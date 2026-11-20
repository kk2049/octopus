import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conformanceFailureCode,
  conformanceRetryResult,
  fixedConformanceFailure,
  KnowledgeIndexManager,
  knowledgeIndexEnabled,
  KNOWLEDGE_ARTIFACT_AGGREGATE_MAX_BYTES,
  KNOWLEDGE_ARTIFACT_MANIFEST_MAX_BYTES,
  KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES,
  KNOWLEDGE_INDEX_CHUNK_MAX_BYTES,
  KNOWLEDGE_INDEX_LAUNCH_LEASE_MS,
  KNOWLEDGE_INDEX_MAX_LAUNCH_ATTEMPTS,
  KNOWLEDGE_INDEX_TERMINAL_MAX_COUNT,
  KNOWLEDGE_INDEX_TERMINAL_TTL_MS,
  type KnowledgeIndexState,
} from "./knowledge-index.js";

describe("knowledge endpoint eligibility", () => {
  it("requires explicit execution-only opt-in while retaining existing Linux compatibility", () => {
    const linux = { allowMachineOps: true, executionOnly: false, platform: "linux" as const };
    expect(knowledgeIndexEnabled(linux)).toBe(true);
    expect(knowledgeIndexEnabled({ ...linux, setting: "0" })).toBe(false);
    for (const setting of [undefined, "0", "true", "unexpected"]) {
      expect(knowledgeIndexEnabled({ ...linux, executionOnly: true, setting })).toBe(false);
    }
    expect(knowledgeIndexEnabled({ ...linux, executionOnly: true, setting: "1" })).toBe(true);
    expect(knowledgeIndexEnabled({ ...linux, executionOnly: true, setting: "1", allowMachineOps: false })).toBe(false);
    for (const platform of ["win32", "darwin"] as const) {
      expect(knowledgeIndexEnabled({ ...linux, platform, setting: "1" })).toBe(false);
    }
  });
});

const KEY = "1".repeat(64);
const SHA = "2".repeat(40);
const INPUT = Buffer.from("privacy-filtered graph input");
const INPUT_SHA = digest(INPUT);
const URL = `https://bot.example/api/contrib/bundle/bt_${"3".repeat(48)}`;
let roots: string[] = [];
let managers: KnowledgeIndexManager[] = [];

afterEach(() => {
  for (const manager of managers) manager.close();
  for (const root of roots) {
    const artifact = path.join(root, "jobs", KEY, "artifact");
    if (fs.existsSync(artifact)) fs.chmodSync(artifact, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
  roots = []; managers = [];
});

function fixture(extra: Partial<ConstructorParameters<typeof KnowledgeIndexManager>[0]> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-jobs-")); roots.push(root);
  const checkout = path.join(root, "checkout"); fs.mkdirSync(checkout);
  let spawns = 0;
  const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
  const manager = new KnowledgeIndexManager({
    jobsRoot: path.join(root, "jobs"), checkoutRoot: checkout, wrapperEntry: "/trusted/runner.js",
    inputOrigins: ["https://bot.example"],
    enforceWorkRoots: false, minFreeBytes: 0, freeBytes: async () => Number.MAX_SAFE_INTEGER,
    fetch: vi.fn(async () => new Response(INPUT, { status: 200, headers: { "content-length": String(INPUT.length) } })) as typeof fetch,
    verifyCheckoutSha: async (_root, sha) => { expect(sha).toBe(SHA); },
    spawnWrapper: async (_entry, _spec, _cwd, attempt) => { spawns++; return { attempt, wrapperPid: 50, wrapperPgid: 50, wrapperStartTicks: "10", workerPid: null, workerPgid: null, workerStartTicks: null }; },
    processAlive: async () => true,
    signalProcessGroup: (pgid, signal) => { signals.push({ pgid, signal }); },
    reconcileIntervalMs: 60_000,
    ...extra,
  });
  managers.push(manager);
  return { manager, root, jobs: path.join(root, "jobs"), signals, spawns: () => spawns };
}

async function start(manager: KnowledgeIndexManager) {
  await manager.start();
  return await manager.rpcStart({ job_key: KEY, repo_sha: SHA, input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length } });
}

function jobKey(value: number) {
  return value.toString(16).padStart(64, "0");
}

function seedJob(jobs: string, key: string, state: KnowledgeIndexState, at: number) {
  const directory = path.join(jobs, key);
  const timestamp = new Date(at).toISOString();
  const isTerminal = ["succeeded", "failed", "cancelled", "timed_out", "orphaned"].includes(state);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "job.json"), JSON.stringify({
    version: 1,
    jobKey: key,
    repoSha: SHA,
    input: { sha256: INPUT_SHA, bytes: INPUT.length, ready: false },
    state,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(isTerminal ? { finishedAt: timestamp } : {}),
    ...(state === "cancellation_requested" ? { cancellationRequestedAt: timestamp } : {}),
    files: [],
    readOffsets: {},
    launchAttempt: state === "running" || state === "cancellation_requested" ? 1 : 0,
    ...(state === "running" || state === "cancellation_requested" ? { launchLease: { attempt: 1, leasedAt: timestamp } } : {}),
  }));
  fs.writeFileSync(path.join(directory, "build.log"), "");
  fs.writeFileSync(path.join(directory, "rc.json"), JSON.stringify({ attempt: state === "running" || state === "cancellation_requested" ? 1 : 0, rc: null }));
  fs.writeFileSync(path.join(directory, "pid.json"), JSON.stringify(
    state === "running" || state === "cancellation_requested"
      ? { attempt: 1, wrapperPid: 50, wrapperPgid: 50, wrapperStartTicks: "10", workerPid: null, workerPgid: null, workerStartTicks: null }
      : { attempt: 0, wrapperPid: null, wrapperPgid: null, wrapperStartTicks: null, workerPid: null, workerPgid: null, workerStartTicks: null },
  ));
}

function publish(jobs: string, content = Buffer.from("passed\n")) {
  const stage = path.join(jobs, KEY, "artifact"); fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "conformance-tests.json"), content);
  const unsigned = {
    schemaVersion: 1,
    kind: "octopus-knowledge-artifact",
    repoSha: SHA,
    input: { sha256: INPUT_SHA, bytes: INPUT.length },
    files: [{ path: "conformance-tests.json", bytes: content.length, sha256: digest(content) }],
  };
  const manifest = { ...unsigned, manifestDigest: digest(Buffer.from(canonical(unsigned))) };
  fs.writeFileSync(path.join(stage, "knowledge-artifact-manifest.json"), `${canonical(manifest)}\n`);
  fs.writeFileSync(path.join(jobs, KEY, "rc.json"), JSON.stringify({ attempt: 1, rc: 0, finishedAt: new Date().toISOString() }));
}
function publishMetadata(jobs: string, files: Array<{ path: string; bytes: number; sha256: string }>) {
  const stage = path.join(jobs, KEY, "artifact");
  fs.mkdirSync(stage, { recursive: true });
  const unsigned = {
    schemaVersion: 1,
    kind: "octopus-knowledge-artifact",
    repoSha: SHA,
    input: { sha256: INPUT_SHA, bytes: INPUT.length },
    files,
  };
  const manifest = { ...unsigned, manifestDigest: digest(Buffer.from(canonical(unsigned))) };
  fs.writeFileSync(path.join(stage, "knowledge-artifact-manifest.json"), `${canonical(manifest)}\n`);
  fs.writeFileSync(path.join(jobs, KEY, "rc.json"), JSON.stringify({ attempt: 1, rc: 0, finishedAt: new Date().toISOString() }));
}

describe("KnowledgeIndexManager", () => {
  it("recognises fixed conformance failures for one same-job retry and names the failed files", () => {
    const output = [
      " ❯ packages/bot/src/knowledge/contracts.test.ts (8 tests | 1 failed)",
      " ✓ packages/runner/src/omp-rpc.test.ts (12 tests)",
      "Error: 1 fixed conformance test file(s) failed",
    ].join("\n");
    expect(fixedConformanceFailure(output)).toEqual({ detected: true, names: ["contracts"] });
    expect(conformanceFailureCode(["contracts", "operation-binding"])).toBe("conformance_failed:contracts,operation-binding");
    expect(conformanceRetryResult({ attempt: 0, exitCode: 1, timedOut: false, cancelled: false, output })).toEqual({
      retry: true,
      names: ["contracts"],
      failureCode: "conformance_failed:contracts",
    });
    expect(conformanceRetryResult({ attempt: 1, exitCode: 1, timedOut: false, cancelled: false, output })).toEqual({
      retry: false,
      names: ["contracts"],
      failureCode: "conformance_failed:contracts",
    });
    expect(conformanceRetryResult({ attempt: 0, exitCode: 1, timedOut: true, cancelled: false, output }).retry).toBe(false);
    expect(fixedConformanceFailure("pnpm build failed before tests")).toEqual({ detected: false, names: [] });
  });

  it("fails closed without an explicit trusted input origin", () => {
    expect(() => new KnowledgeIndexManager({
      jobsRoot: "/work/index-jobs",
      checkoutRoot: "/work/knowledge-index-source",
      wrapperEntry: "/trusted/runner.js",
    })).toThrow(/explicit trusted input origin/);
  });
  it("requires HTTPS origins except for explicit loopback HTTP", () => {
    expect(() => fixture({ inputOrigins: ["http://bot.example"] })).toThrow(/HTTPS/);
    for (const origin of ["http://127.0.0.1:9820", "http://localhost:9820", "http://[::1]:9820"]) {
      expect(() => fixture({ inputOrigins: [origin] })).not.toThrow();
    }
    expect(() => fixture({ inputOrigins: ["https://bot.example"] })).not.toThrow();
  });
  it("persists before acknowledgement and adopts the same running key after restart", async () => {
    const f = fixture();
    await expect(start(f.manager)).resolves.toMatchObject({ state: "running", job_key: KEY, repo_sha: SHA });
    expect(f.spawns()).toBe(1);
    for (const file of ["job.json", "pid.json", "build.log", "rc.json", "manifest.json"]) {
      expect(fs.existsSync(path.join(f.jobs, KEY, file))).toBe(true);
    }
    await expect(f.manager.rpcStart({ job_key: KEY, repo_sha: SHA, input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length } }))
      .resolves.toMatchObject({ state: "running" });
    expect(f.spawns()).toBe(1);
    fs.rmSync(path.join(f.jobs, KEY, "launch-1.authorized"));
    f.manager.close();

    const adopted = new KnowledgeIndexManager({
      jobsRoot: f.jobs, checkoutRoot: path.join(f.root, "checkout"), wrapperEntry: "/trusted/runner.js",
      enforceWorkRoots: false, minFreeBytes: 0, processAlive: async () => true,
      inputOrigins: ["https://bot.example"],
      verifyCheckoutSha: async () => undefined, spawnWrapper: async () => { throw new Error("must not duplicate"); },
      reconcileIntervalMs: 60_000,
    });
    managers.push(adopted); await adopted.start();
    await expect(adopted.rpcStatus({ job_key: KEY })).resolves.toMatchObject({ state: "running" });
    expect(fs.existsSync(path.join(f.jobs, KEY, "launch-1.authorized"))).toBe(true);
  });
  it("persists the launch lease before spawn and never duplicates an indeterminate detached launch", async () => {
    let now = Date.parse("2026-08-23T12:00:00.000Z");
    let launches = 0;
    let jobs = "";
    const f = fixture({
      now: () => now,
      processAlive: async () => false,
      spawnWrapper: async (_entry, _spec, _cwd, attempt) => {
        launches += 1;
        const job = JSON.parse(fs.readFileSync(path.join(jobs, KEY, "job.json"), "utf8")) as Record<string, unknown>;
        const pid = JSON.parse(fs.readFileSync(path.join(jobs, KEY, "pid.json"), "utf8")) as Record<string, unknown>;
        expect(job).toMatchObject({ state: "running", launchAttempt: attempt, launchLease: { attempt } });
        expect(pid).toMatchObject({ attempt, wrapperPid: null });
        expect(fs.existsSync(path.join(jobs, KEY, `launch-${attempt}.authorized`))).toBe(false);
        throw new Error("crash after detached spawn");
      },
    });
    jobs = f.jobs;
    await expect(start(f.manager)).resolves.toMatchObject({ state: "running", error: { code: "launch_pending" } });
    expect(launches).toBe(1);
    f.manager.close();

    const adopted = new KnowledgeIndexManager({
      jobsRoot: f.jobs,
      checkoutRoot: path.join(f.root, "checkout"),
      wrapperEntry: "/trusted/runner.js",
      inputOrigins: ["https://bot.example"],
      enforceWorkRoots: false,
      minFreeBytes: 0,
      now: () => now,
      processAlive: async () => false,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      verifyCheckoutSha: async () => undefined,
      spawnWrapper: async (_entry, _spec, _cwd, attempt) => {
        launches += 1;
        return { attempt, wrapperPid: 60, wrapperPgid: 60, wrapperStartTicks: "11", workerPid: null, workerPgid: null, workerStartTicks: null };
      },
      reconcileIntervalMs: 60_000,
    });
    managers.push(adopted);
    await adopted.start();
    await expect(adopted.rpcStatus({ job_key: KEY })).resolves.toMatchObject({ state: "running" });
    expect(launches).toBe(1);
    now += KNOWLEDGE_INDEX_LAUNCH_LEASE_MS + 1;
    await expect(adopted.rpcStatus({ job_key: KEY })).resolves.toMatchObject({ state: "orphaned", error: { code: "process_lost" } });
    await expect(adopted.rpcStart({
      job_key: KEY,
      repo_sha: SHA,
      input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length },
    })).resolves.toMatchObject({ state: "running" });
    expect(launches).toBe(2);
    expect(fs.existsSync(path.join(f.jobs, KEY, "launch-2.authorized"))).toBe(true);
  });

  it("publishes immutable 1 MiB-bounded chunks and rejects corruption", async () => {
    const f = fixture(); await start(f.manager); publish(f.jobs, Buffer.alloc(32, 7));
    const status = await f.manager.rpcStatus({ job_key: KEY });
    expect(status).toMatchObject({ state: "upload_pending", files: expect.arrayContaining([expect.objectContaining({ file: "conformance-tests.json", bytes: 32 })]) });
    await expect(f.manager.rpcRead({ job_key: KEY, file: "conformance-tests.json", offset: 0, length: 16 }))
      .resolves.toMatchObject({ bytes: 16, eof: false, sha256: digest(Buffer.alloc(32, 7)) });
    await expect(f.manager.rpcRead({ job_key: KEY, file: "conformance-tests.json", offset: 16, length: 16 }))
      .resolves.toMatchObject({ bytes: 16, eof: true });
    await expect(f.manager.rpcRead({ job_key: KEY, file: "conformance-tests.json", offset: 0, length: KNOWLEDGE_INDEX_CHUNK_MAX_BYTES + 1 }))
      .rejects.toThrow(/chunk range/);
    const file = path.join(f.jobs, KEY, "artifact", "conformance-tests.json");
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, Buffer.alloc(32, 8)); fs.chmodSync(file, 0o400);
    await expect(f.manager.rpcRead({ job_key: KEY, file: "conformance-tests.json", offset: 0, length: 1 }))
      .rejects.toThrow(/changed after publication/);
  });

  it("requests TERM for the recorded process group and never couples cancellation to connection lifetime", async () => {
    const f = fixture(); await start(f.manager);
    await expect(f.manager.rpcCancel({ job_key: KEY })).resolves.toMatchObject({ state: "cancellation_requested" });
    expect(f.signals).toContainEqual({ pgid: 50, signal: "SIGTERM" });
    await expect(f.manager.rpcStatus({ job_key: KEY })).resolves.toMatchObject({ state: "cancellation_requested" });
  });

  it("rejects every command, path, device, traversal and oversized-read injection", async () => {
    const f = fixture(); await f.manager.start();
    await expect(f.manager.rpcStart({ job_key: KEY, repo_sha: SHA, command: "sh", input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length } }))
      .rejects.toThrow(/unknown RPC argument/);
    await expect(f.manager.rpcStart({ job_key: KEY, repo_sha: SHA, device: "other", input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length } }))
      .rejects.toThrow(/unknown RPC argument/);
    await expect(f.manager.rpcRead({ job_key: KEY, file: "../secret", offset: 0, length: 1 })).rejects.toThrow(/artifact path/);
  });

  it("persists a transient handoff failure and retries the same deterministic key", async () => {
    const fetchInput = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError("temporary link loss"), { cause: { code: "ECONNRESET" } }))
      .mockResolvedValueOnce(new Response(INPUT, { status: 200, headers: { "content-length": String(INPUT.length) } }));
    const f = fixture({ fetch: fetchInput as typeof fetch });
    await expect(start(f.manager)).resolves.toMatchObject({ state: "queued", error: { code: "input_pending" } });
    expect(f.spawns()).toBe(0);
    await expect(f.manager.rpcStart({
      job_key: KEY,
      repo_sha: SHA,
      input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length },
    })).resolves.toMatchObject({ state: "running" });
    expect(fetchInput).toHaveBeenCalledTimes(2);
    expect(f.spawns()).toBe(1);
  });

  it("fails closed on input digest and free-space admission without spawning", async () => {
    const bad = fixture({ fetch: vi.fn(async () => new Response(Buffer.from("wrong"), { status: 200 })) as typeof fetch });
    await expect(start(bad.manager)).resolves.toMatchObject({ state: "failed", error: { code: "input_rejected" } });
    expect(bad.spawns()).toBe(0);
    const full = fixture({ minFreeBytes: 50 * 1024 ** 3, freeBytes: async () => 49 * 1024 ** 3 });
    await expect(start(full.manager)).resolves.toMatchObject({ state: "failed", error: { code: "insufficient_space" } });
    expect(full.spawns()).toBe(0);
    const tlsError = Object.assign(new TypeError("certificate verify failed"), { cause: { code: "CERT_SIGNATURE_FAILURE" } });
    const secureFetch = vi.fn().mockRejectedValue(tlsError);
    const insecure = fixture({ fetch: secureFetch as typeof fetch });
    await expect(start(insecure.manager)).resolves.toMatchObject({ state: "failed", error: { code: "input_rejected" } });
    await expect(insecure.manager.rpcStart({
      job_key: KEY,
      repo_sha: SHA,
      input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length },
    })).resolves.toMatchObject({ state: "failed", error: { code: "input_rejected" } });
    expect(secureFetch).toHaveBeenCalledTimes(1);
  });
  it("rejects per-member, aggregate, and combined-manifest bytes before publication", async () => {
    const oversizedMember = fixture();
    await start(oversizedMember.manager);
    publishMetadata(oversizedMember.jobs, [{
      path: "conformance-tests.json",
      bytes: KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES + 1,
      sha256: digest(Buffer.alloc(0)),
    }]);
    await expect(oversizedMember.manager.rpcStatus({ job_key: KEY })).resolves.toMatchObject({
      state: "failed",
      error: { code: "manifest_rejected", message: expect.stringMatching(/oversized|ceiling/) },
    });

    const aggregate = fixture();
    await start(aggregate.manager);
    const members = Array.from(
      { length: Math.floor(KNOWLEDGE_ARTIFACT_AGGREGATE_MAX_BYTES / KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES) + 1 },
      (_, index) => ({ path: `code/member-${index}.bin`, bytes: KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES, sha256: digest(Buffer.from(String(index))) }),
    );
    publishMetadata(aggregate.jobs, members);
    await expect(aggregate.manager.rpcStatus({ job_key: KEY })).resolves.toMatchObject({
      state: "failed",
      error: { code: "manifest_rejected", message: expect.stringMatching(/aggregate/) },
    });

    const manifest = fixture();
    await start(manifest.manager);
    const stage = path.join(manifest.jobs, KEY, "artifact");
    fs.mkdirSync(stage, { recursive: true });
    const combined = path.join(stage, "knowledge-artifact-manifest.json");
    fs.writeFileSync(combined, "{}");
    fs.truncateSync(combined, KNOWLEDGE_ARTIFACT_MANIFEST_MAX_BYTES + 1);
    fs.writeFileSync(path.join(manifest.jobs, KEY, "rc.json"), JSON.stringify({ attempt: 1, rc: 0 }));
    await expect(manifest.manager.rpcStatus({ job_key: KEY })).resolves.toMatchObject({
      state: "failed",
      error: { code: "manifest_rejected", message: expect.stringMatching(/manifest.*ceiling/) },
    });
  });
  it("expires old terminal payloads without pruning active, resumable, recent, or untrusted paths", async () => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    const f = fixture({ now: () => now });
    const expired = jobKey(10);
    const recent = jobKey(11);
    const queued = jobKey(12);
    const running = jobKey(13);
    const cancelling = jobKey(14);
    const uploadPending = jobKey(15);
    const linked = jobKey(16);
    seedJob(f.jobs, expired, "succeeded", now - KNOWLEDGE_INDEX_TERMINAL_TTL_MS - 1);
    const expiredRecordFile = path.join(f.jobs, expired, "job.json");
    const expiredRecord = JSON.parse(fs.readFileSync(expiredRecordFile, "utf8")) as Record<string, unknown>;
    expiredRecord.files = [{ file: "code/payload.bin", bytes: 4, sha256: digest(Buffer.from("drop")) }];
    fs.writeFileSync(expiredRecordFile, JSON.stringify(expiredRecord));
    const expiredStage = path.join(f.jobs, expired, "artifact");
    const expiredCode = path.join(expiredStage, "code");
    fs.mkdirSync(expiredCode, { recursive: true });
    fs.writeFileSync(path.join(expiredCode, "payload.bin"), "drop", { mode: 0o400 });
    fs.chmodSync(expiredCode, 0o500);
    fs.chmodSync(expiredStage, 0o500);
    seedJob(f.jobs, recent, "succeeded", now - KNOWLEDGE_INDEX_TERMINAL_TTL_MS + 1);
    seedJob(f.jobs, queued, "queued", now - KNOWLEDGE_INDEX_TERMINAL_TTL_MS - 1);
    seedJob(f.jobs, running, "running", now);
    seedJob(f.jobs, cancelling, "cancellation_requested", now);
    seedJob(f.jobs, uploadPending, "upload_pending", now - KNOWLEDGE_INDEX_TERMINAL_TTL_MS - 1);
    const invalid = path.join(f.jobs, "not-a-job");
    fs.mkdirSync(invalid, { recursive: true });
    fs.writeFileSync(path.join(invalid, "payload"), "keep");
    const outsideRoot = path.join(f.root, "outside");
    seedJob(outsideRoot, linked, "failed", now - KNOWLEDGE_INDEX_TERMINAL_TTL_MS - 1);
    const outside = path.join(outsideRoot, linked);
    fs.writeFileSync(path.join(outside, "payload"), "keep");
    fs.symlinkSync(outside, path.join(f.jobs, linked), "dir");

    await f.manager.start();

    expect(fs.existsSync(path.join(f.jobs, expired))).toBe(false);
    for (const key of [recent, queued, running, cancelling, uploadPending]) {
      expect(fs.existsSync(path.join(f.jobs, key))).toBe(true);
    }
    expect(fs.readFileSync(path.join(invalid, "payload"), "utf8")).toBe("keep");
    expect(fs.readFileSync(path.join(outside, "payload"), "utf8")).toBe("keep");
    await expect(f.manager.rpcStatus({ job_key: expired })).rejects.toThrow(/job not found/);
    await expect(f.manager.rpcStatus({ job_key: recent })).resolves.toMatchObject({ state: "succeeded" });
    await expect(f.manager.rpcStart({
      job_key: expired,
      repo_sha: SHA,
      input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length },
    })).resolves.toMatchObject({ job_key: expired, state: "queued" });
  });
  it("classifies consumed one-use 404/410 handoffs as retryable input_pending", async () => {
    const fetchInput = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
      .mockResolvedValueOnce(new Response(INPUT, { status: 200, headers: { "content-length": String(INPUT.length) } }));
    const f = fixture({ fetch: fetchInput as typeof fetch });
    await expect(start(f.manager)).resolves.toMatchObject({ state: "queued", error: { code: "input_pending" } });
    for (const expected of ["queued", "running"] as const) {
      await expect(f.manager.rpcStart({
        job_key: KEY,
        repo_sha: SHA,
        input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length },
      })).resolves.toMatchObject({ state: expected });
    }
    expect(fetchInput).toHaveBeenCalledTimes(3);
    expect(f.spawns()).toBe(1);
  });

  it("bounds timeout retries while permanent builder failure remains poisoned", async () => {
    const f = fixture();
    await start(f.manager);
    for (let attempt = 1; attempt < KNOWLEDGE_INDEX_MAX_LAUNCH_ATTEMPTS; attempt += 1) {
      fs.writeFileSync(path.join(f.jobs, KEY, "rc.json"), JSON.stringify({ attempt, rc: null, timedOut: true }));
      await expect(f.manager.rpcStatus({ job_key: KEY })).resolves.toMatchObject({ state: "timed_out" });
      await expect(f.manager.rpcStart({
        job_key: KEY,
        repo_sha: SHA,
        input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length },
      })).resolves.toMatchObject({ state: "running" });
    }
    fs.writeFileSync(path.join(f.jobs, KEY, "rc.json"), JSON.stringify({ attempt: KNOWLEDGE_INDEX_MAX_LAUNCH_ATTEMPTS, rc: null, timedOut: true }));
    await expect(f.manager.rpcStatus({ job_key: KEY })).resolves.toMatchObject({ state: "timed_out" });
    await expect(f.manager.rpcStart({
      job_key: KEY,
      repo_sha: SHA,
      input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length },
    })).resolves.toMatchObject({ state: "timed_out" });
    expect(f.spawns()).toBe(KNOWLEDGE_INDEX_MAX_LAUNCH_ATTEMPTS);

    const permanent = fixture();
    await start(permanent.manager);
    fs.writeFileSync(path.join(permanent.jobs, KEY, "rc.json"), JSON.stringify({ attempt: 1, rc: 2 }));
    await expect(permanent.manager.rpcStatus({ job_key: KEY })).resolves.toMatchObject({ state: "failed", error: { code: "builder_failed" } });
    await expect(permanent.manager.rpcStart({
      job_key: KEY,
      repo_sha: SHA,
      input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length },
    })).resolves.toMatchObject({ state: "failed", error: { code: "builder_failed" } });
    expect(permanent.spawns()).toBe(1);

    const named = fixture();
    await start(named.manager);
    fs.writeFileSync(path.join(named.jobs, KEY, "rc.json"), JSON.stringify({
      attempt: 1,
      rc: 2,
      failureCode: "conformance_failed:contracts,omp-rpc",
    }));
    await expect(named.manager.rpcStatus({ job_key: KEY })).resolves.toMatchObject({
      state: "failed",
      error: { code: "conformance_failed:contracts,omp-rpc" },
    });
  });

  it("caps recent terminal payloads and retains the newest idempotency keys", async () => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    const f = fixture({ now: () => now });
    const keys = Array.from({ length: KNOWLEDGE_INDEX_TERMINAL_MAX_COUNT + 1 }, (_, index) => jobKey(100 + index));
    for (const [index, key] of keys.entries()) seedJob(f.jobs, key, "succeeded", now - index - 1);

    await f.manager.start();

    const expired = keys.at(-1)!;
    expect(fs.existsSync(path.join(f.jobs, expired))).toBe(false);
    expect(fs.existsSync(path.join(f.jobs, keys[0]!))).toBe(true);
    expect(fs.existsSync(path.join(f.jobs, keys[KNOWLEDGE_INDEX_TERMINAL_MAX_COUNT - 1]!))).toBe(true);
    await expect(f.manager.rpcStatus({ job_key: keys[0] })).resolves.toMatchObject({ state: "succeeded" });
    await expect(f.manager.rpcStatus({ job_key: expired })).rejects.toThrow(/job not found/);
    await expect(f.manager.rpcStart({
      job_key: expired,
      repo_sha: SHA,
      input: { url: URL, sha256: INPUT_SHA, bytes: INPUT.length },
    })).resolves.toMatchObject({ job_key: expired, state: "running" });
  });

});

function digest(value: Buffer) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}
