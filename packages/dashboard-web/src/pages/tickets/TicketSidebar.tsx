import { UiButton, UiInput, UiSelect } from "../../ui-kit/primitives.js";
/** Ticket list and deploy controls; kept separate from the transcript state machine. */

import { memo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, errorText, query } from "../../lib/api.js";
import { formatRelative } from "../../lib/format.js";
import { Empty, ErrorBox, Loading } from "../../ui/misc.js";
import styles from "../TicketsPage.module.css";
import { ticketCostStrip } from "./cost.js";
import { DeployBox } from "./DeployBox.js";
import { PROPOSAL_LABEL, type DeployState, type Roster, type Ticket } from "./model.js";
import { useMessages } from "../../i18n/react.js";
import type { MessageKey, MessageValues } from "../../i18n/messages.js";
import { uiText } from "../../i18n/ui-text.js";

type Translator = (key: MessageKey, values?: MessageValues) => string;

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

/**
 * The row's one-line verdict.
 *
 * `label` is rendered INLINE in a 340px rail, so it stays a fixed phrase;
 * anything variable-length (an agent's question, an error) belongs in `title`,
 * which is the hover text. A row that grew to three lines because somebody
 * wrote a long sentence is a rail that no longer scans.
 */
function ticketGlyph(ticket: Ticket, t: Translator): { icon: string; tier: string; label: string; title?: string } {
  const prefix = ticket.execution_owner === "native_cli" ? `${uiText("原生 CLI")} · ` : ticket.kind === "cli" ? t("sidebar.glyph.cliPrefix") : "";
  if (ticket.execution_owner === "native_cli" && ticket.dev_status !== "landed") return { icon: "⌨", tier: "mute",
    label: ticket.chat_paused || ["completed", "cancelled"].includes(ticket.dev_status) ? uiText("已结束网页跟踪") : uiText("原生 CLI · 会话已绑定") };
  if (ticket.dev_status === "completed") return { icon: "✓", tier: "ok", label: t("ticket.dev.completed") };
  if (ticket.dev_status === "cancelled") return { icon: "✖", tier: "mute", label: t("sidebar.glyph.cancelled") };
  if (ticket.runtime_wait && !ticket.chat_paused) return { icon: "⏳", tier: "warn",
    label: t(ticket.runtime_wait.state === "reconnecting" ? "ticket.reconnecting" : "ticket.waitingResource") };
  if (ticket.turn_started_at) return { icon: "▶", tier: "run", label: t("sidebar.glyph.running") };
  // Ticket #201: BEFORE the deploy axis. An agent that landed the work and said
  // "the other half needs your call" used to land in the same square as one
  // that finished everything, so the board announced success and the question
  // sat unread. A landed ticket with a question is still a ticket that needs a
  // person; the deploy state is one line down, in the detail pane.
  if (ticket.open_question) {
    return {
      icon: "🙋",
      tier: "warn",
      label: t("sidebar.glyph.question"),
      title: t("sidebar.glyph.questionTitle", { question: ticket.open_question }),
    };
  }
  // A review-lane ticket's row says where its candidate is (2026-08-20): the
  // proposal state replaces "agent said something, waiting for you" because
  // after a submit the next move belongs to CI or to the maintainer, not to
  // the requester — unless the candidate was sent back, which is theirs again.
  if (ticket.dev_status === "open" && ticket.proposal && ticket.proposal.status !== "superseded"
    && !(ticket.proposal.status === "merged" && (ticket.error || (ticket.unread ?? 0) > 0))) {
    const p = PROPOSAL_LABEL[ticket.proposal.status];
    if (p) return {
      icon: p.icon,
      tier: p.tier,
      label: PROPOSAL_KEY[ticket.proposal.status]
        ? t(PROPOSAL_KEY[ticket.proposal.status]!)
        : p.label,
      title: ticket.proposal.review_note ?? undefined,
    };
  }
  // `dev_status` / `deploy_status` record the last successful landing and
  // deployment. A landed ticket remains a conversation and can run follow-up
  // work, so current failure/input/lock-wait signals must win over that
  // historical green result. Once the follow-up lands, these transient axes
  // clear and the latest deployment verdict becomes truthful again.
  if (ticket.error) return { icon: "🔴", tier: "err", label: t("sidebar.glyph.failed") };
  if (ticket.execution_owner !== "native_cli" && (ticket.unread ?? 0) > 0) return { icon: "⏳", tier: "mute", label: t("sidebar.glyph.queued") };
  if (ticket.parked_for_lock) {
    return { icon: "⏸", tier: "run", label: t("sidebar.glyph.lock") };
  }
  if (ticket.dev_status === "landed") {
    if (ticket.deploy_status === "verified") return { icon: "✅", tier: "ok", label: `${prefix}${t("ticket.dep.verified")}` };
    // One label set for deployment states: the same `ticket.dep.*` words as the detail badge.
    if (ticket.deploy_status === "app_live") return { icon: "⚡", tier: "ok", label: t("ticket.dep.app_live") };
    if (ticket.deploy_status === "not_needed" || ticket.delivery_mode === "none") {
      return { icon: "📝", tier: "ok", label: t("ticket.dep.not_needed") };
    }
    if (ticket.deploy_status === "reverted") return { icon: "↩", tier: "err", label: `${prefix}${t("ticket.dep.reverted")}` };
    if (ticket.deploy_status === "live_unverified") {
      return { icon: "🚀", tier: "warn", label: `${prefix}${t("ticket.dep.live_unverified")}` };
    }
    if (ticket.deploy_status === "deploying") return { icon: "🚀", tier: "run", label: `${prefix}${t("ticket.dep.deploying")}` };
    if (ticket.delivery_mode === "app_releases" || (!ticket.delivery_mode && ticket.kind === "app")) {
      return { icon: "📦", tier: "run", label: t("sidebar.glyph.appPending") };
    }
    return { icon: ticket.kind === "cli" ? "⌨" : "📦", tier: "run", label: `${prefix}${t("ticket.dep.pending")}` };
  }
  if (ticket.last_author === "agent") {
    // A reply only means the turn ended. A green check is reserved for an
    // explicit human completion or a verified landing; an agent reply may
    // still have unmerged work and must remain visibly actionable.
    return { icon: "🙋", tier: "warn", label: t("sidebar.glyph.agentDone") };
  }
  return { icon: "💬", tier: "mute", label: t("sidebar.glyph.inProgress") };
}

function needsTrustedDeploy(ticket: Ticket): boolean {
  return ticket.delivery_mode ? ticket.delivery_mode === "full_deploy" : ticket.kind !== "app";
}

function attentionTier(ticket: Ticket, viewer: Roster["viewer"]): string | null {
  if (ticket.turn_started_at || ticket.dev_status === "cancelled") return null;
  // An open question counts however the code ended up: that is the whole point
  // of the field. Everything below it still requires an `open` ticket, because
  // those signals are about a conversation that has not finished.
  const mine = viewer && (viewer.admin || viewer.username === ticket.requester);
  if (ticket.open_question && mine) return "warn";
  if (ticket.dev_status !== "open") return null;
  if (ticket.error) return "err";
  if (ticket.parked_for_lock) return null;
  return null;
}

export interface TicketSidebarProps {
  roster: Roster | undefined;
  rosterPending: boolean;
  rosterError?: string;
  deploy: DeployState | undefined;
  deployError?: string;
  selected: number | null;
  deployBusy: boolean;
  deploying: boolean;
  publishingApps: boolean;
  decidedIntent: { id: number; decision: "alive" | "rollback" } | null;
  onTriggerDeploy: () => void;
  onCheckUpdates?: () => void;
  checkingUpdates?: boolean;
  onPublishApps: () => void;
  onConfirmDeploy: (id: number, decision: "alive" | "rollback") => void;
  onVerify: (id: number, result: "passed" | "failed") => void;
  onOpenComposer: (mode: "ticket" | "discuss") => void;
  onOpenTicket: (id: number) => void;
}

export const TicketSidebar = memo(function TicketSidebar({
  roster,
  rosterPending,
  rosterError,
  deploy,
  deployError,
  selected,
  deployBusy,
  deploying,
  publishingApps,
  decidedIntent,
  onTriggerDeploy,
  onCheckUpdates,
  checkingUpdates,
  onPublishApps,
  onConfirmDeploy,
  onVerify,
  onOpenComposer,
  onOpenTicket,
}: TicketSidebarProps) {
  const { language, t } = useMessages();
  const tickets = roster?.tickets ?? [];
  const [keyword, setKeyword] = useState("");
  const [requester, setRequester] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState<{ q: string; requester: string; status: string; offset: number } | null>(null);
  const results = useQuery({
    queryKey: ["tickets", "search", search],
    enabled: search !== null,
    queryFn: ({ signal }) => api<Roster>(`/api/tickets${query({ ...search, limit: 50 })}`, { signal }),
    staleTime: 0,
    gcTime: 60_000,
    // An explicit search: its button re-runs it and a failure shows at once.
    // With `staleTime: 0` (pages re-read when revisited), window focus or a
    // reconnect would otherwise re-download the results every time.
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const edited = search !== null && (keyword.trim() !== search.q || requester.trim() !== search.requester || status !== search.status);
  const listedTickets = search ? results.data?.tickets ?? [] : tickets;
  const listPending = search ? results.isFetching : rosterPending;
  const listError = search ? (results.isError ? errorText(results.error) : undefined) : rosterError;
  const counts = roster?.counts ?? {};
  const viewer = roster?.viewer;
  const attention = tickets.filter((ticket) => attentionTier(ticket, viewer)).length;
  const failed = tickets.filter(
    (ticket) => ticket.dev_status === "open" && ticket.error && !ticket.turn_started_at,
  ).length;
  const awaitingReview = tickets.filter(
    (ticket) => ticket.dev_status === "open" && ticket.proposal?.status === "awaiting_review",
  ).length;

  return (
    <div className={styles.sideScroll}>
      <div className={styles.counts}>
        {counts.running ? (
          <span className={styles.chip}>
            {t("sidebar.running")} <b>{counts.running}</b>
          </span>
        ) : null}
        {counts.queued_input ? (
          <span className={styles.chip}>
            {t("sidebar.queued")} <b>{counts.queued_input}</b>
          </span>
        ) : null}
        {counts.landed_pending ? (
          <span className={styles.chip}>
            {t("sidebar.pendingDeploy")} <b>{counts.landed_pending}</b>
          </span>
        ) : null}
        {attention - failed > 0 ? (
          <span className={`${styles.chip} ${styles.warn}`}>
            {t("sidebar.awaiting")} <b>{attention - failed}</b>
          </span>
        ) : null}
        {failed ? (
          <span className={`${styles.chip} ${styles.err}`}>
            {t("sidebar.failed")} <b>{failed}</b>
          </span>
        ) : null}
        {awaitingReview ? (
          <span className={`${styles.chip} ${styles.warn}`}>
            {t("sidebar.pendingReview")} <b>{awaitingReview}</b>
          </span>
        ) : null}
        <span className={`${styles.chip} ${styles.base}`}>
          {t("sidebar.target")} <code>{roster?.base_branch || "main"}</code>
        </span>
      </div>
      {roster?.viewer_lane === "review" ? (
        <div className={styles.laneNote} data-testid="lane-note">
          {t("sidebar.contributorLane", { branch: roster?.base_branch || "main" })}
        </div>
      ) : null}

      <details className={styles.sidebarSection} data-testid="deploy-section">
        <summary>{t("sidebar.deploy")}</summary>
        <DeployBox
          state={deploy}
          viewer={viewer}
          pendingCount={
            tickets.filter(
              (ticket) =>
                needsTrustedDeploy(ticket)
                && ticket.dev_status === "landed"
                && ticket.deploy_status === "pending",
            ).length
          }
          busy={deployBusy}
          deploying={deploying}
          publishingApps={publishingApps}
          decidedIntent={decidedIntent}
          onTrigger={onTriggerDeploy}
          onCheckUpdates={onCheckUpdates}
          checkingUpdates={checkingUpdates}
          onPublishApps={onPublishApps}
          onConfirm={onConfirmDeploy}
          onVerify={onVerify}
        />
        {deployError ? <ErrorBox>{deployError}</ErrorBox> : null}
      </details>

      <div className={styles.newButtons}>
        <UiButton className="primary" onClick={() => onOpenComposer("ticket")}>
          {t("sidebar.newTicket")}
        </UiButton>
        <UiButton
          // Ticket #38-5: the discussion shortcut keeps a continuous agent
          // session and can be renamed after the topic becomes clear.
          onClick={() => onOpenComposer("discuss")}
        >
          {t("sidebar.discuss")}
        </UiButton>
      </div>

      <details className={styles.sidebarSection} data-testid="search-section">
        <summary>{t("sidebar.search.label")}</summary>
        <form className={styles.ticketSearch} role="search" aria-label={t("sidebar.search.label")}
          onSubmit={(event) => {
            event.preventDefault();
            const next = { q: keyword.trim(), requester: requester.trim(), status, offset: 0 };
            if (search && !edited && search.offset === 0) void results.refetch();
            else setSearch(next);
          }}>
          <label>
            {t("sidebar.search.keyword")}
            <UiInput aria-label={t("sidebar.search.keyword")} placeholder={t("sidebar.search.hint")}
              value={keyword} maxLength={200} onChange={(event) => setKeyword(event.target.value)} />
          </label>
          <div className={styles.searchFilters}>
            <label>
              {t("sidebar.search.requester")}
              <UiInput aria-label={t("sidebar.search.requester")} placeholder={t("sidebar.search.anyRequester")}
                value={requester} maxLength={64} onChange={(event) => setRequester(event.target.value)} />
            </label>
            <label>
              {t("sidebar.search.status")}
              <UiSelect className={styles.searchStatus} aria-label={t("sidebar.search.status")} value={status} onValueChange={setStatus}
                options={[
                  { value: "", label: t("sidebar.search.anyStatus") },
                  ...(["open", "landed", "completed", "cancelled"] as const).map((value) => ({
                    value, label: t(`ticket.dev.${value}`),
                  })),
                ]} />
            </label>
          </div>
          <div className={styles.searchActions}>
            <UiButton htmlType="submit" tone="primary" loading={Boolean(search && !edited && results.isFetching)}>
              {t("sidebar.search.submit")}
            </UiButton>
            <UiButton onClick={() => { setKeyword(""); setRequester(""); setStatus(""); setSearch(null); }}>
              {t("sidebar.search.clear")}
            </UiButton>
          </div>
        </form>
      </details>

      <div className={styles.list} aria-busy={listPending}>
        {edited ? (
          <Empty>{t("sidebar.search.edited")}</Empty>
        ) : listPending ? (
          <Loading />
        ) : listError ? (
          <ErrorBox>{listError}</ErrorBox>
        ) : listedTickets.length === 0 ? (
          <Empty>{t(search ? "sidebar.search.empty" : "sidebar.empty")}</Empty>
        ) : (
          listedTickets.map((ticket) => {
            const glyph = ticketGlyph(ticket, t);
            const dot = attentionTier(ticket, viewer);
            const cost = ticketCostStrip(ticket, language);
            const name = ticket.slug || ticket.title;
            // CLI reports store a title prefix as the slug; CSS cannot detect
            // that truncation. Keep independently authored short names intact.
            const truncated = name.length < ticket.title.length && ticket.title.startsWith(name);
            return (
              <UiButton
                key={ticket.id}
                className={`${styles.tk} ${ticket.id === selected ? styles.active : ""}`}
                title={glyph.title ?? glyph.label}
                aria-current={ticket.id === selected}
                onClick={() => onOpenTicket(ticket.id)}
              >
                <span className={`${styles.glyph} ${styles[`g-${glyph.tier}`] ?? ""}`}>
                  {glyph.icon}
                </span>
                <span className={styles.body}>
                  <span className={styles.name} title={ticket.title}>
                    <span className={styles.id}>#{ticket.id}</span>
                    {name}{truncated ? " ..." : ""}
                  </span>
                  <span className={styles.sub}>
                    {glyph.label} · {ticket.knowledge_subject_id ? t("sidebar.knowledgeConflict") : ""}{ticket.requester} · {formatRelative(ticket.updated_at, language)}
                  </span>
                  {/* Ticket #192: the cost strip. Rendered only when something
                      was actually measured, so old rows keep their old height
                      instead of gaining a line of zeroes. */}
                  {cost.parts.length ? (
                    <span className={styles.cost} title={cost.hint} data-testid={`cost-${ticket.id}`}>
                      {cost.parts.map((part, i) => (
                        <span key={`${i}-${part}`} className={styles.costPart}>
                          {i > 0 ? <i className={styles.costSep} aria-hidden="true" /> : null}
                          {part}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
                {dot ? <span className={`${styles.dot} ${styles[`d-${dot}`]}`} /> : null}
              </UiButton>
            );
          })
        )}
      </div>
      {search && !edited && !listPending && !listError ? (
        <div className={styles.searchActions}>
          <UiButton disabled={search.offset === 0} onClick={() => setSearch({ ...search, offset: Math.max(0, search.offset - 50) })}>
            {t("sidebar.search.previous")}
          </UiButton>
          <span role="status">{t("sidebar.search.page", { page: search.offset / 50 + 1 })}</span>
          <UiButton disabled={!results.data?.has_more} onClick={() => setSearch({ ...search, offset: search.offset + 50 })}>
            {t("sidebar.search.next")}
          </UiButton>
        </div>
      ) : null}
    </div>
  );
});
