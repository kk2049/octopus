import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_LIST_START_CURSOR } from "@claude-bot/agent-sessions-contract";
import { withListCursor } from "./list-cursor.js";
import { __summaryCache, __summaryPending, listRecentSessions, resetRecentSessionIndexes } from "./scan.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "list-cursor-"));
  __summaryCache.clear();
  __summaryPending.clear();
});
afterEach(() => {
  resetRecentSessionIndexes();
  rmSync(home, { recursive: true, force: true });
});

function seedClaude(id: string): void {
  const proj = join(home, ".claude", "projects", "-home-u-proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${id}.jsonl`), [
    { sessionId: id, timestamp: "2026-07-15T08:00:00.000Z", cwd: "/home/u/proj", type: "user", message: { role: "user", content: `task ${id}` } },
  ].map((line) => JSON.stringify(line)).join("\n"));
}

type Page = { sessions: Array<{ id: string; source: string }>; next_cursor?: string; returned: number };

describe("list_recent_sessions complete walk", () => {
  it("reaches every one of 650 sessions through next_cursor, without duplicates", async () => {
    const ids = Array.from({ length: 650 }, (_, n) => `00000000-0000-0000-0000-${String(n + 1).padStart(12, "0")}`);
    for (const id of ids) seedClaude(id);
    const call = async (args: Record<string, unknown>): Promise<Page> =>
      withListCursor(await listRecentSessions(home, args), args) as Page;

    const first = await call({ limit: 100 });
    expect(first.sessions).toHaveLength(100);
    expect(first.next_cursor).toBe(SESSION_LIST_START_CURSOR);

    const walked: string[] = [];
    let cursor = first.next_cursor;
    for (let page = 0; cursor && page < 20; page += 1) {
      const next = await call({ limit: 100, cursor });
      expect(next.sessions.length).toBeLessThanOrEqual(100);
      walked.push(...next.sessions.map((row) => row.id));
      cursor = next.next_cursor;
    }
    expect(cursor).toBeUndefined();
    expect(walked).toContain(ids[599]);
    expect(new Set(walked).size).toBe(walked.length);
    expect([...walked].sort()).toEqual(ids);
  });

  it("a recent page that holds everything carries no next_cursor", async () => {
    for (const n of [1, 2, 3]) seedClaude(`00000000-0000-0000-0000-00000000000${n}`);
    const page = withListCursor(await listRecentSessions(home, { limit: 50 }), { limit: 50 }) as Page;
    expect(page.sessions).toHaveLength(3);
    expect(page).not.toHaveProperty("next_cursor");
  });

  it("does not skip a copy that a multi-device window cut off at the page boundary", () => {
    const row = (id: string, device: string) => ({ source: "codex", id, device });
    // Gateway output: two devices, limit 3, the second copy of `b` fell outside the window.
    const page = withListCursor({ has_more: true, history_supported: true,
      sessions: [row("a", "x"), row("b", "x"), row("b", "y")] }, { limit: 3, cursor: SESSION_LIST_START_CURSOR }) as Page;
    expect(page.sessions.map((r) => r.id)).toEqual(["a"]);
    expect(page.next_cursor).toBe(JSON.stringify(["codex", "a"]));
  });

  it("refuses to advance past a Runner that ignored the cursor", () => {
    expect(() => withListCursor({ sessions: [{ source: "codex", id: "a" }] }, { cursor: SESSION_LIST_START_CURSOR }))
      .toThrow(/尚不支持完整会话分页/);
    expect(() => withListCursor({ sessions: [], has_more: false, history_supported: false }, { cursor: "" }))
      .toThrow(/尚不支持完整会话分页/);
  });
});
