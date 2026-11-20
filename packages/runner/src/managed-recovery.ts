/**
 * Device-local recovery ledger for provider-native managed sessions.
 *
 * The original prompt is deliberately absent. A Runner restart may create one
 * new, auditable continuation turn, but it must never replay an effectful
 * prompt whose outcome is unknown. Split-placement bearer credentials are also
 * absent: the reconnected, authenticated Runner asks the Bot for a fresh
 * session-bound scope before it rebuilds that attachment.
 */

import { dependencyWait } from "./managed-execution.js";
import { CODEX_CAPACITY_DELAYS_MS, parseCapacityCheckpoint, type CodexCapacityCheckpoint } from "./codex-capacity-retry.js";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isAgentProvider,
  type AgentProvider,
} from "./agent-runtime.js";
import {
  AGENT_PERMISSION_PROFILES,
  type AgentPermissionProfile,
} from "./agent-permissions.js";
import {
  normalizeProviderSessionRef,
  snapshotProviderSessionRef,
  type ProviderSessionRef,
  type StoredProviderSessionRef,
} from "./provider-session-ref.js";

export const RUNNER_RECOVERY_PROMPT = "继续执行";

export interface ManagedRecoveryTask {
  taskId: string;
  toolUseId?: string;
  description?: string;
}

export interface ManagedRecoveryPlacement {
  /** Stable local site id; old records without it belong to the legacy primary. */
  gatewaySite?: string;
  executionDevice: string;
  workspaceId: string;
  /** Non-secret identity: recovery must receive this exact development scope. */
  developmentId?: string;
}

export interface ManagedRecoverySpec {
  provider: AgentProvider;
  session: ProviderSessionRef;
  cwd: string;
  codexHome?: string;
  model?: string;
  effort?: string;
  permissionProfile?: AgentPermissionProfile;
  remotePlacement?: ManagedRecoveryPlacement;
}

export type ManagedRecoveryStatus = "prepared" | "active" | "recovering" | "idle" | "unknown";

export interface ManagedRecoveryRecord extends ManagedRecoverySpec {
  version: 2;
  session: ProviderSessionRef;
  status: ManagedRecoveryStatus;
  turnId?: string;
  recoveryCount: number;
  updatedAt: string;
  detail?: string;
  backgroundTasks?: ManagedRecoveryTask[];
  /** Absent on old records: an ambiguous dispatch window, never retry it. */
  recoveryPhase?: "preparing" | "waiting_resource" | "dispatching";
  unavailableSince?: string;
  nextRetryAt?: string;
  capacityRetry?: CodexCapacityCheckpoint;
  capacityResult?: { ok: boolean; error?: string };
}

/**
 * A restart cannot resurrect Claude's child processes. Give the resumed parent
 * the last durable roster so it can reconcile outputs and selectively rebuild
 * unfinished work without replaying an effectful child prompt.
 */
export function managedRecoveryPrompt(record: ManagedRecoveryRecord): string {
  if (record.provider !== "claude" || !record.backgroundTasks?.length) {
    return RUNNER_RECOVERY_PROMPT;
  }
  const roster = record.backgroundTasks.map((task) => {
    const identity = task.toolUseId ? `${task.taskId} (tool ${task.toolUseId})` : task.taskId;
    return `- ${identity}${task.description ? `: ${task.description}` : ""}`;
  }).join("\n");
  return [
    "[Octopus 重启续接] Runner 已重启；重启前仍登记为运行中的 Claude subagent 如下：",
    roster,
    "旧 subagent 进程已经结束，这些 task id 只是恢复线索，不是仍存活的句柄。",
    "请先检查当前会话、工作目录和已有输出，判断哪些工作已经完成；只重新派发能够证明尚未完成的部分，不要重复未知或已完成的副作用。",
    "汇总恢复结果，然后继续完成主任务；不要只做阶段性状态汇报。",
  ].join("\n");
}

export interface ManagedRecoveryJournalOptions {
  stateFile: string;
  now?: () => Date;
}

interface PersistedTerminalSend {
  provider: AgentProvider;
  logicalId: string;
  promptHash: string;
  observedAt: string;
  sentAt: number;
}

/**
 * One process owns this object, but every mutation is still serialized and
 * atomically renamed: provider completion and a second session can arrive in
 * adjacent microtasks, and an older snapshot must never win that race.
 */
export class ManagedRecoveryJournal {
  private readonly records = new Map<string, ManagedRecoveryRecord>();
  private readonly sessions = new Map<string, StoredProviderSessionRef>();
  private readonly terminalSends = new Map<string, PersistedTerminalSend>();
  private readonly now: () => Date;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ManagedRecoveryJournalOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    this.records.clear();
    this.sessions.clear();
    this.terminalSends.clear();
    try {
      const raw = JSON.parse(await fs.readFile(this.options.stateFile, "utf8")) as {
        records?: unknown;
        sessions?: unknown;
        terminalSends?: unknown;
      };
      if (!Array.isArray(raw.records)) throw new Error("managed recovery records must be an array");
      for (const value of raw.records) {
        const record = recoveryRecord(value);
        this.records.set(keyOf(record.provider, record.session.logicalId), record);
        this.rememberSession(record.provider, record.session);
      }
      if (Array.isArray(raw.sessions)) {
        for (const value of raw.sessions.slice(-512)) {
          const stored = storedSession(value);
          this.rememberSession(stored.provider, stored);
        }
      }
      if (Array.isArray(raw.terminalSends)) {
        for (const value of raw.terminalSends.slice(-64)) {
          const send = terminalSend(value);
          if (send) this.terminalSends.set(terminalSendKey(send.provider, send.logicalId, send.promptHash), send);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // Corrupt recovery state is quarantined rather than guessed through. It
      // contains no prompt or bearer, so losing it fails closed without losing
      // user-authored content.
      const corrupt = `${this.options.stateFile}.corrupt-${Date.now()}`;
      await fs.rename(this.options.stateFile, corrupt).catch(() => {});
      this.records.clear();
      this.sessions.clear();
      this.terminalSends.clear();
    }
  }

  /** Persist recovery identity before prompt ownership crosses to a provider. */
  async prepare(spec: ManagedRecoverySpec, preserveCapacity = false): Promise<void> {
    const normalized = recoverySpec(spec);
    const key = keyOf(normalized.provider, normalized.session.logicalId);
    const prior = this.records.get(key);
    if (prior?.remotePlacement?.developmentId
      && normalized.remotePlacement?.developmentId !== prior.remotePlacement.developmentId) {
      throw new Error("开发会话恢复身份缺失或不一致；等待可信开发范围恢复");
    }
    this.rememberSession(normalized.provider, normalized.session);
    this.records.set(key, {
      version: 2,
      ...normalized,
      status: "prepared",
      recoveryCount: prior?.recoveryCount ?? 0,
      ...(preserveCapacity && prior?.capacityRetry ? { capacityRetry: prior.capacityRetry } : {}),
      updatedAt: this.now().toISOString(),
    });
    await this.persist();
  }

  /** The provider acknowledged dispatch; this turn is now restart-recoverable. */
  async activate(provider: AgentProvider, session: ProviderSessionRef, turnId: string): Promise<void> {
    const key = keyOf(provider, session.logicalId);
    const prior = this.records.get(key);
    if (!prior || prior.status !== "prepared") throw new Error("managed recovery was not prepared");
    const cleanTurnId = bounded(turnId, 256);
    if (!cleanTurnId) throw new Error("managed recovery turn id is invalid");
    this.records.set(key, {
      ...prior,
      status: "active",
      turnId: cleanTurnId,
      ...(prior.capacityRetry ? { capacityRetry: { ...prior.capacityRetry, phase: "active" as const, nextRetryAt: undefined } } : {}),
      updatedAt: this.now().toISOString(),
    });
    await this.persist();
  }

  /** CAS against the logical operation; Stop must never be undone by a timer. */
  async setCapacityRetry(provider: AgentProvider, session: ProviderSessionRef, turnId: string, checkpoint: CodexCapacityCheckpoint): Promise<boolean> {
    const key = keyOf(provider, session.logicalId);
    const current = this.records.get(key);
    if (provider !== "codex" || current?.status !== "active" || current.turnId !== turnId) return false;
    this.records.set(key, { ...current, capacityRetry: parseCapacityCheckpoint({ ...checkpoint,
      operationTurnId: current.capacityRetry?.operationTurnId ?? turnId }), updatedAt: this.now().toISOString() });
    await this.persist();
    return true;
  }

  /** Store only bounded task identity, never child prompts, outputs or credentials. */
  async setBackgroundTasks(
    provider: AgentProvider,
    session: ProviderSessionRef,
    tasks: readonly ManagedRecoveryTask[],
  ): Promise<void> {
    const key = keyOf(provider, session.logicalId);
    const prior = this.records.get(key);
    if (!prior) return;
    const backgroundTasks = recoveryTasks(tasks);
    const { backgroundTasks: _priorTasks, ...withoutTasks } = prior;
    this.records.set(key, {
      ...withoutTasks,
      ...(backgroundTasks.length ? { backgroundTasks } : {}),
      updatedAt: this.now().toISOString(),
    });
    await this.persist();
  }

  /**
   * A completed local session needs no row. Split placement keeps only its
   * non-secret coordinates so a later Runner restart can request a fresh
   * scope; the bearer itself never enters this file.
   */
  async complete(provider: AgentProvider, session: ProviderSessionRef, turnId: string, result?: { ok: boolean; error?: string }): Promise<void> {
    const key = keyOf(provider, session.logicalId);
    const prior = this.records.get(key);
    if (!prior || prior.turnId !== turnId) return;
    if (prior.capacityRetry?.phase === "dispatching" && !result?.ok) {
      this.records.set(key, { ...prior, status: "unknown",
        detail: "容量续接的发送结果无法确认，已停止自动重发。", updatedAt: this.now().toISOString() });
      await this.persist();
      return;
    }
    if (prior.capacityRetry && result) {
      // Keep a bounded result beside the exact original turn correlation so
      // its receipt can settle after a resident restart. No transcript text.
      this.records.set(key, { ...prior, status: "idle", capacityResult: {
        ok: result.ok, ...(result.error ? { error: bounded(result.error, 1_000) } : {}),
      }, updatedAt: this.now().toISOString() });
      await this.persist();
      return;
    }
    if (prior.remotePlacement) {
      const { turnId: _turnId, detail: _detail, recoveryPhase: _phase, unavailableSince: _since, nextRetryAt: _retry, capacityRetry: _capacity, ...rest } = prior;
      this.records.set(key, {
        ...rest,
        status: "idle",
        updatedAt: this.now().toISOString(),
      });
    } else {
      this.records.delete(key);
    }
    await this.persist();
  }

  /** Explicit user interruption disarms automatic continuation immediately. */
  async disarm(provider: AgentProvider, session: ProviderSessionRef, turnId?: string): Promise<void> {
    const key = keyOf(provider, session.logicalId);
    const prior = this.records.get(key);
    if (!prior || (turnId && prior.turnId !== turnId)) return;
    if (prior.remotePlacement) {
      const { turnId: _turnId, detail: _detail, recoveryPhase: _phase, unavailableSince: _since, nextRetryAt: _retry, capacityRetry: _capacity, ...rest } = prior;
      this.records.set(key, { ...rest, status: "idle", updatedAt: this.now().toISOString() });
    } else {
      this.records.delete(key);
    }
    await this.persist();
  }

  /**
   * Claim every turn the previous process had positively acknowledged.
   * `prepared` and a previous `recovering` are unknown crash windows and are
   * never replayed. This transition is persisted before any continuation is
   * sent, so a second crash cannot duplicate that continuation.
   */
  async claimInterrupted(bootRecords?: readonly ManagedRecoveryRecord[]): Promise<ManagedRecoveryRecord[]> {
    const boot = bootRecords ? new Map(bootRecords.map((row) => [keyOf(row.provider, row.session.logicalId), `${row.updatedAt}:${row.status}:${row.turnId ?? ""}:${row.recoveryCount}`])) : undefined;
    const claimed: ManagedRecoveryRecord[] = [];
    let changed = false;
    for (const [key, prior] of this.records) {
      if (boot && boot.get(key) !== `${prior.updatedAt}:${prior.status}:${prior.turnId ?? ""}:${prior.recoveryCount}`) continue;
      if (prior.status !== "idle" && prior.capacityRetry?.phase === "dispatching") {
        this.records.set(key, { ...prior, status: "unknown",
          detail: "Runner 在容量续接的确认窗口内退出；不会自动重发。", updatedAt: this.now().toISOString() });
        changed = true;
        continue;
      }
      if (prior.status === "recovering" && (prior.recoveryPhase === "preparing" || prior.recoveryPhase === "waiting_resource")) {
        claimed.push(prior);
        continue;
      }
      if (prior.status === "active") {
        const next: ManagedRecoveryRecord = {
          ...prior,
          status: "recovering",
          recoveryPhase: "preparing",
          recoveryCount: prior.recoveryCount + 1,
          updatedAt: this.now().toISOString(),
        };
        this.records.set(key, next);
        claimed.push(next);
        changed = true;
        continue;
      }
      if (prior.status === "prepared" || prior.status === "recovering") {
        this.records.set(key, {
          ...prior,
          status: "unknown",
          detail: "Runner 在托管 prompt 的确认窗口内再次退出；不会自动重发。",
          updatedAt: this.now().toISOString(),
        });
        changed = true;
      }
    }
    if (changed) await this.persist();
    return claimed;
  }

  /** A dependency probe has no provider effects. A second restart may retry it. */
  async waitForDependency(record: ManagedRecoveryRecord, detail: string): Promise<boolean> {
    const key = keyOf(record.provider, record.session.logicalId);
    const current = this.records.get(key);
    if (!current || current.status !== "recovering" || current.recoveryCount !== record.recoveryCount
      || !["preparing", "waiting_resource"].includes(current.recoveryPhase ?? "")) return false;
    const now = this.now();
    const since = current.unavailableSince ?? now.toISOString();
    this.records.set(key, { ...current, recoveryPhase: "waiting_resource", unavailableSince: since,
      nextRetryAt: new Date(now.getTime() + dependencyWait(Date.parse(since), now.getTime()).delayMs).toISOString(),
      detail: bounded(detail, 1_000), updatedAt: now.toISOString() });
    await this.persist();
    return true;
  }

  /** Durable barrier immediately BEFORE ownership can cross to the provider. */
  async beginRecoveryDispatch(record: ManagedRecoveryRecord): Promise<boolean> {
    const key = keyOf(record.provider, record.session.logicalId);
    const current = this.records.get(key);
    if (!current || current.status !== "recovering" || current.recoveryCount !== record.recoveryCount
      || !["preparing", "waiting_resource"].includes(current.recoveryPhase ?? "")) return false;
    const capacity = current.capacityRetry;
    if (capacity && (capacity.attempts >= CODEX_CAPACITY_DELAYS_MS.length
      || this.now().getTime() >= Date.parse(capacity.deadlineAt))) {
      await this.exhaustCapacity(record, "Codex 容量续接次数或 30 分钟期限已耗尽；请手动继续。");
      return false;
    }
    this.records.set(key, { ...current, recoveryPhase: "dispatching",
      ...(capacity ? { capacityRetry: { ...capacity, phase: "dispatching" as const,
        attempts: capacity.attempts + 1, nextRetryAt: undefined } } : {}),
      updatedAt: this.now().toISOString() });
    await this.persist();
    return true;
  }

  pendingRecovery(now = this.now().getTime(), wake = false): ManagedRecoveryRecord[] {
    return this.snapshot().filter((row) => row.status === "recovering"
      && (row.recoveryPhase === "preparing" || row.recoveryPhase === "waiting_resource")
      // Reconnection hints cannot shorten provider backoff.
      && (!row.capacityRetry?.nextRetryAt || Date.parse(row.capacityRetry.nextRetryAt) <= now)
      && (wake || !row.nextRetryAt || Date.parse(row.nextRetryAt) <= now));
  }

  async markUnknown(record: ManagedRecoveryRecord, detail: string): Promise<void> {
    const key = keyOf(record.provider, record.session.logicalId);
    const current = this.records.get(key);
    // Recovery setup rewrites the row to `prepared` after a provider-issued
    // rename and before dispatch. If that recovery attempt then fails, the
    // original recovering claim still owns this call and must become unknown
    // instead of looking like a replayable crash window.
    if (!current || (current.status !== "recovering" && current.status !== "prepared")) return;
    this.records.set(key, {
      ...current,
      status: "unknown",
      detail: bounded(detail, 1_000) || "Runner 无法恢复这个托管会话。",
      updatedAt: this.now().toISOString(),
    });
    await this.persist();
  }

  async exhaustCapacity(record: ManagedRecoveryRecord, detail: string): Promise<void> {
    const key = keyOf(record.provider, record.session.logicalId);
    const current = this.records.get(key);
    if (!current?.capacityRetry || current.status !== "recovering") return;
    this.records.set(key, { ...current, status: "idle",
      capacityResult: { ok: false, error: bounded(detail, 1_000) }, updatedAt: this.now().toISOString() });
    await this.persist();
  }

  snapshot(): ManagedRecoveryRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  /** Shutdown waits for a checkpoint already accepted by this resident. */
  async flush(): Promise<void> { await this.persistQueue; }

  current(provider: AgentProvider, logicalId: string): ManagedRecoveryRecord | undefined {
    const row = this.records.get(keyOf(provider, logicalId));
    return row ? structuredClone(row) : undefined;
  }

  /** Resolve only a receipt that already proved this exact session AND turn. */
  capacityReceipt(sessionId: string, turnId: string): {
    state: "running" | "succeeded" | "failed" | "unknown"; result?: Record<string, unknown>;
  } | undefined {
    const row = [...this.records.values()].find(record => record.provider === "codex"
      && record.capacityRetry?.operationTurnId === turnId
      && record.session.lineage.includes(sessionId));
    if (!row) return undefined;
    if (row.capacityResult) return { state: row.capacityResult.ok ? "succeeded" : "failed", result: row.capacityResult };
    if (row.status === "unknown") {
      return { state: "unknown", result: { ok: false, code: "unknown", error: row.detail ?? "容量续接结果无法确认；不会自动重发。" } };
    }
    if (["active", "recovering", "prepared"].includes(row.status)) return { state: "running" };
    return undefined;
  }

  sessionRefs(): StoredProviderSessionRef[] {
    return [...this.sessions.values()].map((session) => structuredClone(session));
  }

  /** Persist the single identity-owner rename edge beside recovery state. */
  async renameSession(
    provider: AgentProvider,
    from: string,
    session: ProviderSessionRef,
  ): Promise<void> {
    const normalized = normalizedSession(session);
    const logicalKey = keyOf(provider, normalized.logicalId);
    let record = this.records.get(logicalKey);
    let priorKey = logicalKey;
    if (!record) {
      const match = [...this.records.entries()].find(([, candidate]) => (
        candidate.provider === provider
        && (candidate.session.currentProviderId === from || candidate.session.lineage.includes(from))
      ));
      if (match) [priorKey, record] = match;
    }
    if (record) {
      this.records.delete(priorKey);
      this.records.set(logicalKey, {
        ...record,
        session: normalized,
        updatedAt: this.now().toISOString(),
      });
    }
    this.rememberSession(provider, normalized);
    await this.persist();
  }

  recentTerminalSend(
    provider: AgentProvider,
    session: ProviderSessionRef,
    promptHash: string,
    observedAt: string,
    windowMs: number,
  ): number | null {
    const key = terminalSendKey(provider, session.logicalId, promptHash);
    const prior = this.terminalSends.get(key);
    if (!prior) return null;
    const age = this.now().getTime() - prior.sentAt;
    if (age < 0 || age >= windowMs || prior.observedAt !== observedAt) {
      this.terminalSends.delete(key);
      return null;
    }
    return age;
  }

  /** Store only the prompt digest and observation clock, never prompt text. */
  async rememberTerminalSend(
    provider: AgentProvider,
    session: ProviderSessionRef,
    promptHash: string,
    observedAt: string,
    windowMs: number,
    maxEntries: number,
  ): Promise<void> {
    const sentAt = this.now().getTime();
    for (const [key, prior] of this.terminalSends) {
      if (sentAt - prior.sentAt >= windowMs) this.terminalSends.delete(key);
    }
    const cleanHash = bounded(promptHash, 64);
    if (!/^[0-9a-f]{64}$/.test(cleanHash)) throw new Error("terminal send prompt hash is invalid");
    const key = terminalSendKey(provider, session.logicalId, cleanHash);
    this.terminalSends.delete(key);
    this.terminalSends.set(key, {
      provider,
      logicalId: session.logicalId,
      promptHash: cleanHash,
      observedAt: bounded(observedAt, 64),
      sentAt,
    });
    while (this.terminalSends.size > maxEntries) {
      const oldest = this.terminalSends.keys().next().value as string | undefined;
      if (!oldest) break;
      this.terminalSends.delete(oldest);
    }
    this.rememberSession(provider, session);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify({
      version: 2,
      records: [...this.records.values()],
      sessions: [...this.sessions.values()],
      terminalSends: [...this.terminalSends.values()],
    }, null, 2) + "\n";
    const work = this.persistQueue.then(async () => {
      const directory = path.dirname(this.options.stateFile);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      const temp = `${this.options.stateFile}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
      try {
        await fs.writeFile(temp, snapshot, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.rename(temp, this.options.stateFile);
        await fs.chmod(this.options.stateFile, 0o600);
      } catch (error) {
        await fs.unlink(temp).catch(() => {});
        throw error;
      }
    });
    this.persistQueue = work.catch(() => {});
    await work;
  }

  private rememberSession(provider: AgentProvider, session: ProviderSessionRef): void {
    const normalized = normalizedSession(session);
    const key = keyOf(provider, normalized.logicalId);
    this.sessions.delete(key);
    this.sessions.set(key, { provider, ...normalized });
    while (this.sessions.size > 512) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
  }
}

function recoverySpec(value: ManagedRecoverySpec): ManagedRecoverySpec {
  if (!isAgentProvider(value.provider)) throw new Error("managed recovery provider is invalid");
  const session = normalizedSession(value.session);
  const cwd = absolutePath(value.cwd, "cwd");
  const codexHome = value.codexHome ? absolutePath(value.codexHome, "Codex home") : "";
  const permissionProfile = value.permissionProfile;
  if (permissionProfile !== undefined
    && permissionProfile !== AGENT_PERMISSION_PROFILES.fullAccess
    && permissionProfile !== AGENT_PERMISSION_PROFILES.manual) {
    throw new Error("managed recovery permission profile is invalid");
  }
  let remotePlacement: ManagedRecoveryPlacement | undefined;
  if (value.remotePlacement) {
    const executionDevice = bounded(value.remotePlacement.executionDevice, 64);
    const workspaceId = bounded(value.remotePlacement.workspaceId, 64);
    if (!executionDevice || !/^ws_[0-9a-f]{24}$/.test(workspaceId)) {
      throw new Error("managed recovery remote placement is invalid");
    }
    const gatewaySite = value.remotePlacement.gatewaySite;
    if (gatewaySite !== undefined && (typeof gatewaySite !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(gatewaySite))) {
      throw new Error("managed recovery gateway site is invalid");
    }
    const developmentId = value.remotePlacement.developmentId;
    if (developmentId !== undefined && (typeof developmentId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(developmentId))) {
      throw new Error("managed recovery development identity is invalid");
    }
    remotePlacement = { executionDevice, workspaceId, ...(gatewaySite ? { gatewaySite } : {}),
      ...(developmentId ? { developmentId } : {}) };
  }
  return {
    provider: value.provider,
    session,
    cwd,
    ...(codexHome ? { codexHome } : {}),
    ...(bounded(value.model, 256) ? { model: bounded(value.model, 256) } : {}),
    ...(bounded(value.effort, 32) ? { effort: bounded(value.effort, 32) } : {}),
    ...(permissionProfile ? { permissionProfile } : {}),
    ...(remotePlacement ? { remotePlacement } : {}),
  };
}

function recoveryRecord(value: unknown): ManagedRecoveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("managed recovery record is invalid");
  }
  const row = value as Record<string, unknown>;
  if (![1, 2].includes(Number(row.version))
    || !["prepared", "active", "recovering", "idle", "unknown"].includes(String(row.status))) {
    throw new Error("managed recovery record version/status is invalid");
  }
  const legacySessionId = bounded(row.sessionId, 256);
  const legacySessionPath = bounded(row.sessionPath, 4_096);
  const session = Number(row.version) === 1
    ? normalizedSession({
        logicalId: legacySessionId,
        currentProviderId: legacySessionId,
        ...(legacySessionPath ? { rolloutPath: legacySessionPath } : {}),
        lineage: [legacySessionId],
      })
    : normalizedSession(row.session as ProviderSessionRef);
  const spec = recoverySpec({
    provider: row.provider as AgentProvider,
    session,
    cwd: String(row.cwd ?? ""),
    ...(row.codexHome ? { codexHome: String(row.codexHome) } : {}),
    ...(row.model ? { model: String(row.model) } : {}),
    ...(row.effort ? { effort: String(row.effort) } : {}),
    ...(row.permissionProfile ? { permissionProfile: row.permissionProfile as AgentPermissionProfile } : {}),
    ...(row.remotePlacement ? { remotePlacement: row.remotePlacement as ManagedRecoveryPlacement } : {}),
  });
  const recoveryCount = Number(row.recoveryCount);
  const updatedAt = bounded(row.updatedAt, 64);
  const turnId = row.turnId ? bounded(row.turnId, 256) : "";
  const backgroundTasks = recoveryTasks(row.backgroundTasks);
  if (!Number.isInteger(recoveryCount) || recoveryCount < 0 || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error("managed recovery record metadata is invalid");
  }
  if ((row.status === "active" || row.status === "recovering") && !turnId) {
    throw new Error("active managed recovery record has no turn id");
  }
  return {
    version: 2,
    ...spec,
    status: row.status as ManagedRecoveryStatus,
    ...(turnId ? { turnId } : {}),
    recoveryCount,
    updatedAt,
    ...(row.capacityRetry ? { capacityRetry: parseCapacityCheckpoint(row.capacityRetry) } : {}),
    ...(row.capacityResult && typeof row.capacityResult === "object" && typeof (row.capacityResult as { ok?: unknown }).ok === "boolean"
      ? { capacityResult: { ok: (row.capacityResult as { ok: boolean }).ok,
        ...(bounded((row.capacityResult as { error?: unknown }).error, 1_000)
          ? { error: bounded((row.capacityResult as { error?: unknown }).error, 1_000) } : {}) } } : {}),
    ...(row.detail ? { detail: bounded(row.detail, 1_000) } : {}),
    ...recoveryMetadata(row),
    ...(backgroundTasks.length ? { backgroundTasks } : {}),
  };
}

function recoveryMetadata(row: Record<string, unknown>): Pick<ManagedRecoveryRecord, "recoveryPhase" | "unavailableSince" | "nextRetryAt"> {
  if (row.recoveryPhase === undefined) return {};
  if (!["preparing", "waiting_resource", "dispatching"].includes(String(row.recoveryPhase))) {
    throw new Error("managed recovery phase is invalid");
  }
  const result: Pick<ManagedRecoveryRecord, "recoveryPhase" | "unavailableSince" | "nextRetryAt"> = {
    recoveryPhase: row.recoveryPhase as ManagedRecoveryRecord["recoveryPhase"],
  };
  for (const key of ["unavailableSince", "nextRetryAt"] as const) {
    if (row[key] !== undefined) {
      if (typeof row[key] !== "string" || row[key].length > 64 || !Number.isFinite(Date.parse(row[key]))) {
        throw new Error("managed recovery wait timestamp is invalid");
      }
      result[key] = row[key];
    }
  }
  return result;
}

function normalizedSession(value: ProviderSessionRef): ProviderSessionRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("managed recovery session ref is invalid");
  }
  if (!Array.isArray(value.lineage)) throw new Error("managed recovery session lineage is invalid");
  const normalized = normalizeProviderSessionRef(value);
  const rolloutPath = value.rolloutPath ? absolutePath(value.rolloutPath, "rollout path") : "";
  return snapshotProviderSessionRef({
    ...normalized,
    ...(rolloutPath ? { rolloutPath } : {}),
  });
}

function storedSession(value: unknown): StoredProviderSessionRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("managed recovery stored session is invalid");
  }
  const row = value as Record<string, unknown>;
  if (!isAgentProvider(row.provider)) throw new Error("managed recovery stored provider is invalid");
  return { provider: row.provider, ...normalizedSession(row as unknown as ProviderSessionRef) };
}

function terminalSend(value: unknown): PersistedTerminalSend | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!isAgentProvider(row.provider)) return undefined;
  const logicalId = bounded(row.logicalId, 256);
  const promptHash = bounded(row.promptHash, 64);
  const observedAt = bounded(row.observedAt, 64);
  const sentAt = Number(row.sentAt);
  if (!logicalId || !/^[0-9a-f]{64}$/.test(promptHash) || !observedAt || !Number.isFinite(sentAt)) {
    return undefined;
  }
  return { provider: row.provider, logicalId, promptHash, observedAt, sentAt };
}

function recoveryTasks(value: unknown): ManagedRecoveryTask[] {
  if (!Array.isArray(value)) return [];
  const tasks = new Map<string, ManagedRecoveryTask>();
  for (const entry of value.slice(0, 32)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Partial<ManagedRecoveryTask>;
    const taskId = bounded(row.taskId, 256);
    if (!taskId || tasks.has(taskId)) continue;
    const toolUseId = bounded(row.toolUseId, 256);
    const description = bounded(row.description, 500).replace(/[\r\n]+/g, " ");
    tasks.set(taskId, {
      taskId,
      ...(toolUseId ? { toolUseId } : {}),
      ...(description ? { description } : {}),
    });
  }
  return [...tasks.values()];
}

function absolutePath(value: string, field: string): string {
  const clean = bounded(value, 4_096);
  if (!clean || !path.isAbsolute(clean)) throw new Error(`managed recovery ${field} is invalid`);
  return path.normalize(clean);
}

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function keyOf(provider: AgentProvider, sessionId: string): string {
  return `${provider}\0${sessionId}`;
}

function terminalSendKey(provider: AgentProvider, logicalId: string, promptHash: string): string {
  return `${keyOf(provider, logicalId)}\0${promptHash}`;
}
