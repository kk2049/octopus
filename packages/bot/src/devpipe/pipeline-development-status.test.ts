import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WORKSPACE_DEVELOPMENT_PROTOCOL } from "@claude-bot/runner/workspace-development-protocol";
import { Store } from "../store/store.js";
import { DevPipeline, type StatusResult } from "./pipeline.js";
import { BundleHandoff } from "./bundle-handoff.js";
import { gitOrThrow } from "./worktree.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(development = true) {
  const root = await mkdtemp(path.join(tmpdir(), "development-status-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "head");
  await gitOrThrow(root, ["init", "-b", "v4", repo]);
  await gitOrThrow(repo, ["config", "user.name", "Status Test"]);
  await gitOrThrow(repo, ["config", "user.email", "test@example.test"]);
  await writeFile(path.join(repo, "source.txt"), "old Runner base\n");
  await gitOrThrow(repo, ["add", "source.txt"]); await gitOrThrow(repo, ["commit", "-m", "base"]);
  const old = await gitOrThrow(repo, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repo, "source.txt"), "new Head authority\n");
  await gitOrThrow(repo, ["add", "source.txt"]); await gitOrThrow(repo, ["commit", "-m", "advance Head"]);
  const current = await gitOrThrow(repo, ["rev-parse", "HEAD"]);
  const store = new Store(path.join(root, "store.db")); cleanups.push(async () => store.close());
  store.saveUser({ username: "alice", uid: 1, home_dir: root, created_at: new Date().toISOString() });
  const ticket = store.devTickets.createDevTicket({ requester: "alice", title: "status", body: "task", model: "codex-gpt-6-astra", effort: "xhigh", kind: "simple", app_id: null });
  store.devTickets.updateDevTicket(ticket.id, { worktree: repo, branch: "v4" });
  const parent = "ws_" + "a".repeat(24), child = "ws_" + "b".repeat(24);
  if (development) store.devTickets.development.bind({ ticketId: ticket.id, owner: "alice", device: "execution", parentWorkspaceId: parent,
    worktreeWorkspaceId: child, repositoryId: "octopus", developmentId: "ticket-dev", baseSha: old });
  const snapshot = { worktree_workspace_id: child, base_sha: old, head_sha: old, synced_head_sha: old, dirty: false, conflicted: false };
  let available = true;
  const call = vi.fn(async (_binding: unknown, method: string) => {
    if (method !== "workspace_development_status") throw new Error("status must not dispatch a mutation");
    return { protocol: WORKSPACE_DEVELOPMENT_PROTOCOL, workspace_id: parent, repository_id: "octopus", development_id: "ticket-dev", ticket_id: ticket.id,
      development: { ...snapshot } };
  });
  const pipe = new DevPipeline({ store, repoDir: repo, worktreesDir: root, baseBranch: "v4", buildWarmEnabled: false, knowledgeCaptureEnabled: false, pushRemote: null });
  cleanups.push(() => pipe.stop());
  pipe.setDevelopmentWorkspaces({ repositoryId: "octopus", stateDir: path.join(root, "development"), publicUrl: "https://head.example.test", bundles: new BundleHandoff(),
    available: () => available, call }, () => { throw new Error("status must not issue provider credentials"); });
  const token = "status-live-turn";
  (pipe as unknown as { turnTokens: Map<string, { ticketId: number; turn: number }> }).turnTokens.set(token, { ticketId: ticket.id, turn: 1 });
  return { repo, current, old, snapshot, call, read: () => pipe.toolStatus(token) as Promise<StatusResult>, offline: () => { available = false; } };
}

it("reports the older actual Runner HEAD even when the Head candidate already equals current authority", async () => {
  const f = await fixture();
  const status = await f.read();
  expect(status).toMatchObject({ behind_base: 1, ahead_of_base: 0,
    development: { state: "available", current_head_sha: f.current, sync_required: true, rebase_required: true, snapshot: { head_sha: f.old } } });
  expect(status.message).toContain("需要 devpipe_workspace_sync");
  expect(f.call).toHaveBeenCalledOnce();
  expect(await gitOrThrow(f.repo, ["rev-parse", "HEAD"])).toBe(f.current);
  expect(await gitOrThrow(f.repo, ["status", "--porcelain"])).toBe("");
});

it("returns real dirty and conflicted facts without attempting candidate import", async () => {
  const f = await fixture(); f.snapshot.dirty = true; f.snapshot.conflicted = true;
  f.snapshot.synced_head_sha = f.current;
  const status = await f.read();
  expect(status.development).toMatchObject({ state: "available", sync_required: false, rebase_required: true,
    snapshot: { dirty: true, conflicted: true, head_sha: f.old } });
  expect(status.message).toContain("有未提交改动");
  expect(status.message).toContain("未完成的 Git 操作或冲突");
  expect(f.call).toHaveBeenCalledOnce();
});

it("keeps counts and ancestry unknown for an unimported Runner commit instead of reporting zero", async () => {
  const f = await fixture(); f.snapshot.head_sha = "f".repeat(40);
  const status = await f.read();
  expect(status.behind_base).toBeUndefined(); expect(status.ahead_of_base).toBeUndefined();
  expect(status.development).toMatchObject({ state: "available", rebase_required: null, snapshot: { head_sha: "f".repeat(40) } });
  expect(status.message).not.toContain("落后 v4 0");
  expect(f.call).toHaveBeenCalledOnce();
});

it("does not fall back to a successful Head candidate status when the Runner is unavailable", async () => {
  const f = await fixture(); f.offline();
  const status = await f.read();
  expect(status.development).toMatchObject({ state: "unavailable", current_head_sha: f.current });
  expect(status.development?.snapshot).toBeUndefined();
  expect(status.behind_base).toBeUndefined(); expect(status.ahead_of_base).toBeUndefined();
  expect(status.message).not.toContain("落后 v4 0");
  expect(f.call).not.toHaveBeenCalled();
});

it("keeps legacy Head-local status counts unchanged", async () => {
  const f = await fixture(false);
  expect(await f.read()).toMatchObject({ behind_base: 0, ahead_of_base: 0 });
  expect((await f.read()).development).toBeUndefined();
  expect(f.call).not.toHaveBeenCalled();
});
