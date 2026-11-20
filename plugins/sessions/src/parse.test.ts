import { describe, it, expect } from "vitest";
import {
  parseSessionText,
  createSessionSummaryParser,
  classifyContent,
  isNoiseText,
  deriveIdFromPath,
  truncate,
  safeJsonParse,
} from "./parse.js";

// ---------------------------------------------------------------------------
// Inline fixtures — real-ish JSONL bytes, including deliberate garbage.
// ---------------------------------------------------------------------------

// Claude Code: mixes non-message lines, a string-content user turn, a
// command-wrapper noise turn, block-array assistant turns (text / tool_use),
// a tool_result-only user turn, a malformed line and a blank line.
const CLAUDE_JSONL = [
  `{"type":"mode","mode":"default","sessionId":"abc123"}`,
  `{"type":"file-history-snapshot","messageId":"m1","snapshot":{}}`,
  `{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"},"timestamp":"2026-07-15T07:00:00.000Z","cwd":"/home/ubuntu/proj","sessionId":"abc123","gitBranch":"main","version":"2.0.1"}`,
  `{"type":"user","message":{"role":"user","content":"帮我修复登录 bug"},"timestamp":"2026-07-15T07:01:00.000Z"}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"让我想想"},{"type":"text","text":"好的，我来看看"}]},"timestamp":"2026-07-15T07:02:00.000Z"}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"先运行测试"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-07-15T07:03:00.000Z"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file list output"}]},"timestamp":"2026-07-15T07:04:00.000Z"}`,
  `{ this is not valid json at all`,
  ``,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Read","input":{}}]},"timestamp":"2026-07-15T07:05:00.000Z"}`,
].join("\n");

// Codex: session_meta + event_msg user/agent messages + a parallel
// response_item message stream (should be deduped away) + a tool call + a
// garbage line + an ignored token_count.
const CODEX_JSONL = [
  `{"timestamp":"2026-07-10T09:43:23.357Z","type":"session_meta","payload":{"id":"019f4b69-0bcb-7853-8cb1-83fe1f94b4f3","session_id":"019f4b69-0bcb-7853-8cb1-83fe1f94b4f3","cwd":"/home/ubuntu/lht/agentos","cli_version":"0.144.1","git":{"branch":"master"}}}`,
  `{"timestamp":"2026-07-10T09:43:45.152Z","type":"event_msg","payload":{"type":"user_message","message":"如何关闭权限检查"}}`,
  `{"timestamp":"2026-07-10T09:43:45.146Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\\n<cwd>/x</cwd>"}]}}`,
  `{"timestamp":"2026-07-10T09:44:22.631Z","type":"event_msg","payload":{"type":"agent_message","message":"我先查一下 Codex CLI 帮助"}}`,
  `{"timestamp":"2026-07-10T09:44:22.956Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c1"}}`,
  `total-garbage-line-not-json`,
  `{"timestamp":"2026-07-10T09:44:30.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total":10}}}`,
].join("\n");

// Codex variant with only the response_item message stream (no event_msg).
const CODEX_ITEM_ONLY = [
  `{"timestamp":"2026-01-01T00:00:00.000Z","type":"session_meta","payload":{"id":"item-uuid","cwd":"/tmp/x"}}`,
  `{"timestamp":"2026-01-01T00:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"只有 item 通道的问题"}]}}`,
  `{"timestamp":"2026-01-01T00:00:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"item 通道的回答"}]}}`,
].join("\n");

// ---------------------------------------------------------------------------

describe("safeJsonParse", () => {
  it("returns null for blank / malformed lines, object for valid", () => {
    expect(safeJsonParse("")).toBeNull();
    expect(safeJsonParse("   ")).toBeNull();
    expect(safeJsonParse("{ not json")).toBeNull();
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("classifyContent", () => {
  it("handles a plain string", () => {
    const info = classifyContent("hello world");
    expect(info).toMatchObject({ text: "hello world", hasText: true, hasToolResult: false });
    expect(info.tools).toEqual([]);
  });

  it("flattens a block array with text + tool_use", () => {
    const info = classifyContent([
      { type: "thinking", thinking: "internal" },
      { type: "text", text: "line one" },
      { type: "tool_use", id: "x", name: "Bash", input: { command: "ls" } },
    ]);
    expect(info.text).toBe("line one"); // thinking omitted
    expect(info.tools).toEqual(["Bash"]);
    expect(info.hasText).toBe(true);
  });

  it("detects tool_result blocks without inlining their payload", () => {
    const info = classifyContent([{ type: "tool_result", tool_use_id: "t1", content: "big output" }]);
    expect(info.hasToolResult).toBe(true);
    expect(info.hasText).toBe(false);
    expect(info.text).toBe("");
  });

  it("treats codex input_text / output_text as text", () => {
    expect(classifyContent([{ type: "output_text", text: "答复" }]).text).toBe("答复");
  });

  it("never throws on junk shapes", () => {
    expect(() => classifyContent(null)).not.toThrow();
    expect(() => classifyContent(42)).not.toThrow();
    expect(classifyContent([null, 1, "x", { no: "type" }]).text).toBe("");
  });
});

describe("isNoiseText", () => {
  it("flags command wrappers and injected context blocks", () => {
    expect(isNoiseText("<command-name>/clear</command-name>")).toBe(true);
    expect(isNoiseText("<local-command-caveat>...")).toBe(true);
    expect(isNoiseText("<environment_context>")).toBe(true);
    expect(isNoiseText("<task-notification>\n<task-id>x</task-id>")).toBe(true);
    expect(isNoiseText("帮我修复 bug")).toBe(false);
  });
});

describe("parseSessionText — Claude", () => {
  const parsed = parseSessionText("claude", CLAUDE_JSONL);

  it("skips non-message / noise / tool_result lines, keeps real turns", () => {
    // real user + assistant(text) + assistant(text+Bash) + assistant(Read)
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.meta.message_count).toBe(4);
  });

  it("keeps a string-content user turn as first_user_text", () => {
    expect(parsed.messages[0]).toEqual({ role: "user", text: "帮我修复登录 bug" });
    expect(parsed.meta.first_user_text).toBe("帮我修复登录 bug");
  });

  it("flattens a block array assistant turn to text", () => {
    expect(parsed.messages[1]).toEqual({ role: "assistant", text: "好的，我来看看" });
  });

  it("compresses tool_use into a `tool` summary", () => {
    expect(parsed.messages[2]).toEqual({ role: "assistant", text: "先运行测试", tool: "Bash" });
    expect(parsed.messages[3]).toEqual({ role: "assistant", text: "", tool: "Read" });
  });

  it("captures meta from surrounding fields", () => {
    expect(parsed.meta.cwd).toBe("/home/ubuntu/proj");
    expect(parsed.meta.git_branch).toBe("main");
    expect(parsed.meta.version).toBe("2.0.1");
    expect(parsed.meta.started_at).toBe("2026-07-15T07:00:00.000Z");
    expect(parsed.meta.last_activity).toBe("2026-07-15T07:05:00.000Z");
  });

  it("preview is the last turn carrying real text (not the tool-only turn)", () => {
    expect(parsed.meta.preview).toBe("先运行测试");
  });

  it("never crashes on the malformed / blank lines", () => {
    expect(() => parseSessionText("claude", CLAUDE_JSONL)).not.toThrow();
  });

  it("names the chat as Claude Code does: the latest --name or /rename, else the generated title", () => {
    const records = [
      { type: "ai-title", aiTitle: "修复登录", sessionId: "abc123" },
      { type: "user", message: { role: "user", content: "帮我修复登录 bug" }, timestamp: "2026-07-15T07:01:00.000Z", sessionId: "abc123" },
      { type: "custom-title", customTitle: "旧名字", sessionId: "abc123" },
      { type: "custom-title", customTitle: "ACC理论 · Opus5.5 max · 逐项讨论", sessionId: "abc123" },
    ];
    const text = records.map((record) => JSON.stringify(record)).join("\n");
    const roster = createSessionSummaryParser("claude");
    roster.append(records);
    expect(parseSessionText("claude", text).meta).toMatchObject({ title: "ACC理论 · Opus5.5 max · 逐项讨论", message_count: 1 });
    expect(roster.snapshot()).toMatchObject({ title: "ACC理论 · Opus5.5 max · 逐项讨论", message_count: 1 });
    expect(parseSessionText("claude", records.slice(0, 2).map((record) => JSON.stringify(record)).join("\n")).meta.title).toBe("修复登录");
    expect(parsed.meta.title).toBeUndefined();
  });
});

describe("parseSessionText — Codex", () => {
  const parsed = parseSessionText("codex", CODEX_JSONL);

  it("uses the event channel and dedups the response_item message stream", () => {
    expect(parsed.messages).toEqual([
      { role: "user", text: "如何关闭权限检查" },
      { role: "assistant", text: "我先查一下 Codex CLI 帮助" },
      { role: "assistant", text: "", tool: "exec" },
    ]);
    expect(parsed.meta.message_count).toBe(3);
  });

  it("reads meta from session_meta", () => {
    expect(parsed.meta.id).toBe("019f4b69-0bcb-7853-8cb1-83fe1f94b4f3");
    expect(parsed.meta.cwd).toBe("/home/ubuntu/lht/agentos");
    expect(parsed.meta.git_branch).toBe("master");
    expect(parsed.meta.version).toBe("0.144.1");
    expect(parsed.meta.first_user_text).toBe("如何关闭权限检查");
    expect(parsed.meta.started_at).toBe("2026-07-10T09:43:23.357Z");
  });

  it("marks only declared multi-agent v2 thread-spawn children as parent-owned", () => {
    const child = parseSessionText("codex", JSON.stringify({
      timestamp: "2026-08-30T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "thread-child",
        multi_agent_version: "v2",
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: "thread-parent", depth: 1, agent_path: "/root/worker" },
          },
        },
      },
    }));
    expect(child.meta).toMatchObject({
      input_mode: "parent_owned",
      parent_session_id: "thread-parent",
    });

    const uncertain = parseSessionText("codex", JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-unknown", parent_thread_id: "thread-parent" },
    }));
    expect(uncertain.meta).not.toHaveProperty("input_mode");
    expect(uncertain.meta).not.toHaveProperty("parent_session_id");
  });

  it("marks only the provider's explicit exec source as background execution", () => {
    for (const source of ["exec", "cli", "vscode"]) {
      const parsed = parseSessionText("codex", JSON.stringify({ type: "session_meta", payload: { id: "run", source } }));
      expect(parsed.meta.execution_mode).toBe(source === "exec" ? "exec" : undefined);
    }
  });

  it("classifies exec runs and their harness forks by the native originator", () => {
    const meta = (payload: Record<string, unknown>) =>
      parseSessionText("codex", JSON.stringify({ type: "session_meta", payload: { id: "run", ...payload } })).meta;
    // `codex exec` and a fork it made with `exec resume` (recorded as vscode).
    expect(meta({ source: "exec", originator: "codex_exec", thread_source: "user" }).execution_mode).toBe("exec");
    expect(meta({ source: "vscode", originator: "codex_exec", forked_from_id: "parent" }).execution_mode).toBe("exec");
    // An Octopus-managed or TUI chat is interactive even when it is a fork.
    expect(meta({ source: "vscode", originator: "octopus_runner" })).not.toHaveProperty("execution_mode");
    expect(meta({ source: "cli", originator: "codex-tui", forked_from_id: "parent" })).not.toHaveProperty("execution_mode");
    expect(meta({ source: "cli", originator: "codex_cli_rs" })).not.toHaveProperty("execution_mode");
  });

  it("retains legacy Codex spawn lineage without inventing a direct-input prohibition", () => {
    const child = parseSessionText("codex", JSON.stringify({
      type: "session_meta", payload: {
        id: "legacy-child", source: { subagent: { spawn: { parent_thread_id: "parent" } } },
      },
    }));
    expect(child.meta).toMatchObject({ is_subagent: true, parent_session_id: "parent" });
    expect(child.meta).not.toHaveProperty("input_mode");
  });

  it("names native children by their own task instead of the copied parent prompt", () => {
    const text = [
      { type: "session_meta", payload: { id: "child", multi_agent_version: "v2",
        source: { subagent: { thread_spawn: { parent_thread_id: "parent", agent_path: "/root/review_slides", agent_nickname: "Franklin" } } } } },
      { type: "event_msg", payload: { type: "user_message", message: "Parent's earlier discussion" } },
      { type: "event_msg", payload: { type: "agent_message", message: "Child's review result" } },
    ].map((value) => JSON.stringify(value)).join("\n");
    const parsed = parseSessionText("codex", text);
    expect(parsed.meta.title).toBe("review_slides · Franklin");
    expect(parsed.meta.parent_session_id).toBe("parent");
    expect(parsed.messages).toHaveLength(2);
  });

  it("leaves forks and conflicting native lineage unclassified", () => {
    for (const payload of [
      { id: "fork", source: "vscode", forked_from_id: "parent", multi_agent_version: "v2" },
      { id: "interactive", source: "cli", parent_thread_id: "parent", thread_source: "subagent", multi_agent_version: "v2" },
      { id: "conflicting", parent_thread_id: "wrong-parent", source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } },
    ]) {
      const parsed = parseSessionText("codex", JSON.stringify({ type: "session_meta", payload }));
      expect(parsed.meta).not.toHaveProperty("is_subagent");
      expect(parsed.meta).not.toHaveProperty("parent_session_id");
    }
  });

  it("falls back to the response_item message stream when no event channel exists", () => {
    const p = parseSessionText("codex", CODEX_ITEM_ONLY);
    expect(p.messages).toEqual([
      { role: "user", text: "只有 item 通道的问题" },
      { role: "assistant", text: "item 通道的回答" },
    ]);
    expect(p.meta.first_user_text).toBe("只有 item 通道的问题");
  });

  it("skips the codex AGENTS.md preamble in the item stream (real-world 0.144 shape)", () => {
    // Real 2026-08 codex logs: no event_msg/user_message at all, and the
    // item stream leads with an auto-injected AGENTS.md preamble as a
    // role=user block, followed by the actual user prompt. The list must
    // treat the preamble as noise so the roster shows the real question.
    const AGENTS_LEAK = [
      `{"timestamp":"2026-08-10T01:50:52.000Z","type":"session_meta","payload":{"id":"019fe95d-958d-7c43-ae26-db63b454d21a","cwd":"/home/ubuntu"}}`,
      `{"timestamp":"2026-08-10T01:50:53.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"You are the primary agent"}]}}`,
      `{"timestamp":"2026-08-10T01:50:54.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /home/ubuntu\\n\\n<INSTRUCTIONS>\\n# 机器环境与安全\\n公网 IP 203.0.113.8"}]}}`,
      `{"timestamp":"2026-08-10T01:50:55.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"我听到一个概念，叫做samll step。给我介绍一下。"}]}}`,
      `{"timestamp":"2026-08-10T01:50:56.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"你听到的应该是 small-step semantics"}]}}`,
    ].join("\n");
    const p = parseSessionText("codex", AGENTS_LEAK);
    expect(p.meta.first_user_text).toBe("我听到一个概念，叫做samll step。给我介绍一下。");
    expect(p.messages[0]).toEqual({ role: "user", text: "我听到一个概念，叫做samll step。给我介绍一下。" });
  });

  it("skips other codex item-stream noise wrappers (codex_internal_context, recommended_plugins, bare INSTRUCTIONS)", () => {
    // Prefix-only sanity check for isNoiseText on codex-emitted wrappers
    // we've observed in the wild; keeps the roster from picking any of
    // these up as the session title.
    expect(isNoiseText("<INSTRUCTIONS>\n<cwd>/x</cwd>\n</INSTRUCTIONS>")).toBe(true);
    expect(isNoiseText('<codex_internal_context source="goal">\nCollab plan\n</codex_internal_context>')).toBe(true);
    expect(isNoiseText("<recommended_plugins>\nHere is a list\n</recommended_plugins>")).toBe(true);
    expect(isNoiseText("# AGENTS.md instructions for /home/x")).toBe(true);
    // Case-insensitive (codex writes mixed case)
    expect(isNoiseText("# agents.md instructions")).toBe(true);
    // Real user prompts that happen to start with '<' or '#' must NOT be flagged
    expect(isNoiseText("<div> 这段代码怎么用？")).toBe(false);
    expect(isNoiseText("# 我的问题：怎么升级 aws 实例？")).toBe(false);
  });
});

describe("deriveIdFromPath", () => {
  it("claude: filename stem", () => {
    expect(deriveIdFromPath("claude", "/x/.claude/projects/-home-x/abc-123-def.jsonl")).toBe("abc-123-def");
  });
  it("codex: uuid embedded in rollout filename", () => {
    expect(
      deriveIdFromPath(
        "codex",
        "/x/.codex/sessions/2026/07/10/rollout-2026-07-10T09-43-23-019f4b69-0bcb-7853-8cb1-83fe1f94b4f3.jsonl",
      ),
    ).toBe("019f4b69-0bcb-7853-8cb1-83fe1f94b4f3");
  });
});

describe("truncate", () => {
  it("adds ellipsis only when longer than the limit", () => {
    expect(truncate("short", 120)).toBe("short");
    expect(truncate("x".repeat(130), 120)).toBe("x".repeat(120) + "…");
  });
});

describe("all-garbage input", () => {
  it("yields an empty transcript without throwing", () => {
    const p = parseSessionText("claude", "garbage\n{bad json\n\n\nmore junk");
    expect(p.messages).toEqual([]);
    expect(p.meta.message_count).toBe(0);
    expect(p.meta.first_user_text).toBeUndefined();
  });
});
