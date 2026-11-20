/**
 * `/api/apps*` — local Agentic App release management.
 *
 * Mechanically relocated out of `server.ts` (2026-08-11 domain split): same
 * paths, same `authz.ts` rule ids, same status codes and messages. Every verb
 * is one call into the catalog host, which owns the ordering that makes a bad
 * candidate unable to replace a working release.
 */

import { parseBundle } from "../../app-registry/bundle.js";
import type { ManagedApp } from "../../app-registry/release-host.js";
import { createLogger } from "../../logger.js";
import { type PanelReply, type PanelRequest, bodyOf, replyJson as json } from "../http.js";
import { PANEL_BODY_SCHEMAS } from "../schemas.js";
import type { DashboardAppReleasePort } from "../ports.js";
import type { DashboardIdentity, DashboardRouteOptions } from "../server.js";
import type { GuardedRoutes } from "./context.js";

const log = createLogger("dashboard");

export interface AppReleaseRoutesContext {
  opts: Pick<
    DashboardRouteOptions,
    "appReleases" | "declaredApps" | "declareApp" | "publishPendingAppReleases" | "appHotswapApprovals"
  >;
}

export function registerAppReleaseRoutes(routes: GuardedRoutes, ctx: AppReleaseRoutesContext): void {
  // Every one of these is `Administer` in the route table, has crossed the
  // mutation gate (precise Origin + CSRF for a browser session), and does
  // exactly one thing: parse, authenticate, call the host, serialise. Nothing
  // here writes a table, compiles anything, reads a path the caller supplied,
  // or decides an ordering — the host owns the ordering that makes a bad
  // candidate unable to replace a working release.
  routes.get("/api/apps", "api.apps.list", (_req, reply) => apiAppsList(ctx, reply));
  routes.post(
    "/api/apps/install",
    "api.apps.install",
    undefined,
    (req, reply, identity) => apiAppsInstall(ctx, req, reply, identity),
    {
      // A release artifact is a compiled React bundle plus the App's declared
      // sources: roughly half a megabyte today, and the panel's global body
      // limit is one. Raised HERE and only here, so "the panel accepts a large
      // body" stays a property of one route rather than of the server. The
      // registry applies its own per-asset and total limits from the bytes up,
      // so this number bounds the transport, not the release.
      bodyLimit: 12 * 1024 * 1024,
    },
  );
  routes.post("/api/apps/activate", "api.apps.activate", PANEL_BODY_SCHEMAS.appsActivate, (req, reply, identity) =>
    apiAppsActivate(ctx, req, reply, identity),
  );
  routes.post("/api/apps/deactivate", "api.apps.deactivate", PANEL_BODY_SCHEMAS.appsDeactivate, (req, reply, identity) =>
    apiAppsDeactivate(ctx, req, reply, identity),
  );
  routes.post("/api/apps/uninstall", "api.apps.uninstall", PANEL_BODY_SCHEMAS.appsUninstall, (req, reply, identity) =>
    apiAppsUninstall(ctx, req, reply, identity),
  );
  routes.post("/api/apps/declare", "api.apps.declare", PANEL_BODY_SCHEMAS.appsDeclare, (req, reply, identity) =>
    apiAppsDeclare(ctx, req, reply, identity),
  );
  routes.post("/api/apps/publish-pending", "api.apps.publishPending", undefined, (_req, reply, identity) =>
    apiAppsPublishPending(ctx, reply, identity),
  );
  routes.post("/api/apps/hotswap/:id/approve", "api.apps.hotswapDecision", undefined, (req, reply, identity) =>
    apiAppsHotswapDecision(ctx, req, reply, identity, "approve"),
  );
  routes.post("/api/apps/hotswap/:id/reject", "api.apps.hotswapDecision", undefined, (req, reply, identity) =>
    apiAppsHotswapDecision(ctx, req, reply, identity, "reject"),
  );
}

// ── Agentic App release management ──

function appReleases(ctx: AppReleaseRoutesContext): DashboardAppReleasePort {
  // The route gate 404s these paths when no host is composed, so reaching a
  // handler means one exists. Asserted rather than assumed, because a `!` on
  // an optional dependency is exactly the shape that turns a composition
  // mistake into a 500 on a route that reads as wired.
  const host = ctx.opts.appReleases;
  if (!host) throw new Error("app release routes require a composed AppReleaseHost");
  return host;
}

/**
 * Which app a call is about.
 *
 * Every verb below names its app explicitly rather than defaulting to "the
 * only one": a default would be right exactly until this host serves two, and
 * the call that moves an active pointer is the last place to learn that. An
 * unknown id is a 404 — on this composition that app does not exist, and 422
 * would read as "your release is bad".
 */
function appFor(ctx: AppReleaseRoutesContext, req: PanelRequest, reply: PanelReply): ManagedApp | null {
  const id = String(bodyOf(req).app ?? "");
  const app = id ? appReleases(ctx).app(id) : null;
  if (!app) {
    const failure = appReleases(ctx).unknownApp(id || "(缺少 app 字段)");
    json(reply, 404, { error: failure.message, code: failure.code });
    return null;
  }
  return app;
}

function apiAppsList(ctx: AppReleaseRoutesContext, reply: PanelReply): void {
  const described = appReleases(ctx).describe();
  json(reply, 200, {
    ...described,
    // Which apps this panel will host at `/apps/<id>/open`, as DATA.
    //
    // The page needs it to decide whether to render an open link, and the
    // alternative — hard-coding "everything except session-plus" in the
    // browser — would be the page guessing at a composition fact. Session
    // Plus is absent because it is compiled in rather than declared, and it
    // has its own surface with the capability chrome its contract needs; the
    // generic host page would be a strictly weaker page for it.
    openable: (ctx.opts.declaredApps?.list() ?? [])
      .filter((app) => app.viewOrigin !== null && app.service !== null)
      .map((app) => app.stableAppId),
    hotswap_approvals: (ctx.opts.appHotswapApprovals?.list() ?? []).map((approval) => {
      const app = described.apps.find((candidate) => candidate.stableAppId === approval.appId);
      const predecessor = app?.releases.find((release) => release.packageDigest === approval.previousDigest);
      return {
        id: approval.id,
        state: approval.state,
        ticket_id: approval.ticketId,
        app_id: approval.appId,
        publisher: app?.publisher ?? null,
        source_commit: approval.sourceCommit,
        package_digest: approval.packageDigest,
        previous_digest: approval.previousDigest,
        contract_digest: approval.contractDigest,
        contract_changed: predecessor
          ? predecessor.permissionContractDigest !== approval.contractDigest
          : null,
        coexistence: approval.coexistence,
        coexistence_reason: approval.coexistenceReason,
        requested_by: approval.requestedBy,
        requested_at: approval.requestedAt,
        expires_at: approval.expiresAt,
        outcome: approval.outcome,
      };
    }),
  });
}

async function apiAppsHotswapDecision(
  ctx: AppReleaseRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
  decision: "approve" | "reject",
): Promise<void> {
  // Administer is necessary but not sufficient: bearer credentials (including
  // an admin bearer) are deliberately unable to consume an agent's pending
  // activation. CSRF/Origin were already enforced by the common mutation gate.
  if (!identity.session || !identity.username) {
    json(reply, 403, { error: "App activation 审批只能在 Dashboard 浏览器登录会话中完成(Bearer 不算人在场)" });
    return;
  }
  const id = String((req.params as { id?: unknown }).id ?? "");
  if (!/^ahr_[0-9a-f-]{36}$/.test(id)) {
    json(reply, 404, { error: "App activation 审批不存在", code: "unknown_approval" });
    return;
  }
  const approvals = ctx.opts.appHotswapApprovals;
  if (!approvals) {
    json(reply, 404, { error: "本部署没有接入 App activation 审批管线", code: "approval_unavailable" });
    return;
  }
  try {
    const result = await approvals.decide(id, decision, `user:${identity.username}`);
    if (!result.ok) {
      json(reply, result.code === "unknown_approval" ? 404 : 409, { error: result.message, code: result.code });
      return;
    }
    json(reply, 200, {
      ok: true,
      decision: result.decision,
      id: result.id,
      app_id: result.appId,
      package_digest: result.packageDigest,
      changed: result.changed,
      coexistence: result.coexistence,
      coexistence_reason: result.coexistenceReason,
      message: result.message,
    });
  } catch (error) {
    json(reply, 500, {
      error: `App activation 审批管线异常:${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      code: "approval_crashed",
    });
  }
}

function apiAppsInstall(ctx: AppReleaseRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const parsed = parseBundle(bodyOf(req).bundle);
  if (!parsed.ok) {
    json(reply, 400, { error: parsed.error });
    return;
  }
  // Routed by the descriptor the bundle carries: a release names its own app,
  // so an `app` field here could only ever agree or contradict.
  const outcome = appReleases(ctx).install(parsed.bundle, actor(identity));
  if (!outcome.ok) {
    json(reply, 422, { error: outcome.failure.message, issues: outcome.failure.issues ?? [] });
    return;
  }
  log.info(
    {
      app: outcome.app,
      packageDigest: outcome.packageDigest,
      deduplicated: outcome.deduplicated,
      by: actor(identity),
    },
    "Agentic App release installed",
  );
  // Installing never changes what is served. Saying so in the response is not
  // decoration: the operator has to make a second, separate decision.
  json(reply, 200, {
    ok: true,
    app: outcome.app,
    package_digest: outcome.packageDigest,
    deduplicated: outcome.deduplicated,
    activated: false,
  });
}

async function apiAppsActivate(
  ctx: AppReleaseRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): Promise<void> {
  const app = appFor(ctx, req, reply);
  if (!app) return;
  const digest = String(bodyOf(req).package_digest ?? "");
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    json(reply, 400, { error: "package_digest 必须是 64 位小写十六进制" });
    return;
  }
  const outcome = await app.activate(digest, actor(identity));
  if (!outcome.ok) {
    json(reply, 422, {
      error: outcome.failure.message,
      code: outcome.failure.code,
      issues: outcome.failure.issues ?? [],
    });
    return;
  }
  json(reply, 200, {
    ok: true,
    app: app.appId,
    package_digest: digest,
    previous_package_digest: outcome.previousPackageDigest,
    changed: outcome.changed,
    coexistence: outcome.coexistence,
    reason: outcome.reason,
    // Where the browser now reaches it. Read back from the app's own
    // description so the panel never has to know the shape of any app's
    // settings object.
    view_origin: app.describe().activeViewOrigin,
  });
}

async function apiAppsDeactivate(ctx: AppReleaseRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  const app = appFor(ctx, req, reply);
  if (!app) return;
  const outcome = await app.deactivate(actor(identity));
  if (!outcome.ok) {
    json(reply, 422, { error: outcome.failure.message, issues: outcome.failure.issues ?? [] });
    return;
  }
  json(reply, 200, { ok: true, app: app.appId, changed: outcome.changed });
}

function apiAppsUninstall(ctx: AppReleaseRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const app = appFor(ctx, req, reply);
  if (!app) return;
  const digest = String(bodyOf(req).package_digest ?? "");
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    json(reply, 400, { error: "package_digest 必须是 64 位小写十六进制" });
    return;
  }
  const outcome = app.uninstall(digest, actor(identity));
  if (!outcome.ok) {
    json(reply, 422, { error: outcome.failure.message, issues: outcome.failure.issues ?? [] });
    return;
  }
  json(reply, 200, { ok: true, app: app.appId, changed: outcome.changed });
}

/**
 * Declare one more App this host serves.
 *
 * Everything that decides anything happens in the composition root: the
 * grammar an id must satisfy (it becomes a state directory name), whether the
 * id is already taken by a compiled-in app, the row, the adapter, the catalog
 * entry and the children. This handler parses three bounded strings, records
 * who asked, and maps the composition root's answer onto a status code.
 *
 * Declaring serves NOTHING. A declared App has no release until somebody
 * installs one and activates it, and its permission contract is empty — which
 * is why declaring is an `Administer` call rather than a review.
 */
async function apiAppsDeclare(
  ctx: AppReleaseRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): Promise<void> {
  const declare = ctx.opts.declareApp;
  if (!declare) {
    json(reply, 404, {
      error: "本部署不能声明新的 App（需要 session_plus.app_domain 形态的 App 域）",
      code: "declare_unavailable",
    });
    return;
  }
  const body = bodyOf(req);
  const outcome = await declare({
    stableAppId: String(body.app ?? ""),
    publisher: String(body.publisher ?? ""),
    title: String(body.title ?? ""),
    by: actor(identity),
  });
  if (!outcome.ok) {
    // 409 for "that id is taken" and 400 for "that is not a usable
    // declaration": one is a collision the caller can resolve by choosing
    // another id, the other is a malformed request. `compose_failed` is 500 —
    // the declaration was recorded, this process could not honour it, and
    // nothing the caller sent was wrong.
    const status = outcome.code === "app_exists" ? 409 : outcome.code === "invalid" ? 400 : 500;
    json(reply, status, { error: outcome.message, code: outcome.code });
    return;
  }
  log.info(
    { app: outcome.app, publisher: outcome.publisher, by: actor(identity) },
    "Agentic App declared",
  );
  json(reply, 200, {
    ok: true,
    app: outcome.app,
    publisher: outcome.publisher,
    title: outcome.title,
    // Two separate decisions still to come, and saying so is not decoration:
    // a declared App serves nothing until a release is installed and then
    // activated.
    installed: false,
    activated: false,
  });
}

/** Pack, install and activate recorded App-only debt without restarting bot. */
async function apiAppsPublishPending(
  ctx: AppReleaseRoutesContext,
  reply: PanelReply,
  identity: DashboardIdentity,
): Promise<void> {
  const publish = ctx.opts.publishPendingAppReleases;
  if (!publish) {
    json(reply, 404, { error: "本部署没有接入待发布 App 的热发布管线", code: "publish_unavailable" });
    return;
  }
  try {
    const result = await publish(actor(identity));
    json(reply, result.ok ? 200 : 409, {
      ok: result.ok,
      results: result.results.map((row) => ({
        app_id: row.appId,
        title: row.title,
        ticket_id: row.ticketId,
        ...row.outcome,
      })),
      remaining: result.remaining,
      ...(result.ok ? {} : { error: `仍有 ${result.remaining.length} 个 App 未发布成功` }),
    });
  } catch (error) {
    json(reply, 500, {
      error: `热发布管线异常:${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      code: "publish_crashed",
    });
  }
}

/** Who did it, for the record. A name, never an authority. */
function actor(identity: DashboardIdentity): string {
  return identity.username ? `user:${identity.username}` : "shared:auth_token";
}
