/**
 * `/api/knowledge*` — the knowledge wiki routes.
 *
 * Wiki reads are server-local SQLite projections. Review writes record human
 * judgement without editing knowledge. Knowledge Chat writes use their own
 * owner-scoped conversation tables and in-process read-only agent; they never
 * enter the development-ticket pipeline. All mutations need `UseDev`.
 */

import { type PanelReply, type PanelRequest, panelUrl, replyJson as json } from "../http.js";
import type { NodeKind } from "../../knowledge/model.js";
import { NODE_KINDS } from "../../knowledge/model.js";
import type {
  KnowledgeChatListCursor,
  KnowledgeChatMessageRow,
  KnowledgeChatRow,
} from "../../store/repositories/knowledge-chats.js";
import {
  isKnowledgeRetrievalEventsCursor,
  isKnowledgeRetrievalReviewCursor,
} from "../../store/repositories/knowledge-retrieval.js";
import type { DashboardKnowledgePort } from "../ports.js";
import type { DashboardIdentity, DashboardRouteOptions } from "../server.js";
import type { GuardedRoutes } from "./context.js";

export interface KnowledgeRoutesContext {
  opts: Pick<DashboardRouteOptions, "knowledge" | "knowledgeChat">;
}

export const KNOWLEDGE_PREVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["body"],
  properties: {
    title: { type: "string", maxLength: 200 },
    body: { type: "string", minLength: 1, maxLength: 12_000 },
  },
} as const;

export const KNOWLEDGE_DECIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject_id", "decision"],
  properties: {
    subject_id: { type: "string", minLength: 1, maxLength: 400 },
    rule: { type: "string", maxLength: 80 },
    decision: { type: "string", enum: ["dismissed", "confirmed", "resolved", "reopened", "approved_change"] },
    fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
    note: { type: "string", maxLength: 600 },
  },
} as const;

export const KNOWLEDGE_ANNOTATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject_id", "body"],
  properties: {
    subject_id: { type: "string", minLength: 1, maxLength: 400 },
    body: { type: "string", minLength: 1, maxLength: 2000 },
  },
} as const;

export const KNOWLEDGE_CHAT_CREATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message", "request_id"],
  properties: {
    subject_id: { type: "string", minLength: 1, maxLength: 400 },
    message: { type: "string", minLength: 1, maxLength: 4000 },
    request_id: { type: "string", minLength: 8, maxLength: 80 },
  },
} as const;

export const KNOWLEDGE_CHAT_SEND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["chat_id", "message", "request_id"],
  properties: {
    chat_id: { type: "string", minLength: 4, maxLength: 80 },
    message: { type: "string", minLength: 1, maxLength: 4000 },
    request_id: { type: "string", minLength: 8, maxLength: 80 },
  },
} as const;

export function registerKnowledgeRoutes(routes: GuardedRoutes, ctx: KnowledgeRoutesContext): void {
  routes.get("/api/knowledge/sources", "api.knowledge.sources.read", (req,reply,identity) => {
    if (!identity.username) return json(reply,403,{error:"需要命名用户"});
    const params=panelUrl(req).searchParams;
    try { json(reply,200,service(ctx).sources(identity.username,params.has("id")?"read":"list",Object.fromEntries(params))); }
    catch(error) { json(reply,400,{error:error instanceof Error?error.message:"来源读取失败"}); }
  });
  routes.post("/api/knowledge/sources", "api.knowledge.sources.import", {type:"object",additionalProperties:false,required:["source_json"],properties:{source_json:{type:"string",maxLength:16000}}}, (req,reply,identity) => {
    if (!identity.username || !identity.session) return json(reply,403,{error:"需要本人浏览器登录"});
    try { json(reply,200,service(ctx).sources(identity.username,"import",req.body as Record<string,unknown>)); }
    catch(error) { json(reply,400,{error:error instanceof Error?error.message:"来源导入失败"}); }
  });
  routes.post("/api/knowledge/sources/confirm", "api.knowledge.sources.confirm", {
    type:"object",additionalProperties:false,required:["id","source_sha256","kind","statement"],properties:{id:{type:"string",maxLength:80},source_sha256:{type:"string",pattern:"^[0-9a-f]{64}$"},kind:{type:"string",enum:["requirement","endorsement"]},statement:{type:"string",minLength:8,maxLength:120}},
  }, (req,reply,identity) => {
    if (!identity.username || !identity.session) return json(reply,403,{error:"只有本人浏览器登录能提交具体设计确认"});
    try { json(reply,200,service(ctx).confirmSource(identity.username,req.body as Parameters<DashboardKnowledgePort["confirmSource"]>[1])); }
    catch(error) { json(reply,400,{error:error instanceof Error?error.message:"确认失败"}); }
  });
  routes.get("/api/knowledge/repairs", "api.knowledge.repairs.read", (req,reply) => json(reply,200,service(ctx).repairs(panelUrl(req).searchParams.get("after")??"")));
  routes.post("/api/knowledge/repairs", "api.knowledge.repairs.write", {
    type:"object",additionalProperties:false,required:["action"],properties:{action:{type:"string",enum:["report","investigate","replay"]},id:{type:"string",maxLength:80},record_id:{type:"string",maxLength:512},fingerprint:{type:"string",maxLength:64},problem:{type:"string",maxLength:40},investigation_json:{type:"string",maxLength:4000}},
  }, async(req,reply) => {
    const input=req.body as Record<string,unknown>;
    try { json(reply,200,await service(ctx).repair(String(input.action),input)); }
    catch(error) { json(reply,400,{error:error instanceof Error?error.message:"纠错操作失败"}); }
  });
  routes.post("/api/knowledge/review/decide", "api.knowledge.review.decide", KNOWLEDGE_DECIDE_SCHEMA, (req, reply, identity) =>
    apiDecide(ctx, req, reply, identity),
  );
  routes.post("/api/knowledge/conflict/annotate", "api.knowledge.conflict.annotate", KNOWLEDGE_ANNOTATE_SCHEMA, (req, reply, identity) =>
    apiAnnotate(ctx, req, reply, identity),
  );
  routes.get("/api/knowledge/chats", "api.knowledge.chats.read", (req, reply, identity) =>
    apiKnowledgeChats(ctx, req, reply, identity),
  );
  routes.get("/api/knowledge/chat", "api.knowledge.chat.read", (req, reply, identity) =>
    apiKnowledgeChat(ctx, req, reply, identity),
  );
  routes.post("/api/knowledge/chats", "api.knowledge.chats.write", KNOWLEDGE_CHAT_CREATE_SCHEMA, (req, reply, identity) =>
    apiCreateKnowledgeChat(ctx, req, reply, identity),
  );
  routes.post("/api/knowledge/chat/send", "api.knowledge.chat.write", KNOWLEDGE_CHAT_SEND_SCHEMA, (req, reply, identity) =>
    apiSendKnowledgeChat(ctx, req, reply, identity),
  );
  routes.get("/api/knowledge/conflict", "api.knowledge.conflict", (req, reply) => apiConflictWorkspace(ctx, req, reply));
  routes.post("/api/knowledge/preview", "api.knowledge.preview", KNOWLEDGE_PREVIEW_SCHEMA, (req, reply) => apiPreview(ctx, req, reply));
  routes.get("/api/knowledge/health", "api.knowledge.health", (_req, reply) => json(reply, 200, service(ctx).artifactHealth()));
  routes.get("/api/knowledge/review", "api.knowledge", (_req, reply) => json(reply, 200, service(ctx).review()));
  routes.get("/api/knowledge/retrievals", "api.knowledge", (req, reply) => apiRetrievals(ctx, req, reply));
  routes.get("/api/knowledge/retrieval", "api.knowledge", (req, reply) => apiRetrieval(ctx, req, reply));
  routes.get("/api/knowledge/graph", "api.knowledge", (_req, reply) => json(reply, 200, service(ctx).relationGraph()));
  routes.get("/api/knowledge/capability", "api.knowledge", (req, reply) => apiById(ctx, req, reply, "capability"));
  routes.get("/api/knowledge/module", "api.knowledge", (req, reply) => apiById(ctx, req, reply, "module"));
  routes.get("/api/knowledge/node", "api.knowledge", (req, reply) => apiById(ctx, req, reply, "node"));
  routes.get("/api/knowledge/search", "api.knowledge", (req, reply) => apiSearch(ctx, req, reply));
  routes.get("/api/knowledge", "api.knowledge", (_req, reply) => json(reply, 200, service(ctx).overview()));
}

function service(ctx: KnowledgeRoutesContext): DashboardKnowledgePort {
  const svc = ctx.opts.knowledge;
  if (!svc) throw new Error("knowledge routes require a composed KnowledgeWikiService");
  return svc;
}

function apiRetrievals(ctx: KnowledgeRoutesContext, req: PanelRequest, reply: PanelReply): void {
  const params = panelUrl(req).searchParams;
  const rawTicket = params.get("ticket_id");
  const rawBeforeTicket = params.get("before_ticket");
  for (const raw of [rawTicket, rawBeforeTicket]) {
    if (raw !== null && (!/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(Number(raw)))) {
      json(reply, 400, { error: "ticket_id / before_ticket 必须是正整数" });
      return;
    }
  }
  const requestedLimit = Number(params.get("limit") ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 50) : 50;
  if (params.get("view") === "tickets") {
    json(reply, 200, service(ctx).retrievalTickets({ limit, ...(rawBeforeTicket ? { before: Number(rawBeforeTicket) } : {}) }));
    return;
  }
  const rawOutcome = params.get("outcome");
  const outcome = rawOutcome === "miss" || rawOutcome === "error" || rawOutcome === "feedback" || rawOutcome === "all"
    ? rawOutcome
    : undefined;
  const rawLane = params.get("lane");
  const lane = rawLane === "ticket" || rawLane === "cli" ? rawLane : undefined;
  const before = params.get("before") ?? undefined;
  if (before && !isKnowledgeRetrievalReviewCursor(before)) {
    json(reply, 400, { error: "before 必须是服务端签发的检索游标" });
    return;
  }
  json(reply, 200, service(ctx).retrievals({
    ...(rawTicket ? { ticket_id: Number(rawTicket) } : {}),
    ...(outcome ? { outcome } : {}),
    ...(lane ? { lane } : {}),
    ...(before ? { before } : {}),
    limit,
  }));
}

function apiRetrieval(ctx: KnowledgeRoutesContext, req: PanelRequest, reply: PanelReply): void {
  const params = panelUrl(req).searchParams;
  const id = (params.get("id") ?? "").trim();
  if (!/^kr_[0-9a-f]{32}$/u.test(id)) {
    json(reply, 400, { error: "id 必须是检索 trace id" });
    return;
  }
  const eventsBefore = params.get("events_before") ?? undefined;
  if (eventsBefore && !isKnowledgeRetrievalEventsCursor(eventsBefore, id)) {
    json(reply, 400, { error: "events_before 必须是该 trace 的服务端签发游标" });
    return;
  }
  const requestedEventsLimit = Number(params.get("events_limit") ?? 25);
  const eventsLimit = Number.isFinite(requestedEventsLimit)
    ? Math.min(Math.max(Math.floor(requestedEventsLimit), 1), 25)
    : 25;
  const trace = service(ctx).retrievalTrace(id, {
    ...(eventsBefore ? { before: eventsBefore } : {}),
    limit: eventsLimit,
  });
  if (!trace) {
    json(reply, 404, { error: "检索 trace 不存在或已过保留期" });
    return;
  }
  json(reply, 200, trace);
}

function apiById(ctx: KnowledgeRoutesContext, req: PanelRequest, reply: PanelReply, what: "capability" | "module" | "node"): void {
  const id = (panelUrl(req).searchParams.get("id") ?? "").trim();
  if (!id || id.length > 400) {
    json(reply, 400, { error: "id 必填" });
    return;
  }
  const svc = service(ctx);
  const out = what === "capability" ? svc.capability(id) : what === "module" ? svc.module(id) : svc.node(id);
  if (!out) {
    json(reply, 404, { error: `${what} 不存在或知识图谱尚未构建` });
    return;
  }
  json(reply, 200, out);
}

async function apiSearch(ctx: KnowledgeRoutesContext, req: PanelRequest, reply: PanelReply): Promise<void> {
  const params = panelUrl(req).searchParams;
  const query = (params.get("q") ?? "").trim().slice(0, 300);
  if (!query) {
    json(reply, 400, { error: "q 必填" });
    return;
  }
  const kinds = (params.get("kinds") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is NodeKind => (NODE_KINDS as readonly string[]).includes(item));
  json(reply, 200, await service(ctx).search(query, kinds));
}

async function apiPreview(ctx: KnowledgeRoutesContext, req: PanelRequest, reply: PanelReply): Promise<void> {
  const body = (req.body ?? {}) as { title?: unknown; body?: unknown };
  const out = await service(ctx).preview(typeof body.title === "string" ? body.title : "", String(body.body ?? ""));
  if (!out) {
    json(reply, 404, { error: "知识图谱尚未构建" });
    return;
  }
  json(reply, 200, out);
}

function apiDecide(ctx: KnowledgeRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const body = (req.body ?? {}) as { subject_id?: unknown; rule?: unknown; decision?: unknown; note?: unknown; fingerprint?: unknown };
  const out = service(ctx).decide({
    subject_id: String(body.subject_id ?? ""),
    rule: typeof body.rule === "string" ? body.rule : "",
    decision: String(body.decision ?? ""),
    note: typeof body.note === "string" ? body.note : "",
    actor: identity.username ?? "token",
    admin: identity.admin && Boolean(identity.session),
    fingerprint: typeof body.fingerprint === "string" ? body.fingerprint : undefined,
  });
  json(reply, out.ok ? 200 : 400, out);
}

function apiConflictWorkspace(ctx: KnowledgeRoutesContext, req: PanelRequest, reply: PanelReply): void {
  const subject = (panelUrl(req).searchParams.get("subject") ?? "").trim();
  const workspace = service(ctx).conflictWorkspace(subject);
  if (!workspace) {
    json(reply, 404, { error: "冲突协作区不存在" });
    return;
  }
  json(reply, 200, workspace);
}

function apiAnnotate(
  ctx: KnowledgeRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const requestBody = req.body;
  const subject = requestBody && typeof requestBody === "object" && "subject_id" in requestBody
    ? requestBody.subject_id
    : undefined;
  const annotation = requestBody && typeof requestBody === "object" && "body" in requestBody
    ? requestBody.body
    : undefined;
  const out = service(ctx).annotate({
    subject_id: String(subject ?? ""),
    body: String(annotation ?? ""),
    actor: identity.username ?? "admin",
  });
  json(reply, out.ok ? 200 : 400, out);
}

function chatService(ctx: KnowledgeRoutesContext) {
  return ctx.opts.knowledgeChat;
}

function publicChat(chat: KnowledgeChatRow) {
  return {
    id: chat.id,
    subject_id: chat.subject_id,
    title: chat.title,
    preview: chat.preview,
    created_at: chat.created_at,
    updated_at: chat.updated_at,
    running_since: chat.running_since,
  };
}

function publicMessage(message: KnowledgeChatMessageRow) {
  return {
    id: message.id,
    chat_id: message.chat_id,
    role: message.role,
    content: message.content,
    at: message.at,
  };
}

function requireUsername(identity: DashboardIdentity, reply: PanelReply): string | null {
  if (identity.username) return identity.username;
  json(reply, 400, { error: "知识 Chat 需要以个人 Dashboard 账号使用" });
  return null;
}

/**
 * A roster cursor on the wire: `<updated_at>|<id>` of a window's last row.
 * Neither half can contain `|` (ISO-8601 and `kc_…`), so the split is exact.
 */
function chatListCursor(chat: KnowledgeChatListCursor): string {
  return `${chat.updatedAt}|${chat.id}`;
}

function readChatListCursor(value: string): KnowledgeChatListCursor | null {
  const bar = value.indexOf("|");
  if (bar <= 0 || value.length > 200) return null;
  const updatedAt = value.slice(0, bar);
  const id = value.slice(bar + 1);
  if (!/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(updatedAt) || !id || id.length > 80 || id.includes("|")) return null;
  return { updatedAt, id };
}

function apiKnowledgeChats(
  ctx: KnowledgeRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const username = requireUsername(identity, reply);
  if (!username) return;
  // `before` is the previous window's `next_before`: older conversations.
  // Absent, the most recently active window (what the open page polls).
  const rawBefore = panelUrl(req).searchParams.get("before");
  const before = rawBefore === null ? undefined : readChatListCursor(rawBefore);
  if (before === null) {
    json(reply, 400, { error: "before 必须是上一页返回的 next_before" });
    return;
  }
  const chat = chatService(ctx);
  const page = chat?.list(username, before) ?? { chats: [], next: null };
  json(reply, 200, {
    enabled: Boolean(chat?.enabled),
    model: chat?.model ?? null,
    chats: page.chats.map(publicChat),
    next_before: page.next ? chatListCursor(page.next) : null,
  });
}

async function apiKnowledgeChat(
  ctx: KnowledgeRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): Promise<void> {
  const username = requireUsername(identity, reply);
  if (!username) return;
  const id = (panelUrl(req).searchParams.get("id") ?? "").trim();
  if (!id || id.length > 80) {
    json(reply, 400, { error: "id 必填" });
    return;
  }
  const chat = chatService(ctx);
  if (!chat) {
    json(reply, 503, { error: "知识 Chat 未接线" });
    return;
  }
  // `before` is the previous window's first message id: an older window of
  // the same chat. Absent, the newest window (what the open page polls).
  const rawBefore = panelUrl(req).searchParams.get("before");
  const before = rawBefore === null ? undefined : Number(rawBefore);
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
    json(reply, 400, { error: "before 必须是消息 id" });
    return;
  }
  const history = await chat.history(username, id, before);
  if (!history) {
    json(reply, 404, { error: "知识 Chat 不存在" });
    return;
  }
  json(reply, 200, {
    enabled: chat.enabled,
    model: chat.model,
    chat: publicChat(history.chat),
    messages: history.messages.map(publicMessage),
    has_earlier: history.hasEarlier,
    read_only: history.readOnly,
    read_only_reason: history.readOnlyReason ?? null,
  });
}

function mutationStatus(code: "not_found" | "disabled" | "busy" | "read_only"): number {
  if (code === "not_found") return 404;
  if (code === "disabled") return 503;
  return 409;
}

async function apiCreateKnowledgeChat(
  ctx: KnowledgeRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): Promise<void> {
  const username = requireUsername(identity, reply);
  if (!username) return;
  const chat = chatService(ctx);
  if (!chat) {
    json(reply, 503, { error: "知识 Chat 未接线" });
    return;
  }
  const body = (req.body ?? {}) as { subject_id?: unknown; message?: unknown; request_id?: unknown };
  const message = String(body.message ?? "").trim();
  const requestId = String(body.request_id ?? "").trim();
  if (!message || !requestId) {
    json(reply, 400, { error: "首条消息与 request_id 必填" });
    return;
  }
  const result = await chat.create({
    username,
    subjectId: typeof body.subject_id === "string" ? body.subject_id.trim() || null : null,
    message,
    requestId,
  });
  if (!result.ok) {
    json(reply, mutationStatus(result.code), { error: result.error, code: result.code });
    return;
  }
  void result.turn;
  json(reply, 200, { ok: true, duplicate: result.duplicate, chat: publicChat(result.chat), running: Boolean(result.chat.running_since) });
}

async function apiSendKnowledgeChat(
  ctx: KnowledgeRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): Promise<void> {
  const username = requireUsername(identity, reply);
  if (!username) return;
  const chat = chatService(ctx);
  if (!chat) {
    json(reply, 503, { error: "知识 Chat 未接线" });
    return;
  }
  const body = (req.body ?? {}) as { chat_id?: unknown; message?: unknown; request_id?: unknown };
  const message = String(body.message ?? "").trim();
  const requestId = String(body.request_id ?? "").trim();
  const chatId = String(body.chat_id ?? "").trim();
  if (!chatId || !message || !requestId) {
    json(reply, 400, { error: "chat_id、消息与 request_id 必填" });
    return;
  }
  const result = await chat.send({ username, chatId, message, requestId });
  if (!result.ok) {
    json(reply, mutationStatus(result.code), { error: result.error, code: result.code });
    return;
  }
  void result.turn;
  json(reply, 200, {
    ok: true,
    duplicate: result.duplicate,
    chat: publicChat(result.chat),
    running: Boolean(result.chat.running_since),
  });
}
