import { describe, expect, it } from "vitest";
import {
  RUNNER_SESSION_PROJECTION_SCHEMA,
  runnerSessionProjectionCommandFromWire,
  runnerSessionProjectionFromWire,
  sessionRosterProjectionFromResult,
  sessionTranscriptProjectionFromResult,
} from "./session-projection.js";

const EPOCH = "epoch-12345678";
describe("runner session projection protocol", () => {
  it("whitelists roster fields and round-trips one full snapshot", () => {
    const projection = sessionRosterProjectionFromResult({
      home: "/home/alice",
      total_found: 1,
      sessions: [{
        id: "s-1",
        source: "codex",
        path: "/home/alice/.codex/sessions/s-1.jsonl",
        cwd: "/home/alice/private",
        cwd_display: "~/private",
        last_activity: "2026-08-23T00:03:00.000Z",
        sort_activity: "2026-08-23T00:02:00.000Z",
        completed_at: "2026-08-23T00:01:00.000Z",
        started_at: "2026-08-23T00:00:00.000Z",
        title: "One",
        input_mode: "parent_owned",
        is_subagent: true,
        parent_session_id: "thread-parent",
        runtime: { state: "running" },
        hostile: "drop-me",
      }],
    }, EPOCH, 1, "2026-08-23T00:00:00.000Z");

    expect(projection).toEqual({
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "roster_full",
      epoch: EPOCH,
      sequence: 1,
      observed_at: "2026-08-23T00:00:00.000Z",
      total_found: 1,
      sessions: [{
        id: "s-1",
        source: "codex",
        cwd_display: "~/private",
        last_activity: "2026-08-23T00:03:00.000Z",
        sort_activity: "2026-08-23T00:02:00.000Z",
        completed_at: "2026-08-23T00:01:00.000Z",
        started_at: "2026-08-23T00:00:00.000Z",
        title: "One",
        input_mode: "parent_owned",
        is_subagent: true,
        parent_session_id: "thread-parent",
        runtime: { state: "running" },
      }],
    });
    expect(runnerSessionProjectionFromWire(projection)).toEqual(projection);
    expect(JSON.stringify(projection)).not.toContain("/home/alice");
    expect(JSON.stringify(projection)).not.toContain("hostile");
  });

  it("round-trips Claude and legacy Codex lineage with their distinct input capabilities", () => {
    const projection = sessionRosterProjectionFromResult({ sessions: [
      { source: "claude", id: "agent-worker", is_subagent: true, parent_session_id: "parent", input_mode: "parent_owned" },
      { source: "codex", id: "legacy-child", is_subagent: true, parent_session_id: "parent" },
    ] }, EPOCH, 2)!;
    expect(projection.sessions[0]).toMatchObject({ input_mode: "parent_owned", parent_session_id: "parent", is_subagent: true });
    expect(projection.sessions[1]).toMatchObject({ parent_session_id: "parent", is_subagent: true });
    expect(projection.sessions[1]).not.toHaveProperty("input_mode");
    expect(runnerSessionProjectionFromWire(projection)).toEqual(projection);
  });

  it("retains only Codex's explicit exec mode for background grouping", () => {
    const projection = sessionRosterProjectionFromResult({ sessions: [
      { source: "codex", id: "run", execution_mode: "exec" },
      { source: "claude", id: "session", execution_mode: "exec" },
      { source: "codex", id: "ordinary", execution_mode: "unknown" },
    ] }, EPOCH, 3)!;
    expect(projection.sessions[0].execution_mode).toBe("exec");
    expect(projection.sessions[1]).not.toHaveProperty("execution_mode");
    expect(projection.sessions[2]).not.toHaveProperty("execution_mode");
    expect(runnerSessionProjectionFromWire(projection)).toEqual(projection);
  });

  it("carries one whole window — chats, automated runs and children — and nothing larger", () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ source: "codex", id: `s${index}` }));
    const whole = sessionRosterProjectionFromResult({ sessions: rows(600), total_found: 9_000 }, EPOCH, 4)!;
    expect(whole.sessions).toHaveLength(600);
    expect(runnerSessionProjectionFromWire(whole)).toEqual(whole);
    expect(sessionRosterProjectionFromResult({ sessions: rows(601) }, EPOCH, 5)!.sessions).toHaveLength(600);
    expect(runnerSessionProjectionFromWire({ ...whole, sessions: rows(601), total_found: 9_000 })).toBeNull();
  });

  it("drops incomplete or malformed parent ownership claims", () => {
    const rows = [
      { id: "child-1", source: "codex", input_mode: "parent_owned" },
      { id: "child-2", source: "codex", parent_session_id: "parent-2" },
      {
        id: "child-3",
        source: "codex",
        input_mode: "parent_owned",
        parent_session_id: "../private/parent",
      },
    ];
    const projection = sessionRosterProjectionFromResult({ sessions: rows }, EPOCH, 2);
    for (const row of projection?.sessions ?? []) {
      expect(row).not.toHaveProperty("input_mode");
      expect(row).not.toHaveProperty("parent_session_id");
    }
  });

  it("removes scanner paths from transcript windows and rejects them on ingress", () => {
    const projection = sessionTranscriptProjectionFromResult({
      rich: true,
      offset: 4,
      total_messages: 5,
      meta: {
        id: "s-1",
        source: "claude",
        path: "/secret/log",
        cwd: "/secret",
        input_mode: "parent_owned",
        parent_session_id: "thread-parent",
        activity: { state: "idle" },
      },
      messages: [{ role: "assistant", blocks: [{ type: "text", text: "done" }] }],
    }, "claude", "s-1", EPOCH, 2, "2026-08-23T00:00:01.000Z");

    expect(projection?.transcript.meta).toEqual({ id: "s-1", source: "claude", activity: { state: "idle" } });
    expect(runnerSessionProjectionFromWire(projection)).toEqual(projection);
    expect(runnerSessionProjectionFromWire({
      ...projection,
      transcript: { ...projection?.transcript, meta: { path: "/forged" } },
    })).toBeNull();
  });

  it("validates bounded demand commands", () => {
    expect(runnerSessionProjectionCommandFromWire({
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "transcript_subscribe",
      source: "omp",
      session_id: "omp-1",
      max_messages: 200,
    })).toMatchObject({ kind: "transcript_subscribe", source: "omp", max_messages: 200 });
    expect(runnerSessionProjectionCommandFromWire({
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "transcript_subscribe",
      source: "omp",
      session_id: "omp-1",
      max_messages: 501,
    })).toBeNull();
    expect(runnerSessionProjectionCommandFromWire({
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "transcript_unsubscribe",
      source: "unknown",
      session_id: "s-1",
    })).toBeNull();
  });
});

it("accepts checked frames only with a preceding content sequence and drops extra fields", () => {
  const frame = { schema: RUNNER_SESSION_PROJECTION_SCHEMA, kind: "transcript_checked", epoch: EPOCH,
    sequence: 2, observed_at: "2026-09-17T00:00:00Z", source: "codex", session_id: "one", content_sequence: 1 };
  expect(runnerSessionProjectionFromWire({ ...frame, transcript: { private: true } })).toEqual(frame);
  for (const content_sequence of [0, 2, 3, 1.5, "invalid"]) expect(runnerSessionProjectionFromWire({ ...frame, content_sequence })).toBeNull();
});
