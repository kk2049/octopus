/**
 * Session Plus — the compiled-in Agentic App probe: its page, trust door,
 * proposals, resource-generation lifecycle, close and projection stream.
 *
 * Mechanically relocated out of `server.ts` (2026-08-11 domain split): same
 * paths, same `authz.ts` rule ids, same status codes and messages.
 */

import type { AppReleaseDescriptor } from "@claude-bot/app-registry";
import { SESSION_ACTIONS, type SessionActionId } from "@claude-bot/agent-sessions-contract";
import { recordConvergenceUsage } from "@claude-bot/convergence-gates";
import type {
  SessionPlusAuthorizationProps,
  SessionPlusPerformanceReport,
} from "@claude-bot/dashboard-web/contract";
import type { ServerResponse } from "node:http";
import { createLogger } from "../../logger.js";
import type { AppReleaseIdentity } from "../../permissions/app-trust.js";
import { SESSION_PLUS_APP_ID } from "../../session-resource/contract.js";
import {
  checkoutLockfileHash,
  sessionPlusDescriptor,
  sessionPlusReleasePackage,
} from "../../app-core/identity.js";
import type { SessionPlusPrincipal } from "../../app-core/instance.js";
import { checkoutReleaseRecord, type SessionPlusReleaseRecord } from "../../app-core/release.js";
import type { SessionPlusSettings } from "../../app-core/settings.js";
import type { PackageAsset } from "../../app-core/view-app.js";
import { type PanelReply, type PanelRequest, bodyOf, panelUrl, replyBody as sendBody, replyJson as json } from "../http.js";
import type {
  DashboardAppTrustPort,
  DashboardPermissionPort,
  DashboardSessionPlusAppPort,
} from "../ports.js";
import { PANEL_BODY_SCHEMAS } from "../schemas.js";
import type { DashboardIdentity, DashboardRouteOptions } from "../server.js";
import {
  actOnHostedApp,
  closeHostedApp,
  decideAppTrust,
  hostedAppPrincipal,
  openHostedAppPage,
  streamHostedApp,
  wantsProjectionDelta,
} from "./app-view.js";
import type { GuardedRoutes, PageRenderer } from "./context.js";

const log = createLogger("dashboard");

export interface SessionPlusRoutesContext extends PageRenderer {
  permissions: DashboardPermissionPort;
  appTrust: DashboardAppTrustPort;
  opts: Pick<DashboardRouteOptions, "sessionPlusApp" | "sessionPlusRelease">;
  /** The Session Plus settings for whichever release is active RIGHT NOW. */
  sessionPlusSettings(): SessionPlusSettings | null;
  /** Per-server memoisation slot for this checkout's own release package. */
  sessionPlusCheckoutCache: {
    value?: { descriptor: AppReleaseDescriptor; assets: readonly PackageAsset[] } | null;
  };
  liveStreams: Map<ServerResponse, { owner: string; credential: string }>;
  eventStreams: Set<ServerResponse>;
}

export function registerSessionPlusRoutes(routes: GuardedRoutes, ctx: SessionPlusRoutesContext): void {
  const sharing = (reply: PanelReply) => { const service = ctx.opts.sessionPlusApp?.sharing; if (!service) json(reply, 503, { error: "共享服务未接入" }); return service; };
  routes.get("/api/session-shares/list", "api.sessionShares.list", (_req, reply, identity) => {
    const service = sharing(reply); if (!service || !identity.username) return;
    json(reply, 200, { shares: service.repository.list(identity.username).map((r) => ({ ...service.summary(r), issued: r.owner === identity.username })), requests: identity.guest ? [] : service.repository.requests(identity.username) });
  });
  routes.get("/api/session-shares/options", "api.sessionShares.options", (req, reply, identity) => {
    const principal = hostedAppPrincipal(reply, identity, SESSION_PLUS_PRESENCE_REFUSAL); if (!principal) return;
    try { if (identity.guest || principal.delegation) throw new Error("访客不能签发共享"); json(reply, 200, ctx.opts.sessionPlusApp!.shareOptions(sessionPlusHandle(req), principal)); }
    catch (error) { json(reply, 403, { error: error instanceof Error ? error.message : "无法分享" }); }
  });
  routes.post("/api/session-shares/create", "api.sessionShares.create", undefined, (req, reply, identity) => {
    const principal = hostedAppPrincipal(reply, identity, SESSION_PLUS_PRESENCE_REFUSAL); if (!principal) return;
    try { if (identity.guest || principal.delegation) throw new Error("访客不能签发共享"); const body = bodyOf(req); json(reply, 200, ctx.opts.sessionPlusApp!.createShare(sessionPlusHandle(req), principal, { resource: String(body.resource ?? ""), workspaces: body.workspaces, preset: body.preset === undefined ? undefined : String(body.preset), hours: body.hours === undefined ? undefined : Number(body.hours) })); }
    catch (error) { json(reply, 400, { error: error instanceof Error ? error.message : "无法分享" }); }
  });
  for (const action of ["request", "decide", "revoke", "reset"] as const) routes.post(`/api/session-shares/${action}`, `api.sessionShares.${action}`, undefined, (req, reply, identity) => {
    const service = sharing(reply); if (!service) return;
    if (!identity.username || !identity.session) { json(reply, 403, { error: "共享操作需要浏览器会话" }); return; }
    try {
      const body = bodyOf(req);
      if (action === "request") service.request(String(body.shareId ?? ""), identity.username, String(body.kind ?? ""));
      else if (action === "revoke") service.revoke(String(body.shareId ?? ""), identity.username);
      else if (action === "reset") service.resetMeter(String(body.shareId ?? ""), identity.username, identity.admin && !identity.guest);
      else { if (typeof body.approve !== "boolean") throw new Error("请明确批准或拒绝"); service.decide(identity.username, Number(body.requestId), body.approve, String(body.preset ?? "1"), Number(body.hours ?? 24)); }
      json(reply, 200, { ok: true });
    } catch (error) { json(reply, 400, { error: error instanceof Error ? error.message : "共享操作失败" }); }
  });

  routes.get("/api/session-plus/release", "api.sessionPlus.release", (req, reply, identity) =>
    apiSessionPlusRelease(ctx, req, reply, identity),
  );
  routes.post("/api/session-plus/trust", "api.sessionPlus.trust", PANEL_BODY_SCHEMAS.sessionPlusTrust, (req, reply, identity) =>
    apiSessionPlusTrust(ctx, req, reply, identity),
  );
  routes.post("/api/session-plus/act", "api.sessionPlus.act", PANEL_BODY_SCHEMAS.sessionPlusAct, (req, reply, identity) =>
    apiSessionPlusAct(ctx, req, reply, identity),
  );
  routes.post(
    "/api/session-plus/performance",
    "api.sessionPlus.performance",
    PANEL_BODY_SCHEMAS.sessionPlusPerformance,
    (req, reply, identity) => apiSessionPlusPerformance(ctx, req, reply, identity),
  );
  routes.post("/api/session-plus/reconstruct", "api.sessionPlus.reconstruct", undefined, (req, reply, identity) =>
    apiSessionPlusReconstruct(ctx, req, reply, identity),
  );
  routes.post("/api/session-plus/close", "api.sessionPlus.close", undefined, (req, reply, identity) =>
    apiSessionPlusClose(ctx, req, reply, identity),
  );
  routes.get("/api/session-plus/stream", "api.sessionPlus.stream", (req, reply, identity) =>
    apiSessionPlusStream(ctx, req, reply, identity),
  );
  routes.get("/api/session-plus/agent-activity", "api.sessionPlus.agentActivity", (req, reply, identity) => {
    const bound = sessionPlusBinding(ctx, req, reply, identity);
    if (!bound) return;
    const activity = bound.app.agentActivity(bound.handle, bound.principal);
    json(reply, activity === null ? 403 : 200, activity === null ? { error: "无法读取当前应用任务" } : { activity });
  });
  routes.post("/api/session-plus/agent-stop", "api.sessionPlus.agentStop", PANEL_BODY_SCHEMAS.appAgentStop, (req, reply, identity) => {
    const bound = sessionPlusBinding(ctx, req, reply, identity);
    if (!bound) return;
    const stopped = bound.app.stopAgentActivity(bound.handle, bound.principal, String(bodyOf(req).turnId ?? ""));
    json(reply, stopped ? 200 : 403, stopped ? { ok: true } : { error: "无法停止当前应用任务" });
  });

}

const SESSION_PLUS_INSTANCE_HEADER = "x-session-plus-instance";
const SESSION_PLUS_RESOURCE_GENERATION_HEADER = "x-session-plus-resource-generation";

const SESSION_UI_ACTION_ENTRIES: Readonly<Record<SessionActionId, string>> = Object.freeze({
  [SESSION_ACTIONS.refreshSessions]: "sessions.roster",
  [SESSION_ACTIONS.search]: "sessions.search",
  [SESSION_ACTIONS.readWindow]: "sessions.archive-read",
  [SESSION_ACTIONS.closeSession]: "sessions.archive-read",
  [SESSION_ACTIONS.listWorkspaces]: "sessions.directory-file",
  [SESSION_ACTIONS.start]: "sessions.new",
  [SESSION_ACTIONS.append]: "sessions.composer-send",
  [SESSION_ACTIONS.resume]: "sessions.composer-send",
  [SESSION_ACTIONS.takeover]: "sessions.takeover",
  [SESSION_ACTIONS.fallback]: "sessions.account-fallback",
  [SESSION_ACTIONS.interrupt]: "sessions.interrupt",
  [SESSION_ACTIONS.releaseControl]: "sessions.control-release",
  [SESSION_ACTIONS.respondInteraction]: "sessions.interaction",
  [SESSION_ACTIONS.pin]: "sessions.pin",
  [SESSION_ACTIONS.saveFolder]: "sessions.folders",
  [SESSION_ACTIONS.deleteFolder]: "sessions.folders",
  [SESSION_ACTIONS.fileSessions]: "sessions.folders",
  [SESSION_ACTIONS.setTitle]: "sessions.title",
  [SESSION_ACTIONS.readContinuation]: "sessions.continuation-settings",
  [SESSION_ACTIONS.saveContinuation]: "sessions.continuation-settings",
  [SESSION_ACTIONS.markReviewed]: "sessions.review",
  [SESSION_ACTIONS.setFileAnnotations]: "sessions.annotations",
  [SESSION_ACTIONS.attachFile]: "sessions.composer-attachment",
  [SESSION_ACTIONS.openTerminal]: "sessions.terminal-open",
  [SESSION_ACTIONS.readTerminal]: "sessions.terminal-refresh",
  [SESSION_ACTIONS.sendTerminal]: "sessions.terminal-input",
  [SESSION_ACTIONS.closeTerminal]: "sessions.terminal-close",
});

function observeSessionUi(owner: string, action: unknown, release: string): void {
  const entry = typeof action === "string" && Object.hasOwn(SESSION_UI_ACTION_ENTRIES, action)
    ? SESSION_UI_ACTION_ENTRIES[action as SessionActionId]
    : undefined;
  recordConvergenceUsage({
    candidate: "native-session-ui",
    principal: owner,
    entry: entry ?? "sessions.unknown-action",
    provider: "session-plus",
    release,
    effect: "execute",
    outcome: entry ? "observed" : "refused",
    ...(entry ? {} : { reason: "unknown_action" }),
  });
}

/**
 * This surface's sentence for the shared presence rule
 * (`hostedAppPrincipal`): instances exist only for a named, live browser
 * login — a raw bearer is useful for scripts, but it is not a browser tab
 * whose lifetime can own an isolated App instance.
 */
const SESSION_PLUS_PRESENCE_REFUSAL = "会话+ 只能在真实浏览器登录会话中使用";

function sessionPlusTrustIdentity(settings: SessionPlusSettings): AppReleaseIdentity {
  return {
    appId: settings.identity.stableAppId,
    publisher: settings.identity.publisher,
    profile: "publisher-js",
    packageDigest: settings.identity.packageDigest,
  };
}

/** Server-computed consent projection; it never authorises an operation. */
function sessionPlusAuthorization(ctx: SessionPlusRoutesContext, owner: string): SessionPlusAuthorizationProps {
  const entry = ctx.permissions.subject("app", SESSION_PLUS_APP_ID)!;
  // What the RUNNING release asks for, and the digest of that exact ask. Both
  // move together when an activation changes the release, which is what makes
  // "the contract changed, please re-consent" true rather than permanent.
  const activeDigest = ctx.sessionPlusSettings()?.identity.permissionContractDigest ?? null;
  const effective = ctx.permissions.sessionPlusEffective(owner, activeDigest);
  const grant = ctx.permissions.get("app", SESSION_PLUS_APP_ID, owner);
  return {
    source: grant?.source ?? null,
    editable: entry.userManaged && grant?.source !== "config",
    needsAuthorization: effective.needsAuthorization,
    contractChanged: Boolean(
      grant?.contractDigest
      && activeDigest
      && grant.contractDigest !== activeDigest
    ),
    publisherChanged: Boolean(
      grant?.publisher
      && entry.grantIdentity?.publisher
      && grant.publisher !== entry.grantIdentity.publisher
    ),
    entries: effective.entries.map((operation) => ({
      operation: operation.operation,
      title: operation.title,
      description: operation.description,
      granted: operation.granted,
      effective: operation.effective,
      alwaysApprove: operation.alwaysApprove,
      explanation: operation.explanation,
    })),
  };
}

export async function pageSessionsPlus(ctx: SessionPlusRoutesContext, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  // The route gate already refused this path when the feature is off, so
  // reaching here means the App is composed. Whether it currently has a usable
  // RELEASE is a separate question — an operator can deactivate one, and an
  // activation this build refuses leaves none — and the honest answer is 503
  // with the reason, not a page framing an origin nobody serves.
  const settings = ctx.sessionPlusSettings();
  if (!settings) {
    json(reply, 503, { error: sessionPlusUnavailableReason(ctx) });
    return;
  }
  const principal = hostedAppPrincipal(reply, identity, SESSION_PLUS_PRESENCE_REFUSAL);
  if (!principal) return;
  if (identity.actingAs) {
    // The account's own activity record says which administrator opened it.
    ctx.permissions.audit({
      owner: identity.actingAs,
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      operation: "(open_as)",
      decision: "admin_access",
      detail: JSON.stringify({ by: identity.username }),
    });
  }
  // Materialise the owner-local default grant before the App opens and derives
  // any capability. The authorization projection below reuses the same row.
  const authorization = sessionPlusAuthorization(ctx, principal.owner);
  const publicIdentity = {
    stableAppId: settings.identity.stableAppId,
    publisher: settings.identity.publisher,
    packageDigest: settings.identity.packageDigest,
    permissionContractDigest: settings.identity.permissionContractDigest,
    viewOrigin: settings.viewOrigin,
    ...(settings.viewUrl ? { viewUrl: settings.viewUrl } : {}),
    frameAncestors: [...settings.frameAncestors],
    development: Boolean(settings.development),
    contractOperations: [...settings.identity.contract.operations],
  };
  await openHostedAppPage({ appTrust: ctx.appTrust, appPage: ctx.appPage }, reply, identity, {
    principal,
    release: sessionPlusTrustIdentity(settings),
    viewOrigin: settings.viewOrigin,
    page: "page.sessionsPlus",
    consentTitle: "octopus · 信任会话+",
    appTitle: "octopus · 会话+",
    consentProps: (reason) => ({
      mode: "consent",
      identity: publicIdentity,
      reason,
      decision: null,
      release: sessionPlusReleaseRecord(ctx, settings),
    }),
    open: () => ctx.opts.sessionPlusApp!.open(principal),
    onOpenError: (err) => log.warn({ err, owner: principal.owner }, "Session Plus could not open an instance"),
    openErrorMessage: "会话+ 后端暂时不可用，请稍后刷新",
    // This surface alone carries the resource plane's chrome: the consent
    // projection, the ready timeout and the typed-resource generation the
    // parent hands its iframe.
    appProps: (instance, trustReason) => ({
      mode: "app",
      ...(principal.delegation ? { shareId: principal.delegation.shareId } : {}),
      ...(identity.actingAs ? { actingAs: identity.actingAs } : {}),
      identity: publicIdentity,
      trustReason,
      authorization,
      resourceGeneration: instance.resourceGeneration,
      projection: instance.projection,
    }),
  });
}

/** The per-tab handle is header-only: never a URL, query parameter or body. */
function sessionPlusHandle(req: PanelRequest): string {
  const value = req.headers[SESSION_PLUS_INSTANCE_HEADER];
  return typeof value === "string" ? value : "";
}

/** Parent-authored typed-resource epoch; the Agent View never receives it. */
function sessionPlusResourceGeneration(req: PanelRequest): number | null {
  const raw = req.headers[SESSION_PLUS_RESOURCE_GENERATION_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,8})$/.test(value)) return null;
  const generation = Number(value);
  return Number.isSafeInteger(generation) ? generation : null;
}

/**
 * The two things every Session Plus route needs before it may do anything, in
 * this order: a named live browser login, and this owner's publisher trust.
 *
 * `release` and `trust` are the doors themselves, so they take only the first
 * step; the rest go through both. Returning `null` means a refusal has been
 * written, exactly as the shared preamble did when these five routes were one
 * handler with a path switch.
 */
function sessionPlusEntry(
  ctx: SessionPlusRoutesContext,
  reply: PanelReply,
  identity: DashboardIdentity,
): { principal: SessionPlusPrincipal; settings: SessionPlusSettings; releaseIdentity: AppReleaseIdentity } | null {
  const settings = ctx.sessionPlusSettings();
  if (!settings) {
    json(reply, 503, { error: sessionPlusUnavailableReason(ctx) });
    return null;
  }
  const principal = hostedAppPrincipal(reply, identity, SESSION_PLUS_PRESENCE_REFUSAL);
  if (!principal) return null;
  return { principal, settings, releaseIdentity: sessionPlusTrustIdentity(settings) };
}

/** Why the App has no release right now, in words an operator can act on. */
function sessionPlusUnavailableReason(ctx: SessionPlusRoutesContext): string {
  const failure = ctx.opts.sessionPlusRelease?.unavailable();
  return failure
    ? `会话+ 当前没有可服务的 release：${failure.message}`
    : "会话+ 当前没有被激活的 release；请在 /apps 激活或回滚一个版本";
}

/**
 * Release evidence for the consent page, for the release being served.
 *
 * Read through the host when one is composed, so what the page shows is what
 * the origin serves. A composition without a registry describes the settings'
 * release directly, which is the single-release deployment shape.
 */
function sessionPlusReleaseRecord(ctx: SessionPlusRoutesContext, settings: SessionPlusSettings): SessionPlusReleaseRecord | null {
  const active = ctx.opts.sessionPlusRelease?.active();
  if (active && active.prepared.identity.packageDigest === settings.identity.packageDigest) {
    return active.prepared.releaseRecord;
  }
  // No registry in this composition — the single-release deployment shape.
  // Describe the checkout, but ONLY when it is provably the release being
  // served: a record that described a different package than the origin
  // serves would be evidence about the wrong thing, which is worse than none.
  const checkout = checkoutRelease(ctx);
  return checkout && checkout.descriptor.packageDigest === settings.identity.packageDigest
    ? checkoutReleaseRecord(checkout.descriptor, settings.identity)
    : null;
}

/** Exact-name source lookup inside the release being served. Never a path. */
function sessionPlusReleaseSource(ctx: SessionPlusRoutesContext, settings: SessionPlusSettings, name: string): string | null {
  const active = ctx.opts.sessionPlusRelease?.active();
  if (active && active.prepared.identity.packageDigest === settings.identity.packageDigest) {
    return active.prepared.source(name);
  }
  const checkout = checkoutRelease(ctx);
  if (!checkout || checkout.descriptor.packageDigest !== settings.identity.packageDigest) return null;
  return checkout.assets.find((asset) => asset.name === name)?.source ?? null;
}

/** This checkout's own package, memoised; null when the View is not built. */
function checkoutRelease(ctx: SessionPlusRoutesContext): { descriptor: AppReleaseDescriptor; assets: readonly PackageAsset[] } | null {
  if (ctx.sessionPlusCheckoutCache.value !== undefined) return ctx.sessionPlusCheckoutCache.value;
  try {
    const pkg = sessionPlusReleasePackage();
    ctx.sessionPlusCheckoutCache.value = {
      descriptor: sessionPlusDescriptor({ pkg, lockfileHash: checkoutLockfileHash() }),
      assets: pkg.assets,
    };
  } catch {
    ctx.sessionPlusCheckoutCache.value = null;
  }
  return ctx.sessionPlusCheckoutCache.value;
}


/** The same, plus the trust check and the constructed coordinator. */
function sessionPlusBinding(
  ctx: SessionPlusRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): { principal: SessionPlusPrincipal; app: DashboardSessionPlusAppPort; handle: string; release: string } | null {
  const entry = sessionPlusEntry(ctx, reply, identity);
  if (!entry) return null;
  const trust = ctx.appTrust.status(entry.principal.owner, entry.releaseIdentity);
  if (!trust.trusted) {
    json(reply, 403, { error: "请先在可信外层确认发布者与当前 release" });
    return null;
  }
  const app = ctx.opts.sessionPlusApp;
  if (!app) {
    json(reply, 503, { error: "会话+ 后端未构造" });
    return null;
  }
  return {
    principal: entry.principal,
    app,
    handle: sessionPlusHandle(req),
    release: entry.settings.identity.packageDigest,
  };
}

function apiSessionPlusRelease(ctx: SessionPlusRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const entry = sessionPlusEntry(ctx, reply, identity);
  if (!entry) return;
  const sourceName = panelUrl(req).searchParams.get("source");
  if (sourceName !== null) {
    const source = sessionPlusReleaseSource(ctx, entry.settings, sourceName);
    if (source === null) {
      json(reply, 404, { error: "源码快照中没有这个文件" });
      return;
    }
    sendBody(reply, 200, "text/plain; charset=utf-8", source);
    return;
  }
  json(reply, 200, sessionPlusReleaseRecord(ctx, entry.settings));
}

function apiSessionPlusTrust(ctx: SessionPlusRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const entry = sessionPlusEntry(ctx, reply, identity);
  if (!entry) return;
  const { principal, releaseIdentity } = entry;
  decideAppTrust(ctx, req, reply, {
    owner: principal.owner,
    release: releaseIdentity,
    subjectId: SESSION_PLUS_APP_ID,
    releaseOwner: (reason) => ctx.opts.sessionPlusApp?.releaseOwner(principal.owner, reason),
  });
}

async function apiSessionPlusAct(ctx: SessionPlusRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  const bound = sessionPlusBinding(ctx, req, reply, identity);
  if (!bound) return;
  observeSessionUi(bound.principal.owner, bodyOf(req).action, bound.release);
  await actOnHostedApp(req, reply, {
    kind: "session-plus",
    app: bound.app,
    principal: bound.principal,
    handle: bound.handle,
    resourceGeneration: sessionPlusResourceGeneration(req),
  });
}

/**
 * Admit one lossy browser-health window from a live, owner-bound tab.
 *
 * These numbers are untrusted observations, not permission or business facts.
 * Resolving the instance first prevents a stale/forged handle from writing log
 * noise; picking every metric into a fresh object prevents ignored body fields
 * from smuggling content into the structured log.
 */
function apiSessionPlusPerformance(
  ctx: SessionPlusRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const bound = sessionPlusBinding(ctx, req, reply, identity);
  if (!bound) return;
  const subscription = bound.app.subscribe(bound.handle, bound.principal, () => {});
  if (!subscription) {
    json(reply, 404, { error: "会话+ 实例不存在或已结束" });
    return;
  }
  subscription.close();

  const report = sessionPlusPerformanceReport(bodyOf(req));
  if (!report) {
    json(reply, 400, { error: "浏览器性能窗口无效" });
    return;
  }
  log.info({
    owner: bound.principal.owner,
    release: bound.release,
    browserPerformance: report,
  }, "Session Plus browser performance window");
  json(reply, 202, { ok: true });
}

const PERFORMANCE_COUNT_KEYS = [
  "projectionCount",
  "sessionRowsMax",
  "sourceRowsMax",
  "transcriptWindowsMax",
  "transcriptMessagesMax",
  "longTaskCount",
  "timerLagCount",
] as const;
const PERFORMANCE_VIEW_COUNT_KEYS = [
  "viewReportCount",
  "viewInputEventCount",
  "viewInputFrameCount",
  "viewInputFrameOver50Count",
  "viewProjectionCommitCount",
  "viewProjectionFrameCount",
  "viewLongTaskCount",
  "viewTimerLagCount",
  "viewDomNodesMax",
] as const;
const PERFORMANCE_DURATION_KEYS = [
  "windowMs",
  "projectionDispatchMaxMs",
  "longTaskTotalMs",
  "longTaskMaxMs",
  "timerLagMaxMs",
] as const;
const PERFORMANCE_VIEW_DURATION_KEYS = [
  "viewInputFrameTotalMs",
  "viewInputFrameMaxMs",
  "viewProjectionCommitTotalMs",
  "viewProjectionCommitMaxMs",
  "viewProjectionFrameTotalMs",
  "viewProjectionFrameMaxMs",
  "viewLongTaskTotalMs",
  "viewLongTaskMaxMs",
  "viewTimerLagMaxMs",
] as const;

function sessionPlusPerformanceReport(body: Record<string, unknown>): SessionPlusPerformanceReport | null {
  if (body.version !== 1 && body.version !== 2) return null;
  const report: Record<string, number> = { version: 2 };
  for (const key of PERFORMANCE_COUNT_KEYS) {
    const value = body[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) return null;
    report[key] = value;
  }
  for (const key of PERFORMANCE_DURATION_KEYS) {
    const value = body[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 3_600_000) return null;
    report[key] = value;
  }
  if (body.version === 2) {
    for (const key of PERFORMANCE_VIEW_COUNT_KEYS) {
      const value = body[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) return null;
      report[key] = value;
    }
    for (const key of PERFORMANCE_VIEW_DURATION_KEYS) {
      const value = body[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 3_600_000) return null;
      report[key] = value;
    }
  } else {
    for (const key of PERFORMANCE_VIEW_COUNT_KEYS) report[key] = 0;
    for (const key of PERFORMANCE_VIEW_DURATION_KEYS) report[key] = 0;
  }
  return report as unknown as SessionPlusPerformanceReport;
}

function apiSessionPlusReconstruct(ctx: SessionPlusRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const bound = sessionPlusBinding(ctx, req, reply, identity);
  if (!bound) return;
  const expected = sessionPlusResourceGeneration(req);
  if (expected === null) {
    json(reply, 400, { ok: false, error: "缺少有效的资源代次" });
    return;
  }
  try {
    const generation = bound.app.resetResourceGeneration(bound.handle, bound.principal, expected);
    json(
      reply,
      generation === null ? 409 : 200,
      generation === null
        ? { ok: false, error: "资源代次已经变化，请刷新页面" }
        : { ok: true, generation },
    );
  } catch (err) {
    log.warn({ err, owner: bound.principal.owner }, "Session Plus resource generation reset failed");
    json(reply, 503, { ok: false, error: "旧视图的资源没有安全结束" });
  }
}

function apiSessionPlusClose(ctx: SessionPlusRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const bound = sessionPlusBinding(ctx, req, reply, identity);
  if (!bound) return;
  closeHostedApp(reply, { principal: bound.principal, handle: bound.handle, service: bound.app });
}

function apiSessionPlusStream(ctx: SessionPlusRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const bound = sessionPlusBinding(ctx, req, reply, identity);
  if (!bound) return;
  streamHostedApp(ctx, reply, { principal: bound.principal, handle: bound.handle, service: bound.app }, {
    delta: wantsProjectionDelta(req),
  });
}
