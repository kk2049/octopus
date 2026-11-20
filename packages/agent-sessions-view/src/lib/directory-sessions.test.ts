import { describe, expect, it } from "vitest";
import type { DirectoryCache, TreeRow } from "@claude-bot/agent-workspace-files-view";
import {
  createDirectorySessionsIndex,
  sessionsInDirectorySubtree,
  sessionsInDisplayDirectorySubtree,
  sessionsInNavigationDirectory,
} from "./directory-sessions.js";
import type { RosterSession } from "./roster.js";

const ROOT_KEY = "dk1_aaaaaaaaaaaaaaaa";
const CHILD_KEY = "dk1_bbbbbbbbbbbbbbbb";
const DEEP_KEY = "dk1_cccccccccccccccc";

function session(id: string, directoryKey?: string): RosterSession {
  return {
    resourceId: id,
    id,
    deviceId: "laptop",
    device: "laptop",
    cliKind: "codex",
    cwd: `~/${id}`,
    ...(directoryKey ? { directoryKey } : {}),
  };
}

const root: Pick<TreeRow, "ref" | "directoryKey"> = { ref: "root", directoryKey: ROOT_KEY };
const cache: DirectoryCache = new Map([
  ["root", {
    status: "ready",
    message: "",
    code: "",
    value: {
      ref: "root",
      label: "project",
      directoryKey: ROOT_KEY,
      truncated: false,
      entries: [{ ref: "child", label: "src", kind: "directory", directoryKey: CHILD_KEY }],
    },
  } as never],
  ["child", {
    status: "ready",
    message: "",
    code: "",
    value: {
      ref: "child",
      label: "src",
      directoryKey: CHILD_KEY,
      truncated: false,
      entries: [{ ref: "deep", label: "feature", kind: "directory", directoryKey: DEEP_KEY }],
    },
  } as never],
]);

describe("sessionsInDirectorySubtree", () => {
  it("orders exact-key matches by directory depth and keeps projection order within a directory", () => {
    const matches = sessionsInDirectorySubtree({
      directory: root,
      sessions: [session("deep", DEEP_KEY), session("root-a", ROOT_KEY), session("child", CHILD_KEY), session("root-b", ROOT_KEY)],
      cache,
    });
    expect(matches.map((row) => `${row.depth}:${row.session.resourceId}`)).toEqual([
      "0:root-a",
      "0:root-b",
      "1:child",
      "2:deep",
    ]);
  });

  it("does not guess from cwd labels when either projection omitted its key", () => {
    expect(sessionsInDirectorySubtree({
      directory: { ref: "root" },
      sessions: [session("project")],
      cache: new Map(),
    })).toEqual([]);
  });

  it("uses a listed child's key before that child is expanded", () => {
    const shallowCache: DirectoryCache = new Map([["root", cache.get("root")!]]);
    const matches = sessionsInDirectorySubtree({
      directory: root,
      sessions: [session("child", CHILD_KEY), session("deep", DEEP_KEY)],
      cache: shallowCache,
    });
    expect(matches.map((row) => row.session.resourceId)).toEqual(["child"]);
  });
});

describe("display-only home navigation grouping", () => {
  it("groups same-device home descendants without treating a redacted path as a location", () => {
    const rows = [
      { ...session("root"), cwd: "~/lht" },
      { ...session("deep"), cwd: "~/lht/octopus" },
      { ...session("other-device"), device: "desktop", cwd: "~/lht" },
      { ...session("redacted"), cwd: "~/…/lht" },
    ];
    expect(sessionsInDisplayDirectorySubtree(
      { device: "laptop", directory: "~/lht" },
      rows,
    ).map((row) => `${row.depth}:${row.session.resourceId}`)).toEqual(["0:root", "1:deep"]);
  });

  it("deduplicates a session found through both an opaque key and its display location", () => {
    const rootSession = { ...session("root", ROOT_KEY), cwd: "~/project" };
    const matches = sessionsInNavigationDirectory({
      directory: root,
      display: { device: "laptop", directory: "~/project" },
      sessions: [rootSession],
      cache,
    });
    expect(matches).toEqual([{ session: rootSession, depth: 0 }]);
  });
});


describe("shared navigation index", () => {
  it("preserves exact/display union, duplicate precedence, boundaries and depth order", () => {
    const rows = [
      { ...session("duplicate", DEEP_KEY), cwd: "~/project/deep" },
      { ...session("duplicate", ROOT_KEY), cwd: "~/project" },
      { ...session("root", ROOT_KEY), cwd: "~/project" },
      { ...session("other-device"), device: "desktop", cwd: "~/project" },
      { ...session("prefix"), cwd: "~/projects" },
      { ...session("redacted"), cwd: "~/…/project" },
      { ...session("parent-segment"), cwd: "~/project/../elsewhere" },
      { ...session("slashes"), cwd: "  ~\\project\\child/ " },
    ];
    const cyclic = new Map(cache);
    const child = cache.get("child")!;
    cyclic.set("child", { ...child, value: { ...child.value!, entries: [
      ...child.value!.entries, { ref: "root", kind: "directory", label: "cycle" },
    ] } });
    const index = createDirectorySessionsIndex(rows, cyclic);
    for (const directory of [root, { ref: "child" }, null]) {
      for (const display of [null, ...["~", "~/project", "~/project/child", "~/…", "~/project/.."]
        .map((directory) => ({ device: "laptop", directory }))]) {
        // Independent legacy scan helpers define the established semantics.
        const candidates = [
          ...(directory ? sessionsInDirectorySubtree({ directory, sessions: rows, cache: cyclic }) : []),
          ...(display ? sessionsInDisplayDirectorySubtree(display, rows) : []),
        ];
        const expected = new Map<string, (typeof candidates)[number]>();
        for (const candidate of candidates) {
          const previous = expected.get(candidate.session.resourceId);
          if (!previous || candidate.depth < previous.depth) expected.set(candidate.session.resourceId, candidate);
        }
        const order = new Map(rows.map((row, index) => [row.resourceId, index]));
        expect(index.matches({ directory, display })).toEqual([...expected.values()].sort((a, b) =>
          a.depth - b.depth || order.get(a.session.resourceId)! - order.get(b.session.resourceId)!));
      }
    }
    expect(index.matches({ display: { device: "desktop", directory: "~/project" } })
      .map((match) => match.session.resourceId)).toEqual(["other-device"]);
  });

  it("reads each cwd once for 300 directory queries and replaces stale generations", () => {
    let reads = 0;
    const rows = Array.from({ length: 500 }, (_, index) => ({
      ...session(`s${index}`, `k${index}`),
      get cwd() { reads += 1; return `~/d${index}`; },
    }));
    const index = createDirectorySessionsIndex(rows, new Map());
    for (let directory = 0; directory < 300; directory += 1) {
      const target = { display: { device: "laptop", directory: `~/d${directory}` } };
      const matches = index.matches(target);
      expect(matches.map((row) => row.session.resourceId)).toEqual([`s${directory}`]);
      expect(index.matches(target)).toBe(matches);
    }
    expect(reads).toBe(500);
    const shallow = new Map([["root", cache.get("root")!]]);
    const deep = session("deep", DEEP_KEY);
    expect(createDirectorySessionsIndex([deep], shallow).matches({ directory: root })).toEqual([]);
    expect(createDirectorySessionsIndex([deep], cache).matches({ directory: root })).toEqual([{ session: deep, depth: 2 }]);
    expect(createDirectorySessionsIndex([], cache).matches({ directory: root })).toEqual([]);
  });
});
