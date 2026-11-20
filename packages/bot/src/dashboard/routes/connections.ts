/**
 * External identity connection management.
 *
 * These are guarded routes: the binder supplies identity/CSRF/Cedar before a
 * handler runs. The browser receives a process-salted handle for each row, not
 * the provider's external id. That handle selects a row only inside the
 * authenticated owner's current list; it grants no authority by itself.
 */

import { createLogger } from "../../logger.js";
import { type PanelReply, type PanelRequest, bodyOf, replyJson as json } from "../http.js";
import type { DashboardStorePort } from "../ports.js";
import { PANEL_BODY_SCHEMAS } from "../schemas.js";
import type { DashboardIdentity } from "../server.js";
import type { GuardedRoutes } from "./context.js";

const log = createLogger("dashboard");

export interface ConnectionRoutesContext {
  store: DashboardStorePort;
  requireUser(reply: PanelReply, identity: DashboardIdentity, username: string): boolean;
  targetAccount(req: PanelRequest, identity: DashboardIdentity): string;
  canManageConnection(identity: DashboardIdentity, username: string): boolean;
  githubConnectionAvailable(): boolean;
  startGithubConnection(username: string): { authorizeUrl: string; stateCookie: string } | null;
  connectionHandle(provider: string, externalId: string): string;
  /** Null means this composition has no identity manager; false means no row matched. */
  removeIdentity(username: string, provider: string, externalId: string): boolean | null;
}
export function registerConnectionRoutes(routes: GuardedRoutes, ctx: ConnectionRoutesContext): void {
  routes.get("/api/connections", "api.connections.list", (req, reply, identity) =>
    apiConnectionList(ctx, req, reply, identity),
  );
  routes.post(
    "/api/connections/github/start",
    "api.connections.github.start",
    PANEL_BODY_SCHEMAS.githubConnectionStart,
    (req, reply, identity) => apiGithubConnectionStart(ctx, req, reply, identity),
  );
  routes.post(
    "/api/connections/unbind",
    "api.connections.unbind",
    PANEL_BODY_SCHEMAS.connectionUnbind,
    (req, reply, identity) => apiConnectionUnbind(ctx, req, reply, identity),
  );
}

function apiConnectionList(
  ctx: ConnectionRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const owner = ctx.targetAccount(req, identity);
  if (!ctx.requireUser(reply, identity, owner)) return;
  const connections = ctx.store.getIdentitiesByUser(owner).map((row) => ({
    connection_id: ctx.connectionHandle(row.provider, row.external_id),
    provider: row.provider,
    label: row.label,
    created_at: row.created_at,
  }));
  json(reply, 200, {
    username: owner,
    github_available: ctx.githubConnectionAvailable(),
    connections,
  });
}

function apiGithubConnectionStart(
  ctx: ConnectionRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const owner = String(bodyOf(req).username ?? identity.username ?? "");
  // The pre-body gate asked ManageConnection against the caller's own account.
  // Re-ask ManageConnection at body scope against the parsed target account.
  if (!ctx.canManageConnection(identity, owner)) {
    json(reply, 403, { error: "GitHub 绑定只能由本人发起 — 请用自己的浏览器会话登录" });
    return;
  }
  const attempt = ctx.startGithubConnection(owner);
  if (!attempt) {
    json(reply, 503, { error: "当前部署没有启用 GitHub OAuth" });
    return;
  }
  void reply.header("set-cookie", attempt.stateCookie);
  json(reply, 200, { authorize_url: attempt.authorizeUrl });
}

function apiConnectionUnbind(
  ctx: ConnectionRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const body = bodyOf(req);
  const owner = String(body.username ?? identity.username ?? "");
  if (!ctx.canManageConnection(identity, owner)) {
    json(reply, 403, { error: "身份解绑只能由本人决定 — 请用自己的浏览器会话登录" });
    return;
  }
  const handle = String(body.connection_id ?? "");
  const identities = ctx.store.getIdentitiesByUser(owner);
  const selected = identities.find(
    (row) => ctx.connectionHandle(row.provider, row.external_id) === handle,
  );
  if (!selected) {
    json(reply, 404, { error: "没有这个身份连接" });
    return;
  }

  // A live web session is not a recovery credential: it expires. The account
  // must retain another durable identity or an independently minted dt_ key.
  if (identities.length - 1 < 1 && !ctx.store.hasDashboardToken(owner)) {
    json(reply, 409, { error: "不能解绑最后一个登录身份：请先绑定另一身份或签发个人登录密钥" });
    return;
  }
  const removed = ctx.removeIdentity(owner, selected.provider, selected.external_id);
  if (removed === null) {
    json(reply, 503, { error: "当前部署没有身份管理服务" });
    return;
  }
  if (!removed) {
    json(reply, 404, { error: "没有这个身份连接" });
    return;
  }
  log.info({ owner, provider: selected.provider }, "Dashboard identity connection removed");
  json(reply, 200, { ok: true, provider: selected.provider });
}
