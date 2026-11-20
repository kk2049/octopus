import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WORKSPACE_DEVELOPMENT_PROTOCOL, type WorkspaceDevelopmentMethod } from "@claude-bot/runner/workspace-development-protocol";
import { Store } from "../store/store.js";
import { BundleHandoff } from "./bundle-handoff.js";
import { DevelopmentWorkspaceService } from "./development-workspace.js";
import { gitOrThrow } from "./worktree.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const parent = "ws_" + "a".repeat(24), child = "ws_" + "b".repeat(24);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "head-development-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "head"), remote = path.join(root, "runner"), candidateDir = path.join(root, "candidate");
  await gitOrThrow(root, ["init", "-b", "v4", repo]);
  for (const [key, value] of [["user.name", "Development Test"], ["user.email", "test@example.test"]]) await gitOrThrow(repo, ["config", key!, value!]);
  await writeFile(path.join(repo, "source.txt"), "base\n");
  await gitOrThrow(repo, ["add", "source.txt"]); await gitOrThrow(repo, ["commit", "-m", "base"]);
  const base = await gitOrThrow(repo, ["rev-parse", "HEAD"]);
  await gitOrThrow(root, ["clone", repo, remote]);
  for (const [key, value] of [["user.name", "Development Test"], ["user.email", "test@example.test"]]) await gitOrThrow(remote, ["config", key!, value!]);
  await gitOrThrow(repo, ["worktree", "add", "-b", "ticket/1", candidateDir, base]);
  const store = new Store(path.join(root, "store.db")); cleanups.push(async () => store.close());
  store.saveUser({ username: "alice", uid: 1, home_dir: root, created_at: new Date().toISOString() });
  const ticket = store.devTickets.createDevTicket({ title: "remote code", body: "task", requester: "alice", model: "codex-gpt-6-astra", effort: "xhigh", kind: "simple", app_id: null });
  const runner = { owner: "alice", device: "model-head", executionDevice: "execution", workspaceId: parent, source: "codex" as const };
  let head = base, synced = base, dirty = false, corrupt = false, wrongIdentity = false;
  let bytes = Buffer.alloc(0);
  const operations = new Map<string, Record<string, unknown>>();
  const call = vi.fn(async (_binding: unknown, method: WorkspaceDevelopmentMethod, args: Record<string, unknown>): Promise<unknown> => {
    const identity = { workspace_id: args.workspace_id, repository_id: args.repository_id, development_id: args.development_id, ticket_id: args.ticket_id };
    const snapshot = () => ({ worktree_workspace_id: child, base_sha: base, head_sha: head, synced_head_sha: synced, dirty, conflicted: false });
    if (method === "workspace_development_artifact") {
      const offset = Number(args.offset), part = bytes.subarray(offset, offset + Number(args.length));
      return { protocol: WORKSPACE_DEVELOPMENT_PROTOCOL, ...identity, ...(wrongIdentity ? { ticket_id: ticket.id + 1 } : {}), candidate_id: args.candidate_id, artifact_id: args.artifact_id,
        offset, bytes: part.length, total: bytes.length, eof: offset + part.length === bytes.length,
        data: (corrupt ? Buffer.alloc(part.length) : part).toString("base64") };
    }
    if (method !== "workspace_development_status") {
      const action = method.replace("workspace_development_", "");
      if (action === "sync") synced = String(args.target_sha);
      const candidate = { candidate_id: "candidate_1", development_id: args.development_id, base_sha: args.expected_base_sha,
        head_sha: args.expected_head_sha, clean: true, bundle: { artifact_id: "source.bundle", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
      operations.set(String(args.request_id), { request_id: args.request_id, action, state: "succeeded", ...(action === "export" ? { candidate } : {}) });
    }
    return { protocol: WORKSPACE_DEVELOPMENT_PROTOCOL, ...identity, development: snapshot(),
      ...(args.request_id ? { operation: operations.get(String(args.request_id)) ?? { request_id: args.request_id, state: "missing" } } : {}) };
  });
  const opts = { repository: store.devTickets.development, repoDir: repo, stateDir: path.join(root, "state"), baseBranch: "v4", repositoryId: "octopus",
    publicUrl: "https://head.example.test", bundles: new BundleHandoff(), call, available: () => true, withGitLock: async <T>(work: () => Promise<T>) => work(), pollMs: 1, timeoutMs: 20 };
  const service = new DevelopmentWorkspaceService(opts);
  const commit = async () => {
    await writeFile(path.join(remote, "source.txt"), "Runner implementation\n");
    await gitOrThrow(remote, ["add", "source.txt"]); await gitOrThrow(remote, ["commit", "-m", "candidate"]);
    head = await gitOrThrow(remote, ["rev-parse", "HEAD"]);
    const file = path.join(root, "runner.bundle");
    await gitOrThrow(remote, ["bundle", "create", file, "HEAD", `^${base}`]); bytes = await readFile(file);
    return head;
  };
  return { root, repo, remote, candidateDir, store, ticket, runner, service, opts, call, base, commit,
    dirty: () => { dirty = true; }, corrupt: () => { corrupt = true; }, wrongIdentity: () => { wrongIdentity = true; } };
}

it("provisions once, preserves child placement across Head restart, and imports a real exact-SHA candidate", async () => {
  const f = await fixture();
  const binding = await f.service.prepare(f.ticket.id, f.runner);
  expect(binding).toMatchObject({ owner: "alice", device: "execution", parentWorkspaceId: parent, worktreeWorkspaceId: child });
  const restored = new DevelopmentWorkspaceService(f.opts);
  expect(await restored.prepare(f.ticket.id, { ...f.runner, workspaceId: child })).toEqual(binding);
  expect(f.call.mock.calls.filter(([, op]) => op === "workspace_development_prepare")).toHaveLength(1);
  const head = await f.commit();
  const result = await restored.importCandidate(f.ticket.id, f.candidateDir, true);
  expect(result?.head_sha).toBe(head);
  expect(await gitOrThrow(f.candidateDir, ["rev-parse", "HEAD"])).toBe(head);
  expect(await gitOrThrow(f.repo, ["rev-parse", "v4"])).toBe(f.base);
  expect(f.store.devTickets.development.candidate(f.ticket.id)).toMatchObject({ imported: true, candidate: { head_sha: head } });
});

it("does not export or omit dirty Runner content for context or CI", async () => {
  const f = await fixture(); await f.service.prepare(f.ticket.id, f.runner); f.dirty();
  await expect(f.service.importCandidate(f.ticket.id, f.candidateDir, false)).rejects.toMatchObject({ code: "dirty" });
  expect(f.call.mock.calls.some(([, op]) => op === "workspace_development_export")).toBe(false);
  expect(await gitOrThrow(f.candidateDir, ["rev-parse", "HEAD"])).toBe(f.base);
});

it.each(["corrupt", "wrongIdentity"] as const)("rejects %s bundle evidence before changing the Head candidate", async (change) => {
  const f = await fixture(); await f.service.prepare(f.ticket.id, f.runner); await f.commit(); f[change]();
  await expect(f.service.importCandidate(f.ticket.id, f.candidateDir, true)).rejects.toMatchObject({ code: "invalid_candidate" });
  expect(await gitOrThrow(f.candidateDir, ["rev-parse", "HEAD"])).toBe(f.base);
});

it("returns the newer authority without rebasing either tree, then sync only requests mirror movement", async () => {
  const f = await fixture(); await f.service.prepare(f.ticket.id, f.runner); const head = await f.commit();
  await writeFile(path.join(f.repo, "other.txt"), "another ticket\n");
  await gitOrThrow(f.repo, ["add", "other.txt"]); await gitOrThrow(f.repo, ["commit", "-m", "advance authority"]);
  const required = await gitOrThrow(f.repo, ["rev-parse", "v4"]);
  await expect(f.service.importCandidate(f.ticket.id, f.candidateDir, true)).rejects.toMatchObject({ code: "base_moved", requiredHeadSha: required });
  await f.service.sync(f.ticket.id);
  expect(f.call.mock.calls.find(([, op]) => op === "workspace_development_sync")?.[2]).toMatchObject({ base_sha: f.base, target_sha: required });
  expect(await gitOrThrow(f.remote, ["rev-parse", "HEAD"])).toBe(head);
  expect(await gitOrThrow(f.candidateDir, ["rev-parse", "HEAD"])).toBe(f.base);
});

it("reports a synced but unreconciled Runner base explicitly without changing either tree", async () => {
  const f = await fixture(); await f.service.prepare(f.ticket.id, f.runner); const head = await f.commit();
  await writeFile(path.join(f.repo, "new.txt"), "new authority\n");
  await gitOrThrow(f.repo, ["add", "new.txt"]); await gitOrThrow(f.repo, ["commit", "-m", "advance authority"]);
  const required = await gitOrThrow(f.repo, ["rev-parse", "HEAD"]);
  await f.service.sync(f.ticket.id);
  const original = f.opts.call;
  f.opts.call = vi.fn(async (binding: unknown, method: WorkspaceDevelopmentMethod, args: Record<string, unknown>): Promise<unknown> => {
    const result = await original(binding, method, args) as Record<string, unknown>;
    if (method === "workspace_development_export") return { ...result, operation: { request_id: args.request_id, action: "export", state: "failed", error: "head_mismatch" } };
    return result;
  });
  await expect(new DevelopmentWorkspaceService(f.opts).importCandidate(f.ticket.id, f.candidateDir, true))
    .rejects.toMatchObject({ code: "base_moved", requiredHeadSha: required });
  expect(await gitOrThrow(f.remote, ["rev-parse", "HEAD"])).toBe(head);
  expect(await gitOrThrow(f.candidateDir, ["rev-parse", "HEAD"])).toBe(f.base);
});

it("queries the same durable request after lost prepare acknowledgement and never repeats prepare", async () => {
  const f = await fixture(); const original = f.opts.call;
  f.opts.call = vi.fn(async (binding: unknown, method: WorkspaceDevelopmentMethod, args: Record<string, unknown>) => {
    if (method === "workspace_development_prepare") throw new Error("lost transport");
    return original(binding, method, args);
  });
  const first = new DevelopmentWorkspaceService(f.opts);
  await expect(first.prepare(f.ticket.id, f.runner)).rejects.toMatchObject({ code: "unknown" });
  const restarted = new DevelopmentWorkspaceService(f.opts);
  await expect(restarted.prepare(f.ticket.id, f.runner)).rejects.toMatchObject({ code: "unknown" });
  expect(f.opts.call.mock.calls.filter(([, op]) => op === "workspace_development_prepare")).toHaveLength(1);
});

it("lets an unchanged clean authority tree request context without exporting an empty bundle", async () => {
  const f = await fixture(); await f.service.prepare(f.ticket.id, f.runner);
  await expect(f.service.importCandidate(f.ticket.id, f.candidateDir, false)).resolves.toBeNull();
  expect(f.call.mock.calls.some(([, op]) => op === "workspace_development_export")).toBe(false);
});


it("reads an unchanged old authority for context while submit still requires Runner synchronization", async () => {
  const f = await fixture(); await f.service.prepare(f.ticket.id, f.runner);
  await writeFile(path.join(f.repo, "other.txt"), "authority moved\n");
  await gitOrThrow(f.repo, ["add", "other.txt"]); await gitOrThrow(f.repo, ["commit", "-m", "advance authority"]);
  const required = await gitOrThrow(f.repo, ["rev-parse", "HEAD"]);
  await expect(f.service.importCandidate(f.ticket.id, f.candidateDir, false)).resolves.toBeNull();
  expect(await gitOrThrow(f.candidateDir, ["rev-parse", "HEAD"])).toBe(f.base);
  expect(f.call.mock.calls.some(([, op]) => op === "workspace_development_export")).toBe(false);
  await expect(f.service.importCandidate(f.ticket.id, f.candidateDir, true)).rejects.toMatchObject({ code: "base_moved", requiredHeadSha: required });
});

it("sends an exact single-HEAD source bundle only after a definitive base_missing refusal", async () => {
  const f = await fixture(); const original = f.opts.call;
  f.opts.call = vi.fn(async (binding: unknown, method: WorkspaceDevelopmentMethod, args: Record<string, unknown>): Promise<unknown> => {
    if (method === "workspace_development_prepare" && !args.input) return {
      protocol: WORKSPACE_DEVELOPMENT_PROTOCOL, workspace_id: args.workspace_id, repository_id: args.repository_id, development_id: args.development_id, ticket_id: args.ticket_id,
      operation: { request_id: args.request_id, action: "prepare", state: "failed", error: "base_missing" },
    };
    if (method === "workspace_development_prepare") {
      const input = args.input as { url: string; bytes: number; sha256: string };
      const offered = f.opts.bundles.take(new URL(input.url).pathname.split("/").at(-1)!);
      expect(offered).not.toBeNull();
      const bytes = await readFile(offered!.path);
      expect(bytes.length).toBe(input.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(input.sha256);
      expect(await gitOrThrow(f.repo, ["bundle", "list-heads", offered!.path])).toBe(`${f.base} HEAD`);
      await offered!.done();
      await expect(readFile(offered!.path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    return original(binding, method, args);
  });
  await new DevelopmentWorkspaceService(f.opts).prepare(f.ticket.id, f.runner);
  const calls = f.opts.call.mock.calls.filter(([, method]) => method === "workspace_development_prepare");
  expect(calls).toHaveLength(2);
  expect(calls[0]![2].request_id).not.toBe(calls[1]![2].request_id);
  expect(JSON.stringify(f.store.devTickets.development.operation(f.ticket.id, JSON.stringify(["prepare", { base_sha: f.base }])))).not.toContain("bt_");
});

it("serializes one development identity while another ticket can provision independently", async () => {
  const f = await fixture(); const original = f.opts.call;
  const other = f.store.devTickets.createDevTicket({ title: "parallel", body: "task", requester: "alice", model: "codex-gpt-6-astra", effort: "xhigh", kind: "simple", app_id: null });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let waiting = false;
  f.opts.call = vi.fn(async (binding: unknown, method: WorkspaceDevelopmentMethod, args: Record<string, unknown>): Promise<unknown> => {
    if (method === "workspace_development_prepare" && args.ticket_id === f.ticket.id) { waiting = true; await blocked; }
    return original(binding, method, args);
  });
  const service = new DevelopmentWorkspaceService(f.opts), first = service.prepare(f.ticket.id, f.runner);
  await vi.waitFor(() => expect(waiting).toBe(true));
  await expect(service.prepare(f.ticket.id, f.runner)).rejects.toMatchObject({ code: "unavailable" });
  await expect(service.prepare(other.id, f.runner)).resolves.toMatchObject({ ticketId: other.id });
  release(); await first;
});
