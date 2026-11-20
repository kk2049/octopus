import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { MeetingTranscriptionManager, readMeetingTranscriptionConfig, readMeetingTranscriptionAdvertisement, transcriptionAdvertisement, type MeetingTranscriptionConfig,
  type MeetingTranscriptionStatus, type MeetingTranscriptionChunk, MEETING_TRANSCRIPTION_LIMITS } from "./meeting-transcription.js";
import { handleRpc } from "./core.js";
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [], managers: MeetingTranscriptionManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) manager.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-jobs-")); roots.push(root);
  const config: MeetingTranscriptionConfig = { version: 1, jobsRoot: path.join(root, "jobs"), script: "/fixed/run.sh", scriptSha256: "a".repeat(64),
    pipeline: "/fixed/dialogue.py", pipelineSha256: "b".repeat(64), python: "/usr/bin/python3", modelDir: "/fixed/model" };
  let now = Date.now(); const spawn = vi.fn(async () => {}), probe = vi.fn(async () => {});
  const make = async () => { const manager = new MeetingTranscriptionManager(config, { spawn, probe, now: () => now }); managers.push(manager); await manager.start(); return manager; };
  const manager = await make();
  const bytes = Buffer.from("recording content"), key = "c".repeat(64), digest = sha(bytes), common = { job_key: key, input_sha256: digest };
  async function upload(m = manager, target = common) {
    await m.call("begin", { ...target, input_bytes: bytes.length, title: "fixture" });
    await m.call("upload", { ...target, offset: 0, data: bytes.toString("base64"), chunk_sha256: digest });
  }
  return { root, config, manager, make, spawn, probe, bytes, key, digest, common, upload, advance: (ms: number) => { now += ms; } };
}
describe("fixed meeting transcription jobs", () => {
  it("uses sequential hashed chunks, detects conflicts and reopens the exact persistent upload", async () => {
    const f = await fixture();
    await f.manager.call("begin", { ...f.common, input_bytes: f.bytes.length, title: "fixture" });
    for (const [offset, bytes] of [[0, f.bytes.subarray(0, 4)], [4, f.bytes.subarray(4)]] as const) {
      const request = { ...f.common, offset, data: bytes.toString("base64"), chunk_sha256: sha(bytes) };
      await f.manager.call("upload", request); await f.manager.call("upload", request);
    }
    expect(await readFile(path.join(f.config.jobsRoot, f.key, "input.audio"))).toEqual(f.bytes);
    await expect(f.manager.call("upload", { ...f.common, offset: 0, data: "WA==", chunk_sha256: sha("X") })).rejects.toThrow("conflicts");
    await expect(f.manager.call("begin", { ...f.common, input_bytes: f.bytes.length, title: "changed" })).rejects.toThrow("immutable");
    f.manager.close(); const resumed = await f.make();
    expect(await resumed.call("status", f.common)).toMatchObject({ received: f.bytes.length, state: "uploading" });
    await expect(resumed.call("status", { ...f.common, input_sha256: "d".repeat(64) })).rejects.toThrow("another recording");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("refuses untrusted selectors, invalid chunks and launch before full verification", async () => {
    const f = await fixture();
    await expect(f.manager.call("begin", { ...f.common, input_bytes: 1, title: "x", script: "/tmp/payload" })).rejects.toThrow("unknown");
    await f.manager.call("begin", { ...f.common, input_bytes: f.bytes.length, title: "fixture" });
    await expect(f.manager.call("start", f.common)).rejects.toThrow("incomplete");
    await expect(f.manager.call("upload", { ...f.common, offset: 1, data: "YQ==", chunk_sha256: sha("a") })).rejects.toThrow("gap");
    await expect(f.manager.call("upload", { ...f.common, offset: 0, data: "YQ==", chunk_sha256: sha("b") })).rejects.toThrow("digest");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("persists one launch, recovers without replay, and limits concurrent jobs", async () => {
    const f = await fixture(); await f.upload(); await f.manager.call("start", f.common);
    const second = { ...f.common, job_key: "d".repeat(64) }; await f.upload(f.manager, second);
    expect(await f.manager.call("start", second)).toMatchObject({ state: "queued" });
    await f.manager.call("start", f.common); expect(f.spawn).toHaveBeenCalledTimes(1);
    f.manager.close(); const resumed = await f.make();
    expect(await resumed.call("start", f.common)).toMatchObject({ state: "launching" }); expect(f.spawn).toHaveBeenCalledTimes(1);
    f.advance(61000);
    expect(await resumed.call("status", f.common)).toMatchObject({ state: "orphaned" });
    await resumed.call("start", f.common); expect(f.spawn).toHaveBeenCalledTimes(2); // only the separately queued job
    expect((await resumed.call("status", second) as MeetingTranscriptionStatus).state).toBe("launching");
  });
  it("publishes immutable bounded artifacts, keeps source evidence, and checks the artifact identity", async () => {
    const f = await fixture(); await f.upload(); await f.manager.call("start", f.common);
    const job = path.join(f.config.jobsRoot, f.key); await mkdir(path.join(job, "result")); await mkdir(path.join(job, "asr"));
    await writeFile(path.join(job, "result/dialogue.md"), "verified fixture"); await writeFile(path.join(job, "asr/model-raw.txt"), "original source");
    await writeFile(path.join(job, "exit.json"), JSON.stringify({ exit_code: 0 }));
    const status = await f.manager.call("status", f.common) as MeetingTranscriptionStatus;
    expect(status.state).toBe("needs_review"); expect(status.files.map(file => file.file)).toEqual(["dialogue.md", "asr/model-raw.txt"]);
    const part = await f.manager.call("read", { ...f.common, file: "dialogue.md", offset: 0, length: 8 }) as MeetingTranscriptionChunk;
    expect(part).toMatchObject({ bytes: 8, total: 16, eof: false, sha256: sha("verified fixture") });
    await expect(f.manager.call("read", { ...f.common, file: "../job.json", offset: 0, length: 8 })).rejects.toThrow("manifest");
    await chmod(path.join(job, "result/dialogue.md"), 0o600); await writeFile(path.join(job, "result/dialogue.md"), "changed artifact");
    await expect(f.manager.call("read", { ...f.common, file: "dialogue.md", offset: 0, length: 8 })).rejects.toThrow("changed");
  });
  it("does not start cancelled or expired jobs after restart", async () => {
    const f = await fixture(); await f.upload(); await f.manager.call("cancel", f.common);
    expect(await f.manager.call("start", f.common)).toMatchObject({ state: "cancelled" }); expect(f.spawn).not.toHaveBeenCalled();
    const second = { ...f.common, job_key: "d".repeat(64) }; await f.upload(f.manager, second); await f.manager.call("start", second);
    f.advance(MEETING_TRANSCRIPTION_LIMITS.deadlineMs + 1);
    expect(await f.manager.call("status", second)).toMatchObject({ state: "timed_out" });
    f.manager.close(); const resumed = await f.make(); await resumed.call("start", second); expect(f.spawn).toHaveBeenCalledTimes(1);
  });
  it("takes a recording past the old 64 MiB ceiling in windows and verifies it by streaming", async () => {
    const f = await fixture();
    const size = 64 * 1024 * 1024 + 300_000, window = MEETING_TRANSCRIPTION_LIMITS.chunkBytes, whole = createHash("sha256");
    const piece = (offset: number) => Buffer.alloc(Math.min(window, size - offset), offset / window & 0xff);
    for (let offset = 0; offset < size; offset += window) whole.update(piece(offset));
    const job = { job_key: "e".repeat(64), input_sha256: whole.digest("hex") };
    await f.manager.call("begin", { ...job, input_bytes: size, title: "long meeting" });
    for (let offset = 0; offset < size; offset += window) {
      const bytes = piece(offset);
      await f.manager.call("upload", { ...job, offset, data: bytes.toString("base64"), chunk_sha256: sha(bytes) });
    }
    expect(await f.manager.call("start", job)).toMatchObject({ state: "launching", received: size, input_bytes: size });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    // The advertisement still says 64 MiB where Heads before 2026-10-20 require it,
    // and a current Head reads the real ceiling; an older Runner's stays 64 MiB.
    const advertised = transcriptionAdvertisement(true);
    expect(advertised).toMatchObject({ max_input_bytes: 64 * 1024 * 1024, max_recording_bytes: Number.MAX_SAFE_INTEGER });
    expect(readMeetingTranscriptionAdvertisement(advertised)?.max_input_bytes).toBe(Number.MAX_SAFE_INTEGER);
    const { max_recording_bytes: _dropped, ...legacy } = advertised;
    expect(readMeetingTranscriptionAdvertisement(legacy)?.max_input_bytes).toBe(64 * 1024 * 1024);
  });
  it("keeps the device/site kill switch in force, even for direct RPCs", async () => {
    const call = vi.fn(async () => ({ state: "running" }));
    const request = { id: "a", method: "meeting_transcription_start", args: {} };
    expect(await handleRpc("/unused", request, { meetingTranscription: { call }, allowMachineOps: false })).toMatchObject({ ok: false });
    expect(await handleRpc("/unused", request, { allowMachineOps: true, executionOnly: true })).toMatchObject({ ok: false });
    expect(call).not.toHaveBeenCalled();
    expect(await handleRpc("/unused", request, { meetingTranscription: { call }, allowMachineOps: true, executionOnly: true })).toMatchObject({ ok: true });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("accepts configuration only from the private device file", async () => {
    const f = await fixture(); expect(await readMeetingTranscriptionConfig(f.root)).toBeNull();
    const dir = path.join(f.root, ".octopus/runner"); await mkdir(dir, { recursive: true }); const file = path.join(dir, "meeting-transcription.json");
    await writeFile(file, JSON.stringify(f.config), { mode: 0o600 }); expect(await readMeetingTranscriptionConfig(f.root)).toEqual(f.config);
    await chmod(file, 0o644); await expect(readMeetingTranscriptionConfig(f.root)).rejects.toThrow("private");
  });
});
