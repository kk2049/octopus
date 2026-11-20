/**
 * One account, one Object, one live root per revocation scope — and the Contexts a browser
 * surface derives from it.
 *
 * ── Why this is a shared class rather than a shape each resource copies ─────
 *
 * `RunnerCapabilities` grew this logic first, for the laptop Runner. When the
 * bot host's own scan home became a second resource (`sessionhub/local-scan.ts`)
 * the choice was to write it twice or to name it once. This repository has been
 * burned by the first option before — the browser-trust rules lived in two
 * independent copies and drifted in five places — and the parts that would have
 * been duplicated are exactly the parts where drift is a security bug:
 *
 *  - "exactly one live root per (account, Object, resource scope)", found in the DURABLE tables
 *    rather than remembered in a Map. A per-process Map is empty after a
 *    restart, so the second lifetime mints a SECOND root while the first stays
 *    live and reachable through everything derived from it before the reboot —
 *    and then revoking "the" root revokes only the newer half;
 *  - "the trusted preconditions are re-read on every single use, and failing
 *    them REVOKES rather than merely returns null" — because "you may no longer
 *    do this" and "the grants you already took out are dead" have to be one
 *    event;
 *  - "two live roots is an invariant violation, not a situation to pick a winner
 *    in" — collapse to no authority and let the next call mint one;
 *  - the pool, which is not an optimisation but the thing that makes the
 *    kernel's per-Context mechanisms (duplicate-approval detection, the pending
 *    cap, Context collection) work for a surface driven by individual HTTP
 *    requests.
 *
 * What is NOT here is anything resource-specific: which facts count as
 * preconditions, what the operations are, what the policy says, and what the
 * adapter talks to. Those arrive as options, so this class can never be the
 * place where one resource's rule leaks into another's.
 */

import { ResourceUnavailableError } from "../resources/recovery.js";
import type {
  CapabilityService,
  ContextId,
  ObjectDefinition,
  ObjectPolicy,
  Operation,
  OperationSpec,
  PolicyInput,
} from "@claude-bot/capability-kernel";

/**
 * How long a pooled Context is reused before a fresh one is derived. Long enough
 * that a human's second click lands in the same one; short enough that the thing
 * is still recognisably "this session's authority" rather than a standing grant.
 */
export const POOL_TTL_MS = 15 * 60_000;

/** One pooled Context, keyed by everything that makes it the same authority. */
interface PooledContext {
  contextId: ContextId;
  expiresAt: number;
}

export interface AccountAuthorityOptions<B> {
  /**
   * The shared service. There is exactly one per process: a Context minted by
   * one service is meaningless to another, and the SQLite store takes a
   * single-writer lease, so "two services" is not a configuration that exists.
   */
  service: CapabilityService;
  /** The slot every grant over this resource is installed under. */
  slot: string;
  /** `${objectPrefix}:${username}` is the Object id. Stable across boots. */
  objectPrefix: string;
  /** The Object's `kind`, part of its identity across restarts. */
  kind: string;
  operations: Record<Operation, OperationSpec>;
  policy: ObjectPolicy;
  /** Enforce a trusted resource scope on every call, including approval resume. */
  scopeAllows?: (scope: string, input: PolicyInput) => boolean;
  adapter: ObjectDefinition<B>["adapter"];
  /**
   * The trusted facts that decide whether this account holds anything at all,
   * re-read on EVERY use. Returning null does not merely refuse: it revokes
   * whatever root is still standing, so everything derived from it fails its
   * next ancestry check. That is the entire mechanism by which removing the
   * last laptop removes access to it.
   */
  bindingFor: (username: string) => B | null;
  /**
   * Maximum unsupervised operations on this account root.  `defaults` contains
   * only observe/read operations.  A deployment may explicitly add a narrowly
   * scoped operation here, but descendants still have to request it and may
   * only attenuate it.
   */
  rootAutoAllow?: (username: string, defaults: readonly Operation[]) => readonly Operation[];
  now?: () => number;
  poolTtlMs?: number;
  /** Diagnostics only; never load-bearing. */
  onWarning?: (message: string, fields: Record<string, unknown>) => void;
}

/** What `derive` produced, for the caller to wrap in its own grant type. */
export interface DerivedContext {
  contextId: ContextId;
  /** True when the Context came from the pool, so `close()` must be a no-op. */
  borrowed: boolean;
}

export class ApprovalRequiredError extends Error {
  constructor(
    readonly pendingCallId: string,
    readonly operation: string,
  ) {
    super(`「${operation}」需要资源主人在可信面板上批准（待批准 ${pendingCallId}）`);
    this.name = "ApprovalRequiredError";
  }
}

/**
 * A narrow, closable authority handed to one trusted lifecycle.
 *
 * Deliberately thin: everything with security content happens inside
 * `capabilities.request`, which is the kernel's own facade. What this adds is
 * (a) the slot, so a caller never names one, and (b) `close()` versus
 * `destroy()`, which is a lifecycle distinction the kernel cannot make for us.
 */
export class SlotGrant {
  constructor(
    protected svc: CapabilityService,
    readonly contextId: ContextId,
    readonly slot: string,
    /** What the grant exists for; shown in approval cards and audit. */
    readonly purpose: string,
    readonly owner: string,
    /**
     * True when this grant borrowed a POOLED Context. `close()` is then a
     * no-op: the pool owns the lifetime, and one borrower releasing it would
     * tear it out from under the others.
     */
    private borrowed = false,
  ) {}

  /** The whole API an untrusted runtime may hold. */
  get capabilities(): import("@claude-bot/capability-kernel").BoundCapabilities {
    return this.svc.bind(this.contextId);
  }

  /** Convenience for trusted in-process callers: throws instead of returning a union. */
  async call(operation: Operation, args: Record<string, unknown> = {}): Promise<unknown> {
    const out = await this.request(operation, args);
    if (out.status === "succeeded") return out.result;
    if (out.status === "approval_required") throw new ApprovalRequiredError(out.pendingCallId, operation);
    if (out.status === "failed" && out.dependency) throw new ResourceUnavailableError(out.dependency.resource, out.dependency.detail);
    throw new Error(out.reason);
  }

  async request(
    operation: Operation,
    args: Record<string, unknown> = {},
  ): Promise<import("@claude-bot/capability-kernel").InvokeResult> {
    return await this.capabilities.request(this.slot, operation, args);
  }

  /**
   * Release the Context. Deferred while this grant still has an undecided
   * PendingCall: approval re-runs the ORIGINAL call in the ORIGINAL Context, so
   * tearing it down at the end of the HTTP request that asked would make every
   * approval fail closed a moment later. The Context still dies on revocation,
   * on the pending call's own expiry, and on the decision.
   */
  close(): void {
    if (this.borrowed) return;
    this.svc.destroyContext(this.contextId, { deferWhilePending: true });
  }

  /**
   * Hard termination: the run/instance this Context belonged to has ended or
   * been revoked. Unlike `close()` this is immediate, so any PendingCall it
   * created can no longer be approved.
   */
  destroy(): void {
    this.svc.destroyContext(this.contextId);
  }
}

export class AccountAuthority<B> {
  private pool = new Map<string, PooledContext>();
  private nowMs: () => number;
  private poolTtlMs: number;

  constructor(private opts: AccountAuthorityOptions<B>) {
    this.nowMs = opts.now ?? Date.now;
    this.poolTtlMs = opts.poolTtlMs ?? POOL_TTL_MS;
  }

  get service(): CapabilityService {
    return this.opts.service;
  }

  objectIdFor(username: string): string {
    return `${this.opts.objectPrefix}:${String(username ?? "").trim()}`;
  }

  private rootAutoAllowFor(username: string): Operation[] {
    const known = new Set(Object.keys(this.opts.operations));
    const defaults = Object.entries(this.opts.operations)
      .filter(([, spec]) => spec.effect === "observe" || spec.effect === "read")
      .map(([operation]) => operation);
    const wanted = this.opts.rootAutoAllow?.(username, defaults) ?? defaults;
    return [...new Set(wanted)].filter((operation) => known.has(operation)).sort();
  }

  /**
   * The one authority root for this account/resource scope, found durably rather than
   * remembered in this process. See the file docstring for why each step is
   * ordered the way it is.
   */
  authorityFor(username: string, scope?: string): { context: ContextId; objectId: string } | null {
    const name = String(username ?? "").trim();
    if (!name) return null;
    if (scope !== undefined && (!scope || !this.opts.scopeAllows)) return null;
    const objectId = this.objectIdFor(name);
    const binding = this.opts.bindingFor(name);
    if (!binding) {
      this.revokeAccount(name);
      return null;
    }
    // Object identity is stable across boots (same kind, metadata and closed
    // operation table), so re-registering after a restart is what re-attaches
    // the adapter to capabilities that persisted pointing at this id.
    if (!this.opts.service.hasObject(objectId)) {
      const def: ObjectDefinition<B> = {
        id: objectId,
        kind: this.opts.kind,
        binding,
        metadata: { owner: name },
        operations: this.opts.operations,
        policy: (input) => {
          // Scope lives on the durable root, not the caller's leaf metadata.
          // Checking ancestry also prevents a chained grant from removing or
          // overwriting the parent's device restriction.
          for (const id of input.context.ancestry) {
            const heldScope = this.opts.service.contextMetadata(id)?.authority_scope;
            if (heldScope && !this.opts.scopeAllows?.(heldScope, input)) {
              return { kind: "deny", reason: "operation is outside the bound resource scope" };
            }
          }
          return this.opts.policy(input);
        },
        adapter: this.opts.adapter,
      };
      this.opts.service.registerObject(def);
    }
    const roots = this.opts.service.rootsOf(objectId).filter((r) =>
      r.slot === this.opts.slot
      && this.opts.service.contextMetadata(r.contextId)?.authority_scope === scope);
    const desiredAutoAllow = this.rootAutoAllowFor(name);
    if (roots.length === 1) {
      const actual = [...this.opts.service.termsOf(roots[0].contextId, roots[0].slot).autoAllow].sort();
      if (JSON.stringify(actual) === JSON.stringify(desiredAutoAllow)) {
        return { context: roots[0].contextId, objectId };
      }
      // Config terms are part of the root's authority.  A persisted root from
      // an older process must not silently keep either more or less than the
      // current policy: revoke its whole ancestry and mint the new root below.
      this.opts.onWarning?.("account root terms changed; rotating authority", {
        username: name,
        previousAutoAllow: actual,
        nextAutoAllow: desiredAutoAllow,
      });
      this.revokeRoots(name, (heldScope) => heldScope === scope);
    }
    if (roots.length > 1) {
      // Two live roots over one account/resource scope is an invariant violation, not a
      // situation to pick a winner in: revoking one would leave the other.
      this.opts.onWarning?.("multiple live account roots in scope; revoking scope", { username: name, scope, roots: roots.length });
      this.revokeRoots(name, (heldScope) => heldScope === scope);
    }
    const ctx = this.opts.service.createContext("account-authority", {
      owner: name,
      purpose: scope ? `resource authority · ${scope}` : "account authority",
      ...(scope ? { authority_scope: scope } : {}),
    });
    this.opts.service.mintRoot(
      ctx,
      this.opts.slot,
      objectId,
      Object.keys(this.opts.operations),
      { autoAllow: desiredAutoAllow },
    );
    return { context: ctx, objectId };
  }

  /** What this account's root actually holds right now. Empty when it holds nothing. */
  rightsOfAccount(username: string): Operation[] {
    const a = this.authorityFor(username);
    if (!a) return [];
    return [...this.opts.service.rightsOf(a.context, this.opts.slot)];
  }

  /**
   * Derive a narrow Context for one trusted lifecycle event. `rights` is the
   * intersection the control plane decided; nothing downstream can widen it.
   *
   * Returns null when the account holds nothing, when the parent Context is
   * dead, or when none of `rights` survives the intersection. All three are
   * fail-closed answers rather than errors to fall back from.
   */
  derive(o: {
    username: string;
    purpose: string;
    kind: string;
    rights: readonly Operation[];
    autoAllow?: readonly Operation[];
    metadata?: Record<string, string>;
    /** A separately revocable resource branch under the same account Object. */
    scope?: string;
    /** Chain off an existing Context instead of the account root. */
    parentContext?: ContextId;
    /**
     * Reuse one Context for this (user, surface) instead of deriving a new one
     * per call — for callers whose "lifecycle" is a browser surface rather than
     * a run. Give it the SURFACE, not the request.
     */
    pool?: string;
  }): DerivedContext | null {
    const username = String(o.username ?? "").trim();
    const svc = this.opts.service;
    const slot = this.opts.slot;
    let sourceCtx: ContextId;
    if (o.parentContext) {
      if (!svc.contextIsLive(o.parentContext)) return null;
      sourceCtx = o.parentContext;
    } else {
      const authority = this.authorityFor(username, o.scope);
      if (!authority) return null;
      sourceCtx = authority.context;
    }
    const available = new Set(svc.rightsOf(sourceCtx, slot));
    const rights = o.rights.filter((r) => available.has(r));
    if (rights.length === 0) return null;
    // A wider owner root is only a ceiling. Callers that do not state terms
    // retain the historical observe/read default; trusted owner-local surfaces
    // opt into execute/modify explicitly. This prevents an unrelated archive
    // or export caller from inheriting new silent authority by omission.
    const autoAllow = o.autoAllow ?? rights.filter((operation) => {
      const effect = this.opts.operations[operation]?.effect;
      return effect === "observe" || effect === "read";
    });

    // The pool key carries everything that makes two Contexts the same
    // authority. Rights and terms are in it because a borrower asking for less
    // must not be handed a Context that holds more.
    const poolKey = o.pool
      ? JSON.stringify([username, o.pool, [...rights].sort(), [...autoAllow].sort(), o.scope ?? null])
      : null;
    if (poolKey) {
      const hit = this.pool.get(poolKey);
      if (hit) {
        // Still usable? Live, in date, and its chain still valid — `rightsOf`
        // returns nothing once the account root is revoked, which is how
        // removing a laptop invalidates a pooled Context too.
        const usable =
          hit.expiresAt > this.nowMs()
          && svc.contextIsLive(hit.contextId)
          && svc.rightsOf(hit.contextId, slot).length > 0;
        if (usable) return { contextId: hit.contextId, borrowed: true };
        this.pool.delete(poolKey);
        // Release it politely: if a card it created is still undecided, approval
        // has to be able to re-run that call in this very Context.
        svc.destroyContext(hit.contextId, { deferWhilePending: true });
      }
      this.prunePool();
    }

    const ctx = svc.createContext(
      o.kind,
      // Caller metadata FIRST, trusted fields last: `owner` decides who may
      // approve a dangerous call and `purpose` is what the card says the call
      // is for. A caller that can overwrite either can choose its own approver.
      { ...(o.metadata ?? {}), owner: username, purpose: o.purpose },
      sourceCtx,
    );
    try {
      svc.derive(sourceCtx, slot, ctx, slot, rights, { autoAllow });
    } catch (err) {
      svc.destroyContext(ctx);
      this.opts.onWarning?.("capability derive refused", { err, username, purpose: o.purpose });
      return null;
    }
    if (poolKey) this.pool.set(poolKey, { contextId: ctx, expiresAt: this.nowMs() + this.poolTtlMs });
    return { contextId: ctx, borrowed: poolKey !== null };
  }

  /**
   * Drop this user's pooled Contexts NOW, hard.
   *
   * The teardown half of a revocation. Hard rather than `deferWhilePending`: a
   * pooled Context whose grant just went away must not survive because it
   * happens to hold an undecided approval — that card was created under the
   * authority being taken back, and letting the owner press it afterwards would
   * execute a call the grant no longer covers.
   *
   * Narrower than `revokeAccount`, deliberately: that kills the account ROOT,
   * which would also tear down every other plane derived from it. Revoking one
   * grant should close what that grant opened, not everything the account has.
   *
   * `surface` narrows further to one pool prefix — which is how ending ONE
   * browser login closes exactly that login's Contexts and leaves the account's
   * other logins alone.
   */
  dropPooled(username: string, surface?: string): number {
    const name = String(username ?? "").trim();
    if (!name) return 0;
    let dropped = 0;
    for (const [key, entry] of this.pool) {
      const parsed = JSON.parse(key) as [string, string];
      if (parsed[0] !== name) continue;
      if (surface && !String(parsed[1] ?? "").startsWith(surface)) continue;
      this.pool.delete(key);
      this.opts.service.destroyContext(entry.contextId);
      dropped++;
    }
    return dropped;
  }

  /** Retire pooled Contexts past their window, politely (see `derive`). */
  private prunePool(): void {
    const now = this.nowMs();
    for (const [key, entry] of this.pool) {
      if (entry.expiresAt > now) continue;
      this.pool.delete(key);
      this.opts.service.destroyContext(entry.contextId, { deferWhilePending: true });
    }
  }

  /** Test/diagnostics: how many pooled Contexts are held. */
  get pooledContexts(): number {
    return this.pool.size;
  }

  /**
   * Revoke a whole account's authority over this resource: every grant derived
   * from the old root dies with it (ancestry check, next call).
   *
   * It works from the durable root list, so it is still correct in a process
   * that never minted the root it is killing — the restart case, which is
   * exactly when a memory-only revocation quietly does nothing.
   */
  revokeAccount(username: string): void {
    this.revokeRoots(username, () => true);
  }

  /**
   * Changing one resource retires its branch and broad device-set grants.
   * Other explicit resource branches keep their authority and pending calls.
   * Durable roots make this work even after the process that minted them exits.
   */
  revokeScope(username: string, scope: string): void {
    this.revokeRoots(username, (heldScope) => heldScope === undefined || heldScope === scope);
  }

  private revokeRoots(username: string, matches: (scope: string | undefined) => boolean): void {
    const name = String(username ?? "").trim();
    if (!name) return;
    const objectId = this.objectIdFor(name);
    for (const root of this.opts.service.rootsOf(objectId)) {
      if (!matches(this.opts.service.contextMetadata(root.contextId)?.authority_scope)) continue;
      this.opts.service.revoke(root.contextId, root.slot);
      // Destroy the holder too: the Context is the root's only reachable
      // handle, and a live one with a revoked slot is a stub that can never
      // become useful again.
      this.opts.service.destroyContext(root.contextId);
    }
    for (const [key, entry] of this.pool) {
      if ((JSON.parse(key) as [string])[0] !== name) continue;
      if (this.opts.service.rightsOf(entry.contextId, this.opts.slot).length) continue;
      this.pool.delete(key);
      this.opts.service.destroyContext(entry.contextId);
    }
  }
}
