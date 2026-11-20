import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DeployArtifactService, parseReleaseManifest, ReleaseBytePacer, RELEASE_SCRATCH } from "./deploy-artifact.js";
import { gitOrThrow } from "./worktree.js";
import type { WorkspaceProvider } from "./workspace-provider.js";
import type { DeployIntentRow } from "../store/repositories/dev-tickets.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const digest = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-artifact-")); roots.push(dir);
  const repo = path.join(dir, "repo"); await fs.mkdir(repo);
  await gitOrThrow(repo, ["init", "-q"]);
  await fs.writeFile(path.join(repo, "pnpm-lock.yaml"), "lock");
  await gitOrThrow(repo, ["add", "."]);
  await gitOrThrow(repo, ["-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "input"]);
  const sha = await gitOrThrow(repo, ["rev-parse", "HEAD"]);
  const files: Record<string, Buffer> = { "dependencies.tar.gz": Buffer.from("deps"), "outputs.tar.gz": Buffer.from("outputs") };
  const manifest = { version: 1, repoSha: sha, node: process.version, platform: process.platform, arch: process.arch,
    nodeAbi: process.versions.modules, lockSha256: digest("lock"), outputs: ["packages/runner/dist"],
    parts: Object.entries(files).map(([file, bytes]) => ({ name: file.split(".")[0], file, bytes: bytes.length, sha256: digest(bytes) })) };
  files["release.json"] = Buffer.from(JSON.stringify(manifest));
  const provider = { target: { owner: "lht", device: "ci", workspaceId: "ws_test" },
    wait: vi.fn(async () => ({ state: "succeeded", job_id: "job" })),
    artifact: vi.fn(async (_key: string, file: string, offset: number, length: number) => {
      const data = files[file]; return { data: data.subarray(offset, offset + length), total: data.length, eof: offset + length >= data.length };
    }),
  };
  const opts = { dir: path.join(dir, "artifacts"), repoDir: repo, worktreesDir: path.join(dir, "worktrees"), provider: () => provider as unknown as WorkspaceProvider };
  await fs.mkdir(opts.worktreesDir);
  return { dir, repo, sha, files, manifest, provider, opts, intent: { id: 300, target_sha: sha } as DeployIntentRow };
}

describe("remote release preparation", () => {
  it("activates an already staged release without joining a newer preparation", async () => {
    const f = await fixture();
    const releasesDir = path.join(f.dir, "releases"), staged = path.join(releasesDir, f.sha);
    await fs.mkdir(staged, { recursive: true });
    await fs.writeFile(path.join(staged, ".octopus-release.json"), f.files["release.json"]);
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const provider = vi.fn(async (intent: Pick<DeployIntentRow, "target_sha">) => {
      if (intent.target_sha !== f.sha) await blocked;
      return f.provider as unknown as WorkspaceProvider;
    });
    const service = new DeployArtifactService({ ...f.opts, releasesDir, provider });
    const newer = service.prewarm("e".repeat(40));
    try {
      await vi.waitFor(() => expect(provider).toHaveBeenCalledWith({ target_sha: "e".repeat(40) }));
      expect(await service.stagedShas()).toEqual([f.sha]);
      await service.prepare({ ...f.intent, release_manifest_sha256: digest(f.files["release.json"]) });
      expect(JSON.parse(await fs.readFile(path.join(f.opts.dir, "intents/300.json"), "utf8"))).toMatchObject({ sha: f.sha, state: "ready" });
      expect(f.provider.wait).not.toHaveBeenCalled();
    } finally { unblock(); await newer; service.close(); }
  });
  it("binds the optional CI inventory to the dependency object and bounded output path", async () => {
    const f = await fixture();
    const manifest = { ...f.manifest, outputs: [...f.manifest.outputs, "packages/bot/dist"], dependencyIndex: {
      version: 1, file: "packages/bot/dist/release-dependency-index.jsonl", bytes: 1024, entries: 6, payloadBytes: 400,
      sha256: "b".repeat(64), archiveSha256: f.manifest.parts[0]!.sha256,
    } };
    expect(parseReleaseManifest(JSON.stringify(manifest), f.sha).dependencyIndex).toEqual(manifest.dependencyIndex);
    for (const bad of [{ file: "../../index" }, { archiveSha256: "0".repeat(64) }, { bytes: 65 * 1024 ** 2 }, { entries: 200001 }]) {
      expect(() => parseReleaseManifest(JSON.stringify({ ...manifest, dependencyIndex: { ...manifest.dependencyIndex, ...bad } }), f.sha)).toThrow(/inventory/);
    }
  });
  it("accounts for transfer time and bounds idle pacing credit", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const pace = new ReleaseBytePacer(1000, () => now, async ms => { sleeps.push(ms); now += ms; });
    const signal = new AbortController().signal;
    await pace.step(100, signal);
    const count = sleeps.length;
    now += 100; await pace.step(100, signal);
    expect(sleeps).toHaveLength(count);
    now += 10000; await pace.step(1000, signal);
    expect(sleeps.at(-1)).toBe(900);
  });
  it("retains phase evidence after ready and does not attach another SHA's installer receipt", async () => {
    const f = await fixture(); const service = new DeployArtifactService(f.opts);
    await service.prewarm(f.sha);
    const report = path.join(f.opts.dir, "preparations", `${f.sha}.install.json`);
    await fs.writeFile(report, JSON.stringify({ sha: "b".repeat(40), state: "succeeded", phases: [] }));
    expect((await service.status(f.sha)).installation).toBeUndefined();
    const phases = [{ name: "dependencies_link", state: "succeeded", elapsedMs: 1200, filesReused: 42 }];
    await fs.writeFile(report, JSON.stringify({ sha: f.sha, state: "succeeded", phases, elapsedMs: 1400 }));
    const state = await service.status(f.sha);
    expect(state.phases?.map(p => p.name)).toContain("receive_outputs");
    expect(state.installation?.phases).toEqual(phases);
  });
  it("downloads complete artifacts without changing the live/reference checkout, and reuses ready receipts", async () => {
    const f = await fixture(); const service = new DeployArtifactService(f.opts);
    await Promise.all([service.prepare(f.intent), service.prepare(f.intent)]);
    const state = JSON.parse(await fs.readFile(path.join(f.opts.dir, "intents/300.json"), "utf8"));
    expect(state).toMatchObject({ state: "ready", sha: f.sha, device: "ci" });
    expect(JSON.parse(await fs.readFile(path.join(f.opts.dir, "preparations", `${f.sha}.json`), "utf8"))).toMatchObject({ transferredBytes: 11 });
    expect(await gitOrThrow(f.repo, ["rev-parse", "HEAD"])).toBe(f.sha);
    expect(await fs.stat(path.join(f.repo, "node_modules")).catch(() => null)).toBeNull();
    expect(f.provider.wait).toHaveBeenCalledTimes(1);
    await new DeployArtifactService(f.opts).prepare(f.intent);
    expect(f.provider.wait).toHaveBeenCalledTimes(1);
    await new DeployArtifactService(f.opts).prepare({ ...f.intent, id: 301 });
    expect(f.provider.wait).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(path.join(f.opts.dir, "intents/301.json"), "utf8"))).toMatchObject({ state: "ready", cached: true, transferredBytes: 0 });
  });
  it("rejects mismatched runtime or source before any archive is fetched", async () => {
    const f = await fixture(); f.files["release.json"] = Buffer.from(JSON.stringify({ ...f.manifest, nodeAbi: "wrong" }));
    await new DeployArtifactService(f.opts).prepare(f.intent);
    expect(JSON.parse(await fs.readFile(path.join(f.opts.dir, "intents/300.json"), "utf8")).state).toBe("failed");
    expect(f.provider.artifact).toHaveBeenCalledTimes(1);
    expect(() => parseReleaseManifest(JSON.stringify(f.manifest), "0".repeat(40))).toThrow();
  });
  it("never marks failed builds or corrupted output ready", async () => {
    const f = await fixture(); f.files["outputs.tar.gz"] = Buffer.from("CORRUPT");
    await new DeployArtifactService(f.opts).prepare(f.intent);
    expect(JSON.parse(await fs.readFile(path.join(f.opts.dir, "intents/300.json"), "utf8")).state).toBe("failed");
    expect(await fs.stat(path.join(f.opts.dir, "manifests", `${f.sha}.json`)).catch(() => null)).toBeNull();
  });
  it("resumes an interrupted byte transfer from its saved offset", async () => {
    const f = await fixture(); const part = f.manifest.parts[0];
    await fs.mkdir(path.join(f.opts.dir, "objects"), { recursive: true });
    await fs.writeFile(path.join(f.opts.dir, "objects", `${part.sha256}.tar.gz.partial`), "de");
    await new DeployArtifactService(f.opts).prepare(f.intent);
    expect(f.provider.artifact).toHaveBeenCalledWith(expect.any(String), "dependencies.tar.gz", 2, 2, expect.any(AbortSignal));
    expect(JSON.parse(await fs.readFile(path.join(f.opts.dir, "intents/300.json"), "utf8")).state).toBe("ready");
  });

  it("shares a preparation with deploy and exposes ready only after staging completes", async () => {
    const f = await fixture();
    let finish!: () => void;
    const staged = new Promise<void>(resolve => { finish = resolve; });
    const stage = vi.fn(() => staged);
    const service = new DeployArtifactService({ ...f.opts, stage });
    const warm = service.prewarm(f.sha), deploy = service.prepare(f.intent);
    await vi.waitFor(() => expect(stage).toHaveBeenCalledTimes(1));
    expect((await service.status(f.sha)).state).toBe("staging");
    expect(await fs.stat(path.join(f.opts.dir, "intents/300.json")).catch(() => null)).toBeNull();
    finish(); await Promise.all([warm, deploy]);
    expect((await service.status(f.sha)).state).toBe("ready");
    expect(f.provider.wait).toHaveBeenCalledTimes(1);
  });

  it("retries a failed staging on a later poll after a pause, never in a tight loop", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
    const f = await fixture();
    let full = true;
    const stage = vi.fn(async () => { if (full) throw new Error("insufficient release staging space after bounded cleanup"); });
    const service = new DeployArtifactService({ ...f.opts, stage });
    await service.prepare(f.intent);
    expect(await service.status(f.sha)).toMatchObject({ state: "failed", error: "insufficient release staging space after bounded cleanup" });
    expect(JSON.parse(await fs.readFile(path.join(f.opts.dir, "intents/300.json"), "utf8")).state).toBe("failed");
    // Space is freed, but polls within the pause do not run the installer again.
    full = false;
    vi.setSystemTime(new Date("2026-10-15T00:09:59.000Z"));
    await service.prewarm(f.sha);
    await service.prepare({ ...f.intent, id: 301 });
    expect(stage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(path.join(f.opts.dir, "intents/301.json"), "utf8")).state).toBe("failed");
    // The first poll after it stages again from the cached objects: no rebuild.
    vi.setSystemTime(new Date("2026-10-15T00:10:01.000Z"));
    await service.prewarm(f.sha);
    expect(stage).toHaveBeenCalledTimes(2);
    expect((await service.status(f.sha)).state).toBe("ready");
    expect(f.provider.wait).toHaveBeenCalledTimes(1);
  });

  it("retries a failed staging at once when an operator explicitly prepares it", async () => {
    const f = await fixture();
    let full = true;
    const stage = vi.fn(async () => { if (full) throw new Error("disk budget"); });
    const service = new DeployArtifactService({ ...f.opts, stage });
    await service.prewarm(f.sha);
    expect(await service.status(f.sha)).toMatchObject({ state: "failed", error: "disk budget" });
    full = false;
    await service.prewarm(f.sha);
    expect(stage).toHaveBeenCalledTimes(1);
    await service.prewarm(f.sha, { retryFailed: true });
    expect(stage).toHaveBeenCalledTimes(2);
    expect((await service.status(f.sha)).state).toBe("ready");
    // The per-SHA source checkout it leaves is what the startup sweep matches.
    expect((await fs.readdir(f.opts.worktreesDir)).filter(name => RELEASE_SCRATCH.test(name))).toEqual([`_release-${f.sha}`]);
  });

  it("rejects oversized chunks and a mismatched lock before declaring readiness", async () => {
    const f = await fixture();
    f.files["release.json"] = Buffer.from(JSON.stringify({ ...f.manifest, lockSha256: "0".repeat(64) }));
    await new DeployArtifactService(f.opts).prepare(f.intent);
    expect(f.provider.artifact).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(path.join(f.opts.dir, "intents/300.json"), "utf8")).state).toBe("failed");
  });
});
