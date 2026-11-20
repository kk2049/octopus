import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionFlatParser, createSessionRichParser, parseSessionRich, parseSessionText } from "./parse.js";
import { readRichTranscriptBlock, readRichTranscriptFile, readSessionSummaryFile, resetRichTranscriptFiles } from "./rich-file.js";
import { invalidateSessionEnumeration, readSession } from "./scan.js";
import { searchSessionFile } from "./search.js";

const item = (role: string, text: string) => ({ type: "response_item", payload: {
  type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }],
} });
const event = (role: string, text: string) => ({ type: "event_msg", payload: {
  type: role === "user" ? "user_message" : "agent_message", message: text,
} });
const marker = (type: string) => ({ type: "event_msg", payload: { type } });
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

describe("Codex restored history and mirrored messages", () => {
  it.each([true, false])("keeps history and consumes each matching mirror once (item first: %s)", (itemFirst) => {
    const pair = (role: string, text: string) => itemFirst
      ? [item(role, text), event(role, text)] : [event(role, text), item(role, text)];
    const rows = [item("user", "original question"), item("assistant", "original answer"),
      ...pair("user", "hi"), ...pair("assistant", "hello"), ...pair("user", "hi"),
      item("assistant", "item-only continuation"), event("assistant", "different event text")];
    const expected = ["original question", "original answer", "hi", "hello", "hi", "item-only continuation", "different event text"];
    const flatMessages: string[] = [];
    const flat = createSessionFlatParser("codex", (message) => flatMessages.push(message.text));
    const rich = createSessionRichParser("codex");
    // Native writes and read chunks can split any mirrored pair.
    for (const row of rows) { flat.append([row]); rich.append([row]); }
    expect(flatMessages).toEqual(expected);
    expect(rich.snapshot().messages.map((message) => message.blocks[0].text)).toEqual(expected);
    expect(flat.snapshot()).toMatchObject({ message_count: 7, first_user_text: "original question", preview: "different event text" });
    expect(rich.snapshot().meta).toEqual(flat.snapshot());
    expect(parseSessionText("codex", jsonl(rows)).messages.map((message) => message.text)).toEqual(expected);
  });

  it.each(["task_started", "turn_started", "task_complete", "turn_complete", "turn_aborted", "thread_rolled_back"])(
    "does not match identical prose across a native %s boundary", (type) => {
      const text = jsonl([item("user", "hi"), marker(type), event("user", "hi")]);
      expect(parseSessionText("codex", text).messages.map((message) => message.text)).toEqual(["hi", "hi"]);
      expect(parseSessionRich("codex", text).messages).toHaveLength(2);
    },
  );

  it("keeps repeated same-channel messages and roles distinct while excluding injected context", () => {
    const text = jsonl([item("user", "hi"), item("user", "hi"), event("assistant", "hi"),
      event("assistant", "hi"), item("user", "<codex_internal_context>private context</codex_internal_context>")]);
    expect(parseSessionText("codex", text).messages.map((message) => message.role)).toEqual(["user", "user", "assistant", "assistant"]);
    expect(parseSessionRich("codex", text).messages).toHaveLength(4);
  });
});

describe("Codex history through the filesystem readers", () => {
  let home: string;
  let file: string;
  const header = { type: "session_meta", payload: { id: "rewound", cwd: "/project" } };
  const history = Array.from({ length: 160 }, (_, index) => item(index % 2 ? "assistant" : "user", `retained history ${index}`));
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codex-history-"));
    const dir = join(home, ".codex", "sessions", "2026", "11", "04");
    mkdirSync(dir, { recursive: true });
    file = join(dir, "rollout-2026-11-04T08-00-00-rewound.jsonl");
  });
  afterEach(() => {
    resetRichTranscriptFiles();
    invalidateSessionEnumeration(home);
    rmSync(home, { recursive: true, force: true });
  });

  async function assertHistory(): Promise<void> {
    const tail = await readRichTranscriptFile(file, "codex", 2);
    expect(tail).toMatchObject({ total: 162, offset: 160, meta: { first_user_text: "retained history 0", preview: "hello" } });
    expect(tail.messages.map((message) => message.blocks[0].text)).toEqual(["hi", "hello"]);
    expect((await readRichTranscriptFile(file, "codex", 2, undefined, 2)).messages.map((message) => message.blocks[0].text))
      .toEqual(["retained history 0", "retained history 1"]);
    expect((await readRichTranscriptBlock(file, "codex", 1, 0)).block?.text).toBe("retained history 1");
    expect(await readSessionSummaryFile(file, "codex")).toMatchObject({ message_count: 162, first_user_text: "retained history 0", preview: "hello" });
    const page = await readSession(home, { id: "rewound", source: "codex", max_messages: 2, offset: 158 }) as {
      messages: Array<{ text: string }>; total_messages: number;
    };
    expect(page.total_messages).toBe(162);
    expect(page.messages.map((message) => message.text)).toEqual(["retained history 158", "retained history 159"]);
    const hit = await searchSessionFile(file, "codex", "retained history 42");
    expect(hit?.matches).toHaveLength(1);
    expect(hit?.matches[0].snippet).toContain("retained history 42");
    expect((await searchSessionFile(file, "codex", "hello"))?.matches).toHaveLength(1);
  }

  const continuation = [marker("task_started"), event("user", "hi"), item("user", "hi"),
    item("assistant", "hello"), event("assistant", "hello"), marker("task_complete")];

  it("keeps disk-paged item-only history when a live event channel starts", async () => {
    writeFileSync(file, jsonl([header, ...history]));
    expect((await readRichTranscriptFile(file, "codex", 2)).total).toBe(160);
    for (const row of continuation) {
      appendFileSync(file, jsonl([row]));
      await readRichTranscriptFile(file, "codex", 2);
    }
    await assertHistory();
    resetRichTranscriptFiles();
    await assertHistory();
  });

  it.each(["truncate", "replace"])("rebuilds a warm %s transcript and keeps the surviving history", async (mode) => {
    writeFileSync(file, jsonl([header, ...history, event("user", "discarded branch " + "x".repeat(10_000))]));
    expect((await readRichTranscriptFile(file, "codex", 1)).total).toBe(161);
    const target = mode === "replace" ? file + ".new" : file;
    writeFileSync(target, jsonl([header, ...history, ...continuation]));
    if (mode === "replace") renameSync(target, file);
    await assertHistory();
    expect(await searchSessionFile(file, "codex", "discarded branch")).toBeNull();
  });
});
