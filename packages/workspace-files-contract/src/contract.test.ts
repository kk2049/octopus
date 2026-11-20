import { describe, expect, it } from "vitest";
import {
  WORKSPACE_FILES_ACTIONS,
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_FILES_OPERATIONS,
  WORKSPACE_FILES_READ_ACTIONS,
  readWorkspaceFilesDirectory,
  readWorkspaceFilesEntry,
  readWorkspaceFilesRoots,
  readWorkspaceTextChunk,
  readWorkspaceTextDocument,
  workspaceFilesRefusal,
} from "./index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("workspace-files/v1 vocabulary", () => {
  it("spends three Runner reads plus exactly one write", () => {
    expect([...WORKSPACE_FILES_ACTIONS]).toEqual([
      "refresh_roots",
      "list_directory",
      "open_text",
      "replace_text",
    ]);
    expect(WORKSPACE_FILES_OPERATIONS).toEqual({
      refresh_roots: "list_session_workspaces",
      list_directory: "list_workspace_entries",
      open_text: "read_workspace_text",
      replace_text: "replace_workspace_text",
    });
    // The read half is still nameable on its own, so a read-only composition can
    // say what it wants without enumerating what it does not.
    expect([...WORKSPACE_FILES_READ_ACTIONS]).toEqual(["refresh_roots", "list_directory", "open_text"]);
  });

  it("bounds refusal text rather than letting a backend write a novel", () => {
    const refusal = workspaceFilesRefusal("too_large", `bad\n${"x".repeat(1_000)}`);
    expect(refusal.message).toHaveLength(WORKSPACE_FILES_LIMITS.maxMessageLength);
    expect(refusal.message).not.toContain("\n");
    expect(refusal.ok).toBe(false);
  });
});

describe("workspace-files/v1 projections", () => {
  it("reads a roots projection and refuses one that names a device selector", () => {
    const good = readWorkspaceFilesRoots({
      roots: [{ ref: "wf_root_1", label: "octopus", sourceLabel: "我的笔记本" }],
      truncated: false,
    });
    expect(good.ok).toBe(true);

    const smuggled = readWorkspaceFilesRoots({
      roots: [{ ref: "wf_root_1", label: "octopus", sourceLabel: "laptop", device: "laptop" }],
      truncated: false,
    });
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.issues[0].code).toBe("unknown_field");
  });

  it("refuses a workspace_id or a relative path smuggled onto an entry", () => {
    for (const extra of [{ workspace_id: "ws_0123456789abcdef01234567" }, { relativePath: "src/a.ts" }, { path: "/x" }]) {
      const read = readWorkspaceFilesEntry({ ref: "wf_a", label: "a.ts", kind: "file", ...extra });
      expect(read.ok).toBe(false);
    }
  });

  it("requires a ref on file and directory entries and forbids one on `other`", () => {
    expect(readWorkspaceFilesEntry({ label: "a.ts", kind: "file" }).ok).toBe(false);
    expect(readWorkspaceFilesEntry({ label: "link", kind: "other" }).ok).toBe(true);

    const symlinkWithRef = readWorkspaceFilesEntry({ ref: "wf_link", label: "link", kind: "other" });
    expect(symlinkWithRef.ok).toBe(false);
  });

  it("keeps optional entry fields optional and validates the ones that are present", () => {
    const full = readWorkspaceFilesEntry({
      ref: "wf_a",
      label: "a.ts",
      kind: "file",
      sizeBytes: 12,
      modifiedAt: "2026-08-06T00:00:00.000Z",
      exceedsTextLimit: false,
    });
    expect(full).toEqual({
      ok: true,
      value: {
        ref: "wf_a",
        label: "a.ts",
        kind: "file",
        sizeBytes: 12,
        modifiedAt: "2026-08-06T00:00:00.000Z",
        exceedsTextLimit: false,
      },
    });

    expect(readWorkspaceFilesEntry({ ref: "wf_a", label: "a.ts", kind: "file", modifiedAt: "yesterday" }).ok)
      .toBe(false);
    expect(readWorkspaceFilesEntry({ ref: "wf_a", label: "a.ts", kind: "socket" }).ok).toBe(false);
  });

  it("bounds a directory listing at the declared entry cap", () => {
    const entries = Array.from({ length: WORKSPACE_FILES_LIMITS.maxEntries + 1 }, (_unused, i) => ({
      ref: `wf_${i}`,
      label: `f${i}`,
      kind: "file" as const,
    }));
    const read = readWorkspaceFilesDirectory({ ref: "wf_dir", label: "src", entries, truncated: true });
    expect(read.ok).toBe(false);
  });

  it("insists a text document states a sha256 digest and a size within the cap", () => {
    const good = readWorkspaceTextDocument({
      ref: "wf_a",
      label: "a.ts",
      mediaType: "text/plain; charset=utf-8",
      sizeBytes: 3,
      digest: DIGEST,
    });
    expect(good.ok).toBe(true);

    expect(
      readWorkspaceTextDocument({
        ref: "wf_a",
        label: "a.ts",
        mediaType: "text/plain; charset=utf-8",
        sizeBytes: 3,
        digest: "sha1:abc",
      }).ok,
    ).toBe(false);

    expect(
      readWorkspaceTextDocument({
        ref: "wf_a",
        label: "a.log",
        mediaType: "text/plain; charset=utf-8",
        sizeBytes: 3 * 1024 ** 3,
        digest: DIGEST,
      }).ok,
    ).toBe(true);
    expect(
      readWorkspaceTextDocument({
        ref: "wf_a",
        label: "a.ts",
        mediaType: "text/plain; charset=utf-8",
        sizeBytes: WORKSPACE_FILES_LIMITS.maxTextBytes + 1,
        digest: DIGEST,
      }).ok,
    ).toBe(false);
  });

  it("lets a text chunk carry text and nothing else", () => {
    expect(readWorkspaceTextChunk({ text: "hello" })).toEqual({ ok: true, value: { text: "hello" } });
    expect(readWorkspaceTextChunk({ text: "hello", byteOffset: 0 }).ok).toBe(false);
    expect(readWorkspaceTextChunk({ text: "x".repeat(WORKSPACE_FILES_LIMITS.textChunkBytes + 1) }).ok).toBe(false);
    expect(readWorkspaceTextChunk({ text: "行".repeat(Math.floor(WORKSPACE_FILES_LIMITS.textChunkBytes / 2)) }).ok)
      .toBe(false);
  });
});
