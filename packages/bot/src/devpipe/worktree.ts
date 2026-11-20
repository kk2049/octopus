/**
 * Ticket worktree management — ring 2 of the trust model
 * (doc/design-self-hosting.md): each ticket gets its own `git worktree` on
 * its own `ticket/<id>-<slug>` branch, so the dev agent never touches the
 * live checkout. All git runs as a direct child (no shell); helpers are
 * deliberately idempotent so a pipeline resumed after a crash can re-enter
 * them (existing worktree dir → reuse, existing branch → attach).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runChild } from "./child-output.js";

const GIT_TIMEOUT_MS = 120_000;

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Error → message, without the stack. Lives here rather than in `pipeline.ts`
 * because `app-releases.ts` needs it too and both already depend on this
 * module — importing it from `pipeline.ts` would have made a runtime cycle.
 */
export function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run git to completion and return its whole output. There is no output cap:
 * a large diff, log or tree listing is an answer, not a failure (the old 8 MiB
 * `maxBuffer` killed git and reported it as failed). The only bound left is
 * the physical one of a single JavaScript string, reported as a failure that
 * says so. Callers that read a blob of arbitrary size stream it instead.
 */
export async function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  const run = await runChild("git", args, { cwd, timeoutMs });
  const e = run.error;
  let stdout: string;
  let stderr: string;
  try {
    stdout = run.stdout.text();
    stderr = run.stderr.text();
  } catch (error) {
    return { ok: false, stdout: "", stderr: msg(error), code: null };
  }
  return {
    ok: !e,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    code: typeof e?.code === "number" ? e.code : e ? null : 0,
  };
}

export async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout || r.code}`);
  return r.stdout;
}

/**
 * Return the worktree that currently holds `branch`, if any.
 *
 * A watermark may be held by the primary clean reference worktree instead of
 * a pipeline-created `_base-*` tree. Git itself is the registry here; keeping
 * a second path setting would recreate the drift this lookup is meant to
 * remove.
 */
export async function worktreeHoldingBranch(repoDir: string, branch: string): Promise<string | null> {
  const listing = await gitOrThrow(repoDir, ["worktree", "list", "--porcelain"]);
  const wanted = `refs/heads/${branch}`;
  let worktree: string | null = null;
  for (const line of listing.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      worktree = line.slice("worktree ".length);
    } else if (line === `branch ${wanted}` && worktree) {
      return worktree;
    } else if (line === "") {
      worktree = null;
    }
  }
  return null;
}

/** ASCII slug of a ticket title; CJK-only titles fall back to "dev". */
export function ticketSlug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return s || "dev";
}

export function ticketBranch(id: number, title: string): string {
  return `ticket/${id}-${ticketSlug(title)}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create (or re-attach) the worktree for a ticket, branched from `baseRef`.
 * Reuse rules: dir already present → hand it back untouched (crash
 * recovery); branch already present → attach a worktree to it rather than
 * recreating, so committed work survives a bot restart.
 */
export async function createTicketWorktree(
  repoDir: string,
  worktreesDir: string,
  ticketId: number,
  title: string,
  baseRef = "main",
): Promise<{ dir: string; branch: string }> {
  const branch = ticketBranch(ticketId, title);
  const dir = path.join(worktreesDir, `ticket-${ticketId}`);
  if (await exists(dir)) return { dir, branch };
  await fs.mkdir(worktreesDir, { recursive: true });
  const branchExists = (await git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
  if (branchExists) {
    await gitOrThrow(repoDir, ["worktree", "add", dir, branch]);
  } else {
    await gitOrThrow(repoDir, ["worktree", "add", "-b", branch, dir, baseRef]);
  }
  return { dir, branch };
}

/**
 * Create (or reset) a scratch worktree parked at `ref` in DETACHED state.
 *
 * Used by the human-lane landing gate (`DevPipeline.land`): the gate must run
 * against exactly the sha that is about to land, and a buffer branch's own
 * worktree is a live desk — another agent may be editing it, and uncommitted
 * files would silently become part of what the gate tested but not part of
 * what ships. Detaching at the sha removes that gap.
 *
 * `clean -fd` (deliberately NOT `-fdx`): tracked leftovers go, gitignored
 * build state — above all `node_modules` — survives, so the second land does
 * not pay for a fresh install.
 */
export async function ensureDetachedWorktree(repoDir: string, dir: string, ref: string): Promise<string> {
  if (await exists(dir)) {
    const probe = await git(dir, ["rev-parse", "--git-dir"]);
    if (!probe.ok) throw new Error(`${dir} 已存在但不是 git worktree,请人工清理后重试`);
    await gitOrThrow(dir, ["checkout", "--force", "--detach", ref]);
    await git(dir, ["clean", "-fd"]);
    return dir;
  }
  await fs.mkdir(path.dirname(dir), { recursive: true });
  // A dir removed behind git's back leaves a stale registration that makes
  // `worktree add` fail with "already registered".
  await git(repoDir, ["worktree", "prune"]);
  await gitOrThrow(repoDir, ["worktree", "add", "--detach", dir, ref]);
  return dir;
}

/** Remove a ticket worktree (the branch stays — it holds the work). */
export async function removeTicketWorktree(repoDir: string, dir: string): Promise<boolean> {
  const r = await git(repoDir, ["worktree", "remove", "--force", dir]);
  return r.ok;
}

/**
 * Remove scratch worktrees that an earlier process left behind.
 *
 * Only direct children of `worktreesDir` whose names match `pattern`, older
 * than `minAgeMs` and not reported by `inUse` are touched; ticket trees,
 * `_land` and `_warm` never match. One directory at a time with a pause in
 * between, so a large backlog becomes a trickle of unlinks rather than an I/O
 * burst on a rate-limited disk. Git's child process does the deleting.
 */
export async function sweepScratchWorktrees(opts: {
  repoDir: string;
  worktreesDir: string;
  pattern: RegExp;
  minAgeMs: number;
  inUse?: (dir: string) => boolean;
  pauseMs?: number;
  signal?: AbortSignal;
}): Promise<number> {
  let names: string[];
  try {
    names = (await fs.readdir(opts.worktreesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && opts.pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names) {
    if (opts.signal?.aborted) break;
    const dir = path.join(opts.worktreesDir, name);
    if (opts.inUse?.(dir)) continue;
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs < opts.minAgeMs) continue;
    if (!(await git(opts.repoDir, ["worktree", "remove", "--force", dir])).ok) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    removed++;
    if (opts.pauseMs) await delay(opts.pauseMs, undefined, { signal: opts.signal }).catch(() => undefined);
  }
  // A directory deleted by the fallback above leaves its registration behind.
  if (removed) await git(opts.repoDir, ["worktree", "prune"]);
  return removed;
}
