import { createHash } from "node:crypto";
import { MeetingTranscriptionManager, MEETING_TRANSCRIPTION_METHODS, type MeetingTranscriptionStatus } from "@claude-bot/runner/meeting-transcription";
import { handleRpc } from "@claude-bot/runner/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "../runner/gateway.js";
import { RunnerCapabilities, RUNNER_OPERATIONS } from "../runner/capability.js";
import { startFakeRunner, type FakeRunner } from "../runner/fake-runner.helper.js";
import { MeetingTranscriptionCapabilities, MEETING_TRANSCRIPTION_OPERATIONS } from "./capability.js";
import { MEETING_TRANSCRIPTION_MCP_TOOLS } from "./contract.js";
let dir: string, store: Store, gateway: RunnerGateway, legacy: RunnerCapabilities, caps: MeetingTranscriptionCapabilities, laptop: FakeRunner;
const base = { device: "compute", job_key: "a".repeat(64), input_sha256: "b".repeat(64) };
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "meeting-cap-")); store = new Store(join(dir, "store.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: new Date().toISOString() });
  store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "compute", new Date().toISOString());
  gateway = new RunnerGateway(store, { port: 0 }); await gateway.start(); const transport = gateway.claimTransport(); legacy = new RunnerCapabilities(store, transport);
  caps = new MeetingTranscriptionCapabilities({ service: legacy.service, transport, userExists: name => Boolean(store.getUser(name)), hasDevice: name => store.listRunnerTokens(name).length > 0 });
  caps.attachToRunnerLifecycle(legacy);
  laptop = await startFakeRunner(gateway.port, "rt_alice", "compute", { meeting_transcription_status: args => args, meeting_transcription_start: args => args }, {
    schema: "runner-inventory/v1", agent_backends: (["claude", "codex", "omp"] as const).map(kind => ({ kind, available: false, split_execution: false })), execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 1, codex_exec_server: false },
    meeting_transcription_jobs: { protocol: "meeting-transcription-jobs/v1", available: true, backend: "MOSS-Transcribe-Diarize", concurrency: 1, max_input_bytes: 67108864, max_chunk_bytes: 262144 },
  });
});
afterEach(async () => { laptop?.close(); await gateway?.stop(); rmSync(dir, { recursive: true, force: true }); });
describe("dedicated transcription authority", () => {
  it("routes only through the owner/device grant and rejects unknown executable selectors", async () => {
    const grant = caps.open({ username: "alice", device: "compute", purpose: "fixture", rights: Object.keys(MEETING_TRANSCRIPTION_OPERATIONS), autoAllow: Object.keys(MEETING_TRANSCRIPTION_OPERATIONS) })!;
    expect(await grant.call("meeting_transcription_status", base)).toMatchObject({ job_key: base.job_key });
    await expect(grant.call("meeting_transcription_start", { ...base, device: "other" })).rejects.toThrow();
    await expect(grant.call("meeting_transcription_start", { ...base, command: "touch payload" })).rejects.toThrow();
    expect(caps.open({ username: "bob", device: "compute", purpose: "fixture", rights: ["meeting_transcription_status"] })).toBeNull();
    expect(laptop.frames).toHaveLength(1);
    expect(caps.readiness("alice", "compute")).toMatchObject({ available: true });
    expect(caps.readiness("bob", "compute")).toMatchObject({ available: false, status: "unregistered" });
    grant.destroy(); await expect(grant.call("meeting_transcription_status", base)).rejects.toThrow();
  });
  it("has its own operation identity and preserves the legacy account closed set", () => {
    expect(Object.keys(MEETING_TRANSCRIPTION_OPERATIONS)).toHaveLength(6);
    expect(Object.keys(RUNNER_OPERATIONS).some(name => name.startsWith("meeting_transcription_"))).toBe(false);
    expect(MEETING_TRANSCRIPTION_OPERATIONS.meeting_transcription_start).toMatchObject({ effect: "execute", retrySafe: true });
    for (const tool of MEETING_TRANSCRIPTION_MCP_TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(false); expect(tool.inputSchema.properties).not.toHaveProperty("device"); expect(tool.inputSchema.properties).not.toHaveProperty("owner");
    }
    expect(MEETING_TRANSCRIPTION_MCP_TOOLS.find(tool => tool.name === "meeting_transcription_upload")!.inputSchema.properties.data.maxLength).toBe(349528);
  });
  it("revokes the device's transcription grants on the shared target lifecycle", async () => {
    const grant = caps.open({ username: "alice", device: "compute", purpose: "fixture", rights: ["meeting_transcription_status"] })!;
    await grant.call("meeting_transcription_status", base);
    legacy.mintDeviceToken("alice", "compute");
    await expect(grant.call("meeting_transcription_status", base)).rejects.toThrow();
  });
});

it("carries the dedicated upload, durable worker and immutable result through a real owner-scoped WebSocket", async () => {
  const script = join(dir, "fixed-transcriber.py");
  writeFileSync(script, `#!/usr/bin/python3
import pathlib,sys,json,hashlib
out=pathlib.Path(sys.argv[sys.argv.index('--out')+1]);out.mkdir()
(out/'manifest.json').write_text(json.dumps({'settings':{'duration_seconds':1,'max_new_tokens':32768,'audio_sha256':hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest(),'model':'MOSS','model_revision':'test'}}))
(out/'model-raw.txt').write_text('[0][S01]Fixture utterance.[1]')
(out/'inference.json').write_text(json.dumps({'generated_tokens':10}))
`, { mode: 0o700 });
  const manager = new MeetingTranscriptionManager({ version: 1, jobsRoot: join(dir, "jobs"), script, scriptSha256: "a".repeat(64),
    pipeline: script, pipelineSha256: "a".repeat(64), python: "/usr/bin/python3", modelDir: "/unused" }, { probe: async () => {} });
  await manager.start(); laptop.close();
  laptop = await startFakeRunner(gateway.port, "rt_alice", "compute", Object.fromEntries(MEETING_TRANSCRIPTION_METHODS.map(method => [method, async args => {
    const answer = await handleRpc(dir, { id: "fixture", method, args }, { allowMachineOps: true, executionOnly: true, meetingTranscription: manager });
    if (!answer.ok) throw new Error(answer.error); return answer.result;
  }])));
  const grant = caps.open({ username: "alice", device: "compute", purpose: "integration fixture", rights: MEETING_TRANSCRIPTION_METHODS, autoAllow: MEETING_TRANSCRIPTION_METHODS })!;
  const bytes = Buffer.from("test audio fixture"), digest = createHash("sha256").update(bytes).digest("hex"), input = { ...base, input_sha256: digest };
  try {
    await grant.call("meeting_transcription_begin", { ...input, input_bytes: bytes.length, title: "fixture" });
    await grant.call("meeting_transcription_upload", { ...input, offset: 0, data: bytes.toString("base64"), chunk_sha256: digest });
    await grant.call("meeting_transcription_start", input);
    let status: MeetingTranscriptionStatus;
    await vi.waitFor(async () => { status = await grant.call("meeting_transcription_status", input) as MeetingTranscriptionStatus; expect(status.state).toBe("succeeded"); }, { timeout: 5000, interval: 25 });
    const result = await grant.call("meeting_transcription_read", { ...input, file: "dialogue.md", offset: 0, length: 262144 }) as { data: string; sha256: string; eof: boolean };
    expect(Buffer.from(result.data, "base64").toString("utf8")).toContain("Fixture utterance."); expect(result.eof).toBe(true);
    expect(createHash("sha256").update(Buffer.from(result.data, "base64")).digest("hex")).toBe(result.sha256);
    expect((await grant.call("meeting_transcription_start", input) as MeetingTranscriptionStatus).state).toBe("succeeded");
    expect(laptop.frames.every(frame => frame.method.startsWith("meeting_transcription_") && !("command" in frame.args))).toBe(true);
  } finally { grant.destroy(); manager.close(); }
});
