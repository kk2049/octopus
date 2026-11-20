import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@claude-bot/agent-sessions-contract";
import { folderOfSession, navigatorSections, newFolderId, selectionRange } from "./navigator.js";
import type { RosterSession } from "./roster.js";

const at = (minutesAgo: number) => new Date(Date.parse("2026-10-22T13:00:00Z") - minutesAgo * 60_000).toISOString();
const tmux = { process_state: "alive", turn_state: "idle", attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" } };

function row(id: string, over: Partial<RosterSession> = {}): RosterSession {
  return {
    resourceId: id, id, sessionId: id, deviceId: "laptop", device: "laptop", cliKind: "codex",
    cwd: "~/project", cwdDisplay: "~/project", title: id, sortActivity: at(10), ...over,
  };
}

const ids = (rows: readonly { resourceId: string }[]) => rows.map((value) => value.resourceId);
const itemIds = (items: ReturnType<typeof navigatorSections>["favorites"]) =>
  items.map((item) => item.kind === "session" ? item.session.resourceId : `missing:${item.resourceId}`);

describe("navigator sections", () => {
  it("puts favorites first in pin order, above foreground terminals and activity", () => {
    const sections = navigatorSections({
      roster: [
        row("terminal", { runtime: tmux, sortActivity: at(500) }),
        row("fresh", { sortActivity: at(1) }),
        row("old-favorite", { sortActivity: at(9_000) }),
        row("new-favorite", { sortActivity: at(2) }),
      ],
      pinned: ["old-favorite", "new-favorite"],
      folders: [],
    });
    expect(itemIds(sections.favorites)).toEqual(["old-favorite", "new-favorite"]);
    // Within 最近 a confirmed tmux foreground still leads (existing rule).
    expect(ids(sections.recent)).toEqual(["terminal", "fresh"]);
  });

  it("files each chat once, keeps favorites visible inside their folder, and moves unnamed exec runs aside", () => {
    const sections = navigatorSections({
      roster: [
        row("chat"),
        row("filed"),
        row("filed-favorite"),
        row("run-1", { executionMode: "exec", sortActivity: at(1) }),
        row("run-named", { executionMode: "exec", userNamed: true }),
        row("run-pinned", { executionMode: "exec" }),
      ],
      pinned: ["filed-favorite", "run-pinned"],
      folders: [{ id: "f", name: "Project", sessions: ["filed", "filed-favorite"] }],
    });
    expect(itemIds(sections.favorites)).toEqual(["filed-favorite", "run-pinned"]);
    expect(itemIds(sections.folders[0]!.items).sort()).toEqual(["filed", "filed-favorite"]);
    expect(ids(sections.recent).sort()).toEqual(["chat", "run-named"]);
    expect(ids(sections.automated)).toEqual(["run-1"]);
    expect(folderOfSession([{ id: "f", name: "Project", sessions: ["filed"] }], "filed")?.id).toBe("f");
  });

  it("keeps children folded under their parent unless the person kept the child itself", () => {
    const sections = navigatorSections({
      roster: [
        row("parent"),
        row("child", { parentResourceId: "parent" }),
        row("kept-child", { parentResourceId: "parent" }),
        row("filed-child", { parentResourceId: "parent" }),
      ],
      pinned: ["kept-child"],
      folders: [{ id: "f", name: "F", sessions: ["filed-child"] }],
    });
    expect(ids(sections.recent)).toEqual(["parent"]);
    expect(ids(sections.families.children.get("parent") ?? [])).toEqual(["child"]);
    expect(itemIds(sections.favorites)).toEqual(["kept-child"]);
    expect(itemIds(sections.folders[0]!.items)).toEqual(["filed-child"]);
  });

  it("shows kept chats the frame does not carry instead of dropping them", () => {
    const cached = { resourceId: "cached", cliKind: "codex", title: "Found by search", cwdDisplay: "~/old" } as SessionSummary;
    const sections = navigatorSections({
      roster: [row("present")],
      pinned: ["offline", "cached"],
      folders: [{ id: "f", name: "F", sessions: ["gone"] }],
      customTitles: { offline: "微信备份" },
      cached: (id) => id === "cached" ? cached : null,
    });
    expect(sections.favorites).toEqual([
      { kind: "missing", resourceId: "offline", title: "微信备份" },
      { kind: "missing", resourceId: "cached", title: "Found by search", cached },
    ]);
    expect(sections.folders[0]!.items).toEqual([{ kind: "missing", resourceId: "gone", title: "" }]);
  });

  it("filters by what a row shows, keeps a parent whose child matches, and searches folder names", () => {
    const roster = [
      row("parent", { title: "Lead" }),
      row("child", { parentResourceId: "parent", title: "Venmo worker" }),
      row("other", { title: "Unrelated", deviceLabel: "aws-workbench" }),
      row("in-folder", { title: "Something" }),
    ];
    const folders = [{ id: "f", name: "微信", sessions: ["in-folder"] }];
    const byChild = navigatorSections({ roster, pinned: [], folders, filter: "venmo" });
    expect(ids(byChild.recent)).toEqual(["parent"]);
    expect(byChild.folders).toEqual([]);
    expect(ids(navigatorSections({ roster, pinned: [], folders, filter: "AWS" }).recent)).toEqual(["other"]);
    // The row shows a 48-character title; the filter still sees the whole preview.
    const long = row("long", { title: undefined, preview: `${"Reconcile the dinner-share note with incoming "}Venmo payments` });
    expect(ids(navigatorSections({ roster: [long], pinned: [], folders: [], filter: "venmo" }).recent)).toEqual(["long"]);
    const byFolder = navigatorSections({ roster, pinned: [], folders, filter: "微信" });
    expect(itemIds(byFolder.folders[0]!.items)).toEqual(["in-folder"]);
    expect(byFolder.recent).toEqual([]);
  });

  it("orders ids for shift ranges and counts live chats in a folder", () => {
    const sections = navigatorSections({
      roster: [row("a"), row("b", { runtime: { process_state: "alive", turn_state: "working", observed_at: new Date().toISOString() } }), row("c")],
      pinned: ["c"],
      folders: [{ id: "f", name: "F", sessions: ["b"] }],
      isLive: (session) => session.runtime?.turn_state === "working",
    });
    expect(sections.order).toEqual(["c", "b", "a"]);
    expect(sections.folders[0]!.live).toBe(1);
    expect(selectionRange(sections.order, "c", "a")).toEqual(["c", "b", "a"]);
    expect(selectionRange(sections.order, "a", "c")).toEqual(["c", "b", "a"]);
    expect(selectionRange(sections.order, null, "b")).toEqual(["b"]);
  });

  it("mints folder ids the App action accepts", () => {
    expect(newFolderId()).toMatch(/^f_[a-z0-9]{12}$/);
    expect(newFolderId(() => 0)).toBe("f_aaaaaaaaaaaa");
  });
});
