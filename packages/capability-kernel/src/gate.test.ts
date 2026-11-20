/**
 * The negative matrix (doc/tcb-reading-guide.md §5, packages/capability-kernel/CLAUDE.md).
 *
 * Every case asserts the ADAPTER — i.e. the real resource — was or was not
 * reached, not merely what a pure function returned. `hits` is the stand-in
 * for "a WebSocket frame left the building"; the bot-side tests assert the
 * actual frame.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { validateArgs } from "./objects.js";
import { CapabilityService } from "./service.js";
import { hashArgs, canonicalJson } from "./canonical.js";
import { DependencyUnavailable, IndeterminateOutcome } from "./types.js";
import type { ObjectDefinition, PolicyDecision, PolicyInput } from "./types.js";

/**
 * Every request goes through the bound facade, which is the ONLY way an
 * untrusted runtime reaches the gate: (slot, operation, args), no principal, no
 * Context, no Object. The tests below deliberately use the same door.
 */
const call = (svc: CapabilityService, ctx: string, slot: string, op: string, args?: unknown) =>
  svc.bind(ctx).request(slot, op, args);

interface Hit {
  binding: string;
  operation: string;
  args: Record<string, unknown>;
}

function fakeObject(
  id: string,
  binding: string,
  hits: Hit[],
  policy?: (i: PolicyInput) => PolicyDecision,
): ObjectDefinition<string> {
  return {
    id,
    kind: "fake",
    binding,
    metadata: { owner: binding },
    operations: {
      read_thing: { args: { path: { type: "string", required: true, maxLength: 100 } }, effect: "read" },
      write_thing: { args: { path: { type: "string", required: true }, content: { type: "string" } }, effect: "modify" },
      count_thing: { args: { n: { type: "number", min: 1, max: 10, integer: true } }, effect: "observe" },
    },
    policy: policy ?? (() => ({ kind: "allow" })),
    adapter: async (b, operation, args) => {
      hits.push({ binding: b, operation, args: args as Record<string, unknown> });
      return { ok: true, from: b };
    },
  };
}

describe("kernel: the eight invoke checks", () => {
  let hits: Hit[];
  let k: CapabilityService;
  let alice: string;
  let bob: string;

  beforeEach(() => {
    hits = [];
    k = new CapabilityService();
    k.registerObject(fakeObject("obj:alice", "alice", hits));
    k.registerObject(fakeObject("obj:bob", "bob", hits));
    alice = k.createContext("account-authority", { owner: "alice" });
    bob = k.createContext("account-authority", { owner: "bob" });
    k.mintRoot(alice, "res", "obj:alice", ["read_thing", "write_thing", "count_thing"]);
    k.mintRoot(bob, "res", "obj:bob", ["read_thing", "write_thing"]);
  });

  it("allows a live slot holding the right", async () => {
    const out = await call(k, alice, "res", "read_thing", { path: "/a" });
    expect(out.status).toBe("succeeded");
    expect(hits).toEqual([{ binding: "alice", operation: "read_thing", args: { path: "/a" } }]);
  });

  it("denies a slot name copied from another context", async () => {
    const app = k.createContext("app-instance", { owner: "alice" }, alice);
    k.derive(alice, "res", app, "runner", ["read_thing"]);
    // "res" is bob's and alice's slot name too, but it is not in THIS context.
    const out = await call(k, app, "res", "read_thing", { path: "/a" });
    expect(out.status).toBe("denied");
    expect(hits).toHaveLength(0);
  });

  it("denies an unknown context id even if well-formed", async () => {
    const out = await call(k, "ctx_00000000-0000-4000-8000-000000000000", "res", "read_thing", { path: "/a" });
    expect(out.status).toBe("denied");
    expect(hits).toHaveLength(0);
  });

  it("A's slot always reaches A's object — the adapter never re-addresses", async () => {
    // Bob's context, bob's slot name, but arguments that name alice.
    const out = await call(k, bob, "res", "read_thing", { path: "/home/alice/secret" });
    expect(out.status).toBe("succeeded");
    expect(hits[0].binding).toBe("bob");
  });

  it("denies an operation outside the capability's rights", async () => {
    const app = k.createContext("app-instance", {}, alice);
    k.derive(alice, "res", app, "runner", ["read_thing"]);
    const out = await call(k, app, "runner", "write_thing", { path: "/a", content: "x" });
    expect(out.status).toBe("denied");
    expect(hits).toHaveLength(0);
  });

  it("denies unknown operations, extra args and wrong types", async () => {
    expect((await call(k, alice, "res", "nuke_thing", {})).status).toBe("denied");
    expect((await call(k, alice, "res", "read_thing", { path: "/a", extra: 1 })).status).toBe("denied");
    expect((await call(k, alice, "res", "read_thing", { path: 5 })).status).toBe("denied");
    expect((await call(k, alice, "res", "read_thing", {})).status).toBe("denied");
    expect((await call(k, alice, "res", "count_thing", { n: 99 })).status).toBe("denied");
    expect((await call(k, alice, "res", "count_thing", { n: 1.5 })).status).toBe("denied");
    expect(hits).toHaveLength(0);
  });

  it("denies when the object policy denies, without touching the resource", async () => {
    const hits2: Hit[] = [];
    const k2 = new CapabilityService();
    k2.registerObject(fakeObject("obj:x", "x", hits2, () => ({ kind: "deny", reason: "nope" })));
    const c = k2.createContext("account-authority");
    k2.mintRoot(c, "res", "obj:x", ["read_thing"]);
    const out = await call(k2, c, "res", "read_thing", { path: "/a" });
    expect(out).toMatchObject({ status: "denied", reason: "nope" });
    expect(hits2).toHaveLength(0);
  });

  it("treats a throwing policy as deny", async () => {
    const hits2: Hit[] = [];
    const k2 = new CapabilityService();
    k2.registerObject(
      fakeObject("obj:x", "x", hits2, () => {
        throw new Error("policy blew up");
      }),
    );
    const c = k2.createContext("account-authority");
    k2.mintRoot(c, "res", "obj:x", ["read_thing"]);
    expect((await call(k2, c, "res", "read_thing", { path: "/a" })).status).toBe("denied");
    expect(hits2).toHaveLength(0);
  });
});

describe("kernel: derive is monotonic attenuation", () => {
  let hits: Hit[];
  let k: CapabilityService;
  let root: string;

  beforeEach(() => {
    hits = [];
    k = new CapabilityService();
    k.registerObject(fakeObject("obj:alice", "alice", hits));
    k.registerObject(fakeObject("obj:bob", "bob", hits));
    root = k.createContext("account-authority", { owner: "alice" });
    k.mintRoot(root, "res", "obj:alice", ["read_thing", "write_thing"]);
  });

  it("allows the same object with a subset of rights", () => {
    const app = k.createContext("app-instance", {}, root);
    expect(() => k.derive(root, "res", app, "runner", ["read_thing"])).not.toThrow();
    expect(k.rightsOf(app, "runner")).toEqual(["read_thing"]);
  });

  it("refuses to add a right the parent does not hold", () => {
    const app = k.createContext("app-instance", {}, root);
    k.derive(root, "res", app, "runner", ["read_thing"]);
    const run = k.createContext("agent-run", {}, app);
    expect(() => k.derive(app, "runner", run, "runner", ["read_thing", "write_thing"])).toThrow(/may not add right/);
    expect(k.slotsOf(run)).toEqual([]);
  });

  it("has no way to change the object: derive only names a source slot", () => {
    const app = k.createContext("app-instance", {}, root);
    k.derive(root, "res", app, "runner", ["read_thing"]);
    expect(k.objectIdOf(app, "runner")).toBe("obj:alice");
  });

  it("intersects across a three-level chain", async () => {
    const app = k.createContext("app-instance", {}, root);
    k.derive(root, "res", app, "runner", ["read_thing", "write_thing"]);
    const run = k.createContext("agent-run", {}, app);
    k.derive(app, "runner", run, "runner", ["read_thing"]);
    expect((await call(k, run, "runner", "read_thing", { path: "/a" })).status).toBe("succeeded");
    expect((await call(k, run, "runner", "write_thing", { path: "/a" })).status).toBe("denied");
    expect(hits).toHaveLength(1);
  });
});

describe("kernel: revocation and context destruction", () => {
  let hits: Hit[];
  let k: CapabilityService;
  let root: string;
  let app: string;
  let run: string;

  beforeEach(() => {
    hits = [];
    k = new CapabilityService();
    k.registerObject(fakeObject("obj:alice", "alice", hits));
    root = k.createContext("account-authority", { owner: "alice" });
    k.mintRoot(root, "res", "obj:alice", ["read_thing", "write_thing"]);
    app = k.createContext("app-instance", {}, root);
    k.derive(root, "res", app, "runner", ["read_thing"]);
    run = k.createContext("agent-run", {}, app);
    k.derive(app, "runner", run, "runner", ["read_thing"]);
  });

  it("revoking the leaf stops only that node", async () => {
    k.revoke(run, "runner");
    expect((await call(k, run, "runner", "read_thing", { path: "/a" })).status).toBe("denied");
    expect((await call(k, app, "runner", "read_thing", { path: "/a" })).status).toBe("succeeded");
  });

  it("revoking the middle kills every descendant", async () => {
    k.revoke(app, "runner");
    expect((await call(k, run, "runner", "read_thing", { path: "/a" })).status).toBe("denied");
    expect((await call(k, app, "runner", "read_thing", { path: "/a" })).status).toBe("denied");
    expect((await call(k, root, "res", "read_thing", { path: "/a" })).status).toBe("succeeded");
  });

  it("revoking the root kills the whole tree", async () => {
    k.revoke(root, "res");
    for (const [c, s] of [
      [root, "res"],
      [app, "runner"],
      [run, "runner"],
    ] as const) {
      expect((await call(k, c, s, "read_thing", { path: "/a" })).status).toBe("denied");
    }
    expect(hits).toHaveLength(0);
  });

  it("destroying an ancestor context kills descendants (code version swap)", async () => {
    k.destroyContext(app);
    expect((await call(k, run, "runner", "read_thing", { path: "/a" })).status).toBe("denied");
    expect((await call(k, app, "runner", "read_thing", { path: "/a" })).status).toBe("denied");
    expect(hits).toHaveLength(0);
  });

  it("destroy is idempotent and a destroyed context is never revived", async () => {
    k.destroyContext(run);
    k.destroyContext(run);
    expect(() => k.derive(app, "runner", run, "again", ["read_thing"])).toThrow(/destroyed/);
    expect((await call(k, run, "runner", "read_thing", { path: "/a" })).status).toBe("denied");
  });
});

describe("canonical args", () => {
  it("sorts keys so argument order cannot change the hash", () => {
    expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }));
  });

  it("distinguishes different values", () => {
    expect(hashArgs({ path: "/a" })).not.toBe(hashArgs({ path: "/b" }));
  });

  it("rejects __proto__ rather than silently dropping it", () => {
    const smuggled = JSON.parse('{"__proto__":{"x":1},"path":"/a"}') as Record<string, unknown>;
    expect(() => hashArgs(smuggled)).toThrow(/__proto__/);
  });

  it("encodes nested objects deterministically", () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: [3, { f: 1, e: 2 }] })).toBe(
      '{"a":[3,{"e":2,"f":1}],"b":{"c":2,"d":1}}',
    );
  });
});

describe("validateArgs", () => {
  const spec = { args: { s: { type: "string" as const, required: true, enum: ["x", "y"] as const } }, effect: "read" as const };
  it("rejects values outside the enum", () => {
    expect(validateArgs(spec, { s: "z" }).ok).toBe(false);
    expect(validateArgs(spec, { s: "x" }).ok).toBe(true);
  });
  it("rejects arrays and scalars as the args object", () => {
    expect(validateArgs(spec, [1]).ok).toBe(false);
    expect(validateArgs(spec, "x").ok).toBe(false);
  });
});

describe("service: bound facade and approval", () => {
  let hits: Hit[];
  let svc: CapabilityService;
  let alice: string;
  let app: string;

  beforeEach(() => {
    hits = [];
    svc = new CapabilityService();
    svc.registerObject(
      fakeObject("obj:alice", "alice", hits, (i) => {
        if (i.effect !== "modify") return { kind: "allow" };
        if (
          i.approval &&
          i.approval.objectId === i.object.id &&
          i.approval.operation === i.operation &&
          i.approval.argsHash === i.argsHash &&
          i.approval.contextId === i.context.id &&
          i.approval.slot === i.slot
        ) {
          return { kind: "allow" };
        }
        return {
          kind: "approval_required",
          summary: {
            title: `write ${String(i.args.path)}`,
            target: "alice/laptop",
            details: [],
            allowedApprover: "alice",
          },
        };
      }),
    );
    alice = svc.createContext("account-authority", { owner: "alice" });
    svc.mintRoot(alice, "res", "obj:alice", ["read_thing", "write_thing"]);
    app = svc.createContext("app-instance", { owner: "alice", app: "reports" }, alice);
    svc.derive(alice, "res", app, "runner", ["read_thing", "write_thing"]);
  });

  it("the facade is (slot, operation, args) plus a read of one's own pending call", async () => {
    const caps = svc.bind(app);
    // Exactly two methods, and neither takes a principal, a Context or an
    // Object. `result` is here so that "needs approval" has a safe ending:
    // without it the only way to learn the outcome is to make the call again.
    expect(Object.keys(caps)).toEqual(["request", "result"]);
    expect(await caps.request("runner", "read_thing", { path: "/a" })).toMatchObject({ status: "succeeded" });
  });

  it("a pending id is a lookup key, not a bearer credential", async () => {
    const out = await svc.bind(app).request("runner", "write_thing", { path: "/a" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    // A sibling App Instance under the same account holds its own Context, so
    // the id it overheard reads nothing.
    const sibling = svc.createContext("app-instance", { owner: "alice", app: "other" }, alice);
    svc.derive(alice, "res", sibling, "runner", ["read_thing"]);
    expect(svc.bind(sibling).result(id)).toBeNull();
    // The originator sees its own call, and reading is not executing.
    expect(svc.bind(app).result(id)).toMatchObject({ state: "pending", outcome: null });
    expect(hits).toHaveLength(0);
  });

  it("reads run without approval; writes create a pending call and no resource hit", async () => {
    const caps = svc.bind(app);
    const out = await caps.request("runner", "write_thing", { path: "/a", content: "x" });
    expect(out.status).toBe("approval_required");
    expect(hits).toHaveLength(0);
  });

  it("the wrong approver is refused and the call stays pending", async () => {
    const out = await svc.bind(app).request("runner", "write_thing", { path: "/a" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    expect((await svc.approve(id, "bob")).status).toBe("denied");
    expect(svc.pendingState(id)).toBe("pending");
    expect(hits).toHaveLength(0);
  });

  it("a double click executes at most once", async () => {
    const out = await svc.bind(app).request("runner", "write_thing", { path: "/a" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    const [a, b] = await Promise.all([svc.approve(id, "alice"), svc.approve(id, "alice")]);
    const ok = [a, b].filter((r) => r.status === "succeeded");
    expect(ok).toHaveLength(1);
    expect(hits).toHaveLength(1);
  });

  it("replaying an approved id returns the recorded result, never a second run", async () => {
    const out = await svc.bind(app).request("runner", "write_thing", { path: "/a" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    const first = await svc.approve(id, "alice");
    expect(first.status).toBe("succeeded");
    // The retry is answered from the durable record: same outcome, no side effect.
    const replay = await svc.approve(id, "alice");
    expect(replay).toEqual(first);
    expect(hits).toHaveLength(1);
  });

  it("the requesting Context can read its own result; a stranger cannot", async () => {
    const out = await svc.bind(app).request("runner", "write_thing", { path: "/a" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    // Before approval: state visible, no result.
    expect(svc.resultOf(app, id)).toMatchObject({ state: "pending", outcome: null });
    await svc.approve(id, "alice");
    expect(svc.resultOf(app, id)).toMatchObject({ state: "finished", outcome: "succeeded" });
    // The account root is an ancestor, so it may look; an unrelated context may not.
    expect(svc.resultOf(alice, id)).not.toBeNull();
    const stranger = svc.createContext("app-instance", {}, alice);
    expect(svc.resultOf(stranger, id)).toBeNull();
  });

  it("revoking the parent after the request makes approval fail closed", async () => {
    const out = await svc.bind(app).request("runner", "write_thing", { path: "/a" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    svc.revoke(alice, "res");
    expect((await svc.approve(id, "alice")).status).toBe("denied");
    expect(hits).toHaveLength(0);
  });

  it("destroying the requesting context expires its pending calls", async () => {
    const out = await svc.bind(app).request("runner", "write_thing", { path: "/a" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    svc.destroyContext(app);
    expect(svc.pendingState(id)).toBe("expired");
    expect((await svc.approve(id, "alice")).status).toBe("denied");
    expect(hits).toHaveLength(0);
  });

  it("expires on time and refuses a late approval", async () => {
    let now = 1_000_000;
    const late = new CapabilityService({ now: () => now, pendingTtlMs: 60_000 });
    const localHits: Hit[] = [];
    late.registerObject(
      fakeObject("obj:a", "a", localHits, (i) =>
        i.effect === "modify"
          ? { kind: "approval_required", summary: { title: "w", target: "a", details: [], allowedApprover: "alice" } }
          : { kind: "allow" },
      ),
    );
    const c = late.createContext("account-authority");
    late.mintRoot(c, "res", "obj:a", ["write_thing"]);
    const out = await late.bind(c).request("res", "write_thing", { path: "/a" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    now += 61_000;
    expect((await late.approve(id, "alice")).status).toBe("denied");
    expect(localHits).toHaveLength(0);
  });

  it("has no field to swap: identical requests coalesce onto one pending id", async () => {
    const caps = svc.bind(app);
    const a = (await caps.request("runner", "write_thing", { path: "/a" })) as { pendingCallId: string };
    const b = (await caps.request("runner", "write_thing", { path: "/a" })) as { pendingCallId: string };
    expect(a.pendingCallId).toBe(b.pendingCallId);
    const c = (await caps.request("runner", "write_thing", { path: "/b" })) as { pendingCallId: string };
    expect(c.pendingCallId).not.toBe(a.pendingCallId);
  });

  it("a hand-made evidence look-alike cannot satisfy the policy", async () => {
    // The kernel's invoke is reachable only through the service's facade,
    // which passes null. Even reaching for the kernel directly, an object
    // literal is not an ApprovalEvidence instance.
    const fake = {
      pendingCallId: "x",
      contextId: app,
      slot: "runner",
      objectId: "obj:alice",
      operation: "write_thing",
      argsHash: hashArgs({ path: "/a" }),
      approver: "alice",
    };
    const caps = svc.bind(app) as unknown as { request: (...a: unknown[]) => Promise<unknown> };
    // There is simply no parameter for it — extra arguments are ignored.
    const out = (await caps.request("runner", "write_thing", { path: "/a" }, fake)) as { status: string };
    expect(out.status).toBe("approval_required");
    expect(hits).toHaveLength(0);
  });

  it("caps the number of pending approvals per context", async () => {
    const small = new CapabilityService({ maxPendingPerContext: 2 });
    const localHits: Hit[] = [];
    small.registerObject(
      fakeObject("obj:a", "a", localHits, (i) =>
        i.effect === "modify"
          ? { kind: "approval_required", summary: { title: "w", target: "a", details: [], allowedApprover: "alice" } }
          : { kind: "allow" },
      ),
    );
    const c = small.createContext("account-authority");
    small.mintRoot(c, "res", "obj:a", ["write_thing"]);
    const caps = small.bind(c);
    expect((await caps.request("res", "write_thing", { path: "/1" })).status).toBe("approval_required");
    expect((await caps.request("res", "write_thing", { path: "/2" })).status).toBe("approval_required");
    expect((await caps.request("res", "write_thing", { path: "/3" })).status).toBe("denied");
  });

  it("only shows pending calls to the entitled approver", async () => {
    await svc.bind(app).request("runner", "write_thing", { path: "/a" });
    expect(svc.listPending("alice")).toHaveLength(1);
    expect(svc.listPending("bob")).toHaveLength(0);
    expect(svc.listPending("alice")[0].requestedBy).toMatchObject({ app: "reports" });
  });

  it("an indeterminate adapter failure on a write is unknown, not failed", async () => {
    const svc2 = new CapabilityService();
    svc2.registerObject({
      id: "obj:t",
      kind: "fake",
      binding: "t",
      operations: { write_thing: { args: { path: { type: "string", required: true } }, effect: "modify" } },
      policy: () => ({ kind: "allow" }),
      adapter: async () => {
        // The adapter — the only code that knows — declares indeterminacy.
        throw new IndeterminateOutcome("the runner socket closed mid-write");
      },
    });
    const c = svc2.createContext("account-authority");
    svc2.mintRoot(c, "res", "obj:t", ["write_thing"]);
    expect((await svc2.bind(c).request("res", "write_thing", { path: "/a" })).status).toBe("unknown");
  });
});

describe("typed dependency evidence after mediation", () => {
  it.each([true, false])("preserves only an adapter's typed dependency failure (typed=%s)", async (typed) => {
    const svc = new CapabilityService(); let calls = 0;
    const dependency = { resource: "test:device", detail: "temporarily away" };
    svc.registerObject({ id: "obj:dependency", kind: "fake", binding: null,
      operations: { read: { args: {}, effect: "read" } }, policy: () => ({ kind: "allow" }),
      adapter: async () => { calls++; throw typed ? new DependencyUnavailable(dependency.resource, dependency.detail)
        : Object.assign(new Error(dependency.detail), { dependency }); },
    });
    const owner = svc.createContext("owner"); svc.mintRoot(owner, "r", "obj:dependency", ["read"]);
    const outcome = await svc.bind(owner).request("r", "read", {});
    expect(outcome).toEqual({ status: "failed", reason: dependency.detail, ...(typed ? { dependency } : {}) });
    expect(calls).toBe(1); // Failure evidence never retries a call inside the kernel.
    svc.destroyContext(owner);
    expect((await svc.bind(owner).request("r", "read", {})).status).toBe("denied");
    expect(calls).toBe(1);
  });
});
