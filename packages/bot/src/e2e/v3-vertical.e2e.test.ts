/**
 * The whole slice, end to end, with nothing faked in the middle.
 *
 * A real v3 Host serving a real app whose handler is real sandboxed code, a
 * real capability service over a real SQLite file, a real Runner Object bound
 * to a real WebSocket device — and the assertions are frame counts on that
 * device.
 *
 * The previous pass wired `authorityFor: () => null`, so the v3 host could
 * only ever demonstrate refusal. This connects it: alice opens an app, its
 * Controller reads a file from HER laptop, and `exec` waits for her approval.
 *
 * `buildHost` below is a NARROWER graph than the shipped one — it sets a
 * per-action `controllerRequirements` this deployment's config has no field
 * for, which is what lets the Controller-attenuation case exist here. The
 * composition the product actually builds is `composeV3Host`, tested against
 * a real gateway in packages/bot/src/v3/compose.test.ts; keep the two in step.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Host, HostCapabilities } from "@claude-bot/engine";
import { CapabilityService, SqliteCapabilityStore } from "@claude-bot/capability-kernel";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "../runner/gateway.js";
import { RunnerCapabilities } from "../runner/capability.js";
import { startFakeRunner, type FakeRunner } from "../runner/fake-runner.helper.js";

const NOW = "2026-07-29T00:00:00.000Z";
const APP = `
app: laptop
title: 我的电脑
scope: per-user
actions:
  peek: { title: 看看, predicate: owner, params: { path: { type: string, required: true } } }
  run:  { title: 跑一下, predicate: owner, params: { command: { type: string, required: true } } }
pages:
  main:
    layout: [a]
    slots:
      a: { widget: kv, bind: view }
`;
const ACTIONS = `
export async function peek(ctx: any, p: any) {
  const out = await ctx.capabilities.request("resources", "read_file", { device: "laptop", path: p.path });
  return { events: [], reply: JSON.stringify(out) };
}
export async function run(ctx: any, p: any) {
  const out = await ctx.capabilities.request("resources", "exec", { device: "laptop", command: p.command });
  return { events: [], reply: JSON.stringify(out) };
}
`;

let dir: string;
let store: Store;
let gateway: RunnerGateway;
let runnerCaps: RunnerCapabilities;
let repo: SqliteCapabilityStore;
let svc: CapabilityService;
let host: Host | null = null;
let base = "";
let alice: FakeRunner;
let bob: FakeRunner;
let transport: import("../runner/gateway.js").RunnerTransport;

/**
 * The bridge: the v3 Host's capability plane holds ONE Object per user — the
 * same `runner-account:<user>` Object the bot's Runner adapter registered.
 * Everything below it (App, Controller, AgentRun) is `derive`.
 */
function buildHost(dataSuffix = "data"): Host {
  const plane = new HostCapabilities({
    service: svc,
    // The trusted lookup: does this account exist AND hold a registered
    // device? `ensureAccount` registers the Runner Object if so, so the plane
    // never claims authority over something nobody registered.
    authorityFor: (username) => runnerCaps.accountAuthority(username),
    // The manifest applies for read + exec; the account holds both.
    appRequirements: () => ["read_file", "exec"],
    // Reads are unsupervised for THIS app; the default is now the opposite.
    appAutoAllow: () => ["read_file"],
    // `peek` declared read only — the Controller narrows further.
    controllerRequirements: (_app, action) => (action === "peek" ? ["read_file"] : ["read_file", "exec"]),
  });
  return new Host({
    port: 0,
    appsDir: path.join(dir, "apps"),
    dataDir: path.join(dir, dataSuffix),
    users: { alice: { token: "t-alice" }, bob: { token: "t-bob" } },
    capabilities: plane,
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "v3e2e-"));
  const appDir = path.join(dir, "apps", "laptop");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "app.yaml"), APP);
  fs.writeFileSync(path.join(appDir, "projection.ts"), `export function project() { return { ok: true }; }`);
  fs.writeFileSync(path.join(appDir, "actions.ts"), ACTIONS);

  store = new Store(path.join(dir, "bot.db"));
  for (const [u, uid] of [["alice", 5001], ["bob", 5002]] as const) {
    store.saveUser({ username: u, uid, home_dir: `/x/${u}`, created_at: NOW });
    store.saveRunnerToken(hashRunnerToken(`rt_${u}`), u, "laptop", NOW);
  }
  gateway = new RunnerGateway(store, { port: 0 });
  await gateway.start();

  transport = gateway.claimTransport();
  repo = new SqliteCapabilityStore(path.join(dir, "cap.db"));
  svc = new CapabilityService({ store: repo });
  runnerCaps = new RunnerCapabilities(store, transport, { service: svc });

  alice = await startFakeRunner(gateway.port, "rt_alice", "laptop", {
    read_file: (a) => ({ path: a.path, content: "alice-file" }),
    exec: (a) => ({ stdout: `alice ran ${String(a.command)}`, exit_code: 0 }),
  });
  bob = await startFakeRunner(gateway.port, "rt_bob", "laptop", {
    read_file: (a) => ({ path: a.path, content: "bob-file" }),
    exec: () => ({ stdout: "bob", exit_code: 0 }),
  });

  host = buildHost();
  await host.start();
  base = host.boundUrl!;
});

afterEach(async () => {
  alice.close();
  bob.close();
  host?.stop();
  host = null;
  try {
    repo.close();
  } catch {
    /* already closed */
  }
  await gateway.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Browser {
  cookie: string;
  csrf: string;
}

async function login(token: string): Promise<Browser> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ token }),
  });
  const raw = res.headers.get("set-cookie") ?? "";
  return {
    cookie: `v3s=${/v3s=([0-9a-f]{64})/.exec(raw)![1]}`,
    csrf: /v3csrf=([0-9a-f]{64})/.exec(raw)![1],
  };
}

async function openInstance(b: Browser): Promise<string> {
  const html = await (await fetch(`${base}/a/laptop`, { headers: { cookie: b.cookie } })).text();
  return /"instance":"([0-9a-f]+)"/.exec(html)![1];
}

async function act(b: Browser, instance: string, action: string, params: unknown): Promise<{ reply?: string }> {
  const res = await fetch(`${base}/api/act`, {
    method: "POST",
    headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
    body: JSON.stringify({ instance, action, params }),
  });
  return (await res.json()) as { reply?: string };
}

describe("v3 app → Controller → capability service → the user's own Runner", () => {
  it("a read reaches the caller's laptop, with no approval and no other device touched", async () => {
    const b = await login("t-alice");
    const out = await act(b, await openInstance(b), "peek", { path: "/home/alice/notes" });
    expect(out.reply).toContain("succeeded");
    expect(out.reply).toContain("alice-file");
    expect(alice.frames.map((f) => f.method)).toEqual(["read_file"]);
    expect(bob.frames).toHaveLength(0);
  });

  it("bob's app instance reaches bob's laptop and only bob's", async () => {
    const b = await login("t-bob");
    const out = await act(b, await openInstance(b), "peek", { path: "/home/alice/notes" });
    expect(out.reply).toContain("bob-file");
    expect(bob.frames.map((f) => f.method)).toEqual(["read_file"]);
    expect(alice.frames).toHaveLength(0);
  });

  it("exec waits for approval, reaches no device until then, then runs exactly once", async () => {
    const b = await login("t-alice");
    const out = await act(b, await openInstance(b), "run", { command: "ls -la" });
    expect(out.reply).toContain("approval_required");
    expect(alice.frames).toHaveLength(0);

    const cards = svc.listPending("alice");
    expect(cards).toHaveLength(1);
    // The card names the machine the frozen args name — `device` is required
    // precisely so the approved target cannot be resolved after the click.
    expect(cards[0].target).toBe("alice/laptop");
    expect(cards[0].details.join(" ")).toContain("ls -la");

    // Bob cannot approve alice's call.
    expect((await svc.approve(cards[0].id, "bob")).status).toBe("denied");
    expect(alice.frames).toHaveLength(0);

    expect((await svc.approve(cards[0].id, "alice")).status).toBe("succeeded");
    expect(alice.frames.map((f) => f.method)).toEqual(["exec"]);
    // A replay is answered from the record, not by the device.
    expect((await svc.approve(cards[0].id, "alice")).status).toBe("succeeded");
    expect(alice.frames).toHaveLength(1);
  });

  it("rejection is terminal and never reaches the device", async () => {
    const b = await login("t-alice");
    const out = await act(b, await openInstance(b), "run", { command: "rm -rf /" });
    const id = svc.listPending("alice")[0].id;
    expect(out.reply).toContain("approval_required");
    expect(svc.reject(id, "alice")).toBe(true);
    expect((await svc.approve(id, "alice")).status).toBe("denied");
    expect(alice.frames).toHaveLength(0);
  });

  it("a Controller that did not declare exec cannot use it, even though the App holds it", async () => {
    fs.writeFileSync(
      path.join(dir, "apps", "laptop", "actions.ts"),
      `export async function peek(ctx: any) {
         const out = await ctx.capabilities.request("resources", "exec", { device: "laptop", command: "id" });
         return { events: [], reply: JSON.stringify(out) };
       }
       export async function run() { return { events: [], reply: "" }; }`,
    );
    host!.reload();
    const b = await login("t-alice");
    const out = await act(b, await openInstance(b), "peek", { path: "/x" });
    expect(out.reply).toContain("denied");
    expect(alice.frames).toHaveLength(0);
    expect(svc.listPending("alice")).toHaveLength(0);
  });

  it("revoking the device revokes what the running app can do", async () => {
    const b = await login("t-alice");
    const instance = await openInstance(b);
    expect((await act(b, instance, "peek", { path: "/a" })).reply).toContain("succeeded");

    store.deleteRunnerToken("alice", "laptop");
    runnerCaps.deviceRevoked("alice", "laptop");

    const after = await act(b, instance, "peek", { path: "/b" });
    expect(after.reply).toContain("denied");
    expect(alice.frames.map((f) => f.method)).toEqual(["read_file"]);
  });

  it("an approval outstanding across a Host restart is still exactly-once", async () => {
    const b = await login("t-alice");
    const out = await act(b, await openInstance(b), "run", { command: "deploy" });
    expect(out.reply).toContain("approval_required");
    const id = svc.listPending("alice")[0].id;
    expect(alice.frames).toHaveLength(0);

    // Restart the capability service over the same file, as a redeploy would.
    host!.stop();
    repo.close();
    const repo2 = new SqliteCapabilityStore(path.join(dir, "cap.db"));
    const svc2 = new CapabilityService({ store: repo2 });
    // Boot step: the Runner Object is re-registered from code (identity is
    // checked against the persisted row) before anything can resume.
    const caps2 = new RunnerCapabilities(store, transport, { service: svc2 });
    expect(caps2.ensureAccount("alice")).toBe(true);

    const cards = svc2.listPending("alice");
    expect(cards.map((c) => c.id)).toContain(id);
    expect((await svc2.approve(id, "alice")).status).toBe("succeeded");
    expect(alice.frames.map((f) => f.method)).toEqual(["exec"]);
    expect((await svc2.approve(id, "alice")).status).toBe("succeeded");
    expect(alice.frames).toHaveLength(1);
    repo2.close();
  });

  it("an unknown operation and a forged instance both fail closed", async () => {
    const b = await login("t-alice");
    const instance = await openInstance(b);
    // An action the manifest does not declare.
    const unknown = await act(b, instance, "nuke", {});
    expect(unknown.reply).toBeUndefined();
    // A handle that was never minted.
    const forged = await fetch(`${base}/api/act`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
      body: JSON.stringify({ instance: "0".repeat(48), action: "peek", params: { path: "/x" } }),
    });
    expect(forged.status).toBe(409);
    expect(alice.frames).toHaveLength(0);
  });
});
