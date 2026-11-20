import fs from "node:fs/promises";
import path from "node:path";
import {
  SESSION_AUTOMATED_WINDOW, SESSION_PRIMARY_WINDOW, SESSION_ROSTER_WINDOW, isAutomatedSession, selectSessionWindow,
} from "@claude-bot/agent-sessions-contract";
import { randomUUID } from "node:crypto";
import { deriveIdFromPath, parseSessionText } from "./parse.js";
import { changedSessionFiles } from "./directory-cache.js";
import type { SessionFile, SessionSummary, SessionRosterPriority } from "./scan.js";

export type SessionEntry = Pick<SessionFile, "source" | "path" | "project" | "account_label">;
export const SESSION_INDEX_BATCH = 200;
export const SESSION_INDEX_HOT_MS = 48 * 60 * 60_000;
export const SESSION_INDEX_SUMMARY_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 64 * 1024;
// Refresh old persisted headers after parser/display semantics change, while
// retaining their previous summaries until the bounded sweep replaces them.
// 4: Claude chats carry their title (custom-title / ai-title).
// 5: Codex `exec` forks are classified by their native originator.
const HEADER_VERSION = "5";
const CACHE_BYTES = 64 * 1024 * 1024;
interface Indexed {
  file: SessionFile;
  version: string;
  header: SessionSummary;
  summary?: SessionSummary;
  summaryVersion?: string;
}
interface IndexStats {
  fileChecks: number;
  headerReads: number;
  summaryReads: number;
}
const order = (row: Indexed): string => row.summary?.sort_activity ?? row.summary?.last_activity
  ?? row.header.last_activity ?? "";
const byActivity = (a: Indexed, b: Indexed): number => order(b).localeCompare(order(a))
  || a.file.path.localeCompare(b.file.path);
const identity = (row: Pick<SessionSummary, "source" | "id">): string => JSON.stringify([row.source, row.id]);
const parent = (row: SessionSummary): string | undefined => row.is_subagent ? row.parent_session_id : undefined;

/**
 * Newest complete root summaries per provider. Automated runs have their own
 * allowance after the interactive one, so a burst of `codex exec` threads can
 * neither take the retained checks nor the durable reserve from chats.
 */
function retainedRoots(rows: readonly Indexed[]): Indexed[] {
  const roots = (["claude", "codex", "omp"] as const).map((source) =>
    rows.filter((row) => row.file.source === source && row.summary && !parent(row.summary)));
  return [
    ...roots.flatMap((list) => list.filter((row) => !isAutomatedSession(row.summary)).slice(0, SESSION_PRIMARY_WINDOW)),
    ...roots.flatMap((list) => list.filter((row) => isAutomatedSession(row.summary)).slice(0, SESSION_AUTOMATED_WINDOW)),
  ];
}

/**
 * A device-owned working set. Directory inventory is separate from expensive
 * file checks; a fair rotating sweep covers missed events and old/backdated logs.
 * Persisted rows are reusable facts, never authority: current discovery must
 * still name every path before a cache row can participate.
 */
export class RecentSessionIndex {
  private readonly rows = new Map<string, Indexed>();
  private readonly pending = new Set<string>();
  private priorityKey = "";
  private loaded = false;
  private sweepAfter = "";
  private summarySweepAfter = "";
  private expires = 0;
  private flight?: Promise<void>;
  private totals = { all: 0, claude: 0, codex: 0, omp: 0 };
  private summaryPending = false;
  private lastPersisted = "";
  private stats: IndexStats = { fileChecks: 0, headerReads: 0, summaryReads: 0 };

  constructor(private readonly options: {
    home: string;
    entries: () => Promise<SessionEntry[]>;
    summarize: (file: SessionFile) => Promise<SessionSummary>;
    parentId: (summary: SessionSummary) => string | null;
    stateFile?: string;
    now?: () => number;
  }) {}

  invalidate(): void { this.expires = 0; }

  async list(args: Record<string, unknown>, priority?: SessionRosterPriority): Promise<unknown> {
    // Observe the full trusted inventory before the bounded cold header sweep.
    // Runtime evidence stays request-local and is never persisted in the index.
    const inventory = priority ? await this.options.entries() : undefined;
    const candidates = inventory?.map((entry) => ({ ...entry,
      id: this.rows.get(entry.path)?.header.id ?? deriveIdFromPath(entry.source, entry.path) })) ?? [];
    const preferred = priority ? await priority(candidates) : new Set<string>();
    const priorityKey = JSON.stringify([...preferred].sort());
    while ((this.options.now?.() ?? Date.now()) >= this.expires || priorityKey !== this.priorityKey) {
      this.flight ??= this.refresh(preferred, inventory).then(() => { this.priorityKey = priorityKey; })
        .finally(() => { this.flight = undefined; });
      await this.flight;
    }
    const source = args.source === "claude" || args.source === "codex" || args.source === "omp" ? args.source : "all";
    const since = Number(args.since_hours);
    const cutoff = args.since_hours != null && Number.isFinite(since)
      ? (this.options.now?.() ?? Date.now()) - since * 3_600_000 : -Infinity;
    const unique = new Map<string, Indexed>();
    for (const row of [...this.rows.values()].sort((a, b) => b.file.mtimeMs - a.file.mtimeMs)) {
      const summary = row.summary ?? row.header;
      if ((source !== "all" && row.file.source !== source) || row.file.mtimeMs < cutoff) continue;
      if (!unique.has(identity(summary))) unique.set(identity(summary), row);
    }
    const sorted = [...unique.values()].sort(byActivity).map((row) => row.summary ?? row.header);
    const sessions = selectSessionWindow(sorted, Number(args.limit ?? SESSION_PRIMARY_WINDOW), parent,
      (row) => preferred.has(identity(row)));
    return { home: this.options.home, source, total_found: this.totals[source], returned: sessions.length, sessions,
      primary_window: true, index_pending: this.pending.size > 0 || this.summaryPending,
      index_stats: { ...this.stats, pending: this.pending.size, indexed: this.rows.size } };
  }

  private async refresh(preferred: ReadonlySet<string>, inventory?: SessionEntry[]): Promise<void> {
    const entries = inventory ?? await this.options.entries();
    const available = new Map(entries.map((entry) => [entry.path, entry]));
    const paths = [...available.keys()].sort();
    const allowed = new Set(paths);
    const ids = { claude: new Set<string>(), codex: new Set<string>(), omp: new Set<string>() };
    for (const entry of entries) ids[entry.source].add(deriveIdFromPath(entry.source, entry.path));
    this.totals = { all: ids.claude.size + ids.codex.size + ids.omp.size,
      claude: ids.claude.size, codex: ids.codex.size, omp: ids.omp.size };
    const stateFile = this.options.stateFile ?? path.join(this.options.home, ".octopus", "session-roster-cache-v1.json");
    if (!this.loaded) {
      await this.restore(stateFile, available);
      this.loaded = true;
    }
    for (const file of this.rows.keys()) if (!allowed.has(file)) this.rows.delete(file);
    for (const file of this.pending) if (!allowed.has(file)) this.pending.delete(file);
    // FIFO survives each refresh: a flood of new names cannot starve old backfill.
    for (const file of [...paths].reverse()) if (!this.rows.has(file)) this.pending.add(file);
    this.stats = { fileChecks: 0, headerReads: 0, summaryReads: 0 };
    const sorted = uniqueRows(this.rows.values()).sort(byActivity);
    const retained = retainedRoots(sorted);
    const foreground = entries.filter((entry) => preferred.has(identity({ source: entry.source,
      id: this.rows.get(entry.path)?.header.id ?? deriveIdFromPath(entry.source, entry.path) })))
      .slice(0, SESSION_ROSTER_WINDOW).map((entry) => entry.path);
    const now = this.options.now?.() ?? Date.now();
    const hot = sorted.filter((row) => row.file.mtimeMs >= now - SESSION_INDEX_HOT_MS)
      .sort((a, b) => b.file.mtimeMs - a.file.mtimeMs).slice(0, SESSION_INDEX_BATCH);
    let start = paths.findIndex((file) => file > this.sweepAfter);
    if (start < 0) start = 0;
    const sweep = [...paths.slice(start), ...paths.slice(0, start)].slice(0, SESSION_INDEX_BATCH);
    this.sweepAfter = sweep.at(-1) ?? "";
    const checks = new Set([
      // Spend the existing retained-file budget on foreground proof first;
      // keep event/new/hot/fair-sweep budgets intact (at most 1,400 checks).
      ...foreground,
      ...retained.filter((row) => !foreground.includes(row.file.path))
        .slice(0, SESSION_PRIMARY_WINDOW * 3 - foreground.length).map((row) => row.file.path),
      ...changedSessionFiles(allowed, SESSION_INDEX_BATCH),
      ...[...this.pending].slice(0, SESSION_INDEX_BATCH),
      ...hot.map((row) => row.file.path),
      ...sweep,
    ]);
    // At most 200 * (three retained providers + event/new/hot/sweep budgets).
    await mapBatches([...checks], async (file) => {
      const entry = available.get(file);
      if (entry) await this.observe(entry);
    });
    // Summarize only effective candidates; child headers need no whole-file parse.
    // New/changed candidates get a separate budget from retained stable chats.
    const candidates = uniqueRows(this.rows.values()).filter((row) => !parent(row.header));
    const dirty = candidates.filter((row) => row.summaryVersion !== row.version);
    const ordered = [...dirty].sort((a, b) => a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0);
    let summaryStart = ordered.findIndex((row) => row.file.path > this.summarySweepAfter);
    if (summaryStart < 0) summaryStart = 0;
    const changed: Indexed[] = [];
    let bytes = 0;
    for (const row of [...ordered.slice(summaryStart), ...ordered.slice(0, summaryStart)].slice(0, SESSION_INDEX_BATCH / 2)) {
      // A single oversized log must still make progress; never repeatedly skip it.
      if (changed.length && bytes + row.file.size > SESSION_INDEX_SUMMARY_BYTES / 2) break;
      changed.push(row);
      bytes += row.file.size;
      this.summarySweepAfter = row.file.path;
    }
    for (const row of dirty.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs)) {
      if (changed.includes(row) || bytes + row.file.size > SESSION_INDEX_SUMMARY_BYTES) continue;
      if (changed.length >= SESSION_INDEX_BATCH) break;
      changed.push(row);
      bytes += row.file.size;
    }
    await mapBatches(changed, async (row) => {
      this.stats.summaryReads += 1;
      try {
        const summary = await this.options.summarize(row.file);
        const parentId = this.options.parentId(summary);
        row.header = { ...row.header, id: summary.id,
          ...(parentId ? { is_subagent: true, parent_session_id: parentId } : {}) };
        row.summary = summary;
        row.summaryVersion = row.version;
      } catch { /* Preserve an existing retained fact on transient IO failure. */ }
    }, 2);
    this.summaryPending = candidates.some((row) => !parent(row.header) && row.summaryVersion !== row.version);
    // Reserve complete summaries for each provider filter; persist compact
    // fingerprints for the remaining files too. There is no age-based eviction.
    const reserve = retainedRoots(uniqueRows(this.rows.values()).sort(byActivity));
    await this.persist(stateFile, reserve);
    this.expires = (this.options.now?.() ?? Date.now()) + (this.pending.size || this.summaryPending ? 1_000 : 3_000);
  }

  private async observe(entry: SessionEntry): Promise<void> {
    this.stats.fileChecks += 1;
    try {
      const st = await fs.lstat(entry.path);
      if (!st.isFile()) { this.rows.delete(entry.path); this.pending.delete(entry.path); return; }
      const version = [HEADER_VERSION, st.dev, st.ino, st.ctimeMs, st.mtimeMs, st.size].join(":");
      const previous = this.rows.get(entry.path);
      if (previous?.version === version) { this.pending.delete(entry.path); return; }
      const file: SessionFile = { ...entry, mtimeMs: st.mtimeMs, size: st.size };
      this.stats.headerReads += 1;
      const handle = await fs.open(entry.path, "r");
      let text: string;
      let complete: boolean;
      try {
        const buffer = Buffer.alloc(HEADER_BYTES);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        complete = read.bytesRead === st.size;
        text = buffer.subarray(0, read.bytesRead).toString("utf8");
        if (st.size > read.bytesRead) text = text.slice(0, text.lastIndexOf("\n") + 1);
      } finally { await handle.close(); }
      const meta = parseSessionText(entry.source, text).meta;
      const id = meta.id ?? deriveIdFromPath(entry.source, entry.path);
      const partial: SessionSummary = { ...file, id, source: entry.source, cwd: meta.cwd, title: meta.title,
        started_at: meta.started_at, last_activity: new Date(st.mtimeMs).toISOString(),
        ...(complete ? { message_count: meta.message_count } : {}),
        first_user_text: meta.first_user_text?.slice(0, 2_000), preview: meta.first_user_text?.slice(0, 2_000),
        ...(meta.execution_mode === "exec" ? { execution_mode: "exec" } : {}),
        ...(meta.is_subagent ? { is_subagent: true, parent_session_id: meta.parent_session_id, input_mode: meta.input_mode } : {}) };
      const parentId = this.options.parentId(partial);
      if (!parentId) { delete partial.is_subagent; delete partial.parent_session_id; delete partial.input_mode; }
      this.rows.set(entry.path, { file, version, header: partial,
        ...(!parentId && previous?.summary?.id === id
          ? { summary: withExecutionMode(previous.summary, partial), summaryVersion: previous.summaryVersion } : {}) });
      this.pending.delete(entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.rows.delete(entry.path);
      // Permission/transient errors retain the last known chat and stay retryable.
    }
  }

  private async restore(file: string, available: ReadonlyMap<string, SessionEntry>): Promise<void> {
    try {
      if ((await fs.stat(file)).size > CACHE_BYTES) return;
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as { version?: unknown; rows?: unknown };
      if (stored?.version !== 1 || !Array.isArray(stored.rows) || stored.rows.length > 100_000) return;
      for (const value of stored.rows) {
        if (!value || typeof value !== "object") continue;
        const row = value as Indexed;
        const entry = available.get(row.file?.path);
        if (!entry || row.file.source !== entry.source || !Number.isFinite(row.file.mtimeMs)
          || !Number.isFinite(row.file.size) || typeof row.version !== "string"
          || !row.header || row.header.path !== entry.path || row.header.source !== entry.source
          || typeof row.header.id !== "string" || typeof row.header.last_activity !== "string"
          || (row.summary && (row.summary.path !== entry.path || row.summary.source !== entry.source
            || row.summary.id !== row.header.id || typeof row.summary.last_activity !== "string"))) continue;
        this.rows.set(entry.path, { ...row, file: { ...row.file, ...entry },
          header: { ...row.header, account_label: entry.account_label },
          ...(row.summary ? { summary: { ...row.summary, account_label: entry.account_label } } : {}) });
      }
    } catch { /* Cold/corrupt caches reconstruct from the current directory inventory. */ }
  }

  private async persist(file: string, rows: Indexed[]): Promise<void> {
    const reserve = new Set(rows.map((row) => row.file.path));
    const indexed = [...rows, ...[...this.rows.values()].filter((row) => !reserve.has(row.file.path))].slice(0, 100_000).map((row) => reserve.has(row.file.path) ? row : {
      ...row, header: compact(row.header), ...(row.summary ? { summary: compact(row.summary) } : {}),
    });
    let data = JSON.stringify({ version: 1, rows: indexed });
    if (Buffer.byteLength(data) > CACHE_BYTES) data = JSON.stringify({ version: 1, rows });
    if (data === this.lastPersisted || Buffer.byteLength(data) > CACHE_BYTES) return;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = file + "." + randomUUID() + ".tmp";
      await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file);
      this.lastPersisted = data;
    } catch { /* Storage failure does not erase a usable in-memory working set. */ }
  }
}

/**
 * Execution mode comes from the first record only, so a fresh header is
 * authoritative for it: correct a retained summary now rather than after its
 * bounded whole-file re-read.
 */
function withExecutionMode(summary: SessionSummary, header: SessionSummary): SessionSummary {
  const { execution_mode: _previous, ...rest } = summary;
  return header.execution_mode === "exec" ? { ...rest, execution_mode: "exec" } : rest;
}

/** Persist seen identities/fingerprints too, so restarting does not reread old logs. */
function compact(row: SessionSummary): SessionSummary {
  return { ...row, first_user_text: row.first_user_text?.slice(0, 200), preview: row.preview?.slice(0, 200) };
}

function uniqueRows(rows: Iterable<Indexed>): Indexed[] {
  const unique = new Map<string, Indexed>();
  for (const row of rows) {
    const key = identity(row.summary ?? row.header);
    if (!unique.has(key) || unique.get(key)!.file.mtimeMs < row.file.mtimeMs) unique.set(key, row);
  }
  return [...unique.values()];
}

async function mapBatches<T>(items: readonly T[], work: (item: T) => Promise<void>, concurrency = 12): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) await Promise.all(items.slice(i, i + concurrency).map(work));
}
