import { describe, expect, it } from "vitest";
import { markedReceiptTail, recoverFullReply, type TranscriptRead } from "./receipt-reply.js";

const RECEIPT_CHARS = 80_000;

/** A rich read_session double: the page previews any text over `preview`, block reads window it. */
function transcript(messages: Array<{ role: string; texts: string[]; zh?: string }>, preview = 16_000, window = 256 * 1024): { read: TranscriptRead; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const read: TranscriptRead = async (args) => {
    calls.push(args);
    if (args.block !== undefined) {
      const text = messages[Number(args.offset)]!.texts[Number(args.block)]!;
      const start = Number(args.char_offset ?? 0);
      const end = Math.min(text.length, start + window);
      return { text: text.slice(start, end), total_chars: text.length, ...(end < text.length ? { next_char_offset: end } : {}) };
    }
    const max = Number(args.max_messages);
    const first = Math.max(0, messages.length - max);
    return {
      rich: true, total_messages: messages.length, offset: first,
      messages: messages.slice(first).map((message) => ({
        role: message.role,
        blocks: message.texts.map((text) => text.length > preview
          ? { type: "text", text: `${text.slice(0, preview)}…`, truncated: true, truncated_fields: ["text"] }
          : { type: "text", text, ...(message.zh ? { bilingual: { zh: message.zh, en: text } } : {}) }),
      })),
    };
  };
  return { read, calls };
}

describe("whole reply behind a truncated receipt", () => {
  it("recovers a reply whose slug section precedes the receipt's tail", async () => {
    const reply = "## 名字\nlong-reply-slug\n\n## 方案\n" + "细节。".repeat(60_000) + "\n结束。";
    const tail = reply.slice(-RECEIPT_CHARS);
    expect(tail).not.toContain("long-reply-slug");
    const { read, calls } = transcript([
      { role: "user", texts: ["做这件事"] },
      { role: "assistant", texts: ["先看看代码"] },
      { role: "assistant", texts: [reply] },
    ]);
    expect(await recoverFullReply(read, tail)).toBe(reply);
    // The page previewed the reply; the whole text came from block windows.
    expect(calls.filter((call) => call.block !== undefined).length).toBeGreaterThan(0);
  });

  it("does not take a different assistant text for the reply", async () => {
    const { read } = transcript([{ role: "assistant", texts: ["something else entirely"] }]);
    expect(await recoverFullReply(read, "x".repeat(RECEIPT_CHARS))).toBeNull();
  });

  it("matches a reply split across text blocks and a translated Claude reply", async () => {
    const parts = ["第一段" + "a".repeat(50_000), "第二段" + "b".repeat(50_000)];
    const split = transcript([{ role: "assistant", texts: parts }]);
    expect(await recoverFullReply(split.read, parts.join("\n\n").slice(-RECEIPT_CHARS))).toBe(parts.join("\n\n"));
    const zh = "中文译文" + "译".repeat(90_000);
    const translated = transcript([{ role: "assistant", texts: ["english"], zh }], Infinity);
    expect(await recoverFullReply(translated.read, zh.slice(-RECEIPT_CHARS))).toBe(zh);
  });

  it("says when only the tail is available", () => {
    const marked = markedReceiptTail("tail");
    expect(marked).toContain("最后 4 个字符");
    expect(marked.endsWith("…tail")).toBe(true);
  });
});
