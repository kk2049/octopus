/**
 * @claude-bot/web-trust — the browser-trust rules, once.
 *
 * Two surfaces face a browser in this repo: the panel (`packages/bot/src/dashboard`)
 * and the v3 Host (`packages/engine/src/host`). They had independent
 * implementations of the same six concepts, and the copies had drifted:
 *
 *   | rule                  | panel             | v3 Host          |
 *   |-----------------------|-------------------|------------------|
 *   | session absolute life | 14 days           | 7 days           |
 *   | bearer may write      | yes (ops scripts) | no               |
 *   | logout method         | GET  ← CSRF hole  | POST             |
 *   | oversized body        | 413 then CONTINUE | 413 then bail    |
 *   | token comparison      | timingSafeEqual   | ===              |
 *
 * Every row is a place a fix could land on one side only, and three of them did.
 * The point of this package is not deduplication for its own sake: it is that the
 * next person to fix a browser-trust bug should not have to know how many copies
 * exist.
 *
 * Two more joined the list in 2026-08, for the same reason and from the same
 * change (Session Plus):
 *
 *   · the login COOKIE NAMES (`cookies.ts`) — once a deployment serves
 *     untrusted app code from a sibling host under the same registrable site,
 *     the name and its attributes stop being independent, because only a
 *     `__Host-` cookie refuses a same-named `Domain` cookie set by a sibling.
 *     Two surfaces assembling `Set-Cookie` by hand cannot both be relied on to
 *     keep that pairing;
 *   · the AGENT VIEW FRAME contract (`frame.ts`) — the sandbox token set and
 *     the deny-everything CSP an untrusted view document answers with. The v3
 *     Host frames a same-origin view (`frame-ancestors 'self'`) and Session
 *     Plus frames a separate origin (an exact list); one decision, two
 *     deployments, and the wildcard both must refuse is refused in one place.
 *
 * What deliberately stays surface-specific: WHERE sessions are stored (SQLite for
 * a long-running service, memory for a host that should fail closed on restart),
 * what a session OWNS (the v3 Host derives capability Contexts per session and
 * must reap them), and the wording of error payloads.
 */

export {
  allowedOrigins,
  cookieSecure,
  hashSecret,
  isLoopbackAddress,
  isLoopbackHostname,
  originOk,
  readCookie,
  secretEquals,
} from "./origin.js";
export {
  HOST_PREFIX,
  clearCookie,
  clearSessionCookies,
  cookieContract,
  csrfCookieCandidates,
  issueSessionCookies,
  serializeCookie,
} from "./cookies.js";
export type { CookieAttributes, CookieContract, CookieNames } from "./cookies.js";
export {
  SANDBOX_ALLOW_SCRIPTS,
  SANDBOX_ALLOW_SCRIPTS_AND_DOWNLOADS,
  viewFrameCsp,
  viewFrameHeaders,
} from "./frame.js";
export type { ViewFrameOptions } from "./frame.js";
export { MemorySessionStore, WebSessions } from "./sessions.js";
export type {
  IssuedSession,
  ResolvedSession,
  SessionPolicy,
  SessionRow,
  SessionStore,
} from "./sessions.js";
export { SAFE_METHODS, mutationGate, parseJsonBodyText } from "./gate.js";
export type { BodyResult, CredentialChannel, GateInput, GateVerdict } from "./gate.js";
