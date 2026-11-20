import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import * as richFiles from "./rich-file.js";
import { parseSessionText } from "./parse.js";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENUMERATION_CACHE_TTL_MS,
  invalidateSessionEnumeration,
  listRecentSessions,
  listSelectedSessions,
  resetRecentSessionIndexes,
  searchSessions,
  digestRecentSessions,
  readSession,
  resolveSessionPath,
  exportSessionFile,
  exportPlainFile,
  assertPathInScanRoot,
  enumerate,
  __summaryCache,
  __summaryPending,
  __summarizeForTests,
  type SessionFile,
  type SessionSummary,
} from "./scan.js";

let home: string;

function seedClaudeSessionAt(scanHome: string, id: string, text: string): string {
  const proj = join(scanHome, ".claude", "projects", "-home-u-proj");
  mkdirSync(proj, { recursive: true });
  const p = join(proj, `${id}.jsonl`);
  const lines = [
    { sessionId: id, timestamp: "2026-07-15T08:00:00.000Z", cwd: "/home/u/proj", type: "user", message: { role: "user", content: text } },
    { sessionId: id, timestamp: "2026-07-15T08:01:00.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ];
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  return p;
}

function seedClaudeSession(id: string, text: string): string {
  return seedClaudeSessionAt(home, id, text);
}

function seedCodexSessionAt(codexHome: string, id: string, text: string): string {
  const sessions = join(codexHome, "sessions", "2026", "08", "21");
  mkdirSync(sessions, { recursive: true });
  const p = join(sessions, `rollout-2026-08-21T09-00-00-${id}.jsonl`);
  writeFileSync(p, [
    { timestamp: "2026-08-21T09:00:00.000Z", type: "session_meta", payload: { id, cwd: "/Users/u/project" } },
    { timestamp: "2026-08-21T09:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: text } },
  ].map((line) => JSON.stringify(line)).join("\n"));
  return p;
}

function seedParentOwnedCodexSession(codexHome: string, id: string, parentId: string): void {
  const sessions = join(codexHome, "sessions", "2026", "08", "30");
  mkdirSync(sessions, { recursive: true });
  const p = join(sessions, `rollout-2026-08-30T12-00-00-${id}.jsonl`);
  writeFileSync(p, JSON.stringify({
    timestamp: "2026-08-30T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      cwd: "/Users/u/project",
      multi_agent_version: "v2",
      source: {
        subagent: {
          thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: "/root/worker" },
        },
      },
    },
  }));
}

function seedOmpSession(id: string, title: string, text: string): string {
  const proj = join(home, ".omp", "agent", "sessions", "-home-u-proj");
  mkdirSync(proj, { recursive: true });
  const p = join(proj, `2026-08-17T08-27-05_${id}.jsonl`);
  const lines = [
    { type: "title", v: 1, title, source: "auto", updatedAt: "2026-08-17T08:27:10.000Z" },
    { type: "session", version: 3, id, timestamp: "2026-08-17T08:27:05.000Z", cwd: "/home/u/proj" },
    { type: "message", id: "m1", timestamp: "2026-08-17T08:27:06.000Z", message: { role: "user", content: [{ type: "text", text }] } },
  ];
  writeFileSync(p, lines.map((line) => JSON.stringify(line)).join("\n"));
  return p;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function sessionFile(p: string, mtimeMs: number): SessionFile {
  return {
    source: "claude",
    path: p,
    project: "-home-u-proj",
    mtimeMs,
    size: statSync(p).size,
  };
}

function gateSummaryReads(target: string, gates: Array<ReturnType<typeof deferred<void>>>): () => number {
  const original = richFiles.readSessionSummaryFile;
  let reads = 0;
  vi.spyOn(richFiles, "readSessionSummaryFile").mockImplementation(async (file, source) => {
    if (file !== target) return original(file, source);
    // Control summary completion independently of the source reader. This
    // tests the outer versioned publication guard, including late completion.
    const value = parseSessionText(source, readFileSync(target, "utf8")).meta;
    const at = reads++;
    const gate = gates[at];
    if (gate) await gate.promise;
    return value;
  });
  return () => reads;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "scanhome-"));
  __summaryCache.clear();
  __summaryPending.clear();
});
afterEach(() => {
  resetRecentSessionIndexes();
  richFiles.resetRichTranscriptFiles();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("native identity path catalog", () => {
  it("stats only matching identities and preserves newest-copy account selection", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    const original = seedCodexSessionAt(join(home, ".codex"), id, "old");
    const copy = seedCodexSessionAt(join(home, "a"), id, "copy");
    for (let index = 2; index < 102; index += 1) {
      seedCodexSessionAt(join(home, ".codex"), "00000000-0000-0000-0000-" + String(index).padStart(12, "0"), "unrelated");
    }
    await fsPromises.utimes(original, new Date(0), new Date(0));
    const stat = vi.spyOn(fsPromises, "stat");
    const lstat = vi.spyOn(fsPromises, "lstat");
    const roots = { home, codexHomes: [{ label: "", codexHome: join(home, ".codex") }, { label: "a", codexHome: join(home, "a") }] };
    await expect(resolveSessionPath(roots, "codex", id, undefined)).resolves.toMatchObject({ path: copy, account_label: "a" });
    const bodyStats = [...stat.mock.calls, ...lstat.mock.calls].map((args) => String(args[0])).filter((file) => file.endsWith(".jsonl"));
    expect(new Set(bodyStats)).toEqual(new Set([original, copy]));
    await expect(resolveSessionPath(home, "codex", id, undefined)).resolves.toMatchObject({ path: original });
  });
});

describe("Claude subagent identity", () => {
  it("lists and reads modern and flat sidechains as children without aliasing their parent", async () => {
    seedClaudeSession("parent", "parent prompt");
    const project = join(home, ".claude", "projects", "-home-u-proj");
    for (const [agent, dir] of [["modern", join(project, "parent", "subagents")], ["flat", project]]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `agent-${agent}.jsonl`), JSON.stringify({
        sessionId: "parent", agentId: agent === "flat" ? undefined : agent, isSidechain: true,
        timestamp: "2026-09-05T10:00:00Z", cwd: "/home/u/proj", type: "user",
        message: { role: "user", content: `${agent} worker prompt` },
      }));
    }
    const listed = await listRecentSessions(home, { source: "claude", limit: 20 }) as { sessions: SessionSummary[] };
    expect(listed.sessions.map((s) => s.id).sort()).toEqual(["agent-flat", "agent-modern", "parent"]);
    for (const agent of ["modern", "flat"]) {
      expect(listed.sessions.find((s) => s.id === `agent-${agent}`)).toMatchObject({
        is_subagent: true, parent_session_id: "parent", input_mode: "parent_owned",
      });
      for (const rich of [true, false]) {
        const read = await readSession(home, { source: "claude", id: `agent-${agent}`, rich }) as { meta: { id: string } };
        expect(read.meta.id).toBe(`agent-${agent}`);
      }
    }
    const search = await searchSessions(home, { source: "claude", query: "modern worker" }) as { results: { session: SessionSummary }[] };
    expect(search.results[0].session).toMatchObject({ id: "agent-modern", parent_session_id: "parent", is_subagent: true });
  });
});

describe("scan layer", () => {
  it.each([false, true])("reads the latest Codex configuration through paged and incremental reads (rich=%s)", async (rich) => {
    const id = "019f4b69-0bcb-7853-8cb1-83fe1f94b4f3";
    const file = seedCodexSessionAt(join(home, ".codex"), id, "hello");
    const read = () => readSession(home, { source: "codex", id, rich, max_messages: 1, offset: 0 });
    const appendContext = (payload: Record<string, unknown>) => appendFileSync(file,
      `\n${JSON.stringify({ type: "turn_context", payload })}\n`);
    expect(await read()).toMatchObject({ meta: { turn_configuration: null }, returned_messages: 1 });
    appendContext({ model: "gpt-6-luna", effort: "high", cwd: "/private" });
    expect(await read()).toMatchObject({ meta: { turn_configuration: { model: "gpt-6-luna", effort: "high" } }, returned_messages: 1 });
    appendContext({ model: "gpt-6-astra", effort: "xhigh" });
    expect(await read()).toMatchObject({ meta: { turn_configuration: { model: "gpt-6-astra", effort: "xhigh" } } });
    appendContext({ model: "custom", effort: null });
    expect(await read()).toMatchObject({ meta: { turn_configuration: { model: "custom" } } });
    appendContext({});
    expect(await read()).toMatchObject({ meta: { turn_configuration: null } });
  });

  it("lists and reads a seeded session", async () => {
    seedClaudeSession("sess-a", "hello world");
    const list = (await listRecentSessions(home, {})) as { returned: number; sessions: Array<{ id: string }> };
    expect(list.returned).toBe(1);
    expect(list.sessions[0].id).toBe("sess-a");

    const read = (await readSession(home, { id: "sess-a" })) as { messages: Array<{ text: string }> };
    expect(read.messages.some((m) => m.text.includes("hello world"))).toBe(true);
  });

  it("lists and finds a Claude chat by the name its terminal shows", async () => {
    const file = seedClaudeSession("sess-named", "我们逐条过一遍理论");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n${JSON.stringify({ type: "custom-title", customTitle: "ACC理论 · 逐项讨论", sessionId: "sess-named" })}`);
    seedClaudeSession("sess-other", "hello world");
    const list = await listRecentSessions(home, { source: "claude" }) as { sessions: SessionSummary[] };
    expect(list.sessions.find((s) => s.id === "sess-named")).toMatchObject({ title: "ACC理论 · 逐项讨论" });
    expect(list.sessions.find((s) => s.id === "sess-other")?.title).toBeUndefined();
    const search = await searchSessions(home, { source: "claude", query: "ACC理论" }) as { results: { session: SessionSummary }[] };
    expect(search.results.map((r) => [r.session.id, r.session.title])).toEqual([["sess-named", "ACC理论 · 逐项讨论"]]);
  });

  it("uses an explicit CODEX_HOME for list, read, jail and export", async () => {
    const codexHome = join(home, "custom-codex-state");
    const id = "019f0000-2222-7000-8000-000000000999";
    const sessionPath = seedCodexSessionAt(codexHome, id, "来自自定义 Codex 根目录");
    const roots = { home, codexHome };

    const list = await listRecentSessions(roots, { source: "codex" }) as {
      returned: number;
      sessions: Array<{ id: string; first_user_text?: string }>;
    };
    expect(list).toMatchObject({
      returned: 1,
      sessions: [{ id, first_user_text: "来自自定义 Codex 根目录" }],
    });
    await expect(readSession(roots, { path: sessionPath })).resolves.toMatchObject({
      meta: { id, source: "codex" },
    });
    await expect(assertPathInScanRoot(roots, sessionPath)).resolves.toBe(sessionPath);
    await expect(exportSessionFile(roots, id)).resolves.toMatchObject({
      source: "codex",
      rel_path: `.codex/sessions/2026/08/21/rollout-2026-08-21T09-00-00-${id}.jsonl`,
    });
  });

  it("enumerates trusted Codex account roots and carries only their a/b labels", async () => {
    const first = join(home, "codex-a");
    const second = join(home, "codex-b");
    const firstId = "019f0000-2222-7000-8000-000000000111";
    const secondId = "019f0000-2222-7000-8000-000000000222";
    seedCodexSessionAt(first, firstId, "first account");
    seedCodexSessionAt(second, secondId, "second account");
    const roots = {
      home,
      codexHomes: [
        { label: "a", codexHome: first },
        { label: "b", codexHome: second },
      ],
    };

    await expect(listRecentSessions(roots, { source: "codex" })).resolves.toMatchObject({
      returned: 2,
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: firstId, account_label: "a" }),
        expect.objectContaining({ id: secondId, account_label: "b" }),
      ]),
    });
    await expect(readSession(roots, { source: "codex", id: secondId })).resolves.toMatchObject({
      meta: { id: secondId, source: "codex", account_label: "b" },
    });
    await expect(resolveSessionPath(roots, "codex", secondId, undefined)).resolves.toMatchObject({
      account_label: "b",
      codexHome: second,
    });
    await expect(exportSessionFile(roots, secondId)).resolves.toMatchObject({
      source: "codex",
      rel_path: `.codex/sessions/2026/08/21/rollout-2026-08-21T09-00-00-${secondId}.jsonl`,
    });
  });

  it("lists Oh My Pi's canonical title with the session summary", async () => {
    const id = "01a00ed4-db09-7000-b549-ac372c282cfa";
    seedOmpSession(id, "调研 dsh 生态", "帮我复盘长任务");

    const list = await listRecentSessions(home, { source: "omp" }) as {
      sessions: Array<{ id: string; source: string; title?: string }>;
    };
    expect(list.sessions).toEqual([
      expect.objectContaining({ id, source: "omp", title: "调研 dsh 生态" }),
    ]);
  });

  it("keeps Codex parent ownership in the cached roster summary", async () => {
    const id = "01a00ed4-db09-7000-b549-ac372c282cfb";
    const parentId = "01a00ed4-db09-7000-b549-ac372c282cfc";
    const codexHome = join(home, ".codex");
    seedParentOwnedCodexSession(codexHome, id, parentId);

    const list = await listRecentSessions(home, { source: "codex" }) as {
      sessions: Array<{ id: string; input_mode?: string; parent_session_id?: string }>;
    };
    expect(list.sessions).toEqual([
      expect.objectContaining({
        id,
        input_mode: "parent_owned",
        parent_session_id: parentId,
      }),
    ]);
  });

  it("list limit accepts a full-roster pull (>100, capped at 500)", async () => {
    for (let i = 0; i < 120; i++) seedClaudeSession(`sess-many-${String(i).padStart(3, "0")}`, `会话 ${i}`);
    const list = (await listRecentSessions(home, { limit: 400 })) as { returned: number; total_found: number };
    expect(list.total_found).toBe(120);
    expect(list.returned).toBe(120);
  });

  it("enumeration cache hits within its TTL, expires, and stays isolated by home", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const otherHome = join(home, "other-home");
    seedClaudeSessionAt(home, "home-a-1", "A1");
    seedClaudeSessionAt(otherHome, "home-b-1", "B1");

    expect((await enumerate(home, "all")).map((file) => file.path)).toEqual([
      expect.stringContaining("home-a-1.jsonl"),
    ]);
    expect((await enumerate(otherHome, "all")).map((file) => file.path)).toEqual([
      expect.stringContaining("home-b-1.jsonl"),
    ]);

    // New filesystem facts stay hidden only for the documented short TTL,
    // unless a trusted provider hook says that source just changed.
    seedClaudeSessionAt(home, "home-a-2", "A2");
    seedClaudeSessionAt(otherHome, "home-b-2", "B2");
    expect(await enumerate(home, "all")).toHaveLength(1);
    expect(await enumerate(otherHome, "all")).toHaveLength(1);

    invalidateSessionEnumeration(home, "claude");
    expect(await enumerate(home, "all")).toHaveLength(2);
    // Invalidation is scoped to the exact trusted roots; another Runner home
    // keeps sharing its own cached scan.
    expect(await enumerate(otherHome, "all")).toHaveLength(1);

    vi.setSystemTime(Date.now() + ENUMERATION_CACHE_TTL_MS);
    expect(await enumerate(otherHome, "all")).toHaveLength(2);
  });

  it("summary cache: hit for unchanged files, invalidated when the file grows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const p = seedClaudeSession("sess-cache", "第一版内容");
    await listRecentSessions(home, {});
    const entry = __summaryCache.get(p);
    expect(entry).toBeDefined();

    // Prove the second list is served FROM the cache: poison the cached
    // summary and observe the poisoned value coming back for an unchanged file.
    entry!.summary.first_user_text = "POISONED";
    const l2 = (await listRecentSessions(home, {})) as { sessions: Array<{ first_user_text?: string }> };
    expect(l2.sessions[0].first_user_text).toBe("POISONED");

    // Append-style growth changes (mtime, size) → entry invalid → fresh parse.
    seedClaudeSession("sess-cache", "第二版内容，比第一版长了不少所以 size 一定变了");
    vi.setSystemTime(Date.now() + ENUMERATION_CACHE_TTL_MS);
    const l3 = (await listRecentSessions(home, {})) as { sessions: Array<{ first_user_text?: string }> };
    expect(l3.sessions[0].first_user_text).toContain("第二版内容");
  });

  it("joins concurrent summary builds for the same path version", async () => {
    const p = seedClaudeSession("sess-flight", "并发只读一次");
    const file = sessionFile(p, 1);
    const gate = deferred<void>();
    const reads = gateSummaryReads(p, [gate]);

    const requests = Array.from({ length: 18 }, () => __summarizeForTests(file));
    await vi.waitFor(() => expect(reads()).toBe(1));
    expect(__summaryPending.size).toBe(1);
    gate.resolve();

    const summaries = await Promise.all(requests);
    expect(summaries).toHaveLength(18);
    expect(new Set(summaries.map((summary) => summary.first_user_text))).toEqual(new Set(["并发只读一次"]));
    expect(reads()).toBe(1);
    expect(__summaryPending.size).toBe(0);
  });

  it("shares one pending summary across roster callers with different source and limit", async () => {
    const p = seedClaudeSession("sess-cross-call", "跨查询复用");
    const gate = deferred<void>();
    const reads = gateSummaryReads(p, [gate]);

    const requests = Array.from({ length: 18 }, (_, at) => listRecentSessions(home, {
      source: at % 2 === 0 ? "claude" : "all",
      limit: at % 3 === 0 ? 1 : 200,
    }));
    await vi.waitFor(() => expect(reads()).toBe(1));
    gate.resolve();

    const rosters = await Promise.all(requests) as Array<{ sessions: SessionSummary[] }>;
    expect(rosters.every((roster) => roster.sessions[0]?.first_user_text === "跨查询复用")).toBe(true);
    expect(reads()).toBe(1);
    expect(__summaryPending.size).toBe(0);
  });

  it("starts a new version build and refuses an older late cache publication", async () => {
    const p = seedClaudeSession("sess-version", "旧版本");
    const oldFile = sessionFile(p, 1);
    const oldGate = deferred<void>();
    const freshGate = deferred<void>();
    const reads = gateSummaryReads(p, [oldGate, freshGate]);

    const oldBuild = __summarizeForTests(oldFile);
    await vi.waitFor(() => expect(reads()).toBe(1));
    seedClaudeSession("sess-version", "新版本，长度也发生变化");
    const freshFile = sessionFile(p, 2);
    const freshBuild = __summarizeForTests(freshFile);
    await vi.waitFor(() => expect(reads()).toBe(2));

    freshGate.resolve();
    await expect(freshBuild).resolves.toMatchObject({ first_user_text: "新版本，长度也发生变化" });
    oldGate.resolve();
    await expect(oldBuild).resolves.toMatchObject({ first_user_text: "旧版本" });

    expect(__summaryCache.get(p)).toMatchObject({
      mtimeMs: freshFile.mtimeMs,
      size: freshFile.size,
      summary: { first_user_text: "新版本，长度也发生变化" },
    });
    // A caller holding stale enumeration facts receives the already-known
    // newer summary; it does not start a backwards third read.
    await expect(__summarizeForTests(oldFile)).resolves.toMatchObject({
      first_user_text: "新版本，长度也发生变化",
    });
    expect(reads()).toBe(2);
    expect(__summaryPending.size).toBe(0);
  });

  it("cleans up a failed summary flight so the same version can retry", async () => {
    const p = seedClaudeSession("sess-retry", "重试成功");
    const file = sessionFile(p, 1);
    let reads = 0;
    vi.spyOn(richFiles, "readSessionSummaryFile").mockImplementation((async (target: unknown) => {
      if (String(target) !== p) throw new Error("unexpected test path");
      reads += 1;
      if (reads === 1) throw new Error("transient read failure");
      return parseSessionText("claude", readFileSync(p, "utf8")).meta;
    }) as never);

    await expect(__summarizeForTests(file)).rejects.toThrow("transient read failure");
    expect(__summaryPending.size).toBe(0);
    await expect(__summarizeForTests(file)).resolves.toMatchObject({ first_user_text: "重试成功" });
    expect(reads).toBe(2);
    expect(__summaryPending.size).toBe(0);
  });

  it("exportSessionFile returns a home-relative path + full content", async () => {
    seedClaudeSession("sess-b", "export me");
    const exp = await exportSessionFile(home, "sess-b");
    expect(exp.rel_path).toBe(".claude/projects/-home-u-proj/sess-b.jsonl");
    expect(exp.source).toBe("claude");
    expect(exp.content).toContain("export me");
    expect(exp.size).toBeGreaterThan(0);
  });

  it("exports a file of any size whole, window by window, never splitting a character", async () => {
    const file = seedClaudeSession("sess-c", "多字节".repeat(3000));
    let content = "";
    let offset: number | undefined = 0;
    let windows = 0;
    while (offset !== undefined) {
      const exp = await exportSessionFile(home, "sess-c", offset, 2047);
      expect(exp.offset).toBe(offset);
      expect(Buffer.byteLength(exp.content)).toBeLessThanOrEqual(2047);
      content += exp.content;
      offset = exp.next_offset;
      windows++;
    }
    expect(windows).toBeGreaterThan(4);
    expect(content).toBe(readFileSync(file, "utf8"));
  });

  it("jail: explicit path outside the scan root is refused, symlink escape too", async () => {
    seedClaudeSession("sess-d", "in jail");
    const outside = join(home, "outside.jsonl");
    writeFileSync(outside, "{}");
    await expect(assertPathInScanRoot(home, outside)).rejects.toThrow(/outside/);

    // A symlink inside .claude pointing outside must not escape.
    const proj = join(home, ".claude", "projects", "-home-u-proj");
    const link = join(proj, "sneaky.jsonl");
    symlinkSync(outside, link);
    await expect(assertPathInScanRoot(home, link)).rejects.toThrow(/outside/);
    await expect(readSession(home, { path: link })).rejects.toThrow(/outside/);
  });
});

describe("exportPlainFile", () => {
  it("exports a project file with files/ prefixed rel_path", async () => {
    const proj = join(home, "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "report.md"), "# 结论\n数据齐全");
    const exp = await exportPlainFile(home, join(proj, "report.md"));
    expect(exp.rel_path).toBe("files/proj/report.md");
    expect(exp.content).toContain("数据齐全");
  });

  it("refuses credentials, blacklisted trees and outside paths; windows any size", async () => {
    const proj = join(home, "proj");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(home, ".ssh", "id_rsa"), "KEY");
    writeFileSync(join(proj, ".env"), "SECRET=1");
    writeFileSync(join(proj, "big.txt"), "x".repeat(100));
    await expect(exportPlainFile(home, join(home, ".ssh", "id_rsa"))).rejects.toThrow(/不允许/);
    await expect(exportPlainFile(home, join(proj, ".env"))).rejects.toThrow(/不允许/);
    await expect(exportPlainFile(home, "/etc/hostname")).rejects.toThrow(/之外/);
    const first = await exportPlainFile(home, join(proj, "big.txt"), 0, 64);
    expect(first).toMatchObject({ size: 100, offset: 0, next_offset: 64, content: "x".repeat(64) });
    expect(await exportPlainFile(home, join(proj, "big.txt"), 64, 64)).toMatchObject({ offset: 64, content: "x".repeat(36) });
    expect(await exportPlainFile(home, join(proj, "big.txt"), 64, 64)).not.toHaveProperty("next_offset");
  });
});

describe("digestRecentSessions", () => {
  it("returns conversation skeletons without tool rows, head+tail on long sessions", async () => {
    const proj = join(home, ".claude", "projects", "-home-u-proj");
    mkdirSync(proj, { recursive: true });
    const lines: string[] = [];
    lines.push(JSON.stringify({ sessionId: "long-1", timestamp: "2026-07-18T08:00:00.000Z", cwd: "/p", type: "user", message: { role: "user", content: "任务:重构登录" } }));
    lines.push(JSON.stringify({ sessionId: "long-1", timestamp: "2026-07-18T08:00:30.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "开始" }] } }));
    for (let i = 0; i < 30; i++) {
      lines.push(JSON.stringify({ sessionId: "long-1", timestamp: `2026-07-18T08:0${(i % 9) + 1}:00.000Z`, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { cmd: "x" } }] } }));
      lines.push(JSON.stringify({ sessionId: "long-1", timestamp: `2026-07-18T08:1${(i % 9)}:00.000Z`, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `第${i}步结论:` + "长".repeat(200) }] } }));
    }
    writeFileSync(join(proj, "long-1.jsonl"), lines.join("\n"));

    const d = (await digestRecentSessions(home, { turns_per_session: 6, chars_per_turn: 60 })) as {
      sessions: Array<{ id: string; elided_turns?: number; turns: Array<{ role: string; text: string }> }>;
    };
    const sess = d.sessions.find((s) => s.id === "long-1")!;
    expect(sess.turns).toHaveLength(6);
    // Head keeps the task definition; tail keeps the latest conclusions.
    expect(sess.turns[0].text).toContain("重构登录");
    expect(sess.turns.at(-1)!.text).toContain("第29步结论");
    expect(sess.elided_turns).toBeGreaterThan(0);
    // No tool rows, and truncation applies.
    expect(sess.turns.every((t) => !t.text.includes("Bash"))).toBe(true);
    expect(Math.max(...sess.turns.map((t) => t.text.length))).toBeLessThanOrEqual(61);
  });
});

describe("read_session tool_detail", () => {
  it("includes truncated tool input when requested", async () => {
    const proj = join(home, ".claude", "projects", "-home-u-proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, "td-1.jsonl"),
      [
        JSON.stringify({ sessionId: "td-1", timestamp: "2026-07-18T09:00:00.000Z", type: "user", message: { role: "user", content: "跑测试" } }),
        JSON.stringify({ sessionId: "td-1", timestamp: "2026-07-18T09:01:00.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "npx vitest run --reporter=dot" } }] } }),
      ].join("\n"),
    );
    const plain = (await readSession(home, { id: "td-1" })) as { messages: Array<{ tool?: string }> };
    expect(plain.messages.some((m) => m.tool === "Bash")).toBe(true);
    const detailed = (await readSession(home, { id: "td-1", tool_detail: true })) as { messages: Array<{ tool?: string }> };
    expect(detailed.messages.some((m) => m.tool?.includes("vitest run"))).toBe(true);
  });
});

describe("complete session catalog pages", () => {
  it("keeps an unreadable chat discoverable without claiming its history is empty", async () => {
    seedClaudeSession("unreadable", "existing history");
    const read = vi.spyOn(richFiles, "readSessionSummaryFile").mockRejectedValue(new Error("temporarily unavailable"));
    const result = await listRecentSessions(home, { source: "claude", cursor: "", limit: 1 }) as { sessions: SessionSummary[] };
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ id: "unreadable", preview: "日志暂时无法读取" });
    expect(result.sessions[0]).not.toHaveProperty("message_count");
    read.mockRestore();
    const transcript = await readSession(home, { source: "claude", id: "unreadable", rich: true });
    expect(transcript).toMatchObject({ total_messages: 2 });
  });

  it("crosses the recent 500-row boundary without gaps, even when activity changes between pages", async () => {
    const ids = Array.from({ length: 507 }, (_, n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`);
    for (const id of ids) seedCodexSessionAt(join(home, ".codex"), id, "headless user task");
    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 6; page += 1) {
      const result = await listRecentSessions(home, { source: "codex", limit: 100, cursor }) as {
        sessions: SessionSummary[]; has_more: boolean; total_found: number;
      };
      seen.push(...result.sessions.map((row) => row.id));
      expect(result.total_found).toBe(507);
      expect(result.has_more).toBe(page < 5);
      cursor = JSON.stringify(["codex", result.sessions.at(-1)!.id]);
      seedCodexSessionAt(join(home, ".codex"), ids[0], "still running; changed file mtime");
    }
    expect(seen).toEqual(ids);
  });

  it("keeps unlabelled default homes alongside explicit account roots and pages copied ids once", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    const original = seedCodexSessionAt(join(home, ".codex"), id, "original");
    seedCodexSessionAt(join(home, "a"), id, "copy");
    await fsPromises.utimes(original, new Date(0), new Date(0));
    const result = await listRecentSessions({ home, codexHomes: [
      { label: "", codexHome: join(home, ".codex") }, { label: "a", codexHome: join(home, "a") },
    ] }, { source: "all", cursor: "", limit: 1 }) as { sessions: SessionSummary[]; has_more: boolean };
    expect(result.sessions).toHaveLength(1);
    expect(result.has_more).toBe(false);
    const read = await readSession({ home, codexHomes: [
      { label: "", codexHome: join(home, ".codex") }, { label: "a", codexHome: join(home, "a") },
    ] }, { id, source: "codex" });
    expect(JSON.stringify(read)).toContain("copy");
  });
});

describe("Codex native list names", () => {
  const id = "00000000-0000-0000-0000-000000000001";
  const other = "00000000-0000-0000-0000-000000000002";
  const index = (root: string, name: string) => writeFileSync(join(root, "session_index.jsonl"),
    JSON.stringify({ id, thread_name: name, updated_at: "2026-09-15T00:00:00Z" }) + "\n");

  it.each(["recent", "primary", "history", "selected"] as const)(
    "updates cached %s names without changing fallback prompts", async (mode) => {
      const root = join(home, ".codex");
      const file = seedCodexSessionAt(root, id, "old prompt title");
      seedCodexSessionAt(root, other, "unnamed prompt");
      const args = { source: "codex", limit: 10, ...(mode === "primary" ? { primary_window: true } : {}),
        ...(mode === "history" ? { cursor: "" } : {}) };
      const list = () => (mode === "selected"
        ? listSelectedSessions(home, args, [{ source: "codex", id }])
        : listRecentSessions(home, args)) as Promise<{ sessions: SessionSummary[] }>;
      const before = await list();
      expect(before.sessions.find((row) => row.id === id)).toMatchObject({ first_user_text: "old prompt title" });
      index(root, "检查科研任务执行结果");
      const named = await list();
      expect(named.sessions.find((row) => row.id === id)).toMatchObject({
        title: "检查科研任务执行结果", first_user_text: "old prompt title",
      });
      expect(before.sessions.find((row) => row.id === id)?.title).toBeUndefined();
      expect(__summaryCache.get(file)?.summary.title).toBeUndefined();
      if (mode !== "selected") {
        expect(named.sessions.find((row) => row.id === other)).toMatchObject({ first_user_text: "unnamed prompt" });
        expect(named.sessions.find((row) => row.id === other)?.title).toBeUndefined();
      } else expect(named.sessions.map((row) => row.id)).toEqual([id]);
      index(root, "新的任务名称");
      expect((await list()).sessions.find((row) => row.id === id)?.title).toBe("新的任务名称");
      index(root, "   ");
      expect((await list()).sessions.find((row) => row.id === id)?.title).toBeUndefined();
      expect(named.sessions.find((row) => row.id === id)?.title).toBe("检查科研任务执行结果");
    },
  );

  it("uses the selected copy's home, never another account or an index-only session", async () => {
    const a = join(home, "codex-a");
    const b = join(home, "codex-b");
    const original = seedCodexSessionAt(a, id, "a prompt");
    seedCodexSessionAt(b, id, "b prompt");
    await fsPromises.utimes(original, new Date(0), new Date(0));
    index(a, "account a title");
    index(b, "account b title");
    writeFileSync(join(b, "session_index.jsonl"), JSON.stringify({ id: other, thread_name: "index-only" }) + "\n", { flag: "a" });
    const roots = { home, codexHomes: [{ label: "a", codexHome: a }, { label: "", codexHome: b }] };
    for (const primary_window of [false, true]) {
      const result = await listRecentSessions(roots, { source: "codex", primary_window }) as { sessions: SessionSummary[] };
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({ id, title: "account b title", first_user_text: "b prompt" });
      expect(result.sessions[0]).not.toHaveProperty("codexHome");
    }
    rmSync(join(b, "session_index.jsonl"));
    const missing = await listRecentSessions(roots, { source: "codex" }) as { sessions: SessionSummary[] };
    expect(missing.sessions[0].title).toBeUndefined();
  });

  it("preserves child ownership and its native task-title fallback", async () => {
    const root = join(home, ".codex");
    seedParentOwnedCodexSession(root, id, other);
    const list = () => listRecentSessions(home, { source: "codex", primary_window: true }) as Promise<{ sessions: SessionSummary[] }>;
    const before = (await list()).sessions[0];
    expect(before).toMatchObject({ title: "worker", input_mode: "parent_owned", parent_session_id: other });
    index(root, "命名后的子任务");
    expect((await list()).sessions[0]).toMatchObject({
      title: "命名后的子任务", input_mode: "parent_owned", parent_session_id: other,
    });
    rmSync(join(root, "session_index.jsonl"));
    expect((await list()).sessions[0]).toMatchObject(before);
  });
});
