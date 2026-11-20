import type { RunnerManagedCompletion } from "@claude-bot/runner/gateway-protocol";
import { WORKSPACE_FILES_PROPOSAL_ACTIONS_V4 } from "@claude-bot/workspace-files-contract";
import { createHash, randomBytes } from "node:crypto";
import { SHARE_LEASE_HOURS, SHARE_TOKEN_PRESETS, readCodexTokenUsage } from "@claude-bot/agent-sessions-contract";
import type { RuntimeJson } from "@claude-bot/app-runtime";
import type { SessionPlusInstanceBinding, SessionPlusPrincipal } from "../app-core/instance.js";
import { decodeResourceId } from "../sessionhub/core.js";
import type { SessionShareRecord, SessionSharesRepository, SharedWorkspace } from "../store/repositories/session-shares.js";
import type { WorkspaceFilesScopeGrant } from "../agent-resources/workspace-files-provider.js";

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const rows = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(object) : [];
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export const SHARED_PROMPT_ACTIONS = new Set(["append_session", "resume_session", "takeover_session"]);
const SHARED_ACTIONS = new Set(["refresh_sessions", "open_session", "close_session", "refresh_workspaces", "search_sessions", "interrupt_session", "release_session_control", "respond_agent_interaction", "attach_file", "open_terminal", "read_terminal", "send_terminal", "close_terminal", ...SHARED_PROMPT_ACTIONS]);
/**
 * A metered prompt that no completion settled within this long stops holding
 * the session's prompt lock (B14). It only ever RELEASES: concurrency is still
 * refused separately while the session's turn is working.
 */
export const STALE_SHARE_METER_MS = 60 * 60_000;
/** Operation outcomes after which no turn ran, so no completion will settle the meter. */
const UNSETTLED_OUTCOMES = new Set(["failed", "rejected", "unknown"]);

/** Explicit delegation narrows existing owner capability planes; it never creates an account root. */
export class SessionSharingService {
  private readonly instances = new Map<string, string>();
  private readonly listeners = new Set<(id: string) => void>();
  /** The durable status of a metered prompt's operation; composed after the coordinator exists. */
  private operationStatus: ((owner: string, operationId: string) => string | null) | null = null;
  constructor(readonly repository: SessionSharesRepository, private readonly now: () => number = Date.now) {}

  attachOperationStatus(read: (owner: string, operationId: string) => string | null): void {
    this.operationStatus = read;
  }

  create(owner: string, resource: string, projection: unknown, selected: unknown, preset = "1", hours = 24) {
    const source = object(projection);
    const session = rows(source.sessions).find((r) => r.resourceId === resource);
    const decoded = decodeResourceId(resource);
    if (!decoded || decoded.owner !== owner || decoded.cliKind !== "codex" || !session || session.inputMode === "parent_owned") throw new Error("只能分享自己可直接操作的 Codex 会话");
    if (!Object.hasOwn(SHARE_TOKEN_PRESETS, preset) || !SHARE_LEASE_HOURS.includes(hours as 1 | 5 | 24)) throw new Error("无效的预算或租期");
    const choices = this.workspaceChoices(source);
    if (!Array.isArray(selected) || selected.length > 16 || selected.some((key) => typeof key !== "string" || !choices.some((c) => c.key === key))) throw new Error("请选择当前已授权的工作区");
    const workspaces = choices.filter((c) => selected.includes(c.key)).map(({ device, workspaceId, label }) => ({ device, workspaceId, label }));
    const secret = randomBytes(32).toString("base64url");
    const row: SessionShareRecord = { id: `sh_${randomBytes(16).toString("hex")}`, owner, secretHash: hash(secret), resource,
      title: String(session.title || session.firstUserText || "共享会话").slice(0, 120), session, workspaces, createdAt: this.now(), expiresAt: this.now() + hours * 3_600_000,
      revokedAt: null, tokenLimit: SHARE_TOKEN_PRESETS[preset as keyof typeof SHARE_TOKEN_PRESETS], tokensUsed: 0, meter: null };
    this.repository.put(row);
    this.changed(row.id);
    return { id: row.id, link: `/share#${secret}`, ...this.summary(row) };
  }

  private workspaceGroups(projection: unknown): Record<string, unknown>[] {
    const p = object(projection);
    const groups = Object.values(object(p.workspacesByDevice)).map(object);
    if (!groups.length && p.workspaces) groups.push(object(p.workspaces));
    return groups;
  }
  workspaceChoices(projection: unknown): Array<SharedWorkspace & { key: string; directoryKey?: string }> {
    return this.workspaceGroups(projection).flatMap((g) => rows(g.workspaces).map((w) => ({
      key: JSON.stringify([g.device, w.id]), device: String(g.device ?? ""), workspaceId: String(w.id ?? ""), label: String(w.label ?? w.display ?? w.id ?? ""),
      ...(typeof w.directoryKey === "string" ? { directoryKey: w.directoryKey } : {}),
    }))).filter((w) => w.device && w.workspaceId).slice(0, 128);
  }
  redeem(secret: string, viewer: string): SessionShareRecord {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("共享链接无效");
    const row = this.repository.bySecret(hash(secret));
    if (!row || row.revokedAt !== null) throw new Error("共享链接无效或已撤销");
    // Membership is discoverability. Even an expired link can request a renewal, not access resources.
    this.repository.join(row.id, viewer); return row;
  }
  access(id: string, viewer: string, requireLive = true): SessionShareRecord {
    const row = this.repository.get(id);
    if (!row || row.revokedAt !== null || (row.owner !== viewer && !this.repository.member(id, viewer))) throw new Error("共享不存在或无权访问");
    if (requireLive && row.expiresAt <= this.now()) throw new Error("共享租期已到期，请申请更多时间");
    return row;
  }
  bind(instance: string, principal: SessionPlusPrincipal): void {
    if (!principal.delegation) return;
    const row = this.access(principal.delegation.shareId, principal.delegation.viewer);
    if (row.owner !== principal.owner) throw new Error("共享签发者不匹配");
    this.instances.set(instance, row.id);
  }
  unbind(instance: string): void { this.instances.delete(instance); }
  scope(instance: string): SessionShareRecord | null {
    const id = this.instances.get(instance);
    if (!id) return null;
    const row = this.repository.get(id);
    if (!row || row.revokedAt !== null || row.expiresAt <= this.now()) throw new Error("共享已到期或撤销");
    return row;
  }
  onChanged(listener: (id: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(id: string): void { for (const listener of this.listeners) listener(id); }
  revoke(id: string, owner: string): void {
    this.repository.update(id, (row) => { if (row.owner !== owner) throw new Error("只有签发者能撤销共享"); row.revokedAt = this.now(); });
    this.changed(id);
  }
  /**
   * The issuer (or an administrator) releases a prompt lock by hand (B14).
   * What the transcript already showed stays charged; nothing else changes.
   */
  resetMeter(id: string, actor: string, admin = false): void {
    this.repository.update(id, (row) => {
      if (row.owner !== actor && !admin) throw new Error("只有签发者能重置用量结算");
      row.meter = null;
    });
    this.changed(id);
  }
  request(id: string, viewer: string, kind: string): void {
    this.access(id, viewer, false);
    if (kind !== "budget" && kind !== "lease") throw new Error("无效申请");
    this.repository.request(id, viewer, kind, this.now());
  }
  decide(owner: string, requestId: number, approve: boolean, preset = "1", hours = 24): void {
    if (!Object.hasOwn(SHARE_TOKEN_PRESETS, preset) || !SHARE_LEASE_HOURS.includes(hours as 1 | 5 | 24)) throw new Error("无效额度");
    const shareId = this.repository.requests(owner).find((r) => r.id === requestId)?.shareId;
    this.repository.decide(owner, requestId, approve, this.now(), (row, kind) => {
      if (row.revokedAt !== null) throw new Error("共享已撤销");
      if (kind === "budget") row.tokenLimit += SHARE_TOKEN_PRESETS[preset as keyof typeof SHARE_TOKEN_PRESETS];
      else row.expiresAt = Math.max(this.now(), row.expiresAt) + hours * 3_600_000;
    });
    if (shareId) this.changed(shareId);
  }
  summary(row: SessionShareRecord) {
    return { shareId: row.id, title: row.title, expiresAt: row.expiresAt, revoked: row.revokedAt !== null,
      tokenLimit: row.tokenLimit, tokensUsed: row.tokensUsed, canPrompt: row.revokedAt === null && row.expiresAt > this.now() && row.tokensUsed < row.tokenLimit,
      metering: row.meter !== null, accounting: "tokens" as const };
  }

  /** Applies to first frames, live frames and durable state updates alike. */
  project(binding: Pick<SessionPlusInstanceBinding, "owner" | "delegation">, raw: RuntimeJson): RuntimeJson {
    const p = object(raw);
    if (!binding.delegation) return { ...p, sharingAvailable: true, sharedSessions: this.repository.list(binding.owner).map((r) => ({ ...this.summary(r), ...(r.owner === binding.owner ? { resourceId: r.resource } : {}) })) } as RuntimeJson;
    let row: SessionShareRecord;
    try { row = this.access(binding.delegation.shareId, binding.delegation.viewer); } catch { return { sessions: [], transcript: {}, sharedAccess: { expired: true, canPrompt: false } }; }
    const transcriptMap = object(p.transcript);
    const transcript = object(transcriptMap[row.resource]);
    const usage = readCodexTokenUsage(transcript.usage);
    if (row.meter && usage && usage.totalTokens > row.meter.observed) {
      row = this.repository.update(row.id, (r) => {
        if (!r.meter) return;
        r.tokensUsed += Math.max(0, usage.totalTokens - r.meter.observed);
        r.meter.observed = usage.totalTokens;
        // Final settlement comes from the authenticated provider completion, even after this tab closes.
      });
    }
    const session = rows(p.sessions).find((r) => r.resourceId === row.resource) ?? row.session;
    return { sessions: [{ ...session, shared: true, sharedPromptAllowed: this.summary(row).canPrompt, ...(usage ? { usage } : {}) }], rosterSettled: true,
      transcript: transcriptMap[row.resource] ? { [row.resource]: transcriptMap[row.resource] } : {},
      operations: rows(p.operations).filter((r) => r.resourceId === row.resource),
      workspacesByDevice: Object.fromEntries(this.workspaceGroups(p).map((g) => ({ ...g, workspaces: rows(g.workspaces).filter((w) => row.workspaces.some((s) => s.device === g.device && s.workspaceId === w.id)) })).filter((g) => g.workspaces.length).map((g) => [String(object(g).device), g])),
      sources: rows(p.sources).filter((s) => s.deviceId === session.deviceId || s.device === session.deviceId),
      search: { query: object(p.search).query ?? "", sessions: rows(object(p.search).sessions).filter((s) => s.resourceId === row.resource) },
      sharedAccess: this.summary(row), sharedSessions: [this.summary(row)], sharingAvailable: false,
    } as unknown as RuntimeJson;
  }

  check(instance: string, action: string, params: Readonly<Record<string, string>>): void {
    const row = this.scope(instance);
    if (!row) return;
    if ((WORKSPACE_FILES_PROPOSAL_ACTIONS_V4 as readonly string[]).includes(action)) return; // The bound workspace grant rechecks every operation/window.
    if (!SHARED_ACTIONS.has(action)) throw new Error("共享只允许操作这一条会话，不能新建、分叉或切换账号");
    if (action === "attach_file" && (params.resource !== row.resource || params.device || params.workspace_id)) throw new Error("共享附件只能发送到被分享的会话");
    if (params.resource && params.resource !== row.resource) throw new Error("会话不在共享范围内");
    if (["refresh_workspaces", "open_terminal"].includes(action) && params.device && !row.workspaces.some((w) => w.device === params.device && (!params.workspace_id || w.workspaceId === params.workspace_id))) throw new Error("工作区不在共享范围内");
    if (SHARED_PROMPT_ACTIONS.has(action) && row.tokensUsed >= row.tokenLimit) throw new Error("共享 token 预算已用完，可申请更多额度；当前执行不会中断");
  }
  beginPrompt(instance: string, total: number): void {
    const row = this.scope(instance); if (!row) return;
    // A lock nothing can settle any more is released here, at the one moment
    // it would otherwise refuse (B14): its prompt's operation ended without a
    // turn, its share was revoked, or no completion arrived in time.
    for (const pending of this.repository.pendingMeters()) {
      if (pending.resource === row.resource && this.unsettleable(pending)) this.release(pending.id);
    }
    this.repository.update(row.id, (r) => {
      if (this.repository.pendingMeters().some((s) => s.resource === r.resource)) throw new Error("上一次共享 prompt 仍在执行或等待用量结算");
      if (r.tokensUsed >= r.tokenLimit) throw new Error("共享 token 预算已用完");
      if (!Number.isSafeInteger(total) || total < 0) throw new Error("当前会话缺少可核对的 token 用量，暂不能提交新 prompt");
      r.meter = { baseline: total, observed: total, startedAt: this.now() };
    });
  }
  /**
   * Every terminal Codex completion of the metered session settles its meter
   * (B14): with authenticated usage it charges that usage; a failed turn or one
   * without accounting releases the lock and keeps the provisional charge the
   * transcript already showed. Before, only "completed with usage" settled,
   * so one failed turn locked every later shared prompt forever.
   */
  spendCompletion(owner: string, device: string, completion: RunnerManagedCompletion): void {
    if (completion.provider !== "codex") return;
    if (!Number.isFinite(Date.parse(completion.completed_at))) return;
    const values = completion.usage
      ? [completion.usage.tokens_in ?? 0, completion.usage.tokens_out ?? 0, completion.usage.tokens_cached ?? 0]
      : null;
    const sum = values?.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
      ? values.reduce<number>((total, v) => total + Number(v), 0)
      : null;
    const tokens = sum !== null && Number.isSafeInteger(sum) ? sum : null;
    for (const row of this.repository.pendingMeters()) {
      const target = decodeResourceId(row.resource);
      if (!target || target.owner !== owner || target.device !== device || target.cliKind !== "codex"
        || ![completion.session_id, completion.logical_session_id].includes(target.sessionId)
        || Date.parse(completion.completed_at) < row.meter!.startedAt) continue;
      this.repository.settle(row.id, JSON.stringify([owner, device, completion.turn_id]), tokens, completion.completed_at);
      this.changed(row.id);
    }
  }

  promptSubmitted(instance: string, operationId: string | null): void {
    const id = this.instances.get(instance); if (!id) return;
    this.repository.update(id, (r) => { if (r.meter) { if (operationId) r.meter.operationId = operationId; else r.meter = null; } });
  }

  private unsettleable(row: SessionShareRecord): boolean {
    const meter = row.meter;
    if (!meter) return false;
    if (row.revokedAt !== null || this.now() - meter.startedAt >= STALE_SHARE_METER_MS) return true;
    if (!meter.operationId || !this.operationStatus) return false;
    const status = this.operationStatus(row.owner, meter.operationId);
    return status === null || UNSETTLED_OUTCOMES.has(status);
  }

  /** Release without new evidence: what the transcript already showed stays charged. */
  private release(id: string): void {
    this.repository.update(id, (row) => { row.meter = null; });
    this.changed(id);
  }

  narrowWorkspaceGrant(instance: string, grant: WorkspaceFilesScopeGrant | null): WorkspaceFilesScopeGrant | null {
    instance = instance.split(":resource:")[0];
    if (!this.instances.has(instance) || !grant) return grant;
    const original = grant.authority;
    const live = () => { const row = this.scope(instance); if (!row) throw new Error("共享访问已结束"); return row; };
    return { ...grant, ownerFiles: false, ownerFilesWritable: false, authority: {
      devices: async () => { const allowed = live().workspaces; const devices = await original.devices(); live(); return devices.filter((d) => allowed.some((w) => w.device === d.device)); },
      call: async (device, operation, args) => {
        const row = live();
        const allowed = row.workspaces.filter((w) => w.device === device);
        if (!allowed.length || operation === "access_owner_files" || operation === "replace_owner_text" || (operation !== "list_session_workspaces" && !allowed.some((w) => w.workspaceId === args.workspace_id))) return { status: "denied" };
        const result = await original.call(device, operation, args);
        live(); // Revocation/expiry during IO cannot disclose its answer.
        if (operation !== "list_session_workspaces" || result.status !== "succeeded") return result;
        const raw = object(result.result);
        return { status: "succeeded", result: { ...raw, workspaces: rows(raw.workspaces).filter((w) => allowed.some((a) => a.workspaceId === w.id)), session_directories: [] } };
      },
    } };
  }
}
