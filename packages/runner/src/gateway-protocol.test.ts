import { describe, expect, it } from "vitest";
import {
  RUNNER_MANAGED_COMPLETION_SCHEMA,
  RUNNER_SYSTEM_STATUS_SCHEMA,
  runnerManagedCompletionFromWire,
  runnerSystemStatusFromWire,
  sessionInputReceiptFromWire,
  sessionOperationReceiptFromWire,
} from "./gateway-protocol.js";

const valid = {
  schema: RUNNER_MANAGED_COMPLETION_SCHEMA,
  provider: "claude",
  session_id: "session-1",
  turn_id: "turn-1",
  status: "succeeded",
  completed_at: "2026-08-28T12:30:00.000Z",
} as const;

describe("runnerManagedCompletionFromWire", () => {
  it("accepts only the bounded content-free terminal contract", () => {
    expect(runnerManagedCompletionFromWire(valid)).toEqual(valid);
    expect(runnerManagedCompletionFromWire({ ...valid, prompt: "secret" })).toBeNull();
    expect(runnerManagedCompletionFromWire({ ...valid, provider: "other" })).toBeNull();
    expect(runnerManagedCompletionFromWire({ ...valid, completed_at: "not-a-date" })).toBeNull();
    expect(runnerManagedCompletionFromWire({
      ...valid,
      logical_session_id: "logical-session-1",
    })).toEqual({ ...valid, logical_session_id: "logical-session-1" });
    expect(runnerManagedCompletionFromWire({ ...valid, logical_session_id: "" })).toBeNull();
    expect(runnerManagedCompletionFromWire({
      ...valid,
      usage: { tokens_in: 12, tokens_out: 3, tokens_cached: 5 },
    })).toEqual({ ...valid, usage: { tokens_in: 12, tokens_out: 3, tokens_cached: 5 } });
    expect(runnerManagedCompletionFromWire({ ...valid, usage: { tokens_in: -1 } })).toBeNull();
    expect(runnerManagedCompletionFromWire({ ...valid, usage: { prompt: "secret" } })).toBeNull();
  });
});

describe("runnerSystemStatusFromWire", () => {
  const status = {
    schema: RUNNER_SYSTEM_STATUS_SCHEMA,
    hostname: "runner-one",
    cpuPercent: 37,
    memoryPercent: 82,
    windowMs: 15_000,
    sampledAt: "2026-09-09T12:30:00.000Z",
  } as const;

  it("accepts only bounded resource telemetry", () => {
    expect(runnerSystemStatusFromWire(status)).toEqual(status);
    expect(runnerSystemStatusFromWire({ ...status, cpuPercent: 101 })).toBeNull();
    expect(runnerSystemStatusFromWire({ ...status, cpuPercent: "37" })).toBeNull();
    expect(runnerSystemStatusFromWire({ ...status, windowMs: 0 })).toBeNull();
    // A sample taken across a Head restart or network outage still describes the device.
    expect(runnerSystemStatusFromWire({ ...status, windowMs: 6 * 60_000 })).toMatchObject({ windowMs: 6 * 60_000 });
    expect(runnerSystemStatusFromWire({ ...status, windowMs: "15000" })).toBeNull();
    expect(runnerSystemStatusFromWire({ ...status, sampledAt: "not-a-date" })).toBeNull();
    expect(runnerSystemStatusFromWire({ ...status, home: "/secret" })).toBeNull();
  });
});


describe("session input evidence", () => {
  const input = { phase: "provider_accepted", evidence: "provider_ack", at: "2026-09-14T12:00:00.000Z", session_id: "original", turn_id: "turn-1" } as const;
  it("preserves input admission while the legacy receipt still waits for completion", () => {
    expect(sessionOperationReceiptFromWire({ protocol: "runner-session-operation/v1", operation_id: "op-1", state: "running", input }, "op-1"))
      .toMatchObject({ state: "running", input });
    expect(sessionOperationReceiptFromWire({ protocol: "runner-session-operation/v1", operation_id: "op-1", state: "succeeded" }, "op-1"))
      .toMatchObject({ state: "succeeded" });
  });
  it("copies only bounded input evidence and rejects malformed receipts", () => {
    expect(sessionInputReceiptFromWire({ ...input, prompt: "private" })).toEqual(input);
    expect(sessionInputReceiptFromWire({ ...input, at: "tomorrow" })).toBeNull();
    expect(sessionInputReceiptFromWire({ ...input, phase: "completed" })).toBeNull();
    expect(sessionInputReceiptFromWire({ ...input, turn_id: "x".repeat(513) })).toBeNull();
    expect(sessionOperationReceiptFromWire({ protocol: "runner-session-operation/v1", operation_id: "other", state: "running", input }, "op-1")).toBeNull();
  });
});
