/**
 * Invariants the first pass asserted in prose but never in code.
 *
 * Each case here was a real hole: an Object could be re-registered under the
 * same id with a different adapter, a caller-held definition object stayed
 * live inside the kernel, `mintRoot` silently replaced an occupied slot,
 * `unknown` was inferred from an error MESSAGE, byte limits counted UTF-16
 * code units, and the approval brand was only checked by TypeScript.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CapabilityGraph } from "./core.js";
import { Gate } from "./gate.js";
import { ObjectRegistry, validateArgs } from "./objects.js";
import { CapabilityService } from "./service.js";
import { SqliteCapabilityStore } from "./sqlite-store.js";
import * as pkg from "./index.js";
import type { ObjectDefinition } from "./types.js";

interface Hit {
  binding: string;
  operation: string;
}

function obj(id: string, binding: string, hits: Hit[], overrides: Partial<ObjectDefinition<string>> = {}) {
  const def: ObjectDefinition<string> = {
    id,
    kind: "fake",
    binding,
    metadata: { owner: binding },
    operations: {
      read: { args: { path: { type: "string", maxLength: 8 } }, effect: "read" },
      write: { args: { path: { type: "string" } }, effect: "modify" },
    },
    policy: () => ({ kind: "allow" }),
    adapter: async (b, operation) => {
      hits.push({ binding: b, operation });
      return { ok: true };
    },
    ...overrides,
  };
  return def;
}

/** The bound facade is the only door an untrusted runtime has; tests use it too. */
const call = (svc: CapabilityService, ctx: string, slot: string, op: string, args?: unknown) =>
  svc.bind(ctx).request(slot, op, args);

let hits: Hit[];
let k: CapabilityService;

beforeEach(() => {
  hits = [];
  k = new CapabilityService();
});

describe("object registration is not a mutable back door", () => {
  it("refuses to re-register an id that is already live", () => {
    k.registerObject(obj("o:1", "alice", hits));
    expect(() => k.registerObject(obj("o:1", "mallory", hits))).toThrow(/already registered/i);
    const ctx = k.createContext("a");
    k.mintRoot(ctx, "s", "o:1", ["read"]);
    return call(k, ctx, "s", "read", {}).then(() => {
      expect(hits.map((h) => h.binding)).toEqual(["alice"]);
    });
  });

  it("a definition object mutated by its author after registration changes nothing", async () => {
    const def = obj("o:2", "alice", hits);
    k.registerObject(def);
    // The caller still holds the object literal it passed in.
    (def as { policy: unknown }).policy = () => ({ kind: "allow" });
    def.operations.nuke = { args: {}, effect: "read" };
    (def.metadata as Record<string, string>).owner = "mallory";
    (def as { binding: string }).binding = "mallory";
    const ctx = k.createContext("a");
    k.mintRoot(ctx, "s", "o:2", ["read"]);
    expect((await call(k, ctx, "s", "nuke", {})).status).toBe("denied");
    await call(k, ctx, "s", "read", {});
    expect(hits.map((h) => h.binding)).toEqual(["alice"]);
  });

  it("rebindObject cannot widen the operation registry or change the object kind", () => {
    k.registerObject(obj("o:3", "alice", hits));
    expect(() => k.rebindObject("o:3", "bob")).not.toThrow();
    expect(() => k.rebindObject("o:nope", "x")).toThrow(/unknown object/);
  });
});

describe("slots are not silently replaced", () => {
  it("mintRoot refuses an occupied slot", () => {
    k.registerObject(obj("o:a", "alice", hits));
    k.registerObject(obj("o:b", "bob", hits));
    const ctx = k.createContext("a");
    k.mintRoot(ctx, "s", "o:a", ["read"]);
    expect(() => k.mintRoot(ctx, "s", "o:b", ["read"])).toThrow(/slot .* occupied/i);
    expect(k.objectIdOf(ctx, "s")).toBe("o:a");
  });

  it("derive refuses an occupied slot", () => {
    k.registerObject(obj("o:a", "alice", hits));
    const root = k.createContext("a");
    k.mintRoot(root, "s", "o:a", ["read", "write"]);
    const child = k.createContext("b", {}, root);
    k.derive(root, "s", child, "t", ["read"]);
    expect(() => k.derive(root, "s", child, "t", ["write"])).toThrow(/occupied/i);
    expect(k.rightsOf(child, "t")).toEqual(["read"]);
  });
});

describe("context topology", () => {
  it("no child may be created under a destroyed parent", () => {
    const parent = k.createContext("a");
    k.destroyContext(parent);
    expect(() => k.createContext("b", {}, parent)).toThrow(/destroyed/);
  });

  it("derive requires the target to descend from the source context", () => {
    k.registerObject(obj("o:a", "alice", hits));
    const rootA = k.createContext("a");
    k.mintRoot(rootA, "s", "o:a", ["read"]);
    const unrelated = k.createContext("b"); // not a descendant of rootA
    expect(() => k.derive(rootA, "s", unrelated, "s", ["read"])).toThrow(/descend/i);
    expect(k.slotsOf(unrelated)).toEqual([]);
  });

  it("a context cannot be its own ancestor", () => {
    const a = k.createContext("a");
    expect(() => k.createContext("b", {}, a)).not.toThrow();
  });
});

describe("argument schema is a closed set, not a prototype walk", () => {
  const spec = { args: { path: { type: "string" as const } }, effect: "read" as const };
  it("rejects keys that only exist on the prototype chain", () => {
    for (const key of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      const out = validateArgs(spec, { [key]: "x" });
      expect(out.ok, `key ${key}`).toBe(false);
    }
  });
  it("a schema whose own key list is empty accepts nothing", () => {
    expect(validateArgs({ args: {}, effect: "read" }, { toString: "x" }).ok).toBe(false);
    expect(validateArgs({ args: {}, effect: "read" }, {}).ok).toBe(true);
  });
});

describe("limits are measured in UTF-8 bytes", () => {
  it("maxLength counts bytes, so a multi-byte string cannot slip past", () => {
    const spec = { args: { s: { type: "string" as const, maxLength: 8 } }, effect: "read" as const };
    expect(validateArgs(spec, { s: "12345678" }).ok).toBe(true);
    // 4 CJK characters are 4 UTF-16 units but 12 UTF-8 bytes.
    expect(validateArgs(spec, { s: "章鱼章鱼" }).ok).toBe(false);
  });

  it("the whole-argument ceiling is bytes too", async () => {
    k.registerObject(obj("o:a", "alice", hits, { operations: { read: { args: { s: { type: "string" } }, effect: "read" } } }));
    const ctx = k.createContext("a");
    k.mintRoot(ctx, "s", "o:a", ["read"]);
    const big = "章".repeat(300_000); // ~900KB in UTF-8, 300k UTF-16 units
    expect((await call(k, ctx, "s", "read", { s: big })).status).toBe("denied");
    expect(hits).toHaveLength(0);
  });
});

describe("adapter results are bounded", () => {
  it("an oversized adapter result fails rather than being returned", async () => {
    k.registerObject(
      obj("o:a", "alice", hits, {
        adapter: async () => ({ blob: "x".repeat(20 * 1024 * 1024) }),
      }),
    );
    const ctx = k.createContext("a");
    k.mintRoot(ctx, "s", "o:a", ["read"]);
    const out = await call(k, ctx, "s", "read", {});
    expect(out.status).toBe("failed");
    expect(out.status === "failed" && out.reason).toMatch(/too large/i);
  });
});

describe("unknown is a typed outcome, not a parsed error message", () => {
  it("an adapter that declares indeterminacy yields unknown", async () => {
    k.registerObject(
      obj("o:a", "alice", hits, {
        adapter: async () => {
          throw new pkg.IndeterminateOutcome("the socket closed mid-write");
        },
      }),
    );
    const ctx = k.createContext("a");
    k.mintRoot(ctx, "s", "o:a", ["write"]);
    const out = await call(k, ctx, "s", "write", { path: "/a" });
    expect(out.status).toBe("unknown");
  });

  it("an ordinary error is a definite failure even if it says 'timeout'", async () => {
    k.registerObject(
      obj("o:b", "alice", hits, {
        adapter: async () => {
          throw new Error("configuration timeout: the profile is invalid");
        },
      }),
    );
    const ctx = k.createContext("a");
    k.mintRoot(ctx, "s", "o:b", ["write"]);
    expect((await call(k, ctx, "s", "write", { path: "/a" })).status).toBe("failed");
  });
});

describe("approval evidence is enforced at runtime, at the gate boundary", () => {
  /**
   * Two halves, and both matter.
   *
   * The facade has no parameter for evidence at all, so an untrusted runtime
   * cannot present one however it words the call. And the gate — reachable only
   * from inside this package — refuses a structural look-alike on the BRAND,
   * before any lookup, so even a future trusted caller that passed the wrong
   * thing cannot get it compared field by field against a real approval.
   */
  it("the untrusted facade has no parameter for it: an extra argument is inert", async () => {
    let seen: unknown = "not called";
    k.registerObject(
      obj("o:a", "alice", hits, {
        policy: (i) => {
          seen = i.approval;
          return i.approval ? { kind: "allow" } : { kind: "deny", reason: "needs a real approval" };
        },
      }),
    );
    const ctx = k.createContext("a");
    k.mintRoot(ctx, "s", "o:a", ["write"]);
    const fake = {
      pendingCallId: "x",
      contextId: ctx,
      slot: "s",
      objectId: "o:a",
      operation: "write",
      argsHash: "0".repeat(64),
      approver: "alice",
    };
    const caps = k.bind(ctx) as unknown as { request: (...a: unknown[]) => Promise<{ status: string }> };
    expect((await caps.request("s", "write", { path: "/a" }, fake)).status).toBe("denied");
    // The policy ran and saw NO approval — the extra argument never became one.
    expect(seen).toBeNull();
    expect(hits).toHaveLength(0);
  });

  it("the gate itself refuses a look-alike before any lookup", async () => {
    const store = new SqliteCapabilityStore(":memory:");
    const graph = new CapabilityGraph(store);
    const registry = new ObjectRegistry(store);
    const gate = new Gate(graph, registry, () => {});
    registry.register(obj("o:g", "alice", hits));
    const ctx = graph.createContext("a");
    graph.mintRoot(ctx, "s", "o:g", ["write"], { autoAllow: [] }, registry.operationsOf("o:g"));
    await expect(
      gate.invoke(ctx, "s", "write", { path: "/a" }, { approver: "alice" } as never),
    ).rejects.toThrow(/approval evidence/i);
    expect(hits).toHaveLength(0);
    store.close();
  });
});

describe("package exports do not hand out the mint", () => {
  it("no supported import produces approval evidence", () => {
    expect((pkg as Record<string, unknown>).mintApprovalEvidence).toBeUndefined();
    // The class is exported for `instanceof`, but its constructor refuses.
    expect(() => new pkg.ApprovalEvidence(Symbol("x"), "p", "c", "s", "o", "op", "h", "a")).toThrow(/mintable/i);
  });
});

describe("audit links a dangerous call end to end", () => {
  it("records creation, decision and execution against one pending id", async () => {
    const records: pkg.AuditRecord[] = [];
    const svc = new CapabilityService({ audit: (r) => records.push(r) });
    svc.registerObject(
      obj("o:a", "alice", hits, {
        policy: (i) => {
          if (i.effect !== "modify") return { kind: "allow" };
          if (i.approval) return { kind: "allow" };
          return {
            kind: "approval_required",
            summary: { title: "w", target: "alice", details: [], allowedApprover: "alice" },
          };
        },
      }) as ObjectDefinition<unknown>,
    );
    const ctx = svc.createContext("a", { owner: "alice" });
    svc.mintRoot(ctx, "s", "o:a", ["write"]);
    const out = await svc.bind(ctx).request("s", "write", { path: "/a" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    expect(records.some((r) => r.decision === "approval_required" && r.pendingCallId === id)).toBe(true);
    await svc.approve(id, "alice");
    const linked = records.filter((r) => r.pendingCallId === id);
    expect(linked.some((r) => r.event === "pending_created")).toBe(true);
    expect(linked.some((r) => r.event === "approved" && r.approver === "alice")).toBe(true);
    expect(linked.some((r) => r.outcome === "succeeded")).toBe(true);
    // Every record for this call names the same context, slot and args hash.
    const hashes = new Set(linked.map((r) => r.argsHash));
    expect(hashes.size).toBe(1);
  });

  it("records rejection and expiry against the pending id too", async () => {
    let now = 1_000_000;
    const records: pkg.AuditRecord[] = [];
    const svc = new CapabilityService({ audit: (r) => records.push(r), now: () => now, pendingTtlMs: 60_000 });
    svc.registerObject(
      obj("o:a", "alice", hits, {
        policy: () => ({
          kind: "approval_required",
          summary: { title: "w", target: "alice", details: [], allowedApprover: "alice" },
        }),
      }) as ObjectDefinition<unknown>,
    );
    const ctx = svc.createContext("a", { owner: "alice" });
    svc.mintRoot(ctx, "s", "o:a", ["write"]);
    const a = (await svc.bind(ctx).request("s", "write", { path: "/a" })) as { pendingCallId: string };
    svc.reject(a.pendingCallId, "alice");
    expect(records.some((r) => r.event === "rejected" && r.pendingCallId === a.pendingCallId)).toBe(true);

    const b = (await svc.bind(ctx).request("s", "write", { path: "/b" })) as { pendingCallId: string };
    now += 61_000;
    svc.listPending("alice"); // triggers the sweep
    expect(records.some((r) => r.event === "expired" && r.pendingCallId === b.pendingCallId)).toBe(true);
  });
});
