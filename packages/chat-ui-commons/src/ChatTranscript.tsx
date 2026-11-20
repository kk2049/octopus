/**
 * The host-neutral chat shell — one message stream, two trust domains.
 *
 * An Agentic App may render this inside a digest-addressed iframe with its
 * Markdown; the trusted Dashboard renders it in the panel with its own. What
 * they must not do is disagree about how a chat behaves: where the window bar
 * sits, when "load earlier" is possible, how scroll position survives a delta,
 * which groups fold. That behaviour lives here once, and everything a host
 * legitimately differs on — Markdown renderer, spinner, status chip, class
 * names, wording — arrives as props.
 *
 * This file is part of the `./transcript-ui` face: it may not import an App or
 * host runtime, open a channel, name an identity, or render unsanitized HTML.
 * The package boundary test walks its source to keep that true.
 *
 * Scroll ownership follows the WINDOW change rather than every React render:
 * a prepend compensates for the height inserted above the reader, an append
 * follows only while the reader is pinned, and unrelated frames never write
 * `scrollTop`. That last distinction matters on touch screens, where writing
 * during momentum scrolling cancels the gesture and feels like a random jump.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { TranscriptWindow } from "@claude-bot/agent-sessions-contract";
import { entriesOf, foldsThinking, groupEntries } from "./transcript.js";
import { TranscriptScrollContext, VirtualTranscriptRows } from "./VirtualTranscriptRows.js";
import { scopedDomId } from "./dom.js";
import {
  DEFAULT_TRANSCRIPT_COPY,
  TranscriptGroupView,
  entryExpansionKey,
  renderPlainTextAssistant,
  type ReadFullBlock,
  type TranscriptCopy,
  type TranscriptGroupClasses,
} from "./TranscriptGroup.js";

export interface ChatScrollerProps {
  /** Identity of the stream; when it changes the view snaps to the bottom. */
  anchor: unknown;
  /** Identity of the tail frame; changes follow only while already pinned. */
  followKey?: unknown;
  /** Identity of the first absolute row; changes compensate a history prepend. */
  prependKey?: unknown;
  className?: string;
  id?: string;
  /** Host-localized label for the floating jump action. */
  latestText?: string;
  /** Upward reading reached the start margin; the host owns paging and deduplication. */
  onNearStart?(): void;
  children: ReactNode;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  /** Numeric window evidence stays available independently of visible controls. */
  windowInfo?: { offset: number; count: number; total: number };
}

const FOLLOW_BOTTOM_GAP = 48;
const SCROLL_DIRECTION_EPSILON = 0.5;
const HISTORY_START_MARGIN = 320;

interface ScrollGesture {
  startTop: number;
  lastTouchY?: number;
}

/**
 * The scroll container both message streams share.
 *
 * Appends and prepends are deliberately different operations. Keeping a fixed
 * distance from the bottom for both makes a live append drag a reader who is
 * studying old context toward the present; doing the write after every render
 * also interrupts mobile momentum scrolling. The caller supplies the two
 * semantic keys, so this component writes only for a real window transition.
 */
export function ChatScroller({
  anchor,
  followKey,
  prependKey,
  className,
  id,
  latestText = DEFAULT_TRANSCRIPT_COPY.latest,
  onNearStart,
  children,
  scrollElementRef,
  windowInfo,
}: ChatScrollerProps) {
  const localScroller = useRef<HTMLDivElement>(null);
  const scroller = scrollElementRef ?? localScroller;
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const position = useRef(0);
  const geometry = useRef({ height: 0, viewport: 0 });
  const readingStart = useRef(false);
  const touchGesture = useRef<ScrollGesture | null>(null);
  const pointerGesture = useRef<ScrollGesture | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const previous = useRef<{
    anchor: unknown;
    followKey: unknown;
    prependKey: unknown;
    scrollHeight: number;
  } | null>(null);

  const isInteracting = (): boolean =>
    touchGesture.current !== null || pointerGesture.current !== null;

  const rememberPosition = (el: HTMLDivElement): void => {
    position.current = el.scrollTop;
    geometry.current = { height: el.scrollHeight, viewport: el.clientHeight };
    setShowLatest(!pinned.current);
  };

  const pinToBottom = (el: HTMLDivElement): void => {
    readingStart.current = false;
    pinned.current = true;
    el.scrollTop = el.scrollHeight;
    rememberPosition(el);
  };

  const detachFromBottom = (): void => {
    pinned.current = false;
    setShowLatest(true);
  };

  const requestNearStart = (el: HTMLDivElement): void => {
    // A hidden panel has no viewport. Short/folded pages still need an upward
    // wheel or touch gesture before they can request any history.
    readingStart.current = el.clientHeight > 0
      && el.scrollTop <= Math.min(HISTORY_START_MARGIN, el.clientHeight / 2);
    if (readingStart.current) onNearStart?.();
  };

  const onScroll = (): void => {
    const el = scroller.current;
    if (!el) return;
    const delta = el.scrollTop - position.current;
    const resized = geometry.current.height !== el.scrollHeight || geometry.current.viewport !== el.clientHeight;
    // Measured virtual rows and viewport resizing can clamp scrollTop upwards.
    // That scroll event is not a decision to read history. Explicit input below
    // claims that decision before the browser moves, even during measurement.
    if (pinned.current && resized && !isInteracting()) {
      pinToBottom(el);
      return;
    }
    if (delta < -SCROLL_DIRECTION_EPSILON) {
      // Leaving the tail is an immediate user decision. In particular, do not
      // keep treating the first 48px as pinned: a fast live stream can fill
      // that gap and repeatedly cancel a phone's upward swipe.
      detachFromBottom();
      requestNearStart(el);
    } else if (delta > SCROLL_DIRECTION_EPSILON) {
      readingStart.current = false;
      // Reattach only while the user is moving toward the latest message.
      // This asymmetric threshold keeps a small upward move from being undone.
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_BOTTOM_GAP) pinned.current = true;
    }
    rememberPosition(el);
  };

  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>): void => {
    const touch = event.touches[0];
    touchGesture.current = {
      startTop: event.currentTarget.scrollTop,
      lastTouchY: touch?.clientY,
    };
  };

  const onTouchMove = (event: ReactTouchEvent<HTMLDivElement>): void => {
    const gesture = touchGesture.current;
    const touch = event.touches[0];
    if (!gesture || !touch) return;
    if (
      gesture.lastTouchY !== undefined
      && touch.clientY > gesture.lastTouchY + SCROLL_DIRECTION_EPSILON
    ) {
      // A downward finger movement asks the viewport to move upward. Claim
      // ownership before the browser emits `scroll`, so a concurrent frame or
      // ResizeObserver callback cannot win the race first.
      detachFromBottom();
      requestNearStart(event.currentTarget);
    } else if (
      gesture.lastTouchY !== undefined
      && touch.clientY < gesture.lastTouchY - SCROLL_DIRECTION_EPSILON
    ) {
      readingStart.current = false;
    }
    gesture.lastTouchY = touch.clientY;
  };

  const finishTouchGesture = (): void => {
    const el = scroller.current;
    touchGesture.current = null;
    if (!el || isInteracting()) return;
    if (pinned.current) pinToBottom(el);
    else rememberPosition(el);
  };

  const cancelTouchGesture = (): void => {
    const el = scroller.current;
    touchGesture.current = null;
    if (!el || isInteracting()) return;
    // Cancellation commonly means the browser took over navigation or
    // momentum. Never introduce a surprise bottom write at that boundary.
    detachFromBottom();
    rememberPosition(el);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === "touch") return;
    pointerGesture.current = { startTop: event.currentTarget.scrollTop };
  };

  const finishPointerGesture = (): void => {
    const el = scroller.current;
    const gesture = pointerGesture.current;
    pointerGesture.current = null;
    if (!el || !gesture || isInteracting()) return;
    // A scrollbar drag can finish before its last scroll event is delivered.
    if (el.scrollTop < gesture.startTop - SCROLL_DIRECTION_EPSILON) {
      detachFromBottom();
    }
    if (pinned.current) pinToBottom(el);
    else rememberPosition(el);
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (event.deltaY < 0) {
      detachFromBottom();
      requestNearStart(event.currentTarget);
    } else if (event.deltaY > 0) {
      readingStart.current = false;
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || (event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
      detachFromBottom();
      requestNearStart(event.currentTarget);
    }
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const last = previous.current;
    if (!last || last.anchor !== anchor) {
      pinToBottom(el);
    } else if (last.prependKey !== prependKey) {
      // `position` is the last user-owned top, captured by the scroll event
      // before React inserted the page. Assigning an absolute result also
      // avoids doubling the browser's own overflow-anchor compensation.
      el.scrollTop = Math.max(0, position.current + el.scrollHeight - last.scrollHeight);
      pinned.current = pinned.current
        && el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_BOTTOM_GAP;
      rememberPosition(el);
    } else if (last.followKey !== followKey && pinned.current && !isInteracting()) {
      pinToBottom(el);
    } else if (!isInteracting()) {
      rememberPosition(el);
    }
    previous.current = { anchor, followKey, prependKey, scrollHeight: el.scrollHeight };
    // Recheck after prepend compensation or a busy read settling. A compact
    // page may leave the reader at the start; the host admits only a new page,
    // never a retry of an unchanged/refused cursor. Mounts and tail-follow do
    // not arm this intent, and scrolling down cancels it.
    if (readingStart.current) requestNearStart(el);
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    const body = content.current;
    if (!el || !body || typeof ResizeObserver === "undefined") return;
    // Markdown layout can grow after the projection commit. Follow that growth
    // only while the reader still owns the bottom anchor; history reading is
    // never interrupted by a late code block, font or image measurement.
    const observer = new ResizeObserver(() => {
      if (!pinned.current || isInteracting()) return;
      pinToBottom(el);
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const jumpToLatest = (): void => {
    const el = scroller.current;
    if (!el) return;
    pinToBottom(el);
  };

  return (
    <div className="av-chat-scroller-shell">
      <div
        className={className}
        id={id}
        ref={scroller}
        data-av-chat-transcript
        data-av-chat-offset={windowInfo?.offset}
        data-av-chat-count={windowInfo?.count}
        data-av-chat-total={windowInfo?.total}
        onScroll={onScroll}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={finishTouchGesture}
        onTouchCancel={cancelTouchGesture}
        onPointerDown={onPointerDown}
        onPointerUp={finishPointerGesture}
        onPointerCancel={finishPointerGesture}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      >
        <div className="av-chat-content" ref={content}>{children}</div>
      </div>
      {showLatest ? (
        <button type="button" className="av-chat-latest" onClick={jumpToLatest}>
          {latestText}
        </button>
      ) : null}
    </div>
  );
}

export interface ChatTranscriptClasses extends TranscriptGroupClasses {
  /** The scroll container around the whole stream. */
  transcript: string;
  /** The "共 N 条 · 当前 f–l" bar with the load-earlier button. */
  windowbar: string;
  /** Informational one-liners: idle, loading and empty states. */
  hint: string;
}

/**
 * Stable structural classes backed by `transcript-ui.css`.
 *
 * A host may append its public/testing hooks, but it should start from this
 * map instead of rebuilding the chat's presentation class by class.
 */
export const SHARED_CHAT_CLASSES = Object.freeze({
  transcript: "av-chat-transcript",
  windowbar: "av-chat-windowbar",
  hint: "av-chat-hint",
  card: "av-chat-card",
  cardError: "av-chat-card-error",
  cardLive: "av-chat-card-live",
  cardHead: "av-chat-card-head",
  cardDetail: "av-chat-card-detail",
  label: "av-chat-label",
  labelRunning: "av-chat-label-running",
  muted: "av-chat-muted",
  error: "av-chat-error",
  work: "av-chat-work",
  fileRefs: "av-chat-file-refs",
  thinking: "av-chat-thinking",
  thinkingText: "av-chat-thinking-text",
  turn: "av-chat-turn",
  operationMeta: "av-chat-operation-meta",
  userTurn: "av-chat-user",
  assistantTurn: "av-chat-assistant",
  metaTurn: "av-chat-meta",
  pendingTurn: "av-chat-pending",
  role: "av-chat-role",
  userBody: "av-chat-user-body",
  assistantBody: "av-chat-assistant-body",
}) satisfies Readonly<ChatTranscriptClasses>;

export interface ChatTranscriptProps {
  /** Hosts with their own history actions can omit the window and local-search bars. */
  showHistoryControls?: boolean;
  /** Static renderers may opt out; interactive chat uses measured, bounded rows. */
  virtualize?: boolean;
  /** Names DOM hooks when more than one chat is mounted; empty preserves legacy selectors. */
  domIdScope?: string;
  resource: string | null;
  data: TranscriptWindow | null;
  /** A load is already in flight, so neither paging entry point may fire another. */
  busy: boolean;
  classes: ChatTranscriptClasses;
  /** The host's follow/status chip; rendered inside the stream below its window bar. */
  chip?: ReactNode;
  /** Host Markdown adapter; absent is deliberately literal React text. */
  renderAssistant?(text: string): ReactNode;
  renderSpinner?(): ReactNode;
  /** Host-owned clipboard action; omitted hosts keep their existing presentation. */
  onCopyResponse?(text: string): Promise<void>;
  /** Host-owned system copy; transcript/user/agent payloads are never translated. */
  copy?: TranscriptCopy;
  onLoadOlder(): void;
  /**
   * Offer `file`-kind entries (the 📝 rows) as an "open this file" action.
   * Optional pass-through to the group renderer; the shared face itself never
   * resolves a path — it only reports the click. Absent, those rows render as
   * the plain text they always were.
   */
  onOpenFile?(path: string): void;
  /**
   * The host's path grammar for a tool call's recorded input/output. Passed
   * straight through to each tool card; see `TranscriptGroupViewProps`.
   */
  extractFilePaths?(text: string | undefined): readonly string[];
  /** Read one complete page-capped block field; see `TranscriptGroupViewProps`. */
  onReadFullBlock?: ReadFullBlock;
  /** Shown when `resource` is null. */
  idleText?: string;
  /** Shown when the window has not arrived yet. */
  loadingText?: string;
  /** Shown when the window arrived with nothing renderable in it. */
  emptyText?: string;
  /**
   * Sticky user choices for transcript disclosures, keyed by a stable group
   * key (`TranscriptGroup.key`) or entry key (`entryExpansionKey`). Effective state is
   * `override ?? derived default` — the derived default opens exactly the last
   * contiguous work run and leaves its individual cards closed. The person's
   * clicks win and survive window growth, prepends and live updates. Provide
   * `onToggleGroup` with it.
   */
  expandOverrides?: Readonly<Record<string, boolean>>;
  onToggleGroup?(key: string, open: boolean): void;
  /** Animate only the final assistant prose group; opt-in keeps other hosts unchanged. */
  animateLastAssistant?: boolean;
  /**
   * Rendered after the last group, inside the scroller: the host's local-echo
   * bubbles for sends still in flight. Kept a slot so this shell stays
   * transport-neutral.
   */
  tail?: ReactNode;
  /** Host-derived live activity rendered at the absolute bottom of the stream. */
  activityTail?: ReactNode;
}

export function ChatTranscript({
  showHistoryControls = true,
  virtualize = true,
  domIdScope,
  resource,
  data,
  busy,
  classes,
  chip,
  renderAssistant = renderPlainTextAssistant,
  renderSpinner,
  onCopyResponse,
  copy = DEFAULT_TRANSCRIPT_COPY,
  onLoadOlder,
  onOpenFile,
  extractFilePaths,
  onReadFullBlock,
  idleText = "选择左侧任意会话查看内容。",
  loadingText = "正在通过能力管线读取 transcript…",
  emptyText = "这个会话还没有可显示的正文。",
  expandOverrides,
  onToggleGroup,
  animateLastAssistant = false,
  tail,
  activityTail,
}: ChatTranscriptProps) {
  // Historical windows opened with the panel render immediately. Animation is
  // for a NEW final answer arriving after this scroller mounted (including the
  // normal null/loading → window transition), never for replaying old history.
  const startedWithData = useRef(data !== null);
  const processedWindow = useRef(false);
  const lastAssistantSignature = useRef<string | null>(null);
  const animationTarget = useRef<string | null>(null);
  const trackedResource = useRef(resource);
  const earlierRequest = useRef<{ resource: string; offset: number } | null>(null);
  if (trackedResource.current !== resource) {
    // An unbound compatibility host can reuse this shell for another session.
    // Data already present for that resource is history, not a newly arriving
    // answer; a null -> window transition may still animate its fresh tail.
    trackedResource.current = resource;
    startedWithData.current = data !== null;
    processedWindow.current = false;
    lastAssistantSignature.current = null;
    animationTarget.current = null;
    earlierRequest.current = null;
  }
  const loadEarlier = (automatic: boolean): void => {
    const offset = data?.offset ?? 0;
    if (!resource || busy || !(offset > 0)) return;
    if (automatic && earlierRequest.current?.resource === resource
      && earlierRequest.current.offset === offset) return;
    // Latch before notifying the host: several scroll/touch events can arrive
    // before its pending frame. Unchanged data (including a refusal) never
    // retries automatically; the visible button remains an explicit retry.
    earlierRequest.current = { resource, offset };
    onLoadOlder();
  };
  // Compatibility callers may omit an external controller. They still get a
  // controlled disclosure store mounted above the data-frame-derived groups;
  // production hosts pass their longer-lived per-resource store through the
  // two props below.
  const [localExpandOverrides, setLocalExpandOverrides] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const localResourceKey = resource ?? "";
  const effectiveExpandOverrides = expandOverrides ?? localExpandOverrides[localResourceKey] ?? {};
  const onToggleExpansion = useCallback((key: string, open: boolean) => {
    if (onToggleGroup) onToggleGroup(key, open);
    if (!expandOverrides) {
      setLocalExpandOverrides((previous) => ({
        ...previous,
        [localResourceKey]: { ...(previous[localResourceKey] ?? {}), [key]: open },
      }));
    }
  }, [expandOverrides, localResourceKey, onToggleGroup]);
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const offset = Math.max(0, Number(data?.offset ?? 0));
  const running = Boolean(data?.activity?.state && data.activity.state !== "idle");
  const ompTimeline = data?.cliKind?.toLowerCase() === "omp";
  const claudeTimeline = data?.cliKind?.toLowerCase() === "claude";
  const foldThinking = foldsThinking(data?.cliKind);
  const entries = useMemo(() => entriesOf(messages, offset), [data?.messages, offset]);
  const groups = useMemo(() => groupEntries(entries, running, foldThinking), [entries, running, foldThinking]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [target, setTarget] = useState<{ index: number; entryIndex: number; request: number } | null>(null);
  useEffect(() => {
    if (!searchOpen) { setSearchQuery(""); return; }
    const timer = setTimeout(() => setSearchQuery(query.trim().toLocaleLowerCase()), 180);
    return () => clearTimeout(timer);
  }, [query, searchOpen]);
  const matches = useMemo(() => {
    if (!searchOpen || !searchQuery) return [];
    return groups.flatMap((group, index) => {
      const rows = "entries" in group ? group.entries : [group.entry];
      const entryIndex = rows.findIndex((entry) => [entry.text, "input" in entry ? entry.input : "", "detail" in entry ? entry.detail : ""]
        .some((text) => typeof text === "string" && text.toLocaleLowerCase().includes(searchQuery)));
      return entryIndex < 0 ? [] : [{ index, entryIndex }];
    });
  }, [groups, searchOpen, searchQuery]);
  const goToMatch = (direction: number) => {
    if (!matches.length) return;
    const current = target ? matches.findIndex((match) => match.index === target.index) : -1;
    const match = matches[(current + direction + matches.length) % matches.length]!;
    const group = groups[match.index]!;
    onToggleExpansion(group.key, true);
    if ("entries" in group && group.entries[match.entryIndex]) onToggleExpansion(entryExpansionKey(group.entries[match.entryIndex]!), true);
    setTarget({ ...match, request: (target?.request ?? 0) + 1 });
  };
  let body: ReactNode;
  if (!resource) {
    body = <div className={classes.hint}>{idleText}</div>;
  } else if (!data) {
    body = (
      <>
        {chip}
        <div className={classes.hint}>{loadingText}</div>
        {tail}
        {activityTail}
      </>
    );
  } else {
    // The offset gives every entry a stable anchor, so keys — and therefore
    // expansion DOM state — belong to a MESSAGE, not to a position that moves
    // whenever "load earlier" prepends a page.
    const total = Math.max(offset + messages.length, Number(data.totalMessages ?? 0));
    const first = messages.length ? offset + 1 : 0;
    const last = offset + messages.length;
    const finalGroup = groups[groups.length - 1];
    const flatAssistant = finalGroup?.kind === "prose" && finalGroup.role === "assistant"
      && finalGroup.entries.every((entry) => (
        !/[`*_#[\]<>|\r\n]/u.test(entry.text)
        && !/(?:https?:\/\/|www\.|mailto:)/iu.test(entry.text)
      ));
    const assistantSignature = flatAssistant
      ? `${finalGroup.key}\u0000${finalGroup.entries.map((entry) => entry.text).join("\u0000")}`
      : null;
    if (!processedWindow.current) {
      processedWindow.current = true;
      if (!startedWithData.current && assistantSignature) animationTarget.current = assistantSignature;
    } else if (assistantSignature && assistantSignature !== lastAssistantSignature.current) {
      animationTarget.current = assistantSignature;
    }
    lastAssistantSignature.current = assistantSignature;
    body = (
      <>
        {showHistoryControls ? <div className={classes.windowbar} data-av-chat-window>
          <span>{copy.window({ total, first, last, count: messages.length })}</span>
          <button
            type="button"
            id={scopedDomId("loadOlder", domIdScope)}
            data-av-chat-action="load-older"
            disabled={!(offset > 0 && !busy)}
            onClick={() => loadEarlier(false)}
          >
            {copy.loadOlder}
          </button>
        </div> : null}
        {chip}
        {showHistoryControls ? <div className={classes.windowbar}>
          <button type="button" onClick={() => setSearchOpen((open) => !open)} aria-expanded={searchOpen}>搜索已读取记录</button>
          {searchOpen ? <>
            <input aria-label="搜索已读取记录" value={query} onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); goToMatch(event.shiftKey ? -1 : 1); } }} />
            <span role="status">{matches.length} 组匹配</span>
            <button type="button" disabled={!matches.length} onClick={() => goToMatch(-1)}>上一处</button>
            <button type="button" disabled={!matches.length} onClick={() => goToMatch(1)}>下一处</button>
            <span className={classes.hint}>搜索已加载正文和折叠工具记录；浏览器查找只覆盖已显示内容。</span>
          </> : null}
        </div> : null}
        {entries.length ? (
          <VirtualTranscriptRows rows={groups} itemKey={(group) => group.key} target={target} renderRow={(group, index) => (
            <TranscriptGroupView
              animateAssistant={Boolean(
                animateLastAssistant
                && index === groups.length - 1
                && assistantSignature !== null
                && animationTarget.current === assistantSignature
              )}
              classes={classes}
              group={group}
              key={`${resource}:${group.key}`}
              searchTarget={target?.index === index ? { index: target.entryIndex, request: target.request } : null}
              renderAssistant={renderAssistant}
              renderSpinner={renderSpinner}
              onCopyResponse={onCopyResponse}
              copy={copy}
              {...(onOpenFile ? { onOpenFile } : {})}
              {...(extractFilePaths ? { extractFilePaths } : {})}
              {...(onReadFullBlock ? { onReadFullBlock } : {})}
              {...(ompTimeline ? { todoCards: true } : {})}
              {...(claudeTimeline ? { defaultWorkOpen: false } : {})}
              {...(group.key in effectiveExpandOverrides
                ? { expanded: effectiveExpandOverrides[group.key] }
                : {})}
              expansionOverrides={effectiveExpandOverrides}
              onToggleExpansion={onToggleExpansion}
              onToggle={(open: boolean) => onToggleExpansion(group.key, open)}
            />
          )} />
        ) : (
          <div className={classes.hint}>{emptyText}</div>
        )}
        {tail}
        {activityTail}
      </>
    );
  }

  return (
    <TranscriptScrollContext.Provider value={virtualize ? scrollElementRef : null}>
    <ChatScroller
      scrollElementRef={scrollElementRef}
      anchor={resource}
      followKey={data}
      prependKey={data?.offset}
      className={classes.transcript}
      id={scopedDomId("tr", domIdScope)}
      latestText={copy.latest}
      onNearStart={() => loadEarlier(true)}
      windowInfo={data ? {
        offset,
        count: messages.length,
        total: Math.max(offset + messages.length, Number(data.totalMessages ?? 0)),
      } : undefined}
    >
      {body}
    </ChatScroller>
    </TranscriptScrollContext.Provider>
  );
}
