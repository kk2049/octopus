import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, uiMessage, uiValue, type UiTextValue } from "../i18n/ui-text.js";
import { UiButton } from "../ui-kit/primitives.js";
/**
 * The trusted approval affordance: a pill in the nav and a compact popup beside it.
 *
 * ── The rules that make it safe ─────────────────────────────────────────────
 *
 *  · It never sends a target, an operation or arguments — only the opaque
 *    pending id that names the call the SERVER froze. The browser cannot say
 *    what will run; it can only say yes or no to something already decided.
 *  · Every summary line is composed server-side. A page that assembled its own
 *    sentence from a status code would eventually make a claim nobody checked.
 *  · Approving is single-flight per card and the buttons stay disabled until
 *    the answer comes back: a double click on 批准 must not execute twice.
 *  · A session submission answers 202 with an operation id and runs in the
 *    background, so the confirmation says so instead of claiming "执行完成"
 *    about something that has not happened yet.
 *
 * The queue polls, and the endpoint it polls is on the replay-safe list: it is a
 * read of the kernel's own pending table and does not traverse the gate.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, errorText } from "../lib/api.js";
import { pollInterval } from "../lib/query.js";
import { Empty, Status } from "../ui/misc.js";
import { useAgenticActivity, type AgenticActivityState } from "./agentic-activity.js";
import styles from "./Approvals.module.css";

export interface PendingCall {
  id: string;
  title?: string;
  operation?: string;
  target?: string;
  details?: string[];
  expiresAt?: string;
  requestedBy?: { purpose?: string; surface?: string };
}

export interface AttentionNotice {
  id: string;
  kind: "feishu_reauth";
  title: string;
  detail: string;
  url: string;
  actionLabel: string;
}

export interface ApprovalQueue {
  items: PendingCall[];
  notices: AttentionNotice[];
  error: unknown;
  refetch: () => void;
}

const PENDING_PATH = "/api/capabilities/pending";

/** Remember server ids and report whether this poll contains a genuinely new call. */
export function rememberPending(seen: Set<string>, items: readonly Pick<PendingCall, "id">[]): boolean {
  const fresh = items.some((item) => !seen.has(item.id));
  for (const item of items) seen.add(item.id);
  return fresh;
}

export function useApprovalQueue(enabled: boolean): ApprovalQueue {
  const q = useQuery({
    queryKey: ["capabilities", "pending"],
    enabled,
    queryFn: () => api<{ pending?: PendingCall[]; notices?: AttentionNotice[] }>(PENDING_PATH),
    // This endpoint is server-local and replay-safe. One second keeps the
    // approval handshake perceptually immediate without polling capability
    // reads or replaying the dangerous call itself.
    refetchInterval: pollInterval(PENDING_PATH, 1000),
    refetchIntervalInBackground: false,
  });
  return {
    items: Array.isArray(q.data?.pending) ? q.data.pending : [],
    notices: Array.isArray(q.data?.notices) ? q.data.notices : [],
    error: q.error,
    refetch: () => void q.refetch(),
  };
}

function summary(call: PendingCall): string {
  const parts: string[] = [];
  if (call.requestedBy?.purpose) parts.push(uiText("发起：{v0}", { v0: call.requestedBy.purpose }));
  if (call.requestedBy?.surface) parts.push(uiText("界面：{v0}", { v0: call.requestedBy.surface }));
  if (call.expiresAt) parts.push(uiText("过期：{v0}", { v0: call.expiresAt.replace("T", " ").slice(0, 19) }));
  return parts.join(" · ");
}

export function ApprovalDrawer({
  open,
  onOpenChange,
  queue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queue: ApprovalQueue;
}) {
  useDashboardLanguage();
  const client = useQueryClient();
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: UiTextValue } | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const activity = useAgenticActivity();

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onOpenChange]);

  async function decide(id: string, action: "approve" | "reject") {
    if (deciding) return;
    setDeciding(id);
    setMessage({ kind: "ok", text: action === "approve" ? uiMessage("已批准，执行中…") : uiMessage("处理中…") });
    try {
      const out = await api<{ operation_id?: string }>(
        `/api/capabilities/pending/${encodeURIComponent(id)}/${action}`,
        { method: "POST", json: {}, expect: [202] },
      );
      setMessage({
        kind: "ok",
        text:
          action !== "approve"
            ? uiMessage("已拒绝。")
            : out?.operation_id
              ? uiMessage("已批准,正在执行 — 结果会显示在对应的会话里。")
              : uiMessage("执行完成。"),
      });
    } catch (err) {
      setMessage({ kind: "err", text: errorText(err) });
    } finally {
      setDeciding(null);
      await client.invalidateQueries({ queryKey: ["capabilities", "pending"] });
    }
  }

  if (!open) return null;

  const stateText: Record<AgenticActivityState, string> = {
    accepted: uiText("已接受"),
    refused: uiText("已拒绝"),
    submitted: uiText("已提交"),
    waiting_approval: uiText("待批准"),
    running: uiText("执行中"),
    succeeded: uiText("已完成"),
    failed: uiText("失败"),
    rejected: uiText("已拒绝"),
    unknown: uiText("结果未知"),
  };

  return (
    <aside
      className={styles.popup}
      role="dialog"
      aria-labelledby="approval-activity-title"
      aria-describedby="approval-activity-description"
    >
      <header className={styles.header}>
        <div>
          <h2 id="approval-activity-title">{uiText("审批与动态")}</h2>
          <p id="approval-activity-description">{uiText("处理账号提醒、审批跨边界调用并查看 App 动态。")}</p>
        </div>
        <UiButton aria-label={uiText("关闭审批与动态")} onClick={() => onOpenChange(false)}>×</UiButton>
      </header>
      <div className={styles.linkRow}>
        <a className="small" href="/permissions">
          {uiText("权限设置")}</a>
      </div>
      <h3 className={styles.sectionTitle}>{uiText("需要你处理 ")}{queue.notices.length}</h3>
      {queue.notices.length === 0 ? (
        <Empty>{uiText("暂无账号提醒。")}</Empty>
      ) : (
        queue.notices.map((notice) => (
          <section key={notice.id} className={styles.card} data-testid="attention-notice">
            <h3>{notice.title}</h3>
            <div className={styles.detail}>{notice.detail}</div>
            <div className={styles.actions}>
              <a href={notice.url} target={notice.url.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
                {notice.actionLabel}
              </a>
            </div>
          </section>
        ))
      )}
      <h3 className={styles.sectionTitle}>{uiText("待审批 ")}{queue.items.length}</h3>
      {queue.error ? (
        <Empty>{uiText("读取失败：")}{errorText(queue.error)}</Empty>
      ) : queue.items.length === 0 ? (
        <Empty>{uiText("暂无待审批调用。")}</Empty>
      ) : (
        queue.items.map((call) => (
          <section key={call.id} className={styles.card} data-testid="approval-card">
            <h3>{call.title || call.operation || uiText("待批准调用")}</h3>
            <div className={styles.target}>
              {call.target || ""} · {call.operation || ""}
            </div>
            {call.details?.length ? (
              <div className={styles.detail}>{call.details.join("\n")}</div>
            ) : null}
            <div className={styles.meta}>{summary(call)}</div>
            <div className={styles.actions}>
              {/* `data-action` is a stable hook, like `data-testid` above:
                  the browser suite decides a real card from outside the app. */}
              <UiButton
                data-action="approve"
                className="primary"
                disabled={deciding !== null}
                onClick={() => void decide(call.id, "approve")}
              >
                {uiText("批准并执行")}</UiButton>
              <UiButton
                data-action="reject"
                disabled={deciding !== null}
                onClick={() => void decide(call.id, "reject")}
              >
                {uiText("拒绝")}</UiButton>
            </div>
          </section>
        ))
      )}
      {message ? <Status kind={message.kind}>{uiValue(message.text)}</Status> : null}
      <details className={styles.activity} open={queue.items.length === 0}>
        <summary>{uiText("Agentic App 动态 ")}<span>{activity.length}</span></summary>
        {activity.length === 0 ? (
          <Empty>{uiText("暂无动作记录。")}</Empty>
        ) : (
          activity.map((row) => (
            <section
              key={row.id}
              className={`${styles.activityCard} agentic-activity-card`}
              data-testid="agentic-activity-card"
            >
              <div className={styles.activityHead}>
                <strong>{row.appTitle}</strong>
                <span data-activity-state={row.state}>{stateText[row.state]}</span>
              </div>
              <code>{row.action}</code>
              {row.detail ? <div className={styles.meta}>{row.detail}</div> : null}
            </section>
          ))
        )}
      </details>
    </aside>
  );
}
