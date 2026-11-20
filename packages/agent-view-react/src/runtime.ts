/** Direct same-origin App state and action runtime. Network and credentials stay with the caller. */
import { APPEARANCE_CONTRACT, VIEW_RECOVERY_BYTES, readAgentViewPerformanceWindow, type AppearanceSpec, type AgentViewPerformanceWindow } from "@claude-bot/web-trust/frame-protocol";
import type { AgentViewClient, AgentViewDraftStore, AgentViewOperation, AgentViewSnapshot, PendingProposal, Projection, ProposalReply } from "./client.js";

export type { AgentViewDraftSnapshot, AgentViewDraftStore, AgentViewOperation, AgentViewSnapshot, PendingProposal, Projection, ProposalReply } from "./client.js";

export interface AppRuntimeReply {
  ok?: boolean;
  code?: string;
  message?: string;
  result?: unknown;
  projection?: unknown;
  revision?: number;
}

export interface AppRuntimeOptions {
  projection?: unknown;
  revision?: number;
  appearance?: AppearanceSpec;
  recovery?: string | null;
  drafts?: AgentViewDraftStore;
  dispatch(action: string, params: Record<string, string>): Promise<AppRuntimeReply>;
  onRecovery?(checkpoint: string): void;
  onPerformance?(report: AgentViewPerformanceWindow): void;
  operationLimit?: number;
  now?: () => number;
}

export interface AppRuntimeClient extends AgentViewClient {
  update(projection: unknown, revision?: number): boolean;
  operation(operation: AgentViewOperation): void;
  wake(hint: { binding?: string; ref: string }): void;
  updateAppearance(appearance: unknown): void;
  close(): void;
}

const EMPTY_DRAFT = Object.freeze({ text: "", updatedAt: 0 });
const NO_DRAFTS: AgentViewDraftStore = {
  get: () => EMPTY_DRAFT,
  set: () => {},
  subscribe: () => () => {},
};
const CLOSED: ProposalReply = { ok: false, code: "channel_closed", message: "应用连接已关闭" };

function projectionOf(value: unknown): Projection {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Projection : {};
}

function revisionOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function appearanceOf(value: unknown): AppearanceSpec {
  const defaultValue: AppearanceSpec = { contract: APPEARANCE_CONTRACT, theme: "classic" };
  if (!value || typeof value !== "object") return defaultValue;
  const raw = value as Record<string, unknown>;
  if (raw.contract !== APPEARANCE_CONTRACT || typeof raw.theme !== "string") return defaultValue;
  const theme = ["classic", "aurora", "ink", "feishu", "deepseek", "apple"].includes(raw.theme) ? raw.theme : "classic";
  const size = raw.controlFontSize;
  return { contract: APPEARANCE_CONTRACT, theme,
    ...(typeof size === "number" && Number.isFinite(size) && size > 16 && size <= 64 ? { controlFontSize: size } : {}) };
}

function recoveryOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= VIEW_RECOVERY_BYTES ? value : null;
}

/**
 * One authoritative ingress, one bounded proposal/operation ledger. This object
 * never opens a transport, reads credentials, creates a React root or retries.
 * Closing settles pending callers immediately; late network results cannot
 * update a replacement runtime.
 */
export function createAppRuntimeClient(options: AppRuntimeOptions): AppRuntimeClient {
  const now = options.now ?? (() => performance.now());
  const operationLimit = Math.max(1, Math.min(100, options.operationLimit ?? 100));
  let closed = false;
  let lastRevision = revisionOf(options.revision) ?? -1;
  let sequence = 0;
  let publishedRecovery = recoveryOf(options.recovery);
  let snapshot: AgentViewSnapshot = {
    phase: options.projection === undefined ? "waiting" : "open",
    projection: options.projection === undefined ? null : projectionOf(options.projection),
    projectionReceivedAt: now(),
    operations: [],
    proposals: [],
    inFlight: 0,
    wakes: {},
    appearance: appearanceOf(options.appearance),
    recovery: publishedRecovery,
  };
  const listeners = new Set<(snapshot: AgentViewSnapshot) => void>();
  const pending = new Map<string, (reply: ProposalReply) => void>();
  const draftSubscriptions = new Set<() => void>();
  const sourceDrafts = options.drafts ?? NO_DRAFTS;

  const publish = (patch: Partial<AgentViewSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener(snapshot);
  };
  const update = (value: unknown, rawRevision?: number): boolean => {
    if (closed) return false;
    const revision = revisionOf(rawRevision);
    if (revision !== null && revision <= lastRevision) return false;
    if (revision !== null) lastRevision = revision;
    const projection = projectionOf(value);
    if (snapshot.projection === projection && snapshot.phase === "open") return true;
    publish({ projection, phase: "open", projectionReceivedAt: now() });
    return true;
  };
  const settle = (rid: string, answer: ProposalReply): void => {
    const resolve = pending.get(rid);
    if (!resolve) return;
    pending.delete(rid);
    let proposals: readonly PendingProposal[] = snapshot.proposals.flatMap((row) => row.rid !== rid
      ? [row]
      : answer.ok ? [] : [{ ...row, phase: "refused" as const, code: answer.code, message: answer.message }]);
    const refused = proposals.filter((row) => row.phase === "refused");
    if (refused.length > 16) {
      const remove = new Set(refused.slice(0, refused.length - 16).map((row) => row.rid));
      proposals = proposals.filter((row) => !remove.has(row.rid));
    }
    publish({ proposals, inFlight: pending.size });
    resolve(answer);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const resolve of pending.values()) resolve({ ok: false, code: "backend_unavailable", message: "应用连接已关闭，原请求结果未确认；请核对原操作，不要重复提交" });
    pending.clear();
    for (const unsubscribe of [...draftSubscriptions]) unsubscribe();
    draftSubscriptions.clear();
    publish({ phase: "closed", proposals: [], inFlight: 0 });
    listeners.clear();
  };

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update,
    async propose(action, input = {}) {
      if (closed) return CLOSED;
      if (pending.size >= 64) return { ok: false, code: "busy", message: "当前请求过多，请等已有请求完成" };
      const rid = "app-" + (++sequence);
      const params = Object.freeze({ ...input });
      const promise = new Promise<ProposalReply>((resolve) => { pending.set(rid, resolve); });
      publish({
        proposals: [...snapshot.proposals, { rid, action, params, phase: "inflight", message: "" }],
        inFlight: pending.size,
      });
      // Attach the continuation without awaiting it: dispose must settle the
      // public promise even when a failed network call never answers.
      void Promise.resolve().then(() => closed || !pending.has(rid) ? undefined : options.dispatch(action, params)).then((raw) => {
        if (closed || !pending.has(rid) || !raw) return;
        if (Object.prototype.hasOwnProperty.call(raw, "projection")) update(raw.projection, raw.revision);
        const ok = raw.ok !== false;
        const result = raw.result;
        const resultMessage = result && typeof result === "object" ? (result as { message?: unknown }).message : undefined;
        settle(rid, {
          ok,
          ...(raw.code ? { code: raw.code } : {}),
          result,
          message: ok ? "" : String(raw.message ?? resultMessage ?? raw.code ?? "动作被拒绝").slice(0, 500),
        });
      }, () => {
        if (!closed) settle(rid, { ok: false, code: "backend_unavailable", message: "请求结果未确认，请核对原操作后再决定下一步" });
      });
      return promise;
    },
    operation(operation) {
      if (closed || typeof operation.id !== "string" || !operation.id) return;
      const existing = snapshot.operations.find((row) => row.id === operation.id);
      // Success is durable evidence. Unknown can still become a late success.
      if (existing?.status === "succeeded" && operation.status !== "succeeded") return;
      if (existing && Object.keys(operation).every((key) => existing[key] === operation[key])
        && Object.keys(existing).length === Object.keys(operation).length) return;
      publish({ operations: [{ ...operation }, ...snapshot.operations.filter((row) => row.id !== operation.id)].slice(0, operationLimit) });
    },
    wake({ ref }) {
      if (closed || !ref || ref.length > 256) return;
      if (snapshot.wakes[ref] === undefined && Object.keys(snapshot.wakes).length >= 64) return;
      publish({ wakes: { ...snapshot.wakes, [ref]: (snapshot.wakes[ref] ?? 0) + 1 } });
    },
    updateAppearance(raw) {
      const appearance = appearanceOf(raw);
      if (closed || snapshot.appearance.theme === appearance.theme
        && snapshot.appearance.contract === appearance.contract
        && snapshot.appearance.controlFontSize === appearance.controlFontSize) return;
      publish({ appearance: { ...appearance } });
    },
    dismissProposal(rid) {
      if (closed || !snapshot.proposals.some((row) => row.rid === rid && row.phase === "refused")) return;
      publish({ proposals: snapshot.proposals.filter((row) => row.rid !== rid) });
    },
    drafts: {
      get: (key) => closed ? EMPTY_DRAFT : sourceDrafts.get(key),
      set: (key, text) => { if (!closed) sourceDrafts.set(key, text); },
      subscribe(key, listener) {
        if (closed) return () => {};
        const off = sourceDrafts.subscribe(key, (value) => { if (!closed) listener(value); });
        const unsubscribe = (): void => { off(); draftSubscriptions.delete(unsubscribe); };
        draftSubscriptions.add(unsubscribe);
        return unsubscribe;
      },
    },
    publishRecovery(value) {
      if (closed) return false;
      const checkpoint = recoveryOf(value);
      if (!checkpoint) return false;
      if (checkpoint === publishedRecovery) return true;
      try {
        options.onRecovery?.(checkpoint);
        publishedRecovery = checkpoint;
        return true;
      } catch { return false; }
    },
    reportPerformance(report) {
      if (closed) return false;
      const value = readAgentViewPerformanceWindow(report);
      if (!value) return false;
      try { options.onPerformance?.(value); return true; } catch { return false; }
    },
    close,
    destroy: close,
  };
}
