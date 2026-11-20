/** Send to an existing native daemon, or queue for a legacy CLI, without loading another writer. */
import { sessionInputStage } from "./session-input-perf.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AgentInteractionBroker } from "./agent-interactions.js";
import { agentCommand, withAgentExecutable } from "./agent-executables.js";
import { CodexJsonRpcClient } from "./codex-app-server.js";
import { trackCodexProcess } from "./codex-owned-process.js";

export interface CodexQueueOptions {
  sessionId: string;
  prompt: string;
  codexHome: string;
  cwd: string;
  timeoutMs?: number;
  /** Revalidate the original process after asynchronous setup, before any input. */
  beforeSubmit: () => Promise<void>;
  /** Test seam: an isolated protocol fixture, never a discovered agent process. */
  child?: ChildProcessWithoutNullStreams;
  /** Already initialized native daemon connection, owned by the caller. */
  client?: CodexJsonRpcClient;
}
export type CodexQueueSubmission =
  | { sessionId: string; queuedSubmissionId: string; turnId?: undefined; controlAction?: undefined }
  | { sessionId: string; turnId: string; controlAction: "protocol_send" | "protocol_steer"; queuedSubmissionId?: undefined };
export class CodexQueueError extends Error {
  constructor(message: string, readonly code = "codex_queue_unavailable", readonly safeFallback = false) { super(message); }
}

// Codex initializes its account-local SQLite state even for an observer. Avoid
// concurrent helper startup in one home; different accounts remain independent.
const homes = new Map<string, Promise<void>>();
export async function queueCodexPrompt(options: CodexQueueOptions): Promise<CodexQueueSubmission> {
  if (!path.isAbsolute(options.codexHome)
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.sessionId)) {
    throw new CodexQueueError("原生 queue 需要已核实的 CODEX_HOME 和完整 thread UUID");
  }
  const key = path.resolve(options.codexHome);
  const previous = homes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  homes.set(key, current);
  await sessionInputStage("queue_home_wait", () => previous);
  try {
    return await (options.client ? submit(options) : withAgentExecutable("codex", () => submit(options)));
  } catch (error) {
    if (error instanceof CodexQueueError) throw error;
    throw new CodexQueueError(error instanceof Error ? error.message : String(error));
  } finally {
    release();
    if (homes.get(key) === current) homes.delete(key);
  }
}

async function submit(options: CodexQueueOptions): Promise<CodexQueueSubmission> {
  let client = options.client;
  if (!client) {
    const group = !options.child && process.platform !== "win32";
    const command = options.child ? undefined : agentCommand("codex", ["app-server"], {
      ...process.env, CODEX_HOME: options.codexHome,
    });
    const child = options.child ?? spawn(command!.bin, command!.args, {
      cwd: options.cwd, env: command!.env, stdio: ["pipe", "pipe", "pipe"], detached: group,
    });
    if (!options.child) trackCodexProcess(child, group);
    client = new CodexJsonRpcClient(child, options.sessionId, new AgentInteractionBroker(), undefined, group);
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const request = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    sessionInputStage(`queue_rpc:${method}`, () => client!.request(method, params, Math.max(1, deadline - Date.now())));
  let transferred = false;
  try {
    if (!options.client) {
      await request("initialize", {
        clientInfo: { name: "octopus_queue", title: "Octopus Queue", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized", {});
    }
    if (options.client) {
      // This connection belongs to the proven, already-loaded TUI daemon.
      // queue/add is a future-turn queue, not steering at the next tool boundary.
      // Never load/resume a thread here: that would acquire another writer.
      const { thread } = await request("thread/read", { threadId: options.sessionId, includeTurns: false }) as {
        thread?: { id?: string; canAcceptDirectInput?: boolean; status?: { type?: string; activeFlags?: string[] } };
      };
      if (thread?.id !== options.sessionId || thread.canAcceptDirectInput !== true) {
        throw new CodexQueueError("目标 Codex 会话身份不匹配或不接受直接输入；尚未发送");
      }
      const status = thread.status;
      if (!status || !["active", "idle"].includes(status.type ?? "")
        || (status.type === "active" && (!Array.isArray(status.activeFlags)
          || status.activeFlags.some(flag => flag === "waitingOnApproval" || flag === "waitingOnUserInput")))) {
        throw new CodexQueueError("Codex 会话状态不明或正在等待决定；尚未发送", "session_needs_input");
      }
      let expectedTurnId: string | undefined;
      if (status.type === "active") {
        const page = await request("thread/turns/list", {
          threadId: options.sessionId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
        }) as { data?: Array<{ id?: string; status?: string }> };
        const turn = Array.isArray(page?.data) && page.data.length === 1 ? page.data[0] : undefined;
        if (!turn || turn.status !== "inProgress" || !validTurnId(turn.id)) {
          throw new CodexQueueError("Codex 当前轮次已变化，尚未发送；请重新发送", "turn_not_active");
        }
        expectedTurnId = turn.id;
      }
      await sessionInputStage("queue_revalidate", options.beforeSubmit);
      if (Date.now() >= deadline) throw new CodexQueueError("Codex 输入准备超时，尚未发送");
      transferred = true;
      const result = await request(expectedTurnId ? "turn/steer" : "turn/start", {
        threadId: options.sessionId, clientUserMessageId: randomUUID(),
        ...(expectedTurnId ? { expectedTurnId } : {}),
        input: [{ type: "text", text: options.prompt, text_elements: [] }],
      }) as { turnId?: unknown; turn?: { id?: unknown } } | null;
      const turnId = expectedTurnId ? result?.turnId : result?.turn?.id;
      if (!validTurnId(turnId) || (expectedTurnId && turnId !== expectedTurnId)) {
        throw new CodexQueueError("Codex 输入回执无效；是否接收未知，未重发", "unknown");
      }
      return { sessionId: options.sessionId, turnId,
        controlAction: expectedTurnId ? "protocol_steer" : "protocol_send" };
    }
    // Only this read-only feature probe can authorize legacy compatibility.
    // An initialize/thread-read error says nothing about queue availability.
    try {
      await request("thread/queue/list", { threadId: options.sessionId, limit: 1 });
    } catch (error) {
      const failure = error as Error & { rpcCode?: number };
      if (failure.rpcCode === -32601 || (failure.rpcCode === -32600
        && /unknown variant [`']thread\/queue\/list[`']/.test(failure.message))) {
        throw new CodexQueueError("当前 Codex 不支持 queue", "codex_queue_unsupported", true);
      }
      throw error;
    }
    const { thread } = await request("thread/read", {
      threadId: options.sessionId, includeTurns: false,
    }) as { thread?: { id?: string; canAcceptDirectInput?: boolean } };
    if (thread?.id !== options.sessionId) throw new CodexQueueError("Codex 返回了不同的 thread，尚未发送输入");
    if (thread.canAcceptDirectInput === false) {
      throw new CodexQueueError("此 Codex 子 agent 不接受外部输入，请通过父 agent 继续", "codex_subagent_thread");
    }
    await sessionInputStage("queue_revalidate", options.beforeSubmit);
    if (Date.now() >= deadline) throw new CodexQueueError("Codex queue 初始化超时，尚未发送输入");
    const clientUserMessageId = randomUUID();
    // This is correlation, NOT an idempotency key. Never retry queue/add.
    transferred = true;
    const result = await request("thread/queue/add", {
      threadId: options.sessionId, clientUserMessageId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
    }) as { queuedSubmission?: { id?: unknown; clientUserMessageId?: unknown } } | null;
    const row = result?.queuedSubmission;
    if (typeof row?.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(row.id)
      || row.clientUserMessageId !== clientUserMessageId) {
      throw new CodexQueueError("Codex queue 回执无效；输入是否入队未知，未重发", "unknown");
    }
    return { sessionId: options.sessionId, queuedSubmissionId: row.id };
  } catch (error) {
    if (error instanceof CodexQueueError) throw error;
    const failure = error as Error & { rpcCode?: number; code?: string };
    const unknown = transferred && failure.rpcCode === undefined;
    throw new CodexQueueError(unknown
      ? "Codex 输入回执丢失；是否接收未知，未重发，请核对原会话"
      : `Codex 未接受输入：${failure.message?.slice(0, 1_000) ?? "请求失败"}`,
    unknown ? "unknown" : failure.code ?? "codex_queue_unavailable");
  } finally {
    // Only our short-lived observer is closed. The original CLI owns execution.
    if (!options.client) await sessionInputStage("queue_close", () => client!.close()).catch(() => {});
  }
}

function validTurnId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}
