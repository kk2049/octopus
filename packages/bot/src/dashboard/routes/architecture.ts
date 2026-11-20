/**
 * `/api/architecture*` — the architecture observatory routes.
 *
 * Mechanically relocated out of `server.ts` (2026-08-11 domain split): same
 * paths, same `authz.ts` rule ids, same status codes and messages.
 */

import { type PanelReply, type PanelRequest, panelUrl, replyJson as json } from "../http.js";
import { COMMITS_LIMIT_MAX, type ArchitectureCommitsCursor } from "../architecture.js";
import { COMMIT_SHA_RE } from "../architecture-evolution.js";
import type { DashboardArchitecturePort } from "../ports.js";
import type { DashboardRouteOptions } from "../server.js";
import type { GuardedRoutes } from "./context.js";
import { clampInt } from "./shared.js";

export interface ArchitectureRoutesContext {
  opts: Pick<DashboardRouteOptions, "architecture">;
}

export function registerArchitectureRoutes(routes: GuardedRoutes, ctx: ArchitectureRoutesContext): void {
  // Job state rides on the GET (`job` is `status()`), the same shape as the
  // secretary's job slot: the page polls one snapshot route, and there is no
  // separate status endpoint to drift from it.
  routes.get("/api/architecture", "api.architecture", (_req, reply) => apiArchitecture(ctx, reply));
  routes.post("/api/architecture/refresh", "api.architecture.refresh", undefined, (_req, reply) =>
    apiArchitectureRefresh(ctx, reply),
  );
  // The evolution reads: commit axis, snapshot manifest, range diff. All are
  // cheap server-local reads (git log / archived snapshot files) — dragging
  // the range NEVER runs the analyzer.
  routes.get("/api/architecture/commits", "api.architecture.commits", (req, reply) =>
    apiArchitectureCommits(ctx, req, reply),
  );
  routes.get("/api/architecture/snapshots", "api.architecture.snapshots", (_req, reply) =>
    apiArchitectureSnapshots(ctx, reply),
  );
  routes.get("/api/architecture/diff", "api.architecture.diff", (req, reply) =>
    apiArchitectureDiff(ctx, req, reply),
  );
}

// ── Architecture observatory ──

function architectureService(ctx: ArchitectureRoutesContext): DashboardArchitecturePort {
  // The route gate 404s these paths when no service is composed, so reaching
  // a handler means one exists. Asserted rather than assumed, for the same
  // reason as `appReleases` below.
  const svc = ctx.opts.architecture;
  if (!svc) throw new Error("architecture routes require a composed ArchitectureService");
  return svc;
}

/** Snapshot + job state in one read; `snapshot` only when one exists. */
async function apiArchitecture(ctx: ArchitectureRoutesContext, reply: PanelReply): Promise<void> {
  const svc = architectureService(ctx);
  const snapshot = await svc.view();
  json(reply, 200, {
    generated: snapshot !== null,
    job: svc.status(),
    ...(snapshot ? { snapshot } : {}),
  });
}

/**
 * Kick the single-slot background re-analysis. 202 when this call started
 * it; 200 + busy when a run is already underway — the second click is not an
 * error, it is told whose run it is waiting on.
 */
function apiArchitectureRefresh(ctx: ArchitectureRoutesContext, reply: PanelReply): void {
  const outcome = architectureService(ctx).refresh();
  if (!outcome.started) {
    json(reply, 200, { ok: false, reason: "busy", running_since: outcome.running_since });
    return;
  }
  json(reply, 202, { ok: true });
}

/**
 * The commit axis for the evolution range selector, one window per request.
 * `head` + `offset` (both from the previous answer) name an older window.
 */
async function apiArchitectureCommits(ctx: ArchitectureRoutesContext, req: PanelRequest, reply: PanelReply): Promise<void> {
  const params = panelUrl(req).searchParams;
  const limit = clampInt(params.get("limit"), 1, COMMITS_LIMIT_MAX, 200);
  const head = params.get("head");
  let cursor: ArchitectureCommitsCursor | undefined;
  if (head !== null) {
    const rawOffset = params.get("offset") ?? "";
    const offset = /^\d+$/.test(rawOffset) ? Number(rawOffset) : Number.NaN;
    if (!COMMIT_SHA_RE.test(head) || !Number.isSafeInteger(offset)) {
      json(reply, 400, { error: "head 必须是 commit SHA，offset 必须是非负整数" });
      return;
    }
    cursor = { head, offset };
  }
  const out = await architectureService(ctx).commits(limit, cursor);
  if ("error" in out) {
    json(reply, 502, out);
    return;
  }
  json(reply, 200, out);
}

/** Every archived analysis plus the live atlas — honestly one on day one. */
async function apiArchitectureSnapshots(ctx: ArchitectureRoutesContext, reply: PanelReply): Promise<void> {
  json(reply, 200, await architectureService(ctx).snapshots());
}

/**
 * Range diff: architecture change from archived snapshots, code change from
 * git. Bad endpoints are the caller's problem (400); a git failure is not.
 */
async function apiArchitectureDiff(ctx: ArchitectureRoutesContext, req: PanelRequest, reply: PanelReply): Promise<void> {
  const params = panelUrl(req).searchParams;
  const from = (params.get("from") ?? "").trim();
  const to = (params.get("to") ?? "").trim();
  const out = await architectureService(ctx).evolutionDiff(from, to);
  if ("error" in out) {
    json(reply, 400, out);
    return;
  }
  json(reply, 200, out);
}
