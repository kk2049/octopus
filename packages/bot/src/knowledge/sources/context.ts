import fs from "node:fs/promises";
import path from "node:path";
import type { GitRunner } from "../git.js";
import { listTree, listWorktree, matchGlobs, readAt } from "../git.js";
import type { CoverageRow, KnowledgeEdge, KnowledgeNode } from "../model.js";

export interface AtlasModuleDef {
  id: string;
  label: string;
  description?: string;
  zone: string;
  criticality?: string;
  pathPrefixes: string[];
  tags?: string[];
  docs?: string[];
}

export interface AtlasDoc {
  system?: { id?: string; title?: string };
  zones?: Array<{ id: string; label: string; description?: string; trust?: string }>;
  modules?: AtlasModuleDef[];
  flows?: Array<{
    id: string;
    title: string;
    description?: string;
    perspective?: string;
    entrySteps?: Array<{ id: string; label: string; module?: string; zone?: string }>;
  }>;
  constraints?: Array<{
    id: string;
    title: string;
    description?: string;
    concern?: string;
    severity?: string;
    mechanism?: Record<string, unknown>;
    evidence?: Array<{ grade?: string; label?: string; description?: string; source?: { path?: string; line?: number; endLine?: number; symbol?: string }; document?: string; command?: string }>;
  }>;
}

/** Shared, read-only view of the repository at one commit for all source parsers. */
export interface SourceContext {
  repoDir: string;
  sha: string;
  /** Commit to use for history questions (`git log`, ranges); `HEAD` when building the working tree. */
  historyRef: string;
  /** ISO timestamp used for edge observation; fixed per build for determinism. */
  observedAt: string;
  /** Explicit date used to evaluate lifecycle and exception validity. */
  evaluationAsOf: string;
  git: GitRunner;
  atlas: AtlasDoc;
  modules: AtlasModuleDef[];
  list(patterns: readonly string[]): Promise<string[]>;
  read(path: string): Promise<string>;
  moduleForPath(path: string): string;
}

export interface SourceOutput {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  coverage: CoverageRow[];
  warnings: string[];
}

export function emptyOutput(): SourceOutput {
  return { nodes: [], edges: [], coverage: [], warnings: [] };
}

export function mergeOutputs(outputs: readonly SourceOutput[]): SourceOutput {
  const merged = emptyOutput();
  for (const output of outputs) {
    merged.nodes.push(...output.nodes);
    merged.edges.push(...output.edges);
    merged.coverage.push(...output.coverage);
    merged.warnings.push(...output.warnings);
  }
  return merged;
}

function normalizeRepoPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function prefixMatches(file: string, rawPrefix: string): boolean {
  const prefix = normalizeRepoPath(rawPrefix).replace(/^\//, "");
  if (prefix.endsWith("/")) return file.startsWith(prefix);
  return file === prefix || file.startsWith(`${prefix}/`);
}

/** Longest-prefix module ownership; mirrors architecture-observatory/analyzer/paths.ts. */
export function moduleForPath(filePath: string, modules: readonly AtlasModuleDef[]): string {
  const file = normalizeRepoPath(filePath);
  let match: { id: string; length: number } | null = null;
  for (const module of modules) {
    for (const prefix of module.pathPrefixes) {
      if (!prefixMatches(file, prefix)) continue;
      const length = normalizeRepoPath(prefix).length;
      if (!match || length > match.length) match = { id: module.id, length };
    }
  }
  return match?.id ?? "unmapped";
}

/**
 * Pseudo-ref for "the working tree as it is now": files are read from disk
 * and listed with `git ls-files` (tracked + untracked, excluding ignored), so
 * uncommitted capabilities, patterns or curated files can be validated and
 * built before they are committed. Commit-anchored facts (which commit
 * introduced a CLI report, exact ranges) still come from Git history.
 */
export const WORKTREE_REF = "WORKTREE";

export async function createSourceContext(args: {
  repoDir: string;
  sha: string;
  git: GitRunner;
  observedAt: string;
  evaluationAsOf?: string;
}): Promise<SourceContext> {
  const worktree = args.sha === WORKTREE_REF;
  const read = worktree
    ? (file: string) => fs.readFile(path.join(args.repoDir, file), "utf8")
    : (file: string) => readAt(args.git, args.sha, file);
  let listing: Promise<string[]> | null = null;
  const allFiles = () => {
    if (!listing) {
      listing = worktree
        ? listWorktree(args.git).then(async (files) => {
            const present: string[] = [];
            for (const file of files) {
              try {
                await fs.access(path.join(args.repoDir, file));
                present.push(file);
              } catch {
                // deleted in the working tree but still in the index
              }
            }
            return present;
          })
        : listTree(args.git, args.sha);
    }
    return listing;
  };
  const list = async (patterns: readonly string[]) => matchGlobs(await allFiles(), patterns);
  const atlas = JSON.parse(await read("architecture/atlas.json")) as AtlasDoc;
  const modules = atlas.modules ?? [];
  const cache = new Map<string, Promise<string>>();
  return {
    repoDir: args.repoDir,
    sha: args.sha,
    historyRef: worktree ? "HEAD" : args.sha,
    observedAt: args.observedAt,
    evaluationAsOf: args.evaluationAsOf ?? args.observedAt.slice(0, 10),
    git: args.git,
    atlas,
    modules,
    list,
    read: (file) => {
      let pending = cache.get(file);
      if (!pending) {
        pending = read(file);
        cache.set(file, pending);
      }
      return pending;
    },
    moduleForPath: (file) => moduleForPath(file, modules),
  };
}

/** Bounded concurrency helper for per-file Git reads. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
