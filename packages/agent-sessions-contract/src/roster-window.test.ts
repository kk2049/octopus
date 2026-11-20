import { describe, expect, it } from "vitest";
import {
  SESSION_AUTOMATED_WINDOW, SESSION_IDS_MAX, SESSION_LIST_START_CURSOR, decodeSessionIds, encodeSessionIds,
  isAutomatedSession, isForegroundTmuxSession, selectSessionWindow, sessionHistoryPage, sessionListCursor,
} from "./roster-window.js";

const runtime = { process_state: "alive", attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" } };

describe("foreground priority before roster truncation", () => {
  it("retains old tmux roots and children through repeated 500-row windows", () => {
    const rows = [
      ...Array.from({ length: 600 }, (_, id) => ({ id: `root-${id}`, parent: undefined as string | undefined })),
      ...Array.from({ length: 600 }, (_, id) => ({ id: `child-${id}`, parent: "root-0" })),
      { id: "old-terminal", parent: undefined, runtime },
      { id: "old-terminal-child", parent: "root-0", runtime },
    ];
    const selected = selectSessionWindow(rows, 500, (row) => row.parent);
    expect(selected).toHaveLength(500);
    expect(selected[0].id).toBe("old-terminal");
    expect(selected[200].id).toBe("old-terminal-child");
    expect(selected.filter((row) => !row.parent)).toHaveLength(200);
    expect(selected.filter((row) => row.parent)).toHaveLength(300);
    expect(selectSessionWindow(selected, 200, (row) => row.parent)).toEqual(selected);
    expect(selected.slice(1, 4).map((row) => row.id)).toEqual(["root-0", "root-1", "root-2"]);
  });

  it.each([
    { stale: true, runtime },
    { runtime: { ...runtime, process_state: "exited" } },
    { runtime: { ...runtime, attachment: { ...runtime.attachment, state: "detached" } } },
    { runtime: { ...runtime, attachment: { ...runtime.attachment, kind: "codex_app_server" } } },
    { runtime: { ...runtime, attachment: { ...runtime.attachment, transport: "exec" } } },
    {}, null,
  ])("does not prefer stale, exited or unproven terminals: %j", (row) => {
    expect(isForegroundTmuxSession(row)).toBe(false);
  });
});

describe("complete roster walk", () => {
  const position = (row: { source: string; id: string }) => sessionListCursor(row);

  it("starts before every real position and ends with no cursor", () => {
    for (const source of ["claude", "codex", "omp"]) expect(SESSION_LIST_START_CURSOR < sessionListCursor({ source, id: "" })).toBe(true);
    const rows = [{ source: "codex", id: "b" }, { source: "claude", id: "z" }];
    expect(sessionHistoryPage(rows, position, 5, false)).toEqual({ sessions: [rows[1], rows[0]] });
  });

  it("ends a full page before its last position group so a cut-off copy is not skipped", () => {
    const rows = [{ source: "codex", id: "a" }, { source: "codex", id: "b" }, { source: "codex", id: "b" }, { source: "codex", id: "c" }];
    const page = sessionHistoryPage(rows, position, 3, false);
    expect(page.sessions.map((row) => row.id)).toEqual(["a"]);
    expect(page.nextCursor).toBe(sessionListCursor({ source: "codex", id: "a" }));
  });

  it("always advances, even when a page is a single group", () => {
    const rows = [{ source: "codex", id: "a" }, { source: "codex", id: "a" }];
    expect(sessionHistoryPage(rows, position, 1, true)).toEqual({ sessions: [rows[0]], nextCursor: sessionListCursor(rows[0]!) });
  });
});

describe("independent budgets for automated runs and kept chats", () => {
  const exec = (id: string) => ({ id, parent: undefined as string | undefined, execution_mode: "exec" as const });
  const chat = (id: string) => ({ id, parent: undefined as string | undefined });

  it("never lets a burst of exec runs evict interactive chats", () => {
    const rows = [
      ...Array.from({ length: 1_000 }, (_, index) => exec(`run-${index}`)),
      ...Array.from({ length: 250 }, (_, index) => chat(`chat-${index}`)),
    ];
    const selected = selectSessionWindow(rows, 200, (row) => row.parent);
    expect(selected.filter((row) => row.id.startsWith("chat-"))).toHaveLength(200);
    expect(selected.filter((row) => row.id.startsWith("run-"))).toHaveLength(SESSION_AUTOMATED_WINDOW);
    // Primary rows still lead for a legacy bounded consumer.
    expect(selected[0].id).toBe("chat-0");
    expect(selected[200].id).toBe("run-0");
  });

  it("recognises both the device and the public field name", () => {
    expect(isAutomatedSession({ execution_mode: "exec" })).toBe(true);
    expect(isAutomatedSession({ executionMode: "exec" })).toBe(true);
    expect(isAutomatedSession({ executionMode: "interactive" })).toBe(false);
    expect(isAutomatedSession(null)).toBe(false);
  });

  it("selects kept rows outside every budget without displacing recent ones", () => {
    const rows = [
      ...Array.from({ length: 300 }, (_, index) => chat(`chat-${index}`)),
      chat("old-favorite"),
      exec("old-run-in-folder"),
    ];
    const kept = new Set(["old-favorite", "old-run-in-folder"]);
    const selected = selectSessionWindow(rows, 200, (row) => row.parent, undefined, { kept: (row) => kept.has(row.id) });
    expect(selected.map((row) => row.id)).toContain("old-favorite");
    expect(selected.map((row) => row.id)).toContain("old-run-in-folder");
    expect(selected.filter((row) => row.id.startsWith("chat-"))).toHaveLength(200);
  });

  it("encodes a bounded identity selector and decodes only well-formed pairs", () => {
    const encoded = encodeSessionIds([{ source: "codex", id: "01a1579e-e734" }, { source: "claude", id: "abc" }]);
    expect(encoded).toBe("codex:01a1579e-e734,claude:abc");
    expect(decodeSessionIds(`${encoded},bogus:1,codex:,codex:a b,codex:01a1579e-e734`)).toEqual([
      { source: "codex", id: "01a1579e-e734" },
      { source: "claude", id: "abc" },
    ]);
    expect(decodeSessionIds(Array.from({ length: 100 }, (_, index) => `omp:${index}`).join(","))).toHaveLength(SESSION_IDS_MAX);
    expect(decodeSessionIds(undefined)).toEqual([]);
  });
});
