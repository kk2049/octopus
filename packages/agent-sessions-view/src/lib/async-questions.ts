import type { AgentInteractionQuestion, RichBlock, TranscriptWindow } from "@claude-bot/agent-sessions-contract";

export interface AsyncQuestionRequest {
  id: string;
  questions: AgentInteractionQuestion[];
  answered: boolean;
  laterUserMessage: boolean;
  error?: string;
}

export function asyncAnswerMarker(id: string): string {
  // JSON escaping is lossless even for malformed UTF-16 in an older log.
  return `【Codex 异步问题回答：${JSON.stringify(id).slice(1, -1)}】`;
}

export function asyncAnswerPrompt(request: AsyncQuestionRequest, answers: Record<string, string[]>): string {
  return [asyncAnswerMarker(request.id), ...request.questions.map((question) =>
    `${question.prompt}\n回答：${(answers[String(question.id)] ?? []).join("；")}`)].join("\n\n");
}

function questionsOf(block: RichBlock): AgentInteractionQuestion[] {
  const input: unknown = JSON.parse(block.input ?? "");
  if (!input || typeof input !== "object" || !("questions" in input) || !Array.isArray(input.questions)
    || input.questions.length === 0 || input.questions.length > 20) throw new Error("invalid questions");
  return input.questions.map((question: unknown, index) => {
    if (!question || typeof question !== "object" || !("title" in question)
      || typeof question.title !== "string" || !question.title.trim()) throw new Error("invalid title");
    const options = "options" in question ? question.options : undefined;
    if (options != null && (!Array.isArray(options) || options.length > 30
      || options.some((option: unknown) => typeof option !== "string" || !option.trim()))) throw new Error("invalid options");
    return {
      id: String(index), prompt: question.title, header: `问题 ${index + 1}`,
      options: [...new Set((options ?? []) as string[])].map((label) => ({ label })),
      multiple: false, allow_other: true,
    };
  });
}

/** Only explicit answer markers resolve a question. Tool outputs acknowledge display,
 * and ordinary later user messages may be unrelated. No model inference here. */
export function collectAsyncQuestions(window: TranscriptWindow | null | undefined): AsyncQuestionRequest[] {
  const requests = new Map<string, AsyncQuestionRequest>();
  for (const [index, message] of (window?.messages ?? []).entries()) {
    if (message.role === "user") {
      const text = message.blocks?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n")
        ?? message.text ?? "";
      for (const request of requests.values()) {
        request.laterUserMessage = true;
        if (text.trimStart().startsWith(`${asyncAnswerMarker(request.id)}\n`)) request.answered = true;
      }
      continue;
    }
    if (message.role !== "assistant") continue;
    for (const [blockIndex, block] of (message.blocks ?? []).entries()) {
      if (block.type !== "tool" || !["request_user_input_async", "functions.request_user_input_async"].includes(block.tool ?? "")) continue;
      const offset = window?.offset;
      // Old providers need an absolute transcript coordinate, never a page index.
      const id = (typeof block.call_id === "string" && block.call_id.length <= 512 ? block.call_id : "")
        || (typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0
        ? `message-${offset + index}-${blockIndex}` : "");
      let questions: AgentInteractionQuestion[] = [];
      let error: string | undefined;
      try { questions = questionsOf(block); }
      catch { error = "问题内容不完整或格式暂不支持，请查看原始工具记录。"; }
      if (!id) error = "问题缺少稳定标识，请刷新会话记录后回答。";
      // The fallback for malformed legacy data is display-only.
      const key = id || `unavailable-${message.timestamp ?? ""}-${block.input ?? ""}`;
      if (!requests.has(key)) requests.set(key, { id: key, questions, answered: false, laterUserMessage: false, ...(error ? { error } : {}) });
    }
  }
  return [...requests.values()];
}
