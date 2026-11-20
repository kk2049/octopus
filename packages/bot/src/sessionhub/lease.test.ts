/**
 * The admission lease, and the three things it must get right at once:
 * approval is single-flight, the same button pressed twice is one intent, and
 * provider-native conversations accept another message after Gate handoff.
 */

import { describe, it, expect } from "vitest";
import { SessionLeases, leaseKey } from "./lease.js";

const parts = { owner: "alice", device: "laptop", cliKind: "claude", sessionId: "s1" };
const other = { ...parts, sessionId: "s2" };

describe("SessionLeases", () => {
  it("a second, DIFFERENT instruction on the same session is refused", () => {
    const l = new SessionLeases();
    expect(l.acquire(parts, "alice", "fp-a").ok).toBe(true);
    const second = l.acquire(parts, "alice", "fp-b");
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.message).toMatch(/不并行驱动/);
  });

  it("hands a dispatched append to the provider so another message may enter", () => {
    const l = new SessionLeases();
    const first = l.acquire(parts, "alice", "fp-a");
    if (!first.ok) throw new Error("first acquire failed");
    l.handoff(first.lease);
    expect(l.acquire(parts, "alice", "fp-b").ok).toBe(true);
  });

  it("the SAME instruction re-submitted gets the same lease, not a conflict", () => {
    const l = new SessionLeases();
    const first = l.acquire(parts, "alice", "fp-a");
    const again = l.acquire(parts, "alice", "fp-a");
    // A double-clicked button, a retried fetch. The kernel dedupes these into
    // one approval card; telling the user "busy" would make the idempotent
    // path look like a failure.
    expect(again.ok).toBe(true);
    expect(again.ok && again.lease).toBe(first.ok && first.lease);
  });

  it("a different session is unaffected", () => {
    const l = new SessionLeases();
    l.acquire(parts, "alice", "fp-a");
    expect(l.acquire(other, "alice", "fp-b").ok).toBe(true);
  });

  it("the key cannot be forged by a device name containing the separator", () => {
    // JSON, not "a|b|c". Reachable only if usernames/devices loosen, which is
    // exactly why it must not be load-bearing.
    expect(leaseKey({ owner: "a", device: 'b","c', cliKind: "claude", sessionId: "s" })).not.toBe(
      leaseKey({ owner: "a", device: "b", cliKind: 'c","claude', sessionId: "s" }),
    );
  });

  it("a lease bound to a decided approval stops blocking", () => {
    let live = true;
    const l = new SessionLeases({ pendingIsLive: () => live });
    const first = l.acquire(parts, "alice", "fp-a");
    if (!first.ok) throw new Error("first acquire failed");
    l.bindPending(first.lease, "pc-1");
    expect(l.acquire(parts, "alice", "fp-b").ok).toBe(false);
    // Decided on /pending, from a Feishu button, or by expiry — the lease is a
    // view of the approval queue, not a second copy of it.
    live = false;
    expect(l.acquire(parts, "alice", "fp-b").ok).toBe(true);
  });

  it("with no liveness oracle it assumes still-pending (fail closed)", () => {
    const l = new SessionLeases();
    const first = l.acquire(parts, "alice", "fp-a");
    if (!first.ok) throw new Error("first acquire failed");
    l.bindPending(first.lease, "pc-1");
    expect(l.acquire(parts, "alice", "fp-b").ok).toBe(false);
  });

  it("a pending-bound lease says WHICH card is in the way", () => {
    const l = new SessionLeases();
    const first = l.acquire(parts, "alice", "fp-a");
    if (!first.ok) throw new Error("first acquire failed");
    l.bindPending(first.lease, "pc-1");
    const blocked = l.acquire(parts, "alice", "fp-b");
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.pendingCallId).toBe("pc-1");
    expect(blocked.ok === false && blocked.message).toMatch(/待批准/);
  });

  it("deciding the card frees the session", () => {
    const l = new SessionLeases();
    const first = l.acquire(parts, "alice", "fp-a");
    if (!first.ok) throw new Error("first acquire failed");
    l.bindPending(first.lease, "pc-1");
    expect(l.releaseByPending("pc-1")).toBe(true);
    expect(l.acquire(parts, "alice", "fp-b").ok).toBe(true);
    expect(l.releaseByPending("pc-1")).toBe(false); // idempotent
  });

  it("a holder that never comes back does not wedge the session forever", () => {
    let now = 1_000_000;
    const l = new SessionLeases({ now: () => now, ttlMs: 60_000 });
    l.acquire(parts, "alice", "fp-a");
    now += 59_000;
    expect(l.acquire(parts, "alice", "fp-b").ok).toBe(false);
    now += 2_000;
    expect(l.acquire(parts, "alice", "fp-b").ok).toBe(true);
  });

  it("a lease waiting on a human gets a longer window than a running call", () => {
    let now = 1_000_000;
    const l = new SessionLeases({ now: () => now, ttlMs: 60_000, pendingTtlMs: 600_000 });
    const first = l.acquire(parts, "alice", "fp-a");
    if (!first.ok) throw new Error("first acquire failed");
    l.bindPending(first.lease, "pc-1");
    now += 120_000; // past the running-call TTL, well inside the approval one
    expect(l.acquire(parts, "alice", "fp-b").ok).toBe(false);
  });

  it("revoking an owner's permissions drops their leases and nobody else's", () => {
    const l = new SessionLeases();
    l.acquire(parts, "alice", "fp-a");
    l.acquire({ ...parts, owner: "bob" }, "bob", "fp-a");
    expect(l.releaseOwner("alice")).toBe(1);
    expect(l.size).toBe(1);
    expect(l.acquire(parts, "alice", "fp-b").ok).toBe(true);
  });
});
