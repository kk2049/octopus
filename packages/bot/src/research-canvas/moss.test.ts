import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResourceBinding } from "@claude-bot/research-canvas-contract";
import type { MeetingTranscriptionCapabilities } from "../meeting-transcription/capability.js";
import { MEETING_TRANSCRIPTION_PROTOCOL } from "@claude-bot/runner/meeting-transcription-protocol";
import { ResearchMossRunner, SourceIntegrityError, validateMossPacket, type MossPacket } from "./moss.js";
function packet(): MossPacket { return {
  manifest: { settings: { duration_seconds: 90, max_new_tokens: 32768, model: "MOSS", model_revision: "fixed" } },
  complete: { status: "machine_transcription_complete" }, quality: {}, inference: { generated_tokens: 300 },
  raw: "[0][S01]先检查结果。[40]\n[41][S02]再决定发布。[89.9]", dialogue: "完整的带讲话人稿",
  segments: [{ id: "D000001", start: 0, end: 40, speaker: "A", text: "先检查结果。" }, { id: "D000002", start: 41, end: 89.9, speaker: "B", text: "再决定发布。" }],
}; }
describe("MOSS delivery integrity", () => {
  it("accepts a closed, fully parsed recording and preserves anonymous speakers", () => {
    const result = validateMossPacket(packet());
    expect(result.integrity).toMatchObject({ complete: true, rawClosed: true, segments: 2, tokenLimited: false });
    expect(result.segments?.map(row => row.speaker)).toEqual(["A", "B"]);
  });
  it("refuses a partial trailing timestamp even if complete.json exists", () => {
    const value = packet(); value.raw = value.raw.replace("[89.9]", "[89");
    expect(() => validateMossPacket(value)).toThrow(SourceIntegrityError);
  });
  it("refuses an unparsed utterance, a 30+ second tail and token exhaustion", () => {
    const missing = packet(); missing.raw += "\n[89.91][S01]遗漏[89.99]";
    const tail = packet(); tail.manifest.settings.duration_seconds = 150;
    const limit = packet(); limit.inference.generated_tokens = 32768;
    for (const value of [missing, tail, limit]) expect(() => validateMossPacket(value)).toThrow(SourceIntegrityError);
  });
  it("requires recovery source and speaker mapping evidence", () => {
    const value = packet(); value.recovery = { cutover: 40 };
    expect(() => validateMossPacket(value)).toThrow("补段来源");
    value.recovery = { sources: [{ run: "full" }, { run: "tail" }], speaker_mapping: [{ mapping: { S01: "S01", S02: "S02" } }] };
    expect(validateMossPacket(value).integrity?.recovered).toBe(true);
  });
  it("rejects unordered, out-of-range or unidentified speaker segments", () => {
    const value = packet(); value.segments[1].start = -1;
    expect(() => validateMossPacket(value)).toThrow("时间范围");
  });
});


describe("dedicated MOSS Runner boundary", () => {
  const stamp = { kind: "human" as const, owner: "alice", trigger: "upload", agent: null, run: null, model: null, at: "2026-09-26T00:00:00Z" };
  const binding: ResourceBinding = { id: "audio", node: "audio", owner: "alice", version: 1, resource: "file", kind: "audio", config: {}, archived: false, created: stamp, updated: stamp };
  const ready = () => ({ available: true, status: "available", backend: "MOSS-Transcribe-Diarize" as const });
  it("uses only typed transcription calls and verifies every artifact digest", async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-transfer-")), input = join(root, "upload.wav"), bytes = Buffer.alloc(300 * 1024, 0x9d);
    writeFileSync(input, bytes); const sha256 = createHash("sha256").update(bytes).digest("hex"), value = packet(); value.manifest.settings.audio_sha256 = sha256;
    const files: Record<string, string> = { "manifest.json": JSON.stringify(value.manifest), "complete.json": JSON.stringify(value.complete),
      "quality.json": "{}", "inference.json": JSON.stringify(value.inference), "model-raw.txt": value.raw, "segments.json": JSON.stringify(value.segments), "dialogue.md": value.dialogue };
    let received = 0; const destroy = vi.fn();
    const call = vi.fn(async (operation: string, args: Record<string, unknown>) => {
      expect(operation).toMatch(/^meeting_transcription_/); expect(args).not.toHaveProperty("command"); expect(args).not.toHaveProperty("path");
      const echo = { protocol: MEETING_TRANSCRIPTION_PROTOCOL, job_key: args.job_key, input_sha256: args.input_sha256 };
      if (operation === "meeting_transcription_read") {
        const text = Buffer.from(files[String(args.file)]), part = text.subarray(Number(args.offset), Number(args.offset) + Number(args.length));
        return { ...echo, file: args.file, offset: args.offset, total: text.length, bytes: part.length, data: part.toString("base64"), eof: Number(args.offset) + part.length === text.length, sha256: createHash("sha256").update(text).digest("hex") };
      }
      if (operation === "meeting_transcription_upload") {
        expect(args.offset).toBe(received); const part = Buffer.from(String(args.data), "base64"); expect(part.length).toBeLessThanOrEqual(256 * 1024);
        expect(args.chunk_sha256).toBe(createHash("sha256").update(part).digest("hex")); received += part.length;
      }
      return { ...echo, input_bytes: bytes.length, received, state: operation === "meeting_transcription_start" ? "succeeded" : "uploading",
        files: Object.entries(files).map(([file, text]) => ({ file, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") })) };
    });
    const open = vi.fn(() => ({ call, destroy }));
    const runner = new ResearchMossRunner({ open, readiness: ready } as unknown as Pick<MeetingTranscriptionCapabilities, "open" | "readiness">, { device: "test-device" });
    try {
      expect((await runner.transcribe(binding, { path: input, name: "upload.wav", mime: "audio/wav" }, new AbortController().signal)).integrity?.complete).toBe(true);
      expect(received).toBe(bytes.length); expect(open).toHaveBeenCalledWith(expect.objectContaining({ username: "alice", device: "test-device" })); expect(destroy).toHaveBeenCalledTimes(1);
      expect(call.mock.calls.filter(([op]) => op === "meeting_transcription_upload")).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("checks revocation after a late response and never falls back to shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-revoke-")), input = join(root, "upload.wav"); writeFileSync(input, "a");
    let authorized = true; const destroy = vi.fn(), call = vi.fn(async () => { authorized = false; return {}; });
    const runner = new ResearchMossRunner({ open: () => ({ call, destroy }), readiness: ready } as unknown as Pick<MeetingTranscriptionCapabilities, "open" | "readiness">, { device: "device" });
    try {
      await expect(runner.transcribe(binding, { path: input, name: "upload.wav", mime: "audio/wav" }, new AbortController().signal,
        () => {}, () => { if (!authorized) throw new Error("revoked"); })).rejects.toThrow("revoked");
      expect(call).toHaveBeenCalledTimes(1); expect(destroy).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("names an older Runner's 64 MiB ceiling instead of applying one of its own", async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-legacy-")), input = join(root, "long.wav");
    writeFileSync(input, ""); truncateSync(input, 64 * 1024 * 1024 + 1);
    const destroy = vi.fn(), call = vi.fn();
    const legacy = () => ({ ...ready(), maxInputBytes: 64 * 1024 * 1024 });
    try {
      await expect(new ResearchMossRunner({ open: () => ({ call, destroy }), readiness: legacy } as unknown as Pick<MeetingTranscriptionCapabilities, "open" | "readiness">, { device: "device" })
        .transcribe(binding, { path: input, name: "long.wav", mime: "audio/wav" }, new AbortController().signal)).rejects.toThrow("升级该设备的 Runner");
      expect(call).not.toHaveBeenCalled(); expect(destroy).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("fails closed on wrong job echoes and unavailable providers", async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-echo-")), input = join(root, "upload.wav"); writeFileSync(input, "a");
    const destroy = vi.fn(), call = vi.fn(async () => ({ protocol: MEETING_TRANSCRIPTION_PROTOCOL, job_key: "wrong" }));
    const provider = { open: () => ({ call, destroy }), readiness: ready } as unknown as Pick<MeetingTranscriptionCapabilities, "open" | "readiness">;
    try {
      await expect(new ResearchMossRunner(provider, { device: "device" }).transcribe(binding, { path: input, name: "x", mime: "audio/wav" }, new AbortController().signal)).rejects.toThrow("身份不一致");
      provider.readiness = () => ({ available: false, status: "unsupported", backend: "MOSS-Transcribe-Diarize" });
      await expect(new ResearchMossRunner(provider, { device: "device" }).transcribe(binding, { path: input, name: "x", mime: "audio/wav" }, new AbortController().signal)).rejects.toThrow("unsupported");
      expect(call).toHaveBeenCalledTimes(1); expect(destroy).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
