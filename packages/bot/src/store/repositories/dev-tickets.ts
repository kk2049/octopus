import type Database from "better-sqlite3";
import type { SessionInputReceipt } from "@claude-bot/runner/gateway-protocol";
export interface NativeTicketInput {
  id: string; ticketId: number; messageId?: number; kind: "message" | "interrupt";
  state: "dispatched" | "accepted" | "failed" | "unknown"; error?: string; receipt?: SessionInputReceipt;
}
import { TicketDevelopmentRepository } from "./ticket-development.js";
import { MergeProposalsRepository } from "./merge-proposals.js";
import { TicketRunnerRepository, type TicketRunnerBinding, type TicketRunnerTurn } from "./ticket-runner.js";

/** One background run of the full suite over an exact watermark tip. */
export interface TestRunRow {
  id: number;
  /** The commit the run pinned. Not a branch — the tip moves while it works. */
  sha: string;
  /** The previous green, so a red can name the batch it implicates. */
  from_sha: string | null;
  status: "running" | "green" | "red" | "aborted";
  started_at: string;
  finished_at: string | null;
  log_tail: string | null;
  /** The ticket a red opened, if one was opened. */
  ticket_id: number | null;
  /** Execution plane. Historical in-process rows are `local`. */
  provider: string;
  /** Provider pipeline id; null only for historical local rows. */
  external_id: string | null;
  external_url: string | null;
  failure_reason: string | null;
}

/**
 * How a ticket or ticket message was written (migration v86, review 6.10).
 * Derived from the credential the write arrived on, never from the text or a
 * caller's claim. Only `browser` (and the reserved `feishu` inbox) is a person
 * typing in an interactive client; `token`/`mcp`/`system` text may carry a
 * person's name as author but was not typed by them there. NULL = written
 * before v86 and therefore unknown.
 */
export const TICKET_ACTOR_KINDS = ["browser", "token", "mcp", "system", "feishu"] as const;
export type TicketActorKind = (typeof TICKET_ACTOR_KINDS)[number];

/**
 * True only when the row is KNOWN not to have been typed by a person in an
 * interactive client. NULL (pre-v86) stays false so legacy rows keep the rules
 * they were written under instead of being reclassified by guesswork.
 */
export function isNonPersonActor(kind: TicketActorKind | null | undefined): boolean {
  return kind === "token" || kind === "mcp" || kind === "system";
}

/** Head-authored conversation rows: the pipeline's own notes and recorded agent replies. */
function defaultActorKind(author: string): TicketActorKind | null {
  return author === "agent" || author === "pipeline" ? "system" : null;
}

export interface DevTicketRow {
  /** Exact Runner-proven native CLI identity; this ticket is never scheduled by the managed pump. */
  native_binding?: string | null;
  /** How the ticket's opening request was written (v86); NULL/absent = unknown. */
  actor_kind?: TicketActorKind | null;
  id: number;
  title: string;
  body: string;
  requester: string;
  /**
   * 'simple' (agent never asks; opens the way to a one-turn close) |
   * 'complex' (may ask, waits for a go-ahead before touching code) |
   * 'app' (legacy Agentic App ticket: a path allowlist plus a trimmed gate) |
   * 'cli' (a read-only delivery report created by the human landing lane).
   *
   * The first two are purely prompt discipline since ticket #16 — the scheduler
   * is FIFO and the merge lock is per-submit, so they do not affect queue
   * position. Historical 'app' rows still carry a hard path gate; new filing
   * uses ordinary kinds and persists final-diff delivery separately (v62).
   */
  kind: string;
  /**
   * Which App an 'app' ticket is about; null for every other kind (migration
   * v32). It selects both halves of the trade — the path allowlist the merge is
   * checked against and the vitest projects the gate runs — so it is stored
   * rather than inferred from the diff.
   */
  app_id: string | null;
  model: string;
  effort: string;
  spec: string | null;
  dev_status: string;
  /** Durable user pause; queued messages never resume it implicitly. */
  chat_paused?: number;
  deploy_status: string | null;
  /** Final-diff delivery classification (v62); NULL rows use legacy kind fallback. */
  delivery_mode: "full_deploy" | "app_releases" | "none" | null;
  /** JSON exact App-id set for delivery_mode=app_releases; otherwise `[]`/NULL. */
  delivery_apps: string | null;
  /**
   * The agent's own unanswered question, or null (ticket #201).
   *
   * Orthogonal to `dev_status` on purpose: a ticket can be landed, deployable
   * and still waiting for a person. Cleared when the requester speaks.
   */
  open_question: string | null;
  /**
   * The failing spec files a CI repair ticket must make green (migration v48,
   * ticket #219). JSON array; NULL on every ticket that did not come from a red
   * batch. `[]` is meaningful and different from NULL — see the migration and
   * `devpipe/ci-roster.ts`. The land gate reads it; nothing else may widen it.
   */
  ci_roster: string | null;
  /**
   * What `devpipe_submit` does with a verified candidate (migration v51):
   * 'direct' fast-forwards the base branch; 'review' publishes a
   * `contrib/<user>/ticket-<id>` branch and waits for a maintainer's decision
   * (see `store/repositories/merge-proposals.ts`). Decided at creation from the
   * requester's capabilities and reconciled at each turn and submit, so both
   * granting and revoking `dev` take effect on an existing ticket rather than
   * only the next ticket.
   */
  lane: string;
  branch: string | null;
  commit_sha: string | null;
  session_id: string | null;
  /** Opaque direct-Codex account binding (migration v54); never an account id, path, or credential. */
  codex_account_slot: string | null;
  /**
   * Stable knowledge conflict id for a collaboration chat (migration v60).
   * The graph is rebuildable, so this pointer has no database foreign key.
   */
  knowledge_subject_id: string | null;
  worktree: string | null;
  parent_ticket_id: number | null;
  gate_attempts: number;
  error: string | null;
  /** Non-null while a headless CLI turn is actually running (see migration v15). */
  turn_started_at: string | null;
  /**
   * Short sidebar label chosen by the spec-turn agent (or the backfill turn
   * for old rows). NULL until it has run — the panel falls back to `title`.
   * See migration v17 / ticket #8.
   */
  slug: string | null;
  /**
   * Wall-clock at the moment this ticket's branch fast-forwarded into the base
   * branch (ticket #16, migration v22). NULL for open/cancelled tickets AND
   * for rows that landed before v22 — the panel sorts landed rows by this so
   * the sidebar order matches git commit order.
   */
  landed_at: string | null;
  /**
   * What this ticket cost (migration v46, ticket #192). Accumulated across
   * turns by the pipeline from what the CLI itself reported, never estimated.
   * Zero means "nothing has been spent yet", which is true for a queued row.
   */
  agent_ms: number;
  agent_turns: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  /**
   * Blast radius and churn of the range this ticket fast-forwarded, written
   * once at landing. NULL for a ticket that never landed and for rows that
   * landed before v46 — the panel shows nothing rather than a false zero.
   */
  diff_files: number | null;
  diff_modules: number | null;
  diff_added: number | null;
  diff_removed: number | null;
  created_at: string;
  updated_at: string;
}

/** Roster row: `last_author`/`unread` let the panel pick a row glyph ("agent
 * 在等你" vs "消息排队中") without a per-ticket message fetch. */
export interface DevTicketListRow extends DevTicketRow {
  last_author: string | null;
  unread: number;
}

export interface TicketMessageRow {
  id: number;
  ticket_id: number;
  author: string;
  via: string; // 'web' | 'feishu' | 'agent' | 'pipeline'
  /** How this row was written (v86); NULL/absent = written before v86. */
  actor_kind?: TicketActorKind | null;
  body: string;
  delivered_turn: number | null;
  delivery_state?: "sending" | "delivered" | "failed" | "unknown" | null;
  delivery_error?: string | null;
  delivery_input?: string | null;
  created_at: string;
}

/** Durable arrival order for an agent that ended its turn waiting for merge. */
export interface DevMergeWaiterRow {
  ticket_id: number;
  queue_sequence: number;
  queued_at: string;
  updated_at: string;
}

/**
 * The whole status set since v19 (ticket #12). A ticket is a conversation:
 * 'open' while it is alive (asking, erroring and approving are messages, not
 * statuses), 'landed' once its branch fast-forwarded into the base branch —
 * and a landed ticket still takes messages, so follow-up work lands again.
 * "Which turn may mutate code" lives in the pipeline's claim/submit lock,
 * not here.
 */
export const DEV_TICKET_STATUSES = ["open", "landed", "cancelled"];

/** The two things a verified candidate can become; see `DevTicketRow.lane`. */
export const DEV_TICKET_LANES = ["direct", "review"] as const;
export type DevTicketLane = (typeof DEV_TICKET_LANES)[number];

/**
 * Pure FIFO by ticket id (ticket #16). The old rule ("complex first, then
 * FIFO") let a complex ticket filed at 10:00 jump ahead of a simple one filed
 * at 09:50 — meant for the era when the shared dev lane was the bottleneck
 * (a complex round-trip freed the lane faster than a full simple ticket did).
 * With per-ticket worktrees and the ticket #16 model (parallel coding, only
 * the merge serialises), that reasoning no longer applies: kind is now pure
 * prompt discipline, and jumping the queue just penalises whoever filed first.
 */
const DEV_TICKET_PRIORITY = "id ASC";

interface DevTicketPatch {
  /**
   * Ticket #38-5 (discuss mode): the agent may rename a `discuss` ticket via
   * devpipe_rename. Every other kind treats title as immutable contract; the
   * pipeline is the only writer here and only for discuss.
   */
  title: string;
  kind: string;
  app_id: string | null;
  spec: string | null;
  slug: string | null;
  dev_status: string;
  chat_paused: number;
  deploy_status: string | null;
  delivery_mode: "full_deploy" | "app_releases" | "none" | null;
  delivery_apps: string | null;
  open_question: string | null;
  ci_roster: string | null;
  lane: string;
  branch: string | null;
  commit_sha: string | null;
  session_id: string | null;
  codex_account_slot: string | null;
  worktree: string | null;
  gate_attempts: number;
  error: string | null;
  turn_started_at: string | null;
  landed_at: string | null;
  agent_ms: number;
  agent_turns: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  diff_files: number | null;
  diff_modules: number | null;
  diff_added: number | null;
  diff_removed: number | null;
}

const DEV_TICKET_PATCHABLE = new Set<keyof DevTicketPatch>([
  "chat_paused",
  "title",
  "kind",
  "app_id",
  "spec",
  "slug",
  "dev_status",
  "deploy_status",
  "delivery_mode",
  "delivery_apps",
  "open_question",
  "ci_roster",
  "lane",
  "branch",
  "commit_sha",
  "session_id",
  "codex_account_slot",
  "worktree",
  "turn_started_at",
  "gate_attempts",
  "error",
  "landed_at",
  "agent_ms",
  "agent_turns",
  "tokens_in",
  "tokens_out",
  "tokens_cached",
  "diff_files",
  "diff_modules",
  "diff_added",
  "diff_removed",
]);

export interface DeployIntentRow {
  id: number;
  target_sha: string;
  release_manifest_sha256?: string | null;
  base_sha: string | null;
  triggered_by: string;
  trigger_source: string | null;
  status: string;
  confirm_deadline: string | null;
  confirm_decision: string | null;
  confirm_by: string | null;
  confirm_at: string | null;
  detail: string | null;
  notified: number;
  created_at: string;
  updated_at: string;
}

export interface VerifyTicketRow {
  id: number;
  intent_id: number;
  target_sha: string;
  ticket_ids: string;
  modules_touched: string;
  checklist: string;
  assignees: string;
  status: string;
  resolved_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The one product-acceptance block shown to a user.
 *
 * Each successful deploy keeps its own immutable verify row for audit, while
 * the dashboard folds every still-open row through `id` into this snapshot.
 * The id of the newest member is the snapshot anchor: resolving it can never
 * accidentally accept a newer deploy that arrived after the page rendered.
 */
export interface VerifyTicketBlock extends VerifyTicketRow {
  deployment_count: number;
}

function jsonArray<T>(raw: string): T[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    // Historical audit data must not take the whole deploy panel down. The
    // malformed row remains in the block and can still be resolved by id.
    return [];
  }
}

/** Fold per-deploy audit rows into the single acceptance block users see. */
export function aggregateVerifyTickets(rows: readonly VerifyTicketRow[]): VerifyTicketBlock | undefined {
  if (!rows.length) return undefined;
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  const newest = ordered.at(-1)!;
  const ticketIds = new Set<number>();
  const modules = new Set<string>();
  const assignees = new Set<string>();
  const checklist = new Map<number, { ticket_id: number; title: string; criteria: string }>();
  for (const row of ordered) {
    for (const id of jsonArray<number>(row.ticket_ids)) {
      if (Number.isSafeInteger(id) && id > 0) ticketIds.add(id);
    }
    for (const module of jsonArray<string>(row.modules_touched)) {
      if (typeof module === "string" && module) modules.add(module);
    }
    for (const assignee of jsonArray<string>(row.assignees)) {
      if (typeof assignee === "string" && assignee) assignees.add(assignee);
    }
    for (const item of jsonArray<{ ticket_id?: unknown; title?: unknown; criteria?: unknown }>(row.checklist)) {
      const id = Number(item?.ticket_id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      checklist.set(id, {
        ticket_id: id,
        title: typeof item.title === "string" ? item.title : `工单 #${id}`,
        criteria: typeof item.criteria === "string" ? item.criteria : "",
      });
    }
  }
  return {
    ...newest,
    ticket_ids: JSON.stringify([...ticketIds]),
    modules_touched: JSON.stringify([...modules].sort()),
    checklist: JSON.stringify([...checklist.values()]),
    assignees: JSON.stringify([...assignees]),
    created_at: ordered[0]!.created_at,
    deployment_count: ordered.length,
  };
}

export const DEPLOY_ACTIVE_STATUSES = [
  "requested",
  "claimed",
  "building",
  "restarting",
  "health_gate",
  "confirm_wait",
];

const DEPLOY_ACTIVE_PLACEHOLDERS = DEPLOY_ACTIVE_STATUSES.map(() => "?").join(",");

interface DeployIntentPatch {
  status: string;
  base_sha: string | null;
  confirm_deadline: string | null;
  detail: string | null;
  notified: number;
}

const DEPLOY_INTENT_PATCHABLE = new Set<keyof DeployIntentPatch>([
  "status",
  "base_sha",
  "confirm_deadline",
  "detail",
  "notified",
]);

/** SQLite repository for the complete self-hosting ticket and delivery lifecycle. */
export class DevTicketsRepository {
  readonly runner: TicketRunnerRepository;
  readonly development: TicketDevelopmentRepository;
  constructor(private readonly db: Database.Database) { this.runner = new TicketRunnerRepository(db); this.development = new TicketDevelopmentRepository(db); }

  // ── Background test batches ──

  /** Open a run over one exact watermark tip. */
  startTestRun(sha: string, from: string | null, startedAt: string): number {
    const res = this.db
      .prepare("INSERT INTO test_runs (sha, from_sha, status, started_at) VALUES (?, ?, 'running', ?)")
      .run(sha, from, startedAt);
    return Number(res.lastInsertRowid);
  }

  /** Start one provider-owned run, idempotently by provider pipeline id. */
  startExternalTestRun(input: {
    provider: string;
    externalId: string;
    externalUrl: string | null;
    sha: string;
    fromSha: string | null;
    startedAt: string;
  }): TestRunRow {
    this.db
      .prepare(
        `INSERT INTO test_runs
           (sha, from_sha, status, started_at, provider, external_id, external_url)
         VALUES (?, ?, 'running', ?, ?, ?, ?)
         ON CONFLICT(provider, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
      )
      .run(input.sha, input.fromSha, input.startedAt, input.provider, input.externalId, input.externalUrl);
    return this.getExternalTestRun(input.provider, input.externalId)!;
  }

  getExternalTestRun(provider: string, externalId: string): TestRunRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM test_runs WHERE provider = ? AND external_id = ?")
        .get(provider, externalId) as TestRunRow | undefined) ?? null
    );
  }

  finishTestRun(id: number, status: "green" | "red" | "aborted", finishedAt: string, logTail: string): void {
    this.db
      .prepare("UPDATE test_runs SET status = ?, finished_at = ?, log_tail = ? WHERE id = ?")
      .run(status, finishedAt, logTail.slice(-20_000), id);
  }

  finishExternalTestRun(
    id: number,
    status: "green" | "red" | "aborted",
    finishedAt: string,
    logTail: string,
    failureReason: string | null,
  ): void {
    this.db
      .prepare("UPDATE test_runs SET status = ?, finished_at = ?, log_tail = ?, failure_reason = ? WHERE id = ?")
      .run(status, finishedAt, logTail.slice(-20_000), failureReason, id);
  }

  attachTestRunTicket(id: number, ticketId: number): void {
    this.db.prepare("UPDATE test_runs SET ticket_id = ? WHERE id = ?").run(ticketId, id);
  }

  /** Every run left 'running' becomes 'aborted'. Called once at startup. */
  abortRunningTestRuns(at: string): number {
    return this.db
      .prepare("UPDATE test_runs SET status = 'aborted', finished_at = ? WHERE status = 'running'")
      .run(at).changes;
  }

  latestTestRun(status?: "green" | "red"): TestRunRow | null {
    const sql = status
      ? "SELECT * FROM test_runs WHERE status = ? ORDER BY id DESC LIMIT 1"
      : "SELECT * FROM test_runs ORDER BY id DESC LIMIT 1";
    const row = status ? this.db.prepare(sql).get(status) : this.db.prepare(sql).get();
    return (row as TestRunRow | undefined) ?? null;
  }

  listTestRuns(limit = 20): TestRunRow[] {
    return this.db.prepare("SELECT * FROM test_runs ORDER BY id DESC LIMIT ?").all(limit) as TestRunRow[];
  }

  // ── Dev tickets ──

  /** Persist a normalized ticket, its immutable placement and unread inbox atomically. */
  createDevTicket(t: {
    title: string;
    body: string;
    requester: string;
    kind: string;
    app_id: string | null;
    model: string;
    effort: string;
    parent_ticket_id?: number | null;
    via?: string;
    /** JSON roster; non-null opens the CI repair lane (devpipe/ci-roster.ts). */
    ci_roster?: string | null;
    /** 'direct' (default) or 'review'; see `DevTicketRow.lane`. */
    lane?: DevTicketLane;
    /** Immutable graph conflict id for a knowledge collaboration chat. */
    knowledge_subject_id?: string | null;
    runner_binding?: TicketRunnerBinding;
    /** How the opening request was written; the first message carries the same kind. */
    actor_kind?: TicketActorKind | null;
  }): DevTicketRow {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const actorKind = t.actor_kind ?? null;
      const res = this.db
        .prepare(
          `INSERT INTO dev_tickets (
             title, body, requester, kind, app_id, model, effort,
             parent_ticket_id, ci_roster, lane, knowledge_subject_id, actor_kind,
             dev_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(
          t.title,
          t.body,
          t.requester,
          t.kind,
          t.app_id,
          t.model,
          t.effort,
          t.parent_ticket_id ?? null,
          t.ci_roster ?? null,
          t.lane ?? "direct",
          t.knowledge_subject_id ?? null,
          actorKind,
          now,
          now,
        );
      const id = Number(res.lastInsertRowid);
      if (t.runner_binding) this.runner.bind(id, t.runner_binding);
      this.addTicketMessage(id, t.requester, t.via ?? "web", t.body, undefined, actorKind);
      return this.getDevTicket(id)!;
    })();
  }

  /** Newest collaboration chats first; a graph rebuild cannot retarget them. */
  listKnowledgeConflictTickets(subjectId: string, limit = 50): DevTicketRow[] {
    return this.db.prepare(
      `SELECT * FROM dev_tickets
       WHERE knowledge_subject_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    ).all(subjectId, Math.max(1, Math.min(limit, 100))) as DevTicketRow[];
  }

  /** Project a checked-in CLI delivery report into the existing deploy axis. */
  createCliDeliveryTicket(t: {
    native_ticket_id?: number;
    title: string;
    body: string;
    spec: string;
    requester: string;
    branch: string;
    commit_sha: string;
    model: string;
    effort: string;
  }): DevTicketRow {
    return this.db.transaction(() => {
      if (t.native_ticket_id !== undefined) {
        const native = this.getDevTicket(t.native_ticket_id);
        if (!native?.native_binding || native.requester !== t.requester || (native.commit_sha && native.commit_sha !== t.commit_sha)) throw new Error("CLI report does not match its registered native ticket");
        this.db.prepare(`UPDATE dev_tickets SET title=?,body=?,spec=?,kind='cli',dev_status='landed',deploy_status='pending',
          commit_sha=?,landed_at=COALESCE(landed_at,?),updated_at=? WHERE id=?`).run(t.title, t.body, t.spec, t.commit_sha,
            new Date().toISOString(), new Date().toISOString(), native.id);
        return this.getDevTicket(native.id)!;
      }
      const existing = this.db
        .prepare("SELECT * FROM dev_tickets WHERE kind = 'cli' AND commit_sha = ? LIMIT 1")
        .get(t.commit_sha) as DevTicketRow | undefined;
      if (existing) return existing;

      const now = new Date().toISOString();
      const slug = [...t.title].slice(0, 14).join("");
      const res = this.db
        .prepare(
          `INSERT INTO dev_tickets
             (title, body, requester, kind, app_id, model, effort, spec,
              dev_status, deploy_status, branch, commit_sha, slug, landed_at,
              actor_kind, created_at, updated_at)
           VALUES (?, ?, ?, 'cli', NULL, ?, ?, ?, 'landed', 'pending', ?, ?, ?, ?, 'system', ?, ?)`,
        )
        .run(
          t.title,
          t.body,
          t.requester,
          t.model,
          t.effort,
          t.spec,
          t.branch,
          t.commit_sha,
          slug,
          now,
          now,
          now,
        );
      const id = Number(res.lastInsertRowid);
      this.db
        .prepare(
          "INSERT INTO ticket_messages (ticket_id, author, via, body, delivered_turn, actor_kind, created_at) VALUES (?, ?, 'cli-report', ?, 0, 'system', ?)",
        )
        .run(id, t.requester, t.body, now);
      return this.getDevTicket(id)!;
    })();
  }

  /**
   * The ticket whose landing produced this exact commit (ticket #219).
   *
   * `commit_sha` is the branch TIP the landing fast-forwarded to, so this
   * matches one commit per landing — enough to name every ticket in a range,
   * which is what the CI change history needs. Non-tip commits of a
   * multi-commit branch stay unmatched rather than being guessed at.
   */
  findDevTicketByCommitSha(sha: string): DevTicketRow | undefined {
    return this.db
      .prepare("SELECT * FROM dev_tickets WHERE commit_sha = ? ORDER BY id DESC LIMIT 1")
      .get(sha) as DevTicketRow | undefined;
  }

  cliReleaseProjection(sha: string): { ticket_id: number; projected_at: string } | undefined {
    return this.db.prepare("SELECT ticket_id,projected_at FROM cli_release_projections WHERE commit_sha=?")
      .get(sha) as { ticket_id: number; projected_at: string } | undefined;
  }

  /** After recording report/debt; recovery includes this in the same transaction. */
  recordCliReleaseProjection(ticketId: number, sha: string): void {
    const existing = this.cliReleaseProjection(sha);
    if (existing && existing.ticket_id !== ticketId) throw new Error("CLI 发布投影已绑定其他工单");
    this.db.prepare("INSERT OR IGNORE INTO cli_release_projections(commit_sha,ticket_id,projected_at) VALUES(?,?,?)")
      .run(sha, ticketId, new Date().toISOString());
  }

  getDevTicket(id: number): DevTicketRow | undefined {
    return this.db.prepare("SELECT * FROM dev_tickets WHERE id = ?").get(id) as DevTicketRow | undefined;
  }

  listDevTickets(limit = 200, filters: {
    query?: string;
    requester?: string;
    status?: string;
    /** Trusted route scope, independent of the user-supplied requester filter. */
    owner?: string;
    offset?: number;
  } = {}): DevTicketListRow[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    for (const [column, value] of [
      ["requester", filters.owner], ["requester", filters.requester], ["dev_status", filters.status],
    ]) {
      if (value !== undefined) { clauses.push(`t.${column} = ?`); values.push(value); }
    }
    const keyword = filters.query?.trim();
    if (keyword) {
      // instr treats %, _ and quotes literally. Search human follow-ups too,
      // but do not scan external agent transcripts or tool output.
      clauses.push(`(instr(lower(t.title), lower(?)) > 0
        OR instr(lower(COALESCE(t.slug, '')), lower(?)) > 0
        OR instr(lower(t.body), lower(?)) > 0
        OR CAST(t.id AS TEXT) = ?
        OR EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id
          AND m.author <> 'agent' AND instr(lower(m.body), lower(?)) > 0))`);
      values.push(keyword, keyword, keyword, keyword.replace(/^#/, ""), keyword);
    }
    return this.db
      .prepare(
        `SELECT t.*,
                (SELECT m.author FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_author,
                (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id AND m.delivered_turn IS NULL AND t.native_binding IS NULL) AS unread
           FROM dev_tickets t
           LEFT JOIN merge_proposals p
             ON p.id = (SELECT MAX(latest.id) FROM merge_proposals latest WHERE latest.ticket_id = t.id)
           ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
           ORDER BY CASE
                      -- A review-lane ticket remains an open conversation after
                      -- its candidate is incorporated. Once its latest proposal
                      -- is merged, however, it belongs in the completed timeline
                      -- rather than permanently outranking every landed ticket.
                      WHEN t.dev_status = 'open' AND (COALESCE(p.status, '') <> 'merged'
                        OR t.turn_started_at IS NOT NULL OR t.error IS NOT NULL OR t.open_question IS NOT NULL OR unread > 0) THEN 0
                      WHEN t.dev_status = 'completed' THEN 1
                      WHEN t.dev_status = 'landed' AND t.landed_at IS NOT NULL THEN 1
                      WHEN t.dev_status = 'open' AND p.status = 'merged' THEN 1
                      WHEN t.dev_status = 'landed' THEN 2
                      ELSE 3
                    END,
                    CASE
                      WHEN t.dev_status = 'completed' THEN t.updated_at
                      WHEN t.dev_status = 'landed' THEN t.landed_at
                      WHEN t.dev_status = 'open' AND p.status = 'merged' THEN p.updated_at
                    END DESC,
                    t.id DESC
           LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, filters.offset ?? 0) as DevTicketListRow[];
  }

  /** Every ticket in these deployment states, unpaged: deploy bookkeeping must see all of them. */
  listTicketsByDeployStatus(statuses: readonly string[]): DevTicketRow[] {
    if (!statuses.length) return [];
    return this.db
      .prepare(`SELECT * FROM dev_tickets WHERE deploy_status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`)
      .all(...statuses) as DevTicketRow[];
  }

  /** App-only landings whose release set has not yet been acknowledged live. */
  listPendingAppReleaseTickets(): DevTicketRow[] {
    return this.db
      .prepare(
        `SELECT * FROM dev_tickets
           WHERE dev_status = 'landed'
             AND deploy_status IN ('pending', 'deploying', 'live_unverified')
             AND (
               delivery_mode = 'app_releases'
               OR (delivery_mode IS NULL AND kind = 'app')
             )
           ORDER BY id`,
      )
      .all() as DevTicketRow[];
  }


  listTicketsNeedingTurn(): DevTicketRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM dev_tickets t
           WHERE t.dev_status NOT IN ('cancelled', 'completed')
             AND t.chat_paused = 0
             AND t.native_binding IS NULL
             AND EXISTS (SELECT 1 FROM ticket_messages m
                          WHERE m.ticket_id = t.id AND m.delivered_turn IS NULL)
           ORDER BY ${DEV_TICKET_PRIORITY}`,
      )
      .all() as DevTicketRow[];
  }

  /** Claim inbox and persist its exact Runner request in one transaction. */
  prepareRunnerTurn(ticketId: number, turn: number, build: (messages: TicketMessageRow[]) => TicketRunnerTurn): TicketRunnerTurn | null {
    return this.db.transaction(() => {
      const existing = this.runner.active(ticketId);
      if (existing) return existing;
      const messages = this.takeTicketInbox(ticketId, turn);
      if (!messages.length) return null;
      const operation = build(messages);
      operation.messageIds = messages.map((message) => message.id);
      this.runner.messageDelivery(operation.messageIds, "sending");
      this.runner.save(operation);
      this.updateDevTicket(ticketId, { turn_started_at: new Date().toISOString(), error: null });
      return operation;
    })();
  }

  /**
   * Recover turns left running by a dead process.
   *
   * Clearing the liveness marker and creating its unread wake-up are one
   * durable transition. If the new process dies during recovery, SQLite
   * leaves either the old marker or the new inbox message — never the silent
   * state where both are absent.
   */
  recoverInterruptedDevTurns(restartWakeMessage: string): number[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT id FROM dev_tickets WHERE turn_started_at IS NOT NULL")
        .all() as Array<{ id: number }>;
      if (rows.length) {
        this.db.prepare("UPDATE dev_tickets SET turn_started_at = NULL WHERE turn_started_at IS NOT NULL").run();
        for (const row of rows) {
          this.addTicketMessage(row.id, "pipeline", "pipeline", restartWakeMessage);
        }
      }
      return rows.map((row) => row.id);
    })();
  }

  /** Finish one live turn, optionally leaving an atomic restart wake-up. */
  finishDevTurn(ticketId: number, restartWakeMessage?: string): boolean {
    return this.db.transaction(() => {
      const cleared = this.db
        .prepare("UPDATE dev_tickets SET turn_started_at = NULL WHERE id = ? AND turn_started_at IS NOT NULL")
        .run(ticketId);
      if (cleared.changes === 1 && restartWakeMessage) {
        this.addTicketMessage(ticketId, "pipeline", "pipeline", restartWakeMessage);
      }
      return cleared.changes === 1;
    })();
  }

  /** Record waiting intent without changing an existing waiter's FIFO place. */
  rememberMergeWaiter(ticketId: number, at = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO dev_merge_waiters (ticket_id, queue_sequence, queued_at, updated_at)
         VALUES (?, COALESCE((SELECT MAX(queue_sequence) + 1 FROM dev_merge_waiters), 1), ?, ?)
         ON CONFLICT(ticket_id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(ticketId, at, at);
  }

  /** A failed/expired offer rejoins at the tail, matching FairWakeLock. */
  moveMergeWaiterToTail(ticketId: number, at = new Date().toISOString()): void {
    this.db
      .prepare(
        `UPDATE dev_merge_waiters
            SET queue_sequence = (SELECT COALESCE(MAX(queue_sequence) + 1, 1) FROM dev_merge_waiters),
                queued_at = ?, updated_at = ?
          WHERE ticket_id = ?`,
      )
      .run(at, at, ticketId);
  }

  forgetMergeWaiter(ticketId: number): boolean {
    return this.db.prepare("DELETE FROM dev_merge_waiters WHERE ticket_id = ?").run(ticketId).changes === 1;
  }

  listMergeWaiters(): DevMergeWaiterRow[] {
    return this.db
      .prepare("SELECT * FROM dev_merge_waiters ORDER BY queue_sequence")
      .all() as DevMergeWaiterRow[];
  }

  updateDevTicket(id: number, patch: Partial<DevTicketPatch>): void {
    const keys = Object.keys(patch) as Array<keyof DevTicketPatch>;
    if (keys.length === 0) return;
    for (const key of keys) {
      if (!DEV_TICKET_PATCHABLE.has(key)) throw new Error(`unpatchable dev_ticket column: ${String(key)}`);
    }
    const sets = keys.map((key) => `${String(key)} = ?`).join(", ");
    this.db
      .prepare(`UPDATE dev_tickets SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((key) => patch[key] ?? null), new Date().toISOString(), id);
  }

  /** Human completion preserves the conversation and never consumes pending work. */
  completeTicket(id: number, actor: string): DevTicketRow {
    return this.db.transaction(() => {
      const ticket = this.getDevTicket(id);
      if (!ticket) throw new Error(`工单不存在: #${id}`);
      if (ticket.dev_status === "completed") return ticket;
      if (ticket.dev_status !== "open" || ticket.kind === "cli") throw new Error("只有未合入的普通工单可以标记完成");
      if (new MergeProposalsRepository(this.db).liveForTicket(id)) throw new Error("工单仍有待处理的合入提案，请先完成评审流程");
      if (ticket.turn_started_at || this.runner.active(id)) throw new Error("本轮仍在执行，请先停止本轮或等待结束");
      if (this.listTicketMessages(id, { undeliveredOnly: true }).length) throw new Error("工单还有排队消息，不能标记完成");
      this.updateDevTicket(id, { dev_status: "completed", open_question: null, error: null });
      this.addTicketMessage(id, "pipeline", "pipeline", `${actor} 将工单标记为已完成；对话、会话和工作区保留，可发新消息继续。`, 0);
      return this.getDevTicket(id)!;
    })();
  }

  countDevTickets(): { open: number; running: number; queued_input: number; landed_pending: number } {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return {
      open: one("SELECT COUNT(*) AS n FROM dev_tickets WHERE dev_status = 'open'"),
      running: one("SELECT COUNT(*) AS n FROM dev_tickets WHERE turn_started_at IS NOT NULL"),
      queued_input: one(
        `SELECT COUNT(*) AS n FROM dev_tickets t
          WHERE t.dev_status NOT IN ('cancelled', 'completed') AND t.turn_started_at IS NULL AND t.native_binding IS NULL
            AND EXISTS (SELECT 1 FROM ticket_messages m
                         WHERE m.ticket_id = t.id AND m.delivered_turn IS NULL)`,
      ),
      landed_pending: one(
        `SELECT COUNT(*) AS n FROM dev_tickets
          WHERE COALESCE(
                  delivery_mode,
                  CASE WHEN COALESCE(kind, 'simple') = 'app' THEN 'app_releases' ELSE 'full_deploy' END
                ) = 'full_deploy'
            AND dev_status = 'landed' AND deploy_status = 'pending'`,
      ),
    };
  }

  addTicketMessage(
    ticketId: number,
    author: string,
    via: string,
    body: string,
    deliveredTurn?: number,
    /** How the row was written; omitted means `system` for agent/pipeline authors, else unknown. */
    actorKind?: TicketActorKind | null,
  ): TicketMessageRow {
    return this.db.transaction(() => {
      if (author !== "pipeline" && author !== "agent") {
        this.db.prepare("UPDATE dev_tickets SET dev_status = 'open', updated_at = ? WHERE id = ? AND dev_status = 'completed'")
          .run(new Date().toISOString(), ticketId);
      }
      const res = this.db
        .prepare(
          "INSERT INTO ticket_messages (ticket_id, author, via, body, delivered_turn, actor_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(ticketId, author, via, body, deliveredTurn ?? null, actorKind ?? defaultActorKind(author), new Date().toISOString());
      return this.db.prepare("SELECT * FROM ticket_messages WHERE id = ?").get(res.lastInsertRowid) as TicketMessageRow;
    })();
  }

  listTicketMessages(ticketId: number, opts?: { undeliveredOnly?: boolean }): TicketMessageRow[] {
    const sql = opts?.undeliveredOnly
      ? "SELECT * FROM ticket_messages WHERE ticket_id = ? AND delivered_turn IS NULL ORDER BY id"
      : "SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id";
    return this.db.prepare(sql).all(ticketId) as TicketMessageRow[];
  }

  /** Messages that a given turn consumed — its inbox plus anything delivered
   * into it while it ran (ticket #183). Ordered like the conversation. */
  listTicketMessagesForTurn(ticketId: number, turn: number): TicketMessageRow[] {
    return this.db
      .prepare("SELECT * FROM ticket_messages WHERE ticket_id = ? AND delivered_turn = ? ORDER BY id")
      .all(ticketId, turn) as TicketMessageRow[];
  }

  /**
   * Stamp exactly one message as consumed by a turn (ticket #183: a message
   * handed to a RUNNING turn, rather than flushed into the next one).
   * Never re-stamps an already delivered row.
   */
  markTicketMessageDelivered(id: number, turn: number): boolean {
    const result = this.db
      .prepare("UPDATE ticket_messages SET delivered_turn = ? WHERE id = ? AND delivered_turn IS NULL")
      .run(turn, id);
    return result.changes === 1;
  }

  takeTicketInbox(ticketId: number, turn: number): TicketMessageRow[] {
    return this.db.transaction(() => {
      const rows = this.listTicketMessages(ticketId, { undeliveredOnly: true });
      if (rows.length) {
        const marks = this.db.prepare("UPDATE ticket_messages SET delivered_turn = ? WHERE id = ?");
        for (const row of rows) marks.run(turn, row.id);
      }
      return rows;
    })();
  }

  // ── Deploy intents ──

  registerNativeTicket(input: { owner: string; device: string; source: "codex" | "claude"; sessionId: string; workspaceId: string;
    relativePath: string; branch: string; remote: string; title: string; ticketId?: number }): DevTicketRow {
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM dev_tickets WHERE json_extract(native_binding,'$.owner')=?
        AND json_extract(native_binding,'$.device')=? AND json_extract(native_binding,'$.source')=? AND json_extract(native_binding,'$.sessionId')=?`)
        .get(input.owner, input.device, input.source, input.sessionId) as DevTicketRow | undefined;
      const { title, ticketId, ...binding } = input;
      if (existing) {
        if (ticketId !== undefined && existing.id !== ticketId) throw new Error("native session already belongs to another ticket");
        if (existing.native_binding !== JSON.stringify(binding)) throw new Error("native session registration cannot change its repository or workspace");
        if (existing.chat_paused) this.updateDevTicket(existing.id, { chat_paused: 0,
          ...(existing.dev_status === "completed" ? { dev_status: "open" as const } : {}) });
        return this.getDevTicket(existing.id)!;
      }
      const target = ticketId === undefined ? undefined : this.getDevTicket(ticketId);
      if (ticketId !== undefined && (!target || target.requester !== input.owner || target.kind !== "cli" || target.dev_status !== "landed"
        || target.native_binding || target.session_id || target.turn_started_at || this.runner.binding(ticketId))) throw new Error("only an unbound landed CLI report owned by this Runner user can be attached");
      const runnerBinding = { owner: input.owner, device: input.device, executionDevice: input.device, source: input.source, workspaceId: input.workspaceId };
      const cli = input.source === "claude" ? "Claude Code" : "Codex";
      const ticket = target ?? this.createDevTicket({ title, body: `已绑定本地 ${cli} CLI；原生 CLI 持有执行权，网页观察并通过原生接口交互。`, requester: input.owner,
        kind: "simple", app_id: null, model: `${input.source}-native`, effort: "high", via: "native-cli", runner_binding: runnerBinding, actor_kind: "system" });
      this.runner.bind(ticket.id, runnerBinding);
      this.db.prepare("UPDATE dev_tickets SET native_binding=?,session_id=?,branch=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(binding), input.sessionId, target ? ticket.branch : input.branch, new Date().toISOString(), ticket.id);
      if (target) this.addTicketMessage(ticket.id, "pipeline", "pipeline", "绑定者通过本地 Runner 将现有原生 CLI 会话关联到此交付记录；合入和上线状态保留。", 0);
      else this.db.prepare("UPDATE ticket_messages SET delivered_turn=0,delivery_state='delivered' WHERE ticket_id=?").run(ticket.id);
      return this.getDevTicket(ticket.id)!;
    })();
  }
  /** Stop observing/control from the ticket; never signal or complete the CLI. */
  closeNativeTicket(id: number, actor: string): DevTicketRow {
    return this.db.transaction(() => {
      const ticket = this.getDevTicket(id);
      if (!ticket?.native_binding) throw new Error("ticket is not attached to a native CLI");
      if (!ticket.chat_paused) {
        this.updateDevTicket(id, { chat_paused: 1, ...(ticket.dev_status === "open" ? { dev_status: "completed" as const } : {}) });
        this.addTicketMessage(id, "pipeline", "pipeline", `${actor} 结束网页跟踪；原生 CLI 不受影响，历史与操作回执保留。可由本地 CLI 重新注册以恢复跟踪。`, 0);
      }
      return this.getDevTicket(id)!;
    })();
  }
  nativeInput(id: string): NativeTicketInput | null {
    const row = this.db.prepare("SELECT record FROM dev_native_inputs WHERE id=?").get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as NativeTicketInput : null;
  }
  createNativeInput(input: NativeTicketInput, author: string, prompt?: string, actorKind?: TicketActorKind | null): NativeTicketInput {
    return this.db.transaction(() => {
      if (prompt) input = { ...input, messageId: this.addTicketMessage(input.ticketId, author, "web", prompt, undefined, actorKind).id };
      this.saveNativeInput(input); return input;
    })();
  }
  latestNativeInput(ticketId: number): NativeTicketInput | null {
    const row = this.db.prepare("SELECT record FROM dev_native_inputs WHERE ticket_id=? ORDER BY rowid DESC LIMIT 1").get(ticketId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as NativeTicketInput : null;
  }
  pendingNativeInputs(ticketId: number): NativeTicketInput[] {
    return (this.db.prepare(`SELECT record FROM dev_native_inputs WHERE ticket_id=?
      AND state IN ('dispatched','unknown') ORDER BY rowid LIMIT 16`).all(ticketId) as Array<{ record: string }>)
      .map(row => JSON.parse(row.record) as NativeTicketInput);
  }
  saveNativeInput(input: NativeTicketInput): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO dev_native_inputs(id,ticket_id,message_id,state,record) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET state=excluded.state,record=excluded.record`)
        .run(input.id, input.ticketId, input.messageId ?? null, input.state, JSON.stringify(input));
      if (input.messageId) this.runner.messageDelivery([input.messageId], input.state === "accepted" ? "delivered"
        : input.state === "dispatched" ? "sending" : input.state, input.error, input.receipt);
    })();
  }

  createDeployIntent(t: { target_sha: string; triggered_by: string; trigger_source?: string; release_manifest_sha256?: string }): DeployIntentRow {
    return this.db.transaction(() => {
      if (this.getActiveDeployIntent()) throw new Error("已有部署在进行中,等它落定再触发");
      const now = new Date().toISOString();
      const res = this.db
        .prepare("INSERT INTO deploy_intents (target_sha, triggered_by, trigger_source, release_manifest_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(t.target_sha, t.triggered_by, t.trigger_source ?? null, t.release_manifest_sha256 ?? null, now, now);
      return this.getDeployIntent(Number(res.lastInsertRowid))!;
    })();
  }

  getDeployIntent(id: number): DeployIntentRow | undefined {
    return this.db.prepare("SELECT * FROM deploy_intents WHERE id = ?").get(id) as DeployIntentRow | undefined;
  }

  getActiveDeployIntent(): DeployIntentRow | undefined {
    return this.db
      .prepare(`SELECT * FROM deploy_intents WHERE status IN (${DEPLOY_ACTIVE_PLACEHOLDERS}) LIMIT 1`)
      .get(...DEPLOY_ACTIVE_STATUSES) as DeployIntentRow | undefined;
  }

  listDeployIntents(limit = 20): DeployIntentRow[] {
    return this.db.prepare("SELECT * FROM deploy_intents ORDER BY id DESC LIMIT ?").all(limit) as DeployIntentRow[];
  }

  updateDeployIntent(id: number, patch: Partial<DeployIntentPatch>): void {
    const keys = Object.keys(patch) as Array<keyof DeployIntentPatch>;
    if (keys.length === 0) return;
    for (const key of keys) {
      if (!DEPLOY_INTENT_PATCHABLE.has(key)) throw new Error(`unpatchable deploy_intent column: ${String(key)}`);
    }
    const sets = keys.map((key) => `${String(key)} = ?`).join(", ");
    this.db
      .prepare(`UPDATE deploy_intents SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((key) => patch[key] ?? null), new Date().toISOString(), id);
  }

  recordDeployDecision(id: number, decision: "alive" | "rollback", by: string): boolean {
    return this.db.transaction(() => {
      const row = this.getDeployIntent(id);
      if (!row || row.status !== "confirm_wait" || row.confirm_decision) return false;
      this.db
        .prepare(
          "UPDATE deploy_intents SET confirm_decision = ?, confirm_by = ?, confirm_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(decision, by, new Date().toISOString(), new Date().toISOString(), id);
      return true;
    })();
  }

  listUnnotifiedDeployIntents(): DeployIntentRow[] {
    return this.db
      .prepare(
        "SELECT * FROM deploy_intents WHERE notified = 0 AND status IN ('succeeded','rolled_back','failed') ORDER BY id",
      )
      .all() as DeployIntentRow[];
  }

  // ── Verify tickets ──

  createVerifyTicket(v: {
    intent_id: number;
    target_sha: string;
    ticket_ids: number[];
    modules_touched: string[];
    checklist: Array<{ ticket_id: number; title: string; criteria: string }>;
    assignees: string[];
  }): VerifyTicketRow {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO verify_tickets (intent_id, target_sha, ticket_ids, modules_touched, checklist, assignees, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.intent_id,
        v.target_sha,
        JSON.stringify(v.ticket_ids),
        JSON.stringify(v.modules_touched),
        JSON.stringify(v.checklist),
        JSON.stringify(v.assignees),
        now,
        now,
      );
    return this.getVerifyTicket(Number(res.lastInsertRowid))!;
  }

  getVerifyTicket(id: number): VerifyTicketRow | undefined {
    return this.db.prepare("SELECT * FROM verify_tickets WHERE id = ?").get(id) as VerifyTicketRow | undefined;
  }

  getOpenVerifyTicket(): VerifyTicketRow | undefined {
    return this.db.prepare("SELECT * FROM verify_tickets WHERE status = 'open' ORDER BY id DESC LIMIT 1").get() as
      | VerifyTicketRow
      | undefined;
  }

  getOpenVerifyBlock(throughId = Number.MAX_SAFE_INTEGER): VerifyTicketBlock | undefined {
    const rows = this.db
      .prepare("SELECT * FROM verify_tickets WHERE status = 'open' AND id <= ? ORDER BY id")
      .all(throughId) as VerifyTicketRow[];
    return aggregateVerifyTickets(rows);
  }

  listVerifyTickets(limit = 20): VerifyTicketRow[] {
    return this.db.prepare("SELECT * FROM verify_tickets ORDER BY id DESC LIMIT ?").all(limit) as VerifyTicketRow[];
  }

  resolveVerifyTicket(id: number, status: "passed" | "failed", by: string, notes?: string): boolean {
    return this.db.transaction(() => {
      const row = this.getVerifyTicket(id);
      if (!row || row.status !== "open") return false;
      this.db
        .prepare("UPDATE verify_tickets SET status = ?, resolved_by = ?, notes = ?, updated_at = ? WHERE id = ?")
        .run(status, by, notes ?? null, new Date().toISOString(), id);
      return true;
    })();
  }

  resolveOpenVerifyBlock(
    throughId: number,
    status: "passed" | "failed",
    by: string,
    notes?: string,
  ): VerifyTicketBlock | undefined {
    return this.db.transaction(() => {
      const anchor = this.getVerifyTicket(throughId);
      if (!anchor || anchor.status !== "open") return undefined;
      const block = this.getOpenVerifyBlock(throughId);
      if (!block || block.id !== throughId) return undefined;
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE verify_tickets SET status = ?, resolved_by = ?, notes = ?, updated_at = ? WHERE status = 'open' AND id <= ?",
        )
        .run(status, by, notes ?? null, now, throughId);
      return { ...block, status, resolved_by: by, notes: notes ?? null, updated_at: now };
    })();
  }
}
