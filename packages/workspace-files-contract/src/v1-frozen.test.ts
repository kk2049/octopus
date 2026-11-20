/**
 * `workspace-files/v1`, frozen — by golden values rather than by nobody touching
 * the files.
 *
 * "Freeze v1" cannot mean "do not edit those modules": v2 shares v1's readers and
 * v1's remote client on purpose, because a copy of the arrival checks is a copy
 * that drifts silently in exactly the places where being wrong produces a
 * plausible truncated file. So what is actually owed is that v1's ANSWERS and
 * v1's public surface do not move, and that is checkable.
 *
 * Every literal below is a v1 answer as it exists today. A change to any of them
 * changes what an already-installed release sees, which is the thing a rollback
 * target is not allowed to do.
 */

import { describe, expect, it } from "vitest";
import {
  RESOURCE_ACTIONS,
  RESOURCE_PARAMS,
  WORKSPACE_FILES_PROPOSAL_ACTIONS,
  createRemoteWorkspaceFilesPort,
} from "./remote.js";
import {
  WORKSPACE_ENTRY_KINDS,
  WORKSPACE_FILES_ACTIONS,
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_FILES_OPERATIONS,
  WORKSPACE_FILES_REFUSALS,
  WORKSPACE_TEXT_CHUNK_PAYLOAD,
  WORKSPACE_TEXT_MEDIA_TYPE,
  WORKSPACE_TEXT_RESOURCE_KIND,
} from "./limits.js";
import {
  readWorkspaceFilesDirectory,
  readWorkspaceFilesRoots,
} from "./projection.js";

describe("v1's vocabulary is exactly what it was", () => {
  it("names one contract, four verbs and four permission tokens", () => {
    expect(WORKSPACE_FILES_CONTRACT).toBe("workspace-files/v1");
    expect([...WORKSPACE_FILES_ACTIONS]).toEqual([
      "refresh_roots",
      "list_directory",
      "open_text",
      "replace_text",
    ]);
    expect({ ...WORKSPACE_FILES_OPERATIONS }).toEqual({
      refresh_roots: "list_session_workspaces",
      list_directory: "list_workspace_entries",
      open_text: "read_workspace_text",
      replace_text: "replace_workspace_text",
    });
  });

  it("keeps the same payload id and resource kind — v2 reuses both", () => {
    // Not an oversight: a text chunk is byte-identical across the two versions,
    // and a second payload id would be a second thing to keep in step for a
    // shape that did not change.
    expect(WORKSPACE_TEXT_CHUNK_PAYLOAD).toBe("workspace-files/v1#text-chunk");
    expect(WORKSPACE_TEXT_MEDIA_TYPE).toBe("text/plain; charset=utf-8");
    expect(WORKSPACE_TEXT_RESOURCE_KIND).toBe("workspace-text");
  });

  it("keeps every bound and every refusal code", () => {
    expect({ ...WORKSPACE_FILES_LIMITS }).toEqual({
      maxRoots: 64,
      maxEntries: 500,
      maxLabelLength: 255,
      maxRefLength: 200,
      // 2026-10-20: reads are windowed end to end, so the text total is a
      // representation bound; whole-document views budget themselves.
      maxTextBytes: Number.MAX_SAFE_INTEGER,
      wholeTextBytes: 16 * 1024 * 1024,
      wholeTextMaxBytes: 128 * 1024 * 1024,
      maxWriteTextBytes: 256 * 1024,
      textChunkBytes: 256 * 1024,
      maxMediaTypeLength: 128,
      maxMessageLength: 200,
      maxDigestLength: 71,
      maxMutationIdLength: 64,
    });
    expect([...WORKSPACE_ENTRY_KINDS]).toEqual(["file", "directory", "other"]);
    expect([...WORKSPACE_FILES_REFUSALS]).toEqual([
      "unknown_ref",
      "wrong_kind",
      "scope_closed",
      "no_authority",
      "approval_required",
      "not_found",
      "not_a_directory",
      "not_a_file",
      "not_text",
      "too_large",
      "outside_workspace",
      "denied",
      "unavailable",
      "invalid_request",
      "digest_mismatch",
      "read_only",
    ]);
  });

  it("uses the same six action ids and the same parameter names", () => {
    expect({ ...RESOURCE_ACTIONS }).toEqual({
      refreshRoots: "resource.refresh_roots",
      listDirectory: "resource.list_directory",
      openText: "resource.open_text",
      replaceText: "resource.replace_text",
      streamPull: "resource.stream_pull",
      streamClose: "resource.stream_close",
    });
    expect({ ...RESOURCE_PARAMS }).toEqual({
      binding: "binding",
      ref: "ref",
      handle: "handle",
      seq: "seq",
      expectedDigest: "expected_digest",
      text: "text",
    });
    expect([...WORKSPACE_FILES_PROPOSAL_ACTIONS]).toEqual([
      "resource.refresh_roots",
      "resource.list_directory",
      "resource.open_text",
      "resource.replace_text",
      "resource.stream_pull",
      "resource.stream_close",
    ]);
  });
});

describe("v1's answers are byte-for-byte what they were", () => {
  it("round-trips a roots answer with no field added or dropped", () => {
    const wire = {
      roots: [
        { ref: "wf_one", label: "octopus", sourceLabel: "我的笔记本" },
        { ref: "wf_two", label: "notes", sourceLabel: "我的笔记本" },
      ],
      truncated: false,
    };
    const read = readWorkspaceFilesRoots(wire);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(JSON.parse(JSON.stringify(read.value))).toEqual(wire);
  });

  it("round-trips a listing, including the `other` row that carries no ref", () => {
    const wire = {
      ref: "wf_dir",
      label: "src",
      entries: [
        { ref: "wf_sub", label: "lib", kind: "directory" },
        {
          ref: "wf_file",
          label: "index.ts",
          kind: "file",
          sizeBytes: 12,
          modifiedAt: "2026-08-10T00:00:00.000Z",
          exceedsTextLimit: false,
        },
        { label: "link", kind: "other" },
      ],
      truncated: false,
    };
    const read = readWorkspaceFilesDirectory(wire);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(JSON.parse(JSON.stringify(read.value))).toEqual(wire);
  });
});

describe("v1's public factory takes the two arguments it always took", () => {
  it("accepts a transport and a binding, and nothing else selects a contract", () => {
    // A third, optional, version parameter would have been cheaper to write and
    // would have made every existing call site one that could have asked for a
    // different contract. Which contract a port speaks is decided by the
    // released binding plan, on the trusted side.
    expect(createRemoteWorkspaceFilesPort.length).toBe(2);
    const remote = createRemoteWorkspaceFilesPort(
      { propose: async () => ({ ok: false, code: "no_authority", message: "" }) },
      "workspace",
    );
    expect(remote.port.contract).toBe(WORKSPACE_FILES_CONTRACT);
    remote.destroy();
  });
});
