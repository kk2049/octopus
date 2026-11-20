import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import { UserManagerImpl } from "../user/manager.js";
import { readBootstrapPayload } from "./app-page.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import type { GithubFetcher } from "./oauth-github.js";

const PUBLIC_URL = "https://bot.example.com";
const SESSION_COOKIE = "__Host-octopus_sess";
const CSRF_COOKIE = "__Host-octopus_csrf";
const STATE_COOKIE = "__Host-octopus_oauth";

interface BrowserJar {
  cookie: string;
  csrf: string;
}

function cookiePair(cookies: string[], name: string): string {
  const cookie = [...cookies].reverse().find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`missing cookie ${name}`);
  return cookie.split(";", 1)[0];
}

function cookieValue(pair: string): string {
  return pair.slice(pair.indexOf("=") + 1);
}

function sessionJar(response: Response): BrowserJar {
  const cookies = response.headers.getSetCookie();
  const session = cookiePair(cookies, SESSION_COOKIE);
  const csrf = cookiePair(cookies, CSRF_COOKIE);
  return { cookie: `${session}; ${csrf}`, csrf: cookieValue(csrf) };
}

describe("GitHub identity connections", () => {
  let dir: string;
  let store: Store;
  let users: UserManagerImpl;
  let dashboard: DashboardServer;
  let base: string;
  let alice: BrowserJar;
  let bob: BrowserJar;
  let charlie: BrowserJar;
  let lonely: BrowserJar;
  let tokened: BrowserJar;
  let tokenedBearer: string;

  const profiles: Record<string, { id: number; login: string }> = {
    alice: { id: 101, login: "alice-gh" },
    mismatch: { id: 102, login: "mismatch-gh" },
    bob: { id: 999, login: "bob-gh" },
    lonely: { id: 777, login: "lonely-gh" },
    tokened: { id: 888, login: "tokened-gh" },
  };
  const githubFetcher: GithubFetcher = async (input, init) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
      return new Response(JSON.stringify({ access_token: `access-${code}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://api.github.com/user") {
      const authorization = (init?.headers as Record<string, string>).authorization;
      const profile = profiles[authorization.replace(/^Bearer access-/, "")];
      return profile
        ? new Response(JSON.stringify(profile), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("missing", { status: 404 });
    }
    return new Response("unexpected", { status: 500 });
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "github-connections-"));
    store = new Store(path.join(dir, "bot.db"));
    users = new UserManagerImpl(store, dir);
    await users.register("alice", { provider: "cli", externalId: "cli-alice", label: "Alice CLI" });
    await users.register("bob", { provider: "github", externalId: "999", label: "bob-gh" });
    await users.register("charlie", { provider: "cli", externalId: "cli-charlie", label: "Charlie CLI" });
    await users.register("lonely", { provider: "github", externalId: "777", label: "lonely-gh" });
    await users.register("tokened", { provider: "github", externalId: "888", label: "tokened-gh" });

    const aliceBearer = mintDashboardToken(store, "alice");
    const charlieBearer = mintDashboardToken(store, "charlie");
    tokenedBearer = mintDashboardToken(store, "tokened");
    dashboard = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: "admin-secret",
      publicUrl: PUBLIC_URL,
      oauthGithub: { clientId: "client-id", clientSecret: "client-secret" },
      registration: "closed",
      userManager: users,
      githubFetcher,
    });
    await dashboard.start();
    base = `http://127.0.0.1:${dashboard.port}`;

    alice = await loginWithBearer(aliceBearer);
    charlie = await loginWithBearer(charlieBearer);
    // Keep these sessions, but remove their dt_ recovery path so the tests can
    // distinguish "another identity" from "a dashboard token exists".
    expect(store.deleteDashboardToken("alice")).toBe(true);
    expect(store.deleteDashboardToken("charlie")).toBe(true);
    bob = await loginWithGithub("bob");
    lonely = await loginWithGithub("lonely");
    tokened = await loginWithGithub("tokened");
  });

  afterAll(async () => {
    await dashboard.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function loginWithBearer(token: string): Promise<BrowserJar> {
    const response = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: PUBLIC_URL },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(303);
    return sessionJar(response);
  }

  async function loginWithGithub(code: string): Promise<BrowserJar> {
    const start = await fetch(`${base}/auth/github`, { redirect: "manual" });
    expect(start.status).toBe(303);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = cookiePair(start.headers.getSetCookie(), STATE_COOKIE);
    const callback = await fetch(
      `${base}/auth/github/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
      { redirect: "manual", headers: { cookie: stateCookie } },
    );
    expect(callback.status).toBe(303);
    return sessionJar(callback);
  }

  async function post(pathname: string, jar: BrowserJar, body: unknown): Promise<Response> {
    return await fetch(base + pathname, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        origin: PUBLIC_URL,
        cookie: jar.cookie,
        "x-csrf-token": jar.csrf,
      },
      body: JSON.stringify(body),
    });
  }

  async function connectionStart(jar: BrowserJar, username: string): Promise<{ state: string; cookie: string }> {
    const response = await post("/api/connections/github/start", jar, { username });
    expect(response.status).toBe(200);
    const body = await response.json() as { authorize_url: string };
    return {
      state: new URL(body.authorize_url).searchParams.get("state")!,
      cookie: cookiePair(response.headers.getSetCookie(), STATE_COOKIE),
    };
  }

  async function connectionCallback(
    jar: BrowserJar,
    attempt: { state: string; cookie: string },
    code: string,
  ): Promise<Response> {
    return await fetch(
      `${base}/auth/github/callback?state=${encodeURIComponent(attempt.state)}&code=${encodeURIComponent(code)}`,
      { redirect: "manual", headers: { cookie: `${jar.cookie}; ${attempt.cookie}` } },
    );
  }

  async function list(jar: BrowserJar): Promise<{
    connections: Array<{ connection_id: string; provider: string; label: string | null; created_at: string | null }>;
  }> {
    const response = await fetch(`${base}/api/connections`, { headers: { cookie: jar.cookie } });
    expect(response.status).toBe(200);
    return await response.json() as {
      connections: Array<{ connection_id: string; provider: string; label: string | null; created_at: string | null }>;
    };
  }

  it("requires a browser session and refuses a different body owner", async () => {
    const bearer = await fetch(`${base}/api/connections/github/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenedBearer}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "tokened" }),
    });
    expect(bearer.status).toBe(403);

    const otherOwner = await post("/api/connections/github/start", alice, { username: "bob" });
    expect(otherOwner.status).toBe(403);
    expect(await otherOwner.json()).toMatchObject({ error: expect.stringContaining("本人") });
  });

  it("consumes but refuses a connect state under a different current session", async () => {
    const attempt = await connectionStart(alice, "alice");
    const response = await connectionCallback(bob, attempt, "mismatch");
    expect(response.status).toBe(403);
    expect(readBootstrapPayload(await response.text())).toMatchObject({
      page: "page.permissions",
      pageProps: {
        owner: "bob",
        connectionMessage: { kind: "err", text: expect.stringContaining("不一致") },
      },
    });
    expect(users.resolve("github", "102")).toBeUndefined();
  });

  it("refuses a GitHub identity already bound to another account", async () => {
    const attempt = await connectionStart(alice, "alice");
    const response = await connectionCallback(alice, attempt, "bob");
    expect(response.status).toBe(409);
    expect(readBootstrapPayload(await response.text()).pageProps).toMatchObject({
      connectionMessage: { kind: "err", text: expect.stringContaining("其他账号") },
    });
    expect(users.resolve("github", "999")?.username).toBe("bob");
  });

  it("binds, lists without external ids, unbinds with another identity, and makes the id reusable", async () => {
    const attempt = await connectionStart(alice, "alice");
    const callback = await connectionCallback(alice, attempt, "alice");
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/permissions#connections");
    expect(users.resolve("github", "101")?.username).toBe("alice");

    const listed = await list(alice);
    const github = listed.connections.find((connection) => connection.provider === "github")!;
    expect(github).toMatchObject({ label: "alice-gh", created_at: expect.any(String) });
    expect(github.connection_id).toMatch(/^[a-f0-9]{64}$/);
    expect(github).not.toHaveProperty("external_id");
    expect(Object.values(github)).not.toContain("101");

    const removed = await post("/api/connections/unbind", alice, {
      username: "alice",
      connection_id: github.connection_id,
    });
    expect(removed.status).toBe(200);
    expect(users.resolve("github", "101")).toBeUndefined();
    expect(store.resolveIdentity("github", "101")).toBeUndefined();

    const rebound = await connectionCallback(
      charlie,
      await connectionStart(charlie, "charlie"),
      "alice",
    );
    expect(rebound.status).toBe(303);
    expect(users.resolve("github", "101")?.username).toBe("charlie");
  });

  it("refuses to remove the last identity when no dashboard token exists", async () => {
    expect(store.hasDashboardToken("lonely")).toBe(false);
    const github = (await list(lonely)).connections.find((connection) => connection.provider === "github")!;
    const response = await post("/api/connections/unbind", lonely, {
      username: "lonely",
      connection_id: github.connection_id,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("最后一个") });
    expect(users.resolve("github", "777")?.username).toBe("lonely");
  });

  it("allows the final identity to be removed when a dashboard token exists", async () => {
    expect(store.hasDashboardToken("tokened")).toBe(true);
    const github = (await list(tokened)).connections.find((connection) => connection.provider === "github")!;
    const response = await post("/api/connections/unbind", tokened, {
      username: "tokened",
      connection_id: github.connection_id,
    });
    expect(response.status).toBe(200);
    expect(users.resolve("github", "888")).toBeUndefined();
    expect((await list(tokened)).connections).toEqual([]);
  });
});
