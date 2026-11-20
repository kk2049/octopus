import { describe, it, expect } from "vitest";
import {
  parseSessionText,
  parseSessionRich,
  classifyOmpContent,
  deriveIdFromPath,
} from "./parse.js";

// ---------------------------------------------------------------------------
// Inline fixtures shaped after real ~/.omp/agent/sessions bytes (omp 17.3.5).
//
// The structural facts that matter and that no other CLI has: a tool RESULT is
// its own top-level entry keyed by `toolCallId`, a tool CALL is an assistant
// block typed `toolCall` carrying `arguments` + `intent`, and the file opens
// with a `title` header line BEFORE the `session` line.
// ---------------------------------------------------------------------------

const OMP_JSONL = [
  `{"type":"title","v":1,"title":"调研 dsh 生态","source":"auto","updatedAt":"2026-08-17T09:08:10.397Z"}`,
  `{"type":"session","version":3,"id":"01a00ed4-db09-7000-b549-ac372c282cfa","timestamp":"2026-08-17T08:27:05.865Z","cwd":"/home/ubuntu/lht/octopus","title":"复盘"}`,
  `{"type":"model_change","id":"8f4f4a18","parentId":null,"timestamp":"2026-08-17T08:27:05.993Z","model":"openai-codex/gpt-5.6-sol"}`,
  `{"type":"thinking_level_change","id":"9d93","parentId":"8f4f","timestamp":"2026-08-17T08:31:37.575Z","thinkingLevel":"xhigh"}`,
  `{"type":"message","id":"cb5b","parentId":"9d93","timestamp":"2026-08-17T08:31:37.682Z","message":{"role":"user","content":[{"type":"text","text":"帮我复盘长任务"}],"attribution":"user"}}`,
  `{"type":"message","id":"27e6","parentId":"cb5b","timestamp":"2026-08-17T08:31:47.245Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"先建立清单"},{"type":"toolCall","id":"call_1","name":"todo","arguments":{"op":"init"},"intent":"建立复盘清单"}],"model":"gpt-5.6-sol"}}`,
  `{"type":"custom","customType":"tool_execution_start","data":{"toolCallId":"call_1","toolName":"todo"},"id":"fc80","parentId":"27e6","timestamp":"2026-08-17T08:31:47.250Z"}`,
  `{"type":"credential_pin","id":"50c9","parentId":"fc80","timestamp":"2026-08-17T08:31:47.252Z","provider":"openai-codex","hash":"deadbeef"}`,
  `{"type":"message","id":"7b5c","parentId":"50c9","timestamp":"2026-08-17T08:31:47.267Z","message":{"role":"toolResult","toolCallId":"call_1","toolName":"todo","content":[{"type":"text","text":"Remaining items (2)"}],"isError":false}}`,
  `{ not json at all`,
  ``,
  `{"type":"custom_message","customType":"mid-run-todo-nudge","content":"<system-reminder>\\n2 todo items still open.\\n</system-reminder>","display":false,"attribution":"agent","id":"c64d","parentId":"7b5c","timestamp":"2026-08-17T08:38:58.430Z"}`,
  `{"type":"message","id":"ae2f","parentId":"c64d","timestamp":"2026-08-17T08:39:10.000Z","message":{"role":"assistant","content":[{"type":"text","text":"复盘结论如下"}]}}`,
].join("\n");

describe("classifyOmpContent", () => {
  it("separates text, thinking, toolCall and image blocks", () => {
    const info = classifyOmpContent([
      { type: "thinking", thinking: "内部推理" },
      { type: "text", text: "回答" },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" }, intent: "列目录" },
      { type: "image", data: "…" },
    ]);
    expect(info.text).toBe("回答");
    expect(info.hasText).toBe(true);
    expect(info.thinking).toEqual(["内部推理"]);
    expect(info.hasImage).toBe(true);
    expect(info.calls).toEqual([
      { id: "c1", name: "bash", arguments: { command: "ls" }, intent: "列目录" },
    ]);
  });

  it("accepts a plain string content and non-arrays", () => {
    expect(classifyOmpContent(" hi ").text).toBe("hi");
    expect(classifyOmpContent(undefined).hasText).toBe(false);
    expect(classifyOmpContent(42).calls).toEqual([]);
  });
});

describe("parseSessionText — omp", () => {
  const parsed = parseSessionText("omp", OMP_JSONL);

  it("reads identity from the session entry and the canonical title header", () => {
    expect(parsed.meta.source).toBe("omp");
    expect(parsed.meta.id).toBe("01a00ed4-db09-7000-b549-ac372c282cfa");
    expect(parsed.meta.cwd).toBe("/home/ubuntu/lht/octopus");
    expect(parsed.meta.title).toBe("调研 dsh 生态");
    expect(parsed.meta.started_at).toBe("2026-08-17T08:27:05.865Z");
    expect(parsed.meta.last_activity).toBe("2026-08-17T08:39:10.000Z");
    expect(parsed.meta.sort_activity).toBe("2026-08-17T08:39:10.000Z");
    expect(parsed.meta.completed_at).toBe("2026-08-17T08:39:10.000Z");
  });

  it("keeps user/assistant turns and drops bookkeeping, results and noise", () => {
    expect(parsed.messages).toEqual([
      { role: "user", text: "帮我复盘长任务" },
      { role: "assistant", text: "", tool: "todo" },
      { role: "assistant", text: "复盘结论如下" },
    ]);
    expect(parsed.meta.message_count).toBe(3);
    expect(parsed.meta.first_user_text).toBe("帮我复盘长任务");
    expect(parsed.meta.preview).toBe("复盘结论如下");
  });

  it("uses the latest omp title change", () => {
    const changed = `${OMP_JSONL}\n${JSON.stringify({
      type: "title_change",
      title: "复盘结论",
      timestamp: "2026-08-17T08:40:00.000Z",
    })}`;
    expect(parseSessionText("omp", changed).meta.title).toBe("复盘结论");
  });

  it("appends the tool arguments only when tool_detail is on", () => {
    const detailed = parseSessionText("omp", OMP_JSONL, { toolDetail: true });
    expect(detailed.messages[1].tool).toBe(`todo({"op":"init"})`);
  });

  it("reports idle once the last assistant turn produced text", () => {
    expect(parsed.meta.activity?.state).toBe("idle");
    expect(parsed.meta.activity?.observed_at).toBe("2026-08-17T08:39:10.000Z");
  });

  it("reports the pending tool while its toolResult has not landed", () => {
    const pending = parseSessionText("omp", OMP_JSONL.split("\n").slice(0, 7).join("\n"));
    expect(pending.meta.activity?.state).toBe("tool");
    expect(pending.meta.activity?.tool).toBe("todo");
    expect(pending.meta.sort_activity).toBe("2026-08-17T08:31:37.682Z");
    expect(pending.meta.completed_at).toBeUndefined();
  });

  it("reports thinking right after a user prompt", () => {
    const waiting = parseSessionText("omp", OMP_JSONL.split("\n").slice(0, 5).join("\n"));
    expect(waiting.meta.activity?.state).toBe("thinking");
  });

  it("moves a resumed session to its newest user prompt before completion", () => {
    const resumedAt = "2026-08-17T12:37:42.867Z";
    const resumed = parseSessionText("omp", `${OMP_JSONL}\n${JSON.stringify({
      type: "message",
      id: "resumed-user",
      parentId: "ae2f",
      timestamp: resumedAt,
      message: {
        role: "user",
        content: [{ type: "text", text: "工单对话有新消息：请继续检查排序" }],
      },
    })}`);
    expect(resumed.meta).toMatchObject({
      sort_activity: resumedAt,
      completed_at: "2026-08-17T08:39:10.000Z",
      activity: { state: "thinking", since: resumedAt, observed_at: resumedAt },
    });
  });

  it("uses a compaction summary as preview when no text turn survives", () => {
    const compacted = [
      `{"type":"session","version":3,"id":"s1","timestamp":"2026-08-17T00:00:00.000Z","cwd":"/tmp"}`,
      `{"type":"compaction","id":"c1","timestamp":"2026-08-17T00:00:01.000Z","summary":"归档摘要"}`,
    ].join("\n");
    expect(parseSessionText("omp", compacted).meta.preview).toBe("归档摘要");
  });

  it("survives an all-garbage file", () => {
    const junk = parseSessionText("omp", "nope\n{oops\n\n");
    expect(junk.messages).toEqual([]);
    expect(junk.meta.source).toBe("omp");
  });
});

describe("parseSessionRich — omp", () => {
  const rich = parseSessionRich("omp", OMP_JSONL);

  it("pairs a top-level toolResult back onto its toolCall block", () => {
    const call = rich.messages[1].blocks.find((b) => b.type === "tool");
    expect(call).toMatchObject({
      type: "tool",
      tool: "todo",
      input: `{"op":"init"}`,
      output: "Remaining items (2)",
    });
    expect(call?.is_error).toBeUndefined();
  });

  it("keeps omp's per-call intent as the tool block's own text", () => {
    const call = rich.messages[1].blocks.find((b) => b.type === "tool");
    expect(call?.text).toBe("建立复盘清单");
  });

  it("preserves thinking blocks and block order inside one assistant turn", () => {
    expect(rich.messages[1].blocks.map((b) => b.type)).toEqual(["thinking", "tool"]);
    expect(rich.messages[1].blocks[0].text).toBe("先建立清单");
  });

  it("emits user / assistant turns only", () => {
    expect(rich.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(rich.meta.id).toBe("01a00ed4-db09-7000-b549-ac372c282cfa");
  });

  it("marks a failed tool result as an error", () => {
    const failed = [
      `{"type":"session","version":3,"id":"s2","timestamp":"2026-08-17T00:00:00.000Z","cwd":"/tmp"}`,
      `{"type":"message","id":"a","timestamp":"2026-08-17T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c9","name":"bash","arguments":{"command":"false"}}]}}`,
      `{"type":"message","id":"b","timestamp":"2026-08-17T00:00:02.000Z","message":{"role":"toolResult","toolCallId":"c9","toolName":"bash","content":[{"type":"text","text":"exit 1"}],"isError":true}}`,
    ].join("\n");
    const block = parseSessionRich("omp", failed).messages[0].blocks[0];
    expect(block).toMatchObject({ type: "tool", output: "exit 1", is_error: true });
  });

  it("renders a pasted image as a marker rather than its payload", () => {
    const withImage = [
      `{"type":"session","version":3,"id":"s3","timestamp":"2026-08-17T00:00:00.000Z","cwd":"/tmp"}`,
      `{"type":"message","id":"u","timestamp":"2026-08-17T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"看这张图"},{"type":"image","data":"AAAA"}]}}`,
    ].join("\n");
    expect(parseSessionRich("omp", withImage).messages[0].blocks[0].text).toBe("看这张图\n🖼 [图片]");
  });
});

describe("deriveIdFromPath — omp", () => {
  it("takes the uuid suffix of `<iso-ts>_<uuid>.jsonl`", () => {
    expect(
      deriveIdFromPath(
        "omp",
        "/home/u/.omp/agent/sessions/-lht/2026-08-17T09-08-13-574Z_01a00efa-8286-7000-8f3d-98d77ebcb790.jsonl",
      ),
    ).toBe("01a00efa-8286-7000-8f3d-98d77ebcb790");
  });

  it("falls back to the stem when the name carries no uuid", () => {
    expect(deriveIdFromPath("omp", "/x/sessions/-p/notauuid.jsonl")).toBe("notauuid");
  });
});
