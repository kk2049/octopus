/**
 * Provider-neutral pending interactions owned by this Runner.
 *
 * A provider adapter translates its native request into this small public
 * envelope, then translates the single-use response back.  The browser never
 * sees JSON-RPC ids, hook control output, local paths, or process identity.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isAgentProvider, type AgentProvider } from "./agent-runtime.js";
import { MACHINE_LIMITS } from "./limits.js";

export interface AgentInteractionOption {
  label: string;
  description?: string;
}

export interface AgentInteractionQuestion {
  id: string;
  header: string;
  prompt: string;
  options: AgentInteractionOption[];
  multiple: boolean;
  allow_other: boolean;
  secret: boolean;
}

export interface PublicAgentInteraction {
  id: string;
  provider: AgentProvider;
  kind: "question" | "permission";
  title: string;
  description?: string;
  tool?: string;
  detail?: string;
  questions?: AgentInteractionQuestion[];
  created_at: string;
  expires_at: string;
  status?: "pending" | "resolved";
  resolved_at?: string;
  resolution?: {
    decision: "allow" | "deny";
    summary: string;
  };
  capabilities: { respond: boolean; allow: boolean; deny: boolean };
}

export interface AgentInteractionResponse {
  decision: "allow" | "deny";
  answers: Record<string, string[]>;
  message?: string;
}

export interface AgentInteractionRequest {
  provider: AgentProvider;
  sessionId: string;
  kind: "question" | "permission";
  title: string;
  description?: string;
  tool?: string;
  detail?: string;
  questions?: AgentInteractionQuestion[];
  /** External TUIs are intercepted only while a browser is actively reading. */
  requireWatcher?: boolean;
  /** The provider's own id for this request, e.g. a Claude tool_use_id. */
  ref?: string;
  /**
   * Delivers an answer once nothing holds the provider and it shows its own
   * prompt instead (a TUI dialog). With it, a request nobody is watching, or
   * one whose hold ends, stays answerable through this path.
   */
  answerReleased?: (response: AgentInteractionResponse) => Promise<void>;
  /** Whether the provider still waits on the hold; checked before an answer is handed over. */
  stillWaiting?: () => Promise<boolean>;
}

interface PendingInteraction {
  public: PublicAgentInteraction;
  provider: AgentProvider;
  sessionId: string;
  questions: AgentInteractionQuestion[];
  ref?: string;
  /** The held provider request. Absent once released to the provider's own prompt. */
  resolve?: (response: AgentInteractionResponse | null) => void;
  answerReleased?: (response: AgentInteractionResponse) => Promise<void>;
  stillWaiting?: () => Promise<boolean>;
  /** A released answer is on its way; the request cannot be dismissed or answered twice. */
  answering?: boolean;
  timer: NodeJS.Timeout;
}

export interface AgentInteractionBrokerOptions {
  now?: () => number;
  watchTtlMs?: number;
  managedTtlMs?: number;
  stateFile?: string;
  receiptTtlMs?: number;
  maxReceipts?: number;
}

const MAX_ANSWER_COUNT = 16;
const MAX_ANSWER_LENGTH = 4_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
/** A released request ends with the provider's own prompt; this only bounds a missed end. */
const RELEASED_TTL_MS = 24 * 60 * 60_000;

export class AgentInteractionBroker {
  private readonly pendingBySession = new Map<string, PendingInteraction>();
  private readonly pendingById = new Map<string, PendingInteraction>();
  private readonly watchedUntil = new Map<string, number>();
  private readonly managed = new Map<string, number>();
  private readonly providerControlled = new Map<string, number>();
  private readonly receipts = new Map<string, PublicAgentInteraction>();
  private readonly now: () => number;
  private readonly watchTtlMs: number;
  private readonly managedTtlMs: number;
  private readonly stateFile?: string;
  private readonly receiptTtlMs: number;
  private readonly maxReceipts: number;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly changeListeners = new Set<(change?: { provider: AgentProvider; sessionId: string }) => void>();

  constructor(options: AgentInteractionBrokerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.watchTtlMs = options.watchTtlMs ?? 15_000;
    this.managedTtlMs = options.managedTtlMs ?? MACHINE_LIMITS.managedInteractionTtlMs;
    this.stateFile = options.stateFile;
    this.receiptTtlMs = options.receiptTtlMs ?? 24 * 60 * 60_000;
    this.maxReceipts = options.maxReceipts ?? 128;
  }

  async load(): Promise<void> {
    if (!this.stateFile) return;
    try {
      const doc = JSON.parse(await fs.readFile(this.stateFile, "utf8")) as { receipts?: unknown };
      if (!Array.isArray(doc.receipts)) return;
      const cutoff = this.now() - this.receiptTtlMs;
      for (const raw of doc.receipts) {
        const receipt = persistedReceipt(raw);
        const sessionId = receiptSessionId(raw);
        if (!receipt || !sessionId || Date.parse(receipt.resolved_at ?? "") < cutoff) continue;
        this.receipts.set(keyOf(receipt.provider, sessionId), receipt);
      }
      this.pruneReceipts();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.receipts.clear();
    }
  }

  /** Keep an external CLI browser-controllable only while its transcript is open. */
  watch(provider: AgentProvider, sessionId: string): void {
    const key = keyOf(provider, sessionId);
    this.watchedUntil.set(key, this.now() + this.watchTtlMs);
    const pending = this.pendingBySession.get(key);
    if (pending?.resolve) {
      // A browser read must not shorten a managed app-server turn to the
      // external-TUI watch lease. Managed turns have no local prompt to fall
      // back to when the tab closes.
      this.scheduleExpiry(pending, this.managed.has(key) ? this.managedTtlMs : this.watchTtlMs);
    }
  }

  /** A browser-started managed turn may wait even before its next read poll. */
  beginManaged(
    provider: AgentProvider,
    sessionId: string,
    options: { providerControl?: boolean } = {},
  ): () => void {
    const key = keyOf(provider, sessionId);
    this.managed.set(key, (this.managed.get(key) ?? 0) + 1);
    if (options.providerControl) {
      this.providerControlled.set(key, (this.providerControlled.get(key) ?? 0) + 1);
    }
    return () => {
      const count = (this.managed.get(key) ?? 1) - 1;
      if (count > 0) this.managed.set(key, count);
      else this.managed.delete(key);
      if (options.providerControl) {
        const controlled = (this.providerControlled.get(key) ?? 1) - 1;
        if (controlled > 0) this.providerControlled.set(key, controlled);
        else this.providerControlled.delete(key);
      }
    };
  }

  /** Native SDK/app-server control owns prompts; hooks must only observe them. */
  usesProviderControl(provider: AgentProvider, sessionId: string): boolean {
    return (this.providerControlled.get(keyOf(provider, sessionId)) ?? 0) > 0;
  }

  publicInteraction(provider: AgentProvider, sessionId: string): PublicAgentInteraction | undefined {
    const key = keyOf(provider, sessionId);
    return this.pendingBySession.get(key)?.public ?? this.receipts.get(key);
  }

  /** Content-free change signal; listeners re-read the public projection. */
  onChanged(listener: (change?: { provider: AgentProvider; sessionId: string }) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async request(request: AgentInteractionRequest): Promise<AgentInteractionResponse | null> {
    const key = keyOf(request.provider, request.sessionId);
    const watched = (this.watchedUntil.get(key) ?? 0) > this.now();
    const isManaged = (this.managed.get(key) ?? 0) > 0;
    // Providers issue one blocking interaction at a time. A duplicate hook or
    // protocol request must not replace the one already visible to the user.
    if (this.pendingBySession.has(key)) return null;
    if (request.requireWatcher && !watched && !isManaged) {
      // Nobody can answer before the provider shows its own prompt, so it is
      // not held; with a released path the browser can still answer it there.
      if (request.answerReleased) this.open(request, RELEASED_TTL_MS);
      return null;
    }
    return await new Promise<AgentInteractionResponse | null>((resolve) => {
      this.open(request, isManaged ? this.managedTtlMs : this.watchTtlMs, resolve);
    });
  }

  async respond(args: Record<string, unknown>): Promise<{ ok: true; interaction_id: string; decision: "allow" | "deny" }> {
    const provider = isAgentProvider(args.provider) ? args.provider : null;
    const sessionId = bounded(args.session_id, 256);
    const interactionId = bounded(args.interaction_id, 128);
    if (!provider || !sessionId || !interactionId) throw new Error("invalid agent interaction target");
    let row = this.pendingById.get(interactionId);
    if (!row || row.provider !== provider || row.sessionId !== sessionId || row.answering) {
      throw new Error("这个 Agent 请求已结束、已回答，或不属于所选会话");
    }
    const response = parseResponse(args.response_json, row.questions);
    // An answer handed to a hold nobody waits on any more would be lost
    // while reported as delivered. Such a hold is released instead.
    if (row.resolve && row.stillWaiting && !await row.stillWaiting().catch(() => false)) this.release(row);
    row = this.pendingById.get(interactionId);
    if (!row || row.answering) throw new Error("这个 Agent 请求已结束、已回答，或不属于所选会话");
    if (row.resolve) {
      this.finish(row, response);
      return { ok: true, interaction_id: interactionId, decision: response.decision };
    }
    row.answering = true;
    try {
      await row.answerReleased!(response);
    } catch (error) {
      // The provider prompt may already be closed or half-answered. Nothing is
      // retried; the request ends and the error says what is known.
      this.finish(row, null);
      throw error;
    }
    this.finish(row, response);
    return { ok: true, interaction_id: interactionId, decision: response.decision };
  }

  cancel(provider: AgentProvider, sessionId: string): void {
    const row = this.pendingBySession.get(keyOf(provider, sessionId));
    if (row) this.finish(row, null);
  }

  /**
   * The provider moved past its own prompt, so a released request can no
   * longer be answered there. `ended` sees the request's provider ref.
   */
  dismissReleased(provider: AgentProvider, sessionId: string, ended: (ref: string | undefined) => boolean): void {
    const row = this.pendingBySession.get(keyOf(provider, sessionId));
    if (row && !row.resolve && !row.answering && ended(row.ref)) this.finish(row, null);
  }

  close(): void {
    for (const row of [...this.pendingById.values()]) this.finish(row, null);
    this.watchedUntil.clear();
    this.managed.clear();
    this.providerControlled.clear();
  }

  /** Wait until the latest durable receipt is on disk before acknowledging RPC. */
  async flush(): Promise<void> {
    await this.persistQueue;
  }

  private open(
    request: AgentInteractionRequest,
    ttl: number,
    resolve?: (response: AgentInteractionResponse | null) => void,
  ): void {
    const key = keyOf(request.provider, request.sessionId);
    if (this.receipts.delete(key)) void this.persist();
    const createdAt = this.now();
    const row: PendingInteraction = {
      provider: request.provider,
      sessionId: request.sessionId,
      questions: request.questions ?? [],
      ...(request.ref ? { ref: request.ref } : {}),
      ...(resolve ? { resolve } : {}),
      ...(request.answerReleased ? { answerReleased: request.answerReleased } : {}),
      ...(request.stillWaiting ? { stillWaiting: request.stillWaiting } : {}),
      timer: setTimeout(() => {}, 1),
      public: {
        id: `ai_${randomUUID().replace(/-/g, "")}`,
        provider: request.provider,
        kind: request.kind,
        title: bounded(request.title, 240) || (request.kind === "question" ? "Agent 提问" : "Agent 权限请求"),
        ...(request.description ? { description: bounded(request.description, 2_000) } : {}),
        ...(request.tool ? { tool: bounded(request.tool, 160) } : {}),
        ...(request.detail ? { detail: bounded(request.detail, 12_000) } : {}),
        ...(request.questions?.length ? { questions: request.questions } : {}),
        created_at: new Date(createdAt).toISOString(),
        expires_at: new Date(createdAt + ttl).toISOString(),
        status: "pending",
        capabilities: { respond: true, allow: true, deny: true },
      },
    };
    clearTimeout(row.timer);
    this.pendingBySession.set(key, row);
    this.pendingById.set(row.public.id, row);
    this.scheduleExpiry(row, ttl);
    this.emitChanged(row);
  }

  /** The hold ended without an answer; the provider falls back to its own prompt. */
  private release(row: PendingInteraction): void {
    if (this.pendingById.get(row.public.id) !== row || !row.resolve) return;
    if (!row.answerReleased) {
      this.finish(row, null);
      return;
    }
    const resolve = row.resolve;
    delete row.resolve;
    this.scheduleExpiry(row, RELEASED_TTL_MS);
    resolve(null);
    this.emitChanged(row);
  }

  private scheduleExpiry(row: PendingInteraction, ttlMs: number): void {
    clearTimeout(row.timer);
    const expiresAt = this.now() + ttlMs;
    row.public = { ...row.public, expires_at: new Date(expiresAt).toISOString() };
    row.timer = setTimeout(() => (row.resolve ? this.release(row) : this.finish(row, null)), ttlMs);
    row.timer.unref?.();
  }

  private finish(row: PendingInteraction, response: AgentInteractionResponse | null): void {
    if (this.pendingById.get(row.public.id) !== row) return;
    clearTimeout(row.timer);
    this.pendingById.delete(row.public.id);
    const key = keyOf(row.provider, row.sessionId);
    this.pendingBySession.delete(key);
    if (response) {
      const resolvedAt = new Date(this.now()).toISOString();
      this.receipts.set(key, {
        id: row.public.id,
        provider: row.public.provider,
        kind: row.public.kind,
        title: row.public.title,
        ...(row.public.tool ? { tool: row.public.tool } : {}),
        created_at: row.public.created_at,
        expires_at: row.public.expires_at,
        status: "resolved",
        resolved_at: resolvedAt,
        resolution: {
          decision: response.decision,
          summary: responseSummary(row.public, row.questions, response),
        },
        capabilities: { respond: false, allow: false, deny: false },
      });
      this.pruneReceipts();
      void this.persist();
    }
    row.resolve?.(response);
    this.emitChanged(row);
  }

  private pruneReceipts(): void {
    const cutoff = this.now() - this.receiptTtlMs;
    const ordered = [...this.receipts.entries()].sort((left, right) =>
      Date.parse(right[1].resolved_at ?? "") - Date.parse(left[1].resolved_at ?? ""));
    this.receipts.clear();
    for (const [key, receipt] of ordered) {
      if (this.receipts.size >= this.maxReceipts) break;
      if (Date.parse(receipt.resolved_at ?? "") < cutoff) continue;
      this.receipts.set(key, receipt);
    }
  }

  private async persist(): Promise<void> {
    if (!this.stateFile) return;
    const receipts = [...this.receipts.entries()].map(([key, receipt]) => ({
      ...receipt,
      session_id: key.slice(key.indexOf("\0") + 1),
    }));
    const snapshot = JSON.stringify({ version: 1, receipts }, null, 2);
    const work = this.persistQueue.then(async () => {
      await fs.mkdir(path.dirname(this.stateFile!), { recursive: true, mode: 0o700 });
      const temp = `${this.stateFile}.${process.pid}.tmp`;
      await fs.writeFile(temp, snapshot, { mode: 0o600 });
      await fs.rename(temp, this.stateFile!);
    });
    this.persistQueue = work.catch(() => {});
    await work;
  }

  private emitChanged(change?: { provider: AgentProvider; sessionId: string }): void {
    for (const listener of [...this.changeListeners]) {
      try { listener(change); } catch { /* notification failure never blocks the provider */ }
    }
  }
}

function responseSummary(
  interaction: PublicAgentInteraction,
  questions: readonly AgentInteractionQuestion[],
  response: AgentInteractionResponse,
): string {
  if (response.decision === "deny") return interaction.kind === "question" ? "已拒绝回答" : "已拒绝";
  if (interaction.kind === "permission") return "已允许一次";
  if (questions.some((question) => question.secret)) return "已提交私密回答";
  const answer = Object.values(response.answers).flat().filter(Boolean).join("、");
  return bounded(answer || "已提交回答", 600);
}

function persistedReceipt(value: unknown): PublicAgentInteraction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const provider = isAgentProvider(row.provider) ? row.provider : null;
  const kind = row.kind === "question" || row.kind === "permission" ? row.kind : null;
  const id = bounded(row.id, 128);
  const title = bounded(row.title, 240);
  const resolvedAt = bounded(row.resolved_at, 64);
  const resolution = row.resolution && typeof row.resolution === "object" && !Array.isArray(row.resolution)
    ? row.resolution as Record<string, unknown>
    : {};
  const decision = resolution.decision === "allow" || resolution.decision === "deny" ? resolution.decision : null;
  if (!provider || !kind || !id || !title || !resolvedAt || !decision) return null;
  return {
    id,
    provider,
    kind,
    title,
    ...(bounded(row.description, 2_000) ? { description: bounded(row.description, 2_000) } : {}),
    ...(bounded(row.tool, 160) ? { tool: bounded(row.tool, 160) } : {}),
    created_at: bounded(row.created_at, 64),
    expires_at: bounded(row.expires_at, 64),
    status: "resolved",
    resolved_at: resolvedAt,
    resolution: { decision, summary: bounded(resolution.summary, 600) },
    capabilities: { respond: false, allow: false, deny: false },
  };
}

function receiptSessionId(value: unknown): string {
  return value && typeof value === "object" && !Array.isArray(value)
    ? bounded((value as Record<string, unknown>).session_id, 256)
    : "";
}

function parseResponse(value: unknown, questions: readonly AgentInteractionQuestion[]): AgentInteractionResponse {
  const text = typeof value === "string" ? value : "";
  if (!text || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Agent 响应格式无效或过大");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Agent 响应不是有效 JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Agent 响应格式无效");
  const doc = raw as Record<string, unknown>;
  const decision = doc.decision === "allow" || doc.decision === "deny" ? doc.decision : null;
  if (!decision) throw new Error("Agent 响应 decision 只能是 allow 或 deny");
  const answers: Record<string, string[]> = {};
  const rawAnswers = doc.answers && typeof doc.answers === "object" && !Array.isArray(doc.answers)
    ? doc.answers as Record<string, unknown>
    : {};
  for (const question of questions) {
    const values = Array.isArray(rawAnswers[question.id])
      ? (rawAnswers[question.id] as unknown[])
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => bounded(entry, MAX_ANSWER_LENGTH))
          .filter(Boolean)
          .slice(0, question.multiple ? MAX_ANSWER_COUNT : 1)
      : [];
    if (decision === "allow" && values.length === 0) throw new Error(`请回答「${question.header || question.prompt}」`);
    answers[question.id] = values;
  }
  return {
    decision,
    answers,
    ...(typeof doc.message === "string" && doc.message.trim() ? { message: bounded(doc.message, 2_000) } : {}),
  };
}

export function normalizeQuestions(value: unknown): AgentInteractionQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((entry, index) => {
    const row = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : {};
    const options = Array.isArray(row.options)
      ? row.options.slice(0, 12).map((option) => {
          const item = option && typeof option === "object" && !Array.isArray(option)
            ? option as Record<string, unknown>
            : {};
          return {
            label: bounded(item.label, 240),
            ...(bounded(item.description, 1_000) ? { description: bounded(item.description, 1_000) } : {}),
          };
        }).filter((option) => option.label)
      : [];
    return {
      id: bounded(row.id, 160) || `question_${index + 1}`,
      header: bounded(row.header, 160) || `问题 ${index + 1}`,
      prompt: bounded(row.question ?? row.prompt, 2_000) || "请选择或填写答案",
      options,
      multiple: row.multiSelect === true || row.multiple === true,
      allow_other: row.isOther !== false && row.allowOther !== false,
      secret: row.isSecret === true || row.secret === true,
    };
  });
}

function keyOf(provider: AgentProvider, sessionId: string): string {
  return `${provider}\0${sessionId}`;
}

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
