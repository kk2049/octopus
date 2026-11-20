import { describe, expect, it, vi } from "vitest";
import { AgentEffectUnknown, AgentLoop, AgentModelUnavailable, type LoopCheckpoint, type RunLoopRequest } from "./loop.js";
import { fetchLlm } from "../session/llm-fetch.js";
vi.mock("../session/llm-fetch.js", () => ({ fetchLlm: vi.fn() }));
const response = (message: unknown) => ({ text: async () => JSON.stringify({ choices: [{ message }] }) }) as Response;
const newLoop = () => new AgentLoop({ baseUrl: "http://model.invalid/v1", apiKey: "test" });
const toolMessage = { tool_calls: [{ id: "call-one", type: "function", function: { name: "effect", arguments: "{}" } }] };

describe("durable HTTP agent loop checkpoint", () => {
  it("retries a disconnected model round after restart without repeating a completed tool", async () => {
    vi.mocked(fetchLlm).mockReset().mockResolvedValueOnce(response(toolMessage))
      .mockRejectedValueOnce(Object.assign(new Error("socket closed"), { reason: "network" }))
      .mockResolvedValueOnce(response({ content: "complete" }));
    let persisted: LoopCheckpoint | undefined;
    const effect = vi.fn(async () => ({ text: "effect already committed" }));
    const request: RunLoopRequest = { systemPrompt: "system", messages: [{ role: "user", content: "run" }],
      tools: [{ name: "effect", description: "effect", parameters: {} }], callTool: effect, model: "test",
      checkpoint: { load: () => persisted, save: value => { persisted = structuredClone(value); } } };
    await expect(newLoop().run(request)).rejects.toBeInstanceOf(AgentModelUnavailable);
    expect(persisted).toMatchObject({ phase: "model", toolCalls: 1, round: 1 });
    expect(await newLoop().run(request)).toMatchObject({ kind: "done", text: "complete", toolCalls: 1 });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(fetchLlm).mock.calls[2]![1]?.body)).messages).toContainEqual(
      expect.objectContaining({ role: "tool", content: "effect already committed" }));
  });

  it("records the effect barrier before dispatch and refuses replay after an interrupted tool", async () => {
    vi.mocked(fetchLlm).mockReset().mockResolvedValue(response(toolMessage));
    let persisted: LoopCheckpoint | undefined;
    const effect = vi.fn(async () => {
      expect(persisted?.phase).toBe("effect");
      throw new Error("unknown external effect");
    });
    const request: RunLoopRequest = { systemPrompt: "system", messages: [], tools: [], callTool: effect, model: "test",
      checkpoint: { load: () => persisted, save: value => { persisted = structuredClone(value); } } };
    await expect(newLoop().run(request)).rejects.toBeInstanceOf(AgentEffectUnknown);
    await expect(newLoop().run(request)).rejects.toBeInstanceOf(AgentEffectUnknown);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(fetchLlm).toHaveBeenCalledTimes(1);
  });
  it("retries a declared read-only child while preserving its parent's completed effect", async () => {
    vi.mocked(fetchLlm).mockReset().mockResolvedValueOnce(response({ tool_calls: [
      ...toolMessage.tool_calls, { id: "consult-one", type: "function", function: { name: "consult", arguments: "{}" } },
    ] })).mockResolvedValueOnce(response({ content: "complete" }));
    let persisted: LoopCheckpoint | undefined;
    let online = false;
    const effect = vi.fn();
    const consult = vi.fn(() => { if (!online) throw new AgentModelUnavailable(); return { text: "analysis" }; });
    const request: RunLoopRequest = { systemPrompt: "system", messages: [], tools: [], model: "test",
      replaySafeTools: new Set(["consult"]),
      callTool: async name => { if (name === "consult") return consult(); effect(); return { text: "committed" }; },
      checkpoint: { load: () => persisted, save: value => { persisted = structuredClone(value); } } };
    await expect(newLoop().run(request)).rejects.toBeInstanceOf(AgentModelUnavailable);
    expect(persisted).toMatchObject({ phase: "tools", nextCall: 1, toolCalls: 1 });
    online = true;
    await expect(newLoop().run(request)).resolves.toMatchObject({ kind: "done", toolCalls: 2 });
    expect(effect).toHaveBeenCalledOnce();
    expect(consult).toHaveBeenCalledTimes(2);
  });

  it("keeps capacity terminal instead of disguising it as a missing resource", async () => {
    const capacity = Object.assign(new Error("model at capacity"), { reason: "http", status: 429 });
    vi.mocked(fetchLlm).mockReset().mockRejectedValueOnce(capacity);
    await expect(newLoop().run({ systemPrompt: "x", messages: [], tools: [], model: "test",
      callTool: vi.fn(), checkpoint: { load: () => undefined, save() {} } })).rejects.toBe(capacity);
    expect(fetchLlm).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchLlm).mock.calls[0]![2]).toMatchObject({ retry: false });
  });

});
