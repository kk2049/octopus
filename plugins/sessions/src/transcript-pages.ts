import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { RichBlock, RichMessage } from "./parse.js";
import {
  RICH_BLOCK_FIELDS, RichFactsAccumulator, capRichBlock, richFieldCap, richText,
  type RichStorage,
} from "./rich-storage.js";

const HOT_BYTES = 2 * 1024 * 1024;
const HOT_MESSAGES = 128;
const livePages = new Set<TranscriptPages>();
process.once("exit", () => { for (const pages of livePages) pages.dispose(true); });

interface HotMessage { message: RichMessage; dirty: boolean; bytes: number }

/** One page window: up to `limit` messages ending at `end` (or from `start`), within `budgetBytes`. */
export interface PageWindow {
  /** Keep the first messages from `start`, or the last ones before `end`. */
  start?: number;
  end?: number;
  limit: number;
  budgetBytes: number;
}

/** A message larger than a whole page keeps text previews of this size (complete via a block read). */
export const OVERSIZE_TEXT_PREVIEW = 16_000;

/**
 * Disposable device-private transcript pages. Fixed-width offsets point into
 * an append journal; late tool results replace only their message's pointer.
 * Tool IDs are hashed filenames, never filesystem coordinates from a provider.
 * This uses Node 20 builtins, preserving the standalone Runner's installation.
 * The source log is authoritative: eviction/restart can always rebuild it.
 *
 * Messages are journaled in page form (capped details). A detail field over
 * its page cap is written whole to its own file, keyed by message, block and
 * field, so a block read returns it complete and a late tool result rewrites
 * only the small page-form message plus that one field.
 */
export class TranscriptPages implements RichStorage {
  private readonly directory = mkdtempSync(path.join(os.tmpdir(), "octopus-transcript-"));
  private readonly data: number;
  private readonly index: number;
  private readonly metadata = new RichFactsAccumulator();
  private readonly toolIds = new WeakMap<RichBlock, string>();
  private readonly hot = new Map<number, HotMessage>();
  /** Blocks currently in page form (loaded from the journal); every other block is complete. */
  private readonly paged = new WeakSet<RichBlock>();
  private size = 0;
  private count = 0;
  private hotBytes = 0;
  private closed = false;

  constructor() {
    const opened: number[] = [];
    try {
      this.data = openSync(path.join(this.directory, "messages"), "wx+", 0o600); opened.push(this.data);
      this.index = openSync(path.join(this.directory, "offsets"), "wx+", 0o600); opened.push(this.index);
      mkdirSync(path.join(this.directory, "tools"), { mode: 0o700 });
      mkdirSync(path.join(this.directory, "fields"), { mode: 0o700 });
      livePages.add(this);
    } catch (error) {
      for (const fd of opened) closeSync(fd);
      rmSync(this.directory, { recursive: true, force: true });
      throw error;
    }
  }

  push(message: RichMessage): void {
    const id = this.count++;
    this.metadata.add({ role: message.role, text: richText(message) });
    this.hot.set(id, { message, dirty: true, bytes: Buffer.byteLength(JSON.stringify(message)) });
    this.hotBytes += this.hot.get(id)!.bytes;
    message.blocks.forEach((block, blockIndex) => {
      const key = this.toolIds.get(block);
      if (key) writeFileSync(this.toolFile(key), JSON.stringify([id, blockIndex]), { mode: 0o600 });
    });
    this.trim();
  }

  rememberTool(id: string, block: RichBlock): void { this.toolIds.set(block, id); }

  findTool(id: string): RichBlock | undefined {
    try {
      const [messageId, block] = JSON.parse(readFileSync(this.toolFile(id), "utf8")) as [number, number];
      const entry = this.load(messageId);
      // The parser mutates the returned block synchronously before flush, so
      // it must see the complete fields, not their page form.
      entry.dirty = true;
      const found = entry.message.blocks[block];
      if (found) this.restore(messageId, block, found);
      return found;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  facts() { return this.metadata.facts(); }
  // Metadata snapshot must never materialize the complete history in memory.
  snapshot(): RichMessage[] { return []; }

  /**
   * Page-form messages of one window. The window is bounded by count AND by
   * serialized bytes: it keeps messages from its anchored side while they fit,
   * always at least one. A single message larger than the budget keeps text
   * previews (`truncated`); every block stays complete through `block()`.
   */
  page(window: PageWindow): { offset: number; messages: RichMessage[]; byteLimited: boolean } {
    this.flush();
    const total = this.facts().count;
    const fromEnd = window.start === undefined;
    const end = fromEnd ? Math.max(0, Math.min(total, window.end ?? total)) : Math.min(total, window.start! + window.limit);
    const start = fromEnd ? Math.max(0, end - window.limit) : Math.max(0, Math.min(window.start!, total));
    const out: RichMessage[] = [];
    let bytes = 0;
    let byteLimited = false;
    for (let index = 0; index < end - start; index++) {
      const ordinal = fromEnd ? end - 1 - index : start + index;
      let message = pageForm(this.load(ordinal).message);
      this.trim();
      let size = Buffer.byteLength(JSON.stringify(message));
      if (out.length && bytes + size > window.budgetBytes) { byteLimited = true; break; }
      if (size > window.budgetBytes) {
        message = { ...message, blocks: message.blocks.map(oversizePreview) };
        size = Buffer.byteLength(JSON.stringify(message));
        byteLimited = true;
      }
      bytes += size;
      out.push(message);
    }
    if (fromEnd) out.reverse();
    return { offset: fromEnd ? end - out.length : start, messages: out, byteLimited };
  }

  /** One complete block of the visible message at `ordinal`, or undefined. */
  block(ordinal: number, blockIndex: number): RichBlock | undefined {
    this.flush();
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= this.facts().count) return undefined;
    const id = ordinal;
    const found = this.load(id).message.blocks[blockIndex];
    this.trim();
    if (!found) return undefined;
    const block = structuredClone(found);
    if (this.paged.has(found)) this.readFields(id, blockIndex, block);
    delete block.truncated_fields;
    return block;
  }

  flush(): void {
    for (const [id, entry] of this.hot) this.save(id, entry);
    this.trim();
  }

  dispose(synchronous = false): void {
    if (this.closed) return;
    this.closed = true;
    livePages.delete(this);
    for (const fd of [this.data, this.index]) closeSync(fd);
    this.hot.clear(); this.hotBytes = 0;
    if (synchronous) { try { rmSync(this.directory, { recursive: true, force: true }); } catch { /* disposable cache */ } }
    else void rm(this.directory, { recursive: true, force: true }).catch(() => {});
  }

  /** Diagnostic bound excludes the caller-owned returned page and current JSON record. */
  retainedBytes(): number { return this.hotBytes; }

  private fieldFile(id: number, block: number, field: string): string {
    return path.join(this.directory, "fields", `${id}-${block}-${field}`);
  }

  /** Put a page-form block's complete fields back in place (no-op for a complete block). */
  private restore(id: number, blockIndex: number, block: RichBlock): void {
    if (!this.paged.has(block)) return;
    this.paged.delete(block);
    this.readFields(id, blockIndex, block);
  }

  private readFields(id: number, blockIndex: number, block: RichBlock): void {
    if (!block.truncated) return;
    for (const field of RICH_BLOCK_FIELDS) {
      try { block[field] = readFileSync(this.fieldFile(id, blockIndex, field), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    delete block.truncated;
    delete block.truncated_fields;
  }

  private toolFile(id: string): string {
    return path.join(this.directory, "tools", createHash("sha256").update(id).digest("hex"));
  }

  private load(id: number): HotMessage {
    let entry = this.hot.get(id);
    if (entry) { this.hot.delete(id); this.hot.set(id, entry); return entry; }
    const pointer = Buffer.alloc(16);
    if (readSync(this.index, pointer, 0, 16, id * 16) !== 16) throw new Error("incomplete transcript offset");
    const length = pointer.readDoubleLE(8);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(this.data, buffer, read, length - read, pointer.readDoubleLE() + read);
      if (!n) throw new Error("incomplete transcript page");
      read += n;
    }
    entry = { message: JSON.parse(buffer.toString("utf8")) as RichMessage, dirty: false, bytes: length };
    for (const block of entry.message.blocks) this.paged.add(block);
    this.hot.set(id, entry); this.hotBytes += length;
    return entry;
  }

  private save(id: number, entry: HotMessage): void {
    if (!entry.dirty) return;
    // Complete blocks go to page form here; their over-cap fields are kept whole beside the journal.
    const blocks = entry.message.blocks.map((block, blockIndex) => {
      if (this.paged.has(block)) return block;
      const paged = capRichBlock(block);
      for (const field of RICH_BLOCK_FIELDS) {
        const limit = richFieldCap(block, field);
        const value = block[field];
        if (limit !== undefined && typeof value === "string" && value.length > limit) {
          writeFileSync(this.fieldFile(id, blockIndex, field), value, { mode: 0o600 });
        }
      }
      this.paged.add(paged);
      return paged;
    });
    entry.message = { ...entry.message, blocks };
    const buffer = Buffer.from(JSON.stringify(entry.message));
    writeAll(this.data, buffer, this.size);
    const pointer = Buffer.alloc(16); pointer.writeDoubleLE(this.size); pointer.writeDoubleLE(buffer.length, 8);
    writeAll(this.index, pointer, id * 16);
    this.size += buffer.length;
    this.hotBytes += buffer.length - entry.bytes; entry.bytes = buffer.length; entry.dirty = false;
  }

  private trim(): void {
    while (this.hot.size > HOT_MESSAGES || this.hotBytes > HOT_BYTES) {
      const [id, entry] = this.hot.entries().next().value!;
      this.save(id, entry); this.hot.delete(id); this.hotBytes -= entry.bytes;
    }
  }
}

function writeAll(fd: number, buffer: Buffer, position: number): void {
  let written = 0;
  while (written < buffer.length) {
    const count = writeSync(fd, buffer, written, buffer.length - written, position + written);
    if (!count) throw new Error("incomplete transcript index write");
    written += count;
  }
}

/** Page form of a hot (possibly complete) or journaled message. */
function pageForm(message: RichMessage): RichMessage {
  return structuredClone({ ...message, blocks: message.blocks.map(capRichBlock) });
}

/** Text preview for a message that alone exceeds a page. */
function oversizePreview(block: RichBlock): RichBlock {
  if (block.type !== "text" || typeof block.text !== "string" || block.text.length <= OVERSIZE_TEXT_PREVIEW) return block;
  const { bilingual: _bilingual, ...rest } = block;
  return { ...rest, text: block.text.slice(0, OVERSIZE_TEXT_PREVIEW) + "…", truncated: true, truncated_fields: ["text"] };
}
