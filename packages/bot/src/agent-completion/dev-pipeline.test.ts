import { describe, expect, it } from "vitest";
import type { DevPipeEvent } from "../devpipe/pipeline.js";
import { devAgentCompletionStatus } from "./dev-pipeline.js";

const ticket = { id: 433 } as DevPipeEvent["ticket"];

describe("devAgentCompletionStatus", () => {
  it("does not present a merge-lock waiter as waiting for the user", () => {
    const reply: DevPipeEvent = { kind: "reply", ticket, text: "等待合并锁" };
    expect(devAgentCompletionStatus(reply, true)).toBe("merge_lock");
    expect(devAgentCompletionStatus(reply, false)).toBe("suspended");
  });

  it("keeps terminal landing and failure states unchanged", () => {
    expect(devAgentCompletionStatus({ kind: "landed", ticket }, false)).toBe("succeeded");
    expect(devAgentCompletionStatus({ kind: "turn_failed", ticket, reason: "boom" }, true)).toBe("failed");
  });
});
