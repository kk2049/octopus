/** Private Unix-socket transport used by very short-lived CLI hook helpers. */

import { createServer, createConnection, type Server } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProvider, AgentRuntimeRegistry } from "./agent-runtime.js";
import {
  AgentInteractionBroker,
  normalizeQuestions,
  type AgentInteractionQuestion,
  type AgentInteractionResponse,
} from "./agent-interactions.js";

const MAX_HOOK_BYTES = 256 * 1024;
/** Local lifecycle reports stay fail-open, but tolerate a briefly loaded Runner. */
export const HOOK_REPORT_TIMEOUT_MS = 2_000;

/** A Claude Code question its TUI shows as a dialog once no hook holds it. */
export interface ClaudeOpenQuestion {
  toolUseId: string;
  transcriptPath: string;
  /** Transcript size when the question was asked; its end is appended after this. */
  transcriptOffset: number;
}

/** Answers a released Claude Code question in the CLI's own terminal. */
export interface ClaudeTerminalQuestions {
  /** Whether this session's CLI is one the Runner could type an answer into. */
  reachable(sessionId: string): Promise<boolean>;
  /** Close the open dialog, then send `prompt` as an ordinary input (null: only close it). */
  answer(sessionId: string, question: ClaudeOpenQuestion, prompt: string | null): Promise<void>;
}

export function defaultHookSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const root = runtime && path.isAbsolute(runtime)
    ? path.join(runtime, "octopus-runner")
    : path.join(os.tmpdir(), `octopus-runner-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
  return path.join(root, "hooks.sock");
}

export async function startHookServer(
  registry: AgentRuntimeRegistry,
  socketPath = defaultHookSocketPath(),
  interactions?: AgentInteractionBroker,
  onHook?: (provider: AgentProvider, payload: unknown) => Promise<void> | void,
  terminalQuestions?: ClaudeTerminalQuestions,
): Promise<{ server: Server; socketPath: string; close(): Promise<void> }> {
  if (process.platform === "win32") throw new Error("agent hooks currently require a Unix-domain socket");
  const root = path.dirname(socketPath);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  try {
    const stat = await fs.lstat(socketPath);
    if (!stat.isSocket()) throw new Error(`refusing to replace non-socket path: ${socketPath}`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`refusing to replace socket owned by another uid: ${socketPath}`);
    }
    if (await socketMayBeLive(socketPath)) {
      throw new Error(`agent-hook socket is already serving: ${socketPath}`);
    }
    await fs.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // The helper half-closes after its request; keep the writable half open long
  // enough to acknowledge durable ingestion.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // A liveness probe intentionally disconnects without reading a reply.
    // Treat EPIPE/ECONNRESET as a per-client failure, never a Runner crash.
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HOOK_BYTES) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    // The helper has half-closed, so its exit raises no event here. Before an
    // answer is handed to a held hook, one byte of JSON whitespace proves the
    // helper still reads this socket: a gone reader fails the write (EPIPE).
    const stillWaiting = () => new Promise<boolean>((resolve) => {
      if (socket.destroyed || !socket.writable) resolve(false);
      else socket.write(" ", (error) => resolve(!error));
    });
    socket.on("end", () => {
      void handleMessage(registry, interactions, onHook, Buffer.concat(chunks).toString("utf8"),
        { stillWaiting, terminalQuestions })
        .then((reply) => socket.end(JSON.stringify(reply) + "\n"))
        .catch(() => socket.end('{"ok":false}\n'));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await fs.chmod(socketPath, 0o600);
  return {
    server,
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.unlink(socketPath).catch(() => {});
    },
  };
}

async function socketMayBeLive(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const done = (live: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    // Only ECONNREFUSED/ENOENT prove staleness. A timeout or an unfamiliar
    // error fails closed so a slow live Runner is never unlinked.
    const timer = setTimeout(() => done(true), 150);
    socket.once("connect", () => done(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      done(error.code !== "ECONNREFUSED" && error.code !== "ENOENT");
    });
  });
}

/** Hook-side send. Failure is intentionally swallowed by the CLI entrypoint. */
export async function reportHook(
  provider: AgentProvider,
  payload: unknown,
  socketPath = defaultHookSocketPath(),
  timeoutMs = HOOK_REPORT_TIMEOUT_MS,
): Promise<boolean> {
  return (await requestHook(provider, payload, socketPath, timeoutMs))?.ok === true;
}

export interface HookReply {
  ok: boolean;
  hook_output?: Record<string, unknown>;
}

/** Hook-side request. Blocking provider hooks may receive native control JSON. */
export async function requestHook(
  provider: AgentProvider,
  payload: unknown,
  socketPath = defaultHookSocketPath(),
  timeoutMs = HOOK_REPORT_TIMEOUT_MS,
): Promise<HookReply | null> {
  const envelope = JSON.stringify({ provider, reporter_pid: process.pid, payload });
  if (Buffer.byteLength(envelope, "utf8") > MAX_HOOK_BYTES) return null;
  return await new Promise<HookReply | null>((resolve) => {
    let settled = false;
    const done = (value: HookReply | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.setEncoding("utf8");
    let response = "";
    socket.on("connect", () => socket.end(envelope));
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.on("end", () => {
      try {
        const parsed = JSON.parse(response) as HookReply;
        done(parsed && typeof parsed === "object" ? parsed : null);
      } catch {
        done(null);
      }
    });
    socket.on("error", () => done(null));
  });
}

/** What the hook connection itself offers an interaction it raises. */
export interface ClaudeHookChannel {
  stillWaiting?: () => Promise<boolean>;
  terminalQuestions?: ClaudeTerminalQuestions;
}

async function handleMessage(
  registry: AgentRuntimeRegistry,
  interactions: AgentInteractionBroker | undefined,
  onHook: ((provider: AgentProvider, payload: unknown) => Promise<void> | void) | undefined,
  text: string,
  channel: ClaudeHookChannel = {},
): Promise<HookReply> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false };
  const row = doc as Record<string, unknown>;
  const provider = row.provider;
  const reporterPid = Number(row.reporter_pid);
  if ((provider !== "claude" && provider !== "codex") || !Number.isInteger(reporterPid) || reporterPid <= 1) {
    return { ok: false };
  }
  const ok = await registry.recordHook(provider, row.payload, reporterPid);
  if (ok && onHook) void Promise.resolve(onHook(provider, row.payload)).catch(() => {});
  if (!ok || provider !== "claude" || !interactions) return { ok };
  dismissSettledQuestion(interactions, row.payload);
  const hookOutput = await claudeHookInteraction(interactions, row.payload, channel);
  return { ok, ...(hookOutput ? { hook_output: hookOutput } : {}) };
}

const CLAUDE_TURN_BOUNDARIES = new Set(["UserPromptSubmit", "Stop", "StopFailure", "SessionStart", "SessionEnd"]);

/**
 * Main-thread events that prove a released question's dialog is gone: the
 * question's own tool call finished (answered or cancelled in the TUI), a new
 * question replaced it, or the turn or session ended. Subagent events carry
 * agent_id and say nothing about the main thread's dialog; the dialog's own
 * PermissionRequest and Notification do not end it either.
 */
function dismissSettledQuestion(interactions: AgentInteractionBroker, payload: unknown): void {
  const row = object(payload);
  const sessionId = bounded(row.session_id, 256);
  if (!sessionId || bounded(row.agent_id, 256)) return;
  const event = bounded(row.hook_event_name, 64);
  const toolUseId = bounded(row.tool_use_id, 256);
  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    if (toolUseId) interactions.dismissReleased("claude", sessionId, (ref) => ref === toolUseId);
  } else if (event === "PreToolUse" && bounded(row.tool_name, 160) === "AskUserQuestion") {
    interactions.dismissReleased("claude", sessionId, (ref) => ref !== toolUseId);
  } else if (CLAUDE_TURN_BOUNDARIES.has(event)) {
    interactions.dismissReleased("claude", sessionId, () => true);
  }
}

/** Translate the two Claude hook requests that can be answered synchronously. */
export async function claudeHookInteraction(
  interactions: AgentInteractionBroker,
  payload: unknown,
  channel: ClaudeHookChannel = {},
): Promise<Record<string, unknown> | null> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  const sessionId = bounded(row.session_id, 256);
  const event = bounded(row.hook_event_name, 64);
  const tool = bounded(row.tool_name, 160);
  const input = object(row.tool_input);
  if (!sessionId) return null;

  // A browser-managed Agent SDK turn routes both questions and permissions
  // through canUseTool. The lifecycle hooks still report observability, but
  // must not create a second card before the SDK callback arrives.
  if (interactions.usesProviderControl("claude", sessionId)) return null;

  if (event === "PreToolUse" && tool === "AskUserQuestion") {
    const questions = normalizeQuestions(input.questions);
    if (questions.length === 0) return null;
    // Claude matches answers by the exact question text it asked, which the
    // public projection trims and bounds.
    const asked = questions.map((question, index) => {
      const raw = object(Array.isArray(input.questions) ? input.questions[index] : null).question;
      return typeof raw === "string" && raw ? raw : question.prompt;
    });
    const open = await openQuestion(row, channel.terminalQuestions, sessionId);
    const terminal = channel.terminalQuestions;
    const response = await interactions.request({
      provider: "claude",
      sessionId,
      kind: "question",
      title: "Claude Code 需要你的回答",
      tool,
      questions,
      requireWatcher: true,
      ...(open ? { ref: open.toolUseId } : {}),
      ...(channel.stillWaiting ? { stillWaiting: channel.stillWaiting } : {}),
      ...(open && terminal ? {
        answerReleased: (answer: AgentInteractionResponse) =>
          terminal.answer(sessionId, open, claudeReleasedAnswer(questions, asked, answer)),
      } : {}),
    });
    if (!response) return null;
    if (response.decision === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: response.message || "用户在 Octopus 中取消了这个问题",
        },
      };
    }
    const answers: Record<string, string> = {};
    questions.forEach((question, index) => {
      answers[asked[index]!] = (response.answers[question.id] ?? []).join(", ");
    });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...input, answers },
      },
    };
  }

  if (event === "PermissionRequest") {
    const suggestions = Array.isArray(row.permission_suggestions) ? row.permission_suggestions : [];
    const response = await interactions.request({
      provider: "claude",
      sessionId,
      kind: "permission",
      title: tool ? `Claude Code 请求执行 ${tool}` : "Claude Code 权限请求",
      description: bounded(row.message ?? row.reason, 2_000) || undefined,
      tool: tool || undefined,
      detail: safeDetail({ tool_input: input, permission_suggestions: suggestions }),
      requireWatcher: true,
      ...(channel.stillWaiting ? { stillWaiting: channel.stillWaiting } : {}),
    });
    if (!response) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: response.decision === "allow"
          ? { behavior: "allow" }
          : { behavior: "deny", message: response.message || "用户在 Octopus 中拒绝了这个权限请求" },
      },
    };
  }
  return null;
}

/** The question's place in the transcript, when the CLI is one an answer can be typed into. */
async function openQuestion(
  row: Record<string, unknown>,
  terminal: ClaudeTerminalQuestions | undefined,
  sessionId: string,
): Promise<ClaudeOpenQuestion | null> {
  const toolUseId = bounded(row.tool_use_id, 256);
  const transcriptPath = bounded(row.transcript_path, 8_192);
  if (!terminal || !toolUseId || !path.isAbsolute(transcriptPath)) return null;
  try {
    const transcriptOffset = (await fs.stat(transcriptPath)).size;
    return await terminal.reachable(sessionId) ? { toolUseId, transcriptPath, transcriptOffset } : null;
  } catch {
    return null;
  }
}

/**
 * The input that replaces a released question's dialog. Esc records the
 * question as declined, so the prompt says the answers arrived another way.
 */
export function claudeReleasedAnswer(
  questions: readonly AgentInteractionQuestion[],
  asked: readonly string[],
  response: AgentInteractionResponse,
): string | null {
  if (response.decision === "deny") return response.message ?? null;
  return [
    "我在 Octopus 网页上回答了你刚才的提问（为了把答案送进来，终端里的选择框被关掉了，并不是拒绝回答）：",
    ...questions.map((question, index) =>
      `- ${asked[index] ?? question.prompt} → ${(response.answers[question.id] ?? []).join(", ")}`),
    ...(response.message ? [`补充：${response.message}`] : []),
    "请按这些回答继续。",
  ].join("\n");
}

export async function readHookStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    size += chunk.length;
    if (size > MAX_HOOK_BYTES) throw new Error("hook payload too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeDetail(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 12_000);
  } catch {
    return "";
  }
}
