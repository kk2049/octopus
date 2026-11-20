import type Database from "better-sqlite3";
import type {
  ResearchEvent,
  ResearchRun,
  ResearchMessage,
} from "@claude-bot/research-canvas-contract";

export type ResearchBucket =
  | "nodes"
  | "evidence-reports"
  | "evidence-adoptions"
  | "cloud-documents"
  | "paper-sync-intents"
  | "node-resources"
  | "text-files"
  | "text-versions"
  | "file-write-intents"
  | "graph-nodes"
  | "graph-edges"
  | "edges"
  | "subscriptions"
  | "bindings"
  | "proposals"
  | "runs"
  | "messages"
  | "uploads"
  | "files"
  | "outbox"
  | "schedules"
  | "usage"
  | "native"
  | "native-runs"
  | "native-responses"
  | "native-completions"
  | "workflow-drafts"
  | "workflow-flags"
  | "workflow-rules"
  | "workflow-batches"
  | "workflow-executions"
  | "workflow-traces"
  | "meeting-plans"
  | "meeting-summaries"
  | "discussion-sources"
  | "discussion-follows"
  | "discussion-create-outbox";
interface StoredRecord {
  id: string;
  version: number;
  record: string;
}
export interface ResearchChange {
  seq: number;
  bucket: ResearchBucket;
  id: string;
  version: number;
  at: string;
}
export interface InboxRow {
  id: number;
  project: string;
  subscription: string;
  event_id: string;
  event: string;
  state: string;
  run: string | null;
  reason: string | null;
  at: string;
}

/** SQL boundary. Callers must authorize the project before entering it. */
export class ResearchCanvasRepository {
  constructor(private readonly db: Database.Database) {}
  /** Caller must already hold this project's membership. No graph contents escape. */
  projectTitle(project: string): string {
    const migrated = this.db.prepare("SELECT 1 FROM research_records WHERE project=? AND bucket='graph-nodes' LIMIT 1").get(project);
    const graphRow = migrated ? this.db.prepare(
      "SELECT json_extract(record, '$.label') AS title FROM research_records WHERE project=? AND bucket='graph-nodes' AND json_extract(record, '$.ref') LIKE 'goal:%' AND COALESCE(json_extract(record, '$.archived'),0)=0 ORDER BY sequence LIMIT 1",
    ).get(project) as { title: unknown } | undefined : undefined;
    const row = migrated ? graphRow : this.db.prepare(
      "SELECT json_extract(record, '$.title') AS title FROM research_records WHERE project=? AND bucket='nodes' AND json_extract(record, '$.type')='goal' AND COALESCE(json_extract(record, '$.archived'),0)=0 ORDER BY sequence LIMIT 1",
    ).get(project) as { title: unknown } | undefined;
    const title = typeof row?.title === "string" ? row.title.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s*[·•|｜-]?\s*GOAL\s*$/i, "").trim().slice(0, 120) : "";
    return title || "未命名科研项目";
  }
  atomic<T>(work: () => T): T {
    return this.db.transaction(work)();
  }
  get<T>(project: string, bucket: ResearchBucket, id: string): T | null {
    const row = this.db
      .prepare(
        "SELECT record FROM research_records WHERE project=? AND bucket=? AND id=?",
      )
      .get(project, bucket, id) as StoredRecord | undefined;
    return row ? (JSON.parse(row.record) as T) : null;
  }
  list<T>(
    project: string,
    bucket: ResearchBucket,
    after = "",
    limit = 101,
  ): T[] {
    return (
      this.db
        .prepare(
          "SELECT record FROM research_records WHERE project=? AND bucket=? AND id>? ORDER BY id LIMIT ?",
        )
        .all(
          project,
          bucket,
          after,
          Math.min(1001, Math.max(1, limit)),
        ) as StoredRecord[]
    ).map((row) => JSON.parse(row.record) as T);
  }
  projects(): string[] {
    return (
      this.db
        .prepare(
          "SELECT DISTINCT project FROM research_records ORDER BY project",
        )
        .all() as { project: string }[]
    ).map((row) => row.project);
  }
  runs(
    project: string,
    options: { node?: string; active?: boolean; limit?: number } = {},
  ): ResearchRun[] {
    const query = `SELECT record FROM research_records WHERE project=? AND bucket='runs'
      ${options.node ? "AND json_extract(record, '$.node')=?" : ""}
      ${options.active ? "AND json_extract(record, '$.status') IN ('queued','running','waiting')" : ""}
      ORDER BY sequence ${options.active ? "ASC" : "DESC"} LIMIT ?`;
    const rows = this.db
      .prepare(query)
      .all(
        project,
        ...(options.node ? [options.node] : []),
        Math.min(1000, options.limit ?? 100),
      ) as StoredRecord[];
    const result = rows.map((row) => JSON.parse(row.record) as ResearchRun);
    return options.active ? result : result.reverse();
  }
  messages(
    project: string,
    conversations: string[],
    cursor = "",
    limit = 101,
    runs?: string[],
  ): ResearchMessage[] {
    if (!conversations.length) return [];
    const after = cursor
      ? (this.db
          .prepare(
            "SELECT sequence FROM research_records WHERE project=? AND bucket='messages' AND id=?",
          )
          .get(project, cursor) as { sequence: number } | undefined)
      : undefined;
    if (cursor && !after) throw new Error("历史游标已失效");
    const rows = this.db
      .prepare(
        `SELECT record, sequence FROM research_records WHERE project=? AND bucket='messages'
      AND json_extract(record, '$.conversation') IN (${conversations.map(() => "?").join(",")})
      ${runs ? `AND json_extract(record, '$.run') IN (${runs.map(() => "?").join(",")})` : ""}
      AND sequence<? ORDER BY sequence DESC LIMIT ?`,
      )
      .all(
        project,
        ...conversations,
        ...(runs ?? []),
        after?.sequence ?? Number.MAX_SAFE_INTEGER,
        Math.min(1000, limit),
      ) as (StoredRecord & { sequence: number })[];
    return rows
      .reverse()
      .map((row) => ({
        ...(JSON.parse(row.record) as ResearchMessage),
        sequence: row.sequence,
      }));
  }
  fileVersions<T extends { id: string }>(
    project: string,
    node: string,
    after: string,
  ): T[] {
    return (
      this.db
        .prepare(
          "SELECT record FROM research_records WHERE project=? AND bucket='files' AND json_extract(record,'$.node')=? AND id>? ORDER BY id LIMIT 101",
        )
        .all(project, node, after) as StoredRecord[]
    ).map((row) => JSON.parse(row.record) as T);
  }
  put<T>(
    project: string,
    bucket: ResearchBucket,
    id: string,
    record: T,
    expected: number | null = null,
    notify = true,
  ): number {
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > 512 * 1024)
      throw new Error("记录超过大小限制");
    return this.atomic(() => {
      const prior = this.db
        .prepare(
          "SELECT version FROM research_records WHERE project=? AND bucket=? AND id=?",
        )
        .get(project, bucket, id) as { version: number } | undefined;
      if (expected !== null && (prior?.version ?? 0) !== expected)
        throw new Error("版本已变化，请重新读取后再修改");
      const version = (prior?.version ?? 0) + 1;
      this.db
        .prepare(
          "INSERT INTO research_records(project,bucket,id,version,record,sequence) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM research_records WHERE project=?)) ON CONFLICT(project,bucket,id) DO UPDATE SET version=excluded.version,record=excluded.record",
        )
        .run(project, bucket, id, version, bytes, project);
      if (notify)
        this.db
          .prepare(
            "INSERT INTO research_changes(project,bucket,id,version,at) VALUES(?,?,?,?,?)",
          )
          .run(project, bucket, id, version, new Date().toISOString());
      return version;
    });
  }
  changes(project: string, after: number, limit = 101): ResearchChange[] {
    return this.db
      .prepare(
        "SELECT seq,bucket,id,version,at FROM research_changes WHERE project=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(project, after, Math.min(501, limit)) as ResearchChange[];
  }
  cursor(project: string): number {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(MAX(seq),0) AS seq FROM research_changes WHERE project=?",
        )
        .get(project) as { seq: number }
    ).seq;
  }
  receipt<T>(
    project: string,
    actor: string,
    request: string,
    fingerprint: string,
  ): T | null {
    const prior = this.db
      .prepare(
        "SELECT fingerprint,result FROM research_requests WHERE project=? AND actor=? AND request=?",
      )
      .get(project, actor, request) as
      | { fingerprint: string; result: string }
      | undefined;
    if (prior && prior.fingerprint !== fingerprint)
      throw new Error("请求 ID 已用于另一个操作");
    return prior ? (JSON.parse(prior.result) as T) : null;
  }
  remember(
    project: string,
    actor: string,
    request: string,
    fingerprint: string,
    result: unknown,
  ): void {
    this.db
      .prepare("INSERT INTO research_requests VALUES(?,?,?,?,?)")
      .run(project, actor, request, fingerprint, JSON.stringify(result));
  }
  enqueue(
    project: string,
    subscription: string,
    event: ResearchEvent,
  ): boolean {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO research_inbox(project,subscription,event_id,event,state,at) VALUES(?,?,?,?,'pending',?)",
        )
        .run(project, subscription, event.id, JSON.stringify(event), event.at)
        .changes === 1
    );
  }
  pending(limit = 100): InboxRow[] {
    return this.db
      .prepare(
        "SELECT * FROM research_inbox WHERE state='pending' ORDER BY id LIMIT ?",
      )
      .all(Math.min(500, limit)) as InboxRow[];
  }
  settleInbox(
    id: number,
    state: "quiet" | "queued" | "error" | "cancelled",
    reason: string,
    run: string | null = null,
  ): void {
    this.db
      .prepare(
        "UPDATE research_inbox SET state=?,reason=?,run=? WHERE id=? AND state='pending'",
      )
      .run(state, reason, run, id);
  }
  inbox(project: string, subscription: string, after = 0): InboxRow[] {
    return this.db
      .prepare(
        "SELECT * FROM research_inbox WHERE project=? AND subscription=? AND id>? ORDER BY id LIMIT 100",
      )
      .all(project, subscription, after) as InboxRow[];
  }
}
