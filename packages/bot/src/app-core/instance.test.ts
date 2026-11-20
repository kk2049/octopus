import { describe, expect, it, vi } from "vitest";
import { SessionPlusInstances, type SessionPlusPrincipal } from "./instance.js";

const PACKAGE = "a".repeat(64);

function input(principal: SessionPlusPrincipal) {
  return {
    principal,
    packageDigest: PACKAGE,
    contractDigest: "b".repeat(32),
    streamId: "stream",
    head: 0,
    projection: null,
  } as const;
}

describe("SessionPlusInstances capacity", () => {
  it("binds delegation to the handle and filters first, stream and operation projections", () => {
    const instances = new SessionPlusInstances(() => new Set([PACKAGE]), () => 1000, 60_000, () => {}, undefined, "session-plus", (_binding, raw) => {
      const p = raw as { sessions?: Array<{ resourceId: string }>; operations?: Array<{ resourceId: string }> } | null;
      return { sessions: p?.sessions?.filter((s) => s.resourceId === "shared") ?? [], operations: p?.operations?.filter((s) => s.resourceId === "shared") ?? [] };
    });
    const principal = { owner: "issuer", credential: "guest", session: true, delegation: { shareId: "sh", viewer: "guest" } };
    const opened = instances.create({ ...input(principal), projection: { sessions: [{ resourceId: "shared" }, { resourceId: "private" }] } });
    expect(opened.binding.projection).toMatchObject({ sessions: [{ resourceId: "shared" }] });
    expect(instances.resolve(opened.handle, { ...principal, delegation: undefined }).ok).toBe(false);
    expect(instances.resolve(opened.handle, { ...principal, delegation: { shareId: "other", viewer: "guest" } }).ok).toBe(false);
    instances.updateStreamBinding(opened.binding.id, "stream", 1, { sessions: [{ resourceId: "private" }] });
    instances.recordOperation(opened.binding.id, { id: "op", resourceId: "private" });
    const live = instances.resolve(opened.handle, principal);
    expect(live.ok && live.binding.projection).toEqual({ sessions: [], operations: [] });
    instances.stop();
  });
  it("bounds credential, owner and process totals, and returns capacity on close", () => {
    const instances = new SessionPlusInstances(
      () => new Set([PACKAGE]),
      () => 1_000,
      60_000,
      () => {},
      { perCredential: 2, perOwner: 3, global: 4 },
    );
    const aliceA = { owner: "alice", credential: "browser-a", session: true };
    const aliceB = { owner: "alice", credential: "browser-b", session: true };
    const bob = { owner: "bob", credential: "browser-b", session: true };
    const carol = { owner: "carol", credential: "browser-c", session: true };

    const first = instances.create(input(aliceA));
    instances.create(input(aliceA));
    expect(() => instances.create(input(aliceA))).toThrow(/limit/);
    instances.create(input(aliceB));
    expect(() => instances.create(input(aliceB))).toThrow(/limit/);
    instances.create(input(bob));
    expect(() => instances.create(input(carol))).toThrow(/limit/);

    expect(instances.destroy(first.handle, aliceA)).toBe(true);
    expect(() => instances.create(input(carol))).not.toThrow();
    expect(instances.size).toBe(4);
    instances.stop();
  });

  it("reaps expired rows before applying the ceiling", () => {
    let now = 0;
    const instances = new SessionPlusInstances(
      () => new Set([PACKAGE]),
      () => now,
      10,
      () => {},
      { perCredential: 1, perOwner: 1, global: 1 },
    );
    const principal = { owner: "alice", credential: "browser-a", session: true };
    instances.create(input(principal));
    now = 11;
    expect(() => instances.create(input(principal))).not.toThrow();
    expect(instances.size).toBe(1);
    instances.stop();
  });

  it("counts in-flight reservations and swaps a commit into the same slot", () => {
    const instances = new SessionPlusInstances(
      () => new Set([PACKAGE]),
      () => 1_000,
      60_000,
      () => {},
      { perCredential: 2, perOwner: 2, global: 2 },
    );
    const principal = { owner: "alice", credential: "browser-a", session: true };
    const first = instances.reserve(principal);
    const second = instances.reserve(principal);
    expect(() => instances.reserve(principal)).toThrow(/limit/);

    const committed = first.commit(input(principal));
    expect(committed.handle).toBeTruthy();
    // One live row + the second reservation still fills the same ceiling.
    expect(() => instances.create(input(principal))).toThrow(/limit/);
    second.release();
    expect(() => instances.create(input(principal))).not.toThrow();
    expect(instances.size).toBe(2);
    instances.stop();
  });

  it("cancels a pending admission when its credential ends", () => {
    const instances = new SessionPlusInstances(() => new Set([PACKAGE]));
    const principal = { owner: "alice", credential: "browser-a", session: true };
    const reservation = instances.reserve(principal);
    expect(instances.releaseCredential("alice", "browser-a")).toBe(0);
    expect(() => reservation.commit(input(principal))).toThrow(/reservation ended/);
    instances.stop();
  });

  it("sweeps bindings whose retained release was retired", () => {
    let servable = new Set([PACKAGE]);
    const destroyed = vi.fn();
    const instances = new SessionPlusInstances(
      () => servable,
      () => 1_000,
      60_000,
      destroyed,
    );
    const principal = { owner: "alice", credential: "browser-a", session: true };
    instances.create(input(principal));

    servable = new Set();
    expect(instances.reapExpired()).toBe(1);
    expect(instances.size).toBe(0);
    expect(destroyed).toHaveBeenCalledWith(expect.objectContaining({ packageDigest: PACKAGE }), "instance_stale");
    instances.stop();
  });
});

describe("SessionPlusInstances projection revisions", () => {
  it("advances for resource projections without changing the durable State head", () => {
    const instances = new SessionPlusInstances(() => new Set([PACKAGE]));
    const principal = { owner: "alice", credential: "browser-a", session: true };
    const created = instances.create(input(principal));
    const listener = vi.fn();
    const subscription = instances.subscribe(created.handle, principal, listener);

    expect(subscription?.initial).toMatchObject({ revision: 0, projection: null });
    expect(instances.update(created.handle, { sessions: [{ resourceId: "first" }] })).toBe(1);
    expect(instances.update(created.handle, { sessions: [{ resourceId: "second" }] })).toBe(2);
    expect(listener.mock.calls.map(([event]) => event.revision)).toEqual([1, 2]);

    const resolved = instances.resolve(created.handle, principal);
    expect(resolved).toMatchObject({
      ok: true,
      binding: {
        head: 0,
        viewRevision: 2,
        projection: { sessions: [{ resourceId: "second" }] },
      },
    });
    subscription?.close();
    instances.stop();
  });
});
