import { OPEN_SHARED_SESSION_ACTION } from "@claude-bot/agent-sessions-contract";
/**
 * The whole of Session Plus's protocol knowledge, in one file.
 *
 * ── What an adapter is for ──────────────────────────────────────────────────
 *
 * The sessions modules are written against `agent-sessions/v1`: a typed port
 * with named methods. This App's transport is an Agent View client that can do
 * exactly one thing — `propose(action, params)` over the channel the trusted
 * shell handed in. This file is the join, and it is the ONLY place in this
 * package that knows an action id exists.
 *
 * That is why it is a separate module rather than a few lines in `App.tsx`: the
 * App is a composition root, and "which string does a transcript read send" is
 * not composition. Keeping it here means a reviewer can read the entire
 * protocol surface of this App in one screen, and the architecture test can
 * check that nothing else in the package names one.
 *
 * ── What it must never add ──────────────────────────────────────────────────
 *
 * A field claiming an identity. Owner, app, scope, instance and approval belong
 * to the trusted Host, which rebinds all of them from its own record; this side
 * could not supply them if it tried, and every parameter below is a value the
 * reader typed or a session id the projection already contained.
 */

import type { AgentViewClient, AgentViewOperation, ProposalReply } from "@claude-bot/agent-view-react";
import {
  SESSION_OPERATION_FIELDS,
  createSessionCommands,
  type SessionsPort,
  type SessionOperation,
  type SessionInputReceipt,
  type SessionsReply,
  type SessionsSnapshot,
} from "@claude-bot/agent-sessions-contract";

/**
 * The generic transport may grow fields for another App. Copy only the
 * agent-sessions/v1 operation projection so a future owner/grant/debug field
 * cannot cross this adapter merely because TypeScript permits extra properties.
 */
function sessionOperationOf(source: AgentViewOperation): SessionOperation {
  const out: SessionOperation = {};
  for (const key of SESSION_OPERATION_FIELDS) {
    const value = source[key];
    if (key === "input") {
      if (!value || typeof value !== "object") continue;
      const input = value as Record<string, unknown>;
      const receipt: Record<string, string> = {};
      for (const field of ["phase", "evidence", "at", "sessionId", "turnId", "transport", "controlAction"]) {
        if (typeof input[field] === "string") receipt[field] = input[field] as string;
      }
      if (receipt.phase && receipt.evidence && receipt.at) out.input = receipt as unknown as SessionInputReceipt;
    } else if (key === "recovery") {
      if (!value || typeof value !== "object") continue;
      const { state, since, retry_at } = value as Record<string, unknown>;
      if ((state === "reconnecting" || state === "waiting_resource")
        && typeof since === "string" && (retry_at === null || typeof retry_at === "string")) {
        out.recovery = { state, since, retry_at };
      }
    } else if (typeof value === "string") out[key] = value;
  }
  return out;
}

export interface SessionsAdapterOptions {
  /** The transport, for the snapshot and the subscription. */
  client: AgentViewClient;
  /**
   * The PROVIDER's proposal function, not the client's.
   *
   * They differ in one way that matters: the provider's records the Host's
   * bounded refusal and clears it on the next attempt. Calling the client
   * directly would send the same frame and silently drop the sentence the Host
   * wrote for the reader.
   */
  propose(action: string, params?: Record<string, string>): Promise<ProposalReply>;
  /** The last bounded refusal, and a way to clear it — the provider's state. */
  refusal: { text: string; clear(): void };
}

/**
 * Present an Agent View client as an `agent-sessions/v1` port.
 *
 * The snapshot is derived rather than stored: the client already publishes a
 * fresh object per change, so a cached copy here would be a second version of
 * the same state that could lag by exactly one frame.
 */
export function createSessionsAdapter(options: SessionsAdapterOptions): SessionsPort {
  const { client } = options;
  const reply = (answer: ProposalReply): SessionsReply => ({
    ok: answer.ok,
    code: answer.code,
    result: answer.result,
    message: answer.message,
  });
  const propose = (action: string, params: Record<string, string>): Promise<SessionsReply> =>
    options.propose(action, params).then(reply);

  let cachedSource: ReturnType<AgentViewClient["snapshot"]> | null = null;
  let cached: SessionsSnapshot | null = null;

  return {
    openShare: (shareId) => propose(OPEN_SHARED_SESSION_ACTION, { share_id: shareId }),
    snapshot() {
      const source = client.snapshot();
      const refusal = options.refusal.text;
      // Identity-stable while nothing changed: `useSyncExternalStore` compares
      // snapshots by identity, and a new object on every call would re-render
      // the whole workspace on every tick.
      if (!cached || source !== cachedSource || refusal !== cached.refusal) {
        cachedSource = source;
        cached = {
          phase: source.phase,
          projection: source.projection,
          operations: source.operations.map(sessionOperationOf),
          refusal,
        };
      }
      return cached;
    },
    subscribe: client.subscribe,
    clearRefusal: () => options.refusal.clear(),

    ...createSessionCommands(propose),
  };
}
