import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { AudioUploadController } from "./audio-upload.js";
import { HASH_WINDOW_BYTES, UPLOAD_CHUNK_BYTES } from "./file-upload.js";
import type { Call } from "./client.js";

const recording = (size = 4) => ({ name: "meeting.wav", type: "audio/wav", size,
  slice: (start: number, end: number) => ({ arrayBuffer: async () => new Uint8Array(end - start).buffer }) });
/** A long recording that exists only as slices: reading it whole is a failure. */
function synthetic(size: number) {
  const byte = (offset: number) => (Math.imul(offset, 2654435761) >>> 24) & 0xff;
  const slices: number[] = [];
  return { slices, source: { name: "long-meeting.wav", type: "audio/wav", size,
    arrayBuffer: () => { throw new Error("the whole recording must never be read at once"); },
    slice: (start: number, end: number) => ({ arrayBuffer: async () => {
      slices.push(end - start);
      const bytes = new Uint8Array(end - start);
      for (let index = 0; index < bytes.length; index++) bytes[index] = byte(start + index);
      return bytes.buffer;
    } }) }, digest: () => {
    const hash = createHash("sha256"), window = new Uint8Array(1 << 20);
    for (let offset = 0; offset < size; offset += window.length) {
      const part = window.subarray(0, Math.min(window.length, size - offset));
      for (let index = 0; index < part.length; index++) part[index] = byte(offset + index);
      hash.update(part);
    }
    return hash.digest("hex");
  } };
}
const file = { id: "file-1", name: "meeting.wav", mime: "audio/wav", bytes: 4, sha256: "0".repeat(64), version: 1 };
describe("durable meeting upload", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("crypto", { randomUUID: () => "upload-request", subtle: { digest: async () => new Uint8Array(32).buffer } });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("reconciles an uncertain commit with the original request after reload and never starts transcription", async () => {
    let received = 0, lost = true;
    const invoke = vi.fn(async (action: string, params?: Record<string, unknown>) => {
      if (action === "file_begin") return { upload: { id: "upload", received } };
      if (action === "file_chunk") { received = 4; return {}; }
      if (action === "file_commit") { if (lost) { lost = false; throw new Error("回复丢失"); } return { file }; }
      throw new Error(`unexpected ${action} ${params}`);
    });
    const first = new AudioUploadController(invoke as Call, "alice:project", "audio");
    await first.upload(recording()); expect(first.snapshot().phase).toBe("failed"); first.close();
    const restored = new AudioUploadController(invoke as Call, "alice:project", "audio");
    expect(restored.snapshot().phase).toBe("paused");
    await restored.upload(recording());
    expect(restored.snapshot().file).toEqual(file);
    expect(invoke.mock.calls.filter(([action]) => action === "file_chunk")).toHaveLength(1);
    expect(invoke.mock.calls.filter(([action]) => action === "file_commit").map(([, params]) => params?.request)).toEqual(["upload-request:commit", "upload-request:commit"]);
    expect(invoke.mock.calls.some(([action]) => action === "audio_transcribe" || action === "resource_read")).toBe(false);
  });
  it("uploads a 100 MiB recording in bounded slices without ever holding it whole", async () => {
    const size = 100 * 1024 * 1024 + 12_345, long = synthetic(size);
    let received = 0, declared = "";
    const invoke = vi.fn(async (action: string, params?: Record<string, unknown>) => {
      if (action === "file_begin") { declared = (params!.data as { sha256: string }).sha256; return { upload: { id: "upload", received: 0 } }; }
      if (action === "file_chunk") {
        expect(params!.offset).toBe(received);
        received += atob(String(params!.data)).length; return { received };
      }
      if (action === "file_commit") return { file: { ...file, bytes: size, sha256: declared } };
      throw new Error(`unexpected ${action}`);
    });
    const controller = new AudioUploadController(invoke as Call, "alice:project", "audio");
    await controller.upload(long.source);
    expect(controller.snapshot()).toMatchObject({ phase: "completed", received: size, error: "" });
    expect(received).toBe(size);
    expect(declared).toBe(long.digest());
    expect(Math.max(...long.slices)).toBeLessThanOrEqual(HASH_WINDOW_BYTES);
    // One hashing pass and one upload pass, each a sequence of bounded slices.
    expect(long.slices).toHaveLength(Math.ceil(size / HASH_WINDOW_BYTES) + Math.ceil(size / UPLOAD_CHUNK_BYTES));
  }, 120_000);
  it("waits for the current chunk before pausing and sends no later chunk or commit", async () => {
    let finish!: () => void;
    const invoke = vi.fn(async (action: string) => {
      if (action === "file_begin") return { upload: { id: "upload", received: 0 } };
      if (action === "file_chunk") return new Promise<void>(resolve => { finish = resolve; });
      throw new Error("must not commit");
    });
    const controller = new AudioUploadController(invoke as Call, "alice:project", "audio");
    const result = controller.upload(recording(64_000));
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); controller.cancel();
    expect(controller.snapshot().phase).toBe("pausing"); finish(); await result;
    expect(controller.snapshot().phase).toBe("paused");
    expect(invoke.mock.calls.map(([action]) => action)).toEqual(["file_begin", "file_chunk"]);
  });
  it("does not apply a late reply after its owning project closes", async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise(resolve => { finish = resolve; })) as Call;
    const controller = new AudioUploadController(invoke, "alice:project", "audio"), listener = vi.fn(); controller.subscribe(listener);
    const result = controller.upload(recording()); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    controller.close(); const count = listener.mock.calls.length; finish({ upload: { id: "upload", received: 0 } }); await result;
    expect(listener).toHaveBeenCalledTimes(count); expect(invoke).toHaveBeenCalledTimes(1);
  });
});
