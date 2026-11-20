/**
 * Transcript logic that is not about SHAPE.
 *
 * Three things live here, and each one has already cost this repository a bug
 * when it was duplicated or nearly-duplicated somewhere:
 *
 *  1. **Rich blocks → `ViewEntry`.** The vocabulary (`user` / `assistant` /
 *     `thinking` / `tool` / `file` / `subagent` / `note`) is the existing answer
 *     to "three transcript formats, N presentations", so nothing downstream
 *     branches on which CLI wrote the log: a Codex `apply_patch` and a Claude
 *     `Edit` are both a `file` entry by the time anything renders.
 *  2. **Grouping, and the unit count that must mirror it.** A run of
 *     consecutive tool entries collapses behind ONE expander. Claude/OMP extend
 *     that same run across thinking blocks, so the thought/tool timeline
 *     still counts as one visible unit. If the counter and renderer disagree,
 *     the tail window and "load earlier" step disagree with what is on screen.
 *  3. **Activity derivation and its EXPIRY.** A finished headless run writes
 *     nothing to say it finished, so "is it still working" is a function of NOW
 *     and has to be re-evaluated on every tick. The first version of this
 *     derived a state once and let a one-second ticker repaint it forever, so a
 *     session that had stopped kept counting up for an hour.
 *
 * ── Trust direction ──────────────────────────────────────────────────────────
 *
 * This file is the canonical browser-side implementation for BOTH the
 * digest-addressed Agent View and the trusted Dashboard. It lives in a neutral
 * presentation package and depends only on the permission-free sessions
 * contract. Both release lanes point inward to this package; neither host can
 * acquire the other's runtime, identity, transport, or authority through it.
 *
 * This is emphatically not a second CLI parser: Claude/Codex JSONL parsing stays
 * in `@claude-bot/plugin-sessions`, on the device side. This layer receives a
 * bounded message window and derives only the entries and state a Host renders.
 */

import type { Activity, RichBlock, RichMessage } from "@claude-bot/agent-sessions-contract";
import { activityPhase, silenceOf } from "@claude-bot/agent-sessions-contract";
export type { Activity, RichBlock, RichMessage, TranscriptWindow } from "@claude-bot/agent-sessions-contract";

/** Metadata the scanner returns beside a transcript window. */
export interface TranscriptMeta {
  id?: string;
  source?: string;
  cwd?: string;
  git_branch?: string;
  started_at?: string;
  last_activity?: string;
  first_user_text?: string;
  activity?: Activity | null;
}

export type ViewEntryKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "file"
  | "subagent"
  | "note"
  | "elicit";

export interface ViewEntry {
  kind: ViewEntryKind;
  text: string;
  at?: string;
  input?: string;
  detail?: string;
  isError?: boolean;
  /** No recorded result: either still running, or the run died mid-call. */
  unpaired?: boolean;
  truncated?: boolean;
  /** Fields the page capped that a complete-block read can return (newer Runners only). */
  truncatedFields?: ReadonlyArray<"text" | "input" | "output">;
  /** Chinese is person-facing; English is the exact text sent to/from Claude. */
  bilingual?: { zh: string; en: string };
  /** Claude completed, but its English result could not be translated. */
  translationError?: string;
  /**
   * Stable identity: `absoluteMessageIndex.contentCoordinate`, where the
   * message index is window `offset` + position and the content coordinate is
   * the rich-block position (or its legacy equivalent). It survives pages
   * being prepended, a streaming block growing, and that block becoming a
   * completed entry. React keys and expansion state key on THIS — never on an
   * array index (design: frontend-interaction-stability-design.md §2 原则 1).
   */
  anchor: string;
}

/** A work-run entry after grouping has attached its own live fact. */
export type TranscriptWorkEntry = ViewEntry & { live: boolean };

/** Tools whose call is better described as "a file the agent touched". */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

function shortTool(name: string | undefined): string {
  return String(name || "tool").replace(/^mcp__[\w-]+__/, "");
}

/** Best-effort file name out of a tool input blob; "" when it says nothing. */
export function fileOf(input: string | undefined): string {
  if (!input) return "";
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const file = record.file_path ?? record.notebook_path ?? record.path;
      if (typeof file === "string" && file) return file;
    }
  } catch {
    // codex sends a patch, not JSON.
  }
  const match = /\*\*\* (?:Add|Update|Delete) File: ([^\n"]+)/.exec(input);
  return match ? match[1].trim() : "";
}

function truncatedFieldsOf(block: RichBlock): Pick<ViewEntry, "truncatedFields"> {
  const fields = Array.isArray(block.truncated_fields)
    ? block.truncated_fields.filter((field) => field === "text" || field === "input" || field === "output")
    : [];
  return fields.length ? { truncatedFields: fields } : {};
}

function entryOfTool(block: RichBlock, at?: string): Omit<ViewEntry, "anchor"> {
  const name = shortTool(block.tool);
  const entry: Omit<ViewEntry, "anchor"> = {
    kind: "tool",
    text: name,
    at,
    input: block.input || "",
    detail: block.output == null ? undefined : String(block.output),
    isError: Boolean(block.is_error),
    unpaired: block.output == null,
    truncated: Boolean(block.truncated),
    ...truncatedFieldsOf(block),
  };
  if (WRITE_TOOLS.has(name)) {
    const file = fileOf(block.input);
    if (file) {
      entry.kind = "file";
      entry.text = file;
    }
  } else if (name === "Task") {
    entry.kind = "subagent";
  }
  return entry;
}

export type TodoProgressState = "done" | "in_progress" | "pending" | "blocked";

export interface TodoProgressItem {
  text: string;
  state: TodoProgressState;
  phase?: string;
}

export interface TodoProgress {
  completed: number;
  total: number;
  open: number;
  activePhase?: string;
  items: TodoProgressItem[];
}

/**
 * OMP's `todo` result is deliberately person-readable text rather than a
 * browser contract. Derive a bounded progress card from the stable lines it
 * prints, while retaining the raw input/output in the tool detail as the
 * authoritative fallback.
 */
export function todoProgressOf(entry: ViewEntry): TodoProgress | null {
  if (entry.text.toLowerCase() !== "todo") return null;

  const items = new Map<string, TodoProgressItem>();
  let input: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(entry.input || "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch {
    // A malformed or legacy input can still have a complete result snapshot.
  }

  const phases = input?.list;
  if (Array.isArray(phases)) {
    for (const phase of phases) {
      if (!phase || typeof phase !== "object" || Array.isArray(phase)) continue;
      const row = phase as Record<string, unknown>;
      const phaseName = typeof row.phase === "string" ? row.phase : undefined;
      if (!Array.isArray(row.items)) continue;
      for (const value of row.items) {
        if (typeof value !== "string" || !value.trim()) continue;
        items.set(value, { text: value, state: "pending", ...(phaseName ? { phase: phaseName } : {}) });
      }
    }
  }

  const detail = entry.detail || "";
  let completed: number | undefined;
  let total: number | undefined;
  let open: number | undefined;
  let activePhase: string | undefined;
  for (const line of detail.split(/\r?\n/u)) {
    const overall = /^\s*Overall:\s*(\d+)\/(\d+)\s+done,\s*(\d+)\s+open\.\s*$/iu.exec(line);
    if (overall) {
      completed = Number(overall[1]);
      total = Number(overall[2]);
      open = Number(overall[3]);
      continue;
    }
    const active = /^\s*Active phase \d+\/\d+\s+"([^"]+)"/u.exec(line);
    if (active) {
      activePhase = active[1];
      continue;
    }
    const remaining = /^\s*-\s+(.+?)\s+\[(in_progress|pending|blocked)\](?:\s+\((.+)\))?\s*$/u.exec(line);
    if (remaining) {
      const text = remaining[1].trim();
      const previous = items.get(text);
      const phase = remaining[3]?.trim() || previous?.phase;
      items.set(text, {
        text,
        state: remaining[2] as TodoProgressState,
        ...(phase ? { phase } : {}),
      });
      continue;
    }
    const checkbox = /^\s*-\s+\[([ xX])\]\s+(.+?)(?:\s+\(in progress\))?\s*$/u.exec(line);
    if (checkbox) {
      const text = checkbox[2].replace(/\s+\(in progress\)\s*$/u, "").trim();
      const previous = items.get(text);
      const checked = checkbox[1].toLowerCase() === "x";
      items.set(text, {
        text,
        state: checked ? "done" : line.includes("(in progress)") ? "in_progress" : previous?.state ?? "pending",
        ...(previous?.phase || activePhase ? { phase: previous?.phase || activePhase } : {}),
      });
    }
  }

  if (input?.op === "done" && typeof input.task === "string" && input.task.trim()) {
    const text = input.task.trim();
    const previous = items.get(text);
    items.set(text, { text, state: "done", ...(previous?.phase ? { phase: previous.phase } : {}) });
  }

  const rows = [...items.values()];
  const knownDone = rows.filter((item) => item.state === "done").length;
  const knownOpen = rows.length - knownDone;
  const resolvedCompleted = completed ?? knownDone;
  const resolvedOpen = open ?? knownOpen;
  const resolvedTotal = total ?? Math.max(rows.length, resolvedCompleted + resolvedOpen);
  if (!detail && !rows.length) return null;
  return {
    completed: Math.min(resolvedCompleted, resolvedTotal),
    total: resolvedTotal,
    open: resolvedOpen,
    ...(activePhase ? { activePhase } : {}),
    items: rows,
  };
}

/**
 * Flatten a window of rich messages into the render vocabulary.
 *
 * `offset` is the window's absolute start (`TranscriptWindow.offset`): with it,
 * every entry carries a stable `anchor` that does not move when older pages are
 * prepended. Callers that render lists MUST pass it; the default keeps pure
 * unit-count uses working unchanged.
 */
export function entriesOf(messages: readonly RichMessage[] | undefined, offset = 0): ViewEntry[] {
  const out: ViewEntry[] = [];
  const absoluteOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  let index = 0;
  for (const message of messages ?? []) {
    const messageIndex = index++;
    const anchorAt = (contentCoordinate: number): string => (
      `${absoluteOffset + messageIndex}.${contentCoordinate}`
    );
    if (!message) continue;
    const role: ViewEntryKind = message.role === "user" ? "user" : "assistant";
    const at = message.timestamp;
    const blocks = message.blocks;
    if (blocks && blocks.length) {
      for (let b = 0; b < blocks.length; b++) {
        const block = blocks[b];
        if (!block) continue;
        if (block.type === "text") {
          if (String(block.text || "").trim()) {
            out.push({
              kind: role,
              text: String(block.text),
              at,
              truncated: Boolean(block.truncated),
              ...truncatedFieldsOf(block),
              anchor: anchorAt(b),
              ...(block.bilingual ? { bilingual: block.bilingual } : {}),
              ...(block.translation_error ? { translationError: block.translation_error } : {}),
            });
          }
        } else if (block.type === "thinking") {
          out.push({ kind: "thinking", text: String(block.text || ""), at, truncated: Boolean(block.truncated), ...truncatedFieldsOf(block), anchor: anchorAt(b) });
        } else if (block.type === "tool") {
          out.push({ ...entryOfTool(block, at), anchor: anchorAt(b) });
        }
      }
      continue;
    }
    // Old Runners that predate rich mode: degraded honestly rather than dropped.
    if (message.tool) out.push({ kind: "tool", text: shortTool(message.tool), at, input: "", unpaired: true, anchor: anchorAt(0) });
    // A text-only legacy frontier becomes rich block 0 when the scanner emits
    // its completed shape. Reusing coordinate 0 keeps that DOM node continuous;
    // when a legacy tool precedes the text, coordinate 1 mirrors rich ordering.
    if (message.text) out.push({ kind: role, text: String(message.text), at, anchor: anchorAt(message.tool ? 1 : 0) });
  }
  return out;
}

export function isWork(entry: ViewEntry): boolean {
  return entry.kind === "tool" || entry.kind === "file" || entry.kind === "subagent";
}

/** Renderer and tail pagination must count the same provider-specific runs. */
export function foldsThinking(cliKind?: string): boolean {
  return cliKind?.toLowerCase() === "omp" || cliKind?.toLowerCase() === "claude";
}

/**
 * Post-fold visible items: a run of consecutive work entries collapses into ONE
 * expander, so it counts as 1. For Claude/OMP, `foldThinking` extends that run through
 * adjacent thinking entries. This is the unit the tail window is measured in,
 * and it must agree with `groupEntries` or "load earlier" stops matching what
 * is on screen.
 *
 * It does NOT model the renderer's other merge: consecutive prose entries of one
 * role become a single turn, and this counts them individually. That makes the
 * number a conservative over-estimate of visible rows — the tail may be a little
 * longer than strictly needed, never shorter — which is the safe direction and
 * is the behaviour the stable Session Hub has always had.
 */
export function countUnits(entries: readonly ViewEntry[], foldThinking = false): number {
  let units = 0;
  let inRun = false;
  for (const entry of entries) {
    if (isWork(entry) || (foldThinking && entry.kind === "thinking")) {
      if (!inRun) {
        units++;
        inRun = true;
      }
    } else {
      units++;
      inRun = false;
    }
  }
  return units;
}

export type TranscriptGroup =
  | { kind: "prose"; role: "user" | "assistant"; at?: string; entries: ViewEntry[]; key: string }
  | { kind: "thinking"; entry: ViewEntry; key: string }
  | { kind: "note"; entry: ViewEntry; key: string }
  | {
    kind: "work";
    entries: TranscriptWorkEntry[];
    busy: boolean;
    key: string;
    /** True only for the LAST work run in the window — the default-open one. */
    last: boolean;
  };

/** A group's stable key is always derived from a normalized entry anchor. */
function groupKeyOf(kind: string, first: ViewEntry): string {
  return `${kind}:${first.anchor}`;
}

/**
 * Group entries into what the reader sees.
 *
 * Consecutive prose entries of one role become one turn (an assistant that
 * emitted three text blocks reads as one answer), and any run of consecutive
 * work entries collapses behind a single expander — the transcript reads as
 * prose until the reader asks for the machinery. When `foldThinking` is true,
 * adjacent thinking entries join the same run and render inline among its tool
 * cards. Claude and OMP use that mode; Codex keeps standalone thought folds.
 *
 * `running` means the session is blocked on a tool right now, so unpaired work
 * in the LAST run is in flight rather than lost. Only the last run: an unpaired
 * tool further up is genuinely dead.
 */
export function groupEntries(
  entries: readonly ViewEntry[],
  running = false,
  foldThinking = false,
): TranscriptGroup[] {
  const joinsWorkRun = (entry: ViewEntry): boolean => isWork(entry) || (foldThinking && entry.kind === "thinking");
  let lastRunStart = -1;
  if (running) {
    for (let k = entries.length - 1; k >= 0; k--) {
      if (!joinsWorkRun(entries[k])) break;
      lastRunStart = k;
    }
  }
  const out: TranscriptGroup[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if (joinsWorkRun(entry)) {
      const run: TranscriptWorkEntry[] = [];
      let busy = false;
      let j = i;
      while (j < entries.length && joinsWorkRun(entries[j])) {
        const work = isWork(entries[j]);
        const inRun = work && lastRunStart >= 0 && j >= lastRunStart;
        if (inRun && entries[j].unpaired) busy = true;
        run.push({ ...entries[j], live: inRun });
        j++;
      }
      out.push({ kind: "work", entries: run, busy, key: groupKeyOf("w", entry), last: false });
      i = j;
      continue;
    }
    if (entry.kind === "thinking") {
      out.push({ kind: "thinking", entry, key: groupKeyOf("t", entry) });
      i++;
      continue;
    }
    if (entry.kind === "note" || entry.kind === "elicit") {
      out.push({ kind: "note", entry, key: groupKeyOf("n", entry) });
      i++;
      continue;
    }
    const role: "user" | "assistant" = entry.kind === "user" ? "user" : "assistant";
    const turn: ViewEntry[] = [];
    let j = i;
    while (j < entries.length && entries[j].kind === entry.kind) {
      turn.push(entries[j]);
      j++;
    }
    out.push({ kind: "prose", role, at: entry.at, entries: turn, key: groupKeyOf("p", entry) });
    i = j;
  }
  // Exactly the final work run is `last` — the default-open one, per the
  // display rule "expand the last contiguous tool run, collapse the earlier".
  for (let k = out.length - 1; k >= 0; k--) {
    const group = out[k];
    if (group.kind !== "work") continue;
    group.last = true;
    break;
  }
  return out;
}

export function isRecent(iso: string | undefined | null, nowMs = Date.now(), ms = 120_000): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && nowMs - t < ms;
}

// ── activity ──

// The expiry rule lives in the neutral contract so the trusted Session Hub
// reports the same "running" as every View; it is re-exported unchanged.
export {
  QUIET_MS, TOOL_STALE_MS, activityPhase, isBusy, shouldFollow, silenceOf, type ActivityPhase,
} from "@claude-bot/agent-sessions-contract";

/**
 * The activity the provider vouches for, or the most that parsed messages alone
 * can prove. This belongs beside the CLI-neutral transcript vocabulary: every
 * host (Agent View, Session Hub and dev ticket) must make the same claim from
 * the same evidence.
 */
export function deriveActivity(
  meta: TranscriptMeta | null | undefined,
  messages: readonly RichMessage[] | undefined,
): Activity | null {
  const activity = meta?.activity;
  if (activity?.state) {
    // Old Runners send no observed_at; the last recorded write is the best
    // available stand-in, and without one the state can never expire.
    if (!activity.observed_at && meta?.last_activity) {
      return { ...activity, observed_at: meta.last_activity };
    }
    return activity;
  }
  const last = messages?.length ? messages[messages.length - 1] : null;
  const timestamp = last?.timestamp || meta?.last_activity;
  if (!isRecent(timestamp)) return null;
  if (last && entriesOf([last]).some((entry) => isWork(entry) && entry.unpaired)) {
    return { state: "tool", since: timestamp, observed_at: timestamp, degraded: true };
  }
  return { state: "running", since: timestamp, observed_at: timestamp, degraded: true };
}

/** Ellipsis-free so callers can add either "…" or the animated dots. */
export function activityLabel(activity: Activity | null | undefined): string {
  if (!activity) return "";
  if (activity.state === "thinking") return "💭 正在思考";
  if (activity.state === "responding") return "✍ 正在输出";
  if (activity.state === "tool") return `⚙ 正在执行 ${activity.tool || "工具"}`;
  if (activity.state === "idle") return "";
  return "⏳ 运行中";
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** Milliseconds since the state began, or -1 when there is no usable timestamp. */
export function elapsedOf(activity: Activity | null | undefined, nowMs: number): number {
  if (!activity?.since) return -1;
  const t = new Date(activity.since).getTime();
  if (!Number.isFinite(t)) return -1;
  return Math.max(0, nowMs - t);
}

/** One-line status for a live indicator; "" when there is nothing to say. */
export function activityStatus(activity: Activity | null | undefined, nowMs = Date.now()): string {
  const phase = activityPhase(activity, nowMs);
  if (!phase) return "";
  if (phase === "stale") return `⚠ 已 ${formatElapsed(silenceOf(activity, nowMs))}无新输出(可能已中断)`;
  const elapsed = elapsedOf(activity, nowMs);
  return `${activityLabel(activity)}…${elapsed >= 0 ? ` · 已 ${formatElapsed(elapsed)}` : ""}`;
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  try {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return iso;
    return date.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
  } catch {
    return iso;
  }
}
