/**
 * The Host's trusted lifecycle state: browser sessions and AppInstance bindings.
 *
 * The RULES — `originOk`, `cookieSecure`, the CSRF double-submit, session
 * idle/absolute lifetimes, the mutation gate, bounded body reading — live in
 * `@claude-bot/web-trust` and are shared with the panel. They used to be a second
 * implementation here, and the two had drifted on four separate points; the
 * GET-logout hole survived a commit that claimed to fix it "across both web
 * surfaces" for exactly that reason.
 *
 * What is genuinely this surface's own and stays here:
 *
 *  - sessions are held in MEMORY, so a Host restart ends every one of them. The
 *    panel makes the opposite choice; both are deliberate. This process runs
 *    generated application code, and fail-closed is the direction to fail in.
 *  - a session OWNS things. Opening an app mints an opaque instance handle that
 *    resolves to (owner, app, scope, SecurityContext, code digest), and only the
 *    Host can destroy those Contexts — which is why expiry here is a transition
 *    it performs (`reapExpired`) rather than a silent delete inside a resolver.
 *
 * One AppInstance owns one Context. Sharing one Context between launches was the
 * older shape and it made every lifecycle question ambiguous: whose logout ends
 * it, which tab's close destroys it, what a stale handle picks up when it is
 * re-derived. A launch is the control-plane action that creates authority, so a
 * launch gets its own.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  MemorySessionStore,
  allowedOrigins,
  WebSessions,
  cookieContract,
  cookieSecure,
  hashSecret,
  originOk,
  readCookie,
  secretEquals,
  type CookieContract,
  type CookieNames,
  type ResolvedSession,
} from "@claude-bot/web-trust";

/**
 * The Host's cookie pair before the deployment decides how to spell it.
 *
 * The spelling is not this file's call: on https the names carry the `__Host-`
 * prefix, which is the only thing that stops a sibling host under the same
 * registrable site from planting a same-named `Domain` cookie here. The prefix
 * requires `Secure`, so `cookieContract` picks the name from the same boolean
 * that sets `Secure`, and the panel does the same with its own base pair — one
 * implementation, in `@claude-bot/web-trust`, so the two cannot drift apart the
 * way every other browser-trust rule in this package once did.
 */
export const COOKIE_BASE: CookieNames = { session: "v3s", csrf: "v3csrf" };
/** A cookie from before sessions existed; never read, cleared on sight. */
export const RETIRED_COOKIES = ["v3t"] as const;

export function hostCookies(publicUrl: string | undefined): CookieContract {
  return cookieContract({ base: COOKIE_BASE, secure: cookieSecure(publicUrl), retired: RETIRED_COOKIES });
}

export const CSRF_HEADER = "x-csrf-token";

const IDLE_MS = 8 * 3600_000;
const ABSOLUTE_MS = 7 * 24 * 3600_000;
/**
 * An instance handle outlives a page load, not a working day — and it must not
 * outlive the SESSION that opened it. At 12h (the previous value) instance expiry
 * was unreachable: the session's 8h idle timeout always fired first, so the
 * shorter-lived thing was the longer-lived one on paper only.
 */
const INSTANCE_TTL_MS = 4 * 3600_000;

export { allowedOrigins, cookieSecure, originOk, readCookie, secretEquals };
export type { ResolvedSession };

export interface HostSession {
  username: string;
  admin: boolean;
  csrfHash: string;
}

export interface AppInstanceBinding {
  owner: string;
  admin: boolean;
  app: string;
  scope: string;
  /**
   * Which browser session launched it. Logging out must end THIS session's
   * instances and no one else's — the same username in another browser is a
   * different session and keeps working.
   */
  sessionKey: string;
  /**
   * The SecurityContext this ONE instance runs as; opaque to the browser, and
   * never shared with another launch. Two tabs are two Contexts.
   */
  contextId: string | null;
  /** Code identity: a change here must destroy the Context, never inherit it. */
  digest: string;
  createdAt: number;
  expiresAt: number;
}

export class HostSecurity {
  private store = new MemorySessionStore();
  private sessions: WebSessions;
  private instances = new Map<string, AppInstanceBinding>();

  constructor(private now: () => number = Date.now) {
    this.sessions = new WebSessions(this.store, { idleMs: IDLE_MS, absoluteMs: ABSOLUTE_MS }, now);
  }

  // ── sessions ──

  issueSession(username: string, admin: boolean): { sessionId: string; csrf: string; maxAgeS: number } {
    const s = this.sessions.issue(username, { admin });
    return { sessionId: s.sessionId, csrf: s.csrf, maxAgeS: Math.floor(ABSOLUTE_MS / 1000) };
  }

  /**
   * Resolve a session cookie. Read-only about lifetime: an expired session is
   * REPORTED as gone, not quietly deleted here. Deleting it in the resolver was
   * how the Host lost its chance to tear down what the session owned — see
   * `reapExpired`.
   */
  resolveSession(sessionId: string): (HostSession & { key: string }) | null {
    const r = this.sessions.resolve(sessionId);
    if (!r) return null;
    return {
      username: r.username,
      admin: (r.extra as { admin?: boolean } | undefined)?.admin === true,
      csrfHash: r.csrfHash,
      key: r.tokenHash,
    };
  }

  revokeSession(sessionId: string): void {
    this.sessions.revoke(sessionId);
  }

  csrfOk(session: Pick<HostSession, "csrfHash">, presented: string | undefined): boolean {
    return this.sessions.csrfOk(session, presented);
  }

  // ── app instances ──

  /**
   * Mint a handle for an app the SESSION owner is opening. Callers pass the owner
   * they resolved from the session; there is no code path that takes an owner
   * from a request.
   */
  openInstance(b: Omit<AppInstanceBinding, "createdAt" | "expiresAt">): string {
    const handle = randomBytes(24).toString("hex");
    const t = this.now();
    this.instances.set(hashSecret(handle), { ...b, createdAt: t, expiresAt: t + INSTANCE_TTL_MS });
    return handle;
  }

  /**
   * Resolve an instance handle. Also read-only: an expired binding stays in the
   * table until `reapExpired` hands it to the Host, because the Host is the only
   * thing that can destroy its Context. The previous version deleted it here and
   * returned null, so the binding vanished before anyone could tear it down —
   * leaving a live Context and any undecided PendingCall of its own behind an
   * expired handle, reachable by an approval that arrived later.
   */
  resolveInstance(handle: string): AppInstanceBinding | null {
    if (!handle) return null;
    const inst = this.instances.get(hashSecret(handle));
    if (!inst) return null;
    if (this.now() > inst.expiresAt) return null;
    return inst;
  }

  /**
   * Drop every instance of an app whose code identity changed. The new version
   * gets a fresh handle and a fresh Context; nothing inherits a slot across a
   * version bump (kernel invariant 9).
   */
  invalidateApp(app: string, digest: string): AppInstanceBinding[] {
    const dropped: AppInstanceBinding[] = [];
    for (const [key, inst] of this.instances) {
      if (inst.app === app && inst.digest !== digest) {
        dropped.push(inst);
        this.instances.delete(key);
      }
    }
    return dropped;
  }

  /**
   * End the instances one SESSION opened.
   *
   * Not "every instance this username has": the same person in another browser, or
   * another tab that logged in separately, holds its own session and its own
   * Contexts, and logging out here must not reach into those.
   */
  closeInstancesForSession(sessionKey: string): AppInstanceBinding[] {
    const dropped: AppInstanceBinding[] = [];
    for (const [key, inst] of this.instances) {
      if (inst.sessionKey === sessionKey) {
        dropped.push(inst);
        this.instances.delete(key);
      }
    }
    return dropped;
  }

  /**
   * Explicit close of one instance, by the SESSION that opened it. Idempotent.
   *
   * The session key, not the username: a handle is not a bearer token, and "same
   * person, other browser, learned the handle somehow" is not the session whose
   * lifetime this instance belongs to.
   */
  closeInstance(handle: string, sessionKey: string): AppInstanceBinding | null {
    if (!handle || !sessionKey) return null;
    const key = hashSecret(handle);
    const inst = this.instances.get(key);
    if (!inst || inst.sessionKey !== sessionKey) return null;
    this.instances.delete(key);
    return inst;
  }

  /**
   * Everything that has timed out, removed and handed back so the Host can destroy
   * the exact Contexts involved.
   *
   * Both halves matter. An instance whose handle expired still owns a Context and
   * may own an undecided PendingCall; a session that went idle owns every instance
   * it opened. Neither can clean itself up — only the Host holds the capability
   * plane — so expiry is a transition it must be told about, not a silent delete
   * inside a resolver.
   */
  reapExpired(): AppInstanceBinding[] {
    const now = this.now();
    const dropped: AppInstanceBinding[] = [];
    const deadSessions = new Set<string>();
    for (const row of this.sessions.expired()) {
      deadSessions.add(row.tokenHash);
      this.store.drop(row.tokenHash);
    }
    for (const [key, inst] of this.instances) {
      if (now > inst.expiresAt || deadSessions.has(inst.sessionKey)) {
        dropped.push(inst);
        this.instances.delete(key);
      }
    }
    return dropped;
  }

  /** Test/diagnostic: how many instance bindings are live. */
  get instanceCount(): number {
    return this.instances.size;
  }
}

/** Content identity of an app's code — changing a byte changes the Context. */
export function digestOf(files: Array<{ path: string; content: string }>): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path).update("\0").update(f.content).update("\0");
  }
  return h.digest("hex").slice(0, 32);
}
