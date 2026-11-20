/**
 * The flattening rule, as a pure function.
 *
 * These are the cases a component would get subtly wrong and still render: a
 * collapsed directory quietly showing its children, an `other` entry acquiring a
 * key that collides with a real ref, a directory whose listing has not arrived
 * being indistinguishable from an empty one.
 */

import { describe, expect, it } from "vitest";
import { displaySize, visibleRows, type DirectoryCache } from "./tree.js";
import type { WorkspaceFilesRoots } from "@claude-bot/workspace-files-contract";

const roots: WorkspaceFilesRoots = {
  roots: [
    { ref: "r1", label: "octopus", sourceLabel: "laptop" },
    { ref: "r2", label: "notes", sourceLabel: "desktop" },
  ],
  truncated: false,
};

const KEY_ROOT = "dk1_aaaaaaaaaaaaaaaa";
const KEY_SRC = "dk1_bbbbbbbbbbbbbbbb";

const cache: DirectoryCache = new Map([
  ["r1", {
    status: "ready",
    message: "",
    code: "",
    value: {
      ref: "r1",
      label: "octopus",
      truncated: false,
      entries: [
        {
          ref: "f1",
          label: "zebra.md",
          kind: "file",
          sizeBytes: 4,
          modifiedAt: "2026-08-13T12:34:56.000Z",
        },
        { label: "sock", kind: "other" },
        { ref: "d1", label: "src", kind: "directory" },
        { ref: "f2", label: "alpha.md", kind: "file" },
      ],
    },
  }],
  ["d1", {
    status: "ready",
    message: "",
    code: "",
    value: { ref: "d1", label: "src", truncated: true, entries: [{ ref: "f3", label: "index.ts", kind: "file" }] },
  }],
]);

describe("visibleRows", () => {
  it("shows only roots when nothing is expanded", () => {
    const rows = visibleRows(roots, cache, new Set());
    expect(rows.map((row) => row.label)).toEqual(["octopus", "notes"]);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
    expect(rows[0]!.sourceLabel).toBe("laptop");
  });

  it("groups an expanded directory's children by kind, then by name", () => {
    const rows = visibleRows(roots, cache, new Set(["r1"]));
    // Directories, then files, then the unaddressable rest. Names compared by
    // code unit, not by locale — two screenshots of one directory must agree.
    expect(rows.map((row) => row.label)).toEqual(["octopus", "src", "alpha.md", "zebra.md", "sock", "notes"]);
    expect(rows.filter((row) => row.label === "src")[0]!.depth).toBe(1);
    expect(rows.find((row) => row.label === "alpha.md")!.listedLocation)
      .toEqual({
        rootRef: "r1",
        labels: ["alpha.md"],
        annotationRoot: "display:laptop:octopus",
      });
  });

  it("gives an `other` entry no ref and a key that cannot collide with one", () => {
    const rows = visibleRows(roots, cache, new Set(["r1"]));
    const other = rows.find((row) => row.label === "sock")!;
    expect(other.kind).toBe("other");
    expect(other.ref).toBeNull();
    // Keyed by parent and position, with a NUL separator. An opaque ref is
    // "bounded printable", so no ref can ever spell this key — which is what
    // makes a synthetic key and a real one impossible to confuse.
    expect(other.key).toContain("\u0000");
    expect(other.key.startsWith("r1\u0000")).toBe(true);
    expect(rows.filter((row) => row.key === other.key)).toHaveLength(1);
  });

  it("nests only through directories that are BOTH expanded and listed", () => {
    // Expanded but the listing has not arrived: the row says loading, and its
    // children are not invented.
    const loading: DirectoryCache = new Map(cache).set("d1", { status: "loading", value: null, message: "", code: "" });
    const rows = visibleRows(roots, loading, new Set(["r1", "d1"]));
    expect(rows.map((row) => row.label)).not.toContain("index.ts");
    expect(rows.find((row) => row.label === "src")!.loading).toBe(true);

    // Listed but collapsed: still no children.
    const collapsed = visibleRows(roots, cache, new Set(["r1"]));
    expect(collapsed.map((row) => row.label)).not.toContain("index.ts");

    // Both: the children appear, one level deeper, and the cap is reported.
    const open = visibleRows(roots, cache, new Set(["r1", "d1"]));
    expect(open.find((row) => row.label === "index.ts")!.depth).toBe(2);
    expect(open.find((row) => row.label === "index.ts")!.listedLocation)
      .toEqual({
        rootRef: "r1",
        labels: ["src", "index.ts"],
        annotationRoot: "display:laptop:octopus",
      });
    expect(open.find((row) => row.label === "src")!.truncated).toBe(true);
    // The continuation is its own row, after the directory's last child.
    const more = open.findIndex((row) => row.kind === "more");
    expect(open[more]).toMatchObject({ kind: "more", ref: null, moreOf: "d1", depth: 2 });
    expect(open[more - 1]!.label).toBe("index.ts");
  });

  it("puts the load-more row after the last child's own expanded descendants, with its page state", () => {
    const paged: DirectoryCache = new Map([
      ["r1", {
        status: "ready", message: "", code: "",
        value: { ref: "r1", label: "octopus", truncated: true, entries: [{ ref: "d9", label: "last", kind: "directory" }] },
        more: { status: "refused", message: "升级 Runner", code: "too_large" },
      }],
      ["d9", {
        status: "ready", message: "", code: "",
        value: { ref: "d9", label: "last", truncated: false, entries: [{ ref: "f9", label: "deep.md", kind: "file" }] },
      }],
    ]);
    const rows = visibleRows({ roots: [roots.roots[0]!], truncated: false }, paged, new Set(["r1", "d9"]));
    expect(rows.map((row) => row.kind === "more" ? `more:${row.moreOf}` : row.label))
      .toEqual(["octopus", "last", "deep.md", "more:r1"]);
    expect(rows.at(-1)!.refusal).toBe("升级 Runner");
  });

  it("carries a refused listing on the row that was refused", () => {
    const refused: DirectoryCache = new Map([
      ["r1", { status: "refused", value: null, message: "需要先批准", code: "approval_required" }],
    ]);
    const rows = visibleRows(roots, refused, new Set(["r1"]));
    expect(rows.find((row) => row.label === "octopus")!.refusal).toBe("需要先批准");
    // The sibling root is untouched: a refusal is one row's state.
    expect(rows.map((row) => row.label)).toContain("notes");
  });

  it("drops dot-prefixed entries only when asked, and never a registered root", () => {
    const dotted: DirectoryCache = new Map([["r1", {
      status: "ready",
      message: "",
      code: "",
      value: {
        ref: "r1",
        label: "octopus",
        truncated: false,
        entries: [
          { ref: "d2", label: ".git", kind: "directory" },
          { ref: "f4", label: ".env", kind: "file" },
          { ref: "d1", label: "src", kind: "directory" },
          { ref: "f2", label: "alpha.md", kind: "file" },
        ],
      },
    }]]);
    const shown = visibleRows({ roots: [{ ref: "r1", label: ".hidden-workspace", sourceLabel: "laptop" }], truncated: false }, dotted, new Set(["r1"]));
    expect(shown.map((row) => row.label)).toEqual([".hidden-workspace", ".git", "src", ".env", "alpha.md"]);

    const hidden = visibleRows(
      { roots: [{ ref: "r1", label: ".hidden-workspace", sourceLabel: "laptop" }], truncated: false },
      dotted,
      new Set(["r1"]),
      { hideDotEntries: true },
    );
    // The ROOT survives: registering that workspace was an explicit decision,
    // and a browsing filter does not get to overrule it.
    expect(hidden.map((row) => row.label)).toEqual([".hidden-workspace", "src", "alpha.md"]);
  });

  it("keeps an unaddressable entry's key stable when the dot filter flips", () => {
    const mixed: DirectoryCache = new Map([["r1", {
      status: "ready",
      message: "",
      code: "",
      value: {
        ref: "r1",
        label: "octopus",
        truncated: false,
        entries: [{ label: ".dotlink", kind: "other" }, { label: "sock", kind: "other" }],
      },
    }]]);
    const shown = visibleRows(roots, mixed, new Set(["r1"]));
    const hidden = visibleRows(roots, mixed, new Set(["r1"]), { hideDotEntries: true });
    const sock = (rows: readonly { label: string; key: string }[]) =>
      rows.find((row) => row.label === "sock")?.key;
    expect(sock(hidden)).toBe(sock(shown));
  });

  it("survives having no roots at all", () => {
    expect(visibleRows(null, new Map(), new Set())).toEqual([]);
    expect(visibleRows({ roots: [], truncated: true }, new Map(), new Set())).toEqual([]);
  });

  it("marks a file the contract already said is too big to open", () => {
    const big: DirectoryCache = new Map([
      ["r1", {
        status: "ready",
        message: "",
        code: "",
        value: {
          ref: "r1",
          label: "octopus",
          truncated: false,
          entries: [{ ref: "f9", label: "huge.log", kind: "file", sizeBytes: 9_000_000, exceedsTextLimit: true }],
        },
      }],
    ]);
    expect(visibleRows(roots, big, new Set(["r1"])).find((row) => row.label === "huge.log")!.exceedsTextLimit)
      .toBe(true);
  });

  it("retains trusted listing metadata for the compact row details", () => {
    const row = visibleRows(roots, cache, new Set(["r1"]))
      .find((candidate) => candidate.label === "zebra.md");
    expect(row).toMatchObject({
      sizeBytes: 4,
      modifiedAt: "2026-08-13T12:34:56.000Z",
    });
  });

  it("carries v2 directory equality keys without inventing them for files", () => {
    const keyedRoots = {
      roots: [{ ref: "r1", label: "octopus", sourceLabel: "laptop", directoryKey: KEY_ROOT }],
      truncated: false,
    };
    const keyedCache: DirectoryCache = new Map([
      ["r1", {
        status: "ready",
        message: "",
        code: "",
        value: {
          ref: "r1",
          label: "octopus",
          truncated: false,
          directoryKey: KEY_ROOT,
          entries: [
            { ref: "d1", label: "src", kind: "directory", directoryKey: KEY_SRC },
            { ref: "f1", label: "index.ts", kind: "file" },
          ],
        } as never,
      }],
    ]);
    const rows = visibleRows(keyedRoots, keyedCache, new Set(["r1"]));
    expect(rows.find((row) => row.ref === "r1")?.directoryKey).toBe(KEY_ROOT);
    expect(rows.find((row) => row.ref === "d1")?.directoryKey).toBe(KEY_SRC);
    expect(rows.find((row) => row.ref === "f1")?.directoryKey).toBeUndefined();
    expect(rows.find((row) => row.ref === "f1")?.listedLocation?.annotationRoot)
      .toBe("display:laptop:octopus");
  });

  it("omits annotation identity when two roots have the same visible coordinate", () => {
    const duplicated = {
      roots: [
        { ref: "r1", label: "octopus", sourceLabel: "laptop" },
        { ref: "r3", label: "octopus", sourceLabel: "laptop" },
      ],
      truncated: false,
    };
    expect(visibleRows(duplicated, new Map(), new Set()).map((row) => row.listedLocation))
      .toEqual([
        { rootRef: "r1", labels: [] },
        { rootRef: "r3", labels: [] },
      ]);
  });
});

describe("displaySize", () => {
  it("is display text and says nothing when there is nothing to say", () => {
    expect(displaySize(undefined)).toBe("");
    expect(displaySize(-1)).toBe("");
    expect(displaySize(Number.NaN)).toBe("");
    expect(displaySize(0)).toBe("0 B");
    expect(displaySize(1023)).toBe("1023 B");
    expect(displaySize(1024)).toBe("1.0 KB");
    expect(displaySize(1024 * 1024)).toBe("1.0 MB");
  });
});
