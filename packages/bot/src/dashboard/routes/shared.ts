/**
 * Small pure helpers shared by `server.ts` and the per-domain route modules.
 *
 * Everything here is a projection or a handle derivation — no authority, no
 * state. They live outside `server.ts` so a route module never has to import
 * a value from the file that composes it (types travel as `import type`).
 */

import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import type { PanelReply } from "../http.js";
import type { PanelSubject } from "../authz.js";
import type { Capabilities, DashboardIdentity } from "../server.js";

/**
 * What a page is told about who it is showing.
 *
 * Explicitly projected rather than serialising the identity, because the
 * identity holds `session` — which carries the session token's hash and the
 * CSRF secret's hash — and `via`, which is about the transport and no business
 * of the page. `viewer: identity` shipped both to the browser.
 */
/**
 * The identity as the authorization policy sees it.
 *
 * Narrower than `DashboardIdentity` on purpose: the policy needs the boolean
 * "did this arrive on a browser session", not the session object (which carries
 * the session token's hash and the CSRF secret's hash). A decision that cannot
 * see a secret cannot leak one.
 */
export function subjectOf(identity: DashboardIdentity): PanelSubject {
  return {
    username: identity.username,
    admin: identity.admin,
    dev: identity.dev,
    deploy: identity.deploy,
    contribute: Boolean(identity.contribute),
    session: Boolean(identity.session),
  };
}

export function viewerOf(identity: DashboardIdentity): Capabilities {
  return {
    username: identity.username,
    admin: identity.admin,
    dev: identity.dev,
    deploy: identity.deploy,
    contribute: Boolean(identity.contribute),
  };
}

/**
 * Take a reply's socket away from the framework, for a stream.
 *
 * `hijack()` is Fastify's way of saying "this reply is mine now": no serializer,
 * no `onSend` hooks, no compression, no automatic close. Everything after it
 * talks to the raw `ServerResponse`, which is what an open-ended event stream
 * needs and what `LiveRegistry` has always been written against.
 *
 * The rule that comes with it: every refusal a streaming route can produce must
 * happen BEFORE this call, because after it there is no reply object left to
 * refuse with.
 */
export function hijack(reply: PanelReply): ServerResponse {
  const res = reply.raw;
  // A raw response may report a failed `write()` asynchronously. Once Fastify
  // is hijacked there is no framework error lifecycle left to catch that
  // EventEmitter `error`, so install the fail-closed floor before ownership is
  // transferred. Route-specific listeners still own timers/subscriptions.
  res.on("error", () => {
    if (!res.destroyed) res.destroy();
  });
  reply.hijack();
  return res;
}

/** Run a raw stream's route-owned teardown once on every terminal signal. */
export function onRawResponseEnd(res: ServerResponse, cleanup: () => void): () => void {
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cleanup();
  };
  res.on("error", stop);
  res.on("finish", stop);
  res.on("close", stop);
  return stop;
}

/**
 * A stable, one-way handle for one browser session.
 *
 * `sha256("websess:" + token_hash)` rather than a prefix of the hash: a prefix
 * of a secret is still part of a secret, and this value goes to the browser so
 * a person can end one specific login. It identifies a row; it authenticates
 * nothing, and the lookup that consumes it is already scoped to one account.
 */
export function webSessionHandle(tokenHash: string): string {
  return createHash("sha256").update(`websess:${tokenHash}`).digest("hex").slice(0, 16);
}

/**
 * The credential handle for one browser login.
 *
 * Deliberately built from the SAME `webSessionHandle` the browser is shown, so
 * "end this login" can compute the thing to tear down straight from the handle
 * it was given — without a second table, and without the row's token hash
 * having to travel anywhere. The `ws:` prefix keeps the two credential
 * namespaces from ever colliding.
 */
export function webCredential(tokenHash: string): string {
  return `ws:${webSessionHandle(tokenHash)}`;
}

export function clampInt(raw: string | null, min: number, max: number, dflt: number): number {
  // Number(null) and Number("") are 0, not NaN — absent means default.
  if (raw == null || raw.trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * The one refusal for text past the shared session prompt budget
 * (`MACHINE_LIMITS.appendMaxPromptBytes`, UTF-8 bytes) — the bound every
 * Runner start/append enforces anyway. Null when the text fits. Exact numbers,
 * never a silent cut.
 */
export function promptBudgetRefusal(what: string, text: string): string | null {
  const bytes = Buffer.byteLength(text, "utf8");
  const budget = MACHINE_LIMITS.appendMaxPromptBytes;
  return bytes > budget
    ? `${what}为 ${bytes} 字节（UTF-8），超过会话 prompt 预算 ${budget} 字节（${budget / 1024} KiB）；请拆成多条或改为附件`
    : null;
}
