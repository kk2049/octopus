import { describe, expect, it } from "vitest";
import {
  WORKSPACE_MEDIA_LIMITS,
  base64ByteLength,
  isWorkspaceMediaLabel,
  readWorkspaceMediaChunk,
  readWorkspaceMediaDocument,
} from "./media.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("workspace-files/v3 media", () => {
  it("accepts only bounded content-identified preview headers", () => {
    expect(readWorkspaceMediaDocument({
      ref: "wf_media_ref",
      label: "diagram.webp",
      mediaType: "image/webp",
      sizeBytes: 17,
      digest: DIGEST,
      modifiedAt: "2026-08-18T10:20:30.123Z",
    })).toEqual({
      ok: true,
      value: {
        ref: "wf_media_ref",
        label: "diagram.webp",
        mediaType: "image/webp",
        sizeBytes: 17,
        digest: DIGEST,
        modifiedAt: "2026-08-18T10:20:30.123Z",
      },
    });
    expect(readWorkspaceMediaDocument({
      ref: "wf_media_ref",
      label: "page.pdf",
      mediaType: "text/html",
      sizeBytes: 17,
      digest: DIGEST,
    }).ok).toBe(false);
    // No size policy: a 50 GiB file is describable; only a non-safe integer is not.
    expect(readWorkspaceMediaDocument({
      ref: "wf_media_ref",
      label: "page.pdf",
      mediaType: "application/pdf",
      sizeBytes: 50 * 1024 ** 3,
      digest: DIGEST,
    }).ok).toBe(true);
    expect(readWorkspaceMediaDocument({
      ref: "wf_media_ref",
      label: "page.pdf",
      mediaType: "application/pdf",
      sizeBytes: WORKSPACE_MEDIA_LIMITS.maxBytes + 1,
      digest: DIGEST,
    }).ok).toBe(false);
  });

  it("accounts for base64 bytes without accepting malformed or mismatched chunks", () => {
    expect(base64ByteLength("AAECAwQ=")).toBe(5);
    expect(base64ByteLength("not base64")).toBeNull();
    expect(readWorkspaceMediaChunk({ offset: 4, bytes: 5, data: "AAECAwQ=" })).toEqual({
      ok: true,
      value: { offset: 4, bytes: 5, data: "AAECAwQ=" },
    });
    expect(readWorkspaceMediaChunk({ offset: 4, bytes: 6, data: "AAECAwQ=" }).ok).toBe(false);
    expect(readWorkspaceMediaChunk({ offset: 4, bytes: 5, data: "AAECAwQ=", extra: true }).ok).toBe(false);
  });

  it("uses extensions only as a routing hint", () => {
    expect(isWorkspaceMediaLabel("scan.PDF")).toBe(true);
    expect(isWorkspaceMediaLabel("photo.jpeg")).toBe(true);
    expect(isWorkspaceMediaLabel("payload.html")).toBe(false);
  });
});
