/**
 * SessionView — the unified middle layer over three loop transcripts.
 *
 * openai-loop writes our own transcript.jsonl; claude-code writes its session
 * JSONL under ~/.claude/projects; codex writes rollout files under
 * ~/.codex/sessions. Three formats, ONE ViewEntry vocabulary — so any number
 * of top-level presentations (rich, minimal, whatever comes next) can render
 * any agent without knowing which loop runs underneath. This is the concrete
 * form of "3 loops → one intermediate → N frontends".
 *
 * All parsing is defensive: unknown lines are skipped, never fatal — CLI log
 * formats are private and drift (same discipline as the bot's parse.ts).
 */

import * as fs from "node:fs";
import type { TranscriptEntry } from "./plane.js";

export interface ViewEntry {
  kind: "user" | "assistant" | "thinking" | "tool" | "file" | "subagent" | "elicit" | "note";
  text: string;
  /** Collapsed detail: tool result, thinking body, subagent output. */
  detail?: string;
  /** elicit entries: the action whose form renders inline. */
  action?: string;
  at?: string;
  // ── optional fidelity a browser renderer needs, and nothing else reads ──
  //
  // Added when the dashboard's transcript viewer moved onto this vocabulary
  // (doc/development/session-hub-unified-ui-operation-plan.md §6: one schema,
  // one renderer). They are optional because the engine's own producers do not
  // set them, and a renderer that only knows `text`/`detail` is unaffected.
  /** Tool entries: the arguments, kept apart from the result. */
  input?: string;
  /** Tool entries: the result came back as an error. */
  isError?: boolean;
  /**
   * Tool entries with no result recorded. That is either "still running" or
   * "never finished", and only the caller's activity state can tell which — so
   * this states the observation and the renderer decides the wording.
   */
  unpaired?: boolean;
  /** The producer clipped this content. */
  truncated?: boolean;
}

export interface SessionView {
  source: "plane" | "claude-code" | "codex";
  entries: ViewEntry[];
  /** Distinct files the agent wrote/edited this session. */
  files: string[];
}

const clip = (s: string, n = 4000): string => (s.length > n ? s.slice(0, n) + " …" : s);

/** Our own transcript format is already close to the vocabulary. */
export function fromPlane(entries: TranscriptEntry[]): SessionView {
  return {
    source: "plane",
    files: [],
    entries: entries.map((e) => ({
      kind: e.role === "tool" ? "tool" : e.role,
      text: e.text,
      action: e.action,
      at: e.at,
    })),
  };
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function parseClaudeSession(text: string): SessionView {
  const entries: ViewEntry[] = [];
  const files = new Set<string>();
  const pendingTools = new Map<string, ViewEntry>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof doc.timestamp === "string" ? doc.timestamp : undefined;
    const message = doc.message as { role?: string; content?: unknown } | undefined;
    if ((doc.type !== "user" && doc.type !== "assistant") || !message) continue;
    const content = message.content;
    if (typeof content === "string") {
      if (doc.type === "user" && content.trim()) entries.push({ kind: "user", text: content, at });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const block = raw as Record<string, unknown>;
      switch (block.type) {
        case "text": {
          const t = String(block.text ?? "").trim();
          if (t) entries.push({ kind: doc.type === "user" ? "user" : "assistant", text: t, at });
          break;
        }
        case "thinking": {
          const t = String(block.thinking ?? "").trim();
          if (t) entries.push({ kind: "thinking", text: clip(t), at });
          break;
        }
        case "tool_use": {
          const name = String(block.name ?? "tool").replace(/^mcp__[\w-]+__/, "");
          const input = (block.input ?? {}) as Record<string, unknown>;
          let entry: ViewEntry;
          if (WRITE_TOOLS.has(String(block.name))) {
            const file = String(input.file_path ?? input.notebook_path ?? "?");
            files.add(file);
            entry = { kind: "file", text: file, detail: clip(JSON.stringify(input).slice(0, 600)), at };
          } else if (block.name === "Task") {
            entry = {
              kind: "subagent",
              text: String(input.description ?? "子代理任务"),
              detail: clip(String(input.prompt ?? "")),
              at,
            };
          } else {
            entry = { kind: "tool", text: `${name}(${clip(JSON.stringify(input), 160)})`, at };
          }
          entries.push(entry);
          if (typeof block.id === "string") pendingTools.set(block.id, entry);
          break;
        }
        case "tool_result": {
          const target = typeof block.tool_use_id === "string" ? pendingTools.get(block.tool_use_id) : undefined;
          if (!target) break;
          const inner = block.content;
          let out = "";
          if (typeof inner === "string") out = inner;
          else if (Array.isArray(inner)) {
            out = inner
              .map((c) => (typeof (c as { text?: unknown }).text === "string" ? String((c as { text: string }).text) : ""))
              .join("\n");
          }
          if (out.trim()) target.detail = clip(out.trim());
          break;
        }
        default:
          break;
      }
    }
  }
  return { source: "claude-code", entries, files: [...files] };
}

export function parseCodexSession(text: string): SessionView {
  const entries: ViewEntry[] = [];
  const files = new Set<string>();
  const pendingCalls = new Map<string, ViewEntry>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof doc.timestamp === "string" ? doc.timestamp : undefined;
    const payload = (doc.payload ?? doc) as Record<string, unknown>;
    switch (payload.type) {
      case "message": {
        const role = payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : null;
        if (!role) break;
        const parts = Array.isArray(payload.content) ? payload.content : [];
        const textOut = parts
          .map((p) => {
            const b = p as { type?: string; text?: string };
            return b.type === "input_text" || b.type === "output_text" || b.type === "text" ? (b.text ?? "") : "";
          })
          .join("")
          .trim();
        // codex re-injects environment context blocks as user messages; skip the noise
        if (textOut && !textOut.startsWith("<environment_context>")) entries.push({ kind: role, text: textOut, at });
        break;
      }
      case "reasoning": {
        const summary = Array.isArray(payload.summary)
          ? payload.summary.map((s) => String((s as { text?: unknown }).text ?? "")).join("\n")
          : "";
        if (summary.trim()) entries.push({ kind: "thinking", text: clip(summary.trim()), at });
        break;
      }
      case "function_call": {
        const name = String(payload.name ?? "tool").replace(/^mcp__[\w-]+__/, "");
        const args = String(payload.arguments ?? "");
        let entry: ViewEntry;
        if (name === "apply_patch" || args.includes("apply_patch")) {
          for (const m of args.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\\"\n]+)/g)) files.add(m[1]);
          const touched = [...args.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\\"\n]+)/g)].map((m) => m[1]);
          entry = { kind: "file", text: touched.join(", ") || "补丁", detail: clip(args, 800), at };
        } else {
          entry = { kind: "tool", text: `${name}(${clip(args, 160)})`, at };
        }
        entries.push(entry);
        if (typeof payload.call_id === "string") pendingCalls.set(payload.call_id, entry);
        break;
      }
      case "function_call_output": {
        const target = typeof payload.call_id === "string" ? pendingCalls.get(payload.call_id) : undefined;
        if (target) {
          const out = String((payload as { output?: unknown }).output ?? "");
          if (out.trim()) target.detail = clip(out.trim());
        }
        break;
      }
      default:
        break;
    }
  }
  return { source: "codex", entries, files: [...files] };
}

// ── cached file parsing (poll-friendly: reparse only when the file grew) ──

const cache = new Map<string, { mtimeMs: number; size: number; view: SessionView }>();

export function parseSessionFile(kind: "claude-code" | "codex", file: string): SessionView | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.view;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const view = kind === "claude-code" ? parseClaudeSession(text) : parseCodexSession(text);
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, view });
  return view;
}
