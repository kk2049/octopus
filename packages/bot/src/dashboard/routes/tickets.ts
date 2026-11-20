/**
 * The dev pipeline surface: tickets, the quota strip, deploy choreography,
 * the human landing door, and the dev agent's loopback tool bridge.
 *
 * Mechanically relocated out of `server.ts` (2026-08-11 domain split): same
 * paths, same `authz.ts` rule ids, same status codes and messages.
 */

import { TicketFileError } from "../../devpipe/ticket-files.js";
import type { ServerResponse } from "node:http";
import { AttachmentUploads, type AttachmentRefusalCode } from "../../attachments/store.js";
import { appTicketChoices } from "../../devpipe/app-scopes.js";
import { LandError, type CliRetrievalReceiptUpload, type LandFailureCode } from "../../devpipe/pipeline.js";
import { dispatchDevpipeTool } from "../../devpipe/tool-dispatch.js";
import { ticketNeedsTrustedDeploy } from "../../devpipe/delivery.js";
import { FABLE_TICKET_APPROVER } from "../../devpipe/ticket-agent-approval.js";
import { createLogger } from "../../logger.js";
// Bot-host transcripts stay direct local scans. codex-runner tickets instead
// ask the pipeline for a trusted-service lease bound to the persisted requester
// and device; the browser never receives a general Runner grant.
import { readSession as scanReadSession, type SessionScanRoot } from "@claude-bot/plugin-sessions/scan";
import {
  DEV_TICKET_MODELS,
  DEV_TICKET_EFFORTS,
  DEV_TICKET_KINDS,
  DEV_TICKET_EFFORT_DEFAULT,
  DEV_TICKET_MODEL_DEFAULT,
  FABLE_TICKET_MODEL,
  localScanSourceForModel,
  offeredTicketModels,
  ticketModelCatalog,
} from "../../devpipe/ticket-models.js";
import type { DevTicketRow, TicketActorKind } from "../../store/repositories/dev-tickets.js";
import type { MergeProposalRow } from "../../store/repositories/merge-proposals.js";
import { authorize } from "../authz.js";
import { type PanelReply, type PanelRequest, bodyOf, panelUrl, replyJson as json } from "../http.js";
import { openLocalTail, openRunnerTail, type TailSource } from "../live.js";
import type {
  DashboardCodexQuotaPort,
  DashboardDevPipelinePort,
  DashboardQuotaPort,
  DashboardRunnerPort,
  DashboardStorePort,
  DashboardSystemStatusPort,
} from "../ports.js";
import { systemStatusHosts } from "../system-status.js";
import { PANEL_BODY_SCHEMAS } from "../schemas.js";
import type { Capabilities, DashboardIdentity, DashboardRouteOptions } from "../server.js";
import type { GuardedRoutes } from "./context.js";
import { clampInt, hijack, promptBudgetRefusal, subjectOf, viewerOf } from "./shared.js";
import { deploymentOrigin, deploymentSource } from "../deployment-origin.js";

const log = createLogger("dashboard");

/**
 * How a ticket write was authenticated (review 6.10), from the identity the
 * gate already resolved — never from the request body. Only a live browser
 * session (cookie + server-side session row) is a person typing in the panel;
 * any bearer, including an agent or script holding someone's key, is `token`;
 * an `mcp_` credential is `mcp`. The no-token loopback mode has no session to
 * attest, so it records `token` too.
 */
export function ticketActorKind(identity: Pick<DashboardIdentity, "session" | "mcpOnly">): TicketActorKind {
  if (identity.mcpOnly) return "mcp";
  return identity.session ? "browser" : "token";
}

function publicTicket<T extends DevTicketRow>(
  ctx: TicketRoutesContext,
  ticket: T,
): Omit<T, "codex_account_slot" | "native_binding"> & {
  execution_owner?: "native_cli";
  codex_account_label?: string;
  runtime_wait?: import("../../resources/suspension.js").ResourceSuspensionView;
  execution_placement?: {
    source: "claude" | "codex" | "omp";
    model_device: string;
    execution_device: string;
    /** Empty = explicitly selected default; absent = account not confirmed. */
    account_label?: string;
  };
} {
  const { codex_account_slot: _privateSlot, native_binding: _nativeBinding, ...projected } = ticket;
  const binding = ctx.store.devTickets.runner.binding(ticket.id);
  // Runner account slots belong to that device, never the Head's account pool.
  // Inventory is already cached public metadata; this read performs no RPC.
  const account = binding?.source === "codex"
    ? ctx.opts.devPipeline?.ticketQuotaHosts?.(ticket.requester)
      ?.find((host) => host.device === binding.device)?.accounts.find((row) => row.id === binding.codexAccount)
    : undefined;
  const label = binding
    ? account?.emailLabel ?? /^codex([a-z])$/.exec(account?.label ?? "")?.[1]
    : typeof ctx.opts.devPipeline?.codexLabelForTicket === "function"
    ? ctx.opts.devPipeline.codexLabelForTicket(ticket)
    : null;
  const wait = ctx.opts.devPipeline?.ticketResourceWait?.(ticket.id);
  return { ...projected, ...(_nativeBinding ? { execution_owner: "native_cli" as const } : {}), ...(wait ? { runtime_wait: wait } : {}), ...(label ? { codex_account_label: label } : {}),
    ...(binding ? { execution_placement: {
      source: binding.source,
      model_device: binding.device,
      execution_device: binding.executionDevice ?? binding.device,
      ...(binding.source === "codex" && (label || binding.codexAccount === "@default")
        ? { account_label: label ?? "" } : {}),
    } } : {}),
  };
}

function ticketScanRoot(ctx: TicketRoutesContext, ticket: DevTicketRow): SessionScanRoot | null {
  const home = ctx.opts.devScanHome;
  if (!home) return null;
  const codexHome = ctx.opts.devPipeline?.codexHomeForTicket(ticket);
  if (codexHome === null) return null;
  return codexHome ? { home, codexHome } : home;
}

export interface TicketRoutesContext {
  store: DashboardStorePort;
  caps: DashboardRunnerPort | undefined;
  opts: Pick<
    DashboardRouteOptions,
    "devPipeline" | "deployService" | "devScanHome" | "appReleases" | "publishPendingAppReleases" | "contribReview"
    | "runnerBundle"
    | "fableTicketApprovals"
  >;
  /** Lazily constructed real probes unless the composition injected one. */
  quotaProbe(): DashboardQuotaPort;
  codexQuotaProbe(): DashboardCodexQuotaPort;
  systemStatusProbe(): DashboardSystemStatusPort;
  startSse(
    req: PanelRequest,
    res: ServerResponse,
    params: URLSearchParams,
    key: string,
    make: () => Promise<{ src: TailSource; intervalMs: number }>,
  ): Promise<void>;
  /** The pre-identity devpipe gate, re-run after parsing for freshness. */
  devpipeGate(req: PanelRequest, reply: PanelReply): DashboardDevPipelinePort | null;
}

export function registerTicketRoutes(routes: GuardedRoutes, ctx: TicketRoutesContext): void {
  routes.get("/api/tickets", "api.tickets", (req, reply, identity) => ticketList(ctx, req, reply, identity));
  routes.post("/api/tickets", "api.tickets", PANEL_BODY_SCHEMAS.ticketCreate, (req, reply, identity) =>
    ticketCreate(ctx, req, reply, identity),
  );
  // One chunk per request, inside the panel's default body window
  // (`ATTACHMENT_CHUNK_BYTES` decoded); a file of any size is several requests.
  let uploads: AttachmentUploads | undefined;
  routes.post(
    "/api/attachments",
    "api.attachments",
    PANEL_BODY_SCHEMAS.attachment,
    (req, reply, identity) => attachmentUpload(ctx, req, reply, identity, (home) => (uploads ??= new AttachmentUploads(home))),
  );
  routes.any("/api/tickets/:id", "api.tickets", (req, reply, identity) => handleTicket(ctx, req, reply, identity));
  routes.any("/api/tickets/:id/:action", "api.tickets", (req, reply, identity) =>
    handleTicket(ctx, req, reply, identity),
  );
  routes.get("/api/dev/quota", "api.dev.quota", async (_req, reply, identity) => {
    // Runner mode reads both providers from the credential-owning devices.
    // Host-local probes remain only for legacy non-Runner deployments.
    const runnerMode = ctx.opts.devPipeline?.usesRunnerTickets?.() === true;
    const owners = identity.username ? [identity.username] : ctx.store.loadUsers().map((user) => user.username);
    const codexHosts = runnerMode ? owners.flatMap((owner) => ctx.opts.devPipeline?.ticketQuotaHosts?.(owner) ?? (ctx.caps?.listDevices(owner) ?? [])
      .filter((device) => device.inventory?.ticket_options?.codex_accounts.length || device.inventory?.ticket_options?.claude_accounts?.length)
      .map((device) => ({ key: JSON.stringify([owner, device.device]), device: device.device,
        label: device.display_name ?? device.device, online: device.online,
        accounts: device.inventory!.ticket_options!.codex_accounts,
        ...(device.inventory!.ticket_options!.claude_accounts ? { claudeAccounts: device.inventory!.ticket_options!.claude_accounts } : {}) }))) : [];
    const empty = { cards: [], fetchedAt: new Date().toISOString(), error: undefined, message: undefined };
    const [claude, codex] = await Promise.all([
      runnerMode ? Promise.resolve(empty) : ctx.quotaProbe().snapshot(),
      runnerMode ? Promise.resolve(empty) : ctx.codexQuotaProbe().snapshot(),
    ]);
    const cards = [...claude.cards, ...codex.cards];
    if (cards.length || codexHosts.length) {
      json(reply, 200, { cards, codexHosts, fetchedAt: claude.fetchedAt });
      return;
    }
    // Both sides empty. Prefer Claude's failure code/message if present,
    // else Codex's — Claude has always been the load-bearing one, and the
    // string ends up in the chip's tooltip so consistency matters.
    const error = claude.error ?? codex.error;
    const message = claude.message ?? codex.message;
    json(reply, 200, { cards: [], fetchedAt: claude.fetchedAt, error, message });
  });
  routes.get("/api/dev/system-status", "api.dev.systemStatus", async (_req, reply) => {
    const main = await ctx.systemStatusProbe().snapshot();
    const devices = ctx.caps
      ? ctx.store.loadUsers().flatMap((user) => ctx.caps!.listDevices(user.username)
          .map((device) => ({ owner: user.username, ...device })))
      : [];
    // Preserve the original top-level fields for already-open browser bundles;
    // new clients use `hosts` for the main + Runner projection.
    json(reply, 200, { ...main, hosts: systemStatusHosts(main, devices) });
  });

  routes.get("/api/deploy", "api.deploy.get", (_req, reply, identity) => deployState(ctx, reply, identity));
  routes.post("/api/deploy/check", "api.deploy.check", PANEL_BODY_SCHEMAS.deploy, async (_req, reply) => {
    try {
      if (!ctx.opts.deployService) return json(reply, 404, { error: "deploy service disabled" });
      return json(reply, 200, { snapshot: await ctx.opts.deployService.checkUpdates() });
    } catch (error) { return json(reply, 400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  routes.get("/api/deploy/active", "api.deploy.active", (_req, reply, identity) => deployActive(ctx, reply, identity));
  routes.post("/api/deploy", "api.deploy.post", PANEL_BODY_SCHEMAS.deploy, (req, reply, identity) =>
    deployTrigger(ctx, req, reply, identity),
  );
  routes.post("/api/deploy/confirm", "api.deploy.confirm", PANEL_BODY_SCHEMAS.deployConfirm, (req, reply, identity) =>
    deployConfirm(ctx, req, reply, identity),
  );
  routes.post("/api/verify/:id", "api.verify", PANEL_BODY_SCHEMAS.verify, (req, reply, identity) =>
    verifyResolve(ctx, req, reply, identity),
  );
  routes.post("/api/land", "api.land", PANEL_BODY_SCHEMAS.land, (req, reply, identity) =>
    handleLand(ctx, req, reply, identity),
  );
  // The review lane's maintainer face (2026-08-20). Reading is `UseDev` in the
  // table; the two verbs are `Deploy` there, so no capability check here — a
  // second copy of the rule is how the two drift apart.
  routes.get("/api/merge-queue", "api.mergeQueue", (_req, reply, identity) => mergeQueueList(ctx, reply, identity));
  routes.post("/api/merge-queue/decide", "api.mergeQueue.decide", PANEL_BODY_SCHEMAS.mergeDecide, (req, reply, identity) =>
    mergeQueueDecide(ctx, req, reply, identity),
  );
  routes.post("/api/merge-queue/run", "api.mergeQueue.run", PANEL_BODY_SCHEMAS.mergeRun, (req, reply, identity) =>
    mergeQueueRun(ctx, req, reply, identity),
  );
}

/**
 * May this viewer see this ticket at all (2026-08-20)?
 *
 * `Contribute` admitted them to the workspace; a full member (`dev`) or the
 * admin sees every row, a contributor only their own. Object-level on purpose:
 * the gate has not read the ticket and must not pretend to have.
 */
export function mayViewTicket(identity: Pick<Capabilities, "admin" | "dev" | "username">, ticket: { requester: string }): boolean {
  return Boolean(identity.admin || identity.dev || (identity.username && identity.username === ticket.requester));
}

/** The slice of a proposal row a ticket roster carries; no CI digests. */
function projectProposal(row: MergeProposalRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    branch: row.branch,
    sha: row.sha,
    pipeline_url: row.pipeline_url,
    mr_url: row.mr_url,
    review_by: row.review_by,
    review_note: row.review_note,
    merge_ticket_id: row.merge_ticket_id,
    merged_sha: row.merged_sha,
    updated_at: row.updated_at,
  };
}

function mergeQueueList(ctx: TicketRoutesContext, res: PanelReply, identity: DashboardIdentity): void {
  const svc = ctx.opts.contribReview;
  if (!svc) {
    json(res, 404, { error: "review lane disabled" });
    return;
  }
  json(res, 200, {
    viewer: viewerOf(identity),
    may_review: authorize(subjectOf(identity), "Deploy", ""),
    proposals: svc.queue(200),
  });
}

function mergeQueueDecide(ctx: TicketRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): void {
  const svc = ctx.opts.contribReview;
  if (!svc) {
    json(res, 404, { error: "review lane disabled" });
    return;
  }
  const body = bodyOf(req);
  const id = Number(body.proposal_id);
  const decision = String(body.decision ?? "");
  if (!Number.isInteger(id) || id <= 0 || (decision !== "approve" && decision !== "reject")) {
    json(res, 400, { error: "proposal_id 与 decision(approve|reject)必填" });
    return;
  }
  const by = identity.username ?? "admin-key";
  const out = svc.decide(id, decision, by, typeof body.note === "string" ? body.note : undefined);
  if (!out.ok) {
    json(res, out.code === "not_found" ? 404 : 409, { error: out.message, code: out.code });
    return;
  }
  log.info({ proposal: id, decision, by }, "merge proposal decided via panel");
  json(res, 200, { ok: true, proposal: out.proposal });
}

function mergeQueueRun(ctx: TicketRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): void {
  const svc = ctx.opts.contribReview;
  if (!svc) {
    json(res, 404, { error: "review lane disabled" });
    return;
  }
  // The batch ticket needs a real requester — it is the person who accepts the
  // merged result. The shared key names nobody, so it cannot file one.
  if (!identity.username) {
    json(res, 400, { error: "批量合并工单需要以个人身份发起,请用自己的 dt_ 密钥登录" });
    return;
  }
  const body = bodyOf(req);
  const raw = body.proposal_ids;
  const ids = Array.isArray(raw)
    ? raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100)
    : undefined;
  const out = svc.runBatch(identity.username, ids);
  if (!out) {
    json(res, 409, { error: "没有已批准的提案可以合并", code: "nothing_approved" });
    return;
  }
  log.info({ ticket: out.ticket.id, proposals: out.proposals.map((p) => p.id), by: identity.username }, "merge batch filed via panel");
  json(res, 200, { ok: true, ticket: publicTicket(ctx, out.ticket), proposals: out.proposals });
}

/**
 * Landing refusals → HTTP. 400 = the request itself is wrong (fix the branch);
 * 409 = the world moved or is busy (retry works); 422 = the request was fine
 * and the code failed its gates (the body carries the log tail).
 */
const LAND_STATUS: Record<LandFailureCode, number> = {
  bad_branch: 400,
  unknown_branch: 400,
  not_ancestor: 400,
  no_commits: 400,
  report_missing: 400,
  report_invalid: 400,
  busy: 409,
  base_moved: 409,
  merge_failed: 409,
  gate_failed: 422,
  land_gate_failed: 422,
};

/**
 * Temporary title used until the ticket agent reads the request and calls
 * `devpipe_rename`. Users describe the work; the agent names it consistently.
 */
export function defaultTicketTitle(now: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `新工单 · ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * Who a new ticket belongs to. Anyone with an account files as themselves;
 * an admin (or the shared key, which has no account of its own) may file on
 * behalf of a real user, who becomes the acceptor.
 * Pure so it's unit-testable; the route supplies store.getUser as hasUser.
 */

export function resolveTicketRequester(
  identity: Capabilities,
  requested: unknown,
  hasUser: (u: string) => boolean,
): { ok: true; requester: string } | { ok: false; error: string } {
  const r = String(requested ?? "").trim();
  if (!r) {
    if (identity.username) return { ok: true, requester: identity.username };
    return { ok: false, error: "管理密钥建单需指定 requester(代提用户,即验收人)" };
  }
  if (!identity.admin && r !== identity.username) {
    return { ok: false, error: "只能以自己的名义提单" };
  }
  if (!hasUser(r)) return { ok: false, error: `requester 不是已知用户: ${r}` };
  return { ok: true, requester: r };
}

/**
 * The dev agent's tool loopback (ticket #12). Auth is the per-turn bearer
 * token alone — it was minted by the pipeline for one turn of one ticket
 * and dies with it, so there is no ambient authority to confuse. Requests
 * may legitimately sit for a whole gate run; nothing here imposes a timeout.
 */
export async function handleDevpipeTool(ctx: TicketRoutesContext, req: PanelRequest, res: PanelReply): Promise<void> {
  // Re-resolve after parsing so a token revoked while bytes were arriving
  // cannot execute. The same helper already ran in onRequest, before parsing.
  const pipe = ctx.devpipeGate(req, res);
  if (!pipe) return;
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const op = String((req.params as { "*"?: string })["*"] ?? "");
  try {
    const result = await dispatchDevpipeTool(pipe, token, op, req.body);
    json(res, result.status, result.body);
  } catch (err) {
    log.error({ err, op }, "devpipe tool op failed");
    json(res, 500, { message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `POST /api/attachments` — one chunk of a pasted or captured file.
 *
 * Everything about WHERE the file goes, what is accepted, how chunks assemble
 * and how long staging lives belongs to `attachments/store.ts`. What is left
 * here is the HTTP shape: map the body onto a chunk, a refusal code onto a
 * status, and say what was staged or stored. A body without chunk fields is a
 * whole file in one chunk, which is what an already-open older page sends.
 */
const ATTACHMENT_STATUS: Readonly<Record<AttachmentRefusalCode, number>> = Object.freeze({
  unsupported_media: 415,
  empty: 400,
  not_base64: 400,
  bad_chunk: 400,
  expired: 410,
  busy: 429,
  size_mismatch: 400,
  disk_full: 507,
  write_failed: 500,
});

async function attachmentUpload(
  ctx: TicketRoutesContext,
  req: PanelRequest,
  res: PanelReply,
  identity: DashboardIdentity,
  uploadsFor: (home: string) => AttachmentUploads,
): Promise<void> {
  const home = ctx.opts.devScanHome;
  if (!home) {
    json(res, 503, { error: "这个部署没有可写的附件目录" });
    return;
  }
  const body = bodyOf(req);
  if (!identity.username) {
    json(res, 403, { error: "上传附件需要已登录账户" });
    return;
  }
  const stored = await uploadsFor(home).accept({
    owner: identity.username,
    uploadId: body.upload_id,
    chunkIndex: body.chunk_index,
    chunkCount: body.chunk_count,
    size: body.size,
    name: body.name,
    mediaType: body.media_type,
    data: body.data,
  });
  if (!stored.ok) {
    if (stored.code === "write_failed" || stored.code === "disk_full") log.error({ by: identity.username, code: stored.code }, "attachment write failed");
    json(res, ATTACHMENT_STATUS[stored.code], { error: stored.message, code: stored.code });
    return;
  }
  if (!stored.complete) {
    json(res, 200, { ok: true, complete: false, upload_id: stored.uploadId, received_bytes: stored.receivedBytes });
    return;
  }
  log.info({ by: identity.username, bytes: stored.attachment.bytes, media_type: stored.attachment.mediaType }, "attachment stored");
  json(res, 200, {
    ok: true,
    complete: true,
    upload_id: stored.uploadId,
    attachment: {
      label: stored.attachment.label,
      path: stored.attachment.path,
      bytes: stored.attachment.bytes,
      media_type: stored.attachment.mediaType,
      sha256: stored.attachment.sha256,
    },
  });
}

function ticketList(ctx: TicketRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): void {
  const pipe = ctx.opts.devPipeline;
  if (!pipe) {
    json(res, 404, { error: "self-hosting pipeline disabled" });
    return;
  }
  // Ticket #16 T3: annotate rows that are parked waiting for the
  // merge lock. Without this, the row glyph misreads "agent spoke,
  // then ended its turn" (submit was queued) as "agent asked and is
  // waiting for you", flashing a false 🙋 on tickets that will
  // auto-wake as soon as the current lander releases the lock.
  const parked = new Set(pipe.lockWaiterIds());
  // A contributor sees their own rows; a member sees the shared workspace.
  const params = panelUrl(req).searchParams;
  const keyword = params.get("q")?.trim() || undefined;
  const requester = params.get("requester")?.trim() || undefined;
  const status = params.get("status")?.trim() || undefined;
  if ((keyword?.length ?? 0) > 200 || (requester?.length ?? 0) > 64
    || (status && !["open", "landed", "completed", "cancelled"].includes(status))) {
    json(res, 400, { error: "invalid ticket search filters" });
    return;
  }
  const limit = clampInt(params.get("limit"), 1, 200, 200);
  const offset = clampInt(params.get("offset"), 0, 1_000_000, 0);
  const matches = ctx.store.devTickets.listDevTickets(limit + 1, {
    query: keyword, requester, status, offset,
    // Apply visibility BEFORE pagination, so older own tickets remain findable.
    ...(!identity.admin && !identity.dev ? { owner: identity.username ?? "" } : {}),
  }).filter((r) => mayViewTicket(identity, r));
  const rows = matches.slice(0, limit);
  // The newest proposal per ticket rides along so the row glyph can say
  // "waiting for CI / for review / merged" without a second request.
  const proposals = ctx.store.mergeProposals.latestByTicket();
  const tickets = rows.map((r) => ({
    ...publicTicket(ctx, r),
    ...(parked.has(r.id) ? { parked_for_lock: true } : {}),
    proposal: projectProposal(proposals.get(r.id)),
  }));
  json(res, 200, {
    viewer: viewerOf(identity),
    // Account-scoped accounting rides on the roster the tickets page already
    // owns. Never return a holder's references to a different viewer, and do
    // not expose the underlying ticket/session ids even to the holder.
    ...(identity.username
      ? {
          credit_account: {
            balance: ctx.store.credits.balance(identity.username),
            entries: ctx.store.credits.list(identity.username, 8).map((entry) => ({
              id: entry.id,
              delta: entry.delta,
              reason: entry.reason,
              ref_kind: entry.ref_kind,
              created_at: entry.created_at,
            })),
          },
        }
      : {}),
    // What a ticket filed by THIS viewer will do when its agent submits, so
    // the composer can say "this will go through review" up front.
    viewer_lane: identity.dev || identity.admin ? "direct" : "review",
    may_review: authorize(subjectOf(identity), "Deploy", ""),
    // Whether this composition serves the review queue at all; the page asks
    // for it only when it exists, so a deployment without the lane never sees
    // a 404 it did not cause.
    review_lane: Boolean(ctx.opts.contribReview),
    // Only the account-less shared key needs to pick one (ticket #15).
    requester_choices: identity.username ? [] : ctx.store.loadUsers().map((u) => u.username),
    counts: ctx.store.devTickets.countDevTickets(),
    spec_concurrency: pipe.specConcurrency,
    base_branch: pipe.baseBranch,
    merge_lock_holder: pipe.mergeLockHolder(),
    // The background suite's last word on the watermark (post-submit model,
    // 2026-08-09). Served on THIS roster rather than behind a route of its
    // own for the same reason the App list is: filing and fixing tickets
    // needs `dev`, and a red batch is work for exactly those people. A new
    // route would have meant a new authz rule for a read that carries no
    // authority — it is a status line, and the ticket it opened is the thing
    // with teeth.
    test_batch: testBatchStatus(ctx.store),
    execution_choices: Object.fromEntries((identity.username ? [identity.username] : ctx.store.loadUsers().map((u) => u.username))
      .flatMap((owner) => { const options = pipe.ticketExecutionChoices(owner); return options ? [[owner, options]] : []; })),
    models: offeredTicketModels(pipe.usesRunnerTickets()),
    // Labels and routing family for every catalogued id, including retired ids
    // persisted tickets still carry. The browser keeps no model table.
    model_catalog: ticketModelCatalog(),
    efforts: [...DEV_TICKET_EFFORTS],
    model_default: DEV_TICKET_MODEL_DEFAULT,
    effort_default: DEV_TICKET_EFFORT_DEFAULT,
    kinds: [...DEV_TICKET_KINDS],
    // What `kind: "app"` may be filed against. Served here rather than from
    // `/api/apps` on purpose: that route is admin-only (it manages releases),
    // while filing a ticket only needs `dev` — asking the panel to read it
    // would 403 for exactly the people who file most tickets. This list is
    // path metadata from a source-code table, so it carries no authority.
    //
    // `served` is the one runtime fact worth adding: an App this process does
    // not host can still be ticketed (the code lands on the base branch), but
    // nothing here will republish it, so the picker can say so up front.
    apps: appTicketChoices().map((choice) => ({
      ...choice,
      served: ctx.opts.appReleases?.app(choice.id) != null,
    })),
    tickets,
    has_more: matches.length > limit,
  });
}

async function ticketCreate(
  ctx: TicketRoutesContext,
  req: PanelRequest,
  res: PanelReply,
  identity: DashboardIdentity,
): Promise<void> {
  const pipe = ctx.opts.devPipeline;
  if (!pipe) {
    json(res, 404, { error: "self-hosting pipeline disabled" });
    return;
  }
  const body = bodyOf(req);
  const who = resolveTicketRequester(identity, body.requester, (u) => Boolean(ctx.store.getUser(u)));
  if (!who.ok) {
    json(res, 400, { error: who.error });
    return;
  }
  const requester = who.requester;
  // Never silently cut it: the one bound is the session prompt budget its
  // first turn must fit, checked in bytes and refused with exact numbers.
  const originalInput = String(body.body ?? "");
  const desc = originalInput.trim();
  const overBudget = promptBudgetRefusal("工单正文", originalInput);
  if (overBudget) {
    json(res, 413, { error: overBudget });
    return;
  }
  // Filing captures the human need, not an implementation/deployment guess.
  // Discussion has a separate explicit entry point; every implementation
  // request starts as a simple agent task and is classified from its final
  // diff by devpipe_submit. Old clients may still send kind/app_id, but those
  // technical selectors are intentionally ignored.
  const kind = body.kind === "discuss" ? "discuss" : "simple";
  if (!desc) {
    json(res, 400, { error: "body 必填" });
    return;
  }
  const title = defaultTicketTitle(new Date());
  const model = typeof body.model === "string" && DEV_TICKET_MODELS.has(body.model)
    ? body.model
    : DEV_TICKET_MODEL_DEFAULT;
  const effort = typeof body.effort === "string" && DEV_TICKET_EFFORTS.has(body.effort)
    ? body.effort
    : DEV_TICKET_EFFORT_DEFAULT;
  const parentRaw = Number(body.parent_ticket_id);
  const parentTicketId = Number.isFinite(parentRaw) && parentRaw > 0 ? parentRaw : undefined;
  try {
    if (model === FABLE_TICKET_MODEL) {
      if (body.agent_source || body.workspace) { json(res, 400, { error: "Fable 审批入口暂不支持自选 Runner" }); return; }
      const approvals = ctx.opts.fableTicketApprovals;
      if (!approvals) {
        json(res, 503, { error: "Fable 工单审批服务未启用；该模型不会直接启动" });
        return;
      }
      const outcome = await approvals.request({
        actor: identity.username ?? "admin-key",
        credential: identity.credential,
        originalInput,
        ticket: {
          title,
          body: desc,
          requester,
          kind,
          model,
          effort,
          ...(parentTicketId ? { parent_ticket_id: parentTicketId } : {}),
          via: "web",
          actor_kind: ticketActorKind(identity),
        },
      });
      if (outcome.status === "approval_required") {
        json(res, 202, {
          ok: false,
          approval_required: true,
          pending_call_id: outcome.pendingCallId,
          message: `Fable 工单已提交 ${FABLE_TICKET_APPROVER} 审批；批准后才会创建并启动。`,
        });
        return;
      }
      if (outcome.status !== "succeeded") {
        const status = outcome.status === "denied" ? 403 : outcome.status === "unknown" ? 504 : 502;
        json(res, status, { error: outcome.reason, outcome: outcome.status });
        return;
      }
      const id = Number((outcome.result as { ticket_id?: unknown } | null)?.ticket_id);
      const approvedTicket = Number.isSafeInteger(id) ? ctx.store.devTickets.getDevTicket(id) : undefined;
      if (!approvedTicket) {
        json(res, 502, { error: "Fable 工单已获准，但创建结果无法确认" });
        return;
      }
      log.info({ id: approvedTicket.id, requester: approvedTicket.requester, by: identity.username ?? "admin-key" }, "Fable dev ticket created");
      json(res, 200, { ok: true, ticket: publicTicket(ctx, approvedTicket) });
      return;
    }
    const t = pipe.createTicket({
      agent_source: typeof body.agent_source === "string" ? body.agent_source : undefined,
      workspace: typeof body.workspace === "string" ? body.workspace : undefined,
      title,
      body: desc,
      requester,
      kind,
      model,
      effort,
      ...(parentTicketId ? { parent_ticket_id: parentTicketId } : {}),
      via: "web",
      actor_kind: ticketActorKind(identity),
    });
    log.info({ id: t.id, requester: t.requester, by: identity.username ?? "admin-key", title: t.title, actor_kind: t.actor_kind }, "Dev ticket created");
    json(res, 200, { ok: true, ticket: publicTicket(ctx, t) });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * One ticket: `/api/tickets/:id` and `/api/tickets/:id/:action`.
 *
 * The id and the action are re-checked against the SAME patterns the router
 * used to be given as one regular expression, so `/api/tickets/abc` stays a
 * plain "not found" rather than becoming a lookup for ticket `NaN`.
 */
async function handleTicket(ctx: TicketRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): Promise<void> {
  const pipe = ctx.opts.devPipeline;
  if (!pipe) {
    json(res, 404, { error: "self-hosting pipeline disabled" });
    return;
  }
  const url = panelUrl(req);
  const params = req.params as { id?: string; action?: string };
  const action = params.action;
  if (!/^\d+$/.test(String(params.id ?? "")) || (action !== undefined && !/^[a-z-]+$/.test(action))) {
    json(res, 404, { error: "not found" });
    return;
  }
  const id = Number(params.id);
  const ticket = ctx.store.devTickets.getDevTicket(id);
  if (!ticket) {
    json(res, 404, { error: `工单不存在: #${id}` });
    return;
  }
  if (!mayViewTicket(identity, ticket)) {
    json(res, 403, { error: "这不是你的工单;贡献者只能查看和操作自己提交的工单" });
    return;
  }
  const mayManage = identity.admin || identity.username === ticket.requester;

  if (req.method === "GET" && action === undefined) {
    json(res, 200, {
      ticket: { ...publicTicket(ctx, ticket), proposal: projectProposal(ctx.store.mergeProposals.latestForTicket(id)) },
      messages: ctx.store.devTickets.listTicketMessages(id),
    });
    return;
  }
  if (req.method === "GET" && action === "files") {
    try {
      const offset = url.searchParams.get("offset");
      const cursor = url.searchParams.get("cursor");
      json(res, 200, await pipe.readTicketFiles(ticket, url.searchParams.get("path") ?? "", {
        ...(offset !== null && offset !== "" ? { offset: Number(offset) } : {}),
        ...(cursor ? { cursor } : {}),
      }));
    } catch (error) {
      json(res, error instanceof TicketFileError ? error.status : 500, {
        error: error instanceof TicketFileError ? error.message : "无法读取工单源码",
      });
    }
    return;
  }
  if (req.method === "GET" && action === "session") {
    await readTicketSession(ctx, res, ticket, url);
    return;
  }
  if (req.method === "GET" && action === "live") {
    const sid = ticket.session_id;
    if (!sid) {
      json(res, 503, { error: "尚无可跟随的会话" });
      return;
    }
    // The ticket is the authority for the CLI family. Never accept a source
    // from the browser: that would let a caller bind this trusted route to an
    // arbitrary same-id transcript in another CLI namespace.
    const source = ctx.opts.devPipeline?.usesRunnerTickets?.() ? null : localScanSourceForModel(ticket.model);
    if (!source) {
      const lease = ctx.opts.devPipeline?.openRemoteTicketTranscript(ticket, `dashboard-ticket/${ticket.id}/live`);
      if (!lease) {
        json(res, 503, { error: "工单绑定的 Runner 设备不可用,无法跟随 transcript" });
        return;
      }
      const key = JSON.stringify(["dev-remote", ticket.requester, lease.device, sid]);
      const stream = hijack(res);
      let sourceOwnsLease = false;
      // LiveRegistry may reuse an existing tailer and never call `make`. In
      // that case this request's just-opened lease is redundant and must die
      // with this response rather than leaking a capability Context.
      stream.on("close", () => {
        if (!sourceOwnsLease) lease.close();
      });
      await ctx.startSse(req, stream, url.searchParams, key, async () => {
        const tail = openRunnerTail((_method, args) => lease.read({
          maxMessages: Number(args.max_messages ?? 500),
          ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
        }), "codex", sid);
        sourceOwnsLease = true;
        return {
          src: {
            fetch: () => tail.fetch(),
            close: () => {
              tail.close();
              lease.close();
            },
          },
          intervalMs: 4000,
        };
      });
      return;
    }
    const scanRoot = ticketScanRoot(ctx, ticket);
    if (!scanRoot) {
      json(res, 503, { error: "devScanHome 未配置" });
      return;
    }
    await ctx.startSse(req, hijack(res), url.searchParams, `dev|${sid}`, async () => ({
      src: await openLocalTail(scanRoot, source, sid),
      intervalMs: 2000,
    }));
    return;
  }

  if (req.method !== "POST") {
    json(res, 404, { error: "not found" });
    return;
  }
  // An administrator (or dev member) acting on somebody else's ticket: the
  // actor goes on the record even for actions whose pipeline call takes none.
  if (identity.username !== ticket.requester) {
    log.info({ ticket: id, requester: ticket.requester, by: identity.username ?? "admin-key", action }, "Ticket action by another account");
  }
  // `dismiss-question` joins `deploy-mark` on the CLI report's short allowlist
  // (#236): a repair route can park a question on a landed CLI entry too, and
  // taking that prompt back off the board is not "further work on the report" —
  // it starts no turn and writes nothing but the note saying who closed it.
  if (ticket.native_binding && action === "close-native") {
    if (!mayManage) { json(res, 403, { error: "只有绑定者或管理员可结束跟踪" }); return; }
    json(res, 200, { ok: true, ticket: publicTicket(ctx, ctx.store.devTickets.closeNativeTicket(id, identity.username ?? "admin")) });
    return;
  }
  if (ticket.native_binding && ["message", "interrupt"].includes(action ?? "")) {
    if (!mayManage) { json(res, 403, { error: "只有绑定者或管理员可控制此原生 CLI" }); return; }
    try {
      const text = action === "message" ? String(bodyOf(req).body ?? "").trim() : undefined;
      const input = await pipe.nativeTicketInput(ticket, identity.username ?? "admin", text, ticketActorKind(identity));
      const message = input.messageId ? ctx.store.devTickets.listTicketMessages(ticket.id).find(row => row.id === input.messageId) : undefined;
      json(res, 200, { ok: true, input, ...(message ? { message } : {}) });
    } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
    return;
  }
  if ((ticket.kind === "cli" || ticket.native_binding) && action !== "deploy-mark" && action !== "dismiss-question") {
    json(res, 400, { error: "CLI 简报是只读交付记录；后续工作请新建工单或新的 CLI 简报" });
    return;
  }
  try {
    switch (action) {
      case "message": {
        const body = bodyOf(req);
        // Never silently cut a person's message; the only bound is the shared
        // session prompt budget the Runner enforces anyway.
        const text = String(body.body ?? "").trim();
        if (!text) {
          json(res, 400, { error: "body 必填" });
          return;
        }
        const overBudget = promptBudgetRefusal("消息", text);
        if (overBudget) {
          json(res, 413, { error: overBudget });
          return;
        }
        const author = identity.username ?? "admin";
        json(res, 200, { ok: true, message: pipe.postMessage(id, author, "web", text, ticketActorKind(identity)) });
        return;
      }
      case "approve-spec": {
        if (!mayManage) {
          json(res, 403, { error: "只有提单人(或管理密钥)可确认方案" });
          return;
        }
        json(res, 200, { ok: true, ticket: publicTicket(ctx, pipe.approveSpec(id, identity.username, ticketActorKind(identity))) });
        return;
      }
      case "complete": {
        if (!mayManage) {
          json(res, 403, { error: "只有提单人(或管理密钥)可标记完成" });
          return;
        }
        json(res, 200, { ok: true, ticket: publicTicket(ctx, pipe.completeTicket(id, identity.username)) });
        return;
      }
      case "requeue": {
        if (!mayManage) {
          json(res, 403, { error: "只有提单人(或管理密钥)可重排" });
          return;
        }
        json(res, 200, { ok: true, ticket: publicTicket(ctx, pipe.requeue(id, identity.username, ticketActorKind(identity))) });
        return;
      }
      case "kind": {
        if (!mayManage) {
          json(res, 403, { error: "只有提单人(或管理密钥)可改工单类型" });
          return;
        }
        const body = bodyOf(req);
        if (body.kind === "app") {
          json(res, 400, {
            error: "App/整机不是提单类型；Agent 在 devpipe_submit 时按最终 diff 声明，上线系统再做精确兜底检查。",
          });
          return;
        }
        json(res, 200, {
          ok: true,
          ticket: publicTicket(
            ctx,
            pipe.setKind(id, String(body.kind ?? "")),
          ),
        });
        return;
      }
      case "cancel": {
        if (!mayManage) {
          json(res, 403, { error: "只有提单人(或管理密钥)可取消" });
          return;
        }
        json(res, 200, { ok: true, ticket: publicTicket(ctx, pipe.cancel(id)) });
        return;
      }
      // Ticket #236: "I am not going to answer this." Same bar as cancel — it
      // silences a prompt addressed to the requester — but it is available in
      // every dev_status, because a landed ticket is exactly where an
      // unanswered question outlives its usefulness and cancel is refused.
      case "dismiss-question": {
        if (!mayManage) {
          json(res, 403, { error: "只有提单人(或管理密钥)可关闭未决问题" });
          return;
        }
        json(res, 200, { ok: true, ticket: publicTicket(ctx, pipe.dismissQuestion(id, identity.username)) });
        return;
      }
      // Stopping the running turn is not cancelling the ticket (#184), but it
      // steers the same agent, so it takes the same bar: the requester or the
      // admin key. The pipeline refuses when there is no turn to stop.
      case "resume": {
        if (!mayManage) {
          json(res, 403, { error: "只有提单人或管理员可继续工单" });
          return;
        }
        json(res, 200, { ok: true, ticket: publicTicket(ctx, pipe.resumeTurn(id, identity.username, ticketActorKind(identity))) });
        return;
      }
      case "interrupt": {
        if (!mayManage) {
          json(res, 403, { error: "只有提单人(或管理密钥)可停止当前轮次" });
          return;
        }
        json(res, 200, { ok: true, ticket: publicTicket(ctx, pipe.interruptTurn(id, identity.username)) });
        return;
      }
      case "deploy-mark": {
        if (!mayManage) {
          json(res, 403, { error: "只有提单人(或管理密钥)可标记部署状态" });
          return;
        }
        const body = bodyOf(req);
        const next = String(body.next ?? "");
        if (next !== "live_unverified" && next !== "verified" && next !== "reverted") {
          json(res, 400, { error: `无效的部署状态: ${next}` });
          return;
        }
        json(res, 200, { ok: true, ticket: publicTicket(ctx, pipe.markDeploy(id, next)) });
        return;
      }
      default:
        json(res, 404, { error: "not found" });
        return;
    }
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Deploy choreography endpoints. Reading state and confirming liveness are
 * open to every logged-in identity (the confirmation gate verifies "the
 * system is alive AND someone can reach it", not authority); triggering
 * respects the deployers whitelist; verification is assignee-or-admin.
 */
function deployActive(ctx: TicketRoutesContext, res: PanelReply, identity: DashboardIdentity): void {
  const svc = ctx.opts.deployService;
  if (!svc) {
    json(res, 404, { error: "deploy service disabled" });
    return;
  }
  // Tiny payload for the shell banner poll.
  const active = ctx.store.devTickets.getActiveDeployIntent();
  json(res, 200, {
    confirm_wait: active?.status === "confirm_wait",
    intent_id: active?.id ?? null,
    status: active?.status ?? null,
    deadline: active?.confirm_deadline ?? null,
    origin: deploymentOrigin(active ?? ctx.store.devTickets.listDeployIntents(1)[0], identity),
  });
}

async function deployState(ctx: TicketRoutesContext, res: PanelReply, identity: DashboardIdentity): Promise<void> {
  const svc = ctx.opts.deployService;
  if (!svc) {
    json(res, 404, { error: "deploy service disabled" });
    return;
  }
  const appTitles = new Map(appTicketChoices().map((app) => [app.id, app.title]));
  const runnerHealth = ctx.opts.runnerBundle?.health() ?? null;
  const releases = await svc.releaseCatalogStatus();
  json(res, 200, {
    viewer: viewerOf(identity),
    may_deploy: identity.deploy,
    may_publish_apps: identity.admin && Boolean(ctx.opts.publishPendingAppReleases),
    base_branch: svc.baseBranch,
    ingress: await svc.ingressStatus(),
    deployed_sha: await svc.runningSha(),
    releases,
    preparation: await svc.preparationStatus(releases?.snapshot?.ready?.sha),
    stable_branch: svc.stableBranch,
    active: publicDeploy(ctx.store.devTickets.getActiveDeployIntent(), identity),
    recent: ctx.store.devTickets.listDeployIntents(8).map((row) => publicDeploy(row, identity)),
    // App debt shares the card so the operator sees one production queue, but
    // App-only debt has its own Administer action and does not trigger a trusted
    // code rebuild/restart.
    app_releases_pending: ctx.store.appCatalog.listPendingAppReleases().map((row) => ({
      app_id: row.app_id,
      title: appTitles.get(row.app_id) ?? row.app_id,
      commit_sha: row.commit_sha,
      ticket_id: row.ticket_id,
    })),
    // The supervisor can finish its health gate before the deliberately
    // asynchronous after-start App drain. Project that in-flight fact so the
    // browser never presents the same debt as a second hot-publish action.
    app_release_drain: ctx.opts.devPipeline?.appReleaseDrainState?.() ?? {
      active: false,
      mode: null,
    },
    runner_bundle: {
      active_sha: runnerHealth?.activeSha ?? null,
      previous_sha: runnerHealth?.previousSha ?? null,
      healthy: runnerHealth?.ok ?? false,
      health_error: runnerHealth?.error ?? null,
      pending: ctx.store.runnerArtifacts.listPending().map((row) => ({
        ticket_id: row.ticket_id,
        commit_sha: row.commit_sha,
        requested_at: row.requested_at,
        candidate_sha: row.candidate_sha,
        last_attempt_at: row.last_attempt_at,
        last_error: row.last_error,
      })),
      recent: ctx.store.runnerArtifacts.listAudit(5),
    },
    // Per-deploy rows stay immutable audit records. The panel gets one
    // snapshot-anchored block so a backlog is accepted with one deliberate
    // click, without sweeping in a deployment that finalized after the read.
    // The block quotes other tickets' titles and acceptance criteria, which is
    // member material: a contributor (2026-08-20) sees the deploy axis but not
    // the workspace's checklist.
    verify_open: identity.dev || identity.admin ? (ctx.store.devTickets.getOpenVerifyBlock() ?? null) : null,
  });
}

async function deployTrigger(ctx: TicketRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): Promise<void> {
  const svc = ctx.opts.deployService;
  if (!svc) {
    json(res, 404, { error: "deploy service disabled" });
    return;
  }
  const who = identity.username ?? "admin";
  // `Deploy` in the route table; the gate already refused everyone else.
  const body = bodyOf(req);
  const target = typeof body.target === "string" && body.target.trim() ? body.target : undefined;
  const hasTrustedBacklog = ctx.store.devTickets.listTicketsByDeployStatus(["pending"]).some((ticket) =>
    ticketNeedsTrustedDeploy(ticket) && ticket.dev_status === "landed");
  const hasRunnerBacklog = ctx.store.runnerArtifacts.listPending().length > 0;
  if (!target && !hasTrustedBacklog && !hasRunnerBacklog && ctx.store.appCatalog.listPendingAppReleases().length > 0) {
    json(res, 409, {
      error: "当前只有 App 待发布，请使用“热发布 App（不重启）”；没有需要重建或重启的可信代码。",
      code: "app_only_pending",
    });
    return;
  }
  try {
    const source = deploymentSource(body.source, identity, (id) => ctx.store.devTickets.getDevTicket(id));
    const digest = typeof body.manifest_sha256 === "string" ? body.manifest_sha256 : undefined;
    const intent = await svc.trigger(who, target, source, target && digest ? { sha: target, manifestSha256: digest } : undefined);
    json(res, 200, { ok: true, intent });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

function publicDeploy(row: import("../../store/repositories/dev-tickets.js").DeployIntentRow | undefined, identity: DashboardIdentity) {
  if (!row) return null;
  const { trigger_source: _source, ...rest } = row;
  return { ...rest, origin: deploymentOrigin(row, identity) };
}

function deployConfirm(ctx: TicketRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): void {
  const svc = ctx.opts.deployService;
  if (!svc) {
    json(res, 404, { error: "deploy service disabled" });
    return;
  }
  const who = identity.username ?? "admin";
  const body = bodyOf(req);
  const intentId = Number(body.intent_id);
  const decision = String(body.decision ?? "");
  if (!Number.isFinite(intentId) || (decision !== "alive" && decision !== "rollback")) {
    json(res, 400, { error: "intent_id 与 decision(alive|rollback)必填" });
    return;
  }
  // Two different acts behind one endpoint, so two different bars.
  //
  // "alive" is deliberately wide: its whole meaning is "a human reached the
  // public entrance after the restart", and the more people who can supply
  // that evidence the better the dead-man switch works.
  //
  // "rollback" is a production change — it checks the previous sha out and
  // restarts. That is the `deploy` capability, exactly like triggering the
  // release was. Before this, the outer gate only asked for `dev`, which is
  // the shared read grant on the ticket workspace: anyone who could watch
  // the pipeline could also revert it.
  if (decision === "rollback" && !authorize(subjectOf(identity), "Deploy", "")) {
    json(res, 403, { error: "回滚是上线权限:请让管理员在 /admin 授予 deploy" });
    return;
  }
  const ok = svc.decide(intentId, decision, who);
  json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "不在确认窗口内(已超时/已确认)" });
}

async function verifyResolve(ctx: TicketRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): Promise<void> {
  const svc = ctx.opts.deployService;
  if (!svc) {
    json(res, 404, { error: "deploy service disabled" });
    return;
  }
  const who = identity.username ?? "admin";
  const raw = String((req.params as { id?: string }).id ?? "");
  if (!/^\d+$/.test(raw)) {
    json(res, 404, { error: "not found" });
    return;
  }
  const id = Number(raw);
  const row = ctx.store.devTickets.getOpenVerifyBlock(id);
  if (!row || row.id !== id) {
    json(res, 404, { error: `验证工单不存在: #${id}` });
    return;
  }
  const assignees = JSON.parse(row.assignees) as string[];
  if (!identity.admin && !assignees.includes(who)) {
    json(res, 403, { error: "只有验证工单的负责人(或管理密钥)可判定" });
    return;
  }
  const body = bodyOf(req);
  const result = String(body.result ?? "");
  if (result !== "passed" && result !== "failed") {
    json(res, 400, { error: "result 必须是 passed|failed" });
    return;
  }
  try {
    const resolved = await svc.resolveVerify(id, result, who, typeof body.notes === "string" ? body.notes : undefined);
    json(res, 200, { ok: true, verify: resolved });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `POST /api/land {branch}` — the human lane's landing door (ticket #5).
 *
 * Same bar as the ticket lane and, crucially, the same lock: the gate and
 * the fast-forward both run inside the pipeline's global git lock, so a
 * ticket merging in the same seconds queues instead of racing. This is the
 * endpoint `scripts/ops/land.sh` calls; the script's local implementation
 * survives only as a fallback for when the bot is unreachable.
 *
 * Authority follows the deploy whitelist rather than ticket ownership:
 * landing is what puts code in front of a deploy, so whoever may deploy may
 * land. Synchronous by design — the caller waits out the gate (minutes).
 */
async function handleLand(ctx: TicketRoutesContext, req: PanelRequest, res: PanelReply, identity: DashboardIdentity): Promise<void> {
  const pipe = ctx.opts.devPipeline;
  if (!pipe) {
    json(res, 404, { error: "self-hosting pipeline disabled" });
    return;
  }
  const svc = ctx.opts.deployService;
  const who = identity.username ?? "admin";
  // No deploy service = no whitelist to consult; only the admin key may land.
  const may = identity.deploy;
  if (!may) {
    json(res, 403, { error: "不在 deployers 名单,不能落地到 " + pipe.baseBranch });
    return;
  }
  const body = bodyOf(req);
  const branch = typeof body.branch === "string" ? body.branch.trim() : "";
  if (!branch) {
    json(res, 400, { error: "branch 必填(要落地的缓冲分支,如 dev/lht)" });
    return;
  }
  if (svc && branch === svc.stableBranch) {
    json(res, 400, { error: `${svc.stableBranch} 是回滚锚点,不能作为落地来源` });
    return;
  }
  try {
    // Same shape as the submit tool: named tests are a convenience for the
    // author, never a condition of landing, so a malformed list is ignored.
    const rawTests = (req.body as { tests?: unknown } | undefined)?.tests;
    const tests = Array.isArray(rawTests)
      ? rawTests.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 200).slice(0, 12)
      : [];
    const rawReceipts = body.retrieval_receipts;
    const receiptUploads: CliRetrievalReceiptUpload[] = Array.isArray(rawReceipts)
      ? rawReceipts.flatMap((raw) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
          const receipt = raw as Record<string, unknown>;
          if (typeof receipt.id !== "string" || !/^kr_[0-9a-f]{32}$/u.test(receipt.id)) return [];
          if (typeof receipt.receipt_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(receipt.receipt_sha256)) return [];
          if (typeof receipt.content !== "string" || Buffer.byteLength(receipt.content, "utf8") > 32 * 1024) return [];
          return [{ id: receipt.id, receipt_sha256: receipt.receipt_sha256, content: receipt.content }];
        }).slice(0, 8)
      : [];
    const result = await pipe.land(branch, who, tests, receiptUploads);
    log.info({ branch, who, to: result.to_sha }, "land succeeded");
    json(res, 200, result);
  } catch (err) {
    if (err instanceof LandError) {
      const status = LAND_STATUS[err.code];
      json(res, status, { ok: false, code: err.code, error: err.message, gate_log_tail: err.gateLogTail ?? "" });
      return;
    }
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function ticketTranscriptIsStarting(ticket: DevTicketRow, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!ticket.session_id || message !== "session not found for id: " + ticket.session_id) return false;
  const age = Date.now() - Date.parse(ticket.turn_started_at ?? "");
  return age >= 0 && age < 30_000;
}

async function readTicketSession(ctx: TicketRoutesContext, res: PanelReply, ticket: DevTicketRow, url: URL): Promise<void> {
  const starting = { pending: true, running: Boolean(ticket.turn_started_at), turn_started_at: ticket.turn_started_at };
  // Start the existing operation query alongside transcript I/O. Neither result
  // grants authority to the other; both use the ticket's persisted binding.
  const executionProbe = ctx.opts.devPipeline!.readTicketExecution(ticket).then(
    (execution) => ({ execution, execution_error: undefined }),
    (error: unknown) => ({ execution: undefined, execution_error: error instanceof Error ? error.message : String(error) }),
  );
  const reply = async (status: number, payload: Record<string, unknown>) => {
    const probe = await executionProbe;
    const runtime = (payload.meta as { runtime?: { event?: string; turn_state?: string; process_state?: string; control_mode?: string; observed_at?: string } } | undefined)?.runtime;
    const nativeAge = Date.now() - Date.parse(runtime?.observed_at ?? "");
    // Codex daemon observations are polled and expire; a Claude TUI is re-proven
    // by its exact process on every read and emits no hook during a long tool call.
    const nativeSource = ticket.native_binding ? (JSON.parse(ticket.native_binding) as { source?: string }).source : undefined;
    const nativeObserved = nativeSource === "claude" ? runtime?.control_mode === "external_cli"
      : runtime?.event === "CodexDaemonObserved" && nativeAge >= -1000 && nativeAge <= 10000;
    json(res, probe.execution_error ? 502 : status, {
      ...payload,
      ...(probe.execution ? { execution: probe.execution, ...(!ticket.native_binding ? { running: probe.execution.state === "running" } : {}) } : {}),
      // An input acknowledgement is not the native agent's current turn state.
      ...(ticket.native_binding ? { running: !ticket.chat_paused && nativeObserved
        && runtime?.process_state === "alive" && runtime.turn_state === "working" } : {}),
      ...(probe.execution_error ? { execution_error: probe.execution_error, error: payload.error ?? probe.execution_error, running: false } : {}),
    });
  };
  const readFailed = async (error: unknown) => {
    const probe = await executionProbe;
    const message = error instanceof Error ? error.message : String(error);
    const missing = message === "session not found for id: " + ticket.session_id;
    if (missing && probe.execution && probe.execution.state !== "missing") {
      await reply(200, { ...starting, transcript_notice: message });
    } else if (!probe.execution_error && ticketTranscriptIsStarting(ticket, error)) {
      await reply(200, starting);
    } else {
      await reply(502, { error: message });
    }
  };
  if (!ticket.session_id) {
    await reply(200, starting);
    return;
  }
  const source = ctx.opts.devPipeline?.usesRunnerTickets?.() ? null : localScanSourceForModel(ticket.model);
  const limit = clampInt(url.searchParams.get("limit"), 1, 500, 200);
  const offsetRaw = url.searchParams.get("offset");
  const offset = offsetRaw != null && offsetRaw !== "" && Number.isFinite(Number(offsetRaw))
    ? Number(offsetRaw)
    : undefined;
  if (!source) {
    const lease = ctx.opts.devPipeline?.openRemoteTicketTranscript(ticket, "dashboard-ticket/" + ticket.id + "/read");
    if (!lease) {
      await reply(503, { error: "工单绑定的 Runner 设备不可用,无法读取 transcript" });
      return;
    }
    try {
      await reply(200, await lease.read({
        maxMessages: limit,
        ...(offset !== undefined ? { offset } : {}),
      }) as Record<string, unknown>);
    } catch (error) {
      await readFailed(error);
    } finally {
      lease.close();
    }
    return;
  }
  const scanRoot = ticketScanRoot(ctx, ticket);
  if (!scanRoot) {
    await reply(503, { error: ticket.codex_account_slot ? "工单绑定的 Codex 账号槽未配置" : "devScanHome 未配置" });
    return;
  }
  const args: Record<string, unknown> = { id: ticket.session_id, rich: true, max_messages: limit, source };
  if (offset !== undefined) args.offset = offset;
  try {
    await reply(200, await scanReadSession(scanRoot, args) as Record<string, unknown>);
  } catch (error) {
    await readFailed(error);
  }
}

/** `all` unless the caller named one of the two real sources. */
/**
 * The background suite's last word, as a status line.
 *
 * Bounded on purpose: a sha, a verdict, a time, and the ticket a red opened.
 * NOT the log tail — that lives on the ticket, where somebody is already being
 * asked to read it, and duplicating it here would put a 20 KB blob on every
 * poll of a page that refreshes every few seconds.
 *
 * `null` means no run has ever finished, which is a different thing from green
 * and must not render as one.
 */
function testBatchStatus(store: DashboardStorePort): {
  status: string;
  sha: string;
  from_sha: string | null;
  finished_at: string | null;
  ticket_id: number | null;
  running_sha: string | null;
} | null {
  const runs = store.devTickets.listTestRuns(2);
  const running = runs.find((r) => r.status === "running") ?? null;
  const settled = runs.find((r) => r.status !== "running") ?? null;
  if (!settled && !running) return null;
  return {
    status: settled?.status ?? "running",
    sha: settled?.sha ?? running!.sha,
    from_sha: settled?.from_sha ?? null,
    finished_at: settled?.finished_at ?? null,
    ticket_id: settled?.ticket_id ?? null,
    running_sha: running?.sha ?? null,
  };
}
