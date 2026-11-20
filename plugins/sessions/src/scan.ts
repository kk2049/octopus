/**
 * Filesystem layer for session investigation — shared by three consumers:
 *   1. the sessions MCP server (local mode, same machine as the bot),
 *   2. the laptop Runner (executes these against the user's real home),
 *   3. the explicit export operations (copy_session / copy_file, windowed by byte offset).
 *
 * All entry points take explicit device-local roots (the scan trust boundary)
 * and the tool-call style `args` record, so the same JSON args can flow
 * MCP → loopback HTTP → gateway RPC → Runner unchanged. A string keeps the
 * historical `home/.codex` default; Runner may additionally supply the
 * effective CODEX_HOME without putting that path in an RPC argument.
 */

import { SESSION_CLI_KINDS, selectSessionWindow, sessionListCursor } from "@claude-bot/agent-sessions-contract";
export { isForegroundTmuxSession } from "@claude-bot/agent-sessions-contract";
export { selectSessionWindow } from "@claude-bot/agent-sessions-contract";
export {
  SESSION_AUTOMATED_WINDOW, SESSION_ROSTER_WINDOW, decodeSessionIds, encodeSessionIds, isAutomatedSession,
} from "@claude-bot/agent-sessions-contract";
import fs from "node:fs/promises";
import path from "node:path";
import { RecentSessionIndex, type SessionEntry } from "./recent-index.js";
import { readCodexSessionTitles } from "./codex-titles.js";
import { RICH_PAGE_BYTES, readRichTranscriptBlock, readRichTranscriptFile, readSessionSummaryFile } from "./rich-file.js";
import { OVERSIZE_TEXT_PREVIEW } from "./transcript-pages.js";
import { sessionDirectoryEntries, invalidateSessionDirectories, resetSessionDirectories } from "./directory-cache.js";
import {
  SEARCH_BUDGET_MS,
  SEARCH_PAGE_MAX,
  compareSearchPositions,
  decodeSearchCursor,
  encodeSearchCursor,
  searchPrefilterTokens,
  searchSessionFile,
  streamSessionRecords,
  type SearchPosition,
} from "./search.js";
import {
  RICH_BLOCK_FIELDS,
  createSessionFlatParser,
  parseSessionText,
  parseSessionRich,
  deriveIdFromPath,
  type FlatMessage,
  type SessionMeta,
  type Source,
  type SessionActivity,
} from "./parse.js";

// Re-export the parse surface consumers of the scan layer need (the Runner's
// append op resolves a session here, then parses meta to find its cwd).
export {
  parseSessionText,
  parseSessionRich,
  deriveIdFromPath,
  classifyOmpContent,
  type Source,
  type SessionActivity,
  type ActivityState,
  type RichMessage,
} from "./parse.js";
export { readSessionSummaryFile } from "./rich-file.js";
export {
  SEARCH_BUDGET_MS,
  SEARCH_CURSOR_MAX_CHARS,
  SEARCH_PAGE_MAX,
  decodeSearchCursor,
  mergeSearchPages,
  type MergedSearchPage,
  type SearchPagePart,
} from "./search.js";
export { readCodexSessionTitles } from "./codex-titles.js";

/**
 * Bytes of file content one export call returns; `next_offset` continues it.
 * JSON escaping of JSONL roughly doubles it, inside the 8 MiB per-call cap.
 */
export const EXPORT_WINDOW_BYTES = 2 * 1024 * 1024;

/** Directory segments never exported as plain files (credentials & internals; sessions travel via copy_session). */
const FILE_EXPORT_DIR_BLACKLIST = new Set([".ssh", ".gnupg", ".aws", ".kube", ".claude", ".codex", ".omp", ".config"]);
/** Basenames never exported as plain files. */
const FILE_EXPORT_NAME_BLACKLIST = new Set([
  "auth.json",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
]);

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface SessionFile {
  source: Source;
  path: string;
  project?: string; // Claude project slug (dir name)
  /** Browser-safe account marker assigned by trusted Runner configuration. */
  account_label?: string;
  mtimeMs: number;
  size: number;
}

export interface CodexSessionScanRoot {
  /** One lowercase display marker; never a provider account name. */
  label: string;
  /** Device-local CODEX_HOME, never accepted from a scan RPC argument. */
  codexHome: string;
}

export interface SessionScanRoots {
  /** User/scan home for Claude, omp, display paths and plain-file disclosure. */
  home: string;
  /** Effective Codex state root (CODEX_HOME); defaults to `<home>/.codex`. */
  codexHome?: string;
  /** Configured Codex account pool. When present, all roots are enumerated. */
  codexHomes?: readonly CodexSessionScanRoot[];
}

export type SessionScanRoot = string | SessionScanRoots;

interface NormalizedSessionScanRoots {
  home: string;
  codexHome: string;
  codexHomes: readonly CodexSessionScanRoot[];
}

function normalizedScanRoots(input: SessionScanRoot): NormalizedSessionScanRoots {
  const home = typeof input === "string" ? input : input.home;
  const legacy = typeof input === "string" || !input.codexHome ? path.join(home, ".codex") : input.codexHome;
  const supplied = typeof input === "string" ? [] : (input.codexHomes ?? []);
  const configured = supplied
    .filter((root) => /^[a-z]?$/.test(root.label) && path.isAbsolute(root.codexHome))
    .map((root) => ({ label: root.label, codexHome: path.resolve(root.codexHome) }));
  if (configured.length !== supplied.length) {
    throw new Error("Codex scan roots require an optional lowercase label and one absolute CODEX_HOME");
  }
  const codexHomes = configured.length ? configured : [{ label: "", codexHome: path.resolve(legacy) }];
  return {
    home,
    codexHome: codexHomes[0].codexHome,
    codexHomes,
  };
}

function scanRootsCacheKey(roots: NormalizedSessionScanRoots): string {
  return JSON.stringify([roots.home, roots.codexHomes]);
}

/**
 * Slightly longer than the View's 2s active-operation poll. That lets the
 * sessions refresh, its workspace refresh, and a wake burst share one device
 * scan, while bounding discovery staleness to one short polling interval.
 */
export const ENUMERATION_CACHE_TTL_MS = 3_000;

type EnumeratedSource = Source;

/** Every CLI this layer can enumerate, in the order `source: "all"` reports. */
export const ENUMERATED_SOURCES: readonly EnumeratedSource[] = SESSION_CLI_KINDS;

/** Tool-call `source` argument → a closed scan selector. Unknown means "all". */
export function scanSourceArg(value: unknown): EnumeratedSource | "all" {
  const raw = String(value ?? "");
  return ENUMERATED_SOURCES.includes(raw as EnumeratedSource) ? (raw as EnumeratedSource) : "all";
}

interface EnumerationCacheEntry {
  files?: readonly SessionFile[];
  expiresAt: number;
  /** A concurrent miss joins the scan already in flight instead of starting another tree walk. */
  refreshing?: Promise<readonly SessionFile[]>;
}

type HomeEnumerationCache = Partial<Record<EnumeratedSource, EnumerationCacheEntry>>;

/** Process-local only; entries expire by wall clock and are isolated by scan home. */
const enumerationCacheByHome = new Map<string, HomeEnumerationCache>();

interface SessionPathCatalog {
  entries: SessionEntry[];
  byId: Map<string, SessionEntry[]>;
}
const pathCatalogs = new Map<string, { expires: number; pending: Promise<SessionPathCatalog> }>();
function pathCatalogKey(roots: NormalizedSessionScanRoots, source: Source): string {
  return JSON.stringify([scanRootsCacheKey(roots), source]);
}

/** Resolve one native identity without statting every unrelated transcript. */
async function sessionPathCatalog(roots: NormalizedSessionScanRoots, source: Source): Promise<SessionPathCatalog> {
  const key = pathCatalogKey(roots, source);
  const previous = pathCatalogs.get(key);
  if (previous && Date.now() < previous.expires) return await previous.pending;
  const slot = { expires: Infinity, pending: Promise.resolve(null as unknown as SessionPathCatalog) };
  slot.pending = SOURCE_LISTERS[source](roots).then((entries) => {
    const byId = new Map<string, SessionEntry[]>();
    for (const entry of entries) {
      const id = deriveIdFromPath(source, entry.path);
      const copies = byId.get(id) ?? []; copies.push(entry); byId.set(id, copies);
    }
    slot.expires = Date.now() + ENUMERATION_CACHE_TTL_MS;
    return { entries, byId };
  }).catch((error) => {
    if (pathCatalogs.get(key) === slot) pathCatalogs.delete(key);
    throw error;
  });
  pathCatalogs.delete(key); pathCatalogs.set(key, slot);
  while (pathCatalogs.size > 48) pathCatalogs.delete(pathCatalogs.keys().next().value!);
  return await slot.pending;
}

/**
 * Drop cached directory facts after a trusted local lifecycle hook.
 *
 * The short enumeration TTL normally lets one UI refresh burst share the same
 * tree walk. A SessionStart/UserPromptSubmit hook is different evidence: the
 * provider may have just materialised a new transcript, so reusing a scan from
 * immediately before that hook would hide the live session until another hook
 * or the periodic reconcile. Completed summary entries stay valid and cheap;
 * only the directory listing for the named provider is invalidated.
 */
export function invalidateSessionEnumeration(
  scanRoot: SessionScanRoot,
  source: Source | "all" = "all",
): void {
  invalidateSessionDirectories();
  recentIndexes.get(normalizedScanRoots(scanRoot).home)?.invalidate();
  const roots = normalizedScanRoots(scanRoot);
  const cacheKey = scanRootsCacheKey(roots);
  const homeCache = enumerationCacheByHome.get(cacheKey);
  const sources: readonly EnumeratedSource[] = source === "all" ? ENUMERATED_SOURCES : [source];
  for (const requested of sources) pathCatalogs.delete(pathCatalogKey(roots, requested));
  if (!homeCache) return;
  for (const requested of sources) delete homeCache[requested];
  if (ENUMERATED_SOURCES.every((known) => !homeCache[known])) enumerationCacheByHome.delete(cacheKey);
}

async function listClaudeFiles(roots: NormalizedSessionScanRoots): Promise<SessionEntry[]> {
  const root = path.join(roots.home, ".claude", "projects");
  const out: SessionEntry[] = [];
  let dirents;
  try {
    dirents = await sessionDirectoryEntries(root);
  } catch {
    return out;
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const projDir = path.join(root, d.name);
    let files;
    try {
      files = await sessionDirectoryEntries(projDir);
    } catch {
      continue;
    }
    for (const directory of files) {
      if (!directory.isDirectory()) continue;
      const subdir = path.join(projDir, directory.name, "subagents");
      if (!(await fs.lstat(subdir).catch(() => null))?.isDirectory()) continue;
      const agents = await sessionDirectoryEntries(subdir).catch(() => []);
      for (const agent of agents) {
        if (!agent.isFile() || !/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(agent.name)) continue;
        const p = path.join(subdir, agent.name);
        out.push({ source: "claude", path: p, project: d.name });
      }
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const p = path.join(projDir, f.name);
      out.push({ source: "claude", path: p, project: d.name });
    }
  }
  return out;
}

async function walkJsonl(dir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await sessionDirectoryEntries(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirents) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      out.push(...(await walkJsonl(p)));
    } else if (d.isFile() && d.name.endsWith(".jsonl")) {
      out.push(p);
    }
  }
  return out;
}

async function listCodexFiles(roots: NormalizedSessionScanRoots): Promise<SessionEntry[]> {
  const out: SessionEntry[] = [];
  for (const account of roots.codexHomes) {
    const files = await walkJsonl(path.join(account.codexHome, "sessions"));
    for (const p of files) {
      out.push({ source: "codex", path: p, ...(account.label ? { account_label: account.label } : {}) });
    }
  }
  return out;
}

/**
 * Oh My Pi session roots.
 *
 * `<home>/.omp/agent/sessions/<slug>/<iso-ts>_<uuid>.jsonl`, where the slug is
 * the launch cwd flattened the way Claude flattens a project directory. Each
 * session file has a SIBLING DIRECTORY of the same stem holding per-tool
 * scratch logs and `__advisor.jsonl`; those are not conversations, so this
 * deliberately reads one level only instead of walking the tree.
 *
 * Named profiles (`omp --profile x`) relocate the agent dir to
 * `~/.omp/profiles/<name>/agent`. They are opt-in and isolated by design; a
 * profile's sessions are out of scope here rather than silently merged into
 * the default profile's roster.
 */
export function ompSessionsRoot(home: string): string {
  return path.join(home, ".omp", "agent", "sessions");
}

async function listOmpFiles(roots: NormalizedSessionScanRoots): Promise<SessionEntry[]> {
  const root = ompSessionsRoot(roots.home);
  const out: SessionEntry[] = [];
  let dirents;
  try {
    dirents = await sessionDirectoryEntries(root);
  } catch {
    return out;
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const projDir = path.join(root, d.name);
    let files;
    try {
      files = await sessionDirectoryEntries(projDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const p = path.join(projDir, f.name);
      out.push({ source: "omp", path: p, project: d.name });
    }
  }
  return out;
}

const SOURCE_LISTERS: Record<EnumeratedSource, (roots: NormalizedSessionScanRoots) => Promise<SessionEntry[]>> = {
  claude: listClaudeFiles,
  codex: listCodexFiles,
  omp: listOmpFiles,
};

/** Cheap directory inventory; file fingerprints are checked by the bounded index. */
export async function sessionFileEntries(scanRoot: SessionScanRoot): Promise<SessionEntry[]> {
  const roots = normalizedScanRoots(scanRoot);
  return (await Promise.all(ENUMERATED_SOURCES.map((source) => SOURCE_LISTERS[source](roots)))).flat();
}

async function enumerateSource(
  roots: NormalizedSessionScanRoots,
  source: EnumeratedSource,
): Promise<readonly SessionFile[]> {
  const cacheKey = scanRootsCacheKey(roots);
  let homeCache = enumerationCacheByHome.get(cacheKey);
  if (!homeCache) {
    homeCache = {};
    enumerationCacheByHome.set(cacheKey, homeCache);
  }

  let entry = homeCache[source];
  if (entry?.files && Date.now() < entry.expiresAt) return entry.files;
  if (entry?.refreshing) return entry.refreshing;

  const refreshing = SOURCE_LISTERS[source](roots).then(async (entries) => {
    const files = await mapLimit(entries, 12, async (entry): Promise<SessionFile | null> => {
      try {
        const stat = await fs.stat(entry.path);
        return { ...entry, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch { return null; }
    });
    return files.filter((file): file is SessionFile => file !== null);
  });
  entry = { expiresAt: 0, refreshing };
  homeCache[source] = entry;
  try {
    const files = await refreshing;
    entry.files = files;
    entry.expiresAt = Date.now() + ENUMERATION_CACHE_TTL_MS;
    return files;
  } catch (error) {
    // Do not turn a transient scan failure into a cached failure.
    if (homeCache[source] === entry) delete homeCache[source];
    if (ENUMERATED_SOURCES.every((known) => !homeCache![known])) enumerationCacheByHome.delete(cacheKey);
    throw error;
  } finally {
    if (homeCache[source] === entry) entry.refreshing = undefined;
  }
}

export async function enumerate(scanRoot: SessionScanRoot, source: EnumeratedSource | "all"): Promise<SessionFile[]> {
  const roots = normalizedScanRoots(scanRoot);
  const sources: readonly EnumeratedSource[] = source === "all" ? ENUMERATED_SOURCES : [source];
  const parts = await Promise.all(sources.map((requested) => enumerateSource(roots, requested)));
  // Callers sort/filter their copy; the cached facts stay immutable for the
  // next consumer during this TTL window.
  return parts.flatMap((files) => [...files]);
}

// ---------------------------------------------------------------------------
// Jail
// ---------------------------------------------------------------------------

/**
 * Ensure an explicit session-file path stays inside the scan root's session
 * dirs (`home/.claude/projects`, `CODEX_HOME/sessions` or
 * `home/.omp/agent/sessions`),
 * resolving symlinks so a link can't escape the jail. Throws when outside.
 * Returns the real path.
 */
export async function assertPathInScanRoot(scanRoot: SessionScanRoot, p: string): Promise<string> {
  const roots = normalizedScanRoots(scanRoot);
  const real = await fs.realpath(p);
  const allowedRoots = [
    path.join(roots.home, ".claude", "projects"),
    ...roots.codexHomes.map((root) => path.join(root.codexHome, "sessions")),
    ompSessionsRoot(roots.home),
  ];
  for (const root of allowedRoots) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
  }
  throw new Error(`path is outside the session scan root (${roots.home})`);
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/**
 * Return the exact parent only for the complete provider-owned Codex claim.
 * Scanner output crosses multiple explicit projection allowlists, so keep the
 * shape and token validation in one dependency they already share.
 */
export function parentOwnedCodexParentId(value: Readonly<Record<string, unknown>>): string | null {
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const parent = typeof value.parent_session_id === "string" ? value.parent_session_id.trim() : "";
  return value.source === "codex"
    && value.input_mode === "parent_owned"
    && Boolean(id)
    && /^[A-Za-z0-9_-]{1,160}$/.test(parent)
    && parent !== id
    ? parent
    : null;
}

/** Lineage is display metadata; it does not by itself prohibit direct input. */
export function subagentParentId(value: Readonly<Record<string, unknown>>): string | null {
  const owned = parentOwnedCodexParentId(value);
  if (owned) return owned;
  const parent = typeof value.parent_session_id === "string" ? value.parent_session_id.trim() : "";
  return (value.source === "codex" || value.source === "claude")
    && value.is_subagent === true
    && typeof value.id === "string" && Boolean(value.id)
    && /^[A-Za-z0-9_-]{1,160}$/.test(parent) && parent !== value.id
    ? parent : null;
}

/** Claude sidechain transcripts have no independent CLI resume identity. */
export function parentOwnedSessionParentId(value: Readonly<Record<string, unknown>>): string | null {
  return parentOwnedCodexParentId(value)
    ?? (value.source === "claude" && value.input_mode === "parent_owned"
      && typeof value.id === "string" && /^agent-[A-Za-z0-9_-]{1,150}$/.test(value.id)
      ? subagentParentId(value) : null);
}

export interface SessionSummary {
  usage?: import("@claude-bot/agent-sessions-contract").CodexTokenUsage;
  id: string;
  source: Source;
  project?: string;
  account_label?: string;
  cwd?: string;
  path: string;
  started_at?: string;
  last_activity?: string;
  /** Cached stable roster key: last user prompt or completed agent turn. */
  sort_activity?: string;
  /** Last agent turn completion, used for review acknowledgement. */
  completed_at?: string;
  message_count?: number;
  /** Provider-owned display title from its session log or native name index. */
  title?: string;
  /** Explicit provider ownership; absent is not evidence of direct writability. */
  input_mode?: "parent_owned";
  /** Exact provider parent id, never a path or display label. */
  parent_session_id?: string;
  is_subagent?: true;
  execution_mode?: "exec";
  first_user_text?: string;
  preview?: string;
  /** What the agent is doing right now (absent when undecidable). */
  activity?: SessionActivity;
  /** Which laptop this summary came from (filled by the gateway on merge). */
  device?: string;
}

function readText(p: string): Promise<string> {
  return fs.readFile(p, "utf8");
}

function isoOrUndefined(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Summary cache keyed by file path, validated by (mtimeMs, size). Building a
 * summary requires reading + parsing the WHOLE session file; listing 50
 * recent sessions used to re-read hundreds of MB on every call. Session logs
 * are append-only (a finished session never changes), so mtime+size is an
 * honest validity check. Summaries are a few hundred bytes each — the cap is
 * a backstop, not a working-set tuner. Exported for tests only.
 */
interface SummaryVersion {
  mtimeMs: number;
  size: number;
}

interface PendingSummary extends SummaryVersion {
  generation: number;
  promise: Promise<SessionSummary>;
}

export const __summaryCache = new Map<string, SummaryVersion & { summary: SessionSummary }>();
/** Test-visible only: in production this map contains no completed values. */
export const __summaryPending = new Map<string, PendingSummary>();
const SUMMARY_CACHE_MAX = 2000;
let nextSummaryGeneration = 0;

/** Session files are append-only; mtime, then size, is their monotonic version. */
function compareSummaryVersion(left: SummaryVersion, right: SummaryVersion): number {
  if (left.mtimeMs !== right.mtimeMs) return left.mtimeMs < right.mtimeMs ? -1 : 1;
  if (left.size === right.size) return 0;
  return left.size < right.size ? -1 : 1;
}

function rememberSummary(file: SessionFile, summary: SessionSummary): void {
  if (__summaryCache.size >= SUMMARY_CACHE_MAX && !__summaryCache.has(file.path)) {
    // Drop the oldest insertions (Map preserves insertion order).
    for (const key of __summaryCache.keys()) {
      if (__summaryCache.size < SUMMARY_CACHE_MAX) break;
      __summaryCache.delete(key);
    }
  }
  __summaryCache.set(file.path, {
    mtimeMs: file.mtimeMs,
    size: file.size,
    summary,
  });
}

async function buildSummary(file: SessionFile): Promise<SessionSummary> {
  const meta = await readSessionSummaryFile(file.path, file.source);
  const id = meta.id ?? deriveIdFromPath(file.source, file.path);
  const lineage = { ...meta, id, source: file.source };
  const parentSessionId = subagentParentId(lineage);
  const parentOwned = parentOwnedSessionParentId(lineage);
  return {
    id,
    source: file.source,
    project: file.project,
    account_label: file.account_label,
    cwd: meta.cwd,
    path: file.path,
    started_at: meta.started_at ?? isoOrUndefined(file.mtimeMs),
    last_activity: meta.last_activity ?? isoOrUndefined(file.mtimeMs),
    sort_activity: meta.sort_activity,
    completed_at: meta.completed_at,
    message_count: meta.message_count,
    title: meta.title,
    usage: meta.usage,
    ...(meta.execution_mode === "exec" ? { execution_mode: "exec" as const } : {}),
    ...(parentSessionId ? {
      is_subagent: true as const,
      ...(parentOwned ? { input_mode: "parent_owned" as const } : {}),
      parent_session_id: parentSessionId,
    } : {}),
    first_user_text: meta.first_user_text,
    preview: meta.preview,
    // Safe to cache alongside the rest: any state change appends a line, and
    // an append moves both mtime and size — the cache key already covers it.
    activity: meta.activity,
  };
}

async function summarize(file: SessionFile): Promise<SessionSummary> {
  const hit = __summaryCache.get(file.path);
  // A caller can hold enumeration facts from just before a refresh. Never let
  // that older version evict a newer summary already observed for this path.
  if (hit && compareSummaryVersion(hit, file) >= 0) return hit.summary;

  const pending = __summaryPending.get(file.path);
  // Exact versions join. If a stale enumerator arrives after a newer build has
  // started, it joins the newer fact rather than starting a backwards read.
  if (pending && compareSummaryVersion(pending, file) >= 0) return pending.promise;

  const generation = ++nextSummaryGeneration;
  let entry!: PendingSummary;
  const promise = buildSummary(file)
    .then((summary) => {
      // A newer (mtime,size) build may have replaced this one while the whole
      // file was being read and synchronously parsed. Only the currently
      // registered generation may publish the completed cache.
      if (__summaryPending.get(file.path)?.generation === generation) rememberSummary(file, summary);
      return summary;
    })
    .finally(() => {
      if (__summaryPending.get(file.path)?.generation === generation) __summaryPending.delete(file.path);
    });
  entry = { mtimeMs: file.mtimeMs, size: file.size, generation, promise };
  __summaryPending.set(file.path, entry);
  return promise;
}

/** @internal Test seam for deterministic whole-file read races. */
export const __summarizeForTests = summarize;


// ---------------------------------------------------------------------------
// Operations (tool-call style: loose args in, JSON-able result out)
// ---------------------------------------------------------------------------

/**
 * Bounded-concurrency map. Uncached summaries read the WHOLE session file;
 * kicking off hundreds of those at once (files reach tens of MB) would spike
 * memory on a small shared host. Single-threaded JS makes `next++` race-free.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Enough I/O overlap for cold logs without unbounded whole-file reads. */
const SUMMARY_READ_CONCURRENCY = 12;

/** One roster page (window). A string `cursor` walks every session past it in identity order. */
export const LIST_LIMIT_MAX = 500;

/** Stable identity order for explicit history paging; defined once in the sessions contract. */
export { sessionListCursor };

const recentIndexes = new Map<string, RecentSessionIndex>();

/** @internal Restart simulation without touching provider logs or durable facts. */
export function resetRecentSessionIndexes(): void {
  recentIndexes.clear();
  recentIndexScopes.clear();
  resetSessionDirectories();
  pathCatalogs.clear();
}

/** Device-owned runtime priority, never accepted through JSON/RPC arguments. */
export type SessionRosterPriority = (candidates: readonly (SessionSelection & { path: string })[]) => Promise<ReadonlySet<string>>;

export async function listRecentSessions(scanRoot: SessionScanRoot, args: Record<string, unknown>, priority?: SessionRosterPriority): Promise<unknown> {
  if (args.primary_window === true && typeof args.cursor !== "string") {
    const roots = normalizedScanRoots(scanRoot);
    // A root-set change creates a fresh observer; its durable reserve is still
    // reusable only after the new root set independently discovers each path.
    const key = roots.home;
    let index = recentIndexes.get(key);
    const signature = scanRootsCacheKey(roots);
    if (!index || recentIndexScopes.get(key) !== signature) {
      index = new RecentSessionIndex({ home: roots.home,
        entries: () => sessionFileEntries(scanRoot),
        summarize: buildSummary, parentId: (row) => subagentParentId({ ...row }) });
      recentIndexes.set(key, index);
      recentIndexScopes.set(key, signature);
      while (recentIndexes.size > 16) {
        const oldest = recentIndexes.keys().next().value!;
        recentIndexes.delete(oldest);
        recentIndexScopes.delete(oldest);
      }
    }
    const result = await index.list(args, priority) as { sessions: SessionSummary[] };
    return { ...result, sessions: await withCodexTitles(roots, result.sessions) };
  }
  return await listRecentSessionsSelected(scanRoot, args);
}
const recentIndexScopes = new Map<string, string>();

/** Name changes need no transcript append or index rebuild; never mutate cached summaries. */
async function withCodexTitles(
  roots: NormalizedSessionScanRoots,
  sessions: readonly SessionSummary[],
): Promise<SessionSummary[]> {
  const groups = new Map<string, SessionSummary[]>();
  // Match the actual discovered file's root, including unlabelled/split homes.
  // Neither a display account label nor an RPC argument can select a name index.
  const homes = [...roots.codexHomes].sort((a, b) => b.codexHome.length - a.codexHome.length);
  for (const session of sessions) {
    if (session.source !== "codex") continue;
    const account = homes.find((root) =>
      path.resolve(session.path).startsWith(path.join(root.codexHome, "sessions") + path.sep));
    if (!account) continue;
    const rows = groups.get(account.codexHome) ?? [];
    rows.push(session);
    groups.set(account.codexHome, rows);
  }
  const named = new Map<SessionSummary, string>();
  await mapLimit([...groups], 2, async ([home, rows]) => {
    const titles = await readCodexSessionTitles(home, new Set(rows.map((row) => row.id)));
    for (const row of rows) {
      const title = titles.get(row.id);
      if (title) named.set(row, title);
    }
  });
  return sessions.map((session) => {
    const title = named.get(session);
    return title ? { ...session, title } : session;
  });
}

/**
 * List only an already-authorized set of provider ids.
 *
 * The selection is a trusted caller's positive provenance, not a tool-call
 * argument. Filtering happens on filename-derived opaque ids before any whole
 * transcript is read, so an excluded corpus cannot influence summaries or I/O.
 */
export async function listSelectedSessions(
  scanRoot: SessionScanRoot,
  args: Record<string, unknown>,
  selected: readonly SessionSelection[],
  priority?: SessionRosterPriority,
): Promise<unknown> {
  return await listRecentSessionsSelected(scanRoot, args, selectionKeys(selected), priority);
}

export interface SessionSelection {
  source: Source;
  id: string;
}

async function listRecentSessionsSelected(
  scanRoot: SessionScanRoot,
  args: Record<string, unknown>,
  selected?: ReadonlySet<string>,
  priority?: SessionRosterPriority,
): Promise<unknown> {
  const roots = normalizedScanRoots(scanRoot);
  const { home } = roots;
  const source = scanSourceArg(args.source);
  const limit = Math.max(1, Math.min(LIST_LIMIT_MAX, Number(args.limit ?? 20) || 20));
  const sinceHours = args.since_hours != null ? Number(args.since_hours) : undefined;

  let files = await enumerate(scanRoot, source);
  if (selected) files = files.filter((file) => selected.has(sessionSelectionKey(file.source, deriveIdFromPath(file.source, file.path))));
  if (sinceHours != null && Number.isFinite(sinceHours)) {
    const cutoff = Date.now() - sinceHours * 3600_000;
    files = files.filter((f) => f.mtimeMs >= cutoff);
  }
  const history = typeof args.cursor === "string";
  const key = (file: SessionFile): string => sessionListCursor({ source: file.source, id: deriveIdFromPath(file.source, file.path) });
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // Copies of the same provider id are one chat. Keep the freshest file.
  files = [...new Map(files.map((file) => [key(file), file] as const).reverse()).values()];
  const total = files.length;
  const preferred = args.primary_window === true && !history && priority
    ? await priority(files.map((file) => ({ ...file, id: deriveIdFromPath(file.source, file.path) })))
    : new Set<string>();
  if (history) {
    files = files.filter((file) => key(file) > String(args.cursor));
    files.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  } else {
    files.sort((a, b) => Number(preferred.has(key(b))) - Number(preferred.has(key(a))) || b.mtimeMs - a.mtimeMs);
  }
  const selectedFiles = files.slice(0, args.primary_window === true && !history ? LIST_LIMIT_MAX : limit);
  let sessions = await mapLimit(selectedFiles, SUMMARY_READ_CONCURRENCY, async (file): Promise<SessionSummary> => {
    try { return await summarize(file); }
    catch {
      return { id: deriveIdFromPath(file.source, file.path), source: file.source, path: file.path,
        project: file.project, last_activity: new Date(file.mtimeMs).toISOString(), preview: "日志暂时无法读取" } satisfies SessionSummary;
    }
  });
  if (!history) sessions.sort((a, b) =>
    (b.sort_activity ?? b.last_activity ?? "").localeCompare(a.sort_activity ?? a.last_activity ?? ""));
  if (args.primary_window === true && !history) sessions = selectSessionWindow(sessions, limit,
    (row) => subagentParentId({ ...row }), (row) => preferred.has(sessionListCursor(row)));

  return {
    home,
    source,
    total_found: total,
    returned: sessions.length,
    ...(history ? { has_more: files.length > limit } : args.primary_window === true ? { primary_window: true } : {}),
    sessions: await withCodexTitles(roots, sessions),
    note: files.length === 0 ? "No Claude/Codex/omp sessions found under this home." : undefined,
  };
}

/**
 * The "skim recent work" primitive: conversation skeletons of the most recent
 * sessions in ONE call — user prompts and the assistant's natural-language
 * replies only (tool calls/results/thinking dropped), each turn truncated.
 * This lets a secretary READ what happened instead of guessing search terms;
 * read_session then digs into whichever sessions matter.
 */
export async function digestRecentSessions(scanRoot: SessionScanRoot, args: Record<string, unknown>): Promise<unknown> {
  const { home } = normalizedScanRoots(scanRoot);
  const source = scanSourceArg(args.source);
  const limit = Math.max(1, Math.min(20, Number(args.limit ?? 8) || 8));
  const perSession = Math.max(2, Math.min(40, Number(args.turns_per_session ?? 14) || 14));
  const maxChars = Math.max(40, Math.min(400, Number(args.chars_per_turn ?? 160) || 160));
  const sinceHours = args.since_hours != null ? Number(args.since_hours) : undefined;

  let files = await enumerate(scanRoot, source);
  if (sinceHours != null && Number.isFinite(sinceHours)) {
    const cutoff = Date.now() - sinceHours * 3600_000;
    files = files.filter((f) => f.mtimeMs >= cutoff);
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = files.slice(0, limit);

  const sessions: Array<Record<string, unknown>> = [];
  for (const f of selected) {
    let parsed;
    try {
      parsed = parseSessionText(f.source, await fs.readFile(f.path, "utf8"));
    } catch {
      continue;
    }
    const { meta, messages } = parsed;
    // Skeleton = only turns with real text (tool-only rows dropped). Keep the
    // opening 2 turns (they define the task) plus the most recent ones (they
    // hold the outcome).
    const textual = messages
      .filter((m) => m.text.trim().length > 0)
      .map((m) => ({ role: m.role, text: m.text.replace(/\s+/g, " ").trim() }));
    let turns = textual;
    let elided = 0;
    if (textual.length > perSession) {
      const head = textual.slice(0, 2);
      const tail = textual.slice(-(perSession - 2));
      elided = textual.length - perSession;
      turns = [...head, ...tail];
    }
    sessions.push({
      id: meta.id ?? deriveIdFromPath(f.source, f.path),
      source: f.source,
      project: f.project,
      account_label: f.account_label,
      cwd: meta.cwd,
      started_at: meta.started_at,
      last_activity: meta.last_activity ?? new Date(f.mtimeMs).toISOString(),
      message_count: meta.message_count,
      elided_turns: elided || undefined,
      turns: turns.map((t) => ({ role: t.role, text: t.text.length > maxChars ? t.text.slice(0, maxChars) + "…" : t.text })),
    });
  }

  return {
    home,
    source,
    total_found: files.length,
    returned: sessions.length,
    sessions,
    note:
      files.length === 0
        ? "No Claude/Codex/omp sessions found under this home."
        : "turns 已滤掉工具调用/思考细节;需要完整内容与工具名用 read_session(细节用 tool_detail=true)。",
  };
}

async function codexAccountForPath(
  scanRoot: SessionScanRoot,
  p: string,
): Promise<CodexSessionScanRoot | null> {
  const { codexHomes } = normalizedScanRoots(scanRoot);
  const normalizedPath = path.resolve(p);
  for (const account of codexHomes) {
    const normalizedHome = await fs.realpath(account.codexHome).catch(() => path.resolve(account.codexHome));
    if (normalizedPath === normalizedHome || normalizedPath.startsWith(normalizedHome + path.sep)) return account;
  }
  return null;
}

async function inferSourceFromPath(scanRoot: SessionScanRoot, p: string): Promise<Source> {
  if (await codexAccountForPath(scanRoot, p)) return "codex";
  if (p.includes(`${path.sep}.codex${path.sep}`) || p.includes("/.codex/")) return "codex";
  if (p.includes(`${path.sep}.omp${path.sep}`) || p.includes("/.omp/")) return "omp";
  return "claude";
}

export async function resolveSessionPath(
  scanRoot: SessionScanRoot,
  source: Source | undefined,
  id: string | undefined,
  explicitPath: string | undefined,
): Promise<{ path: string; source: Source; account_label?: string; codexHome?: string }> {
  if (explicitPath) {
    const resolvedSource = source ?? await inferSourceFromPath(scanRoot, explicitPath);
    const account = resolvedSource === "codex" ? await codexAccountForPath(scanRoot, explicitPath) : null;
    return {
      path: explicitPath,
      source: resolvedSource,
      ...(account?.label ? { account_label: account.label } : {}),
      ...(account ? { codexHome: account.codexHome } : {}),
    };
  }
  if (!id) throw new Error("read_session requires either `id` or `path`");
  const sources: readonly Source[] = source ? [source] : ENUMERATED_SOURCES;
  for (const s of sources) {
    const catalog = await sessionPathCatalog(normalizedScanRoots(scanRoot), s);
    const candidates = await Promise.all((catalog.byId.get(id) ?? []).map(async (entry) => {
      try {
        const stat = await fs.lstat(entry.path);
        return stat.isFile() ? { ...entry, mtimeMs: stat.mtimeMs } : null;
      } catch { return null; }
    }));
    const exact = candidates.filter((entry): entry is SessionEntry & { mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (exact) {
      const account = s === "codex" ? await codexAccountForPath(scanRoot, exact.path) : null;
      return {
        path: exact.path,
        source: s,
        ...(exact.account_label ? { account_label: exact.account_label } : {}),
        ...(account ? { codexHome: account.codexHome } : {}),
      };
    }
    let partial: SessionEntry | undefined;
    for (const entry of catalog.entries) {
      if (!entry.path.includes(id)) continue;
      try { if ((await fs.lstat(entry.path)).isFile()) { partial = entry; break; } } catch { /* Vanished inventory entry. */ }
    }
    if (partial) {
      const account = s === "codex" ? await codexAccountForPath(scanRoot, partial.path) : null;
      return {
        path: partial.path,
        source: s,
        ...(partial.account_label ? { account_label: partial.account_label } : {}),
        ...(account ? { codexHome: account.codexHome } : {}),
      };
    }
  }
  throw new Error(`session not found for id: ${id}`);
}

/** Characters of one block field a block read returns; `next_char_offset` continues it. */
export const RICH_BLOCK_WINDOW_CHARS = 256 * 1024;

function wholeArg(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : undefined;
}

/**
 * Read one bounded window of a session. Every mode pages over the WHOLE log:
 *  - `offset`: the window starts there (forward paging: next offset = offset + returned_messages);
 *  - `before`: the window ends there (backward paging: next before = offset);
 *  - neither: the latest messages.
 * A window holds at most `max_messages` and RICH_PAGE_BYTES of messages
 * (`byte_limited` says it stopped early). Rich pages cap thinking/tool details
 * (`truncated`); `block` (+ `field`, `char_offset`) reads one complete block
 * field of the message at `offset`, in windows of RICH_BLOCK_WINDOW_CHARS.
 */
export async function readSession(scanRoot: SessionScanRoot, args: Record<string, unknown>): Promise<unknown> {
  const source = ENUMERATED_SOURCES.includes(String(args.source) as Source)
    ? (String(args.source) as Source)
    : undefined;
  const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
  let explicitPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
  if (explicitPath) explicitPath = await assertPathInScanRoot(scanRoot, explicitPath);
  const maxMessages = Math.max(1, Math.min(500, Number(args.max_messages ?? 40) || 40));
  const toolDetail = args.tool_detail === true || args.tool_detail === "true";
  const rich = args.rich === true || args.rich === "true";
  const offsetArg = wholeArg(args.offset);
  const before = wholeArg(args.before);

  const resolved = await resolveSessionPath(scanRoot, source, id, explicitPath);
  const sessionMeta = (meta: SessionMeta) => ({
    ...(resolved.source === "codex" ? { turn_configuration: meta.turn_configuration ?? null } : {}),
    id: meta.id ?? deriveIdFromPath(resolved.source, resolved.path),
    source: resolved.source,
    cwd: meta.cwd,
    path: resolved.path,
    started_at: meta.started_at,
    last_activity: meta.last_activity,
    message_count: meta.message_count,
    git_branch: meta.git_branch,
    version: meta.version,
    first_user_text: meta.first_user_text,
    activity: meta.activity,
    ...(resolved.account_label ? { account_label: resolved.account_label } : {}),
  });

  if (rich && args.block !== undefined) {
    const blockIndex = wholeArg(args.block);
    const field = RICH_BLOCK_FIELDS.find((name) => name === args.field) ?? "text";
    if (offsetArg === undefined || blockIndex === undefined) throw new Error("read_session block 需要 offset（消息序号）和 block（块序号）");
    const { meta, total, block } = await readRichTranscriptBlock(resolved.path, resolved.source, offsetArg, blockIndex);
    if (!block) throw new Error("这个内容块不存在（会话可能已变化），请刷新后重试");
    const value = typeof block[field] === "string" ? block[field] : "";
    const start = Math.min(wholeArg(args.char_offset) ?? 0, value.length);
    const end = Math.min(value.length, start + RICH_BLOCK_WINDOW_CHARS);
    return {
      meta: sessionMeta(meta),
      rich: true,
      total_messages: total,
      offset: offsetArg,
      block: blockIndex,
      block_type: block.type,
      ...(block.tool ? { tool: block.tool } : {}),
      ...(block.is_error ? { is_error: true } : {}),
      field,
      char_offset: start,
      total_chars: value.length,
      text: value.slice(start, end),
      ...(end < value.length ? { next_char_offset: end } : {}),
    };
  }

  // Rich mode (transcript viewer): block-level messages with paired tool
  // results, plus honest offset paging over the WHOLE session — the flat
  // mode's "last N" is right for a secretary skim but not for a full review.
  if (rich) {
    const { meta, messages: page, total, offset, byteLimited } = await readRichTranscriptFile(
      resolved.path, resolved.source, maxMessages, offsetArg, before,
    );
    return {
      meta: sessionMeta(meta),
      rich: true,
      total_messages: total,
      offset,
      returned_messages: page.length,
      ...(byteLimited ? { byte_limited: true } : {}),
      messages: page,
    };
  }

  const { meta, messages, total, offset, byteLimited } = await readFlatWindow(
    resolved.path, resolved.source, { toolDetail, limit: maxMessages, offset: offsetArg, before },
  );
  return {
    meta: sessionMeta(meta),
    // Messages exist before this window (the historical "last N" flag).
    truncated: offset > 0,
    total_messages: total,
    offset,
    returned_messages: messages.length,
    ...(byteLimited ? { byte_limited: true } : {}),
    messages,
  };
}

/**
 * One flat window, streamed: memory holds the window, never the log. The parser
 * emits normalized messages, including Codex history and deduplicated mirrors.
 */
async function readFlatWindow(
  file: string,
  source: Source,
  window: { toolDetail: boolean; limit: number; offset?: number; before?: number },
): Promise<{ meta: SessionMeta; messages: FlatMessage[]; total: number; offset: number; byteLimited: boolean }> {
  const start = window.offset !== undefined && window.before === undefined ? window.offset
    : window.before !== undefined ? Math.max(0, window.before - window.limit) : undefined;
  const limit = window.before !== undefined ? Math.min(window.limit, window.before) : window.limit;
  const reading = new FlatWindow(start, limit);
  const parser = createSessionFlatParser(source, (message) => reading.add(message), { toolDetail: window.toolDetail });
  await streamSessionRecords(file, (records) => parser.append(records));
  const first = start ?? Math.max(0, reading.count - limit);
  const fitted = fitFlatMessages(reading.kept, start !== undefined && window.before === undefined);
  return {
    meta: parser.snapshot(),
    messages: fitted.messages,
    total: reading.count,
    offset: Math.min(reading.count, first + fitted.skipped),
    byteLimited: fitted.byteLimited,
  };
}

class FlatWindow {
  count = 0;
  kept: FlatMessage[] = [];
  constructor(private readonly start: number | undefined, private readonly limit: number) {}
  add(message: FlatMessage): void {
    const index = this.count++;
    if (this.start === undefined) {
      this.kept.push(message);
      if (this.kept.length > this.limit) this.kept.shift();
    } else if (index >= this.start && index < this.start + this.limit) this.kept.push(message);
  }
}

/** The flat counterpart of the rich page budget: whole messages from the anchored side, at least one. */
function fitFlatMessages(
  messages: readonly FlatMessage[],
  keepFirst: boolean,
): { messages: FlatMessage[]; skipped: number; byteLimited: boolean } {
  const out: FlatMessage[] = [];
  let bytes = 0;
  let byteLimited = false;
  for (let index = 0; index < messages.length; index++) {
    let message = messages[keepFirst ? index : messages.length - 1 - index]!;
    let size = Buffer.byteLength(JSON.stringify(message));
    if (out.length && bytes + size > RICH_PAGE_BYTES) { byteLimited = true; break; }
    if (size > RICH_PAGE_BYTES) {
      // Complete text stays reachable through rich mode's block reads.
      message = { ...message, text: message.text.slice(0, OVERSIZE_TEXT_PREVIEW) + "…", truncated: true };
      size = Buffer.byteLength(JSON.stringify(message));
      byteLimited = true;
    }
    bytes += size;
    out.push(message);
  }
  if (!keepFirst) out.reverse();
  return { messages: out, skipped: keepFirst ? 0 : messages.length - out.length, byteLimited };
}

/**
 * One bounded page of a complete search (see search.ts). Every candidate the
 * scan root holds is reachable through `next_cursor`; a page ends when it has
 * `limit` hits or has spent `budgetMs`, after at least one file.
 */
export async function searchSessions(
  scanRoot: SessionScanRoot,
  args: Record<string, unknown>,
  budgetMs = SEARCH_BUDGET_MS,
): Promise<unknown> {
  return await searchSessionsSelected(scanRoot, args, budgetMs);
}

/** Search only a trusted positive set, filtering before transcript reads. */
export async function searchSelectedSessions(
  scanRoot: SessionScanRoot,
  args: Record<string, unknown>,
  selected: readonly SessionSelection[],
  budgetMs = SEARCH_BUDGET_MS,
): Promise<unknown> {
  return await searchSessionsSelected(scanRoot, args, budgetMs, selectionKeys(selected));
}

async function searchSessionsSelected(
  scanRoot: SessionScanRoot,
  args: Record<string, unknown>,
  budgetMs: number,
  selected?: ReadonlySet<string>,
): Promise<unknown> {
  const { home } = normalizedScanRoots(scanRoot);
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("search_sessions requires a non-empty `query`");
  const source = scanSourceArg(args.source);
  const limit = Math.max(1, Math.min(SEARCH_PAGE_MAX, Number(args.limit ?? 10) || 10));
  const cursor = decodeSearchCursor(args.cursor);
  const sinceHours = args.since_hours != null ? Number(args.since_hours) : undefined;

  let files = await enumerate(scanRoot, source);
  if (selected) files = files.filter((file) => selected.has(sessionSelectionKey(file.source, deriveIdFromPath(file.source, file.path))));
  if (sinceHours != null && Number.isFinite(sinceHours)) {
    const cutoff = Date.now() - sinceHours * 3600_000;
    files = files.filter((f) => f.mtimeMs >= cutoff);
  }
  // Copies of one provider id are one chat; search the freshest copy, like the roster.
  const byKey = new Map<string, { file: SessionFile; position: SearchPosition }>();
  for (const file of files) {
    const key = `${file.source}:${deriveIdFromPath(file.source, file.path)}`;
    const held = byKey.get(key);
    if (!held || file.mtimeMs > held.file.mtimeMs) byKey.set(key, { file, position: { mtimeMs: file.mtimeMs, key } });
  }
  const ordered = [...byKey.values()].sort((a, b) => compareSearchPositions(a.position, b.position));
  const pending = cursor ? ordered.filter(({ position }) => compareSearchPositions(position, cursor) > 0) : ordered;

  const tokens = searchPrefilterTokens(query);
  const started = Date.now();
  const results: unknown[] = [];
  let scanned = 0;
  for (const { file: f, position } of pending) {
    if (scanned > 0 && (results.length >= limit || Date.now() - started >= budgetMs)) break;
    scanned++;
    let hit;
    try {
      hit = await searchSessionFile(f.path, f.source, query, tokens);
    } catch {
      continue; // Vanished or unreadable since enumeration: nothing to find there now.
    }
    if (!hit) continue;
    const { meta, matches } = hit;
    results.push({
      session: {
        id: meta.id ?? deriveIdFromPath(f.source, f.path),
        source: f.source,
        project: f.project,
        account_label: f.account_label,
        cwd: meta.cwd,
        path: f.path,
        started_at: meta.started_at ?? isoOrUndefined(f.mtimeMs),
        last_activity: meta.last_activity ?? isoOrUndefined(f.mtimeMs),
        message_count: meta.message_count,
        title: meta.title,
        first_user_text: meta.first_user_text,
        is_subagent: meta.is_subagent,
        parent_session_id: meta.parent_session_id,
        input_mode: meta.input_mode,
      },
      matches,
      cursor: encodeSearchCursor(position),
    });
  }
  const complete = scanned >= pending.length;

  return {
    home,
    query,
    source,
    scanned,
    total_candidates: ordered.length,
    returned: results.length,
    results,
    complete,
    ...(complete ? {} : { next_cursor: encodeSearchCursor(pending[scanned - 1]!.position) }),
  };
}

function selectionKeys(selected: readonly SessionSelection[]): ReadonlySet<string> {
  return new Set(selected.map((row) => sessionSelectionKey(row.source, row.id)));
}

function sessionSelectionKey(source: Source, id: string): string {
  return `${source}\u0000${id}`;
}

// ---------------------------------------------------------------------------
// Export (the explicit session-copy primitive)
// ---------------------------------------------------------------------------

export interface SessionFileExport {
  id: string;
  source: Source;
  /** Path relative to the scan home, e.g. ".claude/projects/slug/x.jsonl". */
  rel_path: string;
  /** Whole file size in bytes when this window was read. */
  size: number;
  /** Byte offset of this window; `next_offset` is the next window's, absent at the end. */
  offset: number;
  next_offset?: number;
  /** UTF-8 text of [offset, next_offset ?? size), cut only between characters. */
  content: string;
  /**
   * Which machine this came off, stamped by the gateway (the scanner itself
   * has no idea it is one of several). A report that discloses a file should
   * be able to say where it came from — the same path can exist on two of a
   * user's laptops with different contents.
   */
  device?: string;
}

/** One bounded byte window of a file, never splitting a UTF-8 character. */
async function readExportWindow(
  file: string,
  offset: number,
  windowBytes: number,
): Promise<{ size: number; offset: number; next_offset?: number; content: string }> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, Math.min(Math.floor(offset), size));
    const buffer = Buffer.alloc(Math.min(windowBytes, size - start));
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    let end = read;
    if (start + read < size && read > 0) {
      // A trailing incomplete UTF-8 sequence starts the next window instead.
      let lead = read - 1;
      while (lead > 0 && read - lead < 4 && (buffer[lead]! & 0xc0) === 0x80) lead--;
      const first = buffer[lead]!;
      const length = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
      if (lead > 0 && lead + length > read) end = lead;
    }
    return {
      size,
      offset: start,
      ...(start + end < size ? { next_offset: start + end } : {}),
      content: buffer.subarray(0, end).toString("utf8"),
    };
  } finally { await handle.close(); }
}

/**
 * Read one window of a plain file for report attachment. Jail: the realpath
 * must stay inside the scan home; credential-ish dirs/names are refused
 * outright, as are dotfiles-in-blacklisted-trees. A file of any size is read
 * window by window through `offset`. rel_path is prefixed "files/" so the
 * archive keeps attachments apart from sessions.
 */
export async function exportPlainFile(
  home: string,
  filePath: string,
  offset = 0,
  windowBytes = EXPORT_WINDOW_BYTES,
): Promise<SessionFileExport> {
  const real = await fs.realpath(filePath);
  const realHome = await fs.realpath(home);
  const rel = path.relative(realHome, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`文件在可披露范围(${home})之外`);
  }
  const segments = rel.split(path.sep);
  if (segments.some((s) => FILE_EXPORT_DIR_BLACKLIST.has(s))) {
    throw new Error("该目录下的文件不允许随报告披露(凭据/内部状态)");
  }
  const base = path.basename(real);
  if (FILE_EXPORT_NAME_BLACKLIST.has(base) || base.startsWith(".env")) {
    throw new Error("该文件类型不允许随报告披露(疑似凭据)");
  }
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error("不是普通文件");
  return {
    id: rel.split(path.sep).join("/"),
    source: "claude", // unused for plain files; kept for shape compatibility
    rel_path: ["files", ...segments].join("/"),
    ...await readExportWindow(real, offset, windowBytes),
  };
}

/**
 * Read one window of a session file for archival; `offset` continues it, so a
 * log of any size is exported whole. The returned rel_path is computed from
 * its realpath'd provider root so it can be safely re-rooted under an archive
 * dir. Custom Codex roots retain the logical `.codex/sessions/...` shape.
 */
export async function exportSessionFile(
  scanRoot: SessionScanRoot,
  id: string,
  offset = 0,
  windowBytes = EXPORT_WINDOW_BYTES,
): Promise<SessionFileExport> {
  const roots = normalizedScanRoots(scanRoot);
  const resolved = await resolveSessionPath(scanRoot, undefined, id, undefined);
  const real = await assertPathInScanRoot(scanRoot, resolved.path);
  const exportRoot = resolved.source === "codex" ? (resolved.codexHome ?? roots.codexHome) : roots.home;
  const realExportRoot = await fs.realpath(exportRoot);
  const rel = path.relative(realExportRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("session file resolved outside its session root");
  }
  const relSegments = rel.split(path.sep);
  const relPath = (resolved.source === "codex" ? [".codex", ...relSegments] : relSegments).join("/");
  return { id, source: resolved.source, rel_path: relPath, ...await readExportWindow(real, offset, windowBytes) };
}
