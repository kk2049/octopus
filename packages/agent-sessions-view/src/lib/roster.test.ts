/** The roster rules: how a flat list becomes a tree and a "recent" strip. */

import { describe, expect, it } from "vitest";
import {
  buildDirTree,
  isResolvableDir,
  pathTo,
  sortRecentSessions,
  type RosterSession,
} from "./roster.js";

const NOW = Date.parse("2026-08-06T10:00:00.000Z");
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function session(patch: Partial<RosterSession> & { id: string }): RosterSession {
  return {
    device: "laptop",
    cwd: "~/projects/demo",
    ...patch,
    resourceId: patch.id,
  } as RosterSession;
}

describe("directory tree", () => {
  it("compresses a chain of empty single-child directories into one row", () => {
    const [group] = buildDirTree([session({ id: "a", cwd: "/home/me/work/deep/project" })]);
    expect(group.children).toHaveLength(1);
    expect(group.children[0].name).toBe("home/me/work/deep/project");
    // A top-level absolute path keeps its leading slash; `~` and `(未知目录)` do not.
    expect(group.children[0].disp).toBe("/home/me/work/deep/project");
  });

  it("stops compressing where a directory has sessions of its own", () => {
    const [group] = buildDirTree([
      session({ id: "a", cwd: "/w/x" }),
      session({ id: "b", cwd: "/w/x/y" }),
    ]);
    expect(group.children[0].name).toBe("w/x");
    expect(group.children[0].children.map((c) => c.name)).toEqual(["y"]);
  });

  it("counts a whole subtree, not just the node", () => {
    const [group] = buildDirTree([
      session({ id: "a", cwd: "~/p/one" }),
      session({ id: "b", cwd: "~/p/two" }),
      session({ id: "c", cwd: "~/p/two/inner" }),
    ]);
    expect(group.total).toBe(3);
    expect(group.children[0].count).toBe(3);
    expect(group.children[0].disp).toBe("~/p");
  });

  it("keeps devices apart and sorts them", () => {
    const groups = buildDirTree([
      session({ id: "a", device: "zeta" }),
      session({ id: "b", device: "alpha" }),
    ]);
    expect(groups.map((g) => g.device)).toEqual(["alpha", "zeta"]);
  });

  it("gives a session with no directory a labelled home rather than dropping it", () => {
    const [group] = buildDirTree([session({ id: "a", cwd: "" })]);
    expect(group.children[0].name).toBe("(未知目录)");
    expect(group.children[0].disp).toBe("(未知目录)");
  });

  it("normalises Windows separators so one machine is one tree", () => {
    const [group] = buildDirTree([session({ id: "a", cwd: "C:\\work\\repo" })]);
    expect(group.children[0].name).toBe("C:/work/repo");
    expect(group.children[0].disp).toBe("C:/work/repo");
  });

  it("names every ancestor key of a session so the tree can be opened to it", () => {
    const groups = buildDirTree([session({ id: "deep", cwd: "~/a/b" }), session({ id: "other", cwd: "~/a" })]);
    const keys = pathTo(groups, "deep");
    expect(keys).toContain("dev:laptop");
    expect(keys.some((key) => key.endsWith("/b"))).toBe(true);
  });
});

describe("recent strip", () => {
  it("ignores intermediate log writes and orders by user-start or completion", () => {
    const chatter = session({
      id: "chatter",
      sortActivity: iso(10 * 60_000),
      lastActivity: iso(1_000),
      activity: { state: "tool", tool: "Bash", since: iso(10 * 60_000), observed_at: iso(1_000) },
    });
    const completed = session({
      id: "completed",
      sortActivity: iso(5 * 60_000),
      lastActivity: iso(20 * 60_000),
    });
    expect(sortRecentSessions([chatter, completed], 5).map((s) => s.id))
      .toEqual(["completed", "chatter"]);
  });

  it("breaks stable-activity ties on the incoming order", () => {
    const a = session({ id: "a", sortActivity: iso(3_000) });
    const b = session({ id: "b", sortActivity: iso(2_000) });
    const c = session({ id: "c", sortActivity: iso(2_000) });
    expect(sortRecentSessions([a, b, c], 5).map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("puts favorites first while ordering each group by stable activity", () => {
    const recent = session({ id: "recent", sortActivity: iso(1_000) });
    const olderFavorite = session({ id: "older-favorite", sortActivity: iso(30 * 60_000) });
    const newerFavorite = session({ id: "newer-favorite", sortActivity: iso(5_000) });
    const older = session({ id: "older", sortActivity: iso(40 * 60_000) });
    expect(sortRecentSessions(
      [recent, olderFavorite, older, newerFavorite],
      5,
      ["older-favorite", "newer-favorite"],
    ).map((s) => s.id)).toEqual(["newer-favorite", "older-favorite", "recent", "older"]);
  });

  it("honours the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => session({ id: `s${i}`, sortActivity: iso(i * 1_000) }));
    expect(sortRecentSessions(many, 6)).toHaveLength(6);
  });

  it("keeps all live foreground tmux chats together in activity order before favorites", () => {
    const tmux = { process_state: "alive", turn_state: "idle", attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" } };
    const rows = [
      session({ id: "background", sortActivity: iso(1_000), runtime: { process_state: "alive", turn_state: "working" } }),
      session({ id: "favorite-tmux", sortActivity: iso(40_000), runtime: tmux }),
      session({ id: "idle-tmux", sortActivity: iso(30_000), runtime: tmux }),
      session({ id: "working-tmux", sortActivity: iso(20_000), runtime: { ...tmux, turn_state: "working" } }),
      session({ id: "favorite", sortActivity: iso(10_000) }),
    ];
    const expected = ["working-tmux", "idle-tmux", "favorite-tmux", "favorite", "background"];
    const sorted = sortRecentSessions(rows, 5, ["favorite-tmux", "favorite"]);
    expect(sorted.map((s) => s.id)).toEqual(expected);
    expect(sortRecentSessions(sorted, 3, ["favorite-tmux", "favorite"]).map((s) => s.id)).toEqual(expected.slice(0, 3));
  });

  it.each([
    { stale: true },
    { runtime: { process_state: "exited", attachment: { kind: "terminal_tmux", state: "detached", transport: "tmux" } } },
    { runtime: { process_state: "alive", attachment: { kind: "hook_observer", state: "observed" } } },
    { runtime: { process_state: "alive", attachment: { kind: "codex_app_server", state: "attached", transport: "app-server" } } },
    { runtime: { attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" } } },
  ])("does not promote a stale or unconfirmed foreground observation: %j", (patch) => {
    const older = session({ id: "older", sortActivity: iso(30_000),
      runtime: { process_state: "alive", attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" } }, ...patch });
    const newer = session({ id: "newer", sortActivity: iso(1_000) });
    expect(sortRecentSessions([older, newer], 5).map((s) => s.id)).toEqual(["newer", "older"]);
  });

  it("falls back to legacy lastActivity when the stable field is absent", () => {
    const stale = session({ id: "stale", lastActivity: iso(30 * 60_000) });
    const fresh = session({ id: "fresh", lastActivity: iso(5_000) });
    expect(sortRecentSessions([stale, fresh], 5).map((s) => s.id)).toEqual(["fresh", "stale"]);
  });
});

/**
 * The path a `＋` hands to the new-agent form.
 *
 * The tree already knows how it split and collapsed the segments, so it is also
 * what can rebuild them — re-deriving the path in the renderer would be a second
 * answer to the same question, and the two would disagree exactly on the rows
 * where compression happened.
 */
describe("resolvable directory of a tree row", () => {
  it("rebuilds the path a row stands for, including through compression", () => {
    const groups = buildDirTree([
      session({ id: "a", cwd: "~/work/deep/nested/project" }),
      session({ id: "b", cwd: "/srv/data" }),
    ]);
    const dirs: string[] = [];
    const walk = (node: { dir: string; children: readonly unknown[] }): void => {
      dirs.push(node.dir);
      for (const child of node.children) walk(child as { dir: string; children: readonly unknown[] });
    };
    for (const child of groups[0].children) walk(child);
    expect(dirs).toContain("~/work/deep/nested/project");
    expect(dirs).toContain("/srv/data");
  });

  it("offers no shortcut for the elided form, because that path was never disclosed", () => {
    // `~/…/name` is what a Runner shows for a cwd outside its scan root: a real
    // directory whose path this side was deliberately not told. A one-click
    // start there would be refused after the approval, which is the worst
    // possible moment to find out.
    expect(isResolvableDir("~/…/secret-project")).toBe(false);
    expect(isResolvableDir("(未知目录)")).toBe(false);
    expect(isResolvableDir("relative/path")).toBe(false);
    expect(isResolvableDir("")).toBe(false);
    expect(isResolvableDir("~")).toBe(true);
    expect(isResolvableDir("~/p")).toBe(true);
    expect(isResolvableDir("/srv/data")).toBe(true);
    // Windows sessions may still be displayed in one normalised tree, but the
    // current direct-launch protocol is POSIX-only and must not offer a shortcut
    // that the form and trusted Runner will refuse.
    expect(isResolvableDir("C:/work")).toBe(false);
  });
});
