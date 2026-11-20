import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  BuildMeta,
  ConformanceArtifact,
  ConformanceObservation,
  ConflictCandidate,
  ContractCell,
  CoverageRow,
  KnowledgeEdge,
  KnowledgeNode,
  NodeKind,
  NodeStatus,
  Relation,
} from "./model.js";
import type { RuntimeInputs } from "./sources/landings.js";
import { GRAPH_SCHEMA_VERSION } from "./model.js";

/**
 * `graph.db` — the rebuildable derived layer. It lives under the runtime data
 * dir next to the Architecture Observatory snapshot and can be deleted at any
 * time; `buildGraph` recreates it from Git, docs, atlas and `ticket_landings`.
 *
 * Nothing in here is authoritative. Text columns hold atomic statements
 * (≤ 400 chars) and pointers, never ticket bodies, messages or transcripts.
 */
export const GRAPH_SCHEMA = `
PRAGMA user_version = 2;
PRAGMA foreign_keys = ON;
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  statement TEXT NOT NULL CHECK (length(statement) <= 400),
  status TEXT NOT NULL,
  authority TEXT NOT NULL,
  realization TEXT,
  source_ref TEXT NOT NULL,
  source_sha TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  method TEXT NOT NULL,
  certainty TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX nodes_kind_status ON nodes (kind, status);
CREATE TABLE edges (
  from_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_id TEXT NOT NULL,
  method TEXT NOT NULL,
  certainty TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_sha TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (from_id, relation, to_id)
);
CREATE INDEX edges_to ON edges (to_id, relation);
CREATE INDEX edges_from ON edges (from_id, relation);
CREATE TABLE contract_cells (
  id TEXT PRIMARY KEY REFERENCES nodes(id),
  contract_id TEXT NOT NULL REFERENCES nodes(id),
  scenario_id TEXT NOT NULL REFERENCES nodes(id),
  provider TEXT NOT NULL,
  launch_mode TEXT NOT NULL,
  state TEXT NOT NULL,
  action TEXT NOT NULL,
  desired TEXT NOT NULL CHECK (desired IN ('required', 'degraded', 'unsupported', 'not_applicable')),
  expected_ux TEXT NOT NULL CHECK (length(expected_ux) <= 400),
  trust_semantics TEXT NOT NULL CHECK (length(trust_semantics) <= 400),
  failure_semantics TEXT NOT NULL CHECK (length(failure_semantics) <= 400),
  exception_id TEXT REFERENCES nodes(id),
  UNIQUE (contract_id, provider, launch_mode, state, action)
);
CREATE INDEX contract_cells_lookup
  ON contract_cells (contract_id, provider, launch_mode, state, action);
CREATE TABLE conformance_observations (
  id TEXT PRIMARY KEY REFERENCES nodes(id),
  cell_id TEXT NOT NULL UNIQUE REFERENCES contract_cells(id),
  baseline_sha TEXT NOT NULL,
  code_index_sha TEXT,
  verified_sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('conformant', 'nonconformant', 'unverified', 'stale', 'waived')),
  reason TEXT NOT NULL CHECK (length(reason) <= 400)
);
CREATE TABLE conformance_artifacts (
  observation_id TEXT NOT NULL REFERENCES conformance_observations(id),
  artifact_id TEXT NOT NULL REFERENCES nodes(id),
  role TEXT NOT NULL CHECK (role IN ('handler', 'adapter', 'test', 'config', 'schema')),
  PRIMARY KEY (observation_id, artifact_id, role)
);
CREATE TABLE coverage (
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  measure TEXT NOT NULL,
  value REAL NOT NULL,
  note TEXT,
  PRIMARY KEY (scope_kind, scope_id, measure)
);
CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  a_id TEXT NOT NULL,
  b_id TEXT,
  why TEXT NOT NULL,
  severity TEXT NOT NULL
);
CREATE VIRTUAL TABLE node_fts USING fts5(
  id UNINDEXED,
  kind UNINDEXED,
  statement,
  aliases,
  tokenize='trigram'
);
CREATE TABLE build_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE build_runtime_inputs (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  value TEXT NOT NULL
);
`;

export interface NodeRow extends Omit<KnowledgeNode, "aliases" | "metadata"> {
  aliases: string;
  metadata: string;
}

export interface GraphSnapshot {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  coverage: CoverageRow[];
  conflicts: ConflictCandidate[];
  cells: ContractCell[];
  observations: ConformanceObservation[];
  observationArtifacts: ConformanceArtifact[];
  /** Private AWS-local source snapshot; never included in contextual records or graph metadata. */
  runtimeInputs?: RuntimeInputs;
  meta: BuildMeta;
}

export function parseNode(row: NodeRow): KnowledgeNode {
  return {
    ...row,
    realization: row.realization ?? undefined,
    valid_from: row.valid_from ?? undefined,
    valid_to: row.valid_to ?? undefined,
    aliases: JSON.parse(row.aliases) as string[],
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

export class GraphDb {
  private constructor(readonly db: Database.Database, readonly file: string) {}

  /**
   * Opens only schema-v2 graphs. A missing or older disposable projection is
   * reported as absent so the owning service rebuilds it from authorities.
   */
  static openReadonly(file: string): GraphDb | null {
    if (!fs.existsSync(file)) return null;
    const db = new Database(file, { readonly: true, fileMustExist: true });
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version !== GRAPH_SCHEMA_VERSION) {
      db.close();
      return null;
    }
    return new GraphDb(db, file);
  }

  static openInMemory(): GraphDb {
    const db = new Database(":memory:");
    db.exec(GRAPH_SCHEMA);
    return new GraphDb(db, ":memory:");
  }

  /**
   * Writes a complete snapshot to `file` atomically: build into a sibling temp
   * file and rename over the old graph so readers never observe a half-built
   * database.
   */
  static writeSnapshot(file: string, snapshot: GraphSnapshot): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    for (const stale of [temp, `${temp}-journal`, `${temp}-wal`, `${temp}-shm`]) fs.rmSync(stale, { force: true });
    fs.writeFileSync(temp, "", { flag: "wx", mode: 0o600 });
    const db = new Database(temp);
    try {
      db.pragma("journal_mode = MEMORY");
      db.exec(GRAPH_SCHEMA);
      new GraphDb(db, temp).fill(snapshot);
    } finally {
      db.close();
    }
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  }

  fill(snapshot: GraphSnapshot): void {
    const insertNode = this.db.prepare(`
      INSERT INTO nodes (id, kind, statement, status, authority, realization, source_ref, source_sha,
        valid_from, valid_to, method, certainty, aliases, metadata)
      VALUES (@id, @kind, @statement, @status, @authority, @realization, @source_ref, @source_sha,
        @valid_from, @valid_to, @method, @certainty, @aliases, @metadata)
    `);
    const insertFts = this.db.prepare("INSERT INTO node_fts (id, kind, statement, aliases) VALUES (?, ?, ?, ?)");
    const insertEdge = this.db.prepare(`
      INSERT OR IGNORE INTO edges (from_id, relation, to_id, method, certainty, source_ref, source_sha, observed_at)
      VALUES (@from_id, @relation, @to_id, @method, @certainty, @source_ref, @source_sha, @observed_at)
    `);
    const insertCell = this.db.prepare(`
      INSERT INTO contract_cells (id, contract_id, scenario_id, provider, launch_mode, state, action, desired,
        expected_ux, trust_semantics, failure_semantics, exception_id)
      VALUES (@id, @contract_id, @scenario_id, @provider, @launch_mode, @state, @action, @desired,
        @expected_ux, @trust_semantics, @failure_semantics, @exception_id)
    `);
    const insertObservation = this.db.prepare(`
      INSERT INTO conformance_observations (id, cell_id, baseline_sha, code_index_sha, verified_sha, status, reason)
      VALUES (@id, @cell_id, @baseline_sha, @code_index_sha, @verified_sha, @status, @reason)
    `);
    const insertObservationArtifact = this.db.prepare(`
      INSERT INTO conformance_artifacts (observation_id, artifact_id, role)
      VALUES (@observation_id, @artifact_id, @role)
    `);
    const insertCoverage = this.db.prepare(
      "INSERT OR REPLACE INTO coverage (scope_kind, scope_id, measure, value, note) VALUES (?, ?, ?, ?, ?)",
    );
    const insertConflict = this.db.prepare(
      "INSERT OR REPLACE INTO conflicts (id, rule, a_id, b_id, why, severity) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertMeta = this.db.prepare("INSERT OR REPLACE INTO build_meta (key, value) VALUES (?, ?)");
    this.db.transaction(() => {
      for (const node of [...snapshot.nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        insertNode.run({
          id: node.id,
          kind: node.kind,
          statement: node.statement,
          status: node.status,
          authority: node.authority,
          realization: node.realization ?? null,
          source_ref: node.source_ref,
          source_sha: node.source_sha,
          valid_from: node.valid_from ?? null,
          valid_to: node.valid_to ?? null,
          method: node.method,
          certainty: node.certainty,
          aliases: JSON.stringify(node.aliases ?? []),
          metadata: JSON.stringify(node.metadata ?? {}),
        });
        insertFts.run(node.id, node.kind, node.statement, (node.aliases ?? []).join(" "));
      }
      for (const edge of snapshot.edges) insertEdge.run(edge);
      for (const cell of [...snapshot.cells].sort((a, b) => a.id.localeCompare(b.id))) {
        insertCell.run({ ...cell, exception_id: cell.exception_id ?? null });
      }
      for (const observation of [...snapshot.observations].sort((a, b) => a.id.localeCompare(b.id))) {
        insertObservation.run({
          ...observation,
          code_index_sha: observation.code_index_sha ?? null,
          verified_sha: observation.verified_sha ?? null,
        });
      }
      for (const artifact of [...snapshot.observationArtifacts].sort((a, b) =>
        `${a.observation_id}\0${a.artifact_id}\0${a.role}`.localeCompare(`${b.observation_id}\0${b.artifact_id}\0${b.role}`),
      )) insertObservationArtifact.run(artifact);
      for (const row of snapshot.coverage) insertCoverage.run(row.scope_kind, row.scope_id, row.measure, row.value, row.note ?? null);
      for (const row of snapshot.conflicts) insertConflict.run(row.id, row.rule, row.a_id, row.b_id, row.why, row.severity);
      if (snapshot.runtimeInputs) {
        this.db.prepare("INSERT INTO build_runtime_inputs(singleton, value) VALUES (1, ?)").run(JSON.stringify(snapshot.runtimeInputs));
      }
      for (const [key, value] of Object.entries(snapshot.meta)) if (value !== undefined) insertMeta.run(key, String(value));
    })();
  }

  close(): void {
    this.db.close();
  }

  meta(): Partial<BuildMeta> {
    const rows = this.db.prepare("SELECT key, value FROM build_meta").all() as Array<{ key: string; value: string }>;
    const out: Record<string, string | number> = {};
    for (const row of rows) out[row.key] = /^(schema_version|node_count|edge_count)$/.test(row.key) ? Number(row.value) : row.value;
    return out as Partial<BuildMeta>;
  }

  runtimeInputs(): RuntimeInputs | null {
    const exists = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'build_runtime_inputs'",
    ).get();
    if (!exists) return null;
    const row = this.db.prepare("SELECT value FROM build_runtime_inputs WHERE singleton = 1").get() as { value: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.value) as Partial<RuntimeInputs>;
    if (!Array.isArray(value.landings) || !Array.isArray(value.tickets)) return null;
    return { landings: value.landings, tickets: value.tickets };
  }

  node(id: string): KnowledgeNode | null {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
    return row ? parseNode(row) : null;
  }

  nodes(ids: readonly string[]): KnowledgeNode[] {
    if (!ids.length) return [];
    const out: KnowledgeNode[] = [];
    for (let index = 0; index < ids.length; index += 500) {
      const chunk = ids.slice(index, index + 500);
      const rows = this.db.prepare(
        `SELECT * FROM nodes WHERE id IN (${chunk.map(() => "?").join(",")})`,
      ).all(...chunk) as NodeRow[];
      out.push(...rows.map(parseNode));
    }
    return out;
  }

  nodesByKind(kind: NodeKind, status?: NodeStatus): KnowledgeNode[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM nodes WHERE kind = ? AND status = ? ORDER BY id").all(kind, status)
      : this.db.prepare("SELECT * FROM nodes WHERE kind = ? ORDER BY id").all(kind);
    return (rows as NodeRow[]).map(parseNode);
  }

  allNodes(): KnowledgeNode[] {
    return (this.db.prepare("SELECT * FROM nodes ORDER BY id").all() as NodeRow[]).map(parseNode);
  }

  allEdges(): KnowledgeEdge[] {
    return this.db.prepare("SELECT * FROM edges ORDER BY from_id, relation, to_id").all() as KnowledgeEdge[];
  }

  contractCells(contractId?: string): ContractCell[] {
    const rows = contractId
      ? this.db.prepare("SELECT * FROM contract_cells WHERE contract_id = ? ORDER BY id").all(contractId)
      : this.db.prepare("SELECT * FROM contract_cells ORDER BY id").all();
    return (rows as Array<ContractCell & { exception_id: string | null }>).map((row) => ({
      ...row,
      exception_id: row.exception_id ?? undefined,
    }));
  }

  conformanceObservations(cellId?: string): ConformanceObservation[] {
    const rows = cellId
      ? this.db.prepare("SELECT * FROM conformance_observations WHERE cell_id = ? ORDER BY id").all(cellId)
      : this.db.prepare("SELECT * FROM conformance_observations ORDER BY id").all();
    return (rows as Array<ConformanceObservation & { code_index_sha: string | null; verified_sha: string | null }>).map((row) => ({
      ...row,
      code_index_sha: row.code_index_sha ?? undefined,
      verified_sha: row.verified_sha ?? undefined,
    }));
  }

  conformanceArtifacts(observationId?: string): ConformanceArtifact[] {
    return observationId
      ? this.db.prepare("SELECT * FROM conformance_artifacts WHERE observation_id = ? ORDER BY artifact_id, role").all(observationId) as ConformanceArtifact[]
      : this.db.prepare("SELECT * FROM conformance_artifacts ORDER BY observation_id, artifact_id, role").all() as ConformanceArtifact[];
  }

  edgesFrom(id: string, relations?: readonly Relation[]): KnowledgeEdge[] {
    if (relations?.length) {
      return this.db.prepare(
        `SELECT * FROM edges WHERE from_id = ? AND relation IN (${relations.map(() => "?").join(",")}) ORDER BY to_id`,
      ).all(id, ...relations) as KnowledgeEdge[];
    }
    return this.db.prepare("SELECT * FROM edges WHERE from_id = ? ORDER BY relation, to_id").all(id) as KnowledgeEdge[];
  }

  edgesTo(id: string, relations?: readonly Relation[]): KnowledgeEdge[] {
    if (relations?.length) {
      return this.db.prepare(
        `SELECT * FROM edges WHERE to_id = ? AND relation IN (${relations.map(() => "?").join(",")}) ORDER BY from_id`,
      ).all(id, ...relations) as KnowledgeEdge[];
    }
    return this.db.prepare("SELECT * FROM edges WHERE to_id = ? ORDER BY relation, from_id").all(id) as KnowledgeEdge[];
  }

  /** Nodes reachable by one hop over `relation`, in either direction. */
  neighbors(ids: readonly string[], relation: Relation, direction: "out" | "in"): KnowledgeNode[] {
    if (!ids.length) return [];
    const column = direction === "out" ? "from_id" : "to_id";
    const target = direction === "out" ? "to_id" : "from_id";
    const found = new Set<string>();
    for (let index = 0; index < ids.length; index += 500) {
      const chunk = ids.slice(index, index + 500);
      const rows = this.db.prepare(
        `SELECT DISTINCT ${target} AS id FROM edges WHERE relation = ? AND ${column} IN (${chunk.map(() => "?").join(",")})`,
      ).all(relation, ...chunk) as Array<{ id: string }>;
      for (const row of rows) found.add(row.id);
    }
    return this.nodes([...found]);
  }

  /** FTS over statements + aliases. `match` must already be an FTS5 expression. */
  searchFts(match: string, opts: { kinds?: readonly NodeKind[]; statuses?: readonly NodeStatus[]; limit: number }): Array<{ id: string; rank: number }> {
    const kinds = opts.kinds ?? [];
    const statuses = opts.statuses ?? ["active", "proposed", "historical"];
    const sql = `
      SELECT n.id AS id, bm25(node_fts, 0, 0, 1.0, 2.0) AS rank
      FROM node_fts JOIN nodes n ON n.id = node_fts.id
      WHERE node_fts MATCH ?
        AND n.status IN (${statuses.map(() => "?").join(",")})
        ${kinds.length ? `AND n.kind IN (${kinds.map(() => "?").join(",")})` : ""}
      ORDER BY rank ASC
      LIMIT ?`;
    try {
      return this.db.prepare(sql).all(match, ...statuses, ...kinds, Math.max(1, Math.min(opts.limit, 200))) as Array<{ id: string; rank: number }>;
    } catch {
      return [];
    }
  }

  coverage(): CoverageRow[] {
    return this.db.prepare("SELECT * FROM coverage ORDER BY scope_kind, scope_id, measure").all() as CoverageRow[];
  }

  conflicts(): ConflictCandidate[] {
    return this.db.prepare("SELECT * FROM conflicts ORDER BY severity DESC, rule, id").all() as ConflictCandidate[];
  }

  counts(): { nodes: number; edges: number; byKind: Record<string, number> } {
    const nodes = (this.db.prepare("SELECT count(*) AS n FROM nodes").get() as { n: number }).n;
    const edges = (this.db.prepare("SELECT count(*) AS n FROM edges").get() as { n: number }).n;
    const rows = this.db.prepare("SELECT kind, count(*) AS n FROM nodes GROUP BY kind").all() as Array<{ kind: string; n: number }>;
    return { nodes, edges, byKind: Object.fromEntries(rows.map((row) => [row.kind, row.n])) };
  }
}
