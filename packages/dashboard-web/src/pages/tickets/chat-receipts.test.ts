import { describe, expect, it } from "vitest";
import { inboxFrame, messageReceipt, ticketChatReceipts, type TicketMessage, type TicketSendEcho } from "./chat-receipts.js";
import type { TicketWindow } from "../../lib/ticket-session.js";

const at = (second: number) => `2026-09-16T06:00:${String(second).padStart(2, "0")}Z`;
const row = (id: number, body = "继续", extra: Partial<TicketMessage> = {}): TicketMessage => ({
  id, body, author: "lht", via: "web", created_at: at(id), delivered_turn: null, ...extra,
});
const log = (texts: string[], offset = 0): TicketWindow => ({
  offset, total: offset + texts.length,
  messages: texts.map((text, index) => ({ role: "user", timestamp: at(index + 10), blocks: [{ type: "text", text }] })),
});
const echo = (extra: Partial<TicketSendEcho> = {}): TicketSendEcho => ({
  key: 1, ticketId: 603, prompt: "继续", created_at: at(1), phase: "submitted", after: 0, ...extra,
});

describe("ticket input reconciliation", () => {
  it.each(["provider_accepted", "input_observed"])("settles %s before a lagging delivered_turn marker", (phase) => {
    expect(messageReceipt(row(1, "继续", { delivery_state: "sending", delivery_input: JSON.stringify({ phase }) })).phase).toBe("done");
  });
  it.each(["local_queued", "dispatched"])("keeps %s waiting", (phase) => {
    expect(messageReceipt(row(1, "继续", { delivered_turn: 2, delivery_input: JSON.stringify({ phase }) })).phase).toBe("running");
  });
  it("handles legacy, malformed, failed and uncertain receipts", () => {
    expect(messageReceipt(row(1, "a", { delivered_turn: 2, delivery_input: "null" })).phase).toBe("done");
    expect(messageReceipt(row(1, "a", { delivery_input: "{" })).phase).toBe("submitted");
    expect(messageReceipt(row(1, "a", { delivery_state: "failed" })).phase).toBe("failed");
    expect(messageReceipt(row(1, "a", { delivery_state: "unknown" })).phase).toBe("uncertain");
  });
  it("keeps the queue ordered by server id, joins its echo, and ignores pipeline copies", () => {
    const result = ticketChatReceipts([row(2, "b"), row(1, "a"), row(3, "notice", { author: "agent" })], [echo({ messageId: 1, prompt: "a" })], log([]));
    expect(result.rows.map((entry) => entry.receipt.prompt)).toEqual(["a", "b"]);
    expect(result.rows[0]?.key).toBe("echo:1");
  });
  it("does not confuse old equal text, a substring, or an assistant quotation with a new send", () => {
    const win = log(["继续", "继续更多"]);
    win.messages[0]!.timestamp = at(0);
    win.messages.push({ role: "assistant", text: "继续", timestamp: at(20) });
    expect(ticketChatReceipts([row(1)], [], win).rows).toHaveLength(1);
    expect(ticketChatReceipts([row(1)], [echo({ messageId: 1, after: 3 })], log(["继续"])).rows).toHaveLength(1);
  });
  it("retires two batched inputs only when their complete framed bodies appear", () => {
    const result = ticketChatReceipts([row(1, "a\nparagraph"), row(2, "b")], [], log(["工单对话有新消息:\n[lht via web]: a\nparagraph\n[lht via web]: b\n请继续。"]));
    expect(result.rows).toEqual([]);
  });
  it("labels a person-named row that the person did not type and retires it by the bot's frame", () => {
    const scripted = row(1, "a", { actor_kind: "token" });
    expect(messageReceipt(scripted).author).toBe("lht via web · 脚本/令牌提交");
    expect(messageReceipt(row(1, "a", { actor_kind: "mcp" })).author).toBe("lht via web · 由 agent 代写");
    expect(messageReceipt(row(1, "a", { actor_kind: "system", via: "gitlab-ci" })).author).toBe("lht via gitlab-ci · 系统生成");
    // Typed in the browser, or written before the kind was recorded: no label.
    expect(messageReceipt(row(1, "a", { actor_kind: "browser" })).author).toBe("lht via web");
    expect(messageReceipt(row(1, "a", { actor_kind: null })).author).toBe("lht via web");
    expect(messageReceipt(row(1, "a")).author).toBe("lht via web");
    // Same frame as packages/bot/src/devpipe/prompts.ts#inboxAuthorFrame.
    expect(inboxFrame(scripted)).toBe("[lht via web, actor_kind=token]");
    expect(inboxFrame(row(1, "a", { actor_kind: "browser" }))).toBe("[lht via web]");
    expect(ticketChatReceipts([scripted, row(2, "b")], [], log(["工单对话有新消息:\n[lht via web, actor_kind=token]: a\n[lht via web]: b\n请继续。"])).rows).toEqual([]);
    expect(ticketChatReceipts([scripted], [], log(["[lht via web]: a"])).rows).toHaveLength(1);
  });
  it("requires separate occurrences for identical sends and respects time after refresh", () => {
    expect(ticketChatReceipts([row(1), row(20)], [], log(["继续"])).rows.map((entry) => entry.key)).toEqual(["message:20"]);
    expect(ticketChatReceipts([row(1), row(2)], [], log(["继续"])).rows).toHaveLength(1);
    expect(ticketChatReceipts([row(1), row(2)], [], log(["继续", "继续"])).rows).toHaveLength(0);
    expect(ticketChatReceipts([row(1), row(2)], [], log(["[lht via web]: 继续\n[lht via web]: 继续"])).rows).toHaveLength(0);
  });
  it("shows accepted input during log delay, then retires its echo without mutating the window", () => {
    const accepted = row(1, "继续", { delivered_turn: 2 });
    const pending = echo({ messageId: 1 });
    expect(ticketChatReceipts([accepted], [pending], log([])).rows[0]?.receipt.phase).toBe("done");
    const win = log(["继续"]);
    const before = JSON.stringify(win);
    expect(ticketChatReceipts([accepted], [pending], win)).toEqual({ rows: [], observedEchoes: [1] });
    expect(JSON.stringify(win)).toBe(before);
  });
  it("accepts a log frame before the delivery poll and retains stronger HTTP evidence than a stale row", () => {
    expect(ticketChatReceipts([row(1)], [echo({ messageId: 1 })], log(["继续"])).rows).toEqual([]);
    expect(ticketChatReceipts([row(1)], [echo({ messageId: 1, phase: "done" })], log([])).rows[0]?.receipt.phase).toBe("done");
  });
  it("correlates the HTTP receipt before detail polling catches up", () => {
    const accepted = row(1, "继续", { delivered_turn: 2 });
    expect(ticketChatReceipts([], [echo({ messageId: 1, source: accepted })], log(["[lht via web]: 继续"]))).toEqual({ rows: [], observedEchoes: [1] });
  });
  it("keeps unknown sends visible and avoids recreating old accepted history after paging", () => {
    expect(ticketChatReceipts([], [echo({ phase: "uncertain" })], log(["继续"])).rows).toHaveLength(1);
    expect(ticketChatReceipts([row(1, "old", { delivered_turn: 2 }), row(2, "queued")], [], log(["later"], 200)).rows.map((entry) => entry.receipt.prompt)).toEqual(["queued"]);
  });
});
