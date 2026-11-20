/**
 * `external-app-host/v1` — the two halves of the HTTP surface.
 *
 * ── Half one: the trusted grant face (behind the browser identity gate) ─────
 *
 * `/api/app-external/…?app=<id>` is an ordinary panel API: a logged-in person, in
 * their own session, minting a launch link for one of the operator's allow-
 * listed hosts, listing what they have handed out, and taking it back. This is
 * the ONLY place agent authority can be created, and creating it is a distinct
 * request with a distinct authority value — nothing an external host sends can
 * ask for one.
 *
 * ── Half two: the external transport (before the identity gate) ─────────────
 *
 * `/api/external/app/…` is answered before the identity gate for the same
 * reason the MCP endpoint is: its callers have no cookie, and the credential
 * they do present already names exactly one account, one App, one instance and
 * one authority. Everything cookie-shaped is therefore refused by construction:
 *
 *  · **No cookie authority.** The identity gate never runs, `credentials` is
 *    never allowed on the CORS reply, and nothing here reads `req.headers.cookie`.
 *    A browser that happens to hold an Octopus session gains nothing.
 *  · **Exact origin, never a wildcard.** The reply echoes one allow-listed
 *    origin and sets `vary: origin`; a request whose `Origin` is absent or
 *    unknown is refused before the credential is even looked at.
 *  · **The secret is in a header.** Never a query parameter, never a path
 *    segment, so it stays out of access logs, Referer headers and the DOM.
 *  · **The stream is `fetch`-shaped, not `EventSource`-shaped.** `EventSource`
 *    cannot set an Authorization header, and moving the credential into the URL
 *    to satisfy it is exactly the trade this refuses to make.
 *
 * Nothing in this file relaxes the untrusted App View's policy. The View still
 * runs on its digest-addressed origin with `connect-src 'none'` and reaches the
 * network through nothing; the external host is a SEPARATE, trusted-by-the-user
 * shell that talks to this server directly.
 */

import type { ServerResponse } from "node:http";
import type { InstanceEvent } from "../../app-core/instance.js";
import {
  EXTERNAL_APP_BASE_PATH,
  EXTERNAL_APP_HOST_PROTOCOL,
  EXTERNAL_APP_INSTANCE_HEADER,
  EXTERNAL_APP_PATHS,
  isExternalAppAuthority,
  type ExternalAppOperation,
} from "../../app-external/contract.js";
import type { ExternalAppHostService, ExternalAppSession } from "../../app-external/service.js";
import { createLogger } from "../../logger.js";
import { type PanelReply, type PanelRequest, bodyOf, panelUrl, replyJson as json } from "../http.js";
import { PANEL_BODY_SCHEMAS } from "../schemas.js";
import type { DashboardIdentity } from "../server.js";
import type { GuardedRoutes } from "./context.js";
import { hijack, onRawResponseEnd } from "./shared.js";

const log = createLogger("app-external");

export interface AppExternalRoutesContext {
  externalAppHost: ExternalAppHostService | null;
  liveStreams: Map<ServerResponse, { owner: string; credential: string }>;
  eventStreams: Set<ServerResponse>;
}

/** Same shared-instance grammar the App View routes use; server-minted keys. */
const SHARED_INSTANCE_KEY = /^asi_[0-9a-f]{32}$/;
const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ── Half one: the trusted grant face ──

export function registerAppExternalRoutes(routes: GuardedRoutes, ctx: AppExternalRoutesContext): void {
  // One rule (`api.appExternal`) for three verbs, exactly as `api.appShared`
  // covers its own family: the question Cedar answers is the same one — is this
  // person acting on their own account — and which verb it is, is data.
  routes.post(
    "/api/app-external/launch",
    "api.appExternal",
    PANEL_BODY_SCHEMAS.appExternalLaunch,
    (req, reply, identity) => apiExternalLaunch(ctx, req, reply, identity),
  );
  routes.post(
    "/api/app-external/revoke",
    "api.appExternal",
    PANEL_BODY_SCHEMAS.appExternalRevoke,
    (req, reply, identity) => apiExternalRevoke(ctx, req, reply, identity),
  );
  routes.get("/api/app-external/bindings", "api.appExternal", (req, reply, identity) =>
    apiExternalBindings(ctx, req, reply, identity),
  );
}

/**
 * The account this face acts for.
 *
 * A named browser session and nothing else: minting a credential that acts as
 * you is not something a script-shaped bearer token gets to do on your behalf,
 * and the whole surface exists to move authority OUT of this browser.
 */
function externalActor(
  ctx: AppExternalRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): { service: ExternalAppHostService; owner: string; appId: string } | null {
  if (!ctx.externalAppHost) {
    json(reply, 404, { error: "本部署没有启用外部 App 宿主接入" });
    return null;
  }
  // `?app=` names which App, exactly as it does for the App View routes: the
  // page's own address bar, a lookup key, never a credential and never joined
  // onto a path.
  const appId = panelUrl(req).searchParams.get("app") ?? "";
  if (!APP_ID.test(appId)) {
    json(reply, 404, { error: "本进程没有服务这个 App" });
    return null;
  }
  if (!identity.username || !identity.session) {
    json(reply, 403, { error: "外部绑定只能由本人在浏览器登录会话中签发或撤销" });
    return null;
  }
  return { service: ctx.externalAppHost, owner: identity.username, appId };
}

function apiExternalLaunch(
  ctx: AppExternalRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const actor = externalActor(ctx, req, reply, identity);
  if (!actor) return;
  const body = bodyOf(req);
  const instanceKey = String(body.instance_key ?? "");
  if (!SHARED_INSTANCE_KEY.test(instanceKey)) {
    json(reply, 400, { ok: false, code: "invalid_params", error: "实例标识格式无效" });
    return;
  }
  const authority = body.authority;
  if (!isExternalAppAuthority(authority)) {
    // Spelled out rather than defaulted: which authority is being handed out is
    // the decision this request IS, and a default would make the dangerous one
    // reachable by omission.
    json(reply, 400, { ok: false, code: "invalid_params", error: "authority 必须是 human 或 agent" });
    return;
  }
  const minted = actor.service.mintLaunch({
    owner: actor.owner,
    appId: actor.appId,
    instanceKey,
    hostId: String(body.host ?? ""),
    authority,
  });
  if (!minted.ok) {
    json(reply, minted.status, { ok: false, code: minted.code, error: minted.message });
    return;
  }
  json(reply, 200, { ok: true, ...minted.value });
}

function apiExternalBindings(
  ctx: AppExternalRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const actor = externalActor(ctx, req, reply, identity);
  if (!actor) return;
  const instance = panelUrl(req).searchParams.get("instance");
  const bindings = actor.service
    .bindings(actor.owner, actor.appId)
    .filter((row) => !instance || row.instance === instance);
  json(reply, 200, {
    ok: true,
    protocol: EXTERNAL_APP_HOST_PROTOCOL,
    hosts: actor.service.hosts(),
    bindings,
  });
}

function apiExternalRevoke(
  ctx: AppExternalRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const actor = externalActor(ctx, req, reply, identity);
  if (!actor) return;
  const revoked = actor.service.revoke(actor.owner, String(bodyOf(req).credential_id ?? ""), "user");
  if (!revoked.ok) {
    json(reply, revoked.status, { ok: false, code: revoked.code, error: revoked.message });
    return;
  }
  json(reply, 200, { ok: true, ...revoked.value });
}

// ── Half two: the external transport ──

/** Methods a host may use, per operation. Anything else is 405 before the body. */
const OPERATION_METHOD: Readonly<Record<ExternalAppOperation, "GET" | "POST">> = Object.freeze({
  exchange: "POST",
  describe: "GET",
  open: "POST",
  read: "POST",
  stream: "GET",
  propose: "POST",
  agent_propose: "POST",
  close: "POST",
  revoke: "POST",
});

const ALLOWED_REQUEST_HEADERS = `authorization, content-type, ${EXTERNAL_APP_INSTANCE_HEADER}`;

/**
 * The pre-body admission gate for the whole external surface.
 *
 * Called from `server.ts`'s `preRouteGate`, which runs in `onRequest` — BEFORE
 * Fastify parses a body. That ordering is the point: an unknown origin sending
 * malformed JSON must be told `origin_refused`, not "your JSON is broken". A
 * caller who should never have been admitted must not learn anything about the
 * shape of a request, and must not be able to spend this process's parser.
 *
 * Everything decidable without the credential is decided here — the path names
 * a real operation, the method is the one that operation takes, the Origin is
 * on the operator's allowlist — and the CORS headers are attached to the reply
 * now, so that even a later refusal (including a body-parse failure) is
 * readable by the browser that asked. The preflight is answered here too, for
 * the same reason: it carries no credential, so nothing later in the chain has
 * anything to add.
 *
 * What is NOT decided here: whether the credential is valid, and whether THIS
 * binding's own host is the origin that asked. Being on the allowlist is not
 * being this credential's host, and that check needs the row.
 *
 * Returns false when it has already answered.
 */
export function externalAppPreGate(
  service: ExternalAppHostService | null,
  req: PanelRequest,
  reply: PanelReply,
): boolean {
  if (!service) {
    json(reply, 404, { error: "not found" });
    return false;
  }
  const origin = originOf(req);
  const allowed = Boolean(origin && service.settings.origins.has(origin));
  if (req.method === "OPTIONS") {
    if (!allowed) {
      json(reply, 403, { protocol: EXTERNAL_APP_HOST_PROTOCOL, code: "origin_refused", error: "origin refused" });
      return false;
    }
    void reply
      .code(204)
      .header("access-control-allow-origin", origin!)
      .header("vary", "origin")
      .header("access-control-allow-methods", "GET, POST, OPTIONS")
      .header("access-control-allow-headers", ALLOWED_REQUEST_HEADERS)
      .header("access-control-max-age", "600")
      .header("cache-control", "no-store")
      .send();
    return false;
  }
  // The origin comes FIRST, ahead of even "is this a path we serve": an
  // unknown origin must not be able to map the operation table by status code.
  if (!allowed) {
    json(reply, 403, { protocol: EXTERNAL_APP_HOST_PROTOCOL, code: "origin_refused", error: "origin refused" });
    return false;
  }
  corsHeaders(reply, origin!);
  const operation = externalAppOperation(panelUrl(req).pathname);
  if (!operation) {
    json(reply, 404, { error: "not found" });
    return false;
  }
  if (req.method !== OPERATION_METHOD[operation]) {
    json(reply, 405, { protocol: EXTERNAL_APP_HOST_PROTOCOL, code: "operation_refused", error: "method not allowed" });
    return false;
  }
  return true;
}

/** Which operation a path names, or null. The router's whole table. */
export function externalAppOperation(pathname: string): ExternalAppOperation | null {
  if (!pathname.startsWith(EXTERNAL_APP_BASE_PATH)) return null;
  return EXTERNAL_APP_PATHS[pathname.slice(EXTERNAL_APP_BASE_PATH.length)] ?? null;
}

export async function handleExternalApp(
  ctx: AppExternalRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
): Promise<void> {
  const service = ctx.externalAppHost;
  const origin = originOf(req);
  const operation = externalAppOperation(panelUrl(req).pathname);
  // `externalAppPreGate` already refused every request that fails any of these,
  // in `onRequest`, before the body was read. Re-asserting rather than
  // re-deciding: if this is ever reachable, the gate was bypassed and the only
  // safe answer is the one that grants nothing.
  if (!service || !operation || !origin || !service.settings.origins.has(origin)) {
    json(reply, 403, { protocol: EXTERNAL_APP_HOST_PROTOCOL, code: "origin_refused", error: "origin refused" });
    return;
  }

  if (operation === "exchange") {
    const exchanged = service.exchange({ token: bodyOf(req).token, origin });
    if (!exchanged.ok) {
      json(reply, exchanged.status, { protocol: EXTERNAL_APP_HOST_PROTOCOL, code: exchanged.code, error: exchanged.message });
      return;
    }
    json(reply, 200, { protocol: EXTERNAL_APP_HOST_PROTOCOL, ok: true, ...exchanged.value });
    return;
  }

  const bound = service.session({ secret: bearerOf(req), origin, operation });
  if (!bound.ok) {
    json(reply, bound.status, { protocol: EXTERNAL_APP_HOST_PROTOCOL, code: bound.code, error: bound.message });
    return;
  }
  const session = bound.value;
  switch (operation) {
    case "describe":
      json(reply, 200, { ok: true, ...service.describe(session) });
      return;
    case "open": {
      const opened = await service.open(session);
      answer(reply, opened, (value) => ({ ok: true, protocol: EXTERNAL_APP_HOST_PROTOCOL, ...value }));
      return;
    }
    case "read": {
      // A read is an open plus a close: an external host that only wants the
      // current board must not have to hold an instance to get one, and holding
      // one is what an interactive client does through `open`.
      const opened = await service.open(session);
      if (!opened.ok) {
        json(reply, opened.status, { protocol: EXTERNAL_APP_HOST_PROTOCOL, code: opened.code, error: opened.message });
        return;
      }
      service.close(session, opened.value.handle);
      json(reply, 200, {
        ok: true,
        protocol: EXTERNAL_APP_HOST_PROTOCOL,
        revision: opened.value.revision,
        projection: opened.value.projection,
      });
      return;
    }
    case "propose":
    case "agent_propose": {
      const body = bodyOf(req);
      const proposed = await service.propose(session, handleOf(req), {
        action: body.action,
        params: body.params,
      });
      answer(reply, proposed, (value) => ({ ok: true, protocol: EXTERNAL_APP_HOST_PROTOCOL, ...value }));
      return;
    }
    case "stream":
      streamExternalApp(ctx, service, session, handleOf(req), reply, origin);
      return;
    case "close": {
      const closed = service.close(session, handleOf(req));
      json(reply, closed ? 200 : 404, closed
        ? { ok: true, protocol: EXTERNAL_APP_HOST_PROTOCOL }
        : { ok: false, protocol: EXTERNAL_APP_HOST_PROTOCOL, code: "invalid_instance", error: "应用实例不可用" });
      return;
    }
    case "revoke": {
      const revoked = service.selfRevoke(session);
      answer(reply, revoked, (value) => ({ ok: true, protocol: EXTERNAL_APP_HOST_PROTOCOL, ...value }));
      return;
    }
    default:
      json(reply, 404, { error: "not found" });
  }
}

/**
 * The external projection stream.
 *
 * Three properties, and each exists because a stream is the one place a dead
 * binding could keep producing value:
 *
 *  1. **The subscription is created BEFORE the reply is hijacked**, so a handle
 *     that no longer resolves is an ordinary refusal rather than a torn stream.
 *     Anything the coordinator emits in that window is queued — including a
 *     `closed`, which is why the flush below ends the response instead of
 *     leaving a stream that has already said goodbye open forever.
 *  2. **A revalidation timer.** Expiry and an emptied host allowlist have no
 *     event to listen for, and a connection opened one second before the
 *     deadline must not outlive it. Every tick re-runs the whole live check by
 *     credential id (no secret is held for the life of the connection); the
 *     first `no` ends the stream and tears the binding's instances down.
 *  3. **A release change ends it immediately.** The coordinator's
 *     `release_available` is a CHROME hint for a browser tab that may reload
 *     itself. This binding is pinned to an exact release digest, so for it the
 *     same event means the binding is over — it is converted into `closed`
 *     rather than forwarded to a host that has nothing to do with it.
 */
const EXTERNAL_STREAM_REVALIDATE_MS = 5_000;

export function streamExternalApp(
  ctx: AppExternalRoutesContext,
  /** Narrow on purpose: a stream needs to listen and to re-ask, nothing else. */
  service: Pick<ExternalAppHostService, "subscribe" | "revalidate">,
  session: ExternalAppSession,
  handle: string,
  reply: PanelReply,
  origin: string,
): void {
  let res: ServerResponse | null = null;
  let stopStream: (() => void) | null = null;
  let ended = false;
  const queued: Array<[string, unknown]> = [];
  const send = (event: string, data: unknown): void => {
    if (!res) {
      queued.push([event, data]);
      return;
    }
    if (res.writableEnded || res.destroyed) {
      stopStream?.();
      return;
    }
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      stopStream?.();
    }
  };
  /** End the stream once, whoever noticed first. */
  const finish = (reason: string): void => {
    if (ended) return;
    ended = true;
    send("closed", { reason });
    // Null before the hijack: the flush below sees `ended` and ends the
    // response as soon as it owns one.
    res?.end();
  };
  const subscription = service.subscribe(session, handle, (event: InstanceEvent) => {
    if (event.type === "view") send("view", { revision: event.revision, projection: event.projection });
    else if (event.type === "release_available") finish("release_changed");
    else if (event.type === "closed") finish(event.reason);
    // `op` and `wake` belong to Session Plus's resource plane; a declared App
    // has none, so they are deliberately not forwarded rather than passed on as
    // events an external host would have to guess the meaning of.
  });
  if (!subscription) {
    json(reply, 404, { protocol: EXTERNAL_APP_HOST_PROTOCOL, code: "invalid_instance", error: "应用实例不可用" });
    return;
  }
  res = hijack(reply);
  const stream = res;
  let revalidate: NodeJS.Timeout | null = null;
  let beat: NodeJS.Timeout | null = null;
  const stop = onRawResponseEnd(stream, () => {
    ended = true;
    if (beat) {
      clearInterval(beat);
      beat = null;
    }
    if (revalidate) {
      clearInterval(revalidate);
      revalidate = null;
    }
    subscription.close();
    ctx.eventStreams.delete(stream);
    ctx.liveStreams.delete(stream);
  });
  stopStream = stop;
  ctx.eventStreams.add(res);
  ctx.liveStreams.set(res, { owner: session.binding.username, credential: session.binding.credential_id });
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": origin,
    vary: "origin",
  });
  res.write(": connected\n\n");
  send("view", { revision: subscription.initial.revision, projection: subscription.initial.projection });
  for (const [event, data] of queued.splice(0)) send(event, data);
  // A `closed` that arrived while the reply was still un-hijacked has now been
  // written; end the response it could not end at the time, and leave neither a
  // heartbeat nor a revalidation timer behind — a stream that has already said
  // goodbye must not be what keeps a socket alive. The registry rows are
  // removed here rather than by the `close` listener, which is not installed on
  // this path at all.
  if (ended) {
    res.end();
    stop();
    return;
  }
  if (stream.writableEnded || stream.destroyed) {
    stop();
    return;
  }
  revalidate = setInterval(() => {
    if (stream.writableEnded || stream.destroyed) {
      stop();
      return;
    }
    const still = service.revalidate(session.binding.credential_id);
    if (still.ok) return;
    // The service has already torn the binding's instances down, which ends
    // this subscription too; saying the reason first is what lets the host
    // render something better than "the connection dropped".
    finish(still.code);
  }, EXTERNAL_STREAM_REVALIDATE_MS);
  revalidate.unref?.();
  beat = setInterval(() => {
    if (stream.writableEnded || stream.destroyed) {
      stop();
      return;
    }
    try {
      stream.write(": ping\n\n");
    } catch {
      stop();
    }
  }, 20_000);
  beat.unref?.();
}

function answer<T>(
  reply: PanelReply,
  outcome: { ok: true; value: T } | { ok: false; status: number; code: string; message: string },
  render: (value: T) => Record<string, unknown>,
): void {
  if (outcome.ok) {
    json(reply, 200, render(outcome.value));
    return;
  }
  json(reply, outcome.status, { protocol: EXTERNAL_APP_HOST_PROTOCOL, code: outcome.code, error: outcome.message });
}

function corsHeaders(reply: PanelReply, origin: string): void {
  // Exactly one origin, echoed from the allowlist, plus `vary` so no shared
  // cache can serve one host's reply to another. `access-control-allow-
  // credentials` is deliberately ABSENT: this surface has no cookie authority
  // and must not teach a browser to attach one.
  void reply
    .header("access-control-allow-origin", origin)
    .header("vary", "origin")
    .header("cache-control", "no-store");
}

function originOf(req: PanelRequest): string | null {
  const raw = req.headers.origin;
  return typeof raw === "string" && raw ? raw : null;
}

/** The credential, from the Authorization header and from nowhere else. */
function bearerOf(req: PanelRequest): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function handleOf(req: PanelRequest): string {
  const raw = req.headers[EXTERNAL_APP_INSTANCE_HEADER];
  return typeof raw === "string" ? raw : "";
}

export function logExternalAppFailure(err: unknown): void {
  log.warn({ err }, "external App host request failed");
}
