/**
 * Completion notices for agent runtimes that do not own a chat channel.
 *
 * App agents, managed Sessions+ turns and dev-pipeline tickets keep their
 * primary transcript on a browser surface, so a closed tab used to make
 * completion silent. They publish one content-free terminal fact here, and the
 * composition delivers it as a direct Feishu card to the owner (see
 * `directAgentCompletionSink`). No prompt, model output, tool argument or owner
 * identity is copied into the card.
 */

import type { RunnerManagedCompletion } from "@claude-bot/runner/gateway-protocol";
import type { CardPayload } from "../feishu/direct-card.js";

export type AgentCompletionStatus = "succeeded" | "failed" | "unknown" | "suspended" | "merge_lock";

export interface AgentCompletionEvent {
  /** Stable turn/chat id for logs and future deduplication; never shown whole. */
  runId: string;
  owner: string;
  surface: "app" | "dev" | "sessions";
  /** Trusted, bounded location label, not agent output. */
  label: string;
  status: AgentCompletionStatus;
}

export type AgentCompletionSink = (event: AgentCompletionEvent) => void;

export interface DirectAgentCompletionDelivery {
  recipientFor(owner: string): string | undefined;
  send(recipient: string, card: CardPayload): Promise<void>;
  failed?(event: AgentCompletionEvent, error: unknown): void;
}

/** Build a best-effort direct sink for a composition that has no live Router. */
export function directAgentCompletionSink(delivery: DirectAgentCompletionDelivery): AgentCompletionSink {
  return (event) => {
    const recipient = delivery.recipientFor(event.owner);
    if (!recipient) {
      delivery.failed?.(event, new Error(`no private bot identity for ${event.owner}`));
      return;
    }
    void delivery.send(recipient, buildAgentCompletionCard(event)).catch((error) =>
      delivery.failed?.(event, error),
    );
  };
}

/**
 * A tiny process-local handoff with startup buffering.
 *
 * App recovery happens while the dashboard graph is composed, before Router
 * owns a channel. Keeping a bounded queue means those honest `unknown` endings
 * are still announced once Router attaches, without turning this into a second
 * durable job store (the App/HQ stores remain the records of truth).
 */
export class AgentCompletionRelay {
  private sink: AgentCompletionSink | null = null;
  private pending: AgentCompletionEvent[] = [];

  constructor(private readonly pendingLimit = 64) {}

  publish(event: AgentCompletionEvent): void {
    if (this.sink) {
      this.sink(event);
      return;
    }
    this.pending.push(event);
    if (this.pending.length > this.pendingLimit) this.pending.shift();
  }

  subscribe(sink: AgentCompletionSink): () => void {
    if (this.sink) throw new Error("agent completion relay already has a delivery sink");
    this.sink = sink;
    const queued = this.pending;
    this.pending = [];
    for (const event of queued) sink(event);
    return () => {
      if (this.sink === sink) this.sink = null;
    };
  }
}

/**
 * How long a Runner completion receipt remains news. Runners replay recent
 * receipts after every reconnect (a Head deploy reconnects every device), so a
 * notice needs both receipt identity and recency: a deploy's outage is covered,
 * months-old receipts never produce a card, and the dedupe rows stay small.
 */
export const MANAGED_COMPLETION_NOTICE_WINDOW_MS = 60 * 60_000;

export type ManagedCompletionNoticeClaim = (
  notice: { owner: string; device: string; provider: string; turnId: string; completedAt: string },
  notBefore: string,
) => boolean;

/** The one card a managed-session receipt may produce, or null for a replay or a stale receipt. */
export function managedCompletionNotice(
  owner: string,
  device: string,
  completion: RunnerManagedCompletion,
  claim: ManagedCompletionNoticeClaim,
  now = Date.now(),
): AgentCompletionEvent | null {
  const completedAt = Date.parse(completion.completed_at);
  const notBefore = now - MANAGED_COMPLETION_NOTICE_WINDOW_MS;
  // A replayed receipt older than the window costs no store write at all.
  if (!Number.isFinite(completedAt) || completedAt < notBefore) return null;
  const first = claim({ owner, device, provider: completion.provider, turnId: completion.turn_id,
    completedAt: new Date(completedAt).toISOString() }, new Date(notBefore).toISOString());
  return first ? {
    runId: completion.turn_id,
    owner,
    surface: "sessions",
    label: `Sessions+ · ${device} · ${completion.provider} 托管 Agent`,
    status: completion.status,
  } : null;
}

/** Pure card builder: terminal state and location only, never generated text. */
export function buildAgentCompletionCard(event: AgentCompletionEvent): CardPayload {
  const presentation = {
    succeeded: { title: "✅ Agent 已完成", template: "green", state: "已完成" },
    failed: { title: "❌ Agent 运行失败", template: "red", state: "失败" },
    unknown: { title: "⚠️ Agent 结局未知", template: "orange", state: "因进程重启而无法确认" },
    suspended: { title: "⏸️ Agent 等待用户", template: "blue", state: "已暂停，等待你的操作" },
    merge_lock: { title: "⏳ Agent 等待合并锁", template: "blue", state: "已暂停，合并锁释放后会自动重试" },
  }[event.status];
  const where = event.surface === "app"
    ? "对应 App 页面"
    : event.surface === "sessions"
      ? "Sessions+ 中的托管会话"
      : "开发面板中的工单对话";
  const label = event.label.replace(/\s+/g, " ").trim().slice(0, 80) || "Agent";
  return {
    header: {
      title: { tag: "plain_text", content: presentation.title },
      template: presentation.template,
    },
    elements: [{
      tag: "div",
      text: {
        tag: "plain_text",
        content: `${label} ${presentation.state}。\n请回到${where}查看记录。`,
      },
    }],
  };
}
