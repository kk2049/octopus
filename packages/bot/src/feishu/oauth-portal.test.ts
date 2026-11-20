import { describe, expect, it, vi } from "vitest";
import type { FeishuOAuthToken } from "../user/types.js";
import { FeishuOAuthPortal } from "./oauth-portal.js";

describe("FeishuOAuthPortal", () => {
  it("runs one device flow and persists only the final OAuth token", async () => {
    let stored: FeishuOAuthToken | undefined;
    let finish!: (token: FeishuOAuthToken) => void;
    const token = { access_token: "uat", refresh_token: "refresh", expires_at: 9_999_999, token_type: "Bearer" };
    const auth = {
      startDeviceAuth: vi.fn(async () => ({
        device_code: "dev", user_code: "ABCD", verification_uri: "https://accounts.example/device",
        verification_uri_complete: "https://accounts.example/device?code=ABCD", expires_in: 300, interval: 5,
      })),
      pollForToken: vi.fn(() => new Promise<FeishuOAuthToken>((resolve) => { finish = resolve; })),
    };
    const users = {
      getFeishuToken: () => stored,
      saveFeishuToken: async (_username: string, next: FeishuOAuthToken) => { stored = next; },
    };
    const portal = new FeishuOAuthPortal(auth as never, users, () => 1_000);
    expect(await portal.start("alice")).toMatchObject({ state: "pending", userCode: "ABCD" });
    expect(await portal.start("alice")).toMatchObject({ state: "pending" });
    expect(auth.startDeviceAuth).toHaveBeenCalledTimes(1);
    finish(token);
    await vi.waitFor(() => expect(portal.status("alice")).toEqual({ state: "connected" }));
    expect(stored).toEqual(token);
  });

  it("drops a token answer that arrives after its device flow expired", async () => {
    let now = 1_000;
    let finish!: (token: FeishuOAuthToken) => void;
    const saveFeishuToken = vi.fn(async () => undefined);
    const portal = new FeishuOAuthPortal({
      startDeviceAuth: async () => ({
        device_code: "old", user_code: "OLD", verification_uri: "https://accounts.example/device",
        expires_in: 1, interval: 1,
      }),
      pollForToken: () => new Promise<FeishuOAuthToken>((resolve) => { finish = resolve; }),
    } as never, { getFeishuToken: () => undefined, saveFeishuToken }, () => now);
    expect(await portal.start("alice")).toMatchObject({ state: "pending" });
    now = 2_001;
    finish({ access_token: "stale", refresh_token: "stale", expires_at: 9_999, token_type: "Bearer" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveFeishuToken).not.toHaveBeenCalled();
    expect(portal.status("alice")).toMatchObject({ state: "failed", error: expect.stringContaining("超时") });
  });

  it("publishes a non-approval recovery URL and clears it after reconnect", async () => {
    let stored: FeishuOAuthToken | undefined;
    let finish!: (token: FeishuOAuthToken) => void;
    const portal = new FeishuOAuthPortal({
      startDeviceAuth: async () => ({
        device_code: "dev", user_code: "CODE", verification_uri: "https://accounts.example/device",
        verification_uri_complete: "https://accounts.example/device?code=CODE", expires_in: 300, interval: 1,
      }),
      pollForToken: () => new Promise<FeishuOAuthToken>((resolve) => { finish = resolve; }),
    } as never, {
      getFeishuToken: () => stored,
      saveFeishuToken: async (_username, token) => { stored = token; },
    }, () => 1_000);

    await portal.requireReconnect("alice", "doc_read", "token expired");
    expect(portal.notice("alice")).toMatchObject({
      kind: "feishu_reauth",
      url: "https://accounts.example/device?code=CODE",
      detail: expect.stringContaining("doc_read"),
    });
    expect(portal.notice("alice")).not.toHaveProperty("approve");
    finish({ access_token: "uat", refresh_token: "refresh", expires_at: 99_999, token_type: "Bearer" });
    await vi.waitFor(() => expect(portal.notice("alice")).toBeNull());
  });

  it("forces a new consent for a saved token and never reports an expired renewal as connected", async () => {
    let now = 1_000;
    const oldToken = { access_token: "old", refresh_token: "old-refresh", expires_at: 99_999, token_type: "Bearer" };
    let stored = oldToken;
    const answers: Array<(token: FeishuOAuthToken) => void> = [];
    const startDeviceAuth = vi.fn(async () => ({
      device_code: "device", user_code: "CODE", verification_uri: "https://accounts.example/device",
      expires_in: 1, interval: 1,
    }));
    const saveFeishuToken = vi.fn(async (_owner: string, token: FeishuOAuthToken) => { stored = token; });
    const portal = new FeishuOAuthPortal({
      startDeviceAuth,
      pollForToken: () => new Promise<FeishuOAuthToken>((resolve) => { answers.push(resolve); }),
    } as never, { getFeishuToken: () => stored, saveFeishuToken }, () => now);
    expect(await portal.start("alice")).toEqual({ state: "connected" });
    expect(startDeviceAuth).not.toHaveBeenCalled();
    expect(await portal.start("alice", true)).toMatchObject({ state: "pending" });
    expect(await portal.start("alice", true)).toMatchObject({ state: "pending" });
    expect(startDeviceAuth).toHaveBeenCalledTimes(1);
    now = 2_001;
    expect(portal.status("alice")).toMatchObject({ state: "failed", error: expect.stringContaining("超时") });
    expect(stored).toBe(oldToken);
    expect(await portal.start("alice", true)).toMatchObject({ state: "pending" });
    const newToken = { ...oldToken, access_token: "new", refresh_token: "new-refresh" };
    answers[0]({ ...oldToken, access_token: "late" });
    answers[1](newToken);
    await vi.waitFor(() => expect(portal.status("alice")).toEqual({ state: "connected" }));
    expect(saveFeishuToken).toHaveBeenCalledExactlyOnceWith("alice", newToken);
  });

  it("keeps provider refusal and credential-save failure visible beside an existing grant", async () => {
    const old = { access_token: "old", refresh_token: "refresh", expires_at: 99_999, token_type: "Bearer" };
    const auth = {
      startDeviceAuth: async () => ({ device_code: "dev", user_code: "CODE", verification_uri: "https://accounts.example/device", expires_in: 300, interval: 1 }),
      pollForToken: vi.fn().mockRejectedValueOnce(new Error("授权失败: access_denied")).mockResolvedValueOnce(old),
    };
    const portal = new FeishuOAuthPortal(auth as never, {
      getFeishuToken: () => old,
      saveFeishuToken: async () => { throw new Error("disk write failed"); },
    });
    await portal.start("alice", true);
    await vi.waitFor(() => expect(portal.status("alice")).toMatchObject({ state: "failed", error: "授权失败: access_denied" }));
    await portal.start("alice", true);
    await vi.waitFor(() => expect(portal.status("alice")).toMatchObject({ state: "failed", error: expect.stringContaining("凭据保存失败") }));
  });
});
