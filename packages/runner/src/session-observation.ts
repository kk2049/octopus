/** Device-owned catalog. List reads never discover files or refresh old chats. */
import fs from "node:fs/promises";
import { createReadStream, watch, type FSWatcher } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  deriveIdFromPath, parseSessionText, readSessionSummaryFile, readCodexSessionTitles,
  readSession, assertPathInScanRoot, sessionListCursor, subagentParentId,
  selectSessionWindow, isAutomatedSession, SESSION_AUTOMATED_WINDOW,
  type SessionScanRoot, type SessionSummary, type Source,
} from "@claude-bot/plugin-sessions/scan";

type Identity = { source: Source; id: string };
interface Root { dir: string; source: Source; scan: SessionScanRoot; account?: string; }
/**
 * `classified` records which execution-mode rule produced the row. Version 1
 * also reads Codex's native `originator`, so `exec` forks recorded with source
 * "vscode" are automated. Older journal rows are corrected from their first
 * record in the background, without a whole-log read.
 */
interface Row { summary: SessionSummary; version: string; titleVersion?: string; nativeTitle?: string; mtime: number; root: string; classified?: number; }
const CLASSIFIED = 1;
interface Directory { root: Root; depth: number; watcher?: FSWatcher; version?: string; identity?: string; }
const key = (row: Identity): string => sessionListCursor(row);
const identityOrder = (a: SessionSummary, b: SessionSummary): number => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
const order = (a: SessionSummary, b: SessionSummary): number =>
  (b.sort_activity ?? b.last_activity ?? "").localeCompare(a.sort_activity ?? a.last_activity ?? "") || key(a).localeCompare(key(b));
const MAX_WATCHERS = 8_192;

/**
 * A header-only read sees how a log began, not how it ends: its last record,
 * current activity, last completion and length are unknown. Every append moves
 * the file's mtime, so until a full read the log is dated by that. Dating it by
 * the header's last record put a chat that has run for days at its first hour,
 * out of any recent window — the normal case for a home without hooks.
 */
function headerSummary(summary: SessionSummary, mtimeMs: number): SessionSummary {
  const { sort_activity: _sort, completed_at: _completed, activity: _activity, message_count: _count, ...known } = summary;
  return { ...known, last_activity: new Date(mtimeMs).toISOString() };
}
const MAX_RECORD_BYTES = 64 * 1024;

export interface SessionObservationOptions {
  home: string;
  roots: () => Promise<SessionScanRoot>;
  /** Isolated split roots may discover names, but only authorized ids get parsed. */
  selectedOnly?: boolean;
  stateFile?: string;
  onChanged?: () => void;
  /** A complete re-read of one transcript; the summary reflects its tail. */
  onSummary?: (summary: SessionSummary) => void;
  onError?: (error: unknown) => void;
}

export class SessionObservationIndex {
  private readonly roots = new Map<string, Root>();
  private rootSnapshot?: SessionScanRoot;
  private excluded?: string;
  private readonly directories = new Map<string, Directory>();
  private readonly directoryQueue = new Set<string>();
  private directorySweep?: IterableIterator<string>;
  private nextSweep = 0;
  private readonly files = new Map<string, { root: Root; id: string }>();
  private readonly locations = new Map<string, Set<string>>();
  private readonly pending = new Set<string>();
  private readonly changed = new Set<string>();
  private readonly rows = new Map<string, Row>();
  private readonly live = new Set<string>();
  private readonly leases = new Map<string, number>();
  private readonly flights = new Map<string, Promise<void>>();
  private readonly titles = new Map<string, { version: string; value: Promise<ReadonlyMap<string, string>> }>();
  private historyDirty = true;
  private history: SessionSummary[] = [];
  private historyById: SessionSummary[] = [];
  private readonly historyViews = new Map<string, {
    rows: SessionSummary[]; ids: SessionSummary[]; primary: SessionSummary[]; automated: SessionSummary[]; children: SessionSummary[];
  }>();
  private readonly reclassify = new Set<string>();
  private started?: Promise<void>;
  private ticking?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private watchers = 0;
  private writes = Promise.resolve();
  private journalWrites = 0;
  readonly stats = { directoryReads: 0, fileReads: 0, liveChecks: 0, classifyReads: 0 };

  constructor(private readonly options: SessionObservationOptions) {}
  private get stateFile(): string {
    return this.options.stateFile ?? path.join(this.options.home, ".octopus", this.options.selectedOnly
      ? "session-observation-split-v1.jsonl" : "session-observation-v1.jsonl");
  }

  start(): Promise<void> {
    return this.started ??= (async () => {
      await this.updateRoots();
      await this.restore();
      if (this.closed) return;
      this.timer = setInterval(() => { void this.tick().catch(this.options.onError ?? (() => {})); }, 500);
      this.timer.unref();
      // Startup inventory is background work; a cold roster is honestly partial.
      void this.tick().catch(this.options.onError ?? (() => {}));
    })();
  }

  private async updateRoots(): Promise<void> {
    const scan = await this.options.roots();
    if (scan === this.rootSnapshot) return;
    this.rootSnapshot = scan;
    const home = typeof scan === "string" ? scan : scan.home;
    this.excluded ??= await fs.realpath(path.join(home, ".octopus", "codex-split-home"))
      .catch(() => path.join(home, ".octopus", "codex-split-home"));
    const homes = typeof scan === "string" ? [{ codexHome: path.join(home, ".codex"), label: "" }]
      : scan.codexHomes?.length ? scan.codexHomes : [{ codexHome: scan.codexHome ?? path.join(home, ".codex"), label: "" }];
    const next: Root[] = homes.map((account) => ({ dir: path.join(account.codexHome, "sessions"), source: "codex",
      scan: { home, codexHomes: [account] }, account: account.label }));
    if (!this.options.selectedOnly) next.push(
      { dir: path.join(home, ".claude", "projects"), source: "claude", scan: { home, codexHomes: [] } },
      { dir: path.join(home, ".omp", "agent", "sessions"), source: "omp", scan: { home, codexHomes: [] } });
    const allowed = new Set(next.map((root) => root.dir));
    for (const [dir] of this.roots) if (!allowed.has(dir)) {
      this.roots.delete(dir);
      this.titles.delete(dir);
      for (const [p, entry] of this.directories) if (entry.root.dir === dir) {
        entry.watcher?.close(); if (entry.watcher) this.watchers--;
        this.directories.delete(p); this.directoryQueue.delete(p);
      }
      for (const [p, entry] of this.files) if (entry.root.dir === dir) this.forget(p);
    }
    for (const root of next) {
      const existing = this.roots.get(root.dir);
      if (!existing) {
        this.roots.set(root.dir, root); this.enqueueDirectory(root.dir, root, 0);
      } else {
        // Files and watchers retain this object; update its current account
        // metadata without rereading or dropping historical transcripts.
        const labelChanged = existing.account !== root.account;
        Object.assign(existing, root);
        if (labelChanged) for (const row of this.rows.values()) if (row.root === root.dir) this.relabel(row, existing);
      }
    }
  }

  private relabel(row: Row, root: Root): void {
    const label = root.source === "codex" && root.account ? root.account : undefined;
    if (row.summary.account_label === label) return;
    const { account_label: _previous, ...summary } = row.summary;
    row.summary = { ...summary, ...(label ? { account_label: label } : {}) };
    this.historyDirty = true;
    this.options.onChanged?.();
  }

  private rootFor(file: string): Root | undefined {
    let dir = path.dirname(path.resolve(file));
    while (dir !== path.dirname(dir)) {
      const root = this.roots.get(dir); if (root) return root;
      dir = path.dirname(dir);
    }
    return undefined;
  }

  private async trustedPath(root: Root, file: string): Promise<string> {
    const actual = await assertPathInScanRoot(root.scan, file);
    if (!this.options.selectedOnly && this.excluded && (actual === this.excluded || actual.startsWith(this.excluded + path.sep))) {
      throw new Error("path is outside ordinary session authority");
    }
    if (root.source === "codex") {
      const home = await fs.realpath(path.dirname(root.dir));
      if (!actual.startsWith(home + path.sep)) throw new Error("path is outside the Codex home");
    }
    return actual;
  }

  private enqueueDirectory(dir: string, root: Root, depth: number): void {
    if (this.closed) return;
    if (!this.directories.has(dir)) this.directories.set(dir, { root, depth });
    this.directoryQueue.add(dir);
  }

  private remember(file: string, root: Root, nativeId?: string): void {
    if (this.files.has(file)) return;
    const id = nativeId ?? deriveIdFromPath(root.source, file);
    this.files.set(file, { root, id });
    const identity = key({ source: root.source, id });
    const copies = this.locations.get(identity) ?? new Set<string>();
    copies.add(file); this.locations.set(identity, copies);
    if (!this.options.selectedOnly) this.pending.add(file);
  }

  private forget(file: string): void {
    const location = this.files.get(file);
    if (location) {
      const identity = key({ source: location.root.source, id: location.id });
      const copies = this.locations.get(identity); copies?.delete(file);
      if (!copies?.size) this.locations.delete(identity);
    }
    this.files.delete(file); this.pending.delete(file); this.changed.delete(file); this.reclassify.delete(file);
    if (this.rows.delete(file)) { this.historyDirty = true; this.options.onChanged?.(); }
  }

  /** One owner advances the inventory; observers never race to install watchers. */
  async tick(): Promise<void> {
    if (this.closed) return;
    if (this.ticking) return this.ticking;
    this.ticking = this.advance().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }

  private async advance(): Promise<void> {
    await this.updateRoots();
    const deadline = Date.now() + 20;
    // Watchers discover names. A bounded rotating directory sweep covers lost
    // events, missing roots and watcher exhaustion; it NEVER stats old logs.
    if (Date.now() >= this.nextSweep) {
      this.nextSweep = Date.now() + 2_000;
      this.directorySweep ??= this.directories.keys();
      for (let i = 0; i < 8; i++) {
        const next = this.directorySweep.next();
        if (next.done) { this.directorySweep = undefined; break; }
        this.directoryQueue.add(next.value);
      }
    }
    for (let i = 0; i < 32 && this.directoryQueue.size && !this.closed; i++) {
      const dir = this.directoryQueue.values().next().value!; this.directoryQueue.delete(dir);
      await this.observeDirectory(dir);
      if (Date.now() >= deadline) break;
    }
    // Native changes identify exact files even when /proc cannot prove a live
    // terminal (for example an explicitly registered migrated account). Keep
    // this queue bounded, coalesced, and separate from historical discovery.
    for (const file of [...this.changed].slice(0, 8)) {
      if (this.closed) break;
      this.changed.delete(file);
      await this.observe(file, true);
      if (Date.now() >= deadline) break;
    }
    const headers: string[] = [];
    for (const file of this.pending) { headers.push(file); if (headers.length === 8) break; }
    for (const file of headers) {
      if (this.closed) break;
      this.pending.delete(file);
      await this.observe(file, false);
      if (Date.now() >= deadline) break;
    }
    for (const file of [...this.reclassify].slice(0, 8)) {
      if (this.closed || Date.now() >= deadline) break;
      this.reclassify.delete(file);
      await this.classify(file);
    }
  }

  /** Correct one restored row's execution mode from its first record only. */
  private async classify(file: string): Promise<void> {
    const row = this.rows.get(file); const location = this.files.get(file);
    if (!row || !location || row.classified === CLASSIFIED) return;
    try {
      const actual = await this.trustedPath(location.root, file);
      const handle = await fs.open(actual, "r");
      let text: string;
      try {
        const buffer = Buffer.alloc(MAX_RECORD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        text = buffer.toString("utf8", 0, bytesRead);
      } finally { await handle.close(); }
      this.stats.classifyReads++;
      // A fresh observation may have replaced the row while this read ran.
      if (this.closed || this.rows.get(file) !== row) return;
      // An oversized first record keeps its prior mark until a full read.
      if (text.includes("\n")) {
        const exec = parseSessionText(location.root.source, text.slice(0, text.indexOf("\n") + 1)).meta.execution_mode === "exec";
        const { execution_mode: previous, ...summary } = row.summary;
        row.summary = exec ? { ...summary, execution_mode: "exec" } : summary;
        if (exec !== (previous === "exec")) { this.historyDirty = true; this.options.onChanged?.(); }
      }
      row.classified = CLASSIFIED;
      this.persist(row);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.forget(file);
      // Other failures keep the restored row; a later full read reclassifies it.
    }
  }

  private async observeDirectory(dir: string): Promise<void> {
    const record = this.directories.get(dir); if (!record) return;
    try {
      const st = await fs.lstat(dir);
      if (!st.isDirectory()) return; // Never follow a discovered symlink.
      const identity = `${st.dev}:${st.ino}`;
      if (record.identity !== identity && record.watcher) {
        record.watcher.close(); record.watcher = undefined; this.watchers--;
      }
      record.identity = identity;
      const version = `${identity}:${st.mtimeMs}:${st.ctimeMs}`;
      if (record.version === version && record.watcher) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }); this.stats.directoryReads++;
      if (this.closed) return;
      record.version = version;
      if (!record.watcher && this.watchers < MAX_WATCHERS) try {
        record.watcher = watch(dir, { persistent: false }, (event, name) => {
          const file = name && path.join(dir, name.toString());
          if (file && this.files.has(file)) {
            // Private split names alone never authorize parsing their contents.
            if (!this.options.selectedOnly || this.isLive(record.root.source, this.files.get(file)!.id)) {
              this.changed.add(file);
              if (this.changed.size > 500) this.changed.delete(this.changed.values().next().value!);
            }
            return;
          }
          if (event === "rename" || !name) { record.version = undefined; this.directoryQueue.add(dir); }
        });
        this.watchers++;
        record.watcher.on("error", () => {
          if (record.watcher) { record.watcher.close(); record.watcher = undefined; this.watchers--; }
          record.version = undefined;
        });
      } catch { /* Bounded reconciliation covers unsupported watchers. */ }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          if (record.root.source === "omp" && record.depth !== 1) continue;
          if (record.root.source === "claude" && record.depth !== 1
            && !(record.depth === 3 && path.basename(dir) === "subagents" && /^agent-[\w-]+\.jsonl$/.test(entry.name))) continue;
          this.remember(file, record.root);
        } else if (entry.isDirectory() && (record.root.source === "codex"
          || record.root.source === "omp" && record.depth < 1
          || record.root.source === "claude" && record.depth < 3)) {
          if (!this.directories.has(file)) this.enqueueDirectory(file, record.root, record.depth + 1);
        }
      }
    } catch { /* Absent/unreadable roots remain in the bounded directory sweep. */ }
  }

  private async observe(file: string, fresh: boolean): Promise<void> {
    const previous = this.flights.get(file);
    if (previous) { await previous; if (fresh) await this.observe(file, true); return; }
    const flight = this.observeFile(file, fresh).finally(() => {
      if (this.flights.get(file) === flight) this.flights.delete(file);
    });
    this.flights.set(file, flight); await flight;
  }

  private async observeFile(file: string, fresh: boolean): Promise<void> {
    const location = this.files.get(file); if (!location || this.closed) return;
    const { root, id } = location;
    try {
      // The index is a locator, never permission to read an arbitrary path.
      const actual = await this.trustedPath(root, file);
      const st = await fs.stat(actual); if (!st.isFile()) return;
      const version = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      const cached = this.rows.get(file);
      if (fresh) this.stats.liveChecks++;
      const titleStat = root.source === "codex"
        ? await fs.stat(path.join(path.dirname(root.dir), "session_index.jsonl")).catch(() => null) : null;
      const titleVersion = titleStat ? `${titleStat.dev}:${titleStat.ino}:${titleStat.size}:${titleStat.mtimeMs}:${titleStat.ctimeMs}` : "";
      if (cached?.version.replace(/^header:/, "") === version && (!fresh
        || !cached.version.startsWith("header:") && cached.titleVersion === titleVersion)) return;
      let meta;
      let complete = fresh;
      if (fresh) meta = await readSessionSummaryFile(actual, root.source);
      else {
        const handle = await fs.open(actual, "r");
        try {
          const buffer = Buffer.alloc(MAX_RECORD_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          let text = buffer.toString("utf8", 0, bytesRead);
          if (bytesRead < st.size) text = text.slice(0, text.lastIndexOf("\n") + 1);
          if (!st.size) { this.pending.add(file); return; }
          meta = parseSessionText(root.source, text).meta;
          complete = bytesRead === st.size;
        } finally { await handle.close(); }
      }
      if (this.closed || this.files.get(file) !== location || this.roots.get(root.dir) !== root) return;
      this.stats.fileReads++;
      const read: SessionSummary = { ...meta, id: meta.id ?? id, source: root.source, path: file,
        ...(root.account ? { account_label: root.account } : {}),
        last_activity: meta.last_activity ?? new Date(st.mtimeMs).toISOString() };
      const summary = complete ? read : headerSummary(read, st.mtimeMs);
      if (summary.id !== id) {
        const prior = this.locations.get(key({ source: root.source, id })); prior?.delete(file);
        location.id = summary.id;
        const exact = this.locations.get(key(summary)) ?? new Set<string>(); exact.add(file); this.locations.set(key(summary), exact);
      }
      let nativeTitle = cached?.nativeTitle;
      if (root.source === "codex") {
        // Cold headers can end before the first user message. Names are small,
        // independent native metadata: share one bounded read per home/version.
        let index = this.titles.get(root.dir);
        if (!index || index.version !== titleVersion) {
          index = { version: titleVersion, value: readCodexSessionTitles(path.dirname(root.dir)) };
          this.titles.set(root.dir, index);
        }
        nativeTitle = (await index.value).get(summary.id);
        summary.title = nativeTitle || summary.title;
      }
      // A removed/replaced registration or closed observer cannot be revived
      // by a read which started under the old root generation.
      if (this.closed || this.files.get(file) !== location || this.roots.get(root.dir) !== root) return;
      const row: Row = { root: root.dir, summary, version: fresh ? version : `header:${version}`, titleVersion, nativeTitle,
        mtime: st.mtimeMs, classified: CLASSIFIED };
      this.rows.set(file, row);
      if (!this.live.has(key(summary))) this.historyDirty = true;
      this.persist(row); this.options.onChanged?.();
      if (complete) this.options.onSummary?.(summary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.forget(file);
      // Transient failures retry only on the next active observation/open.
    }
  }

  /** Trusted hook/process evidence supplies an exact local path, never an RPC path. */
  async register(source: Source, file: string): Promise<void> {
    await this.start();
    const root = this.rootFor(file);
    if (!root || root.source !== source) return;
    await this.trustedPath(root, file);
    this.remember(file, root);
  }

  async accepts(source: Source, file: string): Promise<boolean> {
    await this.start();
    const root = this.rootFor(file); if (root?.source !== source) return false;
    return Boolean(await this.trustedPath(root, file).catch(() => null));
  }

  /** First discovery is cheap; changes to an unobserved historical id are ignored. */
  async notify(identity: Identity, file?: string): Promise<void> {
    await this.start();
    const existed = this.locations.has(key(identity));
    if (file) await this.register(identity.source, file);
    if (this.live.has(key(identity)) || this.leases.has(key(identity))) await this.refresh(identity);
    else if (!existed) for (const p of this.locations.get(key(identity)) ?? []) await this.observe(p, false);
  }

  retain(identity: Identity): () => void {
    const id = key(identity); this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const count = (this.leases.get(id) ?? 1) - 1;
      if (count) this.leases.set(id, count); else this.leases.delete(id);
    };
  }

  async refresh(identity: Identity, file?: string): Promise<void> {
    await this.start();
    if (file) await this.register(identity.source, file);
    for (const candidate of this.locations.get(key(identity)) ?? []) await this.observe(candidate, true);
  }

  setLive(identities: readonly Identity[]): void {
    const next = new Set(identities.map(key));
    if (next.size === this.live.size && [...next].every((id) => this.live.has(id))) return;
    this.live.clear(); for (const id of next) this.live.add(id);
    this.historyDirty = true;
  }

  isLive(source: Source, id: string): boolean { return this.live.has(key({ source, id })) || this.leases.has(key({ source, id })); }

  async observeRead(value: unknown): Promise<void> {
    const meta = value && typeof value === "object" ? (value as { meta?: Partial<SessionSummary> }).meta : undefined;
    if (!meta?.path || !meta.id || !meta.source) return;
    if (!await this.accepts(meta.source, meta.path)) return;
    await this.refresh({ source: meta.source, id: meta.id }, meta.path);
  }

  private sortedHistory(): void {
    if (!this.historyDirty) return;
    const unique = new Map<string, Row>();
    for (const row of this.rows.values()) {
      const identity = key(row.summary); if (this.live.has(identity)) continue;
      const prev = unique.get(identity);
      if (!prev || row.mtime > prev.mtime) unique.set(identity, row);
    }
    this.history = [...unique.values()].map((row) => row.summary).sort(order);
    this.historyById = [...this.history].sort(identityOrder);
    for (const source of ["all", "codex", "claude", "omp"]) {
      const rows = source === "all" ? this.history : this.history.filter((row) => row.source === source);
      this.historyViews.set(source, { rows,
        ids: source === "all" ? this.historyById : this.historyById.filter((row) => row.source === source),
        primary: rows.filter((row) => !subagentParentId({ ...row }) && !isAutomatedSession(row)),
        automated: rows.filter((row) => !subagentParentId({ ...row }) && isAutomatedSession(row)),
        children: rows.filter((row) => Boolean(subagentParentId({ ...row }))),
      });
    }
    this.historyDirty = false;
  }

  private row(identity: string): Row | undefined {
    let latest: Row | undefined;
    for (const p of this.locations.get(identity) ?? []) {
      const row = this.rows.get(p); if (row && (!latest || row.mtime > latest.mtime)) latest = row;
    }
    return latest;
  }

  async list(args: Record<string, unknown>, selected?: readonly Identity[]): Promise<unknown> {
    await this.start();
    // Explicit scoped ids alone may populate the isolated catalog. Never parse
    // unrelated split transcripts just because their names were discovered.
    if (selected) for (const identity of selected) {
      if (!this.row(key(identity))) for (const p of this.locations.get(key(identity)) ?? []) await this.observe(p, false);
    }
    this.sortedHistory();
    const hot = [...this.live].map((id) => this.row(id)?.summary).filter((r): r is SessionSummary => Boolean(r)).sort(order);
    const source = ["codex", "claude", "omp"].includes(String(args.source)) ? String(args.source) : "all";
    const allowed = selected ? new Set(selected.map(key)) : undefined;
    const limit = Math.max(1, Math.min(500, Number(args.limit ?? 20) || 20));
    const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
    const cutoff = args.since_hours == null ? -Infinity : Date.now() - Number(args.since_hours) * 3_600_000;
    const matches = (r: SessionSummary): boolean => (source === "all" || r.source === source)
      && (!allowed || allowed.has(key(r))) && (!(Number.isFinite(cutoff)) || Date.parse(r.last_activity ?? "") >= cutoff);
    const view = this.historyViews.get(source)!;
    const matchingHot = hot.filter(matches);
    let candidates: SessionSummary[];
    let total = view.rows.length + matchingHot.length;
    if (allowed) {
      candidates = [...allowed].map((id) => this.row(id)?.summary).filter((r): r is SessionSummary => Boolean(r)).filter(matches).sort(order);
      total = candidates.length;
    } else if (Number.isFinite(cutoff)) {
      // An explicit historical time filter may examine cached metadata only.
      candidates = [...matchingHot, ...view.rows.filter(matches)]; total = candidates.length;
    } else if (cursor !== undefined) {
      // Seek cached identity order instead of sorting all history per page.
      let lo = 0; let hi = view.ids.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1;
        if (key(view.ids[mid]) <= cursor) lo = mid + 1; else hi = mid;
      }
      candidates = [...matchingHot, ...view.ids.slice(lo, lo + limit + 1)];
    } else if (args.primary_window === true) {
      // Separate allowances, so an `exec` burst never starves the chats.
      candidates = [...matchingHot, ...view.primary.slice(0, limit),
        ...view.automated.slice(0, SESSION_AUTOMATED_WINDOW), ...view.children.slice(0, 300)];
    } else candidates = [...matchingHot, ...view.rows.slice(0, limit)];
    const eligible = cursor === undefined ? candidates : candidates.filter((row) => key(row) > cursor).sort(identityOrder);
    const sessions = args.primary_window === true && cursor === undefined
      ? selectSessionWindow(eligible, limit, (row) => subagentParentId({ ...row }), (row) => this.live.has(key(row)))
      : eligible.slice(0, limit);
    return { home: this.options.home, source, total_found: total, returned: sessions.length, sessions,
      ...(cursor !== undefined ? { has_more: eligible.length > limit } : args.primary_window ? { primary_window: true } : {}),
      index_pending: this.pending.size > 0 || this.directoryQueue.size > 0 || this.reclassify.size > 0 };
  }

  async resolve(identity: Identity): Promise<{ path: string; scan: SessionScanRoot } | undefined> {
    await this.start();
    let best: { path: string; scan: SessionScanRoot; mtime: number } | undefined;
    for (const file of this.locations.get(key(identity)) ?? []) {
      const root = this.files.get(file)?.root; if (!root) continue;
      try {
        const actual = await this.trustedPath(root, file); const st = await fs.stat(actual);
        if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path: actual, scan: root.scan, mtime: st.mtimeMs };
      } catch { /* An old index row cannot bypass current file/permission proof. */ }
    }
    return best;
  }

  async read(args: Record<string, unknown>): Promise<unknown | undefined> {
    if (typeof args.id !== "string" || !["codex", "claude", "omp"].includes(String(args.source)) || args.path) return undefined;
    const identity = { source: args.source as Source, id: args.id };
    const resolved = await this.resolve(identity); if (!resolved) return undefined;
    const result = await readSession(resolved.scan, { ...args, path: resolved.path });
    await this.refresh(identity); return result;
  }

  private persist(row: Row): void {
    const text = JSON.stringify(row) + "\n";
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) return;
    this.writes = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.appendFile(this.stateFile, text, { mode: 0o600 });
      // Compact in the same serialized writer. Stream rows to avoid a second
      // full catalog string and yield disk IO between records.
      if (++this.journalWrites < 10_000) return;
      this.journalWrites = 0;
      const temporary = `${this.stateFile}.${process.pid}.tmp`;
      const handle = await fs.open(temporary, "w", 0o600);
      try { for (const row of this.rows.values()) {
        const line = JSON.stringify(row) + "\n";
        if (Buffer.byteLength(line) <= MAX_RECORD_BYTES) await handle.write(line);
      } } finally { await handle.close(); }
      await fs.rename(temporary, this.stateFile);
    }).catch(this.options.onError ?? (() => {}));
  }

  private async restore(): Promise<void> {
    try {
      const stat = await fs.stat(this.stateFile); if (stat.size > 128 * 1024 * 1024) return;
      const lines = createInterface({ input: createReadStream(this.stateFile), crlfDelay: Infinity });
      for await (const line of lines) {
        if (this.closed) break;
        if (Buffer.byteLength(line) > MAX_RECORD_BYTES) continue;
        try {
          const row = JSON.parse(line) as Row;
          const root = this.rootFor(row.summary?.path ?? "");
          if (!root || root.dir !== row.root || row.summary.source !== root.source
            || typeof row.summary.id !== "string" || typeof row.version !== "string" || !Number.isFinite(row.mtime)) continue;
          // A journal caches transcript metadata, not the current account map.
          // Old positional labels must not survive a corrected Runner mapping.
          this.relabel(row, root);
          // Journals written before header rows were dated by mtime carry the header's last record.
          if (row.version.startsWith("header:")) row.summary = headerSummary(row.summary, row.mtime);
          this.remember(row.summary.path, root, row.summary.id); this.pending.delete(row.summary.path);
          this.rows.set(row.summary.path, row);
          // Private split logs are parsed only for an authorized id; they keep their row.
          if (row.classified === CLASSIFIED || this.options.selectedOnly || root.source !== "codex") this.reclassify.delete(row.summary.path);
          else this.reclassify.add(row.summary.path);
        } catch { /* Torn journal tail is reconstructible from native files. */ }
      }
    } catch { /* First boot uses bounded name/header discovery. */ }
  }

  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    await this.started;
    await this.ticking;
    await Promise.allSettled(this.flights.values());
    for (const dir of this.directories.values()) dir.watcher?.close();
    this.watchers = 0; await this.writes;
  }
}
