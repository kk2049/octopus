import { describe, expect, it, vi } from "vitest";
import { RUNNER_MANAGED_COMPLETION_SCHEMA, type RunnerManagedCompletion } from "@claude-bot/runner/gateway-protocol";
import {
  AgentCompletionRelay,
  buildAgentCompletionCard,
  directAgentCompletionSink,
  managedCompletionNotice,
  MANAGED_COMPLETION_NOTICE_WINDOW_MS,
  type AgentCompletionEvent,
  type ManagedCompletionNoticeClaim,
} from "./relay.js";

const event = (runId: string): AgentCompletionEvent => ({
  runId,
  owner: "lht",
  surface: "app",
  label: "HQ 秘书",
  status: "succeeded",
});

describe("AgentCompletionRelay", () => {
  it("buffers startup completions and then delivers live events once", () => {
    const relay = new AgentCompletionRelay();
    relay.publish(event("early"));
    const sink = vi.fn();
    const unsubscribe = relay.subscribe(sink);
    relay.publish(event("live"));
    expect(sink.mock.calls.map(([seen]) => seen.runId)).toEqual(["early", "live"]);
    unsubscribe();
    relay.publish(event("later"));
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("bounds the pre-Router queue", () => {
    const relay = new AgentCompletionRelay(2);
    relay.publish(event("one"));
    relay.publish(event("two"));
    relay.publish(event("three"));
    const seen: string[] = [];
    relay.subscribe((item) => seen.push(item.runId));
    expect(seen).toEqual(["two", "three"]);
  });
});

describe("buildAgentCompletionCard", () => {
  it("names the surface and terminal state without carrying run output or owner identity", () => {
    const card = buildAgentCompletionCard({ ...event("secret-run"), status: "failed" });
    const encoded = JSON.stringify(card);
    expect(encoded).toContain("Agent 运行失败");
    expect(encoded).toContain("对应 App 页面");
    expect(encoded).not.toContain("secret-run");
    expect(encoded).not.toContain("lht");
  });

  it("distinguishes merge-lock auto-retry and Sessions+ managed completion destinations", () => {
    const waiting = JSON.stringify(buildAgentCompletionCard({
      ...event("merge-lock"),
      surface: "dev",
      status: "merge_lock",
    }));
    expect(waiting).toContain("Agent 等待合并锁");
    expect(waiting).toContain("合并锁释放后会自动重试");
    expect(waiting).not.toContain("等待你的操作");

    const managed = JSON.stringify(buildAgentCompletionCard({
      ...event("managed"),
      surface: "sessions",
      label: "Sessions+ · laptop · codex 托管 Agent",
    }));
    expect(managed).toContain("Sessions+ 中的托管会话");
  });

  it("directs a card through a resolved bot identity and reports missing identities", async () => {
    const sends: Array<{ recipient: string; card: unknown }> = [];
    const failures: unknown[] = [];
    const sink = directAgentCompletionSink({
      recipientFor: (owner) => owner === "lht" ? "ou_lht" : undefined,
      send: async (recipient, card) => { sends.push({ recipient, card }); },
      failed: (_event, error) => failures.push(error),
    });
    sink(event("direct"));
    sink({ ...event("missing"), owner: "nobody" });
    await Promise.resolve();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.recipient).toBe("ou_lht");
    expect(failures).toHaveLength(1);
  });
});

describe("managedCompletionNotice", () => {
  const now = Date.parse("2026-10-15T12:00:00.000Z");
  const receipt = (turn: string, completedAt: string): RunnerManagedCompletion => ({
    schema: RUNNER_MANAGED_COMPLETION_SCHEMA, provider: "codex", session_id: "thread", turn_id: turn,
    status: "succeeded", completed_at: completedAt,
  });
  function memoryClaim(): ManagedCompletionNoticeClaim & { rows: Map<string, string> } {
    const rows = new Map<string, string>();
    const claim = ((notice, notBefore) => {
      for (const [key, completedAt] of rows) if (completedAt < notBefore) rows.delete(key);
      if (notice.completedAt < notBefore) return false;
      const key = JSON.stringify([notice.owner, notice.device, notice.provider, notice.turnId]);
      if (rows.has(key)) return false;
      rows.set(key, notice.completedAt);
      return true;
    }) as ManagedCompletionNoticeClaim & { rows: Map<string, string> };
    claim.rows = rows;
    return claim;
  }

  it("notifies a receipt once however often reconnects replay it", () => {
    const claim = memoryClaim();
    const live = receipt("turn-live", "2026-10-15T11:59:00Z");
    expect(managedCompletionNotice("lht", "laptop", live, claim, now)).toEqual({
      runId: "turn-live", owner: "lht", surface: "sessions", label: "Sessions+ · laptop · codex 托管 Agent", status: "succeeded",
    });
    for (let replay = 0; replay < 3; replay++) expect(managedCompletionNotice("lht", "laptop", live, claim, now + replay * 60_000)).toBeNull();
    expect(claim.rows.get(JSON.stringify(["lht", "laptop", "codex", "turn-live"]))).toBe("2026-10-15T11:59:00.000Z");
  });

  it("keeps old replayed receipts silent and covers an outage within the window", () => {
    const claim = memoryClaim();
    expect(managedCompletionNotice("lht", "laptop", receipt("months-old", "2026-07-01T00:00:00Z"), claim, now)).toBeNull();
    const duringDeploy = new Date(now - MANAGED_COMPLETION_NOTICE_WINDOW_MS + 60_000).toISOString();
    expect(managedCompletionNotice("lht", "laptop", receipt("deploy", duringDeploy), claim, now)).not.toBeNull();
    expect(claim.rows.size).toBe(1);
  });
});
