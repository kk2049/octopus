/**
 * Starting a new agent for the Feishu Docs surface.
 *
 * The owner (from a card) or the owner's agent (through MCP) names a device,
 * a directory, a CLI, a model and an effort. This module dispatches the
 * Runner's own `start_session` with a durable operation id — the device's
 * launch journal makes a repeated request join the first — and reads the
 * device receipt until it names the new session.
 *
 * Authority is the owner's Runner root with `start_session` auto-allowed for
 * this one call: the product decision (2026-10-18) is that these actions run
 * without approval clicks and the owner is notified of each instead.
 */
import { createHash } from "node:crypto";
import { AGENT_EFFORTS, DEFAULT_CODEX_MODEL, MODELS, isAgentEffort } from "@claude-bot/agent-sessions-contract/providers";
import { SESSION_OPERATION_PROTOCOL, sessionOperationReceiptFromWire } from "@claude-bot/runner/gateway-protocol";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import type { LaunchDefaults, LaunchOptions, LaunchProvider } from "@claude-bot/feishu-docs-addon/protocol";
import type { RunnerCapabilities } from "../runner/capability.js";
import type { SessionBranchCapabilities } from "../session-branch/capability.js";
import { DocsAddonError } from "./docs-addon-auth.js";

export type { LaunchDefaults, LaunchOptions, LaunchProvider };
export const LAUNCH_PROVIDERS: readonly LaunchProvider[] = ["claude", "codex"];
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const EFFORT_LABELS: Record<string, string> = { low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };

export interface LaunchRequest {
  device: string;
  directory: string;
  provider: LaunchProvider;
  model: string;
  effort: string;
  prompt: string;
  /** Stable per intent: a retry with the same id joins the first launch. */
  requestId: string;
}

export interface LaunchReceipt { state: "running" | "succeeded" | "failed" | "missing" | "unknown"; sessionId?: string; error?: string }

/** Where an owner's launch choices are kept (user settings): the next form, and document assistants, start from them. */
export const LAUNCH_DEFAULTS_KEY = "feishu_docs_launch";

export const FALLBACK_DEFAULTS: LaunchDefaults = {
  provider: "codex",
  model: { claude: "opus", codex: DEFAULT_CODEX_MODEL },
  effort: { claude: "max", codex: "xhigh" },
};

/** A directory the Runner's resolver accepts: absolute, `~` or `~/…`. */
export function directoryProblem(value: string): string {
  if (!value.trim()) return "请填写要启动 Agent 的目录";
  if (value !== value.trim()) return "目录前后不能有空白";
  if (value.length > 4096) return "目录过长";
  if (value === "~" || value.startsWith("~/") || value.startsWith("/")) return "";
  return "目录要写绝对路径，或以 ~/ 开头";
}

export function readDefaults(raw: string | undefined): LaunchDefaults {
  let value: Partial<LaunchDefaults> = {};
  try { value = raw ? JSON.parse(raw) as Partial<LaunchDefaults> : {}; } catch { /* a broken setting falls back */ }
  const provider = LAUNCH_PROVIDERS.includes(value.provider as LaunchProvider) ? value.provider as LaunchProvider : FALLBACK_DEFAULTS.provider;
  const pick = (map: unknown, ok: (p: LaunchProvider, v: string) => boolean, fallback: Record<LaunchProvider, string>) =>
    Object.fromEntries(LAUNCH_PROVIDERS.map((p) => {
      const v = map && typeof map === "object" ? (map as Record<string, unknown>)[p] : undefined;
      return [p, typeof v === "string" && ok(p, v) ? v : fallback[p]];
    })) as Record<LaunchProvider, string>;
  return {
    ...(typeof value.device === "string" && value.device ? { device: value.device } : {}),
    ...(typeof value.directory === "string" && !directoryProblem(value.directory) ? { directory: value.directory } : {}),
    provider,
    model: pick(value.model, (_p, v) => v === "" || MODEL.test(v), FALLBACK_DEFAULTS.model),
    effort: pick(value.effort, (p, v) => isAgentEffort(p, v), FALLBACK_DEFAULTS.effort),
  };
}

export class DocsLauncher {
  constructor(
    private readonly caps: Pick<RunnerCapabilities, "open" | "listDevices">,
    /** Snapshots and forks; absent until composed, and then both refuse plainly. */
    private readonly branches?: Pick<SessionBranchCapabilities, "open">,
  ) {}

  options(owner: string, recent: ReadonlyArray<{ device: string; cwd?: string; lastActivity?: string }>, defaults: LaunchDefaults): LaunchOptions {
    const devices = this.caps.listDevices(owner).filter((row) => !row.device.startsWith("dsh:")).map((row) => {
      const inventory = row.inventory;
      const operations = inventory?.session_operations?.protocol === SESSION_OPERATION_PROTOCOL;
      const providers = LAUNCH_PROVIDERS.filter((p) => inventory?.agent_backends?.some((b) => b.kind === p && b.available));
      const reason = !row.online ? "设备离线" : !operations ? "这台设备的 Runner 需要升级" : !providers.length ? "没有可用的 Claude Code / Codex" : undefined;
      return { device: row.device, label: row.display_name || row.device, online: row.online && operations, providers: row.online && operations ? providers : [], ...(reason ? { reason } : {}) };
    }).sort((a, b) => Number(b.online) - Number(a.online) || a.label.localeCompare(b.label));
    const seen = new Set<string>();
    const directories: LaunchOptions["directories"] = [];
    for (const row of [...recent].sort((a, b) => String(b.lastActivity ?? "").localeCompare(String(a.lastActivity ?? "")))) {
      if (!row.cwd || !row.cwd.startsWith("/") || seen.has(`${row.device}\u0000${row.cwd}`)) continue;
      if (directories.filter((d) => d.device === row.device).length >= 10) continue;
      seen.add(`${row.device}\u0000${row.cwd}`);
      directories.push({ device: row.device, path: row.cwd, ...(row.lastActivity ? { lastActivity: row.lastActivity } : {}) });
    }
    return {
      devices, directories,
      models: { claude: [...MODELS.claude], codex: [...MODELS.codex] },
      efforts: Object.fromEntries(LAUNCH_PROVIDERS.map((p) => [p, AGENT_EFFORTS[p].map((value) => ({ value, label: EFFORT_LABELS[value] ?? value }))])) as LaunchOptions["efforts"],
      defaults,
    };
  }

  /** Validates against the owner's live inventory, then dispatches. Returns the durable operation id. */
  async start(owner: string, request: LaunchRequest): Promise<string> {
    const device = this.caps.listDevices(owner).find((row) => row.device === request.device);
    if (!device?.online) throw new DocsAddonError(409, `${request.device || "所选设备"} 当前不在线`);
    if (!LAUNCH_PROVIDERS.includes(request.provider)) throw new DocsAddonError(400, "只能新建 Claude Code 或 Codex Agent");
    if (!device.inventory?.agent_backends?.some((b) => b.kind === request.provider && b.available)) throw new DocsAddonError(409, `${device.display_name || device.device} 上没有可用的 ${request.provider === "claude" ? "Claude Code" : "Codex"}`);
    const problem = directoryProblem(request.directory);
    if (problem) throw new DocsAddonError(400, problem);
    if (request.model && !MODEL.test(request.model)) throw new DocsAddonError(400, "模型名称无效");
    if (request.effort && !isAgentEffort(request.provider, request.effort)) throw new DocsAddonError(400, "思考强度无效");
    if (!request.prompt.trim()) throw new DocsAddonError(400, "第一条任务为空");
    const bytes = Buffer.byteLength(request.prompt);
    const budget = MACHINE_LIMITS.startMaxPromptBytes;
    if (bytes > budget) throw new DocsAddonError(413, `第一条任务有 ${Math.ceil(bytes / 1024)} KB，超过一条任务能携带的 ${budget / 1024} KB`);
    if (!/^[A-Za-z0-9:_-]{8,80}$/.test(request.requestId)) throw new DocsAddonError(400, "请求标识无效");
    // The device's launch journal accepts only `op_[A-Za-z0-9_-]{8,120}` (runner/src/launch-journal.ts).
    const operationId = `op_fdl_${createHash("sha256").update(`${owner}\u0000${request.requestId}`).digest("hex").slice(0, 40)}`;
    const receipt = await this.call(owner, request.device, "start_session", {
      device: request.device, directory: request.directory, source: request.provider,
      ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}),
      permission_profile: "full_access", prompt: request.prompt,
      client_request_id: operationId, operation_id: operationId, input_receipt: true,
    }, operationId);
    if (receipt.state === "failed") throw new DocsAddonError(422, receipt.error ?? "设备没有启动这个 Agent");
    return operationId;
  }

  /** The device's current receipt for one launch. */
  status(owner: string, device: string, operationId: string): Promise<LaunchReceipt> {
    return this.call(owner, device, "get_session_operation", { device, operation_id: operationId }, operationId);
  }

  /** Polls the receipt until it names the session or fails; `deadline` bounds the wait. */
  async waitForSession(owner: string, device: string, operationId: string, deadline: number, now: () => number = Date.now): Promise<LaunchReceipt> {
    for (;;) {
      const receipt = await this.status(owner, device, operationId);
      if (receipt.sessionId || receipt.state === "failed" || now() >= deadline) return receipt;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }

  /** Where the session's last completed turn ends: the anchor a snapshot keeps and a fork starts from. */
  async anchor(owner: string, device: string, source: string, sessionId: string): Promise<{ anchor: string; at?: string } | null> {
    const result = await this.direct(owner, device, "session_anchor", { device, source, id: sessionId }, "飞书文档 · 固定快照");
    const anchor = typeof result.anchor === "string" ? result.anchor : null;
    return anchor ? { anchor, ...(typeof result.at === "string" ? { at: result.at } : {}) } : null;
  }

  /** A new session holding the conversation through `anchor` (or its last completed turn). Runs nothing. */
  async fork(owner: string, device: string, source: string, sessionId: string, anchor: string | undefined, title: string): Promise<{ sessionId: string; anchor: string }> {
    const result = await this.direct(owner, device, "fork_session", { device, source, id: sessionId, ...(anchor ? { anchor } : {}), title }, "飞书文档 · 分叉会话");
    if (typeof result.session_id !== "string" || typeof result.anchor !== "string") throw new DocsAddonError(502, "设备没有返回分叉出的会话");
    return { sessionId: result.session_id, anchor: result.anchor };
  }

  /** One read or fork on the owner's device, auto-allowed for this call only (notify-instead-of-approve). */
  private async direct(owner: string, device: string, operation: "session_anchor" | "fork_session", args: Record<string, unknown>, purpose: string): Promise<Record<string, unknown>> {
    if (!this.branches) throw new DocsAddonError(503, "快照和分叉暂不可用");
    if (!this.caps.listDevices(owner).find((row) => row.device === device)?.online) throw new DocsAddonError(409, `${device} 当前不在线`);
    const grant = this.branches.open({ username: owner, purpose, device, rights: [operation], autoAllow: [operation], metadata: { surface: "feishu-docs" } });
    if (!grant) throw new DocsAddonError(409, "这台设备不属于这个 Agent 的所有者，或已被移除");
    try {
      const outcome = await grant.request(operation, args);
      if (outcome.status === "succeeded" && outcome.result && typeof outcome.result === "object") return outcome.result as Record<string, unknown>;
      if (outcome.status === "approval_required") throw new DocsAddonError(409, "设备要求人工批准，未能直接完成");
      if (outcome.status === "denied") throw new DocsAddonError(403, "设备拒绝了这次操作");
      if (outcome.status === "failed") {
        if (/unknown method/i.test(outcome.reason)) throw new DocsAddonError(409, "这台设备的 Runner 需要升级后才能固定快照或分叉");
        throw new DocsAddonError(422, outcome.reason.slice(0, 300));
      }
      throw new DocsAddonError(502, "设备暂时没有响应，请稍后重试");
    } finally { grant.destroy(); }
  }

  private async call(owner: string, device: string, operation: "start_session" | "get_session_operation", args: Record<string, unknown>, operationId: string): Promise<LaunchReceipt> {
    const grant = this.caps.open({ username: owner, purpose: "飞书文档 · 新建 Agent", kind: "job", device,
      rights: [operation], autoAllow: [operation], metadata: { surface: "feishu-docs", operation_id: operationId } });
    if (!grant) throw new DocsAddonError(409, "这台设备不属于你，或已被移除");
    try {
      const outcome = await grant.request(operation, args);
      if (outcome.status === "approval_required") throw new DocsAddonError(409, "设备要求人工批准，未能直接启动");
      if (outcome.status === "denied") throw new DocsAddonError(403, "设备拒绝了这次启动");
      // A definite refusal carries the device's own words; an unknown outcome may still have launched.
      if (outcome.status === "failed") throw new DocsAddonError(422, `设备没有启动 Agent：${outcome.reason.slice(0, 200)}`);
      if (outcome.status !== "succeeded") throw new DocsAddonError(502, "设备暂时没有响应；Agent 可能已经启动，请稍后在会话列表里查看");
      const receipt = sessionOperationReceiptFromWire(outcome.result, operationId);
      if (!receipt) throw new DocsAddonError(502, "这台设备的 Runner 需要升级后才能从文档新建 Agent");
      const error = receipt.result && typeof receipt.result.error === "string" ? receipt.result.error.slice(0, 300) : undefined;
      return { state: receipt.state, ...(receipt.session_id ? { sessionId: receipt.session_id } : {}), ...(error ? { error } : {}) };
    } finally { grant.destroy(); }
  }
}
