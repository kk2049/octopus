/**
 * The panel's half of the browser-trust layer: a SQLite-backed session store,
 * plus the cookie names.
 *
 * Everything that is a RULE rather than a storage decision now lives in
 * `@claude-bot/web-trust` and is shared with the v3 Host — `originOk`,
 * `cookieSecure`, the CSRF double-submit, the idle/absolute lifetime logic, the
 * mutation gate, bounded body reading. This file is what is genuinely
 * panel-specific: rows go in the bot database, because a restart of a
 * long-running service should not log everybody out. (The v3 Host makes the
 * opposite choice on purpose, and gets `MemorySessionStore`.)
 *
 * Why sessions exist at all (approval: doc/tcb-reading-guide.md §3): the
 * panel used to put the long-lived personal bearer straight into the cookie. That
 * is a fine credential for "let me read my own transcripts" and a bad one for
 * "this human just approved an `exec` on their laptop" — it never expires, it
 * cannot be revoked per device, and every script that holds it looks exactly like
 * a browser. So the bearer is only a door key now, and approval endpoints accept
 * only a real session.
 */

import {
  WebSessions,
  cookieContract,
  cookieSecure,
  hashSecret,
  type CookieContract,
  type CookieNames,
  type SessionRow,
  type SessionStore,
} from "@claude-bot/web-trust";
import type { Store } from "../store/store.js";

/**
 * The panel's cookie pair, before the deployment decides how to spell it.
 *
 * The spelling is not a preference: on https the names carry the `__Host-`
 * prefix, which is what makes a sibling host under the same registrable site
 * (`app-<digest>.apps.example.org`, once Session Plus is on) unable to plant a
 * same-named `Domain` cookie on the panel. The prefix requires `Secure`, so it
 * is chosen by exactly the boolean that sets `Secure` — see
 * `@claude-bot/web-trust/cookies.ts` for why the pairing has to be decided in
 * one place.
 */
export const COOKIE_BASE: CookieNames = { session: "octopus_sess", csrf: "octopus_csrf" };

/**
 * A cookie from before server-side sessions existed: it held a raw bearer.
 * Nothing reads it; it is cleared wherever the panel writes cookies at all.
 */
export const RETIRED_COOKIES = ["octopus_dash"] as const;

/** The names this deployment issues and accepts. Nothing else is a credential. */
export function dashboardCookies(publicUrl: string | undefined): CookieContract {
  return cookieContract({ base: COOKIE_BASE, secure: cookieSecure(publicUrl), retired: RETIRED_COOKIES });
}

export const CSRF_HEADER = "x-csrf-token";

/** No activity for this long and the session is dead. */
export const IDLE_TIMEOUT_MS = 8 * 3600_000;
/** Hard ceiling regardless of activity. */
export const ABSOLUTE_TIMEOUT_MS = 14 * 24 * 3600_000;

export { hashSecret };

/** Rows in `web_sessions`; the store speaks ISO strings, the policy speaks ms. */
class SqliteSessionStore implements SessionStore {
  constructor(
    private store: Pick<
      Store,
      "createWebSession" | "getWebSession" | "touchWebSession" | "revokeWebSession" | "pruneWebSessions"
    >,
  ) {}

  put(row: SessionRow): void {
    this.store.createWebSession({
      token_hash: row.tokenHash,
      username: row.username,
      csrf_hash: row.csrfHash,
      created_at: new Date(row.createdAt).toISOString(),
      last_seen_at: new Date(row.lastSeenAt).toISOString(),
      absolute_expiry: new Date(row.absoluteExpiry).toISOString(),
      revoked_at: null,
    });
  }

  get(tokenHash: string): SessionRow | null {
    const r = this.store.getWebSession(tokenHash);
    if (!r) return null;
    // `Date.parse` of a corrupt value is NaN, which `WebSessions.isExpired`
    // treats as expired — a timestamp we cannot read is a session we cannot age.
    return {
      tokenHash,
      username: r.username,
      csrfHash: r.csrf_hash,
      createdAt: Date.parse(r.created_at),
      lastSeenAt: Date.parse(r.last_seen_at),
      absoluteExpiry: Date.parse(r.absolute_expiry),
      revokedAt: r.revoked_at ? Date.parse(r.revoked_at) : null,
    };
  }

  touch(tokenHash: string, at: number): void {
    this.store.touchWebSession(tokenHash, new Date(at).toISOString());
  }

  revoke(tokenHash: string, at: number): void {
    this.store.revokeWebSession(tokenHash, new Date(at).toISOString());
  }

  prune(cutoff: number): void {
    this.store.pruneWebSessions(new Date(cutoff).toISOString());
  }
}

export class WebSessionManager extends WebSessions {
  constructor(
    store: Pick<
      Store,
      "createWebSession" | "getWebSession" | "touchWebSession" | "revokeWebSession" | "pruneWebSessions"
    >,
    now: () => number = Date.now,
  ) {
    super(new SqliteSessionStore(store), { idleMs: IDLE_TIMEOUT_MS, absoluteMs: ABSOLUTE_TIMEOUT_MS }, now);
  }
}

export type { ResolvedSession } from "@claude-bot/web-trust";
