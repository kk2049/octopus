import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRichParser, parseSessionRich, type Source } from "./parse.js";
import { readRichTranscriptFile, resetRichTranscriptFiles } from "./rich-file.js";

const dirs: string[] = [];
function file(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rich-file-")); dirs.push(dir);
  return path.join(dir, "session.jsonl");
}
afterEach(() => {
  vi.restoreAllMocks(); resetRichTranscriptFiles();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const line = (value: unknown) => JSON.stringify(value);
const fixtures: Array<[Source, unknown[]]> = [
  ["claude", [
    { type: "user", timestamp: "2026-09-14T00:00:00Z", sessionId: "one", message: { role: "user", content: "你好🙂" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "read", input: { path: "a" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "工具完成" }] } },
    { type: "assistant", message: { role: "assistant", content: "done" }, stop_reason: "end_turn" },
  ]],
  ["codex", [
    { type: "session_meta", payload: { id: "one", cwd: "/workspace" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "duplicate" }] } },
    { type: "event_msg", payload: { type: "user_message", message: "你好🙂" } },
    { type: "response_item", payload: { type: "function_call", call_id: "call", name: "read", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "工具完成" } },
    { type: "event_msg", timestamp: "2026-09-14T00:00:04Z", payload: { type: "task_complete" } },
  ]],
  ["omp", [
    { type: "session", id: "one", cwd: "/workspace" },
    { type: "message", message: { role: "user", content: "你好🙂" } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {}, intent: "inspect" }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "call", content: "工具完成" } },
    { type: "compaction", summary: "summary" },
  ]],
];

describe("incremental native rich transcripts", () => {
  it.each([
    { message: "exceeded reconnect retry limit" },
    { message: "Request blocked", codex_error_info: "cyber_policy" },
  ])("appends terminal errors once, retains them in paged history, and follows resumed work: $message", async (diagnostic) => {
    const target = file();
    const event = (type: string, extra: Record<string, unknown> = {}) => line({
      type: "event_msg", timestamp: "2026-10-12T07:45:27.357Z", payload: { type, ...extra },
    }) + "\n";
    await fs.writeFile(target, event("user_message", { message: "work" }) + event("task_started"));
    await readRichTranscriptFile(target, "codex", 1);
    const error = event("task_complete", { error: diagnostic });
    await fs.appendFile(target, error.slice(0, -3));
    expect((await readRichTranscriptFile(target, "codex", 1)).total).toBe(1);
    await fs.appendFile(target, error.slice(-3));
    const failed = await readRichTranscriptFile(target, "codex", 1);
    expect(failed.total).toBe(2);
    expect(failed.messages[0].blocks[0].text).toContain(`已停止：${diagnostic.message}`);
    if (diagnostic.codex_error_info === "cyber_policy") {
      expect(failed.messages[0].blocks[0].text).toContain("https://help.openai.com/en/articles/20001326");
      expect(failed.messages[0].blocks[0].text).toContain("https://openai.com/form/enterprise-trusted-access-for-cyber/");
    }
    expect(failed.meta.activity?.state).toBe("idle");
    expect(await readRichTranscriptFile(target, "codex", 1)).toEqual(failed);
    await fs.appendFile(target, event("user_message", { message: "continue" }) + event("task_started"));
    expect((await readRichTranscriptFile(target, "codex", 1)).meta.activity?.state).toBe("thinking");
    expect((await readRichTranscriptFile(target, "codex", 1, 1)).messages).toEqual(failed.messages);
    resetRichTranscriptFiles();
    expect((await readRichTranscriptFile(target, "codex", 1, 1)).messages).toEqual(failed.messages);
  });
  it("retains async-question identity through disk paging and late display receipts", async () => {
    const target = file();
    const input = JSON.stringify({ questions: [{ title: "详细题干".repeat(600), options: ["最后选项"] }] });
    await fs.writeFile(target, line({ type: "response_item", payload: {
      type: "function_call", call_id: "question-native", name: "request_user_input_async", arguments: input,
    } }) + "\n" + Array.from({ length: 160 }, (_, index) => line({ type: "event_msg", payload: {
      type: "agent_message", message: `progress ${index}`,
    } })).join("\n") + "\n");
    await readRichTranscriptFile(target, "codex", 10);
    await fs.appendFile(target, line({ type: "response_item", payload: {
      type: "function_call_output", call_id: "question-native", output: "Question displayed",
    } }) + "\n");
    const page = await readRichTranscriptFile(target, "codex", 1, 0);
    expect(page.messages[0].blocks[0]).toMatchObject({ call_id: "question-native", input, output: "Question displayed" });
  });
  it.each(fixtures)("preserves %s full-parser semantics at every native record", (source, records) => {
    const parser = createSessionRichParser(source);
    let text = "";
    for (const record of records) {
      const added = line(record) + "\n";
      text += added; parser.append(added);
      expect(parser.snapshot()).toEqual(parseSessionRich(source, text));
    }
  });

  it.each(fixtures)("preserves %s incomplete byte tails, no-newline records, and late tool results", async (source, records) => {
    const target = file();
    let content = Buffer.alloc(0);
    await fs.writeFile(target, content);
    for (const record of records) {
      const added = Buffer.from(line(record));
      // Deliberately split UTF-8 and JSON at byte boundaries, rather than
      // assuming a provider writes one complete record in one syscall.
      for (let offset = 0; offset < added.length; offset += 7) {
        const part = added.subarray(offset, offset + 7);
        await fs.appendFile(target, part); content = Buffer.concat([content, part]);
        const actual = await readRichTranscriptFile(target, source, 500);
        const expected = parseSessionRich(source, content.toString("utf8"));
        expect(actual).toEqual({ meta: expected.meta, messages: expected.messages, offset: 0, total: expected.messages.length, byteLimited: false });
      }
      await fs.appendFile(target, "\n"); content = Buffer.concat([content, Buffer.from("\n")]);
    }
    const first = await readRichTranscriptFile(target, source, 500);
    first.messages[0]!.blocks.length = 0;
    expect((await readRichTranscriptFile(target, source, 500)).messages[0]!.blocks.length).toBeGreaterThan(0);
  });

  it("reads only appended bytes plus bounded fingerprint proof, and does no body IO when unchanged", async () => {
    const target = file();
    const records = Array.from({ length: 50 }, (_, index) => line({ type: "event_msg", payload: { type: "agent_message", message: `${index} ${"x".repeat(5_000)}` } }));
    await fs.writeFile(target, records.join("\n") + "\n");
    await readRichTranscriptFile(target, "codex", 20);
    const actualOpen = fs.open.bind(fs);
    let requestedBytes = 0;
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await actualOpen(file, flags, mode);
      const actualRead = handle.read.bind(handle);
      handle.read = ((buffer: Buffer, offset: number, length: number, position: number) => {
        requestedBytes += length;
        return actualRead(buffer, offset, length, position);
      }) as typeof handle.read;
      return handle;
    });
    await readRichTranscriptFile(target, "codex", 20);
    expect(requestedBytes).toBe(0);
    await fs.appendFile(target, line({ type: "event_msg", payload: { type: "agent_message", message: "next" } }) + "\n");
    const page = await readRichTranscriptFile(target, "codex", 20);
    expect(page.total).toBe(51);
    expect(requestedBytes).toBeLessThan(4_096);
    expect(page.messages.at(-1)?.blocks[0]?.text).toBe("next");
  });

  it("rebuilds after truncation, replacement and edits to a formerly complete last record", async () => {
    const target = file();
    const record = (text: string) => line({ type: "event_msg", payload: { type: "agent_message", message: text } });
    await fs.writeFile(target, record("original"));
    expect((await readRichTranscriptFile(target, "codex", 20)).messages).toHaveLength(1);
    await fs.appendFile(target, " not-valid-json");
    expect((await readRichTranscriptFile(target, "codex", 20)).messages).toHaveLength(0);
    await fs.writeFile(target, record("short"));
    expect((await readRichTranscriptFile(target, "codex", 20)).messages[0]?.blocks[0]?.text).toBe("short");
    const replacement = target + ".new";
    await fs.writeFile(replacement, record("replacement")); await fs.rename(replacement, target);
    expect((await readRichTranscriptFile(target, "codex", 20)).messages[0]?.blocks[0]?.text).toBe("replacement");
  });
});

it("keeps >32 MiB transcripts incremental and reuses the same decode for summaries", async () => {
  const { readSessionSummaryFile, transcriptReadStats } = await import("./rich-file.js");
  const target = file();
  const record = line({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(100_000) } }) + "\n";
  await fs.writeFile(target, record.repeat(350));
  await readRichTranscriptFile(target, "codex", 2);
  const before = transcriptReadStats.sourceBytes;
  await Promise.all([readRichTranscriptFile(target, "codex", 2), readSessionSummaryFile(target, "codex"), readRichTranscriptFile(target, "codex", 1, 0)]);
  expect(transcriptReadStats.sourceBytes).toBe(before);
  const addition = line({ type: "event_msg", payload: { type: "user_message", message: "next" } }) + "\n";
  await fs.appendFile(target, addition);
  expect((await readSessionSummaryFile(target, "codex")).message_count).toBe(351);
  expect((await readRichTranscriptFile(target, "codex", 1)).messages[0]?.blocks[0]?.text).toBe("next");
  expect(transcriptReadStats.sourceBytes - before).toBeLessThan(Buffer.byteLength(addition) + 2048);
}, 30_000);

it("updates evicted historical tool calls without hiding history when Codex events start", async () => {
  const target = file();
  const records: unknown[] = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "duplicate" }] } },
    { type: "response_item", payload: { type: "function_call", call_id: "old", name: "read", arguments: "{}" } },
    ...Array.from({ length: 300 }, () => ({ type: "event_msg", payload: { type: "agent_reasoning", text: "thinking" } })),
  ];
  await fs.writeFile(target, records.map(line).join("\n") + "\n");
  await readRichTranscriptFile(target, "codex", 2);
  records.push({ type: "response_item", payload: { type: "function_call_output", call_id: "old", output: "late result" } });
  records.push({ type: "event_msg", payload: { type: "user_message", message: "real" } });
  await fs.appendFile(target, records.slice(-2).map(line).join("\n") + "\n");
  const actual = await readRichTranscriptFile(target, "codex", 500, 0);
  const expected = parseSessionRich("codex", records.map(line).join("\n"));
  expect(actual.messages).toEqual(expected.messages);
  expect(actual.meta).toEqual(expected.meta);
  expect(actual.messages[0]?.blocks[0]?.text).toBe("duplicate");
  expect(actual.messages[1]?.blocks[0]?.output).toBe("late result");
});

it.each(fixtures)("preserves %s flat summary semantics across incremental records", async (source, records) => {
  const { createSessionSummaryParser, parseSessionText } = await import("./parse.js");
  const parser = createSessionSummaryParser(source);
  const prior: unknown[] = [];
  for (const record of records) {
    prior.push(record); parser.append([record]);
    expect(parser.snapshot()).toEqual(parseSessionText(source, prior.map(line).join("\n")).meta);
  }
});

it("shares cold parsing across watcher windows and checks appends arriving during a read", async () => {
  const { transcriptReadStats, readSessionSummaryFile } = await import("./rich-file.js");
  const target = file();
  const original = line({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(300_000) } }) + "\n";
  const added = line({ type: "event_msg", payload: { type: "agent_message", message: "arrived during read" } }) + "\n";
  await fs.writeFile(target, original);
  const actualOpen = fs.open.bind(fs);
  let didAppend = false;
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await actualOpen(file, flags, mode);
    const actualRead = handle.read.bind(handle);
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await actualRead(buffer, offset, length, position);
      if (!didAppend) { didAppend = true; await fs.appendFile(target, added); }
      return result;
    }) as typeof handle.read;
    return handle;
  });
  const first = readRichTranscriptFile(target, "codex", 1);
  const joined = readRichTranscriptFile(target, "codex", 2);
  const summary = readSessionSummaryFile(target, "codex");
  expect((await first).total).toBe(1);
  expect((await joined).total).toBe(2);
  expect((await summary).message_count).toBe(2);
  expect(transcriptReadStats.rebuilds).toBe(1);
  expect(transcriptReadStats.sourceBytes).toBeLessThan(Buffer.byteLength(original + added) + 2_048);
});

it("bounds retained message bodies while old pages remain readable", async () => {
  const { TranscriptPages } = await import("./transcript-pages.js");
  const pages = new TranscriptPages();
  try {
    for (let i = 0; i < 400; i++) pages.push({ role: "assistant", blocks: [{ type: "text", text: `${i}:` + "x".repeat(20_000) }] });
    pages.flush();
    expect(pages.retainedBytes()).toBeLessThanOrEqual(2 * 1024 * 1024);
    const at = (start: number) => pages.page({ start, limit: 1, budgetBytes: 1024 * 1024 }).messages[0]?.blocks[0]?.text;
    expect(at(0)).toMatch(/^0:/);
    expect(at(399)).toMatch(/^399:/);
  } finally { pages.dispose(); }
});

it("keeps live body pages when a roster scan encounters many unrelated histories", async () => {
  const { transcriptReadStats, readSessionSummaryFile } = await import("./rich-file.js");
  const target = file();
  const record = line({ type: "event_msg", payload: { type: "agent_message", message: "live" } }) + "\n";
  await fs.writeFile(target, record);
  await readRichTranscriptFile(target, "codex", 20);
  for (let i = 0; i < 80; i++) {
    const other = path.join(path.dirname(target), `other-${i}.jsonl`);
    await fs.writeFile(other, record);
    await readSessionSummaryFile(other, "codex");
  }
  const before = transcriptReadStats.sourceBytes;
  expect((await readRichTranscriptFile(target, "codex", 20)).total).toBe(1);
  expect(transcriptReadStats.sourceBytes).toBe(before);
});
