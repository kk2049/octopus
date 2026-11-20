import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CODEX_TITLE_INDEX_BYTES, readCodexSessionTitles } from "./codex-titles.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), "codex-titles-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const entry = (id: string, name: unknown, updated_at = "2026-09-15T00:00:00Z") =>
  JSON.stringify({ id, thread_name: name, updated_at });
const read = (...ids: string[]) => readCodexSessionTitles(home, new Set(ids));
const write = (text: string) => writeFile(path.join(home, "session_index.jsonl"), text);

it("uses the last valid name by exact id, tolerating bad and unfinished records", async () => {
  await write([
    entry("one", "old", "2099-01-01T00:00:00Z"),
    entry("other", "unrelated"), "null", "[]", "{bad",
    entry("one", "  检查科研任务\n执行结果  ", "2000-01-01T00:00:00Z"),
    entry("one", 42), '{"id":"one","thread_name":"partial',
  ].join("\n"));
  expect(await read("one", "missing")).toEqual(new Map([["one", "检查科研任务 执行结果"]]));
});

it("does not resurrect an older title when the latest name is empty", async () => {
  await write([entry("one", "old"), entry("one", " \n ")].join("\n"));
  expect(await read("one")).toEqual(new Map([["one", ""]]));
});

it("shares a bounded home index without losing names discovered in a later directory", async () => {
  await write([entry("one", "old"), entry("two", "second"), entry("one", "new")].join("\n"));
  expect(await readCodexSessionTitles(home)).toEqual(new Map([["one", "new"], ["two", "second"]]));
  expect(await readCodexSessionTitles(home, new Set())).toEqual(new Map());
});

it("observes index-only replacement and removal", async () => {
  await write(entry("one", "first"));
  expect((await read("one")).get("one")).toBe("first");
  await write([entry("one", "first"), entry("one", "next")].join("\n"));
  expect((await read("one")).get("one")).toBe("next");
  await write(entry("one", "replacement"));
  expect((await read("one")).get("one")).toBe("replacement");
  await rm(path.join(home, "session_index.jsonl"));
  expect(await read("one")).toEqual(new Map());
});

it("falls back when the optional index is absent or not a regular file", async () => {
  expect(await read("one")).toEqual(new Map());
  await mkdir(path.join(home, "session_index.jsonl"));
  expect(await read("one")).toEqual(new Map());
});

it("bounds reads to the newest index bytes and titles to 240 characters", async () => {
  await write(entry("old", "outside the budget") + "\n" + "x".repeat(CODEX_TITLE_INDEX_BYTES)
    + "\n" + entry("new", "名".repeat(300)) + "\n");
  const names = await read("old", "new");
  expect(names.has("old")).toBe(false);
  expect(names.get("new")).toBe("名".repeat(240));
});

it("never interprets a cut leading record as a complete entry", async () => {
  await write("x".repeat(CODEX_TITLE_INDEX_BYTES) + entry("one", "not a complete line"));
  expect(await read("one")).toEqual(new Map());
});
