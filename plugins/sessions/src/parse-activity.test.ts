/**
 * Activity derivation ("what is this agent doing right now").
 *
 * The dashboard used to render a thinking or tool-blocked session exactly
 * like a finished one, because neither writes a log line while it waits.
 * These tests pin the four states against the shapes real logs actually use
 * (verified against live ~/.claude and ~/.codex files), and — just as
 * important — pin the DEGRADATION: an unrecognized shape must fall back, not
 * throw and not invent a state.
 *
 * Flat and rich parsers must agree: the session LIST uses the flat parser and
 * the transcript view uses the rich one, and a session that reads "running"
 * in one and "idle" in the other would be a visible lie.
 */
import { describe, it, expect } from "vitest";
import { parseSessionText, parseSessionRich } from "./parse.js";

const line = (obj: unknown): string => JSON.stringify(obj);

/** Both parsers must agree on activity; return the (identical) result. */
function activityOf(source: "claude" | "codex", text: string) {
  const flat = parseSessionText(source, text).meta.activity;
  const rich = parseSessionRich(source, text).meta.activity;
  expect(rich).toEqual(flat);
  return flat;
}

function lifecycleOf(source: "claude" | "codex", text: string) {
  const flat = parseSessionText(source, text).meta;
  const rich = parseSessionRich(source, text).meta;
  const lifecycle = {
    sort_activity: flat.sort_activity,
    completed_at: flat.completed_at,
  };
  expect({
    sort_activity: rich.sort_activity,
    completed_at: rich.completed_at,
  }).toEqual(lifecycle);
  return lifecycle;
}

// ── Claude ──

const cUser = (ts: string, text: string) =>
  line({ type: "user", timestamp: ts, message: { role: "user", content: text } });

const cAssistantText = (ts: string, text: string, stop = "end_turn") =>
  line({
    type: "assistant",
    timestamp: ts,
    message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text }] },
  });

const cToolCall = (ts: string, id: string, name: string) =>
  line({
    type: "assistant",
    timestamp: ts,
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id, name, input: { command: "ls" } }],
    },
  });

const cToolResult = (ts: string, id: string) =>
  line({
    type: "user",
    timestamp: ts,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  });

describe("claude activity", () => {
  it("is idle after an assistant turn closed with end_turn", () => {
    const text = [cUser("2026-07-25T10:00:00Z", "hi"), cAssistantText("2026-07-25T10:00:09Z", "done")].join("\n");
    expect(activityOf("claude", text)).toEqual({ state: "idle", since: "2026-07-25T10:00:09Z", observed_at: "2026-07-25T10:00:09Z" });
  });

  it("sorts only on a real prompt or terminal turn, not intermediate output", () => {
    const open = [
      cUser("2026-07-25T10:00:00Z", "hi"),
      cAssistantText("2026-07-25T10:00:04Z", "还在做", ""),
    ].join("\n");
    expect(lifecycleOf("claude", open)).toEqual({
      sort_activity: "2026-07-25T10:00:00Z",
      completed_at: undefined,
    });
    expect(lifecycleOf("claude", `${open}\n${cAssistantText("2026-07-25T10:00:09Z", "done")}`)).toEqual({
      sort_activity: "2026-07-25T10:00:09Z",
      completed_at: "2026-07-25T10:00:09Z",
    });
  });

  it("is thinking right after a user prompt, with the prompt's timestamp", () => {
    const text = [
      cUser("2026-07-25T10:00:00Z", "hi"),
      cAssistantText("2026-07-25T10:00:09Z", "done"),
      cUser("2026-07-25T10:05:00Z", "再来一次"),
    ].join("\n");
    expect(activityOf("claude", text)).toEqual({ state: "thinking", since: "2026-07-25T10:05:00Z", observed_at: "2026-07-25T10:05:00Z" });
  });

  it("reports the tool it is waiting on while the result has not landed", () => {
    const text = [cUser("2026-07-25T10:00:00Z", "hi"), cToolCall("2026-07-25T10:00:04Z", "t1", "Bash")].join("\n");
    expect(activityOf("claude", text)).toEqual({ state: "tool", tool: "Bash", since: "2026-07-25T10:00:04Z", observed_at: "2026-07-25T10:00:04Z" });
  });

  it("goes back to thinking once every pending result arrived", () => {
    const text = [
      cUser("2026-07-25T10:00:00Z", "hi"),
      cToolCall("2026-07-25T10:00:04Z", "t1", "Bash"),
      cToolResult("2026-07-25T10:00:06Z", "t1"),
    ].join("\n");
    expect(activityOf("claude", text)).toEqual({ state: "thinking", since: "2026-07-25T10:00:06Z", observed_at: "2026-07-25T10:00:06Z" });
  });

  it("names several parallel tools, summarizing past three", () => {
    const many = ["a", "b", "c", "d"].map((id, i) => cToolCall(`2026-07-25T10:00:0${i}Z`, id, `T${id}`));
    const act = activityOf("claude", [cUser("2026-07-25T09:00:00Z", "hi"), ...many].join("\n"));
    expect(act?.state).toBe("tool");
    expect(act?.tool).toBe("Ta, Tb, Tc 等 4 个");
    // `since` is the OLDEST in-flight call — that's the wait the user feels.
    expect(act?.since).toBe("2026-07-25T10:00:00Z");
  });

  it("still reports the tool when only SOME results came back", () => {
    const text = [
      cToolCall("2026-07-25T10:00:04Z", "t1", "Read"),
      cToolCall("2026-07-25T10:00:04Z", "t2", "Bash"),
      cToolResult("2026-07-25T10:00:06Z", "t1"),
    ].join("\n");
    expect(activityOf("claude", text)?.tool).toBe("Bash");
  });

  it("treats a missing/unknown stop_reason as still responding, not finished", () => {
    const text = [cUser("2026-07-25T10:00:00Z", "hi"), cAssistantText("2026-07-25T10:00:09Z", "部分内容", "")].join("\n");
    expect(activityOf("claude", text)).toEqual({ state: "responding", since: "2026-07-25T10:00:09Z", observed_at: "2026-07-25T10:00:09Z" });
  });

  it("accepts stop_sequence as terminal", () => {
    const text = cAssistantText("2026-07-25T10:00:09Z", "x", "stop_sequence");
    expect(activityOf("claude", text)?.state).toBe("idle");
  });

  it("ignores injected noise turns — a system reminder is not a user prompt", () => {
    const text = [
      cAssistantText("2026-07-25T10:00:09Z", "done"),
      cUser("2026-07-25T10:00:10Z", "<system-reminder>foo</system-reminder>"),
    ].join("\n");
    expect(activityOf("claude", text)?.state).toBe("idle");
  });

  it("skips tool calls without an id — they could never be paired and would pin the session forever", () => {
    const text = [
      cUser("2026-07-25T10:00:00Z", "hi"),
      line({
        type: "assistant",
        timestamp: "2026-07-25T10:00:04Z",
        message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash" }] },
      }),
    ].join("\n");
    expect(activityOf("claude", text)?.state).not.toBe("tool");
  });

  it("says 'unknown' — never nothing — for an empty or unparsable log", () => {
    // An ABSENT activity used to make viewers guess "running" from message
    // timestamps, a guess that could never expire. An explicit unknown state
    // (with no observed_at to measure against) degrades honestly instead.
    expect(activityOf("claude", "")).toEqual({ state: "unknown" });
    expect(activityOf("claude", "not json\n{oops")).toEqual({ state: "unknown" });
  });

  it("a headless run's result record closes the turn, pending tool and all", () => {
    const text = [
      cUser("2026-07-25T10:00:00Z", "hi"),
      cToolCall("2026-07-25T10:00:04Z", "t1", "Bash"),
      line({ type: "result", timestamp: "2026-07-25T10:00:20Z", subtype: "success", result: "done" }),
    ].join("\n");
    expect(activityOf("claude", text)?.state).toBe("idle");
  });

  it("an API error line ends the turn instead of leaving it 'responding' forever", () => {
    const text = [
      cUser("2026-07-25T10:00:00Z", "hi"),
      line({
        type: "assistant",
        timestamp: "2026-07-25T10:00:05Z",
        isApiErrorMessage: true,
        message: { role: "assistant", content: [{ type: "text", text: "API Error" }] },
      }),
    ].join("\n");
    expect(activityOf("claude", text)?.state).toBe("idle");
  });

  it("carries observed_at = the last line's timestamp, so viewers can time silence", () => {
    const text = [
      cUser("2026-07-25T10:00:00Z", "hi"),
      cToolCall("2026-07-25T10:00:04Z", "t1", "Bash"),
      cToolResult("2026-07-25T10:00:06Z", "t1"),
      cAssistantText("2026-07-25T10:09:00Z", "还在写", ""),
    ].join("\n");
    const act = activityOf("claude", text);
    expect(act?.state).toBe("responding");
    expect(act?.observed_at).toBe("2026-07-25T10:09:00Z");
  });
});

// ── Codex ──

const xLine = (ts: string, type: string, payload: Record<string, unknown>) =>
  line({ timestamp: ts, type, payload: { type: payload.type, ...payload } });

const xEvent = (ts: string, t: string, extra: Record<string, unknown> = {}) =>
  xLine(ts, "event_msg", { type: t, ...extra });

const xItem = (ts: string, t: string, extra: Record<string, unknown> = {}) =>
  xLine(ts, "response_item", { type: t, ...extra });

describe("codex activity", () => {
  const meta = xLine("2026-07-25T10:00:00Z", "session_meta", { type: "session_meta", id: "s1", cwd: "/p" });

  it("is thinking between task_started and any output", () => {
    const text = [meta, xEvent("2026-07-25T10:00:01Z", "user_message", { message: "hi" }),
      xEvent("2026-07-25T10:00:02Z", "task_started")].join("\n");
    expect(activityOf("codex", text)).toEqual({ state: "thinking", since: "2026-07-25T10:00:01Z", observed_at: "2026-07-25T10:00:02Z" });
  });

  it("reports an in-flight function call by name", () => {
    const text = [meta, xEvent("2026-07-25T10:00:02Z", "task_started"),
      xItem("2026-07-25T10:00:03Z", "function_call", { call_id: "c1", name: "shell" })].join("\n");
    expect(activityOf("codex", text)).toEqual({ state: "tool", tool: "shell", since: "2026-07-25T10:00:03Z", observed_at: "2026-07-25T10:00:03Z" });
  });

  it("clears the tool when its output arrives", () => {
    const text = [meta, xEvent("2026-07-25T10:00:02Z", "task_started"),
      xItem("2026-07-25T10:00:03Z", "function_call", { call_id: "c1", name: "shell" }),
      xItem("2026-07-25T10:00:05Z", "function_call_output", { call_id: "c1", output: "ok" })].join("\n");
    expect(activityOf("codex", text)).toEqual({ state: "thinking", since: "2026-07-25T10:00:05Z", observed_at: "2026-07-25T10:00:05Z" });
  });

  it("keeps responding after an agent_message while the turn is still open", () => {
    const text = [meta, xEvent("2026-07-25T10:00:02Z", "task_started"),
      xEvent("2026-07-25T10:00:06Z", "agent_message", { message: "先做一步" })].join("\n");
    expect(activityOf("codex", text)?.state).toBe("responding");
  });

  it("is idle after task_complete", () => {
    const text = [meta, xEvent("2026-07-25T10:00:02Z", "task_started"),
      xEvent("2026-07-25T10:00:06Z", "agent_message", { message: "好了" }),
      xEvent("2026-07-25T10:00:07Z", "task_complete")].join("\n");
    expect(activityOf("codex", text)).toEqual({ state: "idle", since: "2026-07-25T10:00:07Z", observed_at: "2026-07-25T10:00:07Z" });
  });

  it("uses task_complete rather than intermediate agent messages as the stable key", () => {
    const open = [
      meta,
      xEvent("2026-07-25T10:00:01Z", "user_message", { message: "hi" }),
      xEvent("2026-07-25T10:00:02Z", "task_started"),
      xEvent("2026-07-25T10:00:06Z", "agent_message", { message: "先做一步" }),
    ].join("\n");
    expect(lifecycleOf("codex", open)).toEqual({
      sort_activity: "2026-07-25T10:00:01Z",
      completed_at: undefined,
    });
    expect(lifecycleOf("codex", `${open}\n${xEvent("2026-07-25T10:00:07Z", "task_complete")}`)).toEqual({
      sort_activity: "2026-07-25T10:00:07Z",
      completed_at: "2026-07-25T10:00:07Z",
    });
  });

  it("is idle after turn_aborted even with a tool still unanswered", () => {
    const text = [meta, xEvent("2026-07-25T10:00:02Z", "task_started"),
      xItem("2026-07-25T10:00:03Z", "function_call", { call_id: "c1", name: "shell" }),
      xItem("2026-07-25T10:00:05Z", "function_call_output", { call_id: "c1", output: "ok" }),
      xEvent("2026-07-25T10:00:08Z", "turn_aborted")].join("\n");
    expect(activityOf("codex", text)?.state).toBe("idle");
  });

  it("ignores token_count chatter", () => {
    const text = [meta, xEvent("2026-07-25T10:00:02Z", "task_started"),
      xEvent("2026-07-25T10:00:03Z", "token_count", { info: {} }),
      xEvent("2026-07-25T10:00:09Z", "task_complete"),
      xEvent("2026-07-25T10:00:10Z", "token_count", { info: {} })].join("\n");
    expect(activityOf("codex", text)).toEqual({ state: "idle", since: "2026-07-25T10:00:09Z", observed_at: "2026-07-25T10:00:10Z" });
  });
});

describe("Claude interrupt markers", () => {
  it("ends the turn when Esc interrupts a running tool, instead of opening a new one", () => {
    const text = [
      line({ type: "user", timestamp: "2026-10-14T11:47:58Z", message: { role: "user", content: "run it" } }),
      line({ type: "assistant", timestamp: "2026-10-14T11:47:59Z", message: { role: "assistant", stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "timeout 120 tail -f /dev/null" } }] } }),
      line({ type: "user", timestamp: "2026-10-14T11:48:19Z", message: { role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "The user doesn't want to proceed with this tool use." }] } }),
      line({ type: "user", timestamp: "2026-10-14T11:48:19.034Z", message: { role: "user",
        content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }),
    ].join("\n");
    expect(activityOf("claude", text)).toMatchObject({ state: "idle", since: "2026-10-14T11:48:19.034Z" });
  });

  it("ends the turn for a plain interrupt while the model is still thinking", () => {
    const text = [
      line({ type: "user", timestamp: "2026-10-14T12:00:00Z", message: { role: "user", content: "think hard" } }),
      line({ type: "user", timestamp: "2026-10-14T12:00:05Z", message: { role: "user", content: "[Request interrupted by user]" } }),
    ].join("\n");
    expect(activityOf("claude", text)).toMatchObject({ state: "idle", since: "2026-10-14T12:00:05Z" });
    // A later real prompt opens a new turn again.
    expect(activityOf("claude", text + "\n" + line({ type: "user", timestamp: "2026-10-14T12:00:09Z",
      message: { role: "user", content: "continue" } }))).toMatchObject({ state: "thinking" });
  });
});
