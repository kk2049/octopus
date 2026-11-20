/**
 * Directory of Feishu chats the bot is in, plus their members — the raw
 * material the /admin page needs to onboard a person by clicking, without
 * waiting for that person to say something in a chat first (ticket #18).
 *
 * Everything here is cross-user tenant data, so it is deliberately gated at
 * the HTTP layer on `identity.admin`, not carried per-user. The class is
 * cache-first: the four Feishu APIs involved (chats list, per-chat members,
 * batch user info, tenant_access_token) each cost a round-trip and change
 * slowly. A single successful build lives for `ttlMs` (default 5 min) so a
 * page refresh does not hammer the tenant token endpoint.
 *
 * When any API fails we return an empty directory with an `error` field so
 * the page can still function as a manual onboarding console — the admin
 * can type an open_id directly. We deliberately do NOT throw; the point of
 * this page is to be reachable when things are half-broken.
 */

import { createLogger } from "../logger.js";

const FEISHU_API = "https://open.feishu.cn/open-apis";

const log = createLogger("feishu-directory");

export interface FeishuMemberInfo {
  open_id: string;
  /** Best-effort real name; falls back to whatever the chat-members API returned. */
  name?: string;
  avatar?: string;
}

export interface FeishuChatSummary {
  chat_id: string;
  name: string;
  /** Members after batch-user-info enrichment; may be empty if the members API is not authorized. */
  members: FeishuMemberInfo[];
  /** Present when this chat could not be fully loaded (e.g. missing scope). */
  error?: string;
}

export interface FeishuDirectoryResult {
  chats: FeishuChatSummary[];
  /** Global error (e.g. token failure); when set, chats is usually empty. */
  error?: string;
  built_at: string;
}

/**
 * One hit from the lookup-by-phone/email flow. `mobile`/`email` echo the
 * caller's input so the admin can see WHICH input matched — useful when a
 * mixed batch contains both formats or a typo turned into a wrong hit.
 */
export interface FeishuLookupHit {
  open_id: string;
  name?: string;
  avatar?: string;
  mobile?: string;
  email?: string;
}

export interface FeishuLookupResult {
  hits: FeishuLookupHit[];
  /** Inputs the batch endpoint returned WITHOUT a user_id — usually "no such user". */
  missing: Array<{ mobile?: string; email?: string }>;
  /** Global error (token / API refused). Hits may still be populated from earlier chunks. */
  error?: string;
}

export interface FeishuDirectoryConfig {
  appId: string;
  appSecret: string;
  /** Cache TTL for a successful build. Defaults to 5 minutes. */
  ttlMs?: number;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests. Defaults to Date.now(). */
  now?: () => number;
  /** Cap on chats to enumerate. Prevents pathological tenant sizes from stalling the page. */
  maxChats?: number;
  /** Cap on members loaded per chat. */
  maxMembersPerChat?: number;
}

interface Cached {
  at: number;
  value: FeishuDirectoryResult;
}

export class FeishuDirectory {
  private readonly cfg: Required<Omit<FeishuDirectoryConfig, "fetch" | "now">> & {
    fetch: typeof globalThis.fetch;
    now: () => number;
  };
  private cache: Cached | null = null;
  /** Coalesce concurrent builds so a page-open storm cost one Feishu round-trip cycle. */
  private inflight: Promise<FeishuDirectoryResult> | null = null;

  constructor(cfg: FeishuDirectoryConfig) {
    this.cfg = {
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      ttlMs: cfg.ttlMs ?? 5 * 60_000,
      fetch: cfg.fetch ?? globalThis.fetch,
      now: cfg.now ?? Date.now,
      maxChats: cfg.maxChats ?? 100,
      maxMembersPerChat: cfg.maxMembersPerChat ?? 200,
    };
  }

  /** Force a rebuild on the next call. Called by /admin's "刷新" button. */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Resolve mobiles/emails to open_ids via Feishu's batch_get_id endpoint,
   * then enrich with names/avatars via the same contact/users/batch call the
   * chat member enrichment uses. Reuses the `contact:user.base:readonly`
   * scope — no new app permission required.
   *
   * The point of this method is the "add-any-Feishu-user" flow on /admin:
   * an admin can onboard someone by their mobile or email without waiting for
   * them to be in a chat with the bot. batch_get_id accepts up to 50 items
   * per call, so we chunk. Empty inputs = empty result (no calls).
   */
  async lookup(inputs: { mobiles?: string[]; emails?: string[] }): Promise<FeishuLookupResult> {
    const mobiles = (inputs.mobiles ?? []).map((s) => s.trim()).filter(Boolean);
    const emails = (inputs.emails ?? []).map((s) => s.trim()).filter(Boolean);
    if (mobiles.length === 0 && emails.length === 0) return { hits: [], missing: [] };

    const token = await this.fetchAppAccessToken();
    if (!token) {
      return { hits: [], missing: [], error: "无法获取 app_access_token — 请检查 feishu.app_id/app_secret 与网络" };
    }

    const hits: FeishuLookupHit[] = [];
    const missing: Array<{ mobile?: string; email?: string }> = [];
    let globalError: string | undefined;

    // Feishu batches at most 50 identifiers per call across both fields.
    const chunkSize = 50;
    const mobileChunks: string[][] = [];
    for (let i = 0; i < mobiles.length; i += chunkSize) mobileChunks.push(mobiles.slice(i, i + chunkSize));
    const emailChunks: string[][] = [];
    for (let i = 0; i < emails.length; i += chunkSize) emailChunks.push(emails.slice(i, i + chunkSize));
    // Pair chunks up so the loop below covers both by index.
    const rounds = Math.max(mobileChunks.length, emailChunks.length);

    for (let r = 0; r < rounds; r++) {
      const mChunk = mobileChunks[r] ?? [];
      const eChunk = emailChunks[r] ?? [];
      try {
        const resp = await this.cfg.fetch(
          `${FEISHU_API}/contact/v3/users/batch_get_id?user_id_type=open_id`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ mobiles: mChunk, emails: eChunk }),
          },
        );
        const data = (await resp.json()) as {
          code?: number;
          msg?: string;
          data?: {
            user_list?: Array<{ mobile?: string; email?: string; user_id?: string }>;
          };
        };
        if (data.code !== 0) {
          globalError = `点名查询失败:${data.msg ?? data.code}`;
          continue;
        }
        for (const entry of data.data?.user_list ?? []) {
          if (entry.user_id) {
            hits.push({
              open_id: entry.user_id,
              mobile: entry.mobile || undefined,
              email: entry.email || undefined,
            });
          } else {
            missing.push({ mobile: entry.mobile || undefined, email: entry.email || undefined });
          }
        }
      } catch (err) {
        globalError = `点名查询异常:${(err as Error).message}`;
      }
    }

    if (hits.length > 0) {
      const names = await this.fetchContactNames(token, hits.map((h) => h.open_id));
      for (const h of hits) {
        const info = names.get(h.open_id);
        if (info?.name) h.name = info.name;
        if (info?.avatar) h.avatar = info.avatar;
      }
    }

    return { hits, missing, error: globalError };
  }

  async get(): Promise<FeishuDirectoryResult> {
    if (this.cache && this.cfg.now() - this.cache.at < this.cfg.ttlMs) return this.cache.value;
    if (this.inflight) return this.inflight;
    const p = this.build().finally(() => (this.inflight = null));
    this.inflight = p;
    return p;
  }

  private async build(): Promise<FeishuDirectoryResult> {
    const at = this.cfg.now();
    const built_at = new Date(at).toISOString();
    const token = await this.fetchAppAccessToken();
    if (!token) {
      const value: FeishuDirectoryResult = {
        chats: [],
        error: "无法获取 app_access_token — 请检查 feishu.app_id/app_secret 与网络",
        built_at,
      };
      this.cache = { at, value };
      return value;
    }

    const chats = await this.fetchBotChats(token);
    if (chats.error) {
      const value: FeishuDirectoryResult = { chats: [], error: chats.error, built_at };
      this.cache = { at, value };
      return value;
    }

    // Enumerate members per chat serially — Feishu tenant-level APIs rate-limit
    // aggressively and the parallel case would need bespoke backoff on top of
    // fetchLlm's chat/completions-oriented retry. Directory is user-triggered
    // and cached; sequential is fine at 100 chats × <100ms each.
    const summaries: FeishuChatSummary[] = [];
    const openIdsToLookup = new Set<string>();
    for (const c of chats.list) {
      const m = await this.fetchChatMembers(token, c.chat_id);
      summaries.push({
        chat_id: c.chat_id,
        name: c.name,
        members: m.members,
        error: m.error,
      });
      for (const mem of m.members) openIdsToLookup.add(mem.open_id);
    }

    // Enrich with real names from the contact API. This is authorization-gated
    // (`contact:user.base:readonly` app scope). When unavailable we keep the
    // names the members API already returned — those are non-empty for the bot's
    // own tenant most of the time.
    if (openIdsToLookup.size > 0) {
      const names = await this.fetchContactNames(token, [...openIdsToLookup]);
      for (const s of summaries) {
        for (const m of s.members) {
          const info = names.get(m.open_id);
          if (info?.name) m.name = info.name;
          if (info?.avatar) m.avatar = info.avatar;
        }
      }
    }

    const value: FeishuDirectoryResult = { chats: summaries, built_at };
    this.cache = { at, value };
    return value;
  }

  private async fetchAppAccessToken(): Promise<string | null> {
    try {
      const resp = await this.cfg.fetch(`${FEISHU_API}/auth/v3/app_access_token/internal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
      });
      const data = (await resp.json()) as { code?: number; app_access_token?: string; msg?: string };
      if (data.code !== 0 || !data.app_access_token) {
        log.warn({ code: data.code, msg: data.msg }, "app_access_token fetch failed");
        return null;
      }
      return data.app_access_token;
    } catch (err) {
      log.warn({ err }, "app_access_token fetch threw");
      return null;
    }
  }

  private async fetchBotChats(token: string): Promise<{ list: Array<{ chat_id: string; name: string }>; error?: string }> {
    const out: Array<{ chat_id: string; name: string }> = [];
    let pageToken = "";
    try {
      while (out.length < this.cfg.maxChats) {
        const qs = new URLSearchParams({ page_size: "50" });
        if (pageToken) qs.set("page_token", pageToken);
        const resp = await this.cfg.fetch(`${FEISHU_API}/im/v1/chats?${qs.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await resp.json()) as {
          code?: number;
          msg?: string;
          data?: { items?: Array<{ chat_id?: string; name?: string }>; has_more?: boolean; page_token?: string };
        };
        if (data.code !== 0) {
          return { list: out, error: `列出机器人所在群失败:${data.msg ?? data.code}` };
        }
        for (const item of data.data?.items ?? []) {
          if (item.chat_id) out.push({ chat_id: item.chat_id, name: item.name || "(未命名群)" });
        }
        if (!data.data?.has_more || !data.data.page_token) break;
        pageToken = data.data.page_token;
      }
      return { list: out.slice(0, this.cfg.maxChats) };
    } catch (err) {
      return { list: out, error: `列出机器人所在群异常:${(err as Error).message}` };
    }
  }

  private async fetchChatMembers(token: string, chatId: string): Promise<{ members: FeishuMemberInfo[]; error?: string }> {
    const out: FeishuMemberInfo[] = [];
    let pageToken = "";
    try {
      while (out.length < this.cfg.maxMembersPerChat) {
        const qs = new URLSearchParams({ member_id_type: "open_id", page_size: "100" });
        if (pageToken) qs.set("page_token", pageToken);
        const resp = await this.cfg.fetch(
          `${FEISHU_API}/im/v1/chats/${encodeURIComponent(chatId)}/members?${qs.toString()}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const data = (await resp.json()) as {
          code?: number;
          msg?: string;
          data?: {
            items?: Array<{ member_id?: string; name?: string; tenant_key?: string }>;
            has_more?: boolean;
            page_token?: string;
          };
        };
        if (data.code !== 0) {
          return { members: out, error: `拉群成员失败:${data.msg ?? data.code}` };
        }
        for (const item of data.data?.items ?? []) {
          if (item.member_id) out.push({ open_id: item.member_id, name: item.name || undefined });
        }
        if (!data.data?.has_more || !data.data.page_token) break;
        pageToken = data.data.page_token;
      }
      return { members: out.slice(0, this.cfg.maxMembersPerChat) };
    } catch (err) {
      return { members: out, error: `拉群成员异常:${(err as Error).message}` };
    }
  }

  private async fetchContactNames(
    token: string,
    openIds: string[],
  ): Promise<Map<string, { name?: string; avatar?: string }>> {
    const out = new Map<string, { name?: string; avatar?: string }>();
    // Feishu's batch endpoint accepts up to 50 user_ids per call.
    const chunks: string[][] = [];
    for (let i = 0; i < openIds.length; i += 50) chunks.push(openIds.slice(i, i + 50));
    for (const chunk of chunks) {
      try {
        const qs = new URLSearchParams({ user_id_type: "open_id" });
        for (const id of chunk) qs.append("user_ids", id);
        const resp = await this.cfg.fetch(`${FEISHU_API}/contact/v3/users/batch?${qs.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await resp.json()) as {
          code?: number;
          data?: { items?: Array<{ open_id?: string; name?: string; avatar?: { avatar_72?: string; avatar_240?: string } }> };
        };
        if (data.code !== 0) continue; // Skip chunk on error — partial enrichment is fine.
        for (const item of data.data?.items ?? []) {
          if (!item.open_id) continue;
          out.set(item.open_id, {
            name: item.name || undefined,
            avatar: item.avatar?.avatar_72 || item.avatar?.avatar_240 || undefined,
          });
        }
      } catch {
        // Skip this chunk — see above.
      }
    }
    return out;
  }
}
