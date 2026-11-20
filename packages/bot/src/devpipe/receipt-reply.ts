/**
 * The whole final reply behind a Runner receipt that kept only its tail.
 *
 * A managed-turn receipt carries at most the last 80,000 characters of the
 * reply and says so with `result_text_truncated: true`; the complete reply is
 * the transcript. This reads the newest messages of that transcript through
 * the ticket's own `read_session` authority and returns the newest assistant
 * text that ends with the receipt's tail — a text block the page previewed is
 * read whole through block windows. The suffix match is the proof: a text that
 * does not end with what the Runner reported is never taken for the reply.
 */

/** One `read_session` call with the ticket binding's fixed id/source/rich arguments. */
export type TranscriptRead = (args: Record<string, unknown>) => Promise<unknown>;

/** Newest messages examined for the reply; the reply ends the turn, so it is among them. */
const RECENT_MESSAGES = 20;

interface PageBlock { type?: unknown; text?: unknown; truncated?: unknown; truncated_fields?: unknown; bilingual?: { zh?: unknown } }
interface PageMessage { role?: unknown; blocks?: unknown }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A text block's complete text: the page copy, or every window of a block read when the page previewed it. */
async function wholeBlockText(read: TranscriptRead, message: number, index: number, block: PageBlock): Promise<string> {
  const capped = Array.isArray(block.truncated_fields) ? block.truncated_fields.includes("text") : block.truncated === true;
  if (!capped) return typeof block.text === "string" ? block.text : "";
  let text = "";
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const window = record(await read({ offset: message, block: index, field: "text", char_offset: offset }));
    if (!window || typeof window.text !== "string") throw new Error("transcript block read returned no text");
    text += window.text;
    const next = window.next_char_offset;
    if (next !== undefined && (typeof next !== "number" || next <= offset)) throw new Error("transcript block read did not advance");
    offset = next as number | undefined;
  }
  return text;
}

function endsWithTail(candidate: string, tail: string): boolean {
  const want = tail.trimEnd();
  return want.length > 0 && candidate.trimEnd().endsWith(want) && candidate.trimEnd().length >= want.length;
}

export async function recoverFullReply(read: TranscriptRead, tail: string): Promise<string | null> {
  const page = record(await read({ max_messages: RECENT_MESSAGES }));
  const messages = Array.isArray(page?.messages) ? page.messages as PageMessage[] : [];
  const first = typeof page?.offset === "number" ? page.offset : 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant" || !Array.isArray(message.blocks)) continue;
    const texts: string[] = [];
    const blocks = message.blocks as PageBlock[];
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b]!;
      if (block.type !== "text") continue;
      texts.push(await wholeBlockText(read, first + i, b, block));
      // A Runner that translates Claude replies reports the translation.
      if (typeof block.bilingual?.zh === "string") texts.push(block.bilingual.zh);
    }
    const candidates = [...texts.slice().reverse(), texts.join(""), texts.join("\n\n"), texts.join("\n")];
    const found = candidates.find((candidate) => endsWithTail(candidate, tail));
    if (found !== undefined) return found;
  }
  return null;
}

/** The reply to store when the transcript could not supply the whole one: the tail, saying it is one. */
export function markedReceiptTail(tail: string): string {
  return `（Runner 回执只保留了这条回复的最后 ${tail.length} 个字符，原会话里没能读到完整回复；完整内容请在原会话查看。）\n\n…${tail}`;
}
