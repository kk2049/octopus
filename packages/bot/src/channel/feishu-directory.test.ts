/**
 * Directory cache + graceful degradation. The Feishu APIs involved are all
 * scope-gated, so the interesting behaviour is not "when everything works"
 * but "when some part refuses" — the /admin page should still render
 * something the admin can act on.
 */
import { describe, it, expect } from "vitest";
import { FeishuDirectory } from "./feishu-directory.js";

/** A tiny router keyed on request URL. Falls through to a 500. */
type RouteBody = { code: number; [k: string]: unknown };
function routeFetch(routes: Record<string, () => RouteBody>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    // Pick the first route whose key is a prefix of the requested URL.
    for (const [prefix, fn] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        const r = fn();
        return { ok: true, status: 200, json: async () => r } as unknown as Response;
      }
    }
    return { ok: false, status: 500, json: async () => ({ code: 500, msg: "no route" }) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

describe("FeishuDirectory", () => {
  it("caches a successful build for the ttl, coalescing concurrent callers", async () => {
    const { impl, calls } = routeFetch({
      [`https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal`]: () => ({
        code: 0, app_access_token: "at_abc",
      }),
      [`https://open.feishu.cn/open-apis/im/v1/chats?`]: () => ({
        code: 0, data: { items: [{ chat_id: "oc_1", name: "研究群" }], has_more: false },
      }),
      [`https://open.feishu.cn/open-apis/im/v1/chats/oc_1/members?`]: () => ({
        code: 0, data: {
          items: [
            { member_id: "ou_a", name: "Alice" },
            { member_id: "ou_b", name: "Bob" },
          ],
          has_more: false,
        },
      }),
      [`https://open.feishu.cn/open-apis/contact/v3/users/batch?`]: () => ({
        code: 0, data: {
          items: [
            { open_id: "ou_a", name: "Alice Chen", avatar: { avatar_72: "https://x/a72" } },
            // Bob missing — enrichment is best-effort; the members-API name survives.
          ],
        },
      }),
    });
    let clock = 0;
    const dir = new FeishuDirectory({ appId: "cli_x", appSecret: "s", ttlMs: 60_000, fetch: impl, now: () => clock });

    const [a, b] = await Promise.all([dir.get(), dir.get()]);
    expect(a).toBe(b); // coalesced
    expect(a.chats).toHaveLength(1);
    expect(a.chats[0].name).toBe("研究群");
    expect(a.chats[0].members.map((m) => m.name)).toEqual(["Alice Chen", "Bob"]);
    expect(a.chats[0].members[0].avatar).toBe("https://x/a72");
    const firstRun = calls.length;

    // Within TTL — no new calls, exact same value.
    clock = 30_000;
    const cached = await dir.get();
    expect(cached).toBe(a);
    expect(calls.length).toBe(firstRun);

    // Past TTL — a rebuild fires.
    clock = 70_000;
    await dir.get();
    expect(calls.length).toBeGreaterThan(firstRun);
  });

  it("degrades gracefully when app_access_token cannot be fetched", async () => {
    const { impl } = routeFetch({
      [`https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal`]: () => ({
        code: 99991663, msg: "invalid app_secret",
      }),
    });
    const dir = new FeishuDirectory({ appId: "cli_x", appSecret: "bad", fetch: impl, now: () => 0 });
    const r = await dir.get();
    expect(r.chats).toEqual([]);
    expect(r.error).toContain("app_access_token");
  });

  it("keeps rendering when the chats API is scope-refused", async () => {
    const { impl } = routeFetch({
      [`https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal`]: () => ({
        code: 0, app_access_token: "at_abc",
      }),
      [`https://open.feishu.cn/open-apis/im/v1/chats?`]: () => ({
        code: 99991672, msg: "app has no permission",
      }),
    });
    const dir = new FeishuDirectory({ appId: "cli_x", appSecret: "s", fetch: impl, now: () => 0 });
    const r = await dir.get();
    expect(r.chats).toEqual([]);
    expect(r.error).toContain("列出机器人所在群失败");
  });

  it("keeps a chat visible even when its members API refuses", async () => {
    const { impl } = routeFetch({
      [`https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal`]: () => ({
        code: 0, app_access_token: "at_abc",
      }),
      [`https://open.feishu.cn/open-apis/im/v1/chats?`]: () => ({
        code: 0, data: {
          items: [
            { chat_id: "oc_1", name: "研究群" },
            { chat_id: "oc_2", name: "运维群" },
          ],
          has_more: false,
        },
      }),
      [`https://open.feishu.cn/open-apis/im/v1/chats/oc_1/members?`]: () => ({
        code: 99991672, msg: "no member permission for this chat",
      }),
      [`https://open.feishu.cn/open-apis/im/v1/chats/oc_2/members?`]: () => ({
        code: 0, data: { items: [{ member_id: "ou_c", name: "Chen" }], has_more: false },
      }),
      [`https://open.feishu.cn/open-apis/contact/v3/users/batch?`]: () => ({
        code: 99991672, msg: "no contact permission",
      }),
    });
    const dir = new FeishuDirectory({ appId: "cli_x", appSecret: "s", fetch: impl, now: () => 0 });
    const r = await dir.get();
    expect(r.chats.map((c) => c.chat_id)).toEqual(["oc_1", "oc_2"]);
    expect(r.chats[0].members).toEqual([]);
    expect(r.chats[0].error).toContain("拉群成员失败");
    // Contact enrichment refused: name survives from the members API.
    expect(r.chats[1].members[0].name).toBe("Chen");
    // No global error — the page still functions.
    expect(r.error).toBeUndefined();
  });

  it("respects the chat/member caps to survive pathological tenant sizes", async () => {
    const chatItems = Array.from({ length: 20 }, (_, i) => ({ chat_id: `oc_${i}`, name: `群 ${i}` }));
    const memberItems = Array.from({ length: 30 }, (_, i) => ({ member_id: `ou_${i}`, name: `人 ${i}` }));
    const { impl } = routeFetch({
      [`https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal`]: () => ({
        code: 0, app_access_token: "at_abc",
      }),
      [`https://open.feishu.cn/open-apis/im/v1/chats?`]: () => ({
        code: 0, data: { items: chatItems, has_more: false },
      }),
      [`https://open.feishu.cn/open-apis/im/v1/chats/`]: () => ({
        code: 0, data: { items: memberItems, has_more: false },
      }),
      [`https://open.feishu.cn/open-apis/contact/v3/users/batch?`]: () => ({
        code: 0, data: { items: [] },
      }),
    });
    const dir = new FeishuDirectory({
      appId: "cli_x", appSecret: "s", fetch: impl, now: () => 0,
      maxChats: 5, maxMembersPerChat: 3,
    });
    const r = await dir.get();
    expect(r.chats).toHaveLength(5);
    for (const c of r.chats) expect(c.members).toHaveLength(3);
  });

  it("looks up open_ids by mobile and email, enriching with contact names", async () => {
    const { impl, calls } = routeFetch({
      [`https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal`]: () => ({
        code: 0, app_access_token: "at_abc",
      }),
      [`https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?`]: () => ({
        code: 0, data: { user_list: [
          { mobile: "13800000001", user_id: "ou_alice" },
          { email: "bob@x.com", user_id: "ou_bob" },
          { mobile: "13800009999" }, // missing
        ] },
      }),
      [`https://open.feishu.cn/open-apis/contact/v3/users/batch?`]: () => ({
        code: 0, data: {
          items: [
            { open_id: "ou_alice", name: "Alice Chen", avatar: { avatar_72: "https://x/a72" } },
            { open_id: "ou_bob", name: "Bob Wu" },
          ],
        },
      }),
    });
    const dir = new FeishuDirectory({ appId: "cli_x", appSecret: "s", fetch: impl, now: () => 0 });
    const r = await dir.lookup({ mobiles: ["13800000001", "13800009999"], emails: ["bob@x.com"] });
    expect(r.hits.map((h) => h.open_id)).toEqual(["ou_alice", "ou_bob"]);
    expect(r.hits[0].name).toBe("Alice Chen");
    expect(r.hits[0].avatar).toBe("https://x/a72");
    expect(r.hits[0].mobile).toBe("13800000001");
    expect(r.hits[1].email).toBe("bob@x.com");
    expect(r.missing).toEqual([{ mobile: "13800009999" }]);
    expect(r.error).toBeUndefined();
    // No API call was made when there was nothing to look up? Sanity — we did call.
    expect(calls.some((u) => u.includes("batch_get_id"))).toBe(true);
  });

  it("lookup returns an error string when the batch endpoint refuses (scope missing)", async () => {
    const { impl } = routeFetch({
      [`https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal`]: () => ({
        code: 0, app_access_token: "at_abc",
      }),
      [`https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?`]: () => ({
        code: 99991672, msg: "app has no contact permission",
      }),
    });
    const dir = new FeishuDirectory({ appId: "cli_x", appSecret: "s", fetch: impl, now: () => 0 });
    const r = await dir.lookup({ emails: ["alice@x.com"] });
    expect(r.hits).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.error).toContain("点名查询失败");
  });

  it("lookup short-circuits when both inputs are empty", async () => {
    const { impl, calls } = routeFetch({});
    const dir = new FeishuDirectory({ appId: "cli_x", appSecret: "s", fetch: impl, now: () => 0 });
    const r = await dir.lookup({ mobiles: ["   "], emails: [] });
    expect(r).toEqual({ hits: [], missing: [] });
    expect(calls.length).toBe(0);
  });

  it("invalidate() forces a fresh rebuild on the next get()", async () => {
    let chatName = "群 v1";
    const { impl, calls } = routeFetch({
      [`https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal`]: () => ({
        code: 0, app_access_token: "at_abc",
      }),
      [`https://open.feishu.cn/open-apis/im/v1/chats?`]: () => ({
        code: 0, data: { items: [{ chat_id: "oc_1", name: chatName }], has_more: false },
      }),
      [`https://open.feishu.cn/open-apis/im/v1/chats/oc_1/members?`]: () => ({
        code: 0, data: { items: [], has_more: false },
      }),
    });
    const dir = new FeishuDirectory({ appId: "cli_x", appSecret: "s", ttlMs: 1_000_000, fetch: impl, now: () => 0 });
    const first = await dir.get();
    expect(first.chats[0].name).toBe("群 v1");

    chatName = "群 v2";
    // Without invalidate, TTL keeps v1.
    expect((await dir.get()).chats[0].name).toBe("群 v1");
    const before = calls.length;
    dir.invalidate();
    expect((await dir.get()).chats[0].name).toBe("群 v2");
    expect(calls.length).toBeGreaterThan(before);
  });
});
