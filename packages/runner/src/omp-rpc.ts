import { agentCommand } from "./agent-executables.js";
/**
 * Oh My Pi's native control transport: `omp --mode rpc` over stdio.
 *
 * This is the piece that lets omp skip the compatibility ladder the other two
 * providers needed. Claude got an SDK and Codex got an app-server; omp ships a
 * newline-delimited JSON protocol in the same binary the person already runs,
 * so ONE attachment covers every managed shape Octopus needs — start a new
 * session, resume an existing one, steer a running turn, abort it — without a
 * second argv dialect or a provider package.
 *
 * Three protocol facts shape the code and are not negotiable:
 *
 *   · a `prompt` is ACKNOWLEDGED, not completed. The turn ends at `agent_end`
 *     with `isTerminal !== false`; an `isTerminal: false` frame means the
 *     session scheduled more work and will resume. Treating the ack as the
 *     result is how a host reports "done" while the agent is still typing.
 *   · a prompt that resolves locally (a slash command) never emits `agent_end`.
 *     It reports `data.agentInvoked: false` on the ack, or later as
 *     `prompt_result`. Both must complete the turn or it hangs forever.
 *   · protocol v2 splits an oversized stdout object into `rpc_chunk` frames.
 *     Reassembly is strict by contract — a client that tolerates interleaved
 *     or short sequences silently parses half a transcript.
 *
 * What this transport CANNOT do is equally load-bearing: RPC mode has no
 * approval surface, so a tool that would prompt fails closed inside omp. The
 * manual permission profile is therefore refused here rather than silently
 * downgraded into an auto-approving session (see `assertOmpPermissionProfile`).
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { classifyOmpContent } from "@claude-bot/plugin-sessions/scan";
import {
  AgentInteractionBroker,
  normalizeQuestions,
  type AgentInteractionResponse,
} from "./agent-interactions.js";
import { AGENT_PERMISSION_PROFILES, type AgentPermissionProfile } from "./agent-permissions.js";
import type { RunnerManagedTurnUsage } from "./gateway-protocol.js";

/** Largest reassembled logical frame we will hold in memory (protocol v2 ceiling). */
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
/** Cold-start budget: omp loads its provider/config before emitting ready; production starts can exceed 30s. */
const HANDSHAKE_TIMEOUT_MS = 90_000;
/** Ordinary command round-trip budget. Turns have their own, much larger, clock. */
const COMMAND_TIMEOUT_MS = 30_000;
/** Rolling stderr kept for an honest failure message. */
const STDERR_TAIL = 4_000;

export interface OmpManagedTurnResult {
  started: boolean;
  ok: boolean;
  status?: string;
  resultText?: string;
  error?: string;
  stderr?: string;
  timedOut?: boolean;
  usage?: RunnerManagedTurnUsage;
}

export interface OmpManagedSessionOptions {
  cwd: string;
  interactions?: AgentInteractionBroker;
  timeoutMs: number;
  model?: string;
  /** omp's thinking level (off … max); its spelling of "effort". */
  effort?: string;
  permissionProfile?: AgentPermissionProfile;
  /** MCP-only split placement; disables every built-in tool. */
  remoteMcpUrl?: string;
  /** Test seam: an already-spawned child speaking the same protocol. */
  child?: ChildProcessWithoutNullStreams;
  /** Test seam: skip the real binary lookup and use this argv instead. */
  bin?: string;
  /** Child environment, used by hosts that provide per-turn credentials. */
  env?: NodeJS.ProcessEnv;
  /** Liveness observer; called for every stdout/stderr frame. */
  onActivity?: () => void;
}

export interface OmpManagedDispatch {
  kind: "started" | "steered";
  turnId: string;
  completion: Promise<OmpManagedTurnResult>;
}

/**
 * RPC mode has no approval UI: a tool call that would prompt fails closed
 * inside omp with "no interactive UI is available". Accepting `manual` here
 * would therefore promise a review step that can never happen, and the
 * alternative — quietly running the session auto-approving — is worse.
 */
export function assertOmpPermissionProfile(profile: AgentPermissionProfile | undefined): void {
  if (profile === AGENT_PERMISSION_PROFILES.manual) {
    const error = new Error(
      "omp 的 RPC 通道没有审批界面：手动确认档在这里无法实现（omp 会直接拒绝需要确认的工具）。"
      + "请改用完整访问档，或在本机 omp TUI 里自己确认。",
    );
    (error as Error & { code?: string }).code = "permission_profile_unsupported";
    throw error;
  }
}

/** Exactly the launch flags this transport owns. Pure so argv stays testable. */
export function ompRpcArgs(input: {
  cwd: string;
  resumePath?: string;
  model?: string;
  effort?: string;
  permissionProfile?: AgentPermissionProfile;
  remoteMcpUrl?: string;
}): string[] {
  const args = ["--mode", "rpc", "--cwd", input.cwd];
  // A path (not an id prefix) is deliberate: omp opens a `.jsonl` value
  // directly, while a prefix can match another project and, when the recorded
  // directory is gone, drops into a TTY prompt that a headless host can never
  // answer.
  if (input.resumePath) args.push("--resume", input.resumePath);
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--thinking", input.effort);
  // The only profile this transport can honour; see assertOmpPermissionProfile.
  args.push("--auto-approve");
  if (input.remoteMcpUrl) args.push("--no-tools");
  return args;
}

/**
 * One managed omp attachment. Constructed through `start`/`resume` so the
 * handshake (ready → negotiate v2 → get_state) always completes before any
 * caller can dispatch a prompt into it.
 */
export class OmpManagedSession {
  private readonly client: OmpRpcClient;
  private active: {
    turnId: string;
    completion: Promise<OmpManagedTurnResult>;
    finishInteraction: () => void;
  } | undefined;
  private closed = false;

  private constructor(
    client: OmpRpcClient,
    readonly sessionId: string,
    readonly sessionFile: string,
    private readonly interactions: AgentInteractionBroker,
    private readonly timeoutMs: number,
    private readonly profile: AgentPermissionProfile | undefined,
  ) {
    this.client = client;
    client.bindSession(sessionId);
  }

  static async start(options: OmpManagedSessionOptions): Promise<OmpManagedSession> {
    return await OmpManagedSession.open(options, undefined);
  }

  static async resume(sessionPath: string, options: OmpManagedSessionOptions): Promise<OmpManagedSession> {
    if (!sessionPath.trim()) throw new Error("omp resume 需要会话文件路径");
    return await OmpManagedSession.open(options, sessionPath);
  }

  private static async open(
    options: OmpManagedSessionOptions,
    resumePath: string | undefined,
  ): Promise<OmpManagedSession> {
    assertOmpPermissionProfile(options.permissionProfile);
    const interactions = options.interactions ?? new AgentInteractionBroker();
    const argv = ompRpcArgs({
        cwd: options.cwd,
        ...(resumePath ? { resumePath } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
        ...(options.remoteMcpUrl ? { remoteMcpUrl: options.remoteMcpUrl } : {}),
      });
    const command = options.bin || options.child
      ? { bin: options.bin ?? "omp", args: argv, env: options.env }
      : agentCommand("omp", argv, options.env);
    const child = options.child ?? spawn(command.bin, command.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(command.env ? { env: command.env } : {}),
    });
    const client = new OmpRpcClient(child, interactions, options.onActivity);
    try {
      await client.ready(HANDSHAKE_TIMEOUT_MS);
      const state = await client.request("get_state", {}, COMMAND_TIMEOUT_MS);
      const sessionId = stringField(state, "sessionId");
      const sessionFile = stringField(state, "sessionFile");
      if (!sessionId) throw new Error("omp 没有报告会话 id");
      return new OmpManagedSession(
        client,
        sessionId,
        sessionFile,
        interactions,
        options.timeoutMs,
        options.permissionProfile,
      );
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get turnActive(): boolean {
    return this.active !== undefined;
  }

  get permissionProfile(): AgentPermissionProfile | undefined {
    return this.profile;
  }

  /**
   * Send one prompt. A prompt that arrives while a turn is running is STEERED
   * into that turn rather than queued behind it — that is the interaction a
   * person expects when they type while the agent works, and it is the only
   * shape that cannot silently reorder their two messages.
   */
  async dispatch(prompt: string): Promise<OmpManagedDispatch> {
    if (this.closed) throw new Error("这个 omp attachment 已经关闭");
    const text = prompt.trim();
    if (!text) throw new Error("发送到 omp 的 prompt 不能为空");

    const running = this.active;
    if (running) {
      await this.client.request("prompt", { message: text, streamingBehavior: "steer" }, COMMAND_TIMEOUT_MS);
      return { kind: "steered", turnId: running.turnId, completion: running.completion };
    }

    const turnId = `turn_${randomUUID().replace(/-/g, "")}`;
    const finishInteraction = this.interactions.beginManaged("omp", this.sessionId, { providerControl: true });
    const turn = this.client.openTurn();
    let ack: Record<string, unknown>;
    try {
      ack = await this.client.request("prompt", { message: text }, COMMAND_TIMEOUT_MS);
    } catch (error) {
      this.client.abandonTurn();
      finishInteraction();
      throw error;
    }
    // `agentInvoked: false` is the completion signal for a local-only prompt.
    // Older runtimes omit `data` entirely, in which case the session events
    // remain the authority and the turn stays open.
    if (ack.agentInvoked === false) this.client.settleLocalTurn();

    const completion = this.client.awaitTurn(turn, this.timeoutMs).finally(() => {
      if (this.active?.turnId === turnId) this.active = undefined;
      this.interactions.cancel("omp", this.sessionId);
      finishInteraction();
    });
    this.active = { turnId, completion, finishInteraction };
    return { kind: "started", turnId, completion };
  }

  /** Stop the running turn. The session, its file and this attachment survive. */
  async interrupt(): Promise<void> {
    if (this.closed || !this.active) return;
    await this.client.request("abort", {}, COMMAND_TIMEOUT_MS).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.interactions.cancel("omp", this.sessionId);
    await this.client.close();
  }
}

// ---------------------------------------------------------------------------
// Wire layer
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface OpenTurn {
  resolve: (value: OmpManagedTurnResult) => void;
  settled: boolean;
  /**
   * The settled value, kept because a turn can finish BEFORE anyone awaits it
   * — a local-only prompt settles on its own acknowledgement. Without this the
   * result would be reconstructed from the leftover fields and quietly lose
   * whatever the settling site actually decided.
   */
  result?: OmpManagedTurnResult;
  /** Text deltas seen this turn; the fallback when `agent_end` carries none. */
  streamed: string;
  /** Final assistant text lifted out of `agent_end.messages`. */
  finalText: string;
  usage?: RunnerManagedTurnUsage;
}

/**
 * Strict protocol-v2 chunk reassembly.
 *
 * Exported because this is the one piece of the transport with a written
 * contract a host can get wrong quietly: accept an interleaved or short
 * sequence and the caller parses a truncated JSON object as if it were whole.
 */
export class OmpFrameDecoder {
  private chunkId = "";
  private expected = 0;
  private byteLength = 0;
  private parts: Buffer[] = [];

  /** Feed one decoded stdout object. Returns a completed logical frame or null. */
  push(frame: Record<string, unknown>): Record<string, unknown> | null {
    if (frame.type !== "rpc_chunk") {
      if (this.parts.length) {
        this.reset();
        throw new Error("omp rpc_chunk 序列被其他帧打断");
      }
      return frame;
    }
    const chunkId = String(frame.chunkId ?? "");
    const index = Number(frame.index);
    const count = Number(frame.count);
    const byteLength = Number(frame.byteLength);
    const data = typeof frame.data === "string" ? frame.data : "";
    if (!chunkId || !Number.isInteger(index) || !Number.isInteger(count) || count <= 0) {
      this.reset();
      throw new Error("omp rpc_chunk 帧头无效");
    }
    if (this.parts.length === 0) {
      if (index !== 0) {
        throw new Error("omp rpc_chunk 序列没有从 index 0 开始");
      }
      if (!Number.isInteger(byteLength) || byteLength <= 0 || byteLength > MAX_REASSEMBLED_BYTES) {
        throw new Error("omp rpc_chunk 声明的长度超出可重组上限");
      }
      this.chunkId = chunkId;
      this.expected = count;
      this.byteLength = byteLength;
    } else if (chunkId !== this.chunkId || count !== this.expected || index !== this.parts.length) {
      this.reset();
      throw new Error("omp rpc_chunk 序列被交错或跳号");
    }
    this.parts.push(Buffer.from(data, "base64"));
    if (this.parts.length < this.expected) return null;

    const joined = Buffer.concat(this.parts);
    const expectedBytes = this.byteLength;
    this.reset();
    if (joined.byteLength !== expectedBytes) throw new Error("omp rpc_chunk 重组后的字节数与声明不符");
    const parsed = JSON.parse(joined.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("omp rpc_chunk 重组后的内容不是一个 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  }

  private reset(): void {
    this.chunkId = "";
    this.expected = 0;
    this.byteLength = 0;
    this.parts = [];
  }
}

class OmpRpcClient {
  private readonly lines: readline.Interface;
  private readonly decoder = new OmpFrameDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private sessionId = "";
  private turn: OpenTurn | undefined;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private readonly readyPromise: Promise<void>;
  private closed = false;
  private failure: Error | undefined;
  stderr = "";

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly interactions: AgentInteractionBroker,
    private readonly onActivity?: () => void,
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      void this.onLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.onActivity?.();
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    // `write()` reports a closed child asynchronously on this stream. Without
    // a listener, Node promotes EPIPE to an uncaught EventEmitter error and
    // takes the whole Runner down. It is a transport failure, so route it
    // through the same lifecycle that rejects ready/pending/turn work.
    child.stdin.on("error", (error) => this.fail(error));
    child.once("error", (error) => this.fail(/ENOENT/.test(error.message)
      ? new Error("未找到 omp 命令 — Runner 进程的 PATH 里没有它")
      : error));
    child.once("exit", (code, signal) => {
      this.fail(new Error(`omp --mode rpc 已退出 (${String(code ?? signal ?? "unknown")})`));
    });
  }

  bindSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  async ready(timeoutMs: number): Promise<void> {
    const timer = setTimeout(
      () => this.readyReject?.(new Error("omp --mode rpc 没有在超时前发出 ready 帧")),
      timeoutMs,
    );
    timer.unref?.();
    try {
      await this.readyPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  async request(type: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    // A request issued after the child died must fail now with the real
    // cause, not sit in `pending` until its own timeout: `write()` swallows
    // the EPIPE and no response will ever arrive.
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("omp attachment 已关闭");
    const id = `req_${this.nextId++}`;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`omp ${type} 超时未返回`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...params, id, type });
    });
  }

  openTurn(): OpenTurn {
    const turn: OpenTurn = { resolve: () => {}, settled: false, streamed: "", finalText: "" };
    this.turn = turn;
    return turn;
  }

  /** @internal Test/inspection seam for a turn that settled before it was awaited. */
  settledResult(turn: OpenTurn): OmpManagedTurnResult | undefined {
    return turn.result;
  }

  abandonTurn(): void {
    this.turn = undefined;
  }

  /** A prompt that completed without an agent turn (slash command, no-op). */
  settleLocalTurn(): void {
    this.settleTurn({ started: true, ok: true, status: "local" });
  }

  async awaitTurn(turn: OpenTurn, timeoutMs: number): Promise<OmpManagedTurnResult> {
    if (turn.result) return turn.result;
    const settled = new Promise<OmpManagedTurnResult>((resolve) => {
      turn.resolve = resolve;
    });
    if (timeoutMs <= 0) return await settled;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<OmpManagedTurnResult>((resolve) => {
      timer = setTimeout(
        () => resolve({
          started: true,
          ok: false,
          timedOut: true,
          error: "omp 这一轮超出了 Runner 的等待上限；omp 进程仍在运行，未自动中断。",
          ...this.turnText(turn),
        }),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([settled, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.turn === turn) this.turn = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Closing stdin is omp's documented shutdown: it drains accepted commands,
    // disposes the session and exits 0. Killing it would abandon a turn
    // mid-tool with no session-file quiescence.
    try {
      this.child.stdin.end();
    } catch {
      /* already gone */
    }
    this.lines.close();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        this.child.kill("SIGTERM");
        resolve();
      }, 5_000);
      timer.unref?.();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async onLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.onActivity?.();
    let frame: Record<string, unknown> | null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      frame = this.decoder.push(parsed as Record<string, unknown>);
    } catch {
      // A malformed or interrupted frame is a transport fault, not a turn
      // result. Drop it: the request timers and process exit remain the
      // authority on whether anything is still coming.
      return;
    }
    if (!frame) return;

    switch (frame.type) {
      case "ready":
        await this.onReady(frame);
        return;
      case "response":
        this.onResponse(frame);
        return;
      case "extension_ui_request":
        await this.onUiRequest(frame);
        return;
      case "prompt_result":
        if (frame.agentInvoked === false) this.settleLocalTurn();
        return;
      case "agent_end":
        this.onAgentEnd(frame);
        return;
      case "message_update":
        this.onDelta(frame);
        return;
      default:
        return;
    }
  }

  private async onReady(frame: Record<string, unknown>): Promise<void> {
    const supported = Array.isArray(frame.supportedProtocolVersions) ? frame.supportedProtocolVersions : [];
    this.readyResolve?.();
    this.readyResolve = undefined;
    this.readyReject = undefined;
    if (!supported.includes(2)) return;
    // Lossless framing for oversized objects. A failure here is not fatal: v1
    // still delivers ordinary frames, it just refuses very large ones.
    await this.request("negotiate_protocol", { protocolVersion: 2 }, COMMAND_TIMEOUT_MS).catch(() => {});
  }

  private onResponse(frame: Record<string, unknown>): void {
    const id = typeof frame.id === "string" ? frame.id : "";
    const row = id ? this.pending.get(id) : undefined;
    if (!row) return;
    this.pending.delete(id);
    clearTimeout(row.timer);
    if (frame.success === true) {
      const data = frame.data;
      row.resolve(data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {});
      return;
    }
    const message = typeof frame.error === "string" && frame.error ? frame.error : `omp ${String(frame.command)} 失败`;
    const error = new Error(message) as Error & { code?: string };
    if (typeof frame.code === "string") error.code = frame.code;
    row.reject(error);
  }

  private onDelta(frame: Record<string, unknown>): void {
    const turn = this.turn;
    if (!turn) return;
    const event = frame.assistantMessageEvent;
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    const row = event as Record<string, unknown>;
    if (row.type !== "text_delta") return;
    const delta = typeof row.delta === "string" ? row.delta : "";
    if (delta) turn.streamed = (turn.streamed + delta).slice(-96_000);
  }

  private onAgentEnd(frame: Record<string, unknown>): void {
    const turn = this.turn;
    if (turn) {
      const text = lastAssistantText(frame.messages);
      if (text) turn.finalText = text;
      // OMP accounts each assistant message (the same shape consumed by the
      // devpipe executor), while a few builds additionally summarize usage on
      // agent_end. Prefer the exact final assistant row and keep the summary as
      // a compatibility fallback.
      turn.usage = lastAssistantUsage(frame.messages) ?? ompTurnUsage(frame.usage) ?? turn.usage;
    }
    // `isTerminal: false` means maintenance or async delivery scheduled more
    // work and the session will resume — the run is not over.
    if (frame.isTerminal === false) return;
    this.settleTurn({ started: true, ok: true, status: "completed" });
  }

  private settleTurn(result: OmpManagedTurnResult): void {
    const turn = this.turn;
    if (!turn || turn.settled) return;
    turn.settled = true;
    this.turn = undefined;
    const value: OmpManagedTurnResult = {
      ...result,
      ...this.turnText(turn),
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(this.stderr ? { stderr: this.stderr } : {}),
    };
    turn.result = value;
    turn.resolve(value);
  }

  private turnText(turn: OpenTurn): { resultText?: string } {
    const text = turn.finalText || turn.streamed;
    return text.trim() ? { resultText: text.trim() } : {};
  }

  /**
   * Bridge one extension dialog to the durable interaction broker.
   *
   * Everything that is not an actual user DECISION (status lines, widgets,
   * notifications) is answered `cancelled` immediately: omp resolves a
   * cancelled dialog to its default, so a host with no such surface never
   * becomes the reason a turn stalls.
   */
  private async onUiRequest(frame: Record<string, unknown>): Promise<void> {
    const id = typeof frame.id === "string" ? frame.id : "";
    if (!id) return;
    const method = String(frame.method ?? "");
    const title = stringField(frame, "title") || "omp 请求";
    const message = stringField(frame, "message");

    if (method !== "confirm" && method !== "select" && method !== "input") {
      this.write({ type: "extension_ui_response", id, cancelled: true });
      return;
    }
    if (!this.sessionId) {
      this.write({ type: "extension_ui_response", id, cancelled: true });
      return;
    }

    let answer: AgentInteractionResponse | null = null;
    try {
      answer = await this.interactions.request({
        provider: "omp",
        sessionId: this.sessionId,
        kind: method === "confirm" ? "permission" : "question",
        title,
        ...(message ? { description: message } : {}),
        ...(method === "confirm" ? {} : { questions: normalizeQuestions([uiQuestion(frame, method, title, message)]) }),
      });
    } catch {
      answer = null;
    }

    if (!answer) {
      this.write({ type: "extension_ui_response", id, cancelled: true });
      return;
    }
    if (method === "confirm") {
      this.write({ type: "extension_ui_response", id, confirmed: answer.decision === "allow" });
      return;
    }
    if (answer.decision === "deny") {
      this.write({ type: "extension_ui_response", id, cancelled: true });
      return;
    }
    const value = Object.values(answer.answers)[0]?.[0] ?? answer.message ?? "";
    this.write({ type: "extension_ui_response", id, value });
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* the exit handler is the authority on a dead child */
    }
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const [id, row] of this.pending) {
      this.pending.delete(id);
      clearTimeout(row.timer);
      row.reject(error);
    }
    const turn = this.turn;
    if (turn && !turn.settled) {
      turn.settled = true;
      this.turn = undefined;
      const value: OmpManagedTurnResult = {
        started: true,
        ok: false,
        error: this.stderr ? `${error.message}: ${this.stderr}` : error.message,
        ...this.turnText(turn),
        ...(this.stderr ? { stderr: this.stderr } : {}),
      };
      turn.result = value;
      turn.resolve(value);
    }
  }
}

function ompTurnUsage(value: unknown): RunnerManagedTurnUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const count = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
      ? Math.round(candidate)
      : 0;
  const input = count(row.input);
  const output = count(row.output);
  const cached = count(row.cacheRead) + count(row.cacheWrite);
  return input || output || cached
    ? {
        ...(input ? { tokens_in: input } : {}),
        ...(output ? { tokens_out: output } : {}),
        ...(cached ? { tokens_cached: cached } : {}),
      }
    : undefined;
}

function lastAssistantUsage(messages: unknown): RunnerManagedTurnUsage | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    const usage = ompTurnUsage(record.usage);
    if (usage) return usage;
  }
  return undefined;
}

function uiQuestion(
  frame: Record<string, unknown>,
  method: string,
  title: string,
  message: string,
): Record<string, unknown> {
  const options = Array.isArray(frame.options)
    ? frame.options.map((option) => (typeof option === "string"
      ? { label: option }
      : { label: String((option as Record<string, unknown>)?.label ?? "") }))
    : [];
  return {
    id: "omp_ui",
    header: title,
    prompt: message || title,
    options,
    multiple: false,
    // A free-text dialog has no closed option set, so "other" IS the answer.
    allow_other: method === "input" || options.length === 0,
    secret: false,
  };
}

/** Pull the last assistant turn's text out of an `agent_end.messages` array. */
export function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    const info = classifyOmpContent(record.content);
    if (info.hasText) return info.text;
  }
  return "";
}

function stringField(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}
