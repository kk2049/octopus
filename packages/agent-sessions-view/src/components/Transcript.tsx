/**
 * The module-side transcript: the shared chat shell, bound to this bundle's
 * global class names and to the SDK's presentation primitives.
 *
 * All behaviour — window bar, load-earlier gating, folds, scroll preservation —
 * lives in `ChatTranscript`, which the trusted Dashboard renders too with its
 * own Markdown and classes. What stays HERE is exactly what only this trust
 * domain may own: the SDK `Markdown`/`StatusChip` (this file may import
 * `@claude-bot/agent-view-react/ui`; the shared face may not) and the global
 * presentation classes used by this bundle. Cross-frame acceptance reads the
 * shared shell's explicit `data-av-chat-*` anchors, never these class names.
 *
 * The file-link behaviour is also THIS surface's, not the shared face's: a
 * path-shaped Markdown link becoming an "open this file" request only makes
 * sense where a workspace exists to open it into. It is one delegated click
 * handler around the shell (a `display: contents` wrapper, so the scroll
 * geometry the e2e suite measures is untouched), plus the shell's optional
 * `onOpenFile` pass-through for the 📝 rows. Both are additive: a host that
 * passes nothing renders exactly what it always has.
 *
 * ── Ticket #189: a path is a reference even when nobody linked it ───────────
 *
 * Agents write file references three ways, and only one of them used to be
 * clickable. So this surface now also:
 *
 *  · rewrites the paths in assistant PROSE (and in an inline code span that is
 *    exactly one path) into Markdown links before rendering, which routes them
 *    through the delegated handler already below — no second open path, no
 *    change to the Markdown renderer, and fenced code blocks untouched;
 *  · hands the shared tool card the same path grammar, so the files a tool
 *    call recorded appear as buttons at the TOP of its detail fold.
 *
 * Both stay additive and both stay guesses: resolution is still one listing at
 * a time from a root the trusted provider minted (`lib/file-link.ts`), so a
 * wrong guess costs one "no such entry" and can never invent a location.
 */

import { memo, useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { SendReceipt } from "@claude-bot/chat-ui-commons/transcript-ui";
import { MermaidPre } from "@claude-bot/chat-ui-commons/mermaid";
import { Markdown, StatusChip } from "@claude-bot/agent-view-react/ui";
import type { TranscriptStatus, TranscriptWindow } from "@claude-bot/agent-sessions-contract";
import type { ReadFullBlock } from "@claude-bot/chat-ui-commons/transcript-ui";
import type { PendingSend } from "../controller.js";
import { chatFileLinkPath } from "../lib/file-link.js";
import { findFilePaths, linkifyFilePaths } from "../lib/file-mentions.js";
import {
  ChatTranscript,
  SHARED_CHAT_CLASSES,
  type ChatTranscriptClasses,
} from "./ChatTranscript.js";

export interface TranscriptViewProps {
  domIdScope?: string;
  resource: string | null;
  data: TranscriptWindow | null;
  status: TranscriptStatus | undefined;
  busy: boolean;
  onLoadOlder(): void;
  /**
   * Offer file references in the transcript as "open this file" actions: the
   * 📝 rows a write tool produced, and Markdown links whose target is a path
   * rather than a URL. Optional and additive — absent, every link keeps its
   * current inert/anchor behaviour. The value is the path as authored;
   * translating and opening it is the module layer's business.
   */
  onOpenFileLink?(path: string): void;
  /** Feishu/Lark document links are routed to a declared Dock module. */
  onOpenFeishuLink?(url: string, label: string): boolean;
  /** Sends still in their lifecycle, rendered as trailing local-echo bubbles. */
  pendingSends?: readonly PendingSend[];
  onDismissSend?(key: string): void;
  /** Explicit recovery of uncertain input; only offered for an empty composer. */
  onRestoreSend?(prompt: string): void;
  /** Sticky fold choices, keyed by stable group/entry key; see ChatTranscript. */
  expandOverrides?: Readonly<Record<string, boolean>>;
  onToggleGroup?(key: string, open: boolean): void;
  /** Hook says the turn is alive, while no tool/request owns the visible tail. */
  thinking?: boolean;
  /** Read one complete page-capped block field on an explicit click. */
  onReadFullBlock?: ReadFullBlock;
}

export { sendPhaseWord } from "@claude-bot/chat-ui-commons/transcript-ui";

function FollowChip({ state }: { state: string | undefined }) {
  if (state === "reconnecting") return <StatusChip busy word="正在重连" tone="warn" />;
  if (state === "paused") return <StatusChip word="实时读取已暂停；刷新可继续" tone="warn" />;
  if (state === "closed") return <StatusChip icon="×" word="跟随已停止" tone="error" />;
  return null;
}

const CLASSES: ChatTranscriptClasses = {
  transcript: `${SHARED_CHAT_CLASSES.transcript} transcript`,
  windowbar: `${SHARED_CHAT_CLASSES.windowbar} windowbar`,
  hint: `${SHARED_CHAT_CLASSES.hint} small`,
  card: `${SHARED_CHAT_CLASSES.card} ev-card`,
  cardError: `${SHARED_CHAT_CLASSES.cardError} ev-err`,
  cardLive: `${SHARED_CHAT_CLASSES.cardLive} ev-live`,
  cardHead: `${SHARED_CHAT_CLASSES.cardHead} ev-head`,
  cardDetail: `${SHARED_CHAT_CLASSES.cardDetail} ev-detail`,
  label: `${SHARED_CHAT_CLASSES.label} ev-lab`,
  labelRunning: `${SHARED_CHAT_CLASSES.labelRunning} ev-run`,
  muted: `${SHARED_CHAT_CLASSES.muted} muted`,
  error: `${SHARED_CHAT_CLASSES.error} err`,
  work: `${SHARED_CHAT_CLASSES.work} ev-work`,
  thinking: `${SHARED_CHAT_CLASSES.thinking} ev-think`,
  thinkingText: `${SHARED_CHAT_CLASSES.thinkingText} ev-tx`,
  turn: `${SHARED_CHAT_CLASSES.turn} ev-turn`,
  operationMeta: `${SHARED_CHAT_CLASSES.operationMeta} ev-op-meta`,
  userTurn: `${SHARED_CHAT_CLASSES.userTurn} ev-user`,
  assistantTurn: `${SHARED_CHAT_CLASSES.assistantTurn} ev-assistant`,
  pendingTurn: `${SHARED_CHAT_CLASSES.pendingTurn} ev-pending`,
  role: `${SHARED_CHAT_CLASSES.role} ev-role`,
  userBody: `${SHARED_CHAT_CLASSES.userBody} ev-body`,
  assistantBody: `${SHARED_CHAT_CLASSES.assistantBody} ev-body`,
};

/* Stable presentation adapters let TranscriptGroup's memo boundary keep
 * settled Markdown out of every subsequent streaming projection render.
 * TWO module-scope functions rather than one closure over a flag, for the same
 * reason: a new identity each render would defeat that memo boundary. */
function renderAssistant(text: string) {
  return <Markdown renderCodeBlock={renderCodeBlock}>{text}</Markdown>;
}

function renderCodeBlock(children: ReactNode) { return <MermaidPre>{children}</MermaidPre>; }

/**
 * The same renderer, with the file paths in ordinary prose rewritten as
 * Markdown links first.
 *
 * The rewrite happens BEFORE the renderer rather than inside it: the renderer
 * is injected presentation and stays swappable, while "a path in this
 * transcript can be opened" is this surface's behaviour — and the delegated
 * click handler below already turns a schemeless link into an open request, so
 * a rewritten path takes exactly the same resolution and permission path an
 * authored link takes. Only used when a host wired `onOpenFileLink`; without
 * one, a linkified path would be an underlined word that does nothing.
 */
function renderAssistantWithFileLinks(text: string) {
  return <Markdown renderCodeBlock={renderCodeBlock}>{linkifyFilePaths(text)}</Markdown>;
}

function renderSpinner() {
  return <span className="av-spin" />;
}

async function copyResponse(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/**
 * Keep the heavy transcript tree insulated from projection-wide wrapper churn.
 *
 * The controller already preserves an unchanged TranscriptWindow identity,
 * but each frame used to defeat React.memo with a fresh filtered pending array,
 * status object and inline callbacks. The wrapper below refreshes callback refs
 * without changing their callable identity and retains semantically unchanged
 * status/pending values. Events always reach the newest props; only rendering
 * is skipped.
 */
export function TranscriptView(props: TranscriptViewProps) {
  const latest = useRef(props);
  useLayoutEffect(() => {
    // Publish only committed props to event handlers. A concurrent render that
    // React abandons must not change what the currently painted tree invokes.
    latest.current = props;
  });
  const status = useSemanticallyStableStatus(props.status);
  const pendingSends = useStableArray(props.pendingSends);
  const onLoadOlder = useCallback(() => latest.current.onLoadOlder(), []);
  const onOpenFileLink = useCallback((path: string) => latest.current.onOpenFileLink?.(path), []);
  const onOpenFeishuLink = useCallback((url: string, label: string) => (
    latest.current.onOpenFeishuLink?.(url, label) ?? false
  ), []);
  const onDismissSend = useCallback((key: string) => latest.current.onDismissSend?.(key), []);
  const onRestoreSend = useCallback((prompt: string) => latest.current.onRestoreSend?.(prompt), []);
  const onToggleGroup = useCallback((key: string, open: boolean) => (
    latest.current.onToggleGroup?.(key, open)
  ), []);
  const onReadFullBlock = useCallback<ReadFullBlock>((anchor, field, charOffset) => (
    latest.current.onReadFullBlock!(anchor, field, charOffset)
  ), []);
  return (
    <MemoTranscriptView
      {...props}
      status={status}
      pendingSends={pendingSends}
      onLoadOlder={onLoadOlder}
      onOpenFileLink={props.onOpenFileLink ? onOpenFileLink : undefined}
      onOpenFeishuLink={props.onOpenFeishuLink ? onOpenFeishuLink : undefined}
      onDismissSend={props.onDismissSend ? onDismissSend : undefined}
      onRestoreSend={props.onRestoreSend ? onRestoreSend : undefined}
      onToggleGroup={props.onToggleGroup ? onToggleGroup : undefined}
      onReadFullBlock={props.onReadFullBlock ? onReadFullBlock : undefined}
    />
  );
}

function useSemanticallyStableStatus(next: TranscriptStatus | undefined): TranscriptStatus | undefined {
  const retained = useRef(next);
  const previous = retained.current;
  if (
    previous?.resource !== next?.resource
    || previous?.state !== next?.state
    || previous?.message !== next?.message
  ) retained.current = next;
  return retained.current;
}

function useStableArray<T>(next: readonly T[] | undefined): readonly T[] | undefined {
  const retained = useRef(next);
  const previous = retained.current;
  if (
    previous === undefined
    || next === undefined
    || previous.length !== next.length
    || previous.some((entry, index) => entry !== next[index])
  ) retained.current = next;
  return retained.current;
}

const MemoTranscriptView = memo(function MemoTranscriptView({
  resource,
  data,
  status,
  busy,
  onLoadOlder,
  domIdScope,
  onOpenFileLink,
  onOpenFeishuLink,
  pendingSends,
  onDismissSend,
  onRestoreSend,
  expandOverrides,
  onToggleGroup,
  thinking = false,
  onReadFullBlock,
}: TranscriptViewProps) {
  // Local echo (design §2 原则 2): the person's words appear the moment they
  // hit send, follow the operation lifecycle, and on refusal stay with the
  // Host's sentence until dismissed. Rendered beside the transcript, never
  // merged into it — the window stays authoritative.
  const tail = pendingSends?.length ? pendingSends.map((entry) => (
    <SendReceipt key={entry.key} entry={entry} classes={CLASSES}
      {...(onRestoreSend ? { onRestore: () => onRestoreSend(entry.prompt) } : {})}
      {...(onDismissSend ? { onDismiss: () => onDismissSend(entry.key) } : {})} />
  )) : null;
  const activityTail = thinking ? (
    <div className="agent-thinking-tail" role="status">
      <span className="av-spin" aria-hidden="true" />
      <span>Agent 正在思考…</span>
    </div>
  ) : null;
  const shell = (
    <ChatTranscript
      showHistoryControls={false}
      animateLastAssistant
      busy={busy}
      chip={(
        <>
          <FollowChip state={status?.resource === resource ? status?.state : undefined} />
          {busy && data ? <StatusChip busy word="正在同步最新消息" tone="info" /> : null}
        </>
      )}
      classes={CLASSES}
      data={data}
      domIdScope={domIdScope}
      onLoadOlder={onLoadOlder}
      renderAssistant={onOpenFileLink ? renderAssistantWithFileLinks : renderAssistant}
      renderSpinner={renderSpinner}
      onCopyResponse={copyResponse}
      resource={resource}
      {...(onOpenFileLink ? { onOpenFile: onOpenFileLink, extractFilePaths: findFilePaths } : {})}
      {...(expandOverrides ? { expandOverrides } : {})}
      {...(onToggleGroup ? { onToggleGroup } : {})}
      {...(onReadFullBlock ? { onReadFullBlock } : {})}
      {...(tail ? { tail } : {})}
      {...(activityTail ? { activityTail } : {})}
    />
  );
  if (!onOpenFileLink && !onOpenFeishuLink) return shell;
  /**
   * One delegated click handler for every Markdown link in the stream, instead
   * of a hook inside the Markdown renderer: the renderer is injected
   * presentation (and stays swappable), while "a path-looking link opens a
   * file here" is this surface's behaviour. An external URL keeps
   * its anchor behaviour; a schemeless or View-origin target is a path claim, which the frame
   * could never navigate to anyway — so it becomes an open request. The
   * wrapper is `display: contents` so the shell's own scroll container keeps
   * exactly the geometry the browser suite measures.
   */
  const onClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (onOpenFeishuLink && /^https:\/\//i.test(href)) {
      // The callback owns strict host/product validation. Calling it for an
      // ordinary URL would make `preventDefault` swallow that URL, so this
      // surface only takes over the two Feishu/Lark tenant host families.
      try {
        const host = new URL(href).hostname.toLowerCase();
        if (host.endsWith(".feishu.cn") || host.endsWith(".larksuite.com")) {
          if (onOpenFeishuLink(href, anchor.textContent?.trim() ?? "")) {
            event.preventDefault();
            return;
          }
        }
      } catch {
        // The file-link branch below decides whether a malformed href is a path.
      }
    }
    // The renderer percent-encodes a destination; the walk compares against
    // listing labels, which are the real names. Decode before either decides.
    const path = chatFileLinkPath(href, anchor.ownerDocument.URL);
    if (!onOpenFileLink || path === null) return;
    event.preventDefault();
    onOpenFileLink(path.trim());
  };
  return (
    <div style={{ display: "contents" }} onClick={onClick}>
      {shell}
    </div>
  );
});
