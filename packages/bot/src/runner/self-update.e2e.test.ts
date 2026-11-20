/**
 * Runner self-update, end to end, with the REAL standalone bundle:
 *
 *   old build dials in → gateway serves a different build → old build stages
 *   it at the managed path and becomes the shim → the new build dials in and
 *   reports the served sha → gateway restart → the new build redials within
 *   the fast window.
 *
 * Needs packages/runner/dist/standalone.js (the test-ready build every CI
 * workspace produces); skipped when it is absent. Every per-machine path the
 * Runner touches (hook socket, Codex endpoint, scan home) is pointed at a
 * temp directory so the live Runner on a shared host is never disturbed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { runnerBundleProtocolBanner } from "@claude-bot/runner/gateway-protocol";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "./gateway.js";
import { RunnerBundleRegistry } from "./bundle-registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const STANDALONE = path.resolve(here, "../../../runner/dist/standalone.js");
const NOW = "2026-08-22T00:00:00.000Z";
const TOKEN = "rt_e2e_update";

const describeIf = existsSync(STANDALONE) ? describe : describe.skip;

/** Linux Runners keep their resident log; Windows/macOS discard it. */
const keepsLog = process.platform === "linux";

describeIf.each([false, true])("runner self-update end to end (installed=%s)", (installed) => {
  let dir: string;
  let store: Store;
  let gateway: RunnerGateway;
  let bundles: RunnerBundleRegistry;
  let child: ChildProcess | null = null;
  let output = "";
  let servedSha = "";
  let startSha = "";
  let port = 0;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "runner-e2e-"));
    const scanHome = path.join(dir, "home");
    const runtime = path.join(dir, "runtime");
    mkdirSync(scanHome, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    const bundle = readFileSync(STANDALONE);
    const start = installed ? path.join(scanHome, ".octopus", "runner", "standalone.js") : path.join(dir, "start.js");
    mkdirSync(path.dirname(start), { recursive: true });
    writeFileSync(start, bundle);
    startSha = createHash("sha256").update(bundle).digest("hex");
    const served = Buffer.concat([bundle, Buffer.from("\n// served build marker\n")]);
    bundles = new RunnerBundleRegistry(path.join(dir, "runner-bundles"));
    servedSha = bundles.activate(served, "test:e2e").activeSha!;

    store = new Store(path.join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: scanHome, created_at: NOW });
    store.saveRunnerToken(hashRunnerToken(TOKEN), "alice", "e2e", NOW);
    // Pick a port once so the gateway can come back on it after a stop.
    const probe = new RunnerGateway(store, { port: 0 });
    await probe.start();
    port = probe.port;
    await probe.stop();
    gateway = new RunnerGateway(store, { port, bundleSource: bundles, bundleRetryAfterMs: 1_000 });
    await gateway.start();

    child = spawn(process.execPath, [start], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: scanHome,
        TMPDIR: runtime,
        XDG_RUNTIME_DIR: runtime,
        OCTOPUS_URL: `ws://127.0.0.1:${port}`,
        OCTOPUS_RUNNER_TOKEN: TOKEN,
        RUNNER_DEVICE: "e2e",
        RUNNER_SCAN_HOME: scanHome,
        RUNNER_AGENT_HOOKS: "manual",
        RUNNER_ALLOW_MACHINE_OPS: "0",
        ...(installed ? { OCTOPUS_RUNNER_SUPERVISED: "1" } : {}),
      },
    });
    child.stdout?.on("data", (d) => { output += String(d); });
    child.stderr?.on("data", (d) => { output += String(d); });
  }, 60_000);

  afterAll(async () => {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await gateway.stop().catch(() => undefined);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("moves the device onto the served build and keeps the previous file", async () => {
    await vi.waitFor(() => {
      const device = gateway.listDevices("alice").find((d) => d.device === "e2e");
      expect(device).toMatchObject({ online: true, bundle_sha: servedSha, bundle_current: true });
    }, { timeout: 45_000, interval: 250 });
    const managed = path.join(dir, "home", ".octopus", "runner", "standalone.js");
    expect(createHash("sha256").update(readFileSync(managed)).digest("hex")).toBe(servedSha);
    if (keepsLog) {
      expect(output).toContain(`requesting it`);
      expect(output).toContain("this process becomes its supervisor");
      expect(output).toContain("handing over to");
      expect(output).toContain(`registered as alice/e2e`);
    } else expect(output).toBe("");
    expect(startSha).not.toBe(servedSha);
  }, 60_000);

  it("redials within the fast window after the gateway announces a restart", async () => {
    await gateway.stop();
    if (keepsLog) await vi.waitFor(() => expect(output).toContain("gateway is restarting"), { timeout: 5_000 });
    const t0 = Date.now();
    gateway = new RunnerGateway(store, { port, bundleSource: bundles, bundleRetryAfterMs: 1_000 });
    await gateway.start();
    await vi.waitFor(() => {
      const device = gateway.listDevices("alice").find((d) => d.device === "e2e");
      expect(device).toMatchObject({ online: true, bundle_sha: servedSha });
    }, { timeout: 15_000, interval: 200 });
    // Backoff would have been 1s → 1.7s → …; the fast window redials every 2s.
    expect(Date.now() - t0).toBeLessThan(8_000);
    if (keepsLog) expect(output).toContain("(gateway restart window)");
    else expect(output).toBe("");
  }, 30_000);

  it("updates an already connected Runner when deployment activates its artifact later", async () => {
    const next = Buffer.concat([readFileSync(STANDALONE), Buffer.from("\n// late activation marker\n")]);
    const nextSha = bundles.activate(next, "test:late-deploy").activeSha!;
    expect(nextSha).not.toBe(servedSha);
    gateway.sweepConnections();
    await vi.waitFor(() => {
      expect(gateway.listDevices("alice").find((d) => d.device === "e2e")).toMatchObject({
        online: true, bundle_sha: nextSha, bundle_current: true,
      });
    }, { timeout: 45_000, interval: 250 });
    const managed = path.join(dir, "home", ".octopus", "runner", "standalone.js");
    expect(createHash("sha256").update(readFileSync(managed)).digest("hex")).toBe(nextSha);
    servedSha = nextSha;
  }, 60_000);
  it("recovers a lost bundle reply through bounded version reconciliation", async () => {
    const originalSend = WebSocket.prototype.send;
    let dropped = false;
    const send = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, data, ...args) {
      if (!dropped && typeof data === "string" && JSON.parse(data).type === "bundle") { dropped = true; return; }
      return originalSend.call(this, data, ...args);
    });
    try {
      const nextSha = bundles.activate(Buffer.concat([readFileSync(STANDALONE), Buffer.from("\n// retry reply marker\n")]), "test:retry").activeSha!;
      gateway.sweepConnections();
      await vi.waitFor(() => expect(dropped).toBe(true), { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(gateway.listDevices("alice").find((d) => d.device === "e2e")?.bundle_current).toBe(false);
      gateway.sweepConnections();
      await vi.waitFor(() => expect(gateway.listDevices("alice").find((d) => d.device === "e2e"))
        .toMatchObject({ bundle_sha: nextSha, bundle_current: true }), { timeout: 30_000, interval: 200 });
      servedSha = nextSha;
    } finally { send.mockRestore(); }
  }, 60_000);

  it("restores a fast-crashing installed update, avoids the bad digest, and accepts the next fixed build", async () => {
    const badSha = bundles.activate(Buffer.from(`${runnerBundleProtocolBanner()}\nthrow new Error('bad runner fixture');\n`), "test:bad").activeSha!;
    gateway.sweepConnections();
    await vi.waitFor(() => expect(gateway.listDevices("alice").find((d) => d.device === "e2e"))
      .toMatchObject({ online: true, bundle_sha: servedSha, bundle_current: false, bundle_update_status: "blocked" }),
    { timeout: 30_000, interval: 200 });
    const managed = path.join(dir, "home", ".octopus", "runner", "standalone.js");
    expect(createHash("sha256").update(readFileSync(managed)).digest("hex")).toBe(servedSha);
    expect(badSha).not.toBe(servedSha);
    if (keepsLog) expect(output).toContain(`quarantining ${badSha.slice(0, 12)}`);
    else expect(output).toBe("");
    gateway.sweepConnections();
    const fixedSha = bundles.activate(Buffer.concat([readFileSync(STANDALONE), Buffer.from("\n// fixed after rollback\n")]), "test:fixed").activeSha!;
    gateway.sweepConnections();
    await vi.waitFor(() => expect(gateway.listDevices("alice").find((d) => d.device === "e2e"))
      .toMatchObject({ online: true, bundle_sha: fixedSha, bundle_current: true, bundle_update_status: "current" }),
    { timeout: 30_000, interval: 200 });
    servedSha = fixedSha;
  }, 60_000);

  it("stops the updated Runner when only the service's original process receives SIGTERM", async () => {
    expect(child?.exitCode).toBeNull();
    expect(child?.kill("SIGTERM")).toBe(true);
    await vi.waitFor(() => {
      expect(child?.exitCode).toBe(0);
      expect(gateway.listDevices("alice").find((d) => d.device === "e2e")?.online).toBe(false);
    }, { timeout: 20_000, interval: 100 });
    if (keepsLog) expect(output.match(/received SIGTERM; stopping managed resources/g) ?? []).toHaveLength(2);
    else expect(output).toBe("");
  }, 30_000);

});

// Optional retained release artifact, for compatibility acceptance against
// actual historical bytes rather than a current bundle with a different hash.
const historicalBundle = process.env.RUNNER_TEST_HISTORICAL_BUNDLE;
it.runIf(Boolean(historicalBundle) && existsSync(STANDALONE))(
  "upgrades a historical installed Runner after it missed an offline deployment", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "runner-historical-"));
    const scanHome = path.join(dir, "home");
    const runtime = path.join(dir, "runtime");
    const managed = path.join(scanHome, ".octopus", "runner", "standalone.js");
    mkdirSync(path.dirname(managed), { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(managed, readFileSync(historicalBundle!));
    const bundles = new RunnerBundleRegistry(path.join(dir, "bundles"));
    const target = bundles.activate(readFileSync(STANDALONE), "test:historical").activeSha!;
    const oldSha = createHash("sha256").update(readFileSync(managed)).digest("hex");
    expect(oldSha).not.toBe(target);
    const store = new Store(path.join(dir, "bot.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: scanHome, created_at: NOW });
    store.saveRunnerToken(hashRunnerToken(TOKEN), "alice", "historical", NOW);
    const gateway = new RunnerGateway(store, { port: 0, bundleSource: bundles });
    await gateway.start();
    let stopped = false;
    const children: ChildProcess[] = [];
    // Model the external OS service restarting old supervised versions that
    // exit 75 instead of becoming the newer in-process update shim.
    const start = () => {
      if (stopped) return;
      const child = spawn(process.execPath, [managed], {
        detached: true, stdio: "ignore",
        env: { PATH: process.env.PATH, HOME: scanHome, TMPDIR: runtime, XDG_RUNTIME_DIR: runtime,
          OCTOPUS_URL: `ws://127.0.0.1:${gateway.port}`, OCTOPUS_RUNNER_TOKEN: TOKEN,
          RUNNER_DEVICE: "historical", RUNNER_SCAN_HOME: scanHome, RUNNER_AGENT_HOOKS: "manual",
          RUNNER_LOCAL_MCP: "manual", RUNNER_ALLOW_MACHINE_OPS: "0", OCTOPUS_RUNNER_SUPERVISED: "1" },
      });
      children.push(child);
      child.once("exit", () => { if (!stopped) setTimeout(start, 100); });
    };
    try {
      // Activate first; only then bring the offline old client back.
      start();
      await vi.waitFor(() => expect(gateway.listDevices("alice")).toContainEqual(expect.objectContaining({
        device: "historical", online: true, bundle_sha: target, bundle_current: true,
      })), { timeout: 45_000, interval: 250 });
      expect(createHash("sha256").update(readFileSync(managed)).digest("hex")).toBe(target);
    } finally {
      stopped = true;
      for (const child of children) if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already stopped */ }
      }
      await gateway.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000,
);
