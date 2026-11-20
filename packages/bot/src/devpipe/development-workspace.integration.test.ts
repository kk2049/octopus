import { createServer, type Server } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { handleRpc } from "@claude-bot/runner/core";
import { WorkspaceDevelopmentManager } from "@claude-bot/runner/workspace-development";
import { addWorkspace, resolveWorkspace, withWorkspaceSite } from "@claude-bot/runner/workspaces";
import type { WorkspaceDevelopmentMethod } from "@claude-bot/runner/workspace-development-protocol";
import { Store } from "../store/store.js";
import { BundleHandoff } from "./bundle-handoff.js";
import { DevelopmentWorkspaceService, type DevelopmentWorkspaceOptions } from "./development-workspace.js";
import { gitOrThrow } from "./worktree.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("uses real Head and Runner protocol through two persistent tickets and a moved-authority rebase", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "development-protocol-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "head"), runnerHome = path.join(root, "runner-home"), parent = path.join(runnerHome, "registered");
  await fs.mkdir(parent, { recursive: true });
  await gitOrThrow(root, ["init", "-b", "v4", repo]);
  for (const [key, value] of [["user.name", "Development Test"], ["user.email", "test@example.invalid"]]) {
    await gitOrThrow(repo, ["config", key!, value!]);
  }
  await fs.writeFile(path.join(repo, "source.txt"), "base\n");
  await gitOrThrow(repo, ["add", "."]); await gitOrThrow(repo, ["commit", "-m", "base"]);
  const base = await gitOrThrow(repo, ["rev-parse", "HEAD"]);
  const registered = await addWorkspace(runnerHome, parent, "Development");

  const store = new Store(path.join(root, "store.db")); cleanup.push(async () => store.close());
  store.saveUser({ username: "alice", uid: 1, home_dir: root, created_at: new Date().toISOString() });
  const tickets = ["A", "B"].map((name) => store.devTickets.createDevTicket({
    title: "Protocol " + name, body: "develop without ssh", requester: "alice", model: "codex-gpt-6-astra",
    effort: "high", kind: "simple", app_id: null,
  }));
  const candidates = tickets.map((ticket) => path.join(root, "candidate-" + ticket.id));
  for (let index = 0; index < tickets.length; index++) {
    await gitOrThrow(repo, ["worktree", "add", "-b", "ticket/" + tickets[index]!.id, candidates[index]!, base]);
  }
  const bundles = new BundleHandoff();
  let downloads = 0;
  const server: Server = createServer((request, response) => {
    const token = request.url?.match(/^\/api\/contrib\/bundle\/(bt_[0-9a-f]{48})$/)?.[1];
    const offer = token ? bundles.take(token) : null;
    if (!offer) { response.writeHead(404).end(); return; }
    downloads++;
    const stream = createReadStream(offer.path);
    response.once("close", () => { stream.destroy(); void offer.done(); });
    stream.once("error", () => response.destroy());
    stream.pipe(response);
  });
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing HTTP address");
  const origin = "http://127.0.0.1:" + address.port;
  let manager = new WorkspaceDevelopmentManager(runnerHome, { inputOrigins: [origin] });
  let gitLock: Promise<unknown> = Promise.resolve();
  const withGitLock = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = gitLock.then(work, work);
    gitLock = pending.catch(() => {});
    return pending;
  };
  const frames: Array<{ method: WorkspaceDevelopmentMethod; ticket: number; request?: string; hasInput: boolean }> = [];
  let dropFirstAcknowledgement = true;
  const options: DevelopmentWorkspaceOptions = {
    repository: store.devTickets.development, repoDir: repo, stateDir: path.join(root, "head-state"),
    baseBranch: "v4", repositoryId: "octopus", publicUrl: origin, bundles,
    available: () => true, withGitLock, pollMs: 20, timeoutMs: 20_000,
    call: async (_binding, method, args) => {
      frames.push({ method, ticket: Number(args.ticket_id), request: args.request_id as string | undefined, hasInput: Boolean(args.input) });
      const response = await handleRpc(runnerHome, { id: "rpc-" + frames.length, method, args },
        { gatewaySite: "head-a", executionOnly: true, allowMachineOps: true, workspaceDevelopment: manager });
      if (!response.ok) throw new Error(response.error);
      // Network acknowledgement loss happens after the real durable admission.
      if (dropFirstAcknowledgement && method === "workspace_development_prepare") {
        dropFirstAcknowledgement = false;
        throw new Error("transport closed after actual admission");
      }
      return response.result;
    },
  };
  const runner = { owner: "alice", device: "model-runtime", executionDevice: "compute",
    workspaceId: registered.id, source: "codex" as const };
  let head = new DevelopmentWorkspaceService(options);
  const bindings = await Promise.all(tickets.map((ticket) => head.prepare(ticket.id, runner)));
  expect(bindings[0]!.worktreeWorkspaceId).not.toBe(bindings[1]!.worktreeWorkspaceId);
  expect(downloads).toBeGreaterThan(0);
  for (const ticket of tickets) {
    const requests = frames.filter((frame) => frame.method === "workspace_development_prepare" && frame.ticket === ticket.id);
    expect(new Set(requests.map((frame) => frame.request)).size).toBe(requests.length);
  }
  const cwd = await Promise.all(bindings.map(async (binding) =>
    (await withWorkspaceSite("head-a", () => resolveWorkspace(runnerHome, binding.worktreeWorkspaceId!))).path));

  // Reconstruct both sides from durable state; no additional prepare or download.
  const before = frames.filter((frame) => frame.method === "workspace_development_prepare").length;
  const priorDownloads = downloads;
  manager = new WorkspaceDevelopmentManager(runnerHome, { inputOrigins: [origin] });
  head = new DevelopmentWorkspaceService(options);
  await Promise.all(tickets.map((ticket, index) => head.prepare(ticket.id, { ...runner, workspaceId: bindings[index]!.worktreeWorkspaceId! })));
  expect(frames.filter((frame) => frame.method === "workspace_development_prepare")).toHaveLength(before);
  expect(downloads).toBe(priorDownloads);
  const commits: string[] = [];
  for (let index = 0; index < cwd.length; index++) {
    await fs.writeFile(path.join(cwd[index]!, "change-" + index + ".txt"), "ticket " + index + "\n");
    await gitOrThrow(cwd[index]!, ["add", "."]);
    await gitOrThrow(cwd[index]!, ["-c", "user.name=Development Test", "-c", "user.email=test@example.invalid",
      "commit", "-m", "ticket " + index]);
    commits.push(await gitOrThrow(cwd[index]!, ["rev-parse", "HEAD"]));
  }
  const initial = await Promise.all(tickets.map((ticket, index) => head.importCandidate(ticket.id, candidates[index]!, true)));
  expect(initial.map((candidate) => candidate!.head_sha)).toEqual(commits);
  expect(await gitOrThrow(repo, ["rev-parse", "v4"])).toBe(base);
  await withGitLock(() => gitOrThrow(repo, ["merge", "--ff-only", commits[0]!]));
  const required = await head.head();
  expect(required).toBe(commits[0]);

  await expect(head.importCandidate(tickets[1]!.id, candidates[1]!, true))
    .rejects.toMatchObject({ code: "base_moved", requiredHeadSha: required });
  const sync = await head.sync(tickets[1]!.id);
  expect(sync.development!.synced_head_sha).toBe(required);
  expect(downloads).toBeGreaterThan(priorDownloads); // Real incremental bundle reached the existing mirror.
  expect(await gitOrThrow(cwd[1]!, ["rev-parse", "HEAD"])).toBe(commits[1]);
  await expect(head.importCandidate(tickets[1]!.id, candidates[1]!, true))
    .rejects.toMatchObject({ code: "base_moved", requiredHeadSha: required });
  expect(await gitOrThrow(candidates[1]!, ["rev-parse", "HEAD"])).toBe(commits[1]);

  // The agent's own registered Runner cwd resolves the moved base. The Head never rebases it.
  await gitOrThrow(cwd[1]!, ["-c", "user.name=Development Test", "-c", "user.email=test@example.invalid",
    "rebase", "refs/remotes/octopus/head"]);
  const rebased = await gitOrThrow(cwd[1]!, ["rev-parse", "HEAD"]);
  expect(rebased).not.toBe(commits[1]);
  const final = await head.importCandidate(tickets[1]!.id, candidates[1]!, true);
  expect(final).toMatchObject({ base_sha: required, head_sha: rebased });
  expect(await gitOrThrow(candidates[1]!, ["rev-parse", "HEAD"])).toBe(rebased);
  await withGitLock(() => gitOrThrow(repo, ["merge", "--ff-only", rebased]));
  expect(await fs.readFile(path.join(repo, "change-0.txt"), "utf8")).toBe("ticket 0\n");
  expect(await fs.readFile(path.join(repo, "change-1.txt"), "utf8")).toBe("ticket 1\n");
  expect(await gitOrThrow(repo, ["rev-parse", "v4"])).toBe(rebased);
  expect(bundles.size).toBe(0);
}, 40_000);
