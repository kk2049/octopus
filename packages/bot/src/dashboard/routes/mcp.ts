/**
 * The MCP surface (endpoint + token lifecycle) and the trusted approval face
 * for pending capability calls.
 *
 * Mechanically relocated out of `server.ts` (2026-08-11 domain split): same
 * paths, same `authz.ts` rule ids, same status codes and messages.
 */

import { createLogger } from "../../logger.js";
import { MCP_SUBJECT_ID } from "../../mcp/catalog.js";
import { handleMcpRpc } from "../../mcp/http.js";
import { MCP_REQUEST_MAX_BYTES } from "../../mcp/tools.js";
import {
  MCP_TOKEN_TTL_DAYS_MAX,
  decodeMcpTokenPolicy,
  mcpCredentialOf,
  mcpRegistration,
  mcpTokenPolicy,
  mintMcpToken,
} from "../../mcp/tokens.js";
import { type PanelReply, type PanelRequest, bodyOf, replyJson as json } from "../http.js";
import type {
  DashboardApprovalPort,
  DashboardFeishuOauthPort,
  DashboardMcpPort,
  DashboardOperationPort,
  DashboardPermissionPort,
  DashboardSessionHubPort,
  DashboardStorePort,
  DashboardTentaclePort,
} from "../ports.js";
import { PANEL_BODY_SCHEMAS } from "../schemas.js";
import type { DashboardIdentity, DashboardRouteOptions } from "../server.js";
import type { GuardedRoutes } from "./context.js";

const log = createLogger("dashboard");

export interface McpRoutesContext {
  store: DashboardStorePort;
  approvals: DashboardApprovalPort;
  mcp: DashboardMcpPort;
  hub: DashboardSessionHubPort;
  operations: DashboardOperationPort;
  permissions: DashboardPermissionPort;
  opts: Pick<DashboardRouteOptions, "publicUrl">;
  feishuOAuth?: DashboardFeishuOauthPort;
  tentacle: DashboardTentaclePort | null;
  boundPort: number;
  targetAccount(req: PanelRequest, identity: DashboardIdentity): string;
  requireUser(res: PanelReply, identity: DashboardIdentity, username: string): boolean;
  canWriteAs(identity: DashboardIdentity, username: string): boolean;
  /** Approving takes a real browser session; writes the refusal itself. */
  requireApprover(res: PanelReply, identity: DashboardIdentity): string | null;
}

export function registerMcpRoutes(routes: GuardedRoutes, ctx: McpRoutesContext): void {
  // One JSON-RPC message per request, as large as the Runner's local bridge
  // carries one (the declared MCP request window). The gate has already run in
  // `onRequest`, so only an authenticated caller's body is ever buffered.
  routes.any("/api/mcp", "api.mcp.rpc", (req, reply, identity) => apiMcpRpc(ctx, req, reply, identity),
    { bodyLimit: MCP_REQUEST_MAX_BYTES });
  routes.get("/api/mcp/tokens", "api.mcp.tokens.list", (req, reply, identity) =>
    apiMcpTokenList(ctx, req, reply, identity),
  );
  routes.post("/api/mcp/tokens/create", "api.mcp.tokens.create", PANEL_BODY_SCHEMAS.mcpTokenCreate, (req, reply, identity) =>
    apiMcpTokenCreate(ctx, req, reply, identity),
  );
  routes.post("/api/mcp/tokens/revoke", "api.mcp.tokens.revoke", PANEL_BODY_SCHEMAS.mcpTokenRevoke, (req, reply, identity) =>
    apiMcpTokenRevoke(ctx, req, reply, identity),
  );
  routes.get("/api/feishu/oauth/status", "api.feishu.oauth.status", (req, reply, identity) =>
    apiFeishuOAuthStatus(ctx, req, reply, identity),
  );
  routes.post("/api/feishu/oauth/start", "api.feishu.oauth.start", PANEL_BODY_SCHEMAS.feishuOAuth, (req, reply, identity) =>
    apiFeishuOAuthStart(ctx, req, reply, identity),
  );

  // ── Trusted approval face (doc/tcb-reading-guide.md §3 批准; packages/capability-kernel/CLAUDE.md) ──
  routes.get("/api/capabilities/pending", "api.capabilities.pending", (_req, reply, identity) => {
    // `Identify` on self — the gate refused an unnamed credential already.
    const owner = identity.username!;
    const notice = ctx.feishuOAuth?.notice(owner);
    json(reply, 200, {
      username: owner,
      pending: ctx.approvals.listPending(owner),
      notices: notice ? [notice] : [],
    });
  });
  // A wildcard rather than `/:id/:decision`, so a malformed id keeps meeting
  // the SAME refusal it always did: the `Approve` policy first (a bearer may
  // never approve), and only then "no such thing".
  routes.post("/api/capabilities/pending/*", "api.capabilities.decide", undefined, (req, reply, identity) =>
    apiDecidePending(ctx, req, reply, identity),
  );
}

function apiFeishuOAuthStatus(
  ctx: McpRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const owner = ctx.targetAccount(req, identity);
  if (!ctx.requireUser(reply, identity, owner)) return;
  if (!ctx.feishuOAuth) {
    json(reply, 200, { available: false, state: "unavailable" });
    return;
  }
  json(reply, 200, { available: true, ...ctx.feishuOAuth.status(owner) });
}

async function apiFeishuOAuthStart(
  ctx: McpRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): Promise<void> {
  const owner = String(bodyOf(req).username ?? identity.username ?? "");
  if (!ctx.canWriteAs(identity, owner)) {
    json(reply, 403, { error: "飞书授权只能由本人发起 — 请用自己的 /dashboard 链接登录" });
    return;
  }
  if (!ctx.feishuOAuth) {
    json(reply, 503, { error: "当前部署没有配置飞书用户授权" });
    return;
  }
  try {
    json(reply, 200, { available: true, ...(await ctx.feishuOAuth.start(owner, bodyOf(req).force === true)) });
  } catch (error) {
    log.warn({ owner, err: error }, "Feishu device OAuth could not start");
    json(reply, 503, { error: "飞书授权暂时无法启动，请稍后重试" });
  }
}

/** The id of the pending call in `POST /api/capabilities/pending/<id>/<verb>`. */
const PENDING_DECISION = /^([A-Za-z0-9_-]{1,80})\/(approve|reject)$/;

// ── MCP surface ──

/**
 * The MCP endpoint. One POSTed JSON-RPC message in, one JSON answer out —
 * the streamable-http subset a stateless server is allowed to be. GET is a
 * deliberate 405 (no server-push stream is offered), matching the spec's
 * option for servers that do not open SSE streams.
 */
async function apiMcpRpc(ctx: McpRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  const owner = identity.username!;
  if (req.method === "DELETE") {
    if (!identity.mcpPolicy?.sessionExecution && !identity.mcpPolicy?.ticketDevelopment) {
      json(reply, 403, { error: "只有内部会话或工单凭证可以结束自身作用域" });
      return;
    }
    ctx.mcp.releaseCredential(owner, identity.credential);
    void reply.code(204).send();
    return;
  }
  if (req.method !== "POST") {
    void reply.header("allow", "POST, DELETE");
    json(reply, 405, { error: "MCP 端点只接受 POST 的 JSON-RPC 消息" });
    return;
  }
  // `Identify`/self admitted only named principals; a browser session or a
  // personal dt_ bearer may drive the endpoint too (same trust class or
  // stronger than the mcp_ token minted for exactly this).
  const out = await handleMcpRpc(bodyOf(req), ctx.mcp, {
    owner,
    credential: identity.credential,
    ...(identity.mcpPolicy ? { policy: identity.mcpPolicy } : {}),
  });
  if (out.body === undefined) {
    void reply.code(out.status).send();
    return;
  }
  json(reply, out.status, out.body);
}

function apiMcpTokenList(ctx: McpRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const owner = ctx.targetAccount(req, identity);
  if (!ctx.requireUser(reply, identity, owner)) return;
  const now = new Date().toISOString();
  json(reply, 200, {
    username: owner,
    tokens: ctx.store.listMcpTokens(owner).map((row) => ({
      token_hash: row.token_hash,
      label: row.label,
      created_at: row.created_at,
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
      revoked_at: row.revoked_at,
      active: !row.revoked_at && (!row.expires_at || row.expires_at > now),
      policy: (() => {
        try {
          return decodeMcpTokenPolicy(row.policy_json) ?? null;
        } catch {
          return { schema: "invalid", groups: [] };
        }
      })(),
    })),
    registration: mcpRegistration(ctx.opts.publicUrl, ctx.boundPort),
  });
}

function apiMcpTokenCreate(ctx: McpRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req);
  const owner = String(body.username ?? identity.username ?? "");
  if (!ctx.canWriteAs(identity, owner)) {
    json(reply, 403, { error: "MCP 令牌只能由本人签发 — 请用自己的 /dashboard 链接登录" });
    return;
  }
  const ttlRaw = body.ttl_days === undefined || body.ttl_days === null ? undefined : Number(body.ttl_days);
  if (ttlRaw !== undefined && (!Number.isFinite(ttlRaw) || ttlRaw <= 0 || ttlRaw > MCP_TOKEN_TTL_DAYS_MAX)) {
    json(reply, 400, { error: `ttl_days 必须是 1..${MCP_TOKEN_TTL_DAYS_MAX} 的天数` });
    return;
  }
  let policy;
  try {
    policy = mcpTokenPolicy({
      groups: body.tool_groups,
      appIds: body.app_ids,
      appInstances: body.app_instances,
      appActions: body.app_actions,
    });
  } catch (error) {
    json(reply, 400, { error: error instanceof Error ? error.message : "MCP token policy 无效" });
    return;
  }
  const minted = mintMcpToken(ctx.store, {
    username: owner,
    label: String(body.label ?? ""),
    ttlDays: ttlRaw,
    policy,
  });
  ctx.permissions.audit({
    owner,
    subjectType: "service",
    subjectId: MCP_SUBJECT_ID,
    operation: "(mcp_token)",
    resource: minted.row.token_hash.slice(0, 16),
    decision: "grant",
    reason: `label=${minted.row.label || "(无标签)"}${minted.row.expires_at ? ` expires=${minted.row.expires_at}` : ""}`,
    detail: JSON.stringify({ by: identity.username ?? "admin-key" }),
  });
  log.info({ owner, by: identity.username, label: minted.row.label }, "MCP token minted");
  json(reply, 200, {
    ok: true,
    // The plaintext, exactly once. It is not stored and cannot be shown again.
    token: minted.token,
    token_hash: minted.row.token_hash,
    label: minted.row.label,
    created_at: minted.row.created_at,
    expires_at: minted.row.expires_at,
    policy,
    registration: mcpRegistration(ctx.opts.publicUrl, ctx.boundPort),
  });
}

function apiMcpTokenRevoke(ctx: McpRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req);
  const owner = String(body.username ?? identity.username ?? "");
  if (!ctx.canWriteAs(identity, owner)) {
    json(reply, 403, { error: "MCP 令牌只能由本人撤销 — 请用自己的 /dashboard 链接登录" });
    return;
  }
  const tokenHash = String(body.token_hash ?? "").trim();
  if (!tokenHash) {
    json(reply, 400, { error: "token_hash is required" });
    return;
  }
  // The row first — from this line the credential no longer resolves — then
  // everything that one token opened: its workspace/document scopes, and its
  // pooled hub Contexts with their undecided approval cards and leases.
  const changed = ctx.store.revokeMcpToken(owner, tokenHash, new Date().toISOString());
  if (changed) {
    ctx.mcp.releaseCredential(owner, mcpCredentialOf(tokenHash));
    ctx.tentacle?.credentialRevoked(owner, tokenHash);
  }
  ctx.permissions.audit({
    owner,
    subjectType: "service",
    subjectId: MCP_SUBJECT_ID,
    operation: "(mcp_token)",
    resource: tokenHash.slice(0, 16),
    decision: "revoke",
    reason: changed ? null : "already_revoked_or_unknown",
    detail: JSON.stringify({ by: identity.username ?? "admin-key" }),
  });
  log.info({ owner, by: identity.username, changed }, "MCP token revoked");
  json(reply, 200, { ok: true, changed });
}

/**
 * Approve or reject one pending capability call.
 *
 * The body is not read at all: there is nothing in a request that may
 * influence WHAT gets executed. Everything the call consists of was frozen
 * when the PendingCall was created, and the URL carries only its id.
 */
async function apiDecidePending(ctx: McpRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  const approver = ctx.requireApprover(reply, identity);
  if (!approver) return;
  const m = PENDING_DECISION.exec(String((req.params as { "*"?: string })["*"] ?? ""));
  if (!m) {
    json(reply, 404, { error: "not found" });
    return;
  }
  const [, pendingId, verb] = m;
  if (verb === "reject") {
    const ok = ctx.approvals.reject(pendingId, approver);
    // Decided either way, the session is free again: the lease exists to cover
    // the gap between "card created" and "card decided", and this is the far
    // end of that gap.
    if (ok) ctx.hub.releasePendingLease(pendingId);
    // A rejection is a decision about the SUBMISSION, not only about the
    // card — the chat that asked has to learn it was refused.
    const rejected = ok ? ctx.operations.rejectAsOperation(pendingId, approver) : null;
    ctx.permissions.audit({
      owner: approver,
      subjectType: "service",
      subjectId: "session-hub",
      operation: "(approval)",
      decision: "reject",
      reason: pendingId,
    });
    json(
      reply,
      ok ? 200 : 404,
      ok
        ? { ok: true, ...(rejected ? { operation_id: rejected.id, operation: rejected } : {}) }
        : { error: "该待批准请求不存在或已处理" },
    );
    return;
  }
  // A session submission's approval starts execution in the BACKGROUND and
  // answers immediately with the record to follow. Holding this request open
  // for the whole CLI run is the same mistake the composer stopped making: a
  // network connection carrying a lifecycle. Every other kind of pending call
  // keeps the awaited behaviour — there is nothing else to report progress to.
  const asOperation = ctx.operations.approveAsOperation(pendingId, approver);
  if (asOperation) {
    ctx.permissions.audit({
      owner: approver,
      subjectType: "service",
      subjectId: "session-hub",
      operation: "(approval)",
      decision: "approve",
      reason: pendingId,
    });
    log.info({ approver, pendingId, operation: asOperation.id }, "Session operation approved");
    json(reply, 202, { ok: true, operation_id: asOperation.id, operation: asOperation });
    return;
  }
  const out = await ctx.approvals.approve(pendingId, approver);
  ctx.hub.releasePendingLease(pendingId);
  ctx.permissions.audit({
    owner: approver,
    subjectType: "service",
    subjectId: "session-hub",
    operation: "(approval)",
    decision: out.status === "succeeded" ? "approve" : "error",
    reason: out.status,
  });
  log.info({ approver, pendingId, status: out.status }, "Capability approval decided");
  if (out.status === "succeeded") {
    json(reply, 200, { ok: true, result: out.result });
    return;
  }
  // `unknown` is its own answer: the call left the process and we cannot say
  // whether it ran. Never auto-retry it.
  const status = out.status === "denied" ? 403 : out.status === "unknown" ? 504 : 502;
  const reason = out.status === "approval_required" ? "该请求仍在等待批准" : out.reason;
  json(reply, status, { ok: false, outcome: out.status, error: reason });
}
