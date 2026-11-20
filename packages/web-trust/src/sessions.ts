/**
 * Server-side opaque browser sessions, with the storage left open.
 *
 * Why sessions exist at all: a long-lived personal bearer is a fine credential
 * for "let me read my own transcripts" and a bad one for "this human just
 * approved an `exec` on their laptop". It never expires, it cannot be revoked per
 * device, and every script holding it looks exactly like a browser. So the bearer
 * is only a door key — login exchanges it for a fresh, high-entropy session id
 * whose HASH is what the server keeps, plus a separate CSRF secret.
 *
 * The two surfaces differ only in where the rows live: the panel wants them in
 * SQLite (a restart should not log everybody out of a long-running service), the
 * v3 probe wants them in memory (a restart there SHOULD end everything, which is
 * the fail-closed direction for a host that runs generated code). That is the
 * whole reason `SessionStore` is an interface and not a table.
 */

import { randomBytes } from "node:crypto";
import { hashSecret, secretEquals } from "./origin.js";

export interface SessionRow {
  /** sha256 of the session id. The id itself is never stored. */
  tokenHash: string;
  username: string;
  /** sha256 of the CSRF secret. */
  csrfHash: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiry: number;
  revokedAt: number | null;
  /** Free-form, surface-specific facts the resolver hands back verbatim. */
  extra?: Readonly<Record<string, unknown>>;
}

export interface SessionStore {
  put(row: SessionRow): void;
  get(tokenHash: string): SessionRow | null;
  touch(tokenHash: string, at: number): void;
  revoke(tokenHash: string, at: number): void;
  /** Drop rows that expired before `cutoff`. Best effort. */
  prune(cutoff: number): void;
  /** Every live row. Only needed by surfaces that reap what a session owned. */
  live?(): SessionRow[];
}

export class MemorySessionStore implements SessionStore {
  private rows = new Map<string, SessionRow>();
  put(row: SessionRow): void {
    this.rows.set(row.tokenHash, { ...row });
  }
  get(tokenHash: string): SessionRow | null {
    const r = this.rows.get(tokenHash);
    return r ? { ...r } : null;
  }
  touch(tokenHash: string, at: number): void {
    const r = this.rows.get(tokenHash);
    if (r) r.lastSeenAt = at;
  }
  revoke(tokenHash: string, at: number): void {
    const r = this.rows.get(tokenHash);
    if (r) r.revokedAt = at;
  }
  prune(cutoff: number): void {
    for (const [k, r] of this.rows) {
      if (r.absoluteExpiry <= cutoff || r.revokedAt !== null) this.rows.delete(k);
    }
  }
  live(): SessionRow[] {
    return [...this.rows.values()].filter((r) => r.revokedAt === null).map((r) => ({ ...r }));
  }
  /** The surface may need to forget a row outright (reaping, not revoking). */
  drop(tokenHash: string): void {
    this.rows.delete(tokenHash);
  }
}

export interface ResolvedSession {
  username: string;
  tokenHash: string;
  csrfHash: string;
  extra?: Readonly<Record<string, unknown>>;
}

export interface IssuedSession {
  sessionId: string;
  csrf: string;
  expiresAt: number;
}

export interface SessionPolicy {
  /** No activity for this long and the session is dead. */
  idleMs: number;
  /** Hard ceiling regardless of activity. */
  absoluteMs: number;
}

export class WebSessions {
  constructor(
    private store: SessionStore,
    private policy: SessionPolicy,
    private now: () => number = Date.now,
  ) {}

  issue(username: string, extra?: Record<string, unknown>): IssuedSession {
    const sessionId = randomBytes(32).toString("hex");
    const csrf = randomBytes(32).toString("hex");
    const t = this.now();
    const expiresAt = t + this.policy.absoluteMs;
    this.store.put({
      tokenHash: hashSecret(sessionId),
      username,
      csrfHash: hashSecret(csrf),
      createdAt: t,
      lastSeenAt: t,
      absoluteExpiry: expiresAt,
      revokedAt: null,
      extra,
    });
    this.store.prune(t);
    return { sessionId, csrf, expiresAt };
  }

  /**
   * Resolve a cookie value. Idle timeout, absolute expiry and revocation all fail
   * closed — including when a timestamp is unreadable.
   *
   * Read-only about lifetime beyond touching `lastSeen`: an expired session is
   * REPORTED as gone, never deleted here. Deleting it in the resolver is how a
   * surface loses its chance to tear down what the session owned (the v3 Host
   * derives Contexts per session, and only it can destroy them).
   */
  resolve(sessionId: string): ResolvedSession | null {
    if (!sessionId) return null;
    const tokenHash = hashSecret(sessionId);
    const row = this.store.get(tokenHash);
    if (!row) return null;
    if (this.isExpired(row)) return null;
    this.store.touch(tokenHash, this.now());
    return { username: row.username, tokenHash, csrfHash: row.csrfHash, extra: row.extra };
  }

  isExpired(row: SessionRow): boolean {
    const now = this.now();
    if (row.revokedAt !== null) return true;
    if (!Number.isFinite(row.absoluteExpiry) || !Number.isFinite(row.lastSeenAt) || !Number.isFinite(row.createdAt)) {
      // A timestamp we cannot read is a session we cannot age. `NaN > x` is
      // false for every comparison, so a corrupt row would otherwise read as
      // "not expired" forever.
      return true;
    }
    if (row.absoluteExpiry <= now) return true;
    if (now - row.lastSeenAt > this.policy.idleMs) return true;
    // A session claiming to have been created in the future, or after its own
    // expiry, is not a session we wrote.
    return row.createdAt > now + 60_000 || row.createdAt >= row.absoluteExpiry;
  }

  revoke(sessionId: string): void {
    if (sessionId) this.store.revoke(hashSecret(sessionId), this.now());
  }

  /** Every session that has timed out, so the surface can reap what they owned. */
  expired(): SessionRow[] {
    return (this.store.live?.() ?? []).filter((r) => this.isExpired(r));
  }

  /** Double-submit check against the stored hash; constant time. */
  csrfOk(session: Pick<ResolvedSession, "csrfHash">, presented: string | undefined): boolean {
    if (!presented) return false;
    return secretEquals(hashSecret(presented), session.csrfHash);
  }
}
