import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BundleHandoff } from "./bundle-handoff.js";
import {
  KnowledgeArtifactService,
  KNOWLEDGE_ARTIFACT_AGGREGATE_MAX_BYTES,
  KNOWLEDGE_ARTIFACT_MAX_RETRIES,
  KNOWLEDGE_ARTIFACT_MANIFEST_MAX_BYTES,
  KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES,
  KNOWLEDGE_ARTIFACT_RETRY_BASE_MS,
  knowledgeArtifactJobKey,
  type KnowledgeArtifactRemote,
  type KnowledgeArtifactServiceOptions,
  type RemoteKnowledgeStatus,
} from "./knowledge-artifact-service.js";

const SHA = "1".repeat(40);
let roots: string[] = [];
let services: KnowledgeArtifactService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services) await service.stop();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = []; services = [];
});

function fixture(
  remote: KnowledgeArtifactRemote,
  extra: {
    publicUrl?: string;
    provider?: KnowledgeArtifactServiceOptions["provider"];
    root?: string;
    now?: () => number;
    availableBytes?: (root: string) => Promise<number>;
    baselineStatus?: KnowledgeArtifactServiceOptions["baselineStatus"];
    evaluateArtifact?: KnowledgeArtifactServiceOptions["evaluateArtifact"];
    graphCommit?: string | null;
  } = {},
) {
  const root = extra.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-artifact-")); if (!extra.root) roots.push(root);
  const graphFile = path.join(root, "graph.db"); fs.writeFileSync(graphFile, "privacy-filtered graph");
  const graphSha = digest(fs.readFileSync(graphFile));
  const recordSetSha = digest(Buffer.from("privacy-filtered record set"));
  const activate = vi.fn();
  const service = new KnowledgeArtifactService({
    graph: {
      file: graphFile,
      artifactInput: async () => {
        const content = fs.readFileSync(graphFile);
        return {
          file: graphFile,
          repoSha: SHA,
          sha256: digest(content),
          bytes: content.length,
          recordSetSha256: recordSetSha,
          evaluationAsOf: "2026-08-23T00:00:00.000Z",
        };
      },
      prepareArtifacts: async () => { throw new Error("fixture has no valid code projection"); },
      activateArtifacts: activate,
      artifactsActive: () => false,
      commit: () => extra.graphCommit === undefined ? SHA : extra.graphCommit,
    },
    remote,
    ...(extra.provider ? { provider: extra.provider } : {}),
    bundles: new BundleHandoff(),
    publicUrl: extra.publicUrl ?? "https://bot.example",
    dir: path.join(root, "artifacts"),
    repoRoot: root,
    desiredShas: async () => [SHA, "2".repeat(40)],
    reconcileMs: 60_000,
    ...(extra.now ? { now: extra.now } : {}),
    ...(extra.availableBytes ? { availableBytes: extra.availableBytes } : {}),
    ...(extra.baselineStatus ? { baselineStatus: extra.baselineStatus } : {}),
    ...(extra.evaluateArtifact ? { evaluateArtifact: extra.evaluateArtifact } : {}),
  });
  services.push(service);
  return { root, graphFile, graphSha, recordSetSha, service, activate };
}

function status(jobKey: string, state: RemoteKnowledgeStatus["state"] = "running", files: RemoteKnowledgeStatus["files"] = []): RemoteKnowledgeStatus {
  return { job_key: jobKey, repo_sha: SHA, state, files };
}

describe("KnowledgeArtifactService", () => {
  it("ignores reconnect signals before restoring the durable no-replay fence", async () => {
    const remote = { protocolAvailable: () => true, syncSource: vi.fn(),
      status: vi.fn().mockRejectedValue(new Error("knowledge index job not found")),
      start: vi.fn(async (input) => status(input.jobKey)), read: vi.fn(), cancel: vi.fn() } as KnowledgeArtifactRemote;
    const current = fixture(remote, { provider: { owner: "lht", device: "new", checkoutDir: "/work/octopus" } });
    const oldJob = { jobKey: knowledgeArtifactJobKey(SHA, current.graphSha), repoSha: SHA,
      inputSha256: current.graphSha, inputBytes: fs.statSync(current.graphFile).size,
      phase: "prepared", retryCount: 0 };
    fs.mkdirSync(path.dirname(current.service.stateFile), { recursive: true });
    const original = JSON.stringify({ version: 1, retiredJobs: [oldJob] });
    fs.writeFileSync(current.service.stateFile, original);
    await current.service.kick();
    expect(fs.readFileSync(current.service.stateFile, "utf8")).toBe(original);
    expect(remote.start).not.toHaveBeenCalled();
    const starting = current.service.start();
    await current.service.kick();
    await starting;
    expect(current.service.health().task.unavailableReason).toBe("job_retired_no_replay");
    expect(remote.status).not.toHaveBeenCalled();
    expect(remote.start).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(current.service.stateFile, "utf8")).retiredJobs).toEqual([oldJob]);
  });

  it("preserves an explicitly retired legacy intent and never dispatches its key after restart", async () => {
    const remote = { protocolAvailable: () => false, syncSource: vi.fn(async () => undefined),
      status: vi.fn().mockRejectedValue(new Error("knowledge index job not found")),
      start: vi.fn(async (input) => status(input.jobKey)), read: vi.fn(), cancel: vi.fn() } as KnowledgeArtifactRemote;
    const legacy = fixture(remote);
    await legacy.service.start(); await legacy.service.stop();
    const oldJob = JSON.parse(fs.readFileSync(legacy.service.stateFile, "utf8")).job;
    // An operator freezes this writer and archives the old intent explicitly;
    // provider mismatch alone never performs this migration.
    fs.writeFileSync(legacy.service.stateFile, JSON.stringify({ version: 1, retiredJobs: [oldJob] }));
    remote.protocolAvailable = () => true;
    const current = fixture(remote, { root: legacy.root, provider: { owner: "lht", device: "new", checkoutDir: "/work/octopus" } });
    await current.service.start();
    expect(current.service.health().task.unavailableReason).toBe("job_retired_no_replay");
    expect(remote.status).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled();
    fs.writeFileSync(current.graphFile, "new privacy-filtered immutable input");
    await current.service.kick();
    expect(remote.start).toHaveBeenCalledTimes(1);
    expect(vi.mocked(remote.start).mock.calls[0][0].jobKey).not.toBe(oldJob.jobKey);
    expect(JSON.parse(fs.readFileSync(current.service.stateFile, "utf8")).retiredJobs).toEqual([oldJob]);
    await current.service.stop();
    vi.mocked(remote.start).mockClear(); vi.mocked(remote.status).mockClear();
    // fixture restores the old input, simulating a source/input rollback.
    const reverted = fixture(remote, { root: legacy.root, provider: { owner: "lht", device: "new", checkoutDir: "/work/octopus" } });
    await reverted.service.start();
    expect(reverted.service.health().task.unavailableReason).toBe("job_retired_no_replay");
    expect(remote.status).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled();
  });

  it.each([
    { owner: "another", device: "builder-a", checkoutDir: "/work/octopus" },
    { owner: "lht", device: "builder-b", checkoutDir: "/work/octopus" },
    { owner: "lht", device: "builder-a", checkoutDir: "/work/replaced" },
  ])("never queries or replays a durable job on a changed provider %j", async (nextProvider) => {
    const provider = { owner: "lht", device: "builder-a", checkoutDir: "/work/octopus" };
    const remote = { protocolAvailable: () => true, syncSource: vi.fn(async () => undefined),
      status: vi.fn().mockRejectedValue(new Error("knowledge index job not found")),
      start: vi.fn(async (input) => status(input.jobKey)), read: vi.fn(), cancel: vi.fn() } as KnowledgeArtifactRemote;
    const first = fixture(remote, { provider });
    await first.service.start();
    const persisted = fs.readFileSync(first.service.stateFile, "utf8");
    expect(JSON.parse(persisted).job.provider).toEqual(provider);
    await first.service.stop();
    vi.mocked(remote.status).mockClear(); vi.mocked(remote.start).mockClear(); vi.mocked(remote.syncSource).mockClear();
    const changed = fixture(remote, { provider: nextProvider, root: first.root });
    await changed.service.start();
    expect(changed.service.health().task.unavailableReason).toBe("provider_changed");
    expect(remote.status).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled(); expect(remote.syncSource).not.toHaveBeenCalled();
    expect(fs.readFileSync(first.service.stateFile, "utf8")).toBe(persisted);
    await changed.service.stop();
    vi.mocked(remote.status).mockImplementation(async (key) => status(key));
    const restored = fixture(remote, { provider, root: first.root });
    await restored.service.start();
    expect(remote.status).toHaveBeenCalledWith(JSON.parse(persisted).job.jobKey);
    expect(remote.start).not.toHaveBeenCalled();
  });

  it("does not assign legacy unbound jobs to a newly configured provider", async () => {
    const remote = { protocolAvailable: () => false, syncSource: vi.fn(), status: vi.fn(),
      start: vi.fn(), read: vi.fn(), cancel: vi.fn() } as KnowledgeArtifactRemote;
    const legacy = fixture(remote); await legacy.service.start(); await legacy.service.stop();
    const current = fixture(remote, { root: legacy.root, provider: { owner: "lht", device: "new", checkoutDir: "/work/octopus" } });
    await current.service.start();
    expect(current.service.health().task.unavailableReason).toBe("provider_identity_missing");
    expect(remote.status).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled();
  });

  it("supersedes an undispatched provider-bound input after an offline startup and restart", async () => {
    const provider = { owner: "lht", device: "builder", checkoutDir: "/work/octopus" };
    const remote = { protocolAvailable: () => false, syncSource: vi.fn(async () => undefined),
      status: vi.fn().mockRejectedValue(new Error("knowledge index job not found")),
      start: vi.fn(async (input) => status(input.jobKey)), read: vi.fn(), cancel: vi.fn() } as KnowledgeArtifactRemote;
    const initial = fixture(remote, { provider });
    await initial.service.start(); await initial.service.stop();
    const old = JSON.parse(fs.readFileSync(initial.service.stateFile, "utf8")).job;
    expect(old).toMatchObject({ phase: "prepared", provider, retryCount: 0 });
    expect(remote.start).not.toHaveBeenCalled();
    const restarted = fixture(remote, { root: initial.root, provider });
    fs.writeFileSync(restarted.graphFile, "updated graph after startup");
    remote.protocolAvailable = () => true;
    await restarted.service.start();
    expect(remote.status).not.toHaveBeenCalledWith(old.jobKey);
    expect(remote.cancel).not.toHaveBeenCalled();
    expect(remote.start).toHaveBeenCalledTimes(1);
    expect(vi.mocked(remote.start).mock.calls[0][0].jobKey).not.toBe(old.jobKey);
    expect(JSON.parse(fs.readFileSync(restarted.service.stateFile, "utf8")).job.phase).toBe("remote");
  });

  it("does not supersede an unknown dispatched input when the graph changes", async () => {
    const remote = { protocolAvailable: () => true, syncSource: vi.fn(async () => undefined),
      status: vi.fn().mockRejectedValue(new Error("knowledge index job not found")),
      start: vi.fn().mockRejectedValue(new Error("lost start response")), read: vi.fn(), cancel: vi.fn() } as KnowledgeArtifactRemote;
    const f = fixture(remote, { provider: { owner: "lht", device: "builder", checkoutDir: "/work/octopus" } });
    await f.service.start();
    const original = fs.readFileSync(f.service.stateFile, "utf8");
    fs.writeFileSync(f.graphFile, "newer input must not erase unknown execution");
    await f.service.kick();
    expect(remote.start).toHaveBeenCalledTimes(1);
    expect(remote.syncSource).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(f.service.stateFile, "utf8")).toBe(original);
    expect(f.service.health().task.unavailableReason).toBe("remote_job_missing");
  });

  it("persists dispatch intent before a lost start response and never replays a missing remote receipt", async () => {
    const remote = { protocolAvailable: () => true, syncSource: vi.fn(async () => undefined),
      status: vi.fn().mockRejectedValue(new Error("knowledge index job not found")),
      start: vi.fn(), read: vi.fn(), cancel: vi.fn() } as KnowledgeArtifactRemote;
    const f = fixture(remote, { provider: { owner: "lht", device: "builder", checkoutDir: "/work/octopus" } });
    vi.mocked(remote.start).mockImplementation(async () => {
      expect(JSON.parse(fs.readFileSync(f.service.stateFile, "utf8")).job.phase).toBe("remote");
      throw new Error("response lost after dispatch");
    });
    await f.service.start(); await f.service.kick();
    expect(remote.start).toHaveBeenCalledTimes(1);
    expect(f.service.health().task.unavailableReason).toBe("remote_job_missing");
    const key = JSON.parse(fs.readFileSync(f.service.stateFile, "utf8")).job.jobKey;
    vi.mocked(remote.status).mockResolvedValue(status(key));
    await f.service.kick();
    expect(f.service.health().task.unavailableReason).toBeNull();
    expect(remote.start).toHaveBeenCalledTimes(1);
  });

  it("reports the configured provider's concrete availability reason", async () => {
    const remote = { protocolAvailable: () => false, availability: () => "offline" as const,
      syncSource: vi.fn(), status: vi.fn(), start: vi.fn(), read: vi.fn(), cancel: vi.fn() } as KnowledgeArtifactRemote;
    const f = fixture(remote); await f.service.start();
    expect(f.service.health().task.unavailableReason).toBe("offline");
    expect(remote.start).not.toHaveBeenCalled();
  });

  it("waits for explicit protocol negotiation and never probes an old Runner", async () => {
    let available = false;
    const remote = {
      protocolAvailable: () => available,
      syncSource: vi.fn(async () => undefined), start: vi.fn(), status: vi.fn(), cancel: vi.fn(), read: vi.fn(),
    } as unknown as KnowledgeArtifactRemote;
    const f = fixture(remote); await f.service.start();
    expect(remote.status).not.toHaveBeenCalled(); expect(remote.start).not.toHaveBeenCalled();
    available = true;
    const key = knowledgeArtifactJobKey(SHA, f.graphSha);
    vi.mocked(remote.status).mockRejectedValue(new Error("knowledge index job not found"));
    vi.mocked(remote.start).mockResolvedValue(status(key));
    await f.service.kick();
    expect(remote.syncSource).toHaveBeenCalledWith(SHA);
    expect(remote.start).toHaveBeenCalledTimes(1);
  });

  it("treats a lost start response as indeterminate and adopts the same key without duplicating", async () => {
    let remoteState: RemoteKnowledgeStatus | null = null;
    let starts = 0;
    const f0: { graphSha?: string } = {};
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => true,
      syncSource: async () => undefined,
      status: async (key) => { if (!remoteState) throw new Error("job not found"); return status(key); },
      start: async (input) => { starts++; remoteState = status(input.jobKey); throw new Error("runner_gone"); },
      cancel: async (key) => status(key),
      read: async () => { throw new Error("not ready"); },
    };
    const f = fixture(remote); f0.graphSha = f.graphSha;
    await f.service.start();
    expect(starts).toBe(1);
    await f.service.kick();
    expect(starts).toBe(1);
    expect(f.service.status().job).toMatchObject({ jobKey: knowledgeArtifactJobKey(SHA, f.graphSha), phase: "remote", remoteState: "running" });
  });

  it("preflights pull capacity and keeps insufficient-space failures retryable", async () => {
    let key = "";
    const read = vi.fn();
    const files = [
      { file: "conformance-tests.json", bytes: 32, sha256: digest(Buffer.alloc(32)) },
      { file: "knowledge-artifact-manifest.json", bytes: 32, sha256: digest(Buffer.alloc(32)) },
    ];
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => true,
      syncSource: async () => undefined,
      status: async () => status(key, "upload_pending", files),
      start: async (input) => status(input.jobKey),
      cancel: async () => status(key),
      read,
    };
    const f = fixture(remote, { availableBytes: async () => 0 });
    key = knowledgeArtifactJobKey(SHA, f.graphSha);

    await f.service.start();

    expect(read).not.toHaveBeenCalled();
    expect(f.service.status().job).toMatchObject({ phase: "pulling" });
    expect(f.service.status().job?.failureCode).toBeUndefined();
    expect(f.service.status().job?.error).toMatch(/requires .* bytes/);
    expect(fs.existsSync(path.join(f.root, "artifacts", "generations", `${key}.partial`))).toBe(true);
  });

  it.each(["ENOSPC", "EDQUOT"])("retains resumable pulls after %s write failures", async (code) => {
    let key = "";
    const payload = Buffer.from("contract evidence");
    const files = [
      { file: "conformance-tests.json", bytes: payload.length, sha256: digest(payload) },
      { file: "knowledge-artifact-manifest.json", bytes: payload.length, sha256: digest(payload) },
    ];
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => true,
      syncSource: async () => undefined,
      status: async () => status(key, "upload_pending", files),
      start: async (input) => status(input.jobKey),
      cancel: async () => status(key),
      read: async () => { throw Object.assign(new Error(`${code} while writing artifact`), { code }); },
    };
    const f = fixture(remote, { availableBytes: async () => Number.MAX_SAFE_INTEGER });
    key = knowledgeArtifactJobKey(SHA, f.graphSha);

    await f.service.start();

    expect(f.service.status().job).toMatchObject({ phase: "pulling" });
    expect(f.service.status().job?.failureCode).toBeUndefined();
    expect(fs.existsSync(path.join(f.root, "artifacts", "generations", `${key}.partial`))).toBe(true);
  });

  it("fences a reconciliation pass that never settles and keeps polling with fresh passes", async () => {
    let now = Date.parse("2026-08-24T04:30:00.000Z");
    let hangs = 0;
    let polls = 0;
    const hung: { reject?: (error: Error) => void } = {};
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => true,
      syncSource: async () => undefined,
      status: async (key) => {
        polls += 1;
        if (polls === 2) {
          hangs += 1;
          return await new Promise<never>((_resolve, reject) => { hung.reject = reject; });
        }
        return status(key);
      },
      start: async (input) => status(input.jobKey),
      cancel: async (key) => status(key),
      read: async () => { throw new Error("not ready"); },
    };
    const f = fixture(remote, { now: () => now });
    await f.service.start();
    expect(f.service.status().job).toMatchObject({ phase: "remote", remoteState: "running" });

    const stuck = f.service.kick();
    await vi.waitFor(() => { expect(hangs).toBe(1); });
    expect(f.service.status().reconcile?.step).toBe("remote_status");
    now += 36 * 60_000;
    expect(f.service.checkStalledReconciliation()).toBe(true);
    await Promise.resolve();

    await f.service.kick();
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(f.service.status().job).toMatchObject({ phase: "remote", remoteState: "running" });
    expect(f.service.status().reconcile).toBeUndefined();

    hung.reject?.(new Error("late transport failure"));
    await stuck.catch(() => undefined);
    expect(f.service.status().job).toMatchObject({ phase: "remote", remoteState: "running" });
  });

  it("does not fence a pass that keeps making step progress", async () => {
    let now = Date.parse("2026-08-24T13:00:00.000Z");
    const hung: { reject?: (error: Error) => void } = {};
    let polls = 0;
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => true,
      syncSource: async () => undefined,
      status: async (key) => {
        polls += 1;
        if (polls === 2) {
          now += 20 * 60_000; // in-flight for twenty minutes, but the step just advanced
          return await new Promise<never>((_resolve, reject) => { hung.reject = reject; });
        }
        return status(key);
      },
      start: async (input) => status(input.jobKey),
      cancel: async (key) => status(key),
      read: async () => { throw new Error("not ready"); },
    };
    const f = fixture(remote, { now: () => now });
    await f.service.start();
    const stuck = f.service.kick();
    await vi.waitFor(() => { expect(polls).toBe(2); });
    expect(f.service.checkStalledReconciliation()).toBe(false);
    now += 36 * 60_000;
    expect(f.service.checkStalledReconciliation()).toBe(true);
    hung.reject?.(new Error("late failure"));
    await stuck.catch(() => undefined);
  });

  it("a fenced pass neither deletes the partial pull nor persists a failure", async () => {
    let now = Date.parse("2026-08-24T13:00:00.000Z");
    const payload = Buffer.from("contract evidence");
    const hung: { reject?: (error: Error) => void } = {};
    let key = "";
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => true,
      syncSource: async () => undefined,
      status: async () => status(key, "upload_pending", [
        { file: "conformance-tests.json", bytes: payload.length, sha256: digest(payload) },
        { file: "knowledge-artifact-manifest.json", bytes: payload.length, sha256: digest(payload) },
      ]),
      start: async (input) => status(input.jobKey),
      cancel: async () => status(key),
      read: async () => await new Promise<never>((_resolve, reject) => { hung.reject = reject; }),
    };
    const f = fixture(remote, { now: () => now });
    key = knowledgeArtifactJobKey(SHA, f.graphSha);
    const started = f.service.start();
    await vi.waitFor(() => { expect(hung.reject).toBeDefined(); });
    const partial = path.join(f.root, "artifacts", "generations", `${key}.partial`);
    expect(fs.existsSync(partial)).toBe(true);

    now += 36 * 60_000;
    expect(f.service.checkStalledReconciliation()).toBe(true);
    hung.reject?.(new Error("late chunk failure"));
    await started.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fs.existsSync(partial)).toBe(true);
    expect(f.service.status().job?.phase).not.toBe("failed");
  });

  it("resumes polling when a withdrawn protocol advertisement returns", async () => {
    let protocol = true;
    let polls = 0;
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => protocol,
      syncSource: async () => undefined,
      status: async (key) => { polls += 1; return status(key); },
      start: async (input) => status(input.jobKey),
      cancel: async (key) => status(key),
      read: async () => { throw new Error("not ready"); },
    };
    const f = fixture(remote);
    await f.service.start();
    expect(f.service.status().job).toMatchObject({ phase: "remote", remoteState: "running" });
    const before = polls;

    protocol = false;
    await f.service.kick();
    await f.service.kick();
    expect(polls).toBe(before);
    expect(f.service.status().job).toMatchObject({ phase: "remote" });

    protocol = true;
    await f.service.kick();
    expect(polls).toBeGreaterThan(before);
    expect(f.service.status().job).toMatchObject({ phase: "remote", remoteState: "running" });
  });

  it("reoffers a fresh one-use input for the same key after a transient Runner fetch", async () => {
    let now = Date.parse("2026-08-23T12:00:00.000Z");
    const starts: Array<{ jobKey: string; inputUrl: string }> = [];
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => true,
      syncSource: async () => undefined,
      status: async () => { throw new Error("job not found"); },
      start: async (input) => {
        starts.push({ jobKey: input.jobKey, inputUrl: input.inputUrl });
        return starts.length === 1
          ? { ...status(input.jobKey, "queued"), error: { code: "input_pending", message: "temporary link loss" } }
          : status(input.jobKey, "running");
      },
      cancel: async (key) => status(key),
      read: async () => { throw new Error("not ready"); },
    };
    const f = fixture(remote, { now: () => now });
    await f.service.start();
    expect(starts).toHaveLength(1);
    expect(f.service.status().job).toMatchObject({ phase: "prepared", retryCount: 1 });
    now += KNOWLEDGE_ARTIFACT_RETRY_BASE_MS;
    await f.service.kick();
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((row) => row.jobKey))).toEqual(new Set([knowledgeArtifactJobKey(SHA, f.graphSha)]));
    expect(starts[0].inputUrl).not.toBe(starts[1].inputUrl);
    expect(f.service.status().job).toMatchObject({ phase: "remote", remoteState: "running" });
  });

  it("resumes a per-file .partial from its exact offset and never activates an incomplete generation", async () => {
    let available = false;
    let key = "";
    const payload = Buffer.from("contract evidence");
    const unsigned = {
      schemaVersion: 1, kind: "octopus-knowledge-artifact", repoSha: SHA,
      input: { sha256: "", bytes: 0 },
      files: [{ path: "conformance-tests.json", bytes: payload.length, sha256: digest(payload) }],
    };
    let manifest = Buffer.alloc(0);
    const reads: Array<{ file: string; offset: number }> = [];
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => available,
      syncSource: async () => undefined,
      status: async () => status(key, "upload_pending", [
        { file: "conformance-tests.json", bytes: payload.length, sha256: digest(payload) },
        { file: "knowledge-artifact-manifest.json", bytes: manifest.length, sha256: digest(manifest) },
      ]),
      start: async () => { throw new Error("not used"); },
      cancel: async () => status(key),
      read: async (jobKey, file, offset, length) => {
        reads.push({ file, offset });
        const source = file === "conformance-tests.json" ? payload : manifest;
        const data = source.subarray(offset, offset + length);
        return { job_key: jobKey, file, offset, bytes: data.length, data: data.toString("base64"), eof: offset + data.length === source.length,
          sha256: digest(source) };
      },
    };
    const f = fixture(remote);
    key = knowledgeArtifactJobKey(SHA, f.graphSha);
    unsigned.input = { sha256: f.graphSha, bytes: fs.statSync(f.graphFile).size };
    const doc = { ...unsigned, manifestDigest: digest(Buffer.from(canonical(unsigned))) };
    manifest = Buffer.from(`${canonical(doc)}\n`);
    const artifacts = path.join(f.root, "artifacts");
    const partial = path.join(artifacts, "generations", `${key}.partial`, "conformance-tests.json.partial");
    fs.mkdirSync(path.dirname(partial), { recursive: true });
    fs.writeFileSync(partial, payload.subarray(0, 5));
    fs.writeFileSync(path.join(artifacts, "service-state.json"), JSON.stringify({
      version: 1,
      job: {
        jobKey: key,
        repoSha: SHA,
        inputSha256: f.graphSha,
        inputBytes: fs.statSync(f.graphFile).size,
        phase: "pulling",
        remoteState: "upload_pending",
        retryCount: 0,
      },
    }));
    available = true;
    await expect(f.service.start()).resolves.toBeUndefined();
    expect(reads).toContainEqual({ file: "conformance-tests.json", offset: 5 });
    const readCount = reads.length;
    await f.service.kick();
    expect(reads).toHaveLength(readCount);
    expect(f.service.status().job).toMatchObject({ phase: "failed", failureCode: "artifact_rejected" });
    expect(f.activate).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.root, "artifacts", "active.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, "artifacts", "generations", `${key}.partial`))).toBe(false);
  });

  it("requires HTTPS handoff origins except for explicit loopback HTTP", () => {
    const remote = {
      protocolAvailable: () => false,
      syncSource: vi.fn(), start: vi.fn(), status: vi.fn(), cancel: vi.fn(), read: vi.fn(),
    } as unknown as KnowledgeArtifactRemote;
    expect(() => fixture(remote, { publicUrl: "http://bot.example" })).toThrow(/HTTPS/);
    for (const origin of ["http://127.0.0.1:9820", "http://localhost:9820", "http://[::1]:9820", "https://bot.example"]) {
      expect(() => fixture(remote, { publicUrl: origin })).not.toThrow();
    }
  });

  it("rejects member, manifest, and aggregate byte ceilings before pulling and cleans rejected partials", async () => {
    for (const files of [
      [
        { file: "conformance-tests.json", bytes: KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES + 1, sha256: "a".repeat(64) },
        { file: "knowledge-artifact-manifest.json", bytes: 1, sha256: "b".repeat(64) },
      ],
      [
        ...Array.from(
          { length: Math.floor(KNOWLEDGE_ARTIFACT_AGGREGATE_MAX_BYTES / KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES) + 1 },
          (_, index) => ({ file: `code/member-${index}.bin`, bytes: KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES, sha256: digest(Buffer.from(String(index))) }),
        ),
        { file: "knowledge-artifact-manifest.json", bytes: 1, sha256: "b".repeat(64) },
      ],
      [
        { file: "conformance-tests.json", bytes: 1, sha256: "a".repeat(64) },
        { file: "knowledge-artifact-manifest.json", bytes: KNOWLEDGE_ARTIFACT_MANIFEST_MAX_BYTES + 1, sha256: "b".repeat(64) },
      ],
    ]) {
      let key = "";
      const read = vi.fn();
      const remote: KnowledgeArtifactRemote = {
        protocolAvailable: () => true,
        syncSource: async () => undefined,
        status: async () => status(key, "upload_pending", files),
        start: async () => { throw new Error("not used"); },
        cancel: async () => status(key),
        read,
      };
      const f = fixture(remote);
      key = knowledgeArtifactJobKey(SHA, f.graphSha);
      const artifacts = path.join(f.root, "artifacts");
      const partial = path.join(artifacts, "generations", `${key}.partial`);
      fs.mkdirSync(partial, { recursive: true });
      fs.writeFileSync(path.join(partial, "abandoned"), "remove");
      fs.writeFileSync(path.join(artifacts, "service-state.json"), JSON.stringify({
        version: 1,
        job: {
          jobKey: key,
          repoSha: SHA,
          inputSha256: f.graphSha,
          inputBytes: fs.statSync(f.graphFile).size,
          phase: "pulling",
          remoteState: "upload_pending",
          retryCount: 0,
        },
      }));
      await f.service.start();
      expect(f.service.status().job).toMatchObject({ phase: "failed", failureCode: "artifact_rejected" });
      expect(read).not.toHaveBeenCalled();
      expect(fs.existsSync(partial)).toBe(false);
    }
  });

  it("garbage-collects only contained inactive generations while preserving active and resumable state", async () => {
    const remote = {
      protocolAvailable: () => false,
      syncSource: vi.fn(), start: vi.fn(), status: vi.fn(), cancel: vi.fn(), read: vi.fn(),
    } as unknown as KnowledgeArtifactRemote;
    const f = fixture(remote);
    const key = knowledgeArtifactJobKey(SHA, f.graphSha);
    const artifacts = path.join(f.root, "artifacts");
    const generations = path.join(artifacts, "generations");
    fs.mkdirSync(generations, { recursive: true });
    fs.writeFileSync(path.join(artifacts, "service-state.json"), JSON.stringify({
      version: 1,
      job: {
        jobKey: key,
        repoSha: SHA,
        inputSha256: f.graphSha,
        inputBytes: fs.statSync(f.graphFile).size,
        phase: "pulling",
        remoteState: "upload_pending",
        retryCount: 0,
      },
    }));
    const resumable = path.join(generations, `${key}.partial`);
    const abandoned = path.join(generations, `${"3".repeat(64)}.partial`);
    const inactive = path.join(generations, "4".repeat(64));
    for (const directory of [resumable, abandoned, inactive]) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "payload"), "data");
    }
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "outside");
    fs.symlinkSync(outside, path.join(generations, "linked.partial"), "dir");
    const activeName = "5".repeat(64);
    const activeGeneration = path.join(generations, activeName);
    fs.mkdirSync(activeGeneration);
    fs.writeFileSync(path.join(activeGeneration, "payload"), "active");
    fs.writeFileSync(path.join(artifacts, "active.json"), JSON.stringify({
      version: 1,
      repoSha: SHA,
      inputSha256: f.graphSha,
      recordSetSha256: f.recordSetSha,
      jobKey: key,
      manifestDigest: activeName,
      generation: activeGeneration,
    }));

    await f.service.start();
    expect(fs.existsSync(resumable)).toBe(true);
    expect(fs.existsSync(abandoned)).toBe(false);
    expect(fs.existsSync(inactive)).toBe(false);
    expect(fs.existsSync(path.join(generations, "linked.partial"))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("outside");
    expect(fs.readFileSync(path.join(activeGeneration, "payload"), "utf8")).toBe("active");
    await f.service.kick();
    expect(fs.existsSync(resumable)).toBe(true);
    expect(fs.existsSync(activeGeneration)).toBe(true);
  });

  it.each([
    { name: "different commit", commit: "2".repeat(40), recordMismatch: false, readsWeights: false },
    { name: "missing graph", commit: null, recordMismatch: false, readsWeights: false },
    { name: "different contextual records", commit: SHA, recordMismatch: true, readsWeights: false },
    { name: "current graph with corrupt weights", commit: SHA, recordMismatch: false, readsWeights: true },
  ])("checks persisted identity before expensive artifacts: $name", async ({ commit, recordMismatch, readsWeights }) => {
    const remote = { protocolAvailable: () => false, syncSource: vi.fn(), start: vi.fn(),
      status: vi.fn(), cancel: vi.fn(), read: vi.fn() } as unknown as KnowledgeArtifactRemote;
    const f = fixture(remote, { graphCommit: commit });
    const recordSetSha = recordMismatch ? "e".repeat(64) : f.recordSetSha;
    const weights = Buffer.from("corrupt model bytes");
    const unsigned = {
      schemaVersion: 1, kind: "octopus-knowledge-artifact", repoSha: SHA,
      input: { sha256: f.graphSha, bytes: fs.statSync(f.graphFile).size },
      bindings: { recordSetDigest: recordSetSha },
      files: [{ path: "model/model.onnx", bytes: weights.length, sha256: "a".repeat(64) }],
    };
    const manifestDigest = digest(Buffer.from(canonical(unsigned)));
    const artifacts = path.join(f.root, "artifacts"), generation = path.join(artifacts, "generations", manifestDigest);
    fs.mkdirSync(path.join(generation, "model"), { recursive: true });
    const modelFile = path.join(generation, "model", "model.onnx");
    fs.writeFileSync(modelFile, weights);
    fs.writeFileSync(path.join(generation, "knowledge-artifact-manifest.json"),
      JSON.stringify({ ...unsigned, manifestDigest }));
    fs.writeFileSync(path.join(artifacts, "active.json"), JSON.stringify({
      version: 1, repoSha: SHA, inputSha256: f.graphSha, recordSetSha256: recordSetSha,
      jobKey: knowledgeArtifactJobKey(SHA, f.graphSha), manifestDigest, generation,
    }));
    const stream = vi.spyOn(fs, "createReadStream");
    await f.service.start();
    expect(stream.mock.calls.some(([file]) => String(file) === modelFile)).toBe(readsWeights);
    expect(f.activate).not.toHaveBeenCalled();
    expect(remote.start).not.toHaveBeenCalled();
    // Both stale and invalid current candidates retain the existing GC fence.
    expect(fs.readFileSync(modelFile)).toEqual(weights);
    await f.service.kick();
    expect(fs.existsSync(generation)).toBe(true);
  });

  it("loads active state before GC and removes only bounded artifact-root temp files", async () => {
    const remote = {
      protocolAvailable: () => false,
      syncSource: vi.fn(), start: vi.fn(), status: vi.fn(), cancel: vi.fn(), read: vi.fn(),
    } as unknown as KnowledgeArtifactRemote;
    const f = fixture(remote);
    const key = knowledgeArtifactJobKey(SHA, f.graphSha);
    const artifacts = path.join(f.root, "artifacts");
    const activeName = "6".repeat(64);
    const activeGeneration = path.join(artifacts, "generations", activeName);
    fs.mkdirSync(activeGeneration, { recursive: true });
    fs.writeFileSync(path.join(activeGeneration, "payload"), "protect before validation");
    fs.writeFileSync(path.join(artifacts, "service-state.json"), JSON.stringify({
      version: 1,
      active: {
        repoSha: SHA,
        inputSha256: f.graphSha,
        recordSetSha256: f.recordSetSha,
        jobKey: key,
        manifestDigest: activeName,
        generation: activeGeneration,
      },
    }));
    const orphan = path.join(artifacts, "service-state.json.123.deadbeef.tmp");
    fs.writeFileSync(orphan, "");
    fs.utimesSync(orphan, new Date(0), new Date(0));

    await f.service.start();

    expect(f.service.status().active).toMatchObject({ manifestDigest: activeName, generation: activeGeneration });
    expect(fs.existsSync(activeGeneration)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("recovers explicit process loss with injected-time bounded retries, including persisted failed state", async () => {
    let now = Date.parse("2026-08-23T12:00:00.000Z");
    let key = "";
    let starts = 0;
    const processLost = () => ({ ...status(key, "orphaned"), error: { code: "process_lost", message: "wrapper disappeared" } });
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => true,
      syncSource: async () => undefined,
      status: async () => processLost(),
      start: async () => { starts += 1; return processLost(); },
      cancel: async () => processLost(),
      read: async () => { throw new Error("not ready"); },
    };
    const f = fixture(remote, { now: () => now });
    key = knowledgeArtifactJobKey(SHA, f.graphSha);
    await f.service.start();
    expect(f.service.status().job).toMatchObject({ phase: "prepared", retryCount: 1 });
    now += KNOWLEDGE_ARTIFACT_RETRY_BASE_MS;
    await f.service.kick();
    now += KNOWLEDGE_ARTIFACT_RETRY_BASE_MS * 2;
    await f.service.kick();
    expect(starts).toBe(KNOWLEDGE_ARTIFACT_MAX_RETRIES);
    expect(f.service.status().job).toMatchObject({ phase: "failed", retryCount: KNOWLEDGE_ARTIFACT_MAX_RETRIES });
    now += 60_000;
    await f.service.kick();
    expect(starts).toBe(KNOWLEDGE_ARTIFACT_MAX_RETRIES);

    let recoveredStarts = 0;
    let recoveredKey = "";
    const recoveredRemote: KnowledgeArtifactRemote = {
      protocolAvailable: () => true,
      syncSource: async () => undefined,
      status: async () => { throw new Error("persisted retry should start directly"); },
      start: async (input) => { recoveredStarts += 1; return status(input.jobKey, "running"); },
      cancel: async () => status(recoveredKey),
      read: async () => { throw new Error("not ready"); },
    };
    const recovered = fixture(recoveredRemote, { now: () => now });
    recoveredKey = knowledgeArtifactJobKey(SHA, recovered.graphSha);
    const recoveredArtifacts = path.join(recovered.root, "artifacts");
    fs.mkdirSync(recoveredArtifacts, { recursive: true });
    fs.writeFileSync(path.join(recoveredArtifacts, "service-state.json"), JSON.stringify({
      version: 1,
      job: {
        jobKey: recoveredKey,
        repoSha: SHA,
        inputSha256: recovered.graphSha,
        inputBytes: fs.statSync(recovered.graphFile).size,
        phase: "failed",
        remoteState: "orphaned",
        failureCode: "process_lost",
        error: "persisted process loss",
        retryCount: 0,
      },
    }));
    await recovered.service.start();
    expect(recoveredStarts).toBe(1);
    expect(recovered.service.status().job).toMatchObject({ phase: "remote", remoteState: "running" });
  });

  it("keeps permanent builder failure poisoned for the same input and permits a new deterministic key", async () => {
    let initialKey = "";
    let statusCalls = 0;
    let starts = 0;
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => true,
      syncSource: async () => undefined,
      status: async (key) => {
        statusCalls += 1;
        if (key === initialKey) return { ...status(key, "failed"), error: { code: "builder_failed", message: "conformance builder failed" } };
        throw new Error("job not found");
      },
      start: async (input) => { starts += 1; return status(input.jobKey, "running"); },
      cancel: async (key) => status(key),
      read: async () => { throw new Error("not ready"); },
    };
    const f = fixture(remote);
    initialKey = knowledgeArtifactJobKey(SHA, f.graphSha);
    await f.service.start();
    expect(f.service.status().job).toMatchObject({ phase: "failed", failureCode: "builder_failed" });
    await f.service.kick();
    expect(statusCalls).toBe(1);
    expect(starts).toBe(0);

    fs.writeFileSync(f.graphFile, "changed privacy-filtered graph");
    await f.service.kick();
    expect(starts).toBe(1);
    expect(f.service.status().job).toMatchObject({ phase: "remote", remoteState: "running" });
  });

  it("projects the latest named failure without remote error text, paths, or deterministic job keys", async () => {
    let key = "";
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => true,
      syncSource: async () => undefined,
      status: async () => ({
        ...status(key, "failed"),
        error: {
          code: "conformance_failed:contracts,omp-rpc",
          message: "private builder path /work/index-jobs and diagnostic detail",
        },
      }),
      start: async (input) => status(input.jobKey),
      cancel: async () => status(key),
      read: async () => { throw new Error("not ready"); },
    };
    const f = fixture(remote);
    key = knowledgeArtifactJobKey(SHA, f.graphSha);

    await f.service.start();

    expect(f.service.health()).toMatchObject({
      configured: true,
      status: "unavailable",
      task: { phase: "failed", remoteState: "failed" },
      lastFailureCode: "conformance_failed:contracts,omp-rpc",
      active: null,
    });
    expect(JSON.stringify(f.service.health())).not.toMatch(/private builder|\/work\/|jobKey|error/u);
  });

  it("binds the deterministic key to every schema/toolchain/model identity", () => {
    expect(knowledgeArtifactJobKey(SHA, "a".repeat(64))).toMatch(/^[0-9a-f]{64}$/);
    expect(knowledgeArtifactJobKey(SHA, "a".repeat(64))).not.toBe(knowledgeArtifactJobKey(SHA, "b".repeat(64)));
    expect(() => knowledgeArtifactJobKey("HEAD", "a".repeat(64))).toThrow(/invalid deterministic/);
  });
});

function digest(value: Buffer) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}
