/**
 * `/api/admin*` — onboarding and capability hand-out (tickets #15, #18).
 *
 * Mechanically relocated out of `server.ts` (2026-08-11 domain split): same
 * paths, same `authz.ts` rule ids, same status codes and messages. No admin
 * check in any handler: `/api/admin*` is `Administer` in the route table and
 * the gate ran before dispatch — a second copy of the rule is how the two
 * drift apart.
 */

import { createLogger } from "../../logger.js";
import { mintDashboardToken, rotateDashboardToken } from "../dashboard-token.js";
import { type PanelReply, type PanelRequest, bodyOf, panelUrl, replyJson as json } from "../http.js";
import type { DashboardPermissionPort, DashboardStorePort } from "../ports.js";
import { PANEL_BODY_SCHEMAS } from "../schemas.js";
import type { Capabilities, DashboardIdentity, DashboardRouteOptions } from "../server.js";
import type { GuardedRoutes } from "./context.js";
import { webCredential } from "./shared.js";

const log = createLogger("dashboard");

export interface AdminRoutesContext {
  store: DashboardStorePort;
  opts: Pick<DashboardRouteOptions, "feishuDirectory" | "registerUser">;
  /** Live lookup: a grant revoked at /admin takes effect on the next request. */
  capabilitiesFor(username: string): Capabilities;
  /** One browser login is over: close the Contexts, cards, streams and leases it opened. */
  endCredential(owner: string, credential: string): void;
  /** The account's own activity record, so the person sees who ended their logins. */
  permissions: Pick<DashboardPermissionPort, "audit">;
}

export function registerAdminRoutes(routes: GuardedRoutes, ctx: AdminRoutesContext): void {
  routes.get("/api/admin/users", "api.admin", (_req, reply) => adminUsers(ctx, reply));
  routes.get("/api/admin/feishu-directory", "api.admin", (req, reply) => adminFeishuDirectory(ctx, req, reply));
  routes.post("/api/admin/feishu-import", "api.admin", PANEL_BODY_SCHEMAS.adminFeishuImport, (req, reply, identity) =>
    adminFeishuImport(ctx, req, reply, identity),
  );
  routes.post("/api/admin/feishu-lookup", "api.admin", undefined, (req, reply) => adminFeishuLookup(ctx, req, reply));
  routes.post("/api/admin/rename", "api.admin", PANEL_BODY_SCHEMAS.adminRename, (req, reply, identity) =>
    adminRename(ctx, req, reply, identity),
  );
  routes.post("/api/admin/grant", "api.admin", PANEL_BODY_SCHEMAS.adminGrant, (req, reply, identity) =>
    adminGrant(ctx, req, reply, identity),
  );
  routes.post("/api/admin/local-user", "api.admin", PANEL_BODY_SCHEMAS.adminLocalUser, (req, reply, identity) =>
    adminLocalUser(ctx, req, reply, identity),
  );
  routes.post(
    "/api/admin/dashboard-token",
    "api.admin",
    PANEL_BODY_SCHEMAS.adminDashboardToken,
    (req, reply, identity) => adminDashboardToken(ctx, req, reply, identity),
  );
  routes.post(
    "/api/admin/web-sessions/revoke",
    "api.admin",
    PANEL_BODY_SCHEMAS.adminDashboardToken,
    (req, reply, identity) => adminRevokeWebSessions(ctx, req, reply, identity),
  );
}

/**
 * Capabilities handed out at /admin. Admin implies all; `deploy` implies `dev`
 * implies `contribute`, each one way (permissions/capability-bits.ts).
 */
export const CAPABILITIES = ["contribute", "dev", "deploy"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The identity provider a local (no Feishu, no GitHub) account is created under. */
export const LOCAL_IDENTITY_PROVIDER = "local";

// ── /admin: hand out capabilities (ticket #15) ──

/** Display names are account data stored in user_settings. */
function displayNameFor(ctx: AdminRoutesContext, username: string): string {
  return ctx.store.getSetting(username, "display_name") || username;
}

// ── /admin: onboarding and capabilities ──
//
// No admin check in any of these: `/api/admin*` is `Administer` in the route
// table and the gate ran before dispatch. A second copy of the rule is how
// the two drift apart.

function adminUsers(ctx: AdminRoutesContext, res: PanelReply): void {
  const grants = ctx.store.listAllUserGrants();
  const users = ctx.store.loadUsers().map((u) => {
    const mine = grants.filter((g) => g.username === u.username);
    const caps = ctx.capabilitiesFor(u.username);
    return {
      username: u.username,
      display_name: displayNameFor(ctx, u.username),
      admin: caps.admin,
      dev: caps.dev,
      deploy: caps.deploy,
      contribute: Boolean(caps.contribute),
      grants: Object.fromEntries(mine.map((g) => [g.capability, g])),
    };
  });
  json(res, 200, { users, capabilities: CAPABILITIES });
}

async function adminFeishuDirectory(ctx: AdminRoutesContext, req: PanelRequest, res: PanelReply): Promise<void> {
  // Cross-user tenant data — admin-only by construction (this handler is
  // gated above). Absent directory means Feishu isn't wired; say so with
  // a shape the page can render, not a bare 404.
  if (!ctx.opts.feishuDirectory) {
    json(res, 200, { chats: [], error: "未配置飞书 app_id/app_secret", built_at: null, bindings: {} });
    return;
  }
  if (panelUrl(req).searchParams.get("refresh") === "1") ctx.opts.feishuDirectory.invalidate();
  const dir = await ctx.opts.feishuDirectory.get();
  // Annotate each open_id with its bound octopus username (if any) + display
  // name — one map keeps the page's render loop O(members) instead of
  // O(members × users) client-side.
  const bindings: Record<string, { username: string; display_name: string }> = {};
  const users = ctx.store.loadUsers();
  for (const u of users) {
    for (const id of ctx.store.getIdentitiesByUser(u.username)) {
      if (id.provider === "feishu") {
        bindings[id.external_id] = {
          username: u.username,
          display_name: displayNameFor(ctx, u.username),
        };
      }
    }
  }
  json(res, 200, { ...dir, bindings });
}

async function adminFeishuImport(ctx: AdminRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): Promise<void> {
  if (!ctx.opts.registerUser) {
    json(res, 500, { error: "未装配用户注册入口" });
    return;
  }
  const body = bodyOf(req);
  const openId = String(body.open_id ?? "").trim();
  const username = String(body.username ?? "").trim().toLowerCase();
  const displayName = String(body.display_name ?? "").trim();
  if (!openId.startsWith("ou_")) {
    json(res, 400, { error: "open_id 必须以 ou_ 开头" });
    return;
  }
  const bound = ctx.store.resolveIdentity("feishu", openId);
  if (bound) {
    json(res, 409, { error: `该飞书用户已绑定到 ${bound}`, bound });
    return;
  }
  try {
    // UserManager validates the username shape / reserved list; let its
    // error message reach the page verbatim (it's already the user-facing copy).
    const user = await ctx.opts.registerUser(username, { provider: "feishu", externalId: openId });
    if (displayName) ctx.store.setSetting(user.username, "display_name", displayName);
    ctx.opts.feishuDirectory?.invalidate();
    log.info({ username, openId, displayName, by: identity.username ?? "admin-key" }, "Admin onboarded a Feishu user");
    json(res, 200, { ok: true, username: user.username, display_name: displayName || user.username });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
}

/**
 * Renaming the PK is out of scope (fk cascades through sessions, rounds,
 * bindings, workspaces, grants, tickets, hq_chats, …). This endpoint sets the
 * display_name setting the whole app already reads through `displayName()` —
 * enough to answer "make X show up as Y".
 */
function adminRename(ctx: AdminRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req);
  const username = String(body.username ?? "").trim();
  const displayName = String(body.display_name ?? "").trim().slice(0, 120);
  if (!ctx.store.getUser(username)) {
    json(res, 404, { error: `unknown user: ${username}` });
    return;
  }
  if (!displayName) {
    json(res, 400, { error: "display_name 不能为空" });
    return;
  }
  ctx.store.setSetting(username, "display_name", displayName);
  ctx.opts.feishuDirectory?.invalidate();
  log.info({ username, displayName, by: identity.username ?? "admin-key" }, "Admin renamed display_name");
  json(res, 200, { ok: true, username, display_name: displayName });
}

/**
 * Point-add for people who aren't in any chat with the bot yet (ticket #18
 * follow-up). Reuses the `contact:user.base:readonly` scope already used for
 * name enrichment — no new app permission required.
 */
async function adminFeishuLookup(ctx: AdminRoutesContext, req: PanelRequest, res: PanelReply): Promise<void> {
  if (!ctx.opts.feishuDirectory) {
    json(res, 200, { hits: [], missing: [], error: "未配置飞书 app_id/app_secret" });
    return;
  }
  const body = bodyOf(req);
  const splitList = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map((x) => String(x));
    if (typeof v === "string") return v.split(/[\s,;，、；]+/);
    return [];
  };
  const mobiles = splitList(body.mobiles).map((s) => s.trim()).filter(Boolean);
  const emails = splitList(body.emails).map((s) => s.trim()).filter(Boolean);
  if (mobiles.length === 0 && emails.length === 0) {
    json(res, 400, { error: "请填写手机号或邮箱(可用逗号/空格分隔多个)" });
    return;
  }
  const r = await ctx.opts.feishuDirectory.lookup({ mobiles, emails });
  // Annotate hits with existing bindings so the page can show badges
  // just like the chat-member rows do.
  const bindings: Record<string, { username: string; display_name: string }> = {};
  for (const h of r.hits) {
    const bound = ctx.store.resolveIdentity("feishu", h.open_id);
    if (bound) {
      bindings[h.open_id] = {
        username: bound,
        display_name: displayNameFor(ctx, bound),
      };
    }
  }
  json(res, 200, { ...r, bindings });
}

/**
 * Create an account that has no external identity at all (2026-08-20).
 *
 * Before this the only onboarding door was the Feishu import, and it validated
 * nothing but the `ou_` prefix — so a person without Feishu got a fabricated
 * open_id. A local account says what it is: the identity row is
 * `local:<username>`, and the only way in is the personal key minted here and
 * shown once in the response. The admin hands it over out of band; the account
 * starts with zero capabilities, exactly like every other new account.
 */
async function adminLocalUser(ctx: AdminRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): Promise<void> {
  if (!ctx.opts.registerUser) {
    json(res, 500, { error: "未装配用户注册入口" });
    return;
  }
  const body = bodyOf(req);
  const username = String(body.username ?? "").trim().toLowerCase();
  const displayName = String(body.display_name ?? "").trim().slice(0, 120);
  if (!username) {
    json(res, 400, { error: "username 必填" });
    return;
  }
  if (ctx.store.getUser(username)) {
    json(res, 409, { error: `用户名 "${username}" 已被使用` });
    return;
  }
  try {
    const user = await ctx.opts.registerUser(username, {
      provider: LOCAL_IDENTITY_PROVIDER,
      externalId: username,
      label: displayName || undefined,
    });
    if (displayName) ctx.store.setSetting(user.username, "display_name", displayName);
    const token = mintDashboardToken(ctx.store, user.username);
    log.info({ username: user.username, by: identity.username ?? "admin-key" }, "Admin created a local account");
    json(res, 200, { ok: true, username: user.username, display_name: displayName || user.username, token });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
}

/**
 * Mint (= rotate) one account's personal web-login key.
 *
 * The plaintext is in this response and nowhere else. Rotation is the whole
 * operation: the previous key stops working the moment the new row is written,
 * and so does every browser session that key (or an earlier one) bought —
 * otherwise a leaked key's logins would outlive the rotation by up to 14 days.
 * An administrator rotating their OWN key keeps the session they are reading
 * the new key in.
 */
function adminDashboardToken(ctx: AdminRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req);
  const username = String(body.username ?? "").trim();
  if (!ctx.store.getUser(username)) {
    json(res, 404, { error: `unknown user: ${username}` });
    return;
  }
  const keep = identity.username === username ? identity.session?.tokenHash : undefined;
  const { token, endedSessions } = rotateDashboardToken(ctx.store, username, keep);
  const by = identity.username ?? "admin-key";
  endWebSessions(ctx, username, endedSessions, "rotate_login_key", by);
  log.info({ username, by, endedSessions: endedSessions.length }, "Admin minted a dashboard login key");
  json(res, 200, { ok: true, username, token, ended_sessions: endedSessions.length });
}

/**
 * End every browser login of one account (B12): the incident response for a
 * leaked session or key that does not wait for the 14-day absolute expiry.
 * The administrator's own current session is spared, exactly like the
 * account's own "log out everywhere else" — ending it would log the person out
 * mid-click.
 */
function adminRevokeWebSessions(ctx: AdminRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): void {
  const username = String(bodyOf(req).username ?? "").trim();
  if (!ctx.store.getUser(username)) {
    json(res, 404, { error: `unknown user: ${username}` });
    return;
  }
  const keep = identity.username === username ? identity.session?.tokenHash : undefined;
  const doomed = ctx.store
    .listWebSessions(username)
    .filter((row) => !row.revoked_at && row.token_hash !== keep)
    .map((row) => row.token_hash);
  const revoked = ctx.store.revokeAllWebSessions(username, new Date().toISOString(), keep);
  const by = identity.username ?? "admin-key";
  endWebSessions(ctx, username, doomed, "admin_logout_all", by);
  log.info({ username, revoked, by }, "Admin ended an account's web sessions");
  json(res, 200, { ok: true, username, revoked });
}

/** Rows are already revoked; close what each login opened and say who did it. */
function endWebSessions(ctx: AdminRoutesContext, owner: string, hashes: readonly string[], operation: string, by: string): void {
  for (const hash of hashes) ctx.endCredential(owner, webCredential(hash));
  ctx.permissions.audit({
    owner,
    subjectType: "service",
    subjectId: "web-session",
    operation,
    decision: "revoke",
    reason: `${hashes.length} sessions`,
    detail: JSON.stringify({ by }),
  });
}

function adminGrant(ctx: AdminRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req);
  const username = String(body.username ?? "");
  const capability = String(body.capability ?? "");
  const value = body.value === true || body.value === "true";
  if (!CAPABILITIES.includes(capability as Capability)) {
    json(res, 400, { error: `unknown capability: ${capability}` });
    return;
  }
  if (!ctx.store.getUser(username)) {
    json(res, 404, { error: `unknown user: ${username}` });
    return;
  }
  // Admin-ness comes from config, so a grant can never widen someone past
  // what the operator wrote there — and revoking one from an admin is a
  // no-op rather than a lie (their rights do not come from this table).
  const by = identity.username ?? "admin-key";
  if (value) ctx.store.grantCapability(username, capability, by, new Date().toISOString());
  else ctx.store.revokeCapability(username, capability);
  log.info({ username, capability, value, by }, "Dashboard capability grant");
  json(res, 200, { ok: true, username, capability, value, effective: ctx.capabilitiesFor(username) });
}
