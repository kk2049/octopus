/**
 * The unified index's join rules, as facts a test can hold still.
 *
 * The one property everything below circles: rows join by `directoryKey`
 * EQUALITY and by nothing else. Same labels, same basenames, same display
 * paths — none of it joins without the key, and the absence renders as the
 * honest note instead of a guess.
 */

import { describe, expect, it } from "vitest";
import type { DirectoryState } from "@claude-bot/agent-workspace-files-view";
import {
  FILES_UNAVAILABLE_NOTE,
  directKeyOf,
  directoryIndexRows,
  type DirectoryIndexInput,
  type IndexRow,
} from "./directory-index.js";
import type { RosterSession } from "./roster.js";

function session(over: Partial<RosterSession> & { id: string }): RosterSession {
  return {
    resourceId: over.id,
    deviceId: over.device ?? "laptop",
    cliKind: "codex",
    ...over,
    id: over.id,
    device: over.device ?? "laptop",
    cwd: over.cwd ?? "~/proj",
  };
}

function ready(value: {
  ref: string;
  label: string;
  entries: Array<Record<string, unknown>>;
  truncated?: boolean;
  directoryKey?: string;
}): DirectoryState {
  return {
    status: "ready",
    value: {
      ref: value.ref,
      label: value.label,
      entries: value.entries as never,
      truncated: value.truncated ?? false,
      ...(value.directoryKey ? { directoryKey: value.directoryKey } : {}),
    } as never,
    message: "",
    code: "",
  };
}

function base(over: Partial<DirectoryIndexInput> = {}): DirectoryIndexInput {
  return {
    sessions: [],
    workspacesByDevice: {},
    roots: null,
    rootsSettled: true,
    cache: new Map(),
    expandedDirs: new Set(),
    expanded: {},
    ...over,
  };
}

function types(rows: IndexRow[]): string[] {
  return rows.map((row) => row.type);
}

describe("directKeyOf", () => {
  it("takes the first session that carries a key, and refuses to invent one", () => {
    expect(directKeyOf({ sessions: [session({ id: "a" })] })).toBe("");
    expect(
      directKeyOf({ sessions: [session({ id: "a" }), session({ id: "b", directoryKey: "dk1_x" })] }),
    ).toBe("dk1_x");
  });
});

describe("directoryIndexRows joins", () => {
  const laptopWorkspace = {
    id: "ws_0123456789abcdef01234567",
    label: "proj",
    display: "~/proj",
    directoryKey: "dk1_root",
  };
  const filesRoot = { ref: "ref_root", label: "proj", sourceLabel: "laptop", directoryKey: "dk1_root" };

  it("merges a session node with its registered workspace by KEY, and joins the files root", () => {
    const rows = directoryIndexRows(
      base({
        sessions: [session({ id: "a", cwd: "~/proj", directoryKey: "dk1_root" })],
        workspacesByDevice: { laptop: { device: "laptop", workspaces: [laptopWorkspace] } },
        roots: { roots: [filesRoot], truncated: false },
      }),
    );
    expect(types(rows)).toEqual(["device", "directory"]);
    const dir = rows[1] as Extract<IndexRow, { type: "directory" }>;
    expect(dir.workspace?.id).toBe(laptopWorkspace.id);
    expect(dir.rootRef).toBe("ref_root");
    expect(dir.filesNote).toBe("");
    // Claimed by the join, so it is NOT a loose root.
    expect(rows.some((row) => row.type === "loose-root")).toBe(false);
  });

  it("does NOT merge on equal labels or display paths when keys are absent", () => {
    const rows = directoryIndexRows(
      base({
        sessions: [session({ id: "a", cwd: "~/proj" })],
        workspacesByDevice: {
          laptop: { device: "laptop", workspaces: [{ id: laptopWorkspace.id, label: "proj", display: "~/proj" }] },
        },
        roots: { roots: [{ ref: "ref_root", label: "proj", sourceLabel: "laptop" }], truncated: false },
      }),
    );
    // The same real directory appears as a session node AND a workspace row AND
    // a loose files root: honest duplication, never a guessed merge.
    expect(types(rows)).toEqual(["device", "directory", "workspace", "loose-root"]);
    const dir = rows[1] as Extract<IndexRow, { type: "directory" }>;
    expect(dir.workspace).toBeNull();
    expect(dir.rootRef).toBeNull();
    const workspace = rows[2] as Extract<IndexRow, { type: "workspace" }>;
    expect(workspace.rootRef).toBeNull();
    expect(workspace.filesNote).toBe(FILES_UNAVAILABLE_NOTE);
  });

  it("keys that differ do not join, even with identical display strings", () => {
    const rows = directoryIndexRows(
      base({
        sessions: [session({ id: "a", cwd: "~/proj", directoryKey: "dk1_other" })],
        workspacesByDevice: { laptop: { device: "laptop", workspaces: [laptopWorkspace] } },
        roots: { roots: [filesRoot], truncated: false },
      }),
    );
    const dir = rows.find((row) => row.type === "directory") as Extract<IndexRow, { type: "directory" }>;
    expect(dir.workspace).toBeNull();
    // The workspace row still joins ITS files root by key.
    const workspace = rows.find((row) => row.type === "workspace") as Extract<IndexRow, { type: "workspace" }>;
    expect(workspace.rootRef).toBe("ref_root");
  });

  it("holds the absence note back until roots enumeration has settled", () => {
    const rows = directoryIndexRows(
      base({
        rootsSettled: false,
        workspacesByDevice: { laptop: { device: "laptop", workspaces: [laptopWorkspace] } },
      }),
    );
    const workspace = rows.find((row) => row.type === "workspace") as Extract<IndexRow, { type: "workspace" }>;
    expect(workspace.filesNote).toBe("");
  });

  it("lists a device that has only workspaces, after the devices with sessions", () => {
    const rows = directoryIndexRows(
      base({
        sessions: [session({ id: "a", device: "zeta", cwd: "~/x" })],
        workspacesByDevice: { alpha: { device: "alpha", workspaces: [{ id: laptopWorkspace.id, label: "w", display: "~/w" }] } },
      }),
    );
    const devices = rows.filter((row) => row.type === "device") as Array<Extract<IndexRow, { type: "device" }>>;
    expect(devices.map((row) => row.device)).toEqual(["zeta", "alpha"]);
  });
});

describe("the lazy file layer", () => {
  const workspace = {
    id: "ws_0123456789abcdef01234567",
    label: "proj",
    display: "~/proj",
    directoryKey: "dk1_root",
  };
  const root = { ref: "ref_root", label: "proj", sourceLabel: "laptop", directoryKey: "dk1_root" };
  const joined = (over: Partial<DirectoryIndexInput> = {}) =>
    base({
      workspacesByDevice: { laptop: { device: "laptop", workspaces: [workspace] } },
      roots: { roots: [root], truncated: false },
      ...over,
    });

  it("contributes nothing while the row is closed — nothing is listed by walking the tree", () => {
    const rows = directoryIndexRows(joined());
    expect(types(rows)).toEqual(["device", "workspace"]);
  });

  it("shows the listing's own loading state, then its entries, from the cache alone", () => {
    const open = { "ws:laptop:ws_0123456789abcdef01234567": true };
    const loading = directoryIndexRows(
      joined({
        expanded: open,
        cache: new Map([["ref_root", { status: "loading", value: null, message: "", code: "" } as DirectoryState]]),
      }),
    );
    expect(types(loading)).toEqual(["device", "workspace", "files-note"]);

    const listed = directoryIndexRows(
      joined({
        expanded: open,
        cache: new Map([
          [
            "ref_root",
            ready({
              ref: "ref_root",
              label: "proj",
              entries: [
                { ref: "ref_docs", label: "docs", kind: "directory" },
                { ref: "ref_readme", label: "readme.md", kind: "file", sizeBytes: 12 },
                { label: "link", kind: "other" },
              ],
            }),
          ],
        ]),
      }),
    );
    const files = listed.filter((row) => row.type === "files") as Array<Extract<IndexRow, { type: "files" }>>;
    expect(files.map((row) => `${row.row.kind}:${row.row.label}`)).toEqual([
      "directory:docs",
      "file:readme.md",
      "other:link",
    ]);
    // A collapsed subdirectory contributes one row; its children were never
    // listed and are not shown.
    expect(files.every((row) => row.depth >= 1)).toBe(true);
  });

  it("renders a per-directory refusal inside the layer, not as a dead tree", () => {
    const rows = directoryIndexRows(
      joined({
        expanded: { "ws:laptop:ws_0123456789abcdef01234567": true },
        cache: new Map([
          ["ref_root", { status: "refused", value: null, message: "要先批准", code: "approval_required" } as DirectoryState],
        ]),
      }),
    );
    const note = rows.find((row) => row.type === "files-note") as Extract<IndexRow, { type: "files-note" }>;
    expect(note.refusal).toBe("要先批准");
  });

  it("descends one level per cached listing under expanded refs only", () => {
    const rows = directoryIndexRows(
      joined({
        expanded: { "ws:laptop:ws_0123456789abcdef01234567": true },
        expandedDirs: new Set(["ref_docs"]),
        cache: new Map([
          [
            "ref_root",
            ready({
              ref: "ref_root",
              label: "proj",
              entries: [{ ref: "ref_docs", label: "docs", kind: "directory" }],
            }),
          ],
          [
            "ref_docs",
            ready({
              ref: "ref_docs",
              label: "docs",
              entries: [{ ref: "ref_notes", label: "notes.md", kind: "file" }],
            }),
          ],
        ]),
      }),
    );
    const files = rows.filter((row) => row.type === "files") as Array<Extract<IndexRow, { type: "files" }>>;
    expect(files.map((row) => `${row.depth}:${row.row.label}`)).toEqual(["1:docs", "2:notes.md"]);
  });
});

describe("the files knob", () => {
  const laptopWorkspace = {
    id: "ws_0123456789abcdef01234567",
    label: "proj",
    display: "~/proj",
    directoryKey: "dk1_root",
  };
  const filesRoot = { ref: "ref_root", label: "proj", sourceLabel: "laptop", directoryKey: "dk1_root" };
  const withFiles = (over: Partial<DirectoryIndexInput> = {}) =>
    base({
      sessions: [session({ id: "a", cwd: "~/proj", directoryKey: "dk1_root" })],
      workspacesByDevice: {
        laptop: {
          device: "laptop",
          workspaces: [laptopWorkspace, { id: "ws_0123456789abcdef01234568", label: "other", display: "~/other" }],
        },
      },
      roots: {
        roots: [filesRoot, { ref: "ref_loose", label: "loose", sourceLabel: "laptop" }],
        truncated: false,
      },
      ...over,
    });

  it("off: a SESSION index — no file layer, no workspace-only rows, no loose roots", () => {
    const rows = directoryIndexRows(withFiles({ showFiles: false, expanded: { "dev:laptop": true } }));
    expect(types(rows)).toEqual(["device", "directory"]);
    const dir = rows[1] as Extract<IndexRow, { type: "directory" }>;
    // Nothing to expand into, and no "关联不可用" note about a layer the
    // reader just said they did not want.
    expect(dir.rootRef).toBeNull();
    expect(dir.filesNote).toBe("");
  });

  it("on: the same input keeps every file-plane row", () => {
    const rows = directoryIndexRows(withFiles({ showFiles: true }));
    expect(types(rows)).toEqual(["device", "directory", "workspace", "loose-root"]);
    expect((rows[1] as Extract<IndexRow, { type: "directory" }>).rootRef).toBe("ref_root");
  });

  it("defaults to on, so a caller that never heard of the knob is unchanged", () => {
    expect(types(directoryIndexRows(withFiles()))).toEqual(types(directoryIndexRows(withFiles({ showFiles: true }))));
  });
});

describe("the idle fold", () => {
  const day = 24 * 60 * 60 * 1000;
  const at = (msAgo: number) => new Date(Date.parse("2026-08-01T00:00:00.000Z") - msAgo).toISOString();
  // Three siblings under one `~` node: the shape a real device has, and the
  // reason the fold is per LEVEL rather than per device.
  const OPEN_HOME = { "dev:laptop/~": true };
  const mixed = (over: Partial<DirectoryIndexInput> = {}) =>
    base({
      sessions: [
        session({ id: "fresh", cwd: "~/now", lastActivity: at(0) }),
        session({ id: "old", cwd: "~/deleted-worktree", lastActivity: at(90 * day) }),
        session({ id: "undated", cwd: "~/undated" }),
      ],
      expanded: OPEN_HOME,
      ...over,
    });
  const dirsOf = (rows: IndexRow[]) =>
    (rows.filter((row) => row.type === "directory") as Array<Extract<IndexRow, { type: "directory" }>>)
      .map((row) => row.disp)
      .sort();

  it("folds a branch far older than the freshest one, and says how many", () => {
    const rows = directoryIndexRows(mixed());
    // `~/deleted-worktree` is folded; `~/undated` is not — "we could not date
    // this" is not evidence of staleness.
    expect(dirsOf(rows)).toEqual(["now", "undated", "~"]);
    const note = rows.find((row) => row.type === "idle-note") as Extract<IndexRow, { type: "idle-note" }>;
    expect(note).toMatchObject({ key: "idle:dev:laptop/~", device: "laptop", hidden: 1, open: false, depth: 1 });
  });

  it("reveals them when its own row is expanded", () => {
    const rows = directoryIndexRows(mixed({ expanded: { ...OPEN_HOME, "idle:dev:laptop/~": true } }));
    expect(dirsOf(rows)).toEqual(["deleted-worktree", "now", "undated", "~"]);
    // The reveal stays on screen so the fold can be re-applied.
    expect((rows.find((row) => row.type === "idle-note") as { open: boolean }).open).toBe(true);
  });

  it("measures against the newest row, not a clock: an index that is entirely old folds nothing", () => {
    const rows = directoryIndexRows(
      base({
        sessions: [
          session({ id: "a", cwd: "~/one", lastActivity: at(400 * day) }),
          session({ id: "b", cwd: "~/two", lastActivity: at(401 * day) }),
        ],
        expanded: OPEN_HOME,
      }),
    );
    expect(rows.some((row) => row.type === "idle-note")).toBe(false);
    expect(dirsOf(rows)).toEqual(["one", "two", "~"]);
  });
});
