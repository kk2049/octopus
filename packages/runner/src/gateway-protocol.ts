/**
 * Wire compatibility declared by a standalone Runner artifact.
 *
 * The build writes this value into the bundle's first line. The Bot validates
 * that marker before an artifact can become active, so independently released
 * client bytes cannot silently outrun the gateway they dial.
 */
export const RUNNER_GATEWAY_PROTOCOL = "runner-gateway/v1" as const;

/** Content-free hint; authority is rechecked through the original recovery scope. */
export const RUNNER_RECOVERY_WAKE = "managed_recovery_wake" as const;

/** Optional, backward-compatible resource telemetry on an authenticated Runner socket. */
export const RUNNER_SYSTEM_STATUS_SCHEMA = "runner-system-status/v1" as const;

export interface RunnerSystemStatus {
  schema: typeof RUNNER_SYSTEM_STATUS_SCHEMA;
  hostname: string;
  cpuPercent: number;
  memoryPercent: number;
  windowMs: number;
  sampledAt: string;
}

/** Reject extra or unbounded fields before device telemetry enters server projections. */
export function runnerSystemStatusFromWire(value: unknown): RunnerSystemStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const hostname = boundedText(row.hostname, 255);
  const cpuPercent = boundedPercent(row.cpuPercent);
  const memoryPercent = boundedPercent(row.memoryPercent);
  const windowMs = row.windowMs;
  const sampledAt = boundedText(row.sampledAt, 64);
  if (
    row.schema !== RUNNER_SYSTEM_STATUS_SCHEMA
    || !hostname
    || cpuPercent === null
    || memoryPercent === null
    || typeof windowMs !== "number"
    || !Number.isInteger(windowMs)
    || windowMs < 1
    // The first sample after a reconnect spans the whole outage (the probe keeps
    // its baseline), so a Head restart made every Runner's status look invalid.
    || windowMs > 30 * 24 * 3600_000
    || !sampledAt
    || !Number.isFinite(Date.parse(sampledAt))
    || Object.keys(row).some((key) => ![
      "schema", "hostname", "cpuPercent", "memoryPercent", "windowMs", "sampledAt",
    ].includes(key))
  ) return null;
  return {
    schema: RUNNER_SYSTEM_STATUS_SCHEMA,
    hostname,
    cpuPercent,
    memoryPercent,
    windowMs,
    sampledAt,
  };
}

function boundedPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : null;
}

/** Only these lease failures prove the requested tool was not dispatched. */
export type LocalAgentBridgeErrorCode = "lease_missing" | "lease_expired" | "policy_changed" | "runner_offline";

export function localAgentBridgeErrorCode(value: unknown): LocalAgentBridgeErrorCode | undefined {
  return value === "lease_missing" || value === "lease_expired" || value === "policy_changed" || value === "runner_offline"
    ? value : undefined;
}

/**
 * Content-free terminal fact emitted by a provider-native turn owned by this
 * Runner. The gateway supplies owner and device from the authenticated socket;
 * neither is accepted from this payload.
 */
export const RUNNER_MANAGED_COMPLETION_SCHEMA = "runner-managed-completion/v1" as const;

export interface RunnerManagedTurnUsage {
  tokens_in?: number;
  tokens_out?: number;
  tokens_cached?: number;
}

export interface RunnerManagedCompletion {
  schema: typeof RUNNER_MANAGED_COMPLETION_SCHEMA;
  provider: "claude" | "codex" | "omp";
  /** Stable logical conversation id; absent only for an older Runner. */
  logical_session_id?: string;
  session_id: string;
  turn_id: string;
  status: "succeeded" | "failed";
  completed_at: string;
  /** Provider-reported numeric accounting only; never transcript or prompt data. */
  usage?: RunnerManagedTurnUsage;
}

/** Reject unbounded or transcript-bearing lookalikes at the wire boundary. */
export function runnerManagedCompletionFromWire(value: unknown): RunnerManagedCompletion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const provider = row.provider;
  const sessionId = boundedText(row.session_id, 512);
  const logicalSessionId = row.logical_session_id === undefined
    ? ""
    : boundedText(row.logical_session_id, 512);
  const turnId = boundedText(row.turn_id, 160);
  const status = row.status;
  const completedAt = boundedText(row.completed_at, 64);
  const usage = managedUsageFromWire(row.usage);
  if (
    row.schema !== RUNNER_MANAGED_COMPLETION_SCHEMA
    || (provider !== "claude" && provider !== "codex" && provider !== "omp")
    || !sessionId
    || (row.logical_session_id !== undefined && !logicalSessionId)
    || !turnId
    || (status !== "succeeded" && status !== "failed")
    || !completedAt
    || !Number.isFinite(Date.parse(completedAt))
    || usage === null
    || Object.keys(row).some((key) => ![
      "schema", "provider", "logical_session_id", "session_id", "turn_id", "status", "completed_at", "usage",
    ].includes(key))
  ) return null;
  return {
    schema: RUNNER_MANAGED_COMPLETION_SCHEMA,
    provider,
    ...(logicalSessionId ? { logical_session_id: logicalSessionId } : {}),
    session_id: sessionId,
    turn_id: turnId,
    status,
    completed_at: completedAt,
    ...(usage ? { usage } : {}),
  };
}

/**
 * Head → Runner: every receiver on that site handled this receipt, so the site
 * need not replay it after reconnecting. Receivers stay idempotent because an
 * acknowledgement can be lost; an older Runner ignores the unknown frame.
 */
export const RUNNER_MANAGED_COMPLETION_ACK = "managed_session_completion_ack" as const;

export interface RunnerManagedCompletionAck {
  provider: RunnerManagedCompletion["provider"];
  turn_id: string;
}

export function runnerManagedCompletionAckFromWire(value: unknown): RunnerManagedCompletionAck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const turnId = boundedText(row.turn_id, 160);
  const provider = row.provider;
  if (row.type !== RUNNER_MANAGED_COMPLETION_ACK || !turnId
    || (provider !== "claude" && provider !== "codex" && provider !== "omp")) return null;
  return { provider, turn_id: turnId };
}

function managedUsageFromWire(value: unknown): RunnerManagedTurnUsage | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["tokens_in", "tokens_out", "tokens_cached"].includes(key))) return null;
  const usage: RunnerManagedTurnUsage = {};
  for (const key of ["tokens_in", "tokens_out", "tokens_cached"] as const) {
    const count = row[key];
    if (count === undefined) continue;
    if (!Number.isSafeInteger(count) || Number(count) < 0) return null;
    usage[key] = Number(count);
  }
  return Object.keys(usage).length ? usage : null;
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length <= max ? text : "";
}

/** Stable first-line label parsed without evaluating candidate JavaScript. */
export const RUNNER_BUNDLE_PROTOCOL_MARKER = "octopus-runner-gateway-protocol" as const;

export function runnerBundleProtocolBanner(): string {
  return `// ${RUNNER_BUNDLE_PROTOCOL_MARKER}: ${RUNNER_GATEWAY_PROTOCOL}`;
}

/** Input evidence is independent of the turn's eventual completion. */
export interface SessionInputReceipt {
  phase: "dispatched" | "local_queued" | "provider_accepted" | "input_observed";
  /** `transcript`: the provider recorded the input in its own session transcript. */
  evidence: "terminal_write" | "local_queue" | "provider_ack" | "native_hook" | "provider_completion" | "launch_identity" | "transcript";
  at: string;
  session_id?: string;
  turn_id?: string;
  transport?: string;
  control_action?: string;
}

/** Validate and copy the bounded wire envelope; never retain extra result fields. */
export function sessionInputReceiptFromWire(value: unknown): SessionInputReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!["dispatched", "local_queued", "provider_accepted", "input_observed"].includes(String(row.phase))
    || !["terminal_write", "local_queue", "provider_ack", "native_hook", "provider_completion", "launch_identity", "transcript"].includes(String(row.evidence))
    || typeof row.at !== "string" || row.at.length > 40 || !Number.isFinite(Date.parse(row.at))) return null;
  const result: SessionInputReceipt = {
    phase: row.phase as SessionInputReceipt["phase"],
    evidence: row.evidence as SessionInputReceipt["evidence"], at: row.at,
  };
  for (const key of ["session_id", "turn_id", "transport", "control_action"] as const) {
    if (row[key] === undefined) continue;
    if (!boundedText(row[key], key === "session_id" || key === "turn_id" ? 512 : 80)) return null;
    result[key] = row[key] as string;
  }
  return result;
}

/** Optional durable receipts on ordinary managed start/append operations. */
export const SESSION_OPERATION_PROTOCOL = "runner-session-operation/v1" as const;
export interface SessionOperationReceipt {
  native_input?: "cli-only/v1";
  protocol: typeof SESSION_OPERATION_PROTOCOL;
  operation_id: string;
  state: "missing" | "running" | "succeeded" | "failed" | "unknown";
  session_id?: string;
  result?: Record<string, unknown>;
  input?: SessionInputReceipt;
  /** Negotiated before a caller relies on append never starting a new turn. */
  live_input?: "steer-only/v1";
}
export function sessionOperationReceiptFromWire(value: unknown, operationId: string): SessionOperationReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as SessionOperationReceipt;
  if (row.protocol !== SESSION_OPERATION_PROTOCOL || row.operation_id !== operationId
    || !["missing", "running", "succeeded", "failed", "unknown"].includes(row.state)
    || (row.session_id !== undefined && (!boundedText(row.session_id, 512)))
    || (row.result !== undefined && (!row.result || typeof row.result !== "object" || Array.isArray(row.result)))) return null;
  const input = row.input === undefined ? undefined : sessionInputReceiptFromWire(row.input);
  if (input === null) return null;
  return { ...row, ...(input ? { input } : {}) };
}
