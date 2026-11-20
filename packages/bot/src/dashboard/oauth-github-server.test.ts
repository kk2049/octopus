import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import { UserManagerImpl } from "../user/manager.js";
import { readBootstrapPayload } from "./app-page.js";
import { DashboardServer, type Capabilities } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import type { GithubFetcher } from "./oauth-github.js";

const PUBLIC_URL = "https://bot.example.com";

function cookiePair(cookies: string[], name: string): string {
  // A failed registration clears the consumed cookie and then rotates a fresh
  // one under the same name. Browsers apply Set-Cookie in order, so the last
  // matching value is the jar state that the next request carries.
  const cookie = [...cookies].reverse().find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`missing cookie ${name}`);
  return cookie.split(";", 1)[0];
}

function stateFrom(response: Response): { state: string; cookie: string } {
  const location = response.headers.get("location");
  if (!location) throw new Error("missing authorize redirect");
  const state = new URL(location).searchParams.get("state");
  if (!state) throw new Error("missing state");
  return { state, cookie: cookiePair(response.headers.getSetCookie(), "__Host-octopus_oauth") };
}

describe("Dashboard GitHub OAuth login and registration", () => {
  let dir: string;
  let store: Store;
  let users: UserManagerImpl;
  let open: DashboardServer;
  let closed: DashboardServer;
  let disabled: DashboardServer;
  let openBase: string;
  let closedBase: string;
  let disabledBase: string;

  const githubFetcher: GithubFetcher = async (input, init) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
      if (code === "bad") return new Response("denied", { status: 401 });
      return new Response(JSON.stringify({ access_token: `token-${code}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://api.github.com/user") {
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
      const code = authorization.replace(/^Bearer token-/, "");
      const profiles: Record<string, { id: number; login: string }> = {
        bound: { id: 101, login: "alice-gh" },
        new: { id: 202, login: "new-gh" },
      };
      const profile = profiles[code];
      return profile
        ? new Response(JSON.stringify(profile), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("missing", { status: 404 });
    }
    return new Response("unexpected", { status: 500 });
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "github-oauth-"));
    store = new Store(path.join(dir, "bot.db"));
    users = new UserManagerImpl(store, dir);
    await users.register("alice", { provider: "github", externalId: "101", label: "alice-gh" });
    await users.register("taken", { provider: "cli", externalId: "cli-taken" });

    const common = {
      port: 0,
      host: "127.0.0.1",
      authToken: "admin-secret",
      publicUrl: PUBLIC_URL,
      oauthGithub: { clientId: "client-id", clientSecret: "client-secret" },
      userManager: users,
      githubFetcher,
    } as const;
    open = createDashboardTestServer(store, undefined, { ...common, registration: "open" });
    closed = createDashboardTestServer(store, undefined, { ...common, registration: "closed" });
    disabled = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: "admin-secret",
      publicUrl: "http://127.0.0.1:9820",
      oauthGithub: common.oauthGithub,
      userManager: users,
      githubFetcher,
    });
    await open.start();
    await closed.start();
    await disabled.start();
    openBase = `http://127.0.0.1:${open.port}`;
    closedBase = `http://127.0.0.1:${closed.port}`;
    disabledBase = `http://127.0.0.1:${disabled.port}`;
  });

  afterAll(async () => {
    await open.stop();
    await closed.stop();
    await disabled.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(base: string, next = ""): Promise<{ state: string; cookie: string }> {
    const response = await fetch(`${base}/auth/github${next ? `?next=${encodeURIComponent(next)}` : ""}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    const stateCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-octopus_oauth="));
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("Path=/");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain("Max-Age=600");
    expect(stateCookie).toContain("Secure");
    return stateFrom(response);
  }

  async function callback(
    base: string,
    input: { state: string; cookie?: string; code: string },
  ): Promise<Response> {
    return await fetch(`${base}/auth/github/callback?state=${encodeURIComponent(input.state)}&code=${input.code}`, {
      redirect: "manual",
      headers: input.cookie ? { cookie: input.cookie } : undefined,
    });
  }

  it("404s the whole OAuth surface without an https public_url", async () => {
    const response = await fetch(`${disabledBase}/auth/github`, { redirect: "manual" });
    expect(response.status).toBe(404);
    const login = readBootstrapPayload(await (await fetch(`${disabledBase}/login`)).text());
    expect(login.pageProps).toMatchObject({ githubEnabled: false });
  });

  it("consumes state before rejecting a missing or wrong browser cookie", async () => {
    const attempt = await start(openBase);
    const missing = await callback(openBase, { state: attempt.state, code: "bound" });
    expect(missing.status).toBe(400);
    expect(readBootstrapPayload(await missing.text()).pageProps).toMatchObject({
      reason: expect.stringContaining("当前浏览器不匹配"),
    });
    expect(missing.headers.getSetCookie().join("\n")).toContain("__Host-octopus_oauth=; ");

    // The cookie cannot make the already-consumed state valid on a retry.
    const retry = await callback(openBase, { ...attempt, code: "bound" });
    expect(retry.status).toBe(400);
    expect(readBootstrapPayload(await retry.text()).pageProps).toMatchObject({
      reason: expect.stringContaining("无效或已过期"),
    });
  });

  it("renders a stable error when code exchange fails", async () => {
    const attempt = await start(openBase);
    const response = await callback(openBase, { ...attempt, code: "bad" });
    expect(response.status).toBe(502);
    expect(readBootstrapPayload(await response.text()).pageProps).toMatchObject({
      reason: "GitHub 登录失败，请重试",
    });
  });

  it("signs an already-bound identity into the shared session path", async () => {
    const attempt = await start(openBase, "/permissions?mine=1#connections");
    const response = await callback(openBase, { ...attempt, code: "bound" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/permissions?mine=1#connections");
    const cookies = response.headers.getSetCookie();
    const session = cookiePair(cookies, "__Host-octopus_sess");
    expect(cookies.join("\n")).toContain("__Host-octopus_csrf=");
    expect(cookies.join("\n")).not.toContain("token-bound");
    const identified = await fetch(`${openBase}/api/overview`, { headers: { cookie: session } });
    expect(identified.status).toBe(200);
    expect(await identified.json()).toMatchObject({ viewer: { username: "alice" } });
  });

  it("sanitizes an OAuth next target before storing it", async () => {
    const attempt = await start(openBase, "//evil.example/path");
    const response = await callback(openBase, { ...attempt, code: "bound" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  });

  it("refuses an unbound identity while registration is closed", async () => {
    const attempt = await start(closedBase);
    const response = await callback(closedBase, { ...attempt, code: "new" });
    expect(response.status).toBe(403);
    expect(readBootstrapPayload(await response.text()).pageProps).toMatchObject({
      reason: expect.stringContaining("未开放注册"),
    });
  });

  it("registers an unbound identity, retries a conflict, and issues a working session", async () => {
    const attempt = await start(openBase);
    const callbackResponse = await callback(openBase, { ...attempt, code: "new" });
    expect(callbackResponse.status).toBe(303);
    expect(callbackResponse.headers.get("location")).toBe("/register");
    let registration = cookiePair(
      callbackResponse.headers.getSetCookie(),
      "__Host-octopus_registration",
    );

    const page = await fetch(`${openBase}/register`, { headers: { cookie: registration } });
    expect(page.status).toBe(200);
    expect(readBootstrapPayload(await page.text())).toMatchObject({
      page: "pre.register",
      pageProps: { label: "new-gh", error: null },
    });

    const crossSite = await fetch(`${openBase}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", cookie: registration },
      body: JSON.stringify({ username: "newuser" }),
    });
    expect(crossSite.status).toBe(403);

    const conflict = await fetch(`${openBase}/auth/register`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: PUBLIC_URL, cookie: registration },
      body: JSON.stringify({ username: "taken" }),
    });
    expect(conflict.status).toBe(400);
    expect(await conflict.json()).toEqual({ error: '用户名 "taken" 已被使用' });
    registration = cookiePair(conflict.headers.getSetCookie(), "__Host-octopus_registration");

    const success = await fetch(`${openBase}/auth/register`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: PUBLIC_URL, cookie: registration },
      body: JSON.stringify({ username: "newuser" }),
    });
    expect(success.status).toBe(303);
    const cookies = success.headers.getSetCookie();
    const session = cookiePair(cookies, "__Host-octopus_sess");
    expect(store.getIdentitiesByUser("newuser")).toEqual([
      expect.objectContaining({ provider: "github", external_id: "202", label: "new-gh" }),
    ]);
    expect(existsSync(path.join(dir, "users", "newuser", "workspace"))).toBe(true);
    expect(users.resolve("github", "202")?.username).toBe("newuser");
    expect(await fetch(`${openBase}/api/overview`, { headers: { cookie: session } })).toMatchObject({ status: 200 });

    const capabilities = (open as unknown as { capabilitiesFor(username: string): Capabilities })
      .capabilitiesFor("newuser");
    expect(capabilities).toEqual({
      username: "newuser",
      admin: false,
      dev: false,
      deploy: false,
      contribute: false,
    });
    const databaseText = readFileSync(path.join(dir, "bot.db")).toString("utf8");
    expect(databaseText).not.toContain("client-secret");
    expect(databaseText).not.toContain("token-new");
  });
});
