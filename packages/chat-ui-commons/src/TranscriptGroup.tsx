/**
 * Host-neutral rendering for one normalized transcript group.
 *
 * The Agentic App and the trusted Dashboard have different shells, themes and
 * scrolling strategies. They should not, however, independently decide how a
 * tool call, thinking block or assistant turn behaves. This component owns
 * that shared interaction and accepts class names plus the host's Markdown and
 * spinner renderers as presentation adapters.
 */

import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { TRANSCRIPT_STATIC_ROW_LIMIT, VirtualTranscriptRows } from "./VirtualTranscriptRows.js";
import {
  formatTime,
  isWork,
  todoProgressOf,
  type TodoProgress,
  type TranscriptGroup,
  type TranscriptWorkEntry,
  type ViewEntry,
} from "./transcript.js";

export interface TranscriptGroupClasses {
  card: string;
  cardError?: string;
  cardLive?: string;
  cardHead: string;
  cardDetail: string;
  label: string;
  labelRunning?: string;
  muted?: string;
  error?: string;
  work: string;
  /** The "文件" strip at the top of an expanded tool card. */
  fileRefs?: string;
  thinking: string;
  thinkingText: string;
  turn: string;
  operationMeta: string;
  userTurn?: string;
  assistantTurn?: string;
  /** A host-side stream may carry system/pipeline turns; transcripts do not. */
  metaTurn?: string;
  /** A turn that exists but has not been delivered/confirmed yet. */
  pendingTurn?: string;
  role: string;
  userBody: string;
  assistantBody?: string;
}

/**
 * Host-owned chrome around a transcript. Payload text is deliberately absent:
 * user prose, assistant prose and tool input/output always pass through verbatim.
 */
export interface TranscriptCopy {
  latest: string;
  window(values: { total: number; first: number; last: number; count: number }): string;
  loadOlder: string;
  time: string;
  files: string;
  input: string;
  output: string;
  truncated: string;
  outputError: string;
  running: string;
  noResult: string;
  todoUpdating: string;
  todoProgress: string;
  todoProgressAria: string;
  completed(value: number): string;
  pending(value: number): string;
  current(value: string): string;
  todoEmpty: string;
  callDetails: string;
  todoState: Readonly<Record<TodoProgress["items"][number]["state"], string>>;
  workSummary(values: { thinking: number; tools: number }): string;
  workRunning: string;
  clickToExpand: string;
  thinking: string;
  you: string;
  assistant: string;
  copyResponse: string;
  copyingResponse: string;
  responseCopied: string;
  copyResponseFailed: string;
  /** Complete-block reads; optional so a host's own copy object stays valid. */
  loadFull?: string;
  loadingFull?: string;
  loadMoreFull?(values: { loaded: number; total: number }): string;
}

export const DEFAULT_TRANSCRIPT_COPY: TranscriptCopy = Object.freeze({
  latest: "回到最新",
  window: ({ total, first, last, count }: { total: number; first: number; last: number; count: number }) =>
    `共 ${total} 条 · 当前 ${first}–${last}（尾窗 ${count}）`,
  loadOlder: "加载更早",
  time: "时间（北京时间）",
  files: "文件",
  input: "input",
  output: "output",
  truncated: "截断",
  outputError: "出错",
  running: "⏳ 执行中…",
  noResult: "（未记录结果）",
  todoUpdating: "Todo 更新中",
  todoProgress: "Todo 进度",
  todoProgressAria: "Todo 完成进度",
  completed: (value: number) => `${value} 已完成`,
  pending: (value: number) => `${value} 待处理`,
  current: (value: string) => `当前：${value}`,
  todoEmpty: "这次更新没有返回可识别的 Todo 条目。",
  callDetails: "调用详情",
  todoState: {
    done: "已完成",
    in_progress: "进行中",
    pending: "待处理",
    blocked: "受阻",
  },
  workSummary: ({ thinking, tools }: { thinking: number; tools: number }) => thinking
    ? `🧭 ${thinking} 次思考 · ${tools} 个工具调用`
    : `⚙ ${tools} 个工具调用`,
  workRunning: "（执行中）",
  clickToExpand: "（点击展开）",
  thinking: "💭 思考",
  you: "🧑 你",
  assistant: "🤖 助手",
  copyResponse: "复制全文",
  copyingResponse: "复制中…",
  responseCopied: "已复制",
  copyResponseFailed: "复制失败，请重试或选中文字复制。",
  loadFull: "显示完整内容",
  loadingFull: "读取中…",
  loadMoreFull: ({ loaded, total }: { loaded: number; total: number }) => `继续读取（已显示 ${loaded}/${total} 字符）`,
});

/** A page-capped block field the host can read whole: `anchor` is the entry's `offset.block`. */
export type TranscriptBlockField = "text" | "input" | "output";
export type ReadFullBlock = (
  anchor: string,
  field: TranscriptBlockField,
  charOffset: number,
) => Promise<{ text: string; totalChars: number; nextCharOffset?: number }>;

/**
 * One field a transcript page capped: its page text, or — after an explicit
 * click — its complete text, read one bounded window per click. Mounted under
 * the entry's stable anchor, so the loaded text survives data frames; a late
 * answer after unmount is dropped.
 */
function CappedField({
  anchor,
  field,
  text,
  entry,
  read,
  copy,
  classes,
  children,
}: {
  anchor: string;
  field: TranscriptBlockField;
  text: string;
  entry: Pick<ViewEntry, "truncatedFields">;
  read?: ReadFullBlock;
  copy: TranscriptCopy;
  classes: TranscriptGroupClasses;
  children(text: string): ReactNode;
}) {
  const [full, setFull] = useState<{ text: string; total: number; next?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const capped = Boolean(read && entry.truncatedFields?.includes(field));
  const load = async (): Promise<void> => {
    if (!read || busy) return;
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const window = await read(anchor, field, full?.next ?? 0);
      if (current !== generation.current) return;
      setFull((old) => ({ text: (old?.text ?? "") + window.text, total: window.totalChars, next: window.nextCharOffset }));
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const defaults = DEFAULT_TRANSCRIPT_COPY;
  return (
    <>
      {children(full ? full.text : text)}
      {capped && (!full || full.next !== undefined) ? (
        <div className="av-chat-full-field" data-av-chat-full-field={field}>
          <button
            type="button"
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void load();
            }}
          >
            {busy
              ? copy.loadingFull ?? defaults.loadingFull
              : full
                ? (copy.loadMoreFull ?? defaults.loadMoreFull!)({ loaded: full.text.length, total: full.total })
                : copy.loadFull ?? defaults.loadFull}
          </button>
          {error ? <span className={classes.error} role="alert">{error}</span> : null}
        </div>
      ) : null}
    </>
  );
}

/** The host performs the clipboard write; this component owns only its receipt. */
function CopyResponse({ text, onCopy, copy }: {
  text: string;
  onCopy(text: string): Promise<void>;
  copy: TranscriptCopy;
}) {
  const [status, setStatus] = useState<"idle" | "pending" | "copied" | "failed">("idle");
  const generation = useRef(0);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    if (!inFlight.current) setStatus("idle");
    return () => { mounted.current = false; generation.current += 1; };
  }, [text]);
  const handleCopy = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = generation.current;
    setStatus("pending");
    try {
      await onCopy(text);
      if (current === generation.current) setStatus("copied");
    } catch {
      if (current === generation.current) setStatus("failed");
    } finally {
      inFlight.current = false;
      if (mounted.current && current !== generation.current) setStatus("idle");
    }
  };
  return <div className="av-chat-response-actions">
    <button type="button" className="av-chat-copy-response" data-av-chat-action="copy-response" disabled={status === "pending"}
      onClick={() => void handleCopy()} aria-label={copy.copyResponse} title={copy.copyResponse}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
      </svg>
    </button>
    <span role="status">{status === "failed" ? copy.copyResponseFailed : status === "copied" ? copy.responseCopied : status === "pending" ? copy.copyingResponse : ""}</span>
  </div>;
}

/** The classes one chat turn needs — a structural subset of the group classes. */
export type ChatTurnClasses = Pick<
  TranscriptGroupClasses,
  "turn" | "userTurn" | "assistantTurn" | "metaTurn" | "pendingTurn" | "role"
>;

export interface ChatTurnProps {
  role: "user" | "assistant" | "meta";
  /** The author line: "🧑 你 · 12:00", "alice via feishu", "⚙ pipeline"… */
  label: ReactNode;
  /** Queued but not delivered yet; adds `pendingTurn`. */
  pending?: boolean;
  classes: ChatTurnClasses;
  children: ReactNode;
}

/**
 * One turn of any message stream: an author line and a body. The transcript's
 * prose groups render through this, and so does the dev-ticket conversation —
 * that is what makes "the same chat" a component rather than a resemblance.
 */
export function ChatTurn({ role, label, pending, classes, children }: ChatTurnProps) {
  return (
    <div
      className={names(
        classes.turn,
        role === "user" && classes.userTurn,
        role === "assistant" && classes.assistantTurn,
        role === "meta" && classes.metaTurn,
        pending && classes.pendingTurn,
      )}
    >
      <div className={classes.role}>{label}</div>
      {children}
    </div>
  );
}

export interface TranscriptGroupViewProps {
  group: TranscriptGroup;
  classes: TranscriptGroupClasses;
  /** Host Markdown adapter; absent is deliberately literal React text. */
  renderAssistant?(text: string): ReactNode;
  renderSpinner?(): ReactNode;
  /** Copy the complete assistant prose group, before Markdown or virtualization. */
  onCopyResponse?(text: string): Promise<void>;
  /** Host-owned system copy; content entries remain untouched. */
  copy?: TranscriptCopy;
  /** Reveal assistant prose quickly instead of painting a completed block in one flash. */
  animateAssistant?: boolean;
  /**
   * Offer `file`-kind entries (the 📝 rows) as an "open this file" action.
   * Optional and purely additive: a host that passes nothing renders the same
   * plain text it always has. The value is the path AS THE TOOL RECORDED IT;
   * translating it into something openable is the caller's business.
   */
  onOpenFile?(path: string): void;
  /**
   * The host's path grammar, applied to a tool call's recorded input/output so
   * the files it touched become openable at the top of its detail card.
   *
   * A CALLBACK rather than a rule here, because "what looks like a file" is a
   * workspace question and this package has no workspace: the trusted panel and
   * an isolated App may legitimately answer it differently, and a host that
   * passes nothing renders exactly the card it always did. Only consulted when
   * `onOpenFile` exists — a list nothing can open is decoration.
   */
  extractFilePaths?(text: string | undefined): readonly string[];
  /** Render OMP's `todo` calls as progress cards while keeping raw details available. */
  todoCards?: boolean;
  /** Provider default; explicit reader choices always take precedence. */
  defaultWorkOpen?: boolean;
  /**
   * The person's sticky choice for a work group's fold, when they made one.
   * Absent, the derived default applies: open exactly the last contiguous tool
   * run (`group.last`, which also covers the in-flight run), collapse earlier
   * ones. The default may only change at a semantic boundary — a NEW run
   * starting — never because a result frame arrived (design:
   * frontend-interaction-stability-design.md §2 原则 1.3).
   */
  expanded?: boolean;
  searchTarget?: { index: number; request: number } | null;
  /** Record the person's fold choice; with it the fold becomes controlled. */
  onToggle?(open: boolean): void;
  /**
   * Sticky choices for nested tool/Todo cards. These are the same override map
   * that owns the outer work fold; entry keys are namespaced by
   * `entryExpansionKey`, so every disclosure follows
   * `userOverride ?? false` without colliding with a group key.
   */
  expansionOverrides?: Readonly<Record<string, boolean>>;
  onToggleExpansion?(key: string, open: boolean): void;
  /**
   * Read one complete field of a page-capped block. Optional and additive:
   * absent (or with a Runner that does not report `truncatedFields`), capped
   * fields render exactly as before, marked truncated.
   */
  onReadFullBlock?: ReadFullBlock;
}

/** Stable storage key for one normalized entry's own disclosure card. */
export function entryExpansionKey(entry: Pick<ViewEntry, "anchor">): string {
  return `e:${entry.anchor}`;
}

/**
 * Fail-closed assistant rendering for hosts that omit a Markdown adapter.
 * Returning the string itself makes React create a text child: no parsing,
 * element construction, raw HTML path, or trust-domain policy is implied.
 */
export function renderPlainTextAssistant(text: string): string {
  return text;
}

function names(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

/** First-seen order, no duplicates, and never the value already shown above. */
function dedupe(values: readonly string[], exclude: string): string[] {
  const seen = new Set(exclude ? [exclude] : []);
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Markdown is the expensive part of a live transcript. A projection frame
 * replaces the whole window, so every surrounding group is reconstructed even
 * when only the trailing assistant block grew. Keeping each prose block behind
 * a text-keyed memo boundary means settled Markdown is parsed once; only the
 * block whose text actually changed pays the parser/DOM reconciliation cost.
 *
 * This is the same stable-node idea used by DeepSeek Harness's keyed chat
 * renderer, adapted to Octopus's provider-neutral `ViewEntry` vocabulary.
 */
interface AssistantEntryProps {
  className: string | undefined;
  text: string;
  render(text: string): ReactNode;
  animate: boolean;
}

function AnimatedAssistantEntry({ className, text, render }: Omit<AssistantEntryProps, "animate">) {
  const reduced = (): boolean => (
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const initial = (): string => {
    const chars = Array.from(text);
    if (reduced() || chars.length <= 1) return text;
    const count = Math.min(24, Math.max(1, Math.floor(chars.length / 4)));
    return chars.slice(0, count).join("");
  };
  const [visible, setVisible] = useState(initial);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const chars = Array.from(text);
    if (reduced() || chars.length <= 1) {
      visibleRef.current = text;
      setVisible(text);
      return;
    }

    const previous = visibleRef.current;
    let count = text.startsWith(previous)
      ? Array.from(previous).length
      : Math.min(24, Math.max(1, Math.floor(chars.length / 4)));
    // A new non-prefix answer never flashes in full; a streaming append keeps
    // the already-visible prefix and animates only the newly arrived suffix.
    let next = chars.slice(0, count).join("");
    visibleRef.current = next;
    setVisible(next);
    // Twelve 16ms frames keeps even a very large final block below ~200ms;
    // the effect is perceptible but never becomes a slow content gate.
    const step = Math.max(2, Math.ceil((chars.length - count) / 12));
    let timer = 0;
    const tick = (): void => {
      if (count >= chars.length) return;
      count = Math.min(chars.length, count + step);
      next = chars.slice(0, count).join("");
      visibleRef.current = next;
      setVisible(next);
      if (count < chars.length) timer = window.setTimeout(tick, 16);
    };
    timer = window.setTimeout(tick, 16);
    return () => window.clearTimeout(timer);
  }, [text]);

  return <div className={className}>{render(visible)}</div>;
}

const AssistantEntry = memo(function AssistantEntry({
  className,
  text,
  render,
  animate,
}: AssistantEntryProps) {
  return animate
    ? <AnimatedAssistantEntry className={className} text={text} render={render} />
    : <div className={className}>{render(text)}</div>;
});
function ProseEntry({
  entry,
  role,
  classes,
  renderAssistant,
  animateAssistant,
}: {
  entry: ViewEntry;
  role: "user" | "assistant";
  classes: TranscriptGroupClasses;
  renderAssistant(text: string): ReactNode;
  animateAssistant: boolean;
}) {
  if (entry.bilingual) {
    return (
      <div className="av-chat-bilingual">
        <div className="av-chat-language" lang="zh-CN">
          <div className="av-chat-language-label">中文</div>
          {role === "user"
            ? <div className={classes.userBody}>{entry.bilingual.zh}</div>
            : (
                <AssistantEntry
                  className={classes.assistantBody}
                  render={renderAssistant}
                  text={entry.bilingual.zh}
                  animate={animateAssistant}
                />
              )}
        </div>
        <div className="av-chat-language av-chat-language-english" lang="en">
          <div className="av-chat-language-label">English</div>
          {role === "user"
            ? <div className={classes.userBody}>{entry.bilingual.en}</div>
            : (
                <AssistantEntry
                  className={classes.assistantBody}
                  render={renderAssistant}
                  text={entry.bilingual.en}
                  animate={false}
                />
              )}
        </div>
      </div>
    );
  }
  return (
    <>
      {role === "user"
        ? <div className={classes.userBody}>{entry.text}</div>
        : (
            <AssistantEntry
              className={classes.assistantBody}
              render={renderAssistant}
              text={entry.text}
              animate={animateAssistant}
            />
          )}
      {entry.translationError
        ? <div className="av-chat-translation-error" role="note">{entry.translationError}</div>
        : null}
    </>
  );
}


/** At most this many file buttons on one tool card; the rest stay in the text. */
const TOOL_FILE_LIMIT = 8;

function ToolTime({
  at,
  classes,
  copy,
}: {
  at: string | undefined;
  classes: TranscriptGroupClasses;
  copy: TranscriptCopy;
}) {
  if (!at) return null;
  return (
    <div className={names(classes.label, classes.muted)} data-av-chat-tool-time>
      {copy.time} · <time dateTime={at}>{formatTime(at)}</time>
    </div>
  );
}

function ToolCard({
  entry,
  classes,
  renderSpinner,
  onOpenFile,
  extractFilePaths,
  todoCards = false,
  expanded,
  onToggle,
  copy,
  onReadFullBlock,
}: {
  entry: TranscriptWorkEntry;
  classes: TranscriptGroupClasses;
  renderSpinner?: () => ReactNode;
  onOpenFile?: (path: string) => void;
  extractFilePaths?: (text: string | undefined) => readonly string[];
  todoCards?: boolean;
  expanded?: boolean;
  onToggle?: (open: boolean) => void;
  copy: TranscriptCopy;
  onReadFullBlock?: ReadFullBlock;
}) {
  const inFlight = entry.live && Boolean(entry.unpaired);
  const open = expanded ?? false;
  // The files this call named, at the TOP of the detail — one tap on a phone,
  // and no scrolling past a JSON blob on a desk. The card's own title already
  // carries the file for a write tool, so it is not repeated below it.
  //
  // Memoised on the TEXT, and on whether an opener exists rather than on its
  // identity: a live transcript re-renders every group on every projection
  // frame, and the host's opener is a fresh closure each time. Scanning a tool
  // output that did not change is exactly the work a streaming turn cannot
  // afford to repeat per card per frame.
  const openable = Boolean(onOpenFile && extractFilePaths);
  const files = useMemo(
    () => (openable && extractFilePaths
      ? dedupe(
        [...extractFilePaths(entry.input), ...extractFilePaths(entry.detail)],
        entry.kind === "file" ? entry.text : "",
      ).slice(0, TOOL_FILE_LIMIT)
      : []),
    [openable, extractFilePaths, entry.input, entry.detail, entry.kind, entry.text],
  );
  const todo = todoCards ? todoProgressOf(entry) : null;
  if (todo) {
    return (
      <TodoCard
        classes={classes}
        entry={entry}
        inFlight={inFlight}
        open={open}
        onToggle={onToggle}
        progress={todo}
        renderSpinner={renderSpinner}
        copy={copy}
        {...(onReadFullBlock ? { onReadFullBlock } : {})}
      />
    );
  }
  const icon = entry.kind === "file" ? "📝" : entry.kind === "subagent" ? "🧩" : "▸";
  const preview = entry.input && entry.input.length > 100 ? `${entry.input.slice(0, 100)}…` : entry.input;
  // A file the agent touched is also a file the reader may want to SEE. The
  // button stops propagation so opening the file does not also toggle the
  // details fold it happens to sit inside.
  const title = entry.kind === "file" && onOpenFile ? (
    <button
      type="button"
      className="ev-file-open"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenFile(entry.text);
      }}
    >
      {entry.text}
    </button>
  ) : (
    entry.text
  );
  return (
    <details
      className={names(classes.card, entry.isError && classes.cardError, inFlight && classes.cardLive)}
      data-av-chat-work-kind="tool"
      open={open}
    >
      <summary
        className={classes.cardHead}
        {...(onToggle
          ? {
            onClick: (event: ReactMouseEvent) => {
              event.preventDefault();
              onToggle(!open);
            },
          }
          : {})}
      >
        {inFlight && renderSpinner ? renderSpinner() : <span aria-hidden="true">{icon}</span>} {title}
        {preview ? <span className={classes.muted}> · {preview}</span> : null}
      </summary>
      <div className={classes.cardDetail}>
        <ToolTime at={entry.at} classes={classes} copy={copy} />
        {files.length ? (
          <div className={classes.fileRefs ?? "av-chat-file-refs"} data-av-chat-file-refs>
            <span className={classes.label}>{copy.files}</span>
            {files.map((path) => (
              <button
                type="button"
                className="ev-file-open"
                key={path}
                title={path}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenFile!(path);
                }}
              >
                {path}
              </button>
            ))}
          </div>
        ) : null}
        <ToolFields entry={entry} inFlight={inFlight} classes={classes} copy={copy} onReadFullBlock={onReadFullBlock} />
      </div>
    </details>
  );
}

/** A tool call's recorded input and result, each readable whole when the page capped it. */
function ToolFields({ entry, inFlight, classes, copy, onReadFullBlock }: {
  entry: TranscriptWorkEntry;
  inFlight: boolean;
  classes: TranscriptGroupClasses;
  copy: TranscriptCopy;
  onReadFullBlock?: ReadFullBlock;
}) {
  return (
    <>
      {entry.input ? (
        <>
          <div className={classes.label}>{copy.input}{entry.truncated ? ` (${copy.truncated})` : ""}</div>
          <CappedField anchor={entry.anchor} field="input" text={entry.input} entry={entry} read={onReadFullBlock} copy={copy} classes={classes}>
            {(text) => <pre>{text}</pre>}
          </CappedField>
        </>
      ) : null}
      {entry.detail != null ? (
        <>
          <div className={classes.label}>
            {entry.isError
              ? <span className={classes.error}>{copy.output} ({copy.outputError})</span>
              : copy.output}
          </div>
          <CappedField anchor={entry.anchor} field="output" text={entry.detail} entry={entry} read={onReadFullBlock} copy={copy} classes={classes}>
            {(text) => <pre>{text}</pre>}
          </CappedField>
        </>
      ) : inFlight ? (
        <div className={names(classes.label, classes.labelRunning)}>{copy.running}</div>
      ) : (
        <div className={names(classes.label, classes.muted)}>{copy.noResult}</div>
      )}
    </>
  );
}

const TODO_STATE_ICON: Readonly<Record<TodoProgress["items"][number]["state"], string>> = {
  done: "✓",
  in_progress: "→",
  pending: "○",
  blocked: "!",
};

function TodoCard({
  entry,
  inFlight,
  open,
  onToggle,
  progress,
  classes,
  renderSpinner,
  copy,
  onReadFullBlock,
}: {
  entry: TranscriptWorkEntry;
  inFlight: boolean;
  open: boolean;
  onToggle?: (open: boolean) => void;
  progress: TodoProgress;
  classes: TranscriptGroupClasses;
  renderSpinner?: () => ReactNode;
  copy: TranscriptCopy;
  onReadFullBlock?: ReadFullBlock;
}) {
  return (
    <details
      className={names(
        classes.card,
        "av-chat-todo-card",
        entry.isError && classes.cardError,
        inFlight && classes.cardLive,
      )}
      data-av-chat-work-kind="tool"
      open={open}
    >
      <summary
        className={classes.cardHead}
        {...(onToggle
          ? {
            onClick: (event: ReactMouseEvent) => {
              event.preventDefault();
              onToggle(!open);
            },
          }
          : {})}
      >
        {inFlight && renderSpinner ? renderSpinner() : <span aria-hidden="true">☑</span>}
        <span className="av-chat-todo-title">{inFlight ? copy.todoUpdating : copy.todoProgress}</span>
        {progress.total > 0 ? (
          <>
            <progress
              aria-label={copy.todoProgressAria}
              className="av-chat-todo-progress"
              max={progress.total}
              value={progress.completed}
            />
            <span className="av-chat-todo-count">
              {progress.completed}/{progress.total} {copy.todoState.done}
            </span>
          </>
        ) : null}
      </summary>
      <div className={names(classes.cardDetail, "av-chat-todo-detail")}>
        <ToolTime at={entry.at} classes={classes} copy={copy} />
        <div className="av-chat-todo-overview">
          <strong>{copy.completed(progress.completed)}</strong>
          <span>{copy.pending(progress.open)}</span>
          {progress.activePhase ? <span>{copy.current(progress.activePhase)}</span> : null}
        </div>
        {progress.items.length ? (
          <ul className="av-chat-todo-list">
            {progress.items.map((item) => (
              <li className={`av-chat-todo-${item.state.replace("_", "-")}`} key={item.text}>
                <span className="av-chat-todo-icon" aria-hidden="true">{TODO_STATE_ICON[item.state]}</span>
                <span className="av-chat-todo-text">{item.text}</span>
                <span className="av-chat-todo-state">{copy.todoState[item.state]}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className={classes.muted}>{copy.todoEmpty}</div>
        )}
        <details className="av-chat-todo-raw">
          <summary>{copy.callDetails}</summary>
          <ToolFields entry={entry} inFlight={inFlight} classes={classes} copy={copy} onReadFullBlock={onReadFullBlock} />
        </details>
      </div>
    </details>
  );
}

export function TranscriptGroupView({
  group,
  classes,
  renderAssistant = renderPlainTextAssistant,
  renderSpinner,
  onCopyResponse,
  animateAssistant = false,
  onOpenFile,
  extractFilePaths,
  expanded,
  onToggle: onToggleProp,
  expansionOverrides,
  onToggleExpansion,
  todoCards = false,
  defaultWorkOpen,
  copy = DEFAULT_TRANSCRIPT_COPY,
  searchTarget,
  onReadFullBlock,
}: TranscriptGroupViewProps) {
  const [localExpanded, setLocalExpanded] = useState<boolean | undefined>();
  const onToggle = onToggleProp ?? setLocalExpanded;
  const workOpen = group.kind === "work" && (expanded ?? localExpanded ?? defaultWorkOpen ?? (group.busy || group.last));
  const [workVisited, setWorkVisited] = useState(workOpen);
  useEffect(() => { if (workOpen) setWorkVisited(true); }, [workOpen]);
  if (group.kind === "work") {
    // Provider default + sticky override. Otherwise `last` opens the final run
    // (which is also the one `busy` marks while a tool is in flight); a person
    // who folded or unfolded a group keeps that choice through every data
    // frame — a result arriving must never re-fold what the reader opened.
    const open = workOpen;
    // Once visited, a small run keeps nested controls and their DOM identity
    // while the native details element hides them. Never-opened history stays
    // lazy; a long run releases its virtual window while closed, avoiding
    // zero-height measurements of a hidden list. Its host-owned fold overrides
    // still restore when it reopens.
    const mountBody = open || (workVisited && group.entries.length <= TRANSCRIPT_STATIC_ROW_LIMIT);
    const thinkingCount = group.entries.filter((entry) => entry.kind === "thinking").length;
    const toolCount = group.entries.filter(isWork).length;
    return (
      <details className={classes.work} open={open}>
        <summary
          {...(onToggle
            ? {
              onClick: (event: ReactMouseEvent) => {
                // Controlled: the click reports intent; React re-renders the
                // fold from state. Letting the browser ALSO toggle the DOM
                // attribute would fork the two, and the next render would
                // snap it back — the exact flicker this exists to remove.
                event.preventDefault();
                onToggle(!open);
              },
            }
            : {})}
        >
          {copy.workSummary({ thinking: thinkingCount, tools: toolCount })}
          {group.busy ? copy.workRunning : open ? "" : copy.clickToExpand}
        </summary>
        {mountBody ? <VirtualTranscriptRows rows={group.entries} itemKey={(entry) => String(entry.anchor)} target={searchTarget} renderRow={(entry) => entry.kind === "thinking" ? (
          <div
            className={names(classes.thinking, "av-chat-work-thinking")}
            data-av-chat-work-kind="thinking"
            key={entry.anchor}
          >
            <CappedField anchor={entry.anchor} field="text" text={entry.text} entry={entry} read={onReadFullBlock} copy={copy} classes={classes}>
              {(text) => (
                <div className={classes.thinkingText}>
                  {text}{entry.truncated && text === entry.text ? "（已截断）" : ""}
                </div>
              )}
            </CappedField>
          </div>
        ) : (
          <ToolCard
            classes={classes}
            entry={entry}
            key={entry.anchor}
            renderSpinner={renderSpinner}
            todoCards={todoCards}
            copy={copy}
            {...(expansionOverrides && entryExpansionKey(entry) in expansionOverrides
              ? { expanded: expansionOverrides[entryExpansionKey(entry)] }
              : {})}
            {...(onToggleExpansion
              ? { onToggle: (open: boolean) => onToggleExpansion(entryExpansionKey(entry), open) }
              : {})}
            {...(onOpenFile ? { onOpenFile } : {})}
            {...(extractFilePaths ? { extractFilePaths } : {})}
            {...(onReadFullBlock ? { onReadFullBlock } : {})}
          />
        )} /> : null}
      </details>
    );
  }
  if (group.kind === "thinking") {
    return (
      <details className={classes.thinking} open={expanded ?? localExpanded ?? false}>
        <summary onClick={(event) => { event.preventDefault(); onToggle(!(expanded ?? localExpanded ?? false)); }}>{copy.thinking}{group.entry.truncated ? ` (${copy.truncated})` : ""}</summary>
        <CappedField anchor={group.entry.anchor} field="text" text={group.entry.text} entry={group.entry} read={onReadFullBlock} copy={copy} classes={classes}>
          {(text) => <div className={classes.thinkingText}>{text}</div>}
        </CappedField>
      </details>
    );
  }
  if (group.kind === "note") {
    return (
      <div className={classes.turn}>
        <div className={classes.operationMeta}>{group.entry.text}</div>
      </div>
    );
  }
  return (
    <ChatTurn
      role={group.role}
      classes={classes}
      label={
        <>
          {group.role === "user" ? copy.you : copy.assistant}
          {group.at ? <span title={group.at}> · {formatTime(group.at)}</span> : null}
        </>
      }
    >
      <VirtualTranscriptRows rows={group.entries} itemKey={(entry) => String(entry.anchor)} target={searchTarget} renderRow={(entry) => (
        <CappedField anchor={entry.anchor} field="text" text={entry.text} entry={entry} read={onReadFullBlock} copy={copy} classes={classes} key={entry.anchor}>
          {(text) => (
            <ProseEntry
              animateAssistant={animateAssistant}
              classes={classes}
              entry={text === entry.text ? entry : { ...entry, text }}
              renderAssistant={renderAssistant}
              role={group.role}
            />
          )}
        </CappedField>
      )} />
      {group.role === "assistant" && onCopyResponse && group.entries.some((entry) => entry.text.trim()) ? (
        <CopyResponse text={group.entries.map((entry) => entry.text).join("\n\n")} onCopy={onCopyResponse} copy={copy} />
      ) : null}
    </ChatTurn>
  );
}
