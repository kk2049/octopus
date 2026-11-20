/**
 * Session browsing — the transcript viewer backend, its live SSE tails, and
 * the submission-operation stream.
 *
 * Mechanically relocated out of `server.ts` (2026-08-11 domain split): same
 * paths, same `authz.ts` rule ids, same status codes and messages. Every
 * decision about whose sessions and what may be written lives in
 * `SessionHubService` / `SessionOperationCoordinator`; these handlers are
 * transport.
 */

import {
  ENUMERATED_SOURCES,
  decodeSearchCursor,
  scanSourceArg,
  type Source as ScanSource,
} from "@claude-bot/plugin-sessions/scan";
import { recordConvergenceUsage } from "@claude-bot/convergence-gates";
import { createLogger } from "../../logger.js";
import { type HubPrincipal } from "../../sessionhub/service.js";
import { type PanelReply, type PanelRequest, bodyOf, panelUrl, replyJson as json } from "../http.js";
import type { DashboardOperationPort, DashboardSessionHubPort } from "../ports.js";
import { openRunnerTail } from "../live.js";
import { PANEL_BODY_SCHEMAS } from "../schemas.js";
import type { DashboardIdentity } from "../server.js";
import type { GuardedRoutes, StreamRegistries } from "./context.js";
import { clampInt, hijack, onRawResponseEnd, promptBudgetRefusal } from "./shared.js";

const log = createLogger("dashboard");

export interface SessionRoutesContext extends StreamRegistries {
  hub: DashboardSessionHubPort;
  operations: DashboardOperationPort;
  /** Which Session Hub front end this composition serves. */
  sessionHubUi: "legacy" | "unified-v3";
  requireUser(res: PanelReply, identity: DashboardIdentity, username: string): boolean;
  canWriteAs(identity: DashboardIdentity, username: string): boolean;
  targetAccount(req: PanelRequest, identity: DashboardIdentity): string;
}

export function registerSessionRoutes(routes: GuardedRoutes, ctx: SessionRoutesContext): void {
  routes.get("/api/sessions", "api.sessions.list", (req, reply, identity) => {
    observeUi(identity, "sessions.roster", "read");
    return apiSessionRoster(ctx, req, reply, identity);
  });
  routes.get("/api/session", "api.session", (req, reply, identity) => {
    observeUi(identity, "sessions.read", "read");
    return apiSessionRead(ctx, req, reply, identity);
  });
  routes.get("/api/sessions/search", "api.sessions.search", (req, reply, identity) => {
    observeUi(identity, "sessions.search", "read");
    return apiSessionSearch(ctx, req, reply, identity);
  });
  routes.get("/api/sessions/live", "api.sessions.live", (req, reply, identity) => {
    observeUi(identity, "sessions.live", "read");
    return handleLive(ctx, req, reply, identity);
  });
  routes.post("/api/sessions/append", "api.sessions.append", PANEL_BODY_SCHEMAS.sessionsAppend, (req, reply, identity) => {
    observeUi(identity, "sessions.append", "execute");
    return apiSessionAppend(ctx, req, reply, identity);
  });
  routes.post(
    "/api/sessions/interaction",
    "api.sessions.interaction",
    PANEL_BODY_SCHEMAS.sessionInteraction,
    (req, reply, identity) => {
      observeUi(identity, "sessions.interaction", "write");
      return apiSessionInteraction(ctx, req, reply, identity);
    },
  );
  routes.get("/api/sessions/operations", "api.sessions.operations", (req, reply, identity) => {
    observeUi(identity, "sessions.operations", "read");
    // `ReadAccount` on the query target: one's own records, or — for a named
    // administrator — the account they are acting on (2026-10-15).
    const owner = ctx.targetAccount(req, identity);
    if (!ctx.requireUser(reply, identity, owner)) return;
    const params = panelUrl(req).searchParams;
    // A window of at most 200, newest first; `before=<operation id>` (the
    // previous window's `next_before`) continues to the oldest record.
    const limit = clampInt(params.get("limit"), 1, 200, 50);
    const window = ctx.operations.list(owner, {
      sessionId: params.get("session") || undefined,
      limit: limit + 1,
      beforeId: params.get("before") || undefined,
    });
    const operations = window.slice(0, limit);
    json(reply, 200, {
      username: owner,
      operations,
      ...(window.length > limit ? { next_before: operations.at(-1)!.id } : {}),
    });
  });
  routes.get("/api/sessions/operations/stream", "api.sessions.operations.stream", (req, reply, identity) => {
    const owner = ctx.targetAccount(req, identity);
    if (!ctx.requireUser(reply, identity, owner)) return;
    streamOperations(ctx, req, reply, identity, owner);
  });
}

function observeUi(identity: DashboardIdentity, entry: string, effect: "read" | "write" | "execute"): void {
  if (!identity.username) return;
  recordConvergenceUsage({
    candidate: "native-session-ui",
    principal: identity.username,
    entry,
    provider: "octopus-dashboard",
    effect,
    outcome: "observed",
  });
}

async function apiSessionRoster(ctx: SessionRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  const username = ctx.targetAccount(req, identity);
  if (!ctx.requireUser(reply, identity, username)) return;
  const p = panelUrl(req).searchParams;
  json(
    reply,
    200,
    await ctx.hub.roster(hubPrincipal(identity), username, {
      // 500 = scan layer LIST_LIMIT_MAX; the sessions page asks for 400 so the
      // directory tree can fold the user's whole roster client-side.
      limit: clampInt(p.get("limit"), 1, 500, 50),
      source: sourceParam(p.get("source")),
      sinceHours: positiveNumber(p.get("since_hours")),
    }),
  );
}

async function apiSessionRead(ctx: SessionRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  const p = panelUrl(req).searchParams;
  const username = p.get("username") || identity.username || "";
  if (!ctx.requireUser(reply, identity, username)) return;
  // A `resource` handle, when present, names (owner, device, kind, id) in one
  // opaque token — and is then RE-CHECKED against the account the gate
  // authorised. It is a convenience, never authority: a handle for another
  // owner is refused exactly as a query parameter naming them would be.
  const handle = ctx.hub.decodeResourceId(p.get("resource") ?? "");
  if (handle && handle.owner !== username) {
    json(reply, 403, { error: "forbidden" });
    return;
  }
  const id = (handle?.sessionId ?? p.get("id") ?? "").trim();
  if (!id) {
    json(reply, 400, { error: "id is required" });
    return;
  }
  const device = (handle?.device ?? p.get("device") ?? "").trim();
  const source = handle?.cliKind ?? p.get("source") ?? "";
  const limit = clampInt(p.get("limit"), 1, 500, 200);
  const offsetRaw = p.get("offset");
  const args: Record<string, unknown> = { id, rich: true, max_messages: limit };
  if (ENUMERATED_SOURCES.includes(source as ScanSource)) args.source = source;
  if (offsetRaw != null && offsetRaw !== "" && Number.isFinite(Number(offsetRaw))) args.offset = Number(offsetRaw);
  // Backward paging and complete-block reads, same window semantics as read_session.
  for (const key of ["before", "block", "char_offset"] as const) {
    const raw = p.get(key);
    if (raw != null && raw !== "" && Number.isSafeInteger(Number(raw)) && Number(raw) >= 0) args[key] = Number(raw);
  }
  const field = p.get("field");
  if (field === "text" || field === "input" || field === "output") args.field = field;
  try {
    const out = await ctx.hub.read(hubPrincipal(identity), username, device, args);
    if (out.ok) json(reply, 200, out.data);
    else json(reply, out.status, { error: out.error });
  } catch (err) {
    json(reply, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function apiSessionSearch(ctx: SessionRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  const p = panelUrl(req).searchParams;
  const username = p.get("username") || identity.username || "";
  if (!ctx.requireUser(reply, identity, username)) return;
  const query = (p.get("query") ?? "").trim();
  if (!query) {
    json(reply, 400, { error: "query is required" });
    return;
  }
  // The continuation of a complete search; validated here so a malformed one is a 400, not a device error.
  const cursor = p.get("cursor") ?? "";
  try { decodeSearchCursor(cursor); } catch {
    json(reply, 400, { error: "cursor 无效；请重新搜索" });
    return;
  }
  const found = await ctx.hub.search(hubPrincipal(identity), username, query, {
    limit: clampInt(p.get("limit"), 1, 50, 15),
    source: sourceParam(p.get("source")),
    ...(positiveNumber(p.get("since_hours")) ? { since_hours: positiveNumber(p.get("since_hours")) } : {}),
    ...(cursor ? { cursor } : {}),
  });
  if (found.ok) json(reply, 200, found.data);
  else json(reply, found.status, { error: found.error });
}

async function apiSessionAppend(ctx: SessionRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  const body = bodyOf(req);
  // Absent = the authenticated account. Naming somebody else is still possible
  // and still refused below; what the default removes is the case where a
  // client has to state its own identity back to the server, which is a field
  // that can only ever be redundant or wrong.
  const username = String(body.username ?? identity.username ?? "");
  // The owner, or a named administrator (2026-10-15): append executes on the
  // target user's machine with their CLI credentials. Checked here AND inside
  // the service — the service is the boundary a future shell calls, and a
  // boundary that trusts its caller is not one.
  if (!ctx.canWriteAs(identity, username)) {
    json(reply, 403, { error: "append 仅限本人或管理员操作 — 请用自己的 /dashboard 链接登录" });
    return;
  }
  const handle = ctx.hub.decodeResourceId(String(body.resource ?? ""));
  if (handle && handle.owner !== username) {
    json(reply, 403, { error: "forbidden" });
    return;
  }
  const device = String(handle?.device ?? body.device ?? "").trim();
  const id = String(handle?.sessionId ?? body.id ?? "").trim();
  const prompt = String(body.prompt ?? "").trim();
  const overBudget = promptBudgetRefusal("消息", prompt);
  if (overBudget) {
    json(reply, 413, { error: overBudget });
    return;
  }
  const source = String(handle?.cliKind ?? body.source ?? "");
  // `resume_session` shares this execution path and differs in its
  // authorisation and audit identity — see the catalog entry. An UNRECOGNISED
  // value is refused rather than folded into append: a typo used to become an
  // `append_session` audit record for something the user had asked to resume,
  // which is a quiet lie about who did what.
  const operation = parseSessionOperation(body.operation);
  if (!operation) {
    json(reply, 400, { error: "operation 只能是 append_session、resume_session、takeover_session、fallback_session 或 interrupt_session" });
    return;
  }
  log.info({ username, by: identity.username, device, id: id.slice(0, 12), source: source || undefined, operation }, "Session hub append");
  const submitted = await ctx.operations.submit("hub", hubPrincipal(identity), {
    owner: username,
    device,
    sessionId: id,
    prompt,
    source,
    operation,
  });
  if (!submitted.ok) {
    // Refused before a record existed: there is no operation to follow, and
    // saying otherwise would leave the page waiting on a lifecycle that never
    // started.
    json(reply, submitted.status, {
      error: submitted.error,
      ...(submitted.pendingCallId ? { pending_call_id: submitted.pendingCallId } : {}),
    });
    return;
  }
  if (ctx.sessionHubUi === "unified-v3") {
    // The record IS the answer. 202 because the work has been accepted and is
    // not finished — the page follows `operation_id` on the stream.
    json(reply, 202, { operation_id: submitted.operation.id, operation: submitted.operation });
    return;
  }
  // Legacy transport: one request, one outcome. Same coordinator, same
  // record — only the reporting shape differs.
  const { view, outcome } = await submitted.settled;
  if (outcome?.ok) {
    log.info({ username, device, id: id.slice(0, 12), ok: true }, "Session hub append done");
    json(reply, 200, { ...(outcome.result as Record<string, unknown> | null), operation_id: view.id });
    return;
  }
  if (!outcome) {
    // Two ways to get here. A duplicate joined the submission already in
    // flight — it reports the SAME approval, because the whole point of
    // joining is that there is one card and one turn, so a caller that only
    // understands `pending_call_id` must still be told which one. Or the
    // execution path itself failed to produce an outcome, in which case the
    // record is already terminal and 202 would be a lie about what is next.
    json(reply, view.live ? 202 : 502, {
      operation_id: view.id,
      operation: view,
      error: view.message,
      ...(view.status === "waiting_approval" ? { approval_required: true } : {}),
      ...(view.pendingCallId ? { pending_call_id: view.pendingCallId } : {}),
    });
    return;
  }
  json(reply, outcome.status, {
    error: outcome.error,
    operation_id: view.id,
    ...(outcome.approvalRequired ? { approval_required: true } : {}),
    ...(outcome.pendingCallId ? { pending_call_id: outcome.pendingCallId } : {}),
  });
}

async function apiSessionInteraction(
  ctx: SessionRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): Promise<void> {
  const body = bodyOf(req);
  const username = String(body.username ?? identity.username ?? "");
  if (!identity.session || !ctx.canWriteAs(identity, username)) {
    json(reply, 403, { error: "回答 Agent 请求只允许本人当前的网页登录操作" });
    return;
  }
  const result = await ctx.hub.respondInteraction(hubPrincipal(identity), {
    owner: username,
    device: String(body.device ?? "").trim(),
    provider: String(body.provider ?? "").trim(),
    sessionId: String(body.session_id ?? "").trim(),
    interactionId: String(body.interaction_id ?? "").trim(),
    responseJson: String(body.response_json ?? ""),
  });
  if (result.ok) json(reply, 200, { ok: true, result: result.data });
  else json(reply, result.status, { error: result.error });
}

/**
 * SSE live tail of one session (doc/design-session-live-view.md). Streams
 * `delta` events through a shared per-session tailer. Auth is the same
 * read-scope check as /api/session — a read-only capability, so admin keys may
 * watch too.
 *
 * Every refusal happens BEFORE `reply.hijack()`, which is the moment the
 * socket stops being the framework's: after it there is no serializer, no
 * `onSend` hook and no compression, and a JSON error written into a half-sent
 * event stream would be worse than the error.
 */
async function handleLive(
  ctx: SessionRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): Promise<void> {
  const url = panelUrl(req);
  const p = url.searchParams;
  const username = p.get("username") || identity.username || "";
  if (!ctx.requireUser(reply, identity, username)) return;
  const handle = ctx.hub.decodeResourceId(p.get("resource") ?? "");
  if (handle && handle.owner !== username) {
    json(reply, 403, { error: "forbidden" });
    return;
  }
  const id = (handle?.sessionId ?? p.get("id") ?? "").trim();
  if (!id) {
    json(reply, 400, { error: "id is required" });
    return;
  }
  const device = (handle?.device ?? p.get("device") ?? "").trim();
  const sourceRaw = handle?.cliKind ?? p.get("source") ?? "";
  const source = ENUMERATED_SOURCES.includes(sourceRaw as ScanSource)
    ? sourceRaw as ScanSource
    : undefined;

  // A long-lived tail is a long-lived read: it gets its own Context, which
  // dies with the stream. Both resources answer through the same call, so
  // "follow a bot-host session" is authorised exactly like "follow a laptop
  // session" — it used to be a direct filesystem tail with no grant at all,
  // which is why revoking the hub grant left local streams running.
  const verdict = ctx.hub.liveGrant(hubPrincipal(identity), username, device);
  if (!verdict.ok) {
    json(reply, verdict.status, { error: verdict.error });
    return;
  }
  const res = hijack(reply);
  const { grant, local } = verdict;
  // JSON, not "a|b|c": with a separator, a device string containing the
  // separator could in principle collide with another user's key. Usernames
  // are currently too restrictive for that to be reachable — which is
  // exactly why it should not be load-bearing.
  //
  // The CREDENTIAL is in the key so a tailer is never shared between two
  // logins. Tailers are refcounted and driven by whichever grant created
  // them; sharing one across logins would mean a stream that outlived the
  // login that authorised it kept being fed by a Context belonging to
  // somebody else's session.
  const key = JSON.stringify(["session", username, identity.credential, device, source ?? "", id]);
  // Registered so a revocation can END this stream rather than merely stop
  // the next poll (see `closeLive`).
  ctx.liveStreams.set(res, { owner: identity.username ?? username, credential: identity.credential });
  onRawResponseEnd(res, () => {
    grant.close();
    ctx.liveStreams.delete(res);
  });
  await ctx.startSse(req, res, url.searchParams, key, async () => ({
    // One poller for both resources: a live tail IS a repeated `read_session`,
    // and the two Objects declare that operation with the same name and the
    // same result shape precisely so this does not need a branch.
    src: openRunnerTail((m, a) => grant.call(m, a), source, id, local ? undefined : device),
    // The bot host is a local file, so it can afford to be checked more often
    // than a laptop across a WebSocket.
    intervalMs: local ? 2000 : 4000,
  }));
}

/**
 * Owner-scoped stream of submission lifecycle events.
 *
 * Deliberately its own stream rather than a field on the transcript stream:
 * the transcript proves the FILE grew, which is a different claim from "your
 * instruction is waiting for you / running / finished / cannot be proven".
 * Conflating them is how the original failure happened — a transcript that
 * eventually showed `OK` while the page still said nothing at all.
 *
 * It carries no session material: an operation view is (id, device, session
 * id, status, a short summary). Which is also why it is `Identify` on self and
 * not a cross-account read.
 */
export function streamOperations(
  ctx: SessionRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
  owner: string = identity.username!,
): void {
  const url = panelUrl(req);
  const res = hijack(reply);
  let beat: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  const cleanup = onRawResponseEnd(res, () => {
    if (beat) {
      clearInterval(beat);
      beat = null;
    }
    unsubscribe?.();
    unsubscribe = null;
    ctx.eventStreams.delete(res);
    ctx.liveStreams.delete(res);
  });
  ctx.eventStreams.add(res);
  // Registered like a transcript stream so a revocation or a logout ends it
  // rather than leaving a page that still LOOKS connected. Keyed on the viewer,
  // so an administrator's logout also ends the streams they opened elsewhere.
  ctx.liveStreams.set(res, { owner: identity.username ?? owner, credential: identity.credential });
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const write = (chunk: string): void => {
    if (res.writableEnded || res.destroyed) {
      cleanup();
      return;
    }
    try {
      res.write(chunk);
    } catch {
      cleanup();
    }
  };
  const send = (event: string, data: unknown): void => {
    write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  write(": connected\n\n");
  // A reload must not have to guess: the snapshot is the same view the stream
  // then patches, so state is restored from the record rather than from
  // whatever the page happened to remember.
  for (const op of ctx.operations.list(owner, {
    sessionId: url.searchParams.get("session") || undefined,
    limit: clampInt(url.searchParams.get("limit"), 1, 200, 50),
  })) {
    send("operation", op);
  }
  send("ready", { username: owner });
  if (res.writableEnded || res.destroyed) {
    cleanup();
    return;
  }
  unsubscribe = ctx.operations.subscribe(owner, (view) => send("operation", view));
  beat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      cleanup();
      return;
    }
    try {
      res.write(": ping\n\n");
    } catch {
      cleanup();
    }
  }, 20_000);
  beat.unref?.();
}

/**
 * The panel identity, narrowed to what the Session Hub is allowed to see.
 *
 * The hub must never receive the session object (it carries token and CSRF
 * hashes). It decides by ownership plus one bit: a named administrator may act
 * on any account (2026-10-15), and the hub records who did.
 */
function hubPrincipal(identity: DashboardIdentity): HubPrincipal {
  return {
    username: identity.username,
    admin: identity.admin,
    session: Boolean(identity.session),
    credential: identity.credential,
  };
}

/**
 * Which hub operation the caller asked for, or null.
 *
 * Absent means append — the historical default, and the honest one for a client
 * that has no opinion. A value that is neither is REFUSED rather than coerced:
 * `resume` (no `_session`) used to become an append, and the audit record then
 * named an operation the user had not chosen.
 */
function parseSessionOperation(raw: unknown): "append_session" | "resume_session" | "takeover_session" | "fallback_session" | "interrupt_session" | null {
  if (raw === undefined || raw === null || raw === "") return "append_session";
  if (raw === "append_session" || raw === "resume_session" || raw === "takeover_session" || raw === "fallback_session" || raw === "interrupt_session") return raw;
  return null;
}

function sourceParam(raw: string | null): string {
  return scanSourceArg(raw);
}

function positiveNumber(raw: string | null): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
