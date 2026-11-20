import type { AppAgentActivity } from "@claude-bot/dashboard-web/contract";
import type { AppAgentActivityScope } from "./activity.js";
/**
 * The App agent plane: one pump, in the trusted bot process.
 *
 * ── Where the pieces live, and why they live there ─────────────────────────
 *
 *   declaration → `app.yaml` (a release asset, covered by `packageDigest`)
 *   execution   → HERE, the trusted process
 *   messages    → the App's own State stream (`sys_agent_inbox`)
 *   cursor+log  → `bot.db` (v29)
 *   the LLM     → HERE, over `session/llm-fetch.ts`
 *
 * The last one is the load-bearing decision. The App Runtime child is where App
 * code runs, and it is deliberately the process with no network, no secrets, a
 * 25s RPC budget and a SES Compartment in which `fetch` is not a name that
 * exists. A turn of tool-calling inference is minutes long and needs an API
 * key, so putting it there would mean widening all three of those at once, for
 * nothing: the tools have to come back through this process's dispatch door
 * anyway. So the credential stays in the process that already holds the SQLite
 * lease and the kernel, and the Runtime child is not touched at all.
 *
 * ── The four rules a turn obeys ────────────────────────────────────────────
 *
 *  1. **SEC-06 first, and with the engine's predicate.** `appAgentAdapterVerdict`
 *     is imported, never restated. A refusal does NOT consume the inbox and
 *     does NOT silently fall back to another adapter — swapping the adapter
 *     swaps the cost, the behaviour and the output, with nobody informed.
 *  2. **Consume at start.** The cursor advances in the same transaction that
 *     opens the turn, before the model is called. A failed turn does not replay:
 *     its tool calls already had effects, and a deterministically failing turn
 *     would otherwise retry for ever. The transcript says so in words.
 *  3. **One door.** Every tool call goes through `handle.dispatch`, which is
 *     `SessionPlusAppService.dispatch` — the same function a button reaches,
 *     with an actor of `agent` instead of `user`. There is no second validator
 *     and no second permission check, because a second one is a second answer.
 *  4. **`approval_required` is an ending, not an error.** The turn collapses,
 *     the decision arrives later as a new inbox message, and the next turn picks
 *     it up. Blocking would hold a turn open for a human-scale delay; polling
 *     would mint one approval card per attempt.
 *
 * ── What this file cannot do ───────────────────────────────────────────────
 *
 * It cannot enumerate accounts (the `daily` population is exactly the set of
 * cursor rows — accounts that have used an agent at least once), it cannot name
 * a device or a Context, and it cannot write an event: an inbox append is the
 * only State write it makes, and App code is refused the `sys_` prefix at the
 * coordinator so it cannot queue work for its own agent.
 */

import { ManagedDependencyUnavailable } from "@claude-bot/runner/managed-execution";
import { registerManagedAgentLoop, type ManagedLoopAdapter } from "../managed-execution/agent-loops.js";
import type { ManagedExecutionSupervisor } from "../managed-execution/supervisor.js";
import type { ManagedExecutionRow } from "../store/repositories/managed-executions.js";
import { randomUUID } from "node:crypto";
import { recordConvergenceUsage } from "@claude-bot/convergence-gates";
import { appAgentAdapterVerdict } from "@claude-bot/engine";
import { createLogger } from "../logger.js";
import type { AppAgentKey, AppAgentTurnTrigger, Store } from "../store/store.js";
import { AgentLoop, TOOL_CAP_NOTE, type LoopMessage, type LoopToolResult } from "./loop.js";
import type { AppAgentBackend, AppAgentDeclaration, AppAgentScope, AppAgentTurnHandle } from "./types.js";
import type { AgentCompletionSink } from "../agent-completion/relay.js";

const log = createLogger("app-agents");

/** Transcript rows written outside any turn (a refusal, a recovery note). */
const NO_TURN = "-";

/** Built-in tools, named so an App action cannot silently shadow one. */
export const BUILTIN_TOOLS = Object.freeze({ readState: "read_app_state", askUser: "ask_user" });

export const ASK_USER_RECEIPT =
  "已经把这句话交给用户了；他们的回应会作为一条新消息到达，本轮请就此收束。";

export const APPROVAL_RECEIPT =
  "这一步需要用户先批准。批准结果会作为一条新消息回到你这里，本轮请就此收束——不要重试，重试只会再排一张批准卡。";

/** Whether a dispatch result says a person still has to decide. */
function waitsForApproval(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  return String((result as Record<string, unknown>).status ?? "") === "waiting_approval";
}

export interface AppAgentPlaneOptions {
  store: Store;
  supervisor?: ManagedExecutionSupervisor;
  backends: readonly AppAgentBackend[];
  loop: AgentLoop;
  defaultModel?: string;
  defaultEffort?: string;
  maxToolTurns?: number;
  /** Whole-turn budget including tool calls. Default 10 minutes. */
  turnTimeoutMs?: number;
  maxConcurrentTurns?: number;
  turnsPerAccountPerDay?: number;
  transcriptTail?: number;
  now?: () => number;
  /** Private bot-channel completion handoff; App transcript stays canonical. */
  onCompletion?: AgentCompletionSink;
}

export interface AppAgentTurnReport {
  turnId: string | null;
  status: "running" | "succeeded" | "failed" | "unknown" | "suspended" | "skipped";
  reason?: string;
}

export class AppAgentPlane {
  private readonly backends = new Map<string, AppAgentBackend>();
  private readonly running = new Set<string>();
  /** Keys whose inbox changed while a turn was in flight. */
  private readonly recheck = new Set<string>();
  private readonly now: () => number;
  private stopped = false;
  private backendsReady = false;
  private readonly detachManaged?: () => void;
  private readonly waitingNotes = new Set<string>();
  private pumping: Promise<void> | null = null;

  constructor(private readonly o: AppAgentPlaneOptions) {
    this.now = o.now ?? Date.now;
    for (const backend of o.backends) this.registerBackend(backend);
    if (o.supervisor) this.detachManaged = registerManagedAgentLoop(o.supervisor, "app-agent", {
      maxConcurrent: o.maxConcurrentTurns ?? 2,
      authorized: row => {
        const turn = o.store.getAppAgentTurn(row.reference);
        if (!turn || turn.owner !== row.owner || !o.loop.configured) return false;
        const backend = this.backends.get(turn.app_id);
        if (!backend) return !this.backendsReady;
        const declaration = this.declarationOf(backend, turn.agent);
        return Boolean(declaration && appAgentAdapterVerdict(declaration.adapter).ok);
      },
      open: row => this.openManaged(row),
      settled: (row, result) => this.settleManaged(row, result),
      changed: row => {
        const turn = o.store.getAppAgentTurn(row.reference);
        if (!turn || turn.status !== "running") return;
        if (row.desired === "cancelled") this.settleManaged(row, { error: "已停止自动恢复；此前已经执行的动作仍会保留。" });
        else if (row.failure === "authorization_revoked") this.settleManaged(row, { error: row.detail });
        else if (row.observed === "waiting_resource" && !this.waitingNotes.has(row.id)) {
          this.waitingNotes.add(row.id);
          o.store.addAppAgentMessage({ appId: turn.app_id, scopeKey: turn.scope_key, agent: turn.agent },
            turn.id, "note", "连接暂不可用，已等待一分钟。任务仍被托管，连接恢复后会自动继续。");
        }
      },
    });
  }

  /** Local bounded projection; the caller must validate a live browser App scope. */
  readActivity(input: AppAgentActivityScope): AppAgentActivity[] {
    const backend = this.backends.get(input.appId);
    if (!backend) return [];
    const scope = scopeOf(input.owner, input.instanceKey);
    return backend.agents().slice(0, 16).flatMap(agent => {
      const key = this.keyOf(backend, scope, agent.name);
      const messages = this.o.store.listAppAgentMessages(key, 120);
      return this.o.store.listAppAgentTurns(key, 2).filter(turn => turn.owner === input.owner).map(turn => {
        const managed = this.o.supervisor?.get(input.owner, `app:${turn.id}`);
        const state: AppAgentActivity["state"] = managed?.desired === "cancelled" ? "stopped"
          : turn.status === "succeeded" ? managed?.observed === "waiting_approval" ? "waiting_approval" : "ended"
          : turn.status !== "running" ? turn.status
          : managed?.observed === "waiting_resource" ? "waiting_resource"
          : managed?.observed === "reconnecting" ? "reconnecting" : "running";
        const reply = messages.filter(message => message.turn_id === turn.id && message.role === "assistant").at(-1)?.content;
        return { id: turn.id, agent: agent.name, state, updatedAt: managed?.updatedAt ?? turn.updated_at,
          reply: reply?.slice(0, 4_000) ?? null,
          canStop: turn.status === "running" && managed?.desired === "running" };
      });
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12);
  }

  stopActivity(input: AppAgentActivityScope, turnId: string): boolean {
    const backend = this.backends.get(input.appId);
    const turn = this.o.store.getAppAgentTurn(turnId);
    if (!backend || !turn || turn.owner !== input.owner || turn.app_id !== input.appId
      || turn.scope_key !== backend.scopeKey(scopeOf(input.owner, input.instanceKey))) return false;
    const managed = this.o.supervisor?.get(input.owner, `app:${turn.id}`);
    if (!managed || managed.source !== "app-agent") return false;
    if (managed.desired === "cancelled") return true;
    if (turn.status !== "running") return false;
    return this.o.supervisor!.setDesired(input.owner, managed.id, "cancelled");
  }

  /** Add one trusted App adapter after its data-driven composition exists. */
  registerBackend(backend: AppAgentBackend): void {
    if (this.backends.has(backend.appId)) {
      throw new Error(`duplicate App agent backend ${backend.appId}`);
    }
    this.backends.set(backend.appId, backend);
    if (!this.stopped) void this.pump();
  }

  /**
   * Settle what a previous process left in flight, once, before anything runs.
   *
   * Nothing is re-dispatched: a turn that was `running` when the process died
   * may have made tool calls whose effects exist, and neither claiming success
   * nor repeating them is honest. `unknown` is the terminal answer, and the
   * transcript carries a note so a person reading it is not left guessing.
   */
  recover(): number {
    if (this.o.supervisor) {
      const turns = this.o.store.listRunningAppAgentTurns();
      for (const turn of turns) {
        const row = this.o.supervisor.get(turn.owner, `app:${turn.id}`);
        if (row && ["preparing", "running", "reconnecting", "waiting_resource"].includes(row.observed)) {
          this.running.add(`${turn.app_id}\0${turn.scope_key}\0${turn.agent}`);
        } else {
          // A pre-journal turn may have already performed effects on an older
          // runtime. Missing evidence never grants permission to replay it.
          this.o.store.finishAppAgentTurn(turn.id, "unknown", "缺少可恢复的执行检查点");
          this.o.store.addAppAgentMessage({ appId: turn.app_id, scopeKey: turn.scope_key, agent: turn.agent },
            turn.id, "error", "重启前的执行结果无法确认，已停止自动恢复，请核对原动作结果。");
          this.turnReport(turn.owner, turn.id, "unknown", "missing_checkpoint");
        }
      }
      this.o.supervisor.kick();
      return turns.length;
    }
    const ids = this.o.store.recoverAppAgentTurns(
      "bot 重启打断了这一轮。已经发出去的动作不会被撤销，也不会重放——要确认结果请看下面的记录。",
    );
    for (const id of ids) {
      const turn = this.o.store.getAppAgentTurn(id);
      if (!turn) continue;
      this.o.store.addAppAgentMessage(
        { appId: turn.app_id, scopeKey: turn.scope_key, agent: turn.agent },
        id,
        "error",
        "本轮在 bot 重启时中断，结局无法证明（unknown）。这批消息不会重投，需要就再说一句。",
      );
      this.turnReport(turn.owner, id, "unknown", "process_restart");
    }
    return ids.length;
  }

  /**
   * Deliver one message from a person to their own agent, then pump.
   *
   * Only the scope owner may talk to their own agent. Writing on somebody
   * else's behalf would put their name on words they did not say, which is the
   * same ruling the workbench and the secretary already follow.
   */
  async deliver(input: {
    appId: string;
    owner: string;
    instanceKey?: string;
    agent: string;
    text: string;
    dispatchId?: string;
  }): Promise<{ ok: true; duplicate: boolean } | { ok: false; message: string }> {
    const backend = this.backends.get(input.appId);
    if (!backend) return { ok: false, message: "这个 App 没有 agent 平面" };
    if (!this.declarationOf(backend, input.agent)) {
      return { ok: false, message: "当前 release 没有声明这个 agent" };
    }
    const scope = scopeOf(input.owner, input.instanceKey);
    const appended = await backend.appendInbox({
      scope,
      agent: input.agent,
      text: input.text,
      from: `user:${input.owner}`,
      dispatchId: input.dispatchId,
    });
    if (!appended.ok) return appended;
    // The cursor row is what puts this account into the `daily` population,
    // and it is created HERE rather than by an account sweep: the plane has no
    // account enumerator, by design.
    this.o.store.ensureAppAgentCursor(this.keyOf(backend, scope, input.agent));
    void this.pump();
    return { ok: true, duplicate: appended.duplicate };
  }

  /**
   * Run one turn for one agent, now, whatever the inbox looks like.
   *
   * A scheduled trigger that has no manual equivalent is a trigger nobody has
   * ever seen work — the engine's own `fireDaily` comment says exactly this.
   */
  async trigger(input: {
    appId: string;
    owner: string;
    instanceKey?: string;
    agent: string;
    prompt?: string;
    trigger?: AppAgentTurnTrigger;
  }): Promise<AppAgentTurnReport> {
    const backend = this.backends.get(input.appId);
    if (!backend) return this.turnReport(input.owner, null, "skipped", "no_backend");
    const declaration = this.declarationOf(backend, input.agent);
    if (!declaration) return this.turnReport(input.owner, null, "skipped", "not_declared");
    const scope = scopeOf(input.owner, input.instanceKey);
    const trigger = input.trigger ?? "manual";
    if (input.prompt) {
      const appended = await backend.appendInbox({
        scope,
        agent: input.agent,
        text: input.prompt,
        from: trigger === "daily" ? "system:daily" : `system:${trigger}`,
      });
      if (!appended.ok) {
        return this.turnReport(input.owner, null, "skipped", appended.message, "append_refused");
      }
    }
    this.o.store.ensureAppAgentCursor(this.keyOf(backend, scope, input.agent));
    return await this.runOnce(backend, declaration, scope, trigger);
  }

  /**
   * Every (app, scope, agent) with unread inbox gets a turn, subject to the
   * global concurrency ceiling. Serialised per key: a second message that
   * arrives during a turn sets `recheck` instead of starting a twin.
   */
  pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    const work = this.drain().finally(() => {
      this.pumping = null;
    });
    this.pumping = work;
    return work;
  }

  completeBackendRegistration(): void {
    this.backendsReady = true;
    this.o.supervisor?.kick();
  }

  stop(): void {
    this.stopped = true;
    this.detachManaged?.();
  }

  /** Diagnostics/inventory: which adapters this plane could actually run. */
  adapters(): string[] {
    const kinds = new Set<string>();
    for (const backend of this.backends.values()) {
      for (const agent of backend.agents()) kinds.add(agent.adapter);
    }
    return [...kinds].sort();
  }

  private async drain(): Promise<void> {
    for (let sweep = 0; sweep < 8 && !this.stopped; sweep++) {
      let started = 0;
      for (const backend of this.backends.values()) {
        const declared = new Map(backend.agents().map((agent) => [agent.name, agent]));
        if (!declared.size) continue;
        for (const cursor of this.o.store.listAppAgentCursors(backend.appId)) {
          const declaration = declared.get(cursor.agent);
          if (!declaration) continue;
          const scope = backend.scopeFromKey(cursor.scope_key);
          if (!scope) continue;
          const key = `${backend.appId}\0${cursor.scope_key}\0${cursor.agent}`;
          if (this.running.has(key)) {
            this.recheck.add(key);
            continue;
          }
          if (!this.o.supervisor && this.running.size >= (this.o.maxConcurrentTurns ?? 2)) break;
          let pending;
          try {
            pending = await backend.readInbox(scope, cursor.agent, cursor.upto_seq);
          } catch (error) {
            log.warn({ err: error, app: backend.appId, agent: cursor.agent }, "could not read App agent inbox");
            continue;
          }
          if (!pending.messages.length) continue;
          started += 1;
          await this.runOnce(backend, declaration, scope, "inbox");
        }
      }
      if (!started) return;
    }
  }

  private async runOnce(
    backend: AppAgentBackend,
    declaration: AppAgentDeclaration,
    scope: AppAgentScope,
    trigger: AppAgentTurnTrigger,
  ): Promise<AppAgentTurnReport> {
    const owner = scope.owner;
    const key = this.keyOf(backend, scope, declaration.name);
    const lock = `${key.appId}\0${key.scopeKey}\0${key.agent}`;
    if (this.running.has(lock)) {
      this.recheck.add(lock);
      return this.turnReport(owner, null, "skipped", "already_running");
    }

    // Gate one: SEC-06, before anything is consumed. A release that was
    // installed under `local-owner` and is still active after the profile
    // tightened must fail closed here, not run on a substituted adapter.
    const verdict = appAgentAdapterVerdict(declaration.adapter);
    if (!verdict.ok) {
      this.o.store.addAppAgentMessage(key, NO_TURN, "error", `⛔ ${verdict.reason}`);
      return this.turnReport(owner, null, "skipped", verdict.code);
    }
    if (!this.o.loop.configured) {
      this.o.store.addAppAgentMessage(key, NO_TURN, "error", "本部署没有配置可用的模型端点，agent 无法运行。");
      return this.turnReport(owner, null, "skipped", "llm_unconfigured");
    }
    const budget = this.o.turnsPerAccountPerDay ?? 60;
    if (this.turnsToday(key) >= budget) {
      this.o.store.addAppAgentMessage(
        key,
        NO_TURN,
        "error",
        `今天这个 agent 已经跑满 ${budget} 轮（部署预算）。明天会自动恢复，或者请运维调高 app_agents.turns_per_account_per_day。`,
      );
      return this.turnReport(owner, null, "skipped", "daily_budget");
    }

    const cursor = this.o.store.ensureAppAgentCursor(key);
    let pending;
    try {
      pending = await backend.readInbox(scope, declaration.name, cursor.upto_seq);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.o.store.addAppAgentMessage(key, NO_TURN, "error", `⛔ ${message.slice(0, 500)}`);
      return this.turnReport(owner, null, "skipped", "scope_unavailable");
    }
    if (!pending.messages.length) return this.turnReport(owner, null, "skipped", "empty_inbox");
    const uptoSeq = pending.messages[pending.messages.length - 1]!.seq;
    const turnId = `agt_${randomUUID()}`;
    // Gate two: consume-at-start, atomically with opening the turn.
    const turn = this.o.store.claimAppAgentInbox({
      key,
      owner,
      turnId,
      trigger,
      fromSeq: cursor.upto_seq,
      uptoSeq,
    });
    if (!turn) return this.turnReport(owner, null, "skipped", "cursor_moved");

    this.running.add(lock);
    for (const message of pending.messages) {
      this.o.store.addAppAgentMessage(key, turnId, "user", `${message.from}: ${message.text}`.slice(0, 8_000));
    }

    if (this.o.supervisor) {
      this.o.supervisor.submit({ id: `app:${turnId}`, reference: turnId, owner, source: "app-agent",
        resumeOwner: "head", desired: "running", observed: "preparing", dispatch: "not_sent",
        checkpoint: { messages: this.historyFor(key, turnId, pending.messages.map(message => message.text)) } });
      return { turnId, status: "running" };
    }

    let handle: AppAgentTurnHandle | null = null;
    let toolCalls = 0;
    try {
      const turnHandle = await backend.openTurn({ scope, agent: declaration.name, turnId });
      handle = turnHandle;
      const controller = new AbortController();
      const timeoutMs = this.o.turnTimeoutMs ?? 10 * 60_000;
      const timer = setTimeout(() => controller.abort(new Error("App agent turn timed out")), timeoutMs);
      timer.unref?.();
      const abortFromHandle = () => controller.abort(turnHandle.signal.reason ?? new Error("App agent authority ended"));
      if (turnHandle.signal.aborted) abortFromHandle();
      else turnHandle.signal.addEventListener("abort", abortFromHandle, { once: true });
      const tools = this.toolsFor(backend, scope, declaration.name);
      let outcome;
      try {
        outcome = await this.o.loop.run({
          systemPrompt: systemPromptOf(declaration, owner, backend.appId, scope.kind),
          messages: this.historyFor(key, turnId, pending.messages.map((m) => m.text)),
          tools,
          model: declaration.model ?? this.o.defaultModel ?? "gpt-5.6-sol",
          effort: declaration.effort ?? this.o.defaultEffort,
          maxToolTurns: this.o.maxToolTurns,
          signal: controller.signal,
          callTool: (name, args) => this.callTool(key, turnId, turnHandle, name, args),
          onAssistant: (text) => {
            this.o.store.addAppAgentMessage(key, turnId, "assistant", text.slice(0, 20_000));
          },
          onToolCall: () => {
            toolCalls += 1;
          },
        });
      } finally {
        clearTimeout(timer);
        turnHandle.signal.removeEventListener("abort", abortFromHandle);
      }
      if (outcome.kind === "tool_cap") {
        this.o.store.addAppAgentMessage(key, turnId, "note", TOOL_CAP_NOTE);
      }
      if (outcome.kind === "suspended") {
        this.o.store.finishAppAgentTurn(turnId, "succeeded", `suspended: ${outcome.reason}`.slice(0, 500), toolCalls);
        return this.turnReport(owner, turnId, "suspended", outcome.reason, "suspended");
      }
      this.o.store.finishAppAgentTurn(turnId, "succeeded", null, toolCalls);
      return this.turnReport(owner, turnId, "succeeded");
    } catch (error) {
      const message = handle?.signal.aborted
        ? "App、共享实例或成员权限已撤销，本轮已停止"
        : error instanceof Error ? error.message : String(error);
      log.warn({ err: error, app: key.appId, agent: key.agent }, "app agent turn failed");
      this.o.store.addAppAgentMessage(
        key,
        turnId,
        "error",
        `本轮失败：${message.slice(0, 500)}。这批消息不会重投，需要就再说一句。`,
      );
      this.o.store.finishAppAgentTurn(turnId, "failed", message.slice(0, 500), toolCalls);
      return this.turnReport(owner, turnId, "failed", message, "turn_failed");
    } finally {
      await handle?.close().catch(() => undefined);
      this.o.store.pruneAppAgentMessages(key);
      this.running.delete(lock);
      if (this.recheck.delete(lock) && !this.stopped) void this.pump();
    }
  }

  private async openManaged(row: ManagedExecutionRow): ReturnType<ManagedLoopAdapter["open"]> {
    const turn = this.o.store.getAppAgentTurn(row.reference);
    if (!turn || turn.status !== "running") return null;
    const backend = this.backends.get(turn.app_id);
    if (!backend) throw new ManagedDependencyUnavailable("App 正在初始化，等待运行时就绪");
    const declaration = this.declarationOf(backend, turn.agent);
    const scope = backend.scopeFromKey(turn.scope_key);
    if (!declaration || !scope || scope.owner !== row.owner) throw new Error("App agent 范围已失效");
    const key = { appId: turn.app_id, scopeKey: turn.scope_key, agent: turn.agent };
    const handle = await backend.openTurn({ scope, agent: turn.agent, turnId: turn.id });
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("App agent turn timed out")), this.o.turnTimeoutMs ?? 10 * 60_000);
    timer.unref?.();
    const checkpoint = row.checkpoint as { messages?: LoopMessage[] } | undefined;
    return { loop: this.o.loop, request: {
      systemPrompt: systemPromptOf(declaration, row.owner, turn.app_id, scope.kind),
      messages: checkpoint?.messages ?? [], tools: this.toolsFor(backend, scope, turn.agent),
      model: declaration.model ?? this.o.defaultModel ?? "gpt-5.6-sol", effort: declaration.effort ?? this.o.defaultEffort,
      maxToolTurns: this.o.maxToolTurns, signal: AbortSignal.any([handle.signal, timeout.signal]),
      callTool: (name, args) => this.callTool(key, turn.id, handle, name, args),
      onAssistant: text => { this.o.store.addAppAgentMessage(key, turn.id, "assistant", text.slice(0, 20_000)); },
    }, close: async () => { clearTimeout(timer); await handle.close(); } };
  }

  private settleManaged(row: ManagedExecutionRow, result: Parameters<ManagedLoopAdapter["settled"]>[1]): void {
    const turn = this.o.store.getAppAgentTurn(row.reference);
    if (!turn || turn.status !== "running") return;
    const key = { appId: turn.app_id, scopeKey: turn.scope_key, agent: turn.agent };
    const status = result.unknown ? "unknown" : result.error ? "failed" : "succeeded";
    if (result.error) this.o.store.addAppAgentMessage(key, turn.id, "error", result.error.slice(0, 600));
    else if (result.outcome?.kind === "tool_cap") this.o.store.addAppAgentMessage(key, turn.id, "note", TOOL_CAP_NOTE);
    const loop = (row.checkpoint as { loop?: { toolCalls?: number } } | undefined)?.loop;
    this.o.store.finishAppAgentTurn(turn.id, status, result.error ?? null, loop?.toolCalls ?? 0);
    this.turnReport(row.owner, turn.id, result.outcome?.kind === "suspended" ? "suspended" : status,
      result.outcome?.kind === "suspended" ? result.outcome.reason : result.error);
    this.o.store.pruneAppAgentMessages(key);
    const lock = `${key.appId}\0${key.scopeKey}\0${key.agent}`;
    this.running.delete(lock);
    this.recheck.delete(lock);
    this.waitingNotes.delete(row.id);
    if (!this.stopped) void this.pump();
  }

  private turnReport(
    owner: string,
    turnId: string | null,
    status: AppAgentTurnReport["status"],
    reportReason?: string,
    metricReason = reportReason,
  ): AppAgentTurnReport {
    recordConvergenceUsage({
      candidate: "app-agent-effects",
      principal: owner,
      entry: "app-agent.turn",
      provider: "octopus-app-agent",
      effect: "execute",
      outcome: status === "succeeded" ? "ok" : status === "failed" ? "failed" : status === "unknown" ? "unknown" : "refused",
      ...(metricReason && /^[a-z][a-z0-9_.:-]{0,95}$/.test(metricReason) ? { reason: metricReason } : {}),
    });
    if (turnId && status !== "skipped" && status !== "running") {
      const turn = this.o.store.getAppAgentTurn(turnId);
      if (turn) {
        this.o.onCompletion?.({
          runId: turnId,
          owner,
          surface: "app",
          label: `App ${turn.app_id} · ${turn.agent}`,
          status,
        });
      }
    }
    return { turnId, status, ...(reportReason ? { reason: reportReason } : {}) };
  }

  /**
   * One tool call.
   *
   * Built-ins are answered here and never reach the door — `read_app_state`
   * returns the projection this instance already opened with, and `ask_user`
   * writes a transcript line and ends the turn. Everything else is a declared
   * action, and it goes through exactly the dispatch a button goes through.
   */
  private async callTool(
    key: AppAgentKey,
    turnId: string,
    handle: AppAgentTurnHandle,
    name: string,
    args: Record<string, unknown>,
  ): Promise<LoopToolResult> {
    if (name === BUILTIN_TOOLS.readState) {
      return { text: JSON.stringify(handle.projection ?? null).slice(0, 16_000) };
    }
    if (name === BUILTIN_TOOLS.askUser) {
      const question = String(args.question ?? args.text ?? "").slice(0, 2_000).trim();
      if (!question) return { text: "ask_user 需要一个非空的 question。", isError: true };
      this.o.store.addAppAgentMessage(key, turnId, "note", `🙋 ${question}`);
      return { text: ASK_USER_RECEIPT, closesTurn: true };
    }
    const answer = await handle.dispatch(name, args);
    if (answer.ok) {
      this.o.store.addAppAgentMessage(key, turnId, "tool", summarise(args), name);
      const text = JSON.stringify(answer.result ?? null).slice(0, 16_000);
      // A submitted operation that is waiting for a person is a NORMAL ending,
      // not a failure and not something to poll. The decision arrives later as
      // a new inbox message, which starts the next turn — the event-driven
      // answer to a problem durable execution would have tried to solve by
      // replaying a call that is not idempotent.
      return waitsForApproval(answer.result)
        ? { text: `${text}\n${APPROVAL_RECEIPT}`, closesTurn: true }
        : { text };
    }
    this.o.store.addAppAgentMessage(key, turnId, "tool", `${summarise(args)} — ${answer.message}`.slice(0, 1_000), name);
    if (answer.code === "approval_required") {
      return { text: `${answer.message}\n${APPROVAL_RECEIPT}`, closesTurn: true };
    }
    return { text: `${answer.code}: ${answer.message}`, isError: true };
  }

  private toolsFor(backend: AppAgentBackend, scope: AppAgentScope, agent: string) {
    const declared = backend.tools(scope, agent);
    const names = new Set(declared.map((tool) => tool.name));
    const builtins = [
      {
        name: BUILTIN_TOOLS.readState,
        description: "读取本 App 当前的投影（只读，不产生任何副作用）。",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
      {
        name: BUILTIN_TOOLS.askUser,
        description: "把一个问题交给用户并结束本轮。用户的回应会作为一条新消息到达。",
        parameters: {
          type: "object",
          properties: { question: { type: "string", maxLength: 2000 } },
          required: ["question"],
          additionalProperties: false,
        },
      },
    ].filter((tool) => !names.has(tool.name));
    return [...declared, ...builtins];
  }

  /**
   * The messages this turn starts from.
   *
   * Prior tool rows collapse into an assistant note rather than being replayed
   * as `tool` messages: their `tool_call_id`s belong to a conversation that no
   * longer exists, and an unmatched `tool` role is a malformed request. Same
   * treatment `hq/chat.ts` gives its own history.
   */
  private historyFor(key: AppAgentKey, turnId: string, fresh: readonly string[]): LoopMessage[] {
    const rows = this.o.store.listAppAgentMessages(key, this.o.transcriptTail ?? 60);
    const out: LoopMessage[] = [];
    for (const row of rows) {
      if (row.turn_id === turnId) continue; // this turn's own input, added below
      if (row.role === "user") out.push({ role: "user", content: row.content });
      else if (row.role === "assistant") out.push({ role: "assistant", content: row.content });
      else if (row.role === "tool") out.push({ role: "assistant", content: `（上一轮我调用了 ${row.tool_name ?? "工具"}：${row.content}）` });
      else if (row.role === "note") out.push({ role: "assistant", content: `（注记）${row.content}` });
    }
    for (const text of fresh) out.push({ role: "user", content: text });
    return out;
  }

  private turnsToday(key: AppAgentKey): number {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    return this.o.store.listAppAgentTurns(key, 200).filter((row) => row.started_at.startsWith(today)).length;
  }

  private declarationOf(backend: AppAgentBackend, agent: string): AppAgentDeclaration | null {
    return backend.agents().find((row) => row.name === agent) ?? null;
  }

  private keyOf(backend: AppAgentBackend, scope: AppAgentScope, agent: string): AppAgentKey {
    return { appId: backend.appId, scopeKey: backend.scopeKey(scope), agent };
  }
}

/**
 * The system prompt.
 *
 * The publisher's text, plus one paragraph this process writes and the release
 * cannot: who the agent is acting for, and that a refusal is an answer rather
 * than something to work around. `{{user}}` is the one substitution, matching
 * the engine's own convention.
 */
export function systemPromptOf(
  declaration: AppAgentDeclaration,
  owner: string,
  appId: string,
  scopeKind: AppAgentScope["kind"] = "account",
): string {
  return [
    declaration.prompt.replaceAll("{{user}}", owner),
    "",
    scopeKind === "shared"
      ? `你是 App「${appId}」里名为「${declaration.name}」的 agent，以角色「${declaration.role ?? "未声明"}」参与共享实例；本轮由成员 ${owner} 触发。`
      : `你是 App「${appId}」里名为「${declaration.name}」的 agent，代表用户 ${owner} 工作。`,
    "你只能调用工具列表里的动作；被拒绝的调用就是一个答案，不要换个说法重试同一个动作。",
    "需要用户批准的调用会明确说明，那时请结束本轮，批准结果会作为新消息回到你这里。",
  ].join("\n");
}

function scopeOf(owner: string, instanceKey?: string): AppAgentScope {
  return instanceKey
    ? { kind: "shared", owner, instanceKey }
    : { kind: "account", owner };
}

/** A short, bounded record of what a tool call asked for. Never the result. */
function summarise(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (parts.length >= 4) break;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    parts.push(`${key}=${String(value).slice(0, 60)}`);
  }
  return parts.length ? parts.join(" · ") : "(无参数)";
}
