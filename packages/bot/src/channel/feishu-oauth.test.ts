import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { FeishuAuthManager } from "./feishu-oauth.js";
import type { UserManager } from "../user/types.js";

afterEach(() => { vi.unstubAllGlobals(); });

it("spends a single-use refresh token once, however many callers race for a fresh user token", async () => {
  let stored = { access_token: "old", refresh_token: "r1", expires_at: Date.now() - 1, scope: "docx:document" };
  const saves: unknown[] = [];
  const users = {
    getFeishuToken: () => stored,
    saveFeishuToken: async (_user: string, token: typeof stored) => { saves.push(token); stored = token; },
  } as unknown as UserManager;
  const refreshes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    refreshes.push(JSON.parse(String(init.body)).refresh_token);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ code: 0, access_token: "new", refresh_token: "r2", expires_in: 7200, token_type: "Bearer" }));
  }));
  const auth = new FeishuAuthManager({ appId: "cli_x", appSecret: "s" }, users);
  const tokens = await Promise.all([auth.getUserToken("lht"), auth.getUserToken("lht"), auth.getUserToken("lht")]);
  expect(tokens).toEqual(["new", "new", "new"]);
  expect(refreshes).toEqual(["r1"]);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ access_token: "new", refresh_token: "r2", scope: "docx:document" });
  expect(await auth.getUserToken("lht")).toBe("new");
  expect(refreshes).toEqual(["r1"]);
});

it("refreshes a device-flow token at the v2 endpoint that issued it, with the app's own credentials", async () => {
  const stored = { access_token: "old", refresh_token: "r1", expires_at: Date.now() - 1, scope: "docx:document" };
  const users = { getFeishuToken: () => stored, saveFeishuToken: async () => {} } as unknown as UserManager;
  const calls: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization });
    return new Response(JSON.stringify({ code: 0, access_token: "new", refresh_token: "r2", expires_in: 7200, scope: "docx:document offline_access" }));
  }));
  const auth = new FeishuAuthManager({ appId: "cli_x", appSecret: "s" }, users);
  expect(await auth.getUserToken("lht")).toBe("new");
  expect(calls).toEqual([{
    url: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
    body: { grant_type: "refresh_token", client_id: "cli_x", client_secret: "s", refresh_token: "r1" },
    auth: undefined,
  }]);
});

it("reports a refused refresh as no token rather than a stale one", async () => {
  const stored = { access_token: "old", refresh_token: "r1", expires_at: Date.now() - 1 };
  const users = { getFeishuToken: () => stored, saveFeishuToken: async () => { throw new Error("must not save"); } } as unknown as UserManager;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: 20064, error: "invalid_grant" }), { status: 400 })));
  const auth = new FeishuAuthManager({ appId: "cli_x", appSecret: "s" }, users);
  expect(await auth.getUserToken("lht")).toBeNull();
});

it("asks only for baseline scopes the app has enabled for user tokens, and for the whole baseline when it cannot tell", async () => {
  const users = { getFeishuToken: () => undefined, saveFeishuToken: async () => {} } as unknown as UserManager;
  const asked: string[] = [];
  let appInfo: unknown = { code: 0, data: { app: { scopes: [
    { scope: "offline_access", token_types: ["user"] },
    { scope: "docx:document", token_types: ["user", "tenant"] },
    { scope: "im:message:send_as_bot", token_types: ["tenant"] },
  ] } } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/tenant_access_token/internal")) return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-1" }));
    if (url.includes("/application/v6/applications/cli_x")) {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer t-1");
      return new Response(JSON.stringify(appInfo));
    }
    asked.push(JSON.parse(String(init?.body)).scope);
    return new Response(JSON.stringify({ device_code: "d", user_code: "u", verification_uri: "v", verification_uri_complete: "vc", expires_in: 600, interval: 5 }));
  }));
  const auth = new FeishuAuthManager({ appId: "cli_x", appSecret: "s" }, users);
  const baseline = (JSON.parse(readFileSync(new URL("../../../../config/feishu_scopes.json", import.meta.url), "utf8")) as { scopes: { user: string[] } }).scopes.user;
  expect(baseline).toEqual(expect.arrayContaining(["offline_access", "docx:document", "slides:presentation:read", "slides:presentation:screenshot"]));
  expect((await auth.startDeviceAuth()).scope).toBe("offline_access docx:document");
  appInfo = { code: 99991663, msg: "no permission" };
  await auth.startDeviceAuth();
  expect(asked).toEqual(["offline_access docx:document", baseline.join(" ")]);
});
