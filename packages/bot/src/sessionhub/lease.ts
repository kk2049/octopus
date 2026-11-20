/**
 * Admission lease over one CLI session mutation.
 *
 * ── The failure it prevents ────────────────────────────────────────────────
 *
 * Before a call reaches the Runner, two mutations on the SAME session would be
 * two competing approval/admission attempts. The first call therefore holds a
 * lease while the Gate decides whether it needs approval and until dispatch is
 * observed.
 *
 * After an ordinary append/resume crosses the Gate, the lease is handed off:
 * the device's provider-native attachment is the ordering authority and may
 * steer or queue later messages exactly as Claude, Codex or OMP supports. The
 * lease must not turn that provider conversation into a one-prompt surface.
 * Disruptive takeover/fallback intents keep the lease until their result.
 *
 * ── Why the lease outlives the HTTP request ────────────────────────────────
 *
 * An append that needs approval returns 202 and executes later, when the owner
 * presses the button on /pending. Releasing at the end of the request would
 * leave the window between "card created" and "card approved" unprotected —
 * and that window is minutes long, exactly where a second attempt happens. So
 * a lease bound to a PendingCall survives until that call is decided, and the
 * second attempt is told there is already an approval waiting rather than being
 * handed a second card for the same session.
 *
 * Every lease also has a deadline, because a holder that never comes back
 * (crashed request, abandoned tab, a card nobody ever presses) must not wedge
 * a session forever.
 */

export interface LeaseKeyParts {
  owner: string;
  device: string;
  cliKind: string;
  sessionId: string;
}

export interface LeaseHandle {
  key: string;
  holder: string;
  expiresAt: number;
  /**
   * The credential this lease was taken on — one browser login, or one device
   * token. Not part of the KEY (a session is single-writer regardless of which
   * of your logins is driving it), but recorded so that ending one login
   * releases the leases that login was holding without touching the others.
   * A lease is permission-shaped: it says "this surface is driving that
   * session", and that claim must not outlive the credential that made it.
   */
  credential?: string;
  /**
   * What was asked for. Two attempts with the SAME fingerprint are one
   * intent — a double-clicked button, a retried fetch — and must not be told
   * the session is busy: the kernel dedupes them into one approval card, and
   * pretending otherwise would make the idempotent path look like a conflict.
   * A different fingerprint on a held session is the case this lease exists
   * for.
   */
  fingerprint: string;
  /** Set once the call became an approval card, so the decision can free it. */
  pendingCallId?: string;
}

export type LeaseResult =
  | { ok: true; lease: LeaseHandle }
  | {
      ok: false;
      /** Present when the blocker is an approval nobody has decided yet. */
      pendingCallId?: string;
      holder: string;
      /** Wording the API returns verbatim; it is on a screen people read. */
      message: string;
    };

/** How long a lease survives with nobody touching it. */
const DEFAULT_TTL_MS = 6 * 60_000;
/** A lease waiting on a human decision gets longer — cards are not instant. */
const PENDING_TTL_MS = 30 * 60_000;

export function leaseKey(parts: LeaseKeyParts): string {
  // JSON rather than a separator string: a device name containing the
  // separator must not be able to collide with another user's key.
  return JSON.stringify([parts.owner, parts.device, parts.cliKind, parts.sessionId]);
}

export interface SessionLeasesOptions {
  now?: () => number;
  ttlMs?: number;
  pendingTtlMs?: number;
  /**
   * Is the approval this lease is waiting on still undecided?
   *
   * Supplied by the service and answered by the KERNEL, so the lease is derived
   * from the approval queue rather than being a second copy of it. Without this
   * the lease is a cache that goes stale the moment a card is decided anywhere
   * other than through the route that happens to release it — on /pending, from
   * a Feishu button, by expiry — and a stale lease wedges a session for its
   * whole 30-minute window.
   *
   * Absent = "assume still pending", which is the fail-closed reading and what
   * a unit test wants.
   */
  pendingIsLive?: (pendingCallId: string, owner: string) => boolean;
}

export class SessionLeases {
  private held = new Map<string, LeaseHandle>();
  private now: () => number;
  private ttlMs: number;
  private pendingTtlMs: number;
  private pendingIsLive?: (pendingCallId: string, owner: string) => boolean;

  constructor(opts: SessionLeasesOptions | (() => number) = {}) {
    const o: SessionLeasesOptions = typeof opts === "function" ? { now: opts } : opts;
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
    this.pendingTtlMs = o.pendingTtlMs ?? PENDING_TTL_MS;
    this.pendingIsLive = o.pendingIsLive;
  }

  /**
   * Take the lease, or explain what is in the way. `holder` is a description
   * for the message, never a credential. `fingerprint` identifies the INTENT;
   * see `LeaseHandle.fingerprint`.
   */
  acquire(parts: LeaseKeyParts, holder: string, fingerprint = "", credential?: string): LeaseResult {
    const key = leaseKey(parts);
    const existing = this.held.get(key);
    if (existing && existing.expiresAt > this.now()) {
      // Same intent = the same card. Hand the caller the lease it already
      // holds; the kernel's (context, slot, operation, argsHash) dedupe does
      // the rest and returns the pending id that already exists.
      if (existing.fingerprint === fingerprint) return { ok: true, lease: existing };
      // A lease waiting on a card that has since been decided (approved,
      // rejected, expired — anywhere, by any route) is not holding anything.
      const stale =
        existing.pendingCallId !== undefined
        && this.pendingIsLive !== undefined
        && !this.pendingIsLive(existing.pendingCallId, parts.owner);
      if (!stale) {
        return {
          ok: false,
          pendingCallId: existing.pendingCallId,
          holder: existing.holder,
          message: existing.pendingCallId
            ? "这个会话已经有一条续跑指令在等你批准 — 先到「待批准」处理它,再发下一条。"
            : "这个会话正在被另一条续跑指令占用 — 等它跑完再发下一条(同一个会话不并行驱动)。",
        };
      }
      this.held.delete(key);
    }
    const lease: LeaseHandle = { key, holder, fingerprint, credential, expiresAt: this.now() + this.ttlMs };
    this.held.set(key, lease);
    return { ok: true, lease };
  }

  /**
   * The call became an approval card: extend the lease and remember which card,
   * so deciding it frees the session.
   */
  bindPending(lease: LeaseHandle, pendingCallId: string): void {
    const held = this.held.get(lease.key);
    if (!held || held !== lease) return;
    held.pendingCallId = pendingCallId;
    held.expiresAt = this.now() + this.pendingTtlMs;
  }

  release(lease: LeaseHandle): void {
    if (this.held.get(lease.key) === lease) this.held.delete(lease.key);
  }

  /**
   * The approved call now belongs to the Runner/provider control plane.
   *
   * This is intentionally a named transition rather than a bare `release` at
   * call sites: it records why a later prompt may enter while the earlier turn
   * is still running. Approval-bound calls never reach this transition.
   */
  handoff(lease: LeaseHandle): void {
    this.release(lease);
  }

  /** Called when an approval is approved, rejected or expires. */
  releaseByPending(pendingCallId: string): boolean {
    for (const [key, lease] of this.held) {
      if (lease.pendingCallId !== pendingCallId) continue;
      this.held.delete(key);
      return true;
    }
    return false;
  }

  /**
   * Drop every lease of one owner — the teardown half of a revocation. A lease
   * is permission-shaped: it says "this surface is driving that session", and
   * that claim must not survive the grant it was taken under.
   */
  releaseOwner(owner: string): number {
    let n = 0;
    for (const [key, lease] of this.held) {
      if ((JSON.parse(key) as [string])[0] !== owner) continue;
      this.held.delete(key);
      n++;
      void lease;
    }
    return n;
  }

  /**
   * Drop the leases one credential was holding — the teardown half of ending
   * ONE login. Narrower than `releaseOwner` on purpose: the account's other
   * logins may still be legitimately driving a session, and freeing their lease
   * would let a third writer in behind them.
   */
  releaseCredential(owner: string, credential: string): number {
    let n = 0;
    for (const [key, lease] of this.held) {
      if ((JSON.parse(key) as [string])[0] !== owner) continue;
      if (lease.credential !== credential) continue;
      this.held.delete(key);
      n++;
    }
    return n;
  }

  /** Diagnostics and tests: how many live leases are held. */
  get size(): number {
    const now = this.now();
    for (const [key, lease] of this.held) if (lease.expiresAt <= now) this.held.delete(key);
    return this.held.size;
  }
}
