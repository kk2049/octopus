/**
 * SEC-06: an ordinary App Agent cannot be a coding CLI on a multi-user host.
 *
 * The assertion that matters throughout is not "an error was returned" but
 * "the adapter's `runTurn` was called ZERO times" — a ban that reports a
 * refusal and then runs the thing anyway is the failure mode this test exists
 * to catch. Every path a caller could use to select the adapter gets its own
 * case: the manifest, the runtime override API, a config file left on disk by
 * an older deployment, and the secure-mode escape hatch.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "../host/server.js";
import { setSecureMode } from "./secure-mode.js";
import {
  CODING_CLI_ADAPTERS,
  appAgentAdapterAllowed,
  appAgentAdapterVerdict,
  deploymentProfile,
  executionInventory,
  profileDisclosure,
  resetDeploymentProfile,
  setDeploymentProfile,
} from "./deployment.js";
import { AgentPlane, type LoopAdapter } from "../agent/plane.js";
import { loadApp } from "../manifest.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpRoot = path.join(pkgRoot, ".test-tmp");

let dir: string;
let plane: AgentPlane | null = null;
/** Bumped by the fake CLI adapter. The number every case asserts on. */
let cliTurns = 0;

const fakeCli: LoopAdapter = {
  async runTurn() {
    cliTurns++;
    return "ran";
  },
};

function writeApp(adapter: string): string {
  const appDir = path.join(dir, "apps", "counter");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "app.yaml"),
    `
app: counter
title: 计数器
scope: per-user
actions:
  add: { title: 加一, predicate: owner }
agents:
  page: { adapter: ${adapter} }
pages:
  main:
    layout: [a]
    slots:
      a: { widget: kv, bind: view }
`,
  );
  fs.writeFileSync(
    path.join(appDir, "projection.ts"),
    `export function project(events: Array<{type: string}>) { return { count: events.length }; }`,
  );
  fs.writeFileSync(
    path.join(appDir, "actions.ts"),
    `export function add() { return { events: [{ type: "add", data: null }] }; }`,
  );
  return appDir;
}

function makeHost(): Host {
  const host = new Host({
    port: 0,
    appsDir: path.join(dir, "apps"),
    dataDir: path.join(dir, "data"),
    users: { lht: { token: "t1", admin: true }, bob: { token: "t2" } },
  });
  host.reload();
  return host;
}

async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  dir = fs.mkdtempSync(path.join(tmpRoot, "sec06-"));
  cliTurns = 0;
  resetDeploymentProfile();
  setSecureMode(true);
});

afterEach(() => {
  plane?.stop();
  plane = null;
  resetDeploymentProfile();
  setSecureMode(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("deployment profile", () => {
  it("defaults to cloud-multi-user, and an absent config does not count as a declaration", () => {
    expect(deploymentProfile()).toBe("cloud-multi-user");
    setDeploymentProfile(undefined);
    expect(deploymentProfile()).toBe("cloud-multi-user");
    expect(executionInventory({}).profileDeclared).toBe(false);
    setDeploymentProfile("cloud-multi-user");
    expect(executionInventory({}).profileDeclared).toBe(true);
  });

  it("refuses an unknown profile at boot instead of silently keeping the default", () => {
    expect(() => setDeploymentProfile("cloud")).toThrow(/unknown deployment profile/);
    // And the state did not move: a throw must not leave a half-applied profile.
    expect(deploymentProfile()).toBe("cloud-multi-user");
  });

  it("cloud-multi-user forbids every coding CLI for app agents, with a distinguishable code", () => {
    for (const kind of CODING_CLI_ADAPTERS) {
      const v = appAgentAdapterVerdict(kind);
      expect(v.ok).toBe(false);
      expect(v.ok === false && v.code).toBe("profile_forbids_coding_cli");
      expect(v.ok === false && v.reason).toMatch(/cloud-multi-user/);
    }
    expect(appAgentAdapterAllowed("openai-loop")).toBe(true);
  });

  it("secure_mode=false does NOT buy the exception back on a cloud host", () => {
    setSecureMode(false);
    for (const kind of CODING_CLI_ADAPTERS) {
      const v = appAgentAdapterVerdict(kind);
      expect(v.ok).toBe(false);
      // Still the PROFILE that refused — not secure mode, which is now off.
      expect(v.ok === false && v.code).toBe("profile_forbids_coding_cli");
    }
  });

  it("local-owner keeps the adapters (subject to secure mode) and discloses the trade", () => {
    setDeploymentProfile("local-owner");
    // Secure mode still gets its say, and says no by default.
    expect(appAgentAdapterVerdict("claude-code")).toMatchObject({ ok: false, code: "secure_mode" });
    setSecureMode(false);
    expect(appAgentAdapterAllowed("claude-code")).toBe(true);
    expect(profileDisclosure()).toMatch(/不提供多用户文件隔离保证/);
  });

  it("trusted-service carries no ordinary app agents at all", () => {
    setDeploymentProfile("trusted-service");
    setSecureMode(false);
    expect(appAgentAdapterVerdict("codex")).toMatchObject({ ok: false, code: "profile_forbids_coding_cli" });
    expect(profileDisclosure()).toMatch(/trusted-service/);
  });

  it("inventory counts app-reachable coding CLIs, and owner/trusted surfaces separately", () => {
    setDeploymentProfile("local-owner");
    setSecureMode(false);
    const inv = executionInventory({
      appAdapters: ["openai-loop", "claude-code"],
      ownerCliSurfaces: [{ id: "session-hub:owner-cli" }],
      trustedServices: [{ id: "system:dev-factory" }],
    });
    expect(inv.appReachableCodingCli).toBe(1);
    // The two non-app entries are coding CLIs too, and are NOT counted: the
    // number SEC-06 asks about is specifically "reachable by an ordinary App".
    expect(inv.executors.filter((e) => e.codingCli).length).toBe(3);
    expect(inv.executors.find((e) => e.id === "session-hub:owner-cli")?.reachableBy).toBe("owner-session");
    expect(inv.executors.find((e) => e.id === "system:dev-factory")?.reachableBy).toBe("trusted-service");

    resetDeploymentProfile();
    expect(executionInventory({ appAdapters: ["openai-loop"] }).appReachableCodingCli).toBe(0);
  });
});

describe("SEC-06 · manifest declaration", () => {
  it("fails at LOAD on a cloud host — not at the first turn", () => {
    const appDir = writeApp("claude-code");
    expect(() => loadApp(appDir)).toThrow(/cloud-multi-user/);
  });

  it("loads on an explicit local-owner deployment", () => {
    setDeploymentProfile("local-owner");
    const appDir = writeApp("claude-code");
    expect(loadApp(appDir).agents.page.adapter).toBe("claude-code");
  });

  it("a banned manifest leaves the app unloaded, so no turn can start", async () => {
    writeApp("codex");
    const host = makeHost();
    // The app did not load; there is nothing to send an inbox message to.
    expect(host.listManifests().map((m) => m.app)).not.toContain("counter");
    plane = new AgentPlane(host, { adapters: { codex: fakeCli }, dataDir: path.join(dir, "data") });
    plane.attach();
    await settle();
    expect(cliTurns).toBe(0);
  });
});

describe("SEC-06 · runtime override", () => {
  it("the ⚙ panel cannot switch an app agent onto a coding CLI", async () => {
    writeApp("openai-loop");
    const host = makeHost();
    plane = new AgentPlane(host, {
      adapters: { "openai-loop": { async runTurn() { return "ok"; } }, "claude-code": fakeCli },
      dataDir: path.join(dir, "data"),
    });
    const out = await plane.setAgentConfig("counter", "lht", "page", { username: "lht", admin: true }, {
      adapter: "claude-code",
    });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.message).toMatch(/cloud-multi-user/);
    // And nothing was written: the next turn must not find a banned adapter.
    expect(plane.readAgentConfig(host.instance("counter", "lht"), "page").adapter).toBeUndefined();
  });

  it("still refuses with secure mode off (the profile decided first)", async () => {
    setSecureMode(false);
    writeApp("openai-loop");
    const host = makeHost();
    plane = new AgentPlane(host, { adapters: { "claude-code": fakeCli }, dataDir: path.join(dir, "data") });
    const out = await plane.setAgentConfig("counter", "lht", "page", { username: "lht", admin: true }, {
      adapter: "claude-code",
    });
    expect(out).toMatchObject({ ok: false });
  });
});

describe("SEC-06 · historic on-disk config", () => {
  /**
   * The migration case the backlog calls out (§10): a `config.json` written
   * when this deployment was `local-owner`, or before the ban existed. It must
   * fail closed — NOT be rewritten to `openai-loop`, which would silently
   * change the model, the cost and the behaviour of somebody's agent.
   */
  it("fails the turn closed, keeps the inbox, and never calls the CLI", async () => {
    writeApp("openai-loop");
    const host = makeHost();
    const dataDir = path.join(dir, "data");
    const agentDir = path.join(dataDir, "apps", "counter", "lht", "agents", "page");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.json"), JSON.stringify({ adapter: "claude-code" }));

    plane = new AgentPlane(host, {
      adapters: { "claude-code": fakeCli, "openai-loop": fakeCli },
      dataDir,
    });
    plane.attach();
    const inst = host.instance("counter", "lht");
    await inst.log.append([{ type: "agent_inbox", data: { to: "page", text: "hi" } }], {
      kind: "user",
      username: "lht",
    });
    await settle(400);

    expect(cliTurns).toBe(0);
    const transcript = fs.readFileSync(path.join(agentDir, "transcript.jsonl"), "utf8");
    expect(transcript).toMatch(/cloud-multi-user/);
    // Inbox NOT consumed: the message survives for a deployment that can run it.
    const cursor = JSON.parse(fs.readFileSync(path.join(agentDir, "cursor.json"), "utf8"));
    expect(cursor.upto).toBe(0);
    // And the config was left exactly as the operator wrote it — a silent
    // rewrite to openai-loop is the outcome this test forbids.
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, "config.json"), "utf8")).adapter).toBe("claude-code");
  });

  it("send() refuses with the reason rather than «adapter not wired up»", async () => {
    writeApp("openai-loop");
    const host = makeHost();
    const dataDir = path.join(dir, "data");
    const agentDir = path.join(dataDir, "apps", "counter", "lht", "agents", "page");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.json"), JSON.stringify({ adapter: "codex" }));
    plane = new AgentPlane(host, { adapters: { codex: fakeCli }, dataDir });
    const out = await plane.send("counter", "lht", "page", { username: "lht", admin: true }, "hi");
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.message).toMatch(/cloud-multi-user/);
    expect(cliTurns).toBe(0);
  });

  it("the transcript view reports the refusal instead of claiming the adapter is ready", async () => {
    writeApp("openai-loop");
    const host = makeHost();
    const dataDir = path.join(dir, "data");
    const agentDir = path.join(dataDir, "apps", "counter", "lht", "agents", "page");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.json"), JSON.stringify({ adapter: "claude-code" }));
    plane = new AgentPlane(host, { adapters: { "claude-code": fakeCli }, dataDir });
    const view = await plane.transcript("counter", "lht", "page", { username: "lht", admin: true });
    expect(view.ok).toBe(true);
    if (view.ok) {
      expect(view.adapterReady).toBe(false);
      expect(view.adapterRefusal).toMatch(/cloud-multi-user/);
    }
  });
});
