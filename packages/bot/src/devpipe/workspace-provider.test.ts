import { randomBytes } from "node:crypto";
import { gitOrThrow } from "./worktree.js";
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BundleHandoff } from "./bundle-handoff.js";
import { WorkspaceProvider, WorkspaceProviderUnknown, WorkspaceProviderUnavailable } from "./workspace-provider.js";
import type { WorkspaceJobGrant } from "./workspace-job-capability.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const target = { owner: "alice", device: "dedicated", workspaceId: `ws_${"1".repeat(24)}` };
const task = { key: "ticket:1:tests", workspaceKey: "ticket-1", sha: "a".repeat(40), command: "echo test", timeoutMs: 1000 };

it("side inputs survive caller cleanup and their private URLs never enter the durable intent", async () => {
  const f = await fixture(), source = path.join(f.opts.stateDir, "caller.json");
  await fs.writeFile(source, "private projection");
  let uploads: Array<{ name: string; url: string }> = [];
  const open = f.opts.open;
  f.opts.open = () => {
    const original = open();
    return { close: () => original.close(), call: async (op: string, args: Record<string, unknown>) => {
      if (op === "workspace_job_start") uploads = JSON.parse(String(args.files_json));
      return original.call(op, args);
    } } as unknown as WorkspaceJobGrant;
  };
  await new WorkspaceProvider(target, f.opts).submit({ ...task, files: [{ name: "runtime.json", file: source }] });
  await fs.rm(source);
  const token = uploads[0].url.split("/").at(-1)!;
  const offered = f.opts.bundles.take(token)!;
  expect(await fs.readFile(offered.path, "utf8")).toBe("private projection");
  for (const file of (await fs.readdir(f.opts.stateDir)).filter(f => /^[0-9a-f]{64}\.json$/.test(f))) {
    expect(await fs.readFile(path.join(f.opts.stateDir, file), "utf8")).not.toContain(token);
  }
  await offered.done();
  expect(await fs.stat(offered.path).catch(() => null)).toBeNull();
});

it("artifact reads resume the same offset after a transient link failure and validate source identity", async () => {
  const f = await fixture(); await f.client.submit(task);
  let reads = 0;
  const offsets: number[] = [];
  f.opts.open = () => ({ close() {}, async call(_op: string, args: Record<string, unknown>) {
    offsets.push(Number(args.offset));
    if (++reads === 1) throw new Error("wireless handover");
    return { protocol: "workspace-jobs/v1", job_id: args.job_id, workspace_id: target.workspaceId,
      repo_sha: task.sha, name: args.name, offset: args.offset, bytes: 3, total: 6, data: Buffer.from("def").toString("base64"), eof: true };
  } } as unknown as WorkspaceJobGrant);
  f.opts.recoveryMs = 100;
  expect((await f.client.artifact(task.key, "out.json", 3, 3)).data.toString()).toBe("def");
  expect(offsets).toEqual([3, 3]);
  expect(f.calls.filter(c => c === "workspace_job_start")).toHaveLength(1);
});
async function fixture() {
  const stateDir = await fs.mkdtemp(path.join(tmpdir(), "workspace-client-")); dirs.push(stateDir);
  const calls: string[] = []; let online = true; let lostStart = false; let forget = false;
  const jobs = new Map<string, Record<string, unknown>>();
  const opts = { stateDir, publicUrl: "https://service.example", bundles: new BundleHandoff(), pollMs: 1, recoveryMs: 5,
    status: () => online ? "available" : "offline",
    open: () => ({ close() {}, async call(op: string, args: Record<string, unknown>) {
      calls.push(op); const id = String(args.job_id);
      const base = { protocol: "workspace-jobs/v1", job_id: id, workspace_id: target.workspaceId };
      if (op === "workspace_job_start") {
        jobs.set(id, { ...base, state: "succeeded", repo_sha: args.repo_sha, workspace_key: args.workspace_key, exit_code: 0 });
        if (lostStart) throw new Error("link lost after dispatch");
      }
      return (!forget && jobs.get(id)) || { ...base, state: "missing" };
    } } as unknown as WorkspaceJobGrant),
  };
  return { opts, calls, jobs, client: new WorkspaceProvider(target, opts), offline: () => { online = false; }, online: () => { online = true; },
    loseStart: () => { lostStart = true; }, forget: () => { forget = true; } };
}
describe("workspace provider: persistent no-replay boundary", () => {
  it("dispatches a long command intact and still binds its complete text to the task key", async () => {
    const f = await fixture();
    const command = `# ${"章鱼".repeat(10_000)}\nprintf done`;
    let received: unknown;
    const open = f.opts.open;
    f.opts.open = () => {
      const grant = open();
      return { close: () => grant.close(), call: async (op: string, args: Record<string, unknown>) => {
        if (op === "workspace_job_start") received = args.command;
        return grant.call(op, args);
      } } as unknown as WorkspaceJobGrant;
    };
    await f.client.submit({ ...task, command });
    expect(received).toBe(command);
    await f.client.submit({ ...task, command });
    await expect(f.client.submit({ ...task, command: `${command}\nprintf changed` })).rejects.toThrow("different input");
    expect(f.calls.filter((op) => op === "workspace_job_start")).toHaveLength(1);
  });

  it("does not dispatch while the provider is unavailable", async () => {
    const f = await fixture(); f.offline();
    await expect(f.client.submit(task)).rejects.toBeInstanceOf(WorkspaceProviderUnavailable);
    expect(f.calls).toEqual([]); expect(await fs.readdir(f.opts.stateDir)).toEqual([]);
  });
  it("a lost start reply is recovered by querying the same job", async () => {
    const f = await fixture(); f.loseStart();
    expect((await f.client.wait(task)).state).toBe("succeeded");
    const restarted = new WorkspaceProvider(target, f.opts);
    expect((await restarted.submit(task)).state).toBe("succeeded");
    expect(f.calls.filter((op) => op === "workspace_job_start")).toHaveLength(1);
  });
  it("a missing receipt after dispatch is unknown and repeated calls never dispatch again", async () => {
    const f = await fixture(); f.loseStart(); f.forget();
    await expect(f.client.submit(task)).rejects.toBeInstanceOf(WorkspaceProviderUnknown);
    await expect(new WorkspaceProvider(target, f.opts).submit(task)).rejects.toBeInstanceOf(WorkspaceProviderUnknown);
    expect(f.calls.filter((op) => op === "workspace_job_start")).toHaveLength(1);
  });
  it("placement and command changes cannot reuse an existing task identity", async () => {
    const f = await fixture(); await f.client.submit(task);
    await expect(f.client.submit({ ...task, command: "echo different" })).rejects.toThrow("different input");
    const moved = new WorkspaceProvider({ ...target, device: "replacement" }, f.opts);
    await expect(moved.submit(task)).rejects.toThrow("different input or placement");
    await expect(moved.query(task.key)).rejects.toThrow("another provider placement");
    expect(f.calls.filter((op) => op === "workspace_job_start")).toHaveLength(1);
  });
  it("rejects a result echoed for another workspace", async () => {
    const f = await fixture(); const result = await f.client.submit(task);
    f.jobs.set(result.job_id, { ...result, workspace_id: `ws_${"2".repeat(24)}` });
    await expect(f.client.query(task.key)).rejects.toBeInstanceOf(WorkspaceProviderUnknown);
  });
});

it("concurrent requests for one identity join one dispatch and preserve prepare identity", async () => {
  const f = await fixture();
  const results = await Promise.all([f.client.submit(task), f.client.submit(task)]);
  expect(results.map((row) => row.job_id)).toEqual([results[0].job_id, results[0].job_id]);
  expect(f.calls.filter((op) => op === "workspace_job_start")).toHaveLength(1);
  await expect(f.client.submit({ ...task, sourceDir: "/different-source" })).rejects.toThrow("different input");
});
it("persists cancellation for every ticket job while offline and redelivers after control restart", async () => {
  const f = await fixture();
  for (const key of ["ticket:1:first", "ticket:1:second"]) {
    const status = await f.client.submit({ ...task, key });
    f.jobs.set(status.job_id, { ...status, state: "running" });
  }
  f.offline(); await expect(f.client.cancelTicket(1)).rejects.toBeInstanceOf(WorkspaceProviderUnavailable);
  const intents = await Promise.all((await fs.readdir(f.opts.stateDir)).filter((file) => file.endsWith(".json")).map(async (file) => JSON.parse(await fs.readFile(path.join(f.opts.stateDir, file), "utf8"))));
  expect(intents).toHaveLength(2); expect(intents.every((row) => row.cancelRequested)).toBe(true);
  const restored = new WorkspaceProvider(target, f.opts); f.online();
  await restored.reconcileCancellations();
  expect(f.calls.filter((op) => op === "workspace_job_cancel")).toHaveLength(2);
  expect(f.calls.filter((op) => op === "workspace_job_start")).toHaveLength(2);
});

it("validates the source receipt and rejects invalid deadlines before dispatch", async () => {
  const f = await fixture();
  await expect(f.client.submit({ ...task, timeoutMs: 0 })).rejects.toThrow("deadline"); expect(f.calls).toEqual([]);
  const result = await f.client.submit(task);
  f.jobs.set(result.job_id, { ...result, repo_sha: "b".repeat(40) });
  await expect(f.client.query(task.key)).rejects.toBeInstanceOf(WorkspaceProviderUnknown);
  await expect(f.client.submit(task)).rejects.toBeInstanceOf(WorkspaceProviderUnknown);
  expect(f.calls.filter((op) => op === "workspace_job_start")).toHaveLength(1);
});

it("durable ticket cancellation fences a preparation that has not dispatched yet", async () => {
  const f = await fixture(); await f.client.cancelTicket(1);
  expect(await new WorkspaceProvider(target, f.opts).submit(task)).toMatchObject({ state: "not_started", error: "ticket_cancelled" });
  expect(f.calls).toEqual([]);
});

it("incremental preparation omits inherited objects and skips transport when the destination is current", async () => {
  const f = await fixture();
  const source = await fs.mkdtemp(path.join(tmpdir(), "workspace-source-")); dirs.push(source);
  await gitOrThrow(source, ["init", "-b", "test"]);
  await fs.writeFile(path.join(source, "seed.bin"), randomBytes(512 * 1024));
  await gitOrThrow(source, ["add", "."]);
  await gitOrThrow(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"]);
  const base = await gitOrThrow(source, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(source, "change.txt"), "small change\n");
  await gitOrThrow(source, ["add", "."]);
  await gitOrThrow(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "change"]);
  const sha = await gitOrThrow(source, ["rev-parse", "HEAD"]);
  let head = base;
  const client = new WorkspaceProvider(target, { ...f.opts, sourceState: async () => ({ head, refs: [head] }) });
  await client.submit({ ...task, key: "incremental", sha, sourceDir: source });
  const bundles = (await fs.readdir(f.opts.stateDir)).filter((file) => file.startsWith("bundle-"));
  expect(bundles).toHaveLength(1);
  const file = path.join(f.opts.stateDir, bundles[0]);
  expect((await fs.stat(file)).size).toBeLessThan(4096);
  expect((await fs.readFile(file)).subarray(0, 100).toString()).toContain(`-${base}`);
  head = sha;
  await client.submit({ ...task, key: "already-present", sha, sourceDir: source });
  expect((await fs.readdir(f.opts.stateDir)).filter((file) => file.startsWith("bundle-"))).toEqual(bundles);
});

it("aborting wait detaches observation without cancelling or replaying the remote task", async () => {
  const f = await fixture(); const result = await f.client.submit(task);
  f.jobs.set(result.job_id, { ...result, state: "running" });
  const controller = new AbortController();
  const waiting = f.client.wait(task, controller.signal);
  controller.abort();
  await expect(waiting).rejects.toThrow();
  expect(f.calls.filter((op) => op === "workspace_job_start")).toHaveLength(1);
  expect(f.calls).not.toContain("workspace_job_cancel");
});
