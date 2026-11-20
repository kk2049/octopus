import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionRichParser, parseSessionRich, parseSessionText, RICH_INPUT_CAP, type Source } from "./parse.js";
import { readSession } from "./scan.js";

const line = (obj: unknown): string => JSON.stringify(obj);

describe("Claude compaction summaries", () => {
  const summary = "This session is being continued from a previous conversation that ran out of context.\n" + "Summary detail. ".repeat(1_000).trim();
  it.each([summary, [{ type: "text", text: summary }]])("hides native summaries in flat and rich reads without hiding similar human prose (%#)", (content) => {
    const rows = [
      { type: "system", subtype: "compact_boundary" },
      { type: "user", isCompactSummary: true, message: { role: "user", content } },
      { type: "user", isCompactSummary: false, message: { role: "user", content: summary } },
      { type: "assistant", message: { role: "assistant", content: "继续回答", stop_reason: "end_turn" } },
    ].map(line).join("\n");
    const rich = parseSessionRich("claude", rows);
    const flat = parseSessionText("claude", rows);
    expect(rich.messages.map((message) => message.blocks[0].text)).toEqual([summary, "继续回答"]);
    expect(flat.messages.map((message) => message.text)).toEqual([summary, "继续回答"]);
    expect(rich.meta.message_count).toBe(2);
    expect(flat.meta.message_count).toBe(2);
  });

  it("does not make a compaction summary a new user turn or break incremental tool pairing", () => {
    const parser = createSessionRichParser("claude");
    const rows = [
      { type: "user", timestamp: "2026-10-22T10:00:00Z", message: { role: "user", content: "检查文件" } },
      { type: "assistant", timestamp: "2026-10-22T10:00:01Z", message: { role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "Read", input: { path: "a.ts" } }], stop_reason: "tool_use" } },
      { type: "user", isCompactSummary: true, timestamp: "2026-10-22T10:00:02Z", message: { role: "user", content: summary } },
    ];
    for (const row of rows) parser.append(line(row));
    expect(parser.snapshot().meta.activity?.state).toBe("tool");
    expect(parser.snapshot().meta.sort_activity).toBe("2026-10-22T10:00:00Z");
    parser.append(line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "file contents" }] } }));
    const result = parser.snapshot();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].blocks[0].output).toBe("file contents");
    const flat = parseSessionText("claude", rows.map(line).join("\n"));
    expect(flat.meta.activity?.state).toBe("tool");
    expect(flat.meta.sort_activity).toBe("2026-10-22T10:00:00Z");
  });
});

// Shapes recorded by Claude Code 2.1.299–2.1.322 (2026-10/11): a prompt typed
// while the agent works, a multi-line paste, a background-task notice and a
// message from another agent session.
describe("Claude inputs that are not plain user lines", () => {
  const humanQueued = { type: "attachment", timestamp: "2026-11-12T16:22:54.836Z", attachment: {
    type: "queued_command", prompt: "忙碌中插入：完成后请再单独回复 BETA-2", commandMode: "prompt",
    origin: { kind: "human" }, humanTurn: true } };
  const rows = [
    { type: "user", origin: { kind: "human" }, message: { role: "user", content: "请运行这条计算" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "python3 -c 1" } }], stop_reason: "tool_use" } },
    { type: "queue-operation", operation: "enqueue", content: "忙碌中插入：完成后请再单独回复 BETA-2" },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-1", content: "1" }] } },
    { type: "queue-operation", operation: "remove", content: "忙碌中插入：完成后请再单独回复 BETA-2" },
    humanQueued,
    { type: "attachment", attachment: { type: "queued_command", prompt: "<task-notification>\n<task-id>b0</task-id>\n</task-notification>",
      commandMode: "task-notification", origin: { kind: "task-notification", producer: "session-task" } } },
    { type: "attachment", attachment: { type: "queued_command", prompt: "<cross-session-message from=\"uds:/tmp/cc-socks/1.sock\">hi</cross-session-message>",
      commandMode: "prompt", origin: { kind: "peer", name: "agentcc-06" } } },
    { type: "assistant", message: { role: "assistant", content: "DONE-2\n\nBETA-2", stop_reason: "end_turn" } },
    { type: "user", origin: { kind: "human" }, message: { role: "user",
      content: "\n\n<pasted_content id=\"c5ef\">\n第一行  \n    第二行\n</pasted_content id=\"c5ef\">\n" } },
    // Older/SDK transcripts carry no origin and may hold content blocks.
    { type: "attachment", attachment: { type: "queued_command", prompt: [{ type: "text", text: "开始干活" }], commandMode: "prompt" } },
  ].map(line).join("\n");

  it("shows the person's queued prompt where Claude read it, and nobody else's", () => {
    const rich = parseSessionRich("claude", rows);
    const flat = parseSessionText("claude", rows);
    const texts = rich.messages.map((message) => message.blocks.map((block) => block.text ?? block.tool).join(""));
    expect(texts).toEqual([
      "请运行这条计算", "Bash", "忙碌中插入：完成后请再单独回复 BETA-2", "DONE-2\n\nBETA-2", "第一行  \n    第二行", "开始干活",
    ]);
    expect(rich.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "user"]);
    expect(flat.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
      "请运行这条计算", "忙碌中插入：完成后请再单独回复 BETA-2", "第一行  \n    第二行", "开始干活",
    ]);
    expect(rich.meta.message_count).toBe(flat.meta.message_count);
  });

  it("keeps the paste wrapper out of what is shown", () => {
    const pasted = line({ type: "user", message: { role: "user", content: [
      { type: "text", text: "看这段：" },
      { type: "text", text: "<pasted_content id=\"a1\">\nline 1\nline 2\n</pasted_content id=\"a1\">" },
    ] } });
    expect(parseSessionRich("claude", pasted).messages[0]?.blocks[0]?.text).toBe("看这段：\nline 1\nline 2");
    expect(parseSessionText("claude", pasted).messages[0]?.text).toBe("看这段：\nline 1\nline 2");
  });
});

describe("Codex asynchronous question records", () => {
  const questions = [{ title: "选一个方案", options: ["甲", "乙"] }];
  const call = (id = "call-q", qs = questions) => ({ type: "response_item", payload: {
    type: "function_call", name: "functions.request_user_input_async", call_id: id,
    arguments: JSON.stringify({ questions: qs }),
  } });
  it("preserves native identity, long questions and immediate output without declaring an answer", () => {
    const qs = [{ title: "完整题目".repeat(700), options: ["保留最后的选项"] }];
    const { messages } = parseSessionRich("codex", [call("q-long", qs), { type: "response_item", payload: {
      type: "function_call_output", call_id: "q-long", output: "Question displayed",
    } }].map(line).join("\n"));
    expect(messages[0].blocks[0]).toMatchObject({ call_id: "q-long", output: "Question displayed" });
    expect(JSON.parse(messages[0].blocks[0].input!)).toEqual({ questions: qs });
    expect(messages[0].blocks[0].truncated).toBeUndefined();
  });
  it("does not duplicate the native agent message following a tool call", () => {
    const parsed = parseSessionRich("codex", [call(), { type: "event_msg", payload: {
      type: "agent_message", message: "请选方案", questions,
    } }].map(line).join("\n"));
    expect(parsed.messages.flatMap((message) => message.blocks).filter((block) => block.type === "tool")).toHaveLength(1);
  });
  it.each([true, false])("keeps question-only native messages with event/item mirroring (item first: %s)", (itemFirst) => {
    const event = { type: "event_msg", payload: { type: "agent_message", message: "", questions } };
    const item = { type: "response_item", payload: { type: "message", id: "native-message", role: "assistant", content: [], questions } };
    const rows = [{ type: "event_msg", payload: { type: "user_message", message: "start" } },
      ...(itemFirst ? [item, event] : [event, item])];
    const { messages } = parseSessionRich("codex", rows.map(line).join("\n"));
    const blocks = messages.flatMap((message) => message.blocks).filter((block) => block.type === "tool");
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(blocks[0].input!)).toEqual({ questions });
  });
  it("keeps repeated calls distinct and marks oversized questions as truncated", () => {
    const { messages } = parseSessionRich("codex", [call("q1"), call("q2"),
      call("huge", [{ title: "x".repeat(33_000), options: [] }])].map(line).join("\n"));
    expect(messages.map((m) => m.blocks[0].call_id)).toEqual(["q1", "q2", "huge"]);
    expect(messages[2].blocks[0].truncated).toBe(true);
    expect(messages[2].blocks[0].input!.length).toBeLessThanOrEqual(32_001);
  });
});

describe("rich conversation text", () => {
  const formats: Array<{
    name: string;
    source: Source;
    message(role: "user" | "assistant", text: string): unknown;
  }> = [
    {
      name: "Claude blocks", source: "claude",
      message: (role, text) => ({ type: role, message: { role, content: [{ type: "text", text }] } }),
    },
    {
      name: "Codex events", source: "codex",
      message: (role, text) => ({
        type: "event_msg", payload: { type: role === "user" ? "user_message" : "agent_message", message: text },
      }),
    },
    {
      name: "Codex items", source: "codex",
      message: (role, text) => ({
        type: "response_item",
        payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
      }),
    },
    {
      name: "OMP blocks", source: "omp",
      message: (role, text) => ({ type: "message", message: { role, content: [{ type: "text", text }] } }),
    },
    {
      name: "OMP string", source: "omp",
      message: (role, text) => ({ type: "message", message: { role, content: text } }),
    },
  ];

  for (const format of formats) {
    it.each(["user", "assistant"] as const)(`${format.name} preserves a long %s message through its final paragraph`, (role) => {
      // A Markdown fence straddles the former 20,000-character cutoff; neither
      // its closing fence nor the Unicode paragraph after it may disappear.
      const text = `${"正文🙂\n".repeat(3_990)}\n\`\`\`yaml\n${"targetPort: 8082\n".repeat(400)}\`\`\`\n\n最后一段：完整结论。`;
      const { messages } = parseSessionRich(format.source, line(format.message(role, text)));
      expect(messages).toHaveLength(1);
      expect(messages[0].blocks).toHaveLength(1);
      expect(messages[0].blocks[0].text?.length).toBe(text.length);
      expect(messages[0].blocks[0]).toEqual({ type: "text", text });
    });
  }
});

describe("parseSessionRich — claude", () => {
  const fixture = [
    line({ type: "summary", summary: "修复了一个 bug" }),
    line({
      type: "user",
      timestamp: "2026-07-20T10:00:00.000Z",
      cwd: "/home/u/proj",
      sessionId: "aaaa1111-0000-0000-0000-000000000000",
      gitBranch: "main",
      message: { role: "user", content: "帮我修 bug" },
    }),
    line({
      type: "assistant",
      timestamp: "2026-07-20T10:00:05.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "内部思考内容" },
          { type: "text", text: "我看一下" },
          { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
        ],
      },
    }),
    line({
      type: "user",
      timestamp: "2026-07-20T10:00:06.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "file1\nfile2" }] }],
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-07-20T10:00:08.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/x" } }],
      },
    }),
    line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu2", content: "no such file", is_error: true }],
      },
    }),
    line({ type: "user", message: { role: "user", content: "<system-reminder>噪声</system-reminder>" } }),
    line({
      type: "assistant",
      timestamp: "2026-07-20T10:00:10.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "完成了" }] },
    }),
  ].join("\n");

  const { meta, messages } = parseSessionRich("claude", fixture);

  it("keeps user text, assistant blocks in order; drops noise and result-only user lines", () => {
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    expect(messages[0].blocks).toEqual([{ type: "text", text: "帮我修 bug" }]);
    expect(messages[1].blocks.map((b) => b.type)).toEqual(["thinking", "text", "tool"]);
    expect(messages[1].blocks[0].text).toBe("内部思考内容");
  });

  it("pairs tool results (from later user lines) onto their tool_use blocks", () => {
    const bash = messages[1].blocks[2];
    expect(bash.tool).toBe("Bash");
    expect(bash.input).toBe('{"command":"ls"}');
    expect(bash.output).toBe("file1\nfile2");
    expect(bash.is_error).toBeUndefined();
    const read = messages[2].blocks[0];
    expect(read.output).toBe("no such file");
    expect(read.is_error).toBe(true);
  });

  it("fills meta including cwd, id, and timestamps", () => {
    expect(meta.id).toBe("aaaa1111-0000-0000-0000-000000000000");
    expect(meta.cwd).toBe("/home/u/proj");
    expect(meta.git_branch).toBe("main");
    expect(meta.message_count).toBe(4);
    expect(meta.started_at).toBe("2026-07-20T10:00:00.000Z");
    expect(meta.first_user_text).toBe("帮我修 bug");
  });

  it("caps oversized tool inputs and marks the block truncated", () => {
    const big = line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "Write", input: { content: "x".repeat(RICH_INPUT_CAP * 2) } }],
      },
    });
    const { messages: m } = parseSessionRich("claude", big);
    expect(m[0].blocks[0].truncated).toBe(true);
    expect((m[0].blocks[0].input ?? "").length).toBeLessThanOrEqual(RICH_INPUT_CAP + 1);
  });

  it("keeps Claude Code's isMeta injections out of the person's turns; a skill body becomes its Skill call's output", () => {
    const rows = [
      { type: "user", timestamp: "2026-10-18T10:00:00.000Z", message: { role: "user", content: "画一张图" } },
      { type: "assistant", timestamp: "2026-10-18T10:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "sk1", name: "Skill", input: { skill: "dataviz" } }] } },
      { type: "user", timestamp: "2026-10-18T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sk1", content: "Launching skill: dataviz" }] } },
      { type: "user", isMeta: true, sourceToolUseID: "sk1", timestamp: "2026-10-18T10:00:02.100Z",
        message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /tmp/skills/dataviz\n\n# Data Visualization" }] } },
      { type: "user", isMeta: true, timestamp: "2026-10-18T10:00:02.200Z", message: { role: "user", content: [{ type: "text", text: "展开后的命令模板" }] } },
      { type: "assistant", timestamp: "2026-10-18T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "图画好了" }], stop_reason: "end_turn" } },
    ].map(line).join("\n");
    const { meta, messages } = parseSessionRich("claude", rows);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[1].blocks[0]).toMatchObject({ tool: "Skill", output: "Launching skill: dataviz\n\nBase directory for this skill: /tmp/skills/dataviz\n\n# Data Visualization" });
    expect(meta.message_count).toBe(3);
    const flat = parseSessionText("claude", rows);
    expect(flat.messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["画一张图"]);
  });
});

describe("parseSessionRich — codex", () => {
  const fixture = [
    line({
      timestamp: "2026-07-20T11:00:00.000Z",
      type: "session_meta",
      payload: { id: "bbbb2222-0000-0000-0000-000000000000", cwd: "/home/u/api", cli_version: "0.9", git: { branch: "dev" } },
    }),
    line({ timestamp: "2026-07-20T11:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "跑一下测试" } }),
    line({ timestamp: "2026-07-20T11:00:02.000Z", type: "event_msg", payload: { type: "agent_reasoning", text: "先看看测试框架" } }),
    line({
      timestamp: "2026-07-20T11:00:03.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: '{"command":["pytest"]}', call_id: "c1" },
    }),
    line({
      timestamp: "2026-07-20T11:00:04.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c1", output: "3 passed" },
    }),
    line({ timestamp: "2026-07-20T11:00:05.000Z", type: "event_msg", payload: { type: "agent_message", message: "测试通过" } }),
    // parallel response_item message stream — must be deduped away
    line({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "测试通过" }] },
    }),
  ].join("\n");

  const { meta, messages } = parseSessionRich("codex", fixture);

  it("orders user / thinking / tool / assistant and dedups the item channel", () => {
    expect(messages.map((m) => m.blocks[0].type)).toEqual(["text", "thinking", "tool", "text"]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    expect(messages[3].blocks[0].text).toBe("测试通过");
  });

  it("pairs function_call_output onto the call via call_id", () => {
    const tool = messages[2].blocks[0];
    expect(tool.tool).toBe("shell");
    expect(tool.input).toBe('{"command":["pytest"]}');
    expect(tool.output).toBe("3 passed");
  });

  it("meta comes from session_meta", () => {
    expect(meta.id).toBe("bbbb2222-0000-0000-0000-000000000000");
    expect(meta.cwd).toBe("/home/u/api");
    expect(meta.git_branch).toBe("dev");
  });

  it("uses the same parent-owned metadata rule as the flat parser", () => {
    const child = parseSessionRich("codex", line({
      type: "session_meta",
      payload: {
        id: "child-rich",
        parent_thread_id: "parent-rich",
        thread_source: "subagent",
        multi_agent_version: "v2",
      },
    }));
    expect(child.meta).toMatchObject({
      input_mode: "parent_owned",
      parent_session_id: "parent-rich",
    });
  });
});

describe("readSession rich paging", () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "rich-scan-"));
    const dir = join(home, ".claude", "projects", "-home-u-proj");
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(
        line({
          type: "user",
          timestamp: `2026-07-20T10:0${i}:00.000Z`,
          sessionId: "cccc3333-0000-0000-0000-000000000000",
          cwd: "/home/u/proj",
          message: { role: "user", content: `问题 ${i}` },
        }),
        line({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: `回答 ${i}` }] },
        }),
      );
    }
    writeFileSync(join(dir, "cccc3333-0000-0000-0000-000000000000.jsonl"), lines.join("\n"));
  });

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("defaults to the latest page; explicit offset pages from the start", async () => {
    const tail = (await readSession(home, { id: "cccc3333", rich: true, max_messages: 6 })) as {
      rich: boolean;
      total_messages: number;
      offset: number;
      messages: Array<{ role: string; blocks: Array<{ text?: string }> }>;
    };
    expect(tail.rich).toBe(true);
    expect(tail.total_messages).toBe(20);
    expect(tail.offset).toBe(14);
    expect(tail.messages).toHaveLength(6);
    expect(tail.messages.at(-1)!.blocks[0].text).toBe("回答 9");

    const head = (await readSession(home, { id: "cccc3333", rich: true, offset: 0, max_messages: 4 })) as {
      offset: number;
      messages: Array<{ blocks: Array<{ text?: string }> }>;
    };
    expect(head.offset).toBe(0);
    expect(head.messages[0].blocks[0].text).toBe("问题 0");
    expect(head.messages).toHaveLength(4);
  });

  it("clamps out-of-range offsets instead of erroring", async () => {
    const past = (await readSession(home, { id: "cccc3333", rich: true, offset: 999, max_messages: 5 })) as {
      offset: number;
      returned_messages: number;
    };
    expect(past.offset).toBe(20);
    expect(past.returned_messages).toBe(0);
  });

  it("pasted images become inline markers, not base64 payloads", () => {
    const fixture = [
      line({
        type: "user",
        timestamp: "2026-07-20T12:00:00.000Z",
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(200_000) } },
            { type: "text", text: "看这个截图" },
          ],
        },
      }),
      // image-only paste: must still show up as a turn instead of vanishing
      line({
        type: "user",
        timestamp: "2026-07-20T12:01:00.000Z",
        message: {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "B".repeat(100) } }],
        },
      }),
    ].join("\n");
    const { messages: m } = parseSessionRich("claude", fixture);
    expect(m).toHaveLength(2);
    expect(m[0].blocks[0].text).toBe("🖼 [图片]\n看这个截图");
    expect(m[1].blocks[0].text).toBe("🖼 [图片]");
    // the base64 itself must never reach the payload
    expect(JSON.stringify(m)).not.toContain("AAAA");
  });

  it("flat mode is unchanged (no rich flag → legacy shape)", async () => {
    const flat = (await readSession(home, { id: "cccc3333", max_messages: 5 })) as {
      rich?: boolean;
      truncated: boolean;
      messages: Array<{ role: string; text: string }>;
    };
    expect(flat.rich).toBeUndefined();
    expect(flat.truncated).toBe(true);
    expect(flat.messages).toHaveLength(5);
    expect(flat.messages.at(-1)!.text).toBe("回答 9");
  });
});
