/**
 * A pasted picture only helps if the agent is TOLD about it.
 *
 * So the load-bearing assertion is not that the upload happened — it is that
 * the body the ticket carries names the absolute path, and that removing a
 * chip removes that line. A picture the brief does not mention is a picture
 * nobody opens.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("./api.js", () => ({ api: (...args: unknown[]) => post(...args) }));

const { attachmentRefBlock, filesFromClipboard, uploadAttachment, withAttachments } =
  await import("./attachments.js");
const { ATTACHMENT_CHUNK_BYTES } = await import("../contract.js");

function clipboard(items: Array<{ kind: string; type: string; file: File | null }>): DataTransfer {
  return {
    items: items.map((item) => ({ kind: item.kind, type: item.type, getAsFile: () => item.file })),
  } as unknown as DataTransfer;
}

function file(type = "image/png", name = "shot.png"): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

beforeEach(() => {
  post.mockReset();
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true });
  }
});

describe("filesFromClipboard", () => {
  it("takes every file, of any type, and leaves a text paste alone", () => {
    expect(filesFromClipboard(clipboard([{ kind: "string", type: "text/plain", file: null }]))).toEqual([]);
    expect(filesFromClipboard(clipboard([{ kind: "file", type: "image/png", file: file() }]))).toHaveLength(1);
    expect(
      filesFromClipboard(clipboard([{ kind: "file", type: "application/pdf", file: file("application/pdf", "brief.pdf") }])),
    ).toHaveLength(1);
    expect(filesFromClipboard(null)).toEqual([]);
  });

  it("does not silently drop files past a count: every file on the clipboard becomes a chip", () => {
    const many = Array.from({ length: 9 }, () => ({ kind: "file", type: "image/png", file: file() }));
    expect(filesFromClipboard(clipboard(many))).toHaveLength(9);
  });
});

describe("uploadAttachment", () => {
  it("sends a small file as one chunk with its declared size, and keeps the server's own label", async () => {
    post.mockResolvedValue({
      complete: true,
      attachment: { label: "shot.png", path: "/home/u/.octopus/attachments/2026-08-17/x.png", bytes: 4, media_type: "image/png" },
    });
    const attachment = await uploadAttachment(file());
    expect(post).toHaveBeenCalledWith("/api/attachments", expect.objectContaining({ method: "POST" }));
    const sent = post.mock.calls[0]![1] as { json: Record<string, unknown> };
    expect(sent.json).toMatchObject({ chunk_index: 0, chunk_count: 1, size: 4, media_type: "image/png" });
    expect(sent.json.data).toBe(btoa(String.fromCharCode(1, 2, 3, 4)));
    expect(attachment.path).toBe("/home/u/.octopus/attachments/2026-08-17/x.png");
    expect(attachment.previewUrl).not.toBe("");
  });

  it("splits a large non-image file into bounded sequential chunks and gives it no preview", async () => {
    const size = ATTACHMENT_CHUNK_BYTES * 2 + 10;
    const big = new File([new Uint8Array(size).fill(7)], "trace.html", { type: "text/html" });
    post
      .mockResolvedValueOnce({ complete: false, upload_id: "u".repeat(24) })
      .mockResolvedValueOnce({ complete: false, upload_id: "u".repeat(24) })
      .mockResolvedValueOnce({ complete: true, upload_id: "u".repeat(24),
        attachment: { label: "trace.html", path: "/srv/a/trace.html", bytes: size, media_type: "text/html" } });
    const progress: number[] = [];
    const attachment = await uploadAttachment(big, { onProgress: (sent) => progress.push(sent) });
    const bodies = post.mock.calls.map(([, init]) => (init as { json: Record<string, unknown> }).json);
    expect(bodies.map((body) => [body.chunk_index, body.chunk_count, body.upload_id])).toEqual([
      [0, 3, undefined], [1, 3, "u".repeat(24)], [2, 3, "u".repeat(24)],
    ]);
    expect(bodies.map((body) => atob(String(body.data)).length)).toEqual([ATTACHMENT_CHUNK_BYTES, ATTACHMENT_CHUNK_BYTES, 10]);
    expect(bodies[0]).toMatchObject({ name: "trace.html", media_type: "text/html", size });
    expect(progress).toEqual([ATTACHMENT_CHUNK_BYTES, ATTACHMENT_CHUNK_BYTES * 2, size]);
    expect(attachment).toMatchObject({ path: "/srv/a/trace.html", mediaType: "text/html", previewUrl: "" });
  });

  it("stops between chunks once the draft is no longer current", async () => {
    const big = new File([new Uint8Array(ATTACHMENT_CHUNK_BYTES + 1)], "a.bin", { type: "" });
    post.mockResolvedValueOnce({ complete: false, upload_id: "u".repeat(24) });
    let live = true;
    const pending = uploadAttachment(big, { current: () => live, onProgress: () => { live = false; } });
    await expect(pending).rejects.toThrow(/草稿已变化/);
    expect(post).toHaveBeenCalledOnce();
  });

  it("refuses an answer with no path rather than inventing one", async () => {
    post.mockResolvedValue({ attachment: { label: "shot.png" } });
    await expect(uploadAttachment(file())).rejects.toThrow(/文件位置/);
  });
});

describe("the body an agent actually reads", () => {
  const one = {
    id: "att-1",
    label: "shot.png",
    path: "/home/u/.octopus/attachments/2026-08-17/x.png",
    bytes: 4,
    mediaType: "image/png",
    previewUrl: "blob:x",
  };

  it("names every remaining attachment by absolute path", () => {
    const body = withAttachments("按钮点不动", [one]);
    expect(body).toContain("按钮点不动");
    expect(body).toContain("/home/u/.octopus/attachments/2026-08-17/x.png");
    expect(body).toContain("附件（1 个");
  });

  it("adds nothing at all when the draft has no attachments", () => {
    expect(attachmentRefBlock([])).toBe("");
    expect(withAttachments("  只有文字  ", [])).toBe("只有文字");
  });
});
