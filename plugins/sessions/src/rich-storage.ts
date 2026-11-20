import type { RichBlock, RichMessage } from "./parse.js";

/** Detail-block caps on a page (characters). Marked `truncated: true` when applied. */
export const RICH_THINKING_CAP = 4_000;
export const RICH_INPUT_CAP = 2_000;
export const ASYNC_QUESTION_INPUT_CAP = 32_000;
export const isAsyncQuestion = (name: string | undefined): boolean =>
  name === "request_user_input_async" || name === "functions.request_user_input_async";
export const RICH_OUTPUT_CAP = 4_000;

/** The block fields a page may cap; a block read returns any of them whole. */
export type RichBlockField = "text" | "input" | "output";
export const RICH_BLOCK_FIELDS: readonly RichBlockField[] = ["text", "input", "output"];

/** The page cap of one field of this block, or undefined when the field is never capped. */
export function richFieldCap(block: Pick<RichBlock, "type" | "tool">, field: RichBlockField): number | undefined {
  if (block.type === "thinking") return field === "text" ? RICH_THINKING_CAP : undefined;
  if (block.type !== "tool") return undefined;
  if (field === "input") return isAsyncQuestion(block.tool) ? ASYNC_QUESTION_INPUT_CAP : RICH_INPUT_CAP;
  return field === "output" ? RICH_OUTPUT_CAP : undefined;
}

/**
 * The page form of a block: capped fields end in "…" and set `truncated`.
 * Idempotent, so a block that is already in page form is returned unchanged.
 */
export function capRichBlock(block: RichBlock): RichBlock {
  let out = block;
  for (const field of RICH_BLOCK_FIELDS) {
    const limit = richFieldCap(block, field);
    const value = block[field];
    if (limit === undefined || typeof value !== "string" || value.length <= limit) continue;
    if (out === block) out = { ...block, truncated_fields: [...block.truncated_fields ?? []] };
    out[field] = cap(value, limit).text;
    out.truncated = true;
    if (!out.truncated_fields!.includes(field)) out.truncated_fields!.push(field);
  }
  return out;
}

function cap(s: string, n: number): { text: string; truncated: boolean } {
  const t = s.trim();
  return t.length <= n ? { text: t, truncated: false } : { text: t.slice(0, n) + "…", truncated: true };
}

export interface RichFacts { count: number; firstUser?: string; preview?: string }
export interface RichStorage {
  push(message: RichMessage): void;
  rememberTool(id: string, block: RichBlock): void;
  findTool(id: string): RichBlock | undefined;
  facts(): RichFacts;
  snapshot(): RichMessage[];
}

/** Facts over the normalized, already deduplicated conversation. */
export class RichFactsAccumulator {
  private all: RichFacts = { count: 0 };
  add(message: { role: string; text: string }): void {
    const text = message.text.trim();
    const preview = text.length > 120 ? text.slice(0, 120) + "…" : text;
    this.all.count++;
    if (text) {
      if (!this.all.firstUser && message.role === "user") this.all.firstUser = preview;
      this.all.preview = preview;
    }
  }
  facts(): RichFacts { return { ...this.all }; }
}

export function richText(message: RichMessage): string {
  return message.blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

/** Pure-parser compatibility; filesystem readers supply their bounded disk store. */
export class MemoryRichStorage implements RichStorage {
  private entries: RichMessage[] = [];
  private tools = new Map<string, RichBlock>();
  private metadata = new RichFactsAccumulator();
  push(message: RichMessage): void {
    this.entries.push(message);
    this.metadata.add({ role: message.role, text: richText(message) });
  }
  rememberTool(id: string, block: RichBlock): void { this.tools.set(id, block); }
  findTool(id: string): RichBlock | undefined { return this.tools.get(id); }
  facts(): RichFacts { return this.metadata.facts(); }
  /** Page form: complete blocks stay in the parser's storage, pages carry capped details. */
  snapshot(): RichMessage[] {
    return this.entries.map(pageMessage);
  }
}

/** A message as a transcript page carries it: details capped, text intact. */
export function pageMessage(message: RichMessage): RichMessage {
  return { ...message, blocks: message.blocks.map(capRichBlock) };
}
