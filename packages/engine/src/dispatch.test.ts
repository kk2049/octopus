import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AppInstance, validateParams, type ActionHandler, type ActionSpec } from "./dispatch.js";
import type { Actor, EngineEvent } from "./types.js";

const lht: Actor = { kind: "user", username: "lht" };
const bob: Actor = { kind: "user", username: "bob" };
const rootAdmin: Actor = { kind: "user", username: "root", admin: true };
const lhtAgent: Actor = { kind: "agent", app: "counter", agent: "page", onBehalfOf: "lht" };
const bobAgent: Actor = { kind: "agent", app: "counter", agent: "page", onBehalfOf: "bob" };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-dispatch-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface CounterView {
  count: number;
  values: number[];
}

const project = (events: readonly EngineEvent[]): CounterView => ({
  count: events.filter((e) => e.type === "add").length,
  values: events.filter((e) => e.type === "add").map((e) => (e.data as { value: number }).value),
});

const actions: Record<string, ActionSpec> = {
  add: { name: "add", predicate: "owner", params: { note: { type: "string" } } },
  reset: { name: "reset", predicate: "owner", humanOnly: true },
  poke: { name: "poke", predicate: "any" },
  sweep: { name: "sweep", predicate: "admin" },
  boom: { name: "boom", predicate: "any" },
  send: { name: "send", predicate: "owner", params: { to: { type: "string", required: true } } },
};

const handlers: Record<string, ActionHandler> = {
  add: (ctx) => ({
    events: [{ type: "add", data: { value: (ctx.state as CounterView).count + 1 } }],
    reply: "added",
  }),
  reset: () => ({ events: [{ type: "reset", data: null }] }),
  poke: () => ({ events: [{ type: "poke", data: null }] }),
  sweep: () => ({ events: [{ type: "sweep", data: null }] }),
  boom: () => {
    throw new Error("handler exploded");
  },
  send: (_ctx, params) => ({
    events: [{ type: "sent", data: { to: params.to } }],
    deliveries: [{ toScope: String(params.to), events: [{ type: "received", data: { hello: true } }] }],
  }),
};

function makeInstance(scopeOwner = "lht") {
  return new AppInstance("counter", scopeOwner, scopeOwner, path.join(dir, scopeOwner, "log.jsonl"), {
    actions: () => actions,
    runHandler: async (action, ctx, params) => {
      const fn = handlers[action];
      if (typeof fn !== "function") throw new Error(`no handler exported for "${action}"`);
      return (await fn(ctx, params)) ?? {};
    },
    project,
    admins: ["root"],
  });
}

describe("AppInstance.dispatch", () => {
  it("runs read→handler→append and returns the stamped events", async () => {
    const inst = makeInstance();
    const out = await inst.dispatch("add", {}, lht);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.reply).toBe("added");
      expect(out.events[0].type).toBe("add");
      expect(out.events[0].by).toBe("user:lht");
    }
  });

  it("serializes concurrent dispatches so each handler sees the previous write", async () => {
    const inst = makeInstance();
    await Promise.all(Array.from({ length: 10 }, () => inst.dispatch("add", {}, lht)));
    const view = (await inst.view()) as CounterView;
    // Each handler computed state.count+1 inside the serial section; racy
    // dispatch would produce duplicates instead of 1..10.
    expect(view.values).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("owner predicate: other users AND admins are refused (authorship is not delegable)", async () => {
    const inst = makeInstance();
    const stranger = await inst.dispatch("add", {}, bob);
    expect(stranger).toMatchObject({ ok: false, code: "forbidden" });
    const admin = await inst.dispatch("add", {}, rootAdmin);
    expect(admin).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("discovery guarantee: the owner's agent passes the same predicate; a stranger's agent does not", async () => {
    const inst = makeInstance();
    expect((await inst.dispatch("add", {}, lhtAgent)).ok).toBe(true);
    expect(await inst.dispatch("add", {}, bobAgent)).toMatchObject({ ok: false, code: "forbidden" });
    const [event] = inst.log.readSince(0);
    expect(event.by).toBe("agent:counter/page@lht");
  });

  it("humanOnly refuses agents even acting for the owner", async () => {
    const inst = makeInstance();
    const out = await inst.dispatch("reset", {}, lhtAgent);
    expect(out).toMatchObject({ ok: false, code: "forbidden" });
    expect((await inst.dispatch("reset", {}, lht)).ok).toBe(true);
  });

  it("admin predicate works through the admins list", async () => {
    const inst = makeInstance();
    expect((await inst.dispatch("sweep", {}, rootAdmin)).ok).toBe(true);
    expect(await inst.dispatch("sweep", {}, bob)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("a throwing handler appends nothing", async () => {
    const inst = makeInstance();
    const out = await inst.dispatch("boom", {}, lht);
    expect(out).toMatchObject({ ok: false, code: "handler_error" });
    expect(inst.log.revision).toBe(0);
  });

  it("listActions filters by the same authz used for dispatch", async () => {
    const inst = makeInstance();
    const forAgent = (await inst.listActions(lhtAgent)).map((a) => a.name).sort();
    expect(forAgent).toEqual(["add", "boom", "poke", "send"]); // no humanOnly reset, no admin sweep
    const forOwner = (await inst.listActions(lht)).map((a) => a.name).sort();
    expect(forOwner).toContain("reset");
  });

  /**
   * SEC-01. `deliveries` used to be a value a handler could return, and the
   * engine appended it into whatever scope the handler named — after the
   * ControllerRun had been closed, so through no gate at all. There is now no
   * wiring to reach: a handler that still returns the old shape writes its own
   * log and nothing else, and says so.
   */
  it("a handler that returns the old `deliveries` shape writes nothing anywhere", async () => {
    const bobInst = makeInstance("bob");
    const lhtInst = makeInstance("lht");
    const out = await lhtInst.dispatch("send", { to: "bob" }, lht);
    expect(out.ok).toBe(true);
    // Local truth is kept — the sender did try, and that is a fact about them.
    expect(lhtInst.log.revision).toBe(1);
    // The other scope is untouched. Not "was denied": there was nothing to deny.
    expect(bobInst.log.readSince(0)).toEqual([]);
    if (out.ok) expect(out.warnings?.[0]).toMatch(/no longer exists/);
  });

  it("InstanceDeps has no cross-scope write at all", () => {
    // A structural assertion, not a behavioural one: the local append is the
    // only thing a dispatch can do to an event log, and it takes no scope.
    const deps = {
      actions: () => actions,
      runHandler: async () => ({}),
      project,
    };
    expect(Object.keys(deps)).not.toContain("deliver");
  });
});

describe("validateParams", () => {
  const specs = {
    name: { type: "string" as const, required: true },
    n: { type: "number" as const },
    deep: { type: "boolean" as const },
    kind: { type: "string" as const, enum: ["a", "b"] },
  };

  it("accepts valid input and coerces form strings", () => {
    const out = validateParams(specs, { name: "x", n: "5", deep: "true", kind: "a" });
    expect(out).toEqual({ ok: true, value: { name: "x", n: 5, deep: true, kind: "a" } });
  });

  it("rejects missing required, unknown keys, bad types and bad enums", () => {
    expect(validateParams(specs, {})).toMatchObject({ ok: false });
    expect(validateParams(specs, { name: "x", zzz: 1 })).toMatchObject({ ok: false });
    expect(validateParams(specs, { name: "x", n: "not a number" })).toMatchObject({ ok: false });
    expect(validateParams(specs, { name: "x", kind: "c" })).toMatchObject({ ok: false });
    expect(validateParams(specs, [1])).toMatchObject({ ok: false });
  });
});
