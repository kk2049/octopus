/** Claude Agent SDK attachments for Runner-managed sessions. */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { agentCommand } from "./agent-executables.js";
import type {
  AgentInteractionBroker,
  AgentInteractionResponse,
} from "./agent-interactions.js";
import { normalizeQuestions } from "./agent-interactions.js";
import {
  agentPermissionProfile,
  claudePermissionOptions,
  type AgentPermissionProfile,
} from "./agent-permissions.js";
import type { RunnerManagedTurnUsage } from "./gateway-protocol.js";

/** The SDK owns protocol argv; Runner owns the selected local executable and interpreter. */
function registeredClaudeOptions(explicit?: string): Record<string, unknown> {
  if (explicit) return { pathToClaudeCodeExecutable: explicit };
  const selected = agentCommand("claude", []);
  if (selected.fingerprint === "ambient") return { pathToClaudeCodeExecutable: "claude" };
  return {
    pathToClaudeCodeExecutable: selected.entry,
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      // SDK distinguishes native binaries from JS entrypoints. Neither case may select a different runtime.
      const index = options.args.indexOf(selected.entry);
      if (options.command !== selected.entry && index < 0) throw new Error("Claude SDK executable contract changed");
      const args = options.command === selected.entry ? options.args : options.args.slice(index + 1);
      const command = agentCommand("claude", args, options.env);
      if (command.fingerprint !== selected.fingerprint) throw new Error("Claude executable changed before SDK spawn");
      return spawn(command.bin, command.args, { cwd: options.cwd, env: command.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] });
    },
  };
}

interface ClaudeQuery extends AsyncIterable<Record<string, unknown>> {
  interrupt?: () => Promise<void>;
  initializationResult?: () => Promise<unknown>;
  close?: () => void;
}

export type ClaudeQueryFactory = (params: {
  prompt: AsyncIterable<Record<string, unknown>>;
  options: Record<string, unknown>;
}) => ClaudeQuery;

export interface ClaudeManagedTurnResult {
  ok: boolean;
  resultText?: string;
  newSessionId: string;
  error?: string;
  stderr?: string;
  timedOut?: boolean;
  usage?: RunnerManagedTurnUsage;
}

export interface ClaudeBackgroundTask {
  taskId: string;
  toolUseId?: string;
  description?: string;
}

export interface ClaudeManagedSessionOptions {
  sessionId: string;
  cwd: string;
  interactions: AgentInteractionBroker;
  timeoutMs: number;
  resume: boolean;
  model?: string;
  effort?: string;
  queryFactory?: ClaudeQueryFactory;
  claudeExecutable?: string;
  permissionProfile?: AgentPermissionProfile;
  /** The only tool surface exposed during split runtime/execution placement. */
  remoteMcpUrl?: string;
  developmentMcpUrl?: string;
  onBackgroundTasksChanged?: (
    tasks: readonly ClaudeBackgroundTask[],
  ) => Promise<void> | void;
}

export interface ClaudeManagedDispatch {
  kind: "started" | "steered";
  completion: Promise<ClaudeManagedTurnResult>;
}

const EMPTY_RESULT_ERROR = "Claude Agent SDK 本轮未返回 Agent 正文；prompt 已写入会话，不能安全自动重试";
const BACKGROUND_TASKS_SETTLED_PROMPT = [
  "[Octopus 自动续接] 后台 subagent 已全部结束。",
  "请读取各子任务结果，处理失败或中断项，并继续完成你刚才承诺的主任务；不要只汇报状态。",
].join("\n");

/**
 * One provider-native Claude attachment.
 *
 * The input iterable deliberately stays open across the turn. That is the
 * official Agent SDK's multi-turn/control mode: an additional message with
 * priority `now` steers the in-flight turn, and `interrupt()` is a native
 * control request. The control plane closes this attachment after an idle
 * grace period (or immediately when returning ownership to a local CLI), so a
 * web turn never permanently steals a session from the terminal.
 */
export class ClaudeManagedSession {
  private readonly input = new ClaudeInputQueue();
  private readonly query: ClaudeQuery;
  private readonly options: ClaudeManagedSessionOptions;
  private active: {
    completion: Promise<ClaudeManagedTurnResult>;
    resolve: (result: ClaudeManagedTurnResult) => void;
    timer?: NodeJS.Timeout;
    finishInteraction: () => void;
  } | null = null;
  private stderr = "";
  private closed = false;
  private consumeError = "";
  private readonly backgroundTasks = new Map<string, ClaudeBackgroundTask>();
  private deferredResult: ClaudeManagedTurnResult | undefined;

  constructor(options: ClaudeManagedSessionOptions) {
    this.options = options;
    const queryFactory = options.queryFactory ?? sdkQuery as unknown as ClaudeQueryFactory;
    const sdkOptions: Record<string, unknown> = {
      cwd: options.cwd,
      ...(options.resume ? { resume: options.sessionId } : { sessionId: options.sessionId }),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort && options.effort !== "xhigh" ? { effort: options.effort } : {}),
      ...claudePermissionOptions(agentPermissionProfile("claude", options.permissionProfile)),
      ...(options.remoteMcpUrl || options.developmentMcpUrl ? {
        // A split session's whole tool surface is the scope's MCP. Settings
        // (and the hooks, plugins and CLAUDE.md they bring) and plugins stay
        // off explicitly, not only by this SDK version's defaults.
        ...(options.remoteMcpUrl ? { tools: [], settingSources: [], plugins: [] } : {}),
        // Octopus owns this tool surface. Without strict mode the CLI also
        // attaches the login's claude.ai connectors (Claude Docs, Drive), so a
        // shared ticket agent could act on the device owner's account data.
        strictMcpConfig: true,
        mcpServers: {
          ...(options.remoteMcpUrl ? { octopus_execution: { type: "http", url: options.remoteMcpUrl } } : {}),
          ...(options.developmentMcpUrl ? { octopus_devpipe: { type: "http", url: options.developmentMcpUrl } } : {}),
        },
      } : {}),
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        context: { signal?: AbortSignal } = {},
      ) => await handleToolRequest(options, toolName, input, context.signal),
      ...registeredClaudeOptions(options.claudeExecutable),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "octopus-runner/2.0.0" },
      stderr: (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8_000); },
    };
    this.query = queryFactory({ prompt: this.input, options: sdkOptions });
    void this.consume();
  }

  get turnActive(): boolean {
    return this.active !== null;
  }

  dispatch(prompt: string): ClaudeManagedDispatch {
    if (this.closed) throw new Error(this.consumeError || "Claude Agent SDK attachment 已关闭");
    if (this.active) {
      // Once Claude has returned a top-level result, there is no live turn to
      // steer. Queue the person's newer instruction after the background work
      // and suppress our generic wake-up; their message is the better sequel.
      const priority = this.deferredResult ? "next" : "now";
      this.deferredResult = undefined;
      this.input.push(userMessage(this.options.sessionId, prompt, priority));
      return { kind: "steered", completion: this.active.completion };
    }
    let resolve!: (result: ClaudeManagedTurnResult) => void;
    const completion = new Promise<ClaudeManagedTurnResult>((done) => { resolve = done; });
    const finishInteraction = this.options.interactions.beginManaged("claude", this.options.sessionId, {
      providerControl: true,
    });
    const timer = this.options.timeoutMs > 0
      ? setTimeout(() => {
          if (!this.active || this.active.completion !== completion) return;
          this.options.interactions.cancel("claude", this.options.sessionId);
          void this.interrupt("Claude Agent SDK turn timed out", true);
        }, this.options.timeoutMs)
      : undefined;
    timer?.unref?.();
    this.active = { completion, resolve, timer, finishInteraction };
    this.input.push(userMessage(this.options.sessionId, prompt, "next"));
    return { kind: "started", completion };
  }

  async interrupt(reason = "Claude turn 已由用户中断", timedOut = false): Promise<void> {
    if (!this.active) return;
    try {
      if (this.query.interrupt) await this.query.interrupt();
      else this.query.close?.();
    } catch {
      this.query.close?.();
    }
    this.finish({
      ok: false,
      newSessionId: this.options.sessionId,
      error: reason,
      ...(this.stderr ? { stderr: this.stderr } : {}),
      ...(timedOut ? { timedOut: true } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    this.options.interactions.cancel("claude", this.options.sessionId);
    if (this.active) await this.interrupt("Claude Agent SDK attachment 已释放");
    this.query.close?.();
  }

  private async consume(): Promise<void> {
    try {
      for await (const raw of this.query) {
        const row = object(raw);
        if (row.type === "system" && row.subtype === "task_started") {
          const taskId = string(row.task_id).slice(0, 256);
          if (taskId) {
            const toolUseId = string(row.tool_use_id).slice(0, 256);
            const description = string(row.description).slice(0, 500);
            this.backgroundTasks.set(taskId, {
              taskId,
              ...(toolUseId ? { toolUseId } : {}),
              ...(description ? { description } : {}),
            });
            await this.publishBackgroundTasks();
          }
          continue;
        }
        if (row.type === "system" && row.subtype === "task_notification") {
          const taskId = string(row.task_id).slice(0, 256);
          if (taskId && this.backgroundTasks.delete(taskId)) {
            await this.publishBackgroundTasks();
            if (this.backgroundTasks.size === 0 && this.deferredResult && this.active) {
              this.deferredResult = undefined;
              this.input.push(userMessage(
                this.options.sessionId,
                BACKGROUND_TASKS_SETTLED_PROMPT,
                "next",
              ));
            }
          }
          continue;
        }
        if (row.type !== "result" || !this.active) continue;
        const sessionId = string(row.session_id) || this.options.sessionId;
        const usage = claudeTurnUsage(row.usage);
        if (row.subtype === "success") {
          const resultText = string(row.result);
          const result: ClaudeManagedTurnResult = {
            ok: Boolean(resultText.trim()),
            ...(resultText.trim() ? { resultText } : { error: EMPTY_RESULT_ERROR }),
            newSessionId: sessionId,
            ...(usage ? { usage } : {}),
            ...(this.stderr ? { stderr: this.stderr } : {}),
          };
          // A parent that only launched background agents may return an empty
          // success while those agents are still working. The task lifecycle
          // proves this is an intermediate result, so keep the attachment
          // alive and wake the parent after the final notification. An empty
          // success without live tasks remains a terminal failure below.
          if (this.backgroundTasks.size > 0) {
            this.deferredResult = result;
          } else {
            this.finish(result);
          }
        } else {
          const errors = Array.isArray(row.errors)
            ? row.errors.filter((entry): entry is string => typeof entry === "string").join("; ")
            : "";
          this.finish({
            ok: false,
            newSessionId: sessionId,
            error: errors || `Claude Agent SDK result: ${string(row.subtype) || "error"}`,
            ...(usage ? { usage } : {}),
            ...(this.stderr ? { stderr: this.stderr } : {}),
          });
        }
      }
      if (!this.closed) this.fail(new Error("Claude Agent SDK transport ended"));
    } catch (error) {
      if (!this.closed) this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private finish(result: ClaudeManagedTurnResult): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.deferredResult = undefined;
    if (active.timer) clearTimeout(active.timer);
    active.finishInteraction();
    active.resolve(result);
  }

  private async publishBackgroundTasks(): Promise<void> {
    if (!this.options.onBackgroundTasksChanged) return;
    try {
      await this.options.onBackgroundTasksChanged([...this.backgroundTasks.values()]);
    } catch (error) {
      // A journal failure must not kill the live team. The recovery guarantee
      // degrades visibly in diagnostics while the current attachment proceeds.
      this.stderr = `${this.stderr}\nOctopus subagent recovery journal: ${message(error)}`.slice(-8_000);
    }
  }

  private fail(error: Error): void {
    this.consumeError = error.message;
    this.finish({
      ok: false,
      newSessionId: this.options.sessionId,
      error: error.message,
      ...(this.stderr ? { stderr: this.stderr } : {}),
    });
  }
}

class ClaudeInputQueue implements AsyncIterable<Record<string, unknown>> {
  private readonly values: Record<string, unknown>[] = [];
  private readonly readers: Array<(value: IteratorResult<Record<string, unknown>>) => void> = [];
  private ended = false;

  push(value: Record<string, unknown>): void {
    if (this.ended) throw new Error("Claude input stream 已关闭");
    const reader = this.readers.shift();
    if (reader) reader({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    while (true) {
      const value = await new Promise<IteratorResult<Record<string, unknown>>>((resolve) => {
        const queued = this.values.shift();
        if (queued) resolve({ done: false, value: queued });
        else if (this.ended) resolve({ done: true, value: undefined });
        else this.readers.push(resolve);
      });
      if (value.done) return;
      yield value.value;
    }
  }
}

function userMessage(sessionId: string, prompt: string, priority: "now" | "next"): Record<string, unknown> {
  return {
    type: "user",
    session_id: sessionId,
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    parent_tool_use_id: null,
    priority,
  };
}

async function handleToolRequest(
  options: Pick<ClaudeManagedSessionOptions, "sessionId" | "interactions">,
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (toolName === "AskUserQuestion") {
    const questions = normalizeQuestions(input.questions);
    if (questions.length === 0) {
      return { behavior: "deny", message: "Claude 提交了无效的提问结构" };
    }
    const response = await waitForInteraction(options.interactions.request({
      provider: "claude",
      sessionId: options.sessionId,
      kind: "question",
      title: "Claude Code 需要你的回答",
      tool: toolName,
      questions,
    }), signal);
    if (!response || response.decision === "deny") {
      return {
        behavior: "deny",
        message: response?.message || "用户在 Octopus 中取消了这个问题",
      };
    }
    const answers: Record<string, string> = {};
    for (const question of questions) {
      answers[question.prompt] = (response.answers[question.id] ?? []).join(", ");
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  const response = await waitForInteraction(options.interactions.request({
    provider: "claude",
    sessionId: options.sessionId,
    kind: "permission",
    title: toolName ? `Claude Code 请求执行 ${toolName}` : "Claude Code 权限请求",
    tool: toolName || undefined,
    detail: safeDetail({ tool_input: input }),
  }), signal);
  if (!response || response.decision === "deny") {
    return {
      behavior: "deny",
      message: response?.message || "用户在 Octopus 中拒绝了这个权限请求",
    };
  }
  return { behavior: "allow", updatedInput: input };
}

async function waitForInteraction(
  response: Promise<AgentInteractionResponse | null>,
  signal?: AbortSignal,
): Promise<AgentInteractionResponse | null> {
  if (!signal) return await response;
  if (signal.aborted) return null;
  return await Promise.race([
    response,
    new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true })),
  ]);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function claudeTurnUsage(value: unknown): RunnerManagedTurnUsage | undefined {
  const row = object(value);
  const count = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
      ? Math.round(candidate)
      : 0;
  const input = count(row.input_tokens);
  const output = count(row.output_tokens);
  const cached = count(row.cache_read_input_tokens) + count(row.cache_creation_input_tokens);
  return input || output || cached
    ? {
        ...(input ? { tokens_in: input } : {}),
        ...(output ? { tokens_out: output } : {}),
        ...(cached ? { tokens_cached: cached } : {}),
      }
    : undefined;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 12_000) : "";
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function safeDetail(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 12_000);
  } catch {
    return "";
  }
}
