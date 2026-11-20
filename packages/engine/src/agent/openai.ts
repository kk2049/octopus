/**
 * OpenAI-flavoured loop adapter — the in-process tool loop, probe edition.
 * Pattern copied (not extracted) from the bot's hq/chat.ts; the copy is a
 * recorded debt. Stateless API: we rebuild messages from the transcript tail
 * each turn, so a host restart loses nothing but the in-flight turn.
 */

import type { LoopAdapter, TranscriptEntry, TurnRequest } from "./plane.js";

export interface OpenAiLoopOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: string;
  maxToolTurns?: number;
  requestTimeoutMs?: number;
}

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function contextOf(entries: TranscriptEntry[]): ChatMessage[] {
  // Tool/note lines collapse into assistant-side context; only real user and
  // assistant turns keep their roles. Cross-turn tool detail decays — same
  // trade the bot's hq chat made, kept knowingly.
  return entries.map((e) => {
    if (e.role === "user") return { role: "user", content: e.text };
    if (e.role === "assistant") return { role: "assistant", content: e.text };
    const tag = e.role === "tool" ? "工具" : e.role === "elicit" ? "问询卡" : "注记";
    return { role: "assistant", content: `（${tag}）${e.text}` };
  });
}

export class OpenAiLoop implements LoopAdapter {
  constructor(private opts: OpenAiLoopOptions) {}

  async runTurn(req: TurnRequest): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: req.systemPrompt },
      ...contextOf(req.transcript.filter((t) => !req.inboxTexts.includes(t.text))),
      ...req.inboxTexts.map((t) => ({ role: "user", content: t })),
    ];
    const tools = req.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const maxTurns = this.opts.maxToolTurns ?? 24;
    for (let turn = 0; turn < maxTurns; turn++) {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model ?? this.opts.model,
          messages,
          tools: tools.length ? tools : undefined,
          ...((req.effort ?? this.opts.reasoningEffort)
            ? { reasoning_effort: req.effort ?? this.opts.reasoningEffort }
            : {}),
        }),
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 120_000),
      });
      if (!res.ok) {
        const head = (await res.text()).slice(0, 300);
        throw new Error(`LLM HTTP ${res.status}: ${head}`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: ChatMessage }> };
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error("LLM 返回没有 choices[0].message");
      messages.push(msg);

      const calls = msg.tool_calls ?? [];
      if (!calls.length) return msg.content ?? "（空回复）";
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          /* tolerate malformed args; tool will complain */
        }
        let result: string;
        try {
          result = await req.callTool(call.function.name, args);
        } catch (err) {
          result = JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) });
        }
        messages.push({ role: "tool", content: result, tool_call_id: call.id });
      }
    }
    return "（工具轮数达上限，先停在这里——继续请再说一句）";
  }
}
