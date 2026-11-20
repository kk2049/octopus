/**
 * `AgentViewAlerts` — a non-blocking corner notification for failures.
 *
 * ── Why the runtime owns this and not each App ──────────────────────────────
 *
 * An Agent View has exactly two ways to learn that something did not work, and
 * both of them used to be optional for the App author to render:
 *
 *  1. **A proposal was refused.** The Host answers with a bounded sentence, the
 *     client keeps it in the proposal ledger, and a module that never reads the
 *     ledger silently drops it.
 *  2. **A proposal was ACCEPTED and the durable operation later failed.** This
 *     one is worse, because there is nothing to drop: the click succeeded, the
 *     screen did not change, and the failure arrives minutes later on the
 *     operation stream addressed to whichever surface happens to render
 *     operations. A composition that mounts no such surface — Session Plus,
 *     since the bottom flow slot went away — shows the person nothing at all.
 *
 * Ticket #191 is exactly case 2: somebody started an agent, no session
 * appeared, and no sentence was written anywhere. So "an error is always
 * visible" cannot be a habit each App re-implements; it is a property of the
 * runtime, and this component is where it lives. Mount it once beside the
 * workspace and every refusal and every failed operation in that View — from
 * ANY typed port, because every port proposes through the same client — becomes
 * a compact notification with optional details. It never takes focus or blocks
 * the workspace; dismissal is explicit so late failures do not vanish unread.
 *
 * ── What it deliberately does NOT raise ────────────────────────────────────
 *
 * `approval_required`. That code means a human decision was CREATED, not that
 * something failed: the trusted shell owns the approval drawer, and turning a
 * pending decision into an error popup would teach people to click through the
 * one dialog that matters. Refusals with that code stay in the ledger for the
 * module that asked.
 *
 * `resource.open_text` classification replies (`not_text`, `too_large`) are
 * presented by the file viewer with their explanation and a download action.
 * A duplicate notification would obscure that recovery action. Other resource failures
 * and failed operations still raise the notification.
 *
 * Operations that were already terminal at first render are treated as history
 * rather than news, so opening a page never greets somebody with an old
 * failure they have already dealt with.
 *
 * ── What it cannot do ───────────────────────────────────────────────────────
 *
 * Retry. Nothing here re-proposes anything: a refusal may have cost an approval
 * card, and re-spending it because a person dismissed a notification is precisely the
 * behaviour the platform forbids. Every string it renders is text the Host
 * wrote, bounded again here, and rendered as text — never markup.
 */

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useOperations, useProposals } from "./hooks.js";
import { AvButton } from "./controls.js";

/** Operation statuses that mean "this will not happen". */
const FAILED_STATUSES = new Set(["failed", "rejected"]);

/**
 * A pending human decision, not a failure.
 */
const APPROVAL_REQUIRED = "approval_required";

/** Bound every sentence again on this side; the Host already bounded it once. */
const MESSAGE_MAX = 240;

/** Dismissed operation ids remembered per mount. Bounded like everything else. */
const DISMISSED_MAX = 64;

/** Bound expanded details as well as the compact default presentation. */
const SHOWN_MAX = 6;

export interface AgentViewAlert {
  /** Ledger rid for a refusal, operation id for a failure. */
  key: string;
  kind: "refusal" | "operation";
  /** The action or operation id the Host was asked to run. */
  action: string;
  message: string;
}

export interface AgentViewAlertsProps {
  /** Notification title. Apps with a narrower vocabulary may say it differently. */
  title?: string;
  /** Label of the single dismiss control. */
  dismissLabel?: string;
}

function bounded(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MESSAGE_MAX) : "";
}

/**
 * Everything that failed and has not been acknowledged, oldest first.
 *
 * Exported for tests and for an App that wants its own presentation: the
 * derivation is the contract, the notification below is one way to show it.
 */
export function useAgentViewAlerts(): { alerts: readonly AgentViewAlert[]; dismiss(): void } {
  const { proposals, dismiss: dismissProposal } = useProposals();
  const operations = useOperations();
  const [dismissedOperations, setDismissedOperations] = useState<readonly string[]>([]);
  // Terminal operations present in the FIRST render are backlog, not news. The
  // ref is seeded once, so a stream that replays history on connect cannot open
  // a notification about something that finished before this View existed.
  const backlog = useRef<Set<string> | null>(null);
  if (backlog.current === null) {
    backlog.current = new Set(
      operations
        .filter((operation) => FAILED_STATUSES.has(String(operation.status ?? "")))
        .map((operation) => String(operation.id ?? ""))
        .filter(Boolean),
    );
  }
  const seen = backlog.current;

  const alerts = useMemo<readonly AgentViewAlert[]>(() => {
    const refusals: AgentViewAlert[] = proposals
      .filter((proposal) => proposal.phase === "refused" && proposal.code !== APPROVAL_REQUIRED
        && !(proposal.action === "resource.open_text" && (proposal.code === "not_text" || proposal.code === "too_large")))
      .map((proposal) => ({
        key: proposal.rid,
        kind: "refusal" as const,
        action: bounded(proposal.action) || "动作",
        message: bounded(proposal.message) || "可信外层拒绝了这个动作，但没有给出说明",
      }));
    const failures: AgentViewAlert[] = operations
      .filter((operation) => FAILED_STATUSES.has(String(operation.status ?? "")))
      .map((operation) => ({
        key: String(operation.id ?? ""),
        kind: "operation" as const,
        action: bounded(operation.operation) || "操作",
        message: bounded(operation.message) || "操作没有完成，可信侧没有给出说明",
      }))
      .filter((alert) => alert.key && !seen.has(alert.key) && !dismissedOperations.includes(alert.key))
      // The client publishes operations newest first; a reader reads a list
      // oldest first, like the refusals above.
      .reverse();
    return Object.freeze([...refusals, ...failures]);
  }, [dismissedOperations, operations, proposals, seen]);

  const dismiss = useCallback(() => {
    const shown = alerts;
    for (const alert of shown) {
      if (alert.kind === "refusal") dismissProposal(alert.key);
    }
    const operationKeys = shown.filter((alert) => alert.kind === "operation").map((alert) => alert.key);
    if (!operationKeys.length) return;
    setDismissedOperations((previous) => {
      const next = [...previous.filter((key) => !operationKeys.includes(key)), ...operationKeys];
      return next.length > DISMISSED_MAX ? next.slice(next.length - DISMISSED_MAX) : next;
    });
  }, [alerts, dismissProposal]);

  return { alerts, dismiss };
}

export function AgentViewAlerts({
  title = "有操作没有成功",
  dismissLabel = "知道了",
}: AgentViewAlertsProps = {}) {
  const { alerts, dismiss } = useAgentViewAlerts();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const shown = expanded ? alerts.slice(-SHOWN_MAX) : alerts.slice(-1);
  const hidden = alerts.length - shown.length;
  const dismissAll = () => {
    dismiss();
    setExpanded(false);
  };
  return (
    <section className="av-alert-notification" aria-label={title} hidden={alerts.length === 0}
      data-av-alerts={alerts.length} data-expanded={expanded}>
      <strong className="av-alert-title">{title}</strong>
      <div className="av-alerts" id={detailsId} role="status" aria-live="polite" aria-atomic="true">
        {shown.map((alert) => (
          <div className="av-alert" key={`${alert.kind}:${alert.key}`} data-av-alert-kind={alert.kind}>
            <code className="av-alert-action">{alert.action}</code>
            <span className="av-alert-message">{alert.message}</span>
          </div>
        ))}
        {expanded && hidden > 0 ? <div className="av-alert-more">还有 {hidden} 条同样没有成功。</div> : null}
      </div>
      <div className="av-alert-actions">
        <AvButton aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起详情" : `查看详情（${alerts.length}）`}
        </AvButton>
        <AvButton data-av-alert-dismiss="all" onClick={dismissAll}>
          {dismissLabel}
        </AvButton>
      </div>
    </section>
  );
}
