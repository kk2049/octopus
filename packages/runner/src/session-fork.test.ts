import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ forkSession: vi.fn(async () => ({ sessionId: "f0f0f0f0-0000-4000-8000-000000000002" })) }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ forkSession: sdk.forkSession, query: vi.fn() }));

import { CodexManagedSession } from "./codex-app-server.js";
import { forkSessionAt, latestTurnAnchor, sessionAnchor } from "./session-fork.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  sdk.forkSession.mockClear();
});

const ID = "6f1d2c3b-0000-4000-8000-000000000001";
const line = (row: unknown) => `${JSON.stringify(row)}\n`;
const assistant = (uuid: string, stop: string, extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", uuid, timestamp: "2026-10-19T05:00:00.000Z", isSidechain: false, message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text: "x" }] }, ...extra });

/** A home whose scanner finds one Claude transcript of `body`. */
function claudeHome(body: string): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), "session-fork-"));
  roots.push(home);
  mkdirSync(join(home, ".claude", "projects", "demo"), { recursive: true });
  const file = join(home, ".claude", "projects", "demo", `${ID}.jsonl`);
  writeFileSync(file, line({ type: "user", sessionId: ID, cwd: home, message: { role: "user", content: "开始" } }) + body);
  return { home, file };
}

describe("latestTurnAnchor", () => {
  it("is the last finished Claude turn: never a turn still running, never a sub-agent's", async () => {
    const { file } = claudeHome(
      assistant("aaaaaaaa-0000-4000-8000-000000000001", "tool_use")
      + line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } })
      + assistant("bbbbbbbb-0000-4000-8000-000000000002", "end_turn")
      + assistant("cccccccc-0000-4000-8000-000000000003", "end_turn", { isSidechain: true })
      + line({ type: "user", origin: { kind: "human" }, message: { content: "再来一轮" } })
      + assistant("dddddddd-0000-4000-8000-000000000004", "tool_use"));
    await expect(latestTurnAnchor(file, "claude")).resolves.toEqual({ anchor: "bbbbbbbb-0000-4000-8000-000000000002", at: "2026-10-19T05:00:00.000Z" });
  });

  it("finds a record cut by the backward read's chunk boundary", async () => {
    const anchor = assistant("eeeeeeee-0000-4000-8000-000000000005", "end_turn");
    // One filler line, sized so the 1 MiB chunk read from the end starts inside the anchor's line.
    const filler = line({ type: "progress", data: "p".repeat(1024 * 1024 - 40) });
    const { file } = claudeHome(anchor + filler);
    await expect(latestTurnAnchor(file, "claude")).resolves.toMatchObject({ anchor: "eeeeeeee-0000-4000-8000-000000000005" });
  });

  it("reads back as far as the last finished turn is, through records wider than a chunk", async () => {
    // The anchor is 3 MiB wide and sits behind 66 MiB of later records: the old 64 MiB horizon missed it.
    const anchor = assistant("ffffffff-0000-4000-8000-000000000006", "end_turn", { padding: "a".repeat(3 * 1024 * 1024) });
    const filler = line({ type: "progress", data: "p".repeat(1024 * 1024) }).repeat(66);
    const { file } = claudeHome(anchor + filler);
    await expect(latestTurnAnchor(file, "claude")).resolves.toMatchObject({ anchor: "ffffffff-0000-4000-8000-000000000006" });
  });

  it("is Codex's last task_complete, and nothing before a first turn finishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-fork-codex-"));
    roots.push(root);
    const file = join(root, "rollout.jsonl");
    const event = (type: string, turn: string) => line({ type: "event_msg", payload: { type, turn_id: turn } });
    writeFileSync(file, event("task_started", "01a1528b-50c3-7bf3-a9f9-19e00c9d6c24"));
    await expect(latestTurnAnchor(file, "codex")).resolves.toBeNull();
    writeFileSync(file, event("task_started", "01a1528b-50c3-7bf3-a9f9-19e00c9d6c24") + event("task_complete", "01a1528b-50c3-7bf3-a9f9-19e00c9d6c24")
      + event("task_started", "01a1528b-8378-7833-94e6-2dd1b7ce18c8"));
    await expect(latestTurnAnchor(file, "codex")).resolves.toEqual({ anchor: "01a1528b-50c3-7bf3-a9f9-19e00c9d6c24" });
  });
});

describe("forkSessionAt", () => {
  it("forks Claude through the last finished turn, or through a snapshot's earlier anchor", async () => {
    const { home } = claudeHome(assistant("bbbbbbbb-0000-4000-8000-000000000002", "end_turn"));
    await expect(sessionAnchor(home, { source: "claude", id: ID })).resolves.toEqual({ anchor: "bbbbbbbb-0000-4000-8000-000000000002", at: "2026-10-19T05:00:00.000Z" });
    await expect(forkSessionAt(home, { source: "claude", id: ID, title: "里程碑\n· 张三的分叉" })).resolves.toEqual({
      session_id: "f0f0f0f0-0000-4000-8000-000000000002", anchor: "bbbbbbbb-0000-4000-8000-000000000002" });
    expect(sdk.forkSession).toHaveBeenLastCalledWith(ID, { upToMessageId: "bbbbbbbb-0000-4000-8000-000000000002", title: "里程碑 · 张三的分叉" });
    await forkSessionAt(home, { source: "claude", id: ID, anchor: "aaaaaaaa-0000-4000-8000-000000000001" });
    expect(sdk.forkSession).toHaveBeenLastCalledWith(ID, { upToMessageId: "aaaaaaaa-0000-4000-8000-000000000001" });
  });

  it("refuses a session with no finished turn, a malformed anchor, and other CLIs", async () => {
    const { home } = claudeHome(assistant("aaaaaaaa-0000-4000-8000-000000000001", "tool_use"));
    await expect(forkSessionAt(home, { source: "claude", id: ID })).rejects.toThrow("没有可以分叉的位置");
    await expect(forkSessionAt(home, { source: "claude", id: ID, anchor: "../x" })).rejects.toThrow("分叉位置无效");
    await expect(forkSessionAt(home, { source: "omp", id: ID })).rejects.toThrow("只能分叉");
    expect(sdk.forkSession).not.toHaveBeenCalled();
  });

  it("forks Codex through app-server thread/fork in the session's own account and directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "session-fork-codex-home-"));
    roots.push(home);
    const dir = join(home, ".codex", "sessions", "2026", "10", "19");
    mkdirSync(dir, { recursive: true });
    const thread = "01a1528b-4b6e-73b1-b15e-7f8078dd712a";
    const rollout = join(dir, `rollout-2026-10-19T05-03-44-${thread}.jsonl`);
    writeFileSync(rollout, line({ type: "session_meta", payload: { id: thread, cwd: home } })
      + line({ type: "event_msg", payload: { type: "task_complete", turn_id: "01a1528b-50c3-7bf3-a9f9-19e00c9d6c24" } }));
    const fork = vi.spyOn(CodexManagedSession, "forkThrough").mockResolvedValue("01a1528b-ff57-7e83-a0ff-7ff132180b35");
    await expect(forkSessionAt(home, { source: "codex", id: thread, title: "分叉" })).resolves.toEqual({
      session_id: "01a1528b-ff57-7e83-a0ff-7ff132180b35", anchor: "01a1528b-50c3-7bf3-a9f9-19e00c9d6c24" });
    expect(fork).toHaveBeenCalledWith(
      { sessionId: thread, path: expect.stringContaining(thread), lastTurnId: "01a1528b-50c3-7bf3-a9f9-19e00c9d6c24", name: "分叉" },
      expect.objectContaining({ cwd: home }));
  });
});
