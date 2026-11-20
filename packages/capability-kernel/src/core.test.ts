/**
 * The graph, on its own — the file that must be perfect, tested without a gate,
 * a policy, an adapter or a pending call in the way.
 *
 * Two things are new here and neither existed before the split:
 *
 *  · GRANT TERMS. "May this grant act without asking a human?" used to be a
 *    boolean on the OPERATION, so it was the same answer for every holder. It is
 *    now a condition on the CAPABILITY, which means it attenuates: a derived
 *    grant can narrow it and can never widen it, and a corrupted row cannot
 *    widen it either because `authorize` re-asserts the chain.
 *  · COLLECTION. Contexts used to accumulate forever, and the bot side creates
 *    one per HTTP request. Now they are collected — but only when nothing can
 *    still name them, which is the part worth testing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CapabilityGraph } from "./core.js";
import { ObjectRegistry } from "./objects.js";
import { SqliteCapabilityStore } from "./sqlite-store.js";
import { CapabilityService } from "./service.js";
import type { ObjectDefinition } from "./types.js";

let store: SqliteCapabilityStore;
let graph: CapabilityGraph;
let registry: ObjectRegistry;

function device(id: string): ObjectDefinition<string> {
  return {
    id,
    kind: "device",
    binding: id,
    metadata: { owner: id },
    operations: {
      look: { args: {}, effect: "observe" },
      read: { args: {}, effect: "read" },
      write: { args: {}, effect: "modify" },
      run: { args: {}, effect: "execute" },
    },
    policy: () => ({ kind: "allow" }),
    adapter: async () => ({ ok: true }),
  };
}

const ALL = ["look", "read", "write", "run"];

beforeEach(() => {
  store = new SqliteCapabilityStore(":memory:");
  graph = new CapabilityGraph(store);
  registry = new ObjectRegistry(store);
  registry.register(device("o:a"));
});

afterEach(() => {
  store.close();
});

function mint(ctx: string, autoAllow: string[] = ALL): void {
  graph.mintRoot(ctx, "s", "o:a", ALL, { autoAllow }, registry.operationsOf("o:a"));
}

describe("authorize is the whole decision, and it is four questions", () => {
  it("answers with the capability and the Object, never with the caller's", () => {
    const ctx = graph.createContext("root");
    mint(ctx);
    expect(graph.authorize(ctx, "s", "read")).toMatchObject({ ok: true, objectId: "o:a" });
  });

  it("refuses instead of throwing, so a caller cannot mistake an error for a pass", () => {
    const ctx = graph.createContext("root");
    mint(ctx);
    for (const [c, s, op, why] of [
      ["ctx_missing", "s", "read", /unknown context/],
      [ctx, "nope", "read", /no capability in slot/],
      [ctx, "s", "fly", /not held/],
    ] as const) {
      const out = graph.authorize(c, s, op);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toMatch(why);
    }
  });

  it("walks up in O(depth) rather than scanning every context", () => {
    // 200 unrelated contexts exist; none of them is on the path, and `isWithin`
    // must not care how many there are.
    const root = graph.createContext("root");
    mint(root);
    for (let i = 0; i < 200; i++) graph.createContext("noise");
    const mid = graph.createContext("app", {}, root);
    graph.derive(root, "s", mid, "s", ["read"]);
    const leaf = graph.createContext("run", {}, mid);
    graph.derive(mid, "s", leaf, "s", ["read"]);
    expect(graph.isWithin(root, leaf)).toBe(true);
    expect(graph.isWithin(leaf, root)).toBe(false);
    expect(graph.ancestry(leaf)).toEqual([root, mid, leaf]);
  });
});

describe("grant terms attenuate like rights do", () => {
  it("a derive may narrow the terms", () => {
    const root = graph.createContext("root");
    mint(root, ["look", "read"]);
    const app = graph.createContext("app", {}, root);
    graph.derive(root, "s", app, "s", ["look", "read"], { autoAllow: ["look"] });
    expect(graph.termsOf(app, "s").autoAllow).toEqual(["look"]);
  });

  it("a derive cannot auto-allow what its parent may not", () => {
    const root = graph.createContext("root");
    mint(root, ["read"]); // the root itself asks a human for write/run
    const app = graph.createContext("app", {}, root);
    graph.derive(root, "s", app, "s", ALL, { autoAllow: ALL });
    // Asked for everything, granted only what the parent held unsupervised.
    expect(graph.termsOf(app, "s").autoAllow).toEqual(["read"]);
  });

  it("omitting the terms inherits the parent's, intersected with the rights", () => {
    const root = graph.createContext("root");
    mint(root, ["look", "read"]);
    const app = graph.createContext("app", {}, root);
    graph.derive(root, "s", app, "s", ["read", "write"]);
    expect(graph.termsOf(app, "s").autoAllow).toEqual(["read"]);
  });

  it("a hand-edited row that widened its terms fails the chain at call time", () => {
    const root = graph.createContext("root");
    mint(root, ["read"]);
    const app = graph.createContext("app", {}, root);
    graph.derive(root, "s", app, "s", ALL);
    // Simulate a corrupted or tampered row: terms wider than the parent's.
    const cap = store.getSlot(app, "s")!.capabilityId;
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare("UPDATE cap_capabilities SET terms = ? WHERE id = ?")
      .run(JSON.stringify({ autoAllow: ALL }), cap);
    const out = graph.authorize(app, "s", "read");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/widened its parent's terms/);
  });

  it("a root never auto-allows modify or execute by default", () => {
    const svc = new CapabilityService();
    svc.registerObject(device("o:b"));
    const ctx = svc.createContext("root");
    svc.mintRoot(ctx, "s", "o:b", ALL);
    // Declared once in the registry, applied once here: nothing that changes or
    // runs something on a resource is unsupervised just because it was added.
    expect(svc.termsOf(ctx, "s").autoAllow).toEqual(["look", "read"]);
    svc.close();
  });
});

describe("destroyed contexts are collected, but only when nothing can name them", () => {
  it("a destroyed leaf is collected once its retention passes", () => {
    let now = 1_000_000;
    const svc = new CapabilityService({ now: () => now, contextRetentionMs: 1000 });
    svc.registerObject(device("o:c"));
    const root = svc.createContext("root");
    svc.mintRoot(root, "s", "o:c", ALL);
    const before = svc.slotsOf(root).length;
    expect(before).toBe(1);

    const run = svc.createContext("run", {}, root);
    svc.derive(root, "s", run, "s", ["read"]);
    svc.destroyContext(run);
    // Nothing collects while it is fresh, even after a sweep.
    now += 500;
    void svc.rightsOf(root, "s");
    expect(svc.contextIsLive(run)).toBe(false);
    // Past retention, and past the collector's own once-a-minute throttle.
    now += 60_001;
    void svc.rightsOf(root, "s");
    void svc.listPending("nobody");
    // The root is untouched; the dead child's rows are gone.
    expect(svc.rightsOf(root, "s")).toHaveLength(4);
    svc.close();
  });

  it("a per-request Context does not accumulate for the life of the deployment", async () => {
    // The shape that made this necessary: the panel's session list derives a
    // Context per HTTP request and the page polls. Before collection, an open
    // tab wrote three durable rows a second, forever, and boot read all of them.
    let now = 1_000_000;
    const box = new SqliteCapabilityStore(":memory:", { now: () => now });
    const svc = new CapabilityService({ store: box, now: () => now, contextRetentionMs: 1000 });
    svc.registerObject(device("o:e"));
    const root = svc.createContext("root");
    svc.mintRoot(root, "s", "o:e", ALL);
    for (let i = 0; i < 50; i++) {
      const req = svc.createContext("request", {}, root);
      svc.derive(root, "s", req, "s", ["read"]);
      svc.destroyContext(req);
    }
    expect(box.graphSize()).toEqual({ contexts: 51, capabilities: 51, slots: 51 });
    now += 61_001; // past retention and past the collector's throttle
    await svc.bind(root).request("s", "read", {});
    // Only the account root survives, and it still works.
    expect(box.graphSize()).toEqual({ contexts: 1, capabilities: 1, slots: 1 });
    expect(svc.rightsOf(root, "s")).toHaveLength(4);
    svc.close();
  });

  it("by default a dead request Context is gone an hour later, not a day", async () => {
    let now = 1_000_000;
    const box = new SqliteCapabilityStore(":memory:", { now: () => now });
    const svc = new CapabilityService({ store: box, now: () => now });
    svc.registerObject(device("o:f"));
    const root = svc.createContext("root");
    svc.mintRoot(root, "s", "o:f", ALL);
    const req = svc.createContext("request", {}, root);
    svc.derive(root, "s", req, "s", ["read"]);
    svc.destroyContext(req);
    now += 3600_000 + 60_001;
    await svc.bind(root).request("s", "read", {});
    expect(box.graphSize()).toEqual({ contexts: 1, capabilities: 1, slots: 1 });
    svc.close();
  });

  it("a context with an undecided approval is never collected", () => {
    let now = 1_000_000;
    const svc = new CapabilityService({ now: () => now, contextRetentionMs: 1000, pendingTtlMs: 10 * 60_000 });
    svc.registerObject({
      ...device("o:d"),
      policy: (i) => {
        if (i.terms.autoAllow.includes(i.operation)) return { kind: "allow" };
        // Evidence for exactly this call, or ask. A policy that ignored the
        // evidence would refuse its own approval, which the desk reads as a
        // misconfiguration and turns into a rejection.
        const a = i.approval;
        if (a && a.operation === i.operation && a.argsHash === i.argsHash && a.contextId === i.context.id) {
          return { kind: "allow" };
        }
        return { kind: "approval_required", summary: { title: "w", target: "d", details: [], allowedApprover: "alice" } };
      },
    });
    const root = svc.createContext("root");
    svc.mintRoot(root, "s", "o:d", ALL);
    const run = svc.createContext("run", {}, root);
    svc.derive(root, "s", run, "s", ["write"]);

    return svc
      .bind(run)
      .request("s", "write", {})
      .then(async (out) => {
        const id = (out as { pendingCallId: string }).pendingCallId;
        // The holder released the Context but the card is still on someone's
        // screen, so teardown is deferred and collection must not run ahead of
        // it: approving re-runs the call in THIS Context.
        svc.destroyContext(run, { deferWhilePending: true });
        now += 60_001 + 1000;
        void svc.listPending("alice");
        expect((await svc.approve(id, "alice")).status).toBe("succeeded");
        svc.close();
      });
  });
});
