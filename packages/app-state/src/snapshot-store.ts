/** Disposable projection cache storage, deliberately outside the commit chain. */

import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import { canonicalJson, isJsonValue } from "./canonical.js";
import type { JsonValue, SnapshotResult } from "./types.js";

const SNAPSHOT_FILE = /^(\d{12})-([0-9a-f]{64})\.json\.gz$/;
export const SNAPSHOT_RETENTION_PER_DIGEST = 3;

interface SnapshotRow {
  stream_id: string;
  projection_digest: string;
  revision: number;
  file_name: string;
}

type AtomicWriter = (file: string, body: string | Buffer) => void;

export class SnapshotStore {
  constructor(
    private readonly db: Database.Database,
    private readonly directory: (streamId: string) => string,
    private readonly writeAtomic: AtomicWriter,
  ) {}

  installSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        stream_id TEXT NOT NULL,
        projection_digest TEXT NOT NULL,
        revision INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        PRIMARY KEY(stream_id, projection_digest, revision),
        UNIQUE(stream_id, file_name),
        FOREIGN KEY(stream_id) REFERENCES streams(stream_id)
      );
      CREATE INDEX IF NOT EXISTS snapshots_latest
        ON snapshots(stream_id, projection_digest, revision DESC);
    `);
  }

  put(streamId: string, revision: number, projectionDigest: string, view: JsonValue): void {
    const body = canonicalJson({ format: 1, streamId, revision, projectionDigest, view } as unknown as JsonValue);
    const dir = this.directory(streamId);
    const fileName = `${String(revision).padStart(12, "0")}-${projectionDigest}.json.gz`;
    this.writeAtomic(path.join(dir, fileName), gzipSync(body));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stream = this.db.prepare("SELECT head FROM streams WHERE stream_id = ?")
        .get(streamId) as { head: number } | undefined;
      if (!stream || revision > stream.head) throw new Error("snapshot revision is outside the stream");
      this.db.prepare(
        `INSERT INTO snapshots(stream_id, projection_digest, revision, file_name)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(stream_id, projection_digest, revision) DO UPDATE SET file_name=excluded.file_name`,
      ).run(streamId, projectionDigest, revision, fileName);
      this.prune(streamId, projectionDigest, dir);
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  get(streamId: string, head: number, projectionDigest: string): SnapshotResult | null {
    const dir = this.directory(streamId);
    const candidates = this.db.prepare(
      `SELECT * FROM snapshots
       WHERE stream_id = ? AND projection_digest = ? AND revision <= ?
       ORDER BY revision DESC`,
    ).all(streamId, projectionDigest, head) as SnapshotRow[];
    for (const candidate of candidates) {
      try {
        if (!rowMatchesFile(candidate)) continue;
        const parsed = JSON.parse(gunzipSync(readFileSync(path.join(dir, candidate.file_name))).toString("utf8")) as Record<string, unknown>;
        if (parsed.format !== 1 || parsed.streamId !== streamId || parsed.projectionDigest !== projectionDigest) continue;
        if (parsed.revision !== candidate.revision || !Number.isSafeInteger(parsed.revision) || !isJsonValue(parsed.view)) continue;
        return { revision: candidate.revision, view: parsed.view };
      } catch {
        // A corrupt cache row is ignored; immutable commits remain truth.
      }
    }
    return null;
  }

  /** Rebuild the disposable index once under AppState's recovery transaction. */
  recover(streamId: string, head: number): void {
    const dir = this.directory(streamId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.db.prepare("DELETE FROM snapshots WHERE stream_id = ?").run(streamId);
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (name.startsWith(".tmp-")) {
        rmSync(file, { force: true });
        continue;
      }
      const match = SNAPSHOT_FILE.exec(name);
      if (!match) continue;
      const revision = Number(match[1]);
      const projectionDigest = match[2]!;
      if (revision > head || !validFile(file, streamId, revision, projectionDigest)) {
        rmSync(file, { force: true });
        continue;
      }
      this.db.prepare(
        "INSERT INTO snapshots(stream_id, projection_digest, revision, file_name) VALUES (?, ?, ?, ?)",
      ).run(streamId, projectionDigest, revision, name);
    }
    const digests = this.db.prepare(
      "SELECT DISTINCT projection_digest FROM snapshots WHERE stream_id = ?",
    ).all(streamId) as Array<{ projection_digest: string }>;
    for (const row of digests) this.prune(streamId, row.projection_digest, dir);
  }

  private prune(streamId: string, projectionDigest: string, dir: string): void {
    const stale = this.db.prepare(
      `SELECT * FROM snapshots WHERE stream_id = ? AND projection_digest = ?
       ORDER BY revision DESC LIMIT -1 OFFSET ?`,
    ).all(streamId, projectionDigest, SNAPSHOT_RETENTION_PER_DIGEST) as SnapshotRow[];
    for (const row of stale) {
      this.db.prepare(
        "DELETE FROM snapshots WHERE stream_id = ? AND projection_digest = ? AND revision = ?",
      ).run(streamId, projectionDigest, row.revision);
      if (rowMatchesFile(row)) rmSync(path.join(dir, row.file_name), { force: true });
    }
  }

  private rollback(): void {
    try {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
    } catch {
      // Preserve the original cache error.
    }
  }
}

function validFile(file: string, streamId: string, revision: number, projectionDigest: string): boolean {
  try {
    const parsed = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as Record<string, unknown>;
    return parsed.format === 1
      && parsed.streamId === streamId
      && parsed.revision === revision
      && parsed.projectionDigest === projectionDigest
      && isJsonValue(parsed.view);
  } catch {
    return false;
  }
}

function rowMatchesFile(row: SnapshotRow): boolean {
  const match = SNAPSHOT_FILE.exec(row.file_name);
  return Boolean(match && Number(match[1]) === row.revision && match[2] === row.projection_digest);
}
