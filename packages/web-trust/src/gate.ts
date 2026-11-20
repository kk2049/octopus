/**
 * The mutation gate, and reading a bounded request body.
 *
 * ── Why the gate is a function and not a per-route call ─────────────────────
 *
 * The problem it replaces is not a missing check, it is a PER-ROUTE one. Both
 * surfaces at some point had a dozen routes each remembering to call the check
 * and one that did not, and the failure mode is silent: a route that forgets is
 * a route where any page on the internet can make an authenticated browser POST.
 * Adding a fourteenth per-route check leaves the fifteenth route to be
 * forgotten, so this runs once, before dispatch, for every unsafe method.
 *
 * ── The distinction that matters: AMBIENT vs presented ──────────────────────
 *
 * A credential is ambient when the browser attaches it by itself, including on a
 * request some hostile page triggered. Cookies are ambient; an `Authorization`
 * header is not, because a cross-site page cannot set one (and a preflight for
 * it does not pass). So there are exactly two channels:
 *
 *   cookie   the browser attached it (a session), or there is nothing to attach
 *            because no token is configured and we are bound to loopback. Either
 *            way a hostile page can aim a request here, so: exact Origin, plus
 *            the double-submit secret when there is a session holding one.
 *   bearer   explicit `Authorization` header. Not ambient, so scripts and ops
 *            tooling pass unchanged.
 *
 * ── What used to be here, and why it is gone ────────────────────────────────
 *
 * There were four channels. `legacy` — an old cookie holding a raw bearer,
 * kept READ-ONLY so browsers logged in before sessions existed would not be
 * thrown out — and `open`, which differed from `session` only in having no
 * secret to double-submit.
 *
 * Both were our own complexity, and both are the reason this file could not be
 * expressed as a CSRF plugin's configuration. `legacy` is what every framework
 * does by simply logging you out when the session format changes; `open` is a
 * deployment mode, not a kind of credential, and the gate already handles "no
 * secret to check" by taking `csrf` as optional. Removing them is what makes
 * the remaining rule the textbook one: cookie-authenticated requests need CSRF
 * and Origin, header-authenticated ones do not.
 */

import { originOk } from "./origin.js";

export type CredentialChannel = "bearer" | "cookie";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type GateVerdict =
  | { ok: true }
  | { ok: false; status: number; code: "origin" | "csrf"; message: string };

export interface GateInput {
  method: string;
  via: CredentialChannel;
  origin: string | undefined;
  /** Decided at startup by `allowedOrigins()`. Never derived from the request. */
  allowed: readonly string[];
  /** Present when a session holds a secret; the gate asks it to verify. */
  csrf?: { presented: string | undefined; ok: (presented: string | undefined) => boolean };
}

/**
 * Pure so the precedence is unit-testable and identical on both surfaces. The
 * caller turns a refusal into whatever its error shape is.
 */
export function mutationGate(input: GateInput): GateVerdict {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  if (input.via === "bearer") return { ok: true };
  // Origin first: it does not depend on the page having rendered correctly, and
  // it is the only check available when there is no session secret.
  if (!originOk(input.origin, input.allowed)) {
    return { ok: false, status: 403, code: "origin", message: "Origin 校验失败" };
  }
  if (input.csrf && !input.csrf.ok(input.csrf.presented)) {
    return { ok: false, status: 403, code: "csrf", message: "CSRF 校验失败,请刷新页面后重试" };
  }
  return { ok: true };
}

export type BodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Turn a request body's TEXT into an object, or say why it is not one.
 *
 * ── What used to be here, and why it left ───────────────────────────────────
 *
 * This was `readJsonBody(req, maxBytes)`: it drained an `IncomingMessage`,
 * enforced two independent size ceilings and then parsed. Both surfaces now run
 * on Fastify, whose `bodyLimit` refuses an oversized body BEFORE a handler
 * exists to be confused by it — which is strictly better than what the
 * hand-written reader could do, because it never had a call site to forget.
 *
 * What could not move to the framework is the SEMANTIC decision, and it is the
 * half that had actually gone wrong:
 *
 *   · an EMPTY body is `{}` — a POST with nothing to say is not an error, and
 *     ops scripts, the CLI shim and `fetch(url, {method:"POST"})` all send one;
 *   · MALFORMED JSON is a refusal that says so — substituting `{}` turns "your
 *     JSON is broken" into "you forgot a field";
 *   · a NON-OBJECT (`[1,2]`, `"hi"`, `null`) is a refusal too, so no handler
 *     ever reads named fields off an array and finds `undefined` everywhere.
 *
 * Both surfaces register it as their content-type parser, so the three answers
 * cannot drift apart again.
 */
export function parseJsonBodyText(text: string): BodyResult {
  if (!text || !text.trim()) return { ok: true, body: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "请求体不是合法 JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "请求体必须是 JSON 对象" };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}
