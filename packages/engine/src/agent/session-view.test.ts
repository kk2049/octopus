import { describe, expect, it } from "vitest";
import { fromPlane, parseClaudeSession, parseCodexSession } from "./session-view.js";

describe("parseClaudeSession", () => {
  const lines = [
    { type: "user", timestamp: "t1", message: { role: "user", content: [{ type: "text", text: "帮我改一下" }] } },
    {
      type: "assistant",
      timestamp: "t2",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先看文件" },
          { type: "tool_use", id: "tu1", name: "mcp__v3__comment", input: { id: "tk-1", text: "hi" } },
          { type: "tool_use", id: "tu2", name: "Write", input: { file_path: "/tmp/a.ts", content: "x" } },
          { type: "tool_use", id: "tu3", name: "Task", input: { description: "查资料", prompt: "去查" } },
        ],
      },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "已评论" }] }] },
    },
    { type: "assistant", timestamp: "t3", message: { role: "assistant", content: [{ type: "text", text: "搞定了" }] } },
    { type: "system", message: { role: "system", content: "noise" } },
    "not json at all",
  ]
    .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
    .join("\n");

  it("maps thinking/tool/file/subagent, pairs results, strips mcp prefixes, collects files", () => {
    const v = parseClaudeSession(lines);
    expect(v.source).toBe("claude-code");
    expect(v.entries.map((e) => e.kind)).toEqual(["user", "thinking", "tool", "file", "subagent", "assistant"]);
    const tool = v.entries[2];
    expect(tool.text).toContain("comment(");
    expect(tool.text).not.toContain("mcp__");
    expect(tool.detail).toBe("已评论");
    expect(v.entries[3].text).toBe("/tmp/a.ts");
    expect(v.entries[4].text).toBe("查资料");
    expect(v.files).toEqual(["/tmp/a.ts"]);
  });
});

describe("parseCodexSession", () => {
  const lines = [
    { timestamp: "t0", type: "session_meta", payload: { id: "sid" } },
    { timestamp: "t1", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "列一下未读" }] } },
    { timestamp: "t1b", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>noise</environment_context>" }] } },
    { timestamp: "t2", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "想想" }] } },
    { timestamp: "t3", type: "response_item", payload: { type: "function_call", name: "read_state", arguments: "{}", call_id: "c1" } },
    { timestamp: "t4", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: '{"ok":true}' } },
    {
      timestamp: "t5",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: '{"command":["apply_patch","*** Update File: src/x.ts\\n..."]}',
        call_id: "c2",
      },
    },
    { timestamp: "t6", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "两条未读" }] } },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");

  it("maps reasoning/function calls, pairs outputs, skips env noise, spots patched files", () => {
    const v = parseCodexSession(lines);
    expect(v.entries.map((e) => e.kind)).toEqual(["user", "thinking", "tool", "file", "assistant"]);
    expect(v.entries[2].text).toContain("read_state");
    expect(v.entries[2].detail).toBe('{"ok":true}');
    expect(v.files).toEqual(["src/x.ts"]);
  });
});

describe("fromPlane", () => {
  it("keeps elicit actions and maps roles 1:1", () => {
    const v = fromPlane([
      { role: "user", text: "hi", at: "t" },
      { role: "elicit", text: "填表", action: "add_clip", at: "t" },
      { role: "note", text: "n", at: "t" },
    ]);
    expect(v.entries.map((e) => e.kind)).toEqual(["user", "elicit", "note"]);
    expect(v.entries[1].action).toBe("add_clip");
  });
});
