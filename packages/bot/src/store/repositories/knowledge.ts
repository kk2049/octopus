import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type KnowledgeKind =
  | "requirement"
  | "decision"
  | "non_goal"
  | "constraint"
  | "risk"
  | "outcome"
  | "verification"
  | "source";
export type KnowledgeStatus = "proposed" | "active" | "superseded" | "rejected" | "historical";
export type KnowledgeAuthority = "user" | "accepted" | "declared" | "derived" | "historical";

export interface KnowledgeRecordInput {
  record_key: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  authority: KnowledgeAuthority;
  title: string;
  body: string;
  source_type: string;
  source_ref: string;
  source_sha?: string | null;
  ticket_id?: number | null;
  confidence: number;
  metadata?: Record<string, unknown>;
  links?: ReadonlyArray<{ relation: string; target_type: string; target_key: string }>;
}

export interface KnowledgeRecordRow {
  id: number;
  record_key: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  authority: KnowledgeAuthority;
  title: string;
  body: string;
  source_type: string;
  source_ref: string;
  source_sha: string | null;
  ticket_id: number | null;
  confidence: number;
  metadata: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSearchHit extends KnowledgeRecordRow {
  rank: number;
}

export interface KnowledgeReviewRow {
  id: number;
  subject_id: string;
  rule: string;
  decision: string;
  note: string;
  actor: string;
  created_at: string;
}

export interface KnowledgeAnnotationRow {
  id: number;
  subject_id: string;
  body: string;
  actor: string;
  created_at: string;
}

export interface LandingKnowledge {
  specifications?: import("../../knowledge/specifications.js").KnowledgeSpecification[];
  changes?: import("../../knowledge/changes.js").KnowledgeChange[];
  /** Server stamped at the landing door; absent on legacy landings. */
  producer?: { model: string; session_ref: string | null };
  summary: string;
  decisions: string[];
  requirements: string[];
  non_goals: string[];
  risks: string[];
  verification: string[];
  context_keys: string[];
  supersedes: string[];
}

export interface KnowledgeReviewCandidate {
  conflict: import("../../knowledge/model.js").ConflictCandidate;
  nodes: Array<import("../../knowledge/model.js").KnowledgeNode | null>;
  target_sha: string;
  fingerprint: string;
}

export interface TicketLandingInput {
  ticket_id: number;
  from_sha: string;
  to_sha: string;
  base_before: string;
  tip_sha: string;
  source: "devpipe" | "cli" | "reconcile";
  report_path?: string | null;
  changed_files: string[];
  changed_modules: string[];
  acceptance: string[];
  knowledge: LandingKnowledge;
  created_at?: string;
}

export interface TicketLandingRow {
  id: number;
  ticket_id: number;
  from_sha: string;
  to_sha: string;
  base_before: string;
  tip_sha: string;
  source: string;
  status: "prepared" | "landed" | "aborted";
  landed_at: string | null;
  report_path: string | null;
  summary: string;
  changed_files: string;
  changed_modules: string;
  verification: string;
  acceptance: string;
  knowledge_json: string;
  created_at: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

const HAN_RUN = /\p{Script=Han}+/gu;
const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9_.\-]{2,}/g;
const MAX_QUERY_TERMS = 40;

/**
 * FTS5 trigram MATCH expression for Chinese, English or mixed free text.
 *
 * Han runs become overlapping three-character windows: the trigram tokenizer
 * cannot match anything shorter, and treating a whole clause as one phrase
 * (the 2026-08-19 behaviour) almost never matched a real ticket body. Latin
 * identifiers stay whole. Terms are frequency-ranked and capped so a long
 * body does not become a 200-term disjunction.
 */
function ftsQuery(query: string): string | null {
  const text = query.normalize("NFKC");
  const counts = new Map<string, number>();
  const bump = (term: string) => counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const match of text.matchAll(LATIN_TOKEN)) bump(match[0].toLowerCase());
  for (const match of text.matchAll(HAN_RUN)) {
    const run = match[0];
    for (let i = 0; i + 3 <= run.length; i += 1) bump(run.slice(i, i + 3));
  }
  const terms = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_QUERY_TERMS)
    .map(([term]) => term);
  if (!terms.length) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

/** SQLite authority for immutable landing ranges and their rebuildable knowledge projection. */
export class KnowledgeRepository {
  constructor(private readonly db: Database.Database) {}

  upsertRecord(input: KnowledgeRecordInput): void {
    this.db.transaction(() => this.upsertRecordInTransaction(input))();
  }

  syncSourceRecords(sourceTypes: readonly string[], records: readonly KnowledgeRecordInput[]): void {
    const allowed = new Set(sourceTypes);
    if (records.some((record) => !allowed.has(record.source_type))) {
      throw new Error("knowledge sync record has an undeclared source type");
    }
    this.db.transaction(() => {
      const seen = new Set(records.map((record) => record.record_key));
      for (const record of records) this.upsertRecordInTransaction(record);
      if (!sourceTypes.length) return;
      const placeholders = sourceTypes.map(() => "?").join(", ");
      const existing = this.db.prepare(
        `SELECT record_key FROM knowledge_records WHERE source_type IN (${placeholders}) AND status != 'superseded'`,
      ).all(...sourceTypes) as Array<{ record_key: string }>;
      const retire = this.db.prepare(
        "UPDATE knowledge_records SET status = 'superseded', updated_at = ? WHERE record_key = ?",
      );
      const now = new Date().toISOString();
      for (const row of existing) {
        if (!seen.has(row.record_key)) retire.run(now, row.record_key);
      }
    })();
  }

  prepareLanding(input: TicketLandingInput): TicketLandingRow {
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT * FROM ticket_landings WHERE ticket_id = ? AND to_sha = ?",
      ).get(input.ticket_id, input.to_sha) as TicketLandingRow | undefined;
      if (existing) return existing;

      const at = input.created_at ?? new Date().toISOString();
      const result = this.db.prepare(`
        INSERT INTO ticket_landings (
          ticket_id, from_sha, to_sha, base_before, tip_sha, status, landed_at,
          source, report_path, summary, changed_files, changed_modules,
          verification, acceptance, knowledge_json, created_at
        ) VALUES (?, ?, ?, ?, ?, 'prepared', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.ticket_id,
        input.from_sha,
        input.to_sha,
        input.base_before,
        input.tip_sha,
        input.source,
        input.report_path ?? null,
        input.knowledge.summary,
        json(input.changed_files),
        json(input.changed_modules),
        json(input.knowledge.verification),
        json(input.acceptance),
        json(input.knowledge),
        at,
      );
      return this.db.prepare("SELECT * FROM ticket_landings WHERE id = ?")
        .get(Number(result.lastInsertRowid)) as TicketLandingRow;
    })();
  }

  completeLanding(ticketId: number, toSha: string, landedAt = new Date().toISOString()): TicketLandingRow {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT * FROM ticket_landings WHERE ticket_id = ? AND to_sha = ?",
      ).get(ticketId, toSha) as TicketLandingRow | undefined;
      if (!row) throw new Error(`prepared landing not found: ticket ${ticketId} @ ${toSha}`);
      if (row.status === "aborted") throw new Error(`cannot complete aborted landing ${row.id}`);
      if (row.status === "landed") return row;

      const knowledge = JSON.parse(row.knowledge_json) as LandingKnowledge;
      const changedFiles = JSON.parse(row.changed_files) as string[];
      const changedModules = JSON.parse(row.changed_modules) as string[];
      this.db.prepare(
        "UPDATE ticket_landings SET status = 'landed', landed_at = ? WHERE id = ?",
      ).run(landedAt, row.id);
      const ticket = this.db.prepare(
        "SELECT requester FROM dev_tickets WHERE id = ?",
      ).get(row.ticket_id) as { requester: string } | undefined;
      const common = {
        status: "active" as const,
        authority: "derived" as const,
        source_type: "ticket_landing",
        source_ref: `ticket:${row.ticket_id}:landing:${row.id}`,
        source_sha: row.to_sha,
        ticket_id: row.ticket_id,
        confidence: 1,
        metadata: {
          landing_id: row.id,
          from_sha: row.from_sha,
          to_sha: row.to_sha,
          files: changedFiles,
          modules: changedModules,
          requester: ticket?.requester,
        },
      };
      const facts: Array<{ kind: KnowledgeKind; title: string; body: string }> = [
        { kind: "outcome", title: knowledge.summary, body: knowledge.summary },
        ...knowledge.requirements.map((body) => ({ kind: "requirement" as const, title: body, body })),
        ...knowledge.decisions.map((body) => ({ kind: "decision" as const, title: body, body })),
        ...knowledge.non_goals.map((body) => ({ kind: "non_goal" as const, title: body, body })),
        ...knowledge.risks.map((body) => ({ kind: "risk" as const, title: body, body })),
        ...knowledge.verification.map((body) => ({ kind: "verification" as const, title: body, body })),
      ];
      facts.forEach((fact, index) => {
        const recordKey = `landing:${row.id}:${fact.kind}:${index}`;
        this.upsertRecordInTransaction({
          record_key: recordKey,
          ...fact,
          ...common,
          links: [
            { relation: "evidenced_by", target_type: "landing", target_key: String(row.id) },
            ...changedModules.map((module) => ({ relation: "affects", target_type: "module", target_key: module })),
            ...changedFiles.map((file) => ({ relation: "affects", target_type: "path", target_key: file })),
            ...knowledge.context_keys.map((key) => ({ relation: "preserves", target_type: "knowledge", target_key: key })),
          ],
        });
      });
      const supersede = this.db.prepare(
        "UPDATE knowledge_records SET status = 'superseded', updated_at = ? WHERE record_key = ? AND status = 'active'",
      );
      const link = this.db.prepare(`
        INSERT OR IGNORE INTO knowledge_links (from_key, relation, target_type, target_key, created_at)
        VALUES (?, 'supersedes', 'knowledge', ?, ?)
      `);
      const outcomeKey = `landing:${row.id}:outcome:0`;
      for (const target of knowledge.supersedes) {
        supersede.run(landedAt, target);
        link.run(outcomeKey, target, landedAt);
      }
      return this.db.prepare("SELECT * FROM ticket_landings WHERE id = ?").get(row.id) as TicketLandingRow;
    })();
  }

  abortLanding(ticketId: number, toSha: string): void {
    this.db.prepare(
      "UPDATE ticket_landings SET status = 'aborted' WHERE ticket_id = ? AND to_sha = ? AND status = 'prepared'",
    ).run(ticketId, toSha);
  }

  recordLanding(input: TicketLandingInput): TicketLandingRow {
    this.prepareLanding(input);
    return this.completeLanding(input.ticket_id, input.to_sha, input.created_at);
  }

  listPreparedLandings(): TicketLandingRow[] {
    return this.db.prepare(
      "SELECT * FROM ticket_landings WHERE status = 'prepared' ORDER BY id",
    ).all() as TicketLandingRow[];
  }

  search(query: string, limit = 20): KnowledgeSearchHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    return this.db.prepare(`
      SELECT r.*, bm25(knowledge_fts, 4.0, 1.0, 2.0) AS rank
      FROM knowledge_fts
      JOIN knowledge_records r USING (record_key)
      WHERE knowledge_fts MATCH ?
        AND r.status IN ('active', 'proposed', 'historical')
      ORDER BY r.status = 'active' DESC,
               rank ASC,
               r.authority IN ('user', 'accepted', 'declared') DESC,
               r.confidence DESC
      LIMIT ?
    `).all(match, Math.max(1, Math.min(limit, 50))) as KnowledgeSearchHit[];
  }

  getRecords(keys: readonly string[]): KnowledgeRecordRow[] {
    if (!keys.length) return [];
    const placeholders = keys.map(() => "?").join(", ");
    return this.db.prepare(
      `SELECT * FROM knowledge_records WHERE record_key IN (${placeholders}) ORDER BY id`,
    ).all(...keys) as KnowledgeRecordRow[];
  }

  recordAnnotation(input: { subject_id: string; body: string; actor: string }): KnowledgeAnnotationRow {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO knowledge_annotations (subject_id, body, actor, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.subject_id, input.body, input.actor, createdAt);
    return this.db.prepare("SELECT * FROM knowledge_annotations WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as KnowledgeAnnotationRow;
  }

  /** Latest bounded window, returned oldest-first for direct conversation rendering. */
  listAnnotations(subjectId: string, limit = 100): KnowledgeAnnotationRow[] {
    return this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM knowledge_annotations
        WHERE subject_id = ?
        ORDER BY id DESC
        LIMIT ?
      ) ORDER BY id
    `).all(subjectId, Math.max(1, Math.min(limit, 200))) as KnowledgeAnnotationRow[];
  }

  /** Append a reviewer's decision on a conflict candidate or ambiguous record; the latest row per subject wins. */
  recordReview(input: { subject_id: string; rule: string; decision: string; note: string; actor: string }): KnowledgeReviewRow {
    const created_at = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO knowledge_reviews (subject_id, rule, decision, note, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.subject_id, input.rule, input.decision, input.note, input.actor, created_at);
    return this.db.prepare("SELECT * FROM knowledge_reviews WHERE id = ?").get(Number(result.lastInsertRowid)) as KnowledgeReviewRow;
  }

  /** All review rows oldest first; callers keep the last per subject. */
  listReviews(): KnowledgeReviewRow[] {
    return this.db.prepare("SELECT * FROM knowledge_reviews ORDER BY id").all() as KnowledgeReviewRow[];
  }

  recordReviewCandidate(candidate: KnowledgeReviewCandidate): void {
    this.db.prepare("INSERT OR IGNORE INTO knowledge_review_candidates (subject_id, fingerprint, target_sha, snapshot, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(candidate.conflict.id, candidate.fingerprint, candidate.target_sha, JSON.stringify(candidate), new Date().toISOString());
  }

  listReviewCandidates(): KnowledgeReviewCandidate[] {
    const rows = this.db.prepare("SELECT snapshot FROM knowledge_review_candidates ORDER BY id").all() as Array<{ snapshot: string }>;
    const latest = new Map<string, KnowledgeReviewCandidate>();
    for (const row of rows) {
      const candidate = JSON.parse(row.snapshot) as KnowledgeReviewCandidate;
      latest.set(candidate.conflict.id, candidate);
    }
    return [...latest.values()];
  }

  /** Every completed landing, oldest first — the derived knowledge graph's runtime input. */
  listLandedLandings(): TicketLandingRow[] {
    return this.db.prepare(
      "SELECT * FROM ticket_landings WHERE status = 'landed' ORDER BY id",
    ).all() as TicketLandingRow[];
  }

  listLandings(ticketId: number): TicketLandingRow[] {
    return this.db.prepare(
      "SELECT * FROM ticket_landings WHERE ticket_id = ? ORDER BY id",
    ).all(ticketId) as TicketLandingRow[];
  }

  private upsertRecordInTransaction(input: KnowledgeRecordInput): void {
    if (!input.record_key || !input.title.trim() || !input.body.trim()) {
      throw new Error("knowledge records require a key, title and body");
    }
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new Error("knowledge confidence must be between 0 and 1");
    }
    const now = new Date().toISOString();
    const metadata = json(input.metadata ?? {});
    const contentHash = hash(json({
      kind: input.kind,
      status: input.status,
      authority: input.authority,
      title: input.title,
      body: input.body,
      source_ref: input.source_ref,
      source_sha: input.source_sha ?? null,
      metadata,
    }));
    this.db.prepare(`
      INSERT INTO knowledge_records (
        record_key, kind, status, authority, title, body, source_type,
        source_ref, source_sha, ticket_id, confidence, metadata, content_hash,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_key) DO UPDATE SET
        kind = excluded.kind,
        status = excluded.status,
        authority = excluded.authority,
        title = excluded.title,
        body = excluded.body,
        source_type = excluded.source_type,
        source_ref = excluded.source_ref,
        source_sha = excluded.source_sha,
        ticket_id = excluded.ticket_id,
        confidence = excluded.confidence,
        metadata = excluded.metadata,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `).run(
      input.record_key,
      input.kind,
      input.status,
      input.authority,
      input.title.trim(),
      input.body.trim(),
      input.source_type,
      input.source_ref,
      input.source_sha ?? null,
      input.ticket_id ?? null,
      input.confidence,
      metadata,
      contentHash,
      now,
      now,
    );
    this.db.prepare("DELETE FROM knowledge_fts WHERE record_key = ?").run(input.record_key);
    this.db.prepare(
      "INSERT INTO knowledge_fts (record_key, title, body, source_ref) VALUES (?, ?, ?, ?)",
    ).run(input.record_key, input.title.trim(), input.body.trim(), input.source_ref);
    this.db.prepare("DELETE FROM knowledge_links WHERE from_key = ?").run(input.record_key);
    const insertLink = this.db.prepare(`
      INSERT OR IGNORE INTO knowledge_links (from_key, relation, target_type, target_key, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const item of input.links ?? []) {
      insertLink.run(input.record_key, item.relation, item.target_type, item.target_key, now);
    }
  }
}
