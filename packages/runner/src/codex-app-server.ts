import { closeCodexProcess, trackCodexProcess } from "./codex-owned-process.js";
import { agentCommand } from "./agent-executables.js";
import { generateCodexThreadTitle, type CodexTitleOptions } from "./codex-thread-title.js";
/** Codex app-server attachments for Runner-managed sessions. */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { AgentInteractionBroker, normalizeQuestions, type AgentInteractionResponse } from "./agent-interactions.js";
import {
  codexPermissionProfile,
  codexThreadPermissionParams,
  codexTurnPermissionParams,
  type CodexPermissionProfile,
} from "./codex-permissions.js";

interface JsonRpcMessage extends Record<string, unknown> {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
}

export interface CodexAppServerTurnResult {
  started: boolean;
  ok: boolean;
  status?: string;
  resultText?: string;
  usage?: CodexAppServerTurnUsage;
  error?: string;
  /** Bounded native error evidence; a transport failure is never a failed turn. */
  providerError?: CodexTurnError;
  stderr?: string;
}

export interface CodexTurnError {
  code?: string;
  message: string;
  threadId: string;
  turnId: string;
  willRetry?: boolean;
}

type CompletedCodexTurn = {
  status: string; text: string; usage?: CodexAppServerTurnUsage;
  error?: string; providerError?: CodexTurnError;
};

/** Per-turn token accounting from `thread/tokenUsage/updated`. */
export interface CodexAppServerTurnUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface CodexManagedSessionOptions {
  cwd: string;
  interactions?: AgentInteractionBroker;
  timeoutMs: number;
  child?: ChildProcessWithoutNullStreams;
  /** Effective device-local account root for this app-server process. */
  codexHome?: string;
  /** Connect to Runner's loopback-only shared app-server. */
  endpoint?: string;
  permissionProfile?: CodexPermissionProfile;
  /** Rejoin an opt-in external TUI without changing that thread's policy. */
  preserveThreadPolicy?: boolean;
  model?: string;
  effort?: string;
  /** Highest-priority, per-thread Codex config (for example one bounded MCP map). */
  config?: Record<string, unknown>;
  /** One app-server remote environment backed by a Codex exec-server. */
  environment?: {
    environmentId: string;
    execServerUrl: string;
  };
  /** Liveness evidence for hosts that own their own stall policy. */
  onActivity?: () => void;
}

export interface CodexManagedDispatch {
  kind: "started" | "steered";
  turnId: string;
  completion: Promise<CodexAppServerTurnResult>;
}

const CODEX_COMPACT_COMMAND = "/compact";

function isCodexCompactCommand(prompt: string): boolean {
  return prompt.trim() === CODEX_COMPACT_COMMAND;
}

/**
 * A bidirectional Codex attachment that exposes the app-server's native
 * turn/start, turn/steer, and turn/interrupt controls.
 *
 * The attachment can be connected through stdio or to a shared loopback host.
 * The latter is what lets an Octopus-installed
 * `octopus-codex` TUI and the browser observe/control the same provider thread
 * without terminal key injection.
 */
export class CodexManagedSession {
  private readonly client: CodexJsonRpcClient;
  private readonly interactions: AgentInteractionBroker;
  private active: {
    turnId: string;
    completion: Promise<CodexAppServerTurnResult>;
    finishInteraction: () => void;
  } | null = null;
  private closed = false;
  private starting = false;
  private interruptOnStart = false;
  private released = false;
  private closing: Promise<void> | null = null;
  private titleJob: Promise<void> | undefined;

  private constructor(
    readonly sessionId: string,
    private readonly options: CodexManagedSessionOptions,
    client: CodexJsonRpcClient,
    private titleOptions?: CodexTitleOptions,
    /** Native app-server evidence; the observation index still checks its root. */
    readonly transcriptPath?: string,
  ) {
    this.client = client;
    this.interactions = options.interactions ?? new AgentInteractionBroker();
  }

  static async resume(
    sessionId: string,
    options: CodexManagedSessionOptions,
  ): Promise<CodexManagedSession> {
    const normalized = withInteractions(options);
    const client = await managedClient(normalized, sessionId);
    let response: Record<string, unknown>;
    let managedOptions = normalized;
    try {
      await initialize(client);
      managedOptions = await prepareEnvironment(client, normalized);
      const resumeParams = managedOptions.preserveThreadPolicy
        ? { threadId: sessionId, cwd: managedOptions.cwd }
        : managedThreadParamsForProfile(
            managedOptions.cwd,
            {
              threadId: sessionId,
              ...(managedOptions.model ? { model: managedOptions.model } : {}),
              ...(managedConfig(managedOptions) ? { config: managedConfig(managedOptions) } : {}),
            },
            codexPermissionProfile(managedOptions.permissionProfile),
          );
      const probe = await probeThread(client, sessionId);
      const plan = selectResumePlan(probe);
      response = await executeResumePlan(client, sessionId, resumeParams, managedOptions, plan);
      if (object(response.thread).canAcceptDirectInput === false) {
        // Defend against a provider changing the capability between probe and
        // resume. The plan already refuses a known parent-owned child before
        // any stateful request; this check keeps the same boundary on a race.
        throw codexRequestError(
          "direct app-server input is not allowed for multi-agent v2 sub-agents",
        );
      }
    } catch (error) {
      await client.close();
      throw error;
    }
    const session = new CodexManagedSession(sessionId, managedOptions, client, undefined, string(object(response.thread).path) || undefined);
    const activeTurn = array(object(response.thread).turns)
      .find((turn) => string(turn.status) === "inProgress");
    const activeTurnId = string(activeTurn?.id);
    if (activeTurnId) session.adoptActiveTurn(activeTurnId);
    return session;
  }

  /**
   * Fork one trusted rollout path into a fresh thread owned by another
   * device-local Codex account. The source stays untouched; the target
   * app-server mints the new id and persists the fork under its own CODEX_HOME.
   */
  static async forkFromPath(
    sourceSessionId: string,
    sourcePath: string,
    options: CodexManagedSessionOptions,
  ): Promise<CodexManagedSession> {
    const normalized = withInteractions(options);
    const client = await managedClient(normalized, "pending");
    let managedOptions = normalized;
    let response: Record<string, unknown>;
    try {
      await initialize(client);
      managedOptions = await prepareEnvironment(client, normalized);
      response = object(await client.request(
        "thread/fork",
        managedThreadParamsForProfile(
          managedOptions.cwd,
          {
            threadId: sourceSessionId,
            path: sourcePath,
            ...(managedOptions.model ? { model: managedOptions.model } : {}),
            ...(managedConfig(managedOptions) ? { config: managedConfig(managedOptions) } : {}),
          },
          codexPermissionProfile(managedOptions.permissionProfile),
        ),
        threadInitializationTimeoutMs(managedOptions),
      ));
    } catch (error) {
      await client.close();
      throw error;
    }
    const sessionId = string(object(response.thread).id);
    if (!sessionId) {
      await client.close();
      throw new Error("codex app-server thread/fork 没有返回 thread id");
    }
    client.setSessionId(sessionId);
    return new CodexManagedSession(sessionId, managedOptions, client, undefined, string(object(response.thread).path) || undefined);
  }

  /**
   * Branch a thread through one completed turn into a new thread under the
   * same account, and run nothing: the copy holds the source's turns up to and
   * including `lastTurnId`, persisted by the app-server before it answers.
   */
  static async forkThrough(
    source: { sessionId: string; path: string; lastTurnId: string; name?: string },
    options: CodexManagedSessionOptions,
  ): Promise<string> {
    const normalized = withInteractions(options);
    const client = await managedClient(normalized, "pending");
    try {
      await initialize(client);
      const response = object(await client.request(
        "thread/fork",
        managedThreadParamsForProfile(
          normalized.cwd,
          { threadId: source.sessionId, path: source.path, lastTurnId: source.lastTurnId, excludeTurns: true },
          codexPermissionProfile(normalized.permissionProfile),
        ),
        threadInitializationTimeoutMs(normalized),
      ));
      const sessionId = string(object(response.thread).id);
      if (!sessionId) throw new Error("codex app-server thread/fork 没有返回 thread id");
      // The name is how the branch reads in session lists; losing it loses nothing else.
      if (source.name) await client.request("thread/name/set", { threadId: sessionId, name: source.name }, 15_000).catch(() => {});
      return sessionId;
    } finally {
      await client.close();
    }
  }

  static async start(
    options: CodexManagedSessionOptions,
  ): Promise<CodexManagedSession> {
    // Interactions cannot occur before thread/start gives the durable id. The
    // temporary id never crosses the public projection.
    const normalized = withInteractions(options);
    const client = await managedClient(normalized, "pending");
    let response: Record<string, unknown>;
    let managedOptions = normalized;
    try {
      await initialize(client);
      managedOptions = await prepareEnvironment(client, normalized);
      response = object(await client.request("thread/start", managedThreadParamsForProfile(managedOptions.cwd, {
        ...(managedOptions.model ? { model: managedOptions.model } : {}),
        ...(managedConfig(managedOptions) ? { config: managedConfig(managedOptions) } : {}),
      }, codexPermissionProfile(managedOptions.permissionProfile), managedOptions.environment?.environmentId), threadInitializationTimeoutMs(managedOptions)));
    } catch (error) {
      await client.close();
      throw error;
    }
    const sessionId = string(object(response.thread).id);
    if (!sessionId) {
      await client.close();
      throw new Error("codex app-server thread/start 没有返回 thread id");
    }
    client.setSessionId(sessionId);
    const model = string(response.model);
    const modelProvider = string(response.modelProvider);
    const titleOptions = !string(object(response.thread).name).trim()
      ? { threadId: sessionId, model, modelProvider,
          ...(!managedOptions.environment ? { cwd: managedOptions.cwd } : {}),
          config: managedOptions.config }
      : undefined;
    return new CodexManagedSession(sessionId, managedOptions, client, titleOptions, string(object(response.thread).path) || undefined);
  }

  get turnActive(): boolean {
    return this.active !== null;
  }

  get permissionProfile(): CodexPermissionProfile | undefined {
    return this.options.preserveThreadPolicy
      ? undefined
      : codexPermissionProfile(this.options.permissionProfile);
  }

  async dispatch(prompt: string): Promise<CodexManagedDispatch> {
    if (this.closed) throw new Error("Codex app-server attachment 已关闭");
    if (this.starting) throw new Error("Codex 正在确认原始输入；不能重复发送");
    if (isCodexCompactCommand(prompt)) {
      if (this.active) {
        throw new Error("Codex 当前轮次仍在运行；请等这一轮结束后再执行 /compact");
      }
      return await this.compact();
    }
    if (this.active) {
      await this.client.request("turn/steer", {
        threadId: this.sessionId,
        expectedTurnId: this.active.turnId,
        input: textInput(prompt),
      }, 30_000);
      return { kind: "steered", turnId: this.active.turnId, completion: this.active.completion };
    }

    const finishInteraction = this.interactions.beginManaged("codex", this.sessionId, {
      providerControl: true,
    });
    this.client.beginTurn();
    this.starting = true;
    this.interruptOnStart = false;
    let response: Record<string, unknown>;
    try {
      response = object(await this.client.request("turn/start", {
        threadId: this.sessionId,
        cwd: this.options.cwd,
        // Codex accepts environments on thread/start and turn/start, but not
        // thread/resume or thread/fork. Each acquired relay is attachment-local;
        // select it on every new turn instead of inheriting a stale/local one.
        ...(this.options.environment ? {
          environments: [{
            environmentId: this.options.environment.environmentId,
            cwd: this.options.cwd,
            runtimeWorkspaceRoots: [this.options.cwd],
          }],
        } : {}),
        ...(this.options.preserveThreadPolicy
          ? {}
          : codexTurnPermissionParams(codexPermissionProfile(this.options.permissionProfile))),
        input: textInput(prompt),
      // Input has crossed the provider boundary. Use the managed lifecycle
      // budget (zero in the resident), not an unrelated 30-second RPC timer.
      // A matching native start/completion also acknowledges this exact send.
      }, this.options.timeoutMs, true));
    } catch (error) {
      finishInteraction();
      throw error;
    } finally {
      this.starting = false;
    }
    const turnId = string(object(response.turn).id);
    if (!turnId) {
      finishInteraction();
      throw new Error("codex app-server turn/start 没有返回 turn id");
    }
    this.client.setActiveTurnId(turnId);
    const completion = this.trackTurn(turnId, finishInteraction);
    this.active = { turnId, completion, finishInteraction };
    // Only a fresh thread's first accepted ordinary input starts title work.
    // Resume, fork, compact and steer never rename an existing conversation.
    if (this.titleOptions) {
      const titleOptions = this.titleOptions;
      this.titleOptions = undefined;
      this.titleJob = generateCodexThreadTitle(this.client, titleOptions, prompt);
    }
    if (this.interruptOnStart) {
      // A control failure must not undo evidence that the input is running.
      // Publish the attachment so the owner can observe it and retry Stop.
      void this.interrupt().catch(() => {
        console.warn("[codex] queued interrupt failed; original turn remains observed");
      });
    }
    return { kind: "started", turnId, completion };
  }

  /** Trigger Codex's native history compaction instead of sending a text turn. */
  private async compact(): Promise<CodexManagedDispatch> {
    const finishInteraction = this.interactions.beginManaged("codex", this.sessionId, {
      providerControl: true,
    });
    this.client.beginTurn();
    try {
      await this.client.request("thread/compact/start", {
        threadId: this.sessionId,
      }, 30_000);
      // Unlike turn/start, compact/start returns no turn object. The provider
      // announces the real id through the same turn lifecycle notifications
      // that carry compaction progress and completion.
      const turnId = await this.client.started(30_000);
      this.client.setActiveTurnId(turnId);
      const completion = this.trackTurn(turnId, finishInteraction);
      this.active = { turnId, completion, finishInteraction };
      return { kind: "started", turnId, completion };
    } catch (error) {
      finishInteraction();
      throw error;
    }
  }

  /**
   * Append to the active provider turn only. Unlike `dispatch`, this never
   * starts a second turn if completion wins the race with a late message.
   */
  async steer(prompt: string): Promise<boolean> {
    if (this.closed || !this.active) return false;
    await this.client.request("turn/steer", {
      threadId: this.sessionId,
      expectedTurnId: this.active.turnId,
      input: textInput(prompt),
    }, 30_000);
    return true;
  }

  private adoptActiveTurn(turnId: string): void {
    this.client.beginTurn();
    this.client.setActiveTurnId(turnId);
    const finishInteraction = this.interactions.beginManaged("codex", this.sessionId, {
      providerControl: true,
    });
    const completion = this.trackTurn(turnId, finishInteraction);
    this.active = { turnId, completion, finishInteraction };
  }

  private trackTurn(
    turnId: string,
    finishInteraction: () => void,
  ): Promise<CodexAppServerTurnResult> {
    return this.client.completed(this.options.timeoutMs).then((completed) => ({
      started: true,
      ok: completed.status === "completed",
      status: completed.status,
      ...(completed.text ? { resultText: completed.text } : {}),
      ...(completed.usage ? { usage: completed.usage } : {}),
      ...(completed.error ? { error: completed.error } : {}),
      ...(completed.providerError ? { providerError: completed.providerError } : {}),
      ...(this.client.stderr ? { stderr: this.client.stderr } : {}),
    })).catch((error) => ({
      started: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(this.client.stderr ? { stderr: this.client.stderr } : {}),
    })).finally(() => {
      if (this.active?.turnId === turnId) this.active = null;
      this.interactions.cancel("codex", this.sessionId);
      finishInteraction();
    });
  }

  async interrupt(): Promise<void> {
    if (this.starting) {
      this.interruptOnStart = true;
      return;
    }
    if (!this.active) return;
    await this.client.request("turn/interrupt", {
      threadId: this.sessionId,
      turnId: this.active.turnId,
    }, 30_000);
  }

  /** True only when this attachment owns the app-server child it can release. */
  get ownsServerProcess(): boolean {
    return !this.options.endpoint;
  }

  async close(): Promise<void> {
    if (this.released) return;
    this.closed = true;
    this.interactions.cancel("codex", this.sessionId);
    if (this.closing) return await this.closing;
    // A fast main turn must not kill its still-running metadata request.
    // Title work has its own 30s deadline plus bounded unsubscribe cleanup.
    const closing = (async () => {
      await this.titleJob;
      await this.client.close();
    })();
    this.closing = closing;
    try {
      await closing;
      this.released = true;
    } finally {
      if (this.closing === closing) this.closing = null;
    }
  }
}

const MAX_SUBAGENT_DEPTH = 32;

interface CodexThreadProbe {
  parentThreadId?: string;
  status: string;
  canAcceptDirectInput?: boolean;
}

type CodexResumePlan =
  | { kind: "resume" }
  | { kind: "resumeAfterLineage"; parentThreadId: string }
  | { kind: "refuseParentOwned" };

/** Read-only preflight: no subscription, policy mutation or prompt transfer. */
async function probeThread(client: CodexJsonRpcClient, sessionId: string): Promise<CodexThreadProbe> {
  const response = object(await client.request("thread/read", {
    threadId: sessionId,
    includeTurns: false,
  }, 30_000));
  const thread = object(response.thread);
  const parentThreadId = string(thread.parentThreadId);
  const status = string(object(thread.status).type);
  return {
    ...(parentThreadId ? { parentThreadId } : {}),
    status,
    ...(typeof thread.canAcceptDirectInput === "boolean"
      ? { canAcceptDirectInput: thread.canAcceptDirectInput }
      : {}),
  };
}

function selectResumePlan(probe: CodexThreadProbe): CodexResumePlan {
  if (probe.canAcceptDirectInput === false) return { kind: "refuseParentOwned" };
  if (probe.status === "notLoaded" && probe.parentThreadId) {
    return { kind: "resumeAfterLineage", parentThreadId: probe.parentThreadId };
  }
  return { kind: "resume" };
}

async function executeResumePlan(
  client: CodexJsonRpcClient,
  sessionId: string,
  resumeParams: Record<string, unknown>,
  options: CodexManagedSessionOptions,
  plan: CodexResumePlan,
): Promise<Record<string, unknown>> {
  if (plan.kind === "refuseParentOwned") {
    // A fork is a new independent root with copied history, not a continuation
    // of the parent-owned child. Refuse before a prompt or policy crosses.
    throw codexRequestError(
      "direct app-server input is not allowed for multi-agent v2 sub-agents",
    );
  }
  if (plan.kind === "resumeAfterLineage") {
    await loadCodexParentLineage(client, sessionId, plan.parentThreadId, options.cwd);
  }
  return object(await client.request("thread/resume", resumeParams, threadInitializationTimeoutMs(options)));
}

async function loadCodexParentLineage(
  client: CodexJsonRpcClient,
  targetSessionId: string,
  firstParentId: string,
  cwd: string,
): Promise<void> {
  const seen = new Set([targetSessionId, firstParentId]);
  const ancestors: string[] = [];
  let current = firstParentId;
  for (let depth = 0; depth < MAX_SUBAGENT_DEPTH; depth += 1) {
    const response = object(await client.request("thread/read", {
      threadId: current,
      includeTurns: false,
    }, 30_000));
    ancestors.push(current);
    const parent = string(object(response.thread).parentThreadId);
    if (!parent) {
      for (const sessionId of ancestors.reverse()) {
        await client.request("thread/resume", { threadId: sessionId, cwd }, 30_000);
      }
      return;
    }
    if (seen.has(parent)) throw new Error("Codex sub-agent thread ancestry contains a cycle");
    seen.add(parent);
    current = parent;
  }
  throw new Error(`Codex sub-agent thread ancestry exceeds ${MAX_SUBAGENT_DEPTH} levels`);
}

/**
 * Turn one app-server error into the answer a person can act on.
 *
 * Some threads are structurally closed to outside input. A thread created as a
 * sub-agent of a multi-agent run belongs to its parent: the app-server refuses
 * direct input into it, and every other Codex entry point refuses it for the
 * same reason. This is marked as a permanent answer AND translated — the raw
 * English sentence read as "Octopus 接管失败" with nothing to do next.
 *
 * Every other error keeps its provider text.
 */
export function codexRequestError(raw: string | undefined): Error & { code?: string; safeFallback?: boolean } {
  const text = (raw ?? "").trim();
  if (!text) return new Error("codex app-server request failed");
  const closedThread = /sub-?agent/i.test(text) && /not allowed|not permitted|forbidden|unsupported/i.test(text);
  if (!closedThread) return new Error(text);
  const error = new Error(
    "这个 Codex 线程是一次多 agent 运行里的子 agent，provider 不接受从外部直接输入。"
    + "请到它的父 agent 会话里继续，或另起一个会话；换成本机 CLI 重发也会被同样拒绝。"
    + `（Codex: ${text.slice(0, 200)}）`,
  ) as Error & { code?: string; safeFallback?: boolean };
  error.code = "codex_subagent_thread";
  // A permanent provider refusal, not a setup failure: no other channel is tried.
  error.safeFallback = false;
  return error;
}

async function initialize(client: CodexJsonRpcClient): Promise<void> {
  await client.request("initialize", {
    clientInfo: { name: "octopus_runner", title: "Octopus Runner", version: "2.0.0" },
    capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
  }, 15_000);
  client.notify("initialized", {});
}

async function managedClient(
  options: CodexManagedSessionOptions,
  sessionId: string,
): Promise<CodexJsonRpcClient> {
  if (options.endpoint && options.codexHome) {
    throw new Error("共享 Codex app-server endpoint 不能切换 CODEX_HOME");
  }
  if (options.endpoint) {
    if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(options.endpoint)) {
      throw new Error("refusing non-loopback Codex app-server endpoint");
    }
    const socket = new WebSocket(options.endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("codex app-server WebSocket handshake timed out"));
      }, 8_000);
      timer.unref?.();
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    return new CodexJsonRpcClient(
      socket,
      sessionId,
      options.interactions ?? new AgentInteractionBroker(),
      options.onActivity,
    );
  }
  const command = options.child ? null : agentCommand("codex", ["app-server"], options.codexHome ? { ...process.env, CODEX_HOME: options.codexHome } : process.env);
  const child = options.child ?? spawn(command!.bin, command!.args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    ...(command ? { env: command.env } : {}),
  });
  if (!options.child) trackCodexProcess(child, process.platform !== "win32");
  return new CodexJsonRpcClient(child, sessionId, options.interactions ?? new AgentInteractionBroker(), options.onActivity, !options.child && process.platform !== "win32");
}

function managedThreadParamsForProfile(
  cwd: string,
  extra: Record<string, unknown>,
  profile: CodexPermissionProfile = codexPermissionProfile(undefined),
  environmentId?: string,
): Record<string, unknown> {
  return {
    ...extra,
    ...codexThreadPermissionParams(profile),
    cwd,
    ...(environmentId ? { environments: [{ environmentId, cwd, runtimeWorkspaceRoots: [cwd] }] } : {}),
  };
}

// Remote thread initialization also discovers the executor filesystem and MCP
// tools. Keep its relay alive through that bounded setup; input dispatch and
// ordinary local threads retain their existing deadlines.
function threadInitializationTimeoutMs(options: CodexManagedSessionOptions): number {
  return options.environment ? 120_000 : 30_000;
}

async function prepareEnvironment(
  client: CodexJsonRpcClient,
  options: CodexManagedSessionOptions,
): Promise<CodexManagedSessionOptions> {
  if (!options.environment) return options;
  await client.request("environment/add", {
    environmentId: options.environment.environmentId,
    execServerUrl: options.environment.execServerUrl,
    connectTimeoutMs: 10_000,
  }, 15_000);
  const info = object(await client.request("environment/info", {
    environmentId: options.environment.environmentId,
  }, 15_000));
  const cwdUri = string(info.cwd);
  if (!cwdUri) throw new Error("Codex remote environment did not report a working directory");
  return { ...options, cwd: environmentNativePath(cwdUri) };
}

function environmentNativePath(value: string): string {
  if (!value.startsWith("file:")) return value;
  const uri = new URL(value);
  const decoded = decodeURIComponent(uri.pathname);
  if (/^\/[A-Za-z]:\//.test(decoded)) return decoded.slice(1).replaceAll("/", "\\");
  if (uri.hostname) return `\\\\${uri.hostname}${decoded.replaceAll("/", "\\")}`;
  return fileURLToPath(uri);
}

function managedConfig(options: CodexManagedSessionOptions): Record<string, unknown> | undefined {
  if (!options.config && !options.effort) return undefined;
  return {
    ...options.config,
    ...(options.effort ? { model_reasoning_effort: options.effort } : {}),
  };
}

function withInteractions(options: CodexManagedSessionOptions): CodexManagedSessionOptions {
  return options.interactions ? options : { ...options, interactions: new AgentInteractionBroker() };
}

function textInput(prompt: string): Array<Record<string, unknown>> {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

/** @internal Exported only as a test seam for transport-failure timing. */
export class CodexJsonRpcClient {
  private readonly lines?: readline.Interface;
  private readonly child?: ChildProcessWithoutNullStreams;
  private readonly socket?: WebSocket;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
    turnStart?: boolean;
  }>();
  private readonly isolatedThreads = new Set<string>();
  private readonly isolatedObservers = new Map<string, (method: string, params: unknown) => void>();
  private nextId = 1;
  private closed = false;
  private turnDone = false;
  /** True only after a returned turn has a consumer for its completion. */
  private completionObserved = false;
  private activeTurnId = "";
  private assistantText = "";
  private usage: CodexAppServerTurnUsage | undefined;
  private turnError: CodexTurnError | undefined;
  private startedNotification = deferred<string>();
  private startedNotificationObserved = false;
  private completion: {
    promise: Promise<CompletedCodexTurn>;
    resolve: (value: CompletedCodexTurn) => void;
    reject: (error: Error) => void;
  };
  stderr = "";

  constructor(
    transport: ChildProcessWithoutNullStreams | WebSocket,
    private sessionId: string,
    private interactions: AgentInteractionBroker,
    private readonly onActivity?: () => void,
    private readonly ownedProcessGroup = false,
  ) {
    let resolve!: (value: CompletedCodexTurn) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<CompletedCodexTurn>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.completion = { promise, resolve, reject };
    if (transport instanceof WebSocket) {
      this.socket = transport;
      transport.on("message", (data) => void this.onLine(String(data)));
      transport.once("error", (error) => this.fail(error));
      transport.once("close", (code, reason) => {
        if (!this.closed) this.fail(new Error(`codex app-server WebSocket closed (${code} ${String(reason)})`));
      });
    } else {
      this.child = transport;
      this.lines = readline.createInterface({ input: transport.stdout });
      this.lines.on("line", (line) => void this.onLine(line));
      transport.stderr.on("data", (chunk: Buffer | string) => {
        this.stderr = (this.stderr + String(chunk)).slice(-8_000);
      });
      // A dead app-server reports a piped write failure on stdin, not on the
      // ChildProcess. Keep the listener for the stream's whole lifetime and
      // settle every protocol waiter through the ordinary transport failure.
      transport.stdin.on("error", (error) => this.fail(error));
      transport.once("error", (error) => this.fail(error));
      transport.once("exit", (code, signal) => {
        if (!this.closed) this.fail(new Error(`codex app-server exited (${String(code ?? signal ?? "unknown")})`));
      });
    }
  }

  observeIsolatedThread(id: string, listener: (method: string, params: unknown) => void): () => void {
    this.isolatedThreads.add(id);
    this.isolatedObservers.set(id, listener);
    return () => { this.isolatedObservers.delete(id); };
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  beginTurn(): void {
    if (this.closed) throw new Error("codex app-server 已关闭");
    this.turnDone = false;
    this.completionObserved = false;
    this.activeTurnId = "";
    this.assistantText = "";
    this.usage = undefined;
    this.turnError = undefined;
    this.startedNotification = deferred<string>();
    this.startedNotificationObserved = false;
    let resolve!: (value: CompletedCodexTurn) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<CompletedCodexTurn>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.completion = { promise, resolve, reject };
  }

  async started(timeoutMs: number): Promise<string> {
    this.startedNotificationObserved = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.startedNotification.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("codex app-server did not announce the compact turn")),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  setActiveTurnId(turnId: string): void {
    this.activeTurnId = turnId;
  }

  request(method: string, params: unknown, timeoutMs: number, turnStart = false): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("codex app-server closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server ${method} timed out`));
      }, timeoutMs) : undefined;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer, turnStart });
      // Register before writing: synchronous transport errors/replies must
      // settle the real waiter instead of leaving an orphaned request.
      try { this.send({ id, method, params }); }
      catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  async completed(timeoutMs: number): Promise<CompletedCodexTurn> {
    this.completionObserved = true;
    if (timeoutMs <= 0) return await this.completion.promise;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.completion.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("codex app-server turn timed out")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const error = new Error("codex app-server closed");
    if (this.startedNotificationObserved) this.startedNotification.reject(error);
    if (!this.completionObserved) this.completion.promise.catch(() => {});
    this.completion.reject(error);
    this.lines?.close();
    for (const row of this.pending.values()) {
      clearTimeout(row.timer);
      row.reject(new Error("codex app-server closed"));
    }
    this.pending.clear();
    if (this.socket) {
      if (this.socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.socket?.terminate(); resolve(); }, 1_000);
        timer.unref?.();
        this.socket!.once("close", () => { clearTimeout(timer); resolve(); });
        this.socket!.close(1000, "Octopus attachment released");
      });
      return;
    }
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await closeCodexProcess(child, this.ownedProcessGroup);
  }

  private async onLine(line: string): Promise<void> {
    try {
      this.onActivity?.();
    } catch {
      // Observability must never break provider protocol handling.
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      try {
        if (this.isolatedThreads.has(string(object(message.params).threadId))) {
          throw new Error("tools and approvals are disabled for automatic titles");
        }
        const result = await this.handleServerRequest(message.method, message.params);
        this.write({ id: message.id, result });
      } catch (error) {
        this.write({ id: message.id, error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = codexRequestError(message.error.message);
        if (typeof message.error.code === "number") Object.assign(error, { rpcCode: message.error.code });
        if (pending.turnStart) Object.assign(error, { inputRejected: true });
        pending.reject(error);
      }
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      const observer = this.isolatedObservers.get(string(object(message.params).threadId));
      observer?.(message.method, message.params);
      this.handleNotification(message.method, message.params);
    }
  }

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    const row = object(params);
    const sessionId = string(row.threadId) || this.sessionId;
    if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
      const questions = normalizeQuestions(row.questions);
      const response = await this.interactions.request({
        provider: "codex",
        sessionId,
        kind: "question",
        title: "Codex 需要你的回答",
        tool: "request_user_input",
        questions,
      });
      return { answers: answerEnvelope(questions, response) };
    }
    if (method === "item/commandExecution/requestApproval") {
      const response = await this.permission(sessionId, {
        title: string(row.command) ? `Codex 请求执行命令：${string(row.command)}` : "Codex 请求执行命令",
        description: string(row.reason),
        tool: "commandExecution",
        detail: jsonDetail({ command: row.command, cwd: row.cwd, commandActions: row.commandActions }),
      });
      return { decision: response?.decision === "allow" ? "accept" : "decline" };
    }
    if (method === "item/fileChange/requestApproval") {
      const response = await this.permission(sessionId, {
        title: "Codex 请求修改文件",
        description: string(row.reason),
        tool: "fileChange",
        detail: jsonDetail({ reason: row.reason, grantRoot: row.grantRoot }),
      });
      return { decision: response?.decision === "allow" ? "accept" : "decline" };
    }
    if (method === "item/permissions/requestApproval") {
      const response = await this.permission(sessionId, {
        title: "Codex 请求扩展权限",
        description: string(row.reason),
        tool: "permissions",
        detail: jsonDetail({ permissions: row.permissions, cwd: row.cwd }),
      });
      return {
        permissions: response?.decision === "allow" ? object(row.permissions) : {},
        scope: "turn",
      };
    }
    if (method === "mcpServer/elicitation/request") {
      // Codex 0.154 uses an empty MCP form for one-call tool consent. Route
      // that exact confirmation through the same human broker as commands.
      // Never invent answers for forms with fields, or follow an auth URL.
      const schema = object(row.requestedSchema);
      const properties = schema.properties;
      const confirmation = row.mode === "form" && schema.type === "object"
        && properties !== null && typeof properties === "object" && !Array.isArray(properties)
        && Object.keys(properties).length === 0
        && (schema.required === undefined || Array.isArray(schema.required) && schema.required.length === 0)
        && Object.keys(schema).every(key => ["type", "properties", "required", "additionalProperties"].includes(key));
      if (!confirmation) return { action: "decline", content: null, _meta: null };
      const response = await this.permission(sessionId, {
        title: "Codex 请求调用 MCP 工具",
        description: string(row.message),
        tool: string(row.serverName) || "MCP",
        detail: jsonDetail({ server: row.serverName, request: row.message }),
      });
      return response?.decision === "allow"
        ? { action: "accept", content: {}, _meta: null }
        : { action: "decline", content: null, _meta: null };
    }
    return {};
  }

  private async permission(
    sessionId: string,
    request: { title: string; description: string; tool: string; detail: string },
  ): Promise<AgentInteractionResponse | null> {
    return await this.interactions.request({
      provider: "codex",
      sessionId,
      kind: "permission",
      title: request.title,
      ...(request.description ? { description: request.description } : {}),
      tool: request.tool,
      detail: request.detail,
    });
  }

  private handleNotification(method: string, params: unknown): void {
    const row = object(params);
    if (string(row.threadId) && string(row.threadId) !== this.sessionId) return;
    if (method === "error") {
      const turnId = string(row.turnId);
      if (string(row.threadId) !== this.sessionId || !turnId
        || (this.activeTurnId && turnId !== this.activeTurnId)) return;
      this.turnError = nativeTurnError(row.error, this.sessionId, turnId,
        typeof row.willRetry === "boolean" ? row.willRetry : undefined);
      return;
    }
    if (method === "turn/started") {
      const threadId = string(row.threadId);
      if (threadId !== this.sessionId) return;
      const turnId = string(object(row.turn).id);
      if (turnId) {
        if (!this.activeTurnId) this.activeTurnId = turnId;
        this.startedNotification.resolve(turnId);
        this.acknowledgeTurnStart(turnId);
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const last = object(object(row.tokenUsage).last);
      const usage: CodexAppServerTurnUsage = {};
      if (typeof last.inputTokens === "number") usage.inputTokens = last.inputTokens;
      if (typeof last.cachedInputTokens === "number") usage.cachedInputTokens = last.cachedInputTokens;
      if (typeof last.outputTokens === "number") usage.outputTokens = last.outputTokens;
      if (Object.keys(usage).length) this.usage = usage;
      return;
    }
    if (method === "item/agentMessage/delta") {
      this.assistantText += string(row.delta);
      return;
    }
    if (method === "item/completed") {
      const item = object(row.item);
      if ((item.type === "agentMessage" || item.type === "agent_message") && string(item.text)) {
        this.assistantText = string(item.text);
      }
      return;
    }
    if (method !== "turn/completed") return;
    const threadId = string(row.threadId);
    if (threadId !== this.sessionId) return;
    const turn = object(row.turn);
    const turnId = string(turn.id);
    // A compact-capable app-server should announce turn/started first. Keep
    // completion as a compatibility backstop so a fast turn cannot strand the
    // caller merely because both notifications overtook the empty RPC reply.
    if (this.activeTurnId && turnId && turnId !== this.activeTurnId) return;
    if (turnId) {
      this.startedNotification.resolve(turnId);
      this.acknowledgeTurnStart(turnId);
    }
    const status = string(turn.status) || "completed";
    const error = string(object(turn.error).message);
    const priorError = this.turnError?.turnId === turnId ? this.turnError : undefined;
    const providerError = turn.error
      ? nativeTurnError(turn.error, threadId, turnId, priorError?.willRetry)
      : priorError;
    this.turnDone = true;
    this.completion.resolve({
      status,
      text: this.assistantText.trim(),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(error ? { error } : {}),
      ...(providerError ? { providerError } : {}),
    });
  }

  private write(message: JsonRpcMessage): void {
    this.send(message);
  }

  private acknowledgeTurnStart(turnId: string): void {
    for (const [id, request] of this.pending) {
      if (!request.turnStart) continue;
      clearTimeout(request.timer);
      this.pending.delete(id);
      request.resolve({ turn: { id: turnId } });
    }
  }

  private send(message: JsonRpcMessage): void {
    const text = JSON.stringify(message);
    if (this.socket) {
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error("codex app-server WebSocket is not open");
      this.socket.send(text);
      return;
    }
    if (this.child && !this.child.stdin.destroyed && this.child.stdin.writable) {
      this.child.stdin.write(`${text}\n`);
      return;
    }
    throw new Error("codex app-server stdin is not writable");
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const row of this.pending.values()) {
      clearTimeout(row.timer);
      row.reject(error);
    }
    this.pending.clear();
    if (this.startedNotificationObserved) this.startedNotification.reject(error);
    // Always settle the completion: a transport that dies between beginTurn()
    // and completed() must reject the future consumer, not leave it pending
    // until the turn timeout (or forever when timeoutMs <= 0). When no
    // consumer exists yet, pre-attach a catch so the rejection is not an
    // unhandled one; a later completed() still observes the rejected promise.
    if (!this.completionObserved) this.completion.promise.catch(() => {});
    this.completion.reject(error);
  }
}

function nativeTurnError(value: unknown, threadId: string, turnId: string, willRetry?: boolean): CodexTurnError {
  const row = object(value);
  const info = row.codexErrorInfo;
  const code = typeof info === "string" ? info : Object.keys(object(info))[0];
  return { threadId, turnId, message: string(row.message).slice(0, 1_000),
    ...(code ? { code: code.slice(0, 100) } : {}),
    ...(willRetry !== undefined ? { willRetry } : {}) };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function answerEnvelope(
  questions: ReturnType<typeof normalizeQuestions>,
  response: AgentInteractionResponse | null,
): Record<string, { answers: string[] }> {
  if (!response || response.decision !== "allow") return {};
  return Object.fromEntries(questions.map((question) => [
    question.id,
    { answers: response.answers[question.id] ?? [] },
  ]));
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 12_000) : "";
}

function jsonDetail(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 12_000);
  } catch {
    return "";
  }
}
