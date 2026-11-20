import { expect, it } from "vitest";
import { mergeSessionCatalogList } from "./session-catalog.js";

it("pages the ordinary and authorized split catalogs in one stable identity order", () => {
  const catalog = ["a", "c"].map((sessionId) => ({
    runtimeOwner: "alice", runtimeDevice: "laptop", source: "codex" as const, sessionId,
    catalogId: `spc_${"a".repeat(64)}`, executionDevice: "exec", workspaceId: "ws", workspaceLabel: "project", workspaceDisplay: "~/project",
  }));
  const row = (id: string) => ({ id, source: "codex", device: "laptop", last_activity: id === "a" ? "2020" : "2026" });
  const merge = (baseIds: string[], splitIds: string[], cursor: string) => mergeSessionCatalogList(
    { devices: ["laptop"], sessions: baseIds.map(row), total_found: 2, has_more: false },
    [{ device: "laptop", catalog, result: { sessions: [...splitIds, "unselected-relay"].map(row), has_more: false } }],
    { device: "laptop", cursor, limit: 2 },
  ) as { sessions: Array<{ id: string }>; has_more: boolean; history_supported: boolean };
  const first = merge(["b", "d"], ["a", "c"], "");
  expect(first.sessions.map((session) => session.id)).toEqual(["a", "b"]);
  expect(first.has_more).toBe(true);
  expect(first.history_supported).toBe(true);
  const second = merge(["d"], ["c"], '["codex","b"]');
  expect(second.sessions.map((session) => session.id)).toEqual(["c", "d"]);
  expect(second.has_more).toBe(false);
});
