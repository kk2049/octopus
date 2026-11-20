/**
 * The review lane's maintainer face on `/tickets` (2026-08-20).
 *
 * One box, under the deploy box, for members of the dev workspace: every
 * contributor proposal with its CI/MR state, approve/reject for the people
 * who hold `deploy`, and one button that files the batch-merge ticket. A
 * contributor does not see this box at all — their own proposal's state is on
 * their ticket row — and a member without `deploy` sees it read-only.
 *
 * Server-authoritative throughout: every verb re-reads the queue afterwards,
 * because approve/reject/run are refused server-side under conditions this
 * pane cannot see (a row that moved, a batch already running).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "../../lib/api.js";
import { pollInterval } from "../../lib/query.js";
import { UiButton, UiInput } from "../../ui-kit/primitives.js";
import styles from "../TicketsPage.module.css";
import { PROPOSAL_LABEL, type MergeQueue, type MergeQueueEntry } from "./model.js";
import { useMessages } from "../../i18n/react.js";
import type { MessageKey } from "../../i18n/messages.js";

const QUEUE_PATH = "/api/merge-queue";
/** Rows a maintainer still has something to do about. */
const ACTIONABLE = new Set(["awaiting_review", "approved", "rejected", "ci_failed", "ci_pending", "merging", "merge_failed"]);
const PROPOSAL_KEY: Record<string, MessageKey> = {
  ci_pending: "proposal.ci_pending",
  ci_failed: "proposal.ci_failed",
  awaiting_review: "proposal.awaiting_review",
  approved: "proposal.approved",
  rejected: "proposal.rejected",
  merging: "proposal.merging",
  merged: "proposal.merged",
  merge_failed: "proposal.merge_failed",
  superseded: "proposal.superseded",
};

function Row({
  row,
  mayReview,
  busy,
  note,
  onNote,
  onDecide,
  onOpenTicket,
}: {
  row: MergeQueueEntry;
  mayReview: boolean;
  busy: boolean;
  note: string;
  onNote: (value: string) => void;
  onDecide: (id: number, decision: "approve" | "reject") => void;
  onOpenTicket: (id: number) => void;
}) {
  const { t } = useMessages();
  const style = PROPOSAL_LABEL[row.status] ?? { icon: "•", tier: "mute", label: row.status };
  const label = PROPOSAL_KEY[row.status] ? t(PROPOSAL_KEY[row.status]!) : style.label;
  const canApprove = row.status === "awaiting_review" || row.status === "rejected";
  const canReject = row.status === "awaiting_review" || row.status === "approved";
  return (
    <div className={styles.mqRow} data-testid={`proposal-${row.id}`}>
      <div className={styles.mqHead}>
        <span className={`${styles.glyph} ${styles[`g-${style.tier}`] ?? ""}`}>{style.icon}</span>
        <button type="button" className={styles.mqTicket} onClick={() => onOpenTicket(row.ticket_id)}>
          #{row.ticket_id} {row.ticket_slug || row.ticket_title}
        </button>
        <span className={styles.mqMeta}>
          {t("merge.proposal", { requester: row.requester, id: row.id, sha: row.sha.slice(0, 10) })}
        </span>
      </div>
      <div className={styles.mqStatus}>
        {label}
        {row.pipeline_url ? (
          <>
            {" · "}
            <a href={row.pipeline_url} target="_blank" rel="noreferrer">
              CI
            </a>
          </>
        ) : null}
        {row.mr_url ? (
          <>
            {" · "}
            <a href={row.mr_url} target="_blank" rel="noreferrer">
              MR
            </a>
          </>
        ) : null}
        {row.merge_ticket_id ? (
          <>
            {" · "}
            <button type="button" className={styles.mqTicket} onClick={() => onOpenTicket(row.merge_ticket_id!)}>
              {t("merge.ticket", { id: row.merge_ticket_id })}
            </button>
          </>
        ) : null}
        {row.review_by ? ` · ${row.review_by}${row.review_note ? `:${row.review_note}` : ""}` : ""}
      </div>
      {row.summary ? <div className={styles.mqSummary}>{row.summary}</div> : null}
      {mayReview && (canApprove || canReject) ? (
        <div className={styles.drow}>
          <UiInput
            type="text"
            aria-label={t("merge.noteAria", { id: row.id })}
            placeholder={t("merge.notePlaceholder")}
            value={note}
            onChange={(event) => onNote(event.target.value)}
          />
          {canApprove ? (
            <UiButton className="primary" disabled={busy} onClick={() => onDecide(row.id, "approve")}>
              {t("merge.approve")}
            </UiButton>
          ) : null}
          {canReject ? (
            <UiButton className="danger" disabled={busy} onClick={() => onDecide(row.id, "reject")}>
              {t("merge.reject")}
            </UiButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MergeQueueBox({
  enabled,
  onOpenTicket,
}: {
  /** Members of the dev workspace only; contributors get nothing here. */
  enabled: boolean;
  onOpenTicket: (id: number) => void;
}) {
  const { t } = useMessages();
  const client = useQueryClient();
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [message, setMessage] = useState<string>("");
  const [showHistory, setShowHistory] = useState(false);

  const queue = useQuery({
    queryKey: ["merge-queue"],
    queryFn: () => api<MergeQueue>(QUEUE_PATH),
    enabled,
    refetchInterval: pollInterval(QUEUE_PATH, 15_000),
    refetchIntervalInBackground: false,
  });

  const decide = useMutation({
    mutationFn: (body: { proposal_id: number; decision: "approve" | "reject"; note?: string }) =>
      api<{ ok: true }>(`${QUEUE_PATH}/decide`, { method: "POST", json: body }),
    onSuccess: async (_out, body) => {
      setMessage(t(body.decision === "approve" ? "merge.approved" : "merge.rejected", {
        id: body.proposal_id,
      }));
      setNotes((prev) => ({ ...prev, [body.proposal_id]: "" }));
      await Promise.all([
        client.invalidateQueries({ queryKey: ["merge-queue"] }),
        client.invalidateQueries({ queryKey: ["tickets"] }),
      ]);
    },
    onError: (err) => setMessage(t("merge.actionFailed", { message: errorText(err) })),
  });

  const run = useMutation({
    mutationFn: () => api<{ ok: true; ticket: { id: number } }>(`${QUEUE_PATH}/run`, { method: "POST", json: {} }),
    onSuccess: async (out) => {
      setMessage(t("merge.createdBatch", { id: out.ticket.id }));
      await Promise.all([
        client.invalidateQueries({ queryKey: ["merge-queue"] }),
        client.invalidateQueries({ queryKey: ["tickets"] }),
      ]);
      onOpenTicket(out.ticket.id);
    },
    onError: (err) => setMessage(t("merge.batchFailed", { message: errorText(err) })),
  });

  if (!enabled) return null;
  const rows = queue.data?.proposals ?? [];
  const live = rows.filter((row) => ACTIONABLE.has(row.status));
  const history = rows.filter((row) => !ACTIONABLE.has(row.status));
  const approved = rows.filter((row) => row.status === "approved").length;
  const mayReview = Boolean(queue.data?.may_review);
  const busy = decide.isPending || run.isPending;
  // Nothing to say until there has ever been a proposal: a member who never
  // onboarded a contributor should not see an empty box every day.
  if (!queue.isPending && rows.length === 0 && !queue.isError) return null;

  return (
    <div className={styles.deployBox} data-testid="merge-queue">
      <div className={styles.dhd}>{t("merge.title")}</div>
      {queue.isError
        ? <div className={styles.dstat}>{t("merge.loadFailed", { message: errorText(queue.error) })}</div>
        : null}
      {live.length === 0 && !queue.isPending ? <div className={styles.dstat}>{t("merge.empty")}</div> : null}
      {live.map((row) => (
        <Row
          key={row.id}
          row={row}
          mayReview={mayReview}
          busy={busy}
          note={notes[row.id] ?? ""}
          onNote={(value) => setNotes((prev) => ({ ...prev, [row.id]: value }))}
          onDecide={(id, decision) => decide.mutate({ proposal_id: id, decision, note: notes[id] || undefined })}
          onOpenTicket={onOpenTicket}
        />
      ))}
      {mayReview && approved > 0 ? (
        <div className={styles.drow}>
          <UiButton className="primary" disabled={busy} onClick={() => run.mutate()}>
            {t("merge.run", { count: approved })}
          </UiButton>
        </div>
      ) : null}
      {history.length ? (
        <button type="button" className={styles.mqTicket} onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? t("merge.collapseHistory") : t("merge.history", { count: history.length })}
        </button>
      ) : null}
      {showHistory
        ? history.map((row) => (
            <Row
              key={row.id}
              row={row}
              mayReview={false}
              busy={busy}
              note=""
              onNote={() => {}}
              onDecide={() => {}}
              onOpenTicket={onOpenTicket}
            />
          ))
        : null}
      {message ? <div className={styles.dstat} role="status">{message}</div> : null}
    </div>
  );
}
