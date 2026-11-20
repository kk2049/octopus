import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WorkspaceDevelopmentManager } from "./workspace-development.js";
import type { WorkspaceDevelopmentStatus } from "./workspace-development-protocol.js";
import { addWorkspace, listSessionWorkspaces, removeWorkspace, resolveWorkspace, withWorkspaceSite } from "./workspaces.js";
import { handleRpc } from "./core.js";
const exec = promisify(execFile);
const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd })).stdout.trim();
}
async function fixture() {
  const home = await fs.mkdtemp(path.join(tmpdir(), "workspace-development-")); roots.push(home);
  const root = path.join(home, "registered"), source = path.join(home, "source");
  await fs.mkdir(root); await fs.mkdir(source);
  await fs.writeFile(path.join(root, "personal.txt"), "keep private root");
  await git(source, "init", "-q");
  await fs.writeFile(path.join(source, "source.txt"), "base\n");
  await git(source, "add", "."); await git(source, "commit", "-qm", "base");
  const base = await git(source, "rev-parse", "HEAD"), workspace = await addWorkspace(home, root, "Compute");
  const offered = new Map<string, Buffer>();
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === "/hang") return;
    const content = offered.get(request.url ?? "");
    if (!content) { response.writeHead(404).end(); return; }
    response.end(content);
  }); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("address missing");
  const origin = "http://127.0.0.1:" + address.port;
  const offer = async (name: string, basis?: string) => {
    const file = path.join(home, name + ".bundle");
    await git(source, "bundle", "create", file, "HEAD", ...(basis ? ["^" + basis] : []));
    const content = await fs.readFile(file); offered.set("/" + name, content);
    return { url: origin + "/" + name, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length };
  };
  const input = await offer("base");
  const request = { workspace_id: workspace.id, repository_id: "octopus", development_id: "ticket-1", ticket_id: 1,
    request_id: "prepare-1", base_sha: base, input };
  const manager = new WorkspaceDevelopmentManager(home, { inputOrigins: [origin] });
  const call = async (method: string, args: Record<string, unknown>, site = "head-a") => {
    const result = await handleRpc(home, { id: "test", method, args },
      { gatewaySite: site, allowMachineOps: true, executionOnly: true, workspaceDevelopment: manager });
    if (!result.ok) throw new Error(String(result.error));
    return result.result as WorkspaceDevelopmentStatus;
  };
  return { home, root, source, base, workspace, request, manager, input, offer, call, origin, requests: () => requests };
}
async function settled(manager: WorkspaceDevelopmentManager, request: Record<string, unknown>, site = "head-a"): Promise<WorkspaceDevelopmentStatus> {
  for (let count = 0; count < 300; count++) {
    const status = await manager.status(site, request);
    if (status.operation && !["accepted", "running"].includes(status.operation.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("development operation did not settle");
}
async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  await f.call("workspace_development_prepare", f.request);
  const ready = await settled(f.manager, f.request);
  expect(ready.operation).toMatchObject({ state: "succeeded" });
  expect(ready.development).toMatchObject({ base_sha: f.base, head_sha: f.base, dirty: false, conflicted: false });
  return (await withWorkspaceSite("head-a", () => resolveWorkspace(f.home, ready.development!.worktree_workspace_id))).path;
}

describe("persistent Runner development via actual RPC and Git", () => {
  it("creates a registered child with exact source and runs ordinary commands there", async () => {
    const f = await fixture(), cwd = await prepare(f), ready = await f.manager.status("head-a", f.request);
    expect(await fs.readFile(path.join(f.root, "personal.txt"), "utf8")).toBe("keep private root");
    expect(await fs.stat(path.join(f.root, ".git")).catch(() => null)).toBeNull();
    const execution = await handleRpc(f.home, { id: "exec", method: "exec_workspace",
      args: { workspace_id: ready.development!.worktree_workspace_id, command: "pwd -P", timeout_ms: 1000 } },
      { gatewaySite: "head-a", allowMachineOps: true, executionOnly: true });
    expect(execution).toMatchObject({ ok: true, result: { ok: true, stdout: cwd + "\n" } });
    const restored = new WorkspaceDevelopmentManager(f.home);
    expect((await restored.prepare("head-a", f.request)).development!.worktree_workspace_id).toBe(ready.development!.worktree_workspace_id);
    expect(f.requests()).toBe(1);
    await expect(restored.prepare("head-a", { ...f.request, base_sha: "f".repeat(40) })).rejects.toThrow("binding_mismatch");
  }, 15_000);

  it("keeps platform screenshots out of add-all and export while ordinary untracked files still block", async () => {
    const f = await fixture(), cwd = await prepare(f);
    const pictureDir = await fs.mkdtemp(path.join(cwd, ".octopus-attachment-"));
    await fs.writeFile(path.join(pictureDir, "screenshot.png"), Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=", "base64"));
    const ignore = "# user-owned rules\n/user-cache/\n";
    await fs.writeFile(path.join(cwd, ".gitignore"), ignore);
    await fs.writeFile(path.join(cwd, "change.txt"), "normal source change");
    await git(cwd, "add", ".");
    expect((await git(cwd, "diff", "--cached", "--name-only")).split("\n")).toEqual([".gitignore", "change.txt"]);
    await git(cwd, "commit", "-qm", "source with screenshot evidence");
    const head = await git(cwd, "rev-parse", "HEAD");
    expect((await f.manager.status("head-a", f.request)).development?.dirty).toBe(false);
    expect(await fs.readFile(path.join(cwd, ".gitignore"), "utf8")).toBe(ignore);

    // Similar names, nested content and ordinary files retain normal Git semantics.
    await fs.writeFile(path.join(cwd, "draft.txt"), "must be committed or removed");
    await fs.mkdir(path.join(cwd, ".octopus-attachment-notes"));
    await fs.writeFile(path.join(cwd, ".octopus-attachment-notes", "notes.txt"), "ordinary user directory");
    await fs.mkdir(path.join(cwd, "nested", ".octopus-attachment-ABC123"), { recursive: true });
    await fs.writeFile(path.join(cwd, "nested", ".octopus-attachment-ABC123", "source.txt"), "ordinary nested source");
    expect((await git(cwd, "ls-files", "--others", "--exclude-standard")).split("\n")).toEqual([
      ".octopus-attachment-notes/notes.txt", "draft.txt", "nested/.octopus-attachment-ABC123/source.txt",
    ]);
    const request = { ...f.request, request_id: "screenshots-dirty", expected_base_sha: f.base, expected_head_sha: head };
    await f.call("workspace_development_export", request);
    expect((await settled(f.manager, request)).operation).toMatchObject({ state: "failed", error: "dirty_worktree" });
    await fs.rm(path.join(cwd, "draft.txt"));
    await fs.rm(path.join(cwd, ".octopus-attachment-notes"), { recursive: true });
    await fs.rm(path.join(cwd, "nested"), { recursive: true });
    const clean = { ...request, request_id: "screenshots-clean" };
    await f.call("workspace_development_export", clean);
    expect((await settled(f.manager, clean)).operation).toMatchObject({
      state: "succeeded", candidate: { head_sha: head, clean: true },
    });
    expect(await fs.stat(path.join(pictureDir, "screenshot.png"))).toBeDefined();
    expect(await fs.readFile(path.join(cwd, ".gitignore"), "utf8")).toBe(ignore);
  }, 15_000);

  it("upgrades existing mirror excludes only on a new prepare or sync operation", async () => {
    const f = await fixture(), cwd = await prepare(f);
    const mirror = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const exclude = path.join(mirror, "info", "exclude");
    const previous = "# preserve private local rules\n/user-cache/";
    await fs.writeFile(exclude, previous); // A mirror created before attachment exclusions.
    const pictureDir = await fs.mkdtemp(path.join(cwd, ".octopus-attachment-"));
    await fs.writeFile(path.join(pictureDir, "screenshot.png"), "existing screenshot");
    expect((await f.manager.status("head-a", f.request)).development?.dirty).toBe(true);
    await f.manager.prepare("head-a", f.request); // Reconcile the old immutable request.
    expect(await fs.readFile(exclude, "utf8")).toBe(previous);

    const synced = { ...f.request, request_id: "upgrade-excludes", target_sha: f.base, input: undefined };
    await f.call("workspace_development_sync", synced);
    expect((await settled(f.manager, synced)).operation).toMatchObject({ state: "succeeded" });
    expect((await f.manager.status("head-a", f.request)).development?.dirty).toBe(false);
    expect(await fs.readFile(exclude, "utf8")).toBe(previous + "\n/.octopus-attachment-??????/\n");
    const prepared = { ...f.request, request_id: "ensure-excludes-again", input: undefined };
    await f.call("workspace_development_prepare", prepared);
    expect((await settled(f.manager, prepared)).operation).toMatchObject({ state: "succeeded" });
    expect(await fs.readFile(exclude, "utf8")).toBe(previous + "\n/.octopus-attachment-??????/\n");
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(f.base);
    expect(await fs.readFile(path.join(pictureDir, "screenshot.png"), "utf8")).toBe("existing screenshot");
  }, 15_000);

  it("preserves index, dirty files and untracked work while syncing a newer exact Head", async () => {
    const f = await fixture(), cwd = await prepare(f);
    await fs.writeFile(path.join(cwd, "source.txt"), "staged development\n");
    await git(cwd, "add", "source.txt");
    await fs.writeFile(path.join(cwd, "source.txt"), "unstaged development\n");
    await fs.writeFile(path.join(cwd, "draft.txt"), "untracked");
    await fs.writeFile(path.join(f.source, "other.txt"), "new Head");
    await git(f.source, "add", "."); await git(f.source, "commit", "-qm", "Head advanced");
    const target = await git(f.source, "rev-parse", "HEAD"), input = await f.offer("next", f.base);
    const request = { ...f.request, request_id: "sync-1", target_sha: target, input };
    await f.call("workspace_development_sync", request);
    expect((await settled(f.manager, request)).development).toMatchObject({ head_sha: f.base, synced_head_sha: target, dirty: true });
    expect(await git(cwd, "show", ":source.txt")).toBe("staged development");
    expect(await fs.readFile(path.join(cwd, "source.txt"), "utf8")).toBe("unstaged development\n");
    expect(await fs.readFile(path.join(cwd, "draft.txt"), "utf8")).toBe("untracked");
    expect(await git(cwd, "rev-parse", "refs/remotes/octopus/head")).toBe(target);
  }, 15_000);

  it("exports immutable exact candidate bytes and refuses dirty/head mismatch/foreign artifacts", async () => {
    const f = await fixture(), cwd = await prepare(f);
    await fs.writeFile(path.join(cwd, "change.txt"), "candidate");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "candidate");
    const head = await git(cwd, "rev-parse", "HEAD");
    const request = { ...f.request, request_id: "export-1", expected_base_sha: f.base, expected_head_sha: head };
    await f.call("workspace_development_export", request);
    const candidate = (await settled(f.manager, request)).operation!.candidate!;
    expect(candidate).toMatchObject({ head_sha: head, base_sha: f.base, clean: true });
    const bytes = await f.manager.artifact("head-a", { ...f.request, candidate_id: candidate.candidate_id,
      artifact_id: candidate.bundle.artifact_id, offset: 0, length: 1048576 });
    const buffer = Buffer.from(bytes.data, "base64");
    expect(createHash("sha256").update(buffer).digest("hex")).toBe(candidate.bundle.sha256);
    const file = path.join(f.home, "candidate.bundle"); await fs.writeFile(file, buffer);
    expect(await git(f.source, "bundle", "list-heads", file)).toBe(head + " HEAD");
    await git(f.source, "fetch", file, "HEAD");
    expect(await git(f.source, "show", head + ":change.txt")).toBe("candidate");
    await fs.writeFile(path.join(cwd, "draft.txt"), "new work after export");
    expect((await f.manager.export("head-a", request)).operation!.candidate).toEqual(candidate);
    const dirty = { ...request, request_id: "export-dirty" };
    await f.manager.export("head-a", dirty);
    expect((await settled(f.manager, dirty)).operation).toMatchObject({ state: "failed", error: "dirty_worktree" });
    const wrong = { ...request, request_id: "export-wrong", expected_head_sha: f.base };
    await f.manager.export("head-a", wrong);
    expect((await settled(f.manager, wrong)).operation).toMatchObject({ state: "failed", error: "head_mismatch" });
    await expect(f.manager.artifact("other-head", { ...request, candidate_id: candidate.candidate_id,
      artifact_id: "source.bundle", offset: 0, length: 10 })).rejects.toThrow();
    await expect(f.manager.artifact("head-a", { ...request, candidate_id: candidate.candidate_id,
      artifact_id: "../binding.json", offset: 0, length: 10 })).rejects.toThrow("invalid_request");
  }, 20_000);

  it("refuses a clean interactive rebase stopped at edit until all commits are replayed", async () => {
    const f = await fixture(), cwd = await prepare(f);
    for (const file of ["first.txt", "second.txt"]) {
      await fs.writeFile(path.join(cwd, file), file);
      await git(cwd, "add", file); await git(cwd, "commit", "-qm", file);
    }
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "rebase", "-i", f.base], { cwd, env: { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i '1s/^pick /edit /'" } });
    expect(await git(cwd, "status", "--porcelain")).toBe("");
    expect(await git(cwd, "ls-files", "-u")).toBe("");
    expect((await f.manager.status("head-a", f.request)).development!.conflicted).toBe(true);
    const request = { ...f.request, request_id: "export-edit",
      expected_base_sha: f.base, expected_head_sha: await git(cwd, "rev-parse", "HEAD") };
    await f.manager.export("head-a", request);
    expect((await settled(f.manager, request)).operation).toMatchObject({ state: "failed", error: "conflicted_worktree" });
    await git(cwd, "rebase", "--continue");
    expect((await f.manager.status("head-a", f.request)).development!.conflicted).toBe(false);
    expect(await fs.readFile(path.join(cwd, "second.txt"), "utf8")).toBe("second.txt");
  }, 15_000);

  it("isolates identical development ids across Heads and immediately honors parent and child revocation", async () => {
    const f = await fixture(); await prepare(f);
    const a = (await f.manager.status("head-a", f.request)).development!.worktree_workspace_id;
    await f.call("workspace_development_prepare", f.request, "head-b");
    const b = (await settled(f.manager, f.request, "head-b")).development!.worktree_workspace_id;
    expect(a).not.toBe(b);
    await expect(withWorkspaceSite("head-b", () => resolveWorkspace(f.home, a))).rejects.toThrow("当前 Head");
    const visible = await withWorkspaceSite("head-a", () => listSessionWorkspaces(f.home));
    expect(visible.workspaces.map((row) => row.id)).toContain(a);
    expect(visible.workspaces.map((row) => row.id)).not.toContain(b);
    await removeWorkspace(f.home, a);
    await expect(f.manager.status("head-a", f.request)).rejects.toThrow("workspace 不存在");
    await removeWorkspace(f.home, f.workspace.id);
    await expect(withWorkspaceSite("head-b", () => resolveWorkspace(f.home, b))).rejects.toThrow("父登记已撤销");
    await expect(f.manager.status("head-b", f.request)).rejects.toThrow();
  }, 20_000);

  it("allows different ticket worktrees concurrently but binds one durable request to one input", async () => {
    const f = await fixture();
    const other = { ...f.request, development_id: "ticket-2", ticket_id: 2, request_id: "prepare-2" };
    await Promise.all([f.manager.prepare("head-a", f.request), f.manager.prepare("head-a", other)]);
    const [a, b] = await Promise.all([settled(f.manager, f.request), settled(f.manager, other)]);
    expect(a.operation!.state).toBe("succeeded"); expect(b.operation!.state).toBe("succeeded");
    expect(a.development!.worktree_workspace_id).not.toBe(b.development!.worktree_workspace_id);
    await expect(f.manager.prepare("head-a", { ...f.request, input: { ...f.input, bytes: f.input.bytes + 1 } })).rejects.toThrow("request_conflict");
  }, 20_000);

  it("keeps a killed worker unknown across restart and never replays its download", async () => {
    const f = await fixture();
    const request = { ...f.request, input: { ...f.input, url: f.origin + "/hang" } };
    await f.manager.prepare("head-a", request);
    const scope = path.join(f.root, ".octopus-development", createHash("sha256").update(JSON.stringify(["head-a", "octopus"])).digest("hex"));
    const dev = path.join(scope, "developments", createHash("sha256").update(JSON.stringify("ticket-1")).digest("hex"));
    const dir = path.join(dev, "requests", request.request_id);
    let pid: { pid: number } | null = null;
    for (let i = 0; i < 100 && (!pid || !f.requests()); i++) {
      pid = await fs.readFile(path.join(dir, "pid.json"), "utf8").then((text) => JSON.parse(text)).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pid).not.toBeNull();
    await expect(f.manager.prepare("head-a", { ...f.request, request_id: "competing" })).rejects.toThrow("workspace_busy");
    process.kill(pid!.pid, "SIGKILL");
    expect((await settled(f.manager, request)).operation!.state).toBe("unknown");
    const restored = new WorkspaceDevelopmentManager(f.home);
    const before = f.requests();
    expect((await restored.prepare("head-a", request)).operation!.state).toBe("unknown");
    expect(f.requests()).toBe(before);
  }, 15_000);

  it("rejects corrupt, oversized or foreign-origin bundles before publishing a development workspace", async () => {
    const f = await fixture();
    await expect(f.manager.prepare("head-a", { ...f.request, input: { ...f.input, bytes: 134217729 } })).rejects.toThrow("invalid_request");
    await expect(f.manager.prepare("head-a", { ...f.request, input: { ...f.input, url: "https://foreign.invalid/input" } })).rejects.toThrow("invalid_request");
    const bad = { ...f.request, input: { ...f.input, sha256: "a".repeat(64) } };
    await f.manager.prepare("head-a", bad);
    expect((await settled(f.manager, bad)).operation).toMatchObject({ state: "failed", error: "input_invalid" });
    expect((await f.manager.status("head-a", bad)).development).toBeUndefined();
  }, 15_000);

  it("refuses a symlinked managed root without writing outside the registered root", async () => {
    const f = await fixture(), elsewhere = path.join(f.home, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(f.root, ".octopus-development"));
    await expect(f.manager.prepare("head-a", f.request)).rejects.toThrow("workspace_unavailable");
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });
});
