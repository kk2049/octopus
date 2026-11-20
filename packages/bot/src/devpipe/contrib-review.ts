/**
 * The review lane: what happens to a contributor's candidate AFTER the pipeline
 * has verified it and refused to fast-forward it (2026-08-20).
 *
 * ── Why a lane and not a second writer ──────────────────────────────────────
 *
 * The base branch has one writer: `ffBaseTo`, under the merge lock, from a
 * verified candidate. A contributor is somebody we are not yet willing to let
 * reach that writer unattended. Rather than teach the writer about trust, the
 * contributor's `devpipe_submit` stops one step earlier — push the candidate
 * somewhere a maintainer can look at it — and a separate, human decision plus
 * an ordinary direct-lane ticket carry it the rest of the way. The watermark's
 * invariants are untouched because the only thing that ever fast-forwards it
 * is still a direct-lane submit.
 *
 * This is a deliberate exception to the trunk-backlog model in
 * `doc/design-self-hosting.md`: that model argues against floating branches for
 * TRUSTED work. Contributor work floats precisely because it is not trusted
 * yet, and it floats for exactly as long as review takes.
 *
 * ── Who moves what ──────────────────────────────────────────────────────────
 *
 *   pipeline.runSubmit (review lane)   → row created: ci_pending | awaiting_review
 *   this.pollOnce (CI adapter)         → ci_pending → awaiting_review | ci_failed
 *   this.decide (a `Deploy` holder)    → awaiting_review|rejected → approved
 *                                        awaiting_review|approved → rejected
 *   this.runBatch (a `Deploy` holder)  → approved → merging  (+ one merge ticket)
 *   this.pollOnce (merge watcher)      → merging → merged | merge_failed
 *   pipeline.runSubmit (resubmit)      → any live row → superseded
 *
 * A rejection and a CI red both land in the ticket's inbox as a message, which
 * is the one trigger the turn pump knows: the agent wakes, reads the feedback,
 * fixes, and submits again. Nothing here needs a second scheduler.
 */

import type { Store } from "../store/store.js";
import type { DevTicketRow, TicketActorKind } from "../store/repositories/dev-tickets.js";
import type { MergeProposalRow, MergeProposalStatus } from "../store/repositories/merge-proposals.js";
import { createLogger } from "../logger.js";

const log = createLogger("contrib-review");

const DEFAULT_POLL_MS = 20_000;

// ── the publisher port ──

export interface ProposalPublishInput {
  ticketId: number;
  requester: string;
  /** `contrib/<user>/ticket-<id>` — pipeline-owned, force-pushed on resubmit. */
  branch: string;
  sha: string;
  baseSha: string;
  title: string;
  summary: string;
}

export interface ProposalPublishResult {
  /** Null when no CI was triggered (no GitLab configured): review starts at once. */
  pipelineId: string | null;
  pipelineUrl: string | null;
  detail?: string;
}

export type PipelineVerdict =
  | { status: "running" }
  | { status: "success" }
  | { status: "failed"; digest: string }
  | { status: "aborted"; reason: string };

export interface MergeRequestRef {
  iid: number;
  url: string;
}

/**
 * Everything the review lane needs from the forge, behind one port so the
 * pipeline and this service can be tested without a network and so the
 * GitLab-specific parts (`gitlab-contrib.ts`) stay out of the state machine.
 */
export interface ProposalPublisher {
  /** Push the candidate branch and start its CI. */
  publish(input: ProposalPublishInput): Promise<ProposalPublishResult>;
  /** What CI currently says about one pipeline. */
  pipelineVerdict(pipelineId: string): Promise<PipelineVerdict>;
  /** Open (or find the existing) merge request for the branch. */
  openMergeRequest(input: {
    branch: string;
    targetBranch: string;
    title: string;
    description: string;
  }): Promise<MergeRequestRef | null>;
  /** Leave a note and close the merge request after the batch landed. */
  closeMergeRequest(iid: number, note: string): Promise<void>;
}

/** A publisher for deployments without a forge: review starts immediately. */
export const NO_FORGE_PUBLISHER: ProposalPublisher = {
  async publish() {
    return { pipelineId: null, pipelineUrl: null, detail: "no forge configured; review without CI" };
  },
  async pipelineVerdict() {
    return { status: "running" };
  },
  async openMergeRequest() {
    return null;
  },
  async closeMergeRequest() {},
};

// ── the pipeline seam ──

/** What the service needs from `DevPipeline`, narrowed so tests can stub it. */
export interface ContribReviewPipeline {
  readonly baseBranch: string;
  createTicket(input: {
    title: string;
    body: string;
    requester: string;
    kind?: string;
    model?: string;
    effort?: string;
    via?: string;
    actor_kind?: TicketActorKind | null;
  }): DevTicketRow;
  /** A human/pipeline message into the ticket's inbox; wakes the agent. */
  postMessage(ticketId: number, author: string, via: string, body: string, actorKind?: TicketActorKind | null): unknown;
  /** A pipeline annotation on the conversation; does not wake the agent. */
  postPipelineNote(ticketId: number, body: string): void;
  /** Whether the candidate range `baseSha..sha` is now part of `landedSha`. */
  proposalApplied(proposal: { sha: string; base_sha: string }, landedSha: string): Promise<{ applied: boolean; evidence: string }>;
}

export interface ContribReviewOpts {
  store: Store;
  pipeline: ContribReviewPipeline;
  publisher: ProposalPublisher;
  pollMs?: number;
  now?: () => number;
  /** Model/effort the batch-merge ticket is filed with. */
  mergeTicketModel?: string;
  mergeTicketEffort?: string;
}

export type DecideOutcome =
  | { ok: true; proposal: MergeProposalRow }
  | { ok: false; code: "not_found" | "not_decidable"; message: string };

export interface MergeQueueEntry extends MergeProposalRow {
  ticket_title: string;
  ticket_slug: string | null;
}

export const REVIEW_BRANCH_PREFIX = "contrib";

export function contribBranchName(requester: string, ticketId: number): string {
  return `${REVIEW_BRANCH_PREFIX}/${requester}/ticket-${ticketId}`;
}

/**
 * The batch-merge ticket's body: what the maintainer approved, where each
 * candidate lives, and the one rule that makes this a controlled merge rather
 * than a second writer — it lands through `devpipe_submit` like every other
 * direct-lane ticket, so the merge lock, the land gate and the knowledge ledger
 * all still apply.
 */
export function buildMergeBatchBody(
  proposals: readonly MergeQueueEntry[],
  opts: { baseBranch: string; approver: string },
): string {
  const items = proposals
    .map(
      (p, i) =>
        `${i + 1}. 提案 #${p.id} ← 工单 #${p.ticket_id}「${p.ticket_title}」(提交人 ${p.requester})\n`
        + `   候选提交 ${p.sha}(基于 ${p.base_sha.slice(0, 12)}),远端分支 \`${p.branch}\``
        + (p.mr_url ? `,MR ${p.mr_url}` : "")
        + `\n   摘要:${p.summary.replace(/\s+/g, " ").slice(0, 400)}`,
    )
    .join("\n");
  return `这是一张**批量合并工单**:${opts.approver} 已审批通过下列贡献者提案,请你受控地把它们合入 \`${opts.baseBranch}\`。

${items}

执行规则:
1. 候选提交已经在本仓库的对象库里(贡献者工单的 worktree 与你共享 .git),按列出的顺序逐个 \`git cherry-pick <base_sha>..<sha>\`;不要 fetch 远端,不要 merge 远端分支。
2. 每叠加一个提案就审查它的 diff:是否与摘要一致、是否触碰保护路径或可信边界路径、是否引入明显错误。有疑问的提案**跳过并在回复里说明原因**,其余继续;不要试图替贡献者重写功能。
3. 冲突就地解决,保留双方意图;解决后确认编译通过,并跑这些提案 diff 涉及的测试文件。
4. 全部叠加完成后只调用一次 devpipe_submit;knowledge.summary 里逐条列出实际合入的提案 id 与跳过的提案 id。
5. 落地后不要部署。流水线会根据落地结果把每个提案标成 merged 或 merge_failed,并关闭对应的 MR。`;
}

export class ContribReviewService {
  private readonly store: Store;
  private readonly pipeline: ContribReviewPipeline;
  private readonly publisher: ProposalPublisher;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly mergeTicketModel: string | undefined;
  private readonly mergeTicketEffort: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(opts: ContribReviewOpts) {
    this.store = opts.store;
    this.pipeline = opts.pipeline;
    this.publisher = opts.publisher;
    this.pollMs = Math.max(5_000, opts.pollMs ?? DEFAULT_POLL_MS);
    this.now = opts.now ?? (() => Date.now());
    this.mergeTicketModel = opts.mergeTicketModel;
    this.mergeTicketEffort = opts.mergeTicketEffort;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce(), this.pollMs);
    this.timer.unref?.();
    void this.pollOnce();
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  // ── read model ──

  queue(limit = 200): MergeQueueEntry[] {
    return this.store.mergeProposals.listRecent(limit).map((row) => this.entry(row));
  }

  private entry(row: MergeProposalRow): MergeQueueEntry {
    const ticket = this.store.devTickets.getDevTicket(row.ticket_id);
    return { ...row, ticket_title: ticket?.title ?? `工单 #${row.ticket_id}`, ticket_slug: ticket?.slug ?? null };
  }

  // ── the maintainer's two verbs ──

  /**
   * Approve or reject one proposal. Approving is a promise to merge, not a
   * merge: the candidate still goes through `runBatch` and a direct-lane
   * landing. Rejecting posts the note into the ticket so the agent (and the
   * contributor reading along) can answer it with another submit.
   */
  decide(proposalId: number, decision: "approve" | "reject", by: string, note?: string): DecideOutcome {
    const row = this.store.mergeProposals.get(proposalId);
    if (!row) return { ok: false, code: "not_found", message: `提案不存在: #${proposalId}` };
    const from: MergeProposalStatus[] = decision === "approve"
      ? ["awaiting_review", "rejected"]
      : ["awaiting_review", "approved"];
    const to: MergeProposalStatus = decision === "approve" ? "approved" : "rejected";
    const trimmed = (note ?? "").trim().slice(0, 2_000);
    const moved = this.store.mergeProposals.transition(proposalId, from, to, {
      review_by: by,
      review_at: new Date(this.now()).toISOString(),
      review_note: trimmed || null,
    });
    if (!moved) {
      return {
        ok: false,
        code: "not_decidable",
        message: `提案 #${proposalId} 当前状态是 ${row.status},不能${decision === "approve" ? "批准" : "打回"}。`,
      };
    }
    if (decision === "reject") {
      // A message, not a note: feedback is the thing that wakes the agent.
      this.pipeline.postMessage(
        row.ticket_id,
        by,
        "review",
        `🔙 提案 #${row.id}(${row.sha.slice(0, 10)})被打回。${trimmed ? `原因:${trimmed}` : "未填写原因。"}\n`
          + "请按反馈修改、commit,再次 devpipe_submit 会生成新的提案并替换这一个。",
        // Head-composed around the reviewer's note, so not the reviewer's own typing.
        "system",
      );
    } else {
      this.pipeline.postPipelineNote(
        row.ticket_id,
        `✅ ${by} 批准了提案 #${row.id}(${row.sha.slice(0, 10)})。${trimmed ? `备注:${trimmed}` : ""}`
          + `它会在下一次批量合并中由维护者的 agent 合入 ${this.pipeline.baseBranch}。`,
      );
    }
    log.info({ proposal: proposalId, decision, by }, "merge proposal decided");
    return { ok: true, proposal: this.store.mergeProposals.get(proposalId)! };
  }

  /**
   * Hand every approved proposal (or the named subset) to ONE direct-lane
   * ticket whose agent performs the merge. Returns null when nothing is
   * approved, so the button can say so instead of filing an empty ticket.
   */
  runBatch(by: string, ids?: readonly number[]): { ticket: DevTicketRow; proposals: MergeQueueEntry[] } | null {
    const wanted = new Set(ids ?? []);
    const approved = this.store.mergeProposals
      .listByStatus(["approved"])
      .filter((row) => wanted.size === 0 || wanted.has(row.id))
      .map((row) => this.entry(row));
    if (approved.length === 0) return null;
    const ticket = this.pipeline.createTicket({
      title: `批量合并 ${approved.length} 个已批准提案`,
      body: buildMergeBatchBody(approved, { baseBranch: this.pipeline.baseBranch, approver: by }),
      requester: by,
      kind: "simple",
      ...(this.mergeTicketModel ? { model: this.mergeTicketModel } : {}),
      ...(this.mergeTicketEffort ? { effort: this.mergeTicketEffort } : {}),
      via: "review",
      actor_kind: "system",
    });
    for (const row of approved) {
      const moved = this.store.mergeProposals.transition(row.id, ["approved"], "merging", {
        merge_ticket_id: ticket.id,
      });
      if (moved) {
        this.pipeline.postPipelineNote(
          row.ticket_id,
          `🔀 提案 #${row.id} 已交给批量合并工单 #${ticket.id},由 ${by} 的 agent 受控合入。`,
        );
      }
    }
    log.info({ ticket: ticket.id, proposals: approved.map((p) => p.id), by }, "merge batch filed");
    return { ticket, proposals: approved.map((row) => this.entry(this.store.mergeProposals.get(row.id)!)) };
  }

  // ── the two watchers ──

  /** One reconciliation pass; public so tests drive it deterministically. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const row of this.store.mergeProposals.listByStatus(["ci_pending"])) await this.reconcileCi(row);
      for (const row of this.store.mergeProposals.listByStatus(["merging"])) await this.reconcileMerge(row);
    } catch (err) {
      log.warn({ err }, "contrib review reconciliation failed");
    } finally {
      this.polling = false;
    }
  }

  private async reconcileCi(row: MergeProposalRow): Promise<void> {
    if (!row.pipeline_id) {
      // Published without CI (no forge). Review starts now.
      this.store.mergeProposals.transition(row.id, ["ci_pending"], "awaiting_review", { detail: "no CI configured" });
      return;
    }
    let verdict: PipelineVerdict;
    try {
      verdict = await this.publisher.pipelineVerdict(row.pipeline_id);
    } catch (err) {
      log.warn({ proposal: row.id, err }, "pipeline verdict unavailable");
      return;
    }
    if (verdict.status === "running") return;
    if (verdict.status === "success") {
      const ticket = this.store.devTickets.getDevTicket(row.ticket_id);
      let mr: MergeRequestRef | null = null;
      try {
        mr = await this.publisher.openMergeRequest({
          branch: row.branch,
          targetBranch: this.pipeline.baseBranch,
          title: `[ticket #${row.ticket_id}] ${ticket?.title ?? "contributor proposal"}`,
          description: mergeRequestDescription(row, ticket),
        });
      } catch (err) {
        // CI is green; a forge hiccup must not hide that. Record the verdict
        // and leave the MR for the next poll by staying in ci_pending.
        log.warn({ proposal: row.id, err }, "merge request creation failed; will retry");
        return;
      }
      const moved = this.store.mergeProposals.transition(row.id, ["ci_pending"], "awaiting_review", {
        mr_iid: mr?.iid ?? null,
        mr_url: mr?.url ?? null,
        detail: `CI passed${row.pipeline_url ? ` (${row.pipeline_url})` : ""}`,
      });
      if (moved) {
        this.pipeline.postPipelineNote(
          row.ticket_id,
          `🟢 提案 #${row.id} 的完整 CI 通过。${mr ? `已创建 MR ${mr.url},` : ""}现在等待维护者审批;`
            + "被批准后会在下一次批量合并中合入,被打回时你会在这里收到原因。",
        );
      }
      return;
    }
    const detail = verdict.status === "failed" ? verdict.digest : `CI aborted: ${verdict.reason}`;
    const moved = this.store.mergeProposals.transition(row.id, ["ci_pending"], "ci_failed", {
      detail: detail.slice(0, 20_000),
    });
    if (!moved) return;
    // A message, because a red is work for the agent.
    this.pipeline.postMessage(
      row.ticket_id,
      "ci",
      "pipeline",
      verdict.status === "failed"
        ? `🔴 提案 #${row.id}(${row.sha.slice(0, 10)})的完整 CI 失败${row.pipeline_url ? `:${row.pipeline_url}` : ""}。\n`
          + "先在本地/开发机复现并修好下面列出的失败,commit 后再次 devpipe_submit(会生成新的提案并重新跑 CI)。\n\n"
          + detail.slice(0, 6_000)
        : `⚠ 提案 #${row.id} 的 CI 被中止(${verdict.reason}),通常是基础设施问题而不是你的代码。`
          + "确认代码无误后再次 devpipe_submit 重新触发即可。",
      "system",
    );
  }

  private async reconcileMerge(row: MergeProposalRow): Promise<void> {
    if (row.merge_ticket_id == null) {
      this.store.mergeProposals.transition(row.id, ["merging"], "merge_failed", { detail: "merging without a merge ticket" });
      return;
    }
    const mergeTicket = this.store.devTickets.getDevTicket(row.merge_ticket_id);
    if (!mergeTicket) {
      this.store.mergeProposals.transition(row.id, ["merging"], "merge_failed", { detail: `merge ticket #${row.merge_ticket_id} missing` });
      return;
    }
    if (mergeTicket.dev_status === "cancelled") {
      const moved = this.store.mergeProposals.transition(row.id, ["merging"], "merge_failed", {
        detail: `批量合并工单 #${mergeTicket.id} 被取消`,
      });
      if (moved) {
        this.pipeline.postPipelineNote(
          row.ticket_id,
          `⚠ 提案 #${row.id} 所在的批量合并工单 #${mergeTicket.id} 被取消,提案回到待处理;维护者可以重新批准后再次批量合并。`,
        );
        // Let the maintainer re-approve: the row is merge_failed, which `decide`
        // does not accept, so hand it straight back to approved.
        this.store.mergeProposals.transition(row.id, ["merge_failed"], "approved", {});
      }
      return;
    }
    if (mergeTicket.dev_status !== "landed" || !mergeTicket.commit_sha) return; // still working
    let applied: { applied: boolean; evidence: string };
    try {
      applied = await this.pipeline.proposalApplied(row, mergeTicket.commit_sha);
    } catch (err) {
      log.warn({ proposal: row.id, err }, "could not evaluate merge outcome; will retry");
      return;
    }
    if (applied.applied) {
      const moved = this.store.mergeProposals.transition(row.id, ["merging"], "merged", {
        merged_sha: mergeTicket.commit_sha,
        detail: applied.evidence,
      });
      if (!moved) return;
      this.pipeline.postPipelineNote(
        row.ticket_id,
        `🎉 提案 #${row.id} 已通过批量合并工单 #${mergeTicket.id} 合入 ${this.pipeline.baseBranch}(${mergeTicket.commit_sha.slice(0, 10)})。`
          + "合入不等于上线;部署由维护者另行触发。",
      );
      if (row.mr_iid != null) {
        await this.publisher
          .closeMergeRequest(
            row.mr_iid,
            `Merged into ${this.pipeline.baseBranch} at ${mergeTicket.commit_sha} by batch ticket #${mergeTicket.id} (octopus review lane).`,
          )
          .catch((err) => log.warn({ proposal: row.id, err }, "closing merge request failed"));
      }
      return;
    }
    const moved = this.store.mergeProposals.transition(row.id, ["merging"], "merge_failed", {
      detail: `批量合并工单 #${mergeTicket.id} 已落地(${mergeTicket.commit_sha.slice(0, 10)}),但未包含本提案:${applied.evidence}`,
    });
    if (moved) {
      this.pipeline.postPipelineNote(
        row.ticket_id,
        `⚠ 批量合并工单 #${mergeTicket.id} 落地了,但没有包含提案 #${row.id}(合并 agent 可能跳过了它,原因见该工单的回复)。`
          + "请根据反馈修改后再次 devpipe_submit,或等维护者重新批准。",
      );
    }
  }
}

function mergeRequestDescription(row: MergeProposalRow, ticket: DevTicketRow | undefined): string {
  return [
    `Octopus review-lane proposal #${row.id} from ticket #${row.ticket_id} (requester: ${row.requester}).`,
    "",
    "## Summary",
    row.summary,
    "",
    // Whole: the publisher continues past GitLab's description limit in notes.
    ticket?.body ? `## Original request\n${ticket.body}` : "",
    "",
    `Candidate ${row.sha} rebased onto ${row.base_sha}.`,
    "This MR is closed by the pipeline once a maintainer-approved batch merge lands; do not merge it on GitLab.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
