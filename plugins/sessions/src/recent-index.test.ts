import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecentSessions, listSelectedSessions, sessionListCursor, readSession, resetRecentSessionIndexes, invalidateSessionEnumeration, subagentParentId, type SessionSummary, type SessionRosterPriority } from "./scan.js";
import { RecentSessionIndex, SESSION_INDEX_SUMMARY_BYTES } from "./recent-index.js";
import { SESSION_AUTOMATED_WINDOW } from "@claude-bot/agent-sessions-contract";
import { parseSessionText } from "./parse.js";

let home: string;
const before = "2026-08-20T12:00:00.000Z";
const now = "2026-09-07T12:00:00.000Z";
const id = (n: number) => "00000000-0000-0000-0000-" + String(n).padStart(12, "0");
function seed(n: number, child = false, time = before, source = "cli", originator?: string): string {
  const dir = join(home, ".codex", "sessions", time.slice(0, 10));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-" + time.slice(0, 10) + "-" + id(n) + ".jsonl");
  const data = [
    { type: "session_meta", payload: { id: id(n), cwd: "/work/project",
      source: child ? { subagent: { thread_spawn: { parent_thread_id: id(1) } } } : source,
      ...(originator ? { originator } : {}),
      ...(child ? { parent_thread_id: id(1) } : {}) } },
    { type: "event_msg", timestamp: time, payload: { type: "user_message", message: "task " + n } },
  ];
  writeFileSync(file, data.map((row) => JSON.stringify(row)).join("\n"));
  utimesSync(file, new Date(time), new Date(time));
  return file;
}
type Result = { sessions: SessionSummary[]; total_found: number; index_pending: boolean; index_stats: { fileChecks: number; headerReads: number; summaryReads: number } };
async function refresh(): Promise<Result> {
  invalidateSessionEnumeration(home);
  return await listRecentSessions(home, { source: "all", limit: 200, primary_window: true }) as Result;
}
async function settle(): Promise<Result> {
  let result = await refresh();
  for (let i = 0; i < 30 && result.index_pending; i++) result = await refresh();
  return result;
}
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "session-working-set-")); });
afterEach(() => { resetRecentSessionIndexes(); rmSync(home, { recursive: true, force: true }); });

it("includes an old foreground terminal before cold backfill and rechecks priority on warm reads", async () => {
  seed(1, false, "2020-01-01T00:00:00.000Z");
  for (let n = 2; n <= 1200; n++) seed(n, false, now);
  const key = sessionListCursor({ source: "codex", id: id(1) });
  let attached = true;
  const priority: SessionRosterPriority = async (candidates) => {
    expect(candidates).toHaveLength(1200);
    return new Set(attached ? [key] : []);
  };
  const args = { primary_window: true, limit: 200 };
  let result = await listRecentSessions(home, args, priority) as Result;
  expect(result.sessions).toHaveLength(200);
  expect(result.sessions[0].id).toBe(id(1));
  expect(result.index_pending).toBe(true);
  expect(result.index_stats.fileChecks).toBeLessThanOrEqual(1_401);
  attached = false;
  result = await listRecentSessions(home, args, priority) as Result;
  expect(result.sessions.some((row) => row.id === id(1))).toBe(false);
  attached = true;
  result = await listRecentSessions(home, args, priority) as Result;
  expect(result.sessions[0].id).toBe(id(1));

  // Scoped catalogs must apply runtime priority before their raw 500-file cap,
  // without disclosing the excluded files to the observer.
  const selection = Array.from({ length: 700 }, (_, n) => ({ source: "codex" as const, id: id(n + 1) }));
  result = await listSelectedSessions(home, args, selection, async (candidates) => {
    expect(candidates).toHaveLength(700);
    expect(candidates.every((row) => selection.some((selected) => selected.id === row.id))).toBe(true);
    return new Set([key]);
  }) as Result;
  expect(result.sessions[0].id).toBe(id(1));
  expect(result.sessions).toHaveLength(200);

  await listRecentSessions(home, { cursor: "", limit: 10 }, async () => {
    throw new Error("history order must not consult foreground priority");
  });
});

it("retains 200 older independent chats despite a new subagent flood, then survives a cold restart", async () => {
  for (let n = 1; n <= 200; n++) seed(n);
  let result = await settle();
  expect(result.sessions.filter((row) => !row.is_subagent)).toHaveLength(200);
  for (let n = 201; n <= 2200; n++) seed(n, true, now);
  for (let round = 0; round < 12; round++) {
    result = await refresh();
    expect(result.sessions.filter((row) => !row.is_subagent)).toHaveLength(200);
    expect(result.index_stats.fileChecks).toBeLessThanOrEqual(1_400);
    expect(result.index_stats.summaryReads).toBe(0);
  }
  expect(result.index_pending).toBe(false);
  expect(result.sessions.filter((row) => row.is_subagent).length).toBeLessThanOrEqual(300);
  resetRecentSessionIndexes();
  result = await refresh();
  expect(result.sessions.filter((row) => !row.is_subagent)).toHaveLength(200);
  expect(result.index_stats.summaryReads).toBe(0);
  expect(result.index_stats.headerReads).toBe(0);
  expect((await fs.stat(join(home, ".octopus", "session-roster-cache-v1.json"))).mode & 0o777).toBe(0o600);
});

it("bounds summary bytes while allowing one oversized log to make fair progress", async () => {
  const files = [seed(1), seed(2), seed(3)];
  const sizes = [96, 40, 40].map((mb) => mb * 1024 * 1024);
  await Promise.all(files.map((file, i) => fs.truncate(file, sizes[i])));
  let bytes = 0;
  const processed = new Set<string>();
  const index = new RecentSessionIndex({ home, entries: async () => files.map((file) => ({ path: file, source: "codex" as const })),
    parentId: () => null,
    summarize: async (file) => {
      bytes += file.size;
      processed.add(file.path);
      return { ...file, id: id(files.indexOf(file.path) + 1), last_activity: before, message_count: 1 };
    },
  });
  for (let pass = 0; pass < 4; pass++) {
    index.invalidate(); bytes = 0;
    const result = await index.list({ primary_window: true, limit: 200 }) as Result;
    expect(result.sessions).toHaveLength(3);
    expect(bytes).toBeLessThanOrEqual(Math.max(SESSION_INDEX_SUMMARY_BYTES, sizes[0]));
    if (bytes > SESSION_INDEX_SUMMARY_BYTES) expect(result.index_stats.summaryReads).toBe(1);
  }
  expect(processed.size).toBe(3);
});

it("lets the one-second backfill cadence advance instead of reusing a three-second partial snapshot", async () => {
  const files = Array.from({ length: 600 }, (_, n) => seed(n + 2, true));
  let time = Date.parse(now);
  const index = new RecentSessionIndex({ home, now: () => time,
    entries: async () => files.map((file) => ({ source: "codex" as const, path: file })),
    parentId: (row) => subagentParentId({ ...row }),
    summarize: async () => { throw new Error("child headers must not read full transcripts"); },
  });
  expect((await index.list({}) as Result).index_pending).toBe(true);
  time += 999;
  expect((await index.list({}) as Result).index_pending).toBe(true);
  time += 1;
  expect((await index.list({}) as Result).index_pending).toBe(false);
});

it("finds a backdated imported chat and detects output, truncation and replacement without monotonic mtime", async () => {
  const file = seed(1);
  await settle();
  await fs.appendFile(file, "\n" + JSON.stringify({ type: "event_msg", timestamp: now, payload: { type: "user_message", message: "resumed" } }));
  utimesSync(file, new Date(before), new Date(before));
  let result = await refresh();
  expect(result.sessions.find((row) => row.id === id(1))?.message_count).toBe(2);
  const imported = seed(2, false, "2020-01-01T00:00:00.000Z");
  result = await settle();
  expect(result.sessions.some((row) => row.id === id(2))).toBe(true);
  await fs.writeFile(imported, JSON.stringify({ type: "session_meta", payload: { id: id(2), cwd: "/replacement" } }));
  utimesSync(imported, new Date("2019-01-01"), new Date("2019-01-01"));
  result = await refresh();
  expect(result.sessions.find((row) => row.id === id(2))?.cwd).toBe("/replacement");
  expect(result.sessions.find((row) => row.id === id(2))?.message_count).toBe(0);
});

it("rediscovers a resumed chat outside both retained and hot windows without any watcher hint", async () => {
  const files = Array.from({ length: 800 }, (_, n) => seed(n + 1));
  // Supplying inventory directly installs no directory watchers. All original
  // files are older than the hot window and only 200 fit the retained reserve.
  const index = new RecentSessionIndex({ home, now: () => Date.parse(now),
    entries: async () => files.map((file) => ({ source: "codex" as const, path: file })),
    parentId: (row) => subagentParentId({ ...row }),
    summarize: async (file) => {
      const { meta } = parseSessionText(file.source, await fs.readFile(file.path, "utf8"));
      return { ...file, ...meta, id: meta.id!, last_activity: meta.last_activity ?? before };
    },
  });
  const next = async () => { index.invalidate(); return await index.list({ limit: 200 }) as Result; };
  let result = await next();
  for (let pass = 0; pass < 10 && result.index_pending; pass++) result = await next();
  expect(result.index_pending).toBe(false);
  const target = files[449];
  expect(result.sessions.some((row) => row.id === id(450))).toBe(false);
  await fs.appendFile(target, "\n" + JSON.stringify({ type: "event_msg", timestamp: now,
    payload: { type: "user_message", message: "resumed outside all priority windows" } }));
  utimesSync(target, new Date(before), new Date(before));
  let detected = false;
  for (let pass = 0; pass < 10; pass++) {
    // New children keep arriving while the old-file reconciliation progresses.
    for (let n = 0; n < 100; n++) files.push(seed(1000 + pass * 100 + n, true, now));
    result = await next();
    expect(result.index_stats.fileChecks).toBeLessThanOrEqual(1_400);
    if (result.sessions.some((row) => row.id === id(450) && row.message_count === 2)) { detected = true; break; }
  }
  expect(detected).toBe(true);
  expect(result.sessions[0].id).toBe(id(450));
});

it("does not let a cached path outside the current trusted roots re-enter the roster", async () => {
  seed(1);
  await settle();
  const cache = join(home, ".octopus", "session-roster-cache-v1.json");
  const stored = JSON.parse(await fs.readFile(cache, "utf8"));
  stored.rows[0].file.path = "/outside/secret.jsonl";
  stored.rows[0].summary.path = "/outside/secret.jsonl";
  await fs.writeFile(cache, JSON.stringify(stored));
  resetRecentSessionIndexes();
  const result = await settle();
  expect(result.sessions.map((row) => row.path)).not.toContain("/outside/secret.jsonl");
  expect(result.sessions).toHaveLength(1);
});

it("preserves discovery when a trusted sessions directory is a symlink", async () => {
  seed(1);
  const directory = join(home, ".codex", "sessions");
  const target = join(home, "provider-logs");
  await fs.rename(directory, target);
  await fs.symlink(target, directory, "dir");
  const result = await settle();
  expect(result.sessions.map((row) => row.id)).toEqual([id(1)]);
});

it("indexes Claude lineage and independent account/app-server roots without reusing withdrawn roots", async () => {
  seed(1);
  const accountFile = seed(3, false, before, "exec");
  const accountHome = join(home, "app-server-home");
  await fs.mkdir(join(accountHome, "sessions"), { recursive: true });
  await fs.rename(accountFile, join(accountHome, "sessions", "rollout-" + id(3) + ".jsonl"));
  const project = join(home, ".claude", "projects", "project");
  await fs.mkdir(join(project, id(8), "subagents"), { recursive: true });
  const claude = { type: "user", sessionId: id(8), cwd: "/work/project", timestamp: before,
    message: { role: "user", content: "Claude task" } };
  await fs.writeFile(join(project, id(8) + ".jsonl"), JSON.stringify(claude));
  await fs.writeFile(join(project, id(8), "subagents", "agent-worker.jsonl"),
    JSON.stringify({ ...claude, isSidechain: true, agentId: "worker" }));
  const roots = { home, codexHomes: [{ codexHome: join(home, ".codex"), label: "" }, { codexHome: accountHome, label: "b" }] };
  const result = await listRecentSessions(roots, { primary_window: true, limit: 200 }) as Result;
  expect(result.sessions.filter((row) => !row.is_subagent)).toHaveLength(3);
  expect(result.sessions.find((row) => row.id === id(3))).toMatchObject({ account_label: "b", execution_mode: "exec" });
  expect(result.sessions.find((row) => row.id === "agent-worker")).toMatchObject({ source: "claude", parent_session_id: id(8), is_subagent: true });
  expect(result.sessions.find((row) => row.id === "agent-worker")?.message_count).toBe(1);
  const codex = await listRecentSessions(roots, { primary_window: true, source: "codex" }) as Result;
  expect(codex.total_found).toBe(2);
  expect(codex.sessions).toHaveLength(2);
  const contracted = await listRecentSessions({ home, codexHomes: [roots.codexHomes[0]] }, { primary_window: true }) as Result;
  expect(contracted.sessions.some((row) => row.id === id(3))).toBe(false);
  expect(contracted.sessions.filter((row) => !row.is_subagent)).toHaveLength(2);
});

it("keeps large child counts unknown and reads their actual history on demand", async () => {
  seed(1);
  const child = seed(2, true);
  await fs.appendFile(child, "\n" + JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(70_000) } }));
  const result = await settle();
  expect(result.sessions.find((row) => row.id === id(2))?.message_count).toBeUndefined();
  const transcript = await readSession(home, { id: id(2), source: "codex", rich: true, max_messages: 1 });
  expect(transcript).toMatchObject({ total_messages: 2, returned_messages: 1, offset: 1 });
  const first = await readSession(home, { id: id(2), source: "codex", rich: true, max_messages: 1, offset: 0 });
  expect(first).toMatchObject({ total_messages: 2, returned_messages: 1, offset: 0 });
});

it("refreshes old cached child labels and counts without discarding retained primary chats", async () => {
  seed(1); seed(2, true);
  await settle();
  const cache = join(home, ".octopus", "session-roster-cache-v1.json");
  const stored = JSON.parse(await fs.readFile(cache, "utf8"));
  for (const row of stored.rows) {
    row.version = row.version.split(":").slice(1).join(":");
    row.header.title = "Incorrect inherited title";
    if (row.header.is_subagent) delete row.header.message_count;
  }
  await fs.writeFile(cache, JSON.stringify(stored));
  resetRecentSessionIndexes();
  const result = await settle();
  expect(result.sessions.find((row) => row.id === id(1))).toBeDefined();
  expect(result.sessions.find((row) => row.id === id(2))).toMatchObject({ title: "子 Agent 00000000", message_count: 1 });
});

it("gives a newer exec burst and its harness forks their own allowance instead of the chats' window", async () => {
  for (let n = 1; n <= 200; n++) seed(n);
  for (let n = 201; n <= 700; n++) seed(n, false, now, "exec", "codex_exec");
  // `exec resume` forks record source "vscode"; only the originator says exec.
  for (let n = 701; n <= 900; n++) seed(n, false, now, "vscode", "codex_exec");
  const result = await settle();
  expect(result.index_pending).toBe(false);
  const roots = result.sessions.filter((row) => !row.is_subagent);
  expect(roots.filter((row) => row.execution_mode !== "exec").map((row) => row.id).sort())
    .toEqual(Array.from({ length: 200 }, (_, index) => id(index + 1)));
  expect(roots.filter((row) => row.execution_mode === "exec")).toHaveLength(SESSION_AUTOMATED_WINDOW);
});

it("corrects a retained summary's exec mark from a re-read header without a whole-file read", async () => {
  const file = seed(1, false, before, "vscode", "codex_exec");
  const stateFile = join(home, ".octopus", "legacy-cache.json");
  await fs.mkdir(join(home, ".octopus"), { recursive: true });
  const st = await fs.stat(file);
  const fingerprint = ["4", st.dev, st.ino, st.ctimeMs, st.mtimeMs, st.size].join(":");
  const known = { id: id(1), source: "codex" as const, path: file, last_activity: before };
  await fs.writeFile(stateFile, JSON.stringify({ version: 1, rows: [{
    file: { source: "codex", path: file, project: "sessions", mtimeMs: st.mtimeMs, size: st.size },
    version: fingerprint, header: known, summary: { ...known, message_count: 42 }, summaryVersion: fingerprint,
  }] }));
  let summaries = 0;
  const index = new RecentSessionIndex({ home, stateFile,
    entries: async () => [{ source: "codex", path: file, project: "sessions" }],
    summarize: async () => { summaries += 1; throw new Error("whole-file read unavailable"); },
    parentId: () => null });
  const result = await index.list({ primary_window: true, limit: 200 }) as Result;
  expect(summaries).toBe(1);
  expect(result.sessions).toEqual([expect.objectContaining({ id: id(1), message_count: 42, execution_mode: "exec" })]);
});
