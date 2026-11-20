import { readCodexTokenUsage, readSessionTurnConfiguration, unwrapPastedContent, type CodexTokenUsage, type SessionTurnConfiguration } from "@claude-bot/agent-sessions-contract";
/**
 * Pure, dependency-free parsers for Claude Code, Codex and Oh My Pi session logs.
 *
 * These formats are INTERNAL / PRIVATE to their respective tools and change
 * across versions, so every function here is defensive: an unrecognized or
 * malformed line is skipped, never thrown. Nothing in this file touches the
 * filesystem — the server layer feeds it raw file text so the logic stays
 * unit-testable with inline fixtures.
 *
 * Claude Code: <HOME>/.claude/projects/<slug>/<session-uuid>.jsonl
 *   one JSON event per line; role-bearing lines carry `message.role` +
 *   `message.content` where content is a string OR an array of blocks
 *   (text / thinking / tool_use / tool_result / ...).
 *
 * Codex: <HOME>/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   one JSON event per line shaped `{ timestamp, type, payload }`. The first
 *   line is `session_meta`; conversation turns arrive as event_msg
 *   user_message / agent_message, tool calls as response_item
 *   custom_tool_call / function_call.
 *
 * Oh My Pi (`omp`): <HOME>/.omp/agent/sessions/<slug>/<ts>_<uuid>.jsonl
 *   one JSON entry per line forming a parent-linked tree (`id`/`parentId`).
 *   A `session` line opens the file; conversation entries are `message` with
 *   `message.role` of user / assistant / **toolResult**. Unlike the other two
 *   CLIs a tool RESULT is its own top-level entry rather than a block inside
 *   the next user message, and a tool CALL is an assistant block typed
 *   `toolCall` (not `tool_use`) carrying `arguments` and a human `intent`.
 *   Non-conversation entries (`model_change`, `credential_pin`, `custom`, …)
 *   are bookkeeping and never become messages.
 */

import { ASYNC_QUESTION_INPUT_CAP, MemoryRichStorage, RichFactsAccumulator, isAsyncQuestion, type RichStorage } from "./rich-storage.js";

import type { CliKind } from "@claude-bot/agent-sessions-contract";

export type Source = CliKind;

/**
 * What the agent is doing RIGHT NOW, derived from the tail of the log.
 *
 * - `thinking`   — the ball is with the model (a user turn or a tool result
 *                  landed and nothing has come back yet)
 * - `tool`       — a tool call was emitted whose result has not arrived
 * - `responding` — an assistant line exists that did not terminate the turn
 * - `idle`       — the last turn ended normally
 */
export type ActivityState = "thinking" | "tool" | "responding" | "idle" | "unknown";

export interface SessionActivity {
  state: ActivityState;
  /** `tool` state: the tool(s) being awaited, comma-joined. */
  tool?: string;
  /** Timestamp of the log line that established this state. */
  since?: string;
  /**
   * Timestamp of the LAST line in the log, whatever it was. Viewers measure
   * silence from here to decide a turn is over: `since` only says when the
   * state began, which never grows for a session that stopped writing.
   */
  observed_at?: string;
}

export interface FlatMessage {
  role: string;
  text: string;
  /** Present when this message is (or contains) a tool call: comma-joined tool names. */
  tool?: string;
  /** Only on a page: this message alone exceeded the page and carries a text preview. */
  truncated?: boolean;
}

export interface SessionMeta {
  turn_configuration?: SessionTurnConfiguration | null;
  usage?: CodexTokenUsage;
  id?: string;
  source: Source;
  /** Claude: project slug (dir name). Filled by the server layer. */
  project?: string;
  cwd?: string;
  started_at?: string;
  last_activity?: string;
  /** Stable roster key: max(last real user prompt, last completed agent turn). */
  sort_activity?: string;
  /** Timestamp of the last agent turn that reached a terminal state. */
  completed_at?: string;
  message_count: number;
  git_branch?: string;
  version?: string;
  /** Provider-owned display title: Claude Code's chat name, or Oh My Pi's title. */
  title?: string;
  /**
   * Codex multi-agent v2 children and Claude sidechains belong to their parent
   * and have no independent external input route. Absent means the provider made
   * no such claim; callers must not infer ownership from a title or path.
   */
  input_mode?: "parent_owned";
  /** Provider-declared parent; lineage may exist without input ownership. */
  parent_session_id?: string;
  /** Provider-declared lineage, independent of direct-input capabilities. */
  is_subagent?: true;
  execution_mode?: "exec";
  first_user_text?: string;
  preview?: string;
  /** Live state of the agent at the end of the log; absent when undecidable. */
  activity?: SessionActivity;
}

export interface ParsedSession {
  meta: SessionMeta;
  messages: FlatMessage[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Parse one JSONL line, returning null on empty/whitespace/invalid JSON. */
export function safeJsonParse(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Only provider-declared terminal errors become chat notices; never stringify raw events. */
function stoppedText(provider: string, detail: string | undefined): string {
  return `⚠️ ${provider} 本轮工作已停止：${truncate(detail || "Agent 报告异常，但未提供具体原因。", 4_000)}`;
}

function errorDetail(value: unknown): string | undefined {
  const text = asString(value) ?? (isRecord(value) ? asString(value.message) : undefined);
  return text?.trim() || undefined;
}

function codexTerminalError(payload: Record<string, unknown>): boolean {
  if (payload.will_retry === true || payload.willRetry === true) return false;
  if (payload.type === "task_complete" || payload.type === "turn_complete" || payload.type === "turn_aborted") {
    // Modern Codex persists the terminal error on the end marker, not as a standalone event.
    return isRecord(payload.error) || Boolean(errorDetail(payload.error));
  }
  if (payload.type !== "error") return false;
  const info = payload.codex_error_info;
  // Native non-terminal input refusals leave the active turn running.
  return info !== "thread_rollback_failed" && info !== "active_turn_not_steerable"
    && !(isRecord(info) && "active_turn_not_steerable" in info);
}

function codexErrorText(payload: Record<string, unknown>): string {
  const text = stoppedText("Codex", errorDetail(payload.message) ?? errorDetail(payload.error));
  const error = isRecord(payload.error) ? payload.error : payload;
  if (error.codex_error_info !== "cyber_policy") return text;

  // Codex's TUI builds its Daybreak notice from this native error code; the
  // persisted message need not include that notice or its help links. Keep the
  // diagnostic and add neutral guidance without guessing account eligibility.
  const help = "https://help.openai.com/en/articles/20001326";
  const apply = "https://openai.com/form/enterprise-trusted-access-for-cyber/";
  return [text, "内容因 Codex 的网络安全策略限制而无法显示。",
    ...(!text.includes(help) ? [`了解详情：${help}`] : []),
    ...(!text.includes(apply) ? [`授权安全研究可了解 Daybreak 申请：${apply}`] : []),
  ].join("\n\n");
}

/**
 * Every literal the flat projection writes that is NOT copied from the log:
 * the stopped-turn notices, the cyber-policy guidance, the default tool name
 * and the default child title. A raw-byte search prefilter may only require
 * query words that cannot come from here. Derived from the synthesizers
 * themselves so a reworded notice cannot drift out of the vocabulary.
 */
export const FLAT_SYNTHESIZED_TEXT: string = [
  ...["Codex", "Claude Code", "OMP"].map((provider) => stoppedText(provider, undefined)),
  codexErrorText({ type: "error", codex_error_info: "cyber_policy" }),
  "tool",
  "子 Agent",
].join("\n");

function claudeErrorText(obj: Record<string, unknown>): string | undefined {
  if (obj.isApiErrorMessage === true) {
    const msg = isRecord(obj.message) ? obj.message : obj;
    return stoppedText("Claude Code", classifyContent(msg.content).text || errorDetail(obj.error));
  }
  if (obj.type === "result" && obj.is_error === true) {
    const errors = Array.isArray(obj.errors) ? obj.errors.slice(0, 8).map(errorDetail).filter(Boolean).join("\n") : undefined;
    return stoppedText("Claude Code", errors || errorDetail(obj.error) || errorDetail(obj.result));
  }
  return undefined;
}

function ompErrorText(msg: Record<string, unknown>): string | undefined {
  return msg.role === "assistant" && msg.stopReason === "error"
    ? stoppedText("OMP", errorDetail(msg.errorMessage)) : undefined;
}

/** Truncate to `n` characters, appending an ellipsis when it was longer. */
export function truncate(s: string, n = 120): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}

/**
 * Synthetic / injected text that isn't a genuine user or assistant turn:
 * slash-command wrappers, local-command caveats, environment/permission
 * context blocks, system reminders. Used to keep previews and message counts
 * meaningful.
 */
const NOISE_PREFIXES = [
  "<local-command",
  "<command-name",
  "<command-message",
  "<command-args",
  "<command-stdout",
  "<command-stderr",
  "<environment_context",
  "<permissions instructions",
  "<user_instructions",
  "<system-reminder",
  "<task-notification",
  "<task-id",
  "<tool-use-id",
  "<output-file",
  "caveat:",
  // Codex injects the auto-loaded AGENTS.md content as the FIRST user-role
  // response_item in the item stream. When a session has no event_msg
  // user_message (turn_context / turn_aborted variants), the parser falls
  // back to the item stream and this preamble becomes first_user_text —
  // the session list then shows "# AGENTS.md instructions ..." instead of
  // the actual user prompt. Both the "# AGENTS.md instructions" heading
  // (with or without a " for /path" suffix) and the raw `<INSTRUCTIONS>`
  // wrapper have been observed in real 0.132/0.144 codex logs.
  "# agents.md instructions",
  "<instructions>",
  "<codex_internal_context",
  "<recommended_plugins",
];

export function isNoiseText(s: string): boolean {
  const t = s.trimStart().toLowerCase();
  return NOISE_PREFIXES.some((p) => t.startsWith(p));
}

export interface ContentInfo {
  text: string;
  tools: string[];
  hasText: boolean;
  hasToolResult: boolean;
}

/**
 * Flatten anthropic/codex-style `content` (a plain string OR an array of
 * blocks) into text + the list of tool names invoked. Any block carrying a
 * string `text` field (type text / input_text / output_text / ...) contributes
 * to text; `tool_use` blocks contribute a tool name (with a truncated input
 * summary when `toolDetail` is on); `tool_result` blocks are noted but their
 * (often huge) payload is not inlined.
 */
export function classifyContent(content: unknown, opts?: { toolDetail?: boolean }): ContentInfo {
  if (typeof content === "string") {
    const text = content.trim();
    return { text, tools: [], hasText: text.length > 0, hasToolResult: false };
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    const tools: string[] = [];
    let hasToolResult = false;
    for (const block of content) {
      if (!isRecord(block)) continue;
      const type = asString(block.type) ?? "";
      if (type === "tool_use") {
        const name = asString(block.name);
        const base = name && name.trim() ? name : "tool";
        if (opts?.toolDetail && block.input !== undefined) {
          let inputStr = "";
          try {
            inputStr = JSON.stringify(block.input);
          } catch {
            inputStr = String(block.input);
          }
          tools.push(`${base}(${truncate(inputStr, 160)})`);
        } else {
          tools.push(base);
        }
      } else if (type === "tool_result") {
        hasToolResult = true;
      } else if (type === "thinking" || type === "redacted_thinking") {
        // internal reasoning — intentionally omitted from the transcript
        continue;
      } else if (typeof block.text === "string" && block.text.trim()) {
        parts.push(block.text);
      }
    }
    const text = parts.join("\n").trim();
    return { text, tools, hasText: text.length > 0, hasToolResult };
  }
  return { text: "", tools: [], hasText: false, hasToolResult: false };
}

/** Thin wrapper: text + tool names only. */
export function flattenContent(content: unknown): { text: string; tools: string[] } {
  const info = classifyContent(content);
  return { text: info.text, tools: info.tools };
}

// ---------------------------------------------------------------------------
// Id derivation from a file path
// ---------------------------------------------------------------------------

/**
 * Claude id = filename stem; Codex id = uuid embedded in
 * `rollout-<ts>-<uuid>.jsonl`; omp id = uuid (v7) suffix of
 * `<iso-ts>_<uuid>.jsonl`.
 */
export function deriveIdFromPath(source: Source, filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const stem = base.replace(/\.jsonl$/i, "");
  if (source === "codex" || source === "omp") {
    const m = stem.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/);
    if (m) return m[1];
  }
  return stem;
}

// ---------------------------------------------------------------------------
// Timestamp accumulation (ISO-8601 with 'Z' sorts lexicographically)
// ---------------------------------------------------------------------------

class TimeRange {
  first: string | undefined;
  last: string | undefined;
  add(ts: unknown): void {
    const s = asString(ts);
    if (!s) return;
    if (this.first === undefined || s < this.first) this.first = s;
    if (this.last === undefined || s > this.last) this.last = s;
  }
}

// ---------------------------------------------------------------------------
// Activity tracking ("what is this agent doing right now")
// ---------------------------------------------------------------------------
//
// The dashboard used to show NOTHING while an agent was thinking or waiting
// on a tool: the log only gains a line once a whole message is committed, so
// a busy session and a finished one looked identical. The tail of the log
// does carry the answer — an emitted tool_use whose tool_result hasn't landed
// means "running that tool", and Claude's `stop_reason` says whether the last
// assistant line ended the turn. Both are PRIVATE CLI formats, so every read
// here is defensive: anything unrecognized degrades to `responding`/`idle`
// rather than throwing, and callers still have `last_activity` as a fallback.
//
// Deliberately NOT decided here: staleness. A session killed mid-tool leaves
// a pending tool forever, and a finished `claude -p` writes NO record saying
// it finished — only the viewer knows "now", so it measures silence from
// `observed_at` and drops the strip (or degrades it to "possibly
// interrupted") on its own clock. What this file owes the viewer is an
// honest state plus the timestamp to measure against — never `undefined`,
// which older viewers turned into a vague "running" that never expired.

/** Terminal `stop_reason` values: the assistant closed its turn. */
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);

/**
 * Claude Code writes one of these as a user line when Esc stops a turn. It is
 * not a prompt: the turn is over, and the CLI fires no Stop hook for it.
 */
const CLAUDE_INTERRUPT_MARKERS = new Set(["[Request interrupted by user]", "[Request interrupted by user for tool use]"]);

/** How many in-flight tool names to name before summarizing. */
const ACTIVITY_TOOL_NAMES = 3;

interface PendingTool {
  name: string;
  ts?: string;
}

type LastEvent =
  | { kind: "user_prompt" | "tool_result" | "assistant_done" | "assistant_open"; ts?: string }
  | undefined;

/** Shared tail: pending tool calls win, otherwise the last event decides. */
class ActivityTracker {
  protected pending = new Map<string, PendingTool>();
  protected last: LastEvent;
  /** Codex only: a turn is open between task_started and task_complete. */
  protected turnOpen = false;
  protected turnTs: string | undefined;
  protected lastUserAt: string | undefined;
  protected lastCompletedAt: string | undefined;
  protected addTool(id: string | undefined, name: string | undefined, ts: string | undefined): void {
    // A tool without an id can never be paired; tracking it would pin the
    // session to "running" forever, so it is skipped on purpose.
    if (!id) return;
    this.pending.set(id, { name: name && name.trim() ? name : "tool", ts });
  }

  protected clearTool(id: string | undefined): void {
    if (id) this.pending.delete(id);
  }
  protected noteUser(ts: string | undefined): void {
    if (ts && (!this.lastUserAt || ts > this.lastUserAt)) this.lastUserAt = ts;
  }

  protected noteCompleted(ts: string | undefined): void {
    if (ts && (!this.lastCompletedAt || ts > this.lastCompletedAt)) this.lastCompletedAt = ts;
  }

  ordering(): { sortActivity?: string; completedAt?: string } {
    const sortActivity = !this.lastUserAt
      ? this.lastCompletedAt
      : !this.lastCompletedAt || this.lastUserAt > this.lastCompletedAt
        ? this.lastUserAt
        : this.lastCompletedAt;
    return {
      ...(sortActivity ? { sortActivity } : {}),
      ...(this.lastCompletedAt ? { completedAt: this.lastCompletedAt } : {}),
    };
  }

  finish(): SessionActivity {
    if (this.pending.size > 0) {
      const entries: PendingTool[] = [];
      for (const entry of this.pending.values()) {
        entries.push(entry);
        if (entries.length >= ACTIVITY_TOOL_NAMES) break;
      }
      const names = entries.map((t) => t.name);
      const tool = this.pending.size > ACTIVITY_TOOL_NAMES ? `${names.join(", ")} 等 ${this.pending.size} 个` : names.join(", ");
      return { state: "tool", tool, since: entries[0].ts };
    }
    if (!this.last) return this.turnOpen ? { state: "thinking", since: this.turnTs } : { state: "unknown" };
    switch (this.last.kind) {
      // A user prompt or a returned tool result both mean: the model owes us
      // the next move and hasn't written anything yet.
      case "user_prompt":
      case "tool_result":
        return { state: "thinking", since: this.last.ts };
      case "assistant_open":
        return { state: "responding", since: this.last.ts };
      default:
        return { state: "idle", since: this.last.ts };
    }
  }
}

/** Stamp the last-seen log time onto an activity so viewers can time silence. */
function withObserved(a: SessionActivity, observedAt: string | undefined): SessionActivity {
  return observedAt ? { ...a, observed_at: observedAt } : a;
}

function finalizeActivity(meta: SessionMeta, tracker: ActivityTracker): void {
  meta.activity = withObserved(tracker.finish(), meta.last_activity);
  const ordering = tracker.ordering();
  meta.sort_activity = ordering.sortActivity;
  meta.completed_at = ordering.completedAt;
}

class ClaudeActivityTracker extends ActivityTracker {
  /** Feed every parsed JSONL record, in file order. */
  line(obj: Record<string, unknown>): void {
    const type = asString(obj.type);
    // Explicit end-of-turn records: a headless run's `result` line, or an API
    // error. Both close the turn — including any tool we were waiting on.
    if (type === "result" || obj.isApiErrorMessage === true) {
      this.pending.clear();
      this.last = { kind: "assistant_done", ts: asString(obj.timestamp) };
      this.noteCompleted(asString(obj.timestamp));
      return;
    }
    if (type !== "user" && type !== "assistant") return;
    if (isClaudeMeta(obj)) return;
    const msg = isRecord(obj.message) ? obj.message : obj;
    const role = asString(msg.role) ?? type;
    const ts = asString(obj.timestamp);
    const content = msg.content;

    if (role === "assistant") {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (isRecord(b) && asString(b.type) === "tool_use") this.addTool(asString(b.id), asString(b.name), ts);
        }
      }
      const stop = asString(msg.stop_reason);
      // `tool_use` is handled by the pending map; an unknown/absent reason
      // means the line did not close the turn, so more output is coming.
      const done = stop !== undefined && TERMINAL_STOP_REASONS.has(stop);
      if (done) this.noteCompleted(ts);
      this.last = { kind: done ? "assistant_done" : "assistant_open", ts };
      return;
    }

    // user line: real prompt, tool_result feedback, interrupt marker, or injected noise.
    const interrupted = typeof content === "string" ? CLAUDE_INTERRUPT_MARKERS.has(content.trim())
      : Array.isArray(content) && content.some((b) => isRecord(b) && typeof b.text === "string" && CLAUDE_INTERRUPT_MARKERS.has(b.text.trim()));
    if (interrupted) {
      this.pending.clear();
      this.last = { kind: "assistant_done", ts };
      return;
    }
    if (typeof content === "string") {
      if (content.trim() && !isNoiseText(content)) {
        this.noteUser(ts);
        this.last = { kind: "user_prompt", ts };
      }
      return;
    }
    if (!Array.isArray(content)) return;
    let sawPrompt = false;
    let sawResult = false;
    for (const b of content) {
      if (!isRecord(b)) continue;
      const bt = asString(b.type);
      if (bt === "tool_result") {
        this.clearTool(asString(b.tool_use_id));
        sawResult = true;
      } else if (bt === "image") {
        sawPrompt = true;
      } else if (typeof b.text === "string" && b.text.trim() && !isNoiseText(b.text)) {
        sawPrompt = true;
      }
    }
    if (sawPrompt) {
      this.noteUser(ts);
      this.last = { kind: "user_prompt", ts };
    }
    else if (sawResult) this.last = { kind: "tool_result", ts };
  }
}

class CodexActivityTracker extends ActivityTracker {
  /** Feed every parsed payload (already unwrapped), in file order. */
  line(payload: Record<string, unknown>, ts: string | undefined): void {
    const pt = asString(payload.type);
    switch (pt) {
      case "task_started":
      case "turn_started":
        this.turnOpen = true;
        this.turnTs = ts;
        if (this.last?.kind === "assistant_done") this.last = undefined;
        return;
      case "task_complete":
      case "turn_complete":
      case "turn_aborted":
      case "error":
        if (pt === "error" && !codexTerminalError(payload)) return;
        this.pending.clear();
        this.turnOpen = false;
        this.last = { kind: "assistant_done", ts };
        this.noteCompleted(ts);
        return;
      case "user_message":
        this.noteUser(ts);
        this.last = { kind: "user_prompt", ts };
        return;
      case "agent_message":
        // Codex may keep working after a message; the open turn decides.
        if (!this.turnOpen) this.noteCompleted(ts);
        this.last = { kind: this.turnOpen ? "assistant_open" : "assistant_done", ts };
        return;
      case "custom_tool_call":
      case "function_call":
        this.addTool(asString(payload.call_id), asString(payload.name), ts);
        return;
      case "custom_tool_call_output":
      case "function_call_output":
        this.clearTool(asString(payload.call_id));
        this.last = { kind: "tool_result", ts };
        return;
      default:
        return;
    }
  }
}

/**
 * omp has no `stop_reason` and no task_started/task_complete pair: the log IS
 * the agent loop. An assistant entry that emitted tool calls is waiting on
 * their `toolResult` entries; one that only produced text closed the turn;
 * one that produced nothing but reasoning is still mid-answer.
 */
class OmpActivityTracker extends ActivityTracker {
  /** Feed every parsed top-level entry, in file order. */
  line(obj: Record<string, unknown>): void {
    const type = asString(obj.type);
    const ts = asString(obj.timestamp);
    if (type !== "message") return;
    const msg = isRecord(obj.message) ? obj.message : undefined;
    if (!msg) return;
    const role = asString(msg.role);

    if (role === "toolResult") {
      this.clearTool(asString(msg.toolCallId));
      this.last = { kind: "tool_result", ts };
      return;
    }
    if (role === "user") {
      const info = classifyOmpContent(msg.content);
      if (info.hasText && !isNoiseText(info.text)) {
        this.noteUser(ts);
        this.last = { kind: "user_prompt", ts };
      }
      return;
    }
    if (role !== "assistant") return;
    if (ompErrorText(msg)) {
      this.pending.clear();
      this.last = { kind: "assistant_done", ts };
      this.noteCompleted(ts);
      return;
    }

    const info = classifyOmpContent(msg.content);
    for (const call of info.calls) this.addTool(call.id, call.name, ts);
    // Emitting a tool call keeps the pending map authoritative; `last` only
    // decides when nothing is outstanding.
    if (info.calls.length > 0) this.last = { kind: "assistant_open", ts };
    else {
      if (info.hasText) this.noteCompleted(ts);
      this.last = { kind: info.hasText ? "assistant_done" : "assistant_open", ts };
    }
  }
}

// ---------------------------------------------------------------------------
// Oh My Pi content blocks
// ---------------------------------------------------------------------------

interface OmpToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
  intent?: string;
}

interface OmpContentInfo {
  text: string;
  thinking: string[];
  calls: OmpToolCall[];
  hasText: boolean;
  hasImage: boolean;
}

/**
 * Flatten one omp `message.content` array. Blocks are the pi/omp spelling —
 * `toolCall` rather than Anthropic's `tool_use` — and a `thinking` block keeps
 * its payload under `thinking`, so this cannot reuse `classifyContent`.
 */
export function classifyOmpContent(content: unknown): OmpContentInfo {
  const out: OmpContentInfo = { text: "", thinking: [], calls: [], hasText: false, hasImage: false };
  if (typeof content === "string") {
    out.text = content.trim();
    out.hasText = out.text.length > 0;
    return out;
  }
  if (!Array.isArray(content)) return out;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = asString(block.type) ?? "";
    if (type === "toolCall") {
      out.calls.push({
        id: asString(block.id),
        name: asString(block.name),
        arguments: block.arguments,
        intent: asString(block.intent),
      });
    } else if (type === "thinking") {
      const thought = asString(block.thinking) ?? asString(block.text) ?? "";
      if (thought.trim()) out.thinking.push(thought);
    } else if (type === "image") {
      out.hasImage = true;
    } else if (typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text);
    }
  }
  out.text = parts.join("\n").trim();
  out.hasText = out.text.length > 0;
  return out;
}

/** A tool label for the flat projection: `name` or `name(args…)`. */
function ompToolLabel(call: OmpToolCall, toolDetail: boolean | undefined): string {
  const base = call.name && call.name.trim() ? call.name : "tool";
  if (!toolDetail || call.arguments === undefined) return base;
  let inputStr: string;
  try {
    inputStr = JSON.stringify(call.arguments);
  } catch {
    inputStr = String(call.arguments);
  }
  return `${base}(${truncate(inputStr, 160)})`;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/**
 * Claude Code writes what it injects on the person's side as `isMeta` user
 * lines: a loaded skill's body (tied to its Skill call by `sourceToolUseID`),
 * an expanded command template, a caveat. Compaction continuation summaries
 * carry `isCompactSummary` instead. None of these were typed by the person;
 * use native metadata, never guesses based on the person's prose.
 */
function isClaudeMeta(obj: Record<string, unknown>): boolean {
  return (obj.isMeta === true || obj.isCompactSummary === true) && asString(obj.type) === "user";
}

/**
 * A prompt the person submitted while Claude was busy.
 *
 * Claude records such a prompt only as a `queued_command` attachment, written
 * where a turn read it. There is no `type: "user"` line for it, so a reader
 * that knows only user lines shows the reply but loses the person's words.
 * Background-task notifications and other agents' messages use the same
 * attachment with a non-human origin and stay out of the transcript. An absent
 * origin is an older or SDK transcript and counts as human, as in the Runner's
 * input receipt. Returns the displayed text, or undefined for any other line.
 */
function claudeQueuedPrompt(obj: Record<string, unknown>): string | undefined {
  if (asString(obj.type) !== "attachment" || !isRecord(obj.attachment)) return undefined;
  const attachment = obj.attachment;
  if (asString(attachment.type) !== "queued_command") return undefined;
  const origin = attachment.origin;
  if (origin !== undefined && !(isRecord(origin) && origin.kind === "human")) return undefined;
  const mode = asString(attachment.commandMode);
  if (mode !== undefined && mode !== "prompt") return undefined;
  const prompt = attachment.prompt;
  const parts = typeof prompt === "string" ? [prompt] : Array.isArray(prompt)
    ? prompt.flatMap((b) => !isRecord(b) ? [] : asString(b.type) === "image" ? ["🖼 [图片]"]
      : typeof b.text === "string" ? [b.text] : [])
    : [];
  const raw = parts.join("\n").trim();
  if (!raw || isNoiseText(raw)) return undefined;
  return unwrapPastedContent(raw).trim() || undefined;
}

function claudeLineToMessage(obj: Record<string, unknown>, opts?: { toolDetail?: boolean }): FlatMessage | null {
  const error = claudeErrorText(obj);
  if (error) return { role: "assistant", text: error };
  const queued = claudeQueuedPrompt(obj);
  if (queued) return { role: "user", text: queued };
  const type = asString(obj.type);
  if (type !== "user" && type !== "assistant") return null;
  if (isClaudeMeta(obj)) return null;

  // Normally the payload is under `message`; tolerate a flattened variant.
  const msg = isRecord(obj.message) ? obj.message : obj;
  const role = asString(msg.role) ?? type;
  const info = classifyContent(msg.content, opts);

  if (role === "user") {
    // tool_result feedback turns and command/caveat wrappers are not genuine
    // user messages.
    if (!info.hasText) return null;
    if (isNoiseText(info.text)) return null;
    return { role: "user", text: unwrapPastedContent(info.text).trim() };
  }

  // assistant
  const tool = info.tools.length ? info.tools.join(", ") : undefined;
  if (!info.hasText && !tool) return null; // e.g. thinking-only line
  const out: FlatMessage = { role: "assistant", text: info.text };
  if (tool) out.tool = tool;
  return out;
}

/** Claude sidechains carry the parent sessionId and their own agentId. */
function claudeSessionIdentity(obj: Record<string, unknown>, meta: SessionMeta): void {
  const parent = asString(obj.sessionId);
  const agent = asString(obj.agentId);
  if (obj.isSidechain === true && parent) {
    meta.id = agent && /^[A-Za-z0-9_-]{1,150}$/.test(agent) ? `agent-${agent}` : undefined;
    meta.parent_session_id = parent;
    meta.is_subagent = true;
    meta.input_mode = "parent_owned";
  } else if (!meta.id && !meta.is_subagent) {
    meta.id = parent;
  }
}

/**
 * Claude Code's own name for a chat, the one its terminal title shows: the
 * latest `--name`/`/rename` (`custom-title`), else the latest generated
 * `ai-title`. Both records repeat as the session runs; the last one wins.
 */
class ClaudeTitle {
  private custom: string | undefined;
  private generated: string | undefined;

  /** Consumes a title record; every other line is left to the caller. */
  line(obj: Record<string, unknown>): boolean {
    const type = asString(obj.type);
    if (type === "custom-title") this.custom = asString(obj.customTitle)?.trim();
    else if (type === "ai-title") this.generated = asString(obj.aiTitle)?.trim();
    else return false;
    return true;
  }

  apply(meta: SessionMeta): void {
    const title = this.custom || this.generated;
    if (title) meta.title = truncate(title);
  }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/**
 * Read the one Codex session_meta shape in one place so the flat roster pass
 * and rich transcript pass cannot disagree about thread ownership.
 *
 * Current Codex rollouts redundantly persist `parent_thread_id`,
 * `thread_source: "subagent"`, and the externally-tagged
 * `source.subagent.thread_spawn`. Requiring v2 plus both parent identity and a
 * subagent source is deliberate: older/unknown formats stay ordinary rather
 * than being guessed read-only.
 */
function codexMetaLine(payload: Record<string, unknown>, meta: SessionMeta, time: TimeRange): void {
  if (!meta.id) meta.id = asString(payload.id) ?? asString(payload.session_id);
  if (!meta.cwd) meta.cwd = asString(payload.cwd);
  if (!meta.version) meta.version = asString(payload.cli_version);
  time.add(payload.timestamp);
  const git = payload.git;
  if (isRecord(git) && !meta.git_branch) meta.git_branch = asString(git.branch);

  // `codex exec` writes `originator: codex_exec`, including on the forks a
  // harness makes with `exec resume`, whose `source` it records as "vscode".
  // TUI, app-server and Octopus-managed rollouts name other originators.
  if (payload.source === "exec" || payload.originator === "codex_exec") meta.execution_mode = "exec";
  const source = isRecord(payload.source) ? payload.source : undefined;
  // This parser reads the persisted Rust/serde shape, not app-server JSON.
  // Never accept a bare parent id by itself.
  const subagent = source && isRecord(source.subagent) ? source.subagent : undefined;
  const spawn = subagent && isRecord(subagent.thread_spawn)
    ? subagent.thread_spawn
    : subagent && isRecord(subagent.spawn) ? subagent.spawn : undefined;
  const directParent = asString(payload.parent_thread_id);
  const spawnedParent = asString(spawn?.parent_thread_id);
  const parent = directParent ?? spawnedParent;
  const conflictingSource = typeof payload.source === "string" && payload.source !== "subagent";
  const conflictingParent = directParent && spawnedParent && directParent !== spawnedParent;
  const declaredSubagent = !conflictingSource && !conflictingParent
    && (asString(payload.thread_source) === "subagent" || Boolean(spawn));
  if (declaredSubagent && parent && parent !== meta.id) {
    meta.is_subagent = true;
    meta.parent_session_id = parent;
    // Forked children contain copied user prompts. Those prompts are history,
    // not the child's identity: use only the provider's own task/name fields.
    const agentPath = asString(payload.agent_path) ?? asString(spawn?.agent_path);
    const task = agentPath?.split("/").filter(Boolean).at(-1);
    const nickname = asString(payload.agent_nickname) ?? asString(spawn?.agent_nickname);
    meta.title = [task, nickname].filter(Boolean).join(" · ").slice(0, 240)
      || `子 Agent ${meta.id?.slice(0, 8) ?? ""}`.trim();
  }
  if (
    asString(payload.multi_agent_version) === "v2"
    && declaredSubagent
    && parent
    && parent !== meta.id
  ) {
    meta.input_mode = "parent_owned";
    meta.parent_session_id = parent;
  }
}

type Channel = "event" | "item" | "tool";
interface CodexEntry {
  msg: FlatMessage;
  channel: Channel;
}

/**
 * A resumed/forked log can contain item-only history followed by event messages.
 * Only adjacent matching prose from opposite channels proves a duplicate;
 * seeing an event does not make every historical item redundant. Keep one
 * record across append batches, consume each mirror once, and stop matching at
 * native turn boundaries. Tools/reasoning do not participate in prose dedupe.
 */
class CodexMessageDedupe {
  private previous?: { role: string; text: string; channel: Channel };

  reset(): void { this.previous = undefined; }

  boundary(type: unknown): void {
    if (type === "session_meta" || type === "task_started" || type === "turn_started"
      || type === "task_complete" || type === "turn_complete" || type === "turn_aborted"
      || type === "thread_rolled_back") this.reset();
  }

  accept(message: Pick<FlatMessage, "role" | "text">, channel: Channel): boolean {
    if (channel === "tool") return true;
    const current = { role: message.role, text: message.text.trim(), channel };
    const previous = this.previous;
    if (previous && previous.channel !== channel && previous.role === current.role && previous.text === current.text) {
      this.previous = undefined;
      return false;
    }
    this.previous = current;
    return true;
  }
}

function codexLineToEntry(payload: Record<string, unknown>, opts?: { toolDetail?: boolean }): CodexEntry | null {
  const pt = asString(payload.type);
  // "tool" is the always-retained channel. An error must not hide item-only history.
  if (codexTerminalError(payload)) return { msg: { role: "assistant", text: codexErrorText(payload) }, channel: "tool" };

  if (pt === "user_message") {
    const text = (asString(payload.message) ?? "").trim();
    if (!text || isNoiseText(text)) return null;
    return { msg: { role: "user", text }, channel: "event" };
  }
  if (pt === "agent_message") {
    const text = (asString(payload.message) ?? "").trim();
    if (!text) return null;
    return { msg: { role: "assistant", text }, channel: "event" };
  }
  if (pt === "custom_tool_call" || pt === "function_call") {
    const name = asString(payload.name);
    const base = name && name.trim() ? name : "tool";
    const args = asString(payload.arguments) ?? asString(payload.input);
    const tool = opts?.toolDetail && args ? `${base}(${truncate(args, 160)})` : base;
    return { msg: { role: "assistant", text: "", tool }, channel: "tool" };
  }
  if (pt === "message") {
    // response_item message: also carries developer/system injections — keep
    // only user/assistant and drop noise. Deduped against the event channel later.
    const role = asString(payload.role);
    if (role !== "user" && role !== "assistant") return null;
    const info = classifyContent(payload.content);
    if (!info.hasText || isNoiseText(info.text)) return null;
    return { msg: { role, text: info.text }, channel: "item" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Oh My Pi
// ---------------------------------------------------------------------------

/**
 * Read the entries every omp parser needs from one top-level line, so the flat
 * and rich passes cannot drift on what counts as meta, noise or a turn.
 */
function ompMetaLine(obj: Record<string, unknown>, meta: SessionMeta): boolean {
  const type = asString(obj.type);
  if (type === "session") {
    if (!meta.id) meta.id = asString(obj.id);
    if (!meta.cwd) meta.cwd = asString(obj.cwd);
    if (!meta.version) meta.version = asString(obj.version) ?? asString(obj.appVersion);
    // Older omp bytes may only carry the launch title on the session row.
    if (meta.title === undefined) {
      const title = asString(obj.title);
      if (title !== undefined) meta.title = truncate(title);
    }
    return true;
  }
  if (type === "title" || type === "title_change") {
    // The standalone header is omp's canonical auto/manual title. A later
    // title_change wins; an empty title intentionally falls back in the View.
    const title = asString(obj.title);
    if (title !== undefined) meta.title = truncate(title);
    return true;
  }
  // Remaining *_change and bookkeeping entries are session state, not
  // conversation.
  return type === "model_change" || type === "thinking_level_change"
    || type === "credential_pin" || type === "custom" || type === "session_meta";
}

// ---------------------------------------------------------------------------
// Rich (block-level) parsing — the transcript-viewer variant
// ---------------------------------------------------------------------------
//
// The flat parser above serves the secretary's skim: tool calls collapse into
// a comma-joined name string and tool RESULTS are dropped entirely. A human
// reviewing a session in the dashboard needs the Claude-Code-like view: each
// message as ordered blocks, tool calls paired with their results (Claude
// puts results in the NEXT user line, Codex in a separate *_output event),
// thinking kept but clearly marked. The parser keeps every block complete;
// a transcript PAGE caps thinking and tool details (`capRichBlock`) so one huge
// tool result can't balloon it, and the complete block stays reachable through
// a block read (rich-file.ts). Conversation text is not capped per block:
// message paging cannot recover a suffix discarded inside one text block.

export {
  RICH_BLOCK_FIELDS,
  RICH_INPUT_CAP,
  RICH_OUTPUT_CAP,
  RICH_THINKING_CAP,
  capRichBlock,
  richFieldCap,
  type RichBlockField,
} from "./rich-storage.js";

export interface RichBlock {
  type: "text" | "thinking" | "tool";
  /** text / thinking payload. */
  text?: string;
  /** tool blocks: tool name. */
  tool?: string;
  /** tool blocks: JSON-encoded input (capped). */
  input?: string;
  /** Native Codex async-question id, used only for answer correlation. */
  call_id?: string;
  /** tool blocks: result text, filled when the paired result arrives (capped). */
  output?: string;
  is_error?: boolean;
  /** Some part of this block hit a cap. */
  truncated?: boolean;
  /** Which fields a page capped; a block read returns each of them whole. */
  truncated_fields?: Array<"text" | "input" | "output">;
  /** Present only for Claude turns translated by its device-local Runner. */
  bilingual?: { zh: string; en: string };
  /** Translation failure is display metadata; the provider result remains intact. */
  translation_error?: string;
}

export interface RichMessage {
  role: "user" | "assistant";
  timestamp?: string;
  blocks: RichBlock[];
}

export interface RichParsedSession {
  meta: SessionMeta;
  messages: RichMessage[];
}

function jsonify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function textBlock(raw: string): RichBlock {
  // A fixed prefix also hides subsequent growth from change-aware tail reads.
  // Keep one provider block/anchor and its Markdown intact across refreshes.
  return { type: "text", text: raw.trim() };
}

function thinkingBlock(raw: string): RichBlock {
  return { type: "thinking", text: raw.trim() };
}

function toolBlock(name: string | undefined, input: unknown): RichBlock {
  const b: RichBlock = { type: "tool", tool: name && name.trim() ? name : "tool" };
  if (input !== undefined) b.input = jsonify(input).trim();
  return b;
}

/** Attach a result to its tool block (found via the id map). */
function attachToolOutput(block: RichBlock | undefined, output: unknown, isError: boolean): void {
  if (!block) return;
  const raw = typeof output === "string" ? output : classifyContent(output).text || jsonify(output);
  block.output = raw.trim();
  if (isError) block.is_error = true;
}

/** Preserve flat metadata semantics without projecting every historical text body. */
function finalizeRichMeta(meta: SessionMeta, storage: RichStorage, time: TimeRange, summary: string | undefined): void {
  const facts = storage.facts();
  meta.message_count = facts.count;
  meta.started_at = time.first;
  meta.last_activity = time.last;
  meta.first_user_text = facts.firstUser;
  meta.preview = facts.preview ?? (summary ? truncate(summary) : undefined);
}

function createClaudeRichParser(storage: RichStorage): RichSessionParser {
  const time = new TimeRange();
  const meta: SessionMeta = { source: "claude", message_count: 0 };
  let summary: string | undefined;
  const activity = new ClaudeActivityTracker();
  /** tool_use id → its block, so the result (in a LATER user line) can attach. */

  const append = (text: string | readonly unknown[]): void => {
    for (const obj of typeof text === "string" ? text.split(/\r?\n/).map(safeJsonParse) : text) {
      if (!isRecord(obj)) continue;

      time.add(obj.timestamp);
      activity.line(obj);
      if (!meta.cwd) meta.cwd = asString(obj.cwd);
      claudeSessionIdentity(obj, meta);
      if (!meta.git_branch) meta.git_branch = asString(obj.gitBranch);
      if (!meta.version) meta.version = asString(obj.version);

      if (asString(obj.type) === "summary") {
        summary = asString(obj.summary) ?? summary;
        continue;
      }

      const error = claudeErrorText(obj);
      if (error) {
        storage.push({ role: "assistant", timestamp: asString(obj.timestamp), blocks: [textBlock(error)] });
        continue;
      }
      const queued = claudeQueuedPrompt(obj);
      if (queued) {
        storage.push({ role: "user", timestamp: asString(obj.timestamp), blocks: [textBlock(queued)] });
        continue;
      }
      const type = asString(obj.type);
      if (type !== "user" && type !== "assistant") continue;
      const msg = isRecord(obj.message) ? obj.message : obj;
      const role = asString(msg.role) ?? type;
      const ts = asString(obj.timestamp);
      const content = msg.content;

      if (role === "assistant") {
        const blocks: RichBlock[] = [];
        if (typeof content === "string") {
          if (content.trim()) blocks.push(textBlock(content));
        } else if (Array.isArray(content)) {
          for (const b of content) {
            if (!isRecord(b)) continue;
            const bt = asString(b.type) ?? "";
            if (bt === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
              blocks.push(thinkingBlock(b.thinking));
            } else if (bt === "tool_use") {
              const block = toolBlock(asString(b.name), b.input);
              const id = asString(b.id);
              if (id) storage.rememberTool(id, block);
              blocks.push(block);
            } else if (typeof b.text === "string" && b.text.trim()) {
              blocks.push(textBlock(b.text));
            }
          }
        }
        if (blocks.length) storage.push({ role: "assistant", timestamp: ts, blocks });
        continue;
      }

      if (isClaudeMeta(obj)) {
        // A loaded skill's body is its Skill call's output, not a turn.
        const block = storage.findTool(asString(obj.sourceToolUseID) ?? "");
        const injected = classifyContent(content).text.trim();
        if (block && injected) attachToolOutput(block, block.output ? `${block.output}\n\n${injected}` : injected, false);
        continue;
      }
      // user line: genuine text and/or tool_result feedback for earlier calls.
      if (typeof content === "string") {
        const t = content.trim();
        const shown = t && !isNoiseText(t) ? unwrapPastedContent(t).trim() : "";
        if (shown) storage.push({ role: "user", timestamp: ts, blocks: [textBlock(shown)] });
        continue;
      }
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const b of content) {
          if (!isRecord(b)) continue;
          if (asString(b.type) === "tool_result") {
            attachToolOutput(storage.findTool(asString(b.tool_use_id) ?? ""), b.content, b.is_error === true);
          } else if (asString(b.type) === "image") {
            // Pasted screenshots are base64 blobs (100s of KB each) — shipping
            // them would balloon the page; dropping them silently would lie.
            // An inline marker keeps the turn visible and the payload tiny.
            textParts.push("🖼 [图片]");
          } else if (typeof b.text === "string" && b.text.trim() && !isNoiseText(b.text)) {
            const shown = unwrapPastedContent(b.text).trim();
            if (shown) textParts.push(shown);
          }
        }
        if (textParts.length) storage.push({ role: "user", timestamp: ts, blocks: [textBlock(textParts.join("\n"))] });
      }
    }
  };
  return { append, snapshot(): RichParsedSession {
    finalizeRichMeta(meta, storage, time, summary);
    finalizeActivity(meta, activity);
    return { meta: { ...meta }, messages: storage.snapshot() };
  } };
}

function createCodexRichParser(storage: RichStorage): RichSessionParser {
  const time = new TimeRange();
  const meta: SessionMeta = { source: "codex", message_count: 0 };
  const activity = new CodexActivityTracker();
  const dedupe = new CodexMessageDedupe();
  const prose = (role: RichMessage["role"], text: string, timestamp: string | undefined, channel: Channel): void => {
    if (dedupe.accept({ role, text }, channel)) storage.push({ role, timestamp, blocks: [textBlock(text)] });
  };
  // The native agent_message can repeat the questions from the function call.
  // Keep a bounded set for this user turn, without retaining tool block bodies.
  const asyncQuestionInputs = new Set<string>();
  let lastNativeQuestions: { input: string; channel: "event" | "item" } | undefined;
  const rememberQuestions = (input: string): void => {
    asyncQuestionInputs.add(input);
    if (asyncQuestionInputs.size > 32) asyncQuestionInputs.delete(asyncQuestionInputs.values().next().value!);
  };
  const nativeQuestions = (payload: Record<string, unknown>, channel: "event" | "item"): RichBlock[] => {
    if (!Array.isArray(payload.questions) || payload.questions.length === 0) return [];
    const input = JSON.stringify({ questions: payload.questions });
    if (input.length > ASYNC_QUESTION_INPUT_CAP) return [toolBlock("request_user_input_async", input)];
    if (asyncQuestionInputs.has(input)) return [];
    if (lastNativeQuestions?.input === input && lastNativeQuestions.channel !== channel) {
      lastNativeQuestions = undefined;
      return [];
    }
    lastNativeQuestions = { input, channel };
    const block = toolBlock("request_user_input_async", input);
    const id = asString(payload.id);
    if (id) block.call_id = id;
    return [block];
  };
  /** call_id → tool block, so *_output events can attach. */

  const append = (text: string | readonly unknown[]): void => {
    for (const obj of typeof text === "string" ? text.split(/\r?\n/).map(safeJsonParse) : text) {
      if (!isRecord(obj)) continue;

      time.add(obj.timestamp);
      const payload = isRecord(obj.payload) ? obj.payload : obj;
      const ts = asString(obj.timestamp);
      dedupe.boundary(obj.type);
      dedupe.boundary(payload.type);
      activity.line(payload, ts);
      captureCodexUsage(payload, meta);

      if (asString(obj.type) === "session_meta" || asString(payload.type) === "session_meta") {
        codexMetaLine(payload, meta, time);
        continue;
      }
      captureCodexTurnConfiguration(obj, payload, meta);

      const pt = asString(payload.type);
      if (codexTerminalError(payload)) {
        dedupe.reset();
        storage.push({ role: "assistant", timestamp: ts, blocks: [textBlock(codexErrorText(payload))] });
      } else if (pt === "user_message") {
        asyncQuestionInputs.clear();
        lastNativeQuestions = undefined;
        const t = (asString(payload.message) ?? "").trim();
        if (t && !isNoiseText(t)) prose("user", t, ts, "event");
      } else if (pt === "agent_message") {
        const t = (asString(payload.message) ?? "").trim();
        if (t) prose("assistant", t, ts, "event");
        const questions = nativeQuestions(payload, "event");
        if (questions.length) storage.push({ role: "assistant", timestamp: ts, blocks: questions });
      } else if (pt === "agent_reasoning") {
        const t = (asString(payload.text) ?? "").trim();
        if (t) storage.push({ role: "assistant", timestamp: ts, blocks: [thinkingBlock(t)] });
      } else if (pt === "custom_tool_call" || pt === "function_call") {
        const block = toolBlock(asString(payload.name), asString(payload.arguments) ?? asString(payload.input));
        const cid = asString(payload.call_id);
        if (isAsyncQuestion(block.tool)) {
          if (cid) block.call_id = cid;
          const args = safeJsonParse(block.input ?? "");
          if (isRecord(args) && Array.isArray(args.questions)) rememberQuestions(JSON.stringify({ questions: args.questions }));
        }
        if (cid) storage.rememberTool(cid, block);
        storage.push({ role: "assistant", timestamp: ts, blocks: [block] });
      } else if (pt === "custom_tool_call_output" || pt === "function_call_output") {
        attachToolOutput(storage.findTool(asString(payload.call_id) ?? ""), payload.output, false);
      } else if (pt === "message") {
        const role = asString(payload.role);
        if (role !== "user" && role !== "assistant") continue;
        const info = classifyContent(payload.content);
        if (isNoiseText(info.text)) continue;
        const questions = role === "assistant" ? nativeQuestions(payload, "item") : [];
        // Native question pairing is independent of mirrored prose.
        if (questions.length) storage.push({ role, timestamp: ts, blocks: questions });
        if (info.hasText) prose(role, info.text, ts, "item");
      }
    }
  };
  return { append, snapshot(): RichParsedSession {
    finalizeRichMeta(meta, storage, time, undefined);
    finalizeActivity(meta, activity);
    return { meta: { ...meta }, messages: storage.snapshot() };
  } };
}

/**
 * omp's rich pass differs from the other two in exactly one structural way:
 * a tool result is a sibling top-level entry keyed by `toolCallId`, so the
 * pairing map is the whole mechanism rather than a scan of the next message.
 * The viewer contract (tool block carries its own output) stays identical.
 */
function createOmpRichParser(storage: RichStorage): RichSessionParser {
  const time = new TimeRange();
  const meta: SessionMeta = { source: "omp", message_count: 0 };
  const activity = new OmpActivityTracker();
  let summary: string | undefined;
  /** toolCall id → its block, so a later `toolResult` entry can attach. */

  const append = (text: string | readonly unknown[]): void => {
    for (const obj of typeof text === "string" ? text.split(/\r?\n/).map(safeJsonParse) : text) {
      if (!isRecord(obj)) continue;

      time.add(obj.timestamp);
      activity.line(obj);
      const ts = asString(obj.timestamp);

      if (asString(obj.type) === "compaction") {
        summary = asString(obj.summary) ?? summary;
        continue;
      }
      if (ompMetaLine(obj, meta)) continue;
      if (asString(obj.type) !== "message") continue;

      const msg = isRecord(obj.message) ? obj.message : undefined;
      if (!msg) continue;
      const role = asString(msg.role);

      if (role === "toolResult") {
        const info = classifyOmpContent(msg.content);
        attachToolOutput(
          storage.findTool(asString(msg.toolCallId) ?? ""),
          info.hasText ? info.text : msg.content,
          msg.isError === true,
        );
        continue;
      }

      if (role === "user") {
        const info = classifyOmpContent(msg.content);
        const parts: string[] = [];
        if (info.hasText && !isNoiseText(info.text)) parts.push(info.text);
        // Pasted screenshots stay a marker, never a base64 payload on the wire.
        if (info.hasImage) parts.push("🖼 [图片]");
        if (parts.length) storage.push({ role: "user", timestamp: ts, blocks: [textBlock(parts.join("\n"))] });
        continue;
      }
      if (role !== "assistant") continue;

      const blocks: RichBlock[] = [];
      // omp orders thinking before text before calls inside one content array;
      // walk the array itself so the viewer shows the author's real order.
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const raw of content) {
        if (!isRecord(raw)) continue;
        const type = asString(raw.type) ?? "";
        if (type === "thinking") {
          const thought = asString(raw.thinking) ?? asString(raw.text) ?? "";
          if (thought.trim()) blocks.push(thinkingBlock(thought));
        } else if (type === "toolCall") {
          const block = toolBlock(asString(raw.name), raw.arguments);
          // omp is the only one of the three that states WHY it is calling a
          // tool. Keep that one-line intent — it is the most useful thing in an
          // omp transcript and costs nothing.
          const intent = asString(raw.intent);
          if (intent && intent.trim()) block.text = truncate(intent.trim(), 200);
          const id = asString(raw.id);
          if (id) storage.rememberTool(id, block);
          blocks.push(block);
        } else if (typeof raw.text === "string" && raw.text.trim()) {
          blocks.push(textBlock(raw.text));
        }
      }
      if (typeof msg.content === "string" && msg.content.trim()) blocks.push(textBlock(msg.content));
      const error = ompErrorText(msg);
      if (error) blocks.push(textBlock(error));
      if (blocks.length) storage.push({ role: "assistant", timestamp: ts, blocks });
    }
  };
  return { append, snapshot(): RichParsedSession {
    finalizeRichMeta(meta, storage, time, summary);
    finalizeActivity(meta, activity);
    return { meta: { ...meta }, messages: storage.snapshot() };
  } };
}

/** Device-private append parser. Returned message objects belong to this parser. */
export interface RichSessionParser {
  /** Supply complete JSONL records; incomplete file tails are held by the file reader. */
  append(text: string | readonly unknown[]): void;
  snapshot(): RichParsedSession;
}

export function createSessionRichParser(source: Source, storage: RichStorage = new MemoryRichStorage()): RichSessionParser {
  if (source === "codex") return createCodexRichParser(storage);
  if (source === "omp") return createOmpRichParser(storage);
  return createClaudeRichParser(storage);
}

/** Block-level parse of a full session file (transcript viewer). */
export function parseSessionRich(source: Source, text: string): RichParsedSession {
  const parser = createSessionRichParser(source);
  parser.append(text);
  return parser.snapshot();
}

function captureCodexTurnConfiguration(
  record: Record<string, unknown>, payload: Record<string, unknown>, meta: SessionMeta,
): void {
  if (record.type !== "turn_context" && payload.type !== "turn_context") return;
  // Each context is a whole turn snapshot. Never pair a new model with old effort.
  meta.turn_configuration = readSessionTurnConfiguration(payload);
  if (!meta.cwd) meta.cwd = asString(payload.cwd);
}

function captureCodexUsage(payload: Record<string, unknown>, meta: SessionMeta): void {
  if (payload.type !== "token_count" || !isRecord(payload.info)) return;
  const usage = readCodexTokenUsage(payload.info.total_token_usage);
  if (usage) meta.usage = usage; // cumulative: replace, never sum snapshots
}

/**
 * Incremental flat projection. Records are supplied in file order; messages
 * are handed to `onMessage` as they complete instead of being retained, so a
 * caller can stream a log of any size with memory bounded by one JSON record.
 *
 * Codex event/item mirrors are deduplicated before emission. Item-only history
 * remains visible even when a later turn supplies event messages.
 */
export interface FlatSessionParser {
  append(records: readonly unknown[]): void;
  snapshot(): SessionMeta;
}

export function createSessionFlatParser(
  source: Source,
  onMessage?: (message: FlatMessage) => void,
  opts?: { toolDetail?: boolean },
): FlatSessionParser {
  const meta: SessionMeta = { source, message_count: 0 };
  const time = new TimeRange();
  const facts = new RichFactsAccumulator();
  const dedupe = new CodexMessageDedupe();
  const tracker = source === "codex" ? new CodexActivityTracker() : source === "omp" ? new OmpActivityTracker() : new ClaudeActivityTracker();
  const title = new ClaudeTitle();
  let summary: string | undefined;
  const emit = (message: FlatMessage): void => {
    facts.add(message);
    onMessage?.(message);
  };
  return {
    append(records) {
      for (const obj of records) {
        if (!isRecord(obj)) continue;
        time.add(obj.timestamp);
        if (source === "codex") {
          // The record may be wrapped ({timestamp,type,payload}) or, defensively,
          // the payload itself at top level.
          const payload = isRecord(obj.payload) ? obj.payload : obj;
          dedupe.boundary(obj.type);
          dedupe.boundary(payload.type);
          if (codexTerminalError(payload)) dedupe.reset();
          (tracker as CodexActivityTracker).line(payload, asString(obj.timestamp));
          captureCodexUsage(payload, meta);
          captureCodexTurnConfiguration(obj, payload, meta);
          if (asString(obj.type) === "session_meta" || asString(payload.type) === "session_meta") {
            codexMetaLine(payload, meta, time); continue;
          }
          const entry = codexLineToEntry(payload, opts);
          if (entry && dedupe.accept(entry.msg, entry.channel)) emit(entry.msg);
        } else if (source === "claude") {
          if (!meta.cwd) meta.cwd = asString(obj.cwd);
          claudeSessionIdentity(obj, meta);
          if (!meta.git_branch) meta.git_branch = asString(obj.gitBranch);
          if (!meta.version) meta.version = asString(obj.version);
          if (title.line(obj)) continue;
          if (asString(obj.type) === "summary") { summary = asString(obj.summary) ?? summary; continue; }
          (tracker as ClaudeActivityTracker).line(obj);
          const message = claudeLineToMessage(obj, opts);
          if (message) emit(message);
        } else {
          (tracker as OmpActivityTracker).line(obj);
          if (asString(obj.type) === "compaction") { summary = asString(obj.summary) ?? summary; continue; }
          if (ompMetaLine(obj, meta) || asString(obj.type) !== "message") continue;
          const msg = isRecord(obj.message) ? obj.message : undefined;
          if (!msg) continue;
          const role = asString(msg.role);
          // A tool RESULT is a top-level omp entry. The flat projection keeps
          // calls and drops their (often huge) payloads, as for the other CLIs.
          if (role === "toolResult") continue;
          const info = classifyOmpContent(msg.content);
          if (role === "user") {
            if (info.hasText && !isNoiseText(info.text)) emit({ role: "user", text: info.text });
            continue;
          }
          if (role !== "assistant") continue;
          const tool = info.calls.length
            ? info.calls.map((call) => ompToolLabel(call, opts?.toolDetail)).join(", ")
            : undefined;
          const error = ompErrorText(msg);
          if (!info.hasText && !tool && !error) continue;
          const out: FlatMessage = { role: "assistant", text: [info.text, error].filter(Boolean).join("\n") };
          if (tool) out.tool = tool;
          emit(out);
        }
      }
    },
    snapshot() {
      const current = facts.facts();
      meta.message_count = current.count;
      meta.first_user_text = current.firstUser;
      meta.preview = current.preview ?? (summary ? truncate(summary) : undefined);
      meta.started_at = time.first; meta.last_activity = time.last;
      finalizeActivity(meta, tracker);
      if (source === "claude") title.apply(meta);
      return structuredClone(meta);
    },
  };
}

/** Incremental flat metadata without retaining historical message bodies. */
export function createSessionSummaryParser(source: Source): {
  append(records: readonly unknown[]): void;
  snapshot(): SessionMeta;
} {
  return createSessionFlatParser(source);
}

/** Split complete JSONL text into the record stream the incremental parsers consume. */
export function jsonlRecords(text: string): unknown[] {
  return text.split(/\r?\n/).map(safeJsonParse);
}

/** Parse a full session file's raw text into normalized meta + flat messages. */
export function parseSessionText(source: Source, text: string, opts?: { toolDetail?: boolean }): ParsedSession {
  const messages: FlatMessage[] = [];
  const parser = createSessionFlatParser(source, (message) => messages.push(message), opts);
  parser.append(jsonlRecords(text));
  return {
    meta: parser.snapshot(),
    messages,
  };
}
