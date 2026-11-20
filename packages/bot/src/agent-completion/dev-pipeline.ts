import type { DevPipeEvent } from "../devpipe/pipeline.js";
import type { AgentCompletionStatus } from "./relay.js";

/** Keep queueing distinct from the only state that actually waits for a user. */
export function devAgentCompletionStatus(
  event: DevPipeEvent,
  waitingForMergeLock: boolean,
): AgentCompletionStatus {
  if (event.kind === "landed") return "succeeded";
  if (event.kind === "turn_failed") return "failed";
  if (event.kind === "reply" && waitingForMergeLock) return "merge_lock";
  return "suspended";
}
