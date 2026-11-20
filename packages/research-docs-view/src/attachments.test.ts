import { describe, expect, it, vi } from "vitest";
import type { Call } from "@claude-bot/research-docs-contract";
import { ATTACHMENT_PREVIEW_BYTES, AttachmentOverBudget, readAttachment, uploadFile } from "./attachments.js";
import { decode, encode } from "./session.js";

describe("attachments of any size", () => {
  it("sends a large file one sliced block at a time", async () => {
    const size = 65 * 1024 * 1024, slices: number[] = [];
    const file = { name: "talk.mp4", type: "video/mp4", size,
      arrayBuffer: () => { throw new Error("must not read the whole file"); },
      slice: (start: number, end: number) => ({ arrayBuffer: async () => { slices.push(end - start); return new Uint8Array(Math.min(end, size) - start).buffer; } }) } as unknown as File;
    let received = 0;
    const call = vi.fn(async (_action: string, p: Record<string, unknown> = {}) => {
      expect(Number(p.offset)).toBe(received);
      received += decode(String(p.data)).length;
      return { file: { id: "file_x", name: "talk.mp4", media: "video/mp4", size }, next: received, complete: received === size };
    }) as unknown as Call;
    expect(await uploadFile(call, "doc", file, () => {})).toMatchObject({ size });
    expect(received).toBe(size);
    expect(Math.max(...slices)).toBe(32000);
  });
  it("stops an embedded preview at its budget but loads on explicit request", async () => {
    const size = ATTACHMENT_PREVIEW_BYTES + 3, block = new Uint8Array(4 * 1024 * 1024);
    const call = vi.fn(async (_action: string, p: Record<string, unknown> = {}) => {
      const offset = Number(p.offset), length = Math.min(block.length, size - offset);
      return { file: { id: "file_x", name: "v.mp4", media: "video/mp4", size }, data: encode(block.subarray(0, length)), next: offset + length < size ? offset + length : null };
    }) as unknown as Call;
    await expect(readAttachment(call, "doc", "file_x", undefined, ATTACHMENT_PREVIEW_BYTES)).rejects.toBeInstanceOf(AttachmentOverBudget);
    expect(call).toHaveBeenCalledTimes(1);
    const whole = await readAttachment(call, "doc", "file_x");
    expect(whole.blob.size).toBe(size);
  }, 60_000);
});
