/**
 * Declared Agentic Apps: the generic trusted host page, shared-scope
 * instances (ADR 0007 P1), and the App View verbs (trust/act/close/stream).
 *
 * Mechanically relocated out of `server.ts` (2026-08-11 domain split): same
 * paths, same `authz.ts` rule ids, same status codes and messages.
 */

import { RESEARCH_APP } from "@claude-bot/research-canvas-contract";
import {
  PROJECTION_BASE_HEADER,
  PROJECTION_DELTA_HEADER,
  PROJECTION_DELTA_VERSION,
  PROJECTION_PATCH_EVENT,
  applyProjectionPatch,
  diffProjection,
  readProjectionBaseId,
  sameProjectionJson,
  type ProjectionPatchOp,
} from "@claude-bot/dashboard-web/projection-delta";
import type {
  DashboardPageProps,
  SharedInstanceSummaryProps,
  SharedWorkspaceProps,
} from "@claude-bot/dashboard-web/contract";
import { SharedAppManagement, SharedManagementError } from "../../app-registry/shared-management.js";
import type { SharedAppInstanceRow } from "../../store/store.js";
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { AppDispatchResult, SharedJoinPolicy } from "../../app-registry/app-instance.js";
import type { ExternalAppHostService } from "../../app-external/service.js";
import { createLogger } from "../../logger.js";
import { isFirstPartyPublisher, type AppReleaseIdentity, type AppTrustStatus } from "../../permissions/app-trust.js";
import type { DispatchResult } from "../../session-plus/app-service.js";
import type { InstanceEvent, InstanceSubscription, SessionPlusPrincipal } from "../../app-core/instance.js";
import type { SessionPlusRoleSpec } from "../../app-core/manifest.js";
import { type PanelReply, type PanelRequest, bodyOf, panelUrl, replyJson as json } from "../http.js";
import type {
  DashboardAppInstancePort,
  DashboardAppTrustPort,
  DashboardPermissionPort,
  DashboardSessionPlusAppPort,
  DashboardStorePort,
} from "../ports.js";
import { PANEL_BODY_SCHEMAS } from "../schemas.js";
import type { DashboardIdentity, DashboardRouteOptions, DeclaredAppSurface } from "../server.js";
import type { GuardedRoutes, PageRenderer } from "./context.js";
import { hijack, onRawResponseEnd } from "./shared.js";

const log = createLogger("dashboard");

export interface AppViewRoutesContext extends PageRenderer {
  store: DashboardStorePort;
  appTrust: DashboardAppTrustPort;
  permissions: DashboardPermissionPort;
  /**
   * `external-app-host/v1`, for one page prop and nothing else: WHICH external
   * hosts a person may pick. Null (the default) leaves the section off the page
   * entirely. The grant face itself lives in `routes/app-external.ts` — this
   * page reads availability, never authority.
   */
  externalAppHost: ExternalAppHostService | null;
  opts: Pick<DashboardRouteOptions, "declaredApps">;
  liveStreams: Map<ServerResponse, { owner: string; credential: string }>;
  eventStreams: Set<ServerResponse>;
}

export function registerAppViewRoutes(routes: GuardedRoutes, ctx: AppViewRoutesContext): void {
  // Shared-scope declared Apps (ADR 0007 P1): four verbs, one rule
  // (`api.appShared`), for the same reason as `api.appView` below. Creating
  // an instance and taking a seat are ACL writes on a state object — the
  // membership DOOR (may this owner open/drive this instance) stays in
  // `AppInstanceService`, which re-reads these rows on every open and every
  // dispatch. These handlers only write membership rows and answer
  // availability; none of them touches App state.
  routes.post(
    "/api/apps/:app/shared-instances",
    "api.appShared",
    PANEL_BODY_SCHEMAS.appSharedInstance,
    (req, reply, identity) => apiAppSharedCreate(ctx, req, reply, identity),
  );
  routes.post(
    "/api/apps/:app/shared-instances/:key/join",
    "api.appShared",
    PANEL_BODY_SCHEMAS.appSharedInstance,
    (req, reply, identity) => apiAppSharedJoin(ctx, req, reply, identity),
  );
  routes.get("/api/apps/:app/shared-instances", "api.appShared", (req, reply, identity) =>
    apiAppSharedList(ctx, req, reply, identity),
  );
  // The launcher's list: availability metadata for a person deciding what to
  // open, NOT the operator's registry read (`api.apps.list` keeps digests,
  // releases and runtime state behind `Administer`). Same `api.appShared`
  // rule as the rest of this file: one question, verbs as data.
  routes.get("/api/apps/launcher", "api.appShared", (_req, reply, _identity) => {
    const directory = ctx.opts.declaredApps;
    const apps = (directory?.list() ?? [])
      .map((surface) => ({
        app: surface.stableAppId,
        title: surface.title,
        publisher: surface.publisher,
        available: Boolean(surface.packageDigest) && !surface.unavailable,
      }))
      .sort((a, b) => (a.title < b.title ? -1 : 1));
    json(reply, 200, { apps });
  });
  routes.get("/api/apps/:app/shared-instances/:key/seats", "api.appShared", (req, reply, identity) =>
    apiAppSharedSeats(ctx, req, reply, identity),
  );
  routes.get("/api/apps/:app/shared-instances/:key/member-candidates", "api.appShared", (req, reply, identity) =>
    apiAppSharedMemberCandidates(ctx, req, reply, identity),
  );
  routes.get("/api/apps/:app/shared-instances/:key/members", "api.appShared", (req, reply, identity) =>
    apiAppSharedMembers(ctx, req, reply, identity),
  );
  routes.post(
    "/api/apps/:app/shared-instances/:key/members",
    "api.appShared",
    PANEL_BODY_SCHEMAS.appSharedMember,
    (req, reply, identity) => apiAppSharedMemberSet(ctx, req, reply, identity),
  );
  routes.post(
    "/api/apps/:app/shared-instances/:key/members/remove",
    "api.appShared",
    PANEL_BODY_SCHEMAS.appSharedMemberRemove,
    (req, reply, identity) => apiAppSharedMemberRemove(ctx, req, reply, identity),
  );
  routes.post("/api/apps/:app/shared-instances/:key/close", "api.appShared", undefined, (req, reply, identity) =>
    apiAppSharedClose(ctx, req, reply, identity),
  );

  // Opening one declared App. Four routes under ONE authorization rule
  // (`api.appView`), because the verb is data: which App and which tab come
  // from `?app=` and the instance header, and every one of them asks the same
  // question of Cedar. The page itself is registered with the other pages.
  routes.post("/api/app-view/trust", "api.appView", PANEL_BODY_SCHEMAS.appViewTrust, (req, reply, identity) =>
    apiAppViewTrust(ctx, req, reply, identity),
  );
  routes.post("/api/app-view/act", "api.appView", PANEL_BODY_SCHEMAS.appViewAct, (req, reply, identity) =>
    apiAppViewAct(ctx, req, reply, identity),
  );
  routes.post("/api/app-view/close", "api.appView", undefined, (req, reply, identity) =>
    apiAppViewClose(ctx, req, reply, identity),
  );
  routes.get("/api/app-view/stream", "api.appView", (req, reply, identity) =>
    apiAppViewStream(ctx, req, reply, identity),
  );
  routes.get("/api/app-view/agent-activity", "api.appView", (req, reply, identity) => {
    const bound = declaredAppBinding(ctx, req, reply, identity);
    if (!bound) return;
    const activity = bound.service.agentActivity(bound.handle, bound.principal);
    json(reply, activity === null ? 403 : 200, activity === null ? { error: "无法读取当前应用任务" } : { activity });
  });
  routes.post("/api/app-view/agent-stop", "api.appView", PANEL_BODY_SCHEMAS.appAgentStop, (req, reply, identity) => {
    const bound = declaredAppBinding(ctx, req, reply, identity);
    if (!bound) return;
    const stopped = bound.service.stopAgentActivity(bound.handle, bound.principal, String(bodyOf(req).turnId ?? ""));
    json(reply, stopped ? 200 : 403, stopped ? { ok: true } : { error: "无法停止当前应用任务" });
  });

}

/**
 * A declared App's per-tab handle rides in its OWN header, never in a URL.
 *
 * Same rule as Session Plus's, and a different name because they are different
 * registries: a handle minted by one App's coordinator is simply absent from
 * another's map, and one header carrying both would invite a reader to think
 * otherwise. Which App a call is about travels in the query string, because it
 * is not a secret — it is in the address bar of the page that made the call.
 */
const APP_INSTANCE_HEADER = "x-app-instance";

/**
 * A shared-instance key, exactly as `apiAppSharedCreate` mints one: `asi_` plus
 * one UUID's 32 hex digits. Keys are server-minted, never caller-named, so the
 * grammar IS the mint's output format and anything else is refused before any
 * lookup. Knowing a key, while logged in, is what a share link is (ADR 0007
 * P1) — the door that decides whether the knower may OPEN the instance stays in
 * `AppInstanceService`.
 */
const SHARED_INSTANCE_KEY = /^asi_[0-9a-f]{32}$/;
const RESEARCH_PROGRAM_APP_ID = "research-program";
/**
 * One project-directory WINDOW. It bounds the viewer-scoped projection work a
 * single request may do (`readSharedProjections` caps one call at the same
 * size); it does not bound how many projects a person may reach. Further
 * windows come from `GET /api/apps/:app/shared-instances?cursor=…`.
 */
const SHARED_WORKSPACE_PROJECT_WINDOW = 64;
/** A cursor is two short fields; anything longer is not one of ours. */
const SHARED_INSTANCE_CURSOR_MAX = 256;

/** Opaque keyset cursor over the store's directory order (created_at, instance_key). */
function sharedInstanceCursor(row: SharedAppInstanceRow): string {
  return Buffer.from(JSON.stringify([row.created_at, row.instance_key]), "utf8").toString("base64url");
}

function parseSharedInstanceCursor(raw: string): { createdAt: string; instanceKey: string } | null {
  if (!raw || raw.length > SHARED_INSTANCE_CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [createdAt, instanceKey] = value as unknown[];
    if (typeof createdAt !== "string" || !createdAt || createdAt.length > 64) return null;
    if (typeof instanceKey !== "string" || !SHARED_INSTANCE_KEY.test(instanceKey)) return null;
    return { createdAt, instanceKey };
  } catch {
    return null;
  }
}

/** One window of a person's membership rows, and the cursor of the next window. */
function sharedInstanceWindow(
  ctx: AppViewRoutesContext,
  appId: string,
  owner: string,
  before?: { createdAt: string; instanceKey: string },
): { rows: SharedAppInstanceRow[]; nextCursor?: string } {
  // One past the window, so "there is more" is an observation, not a guess.
  const page = ctx.store.listSharedAppInstancesPageFor(appId, owner, {
    limit: SHARED_WORKSPACE_PROJECT_WINDOW + 1,
    ...(before ? { before } : {}),
  });
  const rows = page.slice(0, SHARED_WORKSPACE_PROJECT_WINDOW);
  return {
    rows,
    ...(page.length > rows.length ? { nextCursor: sharedInstanceCursor(rows[rows.length - 1]!) } : {}),
  };
}

// ── The hosted-App core: one implementation for Session Plus and declared Apps ──
//
// Session Plus is a declared App's unmerged ancestor: the presence rule, the
// publisher-trust verb, the trusted page flow, `act`, `close` and the
// projection stream were written for `/sessions-plus` first and copy-pasted
// for this generic host. They are one implementation here, parameterized by
// the surface. Every behavioral difference between the two rides an explicit
// `kind` branch or a per-surface argument — the resource-generation epoch and
// the `resource_refused` mapping exist only on Session Plus's resource plane,
// the `not_supported` refusal only on declared Apps — never a silent default.
// What Session Plus has and a declared App does not (session resources,
// submission operations, the typed-port binder, `reconstruct`) stays in
// `routes/session-plus.ts` rather than being stubbed here.

/**
 * Hosted App instances exist only for a named, live browser login.
 *
 * Cedar answers whether the account may reach the route. This narrowing is
 * the separate presence rule: a raw bearer is useful for scripts, but it is
 * not a browser tab whose lifetime can own an isolated App instance — and the
 * App's state is account-scoped, so a shared key naming nobody has nothing to
 * open. The refusal sentence stays per-surface.
 */
export function hostedAppPrincipal(
  reply: PanelReply,
  identity: DashboardIdentity,
  refusal: string,
): SessionPlusPrincipal | null {
  if (!identity.username || !identity.session) {
    json(reply, 403, { error: refusal });
    return null;
  }
  if (identity.actingAs) {
    // A named administrator acting as another account (2026-10-15): the
    // account's own page and planes, under a credential derived from the
    // administrator's login, so ending that login ends these instances too.
    log.info({ by: identity.username, owner: identity.actingAs }, "Administrator acting as account in Sessions+");
    return { owner: identity.actingAs, credential: `${identity.credential}:as:${identity.actingAs}`, session: true };
  }
  return identity.sessionShare
    ? { owner: identity.sessionShare.owner, credential: `${identity.credential}:share:${identity.sessionShare.id}`, session: true, delegation: { shareId: identity.sessionShare.id, viewer: identity.username } }
    : { owner: identity.username, credential: identity.credential, session: true };
}

/**
 * The publisher-trust door verb: record the decision, audit it, and answer
 * with the door's new state. What differs by surface arrives as data — the
 * subject id the audit row names, and whose instances the revoke teardown
 * reaps. The audit `detail` records `release.packageDigest` on both surfaces
 * (Session Plus builds its release identity from the settings' own digest, so
 * the recorded value is unchanged from when the two verbs were separate).
 */
export function decideAppTrust(
  deps: { appTrust: DashboardAppTrustPort; permissions: DashboardPermissionPort },
  req: PanelRequest,
  reply: PanelReply,
  door: {
    owner: string;
    release: AppReleaseIdentity;
    subjectId: string;
    /** Row first, teardown second; must stay idempotent. */
    releaseOwner(reason: string): void;
  },
): void {
  const body = bodyOf(req);
  const decision = String(body.decision ?? "");
  if (decision !== "trust" && decision !== "revoke") {
    json(reply, 400, { error: "unknown trust decision" });
    return;
  }
  // A first-party release is trusted without a decision row (O12): there is
  // nothing to record, and a "revoke" would only kill the open tabs of an App
  // that the next request opens again.
  if (isFirstPartyPublisher(door.release.publisher)) {
    json(reply, 200, { ok: true, trust: deps.appTrust.status(door.owner, door.release) });
    return;
  }
  if (decision === "trust") {
    const next = deps.appTrust.trust(door.owner, door.release, body.follow_updates === true);
    deps.permissions.audit({
      owner: door.owner,
      subjectType: "app",
      subjectId: door.subjectId,
      operation: "(publisher_trust)",
      decision: "trust",
      reason: next.followUpdates ? "publisher_updates" : "exact_release",
      detail: door.release.packageDigest,
    });
  } else {
    // Row first, teardown second, and the teardown is idempotent: a previous
    // request that persisted the revocation and died before releasing still
    // reaps this account's instances (and their Contexts) on the next click.
    const changed = deps.appTrust.revoke(door.owner, door.release);
    door.releaseOwner("publisher_trust_revoked");
    deps.permissions.audit({
      owner: door.owner,
      subjectType: "app",
      subjectId: door.subjectId,
      operation: "(publisher_trust)",
      decision: "untrust",
      reason: changed ? "user" : "already_inactive",
    });
  }
  json(reply, 200, { ok: true, trust: deps.appTrust.status(door.owner, door.release) });
}

/** One tab's binding to whichever coordinator hosts its App. */
export type HostedAppBinding =
  | {
      kind: "session-plus";
      app: DashboardSessionPlusAppPort;
      principal: SessionPlusPrincipal;
      handle: string;
      /** Parent-authored typed-resource epoch; only this surface has one. */
      resourceGeneration: number | null;
    }
  | {
      kind: "declared";
      surface: DeclaredAppSurface;
      service: DashboardAppInstancePort;
      principal: SessionPlusPrincipal;
      handle: string;
    };

/** One bounded proposal from one tab. Only `action` and `params` come from the View. */
export async function actOnHostedApp(
  req: PanelRequest,
  reply: PanelReply,
  bound: HostedAppBinding,
): Promise<void> {
  const body = bodyOf(req);
  // Resolved on arrival: the frame must not be evicted while the action runs.
  const held = heldProjection(req, bound.handle);
  try {
    // The trusted Host substitutes its own binding for every identity field:
    // only `action` and `params` come from the View, and both are checked
    // against the App's declared contract inside `dispatch`.
    const result: DispatchResult | AppDispatchResult = bound.kind === "session-plus"
      ? await bound.app.dispatch(
          bound.handle,
          bound.principal,
          { action: body.action, params: body.params },
          bound.resourceGeneration ?? undefined,
        )
      : await bound.service.dispatch(bound.handle, bound.principal, {
          action: body.action,
          params: body.params,
        });
    if (result.ok) {
      json(reply, 200, held ? patchedActReply(result, held) : result);
      return;
    }
    // `not_supported` exists only on the declared-App coordinator and is the
    // caller's mistake (400). Session Plus never emits it, so its surface
    // keeps the generic 409 for that code — exactly as before the merge.
    const status = result.code === "unknown_action" || result.code === "action_rejected" ? 400
      : result.code === "invalid_instance" ? 404
        : bound.kind === "declared" && result.code === "not_supported" ? 400
          : 409;
    // `resource_refused` is the Session Plus coordinator's bookkeeping code.
    // The typed client needs the provider's domain code (`approval_required`,
    // `not_text`, `too_large`, …) to render an actionable refusal rather than
    // flattening every resource failure to `unavailable` at the HTTP seam.
    // Declared Apps have no resource plane and pass their codes through raw.
    const publicCode = bound.kind === "session-plus" && result.code === "resource_refused"
      ? result.resourceCode ?? "unavailable"
      : result.code;
    json(reply, status, { ok: false, code: publicCode, error: result.message });
  } catch (err) {
    if (bound.kind === "session-plus") {
      log.warn({ err, owner: bound.principal.owner }, "Session Plus action backend failed");
    } else {
      log.warn({ err, app: bound.surface.stableAppId, owner: bound.principal.owner }, "declared App action failed");
    }
    json(reply, 503, { ok: false, code: "backend_unavailable", error: "应用后端暂时不可用" });
  }
}

/** Close one tab's instance; 404 when the handle no longer resolves. */
export function closeHostedApp(
  reply: PanelReply,
  bound: {
    principal: SessionPlusPrincipal;
    handle: string;
    service: { closeInstance(handle: string, principal: SessionPlusPrincipal): boolean };
  },
): void {
  const closed = bound.service.closeInstance(bound.handle, bound.principal);
  json(reply, closed ? 200 : 404, closed ? { ok: true } : { ok: false, error: "应用实例不可用" });
}

/**
 * One tab's projection stream (SSE), shared by both surfaces.
 *
 * The subscription is created BEFORE the reply is hijacked, so a failure to
 * resolve the instance is still an ordinary 404 rather than a torn stream;
 * anything the coordinator emits in that window is queued rather than dropped
 * or written ahead of the headers. Events ride an explicit projection and an
 * explicit branch: a wake must stay content-free on the wire (ADR 0006), and
 * only `closed` may end the stream — a catch-all would end it for every
 * future event variant.
 *
 * `view` frames are full projections, so their volume is paced (2026-10-15,
 * egress): a projection equal to the newest one this stream already accepted
 * is never written again, and the next frame waits until
 * max(250 ms, previous frame bytes / 256 KiB/s) after the previous frame. Only
 * the newest frame waits, and it is written when its slot opens (trailing
 * edge), so the final state always arrives. Controls are never delayed by the
 * pacing: an `op`, `release_available` or `closed` pulls a waiting frame out
 * ahead of itself, because those must not overtake projection state emitted
 * before them; a content-free wake may pass a waiting frame.
 */
const HOSTED_APP_STREAM_PENDING_CONTROL_MAX = 32;
const HOSTED_APP_VIEW_MIN_INTERVAL_MS = 250;
const HOSTED_APP_VIEW_BYTES_PER_SECOND = 256 * 1024;

/** Above this size a patch frame is compared with the full frame it replaces. */
const HOSTED_APP_PATCH_COMPARE_BYTES = 64 * 1024;

/** Whether this stream request opted into `view-patch` frames. */
export function wantsProjectionDelta(req: PanelRequest): boolean {
  return req.headers[PROJECTION_DELTA_HEADER] === PROJECTION_DELTA_VERSION;
}

/** Frames each delta stream wrote last, kept so an act reply can be a patch. */
const PROJECTION_BASE_FRAMES = 8;
/** handle → stream id → that stream's recent frames, oldest first. */
const projectionBases = new Map<string, Map<string, Array<{ revision: number; projection: unknown }>>>();

/**
 * Register one delta stream's recent frames under its instance handle.
 * Lookups are scoped by the handle the act request was bound to, so a tab can
 * name only frames its own instance already sent it.
 */
function openProjectionBases(handle: string): {
  stream: string;
  record(revision: number, projection: unknown): void;
  close(): void;
} {
  const stream = randomBytes(8).toString("hex");
  const frames: Array<{ revision: number; projection: unknown }> = [];
  const byStream = projectionBases.get(handle) ?? new Map<string, Array<{ revision: number; projection: unknown }>>();
  byStream.set(stream, frames);
  projectionBases.set(handle, byStream);
  return {
    stream,
    record(revision, projection) {
      frames.push({ revision, projection });
      if (frames.length > PROJECTION_BASE_FRAMES) frames.shift();
    },
    close() {
      frames.splice(0);
      const live = projectionBases.get(handle);
      live?.delete(stream);
      if (live?.size === 0) projectionBases.delete(handle);
    },
  };
}

/** The frame an act request says its tab holds, if this process still has it. */
function heldProjection(req: PanelRequest, handle: string): { id: string; projection: unknown } | null {
  const id = req.headers[PROJECTION_BASE_HEADER];
  const named = readProjectionBaseId(id);
  if (!named || typeof id !== "string") return null;
  const frame = projectionBases.get(handle)?.get(named.stream)?.find((entry) => entry.revision === named.revision);
  return frame ? { id, projection: frame.projection } : null;
}

/**
 * A successful act reply with its projection replaced by a verified patch
 * against the frame the tab holds; unchanged when no exact, smaller patch
 * exists.
 */
function patchedActReply<Reply extends { projection?: unknown }>(
  result: Reply,
  held: { id: string; projection: unknown },
): Reply | (Omit<Reply, "projection"> & { projection_base: string; projection_patch: ProjectionPatchOp[] }) {
  if (!Object.prototype.hasOwnProperty.call(result, "projection")) return result;
  const patch = verifiedProjectionPatch(held.projection, result.projection);
  if (!patch) return result;
  const patchBytes = JSON.stringify(patch).length;
  if (patchBytes > HOSTED_APP_PATCH_COMPARE_BYTES && patchBytes >= JSON.stringify(result.projection).length) return result;
  const { projection: _full, ...rest } = result;
  return { ...rest, projection_base: held.id, projection_patch: patch };
}

/**
 * The verified patch from `previous` to `next`, or null when only a full frame
 * is exact: the patch is applied to the very base it was computed from and the
 * result must serialize like `next`.
 */
export function verifiedProjectionPatch(previous: unknown, next: unknown): ProjectionPatchOp[] | null {
  const patch = diffProjection(previous, next);
  const check = applyProjectionPatch(previous, patch);
  return check.ok && sameProjectionJson(check.value, next) ? patch : null;
}

export function streamHostedApp(
  streams: {
    liveStreams: Map<ServerResponse, { owner: string; credential: string }>;
    eventStreams: Set<ServerResponse>;
  },
  reply: PanelReply,
  bound: {
    principal: SessionPlusPrincipal;
    handle: string;
    service: {
      subscribe(
        handle: string,
        principal: SessionPlusPrincipal,
        listener: (event: InstanceEvent) => void,
      ): InstanceSubscription | null;
    };
  },
  /** `delta`: the client applies `view-patch` frames (see `projection-delta`). */
  options: { delta?: boolean } = {},
): void {
  const { principal, service, handle } = bound;
  let res: ServerResponse | null = null;
  /** Installed after the hijack; a failed write owns the same teardown as socket close. */
  let stopStream: (() => void) | null = null;
  /** A `closed` seen before the hijack cannot end a response that does not exist yet. */
  let ended = false;
  const queued: Array<[string, unknown]> = [];
  let backpressured = false;
  let overflowed = false;
  let backpressureObserved = false;
  /** The projection of the newest accepted `view`; an equal successor is a no-op. */
  let lastProjection: { value: unknown } | null = null;
  /** Monotonic time before which the next `view` frame may not be written. */
  let nextViewAt = 0;
  let viewTimer: NodeJS.Timeout | null = null;
  /** Delta streams: the last frame written, which the client now holds. */
  let deltaBase: { revision: number; projection: unknown } | null = null;
  let patchRefusalObserved = false;
  /** Delta streams: recent frames an act reply may be patched against. */
  let bases: ReturnType<typeof openProjectionBases> | null = null;

  const observeBackpressure = (): void => {
    if (backpressureObserved || !res) return;
    backpressureObserved = true;
    const memory = process.memoryUsage();
    log.warn({
      owner: principal.owner,
      writableLength: res.writableLength,
      heapUsed: memory.heapUsed,
      rss: memory.rss,
    }, "hosted App projection stream fell behind; coalescing full frames");
  };

  const failBoundedQueue = (): void => {
    if (overflowed) return;
    overflowed = true;
    const memory = process.memoryUsage();
    log.warn({
      owner: principal.owner,
      pendingControls: HOSTED_APP_STREAM_PENDING_CONTROL_MAX,
      writableLength: res?.writableLength ?? 0,
      heapUsed: memory.heapUsed,
      rss: memory.rss,
    }, "hosted App projection stream control queue reached its bound; reconnect required");
    if (res && !res.destroyed) res.destroy();
    stopStream?.();
  };

  const enqueue = (event: string, data: unknown): void => {
    if (overflowed) return;
    if (event === "view") {
      if (res && backpressured) observeBackpressure();
      const previous = queued.findIndex(([kind]) => kind === "view");
      if (previous >= 0) queued.splice(previous, 1);
      // A projection replaces the previous one wholesale. Keeping only the
      // newest pending frame is therefore both the protocol semantics and the
      // memory bound; revision guards discard any stale in-flight frame.
      queued.push([event, data]);
      return;
    }
    const controls = queued.reduce((count, [kind]) => count + (kind === "view" ? 0 : 1), 0);
    if (controls >= HOSTED_APP_STREAM_PENDING_CONTROL_MAX) {
      failBoundedQueue();
      return;
    }
    queued.push([event, data]);
  };

  function onDrain(): void {
    backpressured = false;
    flush();
  }

  function writeChunk(chunk: string): void {
    if (!res || res.writableEnded || res.destroyed) {
      stopStream?.();
      return;
    }
    try {
      if (!res.write(chunk)) {
        backpressured = true;
        res.once("drain", onDrain);
      }
    } catch {
      if (!res.destroyed) res.destroy();
      stopStream?.();
    }
  }

  /**
   * One `view` frame: on a delta stream, a verified patch against the frame
   * the client already holds whenever that is exact and smaller; otherwise the
   * full projection, which also (re)establishes the client's base.
   */
  function viewChunk(data: unknown): string {
    if (!options.delta) return `event: view\ndata: ${JSON.stringify(data)}\n\n`;
    const full = (): string => `event: view\ndata: ${JSON.stringify(bases ? { ...(data as object), stream: bases.stream } : data)}\n\n`;
    const frame = data as { revision?: unknown; projection?: unknown };
    const revision = typeof frame.revision === "number" && Number.isSafeInteger(frame.revision) ? frame.revision : null;
    const base = deltaBase;
    deltaBase = revision === null ? null : { revision, projection: frame.projection };
    if (revision !== null) bases?.record(revision, frame.projection);
    if (!base || revision === null || revision <= base.revision) return full();
    const patch = verifiedProjectionPatch(base.projection, frame.projection);
    if (!patch) {
      if (!patchRefusalObserved) {
        patchRefusalObserved = true;
        log.warn({ owner: principal.owner }, "hosted App projection patch did not reproduce its frame; sent the full projection");
      }
      return full();
    }
    const chunk = `event: ${PROJECTION_PATCH_EVENT}\ndata: ${JSON.stringify({ revision, base: base.revision, patch })}\n\n`;
    if (chunk.length <= HOSTED_APP_PATCH_COMPARE_BYTES) return chunk;
    const whole = full();
    return Buffer.byteLength(whole) < Buffer.byteLength(chunk) ? whole : chunk;
  }

  function writeEvent(event: string, data: unknown): void {
    try {
      const chunk = event === "view" ? viewChunk(data) : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      if (event === "view") {
        nextViewAt = performance.now() + Math.max(
          HOSTED_APP_VIEW_MIN_INTERVAL_MS,
          (Buffer.byteLength(chunk) * 1000) / HOSTED_APP_VIEW_BYTES_PER_SECOND,
        );
      }
      writeChunk(chunk);
    } catch {
      if (res && !res.destroyed) res.destroy();
      stopStream?.();
    }
  }

  function finishIfReady(): void {
    if (ended && res && queued.length === 0 && !res.writableEnded && !res.destroyed) res.end();
  }

  /**
   * The queue index that may be written now, or -1. The queue holds at most
   * one `view`; while it waits for its slot, an ordered control behind it
   * pulls it forward and wakes behind it go first.
   */
  function writableIndex(): number {
    if (queued[0][0] !== "view" || performance.now() >= nextViewAt) return 0;
    for (let index = 1; index < queued.length; index += 1) {
      if (queued[index][0] !== "wake") return 0;
    }
    return queued.length > 1 ? 1 : -1;
  }

  function armViewTimer(): void {
    if (viewTimer || !res || backpressured || overflowed || queued.length === 0) return;
    const wait = nextViewAt - performance.now();
    if (wait <= 0) return;
    viewTimer = setTimeout(() => {
      viewTimer = null;
      flush();
    }, Math.ceil(wait));
    viewTimer.unref?.();
  }

  function flush(): void {
    if (!res || backpressured || overflowed) return;
    while (queued.length > 0 && !backpressured && !res.writableEnded && !res.destroyed) {
      const index = writableIndex();
      if (index < 0) break;
      const [[event, data]] = queued.splice(index, 1);
      writeEvent(event, data);
    }
    armViewTimer();
    finishIfReady();
  }

  const send = (event: string, data: unknown): void => {
    if (!res) {
      enqueue(event, data);
      return;
    }
    if (res.writableEnded || res.destroyed) {
      stopStream?.();
      return;
    }
    if (event === "view") {
      const projection = (data as { projection?: unknown }).projection;
      // Compared with the newest ACCEPTED frame, not the last written one: an
      // act reply may have shown this tab a superseded intermediate state, so
      // a later frame equal to an older write must still be delivered.
      if (lastProjection && sameProjectionJson(lastProjection.value, projection)) return;
      lastProjection = { value: projection };
    }
    enqueue(event, data);
    flush();
  };
  const subscription = service.subscribe(handle, principal, (event) => {
    if (event.type === "view") send("view", event);
    else if (event.type === "op") send("op", event);
    else if (event.type === "wake") send("wake", { binding: event.binding, ref: event.ref });
    else if (event.type === "release_available") send("release_available", {
      current_package_digest: event.current_package_digest,
      available_package_digest: event.available_package_digest,
      mode: event.mode,
    });
    else if (event.type === "closed") {
      ended = true;
      send("closed", { reason: event.reason });
      finishIfReady();
    }
  });
  if (!subscription) {
    json(reply, 404, { error: "应用实例不可用" });
    return;
  }
  if (overflowed) {
    subscription.close();
    json(reply, 503, { error: "应用投影流暂时不可用" });
    return;
  }
  res = hijack(reply);
  const stream = res;
  if (options.delta) bases = openProjectionBases(handle);
  let beat: NodeJS.Timeout | null = null;
  const stop = onRawResponseEnd(stream, () => {
    if (beat) {
      clearInterval(beat);
      beat = null;
    }
    if (viewTimer) {
      clearTimeout(viewTimer);
      viewTimer = null;
    }
    bases?.close();
    subscription.close();
    streams.eventStreams.delete(stream);
    streams.liveStreams.delete(stream);
    stream.off("drain", onDrain);
    queued.splice(0);
  });
  stopStream = stop;
  streams.eventStreams.add(res);
  streams.liveStreams.set(res, { owner: principal.owner, credential: principal.credential });
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  writeChunk(": connected\n\n");
  // The snapshot precedes everything its listener saw before the hijack.
  const early = queued.splice(0);
  send("view", subscription.initial);
  if (subscription.releaseAvailable) {
    send("release_available", {
      current_package_digest: subscription.releaseAvailable.current_package_digest,
      available_package_digest: subscription.releaseAvailable.available_package_digest,
      mode: subscription.releaseAvailable.mode,
    });
  }
  for (const [event, data] of early) send(event, data);
  // The instance closed while the reply was still un-hijacked: the goodbye has
  // now been written, so end the response it could not end at the time rather
  // than holding a stream open behind an event that already said it was over.
  if (ended) {
    finishIfReady();
    return;
  }
  if (stream.writableEnded || stream.destroyed) {
    stop();
    return;
  }
  beat = setInterval(() => {
    if (stream.writableEnded || stream.destroyed) {
      stop();
      return;
    }
    // A heartbeat is disposable. Do not append even tiny writes behind a
    // blocked full projection; the pending authoritative frame is enough.
    if (!backpressured) writeChunk(": ping\n\n");
  }, 20_000);
  beat.unref?.();
}

/**
 * The trusted-shell page flow both surfaces share: ask the publisher-trust
 * door, render the consent page when it says no, open one instance per tab,
 * and frame exactly one origin with the per-tab handle in its own data block.
 *
 * The handle is absent from the bootstrap payload, from every URL and from
 * every MessagePort message; its one journey back is the surface's instance
 * header, which the browser cannot attach cross-site. `frame-src` is ONE
 * exact origin, and only on this page: the baseline says `default-src 'none'`
 * with no `frame-src`, so every other page still frames nothing at all — and
 * a wildcard would let any package under the app domain be framed by the
 * trusted shell.
 *
 * Which App, whether it is available, and every page prop stay per-surface:
 * resolving those is the caller's step, and the props arrive as closures.
 */
export async function openHostedAppPage<Opened extends { handle: string }>(
  deps: { appTrust: DashboardAppTrustPort; appPage: PageRenderer["appPage"] },
  reply: PanelReply,
  identity: DashboardIdentity,
  surface: {
    principal: SessionPlusPrincipal;
    release: AppReleaseIdentity;
    viewOrigin: string;
    page: string;
    consentTitle: string;
    appTitle: string;
    consentProps(reason: Extract<AppTrustStatus, { trusted: false }>["reason"]): DashboardPageProps;
    /** Declared shared-scope Apps interpose their membership pages here. */
    beforeOpen?(): boolean | Promise<boolean>;
    open(): Promise<Opened>;
    onOpenError(err: unknown): void;
    openErrorMessage: string;
    appProps(opened: Opened, trustReason: Extract<AppTrustStatus, { trusted: true }>["reason"]): DashboardPageProps;
  },
): Promise<void> {
  const trust = deps.appTrust.status(surface.principal.owner, surface.release);
  if (!trust.trusted) {
    // No iframe exists until the publisher-trust door is answered, so this
    // page deliberately gets no `frame-src` at all.
    deps.appPage(reply, 200, {
      title: surface.consentTitle,
      identity,
      page: surface.page,
      props: surface.consentProps(trust.reason),
    });
    return;
  }
  if (await surface.beforeOpen?.()) return;
  let opened: Opened;
  try {
    opened = await surface.open();
  } catch (err) {
    surface.onOpenError(err);
    json(reply, 503, { error: surface.openErrorMessage });
    return;
  }
  deps.appPage(reply, 200, {
    title: surface.appTitle,
    identity,
    page: surface.page,
    props: surface.appProps(opened, trust.reason),
    appInstance: opened.handle,
    // Media previews use Blob URLs after an authorized resource read. Keep
    // network media and the consent/login surfaces on the deny-all baseline.
    extraCsp: [`frame-src ${surface.viewOrigin}`, "media-src blob:"],
  });
}

// ── Declared Apps: the generic trusted host, for every App that is data ──

/**
 * Which declared App a request is about, and this viewer's principal for it.
 *
 * The app id comes from `?app=` (the page's own address bar; not a secret and
 * not a credential) and is only ever a LOOKUP KEY — never joined onto a path,
 * never used to build an origin. An unknown id is a 404 for the same reason
 * an unlisted route is: on this composition that App does not exist.
 */
function declaredAppEntry(
  ctx: AppViewRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
  appId?: string,
): { surface: DeclaredAppSurface; principal: SessionPlusPrincipal } | null {
  const directory = ctx.opts.declaredApps;
  if (!directory) {
    json(reply, 404, { error: "本进程没有服务任何被声明的 App" });
    return null;
  }
  const wanted = appId ?? panelUrl(req).searchParams.get("app") ?? "";
  const surface = wanted ? directory.get(wanted) : null;
  if (!surface) {
    json(reply, 404, { error: "本进程没有服务这个 App" });
    return null;
  }
  // The one presence rule both surfaces share (`hostedAppPrincipal`), with
  // this surface's own refusal sentence.
  const principal = hostedAppPrincipal(reply, identity, "被声明的 App 只能在真实浏览器登录会话中打开");
  if (!principal) return null;
  return { surface, principal };
}

/** The identity the publisher-trust door is keyed on, for one declared App. */
function declaredAppTrustIdentity(surface: DeclaredAppSurface): AppReleaseIdentity | null {
  if (!surface.packageDigest) return null;
  return {
    appId: surface.stableAppId,
    publisher: surface.publisher,
    profile: "publisher-js",
    packageDigest: surface.packageDigest,
  };
}

/** Entry, plus the trust check and the coordinator this App is driven through. */
function declaredAppBinding(
  ctx: AppViewRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): { surface: DeclaredAppSurface; principal: SessionPlusPrincipal; service: DashboardAppInstancePort; handle: string } | null {
  const entry = declaredAppEntry(ctx, req, reply, identity);
  if (!entry) return null;
  const release = declaredAppTrustIdentity(entry.surface);
  if (!release || !entry.surface.service) {
    json(reply, 503, { error: entry.surface.unavailable ?? "这个 App 当前没有可服务的 release" });
    return null;
  }
  if (!ctx.appTrust.status(entry.principal.owner, release).trusted) {
    json(reply, 403, { error: "请先在可信外层确认发布者与当前 release" });
    return null;
  }
  const raw = req.headers[APP_INSTANCE_HEADER];
  return {
    surface: entry.surface,
    principal: entry.principal,
    service: entry.surface.service,
    handle: typeof raw === "string" ? raw : "",
  };
}

/**
 * `/apps/<id>/open` — the trusted shell around one declared App's Agent View.
 *
 * Everything the browser is told here is either the App's own identity (which
 * is already in the hostname of the frame) or this account's own projection.
 * The per-tab handle rides in its own data block, exactly as Session Plus's
 * does, and the frame's `frame-src` is ONE exact origin.
 */
export async function pageAppOpen(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  // `/apps/<id>/open`, and nothing else under `/apps/`. The surface rule is a
  // prefix so that a path segment can carry the id; this is where the shape is
  // actually decided, and anything else is the 404 the router would have given.
  const match = /^\/apps\/([a-z0-9][a-z0-9-]{0,63})\/open$/.exec(panelUrl(req).pathname);
  if (!match) {
    json(reply, 404, { error: "not found" });
    return;
  }
  const entry = declaredAppEntry(ctx, req, reply, identity, match[1]);
  if (!entry) return;
  const { surface, principal } = entry;
  const release = declaredAppTrustIdentity(surface);
  if (!release || !surface.viewOrigin || !surface.service) {
    json(reply, 503, {
      error: surface.unavailable ?? `${surface.title} 还没有被激活的 release；请在 /apps 安装并激活一个 bundle`,
    });
    return;
  }
  const resourcePermissions = ctx.permissions.effectiveFor({
    subjectType: "app",
    subjectId: surface.stableAppId,
    owner: principal.owner,
    requested: ctx.permissions.declaredOperations("app", surface.stableAppId, principal.owner),
  });
  const app = {
    stableAppId: surface.stableAppId,
    publisher: surface.publisher,
    title: surface.title,
    packageDigest: release.packageDigest,
    viewOrigin: surface.viewOrigin,
    ...(surface.viewUrl ? { viewUrl: surface.viewUrl } : {}),
    resourcePermissions: {
      requestedCount: resourcePermissions.requestedCount,
      grantedCount: resourcePermissions.grantedCount,
      effectiveCount: resourcePermissions.effectiveCount,
    },
  };
  // `?instance=` names WHICH shared partition, exactly as `?app=` names which
  // App: a lookup key from the address bar, never a credential. The grammar is
  // checked before anything is looked up, and an account-scoped App refuses
  // the parameter outright — its state has no instance to name.
  const rawInstance = panelUrl(req).searchParams.get("instance");
  if (rawInstance !== null && !SHARED_INSTANCE_KEY.test(rawInstance)) {
    json(reply, 400, { error: "实例标识格式无效" });
    return;
  }
  const roles = surface.service.sharedRoles();
  const join = surface.service.sharedJoinPolicy();
  if (rawInstance && !roles) {
    json(reply, 400, { error: "这个 App 是按账户隔离的，不接受实例标识" });
    return;
  }
  const service = surface.service;
  const viewOrigin = surface.viewOrigin;
  let selectedInstance = rawInstance ?? undefined;
  let workspace: SharedWorkspaceProps | undefined;
  await openHostedAppPage({ appTrust: ctx.appTrust, appPage: ctx.appPage }, reply, identity, {
    principal,
    release,
    viewOrigin,
    page: "page.appOpen",
    consentTitle: `octopus · 信任 ${surface.title}`,
    appTitle: `octopus · ${surface.title}`,
    // A share link keeps its `?instance=` across the consent reload, so the
    // join page comes next.
    consentProps: (reason) => ({ mode: "consent", app, reason }),
    beforeOpen: async () => {
      if (!roles) return false;
      // The membership rows are read here only to pick WHICH PAGE to render;
      // the door that guards the state itself is `service.open` below, which
      // re-reads them (ADR 0007 P1 — routes write ACL rows, the service is the
      // gatekeeper). Neither of these two pages frames any App code.
      const appId = surface.stableAppId;
      if (appId === RESEARCH_PROGRAM_APP_ID) {
        const directory = await researchWorkspace(ctx, surface, principal, roles, selectedInstance);
        workspace = directory.workspace;
        selectedInstance ??= directory.defaultInstanceKey;
        workspace = {
          ...workspace,
          ...(selectedInstance ? { currentInstanceKey: selectedInstance } : {}),
        };
      }
      if (!selectedInstance) {
        const instances = ctx.store.listSharedAppInstancesFor(appId, principal.owner).map((row) => ({
          instanceKey: row.instance_key,
          ...(appId === RESEARCH_APP ? { title: ctx.store.researchCanvas.projectTitle(row.instance_key) } : { title: surface.service?.sharedInstanceTitle?.(row.instance_key, principal.owner) }),
          createdAt: row.created_at,
          creator: row.creator,
          role: ctx.store.getSharedAppMember(appId, row.instance_key, principal.owner)?.role ?? "",
          members: ctx.store.listSharedAppMembers(appId, row.instance_key).length,
          manageable: row.creator === principal.owner,
          ...(row.creator === principal.owner
            ? {
                memberRows: ctx.store.listSharedAppMembers(appId, row.instance_key).map((member) => ({
                  username: member.username,
                  role: member.role,
                  joinedAt: member.joined_at,
                })),
              }
            : {}),
        }));
        ctx.appPage(reply, 200, {
          title: `octopus · ${surface.title}`,
          identity,
          page: "page.appOpen",
          props: {
            mode: "instances",
            app,
            roles: Object.entries(roles).map(([role, spec]) => ({ role, max: spec.max, observer: spec.observer })),
            instances,
            // Availability metadata, like navigation: the page renders the
            // operator's list, and the server re-decides every mint against it.
            ...(ctx.externalAppHost ? { externalHosts: ctx.externalAppHost.hosts() } : {}),
            ...(workspace ? { workspace } : {}),
          },
        });
        return true;
      }
      const instance = ctx.store.getSharedAppInstance(appId, selectedInstance);
      if (!instance || instance.status !== "open") {
        json(reply, 404, { error: "共享实例不存在或已关闭" });
        return true;
      }
      if (!ctx.store.getSharedAppMember(appId, selectedInstance, principal.owner)) {
        ctx.appPage(reply, 200, {
          title: `octopus · 加入 ${surface.title}`,
          identity,
          page: "page.appOpen",
          props: {
            mode: "join",
            app,
            instanceKey: selectedInstance,
            seats: join ? sharedSeats(ctx, appId, selectedInstance, roles, join) : [],
            ...(workspace ? { workspace } : {}),
          },
        });
        return true;
      }
      return false;
    },
    open: () => service.open(principal, roles && selectedInstance ? { instanceKey: selectedInstance } : {}),
    onOpenError: (err) =>
      log.warn({ err, app: surface.stableAppId, owner: principal.owner }, "could not open a declared App instance"),
    openErrorMessage: `${surface.title} 的后端暂时不可用，请稍后刷新`,
    appProps: (opened, trustReason) => ({
      mode: "app",
      app,
      projection: opened.projection as never,
      trustReason,
      ...(roles && selectedInstance ? { instanceKey: selectedInstance } : {}),
      ...(workspace ? { workspace: refreshCurrentWorkspace(workspace, selectedInstance, opened.projection) } : {}),
    }),
  });
}

/**
 * Trusted project navigation for the first-party research workbench.
 *
 * Store membership decides WHICH instance keys may be considered. The App
 * service then re-asks that door and runs each instance's viewer-scoped
 * projector. Only bounded display fields are extracted. The same-origin shell
 * keeps the full rows for management and may declassify only each URL lookup
 * ref, title and archive state to the Research Program View; roles, membership
 * rows and management authority never cross that boundary.
 */
async function researchWorkspace(
  ctx: AppViewRoutesContext,
  surface: DeclaredAppSurface,
  principal: SessionPlusPrincipal,
  roles: Readonly<Record<string, SessionPlusRoleSpec>>,
  currentInstanceKey?: string,
): Promise<{ workspace: SharedWorkspaceProps; defaultInstanceKey?: string }> {
  if (!surface.service) throw new Error("research workbench service is unavailable");
  const window = sharedInstanceWindow(ctx, surface.stableAppId, principal.owner);
  const { projects, candidates } = await researchProjects(ctx, surface, principal, window.rows);
  // The project this URL names is always in the directory, even when it sits
  // beyond the first window: otherwise a member's own project would render as
  // an invitation and lose its share link and member controls. Membership is
  // re-checked here; a non-member's URL stays an invitation.
  if (currentInstanceKey && !window.rows.some((row) => row.instance_key === currentInstanceKey)
    && ctx.store.getSharedAppMember(surface.stableAppId, currentInstanceKey, principal.owner)) {
    const row = ctx.store.getSharedAppInstance(surface.stableAppId, currentInstanceKey);
    if (row) projects.push(...(await researchProjects(ctx, surface, principal, [row])).projects);
  }
  // The clean-entry default is chosen within the first window (the most
  // recently created projects). Ranking ALL projects would mean projecting
  // every one of them on each page open — Runtime work proportional to the
  // total, which is the cost the window exists to bound. The default is only a
  // convenience: `?instance=` names any project, and every project is reachable
  // through the directory's further windows.
  const defaultInstanceKey = [...candidates].sort((left, right) => {
    // Current, complete work beats a newly-created shell. Archived projects
    // remain reachable but are not a clean-entry default while active work is
    // available. Within the same class, projected activity is more meaningful
    // than the ACL row's creation time.
    const leftRank = (left.archived ? 0 : 2) + (left.ready ? 1 : 0);
    const rightRank = (right.archived ? 0 : 2) + (right.ready ? 1 : 0);
    return rightRank - leftRank
      || researchTimestamp(right.activityAt ?? right.createdAt) - researchTimestamp(left.activityAt ?? left.createdAt)
      || researchTimestamp(right.createdAt) - researchTimestamp(left.createdAt);
  })[0]?.instanceKey;
  return {
    workspace: {
      projects,
      roles: Object.entries(roles).map(([role, spec]) => ({ role, max: spec.max, observer: spec.observer })),
      ...(currentInstanceKey ? { currentInstanceKey } : {}),
      ...(window.nextCursor ? { nextCursor: window.nextCursor } : {}),
      ...(ctx.externalAppHost ? { externalHosts: ctx.externalAppHost.hosts() } : {}),
    },
    ...(defaultInstanceKey ? { defaultInstanceKey } : {}),
  };
}

/**
 * Directory rows for one window of research projects: membership-backed, with
 * only bounded display fields extracted from each viewer-scoped projection.
 * At most one window of keys reaches `readSharedProjections` per call.
 */
async function researchProjects(
  ctx: AppViewRoutesContext,
  surface: DeclaredAppSurface,
  principal: SessionPlusPrincipal,
  bounded: readonly SharedAppInstanceRow[],
): Promise<{
  projects: SharedInstanceSummaryProps[];
  candidates: Array<{ instanceKey: string; archived: boolean; ready: boolean; activityAt?: string; createdAt: string }>;
}> {
  if (!surface.service) throw new Error("research workbench service is unavailable");
  const snapshots = await surface.service.readSharedProjections(
    principal,
    bounded.map((row) => row.instance_key),
  );
  const projections = new Map(snapshots.map((row) => [row.instanceKey, row.projection]));
  const projects: SharedInstanceSummaryProps[] = [];
  const candidates: Array<{
    instanceKey: string;
    archived: boolean;
    ready: boolean;
    activityAt?: string;
    createdAt: string;
  }> = [];
  for (const row of bounded) {
    const projection = projections.get(row.instance_key);
    // Membership is the directory authority; an evicted projection cache is
    // not a deleted project. Opening this row rebuilds its current projection.
    const member = ctx.store.getSharedAppMember(surface.stableAppId, row.instance_key, principal.owner);
    if (!member) continue;
    const display = projection ? researchProjectDisplay(projection)
      : { title: `项目资料待加载 · ${row.created_at.slice(0, 10)}`, archived: false, ready: false, activityAt: undefined };
    projects.push({
      instanceKey: row.instance_key,
      createdAt: row.created_at,
      creator: row.creator,
      role: ctx.store.getSharedAppMember(surface.stableAppId, row.instance_key, principal.owner)?.role ?? "",
      members: ctx.store.listSharedAppMembers(surface.stableAppId, row.instance_key).length,
      title: display.title,
      archived: display.archived,
      ...(display.activityAt ? { activityAt: display.activityAt } : {}),
      manageable: row.creator === principal.owner,
      ...(row.creator === principal.owner
        ? {
            memberRows: ctx.store.listSharedAppMembers(surface.stableAppId, row.instance_key).map((member) => ({
              username: member.username,
              role: member.role,
              joinedAt: member.joined_at,
            })),
          }
        : {}),
    });
    candidates.push({
      instanceKey: row.instance_key,
      archived: display.archived,
      ready: display.ready,
      ...(display.activityAt ? { activityAt: display.activityAt } : {}),
      createdAt: row.created_at,
    });
  }
  return { projects, candidates };
}

function researchProjectDisplay(projection: unknown): {
  title: string;
  archived: boolean;
  ready: boolean;
  activityAt?: string;
} {
  const root = projection && typeof projection === "object" && !Array.isArray(projection)
    ? projection as Record<string, unknown>
    : {};
  const project = root.project && typeof root.project === "object" && !Array.isArray(root.project)
    ? root.project as Record<string, unknown>
    : {};
  const rawTitle = typeof project.title === "string" ? project.title : "";
  const title = rawTitle
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120) || "未命名科研项目";
  const rows = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
  const sessions = rows(root.sessions);
  const documents = rows(root.documents);
  const timestamps = [
    ...rows(root.activity).map((row) => row.at),
    ...sessions.map((row) => row.lastActivity),
    ...documents.map((row) => row.updated_at),
    ...rows(root.workspaces).map((row) => row.updated_at),
  ].filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  const activityAt = timestamps.sort((left, right) => researchTimestamp(right) - researchTimestamp(left))[0];
  const ready = sessions.some((row) => typeof row.session_key === "string" && row.session_key.length > 0)
    && documents.some((row) => typeof row.key === "string" && row.key.length > 0);
  return {
    title,
    archived: project.archived === true,
    ready,
    ...(activityAt ? { activityAt: activityAt.slice(0, 80) } : {}),
  };
}

function researchTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function refreshCurrentWorkspace(
  workspace: SharedWorkspaceProps,
  currentInstanceKey: string | undefined,
  projection: unknown,
): SharedWorkspaceProps {
  if (!currentInstanceKey) return workspace;
  const display = researchProjectDisplay(projection);
  return {
    ...workspace,
    currentInstanceKey,
    projects: workspace.projects.map((row) => row.instanceKey === currentInstanceKey
      ? {
          ...row,
          title: display.title,
          archived: display.archived,
          ...(display.activityAt ? { activityAt: display.activityAt } : {}),
        }
      : row),
  };
}

// ── Shared-scope instances (ADR 0007 P1): ACL rows, not a room system ──
//
// Sharing is an ACL'd state object. These four handlers mint an instance key,
// seat a member, and answer availability; every one of them stops at the
// membership TABLE. Whether a member may actually open or drive the state is
// `AppInstanceService`'s door, which re-reads these rows on every open and
// every dispatch — so nothing here is a second copy of that check, and a bug
// here can render the wrong page, never grant state access. There are no
// invitations, no notifications and no lifecycle beyond `status`: a share
// link (knowing the key, while logged in) IS the invite.

/**
 * Entry, trust and the role table, for the shared-instance routes.
 *
 * The publisher-trust door comes FIRST, exactly as it does for `act` and
 * `stream`: taking a seat publishes your username into the App's shared
 * projection, so nobody holds one before answering "run this publisher's
 * code?" — and the consent page precedes the join page for the same reason.
 */
function declaredSharedApp(
  ctx: AppViewRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
  appId: string,
): {
  surface: DeclaredAppSurface;
  principal: SessionPlusPrincipal;
  roles: Readonly<Record<string, SessionPlusRoleSpec>>;
  join: SharedJoinPolicy;
} | null {
  const entry = declaredAppEntry(ctx, req, reply, identity, appId);
  if (!entry) return null;
  const release = declaredAppTrustIdentity(entry.surface);
  if (!release || !entry.surface.service) {
    json(reply, 503, { error: entry.surface.unavailable ?? "这个 App 当前没有可服务的 release" });
    return null;
  }
  if (!ctx.appTrust.status(entry.principal.owner, release).trusted) {
    json(reply, 403, { error: "请先在可信外层确认发布者与当前 release" });
    return null;
  }
  const roles = entry.surface.service.sharedRoles();
  const join = entry.surface.service.sharedJoinPolicy();
  if (!roles || !join) {
    json(reply, 400, { error: "这个 App 是按账户隔离的，没有共享实例" });
    return null;
  }
  return { surface: entry.surface, principal: entry.principal, roles, join };
}

/**
 * `/api/apps/<id>/shared-instances/<key>/<verb>` — the handler decides the
 * path's shape, exactly as `pageAppOpen` does for its own. The key grammar is
 * refused before any lookup, so a malformed key is a 400 about the request
 * and never a 404 that would read as "no such instance".
 */
function sharedInstanceParams(
  req: PanelRequest,
  reply: PanelReply,
  verb: "join" | "seats" | "member-candidates" | "members" | "members/remove" | "close",
): { appId: string; key: string } | null {
  const match = new RegExp(`^/api/apps/([a-z0-9][a-z0-9-]{0,63})/shared-instances/([^/]{1,128})/${verb}$`).exec(
    panelUrl(req).pathname,
  );
  if (!match) {
    json(reply, 404, { error: "not found" });
    return null;
  }
  if (!SHARED_INSTANCE_KEY.test(match[2]!)) {
    json(reply, 400, { error: "实例标识格式无效" });
    return null;
  }
  return { appId: match[1]!, key: match[2]! };
}

function sharedManagement(ctx: AppViewRoutesContext) {
  return new SharedAppManagement({ store: ctx.store, trust: ctx.appTrust, get: (id) => ctx.opts.declaredApps?.get(id) ?? null });
}

function sharedManagementReply(reply: PanelReply, work: () => Record<string, unknown>): void {
  try { json(reply, 200, { ok: true, ...work() }); }
  catch (error) {
    if (!(error instanceof SharedManagementError)) throw error;
    json(reply, error.status, { ok: false, code: error.code, error: error.message });
  }
}

/** Creator-only administration seam; knowing a share link is not enough. */
function managedSharedApp(
  ctx: AppViewRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
  verb: "member-candidates" | "members" | "members/remove" | "close",
) {
  const params = sharedInstanceParams(req, reply, verb);
  if (!params) return null;
  const shared = declaredSharedApp(ctx, req, reply, identity, params.appId);
  if (!shared) return null;
  try {
    const { instance } = sharedManagement(ctx).managed(shared.principal.owner, params.appId, params.key);
    return { ...params, ...shared, instance };
  } catch (error) {
    if (!(error instanceof SharedManagementError)) throw error;
    json(reply, error.status, { ok: false, code: error.code, error: error.message });
    return null;
  }
}

/**
 * Declared capacity against taken seats — one row per role, in declaration
 * order. `joinable` says whether a share-link visitor may take that seat
 * themselves; the others are assigned by the creator (B5).
 */
function sharedSeats(
  ctx: AppViewRoutesContext,
  appId: string,
  instanceKey: string,
  roles: Readonly<Record<string, SessionPlusRoleSpec>>,
  join: SharedJoinPolicy,
): Array<{ role: string; max: number; observer: boolean; taken: number; joinable: boolean }> {
  const members = ctx.store.listSharedAppMembers(appId, instanceKey);
  return Object.entries(roles).map(([role, spec]) => ({
    role,
    max: spec.max,
    observer: spec.observer,
    taken: members.filter((member) => member.role === role).length,
    joinable: join.joinable.includes(role),
  }));
}

/** POST `/api/apps/<id>/shared-instances` — mint one instance, creator seated. */
function apiAppSharedCreate(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const match = /^\/api\/apps\/([a-z0-9][a-z0-9-]{0,63})\/shared-instances$/.exec(panelUrl(req).pathname);
  if (!match) {
    json(reply, 404, { error: "not found" });
    return;
  }
  const shared = declaredSharedApp(ctx, req, reply, identity, match[1]!);
  if (!shared) return;
  const role = String(bodyOf(req).role ?? "").slice(0, 64);
  sharedManagementReply(reply, () => sharedManagement(ctx).create(shared.principal.owner, shared.surface.stableAppId, role));
}

/**
 * POST `/api/apps/<id>/shared-instances/<key>/join` — take one seat.
 *
 * Idempotent for a current member: re-joining answers 200 with the CURRENT
 * role, whatever the body asked for — a seat is not re-negotiated by
 * clicking a share link twice. Capacity is enforced INSIDE the store's
 * transaction; the reads here only choose which refusal sentence to say,
 * so two racing joins cannot both pass the count.
 *
 * The role is bounded by the server, not taken from the body (B5): the link
 * is the bare instance key, so a visitor may only take the App's
 * least-privileged member role (the default when the body names none) or a
 * role with no more privilege than it. An approver, a first player or a
 * project owner is seated by the creator through member management. A member
 * the creator removed cannot seat themselves again with the same link.
 */
function apiAppSharedJoin(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const params = sharedInstanceParams(req, reply, "join");
  if (!params) return;
  const shared = declaredSharedApp(ctx, req, reply, identity, params.appId);
  if (!shared) return;
  const appId = shared.surface.stableAppId;
  const owner = shared.principal.owner;
  const existing = ctx.store.getSharedAppMember(appId, params.key, owner);
  if (existing) {
    json(reply, 200, { ok: true, instance_key: params.key, role: existing.role, already_member: true });
    return;
  }
  const instance = ctx.store.getSharedAppInstance(appId, params.key);
  if (!instance || instance.status !== "open") {
    json(reply, 404, { ok: false, code: "instance_missing", error: "共享实例不存在或已关闭" });
    return;
  }
  const asked = String(bodyOf(req).role ?? "").slice(0, 64);
  const role = asked || shared.join.defaultRole;
  const spec = shared.roles[role];
  if (!spec) {
    json(reply, 400, { ok: false, code: "unknown_role", error: `角色 ${role || "(空)"} 不在这个 App 的角色表里` });
    return;
  }
  if (!shared.join.joinable.includes(role)) {
    json(reply, 403, { ok: false, code: "role_assigned_by_creator", error: `角色 ${role} 只能由实例创建者分配` });
    return;
  }
  if (ctx.store.isSharedAppMemberRemoved(appId, params.key, owner)) {
    json(reply, 403, { ok: false, code: "membership_removed", error: "你已被移出这个共享实例；如需重新加入，请联系创建者" });
    return;
  }
  if (ctx.store.addSharedAppMember(appId, params.key, owner, role, spec.max, new Date().toISOString())) {
    json(reply, 200, { ok: true, instance_key: params.key, role });
    return;
  }
  // The transaction said no after the reads above said maybe: re-read to
  // name the reason. This account racing itself is still the idempotent 200.
  const raced = ctx.store.getSharedAppMember(appId, params.key, owner);
  if (raced) {
    json(reply, 200, { ok: true, instance_key: params.key, role: raced.role, already_member: true });
    return;
  }
  const now = ctx.store.getSharedAppInstance(appId, params.key);
  if (!now || now.status !== "open") {
    json(reply, 404, { ok: false, code: "instance_missing", error: "共享实例不存在或已关闭" });
    return;
  }
  json(reply, 409, { ok: false, code: "seat_full", error: `角色 ${role} 的席位已满（${spec.max} 个）` });
}

/**
 * GET `/api/apps/<id>/shared-instances` — the viewer's own memberships only.
 * There is deliberately no "all instances of this App" read: an instance is
 * discoverable by being told its key, not by enumeration.
 */
/**
 * GET `/api/apps/:app/shared-instances` — the viewer's memberships, one window
 * at a time (newest first). `next_cursor` is present exactly when more rows
 * follow; pass it back as `?cursor=` for the next window. The research
 * workbench's rows carry the same projection-derived display fields as its
 * page directory, extracted under the same per-window bound.
 */
async function apiAppSharedList(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  const url = panelUrl(req);
  const match = /^\/api\/apps\/([a-z0-9][a-z0-9-]{0,63})\/shared-instances$/.exec(url.pathname);
  if (!match) {
    json(reply, 404, { error: "not found" });
    return;
  }
  const shared = declaredSharedApp(ctx, req, reply, identity, match[1]!);
  if (!shared) return;
  const rawCursor = url.searchParams.get("cursor");
  const before = rawCursor === null ? undefined : parseSharedInstanceCursor(rawCursor);
  if (before === null) {
    json(reply, 400, { error: "cursor 无效；请从第一页重新读取" });
    return;
  }
  const appId = shared.surface.stableAppId;
  const owner = shared.principal.owner;
  const window = sharedInstanceWindow(ctx, appId, owner, before);
  const instances = appId === RESEARCH_PROGRAM_APP_ID
    ? (await researchProjects(ctx, shared.surface, shared.principal, window.rows)).projects.map((row) => ({
        instance_key: row.instanceKey,
        title: row.title,
        created_at: row.createdAt,
        creator: row.creator,
        role: row.role,
        members: row.members,
        manageable: row.manageable === true,
        ...(row.archived ? { archived: true } : {}),
        ...(row.activityAt ? { activity_at: row.activityAt } : {}),
      }))
    : window.rows.map((row) => ({
        instance_key: row.instance_key,
        ...(appId === RESEARCH_APP ? { title: ctx.store.researchCanvas.projectTitle(row.instance_key) } : { title: shared.surface.service?.sharedInstanceTitle?.(row.instance_key, owner) }),
        created_at: row.created_at,
        creator: row.creator,
        role: ctx.store.getSharedAppMember(appId, row.instance_key, owner)?.role ?? "",
        members: ctx.store.listSharedAppMembers(appId, row.instance_key).length,
        manageable: row.creator === owner,
      }));
  json(reply, 200, { ok: true, instances, ...(window.nextCursor ? { next_cursor: window.nextCursor } : {}) });
}

/** GET `…/<key>/seats` — what the join page renders: capacity, taken, me. */
function apiAppSharedSeats(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const params = sharedInstanceParams(req, reply, "seats");
  if (!params) return;
  const shared = declaredSharedApp(ctx, req, reply, identity, params.appId);
  if (!shared) return;
  const appId = shared.surface.stableAppId;
  const instance = ctx.store.getSharedAppInstance(appId, params.key);
  if (!instance || instance.status !== "open") {
    json(reply, 404, { ok: false, code: "instance_missing", error: "共享实例不存在或已关闭" });
    return;
  }
  json(reply, 200, {
    ok: true,
    instance_key: params.key,
    seats: sharedSeats(ctx, appId, params.key, shared.roles, shared.join),
    default_role: shared.join.defaultRole,
    my_role: ctx.store.getSharedAppMember(appId, params.key, shared.principal.owner)?.role ?? null,
  });
}

function apiAppSharedMembers(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const managed = managedSharedApp(ctx, req, reply, identity, "members");
  if (!managed) return;
  json(reply, 200, {
    instance_key: managed.key,
    status: managed.instance.status,
    creator: managed.instance.creator,
    members: ctx.store.listSharedAppMembers(managed.appId, managed.key).map((row) => ({
      username: row.username,
      role: row.role,
      joined_at: row.joined_at,
    })),
  });
}

/**
 * Creator-only, query-bounded account autocomplete.
 *
 * An empty query never enumerates the user directory. The response exposes only
 * the stable username needed by the existing member mutation and one human
 * label already attached to that account; provider ids and external ids stay in
 * the store. Initials are derived from label word boundaries so `lht` can match
 * `Li Hua Ting` without adding a second, hand-maintained search index.
 */
function apiAppSharedMemberCandidates(
  ctx: AppViewRoutesContext,
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
): void {
  const managed = managedSharedApp(ctx, req, reply, identity, "member-candidates");
  if (!managed) return;
  const query = String(panelUrl(req).searchParams.get("q") ?? "").normalize("NFKC").trim().slice(0, 64);
  if (!query) {
    json(reply, 200, { ok: true, candidates: [] });
    return;
  }
  const members = new Set(
    ctx.store.listSharedAppMembers(managed.appId, managed.key).map((row) => row.username),
  );
  const candidates = ctx.store.loadUsers().flatMap((user) => {
    if (members.has(user.username)) return [];
    const displayName = (ctx.store.getSetting(user.username, "display_name") ?? "").trim();
    const labels = [displayName, ...ctx.store.getIdentitiesByUser(user.username)
      .map((row) => row.label?.trim() ?? "")
      .filter(Boolean)].filter(Boolean);
    if (!memberCandidateMatches(query, user.username, labels)) return [];
    return [{ username: user.username, display_name: displayName || labels[0] || user.username }];
  }).sort((left, right) => {
    const needle = lookupText(query);
    const leftStarts = lookupText(left.username).startsWith(needle) ? 0 : 1;
    const rightStarts = lookupText(right.username).startsWith(needle) ? 0 : 1;
    return leftStarts - rightStarts || left.username.localeCompare(right.username);
  }).slice(0, 8);
  json(reply, 200, { ok: true, candidates });
}

function lookupText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function lookupInitials(value: string): string {
  return value.normalize("NFKC").split(/[\s._@-]+/u).filter(Boolean).map((part) => part[0] ?? "").join("")
    .toLocaleLowerCase("en-US");
}

function memberCandidateMatches(query: string, username: string, labels: readonly string[]): boolean {
  const needle = lookupText(query);
  return [username, ...labels].some((value) => {
    const normalized = lookupText(value);
    const compact = normalized.replace(/[\s._@-]+/gu, "");
    return normalized.includes(needle) || compact.includes(needle) || lookupInitials(value).startsWith(needle);
  });
}

function apiAppSharedMemberSet(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const managed = managedSharedApp(ctx, req, reply, identity, "members");
  if (!managed) return;
  const body = bodyOf(req);
  const username = String(body.username ?? "").trim();
  const role = String(body.role ?? "").trim();
  sharedManagementReply(reply, () => sharedManagement(ctx).setMember(managed.principal.owner, managed.appId, managed.key, username, role));
}

function apiAppSharedMemberRemove(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const managed = managedSharedApp(ctx, req, reply, identity, "members/remove");
  if (!managed) return;
  const username = String(bodyOf(req).username ?? "").trim();
  sharedManagementReply(reply, () => sharedManagement(ctx).removeMember(managed.principal.owner, managed.appId, managed.key, username));
}

function apiAppSharedClose(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const managed = managedSharedApp(ctx, req, reply, identity, "close");
  if (!managed) return;
  sharedManagementReply(reply, () => sharedManagement(ctx).close(managed.principal.owner, managed.appId, managed.key));
}

/** The publisher-trust door, for one declared App. */
function apiAppViewTrust(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const entry = declaredAppEntry(ctx, req, reply, identity);
  if (!entry) return;
  const release = declaredAppTrustIdentity(entry.surface);
  if (!release) {
    json(reply, 503, { error: entry.surface.unavailable ?? "这个 App 当前没有可服务的 release" });
    return;
  }
  decideAppTrust(ctx, req, reply, {
    owner: entry.principal.owner,
    release,
    subjectId: entry.surface.stableAppId,
    releaseOwner: (reason) => entry.surface.service?.releaseOwner(entry.principal.owner, reason),
  });
}

/** One bounded proposal from one tab. Only `action` and `params` come from the View. */
async function apiAppViewAct(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): Promise<void> {
  const bound = declaredAppBinding(ctx, req, reply, identity);
  if (!bound) return;
  await actOnHostedApp(req, reply, { kind: "declared", ...bound });
}

function apiAppViewClose(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const bound = declaredAppBinding(ctx, req, reply, identity);
  if (!bound) return;
  closeHostedApp(reply, bound);
}

function apiAppViewStream(ctx: AppViewRoutesContext, req: PanelRequest, reply: PanelReply, identity: DashboardIdentity): void {
  const bound = declaredAppBinding(ctx, req, reply, identity);
  if (!bound) return;
  streamHostedApp(ctx, reply, bound, { delta: wantsProjectionDelta(req) });
}
