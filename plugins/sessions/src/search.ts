/**
 * Complete, resumable full-text search over session logs.
 *
 * The invariant is "bound the window, not the total": one call does a bounded
 * amount of work (a result page and a time budget) and returns `next_cursor`
 * while candidates remain, so repeated calls cover every session a scan root
 * holds. Nothing is skipped silently: a source that could not be searched
 * completely is named in `incomplete_sources`.
 *
 * ── Positions ───────────────────────────────────────────────────────────────
 *
 * Candidates are visited newest-first by (mtime desc, key asc), where key is
 * `${source}:${id}`. The order is device-independent, so every fan-out level
 * (gateway devices, Sessions+ catalog supplements, Runner + bot-host planes)
 * forwards the SAME cursor to each child and merges with one rule:
 *
 *   page contract: every candidate in (cursor, next_cursor] was examined and
 *   every hit in that range is in `results`.
 *
 * A merge keeps only hits at or before the least advanced child's watermark
 * (the frontier) and windows them to `limit`, never splitting equal positions
 * (the same chat id on two devices). Hits a faster child found beyond the
 * frontier are found again on the next page; each page advances the frontier
 * by at least the slowest child's one candidate, so a search always finishes.
 *
 * Not a snapshot: a session written to after the first page moves ahead of the
 * cursor and is found by a fresh search. Files that do not change are covered
 * exactly once.
 *
 * ── Prefilter ───────────────────────────────────────────────────────────────
 *
 * Parsing every record is the expensive part. A file can match only if every
 * letter/number run of the query occurs in its raw bytes (case-folded), unless
 * that run could have been synthesized by the parser (FLAT_SYNTHESIZED_TEXT)
 * or the file escapes non-ASCII text as \uXXXX. Files failing that necessary
 * condition are skipped after one streaming pass; the rest are parsed record
 * by record with memory bounded by one JSON record, never by file size.
 */

import fs, { type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import {
  FLAT_SYNTHESIZED_TEXT,
  createSessionFlatParser,
  safeJsonParse,
  type FlatMessage,
  type SessionMeta,
  type Source,
} from "./parse.js";

/** One call's work bound. At least one candidate is always finished, so every call makes progress. */
export const SEARCH_BUDGET_MS = 8_000; // inside the 30 s gateway RPC timeout, with room for one large file

/** Result-page window; totals are reached through `next_cursor`. */
export const SEARCH_PAGE_MAX = 50;
/** Opaque cursor size accepted at every boundary. */
export const SEARCH_CURSOR_MAX_CHARS = 1024;
const MATCHES_PER_SESSION = 3;
const READ_CHUNK_BYTES = 1024 * 1024;

export interface SearchPosition {
  mtimeMs: number;
  /** `${source}:${id}` — one chat per key on a device; copies keep the freshest file. */
  key: string;
}

/** Scan order: newest first, then key. Negative = `a` is visited first. */
export function compareSearchPositions(a: SearchPosition, b: SearchPosition): number {
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function encodeSearchCursor(position: SearchPosition): string {
  return JSON.stringify([position.mtimeMs, position.key]);
}

/** Absent/empty is "from the start" (null); anything else malformed throws. */
export function decodeSearchCursor(value: unknown): SearchPosition | null {
  if (value === undefined || value === null || value === "") return null;
  const invalid = new Error("search_sessions cursor 无效；请重新搜索");
  if (typeof value !== "string" || value.length > SEARCH_CURSOR_MAX_CHARS) throw invalid;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid; }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid;
  const [mtimeMs, key] = parsed as unknown[];
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs) || typeof key !== "string") throw invalid;
  return { mtimeMs, key };
}

function position(value: unknown): SearchPosition | null {
  try { return decodeSearchCursor(value); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Merging child pages
// ---------------------------------------------------------------------------

/** One child of a fan-out: its page, or no page when the call failed. */
export interface SearchPagePart {
  /** Device or plane name, reported when this child's coverage is incomplete. */
  label: string;
  page?: unknown;
}

export interface MergedSearchPage {
  results: Array<Record<string, unknown>>;
  next_cursor?: string;
  complete: boolean;
  scanned: number;
  total_candidates: number;
  /** Sources this page could not search completely: a failed call or a Runner that predates complete search. */
  incomplete_sources?: string[];
}

/**
 * A page from a scanner that ignores `cursor` (it searched only its most recent
 * sessions and stamps no positions).
 */
export function isLegacySearchPage(page: unknown): boolean {
  return typeof (page as { complete?: unknown } | null | undefined)?.complete !== "boolean";
}

/**
 * Merge child pages under the page contract above. `continuation` is whether
 * the request carried a cursor: legacy children contribute their (unpositioned)
 * hits only to the first page, after the positioned window.
 */
export function mergeSearchPages(parts: readonly SearchPagePart[], limit: number, continuation: boolean): MergedSearchPage {
  let frontier: SearchPosition | null = null;
  let scanned = 0;
  let candidates = 0;
  const incomplete = new Set<string>();
  const positioned: Array<{ position: SearchPosition; item: Record<string, unknown> }> = [];
  const legacy: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.page === undefined) { incomplete.add(part.label); continue; }
    const page = record(part.page);
    scanned += count(page.scanned);
    candidates += count(page.total_candidates);
    for (const label of Array.isArray(page.incomplete_sources) ? page.incomplete_sources : []) {
      if (typeof label === "string" && label) incomplete.add(label);
    }
    const items = Array.isArray(page.results) ? page.results.filter(isRecord) : [];
    if (isLegacySearchPage(page)) {
      incomplete.add(part.label);
      if (!continuation) legacy.push(...items);
      continue;
    }
    const watermark = page.complete === true ? null : position(page.next_cursor);
    if (page.complete !== true && !watermark) { incomplete.add(part.label); continue; }
    if (watermark && (!frontier || compareSearchPositions(watermark, frontier) < 0)) frontier = watermark;
    for (const item of items) {
      const at = position(item.cursor);
      if (at) positioned.push({ position: at, item });
    }
  }
  const final = positioned
    .filter(({ position: at }) => !frontier || compareSearchPositions(at, frontier) <= 0)
    .sort((a, b) => compareSearchPositions(a.position, b.position));
  let end = Math.min(final.length, Math.max(1, limit));
  // Equal positions are one step of the order: a cursor between them would skip one.
  while (end > 0 && end < final.length && compareSearchPositions(final[end - 1]!.position, final[end]!.position) === 0) end++;
  const next = end < final.length ? final[end - 1]!.position : frontier;
  return {
    results: [...final.slice(0, end).map(({ item }) => item), ...legacy],
    ...(next ? { next_cursor: encodeSearchCursor(next) } : {}),
    complete: !next,
    scanned,
    total_candidates: candidates,
    ...(incomplete.size ? { incomplete_sources: [...incomplete].sort() } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------

const SYNTHESIZED = FLAT_SYNTHESIZED_TEXT.toLowerCase();

/**
 * Case-folded letter/number runs every matching file must contain verbatim.
 * Sigma is a separator because its lower case depends on the next letter.
 */
export function searchPrefilterTokens(query: string): string[] {
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+|[σς]/u).filter(Boolean);
  return [...new Set(tokens)].filter((token) => !SYNTHESIZED.includes(token));
}

/** A \uXXXX escape of a non-ASCII code point: such a writer hides letters from the raw prefilter. */
const NON_ASCII_ESCAPE = /\\u(?!00[0-7])[0-9a-f]{4}/;

async function readChunk(handle: FileHandle, at: number, buffer: Buffer): Promise<number> {
  let read = 0;
  while (read < buffer.length) {
    const result = await handle.read(buffer, read, buffer.length - read, at + read);
    if (!result.bytesRead) break;
    read += result.bytesRead;
  }
  return read;
}

/** One streaming pass: may this file contain every required token? */
async function mayContain(handle: FileHandle, size: number, tokens: readonly string[]): Promise<boolean> {
  const missing = new Set(tokens);
  const guardEscapes = tokens.some((token) => /[^\x00-\x7f]/.test(token));
  const overlap = Math.max(5, ...tokens.map((token) => token.length - 1));
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let tail = "";
  for (let at = 0; at < size;) {
    const read = await readChunk(handle, at, buffer);
    if (!read) break;
    at += read;
    const text = tail + decoder.write(buffer.subarray(0, read)).toLowerCase();
    if (guardEscapes && NON_ASCII_ESCAPE.test(text)) return true;
    for (const token of missing) if (text.includes(token)) missing.delete(token);
    if (!missing.size) return true;
    tail = text.slice(-overlap);
  }
  return false;
}

/** Feed complete JSONL records to `sink`, holding at most one partial record. */
async function streamRecords(handle: FileHandle, size: number, sink: (records: unknown[]) => void): Promise<void> {
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let partial: Buffer[] = [];
  for (let at = 0; at < size;) {
    const read = await readChunk(handle, at, buffer);
    if (!read) break;
    at += read;
    let chunk = buffer.subarray(0, read);
    let newline = chunk.indexOf(10);
    if (newline < 0) { partial.push(Buffer.from(chunk)); continue; }
    if (partial.length) {
      sink([safeJsonParse(Buffer.concat([...partial, chunk.subarray(0, newline)]).toString("utf8"))]);
      partial = [];
      chunk = chunk.subarray(newline + 1);
    }
    newline = chunk.lastIndexOf(10);
    if (newline >= 0) sink(chunk.subarray(0, newline).toString("utf8").split("\n").map(safeJsonParse));
    if (newline + 1 < chunk.length) partial.push(Buffer.from(chunk.subarray(newline + 1)));
  }
  // A complete final record without its newline is still a record.
  if (partial.length) sink([safeJsonParse(Buffer.concat(partial).toString("utf8"))]);
}

/** Stream one log's complete JSONL records; memory is bounded by one record, not the file. */
export async function streamSessionRecords(file: string, sink: (records: unknown[]) => void): Promise<void> {
  const handle = await fs.open(file, "r");
  try { await streamRecords(handle, (await handle.stat()).size, sink); } finally { await handle.close(); }
}

function findSnippet(text: string, query: string): string | null {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + query.length + 80);
  const core = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + core + (end < text.length ? "…" : "");
}

export interface SearchMatch { role: string; snippet: string; tool?: string }

export interface SearchFileHit {
  meta: SessionMeta;
  matches: SearchMatch[];
}

/**
 * Search one log. Returns null when it cannot match. The hit has up to three
 * snippets from the messages the flat projection keeps (tool names and text),
 * or none when only the title/first prompt/preview matched.
 */
export async function searchSessionFile(
  file: string,
  source: Source,
  query: string,
  tokens: readonly string[] = searchPrefilterTokens(query),
): Promise<SearchFileHit | null> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    if (tokens.length && !(await mayContain(handle, size, tokens))) return null;
    const matches: SearchMatch[] = [];
    const parser = createSessionFlatParser(source, (message: FlatMessage) => {
      if (matches.length >= MATCHES_PER_SESSION) return;
      const snippet = findSnippet(`${message.tool ?? ""} ${message.text}`, query);
      if (!snippet) return;
      matches.push({ role: message.role, snippet, ...(message.tool ? { tool: message.tool } : {}) });
    });
    await streamRecords(handle, size, (records) => parser.append(records));
    const meta = parser.snapshot();
    const needle = query.toLowerCase();
    const metaHit = !matches.length
      && [meta.title, meta.first_user_text, meta.preview].some((text) => text?.toLowerCase().includes(needle));
    return matches.length || metaHit ? { meta, matches } : null;
  } finally {
    await handle.close();
  }
}
