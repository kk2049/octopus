/**
 * What the app runtime boundary actually stops.
 *
 * Each case is a malicious `actions.ts` doing the thing an attacker would try
 * after getting an agent to write application code, and asserts the attempt
 * fails — not that a policy disapproved of it.
 *
 * Since the move to Hardened JavaScript most of these fail *earlier* than they
 * used to: the app does not get an `EACCES` from the permission model, it does
 * not get the module at all. Where that changes the shape of the failure the
 * test says so, because "denied at the syscall" and "the identifier is not
 * bound" are different security claims and only the second one survives a Node
 * release that adds a new way to reach the network.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { AppSandbox } from "./sandbox.js";
import { UNISOLATED_ADAPTERS, adapterAllowed, adapterRefusal, secureMode, setSecureMode } from "./secure-mode.js";

let dir: string;
let outside: string;
let sandbox: AppSandbox | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-"));
  fs.writeFileSync(path.join(outside, "config.yaml"), "api_key: sk-do-not-read-me");
  process.env.OCTOPUS_TEST_SECRET = "sk-must-not-leak";
});

afterEach(() => {
  sandbox?.stop();
  sandbox = null;
  delete process.env.OCTOPUS_TEST_SECRET;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function app(code: string): string {
  const file = path.join(dir, "actions.ts");
  fs.writeFileSync(file, code);
  sandbox = new AppSandbox({ appDir: dir, contextKey: "test/alice", timeoutMs: 8000 });
  return file;
}

const CTX = { actor: { kind: "user", username: "alice" }, scope: "alice", scopeOwner: "alice", now: "now", state: {} };

async function run(file: string, action = "attack"): Promise<string> {
  const out = (await sandbox!.runHandler(file, action, CTX, {})) as { reply?: string };
  return String(out?.reply ?? "");
}

describe("app sandbox: what hot-plugged code cannot do", () => {
  it("runs ordinary pure handlers exactly as before", async () => {
    const file = app(`export function attack() { return { events: [], reply: "hello" }; }`);
    expect(await run(file)).toBe("hello");
  });

  it("has no `process` to read secrets out of", async () => {
    // Not "process.env is scrubbed" — there is no process object. The scrubbed
    // environment is still there, one layer down, for a Compartment escape.
    const file = app(`export function attack() {
      return { reply: "process is " + typeof process + ", env via globalThis is "
        + typeof (globalThis as any).process };
    }`);
    const reply = await run(file);
    expect(reply).toBe("process is undefined, env via globalThis is undefined");
    expect(reply).not.toContain("sk-must-not-leak");
  });

  it("cannot read files outside its own app directory", async () => {
    const secret = path.join(outside, "config.yaml");
    const file = app(`export async function attack() {
      try {
        const fs: any = await import("node:fs");
        return { reply: "READ:" + fs.readFileSync(${JSON.stringify(secret)}, "utf8") };
      } catch (e: any) { return { reply: "BLOCKED:" + e.message }; }
    }`);
    const reply = await run(file);
    expect(reply).toContain("BLOCKED");
    expect(reply).not.toContain("sk-do-not-read-me");
  });

  it("cannot write files", async () => {
    const target = path.join(dir, "escape.txt");
    const file = app(`export async function attack() {
      try {
        const fs: any = await import("node:fs");
        fs.writeFileSync(${JSON.stringify(target)}, "x");
        return { reply: "WROTE" };
      } catch (e: any) { return { reply: "BLOCKED:" + e.message }; }
    }`);
    expect(await run(file)).toContain("BLOCKED");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("cannot spawn a process", async () => {
    const file = app(`export async function attack() {
      try {
        const cp: any = await import("node:child_process");
        cp.execSync("id");
        return { reply: "SPAWNED" };
      } catch (e: any) { return { reply: "BLOCKED:" + e.message }; }
    }`);
    expect(await run(file)).toContain("BLOCKED");
  });

  it("cannot start a worker thread to shed the boundary", async () => {
    const file = app(`export async function attack() {
      try { const w: any = await import("node:worker_threads"); new w.Worker("", { eval: true }); return { reply: "WORKER" }; }
      catch (e: any) { return { reply: "BLOCKED:" + e.message }; }
    }`);
    expect(await run(file)).toContain("BLOCKED");
  });

  it("cannot import the engine's store or any host module", async () => {
    const store = path.resolve("packages/engine/src/store.ts");
    const file = app(`export async function attack() {
      try { const m: any = await import(${JSON.stringify(store)}); return { reply: "IMPORTED:" + Object.keys(m).join(",") }; }
      catch (e: any) { return { reply: "BLOCKED:" + e.message }; }
    }`);
    expect(await run(file)).toContain("BLOCKED");
  });

  it("a static import of a host module fails the call outright", async () => {
    // The catchable dynamic-import cases above prove app code cannot *obtain*
    // the module. This one records the other shape: a module that names a
    // forbidden dependency at the top never instantiates, so a handler cannot
    // half-run with some of its imports missing.
    const file = app(`import { writeSync } from "node:fs";
      export function attack() { writeSync(1, "x"); return { reply: "ran" }; }`);
    await expect(run(file)).rejects.toThrow(/may only import its own files/);
  });

  it("gets denied when it asks for a capability nobody granted this run", async () => {
    const file = app(`export async function attack(ctx: any) {
      const out = await ctx.capabilities.request("runner", "exec", { command: "id" });
      return { reply: JSON.stringify(out) };
    }`);
    const reply = await run(file);
    expect(reply).toContain("denied");
  });

  it("reaches the resource only through the broker the parent supplied", async () => {
    const seen: Array<[string, string]> = [];
    const file = app(`export async function attack(ctx: any) {
      const out = await ctx.capabilities.request("runner", "read_file", { path: "/a" });
      return { reply: JSON.stringify(out) };
    }`);
    const out = (await sandbox!.runHandler(file, "attack", CTX, {}, async (slot, operation) => {
      seen.push([slot, operation]);
      return { status: "succeeded", result: { content: "ok" } };
    })) as { reply: string };
    expect(seen).toEqual([["runner", "read_file"]]);
    expect(out.reply).toContain("succeeded");
  });

  it("cannot replace the capability facade with one that lies", async () => {
    // The facade is hardened, so an app cannot wrap `request` to report one
    // operation to the Host while performing another, or hand a doctored copy
    // to a library it loads.
    const file = app(`export async function attack(ctx: any) {
      const before = await ctx.capabilities.request("runner", "read_file", { path: "/a" });
      let tampered = "no";
      try { ctx.capabilities.request = () => ({ status: "succeeded" }); tampered = "yes"; }
      catch (e: any) { tampered = "BLOCKED:" + e.message; }
      return { reply: JSON.stringify({ before, tampered }) };
    }`);
    const out = (await sandbox!.runHandler(file, "attack", CTX, {}, async () => ({ status: "succeeded" }))) as {
      reply: string;
    };
    expect(out.reply).toContain("BLOCKED");
  });

  it("an infinite loop is killed and does not wedge the host", async () => {
    const file = app(`export function attack() { for (;;) {} }`);
    sandbox!.stop();
    sandbox = new AppSandbox({ appDir: dir, contextKey: "test/alice", timeoutMs: 700 });
    await expect(run(file)).rejects.toThrow(/exceeded 700ms/);
    // The sandbox recovers: a later, well-behaved call still works.
    fs.writeFileSync(path.join(dir, "actions.ts"), `export function attack() { return { reply: "alive" }; }`);
    expect(await run(file)).toBe("alive");
  });

  it("refuses to queue more calls than its concurrency budget", async () => {
    // The handler parks on a capability round-trip the TEST controls, so
    // "two calls are in flight" is a fact rather than a bet on how long a busy
    // loop takes. (The old version spun on `Date.now()`, which a Compartment
    // freezes for the invocation — that loop never ends here.)
    const file = app(`export async function attack(ctx: any) {
      await ctx.capabilities.request("park", "wait", {});
      return { reply: "done" };
    }`);
    sandbox!.stop();
    sandbox = new AppSandbox({ appDir: dir, contextKey: "test/alice", timeoutMs: 20_000, maxConcurrent: 2 });
    let release: () => void = () => {};
    const parked = new Promise<void>((r) => {
      release = r;
    });
    let arrived = 0;
    let bothParked: () => void = () => {};
    const twoInFlight = new Promise<void>((r) => {
      bothParked = r;
    });
    const broker = async (): Promise<unknown> => {
      if (++arrived === 2) bothParked();
      await parked;
      return { status: "succeeded" };
    };
    const one = sandbox.runHandler(file, "attack", CTX, {}, broker);
    const two = sandbox.runHandler(file, "attack", CTX, {}, broker);
    await twoInFlight;
    // Both slots are held by calls that cannot finish until we let them.
    await expect(sandbox.runHandler(file, "attack", CTX, {}, broker)).rejects.toThrow(/saturated/);
    release();
    expect(((await one) as { reply: string }).reply).toBe("done");
    expect(((await two) as { reply: string }).reply).toBe("done");
  });

  it("a crashing handler is an error, not a host crash", async () => {
    const file = app(`export function attack() { throw new Error("boom"); }`);
    await expect(run(file)).rejects.toThrow(/boom/);
    fs.writeFileSync(path.join(dir, "actions.ts"), `export function attack() { return { reply: "still here" }; }`);
    expect(await run(file)).toBe("still here");
  });

  it("cannot write a protocol frame, so it cannot answer for anyone", async () => {
    // The channel used to be reachable-but-unauthenticated, and the whole
    // "one process per security context" design existed to make forgery
    // harmless. Now it is unreachable: writing to fd 3 needs `node:fs` or
    // `process`, and app code has neither, so there is nothing to authenticate.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-b-"));
    fs.writeFileSync(path.join(other, "actions.ts"), `export function attack() { return { reply: "context-b" }; }`);
    const b = new AppSandbox({ appDir: other, contextKey: "test/bob", timeoutMs: 4000 });
    try {
      const file = app(`export async function attack() {
        const tried: string[] = [];
        try { const fs: any = await import("node:fs"); fs.writeSync(3, "{}\\n"); tried.push("FS_WROTE"); }
        catch (e: any) { tried.push("NO_FS"); }
        try { (process as any).binding; tried.push("HAS_PROCESS"); } catch (e: any) { tried.push("NO_PROCESS"); }
        return { reply: tried.join(",") };
      }`);
      expect(await run(file)).toBe("NO_FS,NO_PROCESS");
      const outB = (await b.runHandler(path.join(other, "actions.ts"), "attack", CTX, {})) as { reply: string };
      expect(outB.reply).toBe("context-b");
    } finally {
      b.stop();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("app code has no network, by absence rather than by policy", () => {
  // This is the class of bypass the Node permission model could not address at
  // all: it does not cover sockets, so the previous runtime's only honest
  // answer on a host without a network namespace was to refuse to start.
  let server: http.Server;
  let url: string;
  let hits = 0;

  beforeEach(async () => {
    hits = 0;
    server = http.createServer((_req, res) => {
      hits++;
      res.end("SECRET-FROM-LOCALHOST");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("fetch is not bound, and the listener is never reached", async () => {
    const file = app(`export async function attack() {
      if (typeof fetch === "undefined") return { reply: "NO_FETCH" };
      const r = await fetch(${JSON.stringify(url)});
      return { reply: "REACHED:" + (await r.text()) };
    }`);
    expect(await run(file)).toBe("NO_FETCH");
    expect(hits).toBe(0);
  });

  it("node:net and node:http cannot be imported either", async () => {
    // This case used to be `it.skip` — there was no mechanism that made it pass.
    const port = (server.address() as { port: number }).port;
    const file = app(`export async function attack() {
      const out: string[] = [];
      for (const spec of ["node:net", "node:http", "node:https", "node:dgram", "node:tls"]) {
        try { await import(spec); out.push("GOT:" + spec); } catch { out.push("NO:" + spec); }
      }
      try { const n: any = await import("node:net"); n.connect(${port}, "127.0.0.1"); out.push("CONNECTED"); } catch {}
      return { reply: out.join(",") };
    }`);
    const reply = await run(file);
    expect(reply).not.toContain("GOT:");
    expect(reply).not.toContain("CONNECTED");
    await new Promise((r) => setTimeout(r, 150));
    expect(hits).toBe(0);
  });

  it("XMLHttpRequest, WebSocket and EventSource are not bound either", async () => {
    // Naming them individually is not a strategy — the strategy is that the
    // endowment table is a closed list. This asserts the list did not grow.
    const file = app(`export function attack() {
      const names = ["XMLHttpRequest", "WebSocket", "EventSource", "navigator", "require",
                     "setTimeout", "setInterval", "queueMicrotask", "structuredClone"];
      return { reply: names.filter((n) => typeof (globalThis as any)[n] !== "undefined").join(",") || "NONE" };
    }`);
    expect(await run(file)).toBe("NONE");
  });
});

describe("secure mode disables unisolated execution", () => {
  it("refuses the CLI adapters by default and names why", () => {
    expect(secureMode()).toBe(true);
    for (const kind of UNISOLATED_ADAPTERS) {
      expect(adapterAllowed(kind)).toBe(false);
      expect(adapterRefusal(kind)).toMatch(/dangerously-skip-permissions/);
    }
    // The in-process loop has no such bypass and stays available.
    expect(adapterAllowed("openai-loop")).toBe(true);
  });

  it("only an explicit opt-out re-enables them", () => {
    try {
      setSecureMode(false);
      expect(adapterAllowed("claude-code")).toBe(true);
    } finally {
      setSecureMode(true);
    }
    expect(adapterAllowed("claude-code")).toBe(false);
  });
});
