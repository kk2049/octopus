import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RICH_BLOCK_WINDOW_CHARS, readSession } from "./scan.js";
import { RICH_PAGE_BYTES, resetRichTranscriptFiles } from "./rich-file.js";
import { RICH_OUTPUT_CAP, RICH_THINKING_CAP, type RichMessage } from "./parse.js";

/** The capability kernel's per-call result cap (packages/capability-kernel objects.ts). */
const KERNEL_RESULT_BYTES = 8 * 1024 * 1024;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sessions-read-window-"));
  resetRichTranscriptFiles();
});
afterEach(() => {
  resetRichTranscriptFiles();
  rmSync(home, { recursive: true, force: true });
});

function claudeLog(id: string, records: unknown[]): void {
  const dir = join(home, ".claude", "projects", "-home-u-proj");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), records.map((record) => JSON.stringify({ sessionId: id, ...record as object })).join("\n") + "\n");
}
const user = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const assistant = (content: unknown[]) => ({ type: "assistant", message: { role: "assistant", content } });
const result = (id: string, content: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });

interface Page { offset: number; total_messages: number; returned_messages: number; byte_limited?: boolean; messages: RichMessage[] }
interface BlockWindow { text: string; total_chars: number; char_offset: number; next_char_offset?: number; block_type: string; tool?: string }

async function fullField(id: string, offset: number, block: number, field: string): Promise<string> {
  let text = "";
  let charOffset: number | undefined = 0;
  while (charOffset !== undefined) {
    const window = await readSession(home, { id, source: "claude", rich: true, offset, block, field, char_offset: charOffset }) as BlockWindow;
    expect(window.char_offset).toBe(charOffset);
    text += window.text;
    charOffset = window.next_char_offset;
  }
  return text;
}

describe("complete rich blocks behind capped pages", () => {
  it("reads thinking, tool input and tool output whole, in windows, after the page caps them", async () => {
    const thinking = "t".repeat(RICH_THINKING_CAP * 3);
    const command = "c".repeat(5_000);
    const output = Array.from({ length: 40_000 }, (_, i) => `line ${i}`).join("\n"); // > one block window
    claudeLog("blocks", [
      user("go"),
      assistant([{ type: "thinking", thinking }, { type: "tool_use", id: "t1", name: "Bash", input: { command } }]),
      result("t1", output),
    ]);
    const page = await readSession(home, { id: "blocks", source: "claude", rich: true }) as Page;
    const blocks = page.messages[1]!.blocks;
    expect(blocks[0]).toMatchObject({ type: "thinking", truncated: true });
    expect(blocks[1]).toMatchObject({ type: "tool", truncated: true });
    expect(blocks[1]!.output!.length).toBe(RICH_OUTPUT_CAP + 1);

    expect(output.length).toBeGreaterThan(RICH_BLOCK_WINDOW_CHARS);
    expect(await fullField("blocks", 1, 1, "output")).toBe(output);
    expect(await fullField("blocks", 1, 1, "input")).toBe(JSON.stringify({ command }));
    expect(await fullField("blocks", 1, 0, "text")).toBe(thinking);
    const first = await readSession(home, { id: "blocks", source: "claude", rich: true, offset: 1, block: 1, field: "output" }) as BlockWindow;
    expect(first).toMatchObject({ block_type: "tool", tool: "Bash", total_chars: output.length, next_char_offset: RICH_BLOCK_WINDOW_CHARS });
  });

  it("keeps every late result whole when the call's message was already evicted to disk", async () => {
    const outputs = ["a", "b"].map((name) => `${name}:` + name.repeat(50_000));
    claudeLog("late", [
      user("go"),
      assistant([
        { type: "tool_use", id: "a", name: "Read", input: { file: "a" } },
        { type: "tool_use", id: "b", name: "Read", input: { file: "b" } },
      ]),
      // More filler than the hot cache keeps, so each result reloads the journaled call.
      ...Array.from({ length: 300 }, (_, i) => assistant([{ type: "text", text: `filler ${i} ` + "f".repeat(20_000) }])),
      result("a", outputs[0]!),
      ...Array.from({ length: 300 }, (_, i) => assistant([{ type: "text", text: `more ${i} ` + "m".repeat(20_000) }])),
      result("b", outputs[1]!),
    ]);
    const page = await readSession(home, { id: "late", source: "claude", rich: true, offset: 1, max_messages: 1 }) as Page;
    expect(page.messages[0]!.blocks.map((block) => block.truncated)).toEqual([true, true]);
    expect(await fullField("late", 1, 0, "output")).toBe(outputs[0]);
    expect(await fullField("late", 1, 1, "output")).toBe(outputs[1]);
  });

  it("refuses a block that does not exist instead of returning an empty one", async () => {
    claudeLog("missing", [user("only")]);
    await expect(readSession(home, { id: "missing", source: "claude", rich: true, offset: 0, block: 3 })).rejects.toThrow(/内容块不存在/);
  });
});

describe("byte-bounded transcript pages", () => {
  const big = (i: number) => `${i}:` + "x".repeat(300_000);
  beforeEach(() => claudeLog("big", Array.from({ length: 20 }, (_, i) => assistant([{ type: "text", text: big(i) }]))));

  it("keeps the latest messages that fit and pages back to the start with `before`", async () => {
    const seen: string[] = [];
    let before: number | undefined;
    do {
      const page = await readSession(home, { id: "big", source: "claude", rich: true, max_messages: 500, ...(before === undefined ? {} : { before }) }) as Page;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(KERNEL_RESULT_BYTES);
      expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(RICH_PAGE_BYTES);
      expect(page.returned_messages).toBeGreaterThan(0);
      if (page.offset > 0) expect(page.byte_limited).toBe(true);
      seen.unshift(...page.messages.map((message) => message.blocks[0]!.text!.split(":")[0]!));
      before = page.offset;
    } while (before > 0);
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
  });

  it("pages forward from an offset without gaps", async () => {
    const seen: string[] = [];
    let offset = 0;
    while (offset < 20) {
      const page = await readSession(home, { id: "big", source: "claude", rich: true, max_messages: 500, offset }) as Page;
      expect(page.offset).toBe(offset);
      seen.push(...page.messages.map((message) => message.blocks[0]!.text!.split(":")[0]!));
      offset += page.returned_messages;
    }
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
  });

  it("previews a single message larger than a page and keeps its text whole behind a block read", async () => {
    const huge = "h".repeat(RICH_PAGE_BYTES + 1_000);
    claudeLog("huge", [user("q"), assistant([{ type: "text", text: huge }])]);
    const page = await readSession(home, { id: "huge", source: "claude", rich: true }) as Page;
    expect(page.byte_limited).toBe(true);
    expect(page.messages.at(-1)!.blocks[0]).toMatchObject({ type: "text", truncated: true });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(KERNEL_RESULT_BYTES);
    expect(await fullField("huge", 1, 0, "text")).toBe(huge);
  });
});

describe("flat read_session paging", () => {
  beforeEach(() => claudeLog("flat", Array.from({ length: 30 }, (_, i) => user(`m${i}`))));
  const texts = (page: unknown) => (page as { messages: Array<{ text: string }> }).messages.map((message) => message.text);

  it("reads the tail by default and any window by offset or before", async () => {
    const tail = await readSession(home, { id: "flat", source: "claude", max_messages: 10 }) as Record<string, unknown>;
    expect(texts(tail)).toEqual(Array.from({ length: 10 }, (_, i) => `m${20 + i}`));
    expect(tail).toMatchObject({ truncated: true, total_messages: 30, offset: 20, returned_messages: 10 });
    expect(texts(await readSession(home, { id: "flat", source: "claude", max_messages: 10, offset: 0 })))
      .toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
    expect(texts(await readSession(home, { id: "flat", source: "claude", max_messages: 10, before: 15 })))
      .toEqual(Array.from({ length: 10 }, (_, i) => `m${5 + i}`));
    expect(await readSession(home, { id: "flat", source: "claude", max_messages: 10, offset: 25 }))
      .toMatchObject({ offset: 25, returned_messages: 5, truncated: true });
  });

  it("counts Codex's visible channel when it pages", async () => {
    const dir = join(home, ".codex", "sessions", "2026", "08", "21");
    mkdirSync(dir, { recursive: true });
    const rows = [{ type: "session_meta", payload: { id: "cx" } }];
    for (let i = 0; i < 6; i++) {
      rows.push({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `q${i}` }] } } as never);
      rows.push({ type: "event_msg", payload: { type: "user_message", message: `q${i}` } } as never);
    }
    writeFileSync(join(dir, "rollout-2026-08-21T09-00-00-cx.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const page = await readSession(home, { id: "cx", source: "codex", max_messages: 2, offset: 2 });
    expect(page).toMatchObject({ total_messages: 6, offset: 2 });
    expect(texts(page)).toEqual(["q2", "q3"]);
  });
});
