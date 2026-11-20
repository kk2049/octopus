/** Pure boundary conversions for the one durable SessionOperation record. */
import { sessionInputReceiptFromWire, type SessionInputReceipt as RunnerInput } from "@claude-bot/runner/gateway-protocol";
import type { SessionInputReceipt } from "@claude-bot/agent-sessions-contract";
import type { SessionOperationRow } from "../store/store.js";

export interface SessionReceiptTarget { owner: string; resourceId?: string }

export function receiptTargetOf(row: SessionOperationRow): SessionReceiptTarget | null {
  if (!row.runner_receipt_target) return null;
  try {
    const value = JSON.parse(row.runner_receipt_target) as SessionReceiptTarget;
    if (!value || typeof value.owner !== "string" || !value.owner || value.owner.length > 256) return null;
    if (value.owner !== row.owner && (typeof value.resourceId !== "string" || !/^agent-runtime:[0-9a-f]{32}$/.test(value.resourceId))) return null;
    return { owner: value.owner, ...(value.resourceId ? { resourceId: value.resourceId } : {}) };
  } catch { return null; }
}

export function storedInputOf(row: Pick<SessionOperationRow, "input_receipt">): RunnerInput | undefined {
  try { return sessionInputReceiptFromWire(JSON.parse(row.input_receipt ?? "null")) ?? undefined; }
  catch { return undefined; }
}

export function inputForView(input: RunnerInput | undefined): SessionInputReceipt | undefined {
  if (!input) return undefined;
  return { phase: input.phase, evidence: input.evidence, at: input.at,
    ...(input.session_id ? { sessionId: input.session_id } : {}),
    ...(input.turn_id ? { turnId: input.turn_id } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.control_action ? { controlAction: input.control_action } : {}) };
}
