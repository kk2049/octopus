import { selectSessionWindow } from "@claude-bot/agent-sessions-contract";
import { subagentParentId } from "@claude-bot/plugin-sessions/scan";
import Database from "better-sqlite3";
import {
  compareTranscriptVersions,
  type TranscriptVersion,
} from "@claude-bot/agent-sessions-contract";
import {
  RUNNER_SESSION_PROJECTION_SCHEMA,
  SESSION_PROJECTION_TRANSCRIPT_MAX_BYTES,
  type RunnerSessionProjection,
  type SessionProjectionRow,
  type SessionProjectionSource,
  sessionTranscriptProjectionFromResult,
} from "@claude-bot/runner/session-projection";
import type { RunnerSessionProjectionTransport } from "./gateway.js";
import { runnerHasSessionRoster } from "./providers.js";

const ROSTER_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;
// A watch is delivery demand, not evidence that a source is still unchanged.
// Missed pushes must let the existing fallback reach the device again.
const TRANSCRIPT_MAX_AGE_MS = 5_000;
// Poll-only consumers (notably ticket SSE) have no push watch to refresh a cached first frame.
const POLLED_TRANSCRIPT_MAX_AGE_MS = 2_000;
const TRANSCRIPT_CACHE_MAX_ENTRIES = 32;
const TRANSCRIPT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const TRANSCRIPT_WATCH_MAX = 32;
const DURABLE_DEVICE_MAX = 50;
const RETIRED_EPOCHS_PER_DEVICE_MAX = 8;

export interface ProjectionReadResult {
  hit: boolean;
  result?: unknown;
}

export interface RunnerProjectionReadCache {
  readRosterDevice?(owner: string, device: string, args: Readonly<Record<string, unknown>>): ProjectionReadResult;
  read(owner: string, operation: string, args: Readonly<Record<string, unknown>>): ProjectionReadResult;
  remember(owner: string, operation: string, args: Readonly<Record<string, unknown>>, result: unknown): void;
}

interface DeviceVersion {
  epoch: string;
  sequence: number;
}

interface RosterSnapshot extends DeviceVersion {
  owner: string;
  device: string;
  observedAt: string;
  cachedAt: number;
  totalFound: number;
  primaryWindow: boolean;
  indexPending: boolean;
  sessions: SessionProjectionRow[];
}

interface TranscriptEntry {
  owner: string;
  device: string;
  source: SessionProjectionSource;
  sessionId: string;
  cachedAt: number;
  bytes: number;
  transcript: Record<string, unknown>;
  /** Absent only for a direct RPC fallback that predates a materialized frame. */
  version?: TranscriptVersion;
}

interface TranscriptWatch {
  source: SessionProjectionSource;
  sessionId: string;
  maxMessages: number;
  listeners: Set<() => void>;
}

interface SnapshotRow {
  owner: string;
  device: string;
  epoch: string;
  sequence: number;
  observed_at: string;
  total_found: number;
  updated_at: number;
  primary_window: number;
  index_pending: number;
}

interface SessionRow {
  data_json: string;
}

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS session_projection_devices (
    owner TEXT NOT NULL,
    device TEXT NOT NULL,
    epoch TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    observed_at TEXT NOT NULL,
    total_found INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, device)
  );
  CREATE TABLE IF NOT EXISTS session_projection_rows (
    owner TEXT NOT NULL,
    device TEXT NOT NULL,
    source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (owner, device, source, session_id),
    FOREIGN KEY (owner, device) REFERENCES session_projection_devices(owner, device) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS session_projection_rows_device
    ON session_projection_rows(owner, device);
`;

/**
 * Trusted Bot-side projection under the Runner Gate. It stores no authority:
 * every caller still reaches this only from the post-policy Object adapter.
 */
export class RunnerSessionProjectionService implements RunnerProjectionReadCache {
  private readonly db: Database.Database;
  private readonly versions = new Map<string, DeviceVersion>();
  private readonly rosters = new Map<string, RosterSnapshot>();
  private readonly dirtyDevices = new Set<string>();
  /** Prevent a delayed frame from a replaced Runner process reviving its epoch. */
  private readonly retiredEpochs = new Map<string, string[]>();
  private readonly transcripts = new Map<string, TranscriptEntry>();
  private transcriptBytes = 0;
  private readonly watches = new Map<string, TranscriptWatch>();
  private readonly detach: Array<() => void>;
  private readonly persistRosterTransaction: (snapshot: RosterSnapshot) => void;

  constructor(
    dbPath: string,
    private readonly transport: RunnerSessionProjectionTransport,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    const columns = this.db.pragma("table_info(session_projection_devices)") as Array<{ name: string }>;
    for (const name of ["primary_window", "index_pending"]) {
      if (!columns.some((column) => column.name === name)) this.db.exec("ALTER TABLE session_projection_devices ADD COLUMN " + name + " INTEGER NOT NULL DEFAULT 0");
    }
    this.persistRosterTransaction = this.db.transaction((snapshot: RosterSnapshot) => {
      this.db.prepare(`
        INSERT INTO session_projection_devices(owner, device, epoch, sequence, observed_at, total_found, updated_at, primary_window, index_pending)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner, device) DO UPDATE SET
          epoch = excluded.epoch,
          sequence = excluded.sequence,
          observed_at = excluded.observed_at,
          total_found = excluded.total_found,
          updated_at = excluded.updated_at,
          primary_window = excluded.primary_window,
          index_pending = excluded.index_pending
      `).run(
        snapshot.owner,
        snapshot.device,
        snapshot.epoch,
        snapshot.sequence,
        snapshot.observedAt,
        snapshot.totalFound,
        snapshot.cachedAt,
        Number(snapshot.primaryWindow),
        Number(snapshot.indexPending),
      );
      const existing = this.db.prepare(`
        SELECT source, session_id FROM session_projection_rows WHERE owner = ? AND device = ?
      `).all(snapshot.owner, snapshot.device) as Array<{ source: string; session_id: string }>;
      const retained = new Set<string>();
      const upsert = this.db.prepare(`
        INSERT INTO session_projection_rows(owner, device, source, session_id, data_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(owner, device, source, session_id) DO UPDATE SET data_json = excluded.data_json
        WHERE data_json <> excluded.data_json
      `);
      for (const session of snapshot.sessions) {
        retained.add(rosterSessionKey(session.source, session.id));
        upsert.run(snapshot.owner, snapshot.device, session.source, session.id, JSON.stringify(session));
      }
      const remove = this.db.prepare(`
        DELETE FROM session_projection_rows WHERE owner = ? AND device = ? AND source = ? AND session_id = ?
      `);
      for (const row of existing) {
        if (!retained.has(rosterSessionKey(row.source, row.session_id))) {
          remove.run(snapshot.owner, snapshot.device, row.source, row.session_id);
        }
      }
      this.db.prepare(`
        DELETE FROM session_projection_devices
        WHERE (owner, device) IN (
          SELECT owner, device FROM session_projection_devices ORDER BY updated_at DESC LIMIT -1 OFFSET ?
        )
      `).run(DURABLE_DEVICE_MAX);
    });
    this.detach = [
      transport.subscribe((owner, device, projection) => this.ingest(owner, device, projection)),
      transport.subscribeInvalidations((owner, device) => this.invalidate(owner, device)),
      transport.subscribePresence((owner, device, online) => {
        if (online) this.resubscribeDevice(owner, device);
      }),
    ];
  }

  close(): void {
    for (const detach of this.detach.splice(0)) detach();
    for (const [key, watch] of this.watches) {
      const coordinates = transcriptCoordinates(key);
      if (coordinates) this.sendUnsubscribe(coordinates.owner, coordinates.device, watch);
    }
    this.watches.clear();
    this.transcripts.clear();
    this.retiredEpochs.clear();
    this.transcriptBytes = 0;
    this.db.close();
  }

  read(owner: string, operation: string, args: Readonly<Record<string, unknown>>): ProjectionReadResult {
    if (operation === "list_recent_sessions") return this.readRoster(owner, args);
    if (operation === "read_session") return this.readTranscript(owner, args);
    return { hit: false };
  }

  /** A fanout miss on another device must not discard this source's fresh window. */
  readRosterDevice(owner: string, device: string, args: Readonly<Record<string, unknown>>): ProjectionReadResult {
    return this.readRoster(owner, args, device);
  }

  remember(owner: string, operation: string, args: Readonly<Record<string, unknown>>, result: unknown): void {
    if (operation !== "read_session" || args.rich !== true || args.block !== undefined || args.before !== undefined) return;
    // An explicit offset is a request-specific history page, not a new live
    // tail. Putting it in the shared cache lets the watcher later publish page
    // zero as though it were the newest boundary.
    if (args.offset !== undefined) return;
    const device = boundedCoordinate(args.device, 128);
    const source = projectionSource(args.source);
    const sessionId = boundedCoordinate(args.id, 512);
    if (!device || !source || !sessionId) return;
    const projection = sessionTranscriptProjectionFromResult(result, source, sessionId, "rpcfallback", 1);
    if (projection) this.putTranscript(owner, device, projection.source, projection.session_id, projection.transcript);
  }

  watchTranscript(
    owner: string,
    device: string,
    source: SessionProjectionSource,
    sessionId: string,
    maxMessages: number,
    listener: () => void,
  ): (() => void) | null {
    const key = transcriptCacheKey(owner, device, source, sessionId);
    let watch = this.watches.get(key);
    if (!watch) {
      if (this.watches.size >= TRANSCRIPT_WATCH_MAX) return null;
      watch = { source, sessionId, maxMessages, listeners: new Set() };
      this.watches.set(key, watch);
      this.sendSubscribe(owner, device, watch);
    } else if (maxMessages > watch.maxMessages) {
      watch.maxMessages = maxMessages;
      this.sendSubscribe(owner, device, watch);
    }
    watch.listeners.add(listener);
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      const current = this.watches.get(key);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;
      this.watches.delete(key);
      this.sendUnsubscribe(owner, device, current);
    };
  }

  /** Credential target-set changes revoke cached material before the token mutates. */
  purgeDevice(owner: string, device: string): void {
    const key = deviceKey(owner, device);
    this.versions.delete(key);
    this.rosters.delete(key);
    this.dirtyDevices.delete(key);
    this.retiredEpochs.delete(key);
    this.db.prepare("DELETE FROM session_projection_devices WHERE owner = ? AND device = ?").run(owner, device);
    for (const [cacheKey, entry] of this.transcripts) {
      if (entry.owner === owner && entry.device === device) this.deleteTranscript(cacheKey, entry);
    }
    for (const [watchKey, watch] of this.watches) {
      const coordinates = transcriptCoordinates(watchKey);
      if (!coordinates || coordinates.owner !== owner || coordinates.device !== device) continue;
      this.watches.delete(watchKey);
      this.sendUnsubscribe(owner, device, watch);
    }
  }

  private ingest(owner: string, device: string, projection: RunnerSessionProjection): boolean {
    const key = deviceKey(owner, device);
    const previous = this.versions.get(key) ?? this.loadVersion(owner, device);
    if (previous && previous.epoch === projection.epoch && projection.sequence <= previous.sequence) return false;
    if (previous && previous.epoch !== projection.epoch) {
      const retired = this.retiredEpochs.get(key) ?? [];
      if (retired.includes(projection.epoch)) return false;
      this.retiredEpochs.set(key, [...retired, previous.epoch].slice(-RETIRED_EPOCHS_PER_DEVICE_MAX));
      this.clearTranscriptsForDevice(owner, device);
    }
    this.versions.set(key, { epoch: projection.epoch, sequence: projection.sequence });
    if (projection.kind === "roster_full") {
      const snapshot: RosterSnapshot = {
        owner,
        device,
        epoch: projection.epoch,
        sequence: projection.sequence,
        observedAt: projection.observed_at,
        cachedAt: this.now(),
        totalFound: projection.total_found,
        primaryWindow: projection.primary_window === true,
        indexPending: projection.index_pending === true,
        sessions: projection.sessions,
      };
      this.persistRosterTransaction(snapshot);
      this.rosters.set(key, snapshot);
      this.dirtyDevices.delete(key);
      return true;
    }
    if (projection.kind === "transcript_checked") {
      const entry = this.transcripts.get(transcriptCacheKey(owner, device, projection.source, projection.session_id));
      if (!entry?.version || entry.version.epoch !== projection.epoch || entry.version.sequence !== projection.content_sequence) return false;
      entry.cachedAt = this.now();
      return true;
    }
    const changed = this.putTranscript(
      owner,
      device,
      projection.source,
      projection.session_id,
      projection.transcript,
      { epoch: projection.epoch, sequence: projection.sequence },
    );
    const watch = this.watches.get(transcriptCacheKey(owner, device, projection.source, projection.session_id));
    if (watch && changed) {
      for (const listener of [...watch.listeners]) listener();
    }
    return changed;
  }

  private invalidate(owner: string, device: string): void {
    this.dirtyDevices.add(deviceKey(owner, device));
  }

  private readRoster(owner: string, args: Readonly<Record<string, unknown>>, onlyDevice?: string): ProjectionReadResult {
    // A materialized recent window cannot answer a page of the complete catalog,
    // nor an exact selector: its whole point is chats that left that window.
    if (args.cursor !== undefined || args.device !== undefined || args.ids !== undefined) return { hit: false };
    const devices = this.transport.listDevices(owner).filter((device) => device.online
      && (onlyDevice === undefined || device.device === onlyDevice));
    if (devices.length === 0) return { hit: false };
    const snapshots: RosterSnapshot[] = [];
    for (const device of devices.filter((device) => runnerHasSessionRoster(device.inventory))) {
      const key = deviceKey(owner, device.device);
      if (this.dirtyDevices.has(key)) return { hit: false };
      const snapshot = this.rosters.get(key) ?? this.loadRoster(owner, device.device);
      if (!snapshot || this.now() - snapshot.cachedAt > ROSTER_SNAPSHOT_MAX_AGE_MS) return { hit: false };
      const version = this.versions.get(key);
      if (version && version.epoch !== snapshot.epoch) return { hit: false };
      this.rosters.set(key, snapshot);
      if (args.primary_window === true && !snapshot.primaryWindow) return { hit: false };
      snapshots.push(snapshot);
    }

    const requestedSource = args.source === "claude" || args.source === "codex" || args.source === "omp"
      ? args.source
      : "all";
    const sinceHours = finiteNonNegative(args.since_hours);
    const cutoff = sinceHours === null ? null : this.now() - sinceHours * 3_600_000;
    const sessions = snapshots.flatMap((snapshot) => snapshot.sessions
      .filter((session) => requestedSource === "all" || session.source === requestedSource)
      .filter((session) => cutoff === null || timestamp(session.last_activity) >= cutoff)
      .map((session) => ({ ...session, device: snapshot.device })));
    sessions.sort((left, right) =>
      String(right.sort_activity ?? right.last_activity ?? right.started_at ?? "")
        .localeCompare(String(left.sort_activity ?? left.last_activity ?? left.started_at ?? "")));
    const limit = integerInRange(args.limit, 1, 500, 20);
    if (args.primary_window === true && requestedSource !== "all"
      && sessions.filter((row) => !subagentParentId({ ...row })).length < Math.min(limit, 200)
      && snapshots.some((snapshot) => snapshot.totalFound > snapshot.sessions.length)) return { hit: false };
    const selected = args.primary_window === true
      ? selectSessionWindow(sessions, limit, (row) => subagentParentId({ ...row })) : sessions.slice(0, limit);
    const exactStoredCount = requestedSource !== "all" || cutoff !== null;
    const totalFound = exactStoredCount
      ? sessions.length
      : snapshots.reduce((total, snapshot) => total + snapshot.totalFound, 0);
    return {
      hit: true,
      result: {
        devices: devices.map((device) => device.device),
        runner_inventory: devices.flatMap((device) => device.inventory
          ? [{ device: device.device, online: true, inventory: device.inventory }]
          : []),
        total_found: totalFound,
        ...(args.primary_window === true ? { primary_window: true, index_pending: snapshots.some((snapshot) => snapshot.indexPending) } : {}),
        returned: selected.length,
        sessions: selected,
        note: totalFound === 0 ? "No Claude/Codex/omp sessions found on any online device." : undefined,
      },
    };
  }

  private readTranscript(owner: string, args: Readonly<Record<string, unknown>>): ProjectionReadResult {
    // A block read and a `before` window are not slices of a cached tail window.
    if (args.rich !== true || args.block !== undefined || args.before !== undefined) return { hit: false };
    const device = boundedCoordinate(args.device, 128);
    const source = projectionSource(args.source);
    const sessionId = boundedCoordinate(args.id, 512);
    if (!device || !source || !sessionId) return { hit: false };
    const key = transcriptCacheKey(owner, device, source, sessionId);
    const entry = this.transcripts.get(key);
    const maxAge = entry?.version && this.watches.has(key) ? TRANSCRIPT_MAX_AGE_MS : POLLED_TRANSCRIPT_MAX_AGE_MS;
    if (!entry || this.now() - entry.cachedAt > maxAge) {
      if (entry) this.deleteTranscript(key, entry);
      return { hit: false };
    }
    const messages = Array.isArray(entry.transcript.messages) ? entry.transcript.messages : [];
    const cachedOffset = finiteInteger(entry.transcript.offset) ?? 0;
    const total = finiteInteger(entry.transcript.total_messages) ?? cachedOffset + messages.length;
    const maxMessages = integerInRange(args.max_messages, 1, 500, 40);
    const requestedOffset = args.offset === undefined ? null : finiteInteger(args.offset);
    let start: number;
    if (requestedOffset === null) {
      start = Math.max(0, messages.length - maxMessages);
    } else {
      if (requestedOffset < cachedOffset || requestedOffset > cachedOffset + messages.length) return { hit: false };
      start = requestedOffset - cachedOffset;
      if (start + Math.min(maxMessages, total - requestedOffset) > messages.length) return { hit: false };
    }
    const selected = messages.slice(start, start + maxMessages);
    this.transcripts.delete(key);
    this.transcripts.set(key, entry);
    return {
      hit: true,
      result: {
        ...entry.transcript,
        ...(entry.version ? { projection_version: entry.version } : {}),
        offset: cachedOffset + start,
        total_messages: total,
        returned_messages: selected.length,
        messages: selected,
      },
    };
  }

  private putTranscript(
    owner: string,
    device: string,
    source: SessionProjectionSource,
    sessionId: string,
    transcript: Record<string, unknown>,
    version?: TranscriptVersion,
  ): boolean {
    const key = transcriptCacheKey(owner, device, source, sessionId);
    const previous = this.transcripts.get(key);
    if (previous) {
      const relation = compareTranscriptVersions(previous.version, version);
      // A materialized Runner frame is stronger evidence than an unversioned
      // RPC fallback. Within one epoch, an older/equal snapshot is a duplicate
      // or a delayed response and may not replace the cache entry.
      if (relation === "older" || relation === "same") return false;
      if (
        relation === "newer"
        && previous.version?.epoch === version?.epoch
        && transcriptObviouslyRegresses(previous.transcript, transcript)
      ) return false;
      if (relation === "unknown" && transcriptObviouslyRegresses(previous.transcript, transcript)) return false;
    }
    const serialized = JSON.stringify(transcript);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > SESSION_PROJECTION_TRANSCRIPT_MAX_BYTES) return false;
    if (previous) this.deleteTranscript(key, previous);
    const entry: TranscriptEntry = {
      owner,
      device,
      source,
      sessionId,
      cachedAt: this.now(),
      bytes,
      transcript,
      ...(version ? { version } : {}),
    };
    this.transcripts.set(key, entry);
    this.transcriptBytes += bytes;
    while (this.transcripts.size > TRANSCRIPT_CACHE_MAX_ENTRIES || this.transcriptBytes > TRANSCRIPT_CACHE_MAX_BYTES) {
      const oldest = this.transcripts.entries().next().value as [string, TranscriptEntry] | undefined;
      if (!oldest) break;
      this.deleteTranscript(oldest[0], oldest[1]);
    }
    return true;
  }

  private deleteTranscript(key: string, entry: TranscriptEntry): void {
    if (!this.transcripts.delete(key)) return;
    this.transcriptBytes = Math.max(0, this.transcriptBytes - entry.bytes);
  }

  private clearTranscriptsForDevice(owner: string, device: string): void {
    for (const [key, entry] of this.transcripts) {
      if (entry.owner === owner && entry.device === device) this.deleteTranscript(key, entry);
    }
  }

  private loadVersion(owner: string, device: string): DeviceVersion | undefined {
    const row = this.db.prepare(`
      SELECT epoch, sequence FROM session_projection_devices WHERE owner = ? AND device = ?
    `).get(owner, device) as { epoch: string; sequence: number } | undefined;
    return row ? { epoch: row.epoch, sequence: row.sequence } : undefined;
  }

  private loadRoster(owner: string, device: string): RosterSnapshot | null {
    const row = this.db.prepare(`
      SELECT owner, device, epoch, sequence, observed_at, total_found, updated_at, primary_window, index_pending
      FROM session_projection_devices WHERE owner = ? AND device = ?
    `).get(owner, device) as SnapshotRow | undefined;
    if (!row) return null;
    const sessions = (this.db.prepare(`
      SELECT data_json FROM session_projection_rows WHERE owner = ? AND device = ?
    `).all(owner, device) as SessionRow[]).flatMap((session) => {
      try {
        return [JSON.parse(session.data_json) as SessionProjectionRow];
      } catch {
        return [];
      }
    });
    return {
      owner: row.owner,
      device: row.device,
      epoch: row.epoch,
      sequence: row.sequence,
      observedAt: row.observed_at,
      cachedAt: row.updated_at,
      totalFound: row.total_found,
      primaryWindow: row.primary_window === 1,
      indexPending: row.index_pending === 1,
      sessions,
    };
  }

  private resubscribeDevice(owner: string, device: string): void {
    for (const [key, watch] of this.watches) {
      const coordinates = transcriptCoordinates(key);
      if (coordinates?.owner === owner && coordinates.device === device) this.sendSubscribe(owner, device, watch);
    }
  }

  private sendSubscribe(owner: string, device: string, watch: TranscriptWatch): void {
    this.transport.send(owner, device, {
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "transcript_subscribe",
      source: watch.source,
      session_id: watch.sessionId,
      max_messages: Math.max(1, Math.min(500, Math.floor(watch.maxMessages))),
    });
  }

  private sendUnsubscribe(owner: string, device: string, watch: TranscriptWatch): void {
    this.transport.send(owner, device, {
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "transcript_unsubscribe",
      source: watch.source,
      session_id: watch.sessionId,
    });
  }
}

function boundedCoordinate(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

function projectionSource(value: unknown): SessionProjectionSource | null {
  return value === "claude" || value === "codex" || value === "omp" ? value : null;
}

function finiteInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** Append-only transcript evidence that makes an unversioned candidate worse. */
function transcriptObviouslyRegresses(
  current: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
): boolean {
  const currentMessages = Array.isArray(current.messages) ? current.messages : [];
  const incomingMessages = Array.isArray(incoming.messages) ? incoming.messages : [];
  const currentOffset = finiteInteger(current.offset) ?? 0;
  const incomingOffset = finiteInteger(incoming.offset) ?? 0;
  const currentEnd = currentOffset + currentMessages.length;
  const incomingEnd = incomingOffset + incomingMessages.length;
  const currentTotal = finiteInteger(current.total_messages ?? current.total) ?? currentEnd;
  const incomingTotal = finiteInteger(incoming.total_messages ?? incoming.total) ?? incomingEnd;
  return incomingTotal < currentTotal || incomingEnd < currentEnd;
}

function finiteNonNegative(value: unknown): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function integerInRange(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function timestamp(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function rosterSessionKey(source: string, sessionId: string): string {
  return `${source}\u0000${sessionId}`;
}

function deviceKey(owner: string, device: string): string {
  return `${owner}\u0000${device}`;
}

function transcriptCacheKey(owner: string, device: string, source: SessionProjectionSource, sessionId: string): string {
  return `${owner}\u0000${device}\u0000${source}\u0000${sessionId}`;
}

function transcriptCoordinates(key: string): { owner: string; device: string } | null {
  const [owner, device] = key.split("\u0000", 2);
  return owner && device ? { owner, device } : null;
}
