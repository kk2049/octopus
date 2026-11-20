import { runnerDisplayName } from "../runner/display-name.js";
import { runnerOnlineNotice } from "../runner/online-notice.js";
/**
 * Dashboard v2: cookie login, per-user dt_ keys and scoping, the transcript
 * viewer backend (/api/sessions*), and the owner-only append rules. Uses a
 * real Store + a real on-disk claude session fixture; gateway stays undefined
 * so the local (bot-host) source path is what's exercised.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readBootstrapPayload } from "./app-page.js";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { DashboardServer, mintDashboardToken, BOT_HOST_DEVICE } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import type { RunnerCapabilities } from "../runner/capability.js";

/** POST the login exchange the way the page does (no credential in the URL). */
async function loginPost(base: string, token: string, next?: string): Promise<Response> {
  return await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ token, ...(next ? { next } : {}) }),
  });
}


const NOW = "2026-07-22T10:00:00.000Z";
const SESSION_ID = "ab12cd34-1111-2222-3333-444455556666";
const ADMIN = "admin-secret";

describe("dashboard sessions + identity", () => {
  let dir: string;
  let home: string;
  let store: Store;
  let dash: DashboardServer;
  let base: string;
  let dtAlice: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dashv2-"));
    home = join(dir, "alice-home");
    const proj = join(home, ".claude", "projects", "-work-proj");
    mkdirSync(proj, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "user", sessionId: SESSION_ID, cwd: "/work/proj", timestamp: "2026-07-22T09:00:00.000Z",
        message: { role: "user", content: "排查登录 bug" },
      }),
      JSON.stringify({
        type: "assistant", timestamp: "2026-07-22T09:00:05.000Z",
        message: { role: "assistant", content: [
          { type: "text", text: "我先看日志" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "grep err log" } },
        ] },
      }),
      JSON.stringify({
        type: "user", timestamp: "2026-07-22T09:00:06.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ERR token expired" }] },
      }),
      JSON.stringify({
        type: "assistant", timestamp: "2026-07-22T09:00:10.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "已修复:token 过期未刷新" }] },
      }),
    ];
    writeFileSync(join(proj, `${SESSION_ID}.jsonl`), lines.join("\n"));

    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/b", created_at: NOW });
    dtAlice = mintDashboardToken(store, "alice");

    dash = createDashboardTestServer(store, undefined, {
      port: 0, host: "127.0.0.1", authToken: ADMIN, runnerWsPort: 9910,
      scanHomeFor: (u) => (u === "alice" ? home : undefined),
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterAll(async () => {
    await dash.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const asAlice = { authorization: `Bearer ${""}` }; // placeholder; real calls use query token
  void asAlice;

  it("dt_ key mint replaces the previous one", () => {
    const again = mintDashboardToken(store, "alice");
    expect(again).toMatch(/^dt_[0-9a-f]{32}$/);
    // old key row gone, new one resolves
    dtAlice = again;
  });

  it("login with a personal key: 303 to the available Overview + an opaque server session", async () => {
    const res = await loginPost(base, dtAlice);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    // The bearer buys a session; it does not become the cookie any more —
    // stealing the cookie no longer steals a long-lived credential, and the
    // old cookie is actively cleared.
    expect(cookie).not.toContain(dtAlice);
    expect(cookie).toMatch(/octopus_sess=[0-9a-f]{64}; HttpOnly/);
    expect(cookie).toMatch(/octopus_csrf=[0-9a-f]{64}/);
    // Retired names are cleared in the same response. This panel has no
    // `public_url`, so it is on the plain-http development contract and the
    // retired set is the `__Host-` pair plus the pre-session bearer cookie;
    // `cookie-contract.test.ts` pins the https direction. Clearing is matched
    // by name and path, so the flags a live cookie carries are not part of it.
    for (const dead of ["octopus_dash", "__Host-octopus_sess", "__Host-octopus_csrf"]) {
      expect(cookie, dead).toContain(`${dead}=; Path=/; SameSite=Lax; Max-Age=0`);
    }
    expect(cookie).toContain("SameSite=Lax");

    // And that session authenticates on its own.
    const sid = /octopus_sess=([0-9a-f]{64})/.exec(cookie)![1];
    const viaSession = await fetch(`${base}/api/overview`, { headers: { cookie: `octopus_sess=${sid}` } });
    expect(viaSession.status).toBe(200);

    // next= steers the landing page, including query/hash, but only to a
    // same-origin path. Backslashes are URL separators in browsers and must
    // not smuggle an external host past the apparent leading slash.
    const withNext = await loginPost(base, dtAlice, "/tickets?mine=1#approvals");
    expect(withNext.headers.get("location")).toBe("/tickets?mine=1#approvals");
    const evil = await loginPost(base, dtAlice, "//evil.example.com");
    expect(evil.headers.get("location")).toBe("/");
    const backslash = await loginPost(base, dtAlice, "/\\evil.example.com");
    expect(backslash.headers.get("location")).toBe("/");

    const ov = await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${dtAlice}` } });
    expect(ov.status).toBe(200);
    const data = (await ov.json()) as { viewer: { admin: boolean; username?: string }; users: Array<{ username: string }> };
    // Ticket #15: identity is (account, capabilities), not one role enum.
    expect(data.viewer).toEqual({ username: "alice", admin: false, dev: false, deploy: false, contribute: false });
    // scoped: bob is invisible to alice
    expect(data.users.map((u) => u.username)).toEqual(["alice"]);
  });

  it("admin login lands on / and sees every user", async () => {
    const res = await loginPost(base, ADMIN);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const ov = (await (await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as {
      viewer: { admin: boolean }; users: Array<{ username: string }>;
    };
    // The shared key has no account of its own — that absence is what stops
    // it writing authored content anywhere in the panel.
    expect(ov.viewer).toEqual({ admin: true, dev: true, deploy: true, contribute: true });
    expect(ov.users.map((u) => u.username).sort()).toEqual(["alice", "bob"]);
  });

  it("changes only a registered device display name for its owner or administrator", async () => {
    store.saveRunnerToken("display-name-token-hash", "alice", "display-device", NOW);
    store.saveRunnerToken("other-display-name-token-hash", "bob", "display-device", NOW);
    const before = store.getRunnerTokenByHash("display-name-token-hash");
    const requestName = (token: string, username: string, device: string, display_name: unknown) => fetch(`${base}/api/runner-display-name`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ username, device, display_name }),
    });
    expect((await requestName(dtAlice, "bob", "display-device", "not mine")).status).toBe(403);
    expect((await requestName(dtAlice, "alice", "not-registered", "aliyun")).status).toBe(404);
    for (const name of ["  ", "x".repeat(65), 123]) expect((await requestName(dtAlice, "alice", "display-device", name)).status).toBe(400);
    const reply = await requestName(dtAlice, "alice", "display-device", "  aliyun  ");
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ ok: true, username: "alice", device: "display-device", display_name: "aliyun" });
    expect(store.getRunnerTokenByHash("display-name-token-hash")).toEqual(before);
    expect(runnerDisplayName(store, "bob", "display-device")).toBeUndefined();
    const overview = await (await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${dtAlice}` } })).json() as { users: Array<{ runners: Array<{ device: string; display_name?: string }> }> };
    expect(overview.users[0].runners.find((row) => row.device === "display-device")).toMatchObject({ device: "display-device", display_name: "aliyun" });
    expect((await requestName(ADMIN, "alice", "display-device", "Aliyun Workbench")).status).toBe(200);
    expect(runnerDisplayName(store, "alice", "display-device")).toBe("Aliyun Workbench");
  });

  it("lets the owner or an administrator choose a Feishu notice for a returning device", async () => {
    store.saveRunnerToken("online-notice-token-hash", "alice", "notice-device", NOW);
    const request = (token: string, username: string, device: string, channel: unknown) => fetch(`${base}/api/runner-online-notice`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ username, device, channel }),
    });
    expect((await request(dtAlice, "bob", "notice-device", "feishu")).status).toBe(403);
    expect((await request(dtAlice, "alice", "not-registered", "feishu")).status).toBe(404);
    expect((await request(dtAlice, "alice", "notice-device", "email")).status).toBe(400);
    const reply = await request(ADMIN, "alice", "notice-device", "feishu");
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ ok: true, username: "alice", device: "notice-device", online_notice: "feishu" });
    expect(runnerOnlineNotice(store, "alice", "notice-device")).toBe("feishu");
    const overview = await (await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${dtAlice}` } })).json() as { users: Array<{ runners: Array<{ device: string; online_notice?: string | null }> }> };
    expect(overview.users[0].runners.find((row) => row.device === "notice-device")).toMatchObject({ online_notice: "feishu" });
    const off = await request(dtAlice, "alice", "notice-device", "off");
    expect(await off.json()).toEqual({ ok: true, username: "alice", device: "notice-device", online_notice: null });
    expect(runnerOnlineNotice(store, "alice", "notice-device")).toBeUndefined();
    store.deleteRunnerToken("alice", "notice-device");
  });

  it("lets only the owner browser session change a Runner initiator policy", async () => {
    store.saveRunnerToken("runner-policy-hash", "alice", "dev-laptop", NOW);
    const login = await loginPost(base, dtAlice);
    const cookies = login.headers.getSetCookie();
    const sid = /octopus_sess=([0-9a-f]{64})/.exec(cookies.join(";"))![1];
    const csrf = /octopus_csrf=([0-9a-f]{64})/.exec(cookies.join(";"))![1];
    const response = await fetch(`${base}/api/runner-local-agent-bridge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `octopus_sess=${sid}; octopus_csrf=${csrf}`,
        "x-csrf-token": csrf,
        origin: base,
      },
      body: JSON.stringify({ username: "alice", device: "dev-laptop", mode: "full_access" }),
    });
    expect(response.status).toBe(200);
    expect(store.getRunnerDevicePolicy("alice", "dev-laptop")?.local_agent_bridge_mode).toBe("full_access");

    const bearerOnly = await fetch(`${base}/api/runner-local-agent-bridge`, {
      method: "POST",
      headers: { authorization: `Bearer ${dtAlice}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", device: "dev-laptop", mode: "disabled" }),
    });
    expect(bearerOnly.status).toBe(403);
    expect(store.getRunnerDevicePolicy("alice", "dev-laptop")?.local_agent_bridge_mode).toBe("full_access");

    const injection = await fetch(`${base}/api/runner-default-agent-injection`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `octopus_sess=${sid}; octopus_csrf=${csrf}`,
        "x-csrf-token": csrf,
        origin: base,
      },
      body: JSON.stringify({ username: "alice", device: "dev-laptop", enabled: true }),
    });
    expect(injection.status).toBe(200);
    expect(store.getRunnerDevicePolicy("alice", "dev-laptop")?.default_agent_injection).toBe(1);

    const injectionBearerOnly = await fetch(`${base}/api/runner-default-agent-injection`, {
      method: "POST",
      headers: { authorization: `Bearer ${dtAlice}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", device: "dev-laptop", enabled: false }),
    });
    expect(injectionBearerOnly.status).toBe(403);
    expect(store.getRunnerDevicePolicy("alice", "dev-laptop")?.default_agent_injection).toBe(1);
  });

  it("lets only an owner browser session expose an eligible Mac for GUI automation", async () => {
    const guiDir = mkdtempSync(join(tmpdir(), "dash-gui-policy-"));
    const guiStore = new Store(join(guiDir, "t.db"));
    guiStore.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    guiStore.saveRunnerToken("gui-runner-hash", "alice", "studio-mac", NOW);
    const token = mintDashboardToken(guiStore, "alice");
    const setGuiAutomationEnabled = vi.fn(() => ({ changed: true, onlineApplied: true }));
    const guiCaps = {
      setGuiAutomationEnabled,
      listDevices: () => [{
        device: "studio-mac",
        online: true,
        created_at: NOW,
        last_seen_at: NOW,
        inventory: {
          gui_automation: {
            available: true,
            protocol: "runner-macos-gui/v1",
            consent_ttl_seconds: 900,
          },
        },
      }],
    } as unknown as RunnerCapabilities;
    const guiDash = createDashboardTestServer(guiStore, guiCaps, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN,
    });
    try {
      await guiDash.start();
      const guiBase = `http://127.0.0.1:${guiDash.port}`;
      const login = await loginPost(guiBase, token);
      const cookies = login.headers.getSetCookie();
      const sid = /octopus_sess=([0-9a-f]{64})/.exec(cookies.join(";"))![1];
      const csrf = /octopus_csrf=([0-9a-f]{64})/.exec(cookies.join(";"))![1];
      const response = await fetch(`${guiBase}/api/runner-gui-automation`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `octopus_sess=${sid}; octopus_csrf=${csrf}`,
          "x-csrf-token": csrf,
          origin: guiBase,
        },
        body: JSON.stringify({ username: "alice", device: "studio-mac", enabled: true }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, online_applied: true });
      expect(setGuiAutomationEnabled).toHaveBeenCalledWith(
        "alice",
        "studio-mac",
        true,
        expect.any(String),
        "alice",
      );

      const bearerOnly = await fetch(`${guiBase}/api/runner-gui-automation`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ username: "alice", device: "studio-mac", enabled: false }),
      });
      expect(bearerOnly.status).toBe(403);
      expect(setGuiAutomationEnabled).toHaveBeenCalledOnce();
    } finally {
      await guiDash.stop();
      guiStore.close();
      rmSync(guiDir, { recursive: true, force: true });
    }
  });

  it("bad login is 401; browser page navigations enter login with a safe return path", async () => {
    const bad = await loginPost(base, "dt_wrong");
    expect(bad.status).toBe(401);
    // And the credential may not travel in the URL at all.
    const viaUrl = await fetch(`${base}/login?token=dt_wrong`);
    expect(viaUrl.status).toBe(400);
    // Script requests retain an honest machine-readable 401.
    const script = await fetch(`${base}/sessions`, { redirect: "manual" });
    expect(script.status).toBe(401);
    expect(await script.json()).toMatchObject({ error: "unauthorized" });

    // A browser document request is sent to /login, carrying only its bounded
    // same-origin location. The login bootstrap returns to it after exchange.
    const page = await fetch(`${base}/tickets?mine=1`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/login?next=%2Ftickets%3Fmine%3D1");
    const loginPage = await fetch(base + page.headers.get("location")!);
    expect(loginPage.status).toBe(200);
    const login = await loginPage.text();
    expect(readBootstrapPayload(login).page).toBe("pre.login");
    expect(readBootstrapPayload(login).pageProps).toMatchObject({
      rejected: false,
      next: "/tickets?mine=1",
    });
    expect(login).not.toContain("?token=");
  });

  it("logout is a write: GET is refused, POST needs an Origin, and it clears the cookies", async () => {
    // A GET would be reachable from `<img src="…/logout">` on any page.
    const viaGet = await fetch(`${base}/logout`, { redirect: "manual" });
    expect(viaGet.status).toBe(405);
    expect(viaGet.headers.get("set-cookie")).toBeNull();

    // A cross-site POST carries the cookie but not an acceptable Origin.
    const crossSite = await fetch(`${base}/logout`, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);

    const ok = await fetch(`${base}/logout`, { method: "POST", headers: { origin: base } });
    expect(ok.status).toBe(200);
    expect(String(ok.headers.get("set-cookie"))).toContain("Max-Age=0");
  });

  it("a personal key cannot act for another user (runner-token / sessions)", async () => {
    const h = { authorization: `Bearer ${dtAlice}`, "content-type": "application/json" };
    const t1 = await fetch(`${base}/api/runner-token`, { method: "POST", headers: h, body: JSON.stringify({ username: "bob", device: "d" }) });
    expect(t1.status).toBe(403);
    const l1 = await fetch(`${base}/api/sessions?username=bob`, { headers: h });
    expect(l1.status).toBe(403);
  });

  it("lists sessions from the bot-host scan home, tagged and grouped-ready", async () => {
    const res = await fetch(`${base}/api/sessions`, { headers: { authorization: `Bearer ${dtAlice}` } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      sources: Array<{ device: string; kind: string }>;
      sessions: Array<Record<string, unknown>>;
    };
    // No `home`: the scan root is an absolute path on the bot host, and the
    // page renders only kind and device.
    expect(data.sources).toEqual([{ device: BOT_HOST_DEVICE, kind: "local" }]);
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]).toMatchObject({
      id: SESSION_ID, source: "claude", cwd: "/work/proj", device: BOT_HOST_DEVICE, message_count: 3,
    });
  });

  it("the owner reads their own transcript; rich blocks carry paired tool results", async () => {
    const res = await fetch(`${base}/api/session?id=${SESSION_ID.slice(0, 8)}&device=${BOT_HOST_DEVICE}`, { headers: { authorization: `Bearer ${dtAlice}` } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      rich: boolean; total_messages: number; device: string;
      meta: Record<string, unknown>;
      messages: Array<{ role: string; blocks: Array<Record<string, unknown>> }>;
    };
    expect(data.rich).toBe(true);
    expect(data.device).toBe(BOT_HOST_DEVICE);
    expect(data.total_messages).toBe(3);
    expect(data.meta.cwd).toBe("/work/proj");
    const toolMsg = data.messages[1];
    expect(toolMsg.blocks.map((b) => b.type)).toEqual(["text", "tool"]);
    expect(toolMsg.blocks[1]).toMatchObject({ tool: "Bash", output: "ERR token expired" });
  });

  /**
   * The bot host is a resource with an owner, not a place the admin key can
   * read from because the file happens to be on this disk. Reading across
   * accounts is a predicate about account material; it was never a decision
   * that transcripts are included, and this branch used to have no owner check
   * at all because the Runner branch had one.
   */
  it("the admin key is refused a bot-host transcript, and gets no text with the refusal", async () => {
    const res = await fetch(
      `${base}/api/session?username=alice&id=${SESSION_ID}&device=${BOT_HOST_DEVICE}`,
      { headers: { authorization: `Bearer ${ADMIN}` } },
    );
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("排查登录 bug");
  });

  it("paging: offset+limit slice the transcript from the front", async () => {
    const res = await fetch(`${base}/api/session?id=${SESSION_ID}&offset=0&limit=2`, { headers: { authorization: `Bearer ${dtAlice}` } });
    const data = (await res.json()) as { offset: number; messages: Array<{ role: string }> };
    expect(data.offset).toBe(0);
    expect(data.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("search hits transcript content and tags the device", async () => {
    // Search runs over the flat projection (user/assistant text + tool names);
    // tool RESULT payloads are not indexed — pick a term from real prose.
    const res = await fetch(`${base}/api/sessions/search?query=${encodeURIComponent("登录 bug")}`, {
      headers: { authorization: `Bearer ${dtAlice}` },
    });
    const data = (await res.json()) as { returned: number; results: Array<{ session: { id: string; device: string } }> };
    expect(data.returned).toBe(1);
    expect(data.results[0].session).toMatchObject({ id: SESSION_ID, device: BOT_HOST_DEVICE });
  });

  it("append is owner-only: admin refused, wrong user refused, bot-host refused, no-gateway honest", async () => {
    const post = (headersToken: string, body: Record<string, unknown>) =>
      fetch(`${base}/api/sessions/append`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${headersToken}` },
        body: JSON.stringify(body),
      });
    // the shared admin key names no account, so it cannot act as one (a NAMED
    // administrator can; see permissions.e2e.test.ts)
    const a = await fetch(`${base}/api/sessions/append`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ username: "alice", device: "laptop", id: SESSION_ID, prompt: "x" }),
    });
    expect(a.status).toBe(403);
    expect(((await a.json()) as { error: string }).error).toContain("仅限本人");
    // alice targeting bob
    const b = await post(dtAlice, { username: "bob", device: "laptop", id: SESSION_ID, prompt: "x" });
    expect(b.status).toBe(403);
    // bot-host sessions are read-only
    const c = await post(dtAlice, { username: "alice", device: BOT_HOST_DEVICE, id: SESSION_ID, prompt: "x" });
    expect(c.status).toBe(400);
    expect(((await c.json()) as { error: string }).error).toContain("只读");
    // eligible shape but no gateway in this fixture
    const d = await post(dtAlice, { username: "alice", device: "laptop", id: SESSION_ID, prompt: "x" });
    expect(d.status).toBe(503);
  });

  it("gzips large bodies when the client accepts it; small or gzip-less requests stay plain", async () => {
    const h = { authorization: `Bearer ${dtAlice}` };
    const big = await fetch(`${base}/permissions`, { headers: { ...h, "accept-encoding": "gzip" } });
    expect(big.headers.get("content-encoding")).toBe("gzip");
    expect(readBootstrapPayload(await big.text()).page).toBe("page.permissions"); // fetch decompresses transparently

    const small = await fetch(`${base}/api/overview`, { headers: { ...h, "accept-encoding": "gzip" } });
    expect(small.headers.get("content-encoding")).toBeNull();

    const plain = await fetch(`${base}/permissions`, { headers: { ...h, "accept-encoding": "identity" } });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(readBootstrapPayload(await plain.text()).page).toBe("page.permissions");
  });

  it("live SSE: scope-checked, immediate sync delta, incremental delta when the file grows", async () => {
    // Scope check happens before any streaming starts.
    const forbidden = await fetch(`${base}/api/sessions/live?username=bob&id=x`, {
      headers: { authorization: `Bearer ${dtAlice}` },
    });
    expect(forbidden.status).toBe(403);

    const ac = new AbortController();
    const res = await fetch(
      `${base}/api/sessions/live?id=${SESSION_ID}&device=${BOT_HOST_DEVICE}&from=0&frontier=0`,
      { headers: { authorization: `Bearer ${dtAlice}` }, signal: ac.signal },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deltas = () =>
      buf
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)) as { from: number; total: number; messages: unknown[] });
    // 4 raw lines parse to 3 rich messages (the tool_result line pairs into
    // the assistant message instead of standing alone).
    while (deltas().length < 1) buf += dec.decode((await reader.read()).value);
    expect(deltas()[0]).toMatchObject({ from: 0, total: 3 });
    expect(deltas()[0].messages).toHaveLength(3);

    appendFileSync(
      join(home, ".claude", "projects", "-work-proj", `${SESSION_ID}.jsonl`),
      "\n" +
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-22T09:00:20.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "补充说明" }] },
        }),
    );
    while (deltas().length < 2) buf += dec.decode((await reader.read()).value);
    // Old tail was fully settled → the delta carries only the new message.
    expect(deltas()[1]).toMatchObject({ from: 3, total: 4 });
    expect(deltas()[1].messages).toHaveLength(1);
    ac.abort();
  }, 15_000);

  it("retires the sessions page while the main page still renders", async () => {
    const page = await fetch(`${base}/sessions`, {
      headers: { authorization: `Bearer ${dtAlice}` },
      redirect: "manual",
    });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/sessions-plus");
    const main = await fetch(`${base}/`, { headers: { authorization: `Bearer ${dtAlice}` } });
    expect(main.status).toBe(200);
    const mainHtml = await main.text();
    // This fixture does not compose Session Plus, so it advertises no session tab.
    expect(readBootstrapPayload(mainHtml).nav.map((t) => t.path)).not.toContain("/sessions");
    expect(readBootstrapPayload(mainHtml).viewer.username).toBe("alice");
  });
});
