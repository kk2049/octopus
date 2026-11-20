/**
 * Exploits earlier passes left open, as deterministic regressions.
 *
 * P0-1, first pass — broker borrowing by id. A child was keyed by app/scope, so
 * for a shared app every user's calls ran in ONE process, and app code could
 * write a `cap` frame naming another concurrent call's `forId`.
 *
 * P0-1, second pass — broker borrowing by TIME. Removing `forId` and
 * serializing calls was not enough: a weak invocation could `setTimeout` a
 * forged frame and return, and the timer would fire while a
 * differently-authorized invocation was current in the same reusable child.
 * That pass answered it with one process per invocation, killed and reaped.
 *
 * P0-1, third pass — the same bug in Hardened JavaScript. Compartments make the
 * process boundary unnecessary for authority (app code cannot reach fd 3 at
 * all), so invocations share a process again. The borrowing channel that
 * survives is *module scope*: a leftover microtask can read a variable a later
 * invocation wrote and spend the facade it finds there. Measured, before the
 * fix: 17 successful `exec` calls it was never granted. Two mechanisms answer
 * it and both are load-bearing — a fresh Compartment per invocation (no shared
 * scope) and a revocable facade (no reuse of your own handle).
 *
 * P0-2 — network. The Node permission model does not cover sockets, so a
 * generated Controller could simply `fetch()` a localhost service and walk
 * around the capability service entirely. There is no netns on this host, so
 * the previous answer was to refuse to run app code at all. Now the answer is
 * that `fetch` is not bound and `node:net` does not resolve — see
 * `sandbox.test.ts`, which un-skipped the case that had no mechanism before.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AppSandbox } from "./sandbox.js";
import { setSecureMode } from "./secure-mode.js";

let dir: string;
const boxes: AppSandbox[] = [];

function sandbox(appDir: string, contextKey: string, timeoutMs = 8000): AppSandbox {
  const b = new AppSandbox({ appDir, contextKey, timeoutMs });
  boxes.push(b);
  return b;
}

function appWith(code: string, name = "app"): string {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "actions.ts"), code);
  return d;
}

const CTX = { actor: { kind: "user", username: "x" }, scope: "x", scopeOwner: "x", now: "now", state: {} };

/** How many sandbox children this process currently has. */
function childCount(): number {
  const out = execSync(`pgrep -P ${process.pid} -f sandbox-child || true`, { encoding: "utf8" });
  return out.split("\n").filter((l) => l.trim()).length;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iso-"));
  setSecureMode(true);
});

afterEach(() => {
  for (const b of boxes) b.stop();
  boxes.length = 0;
  fs.rmSync(dir, { recursive: true, force: true });
  setSecureMode(true);
});

describe("P0-1: no invocation may borrow another invocation's authority", () => {
  it("a leftover microtask cannot spend a later invocation's capability", async () => {
    // The strongest form of the bug, and the one Compartment reuse would bring
    // back. `strong` stashes its own facade in a module-level variable —
    // ordinary code, not an exploit. `weak` runs with no authority at all and
    // plants a microtask loop that keeps trying both its own (revoked) facade
    // and whatever it can find in that variable.
    const d = appWith(`
      let stash: any = null;
      export async function weak(ctx: any) {
        Promise.resolve().then(async () => {
          for (let i = 0; i < 200; i++) {
            await null;
            try { await ctx.capabilities.request("resources", "exec", { command: "leftover" }); } catch {}
            if (stash) { try { await stash.request("resources", "exec", { command: "borrowed" }); } catch {} }
          }
        });
        return { events: [], reply: "planted" };
      }
      export async function strong(ctx: any) {
        stash = ctx.capabilities;
        for (let i = 0; i < 50; i++) await null;
        const out = await ctx.capabilities.request("resources", "read_file", { path: "/ok" });
        return { events: [], reply: JSON.stringify(out) };
      }
    `, "leftover");
    const file = path.join(d, "actions.ts");
    const box = sandbox(d, "app/alice");

    const reached: string[] = [];
    const strongBroker = async (_slot: string, operation: string) => {
      reached.push(operation);
      return { status: "succeeded", result: { content: "ok" } };
    };

    // `weak` gets no broker and finishes first; `strong` runs after it.
    expect(((await box.runHandler(file, "weak", CTX, {})) as { reply: string }).reply).toBe("planted");
    const out = (await box.runHandler(file, "strong", CTX, {}, strongBroker)) as { reply: string };
    // Let every planted microtask drain before asserting.
    for (let i = 0; i < 1000; i++) await null;
    await new Promise((r) => setTimeout(r, 100));

    expect(out.reply).toContain("succeeded");
    expect(reached).toEqual(["read_file"]);
  });

  it("a concurrent invocation cannot spend a capability it was not given", async () => {
    // Both handlers are genuinely in flight at once — calls are not serialized,
    // so this is the concurrency case rather than the time-travel one.
    const d = appWith(`
      const seen: any[] = [];
      export async function weak(ctx: any) {
        for (let i = 0; i < 40; i++) {
          await null;
          try { await ctx.capabilities.request("resources", "exec", { command: "stolen" }); } catch {}
          for (const c of seen) { try { await c.request("resources", "exec", { command: "sibling" }); } catch {} }
        }
        return { events: [], reply: "sprayed" };
      }
      export async function strong(ctx: any) {
        seen.push(ctx.capabilities);
        for (let i = 0; i < 60; i++) await null;
        const out = await ctx.capabilities.request("resources", "read_file", { path: "/ok" });
        return { events: [], reply: JSON.stringify(out) };
      }
    `);
    const file = path.join(d, "actions.ts");
    const box = sandbox(d, "app/alice");

    const reached: Array<{ operation: string; via: string }> = [];
    const strongBroker = async (_slot: string, operation: string) => {
      reached.push({ operation, via: "strong" });
      return { status: "succeeded", result: { content: "ok" } };
    };

    const [strongOut, weakOut] = await Promise.all([
      box.runHandler(file, "strong", CTX, {}, strongBroker),
      // `weak` is given NO broker at all: anything it manages to spend would
      // have to be borrowed from `strong`.
      box.runHandler(file, "weak", CTX, {}),
    ]);
    expect((weakOut as { reply: string }).reply).toBe("sprayed");
    expect((strongOut as { reply: string }).reply).toContain("succeeded");
    // The strong call spent exactly its own one read; nothing named `exec`.
    expect(reached).toEqual([{ operation: "read_file", via: "strong" }]);
  });

  it("no handler invocation shares module state with any other", async () => {
    // Module-scope state is the observable, and it is also the channel the
    // first test exploits. Every invocation starts at 1 — within one sandbox,
    // across sandboxes, whoever the caller is.
    const d = appWith(`
      let seen = 0;
      export function count() { seen++; return { events: [], reply: String(seen) }; }
    `);
    const file = path.join(d, "actions.ts");
    const alice = sandbox(d, "app/alice");
    const bob = sandbox(d, "app/bob");
    const replies = [
      (await alice.runHandler(file, "count", CTX, {})) as { reply: string },
      (await alice.runHandler(file, "count", CTX, {})) as { reply: string },
      (await bob.runHandler(file, "count", CTX, {})) as { reply: string },
    ];
    expect(replies.map((r) => r.reply)).toEqual(["1", "1", "1"]);
  });

  it("a facade is dead the moment its invocation returns", async () => {
    // The other half of the pair: revocation, observed from the app's side.
    // `plant` keeps a reference and reports what it gets back later.
    const d = appWith(`
      let kept: any = null;
      const later: string[] = [];
      export async function plant(ctx: any) {
        kept = ctx.capabilities;
        Promise.resolve().then(async () => {
          for (let i = 0; i < 5; i++) {
            await null;
            later.push(JSON.stringify(await kept.request("resources", "exec", { command: "after" })));
          }
        });
        return { events: [], reply: "kept" };
      }
      export async function report() { return { events: [], reply: later.join("|") || "nothing yet" }; }
    `, "revoked");
    const file = path.join(d, "actions.ts");
    const box = sandbox(d, "app/alice");
    const reached: string[] = [];
    await box.runHandler(file, "plant", CTX, {}, async (_s, operation) => {
      reached.push(operation);
      return { status: "succeeded" };
    });
    for (let i = 0; i < 200; i++) await null;
    // A fresh Compartment means `report` cannot even see `later` — so the
    // authority assertion is the broker's, not the app's self-report.
    expect(reached).toEqual([]);
  });

  it("one process serves many calls — the per-call spawn is gone", async () => {
    // Not a security property, an economic one, and the reason the process
    // boundary could stop carrying the authority argument: a Compartment costs
    // well under a millisecond, a process about 35.
    const d = appWith(`export function ok() { return { events: [], reply: "ok" }; }`, "cheap");
    const file = path.join(d, "actions.ts");
    const box = sandbox(d, "app/alice");
    await box.runHandler(file, "ok", CTX, {});
    const after = childCount();
    for (let i = 0; i < 20; i++) await box.runHandler(file, "ok", CTX, {});
    expect(childCount()).toBe(after);
    expect(after).toBeGreaterThan(0);
  });
});
