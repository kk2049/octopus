import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LaunchJournal, RESULT_TEXT_RECEIPT_CHARS, receiptText } from "./launch-journal.js";
import { headlessCapturePaths } from "./headless-cli-launch.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(now = Date.parse("2026-08-04T00:00:00Z")) {
  const home = mkdtempSync(join(tmpdir(), "launch-journal-"));
  dirs.push(home);
  let time = now;
  return {
    home,
    journal: new LaunchJournal(home, () => time, 1_000),
    advance(ms: number) { time += ms; },
  };
}

const request = {
  client_request_id: "op_12345678",
  workspace_id: "ws_0123456789abcdef01234567",
  source: "claude" as const,
  prompt_hash: "a".repeat(64),
};

describe("LaunchJournal", () => {
  it("retains prepared identity separately from accepted input and atomically records the original answer", async () => {
    const f = fixture();
    await f.journal.begin({ ...request, source: "codex", remote_execution: true, execution_device: "4090" });
    await f.journal.markManagedPrepared(request.client_request_id, "native-591", "app-server");
    const prepared = await new LaunchJournal(f.home).read(request.client_request_id);
    expect(prepared).toMatchObject({ prepared: { session_id: "native-591" } });
    expect(prepared?.started).toBeUndefined();
    expect(prepared?.exit).toBeUndefined();
    expect(await f.journal.sessionPlacement("native-591")).toMatchObject({ execution_device: "4090", workspace_id: request.workspace_id });
    await expect(f.journal.markManagedPrepared(request.client_request_id, "wrong-native", "app-server")).rejects.toThrow("identity changed");
    await f.journal.markManagedStarted(request.client_request_id, "native-591", "app-server");
    await f.journal.markManagedCompleted(request.client_request_id, { ok: true, resultText: "original answer", durationMs: 55_000,
      usage: { tokens_in: 123, tokens_out: 45 } });
    await f.journal.markManagedCompleted(request.client_request_id, { ok: false, error: "late duplicate", durationMs: 56_000 });
    expect(await new LaunchJournal(f.home).read(request.client_request_id)).toMatchObject({ exit: { code: 0 },
      managed_result: { result_text: "original answer", duration_ms: 55_000, usage: { tokens_in: 123, tokens_out: 45 } } });
  });
  it("says when a recovery receipt keeps only the tail of a long reply", async () => {
    const f = fixture();
    await f.journal.begin({ ...request, client_request_id: "op_longreply1" });
    const reply = "HEAD-" + "x".repeat(RESULT_TEXT_RECEIPT_CHARS) + "-TAIL";
    await f.journal.markManagedCompleted("op_longreply1", { ok: true, resultText: reply, durationMs: 1 });
    const saved = (await new LaunchJournal(f.home).read("op_longreply1"))!.managed_result!;
    expect(saved).toMatchObject({ result_text_truncated: true });
    expect(saved.result_text).toBe(reply.slice(-RESULT_TEXT_RECEIPT_CHARS));
    expect(receiptText("short")).toEqual({ result_text: "short" });
  });
  it("creates requested exactly once and survives a new service instance", async () => {
    const f = fixture();
    const [one, two] = await Promise.all([f.journal.begin(request), f.journal.begin(request)]);
    expect([one.created, two.created].sort()).toEqual([false, true]);
    await f.journal.markStarted(request.client_request_id, "session-1", 123);
    await f.journal.markExit(request.client_request_id, 0, null);
    const restored = await new LaunchJournal(f.home).read(request.client_request_id);
    expect(restored).toMatchObject({
      requested: request,
      started: { session_id: "session-1", pid: 123 },
      exit: { code: 0 },
    });
  });

  it("refuses to reuse an id for different launch arguments", async () => {
    const f = fixture();
    await f.journal.begin(request);
    await expect(f.journal.begin({ ...request, prompt_hash: "b".repeat(64) })).rejects.toThrow(/另一组/);
  });

  it("binds independent CLI mode and its tmux transport into durable replay evidence", async () => {
    const f = fixture();
    const selected = { ...request, launch_mode: "independent_cli" as const };
    await f.journal.begin(selected);
    await f.journal.markStarted(request.client_request_id, "session-tmux", 456, "tmux-cli");
    await expect(f.journal.begin(request)).rejects.toThrow(/另一组/);
    await expect(new LaunchJournal(f.home).read(request.client_request_id)).resolves.toMatchObject({
      requested: { launch_mode: "independent_cli" },
      started: { session_id: "session-tmux", pid: 456, transport: "tmux-cli" },
    });
  });

  it("reads an old Codex row as legacy manual and binds new rows to the selected profile", async () => {
    const f = fixture();
    const legacy = {
      ...request,
      source: "codex" as const,
      client_request_id: "op_codexlegacy",
    };
    await f.journal.begin(legacy);
    await expect(f.journal.begin({ ...legacy, permission_profile: "manual" })).resolves.toMatchObject({ created: false });
    await expect(f.journal.begin({ ...legacy, permission_profile: "full_access" })).rejects.toThrow(/另一组/);

    const selected = { ...legacy, client_request_id: "op_codexprofile", permission_profile: "full_access" as const };
    await f.journal.begin(selected);
    await expect(f.journal.begin({ ...selected, permission_profile: "manual" })).rejects.toThrow(/另一组/);
  });

  it("restores a Codex launch that selected max effort", async () => {
    const f = fixture();
    const selected = {
      ...request,
      source: "codex" as const,
      client_request_id: "op_codexmax",
      effort: "max",
    };
    await f.journal.begin(selected);
    await expect(new LaunchJournal(f.home).read(selected.client_request_id)).resolves.toMatchObject({
      requested: { source: "codex", effort: "max" },
    });
  });

  it("reads an old Claude row as legacy full access", async () => {
    const f = fixture();
    await f.journal.begin(request);
    await expect(f.journal.begin({ ...request, permission_profile: "full_access" }))
      .resolves.toMatchObject({ created: false });
    await expect(f.journal.begin({ ...request, permission_profile: "manual" })).rejects.toThrow(/另一组/);
  });

  it("prunes only terminal rows", async () => {
    const f = fixture();
    await f.journal.begin(request);
    await f.journal.begin({ ...request, client_request_id: "op_abcdefgh", prompt_hash: "b".repeat(64) });
    await f.journal.markExit("op_abcdefgh", 1, null);
    f.advance(2_000);
    expect(await f.journal.prune()).toBe(1);
    expect(await f.journal.read(request.client_request_id)).not.toBeNull();
    expect(await f.journal.read("op_abcdefgh")).toBeNull();
  });
});


it("recovers late identity and exit from only the original persisted launch capture after restart", async () => {
  const f = fixture();
  await f.journal.begin({ ...request, source: "codex" });
  await f.journal.markSpawned(request.client_request_id, 123);
  const capture = headlessCapturePaths(f.home, request.client_request_id);
  mkdirSync(join(f.home, ".octopus-runner", "launch-captures"), { recursive: true });
  writeFileSync(capture.outputFile, JSON.stringify({ type: "thread.started", thread_id: "late-after-restart" }));
  writeFileSync(capture.exitFile, "0\n");
  const restarted = new LaunchJournal(f.home);
  expect(await restarted.reconcile(request.client_request_id)).toMatchObject({
    started: { session_id: "late-after-restart", pid: 123, transport: "exec" }, exit: { code: 0 },
  });
  expect(await restarted.reconcile("op_other0000")).toBeNull();
});
