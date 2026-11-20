import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { explicitQueryPaths, uncoveredCodePaths } from "../../knowledge/retrieval-coverage.js";
import {
  RETRIEVAL_CANONICAL_DELIVERY_EVENT_KEYS,
  traceEvent,
  validateRetrievalPlan,
  validateRetrievalTraceEnvelope,
  validateRetrievalTraceEvent,
  validateRetrievalTraceReceipt,
  type RetrievalErrorCode,
  type RetrievalErrorStage,
  type RetrievalFeedbackCode,
  type RetrievalPlanAudit,
  type RetrievalSlot,
  type RetrievalTraceEnvelopeV1,
  type RetrievalTraceEventInput,
  type RetrievalTraceEventName,
  type RetrievalTraceId,
  type RetrievalTraceReceiptV1,
} from "../../knowledge/retrieval-trace.js";

const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const COMPACT_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const TRACE_CAP = 10_000;
const REVIEW_LIMIT = 50;
const DETAIL_EVENTS_LIMIT = 25;
const CURSOR_TEXT_LIMIT = 256;
const TRACE_ID = /^kr_[0-9a-f]{32}$/u;
const OPAQUE_CURSOR = /^[A-Za-z0-9_-]+$/u;

interface RetrievalTraceDbRow {
  trace_id: string;
  schema_version: number;
  lane: "ticket" | "cli";
  purpose: "startup" | "path_refinement" | "submit_check";
  subject_ref: string;
  turn: number | null;
  parent_trace_id: string | null;
  journey_step_id: string | null;
  query_hash: string;
  query_chars: number;
  repo_sha: string;
  worktree_input_fingerprint: string | null;
  graph_input_fingerprint: string;
  code_index_sha: string | null;
  vector_index_sha: string | null;
  started_at: string;
  expires_at: string;
}

interface RetrievalEventDbRow {
  id: number;
  trace_id: string;
  event: RetrievalTraceEventName;
  event_key: string;
  payload_json: string;
  created_at: string;
}

export interface KnowledgeRetrievalReviewFilter {
  ticket_id?: number;
  outcome?: "miss" | "error" | "feedback" | "all";
  lane?: "ticket" | "cli";
  before?: string;
  limit?: number;
}

export interface KnowledgeTicketRetrievalRow {
  ticket_id: number;
  title: string;
  dev_status: string;
  startup: number;
  path_queries: number;
  delivered_queries: number;
  submit_checks: number;
  cited_records: number;
  feedback: number;
  last_query_at: string | null;
}

export interface KnowledgeTicketRetrievalPage {
  items: KnowledgeTicketRetrievalRow[];
  limit: number;
  has_more: boolean;
  next_before?: number;
}

export interface KnowledgeRetrievalReviewPage {
  items: KnowledgeRetrievalReviewRow[];
  limit: number;
  has_more: boolean;
  next_before?: string;
}

export interface KnowledgeRetrievalReviewRow {
  trace_id: RetrievalTraceId;
  lane: "ticket" | "cli";
  purpose: "startup" | "path_refinement" | "submit_check";
  subject_ref: string;
  turn?: number;
  parent_trace_id?: RetrievalTraceId;
  repo_sha: string;
  code_index_sha?: string;
  vector_index_sha?: string;
  started_at: string;
  expires_at: string;
  outcome: "assembled" | "miss" | "error" | "abandoned" | "unknown";
  unknown_codes: string[];
  feedback_codes: string[];
}

export interface KnowledgeRetrievalTraceEventFilter {
  before?: string;
  limit?: number;
}

export interface KnowledgeRetrievalTraceDetail extends KnowledgeRetrievalReviewRow {
  graph_input_fingerprint: string;
  worktree_input_fingerprint?: string;
  events: Array<{
    event: RetrievalTraceEventName;
    event_key: string;
    payload: unknown;
    created_at: string;
  }>;
  events_total: number;
  events_has_more: boolean;
  events_next_before?: string;
}

export interface RetrievalReceiptImportResult {
  state: "imported" | "already_imported";
  trace_id: RetrievalTraceId;
}
export interface CliRetrievalReceiptImport {
  receipt: RetrievalTraceReceiptV1;
  receipt_sha256: string;
}

export interface CliRetrievalLandingBinding {
  landing_ref: string;
  repo_sha: string;
  context_keys: readonly string[];
}


function addDays(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function parsePayload(row: RetrievalEventDbRow): RetrievalTraceEventInput["payload"] {
  const payload = JSON.parse(row.payload_json) as RetrievalTraceEventInput["payload"];
  return validateRetrievalTraceEvent({
    trace_id: row.trace_id as RetrievalTraceId,
    event: row.event,
    event_key: row.event_key,
    created_at: row.created_at,
    payload,
  }).payload;
}

function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(parts.join("\0"), "utf8").toString("base64url");
}

function decodeCursor(value: string, parts: number, label: string): string[] {
  if (!value || value.length > CURSOR_TEXT_LIMIT || !OPAQUE_CURSOR.test(value)) throw new Error(`invalid ${label}`);
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  if (encodeCursor(decoded.split("\0")) !== value) throw new Error(`invalid ${label}`);
  const decodedParts = decoded.split("\0");
  if (decodedParts.length !== parts) throw new Error(`invalid ${label}`);
  return decodedParts;
}

function decodeReviewCursor(value: string): { startedAt: string; traceId: string } {
  const [startedAt = "", traceId = ""] = decodeCursor(value, 2, "retrieval review cursor");
  const parsedStartedAt = Date.parse(startedAt);
  if (!Number.isFinite(parsedStartedAt) || new Date(parsedStartedAt).toISOString() !== startedAt || !TRACE_ID.test(traceId)) {
    throw new Error("invalid retrieval review cursor");
  }
  return { startedAt, traceId };
}

function encodeReviewCursor(row: Pick<RetrievalTraceDbRow, "started_at" | "trace_id">): string {
  return encodeCursor([row.started_at, row.trace_id]);
}

function decodeEventsCursor(value: string, traceId: string): number {
  const [cursorTraceId = "", rawId = ""] = decodeCursor(value, 2, "retrieval events cursor");
  const id = Number(rawId);
  if (cursorTraceId !== traceId || !Number.isSafeInteger(id) || id < 1 || String(id) !== rawId) throw new Error("invalid retrieval events cursor");
  return id;
}

function encodeEventsCursor(traceId: string, id: number): string {
  return encodeCursor([traceId, String(id)]);
}

export function isKnowledgeRetrievalReviewCursor(value: string): boolean {
  try {
    decodeReviewCursor(value);
    return true;
  } catch {
    return false;
  }
}

export function isKnowledgeRetrievalEventsCursor(value: string, traceId: string): boolean {
  try {
    decodeEventsCursor(value, traceId);
    return true;
  } catch {
    return false;
  }
}

function envelopeFromRow(row: RetrievalTraceDbRow): RetrievalTraceEnvelopeV1 {
  return validateRetrievalTraceEnvelope({
    schema_version: 1,
    trace_id: row.trace_id as RetrievalTraceId,
    lane: row.lane,
    purpose: row.purpose,
    subject_ref: row.subject_ref as RetrievalTraceEnvelopeV1["subject_ref"],
    ...(row.turn === null ? {} : { turn: row.turn }),
    ...(row.parent_trace_id === null ? {} : { parent_trace_id: row.parent_trace_id as RetrievalTraceId }),
    ...(row.journey_step_id === null ? {} : { journey_step_id: row.journey_step_id }),
    query_hash: row.query_hash,
    query_chars: row.query_chars,
    repo_sha: row.repo_sha,
    ...(row.worktree_input_fingerprint === null ? {} : { worktree_input_fingerprint: row.worktree_input_fingerprint }),
    graph_input_fingerprint: row.graph_input_fingerprint,
    ...(row.code_index_sha === null ? {} : { code_index_sha: row.code_index_sha }),
    ...(row.vector_index_sha === null ? {} : { vector_index_sha: row.vector_index_sha }),
    started_at: row.started_at,
  });
}

function resultEvent(events: readonly RetrievalEventDbRow[]): RetrievalEventDbRow | undefined {
  return events.find((event) => event.event === "assembled" || event.event === "miss" || event.event === "error");
}

function lifecycleState(events: readonly RetrievalEventDbRow[]): RetrievalTraceEventName | "none" {
  if (!events.length) return "none";
  const terminal = [...events].reverse().find((event) => event.event !== "feedback" && event.event !== "reported_use");
  return terminal?.event ?? events.at(-1)?.event ?? "none";
}

function reviewRow(row: RetrievalTraceDbRow, events: readonly RetrievalEventDbRow[]): KnowledgeRetrievalReviewRow {
  const result = resultEvent(events);
  let outcome: KnowledgeRetrievalReviewRow["outcome"] = "unknown";
  if (result?.event === "assembled" || result?.event === "miss" || result?.event === "error") outcome = result.event;
  if (events.some((event) => event.event === "abandoned")) outcome = "abandoned";
  const unknownCodes: string[] = [];
  if (result && (result.event === "assembled" || result.event === "miss")) {
    const payload = parsePayload(result);
    if (payload && typeof payload === "object" && "unknown" in payload && Array.isArray(payload.unknown)) {
      for (const item of payload.unknown) {
        if (item && typeof item === "object" && "code" in item && typeof item.code === "string") unknownCodes.push(item.code);
      }
    }
  }
  const feedbackCodes: string[] = [];
  for (const event of events) {
    if (event.event !== "feedback") continue;
    const payload = parsePayload(event);
    if (payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string") feedbackCodes.push(payload.code);
  }
  return {
    trace_id: row.trace_id as RetrievalTraceId,
    lane: row.lane,
    purpose: row.purpose,
    subject_ref: row.subject_ref,
    ...(row.turn === null ? {} : { turn: row.turn }),
    ...(row.parent_trace_id === null ? {} : { parent_trace_id: row.parent_trace_id as RetrievalTraceId }),
    repo_sha: row.repo_sha,
    ...(row.code_index_sha === null ? {} : { code_index_sha: row.code_index_sha }),
    ...(row.vector_index_sha === null ? {} : { vector_index_sha: row.vector_index_sha }),
    started_at: row.started_at,
    expires_at: row.expires_at,
    outcome,
    unknown_codes: [...new Set(unknownCodes)],
    feedback_codes: [...new Set(feedbackCodes)],
  };
}

export class KnowledgeRetrievalRepository {
  private lastPruneAt = 0;
  constructor(private readonly db: Database.Database) {}

  beginTrace(envelopeInput: RetrievalTraceEnvelopeV1): void {
    const envelope = validateRetrievalTraceEnvelope(envelopeInput);
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM knowledge_retrieval_traces WHERE trace_id = ?").get(envelope.trace_id) as RetrievalTraceDbRow | undefined;
      if (existing) {
        const stored = envelopeFromRow(existing);
        if (JSON.stringify(stored) !== JSON.stringify(envelope)) throw new Error(`retrieval trace ${envelope.trace_id} conflicts with its stored envelope`);
        return;
      }
      this.db.prepare(`
        INSERT INTO knowledge_retrieval_traces (
          trace_id, schema_version, lane, purpose, subject_ref, turn,
          parent_trace_id, journey_step_id, query_hash, query_chars, repo_sha,
          worktree_input_fingerprint, graph_input_fingerprint, code_index_sha,
          vector_index_sha, started_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        envelope.trace_id,
        envelope.schema_version,
        envelope.lane,
        envelope.purpose,
        envelope.subject_ref,
        envelope.turn ?? null,
        envelope.parent_trace_id ?? null,
        envelope.journey_step_id ?? null,
        envelope.query_hash,
        envelope.query_chars,
        envelope.repo_sha,
        envelope.worktree_input_fingerprint ?? null,
        envelope.graph_input_fingerprint,
        envelope.code_index_sha ?? null,
        envelope.vector_index_sha ?? null,
        envelope.started_at,
        addDays(envelope.started_at, SUCCESS_TTL_MS),
      );
      this.insertEvent(traceEvent(envelope.trace_id, "started", { event: "started", payload: {} }, envelope.started_at));
    })();
    this.maybePrune();
  }

  appendAssembled(traceId: RetrievalTraceId, plan: RetrievalPlanAudit): void {
    validateRetrievalPlan(plan);
    this.appendEvent(traceEvent(traceId, "result", { event: "assembled", payload: plan }));
  }

  appendMiss(traceId: RetrievalTraceId, plan: RetrievalPlanAudit): void {
    validateRetrievalPlan(plan);
    if (!plan.unknown.length) throw new Error("retrieval miss requires an unknown reason");
    this.appendEvent(traceEvent(traceId, "result", { event: "miss", payload: plan }));
  }

  appendError(traceId: RetrievalTraceId, stage: RetrievalErrorStage, code: RetrievalErrorCode): void {
    this.appendEvent(traceEvent(traceId, "result", { event: "error", payload: { stage, code } }));
  }

  markDelivered(traceId: RetrievalTraceId, channel: "ticket_prompt" | "mcp_response" | "cli_stdout" | "land_import"): void {
    this.appendEvent(traceEvent(traceId, `delivery:${channel}`, { event: "delivered", payload: { channel } }));
  }

  markDeliveredError(traceId: RetrievalTraceId, channel: "ticket_prompt" | "mcp_response" | "cli_stdout", code: "graph_unavailable" | "index_failed" | "pack_failed"): void {
    this.appendEvent(traceEvent(traceId, `delivery:${channel}`, { event: "delivered_error", payload: { stage: "delivery", code } }));
  }

  markAbandoned(traceId: RetrievalTraceId, code: "graph_unavailable" | "index_failed" | "pack_failed"): void {
    this.appendEvent(traceEvent(traceId, "abandoned", { event: "abandoned", payload: { stage: "delivery", code } }));
  }

  recordFeedback(traceId: RetrievalTraceId, code: RetrievalFeedbackCode, slot?: RetrievalSlot, expectedRecordId?: string): void {
    const key = `feedback:${code}:${slot ?? "none"}:${expectedRecordId ?? "none"}`;
    this.appendEvent(traceEvent(traceId, key, {
      event: "feedback",
      payload: {
        code,
        ...(slot ? { slot } : {}),
        ...(expectedRecordId ? { expected_record_id: expectedRecordId } : {}),
      },
    }));
  }

  recordReportedUse(
    traceId: RetrievalTraceId,
    landingRef: string,
    contextKeys: readonly string[],
    offeredTraceIds?: readonly RetrievalTraceId[],
  ): void {
    this.assertReportedUseInput(contextKeys, offeredTraceIds);
    this.db.transaction(() => {
      this.recordReportedUseInTransaction(traceId, landingRef, contextKeys, offeredTraceIds);
    })();
  }

  appendEvent(input: RetrievalTraceEventInput): void {
    const event = validateRetrievalTraceEvent(input);
    this.db.transaction(() => this.appendEventInTransaction(event))();
  }

  importCliReceiptsForLanding(
    inputs: readonly CliRetrievalReceiptImport[],
    binding: CliRetrievalLandingBinding,
  ): RetrievalReceiptImportResult[] {
    if (inputs.length === 0 || inputs.length > 8) throw new Error("CLI retrieval receipt batch must contain one to eight receipts");
    if (!/^[0-9a-f]{40}$/u.test(binding.repo_sha)) throw new Error("landing input sha must be a full lowercase commit sha");
    if (!binding.landing_ref || binding.landing_ref.length > 256) throw new Error("landing ref must be non-empty and bounded");
    this.assertReportedUseInput(binding.context_keys);

    const now = Date.now();
    const traceIds = new Set<RetrievalTraceId>();
    const subjects = new Set<string>();
    const receipts = inputs.map((input) => {
      const receipt = validateRetrievalTraceReceipt(input.receipt);
      if (receipt.events.length !== 3
        || receipt.events[0]?.event_key !== "started"
        || receipt.events[1]?.event_key !== "result"
        || receipt.events[2]?.event_key !== "delivery:cli_stdout"
        || !["delivered", "delivered_error"].includes(receipt.events[2]?.event ?? "")) {
        throw new Error("CLI retrieval receipt must contain only its canonical start, result, and stdout delivery");
      }
      if (!/^[0-9a-f]{64}$/u.test(input.receipt_sha256)) throw new Error("receipt digest must be lowercase sha256");
      const startedAt = Date.parse(receipt.envelope.started_at);
      if (startedAt > now + 5 * 60 * 1_000 || startedAt < now - 7 * 24 * 60 * 60 * 1_000) {
        throw new Error("retrieval receipt is outside the seven-day import window");
      }
      const digest = createHash("sha256").update(`${JSON.stringify(receipt)}\n`, "utf8").digest("hex");
      if (digest !== input.receipt_sha256) throw new Error("retrieval receipt digest mismatch");
      if (receipt.envelope.lane !== "cli") throw new Error("retrieval receipt must belong to the CLI lane");
      if (receipt.envelope.repo_sha !== binding.repo_sha) throw new Error("retrieval receipt repo sha does not match the landing input");
      if (traceIds.has(receipt.envelope.trace_id)) throw new Error("CLI retrieval receipt batch contains duplicate traces");
      traceIds.add(receipt.envelope.trace_id);
      subjects.add(receipt.envelope.subject_ref);
      return { receipt, receipt_sha256: input.receipt_sha256 };
    });
    if (subjects.size !== 1) throw new Error("CLI retrieval receipts must share one subject");

    const receiptBindings = receipts.map(({ receipt, receipt_sha256 }) => ({
      trace_id: receipt.envelope.trace_id,
      receipt_sha256,
    }));
    const host = receipts.at(-1)!;
    const results = this.db.transaction(() => {
      const existingRows = receipts.map(({ receipt }) => (
        this.db.prepare("SELECT * FROM knowledge_retrieval_traces WHERE trace_id = ?").get(receipt.envelope.trace_id) as RetrievalTraceDbRow | undefined
      ));
      if (existingRows.some(Boolean)) {
        if (existingRows.some((row) => !row)) throw new Error("CLI retrieval receipt batch was only partially imported");
        for (const [index, row] of existingRows.entries()) {
          const existing = row!;
          const expected = receipts[index]!.receipt;
          if (JSON.stringify(envelopeFromRow(existing)) !== JSON.stringify(expected.envelope)) {
            throw new Error(`retrieval trace ${expected.envelope.trace_id} conflicts with its stored envelope`);
          }
          const events = this.events(expected.envelope.trace_id);
          if (!events.some((event) => event.event === "delivered" && event.event_key === "delivery:land_import")) {
            throw new Error(`retrieval receipt ${expected.envelope.trace_id} was not imported by a landing`);
          }
          for (const event of expected.events) {
            const stored = events.find((candidate) => candidate.event_key === event.event_key);
            if (!stored || stored.event !== event.event || stored.payload_json !== JSON.stringify(event.payload)) {
              throw new Error(`retrieval receipt ${expected.envelope.trace_id} conflicts with stored evidence`);
            }
          }
          const uses = events.filter((event) => event.event === "reported_use");
          const isHost = expected.envelope.trace_id === host.receipt.envelope.trace_id;
          if (uses.length !== (isHost ? 1 : 0)) throw new Error(`retrieval receipt ${expected.envelope.trace_id} was already consumed`);
          if (isHost && !this.reportedUseMatchesBinding(uses[0]!, binding, receiptBindings)) {
            throw new Error(`retrieval receipt ${expected.envelope.trace_id} was consumed by another landing`);
          }
        }
        return receipts.map(({ receipt }) => ({
          state: "already_imported" as const,
          trace_id: receipt.envelope.trace_id,
        }));
      }

      for (const { receipt } of receipts) {
        this.beginTrace(receipt.envelope);
        for (const event of receipt.events) this.appendEventInTransaction(event);
        this.appendEventInTransaction(traceEvent(
          receipt.envelope.trace_id,
          "delivery:land_import",
          { event: "delivered", payload: { channel: "land_import" } },
        ));
      }
      this.recordReportedUseInTransaction(
        host.receipt.envelope.trace_id,
        binding.landing_ref,
        binding.context_keys,
        [...traceIds],
        {
          receipt_bindings: receiptBindings,
          repo_sha: binding.repo_sha,
        },
      );
      return receipts.map(({ receipt }) => ({
        state: "imported" as const,
        trace_id: receipt.envelope.trace_id,
      }));
    })();
    this.maybePrune();
    return results;
  }

  listForReview(filter: KnowledgeRetrievalReviewFilter = {}): KnowledgeRetrievalReviewPage {
    const requestedLimit = filter.limit ?? REVIEW_LIMIT;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), REVIEW_LIMIT)
      : REVIEW_LIMIT;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.ticket_id !== undefined) {
      clauses.push("t.lane = 'ticket' AND t.subject_ref = ?");
      params.push(`ticket:${filter.ticket_id}`);
    }
    if (filter.lane) {
      clauses.push("t.lane = ?");
      params.push(filter.lane);
    }
    if (filter.before) {
      const cursor = decodeReviewCursor(filter.before);
      clauses.push("(t.started_at < ? OR (t.started_at = ? AND t.trace_id < ?))");
      params.push(cursor.startedAt, cursor.startedAt, cursor.traceId);
    }
    if (filter.outcome && filter.outcome !== "all") {
      if (filter.outcome === "feedback") clauses.push("EXISTS (SELECT 1 FROM knowledge_retrieval_events f WHERE f.trace_id = t.trace_id AND f.event = 'feedback')");
      else clauses.push("EXISTS (SELECT 1 FROM knowledge_retrieval_events r WHERE r.trace_id = t.trace_id AND r.event = ?)");
      if (filter.outcome !== "feedback") params.push(filter.outcome);
    } else if (!filter.outcome) {
      clauses.push("EXISTS (SELECT 1 FROM knowledge_retrieval_events r WHERE r.trace_id = t.trace_id AND r.event IN ('miss', 'error', 'feedback'))");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT t.* FROM knowledge_retrieval_traces t ${where} ORDER BY t.started_at DESC, t.trace_id DESC LIMIT ?`)
      .all(...params, limit + 1) as RetrievalTraceDbRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const lastPageRow = pageRows.at(-1);
    const nextBefore = hasMore && lastPageRow ? encodeReviewCursor(lastPageRow) : undefined;
    return {
      items: pageRows.map((row) => reviewRow(row, this.reviewSummaryEvents(row.trace_id))),
      limit,
      has_more: hasMore,
      ...(nextBefore ? { next_before: nextBefore } : {}),
    };
  }

  /** Retained ticket-lane evidence only. Start from tickets so zero-trace tickets remain visible. */
  listTickets(filter: { before?: number; limit?: number } = {}): KnowledgeTicketRetrievalPage {
    const requested = filter.limit ?? REVIEW_LIMIT;
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), REVIEW_LIMIT) : REVIEW_LIMIT;
    const rows = this.db.prepare(`
      WITH page AS (
        SELECT id, title, dev_status FROM dev_tickets
        WHERE kind <> 'cli' AND (? IS NULL OR id < ?)
        ORDER BY id DESC LIMIT ?
      )
      SELECT p.id AS ticket_id, p.title, p.dev_status,
        COALESCE(SUM(t.purpose = 'startup'), 0) AS startup,
        COALESCE(SUM(t.purpose = 'path_refinement'), 0) AS path_queries,
        COALESCE(SUM(t.purpose = 'path_refinement'
          AND EXISTS (SELECT 1 FROM knowledge_retrieval_events e WHERE e.trace_id = t.trace_id AND e.event = 'assembled')
          AND EXISTS (SELECT 1 FROM knowledge_retrieval_events e WHERE e.trace_id = t.trace_id AND e.event = 'delivered')), 0) AS delivered_queries,
        COALESCE(SUM(t.purpose = 'submit_check'), 0) AS submit_checks,
        (SELECT COUNT(DISTINCT json_extract(c.value, '$.record_id'))
          FROM knowledge_retrieval_traces ct
          JOIN knowledge_retrieval_events e ON e.trace_id = ct.trace_id AND e.event = 'reported_use'
          JOIN json_each(e.payload_json, '$.context_keys') c
          WHERE ct.lane = 'ticket' AND ct.subject_ref = 'ticket:' || p.id) AS cited_records,
        COALESCE(SUM((SELECT COUNT(*) FROM knowledge_retrieval_events e WHERE e.trace_id = t.trace_id AND e.event = 'feedback')), 0) AS feedback,
        MAX(CASE WHEN t.purpose = 'path_refinement' THEN t.started_at END) AS last_query_at
      FROM page p LEFT JOIN knowledge_retrieval_traces t ON t.lane = 'ticket' AND t.subject_ref = 'ticket:' || p.id
      GROUP BY p.id ORDER BY p.id DESC
    `).all(filter.before ?? null, filter.before ?? null, limit + 1) as KnowledgeTicketRetrievalRow[];
    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return { items, limit, has_more: hasMore, ...(hasMore ? { next_before: items.at(-1)!.ticket_id } : {}) };
  }

  getTrace(traceId: string, filter: KnowledgeRetrievalTraceEventFilter = {}): KnowledgeRetrievalTraceDetail | null {
    if (!TRACE_ID.test(traceId)) return null;
    const row = this.db.prepare("SELECT * FROM knowledge_retrieval_traces WHERE trace_id = ?").get(traceId) as RetrievalTraceDbRow | undefined;
    if (!row) return null;
    const requestedLimit = filter.limit ?? DETAIL_EVENTS_LIMIT;
    const eventsLimit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), DETAIL_EVENTS_LIMIT)
      : DETAIL_EVENTS_LIMIT;
    const beforeId = filter.before ? decodeEventsCursor(filter.before, traceId) : null;
    const lifecycle = this.canonicalLifecycleEvents(traceId);
    const reviewRows = this.db.prepare(`
      SELECT *
        FROM knowledge_retrieval_events
       WHERE trace_id = ?
         AND event IN ('feedback', 'reported_use')
         ${beforeId === null ? "" : "AND id < ?"}
       ORDER BY id DESC
       LIMIT ?
    `).all(...(beforeId === null ? [traceId, eventsLimit + 1] : [traceId, beforeId, eventsLimit + 1])) as RetrievalEventDbRow[];
    const hasMore = reviewRows.length > eventsLimit;
    const pageRowsDescending = reviewRows.slice(0, eventsLimit);
    const pageRows = [...pageRowsDescending].reverse();
    const lastPageEvent = pageRowsDescending.at(-1);
    const nextEventsBefore = hasMore && lastPageEvent ? encodeEventsCursor(traceId, lastPageEvent.id) : undefined;
    const reviewCountRow = this.db.prepare(`
      SELECT COUNT(*) AS count
        FROM knowledge_retrieval_events
       WHERE trace_id = ? AND event IN ('feedback', 'reported_use')
    `).get(traceId) as { count: number };
    const reviewCount = reviewCountRow.count;
    const events = [...lifecycle, ...pageRows];
    return {
      ...reviewRow(row, this.reviewSummaryEvents(traceId, lifecycle)),
      graph_input_fingerprint: row.graph_input_fingerprint,
      ...(row.worktree_input_fingerprint === null ? {} : { worktree_input_fingerprint: row.worktree_input_fingerprint }),
      events: events.map((event) => ({
        event: event.event,
        event_key: event.event_key,
        payload: parsePayload(event),
        created_at: event.created_at,
      })),
      events_total: lifecycle.length + reviewCount,
      events_has_more: hasMore,
      ...(nextEventsBefore ? { events_next_before: nextEventsBefore } : {}),
    };
  }

  latestDeliveredTrace(subjectRef: string): RetrievalTraceId | null {
    const row = this.db.prepare(`
      SELECT t.trace_id
        FROM knowledge_retrieval_traces t
       WHERE t.subject_ref = ?
         AND EXISTS (
           SELECT 1 FROM knowledge_retrieval_events e
            WHERE e.trace_id = t.trace_id AND e.event = 'delivered'
         )
       ORDER BY t.started_at DESC, t.trace_id DESC
       LIMIT 1
    `).get(subjectRef) as { trace_id: RetrievalTraceId } | undefined;
    return row?.trace_id ?? null;
  }

  hasDeliveredPathContext(subjectRef: string, turn: number, changed: readonly string[] = [], startedAt?: string | null): boolean {
    const rows = this.db.prepare(`
      SELECT result.payload_json FROM knowledge_retrieval_traces t
      JOIN knowledge_retrieval_events result ON result.trace_id = t.trace_id AND result.event = 'assembled'
      WHERE t.subject_ref = ? AND t.turn = ? AND t.purpose = 'path_refinement'
        AND (? IS NULL OR t.started_at >= ?)
        AND EXISTS (SELECT 1 FROM knowledge_retrieval_events e
          WHERE e.trace_id = t.trace_id AND e.event = 'delivered')
    `).all(subjectRef, turn, startedAt ?? null, startedAt ?? null) as Array<{ payload_json: string }>;
    const queried = rows.flatMap((row) => explicitQueryPaths(validateRetrievalPlan(JSON.parse(row.payload_json) as RetrievalPlanAudit)));
    return queried.length > 0 && uncoveredCodePaths(changed, queried).length === 0;
  }

  prune(now = new Date().toISOString()): { traces: number; details: number; capped: number } {
    if (!Number.isFinite(Date.parse(now))) throw new Error("invalid retrieval prune time");
    return this.db.transaction(() => {
      const detailBefore = new Date(Date.parse(now) - DETAIL_TTL_MS).toISOString();
      const detailRows = this.db.prepare(`
        SELECT evidence.*
          FROM knowledge_retrieval_events evidence
         WHERE evidence.event IN ('assembled', 'miss')
           AND evidence.created_at < ?
           AND (
             evidence.event = 'miss'
             OR EXISTS (
               SELECT 1 FROM knowledge_retrieval_events keep
                WHERE keep.trace_id = evidence.trace_id AND keep.event = 'feedback'
             )
           )
      `).all(detailBefore) as RetrievalEventDbRow[];
      const compactPlan = this.db.prepare("UPDATE knowledge_retrieval_events SET payload_json = ? WHERE id = ?");
      let details = 0;
      for (const row of detailRows) {
        const plan = validateRetrievalPlan(parsePayload(row) as RetrievalPlanAudit);
        const payloadJson = JSON.stringify({
          classifications: [],
          indexes: [],
          candidates: [],
          slots: [],
          context_keys: [],
          unknown: plan.unknown,
          budget: plan.budget,
          performance: plan.performance,
        } satisfies RetrievalPlanAudit);
        if (payloadJson === row.payload_json) continue;
        details += compactPlan.run(payloadJson, row.id).changes;
      }
      const traces = this.db.prepare("DELETE FROM knowledge_retrieval_traces WHERE expires_at <= ?").run(now).changes;
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_retrieval_traces").get() as { count: number }).count;
      let capped = 0;
      if (count > TRACE_CAP) {
        const overflow = count - TRACE_CAP;
        capped += this.db.prepare(`
          DELETE FROM knowledge_retrieval_traces
           WHERE trace_id IN (
             SELECT t.trace_id
               FROM knowledge_retrieval_traces t
              WHERE NOT EXISTS (
                SELECT 1 FROM knowledge_retrieval_events e
                 WHERE e.trace_id = t.trace_id AND e.event IN ('miss', 'error', 'feedback')
              )
              ORDER BY t.started_at ASC, t.trace_id ASC
              LIMIT ?
           )
        `).run(overflow).changes;
      }
      const remaining = (this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_retrieval_traces").get() as { count: number }).count;
      if (remaining > TRACE_CAP) {
        capped += this.db.prepare(`
          DELETE FROM knowledge_retrieval_traces
           WHERE trace_id IN (
             SELECT trace_id FROM knowledge_retrieval_traces
              ORDER BY started_at ASC, trace_id ASC
              LIMIT ?
           )
        `).run(remaining - TRACE_CAP).changes;
      }
      return { traces, details, capped };
    })();
  }

  private assertReportedUseInput(
    contextKeys: readonly string[],
    offeredTraceIds?: readonly RetrievalTraceId[],
  ): void {
    if (contextKeys.length > 50 || new Set(contextKeys).size !== contextKeys.length) {
      throw new Error("reported context keys must be unique and bounded");
    }
    if (offeredTraceIds && (offeredTraceIds.length > 8 || new Set(offeredTraceIds).size !== offeredTraceIds.length)) {
      throw new Error("offered trace ids must be unique and bounded");
    }
  }

  private recordReportedUseInTransaction(
    traceId: RetrievalTraceId,
    landingRef: string,
    contextKeys: readonly string[],
    offeredTraceIds?: readonly RetrievalTraceId[],
    receiptBinding?: {
      receipt_bindings: Array<{ trace_id: RetrievalTraceId; receipt_sha256: string }>;
      repo_sha: string;
    },
  ): void {
    const host = this.requireTrace(traceId);
    const related = this.db.prepare("SELECT * FROM knowledge_retrieval_traces WHERE subject_ref = ? ORDER BY started_at DESC")
      .all(host.subject_ref) as RetrievalTraceDbRow[];
    const offeredIds = offeredTraceIds ? new Set(offeredTraceIds) : null;
    const offered = new Map<string, { trace: RetrievalTraceId; slot: RetrievalSlot }>();
    for (const trace of related) {
      if (offeredIds && !offeredIds.has(trace.trace_id as RetrievalTraceId)) continue;
      const events = this.events(trace.trace_id);
      if (!events.some((event) => event.event === "delivered")) continue;
      const result = resultEvent(events);
      if (!result || (result.event !== "assembled" && result.event !== "miss")) continue;
      const payload = validateRetrievalPlan(parsePayload(result) as RetrievalPlanAudit);
      for (const slot of payload.slots) {
        if (!offered.has(slot.record_id)) offered.set(slot.record_id, { trace: trace.trace_id as RetrievalTraceId, slot: slot.slot });
      }
    }
    const cited = contextKeys.map((recordId) => {
      const source = offered.get(recordId);
      return source
        ? { record_id: recordId, origin: "offered" as const, offered_by_trace: source.trace, slot: source.slot }
        : { record_id: recordId, origin: "manual" as const };
    });
    this.appendEventInTransaction(traceEvent(traceId, `use:${landingRef}`, {
      event: "reported_use",
      payload: {
        landing_ref: landingRef,
        context_keys: cited,
        ...(receiptBinding ?? {}),
      },
    }));
  }

  private reportedUseMatchesBinding(
    event: RetrievalEventDbRow,
    binding: CliRetrievalLandingBinding,
    receiptBindings: Array<{ trace_id: RetrievalTraceId; receipt_sha256: string }>,
  ): boolean {
    const payload = parsePayload(event);
    if (!payload || typeof payload !== "object" || !("landing_ref" in payload) || !("context_keys" in payload)) return false;
    const reported = payload as Extract<RetrievalTraceEventInput["payload"], {
      landing_ref: string;
    }>;
    if (reported.landing_ref !== binding.landing_ref || reported.repo_sha !== binding.repo_sha) return false;
    if (JSON.stringify(reported.receipt_bindings) !== JSON.stringify(receiptBindings)) return false;
    if (!Array.isArray(reported.context_keys)) return false;
    return JSON.stringify(reported.context_keys.map((item) => item.record_id)) === JSON.stringify(binding.context_keys);
  }

  private appendEventInTransaction(eventInput: RetrievalTraceEventInput): void {
    const event = validateRetrievalTraceEvent(eventInput);
    const trace = this.requireTrace(event.trace_id);
    const existing = this.db.prepare("SELECT * FROM knowledge_retrieval_events WHERE trace_id = ? AND event_key = ?")
      .get(event.trace_id, event.event_key) as RetrievalEventDbRow | undefined;
    const payloadJson = JSON.stringify(event.payload);
    if (existing) {
      if (existing.event !== event.event || existing.payload_json !== payloadJson) throw new Error(`retrieval event key ${event.event_key} conflicts with stored evidence`);
      return;
    }
    const prior = this.events(event.trace_id);
    this.assertTransition(lifecycleState(prior), event.event);
    this.insertEvent(event);
    if (event.event === "miss" || event.event === "error" || event.event === "feedback") {
      const compactExpiry = addDays(trace.started_at, COMPACT_TTL_MS);
      this.db.prepare("UPDATE knowledge_retrieval_traces SET expires_at = MAX(expires_at, ?) WHERE trace_id = ?").run(compactExpiry, event.trace_id);
    }
  }

  private insertEvent(event: RetrievalTraceEventInput): void {
    this.db.prepare(`
      INSERT INTO knowledge_retrieval_events (trace_id, event, event_key, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.trace_id, event.event, event.event_key, JSON.stringify(event.payload), event.created_at);
  }

  private assertTransition(from: RetrievalTraceEventName | "none", to: RetrievalTraceEventName): void {
    if (to === "started") {
      if (from !== "none") throw new Error(`invalid retrieval transition ${from} -> started`);
      return;
    }
    if (to === "assembled" || to === "miss" || to === "error") {
      if (from !== "started") throw new Error(`invalid retrieval transition ${from} -> ${to}`);
      return;
    }
    if (to === "delivered") {
      if (!["assembled", "delivered", "delivered_error", "reported_use", "feedback"].includes(from)) throw new Error(`invalid retrieval transition ${from} -> delivered`);
      return;
    }
    if (to === "delivered_error") {
      if (from !== "miss" && from !== "error") throw new Error(`invalid retrieval transition ${from} -> delivered_error`);
      return;
    }
    if (to === "abandoned") {
      if (!["assembled", "miss", "error"].includes(from)) throw new Error(`invalid retrieval transition ${from} -> abandoned`);
      return;
    }
    if (to === "reported_use") {
      if (!["delivered", "reported_use", "feedback"].includes(from)) throw new Error(`invalid retrieval transition ${from} -> reported_use`);
      return;
    }
    if (to === "feedback") {
      if (!["assembled", "miss", "error", "delivered", "delivered_error", "abandoned", "reported_use", "feedback"].includes(from)) {
        throw new Error(`invalid retrieval transition ${from} -> feedback`);
      }
      return;
    }
    throw new Error(`unsupported retrieval event ${to}`);
  }

  private canonicalLifecycleEvents(traceId: string): RetrievalEventDbRow[] {
    return this.db.prepare(`
      SELECT *
        FROM knowledge_retrieval_events
       WHERE trace_id = ?
         AND (
           (event_key = 'started' AND event = 'started')
           OR (event_key = 'result' AND event IN ('assembled', 'miss', 'error'))
           OR (event_key = 'abandoned' AND event = 'abandoned')
           OR (event_key IN (?, ?, ?, ?) AND event IN ('delivered', 'delivered_error'))
         )
       ORDER BY id ASC
       LIMIT 7
    `).all(traceId, ...RETRIEVAL_CANONICAL_DELIVERY_EVENT_KEYS) as RetrievalEventDbRow[];
  }

  private reviewSummaryEvents(traceId: string, lifecycle = this.canonicalLifecycleEvents(traceId)): RetrievalEventDbRow[] {
    const feedback = this.db.prepare(`
      SELECT event.*
        FROM knowledge_retrieval_events event
        JOIN (
          SELECT MIN(id) AS id
            FROM knowledge_retrieval_events
           WHERE trace_id = ? AND event = 'feedback'
           GROUP BY json_extract(payload_json, '$.code')
           LIMIT 32
        ) code ON code.id = event.id
       ORDER BY event.id ASC
    `).all(traceId) as RetrievalEventDbRow[];
    return [...lifecycle, ...feedback];
  }

  private requireTrace(traceId: string): RetrievalTraceDbRow {
    const row = this.db.prepare("SELECT * FROM knowledge_retrieval_traces WHERE trace_id = ?").get(traceId) as RetrievalTraceDbRow | undefined;
    if (!row) throw new Error(`retrieval trace ${traceId} does not exist`);
    return row;
  }

  private maybePrune(): void {
    const now = Date.now();
    const count = (this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_retrieval_traces").get() as { count: number }).count;
    if (count <= TRACE_CAP && now - this.lastPruneAt < 60 * 60 * 1_000) return;
    this.lastPruneAt = now;
    this.prune(new Date(now).toISOString());
  }

  private events(traceId: string): RetrievalEventDbRow[] {
    return this.db.prepare("SELECT * FROM knowledge_retrieval_events WHERE trace_id = ? ORDER BY id ASC").all(traceId) as RetrievalEventDbRow[];
  }
}
