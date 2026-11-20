/**
 * `list_recent_sessions` walks a roster of any size: the recent page stays a
 * bounded window and `next_cursor` continues through every session, across
 * devices, in the stable `[source, id]` order every source already pages by.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionListCursor } from "@claude-bot/agent-sessions-contract";
import { Store } from "../store/store.js";
import { RunnerCapabilities } from "../runner/capability.js";
import type { RunnerTransport } from "../runner/gateway.js";
import { PermissionService } from "../permissions/service.js";
import { SessionHubService } from "../sessionhub/service.js";
import { McpSurface } from "./service.js";
import { mcpSubjectEntry } from "./catalog.js";
import { SESSION_TOOLS } from "./tools.js";

const NOW = Date.parse("2026-10-20T08:00:00.000Z");
const alice = { owner: "alice", credential: "mcp:a1" };

interface Row { source: string; id: string; device: string; last_activity: string }

/** Session #n (1-based), on one of two devices; #77 also exists on the second device. */
function roster(count: number): Row[] {
  const rows = Array.from({ length: count }, (_, index): Row => ({
    source: index % 3 === 0 ? "claude" : "codex",
    id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
    device: index < 400 ? "laptop" : "observer",
    last_activity: new Date(NOW - index * 60_000).toISOString(),
  }));
  rows.push({ ...rows[76]!, device: "observer" });
  return rows;
}

/** The Gateway's list semantics: one shared cursor for every device, `has_more`, no device skipped. */
function gatewayList(rows: readonly Row[], args: Record<string, unknown>, fail: () => boolean): unknown {
  if (fail()) throw new Error("observer timed out");
  const limit = Number(args.limit ?? 20);
  const devices = ["laptop", "observer"];
  if (typeof args.cursor !== "string") {
    const recent = [...rows].sort((a, b) => b.last_activity.localeCompare(a.last_activity));
    return { devices, total_found: rows.length, returned: Math.min(limit, rows.length), sessions: recent.slice(0, limit) };
  }
  const after = rows.filter((row) => sessionListCursor(row) > String(args.cursor))
    .sort((a, b) => sessionListCursor(a) < sessionListCursor(b) ? -1 : sessionListCursor(a) > sessionListCursor(b) ? 1 : 0);
  return { devices, total_found: rows.length, has_more: after.length > limit, history_supported: true,
    returned: Math.min(limit, after.length), sessions: after.slice(0, limit) };
}

describe("list_recent_sessions cursor", () => {
  let dir: string;
  let store: Store;
  let surface: McpSurface;
  let rows: Row[];
  let failing = false;
  const cursors: unknown[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-list-cursor-"));
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 6001, home_dir: "/x/a", created_at: new Date(NOW).toISOString() });
    rows = roster(650);
    failing = false;
    cursors.length = 0;
    const transport = {
      dispatch: async (_owner: string, method: string, args: Record<string, unknown>) => {
        if (method !== "list_recent_sessions") throw new Error(`unexpected ${method}`);
        cursors.push(args.cursor);
        return gatewayList(rows, args, () => failing);
      },
      listDevices: () => ["laptop", "observer"].map((device) => ({ device, online: true, created_at: "", last_seen_at: "" })),
      isOnline: () => true,
      ping: async () => 1,
      disconnect: () => true,
    } as unknown as RunnerTransport;
    const caps = new RunnerCapabilities(store, transport);
    caps.mintDeviceToken("alice", "laptop");
    caps.mintDeviceToken("alice", "observer");
    const permissions = new PermissionService({ store, caps, now: () => NOW, subjects: [mcpSubjectEntry({ workspaceComposed: () => false, crdtComposed: () => false })] });
    const hub = new SessionHubService({ store, permissions, caps, now: () => NOW });
    surface = new McpSurface({ hub, permissions });
  });

  afterEach(() => {
    surface.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  type Page = { sessions: Array<{ session_id: string; device: string }>; next_cursor?: string };
  const list = async (args: Record<string, unknown>): Promise<Page> => {
    const out = await surface.callTool(alice, "list_recent_sessions", args);
    if (!out.ok) throw new Error(`refused: ${JSON.stringify(out)}`);
    return out.result as Page;
  };

  it("declares cursor in the tool schema and says what next_cursor means", () => {
    const spec = SESSION_TOOLS.find((tool) => tool.name === "list_recent_sessions")!;
    expect(spec.fields.cursor).toMatchObject({ type: "string", maxLength: 1024 });
    expect(spec.description).toContain("next_cursor");
    expect(spec.description).toContain("没有 next_cursor 就表示列表已完整");
    const listed = surface.listTools("alice").find((tool) => tool.name === "list_recent_sessions") as unknown as {
      inputSchema: { properties: Record<string, unknown> };
    };
    expect(listed.inputSchema.properties).toHaveProperty("cursor");
  });

  it("walks past the recent window to session #600 and every other session, across devices, once each", async () => {
    const first = await list({ limit: 100 });
    expect(first.sessions).toHaveLength(100);
    expect(cursors).toEqual([undefined]);
    expect(first.next_cursor).toBeTruthy();

    const seen: string[] = [];
    let cursor = first.next_cursor;
    let pages = 0;
    while (cursor) {
      const page = await list({ limit: 100, cursor });
      expect(page.sessions.length).toBeLessThanOrEqual(100);
      seen.push(...page.sessions.map((row) => `${row.device}/${row.session_id}`));
      cursor = page.next_cursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    }
    const expected = rows.map((row) => `${row.device}/${row.id}`).sort();
    expect(seen).toContain(`observer/${rows[599]!.id}`);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(expected);
    // Both copies of #77 survive any page boundary that splits them.
    expect(seen.filter((key) => key.endsWith(rows[76]!.id))).toHaveLength(2);
  });

  it("a recent page that holds every session has no next_cursor", async () => {
    rows = roster(30);
    const page = await list({ limit: 50 });
    expect(page.sessions).toHaveLength(31);
    expect(page).not.toHaveProperty("next_cursor");
  });

  it("refuses a page with a failed source instead of advancing past its rows", async () => {
    const first = await list({ limit: 100 });
    failing = true;
    const out = await surface.callTool(alice, "list_recent_sessions", { limit: 100, cursor: first.next_cursor });
    expect(out).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(out)).toContain("未推进翻页位置");
  });
});
