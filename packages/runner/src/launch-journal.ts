/** Durable idempotency journal for `start_session`, written before spawn. */

import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { isAgentEffort } from "@claude-bot/agent-sessions-contract/providers";
import { promises as fs } from "node:fs";
import path from "node:path";
import { launchDirectoryProblem } from "./directories.js";
import { isAgentProvider, type AgentProvider } from "./agent-runtime.js";
import { headlessCapturePaths, readHeadlessCapture } from "./headless-cli-launch.js";
import { sessionIdFromCodexEvent } from "./launch-evidence.js";
import { sessionIdFromOmpScreen } from "./independent-cli-launch.js";
import type { RunnerManagedTurnUsage } from "./gateway-protocol.js";

/** Every launch transport that may be durable evidence for a started session. */
export const LAUNCH_TRANSPORTS = ["agent-sdk", "app-server", "omp-rpc", "tmux-cli", "exec"] as const;
export type LaunchTransport = (typeof LAUNCH_TRANSPORTS)[number];
export type ManagedLaunchTransport = Extract<LaunchTransport, "agent-sdk" | "app-server" | "omp-rpc">;
import {
  AGENT_PERMISSION_PROFILES,
  type AgentPermissionProfile,
} from "./agent-permissions.js";

export const LAUNCH_JOURNAL_TTL_MS = 30 * 24 * 60 * 60_000;

export interface LaunchRequest {
  client_request_id: string;
  /** The registered workspace, when that is how the target was named. */
  workspace_id: string;
  /**
   * The directory as REQUESTED, when that is how the target was named.
   *
   * The request rather than the canonical path, and that is the identity that
   * matters here: two calls that asked for the same thing are the same launch,
   * and a symlink repointed between them does not retroactively make an earlier
   * launch a different one. Exactly one of these two is ever non-empty.
   */
  directory?: string;
  source: AgentProvider;
  model?: string;
  codex_account?: string;
  effort?: string;
  permission_profile?: AgentPermissionProfile;
  /** Sessions+ local launches may explicitly choose process-independent CLI ownership. */
  launch_mode?: "independent_cli";
  /** True when provider and workspace were intentionally placed on different machines. */
  remote_execution?: boolean;
  /** Selected execution Runner for a split placement; never a path or credential. */
  execution_device?: string;
  prompt_hash: string;
  at: string;
}

export interface LaunchJournalRecord {
  version: 1;
  requested: LaunchRequest;
  /** Native thread exists; this does not assert that input was accepted. */
  prepared?: { session_id: string; transport: ManagedLaunchTransport; at: string };
  /** Bounded recovery copy, written atomically with the managed exit. */
  /**
   * Recovery receipt of a managed turn. `result_text` keeps the final reply's
   * last RESULT_TEXT_RECEIPT_CHARS characters and says so; the complete reply
   * is always in the session transcript (`read_session`, complete-block reads).
   */
  managed_result?: {
    result_text: string; result_text_truncated?: true; duration_ms: number; usage?: RunnerManagedTurnUsage; new_session_id?: string;
  };
  /** A process exists, but Codex may not have reported its session id yet. */
  spawned?: { pid: number; at: string };
  started?: {
    session_id: string;
    /** Legacy detached launches have a child pid; protocol starts do not expose one. */
    pid?: number;
    transport?: LaunchTransport;
    at: string;
  };
  fallback?: { stage: "native_setup"; error: string; at: string };
  exit?: { code: number | null; signal: string | null; at: string; error?: string };
}

export interface LegacySessionPlacementRecord {
  version: 1;
  session_id: string;
  source: AgentProvider;
  execution_device: string;
  workspace_id: string;
}

export interface SessionPlacementRecordV2 {
  version: 2;
  session_id: string;
  source: AgentProvider;
  execution_device: string;
  workspace_id: string;
  /** Host-minted positive provenance for Sessions+ roster/read operations. */
  catalog_id: string;
}

export type SessionPlacementRecord = LegacySessionPlacementRecord | SessionPlacementRecordV2;

export class LaunchJournal {
  private static queues = new Map<string, Promise<void>>();

  constructor(
    private readonly home: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = LAUNCH_JOURNAL_TTL_MS,
  ) {}

  async begin(request: Omit<LaunchRequest, "at"> & { at?: string }): Promise<{ created: boolean; record: LaunchJournalRecord }> {
    validateRequestId(request.client_request_id);
    const record: LaunchJournalRecord = {
      version: 1,
      requested: {
        client_request_id: request.client_request_id,
        workspace_id: request.workspace_id,
        ...(request.directory ? { directory: request.directory } : {}),
        source: request.source,
        ...(request.model ? { model: request.model } : {}),
        ...(request.codex_account ? { codex_account: request.codex_account } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        ...(request.permission_profile ? { permission_profile: request.permission_profile } : {}),
        ...(request.launch_mode ? { launch_mode: request.launch_mode } : {}),
        ...(request.remote_execution ? { remote_execution: true } : {}),
        ...(request.execution_device ? { execution_device: request.execution_device } : {}),
        prompt_hash: request.prompt_hash,
        at: request.at ?? new Date(this.now()).toISOString(),
      },
    };
    await this.ensureDirectory();
    const file = this.file(request.client_request_id);
    try {
      const handle = await fs.open(file, "wx", 0o600);
      try {
        await handle.writeFile(serialise(record), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.syncDirectory();
      return { created: true, record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      // O_EXCL makes the claim atomic, but the winning process still has a
      // small fsync window in which the file exists and its JSON is not yet
      // complete.  A concurrent duplicate must join that claim rather than
      // treating a transient partial read as corrupt durable evidence.
      const existing = await this.readSettled(request.client_request_id);
      if (!existing) throw new Error("launch journal disappeared during dedupe");
      assertSameRequest(existing.requested, record.requested);
      return { created: false, record: existing };
    }
  }

  async read(clientRequestId: string): Promise<LaunchJournalRecord | null> {
    validateRequestId(clientRequestId);
    try {
      return parseRecord(JSON.parse(await fs.readFile(this.file(clientRequestId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw new Error(`无法读取 launch journal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Query original evidence; never launch or match by cwd/title. */
  async reconcile(clientRequestId: string): Promise<LaunchJournalRecord | null> {
    let record = await this.read(clientRequestId);
    if (!record?.spawned) return record;
    const captures = headlessCapturePaths(this.home, clientRequestId);
    if (!record.started && (record.requested.source === "codex" || record.requested.source === "omp")) {
      const parse = record.requested.source === "codex" ? sessionIdFromCodexEvent : sessionIdFromOmpScreen;
      for (const line of (await readHeadlessCapture(captures.outputFile)).split("\n")) {
        const id = parse(line);
        if (id) { record = await this.markStarted(clientRequestId, id, record.spawned!.pid, "exec"); break; }
      }
    }
    if (!record.exit) {
      const exit = await readHeadlessCapture(captures.exitFile);
      if (/^\d{1,3}$/.test(exit)) {
        const code = Number(exit);
        record = await this.markExit(clientRequestId, code, null,
          code ? await readHeadlessCapture(captures.errorFile) : undefined);
      }
    }
    return record;
  }

  async markFallback(clientRequestId: string, stage: "native_setup", error: string): Promise<void> {
    await this.update(clientRequestId, (record) => ({ ...record,
      fallback: { stage, error: error.slice(0, 1_000), at: new Date(this.now()).toISOString() } }));
  }

  async markSpawned(clientRequestId: string, pid: number, at = new Date(this.now()).toISOString()): Promise<LaunchJournalRecord> {
    return await this.update(clientRequestId, (record) => ({ ...record, spawned: { pid, at } }));
  }

  async markStarted(
    clientRequestId: string,
    sessionId: string,
    pid: number,
    transport?: Extract<LaunchTransport, "tmux-cli" | "exec">,
    at = new Date(this.now()).toISOString(),
  ): Promise<LaunchJournalRecord> {
    if (!sessionId || sessionId.length > 200) throw new Error("launch session id 无效");
    return await this.update(clientRequestId, (record) => ({
      ...record,
      spawned: record.spawned ?? { pid, at },
      started: { session_id: sessionId, pid, ...(transport ? { transport } : {}), at },
    }));
  }

  async markManagedStarted(
    clientRequestId: string,
    sessionId: string,
    transport: ManagedLaunchTransport,
    sessionCatalogId?: string,
    at = new Date(this.now()).toISOString(),
  ): Promise<LaunchJournalRecord> {
    if (!sessionId || sessionId.length > 200) throw new Error("launch session id 无效");
    const record = await this.update(clientRequestId, (current) => ({
      ...current,
      started: { session_id: sessionId, transport, at },
    }));
    if (record.requested.remote_execution) await this.writeSessionPlacement(record, sessionCatalogId);
    return record;
  }

  async markManagedPrepared(clientRequestId: string, sessionId: string, transport: ManagedLaunchTransport,
    sessionCatalogId?: string): Promise<void> {
    if (!sessionId || sessionId.length > 200) throw new Error("launch session id 无效");
    const record = await this.update(clientRequestId, (current) => {
      if (current.prepared && current.prepared.session_id !== sessionId) throw new Error("launch session identity changed");
      return { ...current, prepared: { session_id: sessionId, transport, at: new Date(this.now()).toISOString() } };
    });
    if (record.requested.remote_execution) await this.writeSessionPlacement(record, sessionCatalogId);
  }

  async markManagedCompleted(clientRequestId: string, outcome: {
    ok: boolean; resultText?: string; error?: string; durationMs: number; usage?: RunnerManagedTurnUsage; newSessionId?: string;
  }): Promise<void> {
    await this.update(clientRequestId, (record) => record.exit ? record : ({ ...record,
      managed_result: { ...receiptText(outcome.resultText ?? ""), duration_ms: outcome.durationMs,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        ...(outcome.newSessionId ? { new_session_id: outcome.newSessionId } : {}) },
      exit: { code: outcome.ok ? 0 : 1, signal: null, at: new Date(this.now()).toISOString(),
        ...(!outcome.ok ? { error: (outcome.error || "managed Agent turn failed").slice(0, 2_000) } : {}) },
    }));
  }

  /**
   * Upgrade an already-started split placement after an idempotent replay.
   *
   * The launch request id still binds provider/workspace/execution placement;
   * this method only adds the Host's stable catalog correlation. An existing
   * different correlation is a hard refusal rather than a rebind.
   */
  async bindSessionCatalog(clientRequestId: string, sessionCatalogId: string): Promise<void> {
    validateSessionCatalogId(sessionCatalogId);
    const record = await this.read(clientRequestId);
    if (!record?.requested.remote_execution || !record.started?.session_id) {
      throw new Error("split launch 尚无可绑定的会话放置");
    }
    await this.writeSessionPlacement(record, sessionCatalogId);
  }

  async sessionPlacement(sessionId: string): Promise<SessionPlacementRecord | null> {
    if (!sessionId || Buffer.byteLength(sessionId, "utf8") > 200) return null;
    try {
      const value = JSON.parse(await fs.readFile(this.sessionPlacementFile(sessionId), "utf8")) as unknown;
      return parseSessionPlacement(value, sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw new Error(`无法读取 split session placement: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async markExit(
    clientRequestId: string,
    code: number | null,
    signal: string | null,
    error?: string,
    at = new Date(this.now()).toISOString(),
  ): Promise<LaunchJournalRecord> {
    return await this.update(clientRequestId, (record) => ({
      ...record,
      exit: { code, signal, at, ...(error ? { error: error.slice(0, 1_000) } : {}) },
    }));
  }

  /** Remove only old, terminal evidence. Unresolved rows are never garbage-collected. */
  async prune(): Promise<number> {
    await this.ensureDirectory();
    let removed = 0;
    for (const name of await fs.readdir(this.directory())) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!validRequestId(id)) continue;
      const record = await this.read(id);
      if (!record?.exit) continue;
      const finished = Date.parse(record.exit.at);
      if (!Number.isFinite(finished) || finished > this.now() - this.ttlMs) continue;
      await fs.unlink(this.file(id));
      removed += 1;
    }
    if (removed) await this.syncDirectory();
    return removed;
  }

  private async update(
    id: string,
    change: (record: LaunchJournalRecord) => LaunchJournalRecord,
  ): Promise<LaunchJournalRecord> {
    validateRequestId(id);
    let output!: LaunchJournalRecord;
    const key = this.file(id);
    const prior = LaunchJournal.queues.get(key) ?? Promise.resolve();
    const turn = prior.catch(() => {}).then(async () => {
      const current = await this.read(id);
      if (!current) throw new Error("launch journal 不存在");
      output = parseRecord(change(current));
      await this.replace(id, output);
    });
    LaunchJournal.queues.set(key, turn);
    try {
      await turn;
      return output;
    } finally {
      if (LaunchJournal.queues.get(key) === turn) LaunchJournal.queues.delete(key);
    }
  }

  private async replace(id: string, record: LaunchJournalRecord): Promise<void> {
    await this.ensureDirectory();
    const temp = path.join(this.directory(), `.${id}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`);
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(serialise(record), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, this.file(id));
      await fs.chmod(this.file(id), 0o600);
      await this.syncDirectory();
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  }

  private async readSettled(id: string): Promise<LaunchJournalRecord | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const record = await this.read(id);
        if (record) return record;
      } catch (error) {
        lastError = error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    if (lastError) throw lastError;
    return null;
  }

  private directory(): string {
    return path.join(path.resolve(this.home), ".octopus-runner", "launches");
  }

  private file(id: string): string {
    return path.join(this.directory(), `${id}.json`);
  }

  private sessionPlacementFile(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return path.join(path.resolve(this.home), ".octopus-runner", "session-placements", `${digest}.json`);
  }

  private async writeSessionPlacement(record: LaunchJournalRecord, sessionCatalogId?: string): Promise<void> {
    const sessionId = record.started?.session_id ?? record.prepared?.session_id;
    const executionDevice = record.requested.execution_device;
    if (!sessionId || !executionDevice) {
      throw new Error("split launch 缺少可持久化的会话放置");
    }
    const file = this.sessionPlacementFile(sessionId);
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    if (sessionCatalogId) validateSessionCatalogId(sessionCatalogId);
    const placement: SessionPlacementRecord = sessionCatalogId ? {
      version: 2,
      session_id: sessionId,
      source: record.requested.source,
      execution_device: executionDevice,
      workspace_id: record.requested.workspace_id,
      catalog_id: sessionCatalogId,
    } : {
      version: 1,
      session_id: sessionId,
      source: record.requested.source,
      execution_device: executionDevice,
      workspace_id: record.requested.workspace_id,
    };
    const existing = await this.sessionPlacement(sessionId);
    if (existing?.version === 2) {
      if (placement.version !== 2 || existing.catalog_id !== placement.catalog_id) {
        throw new Error("split session placement 已绑定到另一条 Sessions+ 目录记录");
      }
      if (!samePlacement(existing, placement)) throw new Error("split session placement 与启动记录不一致");
      return;
    }
    if (existing && !samePlacement(existing, placement)) {
      throw new Error("split session placement 与启动记录不一致");
    }
    const temp = `${file}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temp, serialise(placement), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temp, file);
      await fs.chmod(file, 0o600);
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory(), { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory(), 0o700);
  }

  private async syncDirectory(): Promise<void> {
    const handle = await fs.open(this.directory(), "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

function serialise(record: unknown): string {
  return JSON.stringify(record, null, 2) + "\n";
}

function validRequestId(id: string): boolean {
  return /^op_[A-Za-z0-9_-]{8,120}$/.test(id);
}

function validateRequestId(id: string): void {
  if (!validRequestId(id)) throw new Error("client_request_id 无效");
}

function assertSameRequest(left: LaunchRequest, right: LaunchRequest): void {
  if (
    left.client_request_id !== right.client_request_id
    || left.workspace_id !== right.workspace_id
    || (left.directory ?? "") !== (right.directory ?? "")
    || left.source !== right.source
    || (left.model ?? "") !== (right.model ?? "")
    || (left.effort ?? "") !== (right.effort ?? "")
    || normalizedPermissionProfile(left) !== normalizedPermissionProfile(right)
    || (left.launch_mode ?? "") !== (right.launch_mode ?? "")
    || Boolean(left.remote_execution) !== Boolean(right.remote_execution)
    || (left.execution_device ?? "") !== (right.execution_device ?? "")
    || left.codex_account !== right.codex_account
    || left.prompt_hash !== right.prompt_hash
  ) {
    throw new Error("client_request_id 已绑定到另一组启动参数");
  }
}

function parseRecord(value: unknown): LaunchJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("launch journal 格式无效");
  const row = value as LaunchJournalRecord;
  if (row.version !== 1 || !row.requested) throw new Error("launch journal 版本无效");
  validateRequestId(row.requested.client_request_id);
  // Exactly one target, and each in its own shape. A record naming both, or
  // neither, describes a launch this Runner would not have performed — which
  // makes it evidence about something else, and evidence is the whole job here.
  const hasWorkspace = row.requested.workspace_id !== "";
  const hasDirectory = Boolean(row.requested.directory);
  if (hasWorkspace === hasDirectory) throw new Error("launch journal 必须恰好记录一个启动目标");
  if (hasWorkspace && !/^ws_[0-9a-f]{24}$/.test(row.requested.workspace_id)) {
    throw new Error("launch journal workspace 无效");
  }
  if (hasDirectory && launchDirectoryProblem(row.requested.directory)) {
    throw new Error("launch journal directory 无效");
  }
  if (!isAgentProvider(row.requested.source)) throw new Error("launch journal source 无效");
  if (row.requested.model !== undefined && (
    Buffer.byteLength(row.requested.model, "utf8") > 120
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(row.requested.model)
  )) throw new Error("launch journal model 无效");
  if (row.requested.effort !== undefined && !isAgentEffort(row.requested.source, row.requested.effort)) {
    throw new Error("launch journal effort 无效");
  }
  if (row.requested.codex_account !== undefined && (row.requested.source !== "codex"
    || (row.requested.codex_account !== "@default" && !/^[A-Za-z0-9_-]{1,32}$/.test(row.requested.codex_account)))) throw new Error("launch journal codex_account 无效");
  if (row.requested.permission_profile !== undefined && (
    row.requested.permission_profile !== AGENT_PERMISSION_PROFILES.fullAccess
    && row.requested.permission_profile !== AGENT_PERMISSION_PROFILES.manual
  )) throw new Error("launch journal Agent 权限档位无效");
  if (row.requested.launch_mode !== undefined && row.requested.launch_mode !== "independent_cli") {
    throw new Error("launch journal 启动模式无效");
  }
  if (row.requested.remote_execution !== undefined && row.requested.remote_execution !== true) {
    throw new Error("launch journal remote_execution 无效");
  }
  const executionDevice = row.requested.execution_device;
  if (row.requested.remote_execution) {
    if (!executionDevice || Buffer.byteLength(executionDevice, "utf8") > 64) {
      throw new Error("launch journal execution_device 无效");
    }
  } else if (executionDevice !== undefined) {
    throw new Error("本机 launch journal 不应记录 execution_device");
  }
  if (!/^[0-9a-f]{64}$/.test(row.requested.prompt_hash)) throw new Error("launch journal prompt hash 无效");
  if (row.prepared && (!row.prepared.session_id || row.prepared.session_id.length > 200
    || !["agent-sdk", "app-server", "omp-rpc"].includes(row.prepared.transport)
    || !Number.isFinite(Date.parse(row.prepared.at)))) throw new Error("launch journal prepared 记录无效");
  if (row.started && (
    !row.started.session_id
    || (row.started.pid !== undefined && !Number.isInteger(row.started.pid))
    || (row.started.transport !== undefined
      && !LAUNCH_TRANSPORTS.includes(row.started.transport))
    || (row.started.pid === undefined && row.started.transport === undefined)
  )) {
    throw new Error("launch journal started 记录无效");
  }
  return row;
}

function parseSessionPlacement(value: unknown, expectedSessionId: string): SessionPlacementRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("split session placement 格式无效");
  }
  const row = value as SessionPlacementRecord;
  if (
    (row.version !== 1 && row.version !== 2)
    || row.session_id !== expectedSessionId
    || !isAgentProvider(row.source)
    || !row.execution_device
    || Buffer.byteLength(row.execution_device, "utf8") > 64
    || !/^ws_[0-9a-f]{24}$/.test(row.workspace_id)
  ) {
    throw new Error("split session placement 内容无效");
  }
  if (row.version === 2) validateSessionCatalogId(row.catalog_id);
  return row;
}

function samePlacement(left: SessionPlacementRecord, right: SessionPlacementRecord): boolean {
  return left.session_id === right.session_id
    && left.source === right.source
    && left.execution_device === right.execution_device
    && left.workspace_id === right.workspace_id;
}

function validateSessionCatalogId(value: string): void {
  if (!/^spc_[0-9a-f]{64}$/.test(value)) throw new Error("Sessions+ session catalog id 无效");
}

/** Rows recorded before launches stored a profile ran Codex manual and the others with full access. */
function normalizedPermissionProfile(request: LaunchRequest): string {
  return request.permission_profile ?? (request.source === "codex"
    ? AGENT_PERMISSION_PROFILES.manual : AGENT_PERMISSION_PROFILES.fullAccess);
}

/** A receipt is a bounded summary; the transcript is the complete record of the reply. */
export const RESULT_TEXT_RECEIPT_CHARS = 80_000;

export function receiptText(text: string): { result_text: string; result_text_truncated?: true } {
  return text.length > RESULT_TEXT_RECEIPT_CHARS
    ? { result_text: text.slice(-RESULT_TEXT_RECEIPT_CHARS), result_text_truncated: true }
    : { result_text: text };
}
