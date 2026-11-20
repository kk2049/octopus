import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTicketWorktree,
  git,
  gitOrThrow,
  removeTicketWorktree,
  sweepScratchWorktrees,
  ticketBranch,
  ticketSlug,
  worktreeHoldingBranch,
} from "./worktree.js";

describe("ticketSlug / ticketBranch", () => {
  it("slugifies ascii, falls back for CJK-only titles, caps length", () => {
    expect(ticketSlug("Add SSE live view!")).toBe("add-sse-live-view");
    expect(ticketSlug("修复看板卡片")).toBe("dev");
    expect(ticketSlug("x".repeat(60)).length).toBeLessThanOrEqual(24);
    expect(ticketBranch(7, "Fix login bug")).toBe("ticket/7-fix-login-bug");
  });
});

describe("worktree lifecycle against a real repo", () => {
  let dir: string;
  let repo: string;
  let wts: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "devwt-"));
    repo = join(dir, "repo");
    wts = join(dir, "worktrees");
    await gitOrThrow(dir, ["init", "-b", "main", repo]);
    writeFileSync(join(repo, "a.txt"), "hello\n");
    await gitOrThrow(repo, ["add", "a.txt"]);
    await gitOrThrow(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
  }, 20_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a worktree on a fresh ticket branch, is idempotent, and removal keeps the branch", async () => {
    const { dir: wt, branch } = await createTicketWorktree(repo, wts, 3, "Add feature X");
    expect(branch).toBe("ticket/3-add-feature-x");
    expect(existsSync(join(wt, "a.txt"))).toBe(true);
    expect(await gitOrThrow(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branch);

    // Idempotent re-entry (crash recovery): same dir handed back untouched.
    const again = await createTicketWorktree(repo, wts, 3, "Add feature X");
    expect(again.dir).toBe(wt);

    // Commit work on the branch, remove the worktree — the branch survives.
    writeFileSync(join(wt, "b.txt"), "work\n");
    await gitOrThrow(wt, ["add", "b.txt"]);
    await gitOrThrow(wt, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "ticket work"]);
    expect(await removeTicketWorktree(repo, wt)).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect((await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`])).ok).toBe(true);

    // Branch exists now → a new worktree ATTACHES to it (work intact).
    const back = await createTicketWorktree(repo, wts, 3, "Add feature X");
    expect(existsSync(join(back.dir, "b.txt"))).toBe(true);
  }, 30_000);

  it("finds the registered worktree that holds a branch", async () => {
    expect(await worktreeHoldingBranch(repo, "main")).toBe(repo);
    expect(await worktreeHoldingBranch(repo, "does-not-exist")).toBeNull();
  });
});

describe("sweeping leftover scratch worktrees", () => {
  it("removes only old, unused, matching directories and their registrations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devsweep-"));
    try {
      const repo = join(dir, "repo"), wts = join(dir, "worktrees");
      await gitOrThrow(dir, ["init", "-b", "main", repo]);
      writeFileSync(join(repo, "a.txt"), "hello\n");
      await gitOrThrow(repo, ["add", "a.txt"]);
      await gitOrThrow(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
      const sha = await gitOrThrow(repo, ["rev-parse", "HEAD"]);
      const at = (name: string) => join(wts, name);
      await gitOrThrow(repo, ["worktree", "add", "--detach", at(`_graph-${sha}`), sha]); // legacy full checkout
      await gitOrThrow(repo, ["worktree", "add", "--detach", "--no-checkout", at(`_graph-${sha}-0000beef`), sha]); // in use
      await gitOrThrow(repo, ["worktree", "add", "--detach", "--no-checkout", at(`_graph-${sha}-0000cafe`), sha]); // too young
      await gitOrThrow(repo, ["worktree", "add", "--detach", at("_land"), sha]); // not ours
      mkdirSync(at("_deploy-review-AbC123")); // a crashed plain scratch dir
      writeFileSync(join(at("_deploy-review-AbC123"), "graph.db"), "x");
      const old = new Date(Date.now() - 3 * 3600_000);
      for (const name of [`_graph-${sha}`, `_graph-${sha}-0000beef`, "_land", "_deploy-review-AbC123"]) utimesSync(at(name), old, old);

      const removed = await sweepScratchWorktrees({
        repoDir: repo, worktreesDir: wts, minAgeMs: 3600_000,
        pattern: /^_(?:graph-[0-9a-f]{40}(?:-[0-9a-f]{8})?|deploy-review-[A-Za-z0-9]{6})$/,
        inUse: (d) => d === at(`_graph-${sha}-0000beef`),
      });
      expect(removed).toBe(2);
      expect(existsSync(at(`_graph-${sha}`))).toBe(false);
      expect(existsSync(at("_deploy-review-AbC123"))).toBe(false);
      for (const kept of [`_graph-${sha}-0000beef`, `_graph-${sha}-0000cafe`, "_land"]) expect(existsSync(at(kept))).toBe(true);
      const list = await gitOrThrow(repo, ["worktree", "list", "--porcelain"]);
      expect(list).not.toContain(`_graph-${sha}\n`);
      expect(list).toContain("_land");
      expect(await sweepScratchWorktrees({ repoDir: repo, worktreesDir: join(dir, "missing"), pattern: /./, minAgeMs: 0 })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
