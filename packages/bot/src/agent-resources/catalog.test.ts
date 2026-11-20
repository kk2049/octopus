/**
 * The catalog's rules, with a provider that records what reached it.
 *
 * Everything asserted here is a way of NOT reaching a provider: a binding the
 * plan does not declare, a contract nobody installed, an action the provider did
 * not enumerate, an instance that has been closed, a second owner's key.
 * Counting calls rather than checking return values is deliberate — "the
 * provider was never opened" is a stronger statement than "the answer was a
 * refusal".
 *
 * The other half is about the HANDLE. An instance is registered when it is
 * opened, not when it first reads something, and that is what makes three
 * otherwise-invisible states decidable: a tab closed before its first call, an
 * owner revoked before its first call, and an old tab told apart from a new one.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { readResourceBindings, type ResourceBindingPlan } from "@claude-bot/agent-module-contract";
import { AgentResourceCatalog, type AgentResourceInstance } from "./catalog.js";
import {
  resourceRefusal,
  type ResourceAnswer,
  type ResourceProviderContext,
  type ResourceProviderDefinition,
  type ResourceScopeIdentity,
} from "./types.js";

const PLAN_DOC = {
  schema: "agent-resource-bindings/v1",
  app: "demo",
  bindings: [
    { binding: "workspace", contract: "workspace-files/v1" },
    { binding: "archive", contract: "cold-storage/v1" },
  ],
  connections: [{ instance: "files", port: "workspace-files/v1", binding: "workspace" }],
};

function plan(overrides: Record<string, unknown> = {}): ResourceBindingPlan {
  const read = readResourceBindings({ ...PLAN_DOC, ...overrides });
  if (!read.ok) throw new Error(`bad fixture: ${JSON.stringify(read.issues)}`);
  return read.value;
}

interface Recorded {
  opens: ResourceProviderContext[];
  calls: Array<{ action: string; scope: string }>;
  closes: string[];
}

function fakeProvider(recorded: Recorded, options: {
  contract?: string;
  actions?: string[];
  open?: (context: ResourceProviderContext) => unknown;
  dispatch?: () => Promise<ResourceAnswer>;
  close?: () => void | Promise<void>;
} = {}): ResourceProviderDefinition<{ scope: string }> {
  return {
    contract: options.contract ?? "workspace-files/v1",
    actions: options.actions ?? ["resource.refresh_roots", "resource.open_text"],
    open(context) {
      recorded.opens.push(context);
      const state = options.open?.(context);
      if (state === null) return null;
      return { scope: context.scope };
    },
    async dispatch(state, action) {
      recorded.calls.push({ action, scope: state.scope });
      return options.dispatch ? await options.dispatch() : { ok: true, result: { action }, message: "" };
    },
    close(state) {
      recorded.closes.push(state.scope);
      return options.close?.();
    },
  };
}

function identity(overrides: Partial<ResourceScopeIdentity> = {}): ResourceScopeIdentity {
  return {
    owner: "alice",
    publisher: "octopus:first-party",
    app: "demo",
    packageDigest: "d".repeat(64),
    permissionContractDigest: "c".repeat(64),
    instance: "tab-1",
    plan: plan(),
    ...overrides,
  };
}

const READ = { action: "resource.refresh_roots", params: { binding: "workspace" } };

let recorded: Recorded;
beforeEach(() => {
  recorded = { opens: [], calls: [], closes: [] };
});

function sealed(overrides: Parameters<typeof fakeProvider>[1] = {}): AgentResourceCatalog {
  const catalog = new AgentResourceCatalog();
  catalog.register(fakeProvider(recorded, overrides));
  catalog.seal();
  return catalog;
}

describe("the trusted identity closure", () => {
  it("echoes every identity field into the provider's context, exactly", () => {
    const catalog = sealed();
    const handle = catalog.openInstance(identity({
      owner: "alice",
      publisher: "octopus:first-party",
      packageDigest: "a".repeat(64),
      permissionContractDigest: "b".repeat(64),
      instance: "tab-9",
    }));
    return handle.dispatch(READ).then(() => {
      expect(recorded.opens).toHaveLength(1);
      expect(recorded.opens[0]).toMatchObject({
        owner: "alice",
        publisher: "octopus:first-party",
        app: "demo",
        packageDigest: "a".repeat(64),
        // The exact contract this instance was opened under. A provider that
        // asked "what is the newest contract right now" would re-interpret a
        // tab somebody already consented to.
        permissionContractDigest: "b".repeat(64),
        instance: "tab-9",
        binding: "workspace",
        contract: "workspace-files/v1",
      });
    });
  });

  it("gives two publishers with the same app id and instance id different scopes", async () => {
    const catalog = sealed();
    const first = catalog.openInstance(identity({ publisher: "octopus:first-party" }));
    const second = catalog.openInstance(identity({ publisher: "someone:else" }));
    await first.dispatch(READ);
    await second.dispatch(READ);
    expect(catalog.openInstances).toBe(2);
    const scopes = recorded.opens.map((context) => context.scope);
    expect(new Set(scopes).size).toBe(2);
    // And a retirement is per publisher: closing one does not retire the other,
    // and it does not free the other's key either.
    await first.close();
    expect(catalog.openInstances).toBe(1);
    expect(() => catalog.openInstance(identity({ publisher: "octopus:first-party" })))
      .toThrow(/已经结束/);
    expect(await second.dispatch(READ)).toMatchObject({ ok: true });
  });

  it("closes one publisher's instance without touching the other's", async () => {
    const catalog = sealed();
    const first = catalog.openInstance(identity({ publisher: "octopus:first-party" }));
    const second = catalog.openInstance(identity({ publisher: "someone:else" }));
    await first.dispatch(READ);
    await second.dispatch(READ);
    await catalog.closeInstance({
      owner: "alice",
      publisher: "someone:else",
      app: "demo",
      instance: "tab-1",
    });
    expect(catalog.openScopes).toBe(1);
    expect(await first.dispatch(READ)).toMatchObject({ ok: true });
    expect(await second.dispatch(READ)).toMatchObject({ ok: false, code: "scope_closed" });
  });

  it("refuses to open on a malformed publisher or digest rather than defaulting", () => {
    const catalog = sealed();
    // These come from trusted composition, so a bad one is a bug in the code
    // that decides WHICH release and WHICH ask an instance runs under. Falling
    // back to a default publisher or a default contract would be inventing an
    // answer to the only two questions the grant resolver has.
    expect(() => catalog.openInstance(identity({ publisher: "has space" }))).toThrow(/publisher/);
    expect(() => catalog.openInstance(identity({ publisher: "" }))).toThrow(/publisher/);
    expect(() => catalog.openInstance(identity({ packageDigest: "not-a-digest" }))).toThrow(/packageDigest/);
    expect(() => catalog.openInstance(identity({ packageDigest: "A".repeat(64) }))).toThrow(/packageDigest/);
    expect(() => catalog.openInstance(identity({ permissionContractDigest: "short" })))
      .toThrow(/permissionContractDigest/);
    expect(() => catalog.openInstance(identity({ permissionContractDigest: "" })))
      .toThrow(/permissionContractDigest/);
    expect(recorded.opens).toHaveLength(0);
  });

  it("still ends every publisher's instances for one owner", async () => {
    const catalog = sealed();
    const first = catalog.openInstance(identity({ publisher: "octopus:first-party" }));
    const second = catalog.openInstance(identity({ publisher: "someone:else" }));
    await first.dispatch(READ);
    await second.dispatch(READ);
    // A device-set change is about the ACCOUNT, so it must not stop at one
    // publisher's handles.
    await catalog.closeOwner("alice");
    expect(catalog.openInstances).toBe(0);
    expect(await first.dispatch(READ)).toMatchObject({ ok: false, code: "scope_closed" });
    expect(await second.dispatch(READ)).toMatchObject({ ok: false, code: "scope_closed" });
  });
});

describe("registration", () => {
  it("refuses a duplicate contract and a late registration", () => {
    const catalog = new AgentResourceCatalog();
    catalog.register(fakeProvider(recorded));
    expect(() => catalog.register(fakeProvider(recorded))).toThrow(/已经有一个 provider/);
    catalog.seal();
    expect(() => catalog.register(fakeProvider(recorded, { contract: "other/v1" }))).toThrow(/已封存/);
    expect(catalog.contracts()).toEqual(["workspace-files/v1"]);
  });

  it("refuses a descriptor that is blank, malformed, empty or repetitive", () => {
    const catalog = new AgentResourceCatalog();
    expect(() => catalog.register(fakeProvider(recorded, { contract: "  " }))).toThrow(/契约 id 非法/);
    expect(() => catalog.register(fakeProvider(recorded, { contract: "Workspace Files" }))).toThrow(/契约 id 非法/);
    expect(() => catalog.register(fakeProvider(recorded, { contract: "https://evil/v1" }))).toThrow(/契约 id 非法/);
    expect(() => catalog.register(fakeProvider(recorded, { actions: [] }))).toThrow(/至少一个 action/);
    expect(() => catalog.register(fakeProvider(recorded, { actions: ["a", "a"] }))).toThrow(/重复项/);
    expect(() => catalog.register(fakeProvider(recorded, { actions: ["../etc/passwd"] }))).toThrow(/非法 action/);
    expect(() => catalog.register(fakeProvider(recorded, { actions: ["resource open"] }))).toThrow(/非法 action/);
    expect(catalog.contracts()).toEqual([]);
  });

  it("refuses a descriptor missing one of the three methods", () => {
    const catalog = new AgentResourceCatalog();
    const broken = fakeProvider(recorded) as unknown as Record<string, unknown>;
    delete broken.close;
    expect(() => catalog.register(broken as unknown as ResourceProviderDefinition<unknown>)).toThrow(/缺少 close/);
  });

  it("snapshots the descriptor, so mutating it after seal changes nothing", async () => {
    const catalog = new AgentResourceCatalog();
    const definition = fakeProvider(recorded) as unknown as {
      contract: string;
      actions: string[];
      dispatch: unknown;
    };
    catalog.register(definition as unknown as ResourceProviderDefinition<{ scope: string }>);
    catalog.seal();

    // Everything a caller still holding the object might try.
    definition.actions.push("resource.write_text");
    definition.contract = "cold-storage/v1";
    definition.dispatch = async () => ({ ok: true, result: "hijacked", message: "" });

    const handle = catalog.openInstance(identity());
    expect(await handle.dispatch({ action: "resource.write_text", params: { binding: "workspace" } }))
      .toMatchObject({ ok: false, code: "invalid_request" });
    expect(await handle.dispatch(READ)).toMatchObject({ ok: true, result: { action: "resource.refresh_roots" } });
    expect(catalog.contracts()).toEqual(["workspace-files/v1"]);
  });

  it("answers which of a plan's contracts it cannot serve", () => {
    const catalog = sealed();
    // A question, not a grant: being able to serve a contract is not the same
    // as any account being allowed to.
    expect(catalog.missingContracts(plan())).toEqual(["cold-storage/v1"]);
  });
});

describe("opening an instance", () => {
  it("refuses before the catalog is sealed", () => {
    const catalog = new AgentResourceCatalog();
    catalog.register(fakeProvider(recorded));
    expect(() => catalog.openInstance(identity())).toThrow(/尚未封存/);
  });

  it("refuses a plan that belongs to another App", () => {
    const catalog = sealed();
    expect(() => catalog.openInstance(identity({ plan: plan({ app: "other-app" }) }))).toThrow(/与实例的 app/);
    expect(catalog.openInstances).toBe(0);
  });

  it("refuses a blank identity", () => {
    const catalog = sealed();
    for (const missing of [{ owner: " " }, { app: "" }, { packageDigest: "" }, { instance: "" }]) {
      expect(() => catalog.openInstance(identity(missing as Partial<ResourceScopeIdentity>))).toThrow(/缺少/);
    }
  });

  it("refuses to open the same owner/app/instance twice, or to reopen a closed one", async () => {
    const catalog = sealed();
    const handle = catalog.openInstance(identity());
    expect(() => catalog.openInstance(identity())).toThrow(/已经打开过/);
    await handle.close();
    expect(() => catalog.openInstance(identity())).toThrow(/不能重开/);
    // A new tab is a new instance id, which is where a fresh decision belongs.
    expect(() => catalog.openInstance(identity({ instance: "tab-2" }))).not.toThrow();
  });

  it("bounds the recent-retirement safety net and expires it", async () => {
    let now = 1_000;
    const catalog = new AgentResourceCatalog({ now: () => now, retiredTtlMs: 100, maxRetired: 2 });
    catalog.register(fakeProvider(recorded));
    catalog.seal();

    for (const instance of ["tab-1", "tab-2", "tab-3"]) {
      await catalog.openInstance(identity({ instance })).close();
    }
    expect(catalog.retiredInstances).toBe(2);
    // FIFO bounding drops the oldest safety-net entry. Instance ids are issued
    // by trusted coordinator code and must still be fresh; the catalog cannot
    // provide permanent nonce storage without growing forever.
    expect(() => catalog.openInstance(identity({ instance: "tab-1" }))).not.toThrow();
    expect(() => catalog.openInstance(identity({ instance: "tab-2" }))).toThrow(/不能重开/);

    now += 101;
    expect(catalog.retiredInstances).toBe(0);
    expect(() => catalog.openInstance(identity({ instance: "tab-2" }))).not.toThrow();
  });

  it("registers the instance without opening any provider", () => {
    const catalog = sealed();
    catalog.openInstance(identity());
    expect(catalog.openInstances).toBe(1);
    expect(catalog.openScopes).toBe(0);
    expect(recorded.opens).toHaveLength(0);
  });

  it("snapshots the plan, so mutating it afterwards cannot widen the handle", async () => {
    const catalog = sealed();
    const mutable = plan() as unknown as { bindings: Array<{ binding: string; contract: string }> };
    const handle = catalog.openInstance(identity({ plan: mutable as unknown as ResourceBindingPlan }));

    mutable.bindings.push({ binding: "secrets", contract: "workspace-files/v1" });
    mutable.bindings[0] = { binding: "workspace", contract: "cold-storage/v1" };

    // The added binding is not reachable, and the rebound one still resolves to
    // the contract it had when the handle was issued.
    expect(await handle.dispatch({ action: "resource.refresh_roots", params: { binding: "secrets" } }))
      .toMatchObject({ ok: false, code: "invalid_request" });
    expect(await handle.dispatch(READ)).toMatchObject({ ok: true });
    expect(recorded.opens[0].contract).toBe("workspace-files/v1");
  });
});

describe("dispatch stops before the provider", () => {
  it("refuses a binding the plan does not declare", async () => {
    const handle = sealed().openInstance(identity());
    expect(await handle.dispatch({ action: "resource.refresh_roots", params: { binding: "secrets" } }))
      .toMatchObject({ ok: false, code: "invalid_request" });
    expect(recorded.opens).toHaveLength(0);
  });

  it("refuses a proposal with no binding at all", async () => {
    const handle = sealed().openInstance(identity());
    expect(await handle.dispatch({ action: "resource.refresh_roots", params: {} }))
      .toMatchObject({ ok: false, code: "invalid_request" });
    expect(recorded.opens).toHaveLength(0);
  });

  it("refuses a declared binding whose contract nobody installed", async () => {
    // The plan asks for `cold-storage/v1`; this deployment composed no provider
    // for it, and there is deliberately no generic proxy to fall back to.
    const handle = sealed().openInstance(identity());
    expect(await handle.dispatch({ action: "resource.refresh_roots", params: { binding: "archive" } }))
      .toMatchObject({ ok: false, code: "no_authority" });
    expect(recorded.opens).toHaveLength(0);
  });

  it("refuses an action the provider did not enumerate", async () => {
    const handle = sealed().openInstance(identity());
    expect(await handle.dispatch({ action: "resource.write_text", params: { binding: "workspace" } }))
      .toMatchObject({ ok: false, code: "invalid_request" });
    expect(recorded.opens).toHaveLength(0);
  });

  it("ignores identity fields a proposal tries to state", async () => {
    const handle = sealed().openInstance(identity());
    await handle.dispatch({
      action: "resource.refresh_roots",
      params: { binding: "workspace", owner: "bob", scope: "other", instance: "tab-9", approved: "true" },
    });
    // Not rejected — not consulted. The context is built from the record the
    // handle was issued against and nothing else.
    expect(recorded.opens[0]).toMatchObject({ owner: "alice", publisher: "octopus:first-party", app: "demo", instance: "tab-1" });
    expect(recorded.opens[0].scope).not.toContain("bob");
  });

  it("turns `no authority` into a refusal rather than an empty success", async () => {
    const handle = sealed({ open: () => null }).openInstance(identity());
    expect(await handle.dispatch(READ)).toMatchObject({ ok: false, code: "no_authority" });
    expect(recorded.calls).toHaveLength(0);
  });
});

describe("scopes", () => {
  it("opens on first use, once, and never crosses owners", async () => {
    const catalog = sealed();
    const alice = catalog.openInstance(identity());
    const bob = catalog.openInstance(identity({ owner: "bob" }));
    await alice.dispatch(READ);
    await alice.dispatch(READ);
    await bob.dispatch(READ);

    expect(recorded.opens).toHaveLength(2);
    expect(catalog.openScopes).toBe(2);
    const [aliceScope, bobScope] = recorded.opens.map((row) => row.scope);
    expect(aliceScope).not.toBe(bobScope);
    // The key is derived from the trusted record, so no caller can choose
    // another's.
    expect(recorded.calls.map((row) => row.scope)).toEqual([aliceScope, aliceScope, bobScope]);
  });

  it("gives one instance a separate scope per binding", async () => {
    const catalog = new AgentResourceCatalog();
    catalog.register(fakeProvider(recorded));
    catalog.register(fakeProvider(recorded, { contract: "cold-storage/v1" }));
    catalog.seal();
    const handle = catalog.openInstance(identity());

    await handle.dispatch(READ);
    await handle.dispatch({ action: "resource.refresh_roots", params: { binding: "archive" } });
    expect(new Set(recorded.opens.map((row) => row.scope)).size).toBe(2);
  });
});

describe("closing", () => {
  it("closes by handle, by instance, by owner and by shutdown", async () => {
    const catalog = sealed();
    const alice = catalog.openInstance(identity());
    const aliceTwo = catalog.openInstance(identity({ instance: "tab-2" }));
    const bob = catalog.openInstance(identity({ owner: "bob" }));
    for (const handle of [alice, aliceTwo, bob]) await handle.dispatch(READ);
    expect(catalog.openScopes).toBe(3);

    await aliceTwo.close();
    expect(catalog.openScopes).toBe(2);
    await catalog.closeInstance({ owner: "alice", publisher: "octopus:first-party", app: "demo", instance: "tab-1" });
    expect(catalog.openScopes).toBe(1);
    await catalog.closeOwner("bob");
    expect(catalog.openScopes).toBe(0);
    await catalog.shutdown();
    expect(recorded.closes).toHaveLength(3);
  });

  it("does NOT open a provider for a handle closed before its first use", async () => {
    const catalog = sealed();
    const handle = catalog.openInstance(identity());
    await handle.close();

    // The late message a channel can still deliver after a tab is gone.
    expect(await handle.dispatch(READ)).toMatchObject({ ok: false, code: "scope_closed" });
    expect(recorded.opens).toHaveLength(0);
    expect(recorded.closes).toHaveLength(0);
    expect(catalog.openInstances).toBe(0);
  });

  it("retires an owner's untouched handles, while a new instance still works", async () => {
    const catalog = sealed();
    const stale = catalog.openInstance(identity());

    // Nothing has been read yet: with lazy registration there would be no scope
    // to match, and this handle would be indistinguishable from a new tab.
    await catalog.closeOwner("alice");

    expect(await stale.dispatch(READ)).toMatchObject({ ok: false, code: "scope_closed" });
    expect(recorded.opens).toHaveLength(0);
    const fresh = catalog.openInstance(identity({ instance: "tab-2" }));
    expect(await fresh.dispatch(READ)).toMatchObject({ ok: true });
    expect(recorded.opens).toHaveLength(1);
  });

  it("refuses everything after shutdown, permanently", async () => {
    const catalog = sealed();
    const handle = catalog.openInstance(identity());
    await catalog.shutdown();

    expect(await handle.dispatch(READ)).toMatchObject({ ok: false, code: "scope_closed" });
    expect(() => catalog.openInstance(identity({ instance: "tab-9" }))).toThrow(/已经停止/);
    expect(recorded.opens).toHaveLength(0);
  });

  it("refuses to serve while that instance's teardown is in flight", async () => {
    let release: (() => void) | null = null;
    const catalog = sealed({ close: () => new Promise<void>((resolve) => { release = resolve; }) });
    const handle = catalog.openInstance(identity());
    await handle.dispatch(READ);

    const closing = catalog.closeOwner("alice");
    // Synchronously after the close STARTS: nothing new may begin, whatever the
    // release is still doing.
    expect(await handle.dispatch(READ)).toMatchObject({ ok: false, code: "scope_closed" });
    expect(recorded.opens).toHaveLength(1);

    release!();
    await closing;
  });

  it("makes every close caller wait for the same teardown", async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const catalog = sealed({
      close: () => new Promise<void>((resolve) => {
        release = () => { order.push("released"); resolve(); };
      }),
    });
    const handle = catalog.openInstance(identity());
    await handle.dispatch(READ);

    const first = catalog.closeOwner("alice").then(() => order.push("first"));
    const second = handle.close().then(() => order.push("second"));
    const third = catalog.closeInstance({ owner: "alice", publisher: "octopus:first-party", app: "demo", instance: "tab-1" })
      .then(() => order.push("third"));
    const fourth = catalog.shutdown().then(() => order.push("fourth"));
    release!();
    await Promise.all([first, second, third, fourth]);

    // One teardown, four callers, and none of them returned early.
    expect(recorded.closes).toHaveLength(1);
    expect(order[0]).toBe("released");
    expect(order.slice(1).sort()).toEqual(["first", "fourth", "second", "third"]);
  });

  it("publishes the teardown before a provider close can re-enter the catalog", async () => {
    let release: (() => void) | null = null;
    let reentered: Promise<void> | null = null;
    let handle!: AgentResourceInstance;
    const catalog = sealed({
      close: () => {
        // A close callback is trusted code and can synchronously trigger the
        // same lifecycle edge. It must see the already-published promise.
        reentered = handle.close();
        return new Promise<void>((resolve) => { release = resolve; });
      },
    });
    handle = catalog.openInstance(identity());
    await handle.dispatch(READ);

    const outer = handle.close();
    expect(reentered).toBe(outer);
    let finished = false;
    void reentered!.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);

    release!();
    await outer;
    expect(finished).toBe(true);
    expect(recorded.closes).toHaveLength(1);
  });

  it("is a no-op for an instance that was never opened", async () => {
    const catalog = sealed();
    await expect(catalog.closeInstance({ owner: "nobody", publisher: "octopus:first-party", app: "demo", instance: "tab-7" })).resolves.toBeUndefined();
    await expect(catalog.closeOwner("nobody")).resolves.toBeUndefined();
  });
});

describe("a provider that misbehaves", () => {
  it("does not let its exception or its message reach the caller", async () => {
    const catalog = sealed({ dispatch: () => Promise.reject(new Error("ENOENT: open '/home/alice/.ssh/id_rsa'")) });
    const handle = catalog.openInstance(identity());
    const answer = await handle.dispatch(READ);

    expect(answer).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(answer)).not.toContain("id_rsa");
  });

  it("survives one that throws while opening or closing", async () => {
    const throwingOpen = sealed({ open: () => { throw new Error("/etc/shadow"); } });
    const answer = await throwingOpen.openInstance(identity()).dispatch(READ);
    expect(answer).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(answer)).not.toContain("shadow");

    // A close that fails is logged and swallowed: the instance is already
    // unreachable, so a rejection here could only make a completed revocation
    // look like a failed one.
    const throwingClose = sealed({ close: () => { throw new Error("nope"); } });
    const handle = throwingClose.openInstance(identity());
    await handle.dispatch(READ);
    await expect(handle.close()).resolves.toBeUndefined();
    expect(throwingClose.openScopes).toBe(0);
    expect(await handle.dispatch(READ)).toMatchObject({ ok: false, code: "scope_closed" });

    const rejectingClose = sealed({ close: () => Promise.reject(new Error("also nope")) });
    const second = rejectingClose.openInstance(identity());
    await second.dispatch(READ);
    await expect(rejectingClose.closeOwner("alice")).resolves.toBeUndefined();
  });

  it("bounds and sanitises the refusal text it writes", () => {
    const refusal = resourceRefusal("unavailable", `line\u0000break${"x".repeat(400)}`);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.message).not.toContain("\u0000");
    expect(refusal.message.length).toBeLessThanOrEqual(200);
  });
});

describe("the handle's own surface", () => {
  it("is two methods, and neither names an identity", () => {
    const handle: AgentResourceInstance = sealed().openInstance(identity());
    expect(Object.keys(handle).sort()).toEqual(["close", "dispatch"]);
  });
});
