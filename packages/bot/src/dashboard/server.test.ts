import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readBootstrapPayload } from "./app-page.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { hashRunnerToken, newRunnerTokenPlaintext } from "../runner/gateway.js";
import type { RunnerCapabilities } from "../runner/capability.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer, runnerBundleSourceFromFile } from "../e2e/dashboard-test-support.js";

const NOW = "2026-07-19T10:00:00.000Z";

/** Minimal stand-in when a test only needs token minting to work. */
function mintOnlyCaps(store: Store): RunnerCapabilities {
  return {
    mintDeviceToken: (u: string, d: string) => {
      // Same fail-safe order as the real one: old credential dies first.
      store.deleteRunnerToken(u, d);
      const t = newRunnerTokenPlaintext();
      store.saveRunnerToken(hashRunnerToken(t), u, d, NOW);
      return t;
    },
    listDevices: () => [],
    isOnline: () => false,
    open: () => null,
    dropPooled: () => 0,
    listPending: () => [],
    deviceRevoked: () => {},
  } as unknown as RunnerCapabilities;
}

describe("dashboard server", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let base: string;

  const kicked: string[] = [];
  // Stands in for the capability service. Note what it can answer: presence,
  // roster and disconnect. A device check no longer reports a session count,
  // because that was a read of the user's data with no capability behind it.
  const fakeCaps = {
    listDevices: (username: string) =>
      username === "alice"
        ? [{ device: "laptop-a", online: true, created_at: NOW, last_seen_at: NOW,
          bundle_sha: "1".repeat(64), bundle_target_sha: "2".repeat(64), bundle_current: false, bundle_update_status: "retry_pending" }]
        : username === "bob"
          ? [{ device: "old-laptop", online: false, created_at: NOW, last_seen_at: null }]
          : [],
    isOnline: (username: string) => username === "alice",
    ping: async (_username: string, device: string) => (device === "laptop-a" ? 12 : null),
    disconnectDevice: (username: string, device: string) => {
      kicked.push(`${username}/${device}`);
      return device === "kickme";
    },
    open: () => null,
    listPending: () => [],
    // A revocation asks the hub to close what this account derived; a stub
    // that cannot be asked would hide that the route now does it.
    dropPooled: () => 0,
    // The real thing: the minted token must actually work for /download.
    mintDeviceToken: (username: string, device: string) => {
      store.deleteRunnerToken(username, device);
      const t = newRunnerTokenPlaintext();
      store.saveRunnerToken(hashRunnerToken(t), username, device, NOW);
      return t;
    },
    deviceRevoked: (username: string, device: string) => {
      kicked.push(`${username}/${device}`);
    },
    // Row + socket + authority in one call, like the real one: the route has
    // no way to do only part of a revocation.
    revokeDeviceToken: (username: string, device: string) => {
      kicked.push(`${username}/${device}`);
      return store.deleteRunnerToken(username, device);
    },
  } as unknown as RunnerCapabilities;

  it("returns only the authenticated device's actual and target Runner digests", async () => {
    const token = "tok-a";
    const response = await fetch(base + "/api/runner-self-status", { headers: { authorization: `Bearer ${token}` } });
    expect(await response.json()).toMatchObject({ online: true, device: "laptop-a", bundle_sha: "1".repeat(64),
      bundle_target_sha: "2".repeat(64), bundle_current: false, bundle_update_status: "retry_pending" });
    const otherToken = "tok-b";
    const other = await fetch(base + "/api/runner-self-status", { headers: { authorization: `Bearer ${otherToken}` } });
    const body = await other.json() as Record<string, unknown>;
    expect(body).toMatchObject({ device: "old-laptop", online: false });
    expect(body).not.toHaveProperty("bundle_sha");
    expect(body).not.toHaveProperty("bundle_target_sha");
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dash-"));
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/b", created_at: NOW });
    store.setSetting("alice", "display_name", "张三");
    store.saveRunnerToken(hashRunnerToken("tok-a"), "alice", "laptop-a", NOW);
    store.saveRunnerToken(hashRunnerToken("tok-b"), "bob", "old-laptop", NOW);
    // Activity: one session + round for alice.
    store.saveSession({
      id: "s1", claude_session_id: null, username: "alice", config: "{}", first_prompt: "hi",
      status: "idle", total_turns: 1, total_duration_ms: 5, total_cost_usd: 0,
      workdir: null, parent_session_id: null, workspace_id: null, created_at: NOW, updated_at: NOW,
    });
    store.saveRound({ session_id: "s1", round_num: 1, prompt: "hi", events: "[]", result: "ok", turns: 1, duration_ms: 5, cost_usd: 0, created_at: NOW });

    const bundle = join(dir, "standalone.js");
    writeFileSync(bundle, "// fake runner bundle");
    dash = createDashboardTestServer(store, fakeCaps, {
      port: 0, host: "127.0.0.1", authToken: "sekrit", runnerWsPort: 9910, runnerBundle: runnerBundleSourceFromFile(bundle),
      publicHost: "203.0.113.9",
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterAll(async () => {
    await dash.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (path: string) => fetch(base + path, { headers: { authorization: "Bearer sekrit" } });
  const post = (path: string, body?: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { authorization: "Bearer sekrit", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

  it("accepts the auth token in a header, and ONLY in a header", async () => {
    expect((await fetch(base + "/api/overview")).status).toBe(401);
    expect((await get("/api/overview")).status).toBe(200);
    // A credential in a query string is written into browser history, into the
    // Referer of the next request and into every access log on the way, so it
    // is no longer a credential at all.
    expect((await fetch(base + "/api/overview?token=sekrit")).status).toBe(401);
  });

  it("constant-time compare still rejects wrong tokens of any length", async () => {
    const hdr = (t: string) => fetch(base + "/api/overview", { headers: { authorization: `Bearer ${t}` } });
    expect((await hdr("")).status).toBe(401);
    expect((await hdr("sekri")).status).toBe(401); // prefix
    expect((await hdr("sekrit-extra")).status).toBe(401); // superstring
    expect((await hdr("nope")).status).toBe(401);
  });

  it("overview: activity, display names, runner state", async () => {
    const data = (await (await get("/api/overview")).json()) as {
      gateway_enabled: boolean;
      users: Array<Record<string, unknown>>;
    };
    expect(data.gateway_enabled).toBe(true);
    const alice = data.users.find((u) => u.username === "alice")!;
    expect(alice.display_name).toBe("张三");
    // The retired secretary's style settings are no longer projected.
    expect(alice).not.toHaveProperty("persona");
    expect(alice).not.toHaveProperty("reply_mode");
    expect(alice.rounds_7d).toBeGreaterThanOrEqual(0);
    expect((alice.runners as unknown[]).length).toBe(1);
    expect((alice.runners as Array<{ local_agent_bridge_mode: string }>)[0].local_agent_bridge_mode).toBe("disabled");
    expect((alice.runners as Array<{ default_agent_injection: boolean }>)[0].default_agent_injection).toBe(false);
    expect((alice.runners as Array<{ gui_automation_enabled: boolean }>)[0].gui_automation_enabled).toBe(false);
    const bob = data.users.find((u) => u.username === "bob")!;
    // bob's device comes from the token table even though the gateway never saw it.
    expect((bob.runners as Array<{ device: string; online: boolean }>)[0]).toMatchObject({ device: "old-laptop", online: false });
  });

  it("single check hits the gateway; unregistered devices are refused", async () => {
    const ok = (await (await post("/api/check", { username: "alice", device: "laptop-a" })).json()) as Record<string, unknown>;
    // Presence + round trip only: a health check must not read the user's data.
    expect(ok).toMatchObject({ online: true, rtt_ms: 12 });
    expect(ok).not.toHaveProperty("sessions_visible");
    const nope = (await (await post("/api/check", { username: "alice", device: "ghost" })).json()) as Record<string, unknown>;
    expect(nope).toMatchObject({ online: false, error: "device not registered" });
  });

  it("check-all sweeps every registered token", async () => {
    const out = (await (await post("/api/check-all")).json()) as { checked: number; results: Array<Record<string, unknown>> };
    expect(out.checked).toBe(2);
    expect(out.results.find((r) => r.device === "old-laptop")).toMatchObject({ online: false });
  });

  it("serves the page and the runner bundle", async () => {
    const page = await (await get("/?x=1")).text();
    expect(page).toContain("octopus · 总览");
    // The user-facing copy is now in the browser bundle; what the SERVER still
    // owes this page is the onboarding facts only it can know.
    const boot = readBootstrapPayload(page);
    expect(boot.page).toBe("page.overview");
    expect(boot.pageProps).toMatchObject({ tokenPlaceholder: expect.stringContaining("rt_") });
    const dl = await get("/download/runner.js");
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain("runner.js");
    expect(await dl.text()).toContain("fake runner bundle");
  });

  it("tutorial is rendered server-side with the real public host and shell-safe commands", async () => {
    const props = readBootstrapPayload(await (await get("/")).text())
      .pageProps as { tutorialHost: string; hostIsGuess: boolean; commands: Record<string, string> };
    // The runner dial address and download URL both carry the public host.
    expect(props.tutorialHost).toBe("203.0.113.9");
    expect(props.commands.run).toContain("ws://203.0.113.9:9910");
    expect(props.commands.download).toContain(`http://203.0.113.9:${dash.port}/download/runner.js`);
    // Install/upgrade fails loudly, validates the candidate, then atomically replaces runner.js.
    expect(props.commands.download).toContain('curl -fL -H "Authorization: Bearer ');
    // Node 22 resolves module format before --check, so the candidate must end
    // in .js rather than using the unrecognized runner.js.next extension.
    expect(props.commands.download).toContain("-o runner.next.js");
    expect(props.commands.download).toContain("node --check runner.next.js");
    expect(props.commands.download).toContain("mv -f runner.next.js runner.js");
    expect(props.commands.download).not.toContain("runner.js.next");
    expect(props.commands.download).not.toContain("runner.js?token=");
    // Placeholders are single-quoted so pasting can't trigger shell redirection.
    expect(props.commands.run).toContain("OCTOPUS_RUNNER_TOKEN='");
    expect(props.commands.run).toContain("RUNNER_DEVICE='");
    expect(props.commands.run).toContain('CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"');
    expect(props.commands.windowsInstall).toContain("OpenJS.NodeJS.22");
    expect(props.commands.windowsInstall).toContain("Git.Git");
    expect(props.commands.windowsInstall).toContain("Invoke-WebRequest -UseBasicParsing");
    expect(props.commands.windowsInstall).toContain("RUNNER_EXECUTION_ONLY = '1'");
    expect(props.commands.windowsInstall).toContain("RUNNER_EXEC_SHELL");
    expect(props.commands.windowsInstall).toContain("RUNNER_AGENT_HOOKS = 'off'");
    expect(props.commands.windowsInstall).toContain("RUNNER_LOCAL_MCP = 'off'");
    expect(props.commands.windowsInstall).toContain("OCTOPUS_RUNNER_DSH_TUNNEL = '0'");
    expect(props.commands.windowsInstall).toContain("Register-ScheduledTask");
    expect(props.commands.windowsInstall).not.toContain("runner.js?token=");
    expect(props.commands.windowsInstall).not.toContain("C:\\bin");
    expect(props.commands.unixInstall).toContain("/install/octopus-runner.sh");
    expect(props.commands.unixInstall).not.toContain("OCTOPUS_RUNNER_TOKEN");
    // Public host known → no tunnel warning.
    expect(props.hostIsGuess).toBe(false);
  });

  it("issues one-shot Unix enrollment and mints the durable token only on public redemption", async () => {
    const res = await post("/api/runner-token", { username: "alice", device: "new-phone", platform: "unix" });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { enrollment_code: string; install_cmd: string; expires_at: string };
    expect(out.enrollment_code).toMatch(/^re_[0-9a-f]{48}$/);
    expect(out.install_cmd).toContain("/install/octopus-runner.sh");
    expect(out.install_cmd).toContain(out.enrollment_code);
    expect(out.install_cmd).not.toContain("rt_");
    expect(store.listRunnerTokens("alice").some((row) => row.device === "new-phone")).toBe(false);

    const installer = await fetch(base + "/install/octopus-runner.sh");
    expect(installer.status).toBe(200);
    expect(await installer.text()).toContain("node \"$tmp\" install");
    expect((await fetch(base + "/install/runner.js")).status).toBe(200);
    const publicSha = await fetch(base + "/install/runner.sha256");
    expect(publicSha.status).toBe(200);
    expect((await publicSha.text()).trim()).toMatch(/^[0-9a-f]{64}$/);
    const redeemed = await fetch(base + "/api/runner-enrollment/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: out.enrollment_code }),
    });
    expect(redeemed.status).toBe(200);
    const installed = await redeemed.json() as { token: string; device: string; runner_url: string };
    expect(installed.token).toMatch(/^rt_[0-9a-f]{32}$/);
    expect(installed).toMatchObject({ device: "new-phone", runner_url: "ws://203.0.113.9:9910" });
    expect((await fetch(base + "/api/runner-enrollment/redeem", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: out.enrollment_code }),
    })).status).toBe(404);
    expect(
      (await fetch(base + "/download/runner.js", { headers: { authorization: `Bearer ${installed.token}` } })).status,
    ).toBe(200);
    expect((await fetch(base + "/api/runner-self-status", { headers: { authorization: `Bearer ${installed.token}` } })).status).toBe(200);
    expect((await fetch(base + "/api/runner-self-revoke", {
      method: "POST", headers: { authorization: `Bearer ${installed.token}` },
    })).status).toBe(200);
    expect((await fetch(base + "/download/runner.js", { headers: { authorization: `Bearer ${installed.token}` } })).status).toBe(401);
    // Unknown user / missing device rejected.
    expect((await post("/api/runner-token", { username: "ghost", device: "x", platform: "unix" })).status).toBe(404);
    expect((await post("/api/runner-token", { username: "alice", device: "  ", platform: "unix" })).status).toBe(400);
  });

  it("issues a short one-shot Windows enrollment and serves the public PowerShell bootstrap", async () => {
    const res = await post("/api/runner-token", { username: "alice", device: "new-win", platform: "windows-installed" });
    expect(res.status).toBe(200);
    const out = await res.json() as { enrollment_code: string; install_cmd: string; token?: string };
    expect(out.enrollment_code).toMatch(/^re_[0-9a-f]{48}$/);
    expect(out.install_cmd.split("\n")).toHaveLength(2);
    expect(out.install_cmd).toContain("/install/octopus-runner.ps1");
    expect(out.install_cmd).toContain(out.enrollment_code);
    expect(out.install_cmd).not.toContain("rt_");
    expect(out.token).toBeUndefined();
    expect(store.listRunnerTokens("alice").some((row) => row.device === "new-win")).toBe(false);

    const installer = await fetch(base + "/install/octopus-runner.ps1");
    expect(installer.status).toBe(200);
    expect(installer.headers.get("cache-control")).toBe("no-store");
    const installerBytes = Buffer.from(await installer.arrayBuffer());
    // Windows PowerShell 5.1 otherwise ignores charset=utf-8 and parses the
    // script through the local ANSI code page. Test the actual HTTP bytes.
    expect([...installerBytes.subarray(0, 3)]).toEqual([0xEF, 0xBB, 0xBF]);
    const script = installerBytes.subarray(3).toString("utf8");
    expect(script).toContain("Get-FileHash -Algorithm SHA256");
    expect(script).toContain("OpenJS.NodeJS.22");
    expect(script).toContain("Git.Git");

    const redeemed = await fetch(base + "/api/runner-enrollment/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: out.enrollment_code }),
    });
    expect(redeemed.status).toBe(200);
    expect((await redeemed.json() as { token: string }).token).toMatch(/^rt_[0-9a-f]{32}$/);
  });

  it("keeps the legacy Windows response for already-open dashboard bundles", async () => {
    const res = await post("/api/runner-token", { username: "alice", device: "new-win", platform: "windows" });
    const out = await res.json() as { token: string; windows_install_cmd: string };
    expect(out.token).toMatch(/^rt_[0-9a-f]{32}$/);
    expect(out.windows_install_cmd).toContain(`$RunnerToken = '${out.token}'`);
  });

  it("keeps platform-less requests compatible with dashboard bundles from before Unix enrollment", async () => {
    const res = await post("/api/runner-token", { username: "alice", device: "legacy-tab" });
    const out = await res.json() as { token?: string; enrollment_code?: string };
    expect(res.status).toBe(200);
    expect(out.token).toMatch(/^rt_[0-9a-f]{32}$/);
    expect(out.enrollment_code).toBeUndefined();
  });

  it("deletes a runner device: token gone, live connection kicked", async () => {
    store.saveRunnerToken(hashRunnerToken("tok-del"), "alice", "kickme", NOW);
    const res = await post("/api/runner-delete", { username: "alice", device: "kickme" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, existed: true, kicked: true });
    expect(kicked).toContain("alice/kickme");
    expect(store.listRunnerTokens("alice").some((t) => t.device === "kickme")).toBe(false);
    // Deleting a device that never existed reports existed:false, still 200.
    expect(await (await post("/api/runner-delete", { username: "alice", device: "ghost" })).json()).toMatchObject({ ok: true, existed: false });
    expect((await post("/api/runner-delete", { username: "alice" })).status).toBe(400);
  });

  it("a device token can download the bundle, but nothing else", async () => {
    const dl = await fetch(base + "/download/runner.js", { headers: { authorization: "Bearer tok-a" } });
    expect(dl.status).toBe(200);
    expect(await dl.text()).toContain("fake runner bundle");
    // Same token via Authorization header works too.
    const viaHeader = await fetch(base + "/download/runner.js", { headers: { authorization: "Bearer tok-b" } });
    expect(viaHeader.status).toBe(200);
    // Unknown token still rejected; device tokens never unlock the admin surface.
    const asDevice = (p: string) => fetch(base + p, { headers: { authorization: "Bearer tok-a" } });
    expect((await fetch(base + "/download/runner.js", { headers: { authorization: "Bearer rt_bogus" } })).status).toBe(401);
    expect((await asDevice("/api/overview")).status).toBe(401);
    expect((await asDevice("/")).status).toBe(401);
  });
});

describe("dashboard page without a known public host", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dash2-"));
    store = new Store(join(dir, "t.db"));
    dash = createDashboardTestServer(store, mintOnlyCaps(store), { port: 0, host: "127.0.0.1", runnerWsPort: 9910 });
    await dash.start();
  });

  afterAll(async () => {
    await dash.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the request Host and warns when that host is local-only", async () => {
    const props = readBootstrapPayload(await (await fetch(`http://127.0.0.1:${dash.port}/`)).text())
      .pageProps as { hostIsGuess: boolean; commands: Record<string, string> };
    expect(props.hostIsGuess).toBe(true);
    // Commands still render (with the only host we have) rather than breaking the tutorial.
    expect(props.commands.run).toContain("ws://127.0.0.1:9910");
  });

  it("honors a non-local Host header as the tutorial address", async () => {
    // fetch() forbids overriding Host, so speak raw HTTP for this one.
    const page = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: dash.port, path: "/", headers: { host: "octopus.example.com:9820" } },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += String(c)));
          res.on("end", () => resolve(buf));
        },
      );
      req.on("error", reject);
      req.end();
    });
    const hostProps = readBootstrapPayload(page).pageProps as {
      hostIsGuess: boolean;
      commands: Record<string, string>;
    };
    expect(hostProps.commands.run).toContain("ws://octopus.example.com:9910");
    expect(hostProps.hostIsGuess).toBe(false);
  });
});

describe("dashboard behind a TLS reverse proxy (public_url + runner_public_url)", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dash3-"));
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    const bundle = join(dir, "standalone.js");
    writeFileSync(bundle, "// fake runner bundle");
    dash = createDashboardTestServer(store, mintOnlyCaps(store), {
      port: 0, host: "127.0.0.1", authToken: "sekrit", runnerWsPort: 9910, runnerBundle: runnerBundleSourceFromFile(bundle),
      publicHost: "203.0.113.9",
      publicUrl: "https://bot.example.com/",
      runnerPublicUrl: "wss://bot.example.com/runner-ws",
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterAll(async () => {
    await dash.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tutorial commands use https + domain, never the raw ip:port", async () => {
    const page = await (
      await fetch(base + "/", { headers: { authorization: "Bearer sekrit" } })
    ).text();
    expect(page).toContain("https://bot.example.com/download/runner.js");
    expect(page).toContain("wss://bot.example.com/runner-ws");
    expect(page).not.toContain(`http://203.0.113.9:${dash.port}/download`);
    expect(page).not.toContain("ws://203.0.113.9:9910");
  });

  it("minted commands use the same https base (trailing slash normalized)", async () => {
    const res = await fetch(base + "/api/runner-token", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sekrit" },
      body: JSON.stringify({ username: "alice", device: "mbp", platform: "unix" }),
    });
    const out = (await res.json()) as { enrollment_code: string; install_cmd: string };
    expect(out.install_cmd).toContain("https://bot.example.com/install/octopus-runner.sh");
    expect(out.install_cmd).toContain(out.enrollment_code);
    expect(out.install_cmd).not.toContain("bot.example.com//install");
    expect(out.install_cmd).not.toContain("rt_");
  });
});

describe("dashboard live stream lifecycle", () => {
  it("does not write to a live stream already ended by its session tailer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-revoke-"));
    const store = new Store(join(dir, "t.db"));
    const dash = createDashboardTestServer(store, mintOnlyCaps(store), {
      port: 0,
      host: "127.0.0.1",
      runnerWsPort: 9910,
    });

    let writeCalled = false;
    let endCalled = false;
    const endedResponse = {
      writableEnded: true,
      destroyed: false,
      write() {
        writeCalled = true;
        throw new Error("write after end");
      },
      end() {
        endCalled = true;
      },
    } as unknown as ServerResponse;
    const tracked = dash as unknown as {
      liveStreams: Map<ServerResponse, { owner: string; credential: string }>;
    };
    tracked.liveStreams.set(endedResponse, { owner: "alice", credential: "browser-1" });

    dash.transportLifecycle.closeLive("alice");

    expect(writeCalled).toBe(false);
    expect(endCalled).toBe(false);
    expect(tracked.liveStreams.size).toBe(0);
    await dash.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("dashboard shutdown", () => {
  it("ends every tracked event stream before waiting for the HTTP server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-stop-"));
    const store = new Store(join(dir, "t.db"));
    const dash = createDashboardTestServer(store, mintOnlyCaps(store), {
      port: 0,
      host: "127.0.0.1",
      runnerWsPort: 9910,
    });
    await dash.start();

    let ended = false;
    const tracked = dash as unknown as {
      eventStreams: Set<{ end(): void }>;
    };
    tracked.eventStreams.add({
      end() {
        ended = true;
      },
    });

    await dash.stop();
    expect(ended).toBe(true);
    expect(tracked.eventStreams.size).toBe(0);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
