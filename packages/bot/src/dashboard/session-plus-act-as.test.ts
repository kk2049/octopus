/**
 * A named administrator opening Sessions+ as another account (`?as=`,
 * 2026-10-15 owner decision: "admin 用户对其他的用户的权限也可以无限大"). The
 * administrator gets that account's own page — its sessions, files and App
 * state, through that account's grants — the account's audit names who did
 * it, and ending the administrator's login ends those instances. A non-admin's
 * `?as=` changes nothing: they still get only their own account.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppRuntimeService, InProcessRuntimeClient } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { Store } from "../store/store.js";
import { readBootstrapPayload } from "./app-page.js";
import { mintDashboardToken, type DashboardServer } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { resolveSessionPlus } from "../app-core/settings.js";
import { sessionPlusIdentity } from "../app-core/identity.js";
import { bundledAppDir } from "../app-core/app-path.js";
import { SessionPlusAppService } from "../session-plus/app-service.js";

const NOW = "2026-10-15T10:00:00.000Z";
const PANEL_URL = "https://bot.example.org";

let dir: string;
let store: Store;
let server: DashboardServer;
let base = "";
let app: SessionPlusAppService;
let appState: AppStateService;
let appRuntime: AppRuntimeService;
const browsers = new Map<string, { cookie: string; csrf: string }>();

async function login(username: string): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ token: mintDashboardToken(store, username) }),
  });
  const set = res.headers.getSetCookie();
  const browser = {
    cookie: set.find((c) => c.startsWith("octopus_sess="))?.split(";", 1)[0] ?? "",
    csrf: /octopus_csrf=([0-9a-f]{64})/.exec(set.join(";"))?.[1] ?? "",
  };
  browsers.set(username, browser);
  return browser;
}

async function open(username: string, query = ""): Promise<{ props: Record<string, unknown>; handle: string; html: string }> {
  const res = await fetch(`${base}/sessions-plus${query}`, { headers: { cookie: browsers.get(username)!.cookie } });
  expect(res.status).toBe(200);
  const html = await res.text();
  const handle = /id="octopus-app-instance">"([a-f0-9]{48})"<\/script>/.exec(html)?.[1] ?? "";
  return { props: readBootstrapPayload(html).pageProps as Record<string, unknown>, handle, html };
}

function act(username: string, handle: string, query: string, session: string): Promise<Response> {
  const browser = browsers.get(username)!;
  return fetch(`${base}/api/session-plus/act${query}`, {
    method: "POST",
    headers: {
      cookie: browser.cookie,
      origin: base,
      "x-csrf-token": browser.csrf,
      "x-session-plus-instance": handle,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "pin_session", params: { session } }),
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sp-act-as-"));
  store = new Store(join(dir, "t.db"));
  for (const [i, name] of ["alice", "bob", "root"].entries()) {
    store.saveUser({ username: name, uid: 5101 + i, home_dir: join(dir, name), created_at: NOW });
  }
  appState = new AppStateService(join(dir, "app-state"));
  appRuntime = new AppRuntimeService(bundledAppDir("session-plus"));
  app = new SessionPlusAppService({
    state: new InProcessStateClient(appState),
    runtime: new InProcessRuntimeClient(appRuntime),
    identity: sessionPlusIdentity(),
  });
  const resolved = resolveSessionPlus({
    config: { enabled: true, view_origin: `https://${sessionPlusIdentity().packageHostLabel}.apps.example.org` },
    publicUrl: PANEL_URL,
  });
  if (!resolved.enabled || !resolved.settings) throw new Error(resolved.errors.join("; "));
  server = createDashboardTestServer(store, undefined, {
    port: 0,
    host: "127.0.0.1",
    authToken: "sekrit",
    adminUsers: ["root"],
    surface: "bootstrap-v3",
    sessionHubUi: "unified-v3",
    sessionPlus: resolved.settings,
    sessionPlusApp: app,
  });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
  for (const name of ["alice", "bob", "root"]) await login(name);
}, 60_000);

afterAll(async () => {
  await server?.stop();
  app?.stop();
  await appRuntime?.stop();
  appState?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("an administrator acting as another account in Sessions+", () => {
  it("opens that account's own page and acts on its state, with the administrator on its record", async () => {
    const asAlice = await open("root", "?as=alice");
    expect(asAlice.props).toMatchObject({ mode: "app", actingAs: "alice" });
    expect(asAlice.handle).not.toBe("");
    expect((await act("root", asAlice.handle, "?as=alice", "pinned-by-admin")).status).toBe(200);

    // Alice's own page now shows what the administrator did in her account.
    const own = await open("alice");
    expect(own.props.actingAs).toBeUndefined();
    expect(own.html).toMatch(/"pinned":\[[^\]]*"pinned-by-admin"/);
    const audit = store.listPermissionAudit("alice", { decision: "admin_access" });
    expect(audit.some((row) => JSON.parse(row.detail ?? "{}").by === "root")).toBe(true);
  });

  it("ignores a non-admin's ?as=: they keep only their own account", async () => {
    const page = await open("bob", "?as=alice");
    expect(page.props.actingAs).toBeUndefined();
    expect((await act("bob", page.handle, "?as=alice", "pinned-by-bob")).status).toBe(200);
    expect((await open("alice")).html).not.toContain("pinned-by-bob");
    expect((await open("bob")).html).toContain("pinned-by-bob");
  });

  it("ends the administrator's acting instances when their login ends", async () => {
    const asAlice = await open("root", "?as=alice");
    const acting = () => app.instances.allBindings().filter((binding) => binding.owner === "alice" && binding.credential.includes(":as:alice"));
    expect(acting().length).toBeGreaterThan(0);
    const browser = browsers.get("root")!;
    const out = await fetch(`${base}/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: browser.cookie, origin: base, "x-csrf-token": browser.csrf },
    });
    expect([200, 303]).toContain(out.status);
    expect(acting()).toEqual([]);
    await login("root");
    // The same handle, presented by the administrator's next login, is gone.
    expect((await act("root", asAlice.handle, "?as=alice", "after-logout")).status).not.toBe(200);
    expect((await open("alice")).html).not.toContain("after-logout");
  });
});
