import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managedRecoveryPrompt, ManagedRecoveryJournal } from "./managed-recovery.js";
import type { ProviderSessionRef } from "./provider-session-ref.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(now = new Date("2026-08-25T08:00:00.000Z")) {
  const root = mkdtempSync(join(tmpdir(), "managed-recovery-"));
  roots.push(root);
  const stateFile = join(root, ".octopus", "managed-recovery.json");
  return {
    root,
    stateFile,
    journal: new ManagedRecoveryJournal({ stateFile, now: () => now }),
  };
}

function session(id: string, rolloutPath?: string): ProviderSessionRef {
  return {
    logicalId: id,
    currentProviderId: id,
    ...(rolloutPath ? { rolloutPath } : {}),
    lineage: [id],
  };
}

describe("ManagedRecoveryJournal", () => {
  it("persists capacity backoff across restart without shortening it on a wake hint", async () => {
    const now = new Date("2026-08-25T08:00:00.000Z");
    const f = fixture(now), ref = session("capacity");
    await f.journal.load();
    await f.journal.prepare({ provider: "codex", session: ref, cwd: f.root, codexHome: join(f.root, "account-d"),
      model: "selected-model", effort: "xhigh", permissionProfile: "manual" });
    await f.journal.activate("codex", ref, "original");
    const checkpoint = { phase: "waiting" as const, attempts: 2, firstFailureAt: now.toISOString(),
      deadlineAt: "2026-08-25T08:30:00.000Z", nextRetryAt: "2026-08-25T08:02:00.000Z" };
    await f.journal.setCapacityRetry("codex", ref, "original", checkpoint);
    const next = new ManagedRecoveryJournal({ stateFile: f.stateFile, now: () => now }); await next.load();
    await next.claimInterrupted();
    expect(next.pendingRecovery(now.getTime(), true)).toEqual([]);
    now.setMinutes(2);
    const [record] = next.pendingRecovery(now.getTime(), true);
    expect(record).toMatchObject({ model: "selected-model", effort: "xhigh", permissionProfile: "manual", capacityRetry: checkpoint });
    expect(await next.beginRecoveryDispatch(record!)).toBe(true);
    expect(next.snapshot()[0]?.capacityRetry).toMatchObject({ attempts: 3, phase: "dispatching", deadlineAt: checkpoint.deadlineAt });
    await next.prepare(record!, true); await next.activate("codex", ref, "recovered");
    expect(next.snapshot()[0]?.capacityRetry).toMatchObject({ attempts: 3, phase: "active" });
  });

  it("never replays capacity dispatch ambiguity and Stop cannot resurrect its checkpoint", async () => {
    const f = fixture(), ref = session("capacity");
    await f.journal.load();
    await f.journal.prepare({ provider: "codex", session: ref, cwd: f.root });
    await f.journal.activate("codex", ref, "original");
    const checkpoint = { phase: "dispatching" as const, attempts: 1,
      firstFailureAt: "2026-08-25T08:00:00.000Z", deadlineAt: "2026-08-25T08:30:00.000Z" };
    await f.journal.setCapacityRetry("codex", ref, "original", checkpoint);
    const next = new ManagedRecoveryJournal({ stateFile: f.stateFile }); await next.load();
    expect(await next.claimInterrupted()).toEqual([]);
    expect(next.snapshot()[0]).toMatchObject({ status: "unknown", capacityRetry: checkpoint });
    await next.disarm("codex", ref);
    expect(await next.setCapacityRetry("codex", ref, "original", checkpoint)).toBe(false);
    expect(next.snapshot()).toEqual([]);
  });

  it("expires the capacity deadline after restart without provider dispatch", async () => {
    const f = fixture(), ref = session("capacity");
    await f.journal.load(); await f.journal.prepare({ provider: "codex", session: ref, cwd: f.root });
    await f.journal.activate("codex", ref, "original");
    await f.journal.setCapacityRetry("codex", ref, "original", { phase: "waiting", attempts: 0,
      firstFailureAt: "2026-08-25T07:00:00.000Z", deadlineAt: "2026-08-25T07:30:00.000Z", nextRetryAt: "2026-08-25T07:00:30.000Z" });
    const [record] = await f.journal.claimInterrupted();
    expect(await f.journal.beginRecoveryDispatch(record!)).toBe(false);
    expect(f.journal.snapshot()[0]).toMatchObject({ status: "idle", capacityResult: { ok: false, error: expect.stringContaining("耗尽") } });
    expect(f.journal.capacityReceipt("capacity", "original")).toMatchObject({ state: "failed" });
  });

  it("retains a bounded final result for the original receipt after a recovered native turn", async () => {
    const f = fixture(), ref = session("capacity");
    await f.journal.load(); await f.journal.prepare({ provider: "codex", session: ref, cwd: f.root });
    await f.journal.activate("codex", ref, "original");
    await f.journal.setCapacityRetry("codex", ref, "original", { phase: "waiting", attempts: 1,
      firstFailureAt: "2026-08-25T08:00:00Z", deadlineAt: "2026-08-25T08:30:00Z", nextRetryAt: "2026-08-25T08:00:00Z" });
    const [record] = await f.journal.claimInterrupted(); await f.journal.beginRecoveryDispatch(record!);
    await f.journal.prepare(record!, true); await f.journal.activate("codex", ref, "new-native-turn");
    expect(f.journal.capacityReceipt("capacity", "original")).toEqual({ state: "running" });
    expect(f.journal.capacityReceipt("other", "original")).toBeUndefined();
    expect(f.journal.capacityReceipt("capacity", "different-turn")).toBeUndefined();
    await f.journal.complete("codex", ref, "new-native-turn", { ok: false, error: "capacity exhausted" });
    const next = new ManagedRecoveryJournal({ stateFile: f.stateFile }); await next.load();
    expect(next.capacityReceipt("capacity", "original")).toEqual({ state: "failed", result: { ok: false, error: "capacity exhausted" } });
    expect(await next.claimInterrupted()).toEqual([]);
  });

  it("persists a bounded Claude subagent roster without prompts or outputs", async () => {
    const f = fixture();
    await f.journal.load();
    const ref = session("session-team");
    await f.journal.prepare({ provider: "claude", session: ref, cwd: f.root });
    await f.journal.activate("claude", ref, "turn-team");
    await f.journal.setBackgroundTasks("claude", ref, [{
      taskId: "research-agent",
      toolUseId: "tool-1",
      description: "检索相关工作\n并核验结论",
      ...({ prompt: "never persist this", output: "nor this" } as Record<string, string>),
    }]);

    const restarted = new ManagedRecoveryJournal({ stateFile: f.stateFile });
    await restarted.load();
    const [record] = await restarted.claimInterrupted();
    expect(record).toMatchObject({
      backgroundTasks: [{
        taskId: "research-agent",
        toolUseId: "tool-1",
        description: "检索相关工作 并核验结论",
      }],
    });
    expect(managedRecoveryPrompt(record!)).toContain("旧 subagent 进程已经结束");
    expect(managedRecoveryPrompt(record!)).toContain("research-agent");
    const persisted = readFileSync(f.stateFile, "utf8");
    expect(persisted).not.toContain("never persist this");
    expect(persisted).not.toContain("nor this");
  });

  it("removes the Claude subagent roster when all tasks settle", async () => {
    const f = fixture();
    await f.journal.load();
    const ref = session("session-team");
    await f.journal.prepare({ provider: "claude", session: ref, cwd: f.root });
    await f.journal.setBackgroundTasks("claude", ref, [{ taskId: "agent-1" }]);
    await f.journal.setBackgroundTasks("claude", ref, []);
    expect(f.journal.snapshot()[0]).not.toHaveProperty("backgroundTasks");
  });

  it("never reclaims a continuation after its durable dispatch barrier", async () => {
    const f = fixture();
    await f.journal.load();
    await f.journal.prepare({
      provider: "claude",
      session: session("session-one"),
      cwd: f.root,
      permissionProfile: "full_access",
    });
    await f.journal.activate("claude", session("session-one"), "turn-one");

    const restarted = new ManagedRecoveryJournal({ stateFile: f.stateFile });
    await restarted.load();
    await expect(restarted.claimInterrupted()).resolves.toMatchObject([{
      provider: "claude",
      session: {
        logicalId: "session-one",
        currentProviderId: "session-one",
      },
      status: "recovering",
      recoveryCount: 1,
      turnId: "turn-one",
    }]);

    await restarted.beginRecoveryDispatch(restarted.snapshot()[0]!);
    const crashedAgain = new ManagedRecoveryJournal({ stateFile: f.stateFile });
    await crashedAgain.load();
    await expect(crashedAgain.claimInterrupted()).resolves.toEqual([]);
    expect(crashedAgain.snapshot()).toMatchObject([{
      status: "unknown",
      recoveryCount: 1,
    }]);
  });

  it("retains dependency waits and their age across repeated restarts without dispatching", async () => {
    const f = fixture();
    await f.journal.load();
    const ref = session("waiting-one");
    await f.journal.prepare({ provider: "codex", session: ref, cwd: f.root });
    await f.journal.activate("codex", ref, "accepted-turn");
    const [claim] = await f.journal.claimInterrupted();
    expect(await f.journal.waitForDependency(claim!, "transport is down")).toBe(true);
    const first = f.journal.snapshot()[0]!;
    const later = new Date(Date.parse(first.unavailableSince!) + 70_000);
    const restarted = new ManagedRecoveryJournal({ stateFile: f.stateFile, now: () => later });
    await restarted.load();
    expect(await restarted.claimInterrupted()).toHaveLength(1);
    expect(await restarted.waitForDependency(restarted.snapshot()[0]!, "still offline")).toBe(true);
    expect(restarted.snapshot()[0]).toMatchObject({ status: "recovering", recoveryPhase: "waiting_resource",
      recoveryCount: 1, unavailableSince: first.unavailableSince, nextRetryAt: new Date(later.getTime() + 30_000).toISOString() });
    expect(restarted.pendingRecovery()).toEqual([]);
    expect(restarted.pendingRecovery(0, true)).toHaveLength(1);
    await restarted.disarm("codex", ref);
    expect(await restarted.beginRecoveryDispatch(claim!)).toBe(false);
    expect(await restarted.waitForDependency(claim!, "late failed probe")).toBe(false);
  });

  it("quarantines legacy recovery ambiguity rather than upgrading it to safe preparation", async () => {
    const f = fixture();
    await f.journal.load();
    const ref = session("legacy-recovery");
    await f.journal.prepare({ provider: "codex", session: ref, cwd: f.root });
    await f.journal.activate("codex", ref, "legacy-turn");
    const [claim] = await f.journal.claimInterrupted();
    const { recoveryPhase: _phase, ...legacy } = claim!;
    writeFileSync(f.stateFile, JSON.stringify({ records: [legacy] }));
    const restarted = new ManagedRecoveryJournal({ stateFile: f.stateFile });
    await restarted.load();
    expect(await restarted.claimInterrupted()).toEqual([]);
    expect(restarted.snapshot()[0]?.status).toBe("unknown");
  });

  it("treats a dispatch crash window as unknown instead of replaying it", async () => {
    const f = fixture();
    await f.journal.load();
    await f.journal.prepare({ provider: "codex", session: session("thread-one"), cwd: f.root });

    const restarted = new ManagedRecoveryJournal({ stateFile: f.stateFile });
    await restarted.load();
    await expect(restarted.claimInterrupted()).resolves.toEqual([]);
    expect(restarted.snapshot()[0]).toMatchObject({ status: "unknown" });
  });

  it("keeps only non-secret split coordinates after completion", async () => {
    const f = fixture();
    await f.journal.load();
    const ref = session("omp-one", join(f.root, "omp-one.jsonl"));
    await f.journal.prepare({
      provider: "omp",
      session: ref,
      cwd: f.root,
      remotePlacement: {
        executionDevice: "val15",
        workspaceId: "ws_0123456789abcdef01234567",
      },
    });
    await f.journal.activate("omp", ref, "turn-omp");
    await f.journal.complete("omp", ref, "turn-omp");

    expect(f.journal.snapshot()).toMatchObject([{
      status: "idle",
      remotePlacement: {
        executionDevice: "val15",
        workspaceId: "ws_0123456789abcdef01234567",
      },
    }]);
    expect(readFileSync(f.stateFile, "utf8")).not.toContain("mcp_");
    expect(statSync(f.stateFile).mode & 0o777).toBe(0o600);
  });

  it("retains a development identity after restart and refuses to erase or replace it", async () => {
    const f = fixture();
    await f.journal.load();
    const ref = session("development-thread");
    const remotePlacement = {
      gatewaySite: "mirror",
      executionDevice: "compute",
      workspaceId: "ws_0123456789abcdef01234567",
      developmentId: "development_ticket_578",
    };
    await f.journal.prepare({ provider: "codex", session: ref, cwd: f.root, remotePlacement });
    await f.journal.activate("codex", ref, "turn-development");
    await f.journal.complete("codex", ref, "turn-development");
    const restarted = new ManagedRecoveryJournal({ stateFile: f.stateFile });
    await restarted.load();
    expect(restarted.snapshot()).toMatchObject([{ status: "idle", remotePlacement }]);
    for (const developmentId of [undefined, "other_ticket"]) {
      await expect(restarted.prepare({
        provider: "codex", session: ref, cwd: f.root,
        remotePlacement: { ...remotePlacement, developmentId },
      })).rejects.toThrow("开发会话恢复身份缺失或不一致");
      expect(restarted.snapshot()).toMatchObject([{ status: "idle", remotePlacement }]);
    }
    await expect(restarted.prepare({ provider: "codex", session: ref, cwd: f.root, remotePlacement })).resolves.toBeUndefined();
    expect(readFileSync(f.stateFile, "utf8")).not.toMatch(/"token"|"endpoint"|mcp_/);
  });

  it("disarms an interrupted local turn instead of waking it after restart", async () => {
    const f = fixture();
    await f.journal.load();
    const ref = session("session-stop");
    await f.journal.prepare({ provider: "claude", session: ref, cwd: f.root });
    await f.journal.activate("claude", ref, "turn-stop");
    await f.journal.disarm("claude", ref, "turn-stop");
    expect(f.journal.snapshot()).toEqual([]);
  });

  it("persists a provider rename with its original rollout path across restart", async () => {
    const f = fixture();
    await f.journal.load();
    const original = session("thread-child", join(f.root, "thread-child.jsonl"));
    await f.journal.prepare({ provider: "codex", session: original, cwd: f.root });
    const renamed: ProviderSessionRef = {
      logicalId: "thread-child",
      currentProviderId: "thread-fork",
      rolloutPath: original.rolloutPath,
      lineage: ["thread-child", "thread-fork"],
    };
    await f.journal.renameSession("codex", "thread-child", renamed);
    await f.journal.activate("codex", renamed, "turn-fork");

    const restarted = new ManagedRecoveryJournal({ stateFile: f.stateFile });
    await restarted.load();
    await expect(restarted.claimInterrupted()).resolves.toMatchObject([{
      session: {
        logicalId: "thread-child",
        currentProviderId: "thread-fork",
        rolloutPath: join(f.root, "thread-child.jsonl"),
        lineage: ["thread-child", "thread-fork"],
      },
    }]);
    expect(restarted.sessionRefs()).toContainEqual(expect.objectContaining({
      provider: "codex",
      logicalId: "thread-child",
      currentProviderId: "thread-fork",
    }));
  });

  it("loads a v1 recovery row into the first logical session ref", async () => {
    const f = fixture();
    mkdirSync(join(f.root, ".octopus"), { recursive: true });
    writeFileSync(f.stateFile, JSON.stringify({
      version: 1,
      records: [{
        version: 1,
        provider: "codex",
        sessionId: "thread-legacy",
        sessionPath: join(f.root, "thread-legacy.jsonl"),
        cwd: f.root,
        status: "active",
        turnId: "turn-legacy",
        recoveryCount: 0,
        updatedAt: "2026-08-25T08:00:00.000Z",
      }],
    }));

    await f.journal.load();
    await expect(f.journal.claimInterrupted()).resolves.toMatchObject([{
      version: 2,
      session: {
        logicalId: "thread-legacy",
        currentProviderId: "thread-legacy",
        rolloutPath: join(f.root, "thread-legacy.jsonl"),
        lineage: ["thread-legacy"],
      },
      status: "recovering",
    }]);
  });

  it("persists only a prompt digest for terminal resend suppression", async () => {
    const f = fixture();
    await f.journal.load();
    const ref = session("thread-terminal");
    const digest = createHash("sha256").update("secret prompt").digest("hex");
    await f.journal.rememberTerminalSend(
      "codex",
      ref,
      digest,
      "2026-08-25T08:00:00.000Z",
      120_000,
      64,
    );

    const persisted = readFileSync(f.stateFile, "utf8");
    expect(persisted).toContain(digest);
    expect(persisted).not.toContain("secret prompt");
    const restarted = new ManagedRecoveryJournal({
      stateFile: f.stateFile,
      now: () => new Date("2026-08-25T08:00:01.000Z"),
    });
    await restarted.load();
    expect(restarted.recentTerminalSend(
      "codex",
      ref,
      digest,
      "2026-08-25T08:00:00.000Z",
      120_000,
    )).toBe(1_000);
  });
});
