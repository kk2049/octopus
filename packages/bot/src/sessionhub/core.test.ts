import { describe, expect, it } from "vitest";
import { BOT_HOST_DEVICE, dedupeSessions, normaliseSession } from "./core.js";

describe("normaliseSession", () => {
  it("preserves a provider-owned display title", () => {
    expect(normaliseSession(
      { device: "laptop", source: "omp", id: "session-1", title: "调研 dsh 生态" },
      "alice",
      "laptop",
    ).title).toBe("调研 dsh 生态");
  });

  it("accepts only a one-letter Codex account marker", () => {
    expect(normaliseSession(
      { device: "laptop", source: "codex", id: "session-1", account_label: "b" },
      "alice",
      "laptop",
    ).accountLabel).toBe("b");
    expect(normaliseSession(
      { device: "laptop", source: "codex", id: "session-2", account_label: "private-slot" },
      "alice",
      "laptop",
    ).accountLabel).toBeUndefined();
    expect(normaliseSession(
      { device: "laptop", source: "claude", id: "session-3", account_label: "a" },
      "alice",
      "laptop",
    ).accountLabel).toBeUndefined();
  });

  it("mints one same-device parent resource and makes parent-owned Codex children read-only", () => {
    const child = normaliseSession({
      device: "laptop",
      source: "codex",
      id: "thread-child",
      input_mode: "parent_owned",
      parent_session_id: "thread-parent",
    }, "alice", "laptop");
    const parent = normaliseSession({
      device: "laptop",
      source: "codex",
      id: "thread-parent",
    }, "alice", "laptop");
    expect(child).toMatchObject({
      inputMode: "parent_owned",
      parentResourceId: parent.resourceId,
      resumable: false,
    });
    expect(normaliseSession({
      device: "laptop",
      source: "codex",
      id: "thread-child",
      input_mode: "parent_owned",
      parent_session_id: "thr_parent_2",
    }, "alice", "laptop")).toHaveProperty("inputMode", "parent_owned");

    for (const raw of [
      { source: "claude", input_mode: "parent_owned", parent_session_id: "thread-parent" },
      { source: "codex", input_mode: "parent_owned", parent_session_id: "../parent" },
      { source: "codex", input_mode: "parent_owned", parent_session_id: "thread-child" },
    ]) {
      expect(normaliseSession({ device: "laptop", id: "thread-child", ...raw }, "alice", "laptop"))
        .not.toHaveProperty("inputMode");
    }
  });

  it("keeps lineage separate from input ownership and binds Claude parents to the same device", () => {
    const parent = normaliseSession({ source: "claude", id: "parent" }, "alice", "laptop");
    expect(normaliseSession({
      source: "claude", id: "agent-worker", is_subagent: true,
      parent_session_id: "parent", input_mode: "parent_owned",
    }, "alice", "laptop")).toMatchObject({ parentResourceId: parent.resourceId, inputMode: "parent_owned", resumable: false });
    const legacyCodex = normaliseSession({
      source: "codex", id: "child", is_subagent: true, parent_session_id: "parent",
    }, "alice", "laptop");
    expect(legacyCodex.parentResourceId).toBeTruthy();
    expect(legacyCodex).not.toHaveProperty("inputMode");
    expect(legacyCodex.resumable).toBe(true);
  });

  it("carries explicit background origin without affecting resource identity or resumability", () => {
    const plain = normaliseSession({ source: "codex", id: "run" }, "alice", "laptop");
    const background = normaliseSession({ source: "codex", id: "run", execution_mode: "exec" }, "alice", "laptop");
    expect(background).toMatchObject({ resourceId: plain.resourceId, resumable: plain.resumable, executionMode: "exec" });
  });

  it("falls back to legacy last activity before session start time", () => {
    expect(normaliseSession({
      device: "laptop",
      source: "omp",
      id: "legacy-session",
      started_at: "2026-08-25T08:00:00Z",
      last_activity: "2026-08-25T10:05:00Z",
    }, "alice", "laptop")).toMatchObject({
      sortActivity: "2026-08-25T10:05:00Z",
    });
  });

  it("keeps repeated OMP idle observations out of stable completion activity", () => {
    const normalizedAt = (observedAt: string) => normaliseSession({
      device: "laptop",
      source: "omp",
      id: "session-4",
      last_activity: "2026-08-25T10:04:00Z",
      sort_activity: "2026-08-25T10:00:00Z",
      completed_at: "2026-08-25T10:03:00Z",
      activity: {
        state: "tool",
        tool: "Bash",
        observed_at: "2026-08-25T10:04:00Z",
      },
      runtime: {
        process_state: "alive",
        turn_state: "idle",
        observed_at: observedAt,
        event: "OmpTerminalObserved",
      },
    }, "alice", "laptop");

    for (const observedAt of ["2026-08-25T10:05:00Z", "2026-08-25T10:06:00Z"]) {
      expect(normalizedAt(observedAt)).toMatchObject({
        lastActivity: "2026-08-25T10:04:00Z",
        sortActivity: "2026-08-25T10:03:00Z",
        completedAt: "2026-08-25T10:03:00Z",
        status: "idle",
        activity: { state: "idle", observed_at: observedAt },
      });
    }
  });

  it("lets newer scanner activity win over an older settled runtime observation", () => {
    expect(normaliseSession({
      device: "laptop",
      source: "omp",
      id: "session-newer-activity",
      activity: {
        state: "tool",
        tool: "Bash",
        observed_at: "2026-08-25T10:06:00Z",
      },
      runtime: {
        process_state: "alive",
        turn_state: "idle",
        observed_at: "2026-08-25T10:05:00Z",
        event: "OmpTerminalObserved",
      },
    }, "alice", "laptop", undefined, Date.parse("2026-08-25T10:06:30Z"))).toMatchObject({
      status: "live",
      activity: { state: "tool", tool: "Bash" },
    });
  });

  it("is live only with fresh evidence: stale activity and unproven turn states are idle", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    const at = (agoMs: number) => new Date(now - agoMs).toISOString();
    const status = (row: Record<string, unknown>) => normaliseSession({ device: "aliyun", source: "claude", id: "s", ...row },
      "alice", "aliyun", undefined, now).status;
    // A cold-read Claude sub-agent from September, stopped mid-tool, with no runtime.
    expect(status({ activity: { state: "tool", tool: "Task", observed_at: "2026-09-03T08:00:00Z" } })).toBe("idle");
    expect(status({ activity: { state: "tool", tool: "Bash", observed_at: at(5 * 60_000) } })).toBe("live");
    expect(status({ activity: { state: "thinking", observed_at: at(30_000) } })).toBe("live");
    expect(status({ activity: { state: "thinking", observed_at: at(3 * 60_000) } })).toBe("idle");
    expect(status({ activity: { state: "unknown", observed_at: at(1_000) } })).toBe("idle");
    // Old Runners send no observed_at; the last recorded write stands in.
    expect(status({ last_activity: "2026-09-03T08:00:00Z", activity: { state: "responding" } })).toBe("idle");
    // A Runner-verified process stays live through a long tool; hook-only state decays.
    expect(status({ runtime: { process_state: "alive", turn_state: "working", observed_at: at(40 * 60_000) } })).toBe("live");
    expect(status({ runtime: { process_state: "unknown", turn_state: "working", observed_at: at(40 * 60_000) } })).toBe("idle");
    expect(status({ runtime: { process_state: "unknown", turn_state: "working", observed_at: at(30_000) } })).toBe("live");
    expect(status({ runtime: { process_state: "exited", turn_state: "working", observed_at: at(1_000) } })).toBe("idle");
  });

  it("does not invent completions from non-terminal runtime observations", () => {
    const observations = [
      { process_state: "alive", turn_state: "idle", event: "SessionStart" },
      { process_state: "alive", turn_state: "needs_input", event: "PermissionRequest" },
      { process_state: "exited", turn_state: "idle", event: "SessionGone" },
    ];

    for (const runtime of observations) {
      expect(normaliseSession({
        device: "laptop",
        source: "claude",
        id: "session-5",
        sort_activity: "2026-08-25T10:00:00Z",
        runtime: {
          ...runtime,
          observed_at: "2026-08-25T10:05:00Z",
        },
      }, "alice", "laptop")).toMatchObject({
        sortActivity: "2026-08-25T10:00:00Z",
        completedAt: undefined,
      });
    }
  });

  it.each(["Stop", "SessionEnd"])("accepts explicit %s events as runtime completions", (event) => {
    expect(normaliseSession({
      device: "laptop",
      source: "claude",
      id: "session-6",
      sort_activity: "2026-08-25T10:00:00Z",
      completed_at: "2026-08-25T10:03:00Z",
      runtime: {
        process_state: event === "SessionEnd" ? "unknown" : "alive",
        turn_state: "idle",
        observed_at: "2026-08-25T10:05:00Z",
        event,
      },
    }, "alice", "laptop")).toMatchObject({
      sortActivity: "2026-08-25T10:05:00Z",
      completedAt: "2026-08-25T10:05:00Z",
    });
  });
});

describe("dedupeSessions", () => {
  it("always prefers a real device over bot-host for the same CLI session", () => {
    const real = normaliseSession(
      { device: "laptop", source: "claude", id: "same-session" },
      "alice",
      "laptop",
    );
    const local = normaliseSession(
      { device: BOT_HOST_DEVICE, source: "claude", id: "same-session" },
      "alice",
      BOT_HOST_DEVICE,
    );

    for (const entries of [[real, local], [local, real]]) {
      const deduped = dedupeSessions(entries);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]).toMatchObject({
        deviceId: "laptop",
        resourceId: real.resourceId,
      });
    }
  });
});
