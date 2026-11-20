import { describe, expect, it } from "vitest";
import { AgentLoop, safeArguments, TOOL_RESULT_WINDOW_CHARS, type LoopToolResult } from "./loop.js";

function response(message: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message }] }),
  } as unknown as Response;
}

function scripted(steps: Array<Record<string, unknown> | (() => Response)>) {
  const seen: Array<Record<string, unknown>> = [];
  const impl = (async (_url: string, init: { body: string }) => {
    seen.push(JSON.parse(init.body) as Record<string, unknown>);
    const step = steps.shift();
    if (typeof step === "function") return step();
    return response(step ?? { content: "(空)" });
  }) as unknown as typeof globalThis.fetch;
  return { impl, seen };
}

function loop(steps: Array<Record<string, unknown> | (() => Response)>, maxToolTurns?: number) {
  const fetch = scripted(steps);
  return {
    fetch,
    agent: new AgentLoop({ baseUrl: "http://llm.invalid/v1", apiKey: "k", fetchImpl: fetch.impl, maxToolTurns }),
  };
}

const TOOLS = [{ name: "ping", description: "ping", parameters: { type: "object", properties: {} } }];

function call(name: string, args: Record<string, unknown> | string) {
  return {
    content: null,
    tool_calls: [{
      id: "c1",
      type: "function",
      function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
    }],
  };
}

describe("AgentLoop", () => {
  it("returns the assistant text when the model stops calling tools", async () => {
    const { agent, fetch } = loop([{ content: "做完了" }]);
    const out = await agent.run({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS,
      callTool: async () => ({ text: "unused" }),
      model: "m",
      effort: "high",
    });
    expect(out).toMatchObject({ kind: "done", text: "做完了", toolCalls: 0 });
    expect(fetch.seen[0]).toMatchObject({ model: "m", reasoning_effort: "high", tool_choice: "auto" });
    expect((fetch.seen[0]!.messages as Array<{ role: string }>)[0]).toMatchObject({ role: "system" });
  });

  it("feeds every tool result back and keeps going", async () => {
    const { agent, fetch } = loop([call("ping", { a: 1 }), { content: "好了" }]);
    const asked: string[] = [];
    const out = await agent.run({
      systemPrompt: "sys",
      messages: [],
      tools: TOOLS,
      callTool: async (name) => {
        asked.push(name);
        return { text: "pong" };
      },
      model: "m",
    });
    expect(asked).toEqual(["ping"]);
    expect(out).toMatchObject({ kind: "done", toolCalls: 1 });
    const second = fetch.seen[1]!.messages as Array<{ role: string; content?: string | null }>;
    expect(second.at(-1)).toMatchObject({ role: "tool", content: "pong" });
  });

  it("collapses the turn when a tool says so, after answering every call in the batch", async () => {
    // A model that gets a `tool` reply for two of three calls sees a malformed
    // conversation next turn, so the collapse waits for the whole batch.
    const { agent, fetch } = loop([{
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "ping", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "ping", arguments: "{}" } },
      ],
    }, { content: "不该到这里" }]);
    let answered = 0;
    const out = await agent.run({
      systemPrompt: "s",
      messages: [],
      tools: TOOLS,
      callTool: async (): Promise<LoopToolResult> => {
        answered += 1;
        return { text: "需要批准", closesTurn: true };
      },
      model: "m",
    });
    expect(answered).toBe(2);
    expect(out).toMatchObject({ kind: "suspended", reason: "需要批准" });
    expect(fetch.seen).toHaveLength(1);
  });

  it("stops at the tool ceiling instead of looping for ever", async () => {
    const { agent } = loop([call("ping", {}), call("ping", {}), call("ping", {})], 2);
    const out = await agent.run({
      systemPrompt: "s",
      messages: [],
      tools: TOOLS,
      callTool: async () => ({ text: "pong" }),
      model: "m",
    });
    expect(out.kind).toBe("tool_cap");
    expect(out.toolCalls).toBe(2);
  });

  it("turns a throwing tool into a stable error string rather than ending the turn", async () => {
    // A trusted-side exception may carry a path or an id; the model gets a
    // fixed sentence and the caller keeps the real error.
    const { agent, fetch } = loop([call("ping", {}), { content: "算了" }]);
    const out = await agent.run({
      systemPrompt: "s",
      messages: [],
      tools: TOOLS,
      callTool: async () => {
        throw new Error("/home/secret/path exploded");
      },
      model: "m",
    });
    expect(out.kind).toBe("done");
    const second = JSON.stringify(fetch.seen[1]);
    expect(second).not.toContain("secret");
    expect(second).toContain("工具执行失败");
  });

  it("does not send a tools array when there are none", async () => {
    const { agent, fetch } = loop([{ content: "ok" }]);
    await agent.run({ systemPrompt: "s", messages: [], tools: [], callTool: async () => ({ text: "" }), model: "m" });
    expect(fetch.seen[0]).not.toHaveProperty("tools");
    expect(fetch.seen[0]).not.toHaveProperty("reasoning_effort");
  });

  it("reports a non-JSON body as a readable error rather than a SyntaxError", async () => {
    // A proxy in front of an LLM endpoint answers 200 with HTML often enough
    // that the opaque parse failure is a real support cost.
    const { agent } = loop([() => ({ ok: true, status: 200, text: async () => "<html>502</html>" } as unknown as Response)]);
    await expect(agent.run({
      systemPrompt: "s",
      messages: [],
      tools: [],
      callTool: async () => ({ text: "" }),
      model: "m",
    })).rejects.toThrow(/不是 JSON/);
  });

  it("does not retry a 4xx, and surfaces it", async () => {
    const { agent, fetch } = loop([() => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "bad model",
      headers: { get: () => null } as unknown as Headers,
    } as unknown as Response)]);
    await expect(agent.run({
      systemPrompt: "s",
      messages: [],
      tools: [],
      callTool: async () => ({ text: "" }),
      model: "m",
    })).rejects.toThrow(/400/);
    expect(fetch.seen).toHaveLength(1);
  });

  it("marks a tool result longer than the model window instead of cutting it silently", async () => {
    const { agent, fetch } = loop([call("ping", {}), { content: "好了" }]);
    const whole = "a".repeat(TOOL_RESULT_WINDOW_CHARS) + "TAIL-MARKER".repeat(100);
    const seenByCaller: string[] = [];
    await agent.run({
      systemPrompt: "sys",
      messages: [],
      tools: TOOLS,
      callTool: async () => ({ text: whole }),
      onToolCall: ({ result }) => { seenByCaller.push(result.text); },
      model: "m",
    });
    const fed = (fetch.seen[1]!.messages as Array<{ role: string; content?: string | null }>).at(-1)!.content!;
    expect(fed.startsWith("a".repeat(TOOL_RESULT_WINDOW_CHARS))).toBe(true);
    expect(fed).not.toContain("TAIL-MARKER");
    expect(fed).toContain(`工具结果共 ${whole.length} 字符`);
    expect(fed).toContain(`其余 ${whole.length - TOOL_RESULT_WINDOW_CHARS} 字符没有送入上下文`);
    expect(fed).toMatch(/offset|cursor/);
    // The domain still observes the complete result.
    expect(seenByCaller).toEqual([whole]);
  });

  it("passes a result that fits the window through unchanged", async () => {
    const { agent, fetch } = loop([call("ping", {}), { content: "好了" }]);
    const exact = "😀".repeat(TOOL_RESULT_WINDOW_CHARS / 2);
    await agent.run({ systemPrompt: "s", messages: [], tools: TOOLS, callTool: async () => ({ text: exact }), model: "m" });
    expect((fetch.seen[1]!.messages as Array<{ content?: string | null }>).at(-1)!.content).toBe(exact);
  });

  it("tolerates malformed tool arguments instead of ending the turn", () => {
    expect(safeArguments('{"a":1}')).toEqual({ a: 1 });
    expect(safeArguments("{not json")).toEqual({});
    expect(safeArguments("[1,2]")).toEqual({});
    expect(safeArguments(undefined)).toEqual({});
  });

  it("knows when it has no endpoint to call", () => {
    expect(new AgentLoop({ baseUrl: "http://x/v1", apiKey: "" }).configured).toBe(false);
    expect(new AgentLoop({ baseUrl: "http://x/v1", apiKey: "k" }).configured).toBe(true);
  });
});
