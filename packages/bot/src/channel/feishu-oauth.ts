/**
 * Feishu OAuth Device Flow (RFC 8628).
 * Per-user token management with auto-refresh.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { FeishuOAuthToken, UserManager } from "../user/types.js";
import { createLogger } from "../logger.js";

const log = createLogger("feishu-oauth");

const DEVICE_AUTH_URL = "https://accounts.feishu.cn/oauth/v1/device_authorization";
/**
 * Feishu's v2 OAuth token endpoint, for both the device-code grant and every
 * refresh. A refresh token is accepted only by the API version that issued it,
 * so the legacy v1 OIDC refresh rejects these tokens (code 20038).
 */
const OAUTH_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const TENANT_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const APP_INFO_URL = "https://open.feishu.cn/open-apis/application/v6/applications/";

export interface FeishuOAuthConfig {
  appId: string;
  appSecret: string;
}

export interface DeviceAuthResult {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
  /** The scope string this flow asked for; carried to `pollForToken`. */
  scope?: string;
}

export class FeishuAuthManager {
  private config: FeishuOAuthConfig;
  private userManager: UserManager;
  /**
   * One refresh in flight per user. A Feishu refresh token is single-use: two
   * concurrent refreshes would spend it twice, and the loser would see the
   * account as disconnected until the next `/auth`.
   */
  private readonly refreshing = new Map<string, Promise<string | null>>();

  constructor(config: FeishuOAuthConfig, userManager: UserManager) {
    this.config = config;
    this.userManager = userManager;
  }

  /** Get user-level token for a username (auto-refresh) */
  async getUserToken(username: string): Promise<string | null> {
    const token = this.userManager.getFeishuToken(username);
    if (!token) return null;

    // Check expiry
    if (Date.now() < token.expires_at - 60000) {
      return token.access_token;
    }

    const pending = this.refreshing.get(username);
    if (pending) return pending;
    const refresh = (async () => {
      try {
        const refreshed = await this.refreshUserToken(token.refresh_token);
        // A refresh renews the same grant; it does not re-consent to a different
        // scope. Carrying the recorded scope forward is what stops the gateway's
        // scope check from decaying into "cannot prove" after two hours.
        await this.userManager.saveFeishuToken(username, { ...refreshed, scope: refreshed.scope ?? token.scope });
        return refreshed.access_token;
      } catch (err) {
        log.warn({ err }, `Failed to refresh token for ${username}`);
        return null;
      }
    })().finally(() => { this.refreshing.delete(username); });
    this.refreshing.set(username, refresh);
    return refresh;
  }

  /**
   * The scopes this user's stored grant carries, or null when the deployment
   * cannot prove them (a token saved before scopes were recorded).
   *
   * Null is not "unrestricted": the gateway refuses any operation that
   * declares a scope it cannot show, and running `/auth` again records one.
   */
  getUserScopes(username: string): readonly string[] | null {
    const token = this.userManager.getFeishuToken(username);
    if (!token?.access_token) return null;
    const raw = token.scope?.trim();
    if (!raw) return null;
    return raw.split(/[\s,]+/).filter(Boolean);
  }

  /**
   * Start Device Authorization (RFC 8628).
   * Returns device_code, user_code, verification_uri_complete, etc.
   */
  async startDeviceAuth(scope?: string): Promise<DeviceAuthResult> {
    if (!scope) {
      scope = await this.grantableScopes(loadOAuthScopes());
    }

    const resp = await fetch(DEVICE_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        scope,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Device authorization failed: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as DeviceAuthResult;
    log.info(`Device auth started: user_code=${data.user_code}`);
    // What we asked for travels with the flow, so the token we save can record
    // a scope even when the token response omits one.
    return { ...data, scope: data.scope ?? scope };
  }

  /**
   * Poll for token after user authorizes (RFC 8628 polling).
   * Loops until authorized, timeout, or error.
   */
  async pollForToken(
    deviceCode: string,
    interval = 5,
    timeout = 300,
    /** What `startDeviceAuth` asked for; used when the response omits it. */
    requestedScope?: string,
  ): Promise<FeishuOAuthToken> {
    const deadline = Date.now() + timeout * 1000;
    let pollInterval = interval;

    while (Date.now() < deadline) {
      await sleep(pollInterval * 1000);

      const resp = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: this.config.appId,
          client_secret: this.config.appSecret,
        }),
      });

      const data = (await resp.json()) as {
        code?: number;
        error?: string;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        refresh_expires_in?: number;
        token_type?: string;
        scope?: string;
      };

      // Check if authorized
      if (data.code === 0 || data.access_token) {
        const now = Date.now();
        const token: FeishuOAuthToken = {
          access_token: data.access_token ?? "",
          refresh_token: data.refresh_token ?? "",
          expires_at: now + (data.expires_in ?? 7200) * 1000,
          token_type: data.token_type ?? "Bearer",
          // Feishu's own answer if it gives one, otherwise what this flow asked
          // for. Either way it is written by trusted code from the provider's
          // response — never by anything an agent can reach (SEC-03).
          scope: data.scope ?? requestedScope,
        };
        log.info("Device auth token obtained");
        return token;
      }

      // Handle polling errors
      const error = data.error ?? "";
      if (error === "authorization_pending") {
        // User hasn't authorized yet — keep polling
        continue;
      }
      if (error === "slow_down") {
        pollInterval += 5;
        continue;
      }
      if (error === "expired_token" || error === "access_denied") {
        throw new Error(`授权失败: ${error}`);
      }

      // Unknown status — log and continue
      log.debug({ data }, "Device auth poll response");
    }

    throw new Error("授权超时");
  }

  /**
   * The baseline minus the scopes this app has not enabled for user tokens.
   *
   * The baseline is what Octopus asks users to grant; the app's console
   * configuration is what Feishu can grant, and an authorization naming a scope
   * the app lacks can fail as a whole. Asking for the intersection keeps one
   * scope added here before an administrator enables it from breaking every
   * reconnect; it only ever narrows the request. When the app's list cannot be
   * read, the request is the baseline, as it always was.
   */
  private async grantableScopes(baseline: string): Promise<string> {
    const wanted = baseline.split(/\s+/).filter(Boolean);
    try {
      const enabled = await this.appUserScopes();
      const kept = wanted.filter((scope) => enabled.has(scope));
      const dropped = wanted.filter((scope) => !enabled.has(scope));
      if (dropped.length) {
        log.warn({ dropped }, "Feishu OAuth baseline names scopes this app has not enabled for user tokens; not requesting them");
      }
      return kept.join(" ");
    } catch (err) {
      log.warn({ err }, "Could not read the scopes this app has enabled; requesting the whole baseline");
      return baseline;
    }
  }

  /** Scopes the app's console configuration enables for user access tokens. */
  private async appUserScopes(): Promise<Set<string>> {
    const tokenResp = await fetch(TENANT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
    });
    const token = (await tokenResp.json()) as { code?: number; tenant_access_token?: string };
    if (token.code !== 0 || !token.tenant_access_token) throw new Error(`tenant token refused: code=${token.code}`);
    const infoResp = await fetch(`${APP_INFO_URL}${encodeURIComponent(this.config.appId)}?lang=zh_cn`, {
      headers: { Authorization: `Bearer ${token.tenant_access_token}` },
    });
    const info = (await infoResp.json()) as {
      code?: number;
      data?: { app?: { scopes?: Array<{ scope?: string; token_types?: string[] }> } };
    };
    if (info.code !== 0) throw new Error(`app info refused: code=${info.code}`);
    const rows = info.data?.app?.scopes ?? [];
    if (!rows.length) throw new Error("app info lists no scopes");
    return new Set(rows.filter((row) => row.token_types?.includes("user")).map((row) => String(row.scope ?? "")).filter(Boolean));
  }

  private async refreshUserToken(refreshToken: string): Promise<FeishuOAuthToken> {
    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        refresh_token: refreshToken,
      }),
    });

    const data = (await resp.json().catch(() => ({}))) as {
      code?: number;
      error?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    if (data.code !== 0 || !data.access_token) {
      throw new Error(`Feishu token refresh failed: code=${data.code}${data.error ? ` ${data.error}` : ""}`);
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? "",
      expires_at: Date.now() + (data.expires_in ?? 7200) * 1000,
      token_type: data.token_type ?? "Bearer",
      scope: data.scope,
    };
  }
}

/** Load OAuth scopes from config file */
function loadOAuthScopes(): string {
  const configPath = process.env.CONFIG_PATH ?? "";
  const configDir = configPath ? path.dirname(path.resolve(configPath)) : "";

  const scopeFiles = [
    path.join(process.cwd(), "config/feishu_scopes.json"),
    path.join(process.cwd(), "../config/feishu_scopes.json"),
    // When launched via bot-ctl, cwd is instance dir — search project root
    ...(configDir ? [
      path.join(configDir, "../../config/feishu_scopes.json"),
      path.join(configDir, "../config/feishu_scopes.json"),
    ] : []),
  ];

  for (const f of scopeFiles) {
    if (existsSync(f)) {
      try {
        const data = JSON.parse(readFileSync(f, "utf-8")) as {
          scopes?: string[] | { user?: string[] };
        };
        // Support both flat array and nested { user: [...] } format
        const scopeList = Array.isArray(data.scopes)
          ? data.scopes
          : (data.scopes as { user?: string[] })?.user;
        if (scopeList) {
          log.info(`Loaded ${scopeList.length} OAuth scopes from ${f}`);
          return scopeList.join(" ");
        }
      } catch {
        // ignore
      }
    }
  }

  log.warn("No feishu_scopes.json found, using minimal scopes");
  return "offline_access";
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
