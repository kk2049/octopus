import { runnerCapabilityView } from "../../runner/capability-view.js";
import { normalizeRunnerDisplayName, runnerDisplayName, runnerDisplayNameKey } from "../../runner/display-name.js";
import { parseRunnerOnlineNoticeChannel, runnerOnlineNotice, runnerOnlineNoticeKey } from "../../runner/online-notice.js";
/**
 * The ops overview: the `/` page, device health checks and runner-token
 * lifecycle.
 *
 * Mechanically relocated out of `server.ts` (2026-08-11 domain split): same
 * paths, same `authz.ts` rule ids, same status codes and messages.
 */

import { createLogger } from "../../logger.js";
import { RUNNER_LOCAL_AGENT_BRIDGE_MODES, type RunnerLocalAgentBridgeMode } from "../../store/store.js";
import { type PanelReply, type PanelRequest, bodyOf, replyJson as json } from "../http.js";
import type { DashboardRunnerPort, DashboardStorePort } from "../ports.js";
import { resolveTutorialHost, buildRunnerCommands, TOKEN_PLACEHOLDER } from "../runner-commands.js";
import { buildUnixInstallCommand, buildWindowsInstalledCommand } from "../runner-commands.js";
import { issueRunnerEnrollment } from "../../runner/enrollment.js";
import { PANEL_BODY_SCHEMAS } from "../schemas.js";
import { DASHBOARD_THEME_SETTING, dashboardThemeId } from "../theme-preference.js";
import type { DashboardIdentity, DashboardRouteOptions, DeviceCheck } from "../server.js";
import type { GuardedRoutes, PageRenderer } from "./context.js";
import { viewerOf } from "./shared.js";

const log = createLogger("dashboard");

export interface OverviewRoutesContext extends PageRenderer {
  store: DashboardStorePort;
  caps: DashboardRunnerPort | undefined;
  opts: Pick<DashboardRouteOptions, "publicHost" | "publicUrl" | "runnerWsPort" | "runnerPublicUrl">;
  /** What the OS actually bound, for the tutorial commands. */
  boundPort: number;
  canActFor(identity: DashboardIdentity, username: string): boolean;
  canWriteAs(identity: DashboardIdentity, username: string): boolean;
  /** Close everything one account derived, after a device revocation. */
  endOwner(owner: string): void;
}

export function registerOverviewRoutes(routes: GuardedRoutes, ctx: OverviewRoutesContext): void {
  routes.get("/api/overview", "api.overview", (_req, reply, identity) => {
    json(reply, 200, overview(ctx, identity));
  });
  routes.post("/api/check", "api.check", PANEL_BODY_SCHEMAS.check, (req, reply, identity) =>
    apiCheck(ctx, req, reply, identity),
  );
  routes.post("/api/check-all", "api.checkAll", undefined, (_req, reply, identity) =>
    apiCheckAll(ctx, reply, identity),
  );
  routes.post(
    "/api/theme-preference",
    "api.themePreference",
    PANEL_BODY_SCHEMAS.themePreference,
    (req, reply, identity) => apiThemePreference(ctx, req, reply, identity),
  );
  routes.post("/api/runner-token", "api.runnerToken", PANEL_BODY_SCHEMAS.runnerToken, (req, reply, identity) =>
    apiRunnerToken(ctx, req, reply, identity),
  );
  routes.post("/api/runner-display-name", "api.runnerDisplayName", PANEL_BODY_SCHEMAS.runnerDisplayName, (req, reply, identity) =>
    apiRunnerDisplayName(ctx, req, reply, identity),
  );
  routes.post("/api/runner-online-notice", "api.runnerOnlineNotice", PANEL_BODY_SCHEMAS.runnerOnlineNotice, (req, reply, identity) =>
    apiRunnerOnlineNotice(ctx, req, reply, identity),
  );
  routes.post("/api/runner-delete", "api.runnerDelete", PANEL_BODY_SCHEMAS.runnerDelete, (req, reply, identity) =>
    apiRunnerDelete(ctx, req, reply, identity),
  );
  routes.post(
    "/api/runner-local-agent-bridge",
    "api.runnerLocalAgentBridge",
    PANEL_BODY_SCHEMAS.runnerLocalAgentBridge,
    (req, reply, identity) => apiRunnerLocalAgentBridge(ctx, req, reply, identity),
  );
  routes.post(
    "/api/runner-default-agent-injection",
    "api.runnerDefaultAgentInjection",
    PANEL_BODY_SCHEMAS.runnerDefaultAgentInjection,
    (req, reply, identity) => apiRunnerDefaultAgentInjection(ctx, req, reply, identity),
  );
  routes.post(
    "/api/runner-gui-automation",
    "api.runnerGuiAutomation",
    PANEL_BODY_SCHEMAS.runnerGuiAutomation,
    (req, reply, identity) => apiRunnerGuiAutomation(ctx, req, reply, identity),
  );
}

// ── Page handlers that need more than a title ──

export function pageOverview(ctx: OverviewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  // The tutorial commands are composed here because only the server knows the
  // bot's real outside address, and because the quoting has to be right once
  // rather than at every place that renders them.
  const { host, guessed } = resolveTutorialHost(
    ctx.opts.publicHost,
    (req.headers.host ?? "").replace(/:\d+$/, ""),
  );
  ctx.appPage(reply, 200, {
    title: "octopus · 总览",
    identity,
    page: "page.overview",
    props: {
      tutorialHost: host,
      hostIsGuess: guessed,
      tokenPlaceholder: TOKEN_PLACEHOLDER,
      commands: buildRunnerCommands({
        host,
        dashboardPort: ctx.boundPort,
        wsPort: ctx.opts.runnerWsPort ?? 9910,
        runnerPublicUrl: ctx.opts.runnerPublicUrl,
        publicUrl: ctx.opts.publicUrl,
        token: TOKEN_PLACEHOLDER,
        device: "<设备名>",
      }),
    },
  });
}

async function apiCheck(ctx: OverviewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  const body = bodyOf(req);
  const username = String(body.username ?? "");
  const device = String(body.device ?? "");
  if (!username || !device) {
    json(reply, 400, { error: "username and device are required" });
    return;
  }
  if (!ctx.canActFor(identity, username)) {
    json(reply, 403, { error: "forbidden" });
    return;
  }
  json(reply, 200, await checkOne(ctx, username, device));
}

async function apiCheckAll(ctx: OverviewRoutesContext, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  const all = ctx.store.listAllRunnerTokens();
  const tokens = identity.admin ? all : all.filter((t) => t.username === identity.username);
  const results = await Promise.all(tokens.map((t) => checkOne(ctx, t.username, t.device)));
  json(reply, 200, { checked: results.length, results });
}

function apiThemePreference(
  ctx: OverviewRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  // The authz rule is Identify/self and the body carries no username. Repeat
  // that narrowing here so a future direct caller cannot turn a presentation
  // preference into an account-selector endpoint.
  const username = identity.username;
  if (!username) {
    json(reply, 403, { error: "主题偏好仅限具名账号修改" });
    return;
  }
  const theme = dashboardThemeId(bodyOf(req).theme);
  if (!theme) {
    json(reply, 400, { error: "unknown dashboard theme" });
    return;
  }
  ctx.store.setSetting(username, DASHBOARD_THEME_SETTING, theme);
  log.info({ username, theme }, "Dashboard theme preference update");
  json(reply, 200, { ok: true, theme });
}

function apiRunnerToken(ctx: OverviewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req);
  const username = String(body.username ?? "");
  const device = String(body.device ?? "").trim().slice(0, 32);
  // Old dashboard bundles did not send platform and expect the legacy response
  // containing a token. New bundles explicitly opt into an installed-service
  // enrollment shape, so a rolling deploy cannot break an already-open tab.
  const platform = body.platform === "unix" || body.platform === "windows-installed"
    ? body.platform
    : "windows";
  // 403 before 404: the reverse order let a personal key tell existing
  // usernames from absent ones by the status code.
  if (!ctx.canActFor(identity, username)) {
    json(reply, 403, { error: "forbidden" });
    return;
  }
  if (!username || !ctx.store.getUser(username)) {
    json(reply, 404, { error: `unknown user: ${username}` });
    return;
  }
  if (!device) {
    json(reply, 400, { error: "device is required" });
    return;
  }
  // Re-minting invalidates the previous token: kick its socket and drop the
  // account authority in the same breath.
  if (!ctx.caps) {
    json(reply, 503, { error: "capability service 未启用,无法签发端点令牌" });
    return;
  }
  const { host } = resolveTutorialHost(ctx.opts.publicHost, (req.headers.host ?? "").replace(/:\d+$/, ""));
  const dashboardUrl = ctx.opts.publicUrl?.replace(/\/$/, "") || `http://${host}:${ctx.boundPort}`;
  if (platform !== "windows") {
    const enrollment = issueRunnerEnrollment(ctx.store, username, device);
    const installCommand = platform === "windows-installed"
      ? buildWindowsInstalledCommand(dashboardUrl, enrollment.code)
      : buildUnixInstallCommand(dashboardUrl, enrollment.code);
    log.info({ username, device, platform }, "Dashboard issued runner enrollment");
    json(reply, 200, {
      ok: true,
      username,
      device,
      enrollment_code: enrollment.code,
      expires_at: enrollment.expires_at,
      install_cmd: installCommand,
    });
    return;
  }
  // This branch exists only for a rolling upgrade: old dashboard bundles sent
  // `windows` (or omitted platform) and expect the durable-token response.
  const token = ctx.caps.mintDeviceToken(username, device);
  const cmds = buildRunnerCommands({
    host,
    dashboardPort: ctx.boundPort,
    wsPort: ctx.opts.runnerWsPort ?? 9910,
    runnerPublicUrl: ctx.opts.runnerPublicUrl,
    publicUrl: ctx.opts.publicUrl,
    token,
    device,
  });
  log.info({ username, device }, "Dashboard minted Windows runner token");
  json(reply, 200, {
    ok: true,
    username,
    device,
    token,
    download_cmd: cmds.download,
    run_cmd: cmds.runOneline,
    windows_install_cmd: cmds.windowsInstall,
  });
}

function apiRunnerDelete(ctx: OverviewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req);
  const username = String(body.username ?? "");
  const device = String(body.device ?? "");
  if (!username || !device) {
    json(reply, 400, { error: "username and device are required" });
    return;
  }
  if (!ctx.canActFor(identity, username)) {
    json(reply, 403, { error: "forbidden" });
    return;
  }
  // Revocation must land on the row, the live connection AND the authority: an
  // Object's target set is "this owner's authenticated connections", so
  // leaving any of the three up would leave the device inside the set it was
  // just removed from. One call does all three, and with no capability service
  // there is no way to do the other two — so refuse rather than half-revoke.
  if (!ctx.caps) {
    json(reply, 503, { error: "capability service 未启用,无法吊销端点令牌" });
    return;
  }
  const kicked = ctx.caps.isOnline(username);
  const existed = ctx.caps.revokeDeviceToken(username, device);
  // The account root is gone, so nothing derived from it can authorise another
  // frame. What is left is the state that does not ask the kernel on its own
  // schedule: open streams (which would keep polling a dead Context and keep
  // LOOKING connected), leases claiming a session is being driven, and this
  // account's bot-host Contexts — a separate root, so `revokeDeviceToken` does
  // not touch it. Closing that too is deliberately conservative: it is the
  // same owner, and a page re-derives on its next request.
  ctx.endOwner(username);
  log.info({ username, device, existed, kicked }, "Dashboard deleted runner device");
  json(reply, 200, { ok: true, existed, kicked });
}

function apiRunnerLocalAgentBridge(
  ctx: OverviewRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const body = bodyOf(req);
  const username = String(body.username ?? "");
  const device = String(body.device ?? "").trim();
  const mode = String(body.mode ?? "") as RunnerLocalAgentBridgeMode;
  if (!identity.session || !ctx.canWriteAs(identity, username)) {
    json(reply, 403, { error: "Runner 发起权限仅限本人在浏览器中修改" });
    return;
  }
  if (!device || !(RUNNER_LOCAL_AGENT_BRIDGE_MODES as readonly string[]).includes(mode)) {
    json(reply, 400, { error: "device and a valid mode are required" });
    return;
  }
  const changed = ctx.store.setRunnerLocalAgentBridgeMode(
    username,
    device,
    mode,
    new Date().toISOString(),
    identity.username ?? username,
  );
  if (!changed) {
    json(reply, 404, { error: "runner device not found" });
    return;
  }
  log.info({ username, device, mode }, "Dashboard changed Runner local agent bridge policy");
  json(reply, 200, { ok: true, username, device, mode });
}

function apiRunnerDefaultAgentInjection(
  ctx: OverviewRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const body = bodyOf(req);
  const username = String(body.username ?? "");
  const device = String(body.device ?? "").trim();
  const enabled = body.enabled;
  if (!identity.session || !ctx.canWriteAs(identity, username)) {
    json(reply, 403, { error: "Runner 默认注入仅限本人在浏览器中修改" });
    return;
  }
  if (!device || typeof enabled !== "boolean") {
    json(reply, 400, { error: "device and enabled are required" });
    return;
  }
  const changed = ctx.store.setRunnerDefaultAgentInjection(
    username,
    device,
    enabled,
    new Date().toISOString(),
    identity.username ?? username,
  );
  if (!changed) {
    json(reply, 404, { error: "runner device not found" });
    return;
  }
  const onlineApplied = ctx.caps?.setDefaultAgentInjection(username, device, enabled) ?? false;
  log.info(
    { username, device, enabled, onlineApplied },
    "Dashboard changed Runner default Agent injection policy",
  );
  json(reply, 200, { ok: true, username, device, enabled, online_applied: onlineApplied });
}

function apiRunnerGuiAutomation(
  ctx: OverviewRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const body = bodyOf(req);
  const username = String(body.username ?? "");
  const device = String(body.device ?? "").trim();
  const enabled = body.enabled;
  if (!identity.session || !ctx.canWriteAs(identity, username)) {
    json(reply, 403, { error: "Runner GUI 自动化仅限本人在浏览器中修改" });
    return;
  }
  if (!device || typeof enabled !== "boolean") {
    json(reply, 400, { error: "device and enabled are required" });
    return;
  }
  if (!ctx.caps) {
    json(reply, 404, { error: "runner capability service disabled" });
    return;
  }
  const result = ctx.caps.setGuiAutomationEnabled(
    username,
    device,
    enabled,
    new Date().toISOString(),
    identity.username ?? username,
  );
  if (!result.changed) {
    json(reply, result.code === "runner_not_found" ? 404 : 409, {
      error: result.code === "runner_not_found"
        ? "runner device not found"
        : "GUI automation is available only on an online macOS Runner with a logged-in graphical console",
    });
    return;
  }
  log.info(
    { username, device, enabled, onlineApplied: result.onlineApplied },
    "Dashboard changed Runner GUI automation exposure",
  );
  json(reply, 200, {
    ok: true,
    username,
    device,
    enabled,
    online_applied: result.onlineApplied ?? false,
  });
}

function apiRunnerDisplayName(ctx: OverviewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req), username = String(body.username ?? ""), device = String(body.device ?? "").trim();
  if (!ctx.canActFor(identity, username)) { json(reply, 403, { error: "forbidden" }); return; }
  const displayName = normalizeRunnerDisplayName(body.display_name);
  if (!username || !device || !displayName) { json(reply, 400, { error: "username, device and a non-empty display_name of at most 64 characters are required" }); return; }
  if (device.startsWith("dsh:") || !ctx.store.listRunnerTokens(username).some((row) => row.device === device)) {
    json(reply, 404, { error: "runner device not found" }); return;
  }
  ctx.store.setSetting(username, runnerDisplayNameKey(device), displayName);
  log.info({ username, device, by: identity.username ?? "admin-key" }, "Dashboard changed Runner display name");
  json(reply, 200, { ok: true, username, device, display_name: displayName });
}

/**
 * Owner preference: notify the owner when this device returns after being
 * away (runner/online-notice.ts). Like the display name it grants nothing and
 * only ever messages the owner, so an administrator may set it on their behalf.
 */
function apiRunnerOnlineNotice(ctx: OverviewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const body = bodyOf(req), username = String(body.username ?? ""), device = String(body.device ?? "").trim();
  if (!ctx.canActFor(identity, username)) { json(reply, 403, { error: "forbidden" }); return; }
  const channel = body.channel === "off" ? "off" : parseRunnerOnlineNoticeChannel(body.channel);
  if (!username || !device || !channel) { json(reply, 400, { error: "username, device and channel (feishu or off) are required" }); return; }
  if (device.startsWith("dsh:") || !ctx.store.listRunnerTokens(username).some((row) => row.device === device)) {
    json(reply, 404, { error: "runner device not found" }); return;
  }
  ctx.store.setSetting(username, runnerOnlineNoticeKey(device), channel);
  log.info({ username, device, channel, by: identity.username ?? "admin-key" }, "Dashboard changed Runner online notice");
  json(reply, 200, { ok: true, username, device, online_notice: channel === "off" ? null : channel });
}

// ── Data assembly ──

function overview(ctx: OverviewRoutesContext, identity: DashboardIdentity) {
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const activity = ctx.store.listUserActivity(since).filter((a) => ctx.canActFor(identity, a.username));
  const users = activity.map((a) => ({
    username: a.username,
    display_name: ctx.store.getSetting(a.username, "display_name") || a.username,
    created_at: a.created_at,
    last_round_at: a.last_round_at,
    rounds_7d: a.recent_rounds,
    runners: (ctx.caps
      ? ctx.caps.listDevices(a.username)
      : ctx.store.listRunnerTokens(a.username).map((r) => ({
          inventory: undefined,
          device: r.device,
          online: false,
          created_at: r.created_at,
          last_seen_at: r.last_seen_at,
        }))).map((runner) => {
          const displayName = runnerDisplayName(ctx.store, a.username, runner.device);
          const onlineNotice = runnerOnlineNotice(ctx.store, a.username, runner.device);
          return {
            ...runner,
            capability_view: runnerCapabilityView(runner.inventory),
            // Schemas are carried once, in the capability view, rather than
            // duplicating up to 256 KiB per device in every overview response.
            ...(runner.inventory ? { inventory: { ...runner.inventory,
              ...(runner.inventory.capabilities ? { capabilities: { protocol: runner.inventory.capabilities.protocol } } : {}),
            } } : {}),
            ...(displayName ? { display_name: displayName } : {}),
            ...(onlineNotice ? { online_notice: onlineNotice } : {}),
            local_agent_bridge_mode:
              ctx.store.getRunnerDevicePolicy(a.username, runner.device)?.local_agent_bridge_mode ?? "disabled",
            default_agent_injection:
              ctx.store.getRunnerDevicePolicy(a.username, runner.device)?.default_agent_injection === 1,
            gui_automation_enabled:
              ctx.store.getRunnerDevicePolicy(a.username, runner.device)?.gui_automation_enabled === 1,
          };
        }),
  }));
  return {
    generated_at: new Date().toISOString(),
    viewer: viewerOf(identity),
    gateway_enabled: Boolean(ctx.caps),
    runner_ws_port: ctx.opts.runnerWsPort ?? 9910,
    runner_public_url: ctx.opts.runnerPublicUrl ?? "",
    public_host: ctx.opts.publicHost ?? "",
    users,
  };
}

/**
 * Device health. Presence and round-trip only — it used to run
 * `list_recent_sessions` and report a session count, which meant pressing
 * "check" on someone else's device performed a read of their data with no
 * capability behind it. A user who wants to know what their own device can
 * see opens the session list, which does go through their read slot.
 */
async function checkOne(ctx: OverviewRoutesContext, username: string, device: string): Promise<DeviceCheck> {
  if (!ctx.caps) {
    return { username, device, online: false, error: "runner capability service disabled" };
  }
  const known = ctx.store.listRunnerTokens(username).some((t) => t.device === device);
  if (!known) {
    return { username, device, online: false, error: "device not registered" };
  }
  const rtt = await ctx.caps.ping(username, device);
  if (rtt === null) return { username, device, online: false };
  return { username, device, online: true, rtt_ms: rtt };
}
