import { describe, expect, it } from "vitest";
import {
  RESOURCE_PAGE_PARAM,
  compareWorkspaceListPositions,
  readWorkspaceListCursor,
  workspaceListCursor,
  workspaceListCursorAfter,
} from "./paging.js";
import { RESOURCE_ACTIONS, createRemoteWorkspaceFilesPort, type ProposalAnswer } from "./remote.js";
import { WORKSPACE_FILES_LIMITS } from "./limits.js";
import { utf8ByteLength } from "./projection.js";
import { workspaceTextWindows } from "./upload.js";

describe("the listing cursor", () => {
  it("is the last row itself, and round-trips", () => {
    for (const entry of [
      { kind: "directory" as const, label: "src" },
      { kind: "file" as const, label: "a:b c.txt" },
      { kind: "other" as const, label: "链接" },
    ]) {
      expect(readWorkspaceListCursor(workspaceListCursor(entry))).toEqual(entry);
    }
    expect(workspaceListCursorAfter([])).toBeNull();
    expect(workspaceListCursorAfter([{ kind: "file", label: "a" }, { kind: "file", label: "b" }])).toBe("file/b");
  });

  it("refuses anything that is not a position rather than repairing it", () => {
    for (const bad of ["", "file", "file/", "/a", "folder/a", "file/a/b", "file/a\u0000", 7, null,
      `file/${"x".repeat(WORKSPACE_FILES_LIMITS.maxLabelLength + 1)}`]) {
      expect(readWorkspaceListCursor(bad), String(bad)).toBeNull();
    }
  });

  it("orders directories, files, then the rest, by code unit within a kind", () => {
    const rows = [
      { kind: "file" as const, label: "b" },
      { kind: "other" as const, label: "a" },
      { kind: "directory" as const, label: "z" },
      { kind: "file" as const, label: "B" },
      { kind: "file" as const, label: "a" },
    ];
    expect([...rows].sort(compareWorkspaceListPositions).map((row) => `${row.kind}/${row.label}`)).toEqual([
      "directory/z",
      "file/B",
      "file/a",
      "file/b",
      "other/a",
    ]);
  });
});

describe("a remote listing continues after its cursor", () => {
  const REF = "wf_dir";
  const page = (labels: string[], truncated: boolean) => ({
    ref: REF,
    label: "src",
    entries: labels.map((label) => ({ ref: `wf_${label}`, label, kind: "file" })),
    truncated,
  });

  function transport(answer: (params: Record<string, string>) => ProposalAnswer) {
    const sent: Array<Record<string, string>> = [];
    return {
      sent,
      async propose(action: string, params: Record<string, string> = {}) {
        sent.push({ action, ...params });
        return answer(params);
      },
    };
  }

  it("sends `after` only for a later page, so page one is the proposal it always was", async () => {
    const wire = transport((params) => ({
      ok: true,
      result: params.after ? page(["c", "d"], false) : page(["a", "b"], true),
      message: "",
    }));
    const port = createRemoteWorkspaceFilesPort(wire, "workspace").port;
    const first = await port.listDirectory(REF);
    expect(first.ok && first.value.truncated).toBe(true);
    const next = await port.listDirectory(REF, workspaceListCursor({ kind: "file", label: "b" }));
    expect(next.ok && next.value.entries.map((row) => row.label)).toEqual(["c", "d"]);
    expect(wire.sent[0]).not.toHaveProperty(RESOURCE_PAGE_PARAM);
    expect(wire.sent[1]).toMatchObject({ action: RESOURCE_ACTIONS.listDirectory, [RESOURCE_PAGE_PARAM]: "file/b" });
  });

  it("refuses a provider that ignored the cursor instead of repeating rows", async () => {
    const wire = transport(() => ({ ok: true, result: page(["a", "b"], true), message: "" }));
    const port = createRemoteWorkspaceFilesPort(wire, "workspace").port;
    expect(await port.listDirectory(REF, "file/b")).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("refuses a malformed cursor before anything is sent", async () => {
    const wire = transport(() => ({ ok: true, result: page([], false), message: "" }));
    const port = createRemoteWorkspaceFilesPort(wire, "workspace").port;
    expect(await port.listDirectory(REF, "nonsense")).toMatchObject({ ok: false, code: "invalid_request" });
    expect(wire.sent).toEqual([]);
  });

  it("pages roots by the last root ref", async () => {
    const wire = transport(() => ({ ok: true, result: { roots: [], truncated: false }, message: "" }));
    const port = createRemoteWorkspaceFilesPort(wire, "workspace").port;
    await port.refreshRoots();
    await port.refreshRoots("wf_root_64");
    expect(wire.sent[0]).not.toHaveProperty(RESOURCE_PAGE_PARAM);
    expect(wire.sent[1]).toMatchObject({ action: RESOURCE_ACTIONS.refreshRoots, [RESOURCE_PAGE_PARAM]: "wf_root_64" });
  });
});

describe("text windows", () => {
  it("cuts on character boundaries and concatenates back exactly", () => {
    const text = "a😀汉".repeat(100_000);
    const windows = workspaceTextWindows(text, 1000);
    expect(windows.join("")).toBe(text);
    for (const window of windows) {
      expect(utf8ByteLength(window)).toBeLessThanOrEqual(1000);
      // A surrogate pair is never split: every window is well-formed UTF-16.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(window)).toBe(false);
    }
  });

  it("also bounds the JSON a window encodes to, where a control character costs six bytes", () => {
    const text = "\u0001".repeat(WORKSPACE_FILES_LIMITS.maxWriteTextBytes);
    const windows = workspaceTextWindows(text);
    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) {
      expect(utf8ByteLength(JSON.stringify(window))).toBeLessThanOrEqual(384 * 1024 + 2);
    }
  });

  it("keeps a text that fits as one window, including the empty one", () => {
    expect(workspaceTextWindows("")).toEqual([""]);
    expect(workspaceTextWindows("x".repeat(WORKSPACE_FILES_LIMITS.maxWriteTextBytes))).toHaveLength(1);
    expect(workspaceTextWindows("x".repeat(WORKSPACE_FILES_LIMITS.maxWriteTextBytes + 1))).toHaveLength(2);
  });
});
