/**
 * Browser-facing coordinator for Feishu's device OAuth flow.
 *
 * It stores no credential: the AuthManager and UserManager remain the only
 * credential writers. This object owns only short-lived device-flow progress
 * so the trusted permission page and the narrow Feishu `/auth` command can
 * reconnect an account without restoring the legacy chat Router.
 */
import type { FeishuAuthManager, DeviceAuthResult } from "../channel/feishu-oauth.js";
import type { FeishuOAuthToken, UserManager } from "../user/types.js";

export type FeishuOAuthPortalStatus =
  | { state: "disconnected" }
  | { state: "pending"; verificationUri: string; userCode: string; expiresAt: string }
  | { state: "connected" }
  | { state: "failed"; error: string };

export interface FeishuOAuthAttentionNotice {
  id: string;
  kind: "feishu_reauth";
  title: string;
  detail: string;
  url: string;
  actionLabel: string;
}

interface Flow {
  device: DeviceAuthResult;
  expiresAt: number;
  state: "pending" | "saving" | "failed";
  error?: string;
}

interface Attention {
  operation: string;
  reason: string;
}

export class FeishuOAuthPortal {
  private flows = new Map<string, Flow>();
  private attention = new Map<string, Attention>();

  constructor(
    private auth: FeishuAuthManager,
    private users: Pick<UserManager, "getFeishuToken" | "saveFeishuToken">,
    private now: () => number = Date.now,
  ) {}

  status(username: string): FeishuOAuthPortalStatus {
    const flow = this.flows.get(username);
    if (flow) {
      if (flow.state === "pending" && flow.expiresAt <= this.now()) {
        flow.state = "failed";
        flow.error = "授权已超时，请重新发起授权。";
      }
      if (flow.state === "failed") {
        return { state: "failed", error: flow.error ?? "授权失败" };
      } else {
        return {
          state: "pending",
          verificationUri: flow.device.verification_uri_complete || flow.device.verification_uri,
          userCode: flow.device.user_code,
          expiresAt: new Date(flow.expiresAt).toISOString(),
        };
      }
    }
    return this.users.getFeishuToken(username)?.refresh_token ? { state: "connected" } : { state: "disconnected" };
  }

  async start(username: string, force = false): Promise<FeishuOAuthPortalStatus> {
    const current = this.status(username);
    if (current.state === "pending" || (current.state === "connected" && !force)) return current;
    const device = await this.auth.startDeviceAuth();
    const flow: Flow = {
      device,
      expiresAt: this.now() + Math.max(1, device.expires_in) * 1000,
      state: "pending",
    };
    this.flows.set(username, flow);
    void this.auth.pollForToken(device.device_code, device.interval, device.expires_in, device.scope).then(
      async (token: FeishuOAuthToken) => {
        // A late answer from an expired/replaced device code must never replace
        // credentials produced by the newer flow.
        if (this.flows.get(username) !== flow || flow.expiresAt <= this.now()) return;
        flow.state = "saving";
        try {
          await this.users.saveFeishuToken(username, token);
          if (this.flows.get(username) === flow) {
            this.flows.delete(username);
            this.attention.delete(username);
          }
        } catch {
          if (this.flows.get(username) !== flow) return;
          flow.state = "failed";
          flow.error = "授权已完成，但凭据保存失败；请重试。";
        }
      },
      (error: unknown) => {
        if (this.flows.get(username) !== flow) return;
        flow.state = "failed";
        flow.error = (error instanceof Error ? error.message : String(error)).slice(0, 240);
      },
    );
    return this.status(username);
  }

  /**
   * Turn an execution-time OAuth refusal into one owner-visible recovery path.
   * This is attention state, not a capability request: it has no approve/reject
   * verb and cannot cause the refused operation to be replayed.
   */
  async requireReconnect(username: string, operation: string, reason: string): Promise<void> {
    const owner = String(username ?? "").trim();
    if (!owner) return;
    this.attention.set(owner, {
      operation: String(operation || "飞书操作").slice(0, 120),
      reason: String(reason || "飞书授权不可用").slice(0, 240),
    });
    try {
      await this.start(owner, true);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.attention.set(owner, {
        operation: String(operation || "飞书操作").slice(0, 120),
        reason: `重新授权暂时无法启动：${detail}`.slice(0, 240),
      });
    }
  }

  notice(username: string): FeishuOAuthAttentionNotice | null {
    const owner = String(username ?? "").trim();
    const attention = this.attention.get(owner);
    if (!attention) return null;
    const status = this.status(owner);
    const url = status.state === "pending" ? status.verificationUri : "/permissions?focus=feishu";
    return {
      id: `feishu-reauth:${owner}:${status.state === "pending" ? status.expiresAt : "retry"}`,
      kind: "feishu_reauth",
      title: "飞书授权需要更新",
      detail: `${attention.operation} 暂停：${attention.reason}`,
      url,
      actionLabel: status.state === "pending" ? "打开飞书授权" : "前往权限设置",
    };
  }

  clear(username: string): void {
    this.flows.delete(username);
    this.attention.delete(username);
  }
}
