/**
 * One writer, two callers, and the things neither of them may choose.
 *
 * The panel route and the Session Plus coordinator arrive from opposite sides
 * of a trust boundary. What keeps them honest is that the file name, the
 * directory, the accepted types and the size cap are decided here — so these
 * tests are about what a CALLER cannot do, more than about what one can.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, existsSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_CHUNK_BYTES } from "@claude-bot/dashboard-web/contract";
import {
  ATTACHMENT_ACTIVE_UPLOADS_PER_OWNER,
  AttachmentUploads,
  attachmentKind,
  attachmentLabel,
  attachmentsRoot,
  storeAttachment,
} from "./store.js";

function home(): string {
  return mkdtempSync(path.join(tmpdir(), "octopus-attach-"));
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
const AT = new Date("2026-08-17T09:41:07.000Z");

describe("storeAttachment", () => {
  it("writes into a dated directory under a name the caller did not pick", async () => {
    const root = home();
    const stored = await storeAttachment(root, { name: "../../etc/passwd", mediaType: "image/png", data: PNG }, AT);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.attachment.path.startsWith(path.join(attachmentsRoot(root), "2026-08-17"))).toBe(true);
    expect(path.basename(stored.attachment.path)).toMatch(/^094107-[0-9a-f]{8}\.png$/);
    expect(readFileSync(stored.attachment.path)).toEqual(Buffer.from(PNG, "base64"));
    // The caller's name survives only as a label, and never as a path segment.
    expect(stored.attachment.label).not.toContain("/");
  });

  it("accepts a data-URL prefix, because that is what a browser hands you", async () => {
    const stored = await storeAttachment(home(), {
      mediaType: "image/png",
      data: `data:image/png;base64,${PNG}`,
    }, AT);
    expect(stored.ok).toBe(true);
  });

  it("legacy single-shot seam still refuses anything that is not one of the four raster types", async () => {
    for (const mediaType of ["image/svg+xml", "text/html", "application/pdf", ""]) {
      const stored = await storeAttachment(home(), { mediaType, data: PNG }, AT);
      expect(stored).toMatchObject({ ok: false, code: "unsupported_media" });
    }
  });

  it("refuses content that is not really base64, instead of writing what decoded", async () => {
    const stored = await storeAttachment(home(), { mediaType: "image/png", data: "not base64 at all!!" }, AT);
    expect(stored).toMatchObject({ ok: false, code: "not_base64" });
  });

  it("refuses an empty upload", async () => {
    expect(await storeAttachment(home(), { mediaType: "image/png", data: "" }, AT))
      .toMatchObject({ ok: false, code: "empty" });
  });


  it("removes dated directories past the retention window on the next write", async () => {
    const root = home();
    const stale = path.join(attachmentsRoot(root), "2026-07-01");
    mkdirSync(stale, { recursive: true });
    await storeAttachment(root, { mediaType: "image/png", data: PNG }, AT);
    // Retention is best-effort and deliberately not awaited by the upload, so
    // give the microtask that runs it a turn before looking.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(attachmentsRoot(root))).toContain("2026-08-17");
  });
});

describe("attachmentLabel", () => {
  it("corrects the extension and keeps the stem", () => {
    expect(attachmentLabel("screen.jpeg", "png")).toBe("screen.png");
    expect(attachmentLabel("", "png")).toBe("粘贴图片.png");
    expect(attachmentLabel("a/b\\c.png", "png")).toBe("abc.png");
  });
});

/** Upload `bytes` the way the panel does: sequential chunks of ATTACHMENT_CHUNK_BYTES. */
async function uploadInChunks(uploads: AttachmentUploads, owner: string, bytes: Buffer, name: string, mediaType: string) {
  const chunkCount = Math.max(1, Math.ceil(bytes.length / ATTACHMENT_CHUNK_BYTES));
  let uploadId = "";
  for (let index = 0; index < chunkCount; index += 1) {
    const answer = await uploads.accept({
      owner, chunkIndex: index, chunkCount, ...(index === 0 ? { size: bytes.length, name, mediaType } : { uploadId }),
      data: bytes.subarray(index * ATTACHMENT_CHUNK_BYTES, (index + 1) * ATTACHMENT_CHUNK_BYTES).toString("base64"),
    });
    if (!answer.ok) throw new Error(`${answer.code}: ${answer.message}`);
    if (index < chunkCount - 1) {
      expect(answer.complete).toBe(false);
      if (!answer.complete) uploadId = answer.uploadId;
    } else if (answer.complete) {
      return answer.attachment;
    }
  }
  throw new Error("upload never completed");
}

describe("AttachmentUploads", () => {
  it("assembles a 40 MiB non-image file from bounded chunks, hashed, with no size ceiling", async () => {
    const root = home();
    const uploads = new AttachmentUploads(root, { now: () => AT });
    const bytes = Buffer.alloc(40 * 1024 * 1024 + 123);
    for (let at = 0; at < bytes.length; at += 4096) bytes[at] = (at / 4096) & 0xff;
    const stored = await uploadInChunks(uploads, "alice", bytes, "trace dump.pdf", "application/pdf");
    expect(stored.bytes).toBe(bytes.length);
    expect(stored.mediaType).toBe("application/pdf");
    expect(stored.label).toBe("trace dump.pdf");
    expect(stored.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(path.basename(stored.path)).toMatch(/^094107-[0-9a-f]{24}\.pdf$/);
    expect(readFileSync(stored.path).equals(bytes)).toBe(true);
    expect(statSync(stored.path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(`${stored.path}.owner.json`, "utf8"))).toEqual({
      owner: "alice", media_type: "application/pdf", bytes: bytes.length, sha256: stored.sha256,
    });
    // Nothing is left staged, and the staging area is not a dated directory.
    expect(uploads.active).toBe(0);
    expect(readdirSync(path.join(attachmentsRoot(root), ".staging"))).toEqual([]);
  });

  it("treats a body without chunk fields as a whole file in one chunk (an older page)", async () => {
    const uploads = new AttachmentUploads(home(), { now: () => AT });
    const answer = await uploads.accept({ owner: "alice", name: "shot.png", mediaType: "image/png", data: PNG });
    expect(answer).toMatchObject({ ok: true, complete: true, attachment: { label: "shot.png", mediaType: "image/png" } });
  });

  it("refuses out-of-order, foreign-owner and mismatched-count chunks without writing", async () => {
    const uploads = new AttachmentUploads(home(), { now: () => AT });
    const first = await uploads.accept({ owner: "alice", chunkIndex: 0, chunkCount: 3, name: "a.txt", mediaType: "text/plain", data: PNG });
    if (!first.ok || first.complete) throw new Error("expected a staged upload");
    const uploadId = first.uploadId;
    expect(await uploads.accept({ owner: "alice", uploadId, chunkIndex: 2, chunkCount: 3, data: PNG }))
      .toMatchObject({ ok: false, code: "bad_chunk" });
    expect(await uploads.accept({ owner: "alice", uploadId, chunkIndex: 1, chunkCount: 4, data: PNG }))
      .toMatchObject({ ok: false, code: "bad_chunk" });
    // Another owner holding the id learns nothing: it reads as expired.
    expect(await uploads.accept({ owner: "bob", uploadId, chunkIndex: 1, chunkCount: 3, data: PNG }))
      .toMatchObject({ ok: false, code: "expired" });
    expect(await uploads.accept({ owner: "alice", uploadId: "x".repeat(24), chunkIndex: 1, chunkCount: 3, data: PNG }))
      .toMatchObject({ ok: false, code: "expired" });
    expect(await uploads.accept({ owner: "alice", uploadId, chunkIndex: 0, chunkCount: 3, data: PNG }))
      .toMatchObject({ ok: false, code: "bad_chunk" });
    // The upload is intact and still completes in order.
    expect(await uploads.accept({ owner: "alice", uploadId, chunkIndex: 1, chunkCount: 3, data: PNG }))
      .toMatchObject({ ok: true, complete: false, receivedBytes: 16 });
    expect(await uploads.accept({ owner: "alice", uploadId, chunkIndex: 2, chunkCount: 3, data: PNG }))
      .toMatchObject({ ok: true, complete: true, attachment: { bytes: 24, mediaType: "text/plain" } });
  });

  it("refuses an assembled file that does not match its declared size, keeping nothing", async () => {
    const root = home();
    const uploads = new AttachmentUploads(root, { now: () => AT });
    const answer = await uploads.accept({ owner: "alice", size: 9, name: "a.bin", mediaType: "", data: PNG });
    expect(answer).toMatchObject({ ok: false, code: "size_mismatch" });
    expect(existsSync(path.join(attachmentsRoot(root), "2026-08-17"))).toBe(false);
    expect(readdirSync(path.join(attachmentsRoot(root), ".staging"))).toEqual([]);
  });

  it("discards an idle staged upload after its TTL and sweeps staging orphaned by a restart", async () => {
    const root = home();
    const staging = path.join(attachmentsRoot(root), ".staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "o".repeat(24)), "left by a previous process");
    utimesSync(path.join(staging, "o".repeat(24)), new Date(0), new Date(0));
    const uploads = new AttachmentUploads(root, { now: () => AT, ttlMs: 20 });
    const first = await uploads.accept({ owner: "alice", chunkIndex: 0, chunkCount: 2, data: PNG });
    if (!first.ok || first.complete) throw new Error("expected a staged upload");
    expect(readdirSync(staging)).toEqual([first.uploadId]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(uploads.active).toBe(0);
    expect(readdirSync(staging)).toEqual([]);
    expect(await uploads.accept({ owner: "alice", uploadId: first.uploadId, chunkIndex: 1, chunkCount: 2, data: PNG }))
      .toMatchObject({ ok: false, code: "expired" });
  });

  it("bounds unfinished uploads per owner, not bytes", async () => {
    const uploads = new AttachmentUploads(home(), { now: () => AT });
    for (let index = 0; index < ATTACHMENT_ACTIVE_UPLOADS_PER_OWNER; index += 1) {
      expect(await uploads.accept({ owner: "alice", chunkIndex: 0, chunkCount: 2, data: PNG })).toMatchObject({ ok: true });
    }
    expect(await uploads.accept({ owner: "alice", chunkIndex: 0, chunkCount: 2, data: PNG }))
      .toMatchObject({ ok: false, code: "busy" });
    expect(await uploads.accept({ owner: "bob", chunkIndex: 0, chunkCount: 2, data: PNG })).toMatchObject({ ok: true });
  });

  it("stops at the volume's free-space reserve instead of filling the disk", async () => {
    const uploads = new AttachmentUploads(home(), { now: () => AT, reserveBytes: Number.MAX_SAFE_INTEGER });
    expect(await uploads.accept({ owner: "alice", data: PNG })).toMatchObject({ ok: false, code: "disk_full" });
  });
});

describe("attachmentKind", () => {
  it("keeps raster extensions canonical and derives a bounded extension otherwise", () => {
    expect(attachmentKind("image/png", "x.jpeg")).toEqual({ mediaType: "image/png", extension: "png", image: true });
    expect(attachmentKind("text/html", "page.HTML")).toEqual({ mediaType: "text/html", extension: "html", image: false });
    expect(attachmentKind("", "../../etc/passwd")).toEqual({ mediaType: "application/octet-stream", extension: "bin", image: false });
    expect(attachmentKind("not a type", "a.tar.gz")).toEqual({ mediaType: "application/octet-stream", extension: "gz", image: false });
    expect(attachmentKind("image/svg+xml", "x.svg")).toMatchObject({ extension: "svg", image: false });
  });
});
