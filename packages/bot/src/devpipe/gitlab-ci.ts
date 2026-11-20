/**
 * Thin GitLab CI result adapter.
 *
 * GitLab owns pipeline execution, cancellation, runner placement, logs and
 * artifacts. This process triggers one complete mainline scan at Beijing
 * 04:00, immediately verifies every repair landing until the suite is green,
 * projects terminal results into the dashboard, and advances the tested
 * rollback anchor. It never executes a test command.
 */

import type { Store } from "../store/store.js";
import type { TestRunRow } from "../store/repositories/dev-tickets.js";
import { createLogger } from "../logger.js";
import { msUntilNextBeijingHour } from "./nightly-clock.js";
import { digestCiTrace, rosterFromDigestText } from "./ci-trace-digest.js";
import { decodeCiRoster } from "./ci-roster.js";

const log = createLogger("gitlab-ci");
const DEFAULT_POLL_MS = 15_000;
const PROVIDER = "gitlab";
const PIPELINE_NAME = "octopus-v4-batch";
const DEFAULT_SETTLE_MS = 60_000;
const DEFAULT_NIGHTLY_HOUR_BEIJING = 4;
const ABORTED_RETRY_MS = 5 * 60_000;
/**
 * Budget per failed job. Smaller than the 5 000-byte tail it replaces because
 * the digest is parsed, not sampled: on the batch that motivated this it named
 * all 7 failing files in ~500 characters where the tail showed 1 in 5 000.
 */
const TRACE_DIGEST_CHARS = 2_500;

interface GitLabPipeline {
  id: number;
  iid: number;
  sha: string;
  ref: string;
  status: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  name?: string | null;
}

interface GitLabJob {
  id: number;
  name: string;
  status: string;
  failure_reason?: string | null;
  web_url?: string;
}

export interface GitLabCiFailure {
  sha: string;
  pipelineId: number;
  pipelineUrl: string;
  summary: string;
  fromSha: string | null;
  /**
   * The spec files this batch blamed, parsed back out of the stored digest
   * (ticket #219). The repair ticket owes exactly these, and its landing is
   * gated on them. Empty when the trace had no parseable roster — an
   * infrastructure red or a suite that never started — which is a real state
   * the repair prompt handles rather than a parse we retry.
   */
  roster: string[];
}

/**
 * Two orthogonal questions about a repair conversation, kept apart because
 * they answer different callers:
 *
 *   1. `ciRepairAgentBusy` — is somebody advancing this repair RIGHT NOW (a
 *      running turn, or a queued message the pump will turn into one)? This
 *      blocks scheduling of new batches: pinning an intermediate repair commit
 *      or a red-on-red would waste a 20-minute run and open a redundant
 *      ticket. A PARKED repair — stopped by hand, errored, or ended without
 *      landing — is not busy, because nothing will ever advance it and waiting
 *      for it means mainline moves with no CI at all.
 *
 *   2. `ciRepairAwaitingVerification` — has the fix agent landed a patch
 *      that no green batch has verified yet? This does NOT block scheduling
 *      (we WANT the next batch, so it can verify), but it DOES route the
 *      next red back into the same conversation instead of spawning a fresh
 *      agent that has to rediscover the context from scratch.
 *
 * A cancelled ticket answers `false` to both.
 *
 * The old single-predicate `ciRepairTicketPending` conflated the two: after
 * a repair landed clean, it flipped back to "not pending", scheduling
 * resumed, and the very next red opened a new ticket — repeatedly, when the
 * fix agent had only patched half the failure. That is the loop this split
 * closes.
 */
export function ciRepairAgentBusy(
  ticket: {
    dev_status: string;
    turn_started_at: string | null;
    error: string | null;
  } | null | undefined,
  unreadMessages: number,
): boolean {
  if (!ticket || ticket.dev_status === "cancelled") return false;
  // "Is anybody advancing this right now", and nothing else. There are exactly
  // two ways a ticket moves: a turn is running, or a message is queued and the
  // pump will start one (`listTicketsNeedingTurn` selects on undelivered
  // messages and nothing else).
  //
  // This used to also answer true for any non-landed ticket, which quietly
  // made "stop this repair" a way to switch mainline CI off. A stopped turn
  // leaves the ticket `open` with no queued message and no running turn, so
  // the pump never wakes it — and this predicate blocked every future batch
  // waiting for it. Observed live on ticket #226. An agent that ends its turn
  // WITHOUT landing (which the repair prompt explicitly asks for on a stale
  // batch: "说明情况,不 submit") produced the same deadlock.
  //
  // `error` is deliberately not busy either, for the same reason: an errored
  // repair is parked until a human speaks, and blocking CI until then means
  // mainline keeps moving with nothing testing it.
  return ticket.turn_started_at != null || unreadMessages > 0;
}

/**
 * A landed repair is "awaiting verification" until a green batch that
 * started at or after its landing timestamp has arrived. This predicate only
 * identifies the candidate conversation; `classifyCiRepairFailure` then uses
 * Git ancestry and the failure roster to distinguish a real failed
 * verification from a stale or unrelated batch.
 *
 * "Started at or after" uses wall-clock rather than commit ordering: the
 * store does not know git ancestry, and every green settles what came
 * before it — so a strictly-later green is enough proof that the branch is
 * ok, regardless of which SHA it pinned. If the ticket landed but the DB
 * has no `landed_at` (rows predating migration v22), we cannot answer;
 * fall back to `false`, which means "route to a fresh ticket". That is
 * the pre-split behavior for old rows, on purpose.
 */
export function ciRepairAwaitingVerification(
  ticket: { dev_status: string; landed_at: string | null } | null | undefined,
  latestGreenStartedAt: string | null,
): boolean {
  if (!ticket || ticket.dev_status !== "landed" || !ticket.landed_at) return false;
  if (!latestGreenStartedAt) return true;
  return latestGreenStartedAt < ticket.landed_at;
}

/**
 * Locate the latest repair conversation that may still need a CI outcome.
 * `classifyCiRepairFailure` is the authoritative onRed decision; this smaller
 * lookup is also used by onGreen and scheduling.
 *
 * `null` = "no active repair to route to; open a fresh ticket".
 * `awaiting=false` = "a fix agent is still working; add another failure to
 *   its inbox and let it iterate".
 * `awaiting=true` = "a fix landed but has not been verified green yet; the
 *   same conversation continues, which is the whole point of the split".
 */
export interface CiRepairRoute {
  ticketId: number;
  awaiting: boolean;
}

export type CiCommitRelation = "same" | "failure_before_fix" | "failure_after_fix" | "unrelated";

export type CiRepairFailureDisposition =
  | { action: "open" }
  | { action: "stale"; ticketId: number }
  | { action: "continue"; ticketId: number; awaiting: boolean };


export function findCiRepairRouteTarget(store: Store): CiRepairRoute | null {
  const latestRed = store
    .devTickets.listTestRuns(100)
    .find((run) => run.provider === PROVIDER && run.status === "red" && run.ticket_id != null);
  if (!latestRed?.ticket_id) return null;
  const ticket = store.devTickets.getDevTicket(latestRed.ticket_id);
  if (!ticket || ticket.dev_status === "cancelled") return null;
  // An open repair conversation owns the next red whether or not anybody is
  // working in it this second. Routing into a PARKED one (stopped by hand,
  // errored, or ended without landing) is strictly better than spawning a
  // fresh agent: the context is there, and the message itself is what wakes
  // it — the pump runs a ticket precisely when it has an undelivered message.
  if (ticket.dev_status !== "landed") return { ticketId: ticket.id, awaiting: false };
  const latestGreen = store
    .devTickets.listTestRuns(100)
    .find((r) => r.provider === PROVIDER && r.status === "green");
  if (ciRepairAwaitingVerification(ticket, latestGreen?.started_at ?? null)) {
    return { ticketId: ticket.id, awaiting: true };
  }
  return null;
}

function rostersDescribeSameFailure(current: readonly string[], incoming: readonly string[]): boolean {
  if (current.length === 0 || incoming.length === 0) return current.length === incoming.length;
  const seen = new Set(current);
  return incoming.some((file) => seen.has(file));
}

/**
 * Decide whether a red belongs to the previous repair episode.
 *
 * Conversation recency alone is not causality. A batch pinned before the
 * landed fix is stale and must not wake/count against the agent; a descendant
 * batch with a disjoint roster is a new regression and gets its own ticket.
 * Only a descendant/same commit with an overlapping failure fingerprint is a
 * failed verification lap for the existing repair.
 */
export async function classifyCiRepairFailure(
  store: Store,
  failure: Pick<GitLabCiFailure, "sha" | "roster">,
  relation: (failureSha: string, fixSha: string) => Promise<CiCommitRelation>,
): Promise<CiRepairFailureDisposition> {
  const route = findCiRepairRouteTarget(store);
  if (!route) return { action: "open" };
  const ticket = store.devTickets.getDevTicket(route.ticketId);
  if (!ticket) return { action: "open" };

  if (route.awaiting) {
    if (!ticket.commit_sha) return { action: "open" };
    const commitRelation = await relation(failure.sha, ticket.commit_sha);
    if (commitRelation === "failure_before_fix") {
      return { action: "stale", ticketId: ticket.id };
    }
    if (commitRelation === "unrelated") return { action: "open" };
  }

  if (!rostersDescribeSameFailure(decodeCiRoster(ticket.ci_roster), failure.roster)) {
    return { action: "open" };
  }
  return {
    action: "continue",
    ticketId: ticket.id,
    awaiting: route.awaiting,
  };
}

/** True while the fix agent has work to do — blocks scheduling of the next batch. */
export function ciRepairBusyForScheduling(store: Store): boolean {
  const latestRed = store
    .devTickets.listTestRuns(100)
    .find((run) => run.provider === PROVIDER && run.status === "red" && run.ticket_id != null);
  if (!latestRed?.ticket_id) return false;
  const ticket = store.devTickets.getDevTicket(latestRed.ticket_id);
  if (!ticket) return false;
  const unread = store.devTickets.listTicketMessages(ticket.id, { undeliveredOnly: true }).length;
  return ciRepairAgentBusy(ticket, unread);
}

export interface GitLabCiMonitorOpts {
  store: Store;
  apiUrl: string;
  project: string | number;
  token: string;
  ref: string;
  pollMs?: number;
  /** Mainline must stay at one SHA this long before a due batch is triggered. */
  settleMs?: number;
  now?: () => number;
  fetchFn?: typeof fetch;
  onGreen: (sha: string) => Promise<void>;
  /**
   * Resolve every piece of repair context before returning the ticket id.
   * The monitor awaits this callback before attaching the red run, so callers
   * may fetch local change history without racing the ticket turn pump.
   */
  onRed: (failure: GitLabCiFailure) => number | null | Promise<number | null>;
  /**
   * True only while a fix turn is running or queued. It holds a due overnight
   * or verification batch until the candidate stops moving. A landed repair
   * does not block: its immediate full verification is the point.
   */
  repairBlocksScheduling?: () => boolean;
  /** Local mainline tip that must already be mirrored by GitLab before scheduling. */
  mainlineSha?: () => Promise<string>;
}

export class GitLabCiMonitor {
  private readonly store: Store;
  private readonly apiUrl: string;
  private readonly project: string;
  private readonly token: string;
  private readonly ref: string;
  private readonly pollMs: number;
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly onGreen: (sha: string) => Promise<void>;
  private readonly onRed: (failure: GitLabCiFailure) => number | null | Promise<number | null>;
  private readonly repairBlocksScheduling: () => boolean;
  private readonly mainlineSha: (() => Promise<string>) | null;
  private pollTimer: NodeJS.Timeout | null = null;
  private dailyTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private nightlyDue = false;
  private triggerLease: { sha: string; at: number } | null = null;

  constructor(opts: GitLabCiMonitorOpts) {
    this.store = opts.store;
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.project = encodeURIComponent(String(opts.project));
    this.token = opts.token;
    this.ref = opts.ref;
    this.pollMs = Math.max(5_000, opts.pollMs ?? DEFAULT_POLL_MS);
    this.settleMs = Math.max(0, opts.settleMs ?? DEFAULT_SETTLE_MS);
    this.now = opts.now ?? (() => Date.now());
    this.fetchFn = opts.fetchFn ?? fetch;
    this.onGreen = opts.onGreen;
    this.onRed = opts.onRed;
    this.repairBlocksScheduling = opts.repairBlocksScheduling ?? (() => false);
    this.mainlineSha = opts.mainlineSha ?? null;
  }

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollOnce(), this.pollMs);
    this.pollTimer.unref?.();
    this.scheduleNextNightly();
    void this.pollOnce();
  }

  stop(): void {
    clearInterval(this.pollTimer ?? undefined);
    this.pollTimer = null;
    clearTimeout(this.dailyTimer ?? undefined);
    this.dailyTimer = null;
  }

  /** Mark the daily scan due; public so deterministic tests can exercise it. */
  async requestNightlyRun(): Promise<void> {
    this.nightlyDue = true;
    await this.pollOnce();
  }

  private scheduleNextNightly(): void {
    if (this.dailyTimer !== null) return;
    const delayMs = msUntilNextBeijingHour(new Date(this.now()), DEFAULT_NIGHTLY_HOUR_BEIJING);
    this.dailyTimer = setTimeout(() => {
      this.dailyTimer = null;
      this.nightlyDue = true;
      void this.pollOnce();
      this.scheduleNextNightly();
    }, delayMs);
    this.dailyTimer.unref?.();
  }

  /** One reconciliation pass, public for deterministic tests. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const params = new URLSearchParams({ ref: this.ref, source: "api", per_page: "20" });
      const pipelines = await this.api<GitLabPipeline[]>(`/projects/${this.project}/pipelines?${params}`);
      const owned = pipelines.filter((pipeline) => pipeline.name === PIPELINE_NAME);
      // Oldest first: if several terminal results arrived during a restart, the
      // stable watermark advances monotonically rather than skipping history.
      for (const pipeline of [...owned].reverse()) await this.reconcile(pipeline);
      await this.maybeSchedule(owned);
    } catch (err) {
      log.warn({ err }, "GitLab CI reconciliation failed");
    } finally {
      this.polling = false;
    }
  }

  private async reconcile(pipeline: GitLabPipeline): Promise<void> {
    const jobs = await this.api<GitLabJob[]>(`/projects/${this.project}/pipelines/${pipeline.id}/jobs?per_page=100`);
    const suiteJobs = jobs.filter((job) => job.name === "full_suite");
    // Do not reinterpret historical or unrelated project pipelines as this
    // suite merely because they ran on the same branch.
    if (suiteJobs.length === 0 && pipeline.status !== "failed") return;
    let row = this.store.devTickets.getExternalTestRun(PROVIDER, String(pipeline.id));
    if (!row) {
      row = this.store.devTickets.startExternalTestRun({
        provider: PROVIDER,
        externalId: String(pipeline.id),
        externalUrl: pipeline.web_url,
        sha: pipeline.sha,
        fromSha: this.store.devTickets.latestTestRun("green")?.sha ?? null,
        startedAt: pipeline.created_at || new Date().toISOString(),
      });
      log.info({ pipeline: pipeline.id, sha: pipeline.sha.slice(0, 10) }, "observed GitLab pipeline");
    }

    if (pipeline.status === "success") {
      if (row.status !== "running") return;
      // Keep the projection running if advancing the anchor fails. The next
      // poll retries the small integration action; the GitLab result is intact.
      await this.onGreen(pipeline.sha);
      this.store.devTickets.finishExternalTestRun(
        row.id,
        "green",
        pipeline.updated_at || new Date().toISOString(),
        `GitLab pipeline #${pipeline.iid} passed\n${pipeline.web_url}`,
        null,
      );
      log.info({ pipeline: pipeline.id, sha: pipeline.sha.slice(0, 10) }, "GitLab pipeline green; anchor advanced");
      return;
    }

    if (pipeline.status === "failed") {
      if (row.status === "running") row = await this.finishFailed(row, pipeline, suiteJobs);
      if (row.status === "red" && row.ticket_id == null) await this.openRepairTicket(row, pipeline);
      return;
    }

    if (["canceled", "skipped", "manual"].includes(pipeline.status) && row.status === "running") {
      this.store.devTickets.finishExternalTestRun(
        row.id,
        "aborted",
        pipeline.updated_at || new Date().toISOString(),
        `GitLab pipeline #${pipeline.iid} ended as ${pipeline.status}\n${pipeline.web_url}`,
        pipeline.status,
      );
    }
    // created/pending/preparing/running/scheduled/waiting_for_resource remain running.
  }

  private async finishFailed(row: TestRunRow, pipeline: GitLabPipeline, jobs: GitLabJob[]): Promise<TestRunRow> {
    const failed = jobs.filter((job) => job.status === "failed");
    const infra = failed.length > 0 && failed.every((job) => isInfrastructureFailure(job.failure_reason));
    const details: string[] = [
      `GitLab pipeline #${pipeline.iid} failed`,
      pipeline.web_url,
      ...failed.map((job) => `- ${job.name}: ${job.failure_reason || "failed"}${job.web_url ? ` (${job.web_url})` : ""}`),
    ];
    // Keep the compact diagnosis first, then append every parsed failure.
    // The compact section makes common-cause triage fast; the complete section
    // is the durable source for both the repair prompt and its roster gate.
    // GitLab remains canonical for raw bytes and artifacts.
    const parsedFailures: Array<{ file: string; test?: string; reason?: string; at?: string }> = [];
    for (const job of failed.slice(0, 3)) {
      try {
        const trace = await this.apiText(`/projects/${this.project}/jobs/${job.id}/trace`);
        const digest = digestCiTrace(trace, { maxChars: TRACE_DIGEST_CHARS });
        parsedFailures.push(...digest.failures);
        const label = digest.structured ? "失败摘要" : "日志尾部(未识别出测试失败)";
        details.push(`\n--- ${job.name} ${label} ---\n${digest.text}`);
      } catch (err) {
        details.push(`\n--- ${job.name} trace unavailable: ${String(err)} ---`);
      }
    }
    if (parsedFailures.length > 0) {
      const byFile = new Map<string, typeof parsedFailures>();
      for (const failure of parsedFailures) {
        const list = byFile.get(failure.file);
        if (list) list.push(failure);
        else byFile.set(failure.file, [failure]);
      }
      const complete: string[] = ["\n--- 全部解析错误(无截断) ---"];
      for (const [file, failures] of byFile) {
        complete.push(`● ${file}`);
        for (const failure of failures) {
          const location = failure.at ? ` @${failure.at}` : "";
          const reason = failure.reason ? ` — ${failure.reason}` : "";
          complete.push(`  - ${failure.test ?? "(文件加载失败)"}${location}${reason}`);
        }
      }
      details.push(complete.join("\n"));
    }
    this.store.devTickets.finishExternalTestRun(
      row.id,
      infra ? "aborted" : "red",
      pipeline.updated_at || new Date().toISOString(),
      details.join("\n"),
      failed.map((job) => job.failure_reason || "failed").join(",") || "pipeline_failed",
    );
    return this.store.devTickets.getExternalTestRun(PROVIDER, String(pipeline.id))!;
  }

  private async openRepairTicket(row: TestRunRow, pipeline: GitLabPipeline): Promise<void> {
    const summary = row.log_tail ?? `GitLab pipeline #${pipeline.iid} failed`;
    const ticketId = await this.onRed({
      sha: pipeline.sha,
      pipelineId: pipeline.id,
      pipelineUrl: pipeline.web_url,
      summary,
      fromSha: row.from_sha,
      // Read from the persisted row rather than kept from `finishFailed`: this
      // may be a red observed on a later poll, or after a restart, and the
      // roster has to be the same either way.
      roster: rosterFromDigestText(summary),
    });
    if (ticketId != null) {
      this.store.devTickets.attachTestRunTicket(row.id, ticketId);
      log.warn({ pipeline: pipeline.id, ticket: ticketId }, "GitLab red projected into a repair ticket");
    }
  }

  /**
   * Trigger the newest mainline tip only when one of three durable reasons
   * exists: the Beijing 04:00 sweep is due, a repair landing needs its full
   * independent verdict, or an infrastructure-aborted run is ready to retry.
   * Ordinary commits merely accumulate for the next overnight sweep.
   */
  private async maybeSchedule(pipelines: GitLabPipeline[]): Promise<void> {
    const latest = this.store.devTickets.listTestRuns(100).find((run) => run.provider === PROVIDER);
    const abortedFinishedAt = latest?.status === "aborted"
      ? Date.parse(latest.finished_at ?? latest.started_at)
      : Number.NaN;
    const abortedRetryDue = latest?.status === "aborted"
      && (!Number.isFinite(abortedFinishedAt) || this.now() - abortedFinishedAt >= ABORTED_RETRY_MS);
    const repairVerificationDue = findCiRepairRouteTarget(this.store)?.awaiting === true;
    if (!this.nightlyDue && !repairVerificationDue && !abortedRetryDue) return;

    const active = pipelines.some((pipeline) =>
      ["created", "pending", "preparing", "running", "scheduled", "waiting_for_resource"].includes(pipeline.status),
    );
    if (active || this.repairBlocksScheduling()) return;

    const branch = await this.api<{ commit: { id: string; committed_date?: string } }>(
      `/projects/${this.project}/repository/branches/${encodeURIComponent(this.ref)}`,
    );
    const desired = branch.commit.id;
    if (this.mainlineSha) {
      const local = await this.mainlineSha();
      if (local !== desired) {
        // `ffBaseTo()` updates the local watermark before its best-effort push
        // is visible through GitLab's branch API. Starting in that window tests
        // the PRE-repair commit and can open a redundant repair ticket. Wait for
        // exact mirror parity; the next poll naturally retries the due reason.
        log.info(
          { ref: this.ref, local: local.slice(0, 10), remote: desired.slice(0, 10) },
          "GitLab branch mirror is behind local mainline; due batch stays queued",
        );
        return;
      }
    }
    const committedAt = Date.parse(branch.commit.committed_date ?? "");
    if (Number.isFinite(committedAt) && this.now() - committedAt < this.settleMs) return;
    if (!this.nightlyDue && latest?.sha === desired && latest.status !== "aborted") return;
    // Cover the short API consistency window after POST, before the pipeline
    // appears in the list endpoint.
    if (this.triggerLease?.sha === desired && this.now() - this.triggerLease.at < 60_000) return;
    await this.api<GitLabPipeline>(`/projects/${this.project}/pipeline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: this.ref }),
    });
    const reason = this.nightlyDue ? "overnight" : repairVerificationDue ? "repair-verification" : "infra-retry";
    this.nightlyDue = false;
    this.triggerLease = { sha: desired, at: this.now() };
    log.info({ ref: this.ref, sha: desired.slice(0, 10), reason }, "triggered GitLab CI batch");
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  private async apiText(path: string): Promise<string> {
    return await (await this.request(path)).text();
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.fetchFn(this.apiUrl + path, {
      ...init,
      headers: { "PRIVATE-TOKEN": this.token, ...init?.headers },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitLab API ${response.status} ${response.statusText}: ${path}`);
    return response;
  }
}

/** GitLab explicitly says these failures are in the execution plane. */
export function isInfrastructureFailure(reason: string | null | undefined): boolean {
  return new Set([
    "runner_system_failure",
    "stuck_or_timeout_failure",
    "scheduler_failure",
    "api_failure",
    "data_integrity_failure",
  ]).has(reason ?? "");
}
