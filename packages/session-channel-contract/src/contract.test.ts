import { describe, expect, it } from "vitest";
import { mcpToolsOf, wireServiceableActions } from "@claude-bot/typed-port-kit";
import {
  SESSION_ACTIVITY_TYPES,
  SESSION_CHANNEL_CONTRACT,
  SESSION_CHANNEL_DECLARATION,
  SESSION_CHANNEL_OPERATIONS,
  readSessionActivityBatch,
} from "./index.js";

describe("session-channel/v1 declaration", () => {
  it("is one typed source for four operations and is wire serviceable", () => {
    expect(SESSION_CHANNEL_DECLARATION.contract).toBe(SESSION_CHANNEL_CONTRACT);
    expect(SESSION_CHANNEL_DECLARATION.actionIds).toEqual(["open_session", "send", "stop", "read_activity"]);
    expect(SESSION_CHANNEL_OPERATIONS).toEqual([
      "open_session_channel",
      "read_session_activity",
      "send_session_message",
      "stop_session_channel",
    ]);
    expect(wireServiceableActions(SESSION_CHANNEL_DECLARATION)).toEqual(SESSION_CHANNEL_DECLARATION.actionIds);
  });

  it("derives a bounded MCP face without identity or routing fields", () => {
    const encoded = JSON.stringify(mcpToolsOf(SESSION_CHANNEL_DECLARATION));
    expect(encoded).not.toMatch(/owner|username|open.?id|chat.?id|tenant|device|endpoint|path|credential|token/i);
    expect(encoded).toContain("client_message_id");
  });
});

describe("activity projection", () => {
  const good = {
    sessionRef: "sch_abc",
    afterCursor: 0,
    nextCursor: 2,
    events: [
      { sessionRef: "sch_abc", seq: 1, timestamp: "2026-08-15T00:00:00.000Z", type: "queued" },
      { sessionRef: "sch_abc", seq: 2, timestamp: "2026-08-15T00:00:01.000Z", type: "result", text: "done" },
    ],
  };

  it("accepts the closed, cursor-ordered projection", () => {
    expect(readSessionActivityBatch(good)).toEqual({ ok: true, value: good });
    expect(SESSION_ACTIVITY_TYPES).toContain("needs_local_action");
  });

  it("rejects raw harness data, routing fields and cursor rollback", () => {
    expect(readSessionActivityBatch({ ...good, nextCursor: 0 }).ok).toBe(false);
    expect(readSessionActivityBatch({ ...good, events: [{ ...good.events[0], rawArgs: { cwd: "/secret" } }] }).ok).toBe(false);
    expect(readSessionActivityBatch({ ...good, events: [{ ...good.events[0], sessionRef: "sch_other" }] }).ok).toBe(false);
  });
});
