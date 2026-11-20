/**
 * The primitives every browser-facing surface needs to agree on.
 *
 * There were two copies of every function in this file — one in the panel, one in
 * the v3 Host — and they had already drifted on four separate rules. That is not
 * a tidiness problem: a GET `/logout` survived a commit whose message said it had
 * been fixed "across both web surfaces", because it had been fixed in one of
 * them. Whoever fixes the next one should not have to know how many copies exist.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compare two secrets without leaking their contents — or their lengths —
 * through timing. Both sides are hashed first, so the comparison is always over
 * 32 bytes and an early length mismatch cannot short-circuit.
 */
export function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function hashSecret(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

/** One cookie value out of a `Cookie` header. "" when absent. */
export function readCookie(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

/**
 * The origins a browser may send a state-changing request from, computed once
 * at startup.
 *
 * ── Why this is a list and not a comparison ─────────────────────────────────
 *
 * The first version derived the canonical origin from the request — `Host`,
 * `X-Forwarded-Proto` — which lets an attacker who can set those headers set
 * BOTH sides of the comparison, producing a check that cannot fail. The fix was
 * to prefer configuration. The simplification, later, was noticing that
 * "compare Origin against a list decided at startup" is precisely what every
 * CORS middleware in the ecosystem takes as its `origin` option, and that our
 * remaining request-derived fallback existed only because we had never decided
 * where the list comes from. So:
 *
 *   · `public_url` configured → that one origin, and only it;
 *   · otherwise               → the loopback origins of the port we bound to,
 *                               which is the only place an unconfigured surface
 *                               is allowed to bind anyway;
 *   · neither                 → the empty list.
 *
 * An empty list is a real answer, and the right one: a server that cannot say
 * who it is has no business accepting a state-changing request from a page it
 * cannot identify.
 *
 * ── Only http(s), because "null" is not an origin you can allow ─────────────
 *
 * `new URL("data:text/html,x").origin` is the STRING `"null"`, and so is
 * `javascript:` and `file:`. Returning that produced a list containing `"null"`,
 * which is exactly the value a browser sends as `Origin` for a sandboxed or
 * opaque document — so a typo in `public_url` could configure a mutation gate to
 * accept requests from any opaque origin, and it configured Session Plus with a
 * `frame-ancestors null` that only blew up on the first request. A scheme that
 * cannot express an origin is a configuration error, and the honest answer is
 * the empty list.
 *
 * A `public_url` with credentials, a path or a query is accepted, because only
 * its ORIGIN is ever used and that origin is well defined; the extra parts are
 * simply not part of the answer.
 */
export function allowedOrigins(o: { publicUrl?: string; loopbackPort?: number }): string[] {
  if (o.publicUrl) {
    try {
      const url = new URL(o.publicUrl);
      // Opaque-origin schemes serialize to the literal "null"; anything that is
      // not a fetch scheme cannot name a browser origin at all.
      if (url.protocol !== "http:" && url.protocol !== "https:") return [];
      // URL accepts `*` (including percent-encoded `*`) as a literal hostname
      // character. It is not an exact deployable origin and must never reach an
      // Origin/CSP allowlist looking like one.
      if (url.hostname.includes("*")) return [];
      return url.origin === "null" || !url.origin ? [] : [url.origin];
    } catch {
      return []; // unusable config is not a reason to accept anything
    }
  }
  if (o.loopbackPort && o.loopbackPort > 0) {
    return [
      `http://127.0.0.1:${o.loopbackPort}`,
      `http://localhost:${o.loopbackPort}`,
      `http://[::1]:${o.loopbackPort}`,
    ];
  }
  return [];
}

/**
 * Membership in that list, and nothing else.
 *
 * A missing Origin is refused: browsers always send it on POST, so its absence
 * means the caller is not the browser this check exists to protect.
 */
export function originOk(origin: string | undefined, allowed: readonly string[]): boolean {
  return Boolean(origin) && allowed.includes(origin as string);
}

/**
 * Whether a session cookie should carry `Secure`, decided from the canonical URL
 * the operator configured — never from `x-forwarded-proto`, which is a request
 * header. Trusting it means a plaintext request can claim https and receive a
 * Secure cookie the browser will then never send back, and, worse, that the flag
 * silently disappears whenever a real proxy forgets to set it, leaving the
 * session id to ride cleartext.
 */
export function cookieSecure(publicUrl: string | undefined): boolean {
  if (!publicUrl) return false;
  try {
    return new URL(publicUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export function isLoopbackHostname(h: string): boolean {
  return h === "localhost" || h === "::1" || h === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Node reports IPv4 loopback over a dual-stack socket as ::ffff:127.x.x.x. */
export function isLoopbackAddress(addr: string): boolean {
  const a = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return a === "::1" || a === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(a);
}
