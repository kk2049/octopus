import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateSessionEnumeration, searchSessions } from "./scan.js";
import { decodeSearchCursor, encodeSearchCursor, mergeSearchPages, searchPrefilterTokens } from "./search.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sessions-search-"));
});
afterEach(() => {
  invalidateSessionEnumeration(home);
  rmSync(home, { recursive: true, force: true });
});

/** One Claude log whose mtime orders it: larger `age` is older. */
function seed(id: string, text: string, age: number, raw?: string): void {
  const dir = join(home, ".claude", "projects", "-home-u-proj");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, raw ?? [
    { sessionId: id, timestamp: "2026-07-15T08:00:00.000Z", cwd: "/home/u/proj", type: "user", message: { role: "user", content: text } },
    { sessionId: id, timestamp: "2026-07-15T08:01:00.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const at = new Date(Date.UTC(2026, 6, 15) - age * 60_000);
  utimesSync(file, at, at);
}

interface Page {
  results: Array<{ session: { id: string }; matches: Array<{ snippet: string }>; cursor: string }>;
  next_cursor?: string;
  complete: boolean;
  scanned: number;
  total_candidates: number;
}

async function allPages(args: Record<string, unknown>, budgetMs?: number): Promise<{ pages: Page[]; ids: string[] }> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  do {
    const page = await searchSessions(home, { ...args, ...(cursor ? { cursor } : {}) }, budgetMs) as Page;
    pages.push(page);
    cursor = page.next_cursor;
    expect(page.complete).toBe(!cursor);
  } while (cursor && pages.length < 1_000);
  return { pages, ids: pages.flatMap((page) => page.results.map((hit) => hit.session.id)) };
}

describe("complete session search", () => {
  it("finds a match far beyond the old 100 most-recent-file horizon", async () => {
    for (let i = 0; i < 130; i++) seed(`s${String(i).padStart(3, "0")}`, i === 129 ? "the needle-word lives here" : `ordinary ${i}`, i);
    const page = await searchSessions(home, { query: "needle-word" }) as Page;
    expect(page.total_candidates).toBe(130);
    expect(page.scanned).toBe(130);
    expect(page.complete).toBe(true);
    expect(page.results.map((hit) => hit.session.id)).toEqual(["s129"]);
  });

  it("pages a time-bounded search through every session exactly once, newest first", async () => {
    for (let i = 0; i < 12; i++) seed(`s${String(i).padStart(2, "0")}`, i % 3 === 0 ? `hit marker ${i}` : `miss ${i}`, i);
    // A zero budget finishes exactly one candidate per call: the worst case for resumption.
    const { pages, ids } = await allPages({ query: "marker" }, 0);
    expect(pages).toHaveLength(12);
    expect(pages.every((page) => page.scanned === 1)).toBe(true);
    expect(ids).toEqual(["s00", "s03", "s06", "s09"]);
  });

  it("ends a page at `limit` hits and resumes after the last one", async () => {
    for (let i = 0; i < 7; i++) seed(`s${i}`, `marker ${i}`, i);
    const { pages, ids } = await allPages({ query: "marker", limit: 2 });
    expect(pages.map((page) => page.results.length)).toEqual([2, 2, 2, 1]);
    expect(ids).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6"]);
  });

  it("filters by since_hours", async () => {
    seed("fresh", "marker fresh", 0);
    seed("stale", "marker stale", 0);
    const old = new Date(Date.now() - 72 * 3600_000);
    utimesSync(join(home, ".claude", "projects", "-home-u-proj", "stale.jsonl"), old, old);
    const fresh = new Date();
    utimesSync(join(home, ".claude", "projects", "-home-u-proj", "fresh.jsonl"), fresh, fresh);
    const page = await searchSessions(home, { query: "marker", since_hours: 24 }) as Page;
    expect(page.results.map((hit) => hit.session.id)).toEqual(["fresh"]);
  });

  it("rejects a malformed cursor instead of restarting silently", async () => {
    seed("a", "marker", 0);
    await expect(searchSessions(home, { query: "marker", cursor: "not-a-cursor" })).rejects.toThrow(/cursor/);
  });

  it("streams records larger than one read chunk and a final record without newline", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const raw = [
      JSON.stringify({ sessionId: "big", timestamp: "2026-07-15T08:00:00.000Z", type: "user", message: { role: "user", content: "start" } }),
      JSON.stringify({ sessionId: "big", timestamp: "2026-07-15T08:01:00.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `${big} tail-needle` }] } }),
      JSON.stringify({ sessionId: "big", timestamp: "2026-07-15T08:02:00.000Z", type: "user", message: { role: "user", content: "last-needle" } }),
    ].join("\n");
    seed("big", "", 0, raw);
    const tail = await searchSessions(home, { query: "tail-needle" }) as Page;
    expect(tail.results[0]?.matches[0]?.snippet).toContain("tail-needle");
    const last = await searchSessions(home, { query: "last-needle" }) as Page;
    expect(last.results.map((hit) => hit.session.id)).toEqual(["big"]);
  });

  it("keeps matches the raw-byte prefilter cannot see verbatim", async () => {
    // A writer that escapes non-ASCII text hides the letters from the raw bytes.
    const escaped = JSON.stringify({ sessionId: "esc", timestamp: "2026-07-15T08:00:00.000Z", type: "user", message: { role: "user", content: "讨论缓存一致性" } })
      .replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
    seed("esc", "", 0, escaped + "\n");
    const page = await searchSessions(home, { query: "缓存一致性" }) as Page;
    expect(page.results.map((hit) => hit.session.id)).toEqual(["esc"]);
    // Words the parser itself may write never become required raw tokens.
    expect(searchPrefilterTokens("Tool call")).toEqual(["call"]);
  });
});

describe("mergeSearchPages", () => {
  const hit = (mtimeMs: number, key: string, device: string) => ({
    session: { id: key, device },
    cursor: encodeSearchCursor({ mtimeMs, key }),
  });
  const page = (results: ReturnType<typeof hit>[], next?: { mtimeMs: number; key: string }) => ({
    results,
    complete: !next,
    scanned: results.length,
    total_candidates: 10,
    ...(next ? { next_cursor: encodeSearchCursor(next) } : {}),
  });

  it("keeps only hits every child has searched past", () => {
    const fast = page([hit(900, "a", "fast"), hit(500, "b", "fast"), hit(100, "c", "fast")]);
    const slow = page([hit(800, "d", "slow")], { mtimeMs: 600, key: "z" });
    const merged = mergeSearchPages([{ label: "fast", page: fast }, { label: "slow", page: slow }], 10, false);
    expect(merged.results.map((item) => (item.session as { id: string }).id)).toEqual(["a", "d"]);
    expect(decodeSearchCursor(merged.next_cursor)).toEqual({ mtimeMs: 600, key: "z" });
    expect(merged.complete).toBe(false);
  });

  it("windows to the limit without splitting equal positions", () => {
    const one = page([hit(900, "a", "one"), hit(800, "same", "one"), hit(700, "c", "one")]);
    const two = page([hit(800, "same", "two")]);
    const merged = mergeSearchPages([{ label: "one", page: one }, { label: "two", page: two }], 2, false);
    expect(merged.results.map((item) => (item.session as { device: string }).device)).toEqual(["one", "one", "two"]);
    expect(decodeSearchCursor(merged.next_cursor)).toEqual({ mtimeMs: 800, key: "same" });
  });

  it("names failed and legacy children; legacy hits only on the first page", () => {
    const legacy = { results: [{ session: { id: "old" } }], scanned: 100, total_candidates: 400 };
    const parts = [{ label: "laptop", page: legacy }, { label: "desk" }, { label: "ok", page: page([]) }];
    const first = mergeSearchPages(parts, 10, false);
    expect(first.results.map((item) => (item.session as { id: string }).id)).toEqual(["old"]);
    expect(first).toMatchObject({ complete: true, incomplete_sources: ["desk", "laptop"] });
    expect(mergeSearchPages(parts, 10, true).results).toEqual([]);
  });

  it("propagates nested incomplete sources", () => {
    const nested = { ...page([]), incomplete_sources: ["old-laptop"] };
    expect(mergeSearchPages([{ label: "runner", page: nested }], 10, false).incomplete_sources).toEqual(["old-laptop"]);
  });
});
