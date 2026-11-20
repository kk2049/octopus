/**
 * Architecture evolution: the pure half of the commit-range view.
 *
 * The page asks "what changed between commit A and commit B?", and the answer
 * has two independent halves with very different costs:
 *
 * - ARCHITECTURE change is a set difference between two archived analysis
 *   snapshots (a full analysis takes ~19 minutes on this host, so it is never
 *   computed on demand — `ArchitectureService` archives each successful run
 *   and the diff picks the snapshot nearest each range endpoint).
 * - CODE change is a cheap read of git itself (`git log A..B --numstat`),
 *   aggregated onto the atlas's module vocabulary. This half is always
 *   available, even before a second snapshot exists.
 *
 * Everything in this file is a deterministic function over strings and plain
 * data: log parsing, path→module attribution, aggregation and the snapshot
 * diff. `ArchitectureService` owns the git subprocess and the snapshot files
 * and calls down into these; the split is what makes the range math testable
 * without a repository.
 */

import type { ArchitectureView } from "./architecture.js";

/**
 * `%x1f` (ASCII unit separator) delimits the fixed fields of one commit line;
 * a tab would collide with `--numstat`'s own separator and with subjects that
 * contain tabs.
 */
export const GIT_FIELD_SEP = "\u001f";
/** Marks a commit header line in `--numstat` output (see `parseNumstatLog`). */
export const GIT_COMMIT_MARK = "@@";
/** The `--format` string both git readers share. */
export const GIT_COMMIT_FORMAT = "%H%x1f%aI%x1f%an%x1f%s";

/** Commits our own commit listing produced are full hex; accept abbreviated. */
export const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;

// ── Wire shapes (mirrored by the browser page, field names are contract) ────

export interface EvolutionCommit {
  sha: string;
  /** Author date, ISO 8601 (`%aI`). */
  date: string;
  author: string;
  subject: string;
}

export interface RangeFileChange {
  path: string;
  additions: number;
  deletions: number;
}

/** One commit of `git log --numstat` output, with its touched files. */
export interface RangeCommit extends EvolutionCommit {
  files: RangeFileChange[];
}

export interface ModuleCodeChange {
  /** Atlas module id, or {@link UNMAPPED_MODULE} for paths no rule owns. */
  moduleId: string;
  additions: number;
  deletions: number;
  /** Commits in the range that touched this module. */
  commits: number;
  /** Heaviest touched files, bounded — `filesTotal` keeps the honest count. */
  files: RangeFileChange[];
  filesTotal: number;
}

export interface CodeChangeSummary {
  /** Exact commit count of the range (`rev-list --count`). */
  commitCount: number;
  /** Commits whose numstat actually entered the aggregation (bounded). */
  aggregatedCommits: number;
  additions: number;
  deletions: number;
  /** Sorted by churn (additions+deletions) descending. */
  modules: ModuleCodeChange[];
  /** Newest first, bounded — compare with `commitCount` for truncation. */
  commits: EvolutionCommit[];
}

export interface SnapshotRef {
  commit: string;
  branch: string;
  dirty: boolean;
  generatedAt: string;
}

export interface ArchitectureTotals {
  files: number;
  codeLoc: number;
  symbols: number;
  calls: number;
  annotations: number;
}

export interface ModuleDiffEntry {
  id: string;
  label: string;
  zone: string;
  codeLoc: number;
  files: number;
}

export interface ModuleResize {
  id: string;
  label: string;
  zone: string;
  codeLocBefore: number;
  codeLocAfter: number;
  filesBefore: number;
  filesAfter: number;
}

export interface DependencyEdgeRef {
  from: string;
  to: string;
}

export interface ArchitectureDiff {
  base: SnapshotRef;
  head: SnapshotRef;
  modules: {
    added: ModuleDiffEntry[];
    removed: ModuleDiffEntry[];
    /** Modules present on both sides whose codeLoc or file count moved. */
    resized: ModuleResize[];
  };
  dependencies: {
    added: Array<DependencyEdgeRef & { runtimeCount: number; dynamicCount: number; circular: boolean }>;
    removed: DependencyEdgeRef[];
    becameCircular: DependencyEdgeRef[];
    becameAcyclic: DependencyEdgeRef[];
  };
  constraints: {
    added: Array<{ id: string; title: string; status: string }>;
    removed: Array<{ id: string; title: string }>;
    changed: Array<{ id: string; title: string; before: string; after: string }>;
  };
  totals: { before: ArchitectureTotals; after: ArchitectureTotals };
}

// ── git log parsing ─────────────────────────────────────────────────────────

/** Parse `git log --format=` {@link GIT_COMMIT_FORMAT} output, order preserved. */
export function parseCommitLog(output: string): EvolutionCommit[] {
  const commits: EvolutionCommit[] = [];
  for (const line of output.split(/\r?\n/)) {
    const commit = parseCommitLine(line);
    if (commit) commits.push(commit);
  }
  return commits;
}

function parseCommitLine(line: string): EvolutionCommit | null {
  // limit 4: a subject containing the separator stays one subject.
  const [sha, date, author, ...rest] = line.split(GIT_FIELD_SEP);
  if (!sha || !COMMIT_SHA_RE.test(sha) || date === undefined || author === undefined) return null;
  return { sha, date, author, subject: rest.join(GIT_FIELD_SEP) };
}

/**
 * Parse `git log --format=@@<fields> --numstat --no-renames` output into
 * per-commit records. The same framing trick as the analyzer's
 * `gitFileHistory`, except nothing is folded — the evolution view needs each
 * commit's own file list, not a cumulative scalar.
 */
export function parseNumstatLog(output: string): RangeCommit[] {
  const commits: RangeCommit[] = [];
  let current: RangeCommit | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(GIT_COMMIT_MARK)) {
      const commit = parseCommitLine(line.slice(GIT_COMMIT_MARK.length));
      current = commit ? { ...commit, files: [] } : null;
      if (current) commits.push(current);
      continue;
    }
    if (!current) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    current.files.push({
      path: normalizeRepoPath(match[3]),
      // "-" is a binary file: counted as touched, contributing zero lines.
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return commits;
}

// ── path → module attribution ───────────────────────────────────────────────

/** The atlas config subset the mapper reads (`architecture/atlas.json`). */
export interface ModuleRule {
  id: string;
  pathPrefixes: string[];
}

export const UNMAPPED_MODULE = "(unmapped)";

/** Same normalisation as the analyzer's `normalizeRepoPath`. */
export function normalizeRepoPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

/**
 * Longest-prefix attribution, the same rule the analyzer applies to its file
 * table (`architecture-observatory/src/analyzer/paths.ts`): a prefix ending in
 * `/` matches inside the directory, otherwise it matches the exact path or the
 * subtree below it. `null` when no rule owns the path.
 */
export function moduleForPath(filePath: string, rules: ModuleRule[]): string | null {
  const file = normalizeRepoPath(filePath);
  let match: { id: string; length: number } | null = null;
  for (const rule of rules) {
    for (const rawPrefix of rule.pathPrefixes) {
      const prefix = normalizeRepoPath(rawPrefix).replace(/^\//, "");
      const hit = prefix.endsWith("/")
        ? file.startsWith(prefix)
        : file === prefix || file.startsWith(`${prefix}/`);
      if (!hit) continue;
      if (!match || prefix.length > match.length) match = { id: rule.id, length: prefix.length };
    }
  }
  return match?.id ?? null;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export interface AggregateLimits {
  /** Top touched files kept per module. */
  moduleFiles: number;
  /** Commits kept in the response list (aggregation still covers all input). */
  commits: number;
}

/**
 * Fold per-commit numstat records onto the module vocabulary.
 *
 * The full input always enters the totals and per-module sums; the limits only
 * bound what is LISTED (top files per module, newest commits), so a truncated
 * response never lies about magnitude.
 */
export function aggregateCodeChanges(
  commits: RangeCommit[],
  rules: ModuleRule[],
  commitCount: number,
  limits: AggregateLimits,
): CodeChangeSummary {
  const modules = new Map<string, { additions: number; deletions: number; commits: number; files: Map<string, RangeFileChange> }>();
  let additions = 0;
  let deletions = 0;
  for (const commit of commits) {
    const touched = new Set<string>();
    for (const file of commit.files) {
      const moduleId = moduleForPath(file.path, rules) ?? UNMAPPED_MODULE;
      const bucket =
        modules.get(moduleId) ??
        { additions: 0, deletions: 0, commits: 0, files: new Map<string, RangeFileChange>() };
      modules.set(moduleId, bucket);
      bucket.additions += file.additions;
      bucket.deletions += file.deletions;
      additions += file.additions;
      deletions += file.deletions;
      if (!touched.has(moduleId)) {
        touched.add(moduleId);
        bucket.commits += 1;
      }
      const record = bucket.files.get(file.path) ?? { path: file.path, additions: 0, deletions: 0 };
      record.additions += file.additions;
      record.deletions += file.deletions;
      bucket.files.set(file.path, record);
    }
  }
  const moduleList: ModuleCodeChange[] = [...modules.entries()]
    .map(([moduleId, bucket]) => {
      const files = [...bucket.files.values()].sort(
        (a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path),
      );
      return {
        moduleId,
        additions: bucket.additions,
        deletions: bucket.deletions,
        commits: bucket.commits,
        files: files.slice(0, limits.moduleFiles),
        filesTotal: files.length,
      };
    })
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.moduleId.localeCompare(b.moduleId));
  return {
    commitCount,
    aggregatedCommits: commits.length,
    additions,
    deletions,
    modules: moduleList,
    commits: commits.slice(0, limits.commits).map(({ files: _files, ...commit }) => commit),
  };
}

// ── Snapshot endpoint resolution ────────────────────────────────────────────

/**
 * The archived snapshot nearest a range endpoint, measured in commits along
 * `order` (sha → position, 0 = newest). Nearest-point projection on a line is
 * monotone, so resolving both endpoints can never invert base past head; when
 * both endpoints resolve to the SAME snapshot the caller reports "no
 * architecture history in this range" instead of inventing a diff. Ties break
 * toward the newer snapshot, deterministically.
 */
export function nearestSnapshotCommit(
  order: ReadonlyMap<string, number>,
  snapshotCommits: readonly string[],
  endpoint: string,
): string | null {
  const at = order.get(endpoint);
  if (at === undefined) return null;
  let best: { sha: string; distance: number; position: number } | null = null;
  for (const sha of snapshotCommits) {
    const position = order.get(sha);
    if (position === undefined) continue;
    const distance = Math.abs(position - at);
    if (!best || distance < best.distance || (distance === best.distance && position < best.position)) {
      best = { sha, distance, position };
    }
  }
  return best?.sha ?? null;
}

// ── Snapshot set difference ─────────────────────────────────────────────────

function isValueEdge(edge: ArchitectureView["dependencies"][number]): boolean {
  // The page's own definition of a runtime edge (`model.ts` isRuntime):
  // type-only and test-only records are not architecture.
  return (edge.runtimeCount ?? 0) > 0 || (edge.dynamicCount ?? 0) > 0;
}

function edgeName(edge: DependencyEdgeRef): string {
  return `${edge.from} ${edge.to}`;
}

function snapshotRef(view: ArchitectureView): SnapshotRef {
  return {
    commit: view.meta.commit,
    branch: view.meta.branch,
    dirty: view.meta.dirty,
    generatedAt: view.meta.generatedAt,
  };
}

/**
 * The set difference between two projected snapshots: module add/remove/resize,
 * value-dependency add/remove and circularity transitions, constraint verdict
 * changes, and the totals. Pure — both sides are the server's own projections,
 * and every list is keyed on stable ids so the output is deterministic.
 */
export function diffArchitectureViews(base: ArchitectureView, head: ArchitectureView): ArchitectureDiff {
  const baseModules = new Map(base.modules.map((m) => [m.id, m]));
  const headModules = new Map(head.modules.map((m) => [m.id, m]));

  const moduleEntry = (m: ArchitectureView["modules"][number]): ModuleDiffEntry => ({
    id: m.id,
    label: m.label,
    zone: m.zone,
    codeLoc: m.codeLoc,
    files: m.files,
  });
  const added = head.modules.filter((m) => !baseModules.has(m.id)).map(moduleEntry);
  const removed = base.modules.filter((m) => !headModules.has(m.id)).map(moduleEntry);
  const resized: ModuleResize[] = [];
  for (const after of head.modules) {
    const before = baseModules.get(after.id);
    if (!before) continue;
    if (before.codeLoc === after.codeLoc && before.files === after.files) continue;
    resized.push({
      id: after.id,
      label: after.label,
      zone: after.zone,
      codeLocBefore: before.codeLoc,
      codeLocAfter: after.codeLoc,
      filesBefore: before.files,
      filesAfter: after.files,
    });
  }
  resized.sort(
    (a, b) =>
      Math.abs(b.codeLocAfter - b.codeLocBefore) - Math.abs(a.codeLocAfter - a.codeLocBefore) ||
      a.id.localeCompare(b.id),
  );

  const baseEdges = new Map(base.dependencies.filter(isValueEdge).map((e) => [edgeName(e), e]));
  const headEdges = new Map(head.dependencies.filter(isValueEdge).map((e) => [edgeName(e), e]));
  const edgesAdded = [...headEdges.values()]
    .filter((e) => !baseEdges.has(edgeName(e)))
    .map((e) => ({
      from: e.from,
      to: e.to,
      runtimeCount: e.runtimeCount,
      dynamicCount: e.dynamicCount,
      circular: e.circular,
    }));
  const edgesRemoved = [...baseEdges.values()]
    .filter((e) => !headEdges.has(edgeName(e)))
    .map((e) => ({ from: e.from, to: e.to }));
  const becameCircular: DependencyEdgeRef[] = [];
  const becameAcyclic: DependencyEdgeRef[] = [];
  for (const [key, after] of headEdges) {
    const before = baseEdges.get(key);
    if (!before || before.circular === after.circular) continue;
    (after.circular ? becameCircular : becameAcyclic).push({ from: after.from, to: after.to });
  }

  const baseConstraints = new Map(base.constraints.map((c) => [c.id, c]));
  const headConstraints = new Map(head.constraints.map((c) => [c.id, c]));
  const constraintsAdded = head.constraints
    .filter((c) => !baseConstraints.has(c.id))
    .map((c) => ({ id: c.id, title: c.title, status: c.status }));
  const constraintsRemoved = base.constraints
    .filter((c) => !headConstraints.has(c.id))
    .map((c) => ({ id: c.id, title: c.title }));
  const constraintsChanged = head.constraints.flatMap((after) => {
    const before = baseConstraints.get(after.id);
    if (!before || before.status === after.status) return [];
    return [{ id: after.id, title: after.title, before: before.status, after: after.status }];
  });

  return {
    base: snapshotRef(base),
    head: snapshotRef(head),
    modules: { added, removed, resized },
    dependencies: {
      added: edgesAdded,
      removed: edgesRemoved,
      becameCircular,
      becameAcyclic,
    },
    constraints: { added: constraintsAdded, removed: constraintsRemoved, changed: constraintsChanged },
    totals: { before: base.meta.totals, after: head.meta.totals },
  };
}
