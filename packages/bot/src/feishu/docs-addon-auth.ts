/**
 * Native Docs login is identity proof, never a Feishu OpenAPI user grant.
 *
 * Every member of the configured tenant may connect; `username` is the mapped
 * Octopus account or null. Only a mapped owner can list, share or operate a
 * session — a tenant member without an account can only observe shared cards.
 */
import { createHash } from 'node:crypto';
import { MemorySessionStore, WebSessions, type ResolvedSession } from '@claude-bot/web-trust';
import type { FeishuDocsAddonConfig } from '../config.js';

export class DocsAddonError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface FeishuDocsAddonOptions {
  tenantKey: string;
  allowedOrigins: readonly string[];
  verifyCode(code: string): Promise<{ openId: string; tenantKey: string }>;
}
export interface DocsAddonIdentity {
  openId: string;
  /** The mapped Octopus account, or null for a tenant member who can only observe. */
  username: string | null;
  /** Scopes the Session Hub Contexts this login derives; never rendered. */
  credential: string;
  tokenHash: string;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const lifetime = 30 * 60_000;

export function feishuDocsAddonOptions(config: FeishuDocsAddonConfig | undefined, credentials: { appId: string; appSecret: string } | null): FeishuDocsAddonOptions | undefined {
  if (!config?.enabled) return undefined;
  if (!credentials?.appId || !credentials.appSecret) throw new Error('Docs add-on requires the configured Feishu application credentials');
  return { tenantKey: config.tenant_key, allowedOrigins: config.allowed_origins, verifyCode: docsAddonCodeVerifier(credentials) };
}

/** The official code2session exchange. Upstream credentials never leave this object. */
export function docsAddonCodeVerifier(
  credentials: { appId: string; appSecret: string },
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): FeishuDocsAddonOptions['verifyCode'] {
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  const post = async (path: string, body: unknown, token?: string): Promise<Record<string, unknown>> => {
    try {
      const response = await fetcher(`https://open.feishu.cn/open-apis/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      const result: unknown = await response.json();
      if (!response.ok || !result || typeof result !== 'object' || (result as Record<string, unknown>).code !== 0) throw new Error('upstream refused');
      return result as Record<string, unknown>;
    } catch { throw new DocsAddonError(502, '飞书身份验证未完成，请重新连接'); }
  };
  const appToken = async (): Promise<string> => {
    if (cached && cached.until > now()) return cached.token;
    if (!pending) pending = (async () => {
      const result = await post('auth/v3/app_access_token/internal', { app_id: credentials.appId, app_secret: credentials.appSecret });
      if (typeof result.app_access_token !== 'string' || typeof result.expire !== 'number' || !Number.isFinite(result.expire) || result.expire <= 60) throw new DocsAddonError(502, '飞书应用登录暂不可用');
      cached = { token: result.app_access_token, until: now() + (result.expire - 60) * 1000 };
      return cached.token;
    })().finally(() => { pending = undefined; });
    return pending;
  };
  return async (code) => {
    const result = await post('mina/v2/tokenLoginValidate', { code }, await appToken());
    const data = result.data as Record<string, unknown> | undefined;
    if (!data || typeof data.open_id !== 'string' || !data.open_id || typeof data.tenant_key !== 'string' || !data.tenant_key) throw new DocsAddonError(401, '飞书未返回完整的用户身份');
    // access_token / refresh_token / session_key are deliberately discarded.
    return { openId: data.open_id, tenantKey: data.tenant_key };
  };
}

export class FeishuDocsAddonAuth {
  private readonly store = new MemorySessionStore();
  private readonly sessions: WebSessions;
  private readonly usedCodes = new Map<string, number>();
  private readonly origins: Set<string>;
  private readonly timer: ReturnType<typeof setInterval>;
  private inflight = 0;
  private closed = false;
  constructor(
    private readonly options: FeishuDocsAddonOptions,
    private readonly ownerFor: (openId: string) => string | undefined,
    private readonly endCredential: (owner: string, credential: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    if (!options.tenantKey?.trim() || !Array.isArray(options.allowedOrigins) || !options.allowedOrigins.length) throw new Error('Docs add-on needs an exact tenant and origin allowlist');
    this.origins = new Set(options.allowedOrigins.map((origin) => {
      const url = new URL(origin);
      if (url.origin !== origin || url.protocol !== 'https:' || url.hostname.includes('*')) throw new Error('Docs add-on origins must be exact HTTPS origins');
      return origin;
    }));
    this.sessions = new WebSessions(this.store, { idleMs: 15 * 60_000, absoluteMs: lifetime }, now);
    this.timer = setInterval(() => this.reap(), 30_000);
    this.timer.unref();
  }
  allowsOrigin(origin: string): boolean { return !this.closed && this.origins.has(origin); }
  private forget(row: Pick<ResolvedSession, 'username' | 'tokenHash'>): void {
    this.store.drop(row.tokenHash);
    // An observer derived no Session Hub Context of its own: nothing to end.
    if (row.username) this.endCredential(row.username, `feishu-docs:${row.tokenHash}`);
  }
  /** A login stays valid only while its Feishu identity maps to the same account (or still to none). */
  private mapped(row: Pick<ResolvedSession, 'username' | 'extra'>): boolean {
    return (this.ownerFor(String(row.extra?.openId)) ?? '') === row.username;
  }
  private reap(): void {
    for (const row of this.store.live()) {
      if (this.sessions.isExpired(row) || !this.mapped(row)) this.forget(row);
    }
    for (const [key, until] of this.usedCodes) if (until <= this.now()) this.usedCodes.delete(key);
  }
  async login(code: string, origin: string): Promise<{ token: string; username: string | null; expiresAt: number }> {
    if (!this.allowsOrigin(origin)) throw new DocsAddonError(403, '此卡片来源未获授权');
    if (!code || code.length > 2048) throw new DocsAddonError(400, '缺少有效的飞书登录码');
    this.reap();
    if (this.inflight >= 8 || this.store.live().length >= 512 || this.usedCodes.size >= 2048) throw new DocsAddonError(429, '连接请求过多，请稍后重试');
    const key = digest(code);
    if (this.usedCodes.has(key)) throw new DocsAddonError(401, '登录码已使用，请重新连接');
    this.usedCodes.set(key, this.now() + lifetime);
    this.inflight++;
    try {
      const user = await this.options.verifyCode(code);
      if (this.closed) throw new DocsAddonError(503, '连接服务已关闭');
      if (user.tenantKey !== this.options.tenantKey) throw new DocsAddonError(403, '此飞书组织尚未接入 Octopus');
      const username = this.ownerFor(user.openId) ?? '';
      const result = this.sessions.issue(username, { openId: user.openId, origin, tenantKey: user.tenantKey });
      return { token: `fda_${result.sessionId}`, username: username || null, expiresAt: result.expiresAt };
    } finally { this.inflight--; }
  }
  authenticate(token: string, origin: string): DocsAddonIdentity {
    if (!this.allowsOrigin(origin) || !/^fda_[0-9a-f]{64}$/.test(token)) throw new DocsAddonError(401, '请使用飞书身份重新连接');
    const row = this.sessions.resolve(token.slice(4));
    if (!row || row.extra?.origin !== origin || row.extra?.tenantKey !== this.options.tenantKey || !this.mapped(row)) {
      if (row && !this.mapped(row)) this.forget(row);
      this.reap();
      throw new DocsAddonError(401, '连接已失效，请使用飞书身份重新连接');
    }
    return { openId: String(row.extra?.openId), username: row.username || null, credential: `feishu-docs:${row.tokenHash}`, tokenHash: row.tokenHash };
  }
  assertLive(identity: DocsAddonIdentity): void {
    const row = this.store.get(identity.tokenHash);
    if (this.closed || !row || row.username !== (identity.username ?? '') || this.sessions.isExpired(row) || !this.mapped(row)) {
      if (row) this.forget(row);
      throw new DocsAddonError(401, '连接已失效，请使用飞书身份重新连接');
    }
  }
  logout(identity: DocsAddonIdentity): void { this.forget({ username: identity.username ?? '', tokenHash: identity.tokenHash }); }
  revokeOwner(owner: string): void { for (const row of this.store.live()) if (row.username === owner) this.forget(row); }
  close(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    for (const row of this.store.live()) this.forget(row);
    this.usedCodes.clear();
  }
}
