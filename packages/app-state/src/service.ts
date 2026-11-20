/**
 * Durable App state: immutable commit files are truth; SQLite serializes
 * writers and indexes that truth. There is no update/delete-history method.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { canonicalJson, isJsonValue, sha256 } from "./canonical.js";
import { SnapshotStore } from "./snapshot-store.js";
import { retrySqliteBusy } from "./sqlite-busy.js";
import { STATE_READ_PAGE_LIMIT } from "./types.js";
import type {
  AppStateHealth,
  CommitRequest,
  CommitResult,
  CommitSummary,
  EventInput,
  JsonValue,
  ReadCommitsResult,
  ReadResult,
  ResolveStreamRequest,
  SnapshotResult,
  StoredEvent,
  StreamHead,
} from "./types.js";

const STREAM_ID = /^st_[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_EVENTS = 256;
const MAX_COMMIT_PAGE = 256;
const MAX_EVENT_BYTES = 64 * 1024;
const COMMIT_FILE = /^(\d{12})-(\d{12})-([0-9a-f-]{36})\.json$/;
export { SNAPSHOT_RETENTION_PER_DIGEST } from "./snapshot-store.js";

interface StreamRow {
  stream_id: string;
  app_id: string;
  scope_kind: string;
  scope_key: string;
  head: number;
  head_hash: string;
}

interface CommitRow {
  stream_id: string;
  dispatch_id: string;
  seq_from: number;
  seq_to: number;
  file_name: string;
  commit_hash: string;
}

interface StreamManifest {
  format: 1;
  streamId: string;
  app: string;
  scope: { kind: string; key: string };
}

interface CommitDocument {
  format: 1;
  streamId: string;
  seqFrom: number;
  seqTo: number;
  actor: string;
  action: string;
  dispatchId: string;
  backendCodeDigest: string;
  contractDigest: string;
  paramsHash: string;
  events: StoredEvent[];
  prevCommitHash: string;
  commitHash: string;
}

export type FaultPoint = "after_file_fsync" | "after_rename" | "before_db_commit";

export interface AppStateServiceOptions {
  /** Diagnostic-only; no stream identity or content leaves the State process. */
  onStartupPhase?: (phase: "database" | "schema" | "recovery" | "ready") => void;
  busyTimeoutMs?: number;
  fault?: (point: FaultPoint) => void;
}

export class AppStateError extends Error {
  constructor(message: string, readonly code = "state_error") {
    super(message);
    this.name = "AppStateError";
  }
}

export class AppStateService {
  private readonly db: Database.Database;
  private readonly snapshots: SnapshotStore;
  private recoveredStreams = 0;
  private closed = false;

  constructor(readonly stateDir: string, private readonly options: AppStateServiceOptions = {}) {
    options.onStartupPhase?.("database");
    this.stateDir = path.resolve(stateDir);
    secureDir(this.stateDir);
    secureDir(path.join(this.stateDir, "streams"));
    const dbPath = path.join(this.stateDir, "state.db");
    this.db = new Database(dbPath);
    const busyTimeoutMs = Math.max(1, options.busyTimeoutMs ?? 10_000);
    this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    // WAL mode is persistent, but two first-open processes can both observe a
    // new database and race to establish it. SQLite can return BUSY immediately
    // for this mode change without invoking the connection's busy handler.
    retrySqliteBusy(() => this.db.pragma("journal_mode = WAL"), busyTimeoutMs);
    this.db.pragma("synchronous = FULL");
    chmodSync(dbPath, 0o600);
    options.onStartupPhase?.("schema");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS streams (
        stream_id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        head INTEGER NOT NULL DEFAULT 0,
        head_hash TEXT NOT NULL DEFAULT '',
        UNIQUE(app_id, scope_kind, scope_key)
      );
      CREATE TABLE IF NOT EXISTS commits (
        stream_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        seq_from INTEGER NOT NULL,
        seq_to INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        PRIMARY KEY(stream_id, dispatch_id),
        UNIQUE(stream_id, seq_from),
        FOREIGN KEY(stream_id) REFERENCES streams(stream_id)
      );
      CREATE INDEX IF NOT EXISTS commits_order ON commits(stream_id, seq_from);
    `);
    this.snapshots = new SnapshotStore(
      this.db,
      (streamId) => path.join(this.streamDir(streamId), "snapshots"),
      writeAtomic,
    );
    this.snapshots.installSchema();
    options.onStartupPhase?.("recovery");
    this.recover();
    options.onStartupPhase?.("ready");
  }

  health(): AppStateHealth {
    return { ok: !this.closed, recoveredStreams: this.recoveredStreams, stateDir: this.stateDir };
  }

  resolveStream(request: ResolveStreamRequest): StreamHead {
    this.assertOpen();
    const app = bounded(request.app, 128, "app");
    const kind = bounded(request.scope?.kind, 64, "scope kind");
    const key = bounded(request.scope?.key, 1024, "scope key");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const hit = this.db.prepare(
        "SELECT * FROM streams WHERE app_id = ? AND scope_kind = ? AND scope_key = ?",
      ).get(app, kind, key) as StreamRow | undefined;
      if (hit) {
        this.db.exec("COMMIT");
        return { streamId: hit.stream_id, head: hit.head };
      }
      const streamId = `st_${randomBytes(16).toString("hex")}`;
      const manifest: StreamManifest = { format: 1, streamId, app, scope: { kind, key } };
      const dir = this.streamDir(streamId);
      secureDir(dir);
      secureDir(path.join(dir, "commits"));
      secureDir(path.join(dir, "snapshots"));
      writeAtomic(path.join(dir, "stream.json"), canonicalJson(manifest as unknown as JsonValue));
      this.db.prepare(
        "INSERT INTO streams(stream_id, app_id, scope_kind, scope_key, head, head_hash) VALUES (?, ?, ?, ?, 0, '')",
      ).run(streamId, app, kind, key);
      this.db.exec("COMMIT");
      return { streamId, head: 0 };
    } catch (error) {
      this.rollback();
      throw stateError(error);
    }
  }

  commit(request: CommitRequest): CommitResult {
    this.assertOpen();
    validateCommitRequest(request);
    let renamed = false;
    let temp: string | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.db.prepare(
        "SELECT * FROM commits WHERE stream_id = ? AND dispatch_id = ?",
      ).get(request.streamId, request.dispatchId) as CommitRow | undefined;
      if (duplicate) {
        this.db.exec("COMMIT");
        return { ok: true, revision: duplicate.seq_to, duplicate: true };
      }
      const stream = this.stream(request.streamId);
      if (stream.head !== request.expectedRevision) {
        this.db.exec("COMMIT");
        return { ok: false, code: "conflict", head: stream.head };
      }
      const seqFrom = stream.head + 1;
      const events = request.events.map((event, index): StoredEvent => ({ ...event, seq: seqFrom + index }));
      const seqTo = events[events.length - 1]!.seq;
      const base = {
        format: 1 as const,
        streamId: request.streamId,
        seqFrom,
        seqTo,
        actor: request.actor,
        action: request.action,
        dispatchId: request.dispatchId,
        backendCodeDigest: request.backendCodeDigest,
        contractDigest: request.contractDigest,
        paramsHash: request.paramsHash,
        events,
        prevCommitHash: stream.head_hash,
      };
      const commitHash = sha256(canonicalJson(base as unknown as JsonValue));
      const document: CommitDocument = { ...base, commitHash };
      const name = `${pad(seqFrom)}-${pad(seqTo)}-${randomUUID()}.json`;
      const commitsDir = path.join(this.streamDir(request.streamId), "commits");
      temp = path.join(commitsDir, `.tmp-${randomBytes(12).toString("hex")}`);
      const target = path.join(commitsDir, name);
      writeAndSync(temp, canonicalJson(document as unknown as JsonValue));
      this.options.fault?.("after_file_fsync");
      renameSync(temp, target);
      syncDir(commitsDir);
      renamed = true;
      this.options.fault?.("after_rename");
      this.db.prepare(
        `INSERT INTO commits(stream_id, dispatch_id, seq_from, seq_to, file_name, commit_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(request.streamId, request.dispatchId, seqFrom, seqTo, name, commitHash);
      this.db.prepare("UPDATE streams SET head = ?, head_hash = ? WHERE stream_id = ?")
        .run(seqTo, commitHash, request.streamId);
      this.options.fault?.("before_db_commit");
      this.db.exec("COMMIT");
      return { ok: true, revision: seqTo, duplicate: false };
    } catch (error) {
      this.rollback();
      // A process crash leaves this cleanup to recover(); an ordinary injected
      // or I/O failure should not retain a file that never became history.
      if (!renamed && temp) rmSync(temp, { force: true });
      if (renamed) {
        // The immutable file may now be truth while the index rolled back.
        // Reconcile before accepting another write, then answer from the
        // idempotency row. The caller never has to guess whether to append a
        // second copy of the same dispatch.
        this.recover();
        const adopted = this.db.prepare(
          "SELECT * FROM commits WHERE stream_id = ? AND dispatch_id = ?",
        ).get(request.streamId, request.dispatchId) as CommitRow | undefined;
        if (adopted) return { ok: true, revision: adopted.seq_to, duplicate: true };
      }
      throw stateError(error);
    }
  }

  readSince(streamId: string, after: number, limit: number): ReadResult {
    this.assertOpen();
    if (!STREAM_ID.test(streamId)) throw new AppStateError("invalid stream id", "invalid");
    if (!Number.isSafeInteger(after) || after < 0) throw new AppStateError("invalid revision", "invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > STATE_READ_PAGE_LIMIT) {
      throw new AppStateError(
        `read page limit must be 1-${STATE_READ_PAGE_LIMIT}; paginate and compact projection history with snapshots`,
        "history_page_limit",
      );
    }
    const stream = this.stream(streamId);
    const rows = this.db.prepare(
      "SELECT * FROM commits WHERE stream_id = ? AND seq_to > ? AND seq_from <= ? ORDER BY seq_from LIMIT ?",
    ).all(streamId, after, stream.head, limit) as CommitRow[];
    const events: StoredEvent[] = [];
    for (const row of rows) {
      const doc = this.readCommit(streamId, row.file_name, row.commit_hash);
      for (const event of doc.events) {
        if (event.seq <= after || event.seq > stream.head) continue;
        events.push(event);
        if (events.length >= limit) break;
      }
      if (events.length >= limit) break;
    }
    const cursor = events.at(-1)?.seq ?? after;
    return { events, head: stream.head, cursor, hasMore: cursor < stream.head };
  }

  /**
   * The commit chain as an audit/repair page: evidence fields and an event
   * count, never raw params or payloads. Oldest first, from the same immutable
   * files `readSince` reads, so the two faces cannot disagree about history.
   */
  readCommits(streamId: string, after: number, limit: number): ReadCommitsResult {
    this.assertOpen();
    if (!Number.isSafeInteger(after) || after < 0) throw new AppStateError("invalid revision", "invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_COMMIT_PAGE) {
      throw new AppStateError(`limit must be 1-${MAX_COMMIT_PAGE}`, "invalid");
    }
    const stream = this.stream(streamId);
    const rows = this.db.prepare(
      "SELECT * FROM commits WHERE stream_id = ? AND seq_to > ? ORDER BY seq_from LIMIT ?",
    ).all(streamId, after, limit) as CommitRow[];
    const commits = rows.map((row): CommitSummary => {
      const doc = this.readCommit(streamId, row.file_name, row.commit_hash);
      return {
        seqFrom: doc.seqFrom, seqTo: doc.seqTo, at: doc.events[0]?.at ?? "", actor: doc.actor,
        action: doc.action, dispatchId: doc.dispatchId, paramsHash: doc.paramsHash,
        backendCodeDigest: doc.backendCodeDigest, contractDigest: doc.contractDigest, eventCount: doc.events.length,
      };
    });
    return { commits, head: stream.head };
  }

  putSnapshot(streamId: string, revision: number, projectionDigest: string, view: JsonValue): void {
    this.assertOpen();
    const stream = this.stream(streamId);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > stream.head) throw new AppStateError("snapshot revision is outside the stream", "invalid");
    if (!DIGEST.test(projectionDigest) || !isJsonValue(view)) throw new AppStateError("invalid snapshot", "invalid");
    try { this.snapshots.put(streamId, revision, projectionDigest, view); }
    catch (error) { throw stateError(error); }
  }

  snapshot(streamId: string, projectionDigest: string): SnapshotResult | null {
    this.assertOpen();
    const stream = this.stream(streamId);
    if (!DIGEST.test(projectionDigest)) throw new AppStateError("invalid projection digest", "invalid");
    return this.snapshots.get(streamId, stream.head, projectionDigest);
  }

  /** Rebuild the index while holding the same BEGIN IMMEDIATE writer lock. */
  recover(): void {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const manifests = this.scanManifests();
      for (const manifest of manifests) this.recoverStream(manifest);
      const known = new Set(manifests.map((manifest) => manifest.streamId));
      const indexed = this.db.prepare("SELECT stream_id FROM streams").all() as Array<{ stream_id: string }>;
      for (const row of indexed) {
        if (!known.has(row.stream_id)) {
          throw new AppStateError(`stream ${row.stream_id} is indexed but its immutable manifest is missing`, "state_corrupt");
        }
      }
      this.db.exec("COMMIT");
      this.recoveredStreams = manifests.length;
    } catch (error) {
      this.rollback();
      throw stateError(error, "state_recovery_failed");
    }
  }

  private recoverStream(manifest: StreamManifest): void {
    const existing = this.db.prepare(
      "SELECT * FROM streams WHERE app_id = ? AND scope_kind = ? AND scope_key = ?",
    ).get(manifest.app, manifest.scope.kind, manifest.scope.key) as StreamRow | undefined;
    if (existing && existing.stream_id !== manifest.streamId) {
      throw new AppStateError(`scope has two stream manifests: ${existing.stream_id} and ${manifest.streamId}`, "state_corrupt");
    }
    this.db.prepare(
      `INSERT INTO streams(stream_id, app_id, scope_kind, scope_key, head, head_hash)
       VALUES (?, ?, ?, ?, 0, '')
       ON CONFLICT(stream_id) DO UPDATE SET app_id=excluded.app_id, scope_kind=excluded.scope_kind, scope_key=excluded.scope_key`,
    ).run(manifest.streamId, manifest.app, manifest.scope.kind, manifest.scope.key);

    const commitsDir = path.join(this.streamDir(manifest.streamId), "commits");
    secureDir(commitsDir);
    for (const name of readdirSync(commitsDir)) {
      if (name.startsWith(".tmp-")) rmSync(path.join(commitsDir, name), { force: true });
    }
    const files = readdirSync(commitsDir)
      .map((name) => ({ name, match: COMMIT_FILE.exec(name) }))
      .filter((row): row is { name: string; match: RegExpExecArray } => Boolean(row.match))
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]) || a.name.localeCompare(b.name));
    // Rows enter the index only after their chain link was verified, so an
    // index that still names exactly the oldest files needs only its newest row
    // re-checked against the file; later files (a crash between rename and
    // index commit) are adopted below. Anything else rebuilds from the files.
    // Replaying every commit on each start took ~50 s for a 24k-commit App.
    const indexed = this.verifiedPrefix(manifest.streamId, files);
    if (indexed.length === 0) this.db.prepare("DELETE FROM commits WHERE stream_id = ?").run(manifest.streamId);
    let head = indexed.at(-1)?.seq_to ?? 0;
    let headHash = indexed.at(-1)?.commit_hash ?? "";
    const dispatches = new Set<string>();
    for (const file of files.slice(indexed.length)) {
      const doc = this.readCommit(manifest.streamId, file.name);
      if (doc.seqFrom !== head + 1 || doc.seqTo < doc.seqFrom) {
        throw new AppStateError(`commit sequence gap or fork at ${file.name}`, "state_corrupt");
      }
      if (doc.prevCommitHash !== headHash) throw new AppStateError(`commit hash chain breaks at ${file.name}`, "state_corrupt");
      const indexedDispatch = indexed.length > 0 && this.db.prepare(
        "SELECT 1 FROM commits WHERE stream_id = ? AND dispatch_id = ?",
      ).get(manifest.streamId, doc.dispatchId);
      if (dispatches.has(doc.dispatchId) || indexedDispatch) {
        throw new AppStateError(`duplicate dispatch in immutable history: ${doc.dispatchId}`, "state_corrupt");
      }
      dispatches.add(doc.dispatchId);
      for (let index = 0; index < doc.events.length; index++) {
        if (doc.events[index]?.seq !== doc.seqFrom + index) {
          throw new AppStateError(`event sequence is invalid in ${file.name}`, "state_corrupt");
        }
      }
      if (doc.events.length !== doc.seqTo - doc.seqFrom + 1) {
        throw new AppStateError(`event count is invalid in ${file.name}`, "state_corrupt");
      }
      this.db.prepare(
        `INSERT INTO commits(stream_id, dispatch_id, seq_from, seq_to, file_name, commit_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(manifest.streamId, doc.dispatchId, doc.seqFrom, doc.seqTo, file.name, doc.commitHash);
      head = doc.seqTo;
      headHash = doc.commitHash;
    }
    this.db.prepare("UPDATE streams SET head = ?, head_hash = ? WHERE stream_id = ?")
      .run(head, headHash, manifest.streamId);
    this.snapshots.recover(manifest.streamId, head);
  }

  /**
   * This stream's index rows when they name exactly the oldest commit files in
   * order, chain contiguously to the stream head, and the newest row still
   * matches its file; otherwise none, so the caller rebuilds from the files.
   */
  private verifiedPrefix(streamId: string, files: ReadonlyArray<{ name: string; match: RegExpExecArray }>): CommitRow[] {
    const rows = this.db.prepare("SELECT * FROM commits WHERE stream_id = ? ORDER BY seq_from").all(streamId) as CommitRow[];
    if (rows.length === 0 || rows.length > files.length) return [];
    let next = 1;
    for (const [index, row] of rows.entries()) {
      const file = files[index]!;
      if (row.file_name !== file.name || row.seq_from !== next || row.seq_to < row.seq_from
        || Number(file.match[1]) !== row.seq_from || Number(file.match[2]) !== row.seq_to) return [];
      next = row.seq_to + 1;
    }
    const last = rows.at(-1)!;
    const stream = this.stream(streamId);
    if (stream.head !== last.seq_to || stream.head_hash !== last.commit_hash) return [];
    const doc = this.readCommit(streamId, last.file_name);
    if (doc.commitHash !== last.commit_hash || doc.dispatchId !== last.dispatch_id
      || doc.seqFrom !== last.seq_from || doc.seqTo !== last.seq_to) return [];
    return rows;
  }

  private scanManifests(): StreamManifest[] {
    const root = path.join(this.stateDir, "streams");
    const manifests: StreamManifest[] = [];
    for (const prefix of safeReadDir(root)) {
      const prefixDir = path.join(root, prefix);
      if (!statSync(prefixDir).isDirectory()) continue;
      for (const streamId of safeReadDir(prefixDir)) {
        if (!STREAM_ID.test(streamId)) continue;
        const file = path.join(prefixDir, streamId, "stream.json");
        if (!existsSync(file)) continue;
        const parsed = JSON.parse(readFileSync(file, "utf8")) as StreamManifest;
        if (
          parsed.format !== 1
          || parsed.streamId !== streamId
          || typeof parsed.app !== "string"
          || typeof parsed.scope?.kind !== "string"
          || typeof parsed.scope?.key !== "string"
        ) {
          throw new AppStateError(`invalid stream manifest: ${file}`, "state_corrupt");
        }
        manifests.push(parsed);
      }
    }
    return manifests.sort((a, b) => a.streamId.localeCompare(b.streamId));
  }

  /** `indexedHash`: the hash the index recorded once this file's chain link was verified. */
  private readCommit(streamId: string, fileName: string, indexedHash?: string): CommitDocument {
    const file = path.join(this.streamDir(streamId), "commits", fileName);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CommitDocument;
    if (parsed.format !== 1 || parsed.streamId !== streamId || !Array.isArray(parsed.events)) {
      throw new AppStateError(`invalid commit envelope: ${fileName}`, "state_corrupt");
    }
    const { commitHash, ...base } = parsed;
    if (!DIGEST.test(commitHash) || sha256(canonicalJson(base as unknown as JsonValue)) !== commitHash) {
      throw new AppStateError(`commit hash mismatch: ${fileName}`, "state_corrupt");
    }
    if (indexedHash !== undefined && commitHash !== indexedHash) {
      throw new AppStateError(`commit no longer matches its index: ${fileName}`, "state_corrupt");
    }
    if (!parsed.events.every((event) => validateStoredEvent(event))) {
      throw new AppStateError(`invalid event in commit: ${fileName}`, "state_corrupt");
    }
    return parsed;
  }

  private stream(streamId: string): StreamRow {
    if (!STREAM_ID.test(streamId)) throw new AppStateError("invalid stream id", "invalid");
    const row = this.db.prepare("SELECT * FROM streams WHERE stream_id = ?").get(streamId) as StreamRow | undefined;
    if (!row) throw new AppStateError("stream not found", "not_found");
    return row;
  }

  private streamDir(streamId: string): string {
    if (!STREAM_ID.test(streamId)) throw new AppStateError("invalid stream id", "invalid");
    return path.join(this.stateDir, "streams", streamId.slice(3, 5), streamId);
  }

  private rollback(): void {
    try {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new AppStateError("state service is closed", "state_unavailable");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function validateCommitRequest(request: CommitRequest): void {
  if (!STREAM_ID.test(request.streamId)) throw new AppStateError("invalid stream id", "invalid");
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
    throw new AppStateError("invalid expected revision", "invalid");
  }
  bounded(request.dispatchId, 160, "dispatch id");
  bounded(request.actor, 160, "actor");
  bounded(request.action, 128, "action");
  bounded(request.paramsHash, 128, "params hash");
  bounded(request.backendCodeDigest, 128, "backend digest");
  bounded(request.contractDigest, 128, "contract digest");
  if (!Array.isArray(request.events) || request.events.length === 0 || request.events.length > MAX_EVENTS) {
    throw new AppStateError("a commit needs 1-256 events", "invalid");
  }
  for (const event of request.events) {
    if (!validateEventInput(event)) throw new AppStateError("invalid event", "invalid");
    if (Buffer.byteLength(canonicalJson(event as unknown as JsonValue), "utf8") > MAX_EVENT_BYTES) {
      throw new AppStateError("event is too large", "invalid");
    }
  }
}

function validateEventInput(event: EventInput): boolean {
  return Boolean(
    event
    && typeof event.type === "string"
    && event.type.length > 0
    && event.type.length <= 128
    && typeof event.at === "string"
    && event.at.length <= 64
    && typeof event.by === "string"
    && event.by.length <= 160
    && isJsonValue(event.data),
  );
}

function validateStoredEvent(event: StoredEvent): boolean {
  return validateEventInput(event) && Number.isSafeInteger(event.seq) && event.seq > 0;
}

function bounded(value: unknown, max: number, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) throw new AppStateError(`invalid ${label}`, "invalid");
  return text;
}

function stateError(error: unknown, fallback = "state_error"): AppStateError {
  if (error instanceof AppStateError) return error;
  const row = error as { message?: unknown; code?: unknown };
  return new AppStateError(String(row?.message ?? error), typeof row?.code === "string" ? row.code : fallback);
}

function pad(value: number): string {
  return String(value).padStart(12, "0");
}

function writeAndSync(file: string, body: string | Buffer): void {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function secureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `mode` is ignored for an existing directory. Re-assert it so restoring a
  // backup with a permissive mode cannot quietly publish account scope keys.
  chmodSync(dir, 0o700);
}

function writeAtomic(file: string, body: string | Buffer): void {
  secureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), `.tmp-${randomBytes(12).toString("hex")}`);
  writeAndSync(temp, body);
  renameSync(temp, file);
  syncDir(path.dirname(file));
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
