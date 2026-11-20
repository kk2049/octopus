import { describe, expect, it } from "vitest";
import { createSessionSummaryParser, parseSessionRich, parseSessionText, type Source } from "./parse.js";

const timestamp = "2026-10-12T07:45:27.357Z";
const codex = (type: string, extra: Record<string, unknown> = {}) => ({ type: "event_msg", timestamp, payload: { type, ...extra } });
const omp = (message: Record<string, unknown>) => ({ type: "message", timestamp, message });
const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

function projections(source: Source, records: unknown[]) {
  const text = jsonl(records);
  const flat = parseSessionText(source, text);
  const rich = parseSessionRich(source, text);
  const summary = createSessionSummaryParser(source);
  for (const record of records) summary.append([record]);
  expect(summary.snapshot()).toEqual(flat.meta);
  expect(rich.meta.message_count).toBe(flat.meta.message_count);
  expect(rich.meta.activity).toEqual(flat.meta.activity);
  return { flat, rich, body: rich.messages.flatMap((message) => message.blocks.map((block) => block.text ?? "")).join("\n") };
}

describe("native Agent terminal errors in session chat", () => {
  it.each(["error", "task_complete", "turn_complete", "turn_aborted"])("explains the native cyber-policy stop from %s", (type) => {
    const diagnostic = { message: "Request blocked", codex_error_info: "cyber_policy", private_detail: "do-not-project" };
    const { flat, rich, body } = projections("codex", [
      codex("user_message", { message: "continue" }), codex("task_started"),
      codex("function_call", { call_id: "pending", name: "shell" }),
      codex(type, type === "error" ? diagnostic : { error: diagnostic }),
    ]);
    expect(body).toContain("Codex 本轮工作已停止：Request blocked");
    expect(body).toContain("网络安全策略限制");
    expect(body).toContain("https://help.openai.com/en/articles/20001326");
    expect(body).toContain("https://openai.com/form/enterprise-trusted-access-for-cyber/");
    expect(body).not.toContain("do-not-project");
    expect(flat.messages.at(-1)?.text).toBe(rich.messages.at(-1)?.blocks[0].text);
    expect(flat.meta.activity?.state).toBe("idle");
    expect(flat.meta.completed_at).toBe(timestamp);
  });

  it("retains the user's complete Daybreak example without duplicating its links", () => {
    const message = "ⓘ This content can’t be shown\n"
      + "  We take extra care with some cybersecurity requests. If you’re doing authorized security work, apply for Daybreak to get\n"
      + "  broader access.\n"
      + "  Learn more: https://help.openai.com/en/articles/20001326\n"
      + "  Apply for Daybreak: https://openai.com/form/enterprise-trusted-access-for-cyber/";
    const { body } = projections("codex", [codex("task_complete", { error: { message, codex_error_info: "cyber_policy" } })]);
    expect(body).toContain(message);
    expect(body.match(/https:\/\/help\.openai\.com/g)).toHaveLength(1);
    expect(body.match(/https:\/\/openai\.com/g)).toHaveLength(1);
  });

  it("keeps cyber-policy guidance after bounding a long diagnostic", () => {
    const { body } = projections("codex", [codex("task_complete", { error: { message: "x".repeat(10_000), codex_error_info: "cyber_policy" } })]);
    expect(body).toContain("x".repeat(4_000) + "…");
    expect(body).toContain("https://openai.com/form/enterprise-trusted-access-for-cyber/");
    expect(body.length).toBeLessThan(4_400);
  });

  it("does not infer cyber-policy failures from wording or classify a warning as a stop", () => {
    const { body } = projections("codex", [codex("error", { message: "This content can’t be shown", codex_error_info: "other" })]);
    expect(body).toContain("This content can’t be shown");
    expect(body).not.toContain("Daybreak");
    for (const event of [codex("warning", { message: "cyber_policy" }),
      codex("error", { message: "retrying", codex_error_info: "cyber_policy", will_retry: true })]) {
      const result = projections("codex", [codex("task_started"), event]);
      expect(result.body).toBe("");
      expect(result.flat.meta.activity?.state).toBe("thinking");
    }
  });

  it.each(["stream disconnected before completion: exceeded retry limit", "You've hit your usage limit. Try again later."])(
    "retains the Codex cause: %s", (message) => {
      const { flat, rich, body } = projections("codex", [
        codex("user_message", { message: "continue" }), codex("task_started"),
        codex("function_call", { call_id: "pending", name: "shell" }), codex("error", { message }),
      ]);
      expect(body).toContain(`Codex 本轮工作已停止：${message}`);
      expect(rich.messages.at(-1)?.timestamp).toBe(timestamp);
      expect(flat.messages.at(-1)?.text).toContain(message);
      expect(flat.meta.activity?.state).toBe("idle");
      expect(flat.meta.completed_at).toBe(timestamp);
    },
  );

  it.each(["task_complete", "turn_complete", "turn_aborted"])("reads the durable %s error without a standalone event", (type) => {
    const { flat, body } = projections("codex", [
      codex("turn_started", { turn_id: "one" }),
      codex(type, { turn_id: "one", error: { message: "Usage limit exceeded", codex_error_info: "usage_limit_exceeded" } }),
    ]);
    expect(body).toContain("Codex 本轮工作已停止：Usage limit exceeded");
    expect(flat.meta.activity?.state).toBe("idle");
  });

  it.each(["thread_rollback_failed", { active_turn_not_steerable: { turn_kind: "compact" } }])("does not stop a native turn on an input refusal", (codex_error_info) => {
    const { flat, body } = projections("codex", [codex("task_started"), codex("error", { message: "input refused", codex_error_info })]);
    expect(body).toBe("");
    expect(flat.meta.activity?.state).toBe("thinking");
  });

  it.each(["new prompt", "original prompt"])("keeps item-only history and errors when a later event supplies %s", (prompt) => {
    const item = { type: "response_item", timestamp, payload: { type: "message", role: "user", content: "original prompt" } };
    const failure = codex("error", { error: { message: "quota exhausted" } });
    const before = projections("codex", [item, failure]);
    expect(before.flat.messages.map((message) => message.text)).toEqual(["original prompt", expect.stringContaining("quota exhausted")]);
    const after = projections("codex", [item, failure, codex("user_message", { message: prompt }), codex("task_started")]);
    const expected = ["original prompt", expect.stringContaining("quota exhausted"), prompt];
    expect(after.flat.messages.map((message) => message.text)).toEqual(expected);
    expect(after.rich.messages.map((message) => message.blocks[0].text)).toEqual(expected);
    expect(after.flat.meta.activity?.state).toBe("thinking");
  });

  it("a new native turn clears the previous terminal state without needing a user echo", () => {
    expect(projections("codex", [codex("error", { message: "quota exhausted" }), codex("task_started")]).flat.meta.activity?.state).toBe("thinking");
  });

  it.each([
    codex("stream_error", { message: "Reconnecting... 1/5" }),
    codex("warning", { message: "quota nearly exhausted" }),
    codex("error", { message: "retrying", will_retry: true }),
    codex("error", { message: "retrying", willRetry: true }),
  ])("does not claim a retry/warning stopped the turn", (event) => {
    const { flat, body } = projections("codex", [codex("task_started"), event]);
    expect(body).not.toContain("已停止");
    expect(flat.meta.activity?.state).toBe("thinking");
    expect(flat.meta.completed_at).toBeUndefined();
  });

  it.each(["task_complete", "turn_complete", "turn_aborted"])("closes pending tools without inventing an error for %s", (type) => {
    const { flat, body } = projections("codex", [codex("task_started"), codex("function_call", { call_id: "pending", name: "shell" }), codex(type)]);
    expect(body).not.toContain("已停止");
    expect(flat.meta.activity?.state).toBe("idle");
  });

  it.each([
    { type: "assistant", timestamp, isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: "Credit balance is too low" }] } },
    { type: "result", timestamp, is_error: true, errors: ["Credit balance is too low"] },
  ])("renders a Claude terminal failure once per native record", (failure) => {
    const { flat, rich, body } = projections("claude", [failure]);
    expect(body).toContain("Claude Code 本轮工作已停止：Credit balance is too low");
    expect(rich.messages).toHaveLength(1);
    expect(flat.meta.activity?.state).toBe("idle");
  });

  it("does not render Claude retry diagnostics or successful results as failures", () => {
    const { body } = projections("claude", [
      { type: "system", subtype: "api_error", error: { message: "retrying" }, retryAttempt: 1 },
      { type: "result", is_error: false, result: "done" },
    ]);
    expect(body).toBe("");
  });

  it("retains OMP's error-only assistant and closes its pending tool", () => {
    const { flat, body } = projections("omp", [
      omp({ role: "assistant", content: [{ type: "toolCall", id: "pending", name: "read", arguments: {} }] }),
      omp({ role: "assistant", content: [], stopReason: "error", errorMessage: "Insufficient quota" }),
    ]);
    expect(body).toContain("OMP 本轮工作已停止：Insufficient quota");
    expect(flat.meta.activity?.state).toBe("idle");
  });

  it("preserves partial OMP text and treats the next user message as new work", () => {
    const failure = omp({ role: "assistant", content: [{ type: "text", text: "Completed step one" }], stopReason: "error", errorMessage: "Connection lost" });
    const { rich, body } = projections("omp", [failure]);
    expect(rich.messages).toHaveLength(1);
    expect(body).toContain("Completed step one");
    expect(body).toContain("Connection lost");
    expect(projections("omp", [failure, omp({ role: "user", content: "continue" })]).flat.meta.activity?.state).toBe("thinking");
  });

  it.each<Source>(["codex", "claude", "omp"])("bounds %s diagnostics and never serializes unrecognized fields", (source) => {
    const failure = source === "codex" ? codex("error", { message: "x".repeat(10_000), token: "private-token" })
      : source === "claude" ? { type: "result", is_error: true, errors: ["x".repeat(10_000)], token: "private-token" }
        : omp({ role: "assistant", stopReason: "error", errorMessage: "x".repeat(10_000), token: "private-token" });
    const { body } = projections(source, [failure]);
    expect(body.length).toBeLessThan(4_100);
    expect(body).not.toContain("private-token");
  });

  it("handles missing or malformed diagnostics without fabricating a reason", () => {
    const { body } = projections("codex", [codex("error", { message: { token: "private-token" } })]);
    expect(body).toContain("未提供具体原因");
    expect(body).not.toContain("private-token");
  });
});
