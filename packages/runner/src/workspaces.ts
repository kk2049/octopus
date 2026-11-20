/**
 * Device-local workspace registry. Canonical paths never cross the Runner wire.
 *
 * ── Since 2026-08-10: this device also answers "which registered workspace is
 *    that session sitting in" ─────────────────────────────────────────────────
 *
 * A session's working directory and a registered workspace's root are both
 * absolute paths on THIS machine, and this file is the only place that holds
 * both. The bot holds neither: it gets opaque workspace ids and a display-only
 * `~/…` label, which is exactly the disclosure boundary this module exists to
 * keep. So the association has to be computed here or not at all — matching a
 * `~/…` label against a workspace label on the bot would be a guess dressed up
 * as an answer, and two directories that a truncated label makes look identical
 * would silently become one.
 *
 * The answer is reported as `(workspace_id, relative_path)`: the SAME pair the
 * workspace-files operations already accept and return. No new authority
 * material crosses, no canonical path crosses, and the bot can compare it
 * against what a directory listing gave it without parsing anything.
 *
 * Containment is decided on `realpath`ed paths, so a session started through a
 * symlink still associates with the registered root it actually lives in.
 */

import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ENUMERATED_SOURCES, type Source } from "@claude-bot/plugin-sessions/scan";
import { MACHINE_LIMITS } from "./limits.js";
import { workspaceRelativePathProblem } from "./workspace-paths.js";

const REGISTRY_VERSION = 1;
const REGISTRY_DIR = ".octopus-runner";
const REGISTRY_FILE = "workspaces.json";
/** A Runner normally has one home; this bounds test/multi-tenant process churn. */
const REGISTRY_CACHE_MAX_ENTRIES = 16;
const DIRECTORY_CHECK_CONCURRENCY = 4;

/** Bound filesystem pressure within one request, preserving input order. */
async function directoryChecks<T, R>(items: readonly T[], check: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(DIRECTORY_CHECK_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await check(items[index]);
    }
  }));
  return result;
}

/** RPC scope is set once by the authenticated dispatcher; local CLI is unscoped. */
const workspaceSite = new AsyncLocalStorage<string>();
export function withWorkspaceSite<T>(site: string, action: () => T): T {
  return workspaceSite.run(site, action);
}
export interface ManagedWorkspaceBinding {
  site: string;
  parent_workspace_id: string;
  repository_id: string;
  development_id: string;
}
const registryWrites = new Map<string, Promise<unknown>>();
function registryWrite<T>(home: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(home);
  const pending = (registryWrites.get(key) ?? Promise.resolve()).then(action, action);
  registryWrites.set(key, pending);
  void pending.finally(() => { if (registryWrites.get(key) === pending) registryWrites.delete(key); }).catch(() => {});
  return pending;
}

export interface WorkspaceRecord {
  id: string;
  label: string;
  display: string;
  /** Device-local authority material. Never return this from an RPC. */
  path: string;
  managed?: ManagedWorkspaceBinding;
}

export interface PublicWorkspace {
  id: string;
  label: string;
  display: string;
}

/** Device-local CLI projection. The canonical path never leaves this process. */
export interface LocalWorkspace extends PublicWorkspace {
  path: string;
  available: boolean;
}

export interface SessionWorkspaceCandidate {
  cwd?: unknown;
  /** The session's own id, as the scanner reports it. */
  id?: unknown;
  /** `claude`, `codex` or `omp`. Anything else is not an associable session. */
  source?: unknown;
}

/**
 * One session's working directory, named the way this contract already names
 * directories: an opaque workspace id plus a POSIX path relative to its root.
 *
 * `relative_path` is `""` when the session sits at the workspace root. There is
 * no third field and no absolute path — a consumer that wanted one would have
 * to ask the device for it, which is the point.
 */
export interface SessionDirectoryAssociation {
  source: Source;
  id: string;
  workspace_id: string;
  relative_path: string;
}

/** One roster's worth. Bounded so a huge scan cannot inflate one response. */
const MAX_SESSION_DIRECTORIES = 500;

interface WorkspaceRegistry {
  version: 1;
  workspaces: WorkspaceRecord[];
}

interface RegistryCacheEntry {
  mtimeMs: number;
  size: number;
  registry: WorkspaceRegistry;
}

/**
 * Process-local parsed registries, reused only after the file's mtime and size
 * still match. Atomic in-process writes evict immediately after rename.
 */
const registryCacheByFile = new Map<string, RegistryCacheEntry>();

export function addWorkspace(home: string, directory: string, label?: string): Promise<PublicWorkspace> {
  return registryWrite(home, () => addWorkspaceLocked(home, directory, label));
}

/**
 * Every resident Runner has one safe, useful starting point even before the
 * user registers a project. The operation is idempotent and preserves an
 * existing label when an older Runner already registered the home directory.
 */
export function ensureDefaultWorkspace(home: string): Promise<PublicWorkspace> {
  return addWorkspace(home, home, "Home");
}

async function addWorkspaceLocked(home: string, directory: string, label?: string): Promise<PublicWorkspace> {
  const root = path.resolve(home);
  const canonical = await fs.realpath(path.resolve(directory));
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) throw new Error("workspace 必须是目录");

  const registry = await readRegistry(root);
  const existing = registry.workspaces.find((entry) => entry.path === canonical);
  if (existing) return publicWorkspace(existing);

  const entry: WorkspaceRecord = {
    id: `ws_${randomBytes(12).toString("hex")}`,
    label: boundedLabel(label) || path.basename(canonical) || "workspace",
    display: displayPath(root, canonical),
    path: canonical,
  };
  registry.workspaces.push(entry);
  await writeRegistry(root, registry);
  return publicWorkspace(entry);
}

/** Runner-owned registration under an existing root; callers supply no path. */
export function addManagedWorkspace(
  home: string, directory: string, label: string, managed: ManagedWorkspaceBinding,
): Promise<PublicWorkspace> {
  return registryWrite(home, async () => {
    const parent = await resolveWorkspace(home, managed.parent_workspace_id);
    if (parent.managed) throw new Error("开发 workspace 的父目录必须是普通登记根");
    const canonical = await fs.realpath(directory);
    if (canonical !== directory || canonical === parent.path || !inside(parent.path, canonical)) {
      throw new Error("开发 workspace 必须位于原登记根内");
    }
    const registry = await readRegistry(path.resolve(home));
    const prior = registry.workspaces.find((entry) => entry.path === canonical);
    if (prior) {
      if (JSON.stringify(prior.managed) !== JSON.stringify(managed)) throw new Error("开发 workspace 绑定不一致");
      return publicWorkspace(prior);
    }
    const entry: WorkspaceRecord = {
      id: "ws_" + randomBytes(12).toString("hex"), label: boundedLabel(label) || "development",
      display: displayPath(path.resolve(home), canonical), path: canonical, managed: { ...managed },
    };
    registry.workspaces.push(entry);
    await writeRegistry(path.resolve(home), registry);
    return publicWorkspace(entry);
  });
}

/** List every durable registration, including temporarily unavailable roots. */
export async function listRegisteredWorkspaces(home: string): Promise<LocalWorkspace[]> {
  const registry = await readRegistry(path.resolve(home));
  return await directoryChecks(registry.workspaces, async (entry) => ({
    ...publicWorkspace(entry),
    path: entry.path,
    available: await workspaceIsLive(entry),
  }));
}

/** Removing a registration revokes future file/workspace authority immediately. */
export function removeWorkspace(home: string, id: string): Promise<boolean> {
  return registryWrite(home, () => removeWorkspaceLocked(home, id));
}
async function removeWorkspaceLocked(home: string, id: string): Promise<boolean> {
  requireWorkspaceId(id);
  const root = path.resolve(home);
  const registry = await readRegistry(root);
  const kept = registry.workspaces.filter((entry) => entry.id !== id);
  if (kept.length === registry.workspaces.length) return false;
  await writeRegistry(root, { version: REGISTRY_VERSION, workspaces: kept });
  return true;
}

export function renameWorkspace(home: string, id: string, label: string): Promise<PublicWorkspace> {
  return registryWrite(home, () => renameWorkspaceLocked(home, id, label));
}
async function renameWorkspaceLocked(home: string, id: string, label: string): Promise<PublicWorkspace> {
  requireWorkspaceId(id);
  const bounded = boundedLabel(label);
  if (!bounded) throw new Error("workspace label 不能为空");
  const root = path.resolve(home);
  const registry = await readRegistry(root);
  const entry = registry.workspaces.find((candidate) => candidate.id === id);
  if (!entry) throw new Error("workspace 不存在或未登记");
  entry.label = bounded;
  await writeRegistry(root, registry);
  return publicWorkspace(entry);
}

export async function listSessionWorkspaces(
  home: string,
  sessions: readonly SessionWorkspaceCandidate[] = [],
  options: { includeManaged?: boolean } = {},
): Promise<{ workspaces: PublicWorkspace[]; session_directories: SessionDirectoryAssociation[] }> {
  const workspaces = await navigableWorkspaces(home, options);

  // Session metadata may associate a session with an explicitly registered,
  // live workspace. It never creates a workspace: a historical transcript is
  // evidence that a directory once existed, not authority to put that directory
  // in today's navigation tree.
  const resolved = await resolveCandidates(sessions);

  // Conflicts are dropped rather than resolved. Two rows claiming the same
  // (source, id) with different directories is a scanner this code does not
  // understand, and picking one of them would report a directory a session is
  // not in.
  const associations = new Map<string, SessionDirectoryAssociation | null>();

  for (const candidate of resolved) {
    // The registered root that CONTAINS this directory, deepest first. A
    // session two levels inside a registered project belongs to that project;
    // it is not a project of its own, and registering it as one is how the
    // launch list fills up with one row per subdirectory anybody ever ran in.
    const container = deepestContainer(workspaces, candidate.canonical);
    if (!container) continue;

    if (candidate.key === null) continue;
    if (associations.size >= MAX_SESSION_DIRECTORIES && !associations.has(candidate.key)) continue;
    const relative = relativeWithin(container.path, candidate.canonical);
    // Refused rather than reported: a directory whose name carries a newline or
    // a backslash produces a relative path the reading side would reject
    // anyway, and one implementation of that sentence is the whole point of
    // `workspace-paths.ts`.
    if (relative === null) continue;
    const association: SessionDirectoryAssociation = {
      source: candidate.source,
      id: candidate.id,
      workspace_id: container.id,
      relative_path: relative,
    };
    const seen = associations.get(candidate.key);
    if (seen === undefined) associations.set(candidate.key, association);
    else if (seen === null || !sameAssociation(seen, association)) associations.set(candidate.key, null);
  }

  return {
    workspaces: workspaces.map(publicWorkspace),
    session_directories: [...associations.values()].filter(
      (entry): entry is SessionDirectoryAssociation => entry !== null,
    ),
  };
}

/** The registered workspaces that can be opened now, as the navigation listing reports them. */
async function navigableWorkspaces(home: string, options: { includeManaged?: boolean } = {}): Promise<WorkspaceRecord[]> {
  const registry = await readRegistry(path.resolve(home));
  // The registry is a durable user decision, but the roster is a snapshot of
  // what can be opened NOW. Do not delete an unavailable row here (a mounted
  // workspace may return); simply omit paths that no longer resolve to the
  // exact directory that was registered.
  const allowed = registry.workspaces.filter((entry) => (options.includeManaged !== false || !entry.managed)
    && workspaceVisible(entry, registry.workspaces));
  const workspaces = await liveRegisteredWorkspaces(allowed);
  // Parent revocation and mount changes invalidate managed children too.
  const liveIds = new Set(workspaces.map((entry) => entry.id));
  for (let index = workspaces.length - 1; index >= 0; index--) {
    const managed = workspaces[index].managed;
    if (managed && !liveIds.has(managed.parent_workspace_id)) workspaces.splice(index, 1);
  }
  return workspaces;
}

/**
 * The navigable workspace that holds `absolute` once symlinks are resolved,
 * deepest first, and the POSIX path inside it. Answers with an opaque id and a
 * relative path only; the absolute path never leaves the device.
 */
export async function placeInWorkspaces(home: string, absolute: string): Promise<WorkspacePlacement> {
  let canonical: string;
  try {
    canonical = await fs.realpath(absolute);
  } catch {
    return { placement: null, reason: "not_found" };
  }
  const container = deepestContainer(await navigableWorkspaces(home), canonical);
  const relative = container ? relativeWithin(container.path, canonical) : null;
  return container && relative !== null
    ? { placement: { workspace_id: container.id, relative_path: relative } }
    : { placement: null, reason: "outside" };
}

export type WorkspacePlacement =
  | { placement: { workspace_id: string; relative_path: string } }
  | { placement: null; reason: "not_found" | "outside" | "no_cwd" | "unavailable" };

/** Keep stale registry rows durable but out of the live navigation response. */
async function liveRegisteredWorkspaces(entries: readonly WorkspaceRecord[]): Promise<WorkspaceRecord[]> {
  const live = await directoryChecks(entries, async (entry) => await workspaceIsLive(entry) ? entry : null);
  return live.filter((entry): entry is WorkspaceRecord => entry !== null);
}

async function workspaceIsLive(entry: WorkspaceRecord): Promise<boolean> {
  try {
    const canonical = await fs.realpath(entry.path);
    const stat = await fs.stat(canonical);
    return stat.isDirectory() && canonical === entry.path;
  } catch {
    // Missing, inaccessible, or temporarily unavailable: not navigable now.
    return false;
  }
}

interface ResolvedCandidate {
  /**
   * `source:id`, or null when the candidate does not name a session completely.
   *
   * A candidate without a complete identity cannot produce an association.
   * It is still resolved uniformly so malformed metadata does not create a
   * separate path through the filesystem boundary.
   */
  key: string | null;
  source: Source;
  id: string;
  canonical: string;
}

/** Validate each distinct cwd once per request, then preserve every identity/conflict. */
async function resolveCandidates(sessions: readonly SessionWorkspaceCandidate[]): Promise<ResolvedCandidate[]> {
  const out: ResolvedCandidate[] = [];
  // Deduplicate only inside this request. Revalidate symlinks and liveness on
  // the next request; a successful old lookup never grants current authority.
  const cwds = [...new Set(sessions.flatMap((candidate) =>
    typeof candidate.cwd === "string" && path.isAbsolute(candidate.cwd) ? [candidate.cwd] : []))];
  const directories = await directoryChecks(cwds, async (cwd) => {
    try {
      const canonical = await fs.realpath(cwd);
      return (await fs.stat(canonical)).isDirectory() ? canonical : null;
    } catch { return null; }
  });
  const byCwd = new Map(cwds.map((cwd, index) => [cwd, directories[index]]));
  for (const candidate of sessions) {
    if (typeof candidate.cwd !== "string") continue;
    const canonical = byCwd.get(candidate.cwd);
    if (!canonical) continue;
    const source = ENUMERATED_SOURCES.includes(candidate.source as Source) ? candidate.source as Source : null;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const named = Boolean(source) && Boolean(id) && Buffer.byteLength(id, "utf8") <= MACHINE_LIMITS.sessionIdMaxBytes;
    out.push({
      key: named ? `${source}:${id}` : null,
      source: source ?? "claude",
      id,
      canonical,
    });
  }
  // Stable byte order keeps association output independent of scanner order.
  out.sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0));
  return out;
}

/** The registered root containing `canonical`, preferring the deepest one. */
function deepestContainer(entries: readonly WorkspaceRecord[], canonical: string): WorkspaceRecord | null {
  let best: WorkspaceRecord | null = null;
  for (const entry of entries) {
    if (!inside(entry.path, canonical)) continue;
    if (!best || entry.path.length > best.path.length) best = entry;
  }
  return best;
}

/** A POSIX relative path from a containing root, or null when it is unreportable. */
function relativeWithin(rootPath: string, canonical: string): string | null {
  const relative = path.relative(rootPath, canonical).split(path.sep).join("/");
  return workspaceRelativePathProblem(relative) === null ? relative : null;
}

function sameAssociation(a: SessionDirectoryAssociation, b: SessionDirectoryAssociation): boolean {
  return a.workspace_id === b.workspace_id && a.relative_path === b.relative_path;
}

/** Resolve an opaque id to a canonical directory without disclosing the path. */
export async function resolveWorkspace(home: string, id: string): Promise<WorkspaceRecord> {
  requireWorkspaceId(id);
  const registry = await readRegistry(path.resolve(home));
  const entry = registry.workspaces.find((candidate) => candidate.id === id);
  if (!entry) throw new Error("workspace 不存在或未登记");
  if (!workspaceVisible(entry, registry.workspaces)) throw new Error("workspace 不属于当前 Head 或父登记已撤销");
  if (entry.managed) {
    const parent = registry.workspaces.find((candidate) => candidate.id === entry.managed!.parent_workspace_id);
    if (!parent || parent.managed || !await workspaceIsLive(parent) || !inside(parent.path, entry.path)) {
      throw new Error("开发 workspace 父登记已撤销或路径变化");
    }
  }
  const canonical = await fs.realpath(entry.path);
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory() || canonical !== entry.path) {
    throw new Error("workspace 路径已经变化，请在 Runner 上重新登记");
  }
  return { ...entry };
}

function workspaceVisible(entry: WorkspaceRecord, all: readonly WorkspaceRecord[]): boolean {
  if (!entry.managed) return true;
  const site = workspaceSite.getStore();
  return (site === undefined || site === entry.managed.site)
    && all.some((parent) => parent.id === entry.managed!.parent_workspace_id && !parent.managed);
}

function requireWorkspaceId(id: string): void {
  if (!/^ws_[0-9a-f]{24}$/.test(id)) throw new Error("workspace_id 无效");
}

export function workspaceRegistryPath(home: string): string {
  return path.join(path.resolve(home), REGISTRY_DIR, REGISTRY_FILE);
}

async function readRegistry(home: string): Promise<WorkspaceRegistry> {
  const file = workspaceRegistryPath(home);
  let initialStat;
  try {
    initialStat = await fs.stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      registryCacheByFile.delete(file);
      return { version: REGISTRY_VERSION, workspaces: [] };
    }
    throw new Error(`无法读取 workspace 注册表: ${error instanceof Error ? error.message : String(error)}`);
  }

  const cached = registryCacheByFile.get(file);
  if (cached && cached.mtimeMs === initialStat.mtimeMs && cached.size === initialStat.size) {
    return cloneRegistry(cached.registry);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 workspace 注册表: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { workspaces?: unknown }).workspaces)
      ? (parsed as { workspaces: unknown[] }).workspaces
      : null;
  if (!raw) throw new Error("workspace 注册表格式无效");
  const workspaces = raw.map(validateRecord);
  if (new Set(workspaces.map((entry) => entry.id)).size !== workspaces.length) {
    throw new Error("workspace 注册表包含重复 id");
  }
  const registry: WorkspaceRegistry = { version: REGISTRY_VERSION, workspaces };

  // Cache only when the path still names the facts we just read. A concurrent
  // atomic replacement makes this call useful but deliberately uncacheable.
  try {
    const finalStat = await fs.stat(file);
    if (finalStat.mtimeMs === initialStat.mtimeMs && finalStat.size === initialStat.size) {
      rememberRegistry(file, finalStat.mtimeMs, finalStat.size, registry);
    }
  } catch {
    registryCacheByFile.delete(file);
  }
  return registry;
}

function cloneRegistry(registry: WorkspaceRegistry): WorkspaceRegistry {
  return {
    version: REGISTRY_VERSION,
    workspaces: registry.workspaces.map((entry) => ({ ...entry, ...(entry.managed ? { managed: { ...entry.managed } } : {}) })),
  };
}

function rememberRegistry(file: string, mtimeMs: number, size: number, registry: WorkspaceRegistry): void {
  if (!registryCacheByFile.has(file) && registryCacheByFile.size >= REGISTRY_CACHE_MAX_ENTRIES) {
    const oldest = registryCacheByFile.keys().next().value;
    if (oldest !== undefined) registryCacheByFile.delete(oldest);
  }
  registryCacheByFile.set(file, { mtimeMs, size, registry: cloneRegistry(registry) });
}

function validateRecord(value: unknown): WorkspaceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace 条目格式无效");
  const row = value as Record<string, unknown>;
  const id = String(row.id ?? "");
  const label = boundedLabel(row.label);
  const display = String(row.display ?? "").trim();
  const canonicalPath = String(row.path ?? "");
  if (!/^ws_[0-9a-f]{24}$/.test(id) || !label || !display || !path.isAbsolute(canonicalPath)) {
    throw new Error("workspace 条目缺少有效的 id/label/display/path");
  }
  let managed: ManagedWorkspaceBinding | undefined;
  if (row.managed !== undefined) {
    const m = row.managed as Record<string, unknown>;
    if (!m || typeof m !== "object" || Array.isArray(m)
      || typeof m.site !== "string" || !m.site || m.site.length > 100
      || typeof m.parent_workspace_id !== "string" || !/^ws_[0-9a-f]{24}$/.test(m.parent_workspace_id)
      || typeof m.repository_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(m.repository_id)
      || typeof m.development_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(m.development_id)) {
      throw new Error("开发 workspace 绑定格式无效");
    }
    managed = { site: m.site, parent_workspace_id: m.parent_workspace_id,
      repository_id: m.repository_id, development_id: m.development_id };
  }
  return { id, label, display: display.slice(0, 240), path: path.normalize(canonicalPath),
    ...(managed ? { managed } : {}) };
}

async function writeRegistry(home: string, registry: WorkspaceRegistry): Promise<void> {
  const dir = path.dirname(workspaceRegistryPath(home));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const target = workspaceRegistryPath(home);
  const temp = path.join(dir, `.workspaces.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(registry, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
    // The path now names new registry facts even if a later durability step
    // fails, so no reader may reuse the pre-rename parsed value.
    registryCacheByFile.delete(target);
    await fs.chmod(target, 0o600);
    await syncDirectory(dir);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

async function syncDirectory(dir: string): Promise<void> {
  // Windows rejects fsync on a directory handle (EPERM). The registry file
  // itself was already flushed before its atomic rename; do not report a
  // successfully written registration as failed because of a Unix-only step.
  if (process.platform === "win32") return;
  const handle = await fs.open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function publicWorkspace(entry: WorkspaceRecord): PublicWorkspace {
  return { id: entry.id, label: entry.label, display: entry.display };
}

function boundedLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function displayPath(home: string, canonical: string): string {
  const relative = path.relative(home, canonical);
  if (relative === "") return "~";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return `~/${relative.split(path.sep).join("/")}`;
  return `~/…/${path.basename(canonical)}`;
}

/** Display-only path form; never accepted by resolveWorkspace. */
export function workspaceDisplayPath(home: string, directory: string): string {
  if (!path.isAbsolute(directory)) return "";
  return displayPath(path.resolve(home), path.normalize(directory));
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
