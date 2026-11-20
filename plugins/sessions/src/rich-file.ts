import fs, { type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  createSessionRichParser, createSessionSummaryParser, safeJsonParse,
  type RichBlock, type RichMessage, type RichSessionParser, type SessionMeta, type Source,
} from "./parse.js";

import { TranscriptWork } from "./transcript-work.js";
import { TranscriptPages } from "./transcript-pages.js";

const RICH_CACHE_MAX = 64;
const SUMMARY_CACHE_MAX = 1_024;
const CHUNK_BYTES = 128 * 1024;
const PROOF_BYTES = 256;

interface Entry {
  leases: number;
  retired: boolean;
  source: Source;
  parser?: RichSessionParser;
  pages?: TranscriptPages;
  summary: ReturnType<typeof createSessionSummaryParser>;
  version: Stats;
  partial: Buffer[];
  partialApplied: boolean;
  prefix: Buffer;
  boundary: Buffer;
}

const entries = new Map<string, Entry>();
const flights = new Map<string, Promise<Entry>>();
// One CPU-heavy source chunk at a time across all RPCs and site projectors.
// Jobs yield between bounded chunks, so hook acknowledgements and heartbeat
// traffic can proceed while a cold history is materialized.
const work = new TranscriptWork();
export const transcriptReadStats = { sourceBytes: 0, rebuilds: 0, incremental: 0, reused: 0 };

function fresh(source: Source, version: Stats, rich: boolean): Entry {
  const pages = rich ? new TranscriptPages() : undefined;
  transcriptReadStats.rebuilds++;
  return { leases: 0, retired: false, source, version, pages, parser: pages ? createSessionRichParser(source, pages) : undefined,
    summary: createSessionSummaryParser(source), partial: [], partialApplied: false,
    prefix: Buffer.alloc(0), boundary: Buffer.alloc(0) };
}
function sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameVersion(a: Stats, b: Stats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function bytes(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, start + read);
    if (!result.bytesRead) break;
    read += result.bytesRead;
    transcriptReadStats.sourceBytes += result.bytesRead;
  }
  return buffer.subarray(0, read);
}

function retire(entry: Entry): void {
  entry.retired = true;
  if (!entry.leases) entry.pages?.dispose();
}
function release(entry: Entry): void {
  entry.leases--;
  if (entry.retired && !entry.leases) entry.pages?.dispose();
}
function forget(file: string): void {
  const entry = entries.get(file);
  if (entry) retire(entry);
  entries.delete(file);
}
function retain(file: string, entry: Entry): void {
  entries.delete(file);
  // Background roster discovery cannot evict the body pages of live chats.
  const peers = [...entries].filter(([, other]) => Boolean(other.pages) === Boolean(entry.pages));
  const limit = entry.pages ? RICH_CACHE_MAX : SUMMARY_CACHE_MAX;
  for (let i = 0; i <= peers.length - limit; i++) forget(peers[i]![0]);
  entries.set(file, entry);
}
function apply(entry: Entry, text: string): void {
  const records = text.split(/\r?\n/).map(safeJsonParse);
  entry.parser?.append(records); entry.summary.append(records);
}

/** True native records may end before their final newline; preserve that old reader behavior. */
function append(entry: Entry, input: Buffer): boolean {
  let added = input;
  if (entry.partialApplied) {
    const end = input.indexOf(10);
    if (input.subarray(0, end < 0 ? input.length : end).toString("utf8").trim()) return false;
    if (end < 0) return true;
    entry.partialApplied = false;
    added = input.subarray(end + 1);
  }
  const first = added.indexOf(10);
  if (first >= 0 && entry.partial.length) {
    apply(entry, Buffer.concat([...entry.partial, added.subarray(0, first)]).toString("utf8"));
    entry.partial = [];
    added = added.subarray(first + 1);
  }
  const end = added.lastIndexOf(10);
  if (end >= 0) apply(entry, added.subarray(0, end + 1).toString("utf8"));
  if (end + 1 < added.length) entry.partial.push(Buffer.from(added.subarray(end + 1)));
  return true;
}

function finishPartial(entry: Entry): void {
  if (!entry.partial.length) return;
  // Decode once at the observed EOF, not once per chunk of a large JSON line.
  // Incomplete UTF-8/JSON bytes remain available for the next source append.
  const text = Buffer.concat(entry.partial).toString("utf8");
  if (safeJsonParse(text) !== null) {
    apply(entry, text);
    entry.partial = [];
    entry.partialApplied = true;
  }
}

async function refresh(file: string, source: Source, rich: boolean): Promise<Entry> {
  const handle = await fs.open(file, "r");
  try {
    const current = await handle.stat();
    if (!current.isFile()) throw new Error("session transcript is not a regular file");
    const cached = entries.get(file);
    const previous = rich && !cached?.pages ? undefined : cached;
    if (previous?.source === source && sameVersion(previous.version, current)) {
      entries.delete(file); entries.set(file, previous);
      transcriptReadStats.reused++;
      return previous;
    }
    let entry = previous;
    let start = previous?.version.size ?? 0;
    let appendable = Boolean(previous && previous.source === source && sameIdentity(previous.version, current)
      && current.size > previous.version.size);
    if (appendable && previous) {
      // Native files are append-only. Cheap prefix/boundary proofs also detect
      // normal in-place truncate+regrow, replacement and non-append tail edits.
      const [prefix, boundary] = await Promise.all([
        bytes(handle, 0, previous.prefix.length),
        bytes(handle, start - previous.boundary.length, previous.boundary.length),
      ]);
      appendable = prefix.equals(previous.prefix) && boundary.equals(previous.boundary);
    }
    if (!appendable || !entry) {
      forget(file); entry = fresh(source, current, rich || Boolean(previous?.pages)); start = 0;
    } else transcriptReadStats.incremental++;
    entries.delete(file);
    try {
      let position = start;
      while (position < current.size) {
        const length = Math.min(CHUNK_BYTES, current.size - position);
        const advanced = await work.run(rich || Boolean(entry.pages), async () => {
          const added = await bytes(handle, position, length);
          if (added.length !== length) throw new Error("session transcript changed while being read");
          if (!append(entry!, added)) return false;
          entry!.pages?.flush();
          return true;
        });
        if (!advanced) {
          retire(entry); entry = fresh(source, current, rich || Boolean(previous?.pages)); position = 0; continue;
        }
        position += length;
      }
      await work.run(rich || Boolean(entry.pages), async () => { finishPartial(entry!); entry!.pages?.flush(); });
      entry.version = current;
      [entry.prefix, entry.boundary] = await Promise.all([
        bytes(handle, 0, Math.min(PROOF_BYTES, current.size)),
        bytes(handle, Math.max(0, current.size - PROOF_BYTES), Math.min(PROOF_BYTES, current.size)),
      ]);
      retain(file, entry);
      return entry;
    } catch (error) { retire(entry); throw error; }
  } finally { await handle.close(); }
}
export interface RichTranscriptPage {
  meta: SessionMeta;
  messages: RichMessage[];
  offset: number;
  total: number;
  /** The page ended early at its byte budget; continue from its edge. */
  byteLimited: boolean;
}

/**
 * Serialized bytes of messages one transcript page may carry. The capability
 * kernel refuses a per-call result over 8 MiB, device-local Claude translation
 * can add English and Chinese copies of the text, and the Runner's pushed
 * transcript projection is limited to 2 MiB, so a page stays well inside all three.
 */
export const RICH_PAGE_BYTES = 1024 * 1024;

/** Coalesce source work, not caller windows or authorization decisions. */
async function sharedEntry(file: string, source: Source, rich = false): Promise<Entry> {
  const key = source + "\0" + file;
  const existing = flights.get(key);
  if (existing) {
    await existing;
    // A caller may have observed an append while the first snapshot was read.
    // Re-stat after joining; changed bytes are still decoded only once.
    return sharedEntry(file, source, rich);
  }
  if (flights.size >= 128) throw new Error("transcript source queue is full");
  const flight = refresh(file, source, rich);
  flights.set(key, flight);
  try {
    const entry = await flight;
    if (entry.retired) throw new Error("transcript cache evicted during source read; retry");
    entry.leases++;
    return entry;
  }
  finally { if (flights.get(key) === flight) flights.delete(key); }
}

/**
 * Only this request's bounded page leaves the device-private index. With
 * `requestedOffset` (and no `before`) the window starts there and keeps its
 * first messages; otherwise it ends at `before` (default: the end) and keeps
 * its last ones. Either way it stops at `budgetBytes`, never mid-message.
 */
export async function readRichTranscriptFile(
  file: string, source: Source, maxMessages: number, requestedOffset?: number, before?: number,
  budgetBytes = RICH_PAGE_BYTES,
): Promise<RichTranscriptPage> {
  const entry = await sharedEntry(file, source, true);
  try {
    const meta = entry.parser!.snapshot().meta;
    const total = meta.message_count;
    const clamp = (value: number): number => Math.max(0, Math.min(Math.floor(value), total));
    const page = entry.pages!.page(before === undefined && requestedOffset !== undefined
      ? { start: clamp(requestedOffset), limit: maxMessages, budgetBytes }
      : { end: before === undefined ? total : clamp(before), limit: maxMessages, budgetBytes });
    return { meta: structuredClone(meta), messages: page.messages, offset: page.offset, total, byteLimited: page.byteLimited };
  } finally { release(entry); }
}

/** One complete block of the visible message at `ordinal` (the page offset space). */
export async function readRichTranscriptBlock(
  file: string, source: Source, ordinal: number, blockIndex: number,
): Promise<{ meta: SessionMeta; total: number; block: RichBlock | undefined }> {
  const entry = await sharedEntry(file, source, true);
  try {
    const meta = entry.parser!.snapshot().meta;
    return { meta: structuredClone(meta), total: meta.message_count, block: entry.pages!.block(ordinal, blockIndex) };
  } finally { release(entry); }
}

export async function readSessionSummaryFile(file: string, source: Source): Promise<SessionMeta> {
  const entry = await sharedEntry(file, source);
  try { return entry.summary.snapshot(); } finally { release(entry); }
}

/** @internal Deterministic cache isolation in filesystem tests. */
export function resetRichTranscriptFiles(): void {
  for (const file of entries.keys()) forget(file);
  for (const key of Object.keys(transcriptReadStats) as Array<keyof typeof transcriptReadStats>) transcriptReadStats[key] = 0;
}
