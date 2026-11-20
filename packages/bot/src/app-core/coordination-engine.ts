import { createHash } from "node:crypto";
import type { AppRuntimeClient, RuntimeJson } from "@claude-bot/app-runtime";
import { canonicalJson, type StateClient } from "@claude-bot/app-state";
import {
  advanceCanonicalProjection,
  loadCanonicalProjection,
  readAllStateEvents,
  renderViewerProjection,
  type CanonicalProjection,
} from "./projection-cache.js";

/** Event names below this prefix belong to trusted platform writers. */
export const SYSTEM_EVENT_PREFIX = "sys_";

/**
 * The one system event type this build writes: a durable message for an App
 * agent, written by the trusted agent plane and by nothing else.
 *
 * It lives in the App's own State stream because inbox messages must survive a
 * restart, be ordered and be idempotent, and that store already provides all
 * three. An App handler can never emit it: see the `sys_` refusal in `dispatch`.
 */
export const AGENT_INBOX_EVENT = "sys_agent_inbox";

/**
 * One queued message's ceiling, in UTF-16 code units, for every App.
 *
 * `app-state` refuses an event whose canonical JSON exceeds 64 KiB; even a
 * worst-case escaped body (6 bytes per unit) stays under that at this size, so
 * the State door never has to refuse an inbox write the plane accepted.
 */
export const AGENT_INBOX_MAX_CHARS = 8_192;

/** The bounded text an inbox write stores; empty means "refuse, nothing to queue". */
export function agentInboxText(text: unknown): string {
  return String(text ?? "").slice(0, AGENT_INBOX_MAX_CHARS).trim();
}

export interface AgentInboxMessage {
  seq: number;
  text: string;
  from: string;
  at: string;
}

export type AgentInboxAppendResult =
  | { ok: true; revision: number; duplicate: boolean }
  | { ok: false; message: string };

export interface CoordinationRefusal {
  ok: false;
  code: string;
  message: string;
}

export type CommitAuthorization<TRefusal extends CoordinationRefusal> =
  | { ok: true; actor: string }
  | { ok: false; refusal: TRefusal };

export interface AppProjectionInput {
  streamId: string;
  backendCodeDigest: string;
  canonical?: CanonicalProjection;
  context?: Record<string, RuntimeJson>;
}

export interface AppProjection {
  canonical: CanonicalProjection;
  projection: RuntimeJson;
}

export interface AppDispatchInput<TRefusal extends CoordinationRefusal> {
  streamId: string;
  backendCodeDigest: string;
  contractDigest: string;
  dispatchId: string;
  action: string;
  params: Record<string, RuntimeJson>;
  context: (input: { state: RuntimeJson; now: string }) => Record<string, RuntimeJson>;
  /** Re-ask composition policy after State and Runtime awaits, immediately before commit. */
  authorizeCommit: () => CommitAuthorization<TRefusal> | Promise<CommitAuthorization<TRefusal>>;
  /** Pure human actions may retry one revision conflict; agent turns never replay. */
  retryConflict?: boolean;
  /** Trusted composition opt-in; no arbitrary stream selector is accepted. */
  historyAfter?: number;
}

export interface AppDispatchSuccess {
  ok: true;
  result: RuntimeJson | null;
  canonical: CanonicalProjection;
}

export type CoordinationEngineRefusal =
  | { ok: false; code: "action_rejected"; message: string }
  | { ok: false; code: "state_conflict"; message: string };

/**
 * The policy-free State/Runtime engine shared by every trusted App composition.
 *
 * Callers own admission, handles, action declarations, membership and viewer
 * evidence. This engine owns the invariant mechanics: snapshot-plus-tail
 * projection, sandbox invocation, reserved-event rejection, evidence stamping,
 * one conflict retry, immutable commit and incremental re-projection.
 */
export class AppCoordinationEngine {
  private readonly now: () => number;
  private readonly streamQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: { state: StateClient; runtime: AppRuntimeClient; now?: () => number },
  ) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Serialise everything one coordinator writes to one stream.
   *
   * Two tabs of the same person pressing two buttons is the ordinary case, and
   * `app-state` answers a stale `expectedRevision` with a conflict rather than a
   * merge. Queueing here turns that from a user-visible retry into an ordering,
   * and an inbox append queues behind the same turn as a button. The tail is
   * deleted when it is still this turn's, so a long-lived process does not keep
   * one resolved promise per stream it ever served.
   */
  async serialize<T>(streamId: string, work: () => Promise<T>): Promise<T> {
    const before = this.streamQueues.get(streamId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = before.then(() => turn);
    this.streamQueues.set(streamId, queued);
    await before;
    try {
      return await work();
    } finally {
      release();
      if (this.streamQueues.get(streamId) === queued) this.streamQueues.delete(streamId);
    }
  }

  /**
   * Queue one message for an App agent, durably, in the stream's turn.
   *
   * The caller has already chosen the stream and bounded `text` with
   * `agentInboxText`. `dispatchId` makes a double submit one message:
   * `app-state` keys idempotency on `(streamId, dispatchId)` and answers a
   * retry with the prior revision. `authorizeCommit` re-asks composition policy
   * after the State read, immediately before the commit. `owner` is recorded
   * only for a shared stream, where several members' lanes share one log.
   */
  async appendAgentInbox(input: {
    streamId: string;
    backendCodeDigest: string;
    contractDigest: string;
    agent: string;
    text: string;
    from: string;
    owner?: string;
    dispatchId: string;
    authorizeCommit?: () => { ok: true } | { ok: false; message: string };
  }): Promise<AgentInboxAppendResult> {
    return await this.serialize(input.streamId, async () => {
      const canonical = await loadCanonicalProjection({
        state: this.deps.state,
        runtime: this.deps.runtime,
        streamId: input.streamId,
        backendCodeDigest: input.backendCodeDigest,
      });
      const event = {
        type: AGENT_INBOX_EVENT,
        data: {
          to: input.agent,
          text: input.text,
          from: input.from,
          ...(input.owner === undefined ? {} : { owner: input.owner }),
        },
        at: new Date(this.now()).toISOString(),
        by: input.from,
      };
      const authorized = input.authorizeCommit?.() ?? { ok: true as const };
      if (!authorized.ok) return { ok: false, message: authorized.message };
      const committed = await this.deps.state.commit({
        streamId: input.streamId,
        expectedRevision: canonical.head,
        dispatchId: input.dispatchId,
        actor: input.from,
        action: "agent_inbox",
        paramsHash: createHash("sha256").update(canonicalJson({ agent: input.agent, text: input.text })).digest("hex"),
        backendCodeDigest: input.backendCodeDigest,
        contractDigest: input.contractDigest,
        events: [event],
      });
      if (!committed.ok) return { ok: false, message: "状态刚刚在另一处更新，请重新操作" };
      // A duplicate's revision is already folded into `canonical`; advancing
      // with it would be a no-op (`advanceCanonicalProjection` returns early).
      if (committed.duplicate) return { ok: true, revision: committed.revision, duplicate: true };
      await advanceCanonicalProjection({
        state: this.deps.state,
        runtime: this.deps.runtime,
        streamId: input.streamId,
        backendCodeDigest: input.backendCodeDigest,
        canonical,
        revision: committed.revision,
        events: [{ ...event, seq: canonical.head + 1 }],
      });
      return { ok: true, revision: committed.revision, duplicate: false };
    });
  }

  /**
   * Everything queued for one agent after `cursor`, plus the stream head.
   * With `owner`, only that member's lane of a shared stream.
   */
  async readAgentInbox(input: {
    streamId: string;
    agent: string;
    cursor: number;
    owner?: string;
  }): Promise<{ head: number; messages: AgentInboxMessage[] }> {
    const read = await readAllStateEvents(this.deps.state, input.streamId, Math.max(0, input.cursor));
    const messages: AgentInboxMessage[] = [];
    for (const event of read.events) {
      if (event.type !== AGENT_INBOX_EVENT) continue;
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (String(data.to ?? "") !== input.agent) continue;
      if (input.owner !== undefined && String(data.owner ?? "") !== input.owner) continue;
      messages.push({
        seq: event.seq,
        text: String(data.text ?? ""),
        from: String(data.from ?? event.by ?? ""),
        at: event.at,
      });
    }
    return { head: read.head, messages };
  }

  /**
   * State and Runtime liveness for the release being served. The Runtime is
   * healthy only while it runs exactly that release's backend code; with no
   * release (`undefined`) it is never healthy.
   */
  async health(backendCodeDigest: string | undefined): Promise<{ ok: boolean; state: boolean; runtime: boolean }> {
    const [state, runtime] = await Promise.allSettled([this.deps.state.health(), this.deps.runtime.health()]);
    const stateOk = state.status === "fulfilled" && state.value.ok;
    const runtimeOk = backendCodeDigest !== undefined
      && runtime.status === "fulfilled"
      && runtime.value.ok
      && runtime.value.backendCodeDigest === backendCodeDigest;
    return { ok: stateOk && runtimeOk, state: stateOk, runtime: runtimeOk };
  }

  async project(input: AppProjectionInput): Promise<AppProjection> {
    const canonical = input.canonical ?? await loadCanonicalProjection({
      state: this.deps.state,
      runtime: this.deps.runtime,
      streamId: input.streamId,
      backendCodeDigest: input.backendCodeDigest,
    });
    const projection = input.context === undefined
      ? canonical.projection
      : await renderViewerProjection({
          state: this.deps.state,
          runtime: this.deps.runtime,
          streamId: input.streamId,
          backendCodeDigest: input.backendCodeDigest,
          canonical,
          context: input.context,
        });
    return { canonical, projection };
  }

  async dispatch<TRefusal extends CoordinationRefusal = never>(
    input: AppDispatchInput<TRefusal>,
  ): Promise<AppDispatchSuccess | CoordinationEngineRefusal | TRefusal> {
    const attempts = input.retryConflict === false ? 1 : 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const { canonical } = await this.project({
        streamId: input.streamId,
        backendCodeDigest: input.backendCodeDigest,
      });
      if (input.historyAfter !== undefined && (!Number.isSafeInteger(input.historyAfter) || input.historyAfter < 0 || input.historyAfter > canonical.head)) {
        return { ok: false, code: "action_rejected", message: "历史游标超出当前状态范围" };
      }
      const history = input.historyAfter === undefined ? undefined
        : await this.deps.state.readSince(input.streamId, input.historyAfter, 8);
      let invoked;
      try {
        invoked = await this.deps.runtime.invoke({
          backendCodeDigest: input.backendCodeDigest,
          action: input.action,
          context: {
            ...input.context({ state: canonical.projection, now: new Date(this.now()).toISOString() }),
            ...(history ? { history: history as unknown as RuntimeJson } : {}),
          },
          params: input.params,
        });
      } catch (error) {
        const refusal = runtimeRefusal(error);
        if (refusal) return refusal;
        throw error;
      }

      const reserved = invoked.events.find((event) => String(event.type).startsWith(SYSTEM_EVENT_PREFIX));
      if (reserved) {
        return {
          ok: false,
          code: "action_rejected",
          message: `应用不能写 ${SYSTEM_EVENT_PREFIX} 前缀的事件（${String(reserved.type).slice(0, 40)}）`,
        };
      }

      const authorization = await input.authorizeCommit();
      if (!authorization.ok) return authorization.refusal;
      // Read-only handler results still recheck current authorization. No empty
      // commit, invented revision or query event is written into research history.
      if (invoked.events.length === 0) return { ok: true, result: invoked.result ?? null, canonical };
      const at = new Date(this.now()).toISOString();
      const events = invoked.events.map((event) => ({
        type: event.type,
        data: event.data,
        // App code proposes content; the trusted engine owns evidence fields.
        at,
        by: authorization.actor,
      }));
      const committed = await this.deps.state.commit({
        streamId: input.streamId,
        expectedRevision: canonical.head,
        dispatchId: input.dispatchId,
        actor: authorization.actor,
        action: input.action,
        paramsHash: createHash("sha256").update(canonicalJson(input.params)).digest("hex"),
        backendCodeDigest: input.backendCodeDigest,
        contractDigest: input.contractDigest,
        events,
      });
      if (!committed.ok) {
        if (attempt + 1 < attempts) continue;
        return { ok: false, code: "state_conflict", message: "状态刚刚在另一处更新，请重新操作" };
      }
      const canonicalAfter = await advanceCanonicalProjection({
        state: this.deps.state,
        runtime: this.deps.runtime,
        streamId: input.streamId,
        backendCodeDigest: input.backendCodeDigest,
        canonical,
        revision: committed.revision,
        events: events.map((event, index) => ({ ...event, seq: canonical.head + index + 1 })),
      });
      return { ok: true, result: invoked.result ?? null, canonical: canonicalAfter };
    }
    return { ok: false, code: "state_conflict", message: "状态冲突" };
  }
}

function runtimeRefusal(error: unknown): CoordinationEngineRefusal | null {
  const code = String((error as { code?: unknown })?.code ?? "");
  if (code === "handler_rejected") {
    const reason = String((error as Error).message ?? "").slice(0, 240);
    return { ok: false, code: "action_rejected", message: reason || "动作被应用规则拒绝" };
  }
  if (["handler_failed", "invalid_action", "invalid_input", "invalid_handler_result"].includes(code)) {
    return { ok: false, code: "action_rejected", message: "动作参数不被当前应用 release 接受" };
  }
  return null;
}
