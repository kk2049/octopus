/** Shared lifecycle vocabulary. Domain adapters retain their authority and journals.
 * No prompt, credential, transport or provider process belongs in this contract.
 */
export type ManagedExecutionSource = "ticket" | "session" | "research" | "mcp-session"
  | "app-agent" | "discussion" | "knowledge-chat" | "research-canvas";
export type ExecutionDesired = "running" | "paused" | "cancelled";
export type ExecutionObserved = "preparing" | "running" | "reconnecting" | "waiting_resource"
  | "waiting_approval" | "completed" | "failed" | "unknown";
export type ExecutionFailure = "transport_unavailable" | "authorization_revoked" | "workspace_missing"
  | "protocol_incompatible" | "provider_capacity" | "effect_unknown" | "internal";
export type ResumeOwner = "head" | "runner" | "observed" | "parent";

export interface ManagedExecution {
  id: string;
  owner: string;
  source: ManagedExecutionSource;
  desired: ExecutionDesired;
  observed: ExecutionObserved;
  resumeOwner: ResumeOwner;
  operationId?: string;
  sessionId?: string;
  runtimeDevice?: string;
  executionDevice?: string;
  workspaceId?: string;
  dependency?: string;
  unavailableSince?: string;
  nextRetryAt?: string;
  failure?: ExecutionFailure;
}

export type RecoveryAction = "wait" | "refuse" | "query_original" | "dispatch_prepared" | "resume_acknowledged" | "none";
export interface RecoveryEvidence {
  desired: ExecutionDesired;
  resumeOwner: ResumeOwner;
  coordinator: "head" | "runner";
  authorized: boolean;
  dependencyAvailable: boolean;
  /** Positive durable evidence, never an inference from a missing response. */
  dispatch: "not_sent" | "acknowledged_interrupted" | "sent" | "uncertain" | "settled";
}

export function recoveryAction(evidence: RecoveryEvidence): RecoveryAction {
  if (evidence.desired !== "running" || evidence.dispatch === "settled") return "none";
  if (evidence.resumeOwner === "observed" || evidence.resumeOwner === "parent") return "none";
  if (!evidence.authorized) return "refuse";
  if (!evidence.dependencyAvailable) return "wait";
  if (evidence.dispatch === "sent" || evidence.dispatch === "uncertain") return "query_original";
  if (evidence.resumeOwner !== evidence.coordinator) return "query_original";
  if (evidence.dispatch === "not_sent") return "dispatch_prepared";
  return evidence.coordinator === "runner" ? "resume_acknowledged" : "query_original";
}

export const DEPENDENCY_GRACE_MS = 60_000;
export const DEPENDENCY_RETRY_MS = 5_000;
export const DEPENDENCY_WAITING_RETRY_MS = 30_000;

export function dependencyWait(since: number, now: number, policy: {
  graceMs?: number; retryMs?: number; waitingRetryMs?: number;
} = {}): { state: "reconnecting" | "waiting_resource"; delayMs: number } {
  const remaining = since + (policy.graceMs ?? DEPENDENCY_GRACE_MS) - now;
  return remaining > 0
    ? { state: "reconnecting", delayMs: Math.max(1, Math.min(policy.retryMs ?? DEPENDENCY_RETRY_MS, remaining)) }
    : { state: "waiting_resource", delayMs: Math.max(1, policy.waitingRetryMs ?? DEPENDENCY_WAITING_RETRY_MS) };
}

/** Only trusted transport adapters construct this error. Message text is never a retry policy. */
export class ManagedDependencyUnavailable extends Error {
  readonly code = "transport_unavailable";
  constructor(message: string) { super(message); this.name = "ManagedDependencyUnavailable"; }
}
export function isManagedDependencyUnavailable(error: unknown): error is ManagedDependencyUnavailable {
  return error instanceof ManagedDependencyUnavailable;
}
