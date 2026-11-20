import { describe, expect, it } from "vitest";
import type { RichMessage, TranscriptWindow } from "@claude-bot/agent-sessions-contract";
import { asyncAnswerMarker, asyncAnswerPrompt, collectAsyncQuestions } from "./async-questions.js";

const ask = (id = "call-a", input = JSON.stringify({ questions: [{ title: "选哪个？", options: ["A", "B"] }] })): RichMessage => ({
  role: "assistant", blocks: [{ type: "tool", tool: "functions.request_user_input_async", call_id: id, input,
    output: "Question displayed. Continue working." }],
});
const user = (text: string): RichMessage => ({ role: "user", blocks: [{ type: "text", text }] });

describe("Codex asynchronous question evidence", () => {
  it("keeps questions pending after the immediate tool output and unrelated user messages", () => {
    const [request] = collectAsyncQuestions({ messages: [ask(), user("先看另一个文件")] });
    expect(request).toMatchObject({ id: "call-a", answered: false, laterUserMessage: true,
      questions: [{ prompt: "选哪个？", options: [{ label: "A" }, { label: "B" }], allow_other: true }] });
  });
  it("matches only a later explicit user answer to its exact call, including after reload", () => {
    const window: TranscriptWindow = { messages: [ask(), ask("call-b")] };
    const [a] = collectAsyncQuestions(window);
    const prompt = asyncAnswerPrompt(a, { "0": ["自己的回答"] });
    const reloaded = JSON.parse(JSON.stringify({ ...window, messages: [...window.messages!, user(prompt)] }));
    expect(collectAsyncQuestions(reloaded).map((r) => r.answered)).toEqual([true, false]);
    expect(prompt).toContain("选哪个？\n回答：自己的回答");
    expect(collectAsyncQuestions({ messages: [user(prompt), ask()] })[0].answered).toBe(false);
    expect(collectAsyncQuestions({ messages: [ask(), { role: "assistant", blocks: [{ type: "text", text: prompt }] }] })[0].answered).toBe(false);
    expect(collectAsyncQuestions({ messages: [ask(), user(`引用：\n${prompt}`)] })[0].answered).toBe(false);
  });
  it("keeps native identity across prepend and page movement, with absolute offsets for old providers", () => {
    const native = ask();
    expect(collectAsyncQuestions({ offset: 50, messages: [native] })[0].id).toBe("call-a");
    expect(collectAsyncQuestions({ offset: 49, messages: [user("old"), native] })[0].id).toBe("call-a");
    const legacy = ask("");
    expect(collectAsyncQuestions({ offset: 50, messages: [legacy] })[0].id)
      .toBe(collectAsyncQuestions({ offset: 49, messages: [user("old"), legacy] })[0].id);
    expect(collectAsyncQuestions({ messages: [legacy] })[0].error).toContain("稳定标识");
  });
  it("supports free text, multiple questions and keeps repeated same-title calls distinct", () => {
    const input = JSON.stringify({ questions: [{ title: "自由回答" }, { title: "单选", options: ["甲"] }] });
    const requests = collectAsyncQuestions({ messages: [ask("1", input), ask("2", input)] });
    expect(requests).toHaveLength(2);
    expect(requests[0].questions).toHaveLength(2);
    expect(requests[0].questions[0].options).toEqual([]);
  });
  it.each(["{\"questions\":", '{"questions":[]}', '{"questions":[{"title":"","options":["a"]}]}',
    '{"questions":[{"title":"x","options":[{}]}]}'])("exposes malformed or truncated inputs without inventing actionable questions: %s", (input) => {
    expect(collectAsyncQuestions({ messages: [ask("bad", input)] })[0].error).toContain("问题内容不完整");
  });
  it("ignores other tools and escapes native ids in the correlation line", () => {
    expect(collectAsyncQuestions({ messages: [{ role: "assistant", blocks: [{ type: "tool", tool: "request_user_input", input: "{}" }] }] })).toEqual([]);
    expect(asyncAnswerMarker("id\nother")).not.toContain("\n");
    expect(() => asyncAnswerMarker("id\ud800")).not.toThrow();
    const [request] = collectAsyncQuestions({ messages: [ask("id\ud800")] });
    expect(collectAsyncQuestions({ messages: [ask("id\ud800"), user(asyncAnswerPrompt(request, { "0": ["A"] }))] })[0].answered).toBe(true);
  });
});
