/**
 * The capability graph. THIS is the trusted computing base.
 *
 * Everything an authorization decision depends on is here and nothing else is:
 * a tree of Contexts, a Context-local slot table, capabilities that can only
 * ever narrow, and one function — `authorize` — that says whether a
 * (Context, slot, operation) triple may proceed.
 *
 * What is deliberately NOT here, and used to be: argument schemas, byte
 * accounting, canonical hashing, policy, adapters, audit records, the pending
 * approval state machine, Object definitions. Each of those was in the kernel
 * because it was convenient, and each of them enlarged the surface on which a
 * mistake means "the wrong person reached the resource". They now sit above
 * this file, where a bug costs something smaller.
 *
 * Why no cryptography: seL4's capabilities are not unforgeable because they are
 * signed, they are unforgeable because user space only ever holds an index into
 * a table the kernel owns. Same here — the store below never leaves this
 * object, and an untrusted runtime only ever holds a slot name that is
 * meaningless outside its own Context.
 *
 * ── The invariants, in one place ───────────────────────────────────────────
 *
 *  1. A Context is created by the trusted plane, under a live parent, and is
 *     never revived once destroyed.
 *  2. A capability is reachable only as (Context, slot). A slot is never
 *     silently replaced, and a capability id is not a credential.
 *  3. `derive` keeps the Object, narrows the rights, narrows the terms, and
 *     may only install into a DESCENDANT of the granting Context.
 *  4. `authorize` re-walks the whole chain every time: any revoked capability
 *     or destroyed holder anywhere above invalidates everything below.
 *  5. Attenuation is re-asserted at authorize time, not trusted from the row —
 *     a corrupted or hand-edited row cannot widen anything.
 *  6. Every refusal is a reason, never an exception, so the caller above can
 *     audit it without a try/catch deciding security.
 */

import { randomUUID } from "node:crypto";
import type { CapabilityStore, CapabilityRow, ContextRow, RootRef } from "./store.js";
import type { CapabilityId, ContextId, GrantTerms, ObjectId, Operation, Slot } from "./types.js";

/** What `authorize` answers. A refusal carries its reason and nothing else. */
export type Authorization =
  | { ok: true; capabilityId: CapabilityId; objectId: ObjectId; terms: GrantTerms }
  | { ok: false; reason: string };

/** Depth guard: a parent chain longer than this is a corrupt store, not a tree. */
const MAX_CHAIN = 256;

export class CapabilityGraph {
  constructor(
    private store: CapabilityStore,
    private nowMs: () => number = Date.now,
  ) {}

  // ── contexts ──

  createContext(kind: string, metadata: Record<string, string> = {}, parent: ContextId | null = null): ContextId {
    if (parent !== null) {
      const p = this.store.getContext(parent);
      if (!p) throw new Error("parent context does not exist");
      // A destroyed Context has no descendants — creating one would give it a
      // live child that outlives the lifecycle that was supposed to end.
      if (p.lifecycle !== "live") throw new Error(`parent context ${parent} is destroyed`);
    }
    const id = `ctx_${randomUUID()}`;
    this.store.putContext({
      id,
      kind,
      metadata: { ...metadata },
      parent,
      lifecycle: "live",
      createdAt: this.nowMs(),
      destroyedAt: null,
    });
    return id;
  }

  /** Idempotent. A destroyed Context is never revived — derive a new one. */
  destroyContext(id: ContextId): void {
    const ctx = this.store.getContext(id);
    if (!ctx || ctx.lifecycle !== "live") return;
    this.store.setContextDestroyed(id, this.nowMs());
  }

  contextIsLive(id: ContextId): boolean {
    return this.store.getContext(id)?.lifecycle === "live";
  }

  contextOf(id: ContextId): ContextRow | null {
    return this.store.getContext(id);
  }

  contextMetadata(id: ContextId): Readonly<Record<string, string>> | null {
    return this.store.getContext(id)?.metadata ?? null;
  }

  /** Ancestry, root first, including `id` itself. */
  ancestry(id: ContextId): ContextId[] {
    const out: ContextId[] = [];
    const seen = new Set<ContextId>();
    let cur: ContextRow | null = this.store.getContext(id);
    while (cur && !seen.has(cur.id) && out.length < MAX_CHAIN) {
      seen.add(cur.id);
      out.unshift(cur.id);
      cur = cur.parent ? this.store.getContext(cur.parent) : null;
    }
    return out;
  }

  /**
   * Is `descendant` inside `ancestor`'s subtree (or the same Context)?
   *
   * Walks UP from the descendant, which is O(depth). The previous shape walked
   * DOWN by enumerating every Context ever created and testing each one — a
   * full scan of an unbounded table, on the hot path of every request.
   */
  isWithin(ancestor: ContextId, descendant: ContextId): boolean {
    const seen = new Set<ContextId>();
    let cur: ContextRow | null = this.store.getContext(descendant);
    while (cur && !seen.has(cur.id) && seen.size < MAX_CHAIN) {
      if (cur.id === ancestor) return true;
      seen.add(cur.id);
      cur = cur.parent ? this.store.getContext(cur.parent) : null;
    }
    return false;
  }

  // ── capabilities ──

  /**
   * Mint a root capability from a trusted fact. Never reachable from a bound
   * facade; the control plane calls it after it has itself verified ownership
   * (e.g. a device token row proving `(owner, device)`).
   *
   * `terms` is the ceiling for everything derived below: no descendant can
   * auto-allow an operation this root does not.
   */
  mintRoot(
    contextId: ContextId,
    slot: Slot,
    objectId: ObjectId,
    rights: Iterable<Operation>,
    terms: GrantTerms,
    knownOperations: ReadonlySet<Operation>,
  ): void {
    const ctx = this.liveContext(contextId);
    if (this.store.getSlot(ctx.id, slot)) {
      throw new Error(`slot "${slot}" is occupied; a slot is never silently replaced`);
    }
    const wanted = new Set(rights);
    for (const r of wanted) {
      if (!knownOperations.has(r)) throw new Error(`operation "${r}" is not in ${objectId}'s registry`);
    }
    if (wanted.size === 0) throw new Error("a root needs at least one right");
    const autoAllow = [...new Set(terms.autoAllow)].filter((op) => wanted.has(op));
    const cap: CapabilityRow = {
      id: `cap_${randomUUID()}`,
      objectId,
      rights: [...wanted],
      terms: { autoAllow },
      parentCapabilityId: null,
      holderContextId: contextId,
      revokedAt: null,
    };
    this.store.putCapability(cap);
    this.store.putSlot({ contextId, slot, capabilityId: cap.id });
  }

  /**
   * Install a strictly-attenuated child capability into another Context.
   * Trusted control plane only: this is how "user ∩ app ∩ controller ∩ run" is
   * materialised once, at lifecycle boundaries, instead of being recomputed
   * from caller-supplied strings on every call.
   *
   * `terms` defaults to "whatever the parent auto-allows, of the rights being
   * handed down" — the same posture as before this existed. Passing it
   * explicitly can only narrow further.
   */
  derive(
    sourceContextId: ContextId,
    sourceSlot: Slot,
    targetContextId: ContextId,
    targetSlot: Slot,
    requestedRights: Iterable<Operation>,
    requestedTerms?: Partial<GrantTerms>,
  ): void {
    // @architecture enforces=AUTH-003 label="Derive only into descendants and attenuate rights/terms"
    const source = this.liveContext(sourceContextId);
    const target = this.liveContext(targetContextId);
    if (target.id === source.id) throw new Error("derive target must be a different context");
    // Authority flows down the Context tree and nowhere else: a capability
    // cannot be installed into a Context that is not a descendant of the one
    // handing it out, so "derive into a sibling" is not expressible.
    if (!this.isWithin(source.id, target.id)) {
      throw new Error("derive target must descend from the source context");
    }
    if (this.store.getSlot(target.id, targetSlot)) {
      throw new Error(`slot "${targetSlot}" is occupied; a slot is never silently replaced`);
    }
    const binding = this.store.getSlot(source.id, sourceSlot);
    if (!binding) throw new Error(`slot "${sourceSlot}" does not exist in the source context`);
    const parent = this.store.getCapability(binding.capabilityId);
    if (!parent) throw new Error("source capability is missing");
    const chain = this.validateChain(parent);
    if (!chain.ok) throw new Error(`cannot derive from an invalid capability: ${chain.reason}`);

    const parentRights = new Set(parent.rights);
    const wanted = new Set(requestedRights);
    for (const r of wanted) {
      if (!parentRights.has(r)) throw new Error(`derive may not add right "${r}"`);
    }
    if (wanted.size === 0) throw new Error("derive needs at least one right");

    // Terms narrow the same way rights do: parent's ∩ this grant's rights ∩
    // whatever was explicitly asked for. A derive can never auto-allow more
    // than the capability it came from.
    const parentAuto = new Set(parent.terms.autoAllow);
    const askedAuto = requestedTerms?.autoAllow ? new Set(requestedTerms.autoAllow) : null;
    const autoAllow = [...wanted].filter((op) => parentAuto.has(op) && (askedAuto === null || askedAuto.has(op)));

    const child: CapabilityRow = {
      id: `cap_${randomUUID()}`,
      objectId: parent.objectId, // Object can never change across a derive.
      rights: [...wanted],
      terms: { autoAllow },
      parentCapabilityId: parent.id,
      holderContextId: targetContextId,
      revokedAt: null,
    };
    this.store.putCapability(child);
    this.store.putSlot({ contextId: targetContextId, slot: targetSlot, capabilityId: child.id });
  }

  /** Mark one capability revoked; every descendant fails at its next authorize. */
  revoke(contextId: ContextId, slot: Slot): boolean {
    const binding = this.store.getSlot(contextId, slot);
    if (!binding) return false;
    const cap = this.store.getCapability(binding.capabilityId);
    if (!cap || cap.revokedAt) return false;
    this.store.setCapabilityRevoked(cap.id, new Date(this.nowMs()).toISOString());
    return true;
  }

  // ── the decision ──

  /**
   * The whole authorization question, answered from the graph alone.
   *
   * Order matters and is the order a reviewer should read: the Context must be
   * live, the slot must exist INSIDE it, the entire chain above must still be
   * valid, and the operation must be inside this capability's rights. Nothing
   * here consults arguments, policy or the resource — those come after, and
   * they can only ever narrow this answer further.
   */
  authorize(contextId: ContextId, slot: Slot, operation: Operation): Authorization {
    // @architecture enforces=AUTH-001,AUTH-003 label="Revalidate bound Context, slot and the complete ancestor chain"
    const ctx = this.store.getContext(contextId);
    if (!ctx) return { ok: false, reason: "unknown context" };
    if (ctx.lifecycle !== "live") return { ok: false, reason: "context destroyed" };

    const binding = this.store.getSlot(contextId, slot);
    if (!binding) return { ok: false, reason: `no capability in slot "${slot}"` };
    const cap = this.store.getCapability(binding.capabilityId);
    if (!cap) return { ok: false, reason: "capability missing" };

    const chain = this.validateChain(cap);
    if (!chain.ok) return { ok: false, reason: chain.reason };

    if (!cap.rights.includes(operation)) {
      return { ok: false, reason: `right "${operation}" not held in slot "${slot}"` };
    }
    return { ok: true, capabilityId: cap.id, objectId: cap.objectId, terms: cap.terms };
  }

  /** Rights currently held in a Context's slot; [] when absent or revoked. */
  rightsOf(contextId: ContextId, slot: Slot): Operation[] {
    const ctx = this.store.getContext(contextId);
    if (!ctx || ctx.lifecycle !== "live") return [];
    const binding = this.store.getSlot(contextId, slot);
    if (!binding) return [];
    const cap = this.store.getCapability(binding.capabilityId);
    if (!cap || !this.validateChain(cap).ok) return [];
    return [...cap.rights];
  }

  /** Terms currently attached to a Context's slot; empty when absent or revoked. */
  termsOf(contextId: ContextId, slot: Slot): GrantTerms {
    const binding = this.store.getSlot(contextId, slot);
    const cap = binding ? this.store.getCapability(binding.capabilityId) : null;
    if (!cap || !this.validateChain(cap).ok) return { autoAllow: [] };
    return cap.terms;
  }

  slotsOf(contextId: ContextId): Slot[] {
    return this.store.slotsOf(contextId).map((s) => s.slot);
  }

  objectIdOf(contextId: ContextId, slot: Slot): ObjectId | null {
    const binding = this.store.getSlot(contextId, slot);
    const cap = binding ? this.store.getCapability(binding.capabilityId) : null;
    return cap ? cap.objectId : null;
  }

  /**
   * Every still-usable root capability over an Object, with the Context and
   * slot holding it.
   *
   * This exists so a control plane can keep "exactly one live root per account"
   * true ACROSS RESTARTS. A plane that remembers its roots in a Map mints a
   * second one after a reboot and then revokes only the newer tree, leaving the
   * older one — and everything derived from it — alive. The store already knows
   * the answer; this is how the plane asks it.
   */
  rootsOf(objectId: ObjectId): RootRef[] {
    const out: RootRef[] = [];
    for (const ref of this.store.rootsOf(objectId)) {
      const holder = this.store.getContext(ref.contextId);
      if (!holder || holder.lifecycle !== "live") continue;
      const cap = this.store.getCapability(ref.capabilityId);
      if (!cap || !this.validateChain(cap).ok) continue;
      out.push(ref);
    }
    return out;
  }

  // ── internals ──

  private liveContext(id: ContextId): ContextRow {
    const ctx = this.store.getContext(id);
    if (!ctx) throw new Error(`unknown context ${id}`);
    if (ctx.lifecycle !== "live") throw new Error(`context ${id} is destroyed`);
    return ctx;
  }

  /**
   * Walk the capability chain to its root. Any revoked capability or any
   * destroyed holder Context invalidates every descendant — which is why
   * revocation does not need to rewrite rows.
   */
  private validateChain(cap: CapabilityRow): { ok: true } | { ok: false; reason: string } {
    let cur: CapabilityRow | null = cap;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur.id)) return { ok: false, reason: "capability chain is cyclic" };
      if (seen.size >= MAX_CHAIN) return { ok: false, reason: "capability chain is too long" };
      seen.add(cur.id);
      if (cur.revokedAt) return { ok: false, reason: "capability revoked" };
      const holder = this.store.getContext(cur.holderContextId);
      if (!holder) return { ok: false, reason: "holder context missing" };
      if (holder.lifecycle !== "live") return { ok: false, reason: "an ancestor context was destroyed" };
      if (cur.objectId !== cap.objectId) return { ok: false, reason: "capability chain changes object" };
      if (!cur.parentCapabilityId) return { ok: true };
      const parent: CapabilityRow | null = this.store.getCapability(cur.parentCapabilityId);
      if (!parent) return { ok: false, reason: "parent capability missing" };
      // Attenuation is checked at derive time; re-assert it here so a corrupted
      // row can never widen rights or terms at call time.
      const parentRights = new Set(parent.rights);
      for (const r of cur.rights) {
        if (!parentRights.has(r)) return { ok: false, reason: "capability widened its parent's rights" };
      }
      const parentAuto = new Set(parent.terms.autoAllow);
      for (const op of cur.terms.autoAllow) {
        if (!parentAuto.has(op)) return { ok: false, reason: "capability widened its parent's terms" };
      }
      cur = parent;
    }
    return { ok: false, reason: "broken capability chain" };
  }
}
