import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { gitOrThrow } from "../devpipe/worktree.js";
import type { MachineExec } from "../devpipe/runner-machine-sync.js";
import type { WorkspaceProvider, WorkspaceTask } from "../devpipe/workspace-provider.js";
import { runnerArchitectureAnalyzer } from "./architecture-runner.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
async function fixture(padding = 0) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "architecture-provider-")); dirs.push(dir);
  await gitOrThrow(dir, ["init", "-b", "test"]);
  await gitOrThrow(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "source"]);
  const sha = await gitOrThrow(dir, ["rev-parse", "HEAD"]);
  const outFile = path.join(dir, "data", "atlas.json");
  await fs.mkdir(path.dirname(outFile)); await fs.writeFile(outFile, "previous snapshot");
  const inputFingerprint = "1".repeat(64);
  const raw = Buffer.from(JSON.stringify({ schemaVersion: 1, meta: { commit: sha, dirty: false, inputFingerprint }, modules: [], padding: randomBytes(padding).toString("base64") }));
  const compressed = gzipSync(raw);
  const metadata = { version: 1, repoSha: sha, bytes: raw.length, sha256: hash(raw), compressedBytes: compressed.length, compressedSha256: hash(compressed), inputFingerprint };
  const tasks: WorkspaceTask[] = [], reads: string[] = [], offsets: number[] = [];
  let offline = false, corrupt = false, interruptTransfer = false;
  const provider: Pick<WorkspaceProvider, "wait" | "target"> = {
    target: { owner: "alice", device: "ci", workspaceId: `ws_${"1".repeat(24)}` },
    wait: async (task, signal) => {
      signal?.throwIfAborted(); tasks.push(task);
      if (offline) throw new Error("CI offline");
      return { protocol: "workspace-jobs/v1", job_id: `job_${sha}`, workspace_id: `ws_${"1".repeat(24)}`,
        workspace_key: task.workspaceKey, repo_sha: task.sha, state: "succeeded", exit_code: 0 };
    },
  };
  const exec: MachineExec = async ({ command }) => {
    // The final shell-quoted argument is a JSON tuple; test paths contain no apostrophe.
    const tuple = command.match(/ '(\[.*\])'$/)?.[1];
    if (!tuple) throw new Error("unexpected remote command");
    const [file, offset, length] = JSON.parse(tuple) as [string, number, number]; reads.push(file);
    if (file.endsWith(".gz")) {
      offsets.push(offset);
      if (interruptTransfer && offset > 0) { interruptTransfer = false; return { ok: false, stdout: "", stderr: "network interrupted" }; }
    }
    const source = file.endsWith("manifest.json") ? Buffer.from(JSON.stringify(metadata)) : Buffer.from(compressed);
    if (corrupt && file.endsWith(".gz")) source[0] ^= 1;
    const data = source.subarray(offset, offset + length);
    return { ok: true, stderr: "", stdout: JSON.stringify({ offset, total: source.length, bytes: data.length, data: data.toString("base64") }) };
  };
  const opts = { provider, exec, checkoutDir: "/remote/repo" };
  const input = { repoDir: dir, outFile, signal: new AbortController().signal };
  return { raw, metadata, input, tasks, reads, offsets, opts, run: runnerArchitectureAnalyzer(opts), offline: () => { offline = true; }, corrupt: () => { corrupt = true; }, interrupt: () => { interruptTransfer = true; } };
}

describe("architecture Runner adapter", () => {
  it("installs the exact remote snapshot and reuses it across a control-service restart", async () => {
    const f = await fixture();
    expect((await f.run(f.input)).ok).toBe(true);
    expect(await fs.readFile(f.input.outFile)).toEqual(f.raw);
    expect(f.tasks[0]).toMatchObject({ key: `architecture:${f.metadata.repoSha}`, sha: f.metadata.repoSha,
      workspaceKey: "architecture", sourceDir: f.input.repoDir });
    expect(f.tasks[0].command).toContain("architecture-artifact-build.mjs");
    const downloads = f.reads.filter((file) => file.endsWith(".gz")).length;
    expect((await runnerArchitectureAnalyzer(f.opts)(f.input)).ok).toBe(true);
    expect(f.tasks[1]).toEqual(f.tasks[0]);
    expect(f.reads.filter((file) => file.endsWith(".gz"))).toHaveLength(downloads);
  });
  it("an offline provider preserves the previous snapshot without local analysis", async () => {
    const f = await fixture(); f.offline();
    await expect(f.run(f.input)).rejects.toThrow("offline");
    expect(await fs.readFile(f.input.outFile, "utf8")).toBe("previous snapshot");
    expect(f.reads).toEqual([]);
  });
  it("resumes a partial transfer from the same remote job after a link interruption", async () => {
    const f = await fixture(160000); f.interrupt();
    await expect(f.run(f.input)).rejects.toThrow("read unavailable");
    expect(await fs.readFile(f.input.outFile, "utf8")).toBe("previous snapshot");
    expect((await runnerArchitectureAnalyzer(f.opts)(f.input)).ok).toBe(true);
    expect(await fs.readFile(f.input.outFile)).toEqual(f.raw);
    expect(f.tasks[1]).toEqual(f.tasks[0]);
    expect(f.offsets.filter((offset) => offset === 0)).toHaveLength(1);
  });
  it("rejects the wrong deployed SHA before downloading a snapshot", async () => {
    const f = await fixture(); f.metadata.repoSha = "a".repeat(40);
    await expect(f.run(f.input)).rejects.toThrow("invalid source");
    expect(await fs.readFile(f.input.outFile, "utf8")).toBe("previous snapshot");
    expect(f.reads).toHaveLength(1);
  });
  it("rejects damaged compressed bytes without replacing the previous atlas", async () => {
    const f = await fixture(); f.corrupt();
    await expect(f.run(f.input)).rejects.toThrow("compressed digest mismatch");
    expect(await fs.readFile(f.input.outFile, "utf8")).toBe("previous snapshot");
  });
  it("bounds decompression and preserves the previous snapshot on an incorrect size claim", async () => {
    const f = await fixture(); f.metadata.bytes = 1;
    await expect(f.run(f.input)).rejects.toThrow("decompression exceeds");
    expect(await fs.readFile(f.input.outFile, "utf8")).toBe("previous snapshot");
  });
  it("does not start a task after drain has aborted observation", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.run({ ...f.input, signal: controller.signal })).rejects.toThrow();
    expect(f.tasks).toEqual([]); expect(f.reads).toEqual([]);
  });
});
