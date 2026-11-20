/**
 * The permission centre: subjects/grants projection, devices, web sessions,
 * audit trail, grant and revoke.
 *
 * Mechanically relocated out of `server.ts` (2026-08-11 domain split): same
 * paths, same `authz.ts` rule ids, same status codes and messages.
 */

import { createLogger } from "../../logger.js";
import { SESSION_HUB_SUBJECT } from "../../permissions/catalog.js";
import { TENTACLE_SUBJECT_ID } from "../../tentacle/contract.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_PUBLISHER,
  sessionPlusContractCovering,
} from "../../session-resource/contract.js";
import type { SessionPlusSettings } from "../../app-core/settings.js";
import { type PanelReply, type PanelRequest, bodyOf, panelUrl, replyJson as json } from "../http.js";
import type {
  DashboardPermissionPort,
  DashboardPermissionStudioPort,
  DashboardRunnerPort,
  DashboardStorePort,
} from "../ports.js";
import { PANEL_BODY_SCHEMAS } from "../schemas.js";
import type { DashboardIdentity, DashboardRouteOptions } from "../server.js";
import type { GuardedRoutes } from "./context.js";
import { clampInt, webCredential, webSessionHandle } from "./shared.js";

const log = createLogger("dashboard");

export interface PermissionRoutesContext {
  store: DashboardStorePort;
  caps: DashboardRunnerPort | undefined;
  permissions: DashboardPermissionPort;
  permissionStudio: DashboardPermissionStudioPort;
  opts: Pick<DashboardRouteOptions, "devPipeline">;
  requireUser(res: PanelReply, identity: DashboardIdentity, username: string): boolean;
  targetAccount(req: PanelRequest, identity: DashboardIdentity): string;
  canWriteAs(identity: DashboardIdentity, username: string): boolean;
  /** One browser login (or device token) is over: close everything it opened. */
  endCredential(owner: string, credential: string): void;
  /** The Session Plus settings for whichever release is active RIGHT NOW. */
  sessionPlusSettings(): SessionPlusSettings | null;
}

export function registerPermissionRoutes(routes: GuardedRoutes, ctx: PermissionRoutesContext): void {
  routes.get("/api/permissions/studio", "api.permissions.studio", (req, reply, identity) => {
    const owner = ctx.targetAccount(req, identity);
    if (!ctx.requireUser(reply, identity, owner)) return;
    json(reply, 200, ctx.permissionStudio.projection(owner, ctx.canWriteAs(identity, owner)));
  });
  routes.post(
    "/api/permissions/studio/explain",
    "api.permissions.studio.explain",
    PANEL_BODY_SCHEMAS.permissionStudioExplain,
    (req, reply, identity) => apiPermissionStudioExplain(ctx, req, reply, identity),
  );
  routes.post(
    "/api/permissions/studio/apply",
    "api.permissions.studio.apply",
    PANEL_BODY_SCHEMAS.permissionStudioApply,
    (req, reply, identity) => apiPermissionStudioApply(ctx, req, reply, identity),
  );
  routes.get("/api/permissions", "api.permissions.list", (req, reply, identity) => {
    const owner = ctx.targetAccount(req, identity);
    if (!ctx.requireUser(reply, identity, owner)) return;
    json(reply, 200, permissionsView(ctx, owner));
  });
  routes.get("/api/permissions/devices", "api.permissions.devices", (req, reply, identity) =>
    apiPermissionDevices(ctx, req, reply, identity),
  );
  routes.get("/api/permissions/web-sessions", "api.permissions.websessions", (req, reply, identity) =>
    apiWebSessions(ctx, req, reply, identity),
  );
  routes.post(
    "/api/permissions/web-sessions/revoke",
    "api.permissions.websessions.revokeOne",
    PANEL_BODY_SCHEMAS.webSessionRevoke,
    (req, reply, identity) => apiWebSessionRevoke(ctx, req, reply, identity),
  );
  routes.post(
    "/api/permissions/web-sessions/revoke-others",
    "api.permissions.websessions.revokeOthers",
    PANEL_BODY_SCHEMAS.webSessionRevokeOthers,
    (req, reply, identity) => apiWebSessionRevokeOthers(ctx, req, reply, identity),
  );
  routes.get("/api/permissions/audit", "api.permissions.audit", (req, reply, identity) =>
    apiPermissionAudit(ctx, req, reply, identity),
  );
  routes.post("/api/permissions/grant", "api.permissions.grant", PANEL_BODY_SCHEMAS.permissionsGrant, (req, reply, identity) =>
    apiPermissionGrant(ctx, req, reply, identity),
  );
  routes.post("/api/permissions/revoke", "api.permissions.revoke", PANEL_BODY_SCHEMAS.permissionsRevoke, (req, reply, identity) =>
    apiPermissionRevoke(ctx, req, reply, identity),
  );
}

function apiPermissionStudioExplain(
  ctx: PermissionRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const body = bodyOf(req);
  const owner = String(body.username ?? identity.username ?? "");
  if (!ctx.canWriteAs(identity, owner)) {
    json(reply, 403, { error: "权限变更只能由本人预演 — 请用自己的 /dashboard 链接登录" });
    return;
  }
  const rawMode = body.proposed_mode;
  const proposedMode = rawMode === undefined
    ? undefined
    : rawMode === "deny" || rawMode === "ask" || rawMode === "allow"
      ? rawMode
      : null;
  if (proposedMode === null) {
    json(reply, 400, { error: "proposed_mode 必须是 deny、ask 或 allow" });
    return;
  }
  try {
    json(reply, 200, ctx.permissionStudio.explain({
      owner,
      actor: identity.username!,
      resourceId: String(body.resource_id ?? ""),
      holderId: String(body.holder_id ?? ""),
      operation: String(body.operation ?? ""),
      ...(proposedMode === undefined ? {} : { proposedMode }),
    }));
  } catch (error) {
    json(reply, 400, { error: error instanceof Error ? error.message : "无法解释这条许可" });
  }
}

function apiPermissionStudioApply(
  ctx: PermissionRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const body = bodyOf(req);
  const owner = String(body.username ?? identity.username ?? "");
  if (!ctx.canWriteAs(identity, owner)) {
    json(reply, 403, { error: "权限变更只能由本人应用 — 请用自己的 /dashboard 链接登录" });
    return;
  }
  json(reply, 200, ctx.permissionStudio.apply(owner, identity.username!, String(body.proposal_id ?? "")));
}

/**
 * The permission centre's whole payload for one account: every subject with
 * its requested / granted / effective columns and reasons.
 *
 * Assembled server-side, including the effective column — the browser must
 * not reach a security conclusion, and a client that computed "effective"
 * from "granted" would be wrong every time a device was revoked.
 */
function permissionsView(ctx: PermissionRoutesContext, owner: string) {
  const devFactoryEnabled = Boolean(ctx.opts.devPipeline);
  return {
    username: owner,
    subjects: ctx.permissions.subjects(owner, { devFactoryEnabled })
      // Resource-scoped dsh grants have their own owner/viewer/Object face.
      // A wildcard card here would imply an account-wide grant that cannot
      // exist and would hide the identity binding that makes the share safe.
      .filter((s) => !(s.type === "service" && s.id === TENTACLE_SUBJECT_ID))
      .map((s) => {
      const isHub = s.type === "service" && s.id === SESSION_HUB_SUBJECT.id;
      const isSessionPlus = s.type === "app" && s.id === SESSION_PLUS_APP_ID;
      const requested = ctx.permissions.declaredOperations(s.type, s.id, owner);
      // Compute the projection FIRST: for the hub that call is also what
      // writes the bootstrap row, and reading the grant before it would show
      // "尚未授权" on the very first page load of every account.
      const permissions = isHub
        ? ctx.permissions.sessionHubEffective(owner)
        : isSessionPlus
          ? ctx.permissions.sessionPlusEffective(
              owner,
              ctx.sessionPlusSettings()?.identity.permissionContractDigest ?? null,
            )
          : ctx.permissions.effectiveFor({
              subjectType: s.type,
              subjectId: s.id,
              owner,
              requested,
            });
      const grant = ctx.permissions.get(s.type, s.id, owner);
      const entry = ctx.permissions.subject(s.type, s.id);
      return {
        ...s,
        editable: Boolean(entry?.userManaged && grant?.source !== "config"),
        grant: grant
          ? {
              source: grant.source,
              status: grant.status,
              createdAt: grant.createdAt,
              createdBy: grant.createdBy,
              expiresAt: grant.expiresAt,
            }
          : null,
        permissions,
      };
      }),
  };
}

// ── Permission centre ──

function apiPermissionDevices(ctx: PermissionRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const owner = ctx.targetAccount(req, identity);
  if (!ctx.requireUser(reply, identity, owner)) return;
  // Presence and registration facts only — never a Runner RPC, so looking at
  // this list is not a read of anybody's data.
  const live = new Map((ctx.caps?.listDevices(owner) ?? []).map((d) => [d.device, d]));
  json(reply, 200, {
    username: owner,
    devices: ctx.store.listRunnerTokens(owner).filter((r) => !r.device.startsWith("dsh:")).map((r) => ({
      device: r.device,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      online: Boolean(live.get(r.device)?.online),
    })),
  });
}

function apiWebSessions(ctx: PermissionRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const owner = ctx.targetAccount(req, identity);
  if (!ctx.requireUser(reply, identity, owner)) return;
  // Never the token hash: it is the credential's shadow, and a list of "where
  // am I logged in" needs no part of it. `current` is computed by comparing
  // hashes server-side.
  const currentHash = identity.session?.tokenHash;
  const now = Date.now();
  json(reply, 200, {
    username: owner,
    sessions: ctx.store.listWebSessions(owner).map((s) => ({
      // A one-way handle so "end THIS login" is possible without the row's
      // token hash ever leaving the process. Hashing again rather than
      // truncating: a prefix of a secret is still part of a secret.
      sid: webSessionHandle(s.token_hash),
      created_at: s.created_at,
      last_seen_at: s.last_seen_at,
      absolute_expiry: s.absolute_expiry,
      active: !s.revoked_at && Date.parse(s.absolute_expiry) > now,
      current: Boolean(currentHash) && s.token_hash === currentHash,
    })),
  });
}

function apiWebSessionRevoke(ctx: PermissionRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req);
  const owner = String(body.username ?? identity.username ?? "");
  if (!ctx.canWriteAs(identity, owner)) {
    json(reply, 403, { error: "只能结束自己的登录会话" });
    return;
  }
  const sid = String(body.sid ?? "");
  // Resolve the handle inside THIS owner's rows. A handle from somebody else's
  // session simply does not match anything here — the lookup is scoped before
  // it is performed, rather than being checked afterwards.
  const row = ctx.store.listWebSessions(owner).find((s) => webSessionHandle(s.token_hash) === sid);
  if (!row) {
    json(reply, 404, { error: "没有这个登录会话" });
    return;
  }
  ctx.store.revokeWebSession(row.token_hash, new Date().toISOString());
  ctx.endCredential(owner, webCredential(row.token_hash));
  ctx.permissions.audit({
    owner,
    subjectType: "service",
    subjectId: "web-session",
    operation: "logout_one",
    decision: "revoke",
    reason: sid,
    detail: JSON.stringify({ by: identity.username ?? "admin-key" }),
  });
  log.info({ owner, sid, by: identity.username }, "Web session revoked");
  json(reply, 200, { ok: true, current: row.token_hash === identity.session?.tokenHash });
}

function apiWebSessionRevokeOthers(ctx: PermissionRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req);
  const owner = String(body.username ?? identity.username ?? "");
  if (!ctx.canWriteAs(identity, owner)) {
    json(reply, 403, { error: "只能结束自己的登录会话" });
    return;
  }
  // "Everywhere else", not "everywhere": ending the session that is asking
  // would log the user out mid-click and make the result unreadable. The
  // current one is ended by /logout, which is its own explicit act.
  //
  // The doomed rows are listed BEFORE they are revoked, because after the
  // UPDATE there is no way to tell which ones this call ended — and each of
  // them owns Contexts, approval cards, streams and leases that have to be
  // torn down by handle.
  const current = identity.session?.tokenHash;
  const doomed = ctx.store
    .listWebSessions(owner)
    .filter((s) => !s.revoked_at && s.token_hash !== current)
    .map((s) => s.token_hash);
  const revoked = ctx.store.revokeAllWebSessions(owner, new Date().toISOString(), current);
  for (const hash of doomed) ctx.endCredential(owner, webCredential(hash));
  ctx.permissions.audit({
    owner,
    subjectType: "service",
    subjectId: "web-session",
    operation: "logout_others",
    decision: "revoke",
    reason: `${revoked} sessions`,
    detail: JSON.stringify({ by: identity.username ?? "admin-key" }),
  });
  log.info({ owner, revoked, by: identity.username }, "Web sessions revoked (others)");
  json(reply, 200, { ok: true, revoked });
}

/**
 * One newest-first page of the account's permission activity. `limit` is the
 * page window; `before` (the previous page's `next_before`) walks to the
 * oldest retained record, so the history itself has no read ceiling.
 */
function apiPermissionAudit(ctx: PermissionRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const p = panelUrl(req).searchParams;
  const owner = p.get("username") || identity.username || "";
  if (!ctx.requireUser(reply, identity, owner)) return;
  const rawBefore = p.get("before");
  const before = rawBefore === null || rawBefore === "" ? undefined : Number(rawBefore);
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
    json(reply, 400, { error: "before 必须是上一页返回的正整数 next_before" });
    return;
  }
  const limit = clampInt(p.get("limit"), 1, 500, 100);
  const rows = ctx.permissions.activity(owner, {
    subjectId: p.get("subject") || undefined,
    operation: p.get("operation") || undefined,
    decision: p.get("decision") || undefined,
    limit: limit + 1,
    ...(before !== undefined ? { beforeId: before } : {}),
  });
  const records = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  json(reply, 200, {
    username: owner,
    records,
    has_more: hasMore,
    ...(hasMore ? { next_before: records[records.length - 1]!.id } : {}),
  });
}

function apiPermissionGrant(ctx: PermissionRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req);
  const owner = String(body.username ?? identity.username ?? "");
  // Owner-only. An admin may READ across accounts; deciding what may act on
  // somebody's laptop is not an observation.
  if (!ctx.canWriteAs(identity, owner)) {
    json(reply, 403, { error: "授权只能由本人决定 — 请用自己的 /dashboard 链接登录" });
    return;
  }
  const subjectId = String(body.subject_id ?? "");
  const subjectType = String(body.subject_type ?? "service");
  if (subjectType !== "service" && subjectType !== "app" && subjectType !== "agent") {
    json(reply, 400, { error: "unknown subject_type" });
    return;
  }
  const subject = ctx.permissions.subject(subjectType, subjectId);
  if (!subject?.info.enforced) {
    json(reply, 400, { error: "这个 subject 没有消费 grant 行的执行路径，拒绝创建装饰性授权" });
    return;
  }
  if (!subject.userManaged) {
    json(reply, 400, { error: "这条授权来自部署配置，只能修改配置并重启，当前页面只读" });
    return;
  }
  const existing = ctx.permissions.get(subjectType, subjectId, owner);
  if (existing?.source === "config") {
    json(reply, 400, { error: "这条授权来自部署配置，只能修改配置并重启，当前页面只读" });
    return;
  }
  if (subjectId === "dev-factory") {
    // Saying yes here would be a fiction: Dev Factory's authority does not
    // come from a grant, and a button that pretended otherwise is exactly what
    // the execution plan forbids.
    json(reply, 400, { error: "开发工厂是受信系统服务,它的权限不来自本页的授权,也不能在这里扩大" });
    return;
  }
  const requested = Array.isArray(body.operations) ? body.operations.map((x) => String(x)) : [];
  // Materialise the hub's bootstrap row before diffing against it. Without
  // this, the first save on a fresh account diffs against "nothing" and
  // reports no removals — so the screen would say "no change" while silently
  // taking permissions away.
  if (subjectId === SESSION_HUB_SUBJECT.id) ctx.permissions.sessionHubEffective(owner);
  if (subjectId === SESSION_PLUS_APP_ID) {
    ctx.permissions.sessionPlusEffective(
      owner,
      ctx.sessionPlusSettings()?.identity.permissionContractDigest ?? null,
    );
  }
  // A grant may only answer the ask that was actually shown. `declared` is the
  // running release's operation list, so an operation the active release never
  // requested cannot be consented to here — and the digest stamped on the row
  // is the one that COVERS what was granted, not whatever is newest.
  const declared = new Set(ctx.permissions.declaredOperations(subjectType, subjectId, owner));
  const allowed = requested.filter((operation) => declared.has(operation));
  const covering = subjectId === SESSION_PLUS_APP_ID
    ? sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, allowed)
    : null;
  const activeSessionPlusDigest = subjectId === SESSION_PLUS_APP_ID
    ? ctx.sessionPlusSettings()?.identity.permissionContractDigest ?? null
    : null;
  const out = ctx.permissions.grant({
    subjectType,
    subjectId,
    owner,
    operations: allowed,
    // The subject catalog and active immutable contract decide which granted
    // operations may run silently; scope ownership is enforced downstream by
    // the capability chain.
    autoAllow: allowed,
    source: "user",
    createdBy: identity.username!,
    ...(covering
      ? {
          contractDigest: activeSessionPlusDigest ?? covering.digest,
          publisher: SESSION_PLUS_PUBLISHER,
        }
      : {}),
  });
  log.info({ owner, by: identity.username, subjectId, added: out.diff.added, removed: out.diff.removed }, "Permission grant saved");
  json(reply, 200, { ok: true, diff: out.diff, permissions: permissionsView(ctx, owner) });
}

function apiPermissionRevoke(ctx: PermissionRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req);
  const owner = String(body.username ?? identity.username ?? "");
  if (!ctx.canWriteAs(identity, owner)) {
    json(reply, 403, { error: "撤销只能由本人决定 — 请用自己的 /dashboard 链接登录" });
    return;
  }
  const subjectType = String(body.subject_type ?? "service");
  if (subjectType !== "service" && subjectType !== "app" && subjectType !== "agent") {
    json(reply, 400, { error: "unknown subject_type" });
    return;
  }
  // Refused for the same reason granting is: with nothing enforcing an
  // App/Agent row, "撤销成功" would report a security change that did not
  // happen. The rows cannot exist anyway — which makes this a guard against
  // the two edits drifting apart, not a second decision.
  const subjectId = String(body.subject_id ?? "");
  const subject = ctx.permissions.subject(subjectType, subjectId);
  const existing = ctx.permissions.get(subjectType, subjectId, owner);
  if (!subject?.info.enforced) {
    json(reply, 400, { error: "这个 subject 没有消费 grant 行的执行路径，无法声称已经撤销" });
    return;
  }
  if (!subject.userManaged || existing?.source === "config") {
    json(reply, 400, { error: "这条授权来自部署配置，只能修改配置并重启，当前页面只读" });
    return;
  }
  const changed = ctx.permissions.revoke({
    subjectType,
    subjectId,
    owner,
    by: identity.username!,
  });
  log.info({ owner, subject: String(body.subject_id ?? ""), changed }, "Permission revoked");
  json(reply, 200, { ok: true, changed, permissions: permissionsView(ctx, owner) });
}
