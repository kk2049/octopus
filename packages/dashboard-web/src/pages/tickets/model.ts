import { uiText } from "../../i18n/ui-text.js";

/**
 * The newest merge proposal of a review-lane ticket (2026-08-20), as the
 * roster carries it. Statuses: ci_pending, ci_failed, awaiting_review,
 * approved, rejected, merging, merged, merge_failed, superseded.
 */
export interface Proposal {
  id: number;
  status: string;
  branch: string;
  sha: string;
  pipeline_url?: string | null;
  mr_url?: string | null;
  review_by?: string | null;
  review_note?: string | null;
  merge_ticket_id?: number | null;
  merged_sha?: string | null;
  updated_at?: string;
}

export interface Ticket {
  execution_owner?: "native_cli";
  id: number;
  title: string;
  slug?: string;
  body?: string;
  spec?: string;
  requester: string;
  /** How the opening request was written (server v86); absent/null = unknown. */
  actor_kind?: string | null;
  kind: string;
  /** 'direct' (submit fast-forwards) or 'review' (submit publishes a proposal). */
  lane?: string;
  proposal?: Proposal | null;
  /** Which App a `kind: "app"` ticket is about; null for every other kind. */
  app_id?: string | null;
  /** Stable knowledge conflict subject when this ticket is a conflict Agent thread. */
  knowledge_subject_id?: string | null;
  dev_status: string;
  chat_paused?: number;
  runtime_wait?: {
    state: "reconnecting" | "waiting_resource";
    resource: string;
    since: string;
    retry_at: string | null;
  };
  deploy_status: string;
  /** Final-diff delivery classification; absent rows use the legacy kind rule. */
  delivery_mode?: "full_deploy" | "app_releases" | "none" | null;
  /** JSON exact App-id set for delivery_mode=app_releases. */
  delivery_apps?: string | null;
  /**
   * The agent's own unanswered question (ticket #201), or absent.
   *
   * A SECOND axis, not a status: a ticket can be landed, deployable and still
   * waiting for a person. The row glyph consults it before the deploy axis,
   * because "done, go press deploy" is the wrong sentence for a ticket whose
   * agent said half the work needs a decision first.
   */
  open_question?: string | null;
  model: string;
  effort: string;
  branch?: string;
  commit_sha?: string;
  parent_ticket_id?: number;
  session_id?: string;
  /** Server-minted compact Codex account marker; private slot/path never cross. */
  codex_account_label?: string;
  /** Persisted Runner placement, independent of the viewer's current defaults. */
  execution_placement?: {
    source: "claude" | "codex" | "omp";
    model_device: string;
    execution_device: string;
    /** Empty = default account; absent = not confirmed. */
    account_label?: string;
  };
  turn_started_at?: string;
  updated_at?: string;
  error?: string;
  unread?: number;
  last_author?: string;
  parked_for_lock?: boolean;
  /**
   * What this ticket cost (#192). Server-accumulated from what the CLI itself
   * reported; absent on rows created before the columns existed.
   */
  agent_ms?: number;
  agent_turns?: number;
  tokens_in?: number;
  tokens_out?: number;
  tokens_cached?: number;
  /**
   * Blast radius and churn of the range this ticket landed. `null` means the
   * landing was never measured (never landed, or landed before v46); `0` is a
   * measured zero and is rendered as such.
   */
  diff_files?: number | null;
  diff_modules?: number | null;
  diff_added?: number | null;
  diff_removed?: number | null;
}

export interface Roster {
  spec_concurrency?: number;
  execution_choices?: Record<string, import("../../contract.js").TicketExecutionOptions>;
  tickets?: Ticket[];
  has_more?: boolean;
  counts?: Record<string, number>;
  viewer?: { username?: string; admin?: boolean; dev?: boolean; contribute?: boolean };
  /** Current viewer only; references deliberately omit ticket/session ids. */
  credit_account?: {
    balance: number;
    entries: Array<{
      id: number;
      delta: number;
      reason: "ticket_earn" | "session_spend" | "admin_adjust";
      ref_kind: string;
      created_at: string;
    }>;
  };
  /** What a ticket filed by this viewer will do when its agent submits. */
  viewer_lane?: "direct" | "review";
  /** Whether this viewer may approve/reject proposals and run a batch merge. */
  may_review?: boolean;
  /** Whether this composition serves the review queue at all. */
  review_lane?: boolean;
  base_branch?: string;
  models?: string[];
  /** Labels/families for every catalogued model id, offered or retained for history. */
  model_catalog?: TicketModelChoice[];
  efforts?: string[];
  model_default?: string;
  effort_default?: string;
  /** App release metadata retained for deploy/admin projections, not filing choices. */
  apps?: Array<{ id: string; title: string; refreshable: boolean; served: boolean }>;
  requester_choices?: string[];
  error?: string;
}

export interface DeployState {
  releases?: { enabled: true; deployable: { sha: string; manifestSha256: string } | null;
    snapshot: { mainlineSha: string; ready: { sha: string; manifestSha256: string } | null; checkedAt: string } | null } | null;
  preparation?: {
    sha: string; state: string; error?: string;
    phases?: ReleasePreparationPhase[];
    installation?: { state: string; elapsedMs: number; dependencyCacheHit?: boolean; phases: ReleasePreparationPhase[] };
    maintenance?: { state: string; elapsedMs: number; phases: ReleasePreparationPhase[] };
  } | null;
  ingress?: { ready: boolean; reason: string | null } | null;
  deployed_sha?: string | null;
  base_branch: string;
  stable_branch: string;
  may_deploy?: boolean;
  may_publish_apps?: boolean;
  app_releases_pending?: Array<{
    app_id: string;
    title: string;
    commit_sha: string;
    ticket_id: number | null;
  }>;
  app_release_drain?: {
    active: boolean;
    /** `automatic` needs no operator (#61); `hot-publish` is the Administer retry. */
    mode: "automatic" | "hot-publish" | null;
  };
  runner_bundle?: {
    active_sha: string | null;
    previous_sha: string | null;
    healthy: boolean;
    health_error: string | null;
    pending: Array<{
      ticket_id: number;
      commit_sha: string;
      requested_at: string;
      candidate_sha: string | null;
      last_attempt_at: string | null;
      last_error: string | null;
    }>;
    recent?: Array<{
      id: number;
      target_commit: string;
      candidate_sha: string | null;
      outcome: "activated" | "unchanged" | "failed";
      attempted_at: string;
      error: string | null;
    }>;
  };
  active?: {
    /** deploy_intents primary key; this is a deployment batch, never a ticket number. */
    id: number;
    target_sha: string;
    status: string;
    detail?: string;
    created_at?: string;
    updated_at?: string;
  };
  verify_open?: {
    /** Internal snapshot anchor in verify_tickets; kept for the resolve action, not display. */
    id: number;
    /** Newest deploy_intents key represented by this acceptance snapshot. */
    intent_id: number;
    target_sha: string;
    modules_touched: string;
    checklist: string;
    assignees: string;
    /** Number of successful deploy audit rows folded into this one snapshot. */
    deployment_count?: number;
  };
  /** Recent deployment batches. Their ids are deploy_intents keys, not ticket numbers. */
  recent?: Array<{ id: number; status: string; target_sha?: string; detail?: string | null }>;
}

export interface ReleasePreparationPhase {
  name: string; state: string; startedAt: string; elapsedMs: number;
  bytes?: number; entries?: number; cacheHit?: boolean; filesReused?: number; bytesReused?: number;
}

export interface MergeQueueEntry extends Proposal {
  ticket_id: number;
  ticket_title: string;
  ticket_slug?: string | null;
  requester: string;
  base_sha: string;
  summary: string;
  detail?: string | null;
  created_at?: string;
}

export interface MergeQueue {
  viewer?: Roster["viewer"];
  may_review?: boolean;
  proposals?: MergeQueueEntry[];
}

export const PROPOSAL_LABEL: Record<string, { icon: string; tier: string; label: string }> = {
  ci_pending: { icon: "📤", tier: "run", label: "已提交评审 · CI 运行中" },
  ci_failed: { icon: "🔴", tier: "err", label: "评审候选 CI 失败,等 agent 修复" },
  awaiting_review: { icon: "🧐", tier: "warn", label: "CI 通过 · 等维护者审批" },
  approved: { icon: "👍", tier: "ok", label: "已批准 · 等批量合并" },
  rejected: { icon: "🔙", tier: "err", label: "被打回 · 等 agent 修改" },
  merging: { icon: "🔀", tier: "run", label: "批量合并进行中" },
  merged: { icon: "🎉", tier: "ok", label: "已合入(经批量合并)" },
  merge_failed: { icon: "⚠", tier: "err", label: "批量合并未包含此提案" },
  superseded: { icon: "↻", tier: "mute", label: "已被新提案替换" },
};

/** One server catalog row (`model_catalog`); `family` is the server's routing family. */
export interface TicketModelChoice {
  id: string;
  label: string;
  family: "claude" | "codex" | "omp" | "codex-runner";
}

export function codexAccountDisplayLabel(accountLabel: string): string {
  return /^[a-z]$/.test(accountLabel) ? `Codex-${accountLabel}` : `Codex · ${accountLabel}`;
}

/** The Agent source family that can run a catalogued model; undefined when the server did not name it. */
export function ticketModelSource(
  catalog: readonly TicketModelChoice[] | undefined,
  model: string,
): "claude" | "codex" | "omp" | undefined {
  const family = catalog?.find((entry) => entry.id === model)?.family;
  return family === "codex-runner" ? "codex" : family;
}

/** Server-provided label; an id the catalog does not name is shown as itself. */
export function ticketModelLabel(
  model: string,
  catalog: readonly TicketModelChoice[] | undefined,
  accountLabel?: string,
): string {
  const entry = catalog?.find((row) => row.id === model);
  if (!entry) return model;
  const label = entry.family === "codex-runner" ? `${entry.label} · ${uiText("我的 Runner")}` : entry.label;
  if ((entry.family !== "codex" && entry.family !== "codex-runner") || !accountLabel) return label;
  return label.replace(/^Codex(?=\s|·|$)/, codexAccountDisplayLabel(accountLabel));
}
