import { UiButton, UiTextArea } from "../ui-kit/primitives.js";
import { deploymentRequested } from "../lib/deployment-status.js";
/**
 * `/tickets` — the dev pipeline, where a ticket IS a conversation.
 *
 * Since ticket #12 the only steering wheel is the message box: "可以,开始实现吧"
 * is the approval, and the old approve/requeue buttons are gone. The left list
 * is flat and newest-first with one derived status glyph per row; the right pane
 * is the selected ticket, its conversation, the dev agent's transcript with live
 * follow, and the box.
 *
 * Two things are deliberately server-authoritative:
 *  · the activity strip trusts `turn_started_at` over anything derived from the
 *    log — the pipeline holds the child process, the log only knows what was
 *    written;
 *  · every lifecycle action re-reads the ticket afterwards rather than assuming
 *    it succeeded, because cancel/kind/deploy-mark are all refused server-side
 *    under conditions the browser cannot see.
 *
 * Server facts are detach-friendly by construction: they are re-derived on a
 * poll cycle plus SSE. User-owned message drafts are the one deliberate local
 * exception and are keyed by ticket id in the browser cache.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { handleModifierSubmitKeyDown } from "@claude-bot/chat-ui-commons/composer";
import { useCompactChatViewport } from "@claude-bot/chat-ui-commons/composer-react";
import { SendReceipt, type ChatSendReceipt } from "@claude-bot/chat-ui-commons/transcript-ui";
import { DASHBOARD_CHAT_CLASSES } from "../transcript/ChatTranscript.js";
import { ApiError, api, errorText, query } from "../lib/api.js";
import { useBrowserDraft } from "../lib/browser-drafts-react.js";
import { pollInterval } from "../lib/query.js";
import { actorKindHint, actorKindLabel } from "../lib/actor-kind.js";
import { useEventSource } from "../lib/sse.js";
import { clientFrontier } from "../live-contract.js";
import { deriveActivity, type Activity, type RichMessage } from "../lib/transcript.js";
import {
  mergeOlder,
  ticketTranscriptWakeKey,
  ticketSessionView,
  transcriptWindowOf,
  type TicketSessionResponse,
  nativeTicketConnected,
  nativeTicketControl,
  type TicketExecution,
  type TicketWindow,
} from "../lib/ticket-session.js";
import { SessionChat } from "../transcript/SessionChat.js";
import { activityStatusText } from "../transcript/ActivityBar.js";
import { ShellPageActions } from "../app/Shell.js";
import {
  SplitPane,
  SplitPanel,
  SplitHandle,
} from "../ui/SplitPane.js";
import { TicketFiles } from "./tickets/TicketFiles.js";
import type { FileReference } from "../lib/file-reference.js";
import { uiText } from "../i18n/ui-text.js";
import { Markdown, MarkdownFileLinks } from "../ui/Markdown.js";
import { Confirm, Dialog } from "../ui/Dialog.js";
import {
  ErrorBox,
  Field,
  Loading,
  StaleDataBanner,
  Status,
  useAction,
  useNow,
} from "../ui/misc.js";
import { HardRefreshAction } from "./tickets/HardRefreshAction.js";
import { NewDiscussPane, NewTicketPane } from "./tickets/TicketComposer.js";
import { AttachmentStrip, useAttachments } from "../ui/Attachments.js";
import { TicketSidebar } from "./tickets/TicketSidebar.js";
import { PROPOSAL_LABEL, codexAccountDisplayLabel, ticketModelLabel, type DeployState, type Roster, type Ticket } from "./tickets/model.js";
import { useMessages } from "../i18n/react.js";
import { ticketChatReceipts, messageReceipt, type TicketMessage, type TicketSendEcho } from "./tickets/chat-receipts.js";
import type { MessageKey, MessageValues } from "../i18n/messages.js";
import styles from "./TicketsPage.module.css";

const DEV_LABEL: Record<string, MessageKey> = {
  open: "ticket.dev.open",
  landed: "ticket.dev.landed",
  cancelled: "ticket.dev.cancelled",
  completed: "ticket.dev.completed",
};
/** Every deployment state the server writes, so none reaches the page as a raw word. */
const DEP_LABEL: Record<string, MessageKey> = {
  pending: "ticket.dep.pending",
  deploying: "ticket.dep.deploying",
  app_live: "ticket.dep.app_live",
  live_unverified: "ticket.dep.live_unverified",
  verified: "ticket.dep.verified",
  reverted: "ticket.dep.reverted",
  not_needed: "ticket.dep.not_needed",
};
const KIND_LABEL: Record<string, MessageKey> = {
  simple: "ticket.kind.simple",
  complex: "ticket.kind.complex",
  app: "ticket.kind.app",
  discuss: "ticket.kind.discuss",
  cli: "ticket.kind.cli",
};
const KIND_FULL: Record<string, MessageKey> = {
  simple: "ticket.kindFull.simple",
  complex: "ticket.kindFull.complex",
  app: "ticket.kindFull.app",
  discuss: "ticket.kindFull.discuss",
  cli: "ticket.kindFull.cli",
};
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
type LocalizedText = { key: MessageKey; values?: MessageValues } | { raw: string };

function localizedText(
  value: LocalizedText,
  t: (key: MessageKey, values?: MessageValues) => string,
): string {
  return "raw" in value ? value.raw : t(value.key, value.values);
}
/** One page of the dev agent's session log, initial read and "load earlier" alike. */
const TRANSCRIPT_PAGE = 200;

/** The live tail resumes exactly where the loaded window ends. */
function liveUrlFor(id: number, win: TicketWindow): string {
  return `/api/tickets/${id}/live${query({
    from: win.offset + win.messages.length,
    frontier: clientFrontier(win.messages, win.offset),
  })}`;
}

/** The server's `err` frame carries `{"error": "…"}`; show its bounded sentence. */
function streamEndReason(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed?.error === "string") return parsed.error.slice(0, 200);
  } catch { /* A bare string is already the sentence. */ }
  return raw.slice(0, 200);
}

function Badge({ kind, value }: { kind: "dev" | "dep" | "kind"; value: string | undefined }) {
  const { t } = useMessages();
  if (!value) return null;
  const map = kind === "dev" ? DEV_LABEL : kind === "dep" ? DEP_LABEL : KIND_LABEL;
  const label = map[value] ? t(map[value]!) : value;
  return (
    <span
      className={`${styles.st} ${styles[`${kind}-${value}`] ?? ""}`}
      title={kind === "kind" ? (KIND_FULL[value] ? t(KIND_FULL[value]!) : value) : undefined}
    >
      {label}
    </span>
  );
}

/** Ticket message statuses the server answers before writing anything. */
const PRE_MUTATION_REFUSALS: readonly number[] = [400, 401, 403, 404, 413, 422];

export function TicketsPage() {
  const { language, t } = useMessages();
  const client = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const messageDraft = useBrowserDraft(selected === null ? null : `tickets:message:${selected}`);
  const nextEcho = useRef(0);
  const [sendEchoes, setSendEchoes] = useState<TicketSendEcho[]>([]);
  // Ticket #38-5: the sidebar has two "start something new" entry points now
  // (a full ticket vs. an open-ended discussion), so `composing` is a mode
  // string instead of a boolean.
  const [composing, setComposing] = useState<"ticket" | "discuss" | null>(null);
  // Ticket #201: a screenshot pasted into the answer box uploads and is
  // named in the message body, so "看这个" finally has a "这个" attached.
  const attachments = useAttachments(selected === null ? "none" : `ticket:${selected}`);
  const [sendStat, setSendStat] = useState<{ kind: "muted" | "ok" | "err"; text: LocalizedText } | null>(
    null,
  );
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDeploy, setConfirmDeploy] = useState(false);
  const [deployPin, setDeployPin] = useState<{ sha: string; manifestSha256: string } | null>(null);
  const [confirmAppPublish, setConfirmAppPublish] = useState(false);
  const [verifyFail, setVerifyFail] = useState<number | null>(null);
  const [verifyNotes, setVerifyNotes] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const compactLayout = useCompactChatViewport();

  const [win, setWin] = useState<TicketWindow>({
    messages: [],
    offset: 0,
    total: 0,
  });
  const [transcriptNote, setTranscriptNote] = useState<LocalizedText | null>({ key: "ticket.selectPrompt" });
  // A failed refresh after the transcript is on screen: the window stays
  // mounted and this says it may be behind, from when.
  const [transcriptStale, setTranscriptStale] = useState<{ text: LocalizedText; at: number } | null>(null);
  const transcriptLoadedAt = useRef(0);
  const [liveStopped, setLiveStopped] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [execution, setExecution] = useState<TicketExecution | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [starting, setStarting] = useState<{ since?: string } | null>(null);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);

  const roster = useQuery({
    queryKey: ["tickets", "list"],
    queryFn: () => api<Roster>("/api/tickets"),
    refetchInterval: pollInterval("/api/tickets", 10_000),
    refetchIntervalInBackground: false,
  });

  const detail = useQuery({
    queryKey: ["tickets", "detail", selected],
    enabled: selected !== null,
    queryFn: () =>
      api<{ ticket: Ticket; messages?: TicketMessage[] }>(`/api/tickets/${selected}`),
    refetchInterval: (query) => pollInterval("/api/tickets", query.state.data?.ticket.turn_started_at ? 1000 : 5000),
    refetchIntervalInBackground: false,
  });

  const deploy = useQuery({
    queryKey: ["deploy", "panel"],
    queryFn: () => api<DeployState>("/api/deploy"),
    refetchInterval: pollInterval("/api/deploy", 10_000),
    refetchIntervalInBackground: false,
  });

  const viewer = roster.data?.viewer;
  const ticket = detail.data?.ticket;
  const rosterTicket = roster.data?.tickets?.find((row) => row.id === ticket?.id);
  const isNative = ticket?.execution_owner === "native_cli";
  const queued = !isNative && !ticket?.turn_started_at && (rosterTicket?.unread ?? 0) > 0;
  const canComplete = !isNative && ticket?.dev_status === "open" && !ticket.turn_started_at && !queued
    && (!rosterTicket?.proposal || ["merged", "superseded"].includes(rosterTicket.proposal.status));
  const [, expireNativeObservation] = useState(0);
  useEffect(() => {
    if (!isNative || win.cliKind === "claude" || !win.runtime?.observed_at) return;
    const remaining = Date.parse(win.runtime.observed_at) + 10001 - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(() => expireNativeObservation(n => n + 1), remaining);
    return () => window.clearTimeout(timer);
  }, [isNative, win.cliKind, win.runtime]);
  const nativeState = nativeTicketControl(win.runtime, Boolean(ticket?.chat_paused || ticket?.dev_status === "completed" || ticket?.dev_status === "cancelled"),
    Date.now(), win.cliKind);
  const nativeCanSend = nativeTicketConnected(nativeState);
  const nativeLabel = nativeState === "working" ? uiText("原生 CLI 正在运行") : nativeState === "idle" ? uiText("原生 CLI 在线，等待输入")
    : nativeState === "needs_input" ? uiText("原生 CLI 正在等待本机确认：请先在终端处理权限或问题")
    : nativeState === "unknown" ? uiText("原生 CLI 已连接，当前状态未知")
    : nativeState === "closed" ? uiText("已结束网页跟踪") : uiText("原生 CLI 未连接，历史记录仍可查看");
  const executionLabel: MessageKey = ticket?.runtime_wait?.state === "reconnecting" ? "ticket.reconnecting"
    : ticket?.runtime_wait ? "ticket.waitingResource"
    : executionError ? "ticket.executionUnavailable"
    : execution?.state === "succeeded" ? "ticket.executionSucceeded"
    : execution?.state === "failed" ? "ticket.executionFailed"
    : execution?.state === "unknown" || execution?.state === "missing" ? "ticket.executionUnknown"
    : execution?.state === "running" && execution.input?.phase === "provider_accepted" ? "ticket.executionAccepted"
    : "ticket.turnRunning";

  // Every change in "which ticket the pane belongs to" — including a change
  // TO `null` when the reader opens the New / Discuss composer — goes through
  // `beginSelection` and bumps this counter. `loadTranscript` captures the
  // current value at entry and drops all state writes if it changes before
  // the fetch resolves, so a slow response for #44 never rewrites state that
  // already belongs to #45 or to the composer pane.
  //
  // The counter is a second layer of safety for the `/session` fetch — the
  // SSE subscription itself does not need one because `lib/sse.ts` gives every
  // effect its own `closed` token, invisibly to us, so a late frame from an
  // already-torn-down URL cannot reach any handler here.
  const generationRef = useRef(0);

  // Any OPEN conversation may grow (a queued message can start a turn at any
  // moment); landed/cancelled tickets only change when spoken to.
  const winRef = useRef(win);
  winRef.current = win;

  // One failed read (a restart, a device that blinked) must not unload a
  // transcript the reader is already looking at: keep the window and mark it
  // stale. Only a pane with nothing loaded shows the failure in its place.
  const showReadFailure = useCallback((text: LocalizedText) => {
    if (winRef.current.messages.length) setTranscriptStale({ text, at: transcriptLoadedAt.current || Number.NaN });
    else setTranscriptNote(text);
  }, []);

  const loadTranscript = useCallback(async (id: number, generation: number) => {
    if (generation !== generationRef.current) return;
    try {
      const data = await api<TicketSessionResponse>(
        `/api/tickets/${id}/session${query({ limit: TRANSCRIPT_PAGE })}`,
      );
      if (generation !== generationRef.current) return;
      setExecution(data.execution ?? null);
      setExecutionError(data.execution_error ?? null);
      const view = ticketSessionView(data);
      if (view.kind === "starting" || view.kind === "idle") {
        // A turn may well be running with nothing on disk yet — say so instead
        // of claiming the ticket has not started.
        setStarting(view.kind === "starting" ? { since: view.since } : null);
        setActivity(null);
        setWin({ messages: [], offset: 0, total: 0 });
        setTranscriptNote(
          data.transcript_notice ? { raw: data.transcript_notice }
            : { key: data.execution ? "ticket.transcriptConnecting"
              : view.kind === "starting" ? "ticket.agentStarting" : "ticket.notStarted" },
        );
        return;
      }
      setStarting(null);
      if (view.kind === "error") {
        setActivity(null);
        setWin(previous => ({ ...previous, runtime: null }));
        showReadFailure({ raw: view.message });
        return;
      }
      // An empty window still renders through the chat shell, which owns the
      // "(会话尚无内容)" line — the note is only for states without a window.
      setWin(view.window);
      setTranscriptNote(null);
      setTranscriptStale(null);
      transcriptLoadedAt.current = Date.now();
      setActivity(view.activity);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setWin(previous => ({ ...previous, runtime: null }));
      setActivity(null);
      setStarting(null);
      const body = err instanceof ApiError ? err.body as TicketSessionResponse | null : null;
      setExecution(body?.execution ?? null);
      setExecutionError(body?.execution_error ?? null);
      showReadFailure({ raw: errorText(err) });
    }
  }, [showReadFailure]);

  // "加载更早" pages the window backwards. The generation guard is the same one
  // every other transcript write passes: a page that comes back after the
  // reader switched tickets merges into nothing.
  const [loadOlder, loadingOlder] = useAction(async () => {
    const prev = winRef.current;
    if (selected === null || prev.offset <= 0) return;
    const generation = generationRef.current;
    const take = Math.min(TRANSCRIPT_PAGE, prev.offset);
    try {
      const page = await api<TicketSessionResponse>(
        `/api/tickets/${selected}/session${query({ offset: prev.offset - take, limit: take })}`,
      );
      if (generation !== generationRef.current) return;
      if (!page.pending && !page.error) setWin(mergeOlder(winRef.current, page));
    } catch {
      // The window is unchanged and the button stays enabled; retry is manual.
    }
  });
  useEffect(() => {
    if (
      !ticket?.session_id
      || selected === null
      || (ticket.execution_owner === "native_cli" ? Boolean(ticket.chat_paused || ticket.dev_status === "completed" || ticket.dev_status === "cancelled")
        : ticket.dev_status !== "open" && !ticket.turn_started_at)
    ) {
      setLiveUrl(null);
      return;
    }
    setLiveStopped(null);
    setLiveUrl(liveUrlFor(selected, winRef.current));
    // Re-subscribing on every window change would tear the connection down on
    // every delta; the cursor is only recomputed when the ticket, session or
    // authoritative turn marker changes.
  }, [selected, ticket?.session_id, ticket?.dev_status, ticket?.turn_started_at, ticket?.execution_owner, ticket?.chat_paused]);

  const liveStatus = useEventSource(liveUrl, {
    // A reconnect the hook opens itself resumes from the window as it is now.
    ...(selected !== null ? { reconnectUrl: () => liveUrlFor(selected, winRef.current) } : {}),
    events: {
      delta: (data) => {
        // `lib/sse.ts` has already dropped late frames that belonged to a
        // torn-down URL (each subscription has its own `closed` token). By
        // the time this runs, the reader is still on the ticket this stream
        // was opened for; no second guard is needed here.
        const delta = data as {
          from: number;
          messages: RichMessage[];
          total: number;
          activity?: Activity;
          runtime?: import("@claude-bot/agent-sessions-contract").AgentRuntime | null;
        };
        // Decided outside the updater: an updater can run twice for one update
        // (StrictMode does), and reloading the transcript twice is a real cost.
        const prev = winRef.current;
        if (delta.from < prev.offset || delta.from > prev.offset + prev.messages.length) {
          if (selected !== null) void loadTranscript(selected, generationRef.current);
          return;
        }
        const messages = prev.messages.slice(0, delta.from - prev.offset).concat(delta.messages);
        setWin({ ...prev, messages, total: delta.total,
          ...(delta.runtime !== undefined ? { runtime: delta.runtime } : {}) });
        setActivity(deriveActivity({ activity: delta.activity ?? null }, messages));
        setTranscriptNote(null);
        setTranscriptStale(null);
        transcriptLoadedAt.current = Date.now();
      },
    },
    // The server ended the stream on purpose; it is not reopened, and the
    // reader is told why instead of the chip silently disappearing.
    onFatal: (message) => {
      setLiveUrl(null);
      setLiveStopped(streamEndReason(message));
      setWin(previous => ({ ...previous, runtime: null }));
    },
  });

  // Either half can arrive first: Claude publishes a preallocated session id
  // before its turn marker, while Codex publishes thread.started after the
  // marker. Treat both transitions as transcript wake-ups. This also performs
  // a final read when a turn clears its liveness marker.
  const transcriptWakeKey = ticketTranscriptWakeKey(ticket?.session_id, ticket?.turn_started_at);
  useEffect(() => {
    if (selected === null || !transcriptWakeKey) return;
    void loadTranscript(selected, generationRef.current);
  }, [selected, transcriptWakeKey, loadTranscript]);

  // While the CLI has started but its transcript file is not readable yet,
  // retry at the same cadence as the server tailer. The previous effect retried
  // immediately on every `setStarting({…})`, creating a render/fetch loop; a
  // paced interval bridges process startup without hammering the route.
  const awaitingFirstLog = Boolean(starting);
  useEffect(() => {
    if (selected === null || !awaitingFirstLog) return;
    const timer = window.setInterval(() => {
      void loadTranscript(selected, generationRef.current);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [selected, awaitingFirstLog, loadTranscript]);

  /**
   * The single point through which selection identity may change.
   *
   * Any place that used to write `setSelected(x)` on its own — the sidebar row,
   * yes, but ALSO the New / Discuss buttons that put `selected` back to `null`
   * — has to come through here. Otherwise a slow /session response from before
   * the change would find `generationRef.current` unchanged, decide it was
   * still current, and quietly write the old ticket's transcript into the pane
   * that is now showing the composer. Bumping on every identity change
   * (including to `null`) is the property the guard depends on.
   *
   * Returns the new generation so a caller can pass it to `loadTranscript`
   * without a second read of the ref.
   */
  const beginSelection = useCallback((id: number | null): number => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setSelected(id);
    setSendStat(null);
    setActionError(null);
    setLiveUrl(null);
    setLiveStopped(null);
    setTranscriptStale(null);
    setExecution(null);
    setExecutionError(null);
    setStarting(null);
    setActivity(null);
    setWin({ messages: [], offset: 0, total: 0 });
    setTranscriptNote({ key: id === null ? "ticket.selectPrompt" : "ticket.reading" });
    return generation;
  }, []);

  const openTicket = useCallback((id: number) => {
    setComposing(null);
    const generation = beginSelection(id);
    const summary = roster.data?.tickets?.find((candidate) => candidate.id === id);
    if (summary?.kind === "cli" && summary.execution_owner !== "native_cli") {
      setTranscriptNote(null);
      return;
    }
    void loadTranscript(id, generation);
  }, [beginSelection, loadTranscript, roster.data?.tickets]);

  const openComposer = useCallback((mode: "ticket" | "discuss") => {
    // Toggling the composer off keeps the "nothing selected" branch and
    // therefore still needs a fresh generation — otherwise a late /session
    // response from the ticket we just left would land on a blank pane.
    setComposing((current) => current === mode ? null : mode);
    beginSelection(null);
  }, [beginSelection]);

  const [sendMessage, sending] = useAction(async () => {
    if (!messageDraft.text.trim() || selected === null || (isNative && (!mayManage || !nativeCanSend))) return;
    const generation = generationRef.current;
    const key = ++nextEcho.current;
    const updateEcho = (patch: Partial<ChatSendReceipt> & { messageId?: number; source?: TicketMessage }) => {
      // Outcomes belong to this immutable echo/ticket identity, even if its
      // page is no longer selected. They cannot mutate the new page's draft.
      setSendEchoes((rows) => rows.map((row) => row.key === key ? { ...row, ...patch } : row));
    };
    setSendEchoes((rows) => [...rows, { key, ticketId: selected, prompt: messageDraft.text.trim(), phase: "sending" as const, after: win.offset + win.messages.length, created_at: new Date().toISOString() }].slice(-20));
    setSendStat({ kind: "muted", text: { key: "ticket.sending" } });
    try {
      await attachments.ready();
    } catch (err) {
      updateEcho({ phase: "failed", message: errorText(err) });
      if (generation === generationRef.current) setSendStat({ kind: "err", text: { raw: errorText(err) } });
      return;
    }
    if (generation !== generationRef.current) { updateEcho({ phase: "failed", message: uiText("发送前已切换工单，消息仍在原输入框。") }); return; }
    const submission = messageDraft.beginSubmission();
    const completeAttachments = attachments.markSubmission();
    const text = submission?.text.trim();
    if (!text) { messageDraft.restoreSubmission(submission); setSendStat(null); setSendEchoes((rows) => rows.filter((row) => row.key !== key)); return; }
    try {
      const response = await api<{ message: TicketMessage }>(`/api/tickets/${selected}/message`, {
        method: "POST",
        json: { body: attachments.compose(text) },
      });
      messageDraft.completeSubmission(submission);
      const received = { ...response.message, body: response.message.body ?? text };
      updateEcho({ ...messageReceipt(received), messageId: received.id, source: received });
      if (generation === generationRef.current) {
        completeAttachments();
        setSendStat(null);
      }
      await client.invalidateQueries({ queryKey: ["tickets"] });
    } catch (err) {
      // Only authoritative pre-mutation refusals permit restoring a submitted draft.
      // 400 (invalid body) and 413 (over the prompt budget) are answered before
      // anything is written, so they are refusals too, not "may have arrived".
      const refused = err instanceof ApiError && PRE_MUTATION_REFUSALS.includes(err.status);
      if (refused) messageDraft.restoreSubmission(submission);
      updateEcho({ phase: refused ? "refused" : "uncertain", message: errorText(err) });
      if (generation === generationRef.current) setSendStat({ kind: "err", text: { raw: `✖ ${errorText(err)}` } });
    }
  });

  const [runAction, actionBusy] = useAction(
    async (action: string, payload: Record<string, unknown>) => {
      if (selected === null) return;
      const generation = generationRef.current;
      setActionError(null);
      try {
        await api(`/api/tickets/${selected}/${action}`, { method: "POST", json: payload });
      } catch (err) {
        if (generation === generationRef.current) setActionError(errorText(err));
      }
      if (generation === generationRef.current) setConfirmCancel(false);
      await client.invalidateQueries({ queryKey: ["tickets"] });
    },
  );

  /**
   * Ticket #184: stop the turn that is running, and nothing else.
   *
   * Kept off `runAction` on purpose. That helper is the lifecycle bar, where
   * every button disables every other one — but this control's whole point is
   * to be pressable at the moment somebody is watching the agent go wrong, and
   * its own pending state is the only one that should show.
   *
   * The button does not disappear on success: `turn_started_at` clears when the
   * CLI has actually stopped, which is the honest signal, and the poll a second
   * later is what removes the row.
   */
  const [interruptTurn, interrupting] = useAction(async () => {
    if (selected === null) return;
    const generation = generationRef.current;
    setActionError(null);
    try {
      await api(`/api/tickets/${selected}/interrupt`, { method: "POST", json: {} });
      if (generation === generationRef.current) setSendStat({ kind: "muted", text: { key: "ticket.interruptRequested" } });
    } catch (err) {
      if (generation === generationRef.current) setActionError(errorText(err));
    }
    await client.invalidateQueries({ queryKey: ["tickets"] });
  });

  const [triggerDeploy, deploying] = useAction(async () => {
    deploymentRequested(0);
    setConfirmDeploy(false);
    setDeployError(null);
    try {
      const result = await api<{ intent: { id: number; detail?: string | null } }>("/api/deploy", { method: "POST", json: deployPin ? { target: deployPin.sha, manifest_sha256: deployPin.manifestSha256 } : {} });
      deploymentRequested(result.intent.id);
      // e.g. the knowledge review could not run: the deployment proceeds, but say so.
      if (result.intent.detail) setDeployError(result.intent.detail);
    } catch (err) {
      deploymentRequested(null);
      setDeployError(errorText(err));
    }
    await client.invalidateQueries({ queryKey: ["deploy"] });
  });

  const [checkUpdates, checkingUpdates] = useAction(async () => {
    setDeployError(null);
    try { await api("/api/deploy/check", { method: "POST", json: {} }); }
    catch (err) { setDeployError(errorText(err)); }
    await client.invalidateQueries({ queryKey: ["deploy"] });
  });

  const [publishPendingApps, publishingApps] = useAction(async () => {
    setConfirmAppPublish(false);
    setDeployError(null);
    try {
      await api("/api/apps/publish-pending", { method: "POST", json: {} });
    } catch (err) {
      setDeployError(errorText(err));
    }
    await Promise.all([
      client.invalidateQueries({ queryKey: ["deploy"] }),
      client.invalidateQueries({ queryKey: ["tickets"] }),
    ]);
  });

  // Once a decision has been submitted for an intent id, hide the two buttons
  // right away — the poll cycle needs a couple of seconds to reflect that the
  // supervisor has left `confirm_wait`, and until then the local `active`
  // object still says `confirm_wait`. Without this a second click reproduces
  // the "已经确认过" 409 from the server, which reads as "your click did
  // nothing" (ticket #38-1). Cleared whenever the poll finally returns a
  // different intent id or leaves `confirm_wait`.
  const [decidedIntent, setDecidedIntent] = useState<{
    id: number;
    decision: "alive" | "rollback";
  } | null>(null);
  const [confirmDeployDecision, confirming] = useAction(
    async (id: number, decision: "alive" | "rollback") => {
      setDeployError(null);
      setDecidedIntent({ id, decision });
      try {
        await api("/api/deploy/confirm", { method: "POST", json: { intent_id: id, decision } });
      } catch (err) {
        setDeployError(errorText(err));
        setDecidedIntent(null);
      }
      await client.invalidateQueries({ queryKey: ["deploy"] });
    },
  );

  useEffect(() => {
    if (!decidedIntent) return;
    const active = deploy.data?.active;
    if (!active || active.id !== decidedIntent.id || active.status !== "confirm_wait") {
      setDecidedIntent(null);
    }
  }, [deploy.data?.active, decidedIntent]);

  const [resolveVerify, verifying] = useAction(
    async (id: number, result: "passed" | "failed", notes: string) => {
      setDeployError(null);
      try {
        await api(`/api/verify/${id}`, { method: "POST", json: { result, notes } });
      } catch (err) {
        setDeployError(errorText(err));
      }
      setVerifyFail(null);
      setVerifyNotes("");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["deploy"] }),
        client.invalidateQueries({ queryKey: ["tickets"] }),
      ]);
    },
  );

  const now = useNow(Boolean(liveUrl));
  const mayManage = Boolean(
    ticket && viewer && (viewer.admin || viewer.username === ticket.requester),
  );
  const liveActivity = ticket?.turn_started_at ? activity : null;
  // `language`: receipt authors carry a localized provenance label.
  const receiptState = useMemo(() => ticketChatReceipts(
    detail.data?.messages ?? [], sendEchoes.filter((entry) => entry.ticketId === selected), win,
  ), [detail.data?.messages, sendEchoes, selected, win, language]);
  // Once observed, an echo must not reappear when the log window moves on.
  useEffect(() => {
    if (!receiptState.observedEchoes.length) return;
    setSendEchoes((rows) => rows.filter((row) => !receiptState.observedEchoes.includes(row.key)));
  }, [receiptState.observedEchoes]);
  const receiptRows = receiptState.rows;
  const sessionWindow = useMemo(() => transcriptWindowOf(win, activity), [win, activity]);
  const openDeployConfirm = useCallback(() => {
    setDeployPin(deploy.data?.releases?.deployable ?? null);
    setConfirmDeploy(true);
  }, [deploy.data?.releases?.deployable]);
  const openAppPublishConfirm = useCallback(() => setConfirmAppPublish(true), []);
  const handleConfirmDeploy = useCallback(
    (id: number, decision: "alive" | "rollback") => {
      void confirmDeployDecision(id, decision);
    },
    [confirmDeployDecision],
  );
  const verifyDeploy = useCallback(
    (id: number, result: "passed" | "failed") => {
      if (result === "failed") setVerifyFail(id);
      else void resolveVerify(id, "passed", "");
    },
    [resolveVerify],
  );

  /*
    Ticket #201: the agent's own unanswered question, rendered from the ticket
    row rather than found in the transcript because that is the whole failure
    it fixes — the sentence existed, in a conversation nobody had a reason to
    reopen.

    Ticket #236 adds the way out of it. Answering was the only exit, so a
    question the reader did not want to answer sat on a landed ticket forever:
    cancel is refused after landing, and typing "不用管了" wakes a whole turn
    to say so. It is a shared element because a CLI report has no composer to
    sit above — a repair route can park a question there too.
  */
  const openQuestionNote = ticket?.open_question ? (
    <p className={styles.openQuestion} role="note">
      <b>{t("ticket.questionWaiting")}</b>{ticket.open_question}
      {mayManage ? (
        <UiButton
          className={styles.dismissQuestion}
          disabled={actionBusy}
          title={t("ticket.questionDismissTitle")}
          onClick={() => void runAction("dismiss-question", {})}
        >
          {t("ticket.questionDismiss")}
        </UiButton>
      ) : null}
    </p>
  ) : null;

  const [fileTarget, setFileTarget] = useState<(FileReference & { ticketId: number }) | null>(null);
  const openFile = useCallback((file: FileReference) => {
    if (selected !== null) setFileTarget({ ...file, ticketId: selected });
  }, [selected]);

  const agentTranscript = selected !== null && ticket ? (
    <div className={styles.transcriptArea} id="ticket-agent-transcript">
      <div><UiButton onClick={() => openFile({ path: "" })}>{uiText("浏览源码")}</UiButton></div>
      {transcriptStale && !transcriptNote ? (
        <StaleDataBanner message={localizedText(transcriptStale.text, t)} dataUpdatedAt={transcriptStale.at} />
      ) : null}
        <SessionChat
          className={styles.transcript}
          domIdScope="ticket"
          resource={`${selected}:${ticket.session_id ?? ""}`}
          data={transcriptNote ? null : sessionWindow}
          loadingText={transcriptNote ? localizedText(transcriptNote, t) : undefined}
          tail={receiptRows.map((entry) => (
            <div key={entry.key} data-ticket-input={entry.key}>
              <SendReceipt entry={entry.receipt} classes={DASHBOARD_CHAT_CLASSES} text={uiText}
                onRestore={() => { if (!messageDraft.text.trim()) messageDraft.set(entry.receipt.prompt); }}
                {...(entry.echo !== undefined ? { onDismiss: () => setSendEchoes((rows) => rows.filter((row) => row.key !== entry.echo)) } : {})} />
            </div>
          ))}
          busy={loadingOlder}
          emptyText={t("ticket.emptyTranscript")}
          chip={
            liveUrl ? (
              // The chip states what the connection IS: following only while
              // the stream is open, otherwise connecting or reconnecting.
              <span className={`small ${liveStatus === "open" ? styles.liveOn : styles.liveOff}`}
                data-live-status={liveStatus}>
                {liveStatus === "open"
                  ? activityStatusText(liveActivity, now, language)
                    ? t("ticket.liveStatus", { status: activityStatusText(liveActivity, now, language) })
                    : t("ticket.liveFollowing")
                  : liveStatus === "reconnecting" ? t("ticket.liveReconnecting")
                  : liveStatus === "closed" ? t("ticket.liveStopped", { reason: liveStopped ?? "" })
                  : t("ticket.liveConnecting")}
              </span>
            ) : liveStopped ? (
              <span className={`small ${styles.liveOff}`} data-live-status="closed">
                {t("ticket.liveStopped", { reason: liveStopped })}
              </span>
            ) : null
          }
          onLoadOlder={() => void loadOlder()}
        />
    </div>
  ) : null;

  return (
    <MarkdownFileLinks.Provider value={openFile}>
    <div className={styles.root}>
      <ShellPageActions>
        <HardRefreshAction className={styles.topRefresh} draftAtRisk={Boolean(messageDraft.text.trim())} />
      </ShellPageActions>
      <SplitPane id="tickets" className={styles.cols}>
        <SplitPanel defaultSize={28} minSize={16} maxSize={48} className={styles.side}>
          {/* The Panel keeps the library's inline `overflow: hidden`; scrolling
              lives on this inner wrapper so the whole sidebar scrolls to the
              bottom of the list (the anti-pattern was `overflow-y` on the Panel
              class itself, which the inline style silently overrode). */}
          <TicketSidebar
            roster={roster.data}
            rosterPending={roster.isPending}
            rosterError={roster.isError ? errorText(roster.error) : undefined}
            deploy={deploy.data}
            deployError={deployError ?? undefined}
            selected={selected}
            deployBusy={deploying || publishingApps || confirming || verifying}
            deploying={deploying}
            publishingApps={publishingApps}
            decidedIntent={decidedIntent}
            onTriggerDeploy={openDeployConfirm}
            onCheckUpdates={() => void checkUpdates()}
            checkingUpdates={checkingUpdates}
            onPublishApps={openAppPublishConfirm}
            onConfirmDeploy={handleConfirmDeploy}
            onVerify={verifyDeploy}
            onOpenComposer={openComposer}
            onOpenTicket={openTicket}
          />
        </SplitPanel>
        <SplitHandle label={t("ticket.sidebarResize")} />
        <SplitPanel defaultSize={72} minSize={40} className={styles.main}>
          {composing === "ticket" ? (
            <div className={styles.mainScroll}>
              <NewTicketPane
                roster={roster.data}
                onCancel={() => setComposing(null)}
                onCreated={async (id) => {
                  setComposing(null);
                  await client.invalidateQueries({ queryKey: ["tickets"] });
                  openTicket(id);
                }}
              />
            </div>
          ) : composing === "discuss" ? (
            <div className={styles.mainScroll}>
              <NewDiscussPane
                roster={roster.data}
                onCancel={() => setComposing(null)}
                onCreated={async (id) => {
                  setComposing(null);
                  await client.invalidateQueries({ queryKey: ["tickets"] });
                  openTicket(id);
                }}
              />
            </div>
          ) : selected === null ? (
            <div className={styles.mainScroll}>
              <div className={styles.placeholder}>{t("ticket.selectPrompt")}</div>
            </div>
          ) : detail.isPending ? (
            <div className={styles.mainScroll}>
              <Loading what={t("ticket.reading")} />
            </div>
          ) : !ticket ? (
            <div className={styles.mainScroll}>
              {detail.error ? <ErrorBox>{errorText(detail.error)}</ErrorBox> : <Loading what={t("ticket.reading")} />}
            </div>
          ) : (
            <div className={styles.detail}>
              {detail.error && (
                <StaleDataBanner
                  message={errorText(detail.error)}
                  dataUpdatedAt={detail.dataUpdatedAt}
                />
              )}
              <div className={styles.thead}>
                <div className={styles.ticketSummary}>
                  <div className={styles.ttitle}>
                    #{ticket.id} {ticket.title}
                  </div>
                  <div className={styles.summaryBadges} aria-label={t("ticket.status")}>
                    {isNative ? <span className={styles.st}>{uiText("原生 CLI")}</span> : <Badge kind="kind" value={ticket.kind} />}
                    {isNative && ticket.dev_status !== "landed" ? <span className={styles.st}>{nativeLabel}</span> : <Badge kind="dev" value={ticket.dev_status} />}
                    <Badge kind="dep" value={ticket.deploy_status} />
                  </div>
                </div>
                {queued ? <p role="status" className={styles.tmeta}>{t("ticket.queueReason", {
                  running: roster.data?.counts?.running ?? 0,
                  limit: roster.data?.spec_concurrency ?? "?",
                })}</p> : null}
                <div className={styles.ticketInfo}>
                  <div className={styles.ticketInfoBody}>
                    <div className={styles.tmeta}>
                      {ticket.kind === "app" && ticket.app_id ? (
                        <span title={t("ticket.appScope")}>📦 {ticket.app_id} </span>
                      ) : null}
                      {ticket.kind === "cli" ? (
                        <>{t("ticket.acceptor", { name: ticket.requester })}</>
                      ) : (
                        <>{t("ticket.requester", {
                          name: ticket.requester,
                          model: ticketModelLabel(ticket.model, roster.data?.model_catalog, ticket.codex_account_label),
                          effort: ticket.effort,
                        })}</>
                      )}
                      {actorKindLabel(ticket.actor_kind) ? (
                        <span data-testid="ticket-actor-kind" title={actorKindHint()}> · {actorKindLabel(ticket.actor_kind)}</span>
                      ) : null}
                      {ticket.branch ? ` · ⎇ ${ticket.branch}` : ""}
                      {ticket.parent_ticket_id ? t("ticket.parent", { id: ticket.parent_ticket_id }) : ""}
                      {ticket.commit_sha ? (
                        <span title={ticket.commit_sha}> · {ticket.commit_sha.slice(0, 10)}</span>
                      ) : null}
                      {ticket.knowledge_subject_id ? (
                        <>
                          {" · "}
                          <a href={`/knowledge?v=review&tab=conflicts&conflict=${encodeURIComponent(ticket.knowledge_subject_id)}`}>
                            {t("ticket.knowledgeConflict", { id: ticket.knowledge_subject_id })}
                          </a>
                        </>
                      ) : null}
                    </div>
                    {ticket.kind !== "cli" && ticket.execution_owner !== "native_cli" && (
                      <div className={styles.tmeta} data-testid="ticket-execution-placement">
                        {ticket.execution_placement ? <>
                          {t("ticket.modelSource", {
                            device: ticket.execution_placement.model_device,
                            agent: ticket.execution_placement.source === "codex"
                              ? ticket.execution_placement.account_label
                                ? codexAccountDisplayLabel(ticket.execution_placement.account_label)
                                : `Codex · ${t(ticket.execution_placement.account_label === ""
                                  ? "ticket.defaultAccount" : "ticket.unknownAccount")}`
                              : ticket.execution_placement.source === "claude" ? "Claude" : "OMP",
                          })}
                          {" · "}
                          {t("ticket.toolRunner", { device: ticket.execution_placement.execution_device })}
                        </> : t("ticket.placementUnknown")}
                      </div>
                    )}
                    {/* The review lane's state line (2026-08-20): where this
                        ticket's candidate is, with the CI and MR links. Shown
                        for every review-lane ticket — "not yet submitted" is a
                        state the contributor needs to see too. */}
                    {ticket.lane === "review" || ticket.proposal ? (
                      <div className={styles.tmeta} data-testid="ticket-proposal">
                        <span title={t("ticket.reviewLaneHint")}>{t("ticket.reviewLane")}</span>
                        {ticket.proposal && ticket.proposal.status !== "superseded" ? (
                          <>
                            {" · "}
                            {PROPOSAL_KEY[ticket.proposal.status]
                              ? t(PROPOSAL_KEY[ticket.proposal.status]!)
                              : (PROPOSAL_LABEL[ticket.proposal.status] ?? { label: ticket.proposal.status }).label}
                            {t("ticket.proposal", { id: ticket.proposal.id })}{" "}
                            <span title={ticket.proposal.sha}>{ticket.proposal.sha.slice(0, 10)}</span>
                            {ticket.proposal.pipeline_url ? (
                              <>
                                {" · "}
                                <a href={ticket.proposal.pipeline_url} target="_blank" rel="noreferrer">
                                  CI
                                </a>
                              </>
                            ) : null}
                            {ticket.proposal.mr_url ? (
                              <>
                                {" · "}
                                <a href={ticket.proposal.mr_url} target="_blank" rel="noreferrer">
                                  MR
                                </a>
                              </>
                            ) : null}
                            {ticket.proposal.review_note
                              ? ` · ${ticket.proposal.review_by ?? ""}:${ticket.proposal.review_note}`
                              : ""}
                          </>
                        ) : (
                          t("ticket.reviewNotSubmitted")
                        )}
                      </div>
                    ) : null}
                    {mayManage ? (
                      <div className={styles.actions}>
                        {!isNative && ticket.dev_status === "open" ? (
                          <>
                            <UiButton
                              disabled={actionBusy}
                              onClick={() =>
                                void runAction("kind", {
                                  // discuss → simple: converts an open-ended chat into
                                  // a "no questions, just do it" ticket. The agent
                                  // keeps the same session; the next turn's intro
                                  // switches to the simple contract. discuss and
                                  // simple both allow submit, so this is a widen of
                                  // discipline, not of capability.
                                  kind:
                                    ticket.kind === "simple"
                                      ? "complex"
                                      : ticket.kind === "discuss"
                                        ? "simple"
                                        : "simple",
                                })
                              }
                            >
                              {/* An app ticket demotes to `complex`, which drops its
                                  path allowlist AND its automatic republish. Saying
                                  so on the button is the difference between a widen
                                  and a surprise. */}
                              {t("ticket.changeTo")}
                              {ticket.kind === "app"
                                ? t("ticket.change.app")
                                : ticket.kind === "simple"
                                  ? t("ticket.change.simple")
                                  : ticket.kind === "discuss"
                                    ? t("ticket.change.discuss")
                                    : t("ticket.change.default")}
                            </UiButton>
                            {!compactLayout && canComplete ? <UiButton disabled={actionBusy} title={t("ticket.completeTitle")}
                              onClick={() => void runAction("complete", {})}>{t("ticket.complete")}</UiButton> : null}
                            <UiButton className="danger" onClick={() => setConfirmCancel(true)}>
                              {t("ticket.cancel")}
                            </UiButton>
                          </>
                        ) : null}
                        {ticket.deploy_status === "pending" ? (
                          <UiButton
                            disabled={actionBusy}
                            onClick={() => void runAction("deploy-mark", { next: "live_unverified" })}
                          >
                            {t("ticket.manualLive")}
                          </UiButton>
                        ) : null}
                        {ticket.deploy_status === "live_unverified" ? (
                          <>
                            <UiButton
                              className="primary"
                              disabled={actionBusy}
                              onClick={() => void runAction("deploy-mark", { next: "verified" })}
                            >
                              {t("ticket.verifyPassed")}
                            </UiButton>
                            <UiButton
                              className="danger"
                              disabled={actionBusy}
                              onClick={() => void runAction("deploy-mark", { next: "reverted" })}
                            >
                              {t("ticket.reverted")}
                            </UiButton>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
                {ticket.runtime_wait && !ticket.chat_paused ? (
                  <div role="status" data-testid="ticket-resource-wait">
                    {t(ticket.runtime_wait.state === "reconnecting" ? "ticket.reconnectingDetail" : "ticket.waitingResourceDetail",
                      { resource: ticket.runtime_wait.resource.replace(/^runner:/, "") })}
                  </div>
                ) : null}
                {ticket.error ? <ErrorBox>{ticket.error}</ErrorBox> : null}
                {actionError ? <ErrorBox>{actionError}</ErrorBox> : null}
              </div>

              {ticket.spec && ticket.kind !== "cli" ? (
                <details className={styles.spec}>
                  <summary>{t("ticket.legacySpec")}</summary>
                  {/* Its own scroll region: a long spec must not push the
                      conversation and composer off the pane. */}
                  <div className={styles.specBody}>
                    <Markdown>{ticket.spec}</Markdown>
                  </div>
                </details>
              ) : null}

              {ticket.kind === "cli" && ticket.execution_owner !== "native_cli" ? (
                <>
                  <section className={styles.cliReport} aria-label={t("ticket.cliReport")}>
                    <div className={styles.cliReportHead}>
                      <strong>⌨ {t("ticket.cliReport")}</strong>
                      <span>{t("ticket.cliReadonly")}</span>
                      <UiButton onClick={() => openFile({ path: "" })}>{uiText("浏览源码")}</UiButton>
                    </div>
                    <p>{uiText("这是未绑定会话的交付记录，不是运行中的 Agent。开发时可在本地显式注册原生 CLI，以查看会话并交互。")}</p>
                    <Markdown>{ticket.body || t("ticket.cliMissing")}</Markdown>
                  </section>
                  {/* A CLI report has no composer, so its question would
                      otherwise be un-closeable and unreadable at once. */}
                  {openQuestionNote}
                </>
              ) : (
                <>
                  {agentTranscript}
                  <div className={styles.sendBox}>
                {/* One line, present only while there is a turn to stop, so
                    the box keeps its geometry on a phone. `turn_started_at`
                    is the pipeline's own liveness marker — the same fact the
                    activity strip trusts — so this never offers to stop a
                    turn that has already ended. */}
                {ticket.execution_owner === "native_cli" || ticket.turn_started_at || ticket.runtime_wait || ticket.chat_paused || execution || executionError ? (
                  <div className={styles.turnStop} role="status">
                    <span className={styles.turnStopLabel}>{isNative ? nativeLabel : ticket.chat_paused
                      ? uiText(ticket.turn_started_at ? "正在停止，后续消息将保留" : "已暂停，消息和会话已保留")
                      : t(executionLabel)}</span>
                    {(isNative ? nativeState === "working" : ticket.turn_started_at || ticket.runtime_wait) && mayManage ? (
                    <UiButton
                      className={styles.turnStopAction}
                      disabled={interrupting || Boolean(ticket.chat_paused)}
                      title={t("ticket.interruptTitle")}
                      onClick={() => void interruptTurn()}
                    >
                      {interrupting ? t("ticket.stopping") : compactLayout ? t("ticket.stop") : t("ticket.stopTurn")}
                    </UiButton>) : null}
                  </div>
                ) : null}
                {!isNative && !ticket.chat_paused && executionLabel === "ticket.executionUnknown" ? (
                  <p className={styles.executionHint} role="note">{t("ticket.executionUnknownHint")}</p>
                ) : null}
                {!isNative && ticket.chat_paused && mayManage ? (
                  <div className={styles.turnStop}>
                    <span>{uiText("未发送的消息会在继续时处理，无需重新发送。")}</span>
                    <UiButton disabled={actionBusy || Boolean(ticket.turn_started_at)} onClick={() => void runAction("resume", {})}>
                      {uiText("继续")}
                    </UiButton>
                  </div>
                ) : null}
                {/* Above the box it has to be answered in — see the note
                    beside `openQuestionNote`. */}
                {openQuestionNote}
                <label className="srOnly" htmlFor="ticket-message">
                  {t("ticket.messageLabel")}
                </label>
                <UiTextArea
                  id="ticket-message"
                  disabled={isNative && (!mayManage || !nativeCanSend)}
                  value={messageDraft.text}
                  autoSize={compactLayout ? { minRows: 2, maxRows: 6 } : undefined}
                  onChange={(event) => messageDraft.set(event.target.value)}
                  onKeyDown={(event) => handleModifierSubmitKeyDown(event, () => void sendMessage())}
                  onPaste={attachments.onPaste}
                  placeholder={compactLayout ? t("ticket.placeholderCompact") : t("ticket.placeholderWide")}
                />
                <AttachmentStrip draft={attachments} />
                <div className={styles.row}>
                  {/* Ticket #190: the phone layout hides `.ticketInfo`, and with
                      it the whole lifecycle bar — so a ticket the agent has
                      handed back ("🙋 等你回复") could be answered from a phone
                      but never ended there. This is the same `cancel` action
                      behind the same confirmation, placed where the reader
                      already is. The wide layout keeps its own button and does
                      not need a second one. */}
                  {compactLayout && mayManage && canComplete ? <UiButton disabled={actionBusy}
                    title={t("ticket.completeTitle")} onClick={() => void runAction("complete", {})}>
                    {t("ticket.complete")}
                  </UiButton> : null}
                  {isNative && mayManage && nativeState !== "closed" ? <UiButton disabled={actionBusy}
                    title={uiText("仅结束网页跟踪，不停止本地 CLI；重新注册可恢复跟踪。")}
                    onClick={() => void runAction("close-native", {})}>{uiText("结束跟踪")}</UiButton> : null}
                  {compactLayout && !isNative && mayManage && ticket.dev_status === "open" ? (
                    <UiButton
                      tone="danger"
                      className={styles.closeAction}
                      disabled={actionBusy}
                      title={t("ticket.closeTitle")}
                      onClick={() => setConfirmCancel(true)}
                    >
                      {t("ticket.close")}
                    </UiButton>
                  ) : null}
                  <UiButton
                    className="primary"
                    disabled={sending || (isNative && (!mayManage || !nativeCanSend))}
                    onClick={() => void sendMessage()}
                  >
                    {t("ticket.send")}
                  </UiButton>
                </div>
                {sendStat ? (
                  <div className={styles.sendStatus}>
                    <Status kind={sendStat.kind}>{localizedText(sendStat.text, t)}</Status>
                  </div>
                ) : null}
                  </div>
                </>
              )}
            </div>
          )}
        </SplitPanel>
      </SplitPane>

      {fileTarget && fileTarget.ticketId === selected && <TicketFiles
        key={selected}
        ticketId={selected}
        target={fileTarget}
        onOpen={openFile}
        onClose={() => setFileTarget(null)}
      />}
      <Confirm
        open={confirmCancel}
        title={t("ticket.cancelTitle")}
        destructive
        confirmLabel={t("ticket.cancelTitle")}
        busy={actionBusy}
        body={t("ticket.cancelBody", { id: selected ?? "" })}
        onConfirm={() => void runAction("cancel", {})}
        onCancel={() => setConfirmCancel(false)}
      />
      <Confirm
        open={confirmDeploy}
        title={t("ticket.deployTitle")}
        confirmLabel={t("ticket.deployConfirm")}
        busy={deploying}
        body={deployPin ? `${uiText("上线下面已准备好的发行版？服务将短暂重启；启动检查失败会自动恢复。此版本包含的 App 会同步发布，更新的工单继续保留待上线。确认期间出现的新包不会替换本次选择。")}\n${deployPin.sha}\nSHA256 ${deployPin.manifestSha256}` : t("ticket.deployBody")}
        onConfirm={() => void triggerDeploy()}
        onCancel={() => setConfirmDeploy(false)}
      />
      <Confirm
        open={confirmAppPublish}
        title={t("ticket.publishTitle")}
        confirmLabel={t("ticket.publishConfirm")}
        busy={publishingApps}
        body={t("ticket.publishBody")}
        onConfirm={() => void publishPendingApps()}
        onCancel={() => setConfirmAppPublish(false)}
      />
      <Dialog
        open={verifyFail !== null}
        onOpenChange={(open) => {
          if (!open) setVerifyFail(null);
        }}
        title={t("ticket.verifyProblem")}
        description={t("ticket.verifyDescription")}
        footer={
          <>
            <UiButton onClick={() => setVerifyFail(null)}>
              {t("common.cancel")}
            </UiButton>
            <UiButton
              className="danger"
              disabled={verifying || !verifyNotes.trim()}
              onClick={() =>
                verifyFail !== null && void resolveVerify(verifyFail, "failed", verifyNotes.trim())
              }
            >
              {t("ticket.submit")}
            </UiButton>
          </>
        }
      >
        <Field label={t("ticket.verifyQuestion")}>
          {(id, describedBy) => (
            <UiTextArea
              id={id}
              aria-describedby={describedBy}
              value={verifyNotes}
              onChange={(event) => setVerifyNotes(event.target.value)}
            />
          )}
        </Field>
      </Dialog>
    </div>
    </MarkdownFileLinks.Provider>
  );
}
