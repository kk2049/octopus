/**
 * Shared HTTP model/tool loop. Domain callers own authorization, tool effects
 * and transcripts; the managed-execution adapter owns durable scheduling.
 * Legacy App imports re-export this module so there is only one class identity.
 */

import { fetchLlm } from "../session/llm-fetch.js";

export interface LoopToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LoopMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: LoopToolCall[];
  tool_call_id?: string;
}

export interface LoopTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * One tool's answer.
 *
 * `closesTurn` is the shape `approval_required` needs. A resource read that a
 * human still has to approve is a NORMAL outcome, not a failure: blocking would
 * hold an LLM turn open for a human-scale delay, and polling would mint a fresh
 * approval card per attempt (the same rule the panel front-end follows for
 * capability GETs). So the tool answers, the turn collapses, and the decision —
 * when it arrives — becomes a new inbox message that starts the next turn.
 */
export interface LoopToolResult {
  text: string;
  isError?: boolean;
  closesTurn?: boolean;
}

export interface RunLoopRequest {
  systemPrompt: string;
  /** Prior transcript plus this turn's new input, already in wire shape. */
  messages: readonly LoopMessage[];
  tools: readonly LoopTool[];
  callTool(name: string, args: Record<string, unknown>): Promise<LoopToolResult>;
  model: string;
  effort?: string;
  /** Unset means the deployment default; 0 or negative means unlimited. */
  maxToolTurns?: number;
  signal?: AbortSignal;
  /** Every assistant text, as it is produced. Persistence is the caller's. */
  onAssistant?(text: string): void;
  /** Provider receipt only: requested model and absent usage are not evidence. */
  onUsage?(receipt: { id: string | null; model: string | null; input: number | null; output: number | null }): void;
  checkpoint?: LoopCheckpointPort;
  /** Trusted adapter declaration; models and App manifests cannot set this. */
  replaySafeTools?: ReadonlySet<string>;
  /** Read-only child inference inherits its parent's durable retry boundary. */
  parentManaged?: boolean;
  onToolCall?(call: { name: string; args: Record<string, unknown>; result: LoopToolResult }): void;
}

/** Durable cursor through a tool loop; `effect` is deliberately not replayable. */
export interface LoopCheckpoint {
  version: 1;
  phase: "model" | "tools" | "effect";
  history: LoopMessage[];
  pendingCalls: LoopToolCall[];
  nextCall: number;
  round: number;
  toolCalls: number;
  lastText: string;
  suspend: string | null;
}
export interface LoopCheckpointPort {
  load(): LoopCheckpoint | undefined;
  save(checkpoint: LoopCheckpoint): void;
}
export class AgentModelUnavailable extends Error {
  constructor() { super("模型连接暂不可用，等待连接恢复"); this.name = "AgentModelUnavailable"; }
}
export class AgentEffectUnknown extends Error {
  constructor() { super("Agent 在副作用确认窗口中断；不会自动重复该工具或输出"); this.name = "AgentEffectUnknown"; }
}

export type LoopOutcome =
  | { kind: "done"; text: string; toolCalls: number }
  | { kind: "tool_cap"; text: string; toolCalls: number }
  | { kind: "suspended"; text: string; reason: string; toolCalls: number };

export interface AgentLoopConfig {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs?: number;
  /** Default ceiling when a request does not set one. Engine's value. */
  maxToolTurns?: number;
  fetchImpl?: typeof globalThis.fetch;
  label?: string;
}

export const DEFAULT_MAX_TOOL_TURNS = 24;

export const TOOL_CAP_NOTE = "工具轮数达上限，本轮先停在这里——要继续请再说一句。";

/**
 * Characters of one tool result the model sees. The model's context is the
 * real bound; this is its per-result window. `onToolCall` still receives the
 * whole result.
 */
export const TOOL_RESULT_WINDOW_CHARS = 20_000;

/**
 * One tool result as the model receives it: whole when it fits the window,
 * otherwise the head plus a note that says how much was left out and how to
 * reach it, so a cut is never mistaken for the end of the data.
 */
export function modelToolText(text: string): string {
  if (text.length <= TOOL_RESULT_WINDOW_CHARS) return text;
  // Never split a surrogate pair at the cut.
  let end = TOOL_RESULT_WINDOW_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\n\n[工具结果共 ${text.length} 字符，这里只给出前 ${end} 字符，其余 ${text.length - end} 字符没有送入上下文。`
    + "需要后面的内容时，用该工具的分页参数（offset / cursor / next_offset / page_token 一类）从这里继续读，或缩小查询范围后重新调用；不要把这段当成完整结果。]";
}

export class AgentLoop {
  constructor(private readonly cfg: AgentLoopConfig) {}

  get configured(): boolean {
    return Boolean(this.cfg.apiKey && this.cfg.baseUrl);
  }

  async run(req: RunLoopRequest): Promise<LoopOutcome> {
    const restored = req.checkpoint?.load();
    if (restored?.phase === "effect") throw new AgentEffectUnknown();
    const state: LoopCheckpoint = restored ? structuredClone(restored) : {
      version: 1, phase: "model", history: [{ role: "system", content: req.systemPrompt },
        ...req.messages.map(message => ({ ...message }))], pendingCalls: [], nextCall: 0,
      round: 0, toolCalls: 0, lastText: "", suspend: null,
    };
    const save = (phase: LoopCheckpoint["phase"]): void => {
      state.phase = phase;
      req.checkpoint?.save(structuredClone(state));
    };
    const tools = req.tools.map(tool => ({ type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    const cap = req.maxToolTurns ?? this.cfg.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS;
    const maxTurns = cap > 0 ? Math.floor(cap) : Infinity;
    while (state.round < maxTurns) {
      throwIfAborted(req.signal);
      if (state.phase === "model") {
        save("model");
        let message: Awaited<ReturnType<AgentLoop["complete"]>>;
        try { message = await this.complete(state.history, tools, req); }
        catch (error) {
          throwIfAborted(req.signal);
          const failure = error as { reason?: string; status?: number } | null;
          if ((req.checkpoint || req.parentManaged) && (failure?.reason === "network" || failure?.reason === "timeout"
            || (failure?.reason === "http" && [502, 503, 504].includes(failure.status ?? 0)))) throw new AgentModelUnavailable();
          throw error;
        }
        const text = message.content ?? "";
        const calls = message.tool_calls ?? [];
        state.history.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
        state.pendingCalls = calls;
        state.nextCall = 0;
        state.suspend = null;
        if (text) {
          state.lastText = text;
          // Transcript delivery is also an effect. Crash between delivery and
          // checkpoint cannot be mistaken for an untouched model request.
          if (req.onAssistant) {
            save("effect");
            req.onAssistant(text);
          }
        }
        save("tools");
      }
      if (!state.pendingCalls.length) return { kind: "done", text: state.lastText, toolCalls: state.toolCalls };
      while (state.nextCall < state.pendingCalls.length) {
        throwIfAborted(req.signal);
        const call = state.pendingCalls[state.nextCall]!;
        const args = safeArguments(call.function?.arguments);
        const name = String(call.function?.name ?? "");
        const replaySafe = req.replaySafeTools?.has(name) === true;
        save(replaySafe ? "tools" : "effect");
        state.toolCalls += 1;
        let result: LoopToolResult;
        try { result = await req.callTool(name, args); }
        catch (error) {
          throwIfAborted(req.signal);
          if (replaySafe && error instanceof AgentModelUnavailable) throw error;
          if (req.checkpoint) throw new AgentEffectUnknown();
          result = { text: "工具执行失败。", isError: true };
        }
        throwIfAborted(req.signal);
        req.onToolCall?.({ name: String(call.function?.name ?? ""), args, result });
        state.history.push({ role: "tool", tool_call_id: call.id, content: modelToolText(result.text) });
        if (result.closesTurn) state.suspend = result.text;
        state.nextCall++;
        save("tools");
      }
      if (state.suspend !== null) return { kind: "suspended", text: state.lastText, reason: state.suspend, toolCalls: state.toolCalls };
      state.round++;
      state.pendingCalls = [];
      save("model");
    }
    return { kind: "tool_cap", text: state.lastText, toolCalls: state.toolCalls };
  }

  private async complete(
    history: LoopMessage[],
    tools: ReadonlyArray<{ type: "function"; function: LoopTool }>,
    req: RunLoopRequest,
  ): Promise<{ content?: string | null; tool_calls?: LoopToolCall[] }> {
    const baseUrl = (this.cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetchLlm(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({
          model: req.model,
          messages: history,
          ...(tools.length ? { tools, tool_choice: "auto" } : {}),
          ...(req.effort ? { reasoning_effort: req.effort } : {}),
        }),
      },
      {
        fetchImpl: this.cfg.fetchImpl,
        timeoutMs: this.cfg.requestTimeoutMs ?? 300_000,
        // Durable scheduling owns retries for managed loops. Nested HTTP
        // retries would hide the outage from the lifecycle projection.
        retry: req.checkpoint || req.parentManaged ? false : undefined,
        signal: req.signal,
        label: this.cfg.label ?? "App agent chat/completions",
      },
    );
    // `text()` then `JSON.parse`, not `json()`: a proxy or gateway in front of
    // an LLM endpoint answers 200 with HTML often enough that the opaque
    // `SyntaxError` is a real support cost.
    const raw = await response.text();
    let data: { id?: string; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: Array<{ message?: { content?: string | null; tool_calls?: LoopToolCall[] } }> };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      throw new Error(`模型返回的不是 JSON：${raw.slice(0, 240).replace(/\s+/g, " ")}`);
    }
    const tokens = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    req.onUsage?.({ id: typeof data.id === 'string' ? data.id : null, model: typeof data.model === 'string' ? data.model : null,
      input: tokens(data.usage?.prompt_tokens), output: tokens(data.usage?.completion_tokens) });
    return data.choices?.[0]?.message ?? {};
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("App agent turn aborted");
}

/**
 * A tool call's arguments, as an object.
 *
 * Models emit truncated or doubly-encoded JSON often enough that throwing here
 * would end turns for a reason the model could have recovered from. An empty
 * object flows into the normaliser, which answers "you left out `session`" —
 * an actionable sentence.
 */
export function safeArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
