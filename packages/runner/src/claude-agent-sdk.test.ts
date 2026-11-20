import { describe, expect, it } from "vitest";
import { AgentInteractionBroker } from "./agent-interactions.js";
import { ClaudeManagedSession } from "./claude-agent-sdk.js";

describe("Claude managed turn protocol", () => {
  it("streams the person's input and reports provider usage", async () => {
    let submitted: Record<string, unknown> | undefined;
    const session = new ClaudeManagedSession({
      sessionId: "session-streaming",
      cwd: "/tmp",
      interactions: new AgentInteractionBroker(),
      timeoutMs: 2_000,
      resume: true,
      queryFactory: ({ prompt }) => ({
        close: () => {},
        async *[Symbol.asyncIterator]() {
          for await (const row of prompt) {
            submitted = row;
            yield {
              type: "result",
              subtype: "success",
              result: "streamed",
              session_id: "session-streaming",
              usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 },
            };
          }
        },
      }),
    });
    await expect(session.dispatch("ask me in the browser").completion).resolves.toMatchObject({
      ok: true,
      resultText: "streamed",
      usage: { tokens_in: 12, tokens_out: 3, tokens_cached: 5 },
    });
    expect(submitted).toEqual({
      type: "user",
      session_id: "session-streaming",
      message: { role: "user", content: [{ type: "text", text: "ask me in the browser" }] },
      parent_tool_use_id: null,
      priority: "next",
    });
    await session.close();
  });

  it("round-trips AskUserQuestion answers through the broker", async () => {
    const interactions = new AgentInteractionBroker({ managedTtlMs: 2_000 });
    let toolResult: Record<string, unknown> | undefined;
    const session = new ClaudeManagedSession({
      sessionId: "session-1",
      cwd: "/tmp",
      interactions,
      timeoutMs: 2_000,
      resume: true,
      queryFactory: ({ prompt, options }) => ({
        close: () => {},
        async *[Symbol.asyncIterator]() {
          for await (const row of prompt) {
            void row;
            const callback = options.canUseTool as (
              tool: string,
              input: Record<string, unknown>,
            ) => Promise<Record<string, unknown>>;
            toolResult = await callback("AskUserQuestion", {
              questions: [{
                header: "Scope",
                question: "Which scope?",
                options: [{ label: "Small", description: "Minimal change" }],
                multiSelect: false,
              }],
            });
            yield { type: "result", subtype: "success", result: "continued", session_id: "session-1" };
          }
        },
      }),
    });
    const turn = session.dispatch("ask me");
    const shown = await waitFor(() => interactions.publicInteraction("claude", "session-1"));
    interactions.respond({
      provider: "claude",
      session_id: "session-1",
      interaction_id: shown.id,
      response_json: JSON.stringify({ decision: "allow", answers: { question_1: ["Small"] } }),
    });
    await expect(turn.completion).resolves.toMatchObject({ ok: true, resultText: "continued" });
    expect(toolResult).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Which scope?": "Small" } },
    });
    await session.close();
  });
});

describe("Claude managed attachment", () => {
  it("keeps the parent attached after an empty result until background subagents settle", async () => {
    const received: Array<Record<string, unknown>> = [];
    const snapshots: Array<readonly { taskId: string }[]> = [];
    const session = new ClaudeManagedSession({
      sessionId: "session-team",
      cwd: "/tmp",
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      resume: true,
      onBackgroundTasksChanged: (tasks) => {
        snapshots.push(tasks.map(({ taskId }) => ({ taskId })));
      },
      queryFactory: ({ prompt }) => ({
        close: () => {},
        async *[Symbol.asyncIterator]() {
          for await (const message of prompt) {
            received.push(message);
            if (received.length === 1) {
              yield {
                type: "system",
                subtype: "task_started",
                task_id: "research-agent",
                tool_use_id: "tool-1",
                description: "检索相关工作",
                prompt: "must not be persisted",
              };
              yield {
                type: "result",
                subtype: "success",
                result: "",
                session_id: "session-team",
              };
              yield {
                type: "system",
                subtype: "task_notification",
                task_id: "research-agent",
                status: "completed",
                output_file: "/tmp/private-output",
              };
              continue;
            }
            yield {
              type: "result",
              subtype: "success",
              result: "相关工作和执行计划均已完成",
              session_id: "session-team",
            };
          }
        },
      }),
    });

    const turn = session.dispatch("完成整份研究计划");
    await expect(turn.completion).resolves.toMatchObject({
      ok: true,
      resultText: "相关工作和执行计划均已完成",
    });
    expect(received).toHaveLength(2);
    expect(received.map((row) => row.priority)).toEqual(["next", "next"]);
    expect(received[1]).toMatchObject({
      message: {
        content: [{ text: expect.stringContaining("[Octopus 自动续接]") }],
      },
    });
    expect(snapshots).toEqual([[{ taskId: "research-agent" }], []]);
    await session.close();
  });

  it("lets a newer person prompt replace the automatic post-subagent wake-up", async () => {
    const received: Array<Record<string, unknown>> = [];
    let notifySettled!: () => void;
    const settled = new Promise<void>((resolve) => { notifySettled = resolve; });
    let notifyParentReturned!: () => void;
    const parentReturned = new Promise<void>((resolve) => { notifyParentReturned = resolve; });
    const session = new ClaudeManagedSession({
      sessionId: "session-team-steer",
      cwd: "/tmp",
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      resume: true,
      queryFactory: ({ prompt }) => ({
        close: () => {},
        async *[Symbol.asyncIterator]() {
          for await (const message of prompt) {
            received.push(message);
            if (received.length === 1) {
              yield { type: "system", subtype: "task_started", task_id: "agent-1" };
              yield {
                type: "result",
                subtype: "success",
                result: "后台仍在运行",
                session_id: "session-team-steer",
              };
              notifyParentReturned();
              await settled;
              yield {
                type: "system",
                subtype: "task_notification",
                task_id: "agent-1",
                status: "completed",
              };
              continue;
            }
            yield {
              type: "result",
              subtype: "success",
              result: "按用户的新要求完成",
              session_id: "session-team-steer",
            };
          }
        },
      }),
    });

    const first = session.dispatch("开始");
    await parentReturned;
    const newer = session.dispatch("同时补上风险分析");
    expect(newer.completion).toBe(first.completion);
    notifySettled();
    await expect(first.completion).resolves.toMatchObject({ resultText: "按用户的新要求完成" });
    expect(received).toHaveLength(2);
    expect(received.map((row) => row.priority)).toEqual(["next", "next"]);
    expect(received[1]).toMatchObject({
      message: { content: [{ text: "同时补上风险分析" }] },
    });
    await session.close();
  });

  it("reports an empty SDK success as a terminal failure", async () => {
    const session = new ClaudeManagedSession({
      sessionId: "session-empty",
      cwd: "/tmp",
      interactions: new AgentInteractionBroker(),
      timeoutMs: 2_000,
      resume: true,
      queryFactory: () => fakeQuery(async () => ({
        type: "result",
        subtype: "success",
        result: "   ",
        session_id: "session-empty",
      })),
    });

    await expect(session.dispatch("continue").completion).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/未返回 Agent 正文.*不能安全自动重试/),
    });
    await session.close();
  });

  it("uses streaming priority=now input to steer one in-flight turn", async () => {
    const interactions = new AgentInteractionBroker();
    const received: Array<Record<string, unknown>> = [];
    let sdkOptions: Record<string, unknown> | undefined;
    const session = new ClaudeManagedSession({
      sessionId: "session-steer",
      cwd: "/tmp",
      interactions,
      timeoutMs: 5_000,
      resume: true,
      queryFactory: ({ prompt, options }) => {
        sdkOptions = options;
        return {
          close: () => {},
          async *[Symbol.asyncIterator]() {
            for await (const message of prompt) {
              received.push(message);
              if (received.length < 2) continue;
              yield { type: "result", subtype: "success", result: "steered", session_id: "session-steer" };
            }
          },
        };
      },
    });
    const first = session.dispatch("first");
    const second = session.dispatch("extra context");
    expect(first.kind).toBe("started");
    expect(second.kind).toBe("steered");
    expect(second.completion).toBe(first.completion);
    await expect(first.completion).resolves.toMatchObject({ ok: true, resultText: "steered" });
    expect(received.map((row) => row.priority)).toEqual(["next", "now"]);
    expect(sdkOptions).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    expect(typeof sdkOptions?.canUseTool).toBe("function");
    await session.close();
  });

  it("exposes only the scoped MCP server for split execution", async () => {
    let sdkOptions: Record<string, unknown> | undefined;
    const session = new ClaudeManagedSession({
      sessionId: "session-split",
      cwd: "/tmp/control",
      interactions: new AgentInteractionBroker(),
      timeoutMs: 2_000,
      resume: false,
      remoteMcpUrl: "http://127.0.0.1:4321/session/x/mcp",
      developmentMcpUrl: "http://127.0.0.1:4322/session/y/mcp",
      queryFactory: ({ options }) => {
        sdkOptions = options;
        return fakeQuery(async () => ({
          type: "result",
          subtype: "success",
          result: "done",
          session_id: "session-split",
        }));
      },
    });
    await expect(session.dispatch("work").completion).resolves.toMatchObject({ ok: true });
    expect(sdkOptions).toMatchObject({
      cwd: "/tmp/control",
      tools: [],
      // No filesystem settings (hooks, CLAUDE.md, enabled plugins) and no plugins, whatever the SDK's defaults become.
      settingSources: [],
      plugins: [],
      strictMcpConfig: true,
      mcpServers: {
        octopus_execution: {
          type: "http",
          url: "http://127.0.0.1:4321/session/x/mcp",
        },
        octopus_devpipe: { type: "http", url: "http://127.0.0.1:4322/session/y/mcp" },
      },
    });
    await session.close();
  });

  it("keeps a manual attachment on the SDK's normal permission mode", async () => {
    const interactions = new AgentInteractionBroker();
    let sdkOptions: Record<string, unknown> | undefined;
    const session = new ClaudeManagedSession({
      sessionId: "session-manual-attachment",
      cwd: "/tmp",
      interactions,
      timeoutMs: 5_000,
      resume: true,
      permissionProfile: "manual",
      queryFactory: ({ options }) => {
        sdkOptions = options;
        return fakeQuery(async () => ({
          type: "result",
          subtype: "success",
          result: "manual",
          session_id: "session-manual-attachment",
        }));
      },
    });

    await expect(session.dispatch("work").completion).resolves.toMatchObject({ ok: true });
    expect(sdkOptions).toMatchObject({ permissionMode: "default" });
    expect(sdkOptions).not.toHaveProperty("allowDangerouslySkipPermissions");
    // An owner's ordinary session keeps the login's own connectors.
    expect(sdkOptions).not.toHaveProperty("strictMcpConfig");
    await session.close();
  });

  it("uses the SDK interrupt control request", async () => {
    const interactions = new AgentInteractionBroker();
    let interrupted = 0;
    const session = new ClaudeManagedSession({
      sessionId: "session-interrupt",
      cwd: "/tmp",
      interactions,
      timeoutMs: 5_000,
      resume: true,
      queryFactory: () => ({
        interrupt: async () => { interrupted += 1; },
        close: () => {},
        async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
      }),
    });
    const turn = session.dispatch("work");
    await session.interrupt();
    expect(interrupted).toBe(1);
    await expect(turn.completion).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/中断/) });
    await session.close();
  });

  it("leaves a managed turn running when its wall-clock timeout is disabled", async () => {
    const interactions = new AgentInteractionBroker();
    let finishProvider!: () => void;
    const providerFinished = new Promise<void>((resolve) => { finishProvider = resolve; });
    let interrupted = 0;
    const session = new ClaudeManagedSession({
      sessionId: "session-long-running",
      cwd: "/tmp",
      interactions,
      timeoutMs: 0,
      resume: true,
      queryFactory: () => ({
        interrupt: async () => { interrupted += 1; },
        close: () => {},
        async *[Symbol.asyncIterator]() {
          await providerFinished;
          yield {
            type: "result",
            subtype: "success",
            result: "eventually done",
            session_id: "session-long-running",
          };
        },
      }),
    });

    const turn = session.dispatch("take as long as needed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.turnActive).toBe(true);
    expect(interrupted).toBe(0);

    finishProvider();
    await expect(turn.completion).resolves.toMatchObject({ ok: true, resultText: "eventually done" });
    await session.close();
  });
});

function fakeQuery(
  produce: () => Promise<Record<string, unknown>>,
): AsyncIterable<Record<string, unknown>> & { close(): void } {
  let closed = false;
  return {
    close: () => { closed = true; },
    async *[Symbol.asyncIterator]() {
      const row = await produce();
      if (!closed) yield row;
    },
  };
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for interaction");
}
