import { CodexContinuationForm } from "./CodexContinuationForm.js";
import { tokenUsageLabel } from "@claude-bot/agent-sessions-contract";
import { AvButton, AvInput, AvTextArea } from "@claude-bot/agent-view-react/ui";
/**
 * One session: its transcript, and the one place text can be sent into it.
 *
 * The write predicate is worth stating, because a narrower one shipped once and
 * disabled the composer for exactly the sessions people wanted to continue: a
 * LIVE Runner session accepts an append even when it is not resumable yet, and
 * an idle one needs resumability. Requiring both was wrong.
 *
 * Sending is never immediate, but it is never INVISIBLE either: the moment the
 * person hits send, the controller's pending-send ledger puts a local-echo
 * bubble at the transcript's tail, and the same lifecycle carries the
 * operation's progress, the refusal sentence and the draft restore. The trusted
 * side decides from the release contract whether append/resume runs silently,
 * is refused or requires approval; this reusable View does not predict it.
 *
 * The composer draft lives in the CONTROLLER, keyed by session (a deliberate
 * 2026-08-13 ownership change): a draft that lived in this component belonged
 * to whatever session the panel happened to show next, so a focus change could
 * cross-post half-written text into another conversation — and it died with
 * every remount. The controller's resource-local external store has neither
 * failure, and avoids turning a keystroke into a shared-context rerender.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SplitHandle } from "@claude-bot/agent-view-react/ui";
import { handleChatComposerKeyDown } from "@claude-bot/chat-ui-commons/composer";
import {
  MAX_CHAT_ATTACHMENTS,
  imagesFromItems,
  nextAttachmentId,
  promptWithAttachments,
  type ChatAttachment,
} from "../lib/attachments.js";
import { useCompactChatViewport } from "@claude-bot/chat-ui-commons/composer-react";
import type {
  AgentInteractionResponse,
  AgentPermissionProfile,
  CliKind,
  ModelChoice,
  SessionSummary,
  TranscriptStatus,
  TranscriptWindow,
  SessionsReply,
} from "@claude-bot/agent-sessions-contract";
import {
  cliKindLabel,
  sessionCliKindLabel,
  supportsManualPermissionProfile,
  turnConfigurationRoute,
} from "../lib/cli.js";
import type {
  PendingControlRelease,
  PendingInterrupt,
  PendingSend,
  ResolvedAgentInteraction,
  WorkspaceReveal,
} from "../controller.js";
import { AgentPermissionField, EffortPicker, ModelPicker, RunConfigBar, RunConfigField } from "./RunConfig.js";
import { TranscriptView } from "./Transcript.js";
import { AgentInteractionCard } from "./AgentInteractionCard.js";
import { AsyncQuestions } from "./AsyncQuestionCard.js";
import type { ComposerDraftPersistence } from "../composer-drafts.js";
import { scopedDomId } from "../lib/dom.js";
import { currentRuntimeOf, currentTurnState, titleOf } from "../lib/projection.js";
import { QUIET_MS } from "../lib/transcript.js";

export interface AgentChatProps {
  /** Names DOM hooks when more than one chat is mounted; empty preserves legacy selectors. */
  domIdScope?: string;
  session: SessionSummary;
  /**
   * True when this session is missing from the CURRENT roster frame. The chat
   * keeps rendering the retained facts (absence is not deletion) and says so,
   * instead of unmounting or letting focus jump.
   */
  absent?: boolean;
  transcript: TranscriptWindow | null;
  transcriptStatus: TranscriptStatus | undefined;
  transcriptBusy: boolean;
  /**
   * The controller-owned draft for THIS session, and its setter. Optional so
   * the component stands alone (harness, tests) with a local fallback — but a
   * composition that mounts it beside a roster MUST wire these, or a focus
   * change hands the fallback draft to another session.
   */
  draft?: string;
  onDraftChange?(text: string): void;
  /** Resource-local controller store; preferred by mounted Sessions modules. */
  draftSource?: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): string;
    set(text: string): void;
  };
  permissionProfile?: AgentPermissionProfile;
  onPermissionProfileChange?(profile: AgentPermissionProfile): void;
  /** Optional model for the next provider-managed turn; absent preserves the Runner's current/default choice. */
  model?: string;
  models?: readonly ModelChoice[];
  onModelChange?(model: string): void;
  /** Optional effort for the next provider-managed turn; absent preserves the Runner's current/default choice. */
  effort?: string;
  onEffortChange?(effort: string): void;
  /** Sends still in their lifecycle for this session (local echo). */
  pendingSends?: readonly PendingSend[];
  asyncQuestionPersistence?: ComposerDraftPersistence;
  onDismissSend?(key: string): void;
  /** Sticky fold choices for this session's transcript groups and cards. */
  expandOverrides?: Readonly<Record<string, boolean>>;
  onToggleGroup?(key: string, open: boolean): void;
  onSend(prompt: string): void;
  /**
   * Upload one selected/dropped/pasted file to this session's physical device.
   * Resolves only after the complete `/tmp` path is available for the draft.
   */
  onAttachFile?(
    file: File,
    onProgress?: (uploadedBytes: number, totalBytes: number) => void,
  ): Promise<{ ok: true; attachment: Omit<ChatAttachment, "id"> } | { ok: false; message: string }>;
  onTakeover?(prompt: string): void;
  onFallback?(prompt: string): void;
  onInterrupt?(): void;
  interruptReceipt?: PendingInterrupt | null;
  /** Open the exact parent resource projected by the trusted coordinator. */
  onOpenParent?(): void;
  /** Lifecycle of the exceptional Codex attachment-release request. */
  controlRelease?: PendingControlRelease | null;
  onReleaseControl?(): void;
  onDismissControlRelease?(): void;
  onPin(): void;
  /**
   * Whether this session is currently a favourite. The control used to read
   * "收藏 / 取消收藏" in both states, which named the two things it could do
   * and never said which one was true — the same button, before and after a
   * tap. A filled star is the state; the label stays put.
   */
  pinned?: boolean;
  /** Account-owned title; empty means the provider/fallback title is active. */
  customTitle?: string;
  onSetTitle?(title: string): Promise<SessionsReply>;
  onReadContinuation?(): Promise<SessionsReply>;
  onSaveContinuation?(prompt: string | null, revision: string): Promise<SessionsReply>;
  onRefresh(): void;
  onLoadOlder(): void;
  onRespondInteraction?(interactionId: string, response: AgentInteractionResponse): Promise<void>;
  /** Successful answer retained by the shared controller as a compact receipt. */
  resolvedInteraction?: ResolvedAgentInteraction | null;
  /**
   * Open a file the transcript referred to (a 📝 row or a path-shaped link).
   * Optional and additive; absent, those references render as before.
   */
  onOpenFileLink?(path: string): void;
  /** Open a strictly recognised Feishu/Lark document URL as a Dock resource. */
  onOpenFeishuLink?(url: string, label: string): boolean;
  /** Read one complete page-capped transcript block field on an explicit click. */
  onReadFullBlock?: import("@claude-bot/chat-ui-commons/transcript-ui").ReadFullBlock;
  /** One bounded line about the file-link resolution in progress or refused. */
  fileLinkNotice?: string;
  /** Desktop-only reveal inside the shared file index. */
  onRevealWorkspace?(): void;
  workspaceReveal?: WorkspaceReveal | null;
}

/**
 * How long a settled absence must persist before the hint renders. One dropped
 * fan-out frame or a refresh racing a device timeout stays silent; a session
 * that is really gone still says so in under two seconds.
 */
export const ABSENT_NOTICE_DELAY_MS = 1_500;

/**
 * How long the stop button stays in its pressed state without the Host either
 * ending the turn or refusing out loud. Long enough that a normal stop settles
 * inside it, short enough that an undecided approval does not look like a
 * button that stopped working.
 */
export const STOP_PENDING_MAX_MS = 12_000;

const EMPTY_DRAFT_SNAPSHOT = () => "";
const NO_DRAFT_SUBSCRIPTION = () => () => {};

interface ChatFileUpload {
  id: string;
  label: string;
  bytes: number;
  uploadedBytes: number;
  status: "uploading" | "failed";
  message: string;
}

export function AgentChat(props: AgentChatProps) {
  const { session } = props;
  const cliKind = session.cliKind as CliKind | undefined;
  const parentOwned = session.inputMode === "parent_owned";
  // The roster is the authority for whether a request is CURRENT. A transcript
  // window may still contain the runtime snapshot from just before the person
  // answered; using that stale snapshot resurrects an already-finished card.
  // Older projections with no roster runtime at all may still fall back to the
  // transcript, while an explicitly present runtime without an interaction
  // means "there is no pending request".
  const runtime = currentRuntimeOf(session.runtime, props.transcript?.runtime);
  const [, refreshRuntimeClock] = useState(0);
  useEffect(() => {
    const declared = runtime?.turn_state || runtime?.turn?.state;
    if (declared !== "working") return;
    const observedAt = Date.parse(String(runtime?.observed_at ?? ""));
    if (!Number.isFinite(observedAt)) return;
    const remaining = observedAt + QUIET_MS - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(
      () => refreshRuntimeClock((value) => value + 1),
      Math.min(remaining + 1, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [runtime?.observed_at, runtime?.turn_state, runtime?.turn?.state]);
  const turnState = currentTurnState(runtime);
  const interaction = runtime?.interaction;
  const displayedInteraction = interaction ?? (
    props.resolvedInteraction?.interaction
  );
  const [localDraft, setLocalDraft] = useState("");
  const subscribedDraft = useSyncExternalStore(
    props.draftSource?.subscribe ?? NO_DRAFT_SUBSCRIPTION,
    props.draftSource?.getSnapshot ?? EMPTY_DRAFT_SNAPSHOT,
    props.draftSource?.getSnapshot ?? EMPTY_DRAFT_SNAPSHOT,
  );
  // Local pending for the stop button only. The authoritative end of a turn is
  // the Host withdrawing the capability, so this flag exists to keep a second
  // press from queueing a second stop in the seconds before that frame lands —
  // it is never the reason the button disappears.
  const [localStopping, setStopping] = useState(false);
  const stopping = props.interruptReceipt
    ? ["sending", "submitted", "running"].includes(props.interruptReceipt.phase)
    : localStopping;
  const [releaseDialogOpen, setReleaseDialogOpen] = useState(false);
  const [releaseConfirmed, setReleaseConfirmed] = useState(false);
  const releaseDialogRef = useRef<HTMLDialogElement>(null);
  const compactLayout = useCompactChatViewport();
  const composer = props.draftSource ? subscribedDraft : props.draft ?? localDraft;
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploads, setUploads] = useState<ChatFileUpload[]>([]);
  const uploading = uploads.some((item) => item.status === "uploading");
  const [attachError, setAttachError] = useState("");
  const [draggingFile, setDraggingFile] = useState(false);
  const [titleDraft, setTitleDraft] = useState(props.customTitle ?? "");
  const [titleBusy, setTitleBusy] = useState(false);
  const [titleNotice, setTitleNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);
  const uploadsRef = useRef<ChatFileUpload[]>(uploads);
  // The list as the paste loop sees it between awaits; state alone would read
  // the value captured when the paste started.
  const pending = useRef<ChatAttachment[]>(attachments);
  const attachmentResource = useRef(session.resourceId);
  attachmentResource.current = session.resourceId;
  pending.current = attachments;
  uploadsRef.current = uploads;
  useEffect(() => {
    pending.current = [];
    uploadsRef.current = [];
    uploadingRef.current = false;
    setAttachments([]);
    setUploads([]);
    setAttachError("");
  }, [session.resourceId]);
  useEffect(() => {
    setReleaseDialogOpen(false);
    setReleaseConfirmed(false);
  }, [session.resourceId]);
  useEffect(() => {
    if (!releaseDialogOpen) return;
    const dialog = releaseDialogRef.current;
    if (!dialog || dialog.open) return;
    // Real browsers get modal focus containment and Escape semantics. jsdom
    // and older embedded webviews lack showModal, so keep the same accessible
    // content visible there without pretending the action already happened.
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
        return;
      } catch {
        // Fall through to the non-modal compatibility rendering below.
      }
    }
    dialog.setAttribute("open", "");
  }, [releaseDialogOpen]);
  useEffect(() => {
    setTitleDraft(props.customTitle ?? "");
    setTitleNotice("");
  }, [props.customTitle, session.resourceId]);
  const setComposer = props.draftSource?.set ?? props.onDraftChange ?? setLocalDraft;
  // The HINT is debounced, never the facts: the chat renders the retained row
  // either way, and an absence shorter than the delay simply never flashes.
  const [showAbsent, setShowAbsent] = useState(false);
  useEffect(() => {
    if (!props.absent) {
      setShowAbsent(false);
      return;
    }
    const timer = setTimeout(() => setShowAbsent(true), ABSENT_NOTICE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [props.absent]);
  // The transcript may carry a newer runtime observation than the roster.
  // Every control fact must come from the same chosen envelope; mixing a new
  // turn state with stale capabilities is how a newly attached tmux pane kept
  // showing the background-takeover action.
  const runtimeCapabilities = runtime?.capabilities;
  const hasRoutedCapabilities = runtimeCapabilities && (
    runtimeCapabilities.terminal_append !== undefined
    || runtimeCapabilities.protocol_append !== undefined
    || runtimeCapabilities.managed_resume !== undefined
  );
  const routedWrite = runtimeCapabilities?.terminal_append === true
    || runtimeCapabilities?.protocol_append === true
    || runtimeCapabilities?.managed_resume === true
    || runtimeCapabilities?.append_when_idle === true;
  const awaitingInteraction = Boolean(interaction && interaction.status !== "resolved");
  const hookWorking = runtime?.process_state === "alive"
    && turnState === "working";
  const waitingForTool = props.transcript?.activity?.state === "tool";
  const showThinking = Boolean(hookWorking && !awaitingInteraction && !waitingForTool);
  const canWrite = Boolean(
    !parentOwned
    && session.sharedPromptAllowed !== false
    && session.deviceId
    && !awaitingInteraction
    && (hasRoutedCapabilities ? routedWrite : session.status === "live" || session.resumable === true),
  );
  const canTakeover = !parentOwned && session.sharedPromptAllowed !== false && runtimeCapabilities?.takeover === true;
  // A failed ordinary Codex send is also trusted lifecycle evidence: the
  // request reached an operation and did not complete. Offer the already
  // declared human-only takeover action even when the original CLI was missed
  // by the prior runtime frame. The Runner will freshly rebind the opaque
  // resource and refuse unless it can prove one exact CLI process.
  const failedCodexSend = !parentOwned && session.cliKind === "codex"
    ? [...(props.pendingSends ?? [])].reverse().find((entry) =>
        (entry.kind === "append" || entry.kind === "resume")
        && (entry.phase === "failed" || entry.phase === "refused"))
    : undefined;
  const canInterruptRetry = session.sharedPromptAllowed !== false && Boolean(failedCodexSend && props.onTakeover);
  const canFallback = !parentOwned && !session.shared
    && session.cliKind === "codex"
    && Boolean(session.accountLabel)
    && session.status !== "live"
    && !awaitingInteraction;
  // Takeover is intentionally explicit, but its prompt still needs somewhere
  // to be written. A read-only observed CLI therefore enables the draft while
  // keeping ordinary Send disabled.
  const canCompose = parentOwned || canWrite || canTakeover || canFallback || canInterruptRetry;
  const canInterrupt = !parentOwned && runtimeCapabilities?.interrupt === true;
  const recovering = runtime?.recovery?.state === "reconnecting" || runtime?.recovery?.state === "waiting_resource"
    || runtime?.recovery?.state === "waiting_capacity";
  // Two different stops behind one capability (ticket #184): a turn this
  // deployment drives has the provider's own interrupt, while an externally
  // observed CLI gets one stop keystroke in its own terminal. The button says
  // which, because "stop" means something different to someone who is looking
  // at that terminal — nothing there closes, exits or disappears.
  const terminalInterrupt = runtimeCapabilities?.terminal_interrupt === true;
  // A provider-native steer joins the turn already in progress; terminal/TUI
  // sends have no provider configuration receipt. Use the same predicate the
  // controller uses when deciding whether to carry the selected value. An
  // Agent started elsewhere (terminal TUI, hook-observed CLI) still gets the
  // controls when the explicit takeover is available, because that route —
  // and only that route — opens a managed turn the choice can apply to.
  const routedConfiguration = !parentOwned && cliKind
    ? turnConfigurationRoute({ ...session, ...(runtime ? { runtime } : {}) })
    : null;
  const configurationRoute = routedConfiguration === "takeover" && !(canTakeover && props.onTakeover)
    ? null
    : routedConfiguration;
  // The Host withdrawing the capability IS the turn ending, for both
  // mechanisms — that is the ordinary way this flag clears. The bounded timer
  // is for the outcomes that leave the turn running: a refusal, an approval
  // card nobody has decided yet, an unconfirmed keystroke. None of them should
  // strand the one control that would let the reader try again.
  useEffect(() => {
    if (!canInterrupt) {
      setStopping(false);
      return;
    }
    if (!stopping) return;
    const timer = setTimeout(() => setStopping(false), STOP_PENDING_MAX_MS);
    return () => clearTimeout(timer);
  }, [canInterrupt, stopping]);
  const attachmentKind = runtime?.attachment?.kind;
  const bestEffortTerminal = (attachmentKind === "hook_observer" || attachmentKind === "omp_terminal")
    && runtimeCapabilities?.terminal_append === true;
  const terminalLease = runtime?.control_lease?.holder === "terminal";
  const runtimeLabel = attachmentKind === "claude_sdk"
    ? "Octopus 托管 · Claude Agent SDK"
    : attachmentKind === "codex_app_server"
      ? terminalLease ? "本机 Codex CLI · app-server 可追加" : "Octopus 托管 · Codex app-server"
      : attachmentKind === "omp_rpc"
        ? "Octopus 托管 · omp RPC"
        : attachmentKind === "terminal_tmux"
          ? "本机 CLI · tmux 可发送"
          // omp is discovered from its own breadcrumbs, never hook-reported.
          // A missed cheap pane probe may still expose one force-verified send
          // attempt; call that pending tmux proof rather than "仅观察".
          : attachmentKind === "omp_terminal"
            ? bestEffortTerminal ? "本机 omp TUI · tmux 待确认" : "本机 omp TUI · 已发现,仅观察"
            : attachmentKind === "hook_observer"
              ? bestEffortTerminal ? "本机 Codex CLI · tmux 待确认" : "本机 CLI · 仅观察"
              : runtime?.process_state === "alive"
                ? "本机 CLI"
                : "";
  const sendLabel = runtimeCapabilities?.protocol_append === true
      ? "追加到当前轮次"
    : runtimeCapabilities?.terminal_append === true
      ? turnState === "working"
        ? "追加到 CLI 队列"
        : bestEffortTerminal ? "尝试发送到本机 CLI" : "发送到本机 CLI"
      : runtimeCapabilities?.managed_resume === true
        ? "由 Octopus 继续"
        : "发送";
  const id = (base: string): string => scopedDomId(base, props.domIdScope);
  // An attachment with no words is a message; empty with none is not.
  const hasMessage = Boolean(composer.trim() || attachments.length);
  /**
   * Every route (send, takeover, account fallback, interrupt-and-retry) sends
   * the same message: the words plus the attached files' paths. The takeover
   * routes used to send the words alone and leave the chips behind, so the
   * files never reached the agent.
   */
  const submit = (deliver: ((prompt: string) => void) | undefined): void => {
    if (!deliver || uploadingRef.current || !hasMessage) return;
    deliver(promptWithAttachments(composer, attachments));
    setComposer("");
    pending.current = [];
    setAttachments([]);
    setAttachError("");
  };
  const send = (): void => {
    if (canWrite) submit(props.onSend);
  };
  const uploadFiles = (files: readonly File[]): void => {
    const attach = props.onAttachFile;
    if (!attach || !files.length) return;
    // Reset immediately so choosing the same file again remains a real change,
    // including while an earlier selection is still uploading.
    if (fileInput.current) fileInput.current.value = "";
    if (!canWrite) {
      setAttachError("当前会话不能上传文件");
      return;
    }
    const activeUploads = uploadsRef.current.filter((item) => item.status === "uploading").length;
    const available = MAX_CHAT_ATTACHMENTS - pending.current.length - activeUploads;
    if (available <= 0) {
      setAttachError(`一条消息最多带 ${MAX_CHAT_ATTACHMENTS} 个文件`);
      return;
    }
    const selected = files.slice(0, available);
    setAttachError(files.length > available ? `只会上传前 ${available} 个文件` : "");
    const queued = selected.map((file): ChatFileUpload => ({
      id: nextAttachmentId(),
      label: file.name || "upload.bin",
      bytes: file.size,
      uploadedBytes: 0,
      status: "uploading",
      message: "",
    }));
    const replaceUploads = (next: ChatFileUpload[]): void => {
      uploadsRef.current = next;
      uploadingRef.current = next.some((item) => item.status === "uploading");
      setUploads(next);
    };
    const updateUpload = (id: string, update: (item: ChatFileUpload) => ChatFileUpload): void => {
      replaceUploads(uploadsRef.current.map((item) => item.id === id ? update(item) : item));
    };
    replaceUploads([...uploadsRef.current, ...queued]);
    uploadingRef.current = true;
    const resourceAtStart = session.resourceId;
    const upload = async (file: File, item: ChatFileUpload): Promise<void> => {
      try {
        const answer = await attach(file, (uploadedBytes) => {
          if (attachmentResource.current !== resourceAtStart) return;
          updateUpload(item.id, (current) => ({
            ...current,
            uploadedBytes: Math.max(current.uploadedBytes, Math.min(current.bytes, Math.max(0, uploadedBytes))),
          }));
        });
        if (attachmentResource.current !== resourceAtStart) return;
        if (!answer.ok) {
          updateUpload(item.id, (current) => ({ ...current, status: "failed", message: answer.message }));
          return;
        }
        const next = [...pending.current, { id: item.id, ...answer.attachment }];
        pending.current = next;
        setAttachments(next);
        replaceUploads(uploadsRef.current.filter((current) => current.id !== item.id));
      } catch {
        if (attachmentResource.current !== resourceAtStart) return;
        updateUpload(item.id, (current) => ({ ...current, status: "failed", message: "文件上传失败" }));
      }
    };
    // Each file owns one opaque multipart id and keeps its own chunks ordered;
    // separate files can therefore make progress independently.
    for (let index = 0; index < selected.length; index += 1) {
      void upload(selected[index]!, queued[index]!);
    }
  };
  const onPaste = (event: React.ClipboardEvent): void => {
    if (!props.onAttachFile) return;
    const images = imagesFromItems([...(event.clipboardData?.items ?? [])]);
    if (!images.length) return;
    // Only when there IS an image: a plain text paste stays a text paste.
    event.preventDefault();
    uploadFiles(images);
  };
  const permissionField = !parentOwned && props.permissionProfile && props.onPermissionProfileChange ? (
    <AgentPermissionField
      id={id("permissionProfile")}
      label={`下次托管 / 接管的 ${cliKindLabel(session.cliKind)} 权限`}
      value={props.permissionProfile}
      onChange={props.onPermissionProfileChange}
      allowManual={supportsManualPermissionProfile(session.cliKind)}
      hint={!supportsManualPermissionProfile(session.cliKind)
        ? "omp 的托管通道没有审批界面，只能以完整访问档接管；要逐项确认请在本机 omp TUI 里操作。"
        : runtimeCapabilities?.protocol_append === true || runtimeCapabilities?.terminal_append === true
          ? "当前追加沿用已有 attachment / CLI 权限；此档位只在发送前连接已结束、必须新开托管 attachment 时生效。"
          : ""}
    />
  ) : null;
  // The same compact items the launch composer shows (RunConfig.tsx), in the
  // same order. Desktop keeps them under the input beside the action buttons;
  // a phone folds them into the settings card so its two-column composer grid
  // (input + send) stays exactly as it was.
  const configurationHint = configurationRoute === "takeover"
    ? "只在“交给 Octopus 托管并发送”时生效；普通发送沿用本机 CLI 自己的模型与 effort。"
    : "随下一条消息开启托管轮次时生效；留空会保持 Runner 当前 / 默认值，当前页面会为这个会话保留选择。";
  const runConfigBar = configurationRoute && cliKind && (props.onModelChange || props.onEffortChange) ? (
    <RunConfigBar
      label={configurationRoute === "takeover" ? "托管后设置" : "后续轮次设置"}
      className={`session-run-config${configurationRoute === "takeover" ? " run-config-takeover" : ""}`}
    >
      <RunConfigField label="后端" hint="会话的 provider 与账号来源">
        <span className="run-config-value">
          {cliKind === "codex" ? sessionCliKindLabel(session.cliKind, session.accountLabel) : cliKindLabel(cliKind)}
        </span>
      </RunConfigField>
      {props.onModelChange ? (
        <RunConfigField label="模型" hint={configurationHint}>
          <ModelPicker
            id={id("sessionModel")}
            aria-label={configurationRoute === "takeover" ? "托管后模型" : "后续新轮次模型"}
            source={cliKind}
            models={props.models}
            value={props.model ?? ""}
            onValue={(value) => props.onModelChange?.(value)}
          />
        </RunConfigField>
      ) : null}
      {props.onEffortChange ? (
        <RunConfigField label="Effort" hint={configurationHint}>
          <EffortPicker
            id={id("sessionEffort")}
            aria-label={configurationRoute === "takeover" ? "托管后 effort" : "后续新轮次 effort"}
            source={cliKind}
            value={props.effort ?? ""}
            keepLabel="保持当前"
            onValue={(value) => props.onEffortChange?.(value)}
          />
        </RunConfigField>
      ) : null}
      {configurationRoute === "takeover" ? <span className="run-config-note">托管时生效</span> : null}
    </RunConfigBar>
  ) : null;
  const takeoverOnly = !canWrite && canTakeover && Boolean(props.onTakeover);
  const takeover = (): void => submit(props.onTakeover);
  // When ordinary sending works, takeover remains the explicit fallback in the
  // settings card. When takeover is the ONLY route, folding it there creates a
  // dead-looking composer: text is accepted but the only visible button is
  // disabled. In that state the primary button below carries the explicit
  // takeover wording and action instead.
  const takeoverButton = canWrite && canTakeover && props.onTakeover ? (
    <AvButton
      id={id("takeoverPrompt")}
      disabled={uploading || !hasMessage}
      onClick={takeover}
    >
      交给 Octopus 托管并发送
    </AvButton>
  ) : null;
  const interruptRetryPanel = canInterruptRetry ? (
    <section className="codex-release codex-interrupt-retry" role="status">
      <div>
        <strong>Codex 普通托管没有完成</strong>
        <div className="small">
          可以升级为中断式接管：Runner 会重新核验，只结束与当前会话精确绑定的本机 Codex CLI，
          再发送当前草稿；无法证明绑定时会拒绝，不会猜测或终止其他 Codex 进程。
        </div>
      </div>
      <div className="row">
        <AvButton
          id={id("interruptCodexAndRetry")}
          disabled={uploading || !hasMessage}
          title="显式结束精确绑定的本机 Codex CLI，再由 app-server 发送当前草稿"
          onClick={() => {
            if (uploadingRef.current || !hasMessage) return;
            if (failedCodexSend) props.onDismissSend?.(failedCodexSend.key);
            takeover();
          }}
        >
          中断 CLI 并重试
        </AvButton>
      </div>
    </section>
  ) : null;
  const fallbackButton = canFallback && props.onFallback ? (
    <AvButton
      id={id("fallbackPrompt")}
      disabled={uploading || !hasMessage}
      title="保留原会话，把上下文分叉到 Runner 自动选择的健康备用账号"
      onClick={() => submit(props.onFallback)}
    >
      换备用账号并发送
    </AvButton>
  ) : null;
  /**
   * Stop remains available for every interruptible runtime, but it shares the
   * composer's folded control card with permission, takeover and session
   * actions. The summary lives inside the input shell, so no provider kind
   * gets a permanent control block above the draft.
   */
  const interruptBar = (canInterrupt && props.onInterrupt) || props.interruptReceipt ? (
    <div className="turn-stop" role="status">
      <span className="turn-stop-label">
        {recovering ? "Octopus 正在等待运行环境恢复" : terminalInterrupt ? "本机 CLI 正在执行这一轮" : "Octopus 正在执行这一轮"}
      </span>
      {canInterrupt && props.onInterrupt ? <AvButton
        id={id("interruptTurn")}
        className="turn-stop-action"
        disabled={stopping}
        title={recovering ? "取消自动恢复；保留原会话与工作区" : terminalInterrupt
          ? "向该 CLI 的终端发送一次停止键；进程、终端与会话都保留，可以继续对话"
          : "结束当前托管轮次；会话保留，可以继续对话"}
        onClick={() => {
          setStopping(true);
          props.onInterrupt?.();
        }}
      >
        {stopping ? "停止中…" : recovering ? "停止自动恢复" : compactLayout ? "⏹ 停止" : terminalInterrupt ? "⏹ 停止这一轮(不结束 CLI)" : "⏹ 停止这一轮"}
      </AvButton> : null}
      {props.interruptReceipt ? <span className="small" role="status">
        {stopping ? "停止请求处理中…" : props.interruptReceipt.message}
      </span> : null}
    </div>
  ) : null;
  const releaseReceipt = props.controlRelease ?? null;
  const releaseAvailable = !parentOwned
    && runtimeCapabilities?.release_control === true
    && releaseReceipt?.phase !== "done"
    && Boolean(props.onReleaseControl);
  const releaseBusy = releaseReceipt
    ? ["sending", "submitted", "running"].includes(releaseReceipt.phase)
    : false;
  const releasePanel = !parentOwned && (releaseAvailable || releaseReceipt) ? (
    <section className={`codex-release${releaseReceipt?.phase === "done" ? " codex-release-done" : ""}`} role="status">
      <div>
        <strong>{releaseReceipt?.phase === "done" ? "Codex 后台占用已释放" : "Codex 后台占用需要处理"}</strong>
        <div className="small">
          {releaseReceipt?.message || (releaseBusy
            ? "放锁请求尚未完成；当前控制者不提前改变，也不会重复提交。"
            : "任务已经结束，但 Runner 未能确认独立 Codex app-server 已退出。本机 resume 前请先释放这份精确占用。")}
        </div>
      </div>
      <div className="row">
        {releaseAvailable ? (
          <AvButton
            id={id("releaseCodexControl")}
            disabled={releaseBusy}
            onClick={() => {
              setReleaseConfirmed(false);
              setReleaseDialogOpen(true);
            }}
          >
            {releaseBusy ? "放锁中…" : releaseReceipt?.phase === "refused" || releaseReceipt?.phase === "failed"
              || releaseReceipt?.phase === "uncertain"
              ? "重新核对并放锁"
              : "检查并释放占用"}
          </AvButton>
        ) : null}
        {releaseReceipt && !releaseBusy && props.onDismissControlRelease ? (
          <AvButton onClick={props.onDismissControlRelease}>知道了</AvButton>
        ) : null}
      </div>
    </section>
  ) : null;
  const releaseDialog = releaseDialogOpen ? (
    <dialog
      ref={releaseDialogRef}
      className="codex-release-dialog"
      aria-labelledby={id("releaseCodexTitle")}
      onCancel={(event) => {
        event.preventDefault();
        setReleaseDialogOpen(false);
        setReleaseConfirmed(false);
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!releaseConfirmed || !releaseAvailable || releaseBusy) return;
          setReleaseDialogOpen(false);
          setReleaseConfirmed(false);
          props.onReleaseControl?.();
        }}
      >
        <h3 id={id("releaseCodexTitle")}>确认释放 Codex 后台占用</h3>
        <p>
          这只会关闭当前会话由 Runner 自己启动的独立 app-server。若本机或网页仍在写入，强制释放可能让这一轮中断；
          共享宿主和本机 tmux 不会被这个动作关闭。
        </p>
        <label className="codex-release-check">
          <input
            type="checkbox"
            checked={releaseConfirmed}
            onChange={(event) => setReleaseConfirmed(event.target.checked)}
          />
          我已确认本机 Codex CLI 与网页后台当前都没有继续写入
        </label>
        <div className="row codex-release-actions">
          <AvButton
            htmlType="button"
            onClick={() => {
              setReleaseDialogOpen(false);
              setReleaseConfirmed(false);
            }}
          >
            取消
          </AvButton>
          <AvButton htmlType="submit" className="primary" disabled={!releaseConfirmed || releaseBusy}>
            确认释放这份占用
          </AvButton>
        </div>
      </form>
    </dialog>
  ) : null;
  const parentOwnedNotice = parentOwned ? (
    <section className="codex-release parent-owned-agent-note" role="status">
      <div>
        <strong>这个 {session.cliKind === "claude" ? "Claude" : "Codex"} 子 Agent 由父 Agent 管理</strong>
        <div className="small">
          {session.cliKind === "claude" ? "这是由父 Agent 启动的子任务，不接受独立续跑。请打开父 Agent 继续安排任务。" : (
            <>Codex 不接受对它的外部直接输入。复制历史会创建另一个 Agent，既不会唤醒这里的子 Agent，
              也不能冒充原来的协作身份；请回到父 Agent，由它通过 followup_task 继续或唤醒。</>
          )}
        </div>
      </div>
      {props.onOpenParent ? (
        <div className="row">
          <AvButton id={id("openParentAgent")} onClick={props.onOpenParent}>打开父 Agent</AvButton>
        </div>
      ) : null}
    </section>
  ) : null;
  const composerHint = (
    <div className="hint">
      <span>{parentOwned
        ? "当前子 Agent 只读；草稿保留在本页，不会被自动转发"
        : bestEffortTerminal
        ? "先尝试注入独占 tmux；注入失败后再选择显式托管"
        : canWrite ? (
          <span className="chat-submit-shortcut">
            <span className="chat-submit-wide">⌘/Ctrl + Enter 发送</span>
            <span className="chat-submit-compact">Enter 发送</span>
          </span>
        ) : canTakeover
          ? takeoverOnly ? "当前 CLI 只能观察；请使用主按钮显式托管" : "当前 CLI 只能观察；如需接管请使用右侧按钮"
          : canInterruptRetry
            ? "普通接续没有完成；可在上方显式中断 CLI 并重试"
          : "当前来源没有可执行 Runner"}</span>
      <span>{parentOwned
        ? "只有父 Agent 能继续原协作任务"
        : canTakeover
        ? "普通发送不会终止 CLI；显式托管会结束当前 CLI 进程"
        : canInterruptRetry
          ? "Runner 只会中断与当前会话精确绑定的 CLI；无法证明时会拒绝且不重发"
        : canFallback
          ? "换账号会保留原会话并创建新会话；上下文会复制，provider 缓存不跨账号复用"
          : "由可信侧按当前会话权限执行"}</span>
    </div>
  );
  const composerInput = (
    <AvTextArea
      id={id("composer")}
      data-av-session-composer
      placeholder={parentOwned ? "可暂存文字；请在父 Agent 中继续…" : "继续这个会话…"}
      disabled={!canCompose}
      value={composer}
      autoSize={compactLayout ? { minRows: 2, maxRows: 6 } : undefined}
      onChange={(event) => setComposer(event.target.value)}
      onKeyDown={(event) => handleChatComposerKeyDown(event, send)}
      onPaste={onPaste}
    />
  );
  const attachmentStrip = attachments.length || uploads.length || attachError ? (
    <div className="chat-attachments" aria-live="polite">
      {attachments.map((item) => (
        <span className="chat-attachment" key={item.id}>
          <span className="chat-attachment-name">{item.label}</span>
          <span className="chat-attachment-size">{Math.max(1, Math.round(item.bytes / 1024))} KB</span>
          <button
            type="button"
            className="chat-attachment-remove"
            aria-label={`移除 ${item.label}`}
            onClick={() => {
              const next = pending.current.filter((row) => row.id !== item.id);
              pending.current = next;
              setAttachments(next);
            }}
          >
            ✕
          </button>
        </span>
      ))}
      {uploads.map((item) => item.status === "uploading" ? (
        <span className="chat-upload" key={item.id}>
          <span className="chat-attachment-name">{item.label}</span>
          <span className="chat-upload-percent">
            {item.bytes ? Math.round(item.uploadedBytes / item.bytes * 100) : 0}%
          </span>
          <span className="chat-upload-progress">
            <progress
              aria-label={`${item.label} 上传进度`}
              value={item.uploadedBytes}
              max={Math.max(1, item.bytes)}
            />
          </span>
        </span>
      ) : (
        <span className="chat-upload chat-upload-failed" key={item.id}>
          <span className="chat-attachment-name">{item.label}</span>
          <span className="chat-attachment-bad" role="alert">{item.message}</span>
          <button
            type="button"
            className="chat-attachment-remove"
            aria-label={`移除失败的上传 ${item.label}`}
            onClick={() => {
              const next = uploadsRef.current.filter((current) => current.id !== item.id);
              uploadsRef.current = next;
              setUploads(next);
            }}
          >
            ✕
          </button>
        </span>
      ))}
      {attachError ? <span className="chat-attachment-bad" role="alert">{attachError}</span> : null}
    </div>
  ) : null;
  const uploadButton = props.onAttachFile ? (
    <AvButton
      id={id("uploadFile")}
      className="chat-upload-button"
      data-av-session-action="upload"
      disabled={!canWrite || attachments.length + uploads.filter((item) => item.status === "uploading").length >= MAX_CHAT_ATTACHMENTS}
      onClick={() => fileInput.current?.click()}
    >
      📎 上传文件 / 照片
    </AvButton>
  ) : null;
  const titleControl = props.onSetTitle && !session.shared ? (
    <div className="session-title-control">
      <label htmlFor={id("sessionTitle")}>会话标题</label>
      <div className="row">
        <AvInput
          id={id("sessionTitle")}
          value={titleDraft}
          maxLength={96}
          disabled={titleBusy}
          placeholder="留空以使用自动标题"
          onChange={(event) => {
            setTitleDraft(event.target.value);
            setTitleNotice("");
          }}
        />
        <AvButton
          id={id("saveSessionTitle")}
          disabled={titleBusy || titleDraft.trim() === (props.customTitle ?? "")}
          onClick={() => {
            setTitleBusy(true);
            setTitleNotice("");
            void props.onSetTitle?.(titleDraft).then((reply) => {
              setTitleNotice(reply.ok ? "标题已保存。" : reply.message || "标题保存被拒绝。");
            }).catch(() => {
              setTitleNotice("标题保存失败。");
            }).finally(() => {
              setTitleBusy(false);
            });
          }}
        >
          {titleBusy ? "保存中…" : titleDraft.trim() ? "保存标题" : "恢复自动标题"}
        </AvButton>
      </div>
      {titleNotice ? (
        <div className={titleNotice === "标题已保存。" ? "small" : "session-title-error"} role="status">
          {titleNotice}
        </div>
      ) : null}
    </div>
  ) : null;
  const sendButton = (
    <AvButton
      className="primary"
      id={id("sendPrompt")}
      data-av-session-action="send"
      aria-label={takeoverOnly ? "交给 Octopus 托管并发送" : sendLabel}
      disabled={uploading || !hasMessage || (!takeoverOnly && !canWrite)}
      onClick={takeoverOnly ? takeover : send}
    >
      {takeoverOnly ? (compactLayout ? "托管并发送" : "交给 Octopus 托管并发送") : compactLayout ? "发送" : sendLabel}
    </AvButton>
  );
  const composerOptions = (
    <details className="composer-options" data-av-session-options>
      <summary aria-label="会话设置" title="会话设置">⚙</summary>
      <div className="composer-options-card" data-av-session-options-card>
        {!recovering ? interruptBar : null}
        {compactLayout ? runConfigBar : null}
        {permissionField}
        {titleControl}
        {session.cliKind === "codex" && !session.shared && !parentOwned && props.onReadContinuation && props.onSaveContinuation ? (
          <CodexContinuationForm key={session.resourceId} read={props.onReadContinuation} save={props.onSaveContinuation} />
        ) : null}
        <div className="row">
          {compactLayout ? uploadButton : null}
          {!session.shared && <AvButton
            id={id("doPin")}
            data-av-session-action="pin"
            onClick={props.onPin}
            aria-pressed={props.pinned ?? false}
          >
            {props.pinned ? "★" : "☆"} 收藏
          </AvButton>}
          {takeoverButton}
          {fallbackButton}
          {(props.transcript?.offset ?? 0) > 0 ? (
            <AvButton
              id={id("compactLoadOlder")}
              disabled={props.transcriptBusy}
              onClick={props.onLoadOlder}
            >
              加载更早消息
            </AvButton>
          ) : null}
          <AvButton id={id("doRefresh")} onClick={props.onRefresh}>刷新会话</AvButton>
        </div>
        {composerHint}
      </div>
    </details>
  );
  const workspaceDisplay = session.cwdDisplay?.trim() || "当前工作目录";
  return (
    <>
      <div className="detailhead" data-av-session-header>
        <div className="title">
          {titleOf(session)}
          <div className="meta">
            {(props.transcript?.usage ?? session.usage) ? <span title="原生累计输入 + 输出；缓存输入不重复相加。Codex 未提供可归因的 weekly 百分比。">{tokenUsageLabel(props.transcript?.usage ?? session.usage)} · </span> : null}
            {session.deviceLabel || session.deviceId} · {sessionCliKindLabel(session.cliKind, session.accountLabel)}
            {session.cliKind === "codex" ? <span data-av-session-turn-configuration
              title="来自 Codex 最近一次实际运行的轮次记录；在 CLI 中切换模型或 Effort 后，开始下一轮时更新。">
              {` · ${props.transcript?.turnConfiguration?.model ?? "模型未报告"} · Effort ${props.transcript?.turnConfiguration?.effort ?? "未报告"}`}
            </span> : null}
            {runtimeLabel
              ? ` · ${runtimeLabel} ${turnState === "needs_input" ? "等待输入" : turnState === "working" ? "执行中" : turnState === "unknown" ? "状态未知" : "空闲"}`
              : null}
          </div>
        </div>
        {props.onRevealWorkspace ? (
          <AvButton
            className="workspace-reveal-button"
            aria-label={`在文件索引中定位 ${workspaceDisplay}`}
            title={`在同一个文件索引中展开 ${workspaceDisplay}`}
            disabled={props.workspaceReveal?.phase === "pending"}
            onClick={props.onRevealWorkspace}
          >
            <span aria-hidden="true">⌂</span>
            <span className="workspace-reveal-label">
              {props.workspaceReveal?.phase === "pending" ? "定位中…" : workspaceDisplay}
            </span>
          </AvButton>
        ) : null}
      </div>
      {session.sharedPromptAllowed === false ? <p role="status">共享 token 预算已用完；当前执行继续。请在“共享额度与租期”中申请更多 token。</p> : null}
      {runtime?.recovery ? <p role="status" data-agent-recovery={runtime.recovery.state}>
        {runtime.recovery.state === "reconnecting" ? "运行环境暂时断开，正在重新连接。任务仍被托管。"
          : runtime.recovery.state === "waiting_capacity"
            ? `Codex 容量不足，等待自动续接（已尝试 ${runtime.recovery.attempts ?? 0}/6 次）。${runtime.recovery.retry_at ? `下次：${runtime.recovery.retry_at}。` : ""}最多等待 30 分钟；你可以停止自动恢复。`
          : runtime.recovery.state === "waiting_resource" ? "等待运行环境恢复。恢复后会自动继续；你也可以停止托管。"
          : "恢复结果无法确认。为避免重复执行，已停止自动恢复，请核对会话记录。"}
      </p> : null}
      {recovering ? interruptBar : null}
      {interruptRetryPanel}
      {parentOwnedNotice}
      {releasePanel}
      {releaseDialog}
      {props.workspaceReveal?.phase === "refused" ? (
        <div className="workspace-reveal-note" role="status">{props.workspaceReveal.message}</div>
      ) : null}


      {props.fileLinkNotice ? (
        <div className="filelink-note" role="status">{props.fileLinkNotice}</div>
      ) : null}

      {showAbsent ? (
        <div className="session-absent-note" role="status">
          ⚠ 此会话暂时不在当前列表中（设备可能离线或列表被截断）；显示的是最近一次已知状态。
        </div>
      ) : null}

      <TranscriptView
        resource={session.resourceId}
        data={props.transcript}
        status={props.transcriptStatus}
        busy={props.transcriptBusy}
        thinking={showThinking}
        domIdScope={props.domIdScope}
        onLoadOlder={props.onLoadOlder}
        {...(props.pendingSends ? { pendingSends: props.pendingSends } : {})}
        {...(props.onDismissSend ? { onDismissSend: props.onDismissSend } : {})}
        {...(canCompose && !parentOwned && !composer ? { onRestoreSend: (prompt: string) => setComposer(prompt) } : {})}
        {...(props.expandOverrides ? { expandOverrides: props.expandOverrides } : {})}
        {...(props.onToggleGroup ? { onToggleGroup: props.onToggleGroup } : {})}
        {...(props.onOpenFileLink ? { onOpenFileLink: props.onOpenFileLink } : {})}
        {...(props.onOpenFeishuLink ? { onOpenFeishuLink: props.onOpenFeishuLink } : {})}
        {...(props.onReadFullBlock ? { onReadFullBlock: props.onReadFullBlock } : {})}
      />

      {cliKind === "codex" ? <AsyncQuestions key={session.resourceId} transcript={props.transcript}
        scope={`${props.domIdScope ?? ""}:${session.resourceId}`}
        resource={session.resourceId} persistence={props.asyncQuestionPersistence}
        canSend={canWrite} pendingSends={props.pendingSends} onSend={props.onSend} /> : null}

      {displayedInteraction?.id && props.onRespondInteraction ? (
        <AgentInteractionCard
          interaction={displayedInteraction}
          resolvedResponse={interaction ? undefined : props.resolvedInteraction?.response}
          onRespond={(response) => props.onRespondInteraction!(String(displayedInteraction.id), response)}
        />
      ) : null}

      {compactLayout ? null : (
        <SplitHandle
          axis="y"
          target="next"
          storageKey={`agent-sessions.command${props.domIdScope ? `.${props.domIdScope}` : ""}`}
          min={125}
          max={520}
          title="拖动调整操作区高度，双击恢复"
        />
      )}

      <div className="command-pane" data-av-session-command-pane>
        <div
          className={`composer composer-collapsed-controls${compactLayout ? " composer-compact" : ""}`}
          data-av-session-composer-region
        >
          <input
            ref={fileInput}
            id={id("uploadFileInput")}
            className="chat-file-input"
            data-av-session-upload-input
            type="file"
            multiple
            aria-label="选择要上传到当前会话的文件或照片"
            onChange={(event) => uploadFiles([...(event.currentTarget.files ?? [])])}
          />
          {attachmentStrip}
          <div
            className={!compactLayout && runConfigBar ? "composer-entry composer-entry-configured" : "composer-entry"}
            data-av-session-composer-actions
          >
            <div
              className={`composer-input-shell${draggingFile ? " chat-file-drop" : ""}`}
              onDragOver={(event) => {
                if (![...event.dataTransfer.types].includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDraggingFile(true);
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget;
                if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDraggingFile(false);
              }}
              onDrop={(event) => {
                if (!event.dataTransfer.files.length) return;
                event.preventDefault();
                setDraggingFile(false);
                uploadFiles([...event.dataTransfer.files]);
              }}
            >
              {composerInput}
              {compactLayout ? composerOptions : null}
            </div>
            {compactLayout ? null : runConfigBar}
            {compactLayout ? null : composerOptions}
            {compactLayout ? null : uploadButton}
            {sendButton}
          </div>
        </div>
      </div>
    </>
  );
}
