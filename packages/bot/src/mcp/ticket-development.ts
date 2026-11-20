import type { McpToolDefinition } from "@claude-bot/typed-port-kit";
import type { Store } from "../store/store.js";
import { devpipeToolsForTicket, DEVPIPE_OP_BY_TOOL } from "../devpipe/tool-contract.js";
import type { McpPrincipal, McpToolOutcome } from "./service.js";
import {
  mcpCredentialOf, mcpRegistration, mcpTicketDevelopmentPolicy, mintMcpToken,
} from "./tokens.js";

const MAX_TTL_MS = 24 * 60 * 60_000;

export interface TicketDevelopmentBinding {
  owner: string;
  ticketId: number;
  turn: number;
  developmentId: string;
}

export interface TicketDevelopmentCredential {
  credential: string;
  /** Trusted Runner configuration only; never include in an agent prompt. */
  token: string;
  endpoint: string;
  expiresAt: number;
  release(): void;
}

interface HeldScope {
  binding: Readonly<TicketDevelopmentBinding>;
  tokenHash: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export interface TicketDevelopmentOptions {
  store: Pick<Store, "saveMcpToken" | "getActiveMcpTokenByHash" | "revokeMcpToken">;
  publicUrl?: string;
  dashboardPort: number;
  now?: () => number;
  /** Synchronous check against persisted owner, active turn and development binding. */
  isCurrent(binding: Readonly<TicketDevelopmentBinding>): boolean;
  /** Trusted ticket metadata; callers cannot select or attach a conflict. */
  hasKnowledgeConflict?(binding: Readonly<TicketDevelopmentBinding>): boolean;
  /** Resolves the live pipeline token internally; arguments never choose the target. */
  dispatch(binding: Readonly<TicketDevelopmentBinding>, operation: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Per-turn development authority, independent of user MCP and session execution.
 * Rows authenticate a bearer; only this live registry plus the pipeline's current
 * binding authorize it. A Head restart intentionally restores no development scope.
 */
export class TicketDevelopmentRegistry {
  private readonly scopes = new Map<string, HeldScope>();
  private closed = false;

  constructor(private readonly options: TicketDevelopmentOptions) {}

  issue(binding: TicketDevelopmentBinding, ttlMs = MAX_TTL_MS): TicketDevelopmentCredential {
    if (this.closed || !this.options.isCurrent(binding)) throw new Error("工单开发轮次已失效");
    const policy = mcpTicketDevelopmentPolicy(binding);
    for (const held of this.scopes.values()) {
      if (held.binding.owner === binding.owner && held.binding.ticketId === binding.ticketId) {
        throw new Error("工单已有开发凭证；续轮须显式更新");
      }
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("工单开发凭证有效期无效");
    const duration = Math.min(MAX_TTL_MS, Math.floor(ttlMs));
    const now = (this.options.now ?? Date.now)();
    const issued = mintMcpToken(this.options.store, {
      username: binding.owner, label: `Ticket #${binding.ticketId} turn ${binding.turn}`,
      policy, ttlMs: duration, now: () => now,
    });
    const credential = mcpCredentialOf(issued.row.token_hash);
    const timer = setTimeout(() => this.releaseCredential(credential), duration);
    timer.unref();
    const expiresAt = now + duration;
    this.scopes.set(credential, {
      binding: Object.freeze({ ...binding }), tokenHash: issued.row.token_hash, expiresAt, timer,
    });
    return {
      credential, token: issued.token,
      endpoint: mcpRegistration(this.options.publicUrl, this.options.dashboardPort).endpoint,
      expiresAt, release: () => this.releaseCredential(credential),
    };
  }

  /** The trusted pipeline reauthorizes the exact current binding before rotation. */
  renew(binding: TicketDevelopmentBinding, ttlMs = MAX_TTL_MS): TicketDevelopmentCredential {
    if (this.closed || !this.options.isCurrent(binding)) throw new Error("工单开发轮次已失效");
    mcpTicketDevelopmentPolicy(binding);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("工单开发凭证有效期无效");
    for (const [credential, held] of this.scopes) {
      if (held.binding.owner === binding.owner && held.binding.ticketId === binding.ticketId) {
        this.releaseCredential(credential);
      }
    }
    return this.issue(binding, ttlMs);
  }

  private resolve(principal: McpPrincipal): HeldScope | null {
    const held = this.scopes.get(principal.credential);
    const scope = principal.policy?.ticketDevelopment;
    if (this.closed || !held || !scope || principal.policy?.sessionExecution
      || principal.policy?.groups.length !== 0 || principal.owner !== held.binding.owner
      || scope.ticketId !== held.binding.ticketId || scope.turn !== held.binding.turn
      || scope.developmentId !== held.binding.developmentId) return null;
    const now = this.options.now ?? Date.now;
    const token = this.options.store.getActiveMcpTokenByHash(held.tokenHash, new Date(now()).toISOString());
    if (held.expiresAt <= now() || token?.username !== held.binding.owner || !this.options.isCurrent(held.binding)) {
      this.releaseCredential(principal.credential);
      return null;
    }
    return held;
  }

  listTools(principal: McpPrincipal): McpToolDefinition[] {
    const held = this.resolve(principal);
    return held ? this.toolsFor(held) : [];
  }

  private toolsFor(held: HeldScope): McpToolDefinition[] {
    return devpipeToolsForTicket(this.options.hasKnowledgeConflict?.(held.binding) === true);
  }

  async callTool(principal: McpPrincipal, name: string, raw: unknown): Promise<McpToolOutcome> {
    const held = this.resolve(principal);
    if (!held) return { ok: false, code: "no_authority", message: "这个工单开发凭证已过期或轮次已结束" };
    const tool = this.toolsFor(held).find((candidate) => candidate.name === name);
    const operation = DEVPIPE_OP_BY_TOOL[name];
    if (!tool || !operation) return { ok: false, code: "unknown_tool", message: `没有名为 ${name} 的工具。` };
    const input = raw ?? {};
    if (typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, code: "invalid_params", message: "arguments 必须是对象" };
    }
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(tool.inputSchema.properties, key)) {
        return { ok: false, code: "invalid_params", message: `未声明的参数：${key}` };
      }
    }
    // The shared dispatch reader retains each existing operation's validation.
    // It receives only this server-owned binding and the declared arguments.
    try {
      const result = await this.options.dispatch(held.binding, operation, input as Record<string, unknown>);
      if (this.resolve(principal) !== held) {
        return { ok: false, code: "unknown", message: "工单轮次已结束；请从工单记录确认原调用结果，不要重复提交。" };
      }
      return { ok: true, result };
    } catch {
      // The operation may already have taken effect. Neither this transport
      // nor a credential renewal is evidence that it is safe to replay it.
      return { ok: false, code: "unknown", message: "工单开发工具结果未知；请查询原调用，不要重复提交。" };
    }
  }

  releaseCredential(credential: string): void {
    const held = this.scopes.get(credential);
    if (!held) return;
    this.scopes.delete(credential);
    clearTimeout(held.timer);
    this.options.store.revokeMcpToken(
      held.binding.owner, held.tokenHash, new Date((this.options.now ?? Date.now)()).toISOString(),
    );
  }

  releaseOwner(owner: string): void {
    for (const [credential, held] of this.scopes) {
      if (held.binding.owner === owner) this.releaseCredential(credential);
    }
  }

  close(): void {
    this.closed = true;
    for (const credential of this.scopes.keys()) this.releaseCredential(credential);
  }
}
