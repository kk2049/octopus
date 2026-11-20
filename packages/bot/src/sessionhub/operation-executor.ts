/** Direct Session Hub adapter for the shared durable operation coordinator. */

import { sessionOperationReceiptFromWire } from "@claude-bot/runner/gateway-protocol";
import {
  type OperationExecutor,
  type OperationIntent,
  type OperationOutcome,
  type OperationTicket,
} from "./operations.js";
import {
  appendFingerprint,
  type AppendTicket,
  type HubPrincipal,
  type SessionHubService,
} from "./service.js";
import type { Source as ScanSource } from "@claude-bot/plugin-sessions/scan";
import { SESSION_CLI_KINDS } from "./core.js";

export interface HubOperationInput {
  owner: string;
  device: string;
  sessionId: string;
  prompt?: string;
  source?: string;
  operation: "append_session" | "resume_session" | "takeover_session" | "fallback_session" | "interrupt_session";
}

interface HubOperationTicket extends OperationTicket {
  append: AppendTicket;
}

export class SessionHubOperationExecutor implements OperationExecutor<HubOperationInput, HubOperationTicket> {
  constructor(private readonly hub: SessionHubService) {}

  describe(
    _principal: HubPrincipal,
    input: HubOperationInput,
  ): { ok: true; intent: OperationIntent } | { ok: false; status: number; error: string } {
    const owner = String(input?.owner ?? "").trim();
    const device = String(input?.device ?? "").trim();
    const sessionId = String(input?.sessionId ?? "").trim();
    const prompt = String(input?.prompt ?? "");
    const interrupt = input.operation === "interrupt_session";
    if (!owner || !device || !sessionId || (!interrupt && !prompt.trim())) {
      return { ok: false, status: 400, error: interrupt
        ? "owner, device and sessionId are required"
        : "owner, device, sessionId and prompt are required" };
    }
    const cliKind = SESSION_CLI_KINDS.includes(input.source as ScanSource)
      ? input.source as ScanSource
      : "claude";
    if (input.operation === "fallback_session" && cliKind !== "codex") {
      return { ok: false, status: 400, error: "备用账号切换只支持 Codex 会话" };
    }
    const operation = input.operation === "resume_session"
      ? "resume_session"
      : input.operation === "takeover_session"
        ? "takeover_session"
        : input.operation === "fallback_session"
          ? "fallback_session"
          : input.operation === "interrupt_session" ? "interrupt_session" : "append_session";
    return {
      ok: true,
      intent: {
        owner,
        device,
        cliKind,
        sessionId,
        operation,
        fingerprint: appendFingerprint(operation, input.source, prompt),
        resourceId: this.hub.resourceId({ owner, device, cliKind, sessionId }),
      },
    };
  }

  prepare(
    principal: HubPrincipal,
    input: HubOperationInput,
    operationId: string,
  ): { ok: true; ticket: HubOperationTicket } | { ok: false; status: number; error: string; pendingCallId?: string } {
    const described = this.describe(principal, input);
    if (!described.ok) return described;
    const prepared = this.hub.prepareAppend(principal, input);
    if (!prepared.ok) return prepared;
    prepared.ticket.args = { ...prepared.ticket.args, operation_id: operationId, input_receipt: true };
    return { ok: true, ticket: { ...described.intent, runnerOperationId: operationId,
      contextId: prepared.ticket.contextId, append: prepared.ticket } };
  }

  async run(ticket: HubOperationTicket, hooks?: Parameters<SessionHubService["runAppend"]>[1]): Promise<OperationOutcome> {
    const outcome = await this.hub.runAppend(ticket.append, hooks);
    if (!outcome.ok) return outcome;
    const interpreted = this.interpret(outcome.result, ticket);
    return interpreted.ok ? { ...interpreted, durationMs: outcome.durationMs } : interpreted;
  }

  interpret(result: unknown, intent: OperationIntent): OperationOutcome {
    const row = record(result);
    if (intent.runnerOperationId && row.protocol !== undefined) {
      const receipt = sessionOperationReceiptFromWire(result, intent.runnerOperationId);
      return receipt ? { ok: true, result, receipt } : { ok: false, status: 504, indeterminate: true,
        error: "Runner 返回了不属于这次提交的操作回执；不会自动重发。" };
    }
    if (row.ok === false) {
      const unknown = row.code === "unknown";
      return {
        ok: false,
        status: unknown ? 504 : 502,
        error: typeof row.error === "string" ? row.error : "CLI 执行失败",
        ...(unknown ? { indeterminate: true } : {}),
      };
    }
    return {
      ok: true,
      result,
      ...(typeof row.new_session_id === "string" ? { newSessionId: row.new_session_id } : {}),
    };
  }

  discard(ticket: HubOperationTicket): void {
    this.hub.discardAppend(ticket.append);
  }

  releasePending(pendingCallId: string): void {
    this.hub.releasePendingLease(pendingCallId);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
