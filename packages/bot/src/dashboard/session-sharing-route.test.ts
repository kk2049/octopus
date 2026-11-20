import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppRuntimeService, InProcessRuntimeClient } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { Store } from "../store/store.js";
import { bundledAppDir } from "../app-core/app-path.js";
import { sessionPlusIdentity } from "../app-core/identity.js";
import { resolveSessionPlus } from "../app-core/settings.js";
import { SessionPlusAppService } from "../session-plus/app-service.js";
import { resourceId } from "../sessionhub/core.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { mintDashboardToken, type DashboardServer } from "./server.js";
import { readBootstrapPayload } from "./app-page.js";

type Browser = { cookie: string; csrf: string };
const browserOf = (res: Response): Browser => ({
  cookie: res.headers.getSetCookie().find((c) => c.startsWith("octopus_sess="))?.split(";")[0] ?? "",
  csrf: /octopus_csrf=([0-9a-f]{64})/.exec(res.headers.getSetCookie().join(";"))?.[1] ?? "",
});
describe("shared Sessions+ browser entry", () => {
  let dir: string, store: Store, app: SessionPlusAppService, runtime: AppRuntimeService, state: AppStateService, server: DashboardServer, base: string;
  let alice: Browser, bob: Browser, guest: Browser, shareId: string, secret: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "shared-session-http-"));
    store = new Store(join(dir, "store.db"));
    for (const username of ["alice", "bob"]) store.saveUser({ username, uid: username === "alice" ? 5001 : 5002, home_dir: join(dir, username), created_at: new Date().toISOString() });
    state = new AppStateService(join(dir, "state")); runtime = new AppRuntimeService(bundledAppDir("session-plus"));
    app = new SessionPlusAppService({ state: new InProcessStateClient(state), runtime: new InProcessRuntimeClient(runtime), identity: sessionPlusIdentity() });
    const resolved = resolveSessionPlus({ config: { enabled: true, view_origin: `https://${sessionPlusIdentity().packageHostLabel}.apps.example.com` }, publicUrl: "https://panel.example.com" });
    if (!resolved.enabled || !resolved.settings) throw new Error(resolved.errors.join(";"));
    server = createDashboardTestServer(store, undefined, { port: 0, host: "127.0.0.1", authToken: "test", surface: "bootstrap-v3", sessionPlus: resolved.settings, sessionPlusApp: app });
    await server.start(); base = `http://127.0.0.1:${server.port}`;
    alice = browserOf(await post("/login", { token: mintDashboardToken(store, "alice") }));
    bob = browserOf(await post("/login", { token: mintDashboardToken(store, "bob") }));
    expect((await post("/api/session-plus/trust", { decision: "trust", follow_updates: false }, alice)).status).toBe(200);
    const resource = resourceId({ owner: "alice", device: "laptop", cliKind: "codex", sessionId: "one" });
    const share = app.sharing!.create("alice", resource, { sessions: [{ resourceId: resource, title: "Shared chat", cliKind: "codex", deviceId: "laptop" }] }, []);
    shareId = share.id; secret = share.link.split("#")[1];
  }, 60_000);
  afterAll(async () => { await server?.stop(); app?.stop(); await runtime?.stop(); state?.close(); store?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  function post(path: string, body: unknown, browser?: Browser, extra: Record<string, string> = {}) {
    return fetch(base + path, { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/json", ...(browser ? { cookie: browser.cookie, "x-csrf-token": browser.csrf } : {}), ...extra }, body: JSON.stringify(body) });
  }
  function get(path: string, browser?: Browser) { return fetch(base + path, { redirect: "manual", headers: browser ? { cookie: browser.cookie } : {} }); }
  it("redeems anonymously with the existing host-only cookie, with no account or root capabilities", async () => {
    expect((await get("/share")).status).toBe(200);
    const res = await post("/api/session-shares/redeem", { secret }); expect(res.status).toBe(200); guest = browserOf(res);
    expect(guest.cookie).not.toBe(""); expect(guest.csrf).not.toBe("");
    expect(await res.json()).toMatchObject({ shareId, expired: false });
    for (const path of ["/", "/permissions", "/api/permissions", "/api/tickets", "/sessions-plus", "/api/session-plus/release"]) expect((await get(path, guest)).status, path).toBe(403);
    const page = await get(`/sessions-plus?share=${shareId}`, guest);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(JSON.stringify(readBootstrapPayload(html))).toContain('"shareId"');
    expect(JSON.stringify(readBootstrapPayload(html))).not.toContain(secret);
    const handle = /id="octopus-app-instance">"([a-f0-9]{48})"<\/script>/.exec(html)?.[1];
    expect(handle).toBeTruthy();
    const denied = await post(`/api/session-plus/act?share=${shareId}`, { action: "start_session", params: {} }, guest, { "x-session-plus-instance": handle! });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });
  it("keeps a signed-in recipient's existing cookie and prevents issuer trust or account escalation", async () => {
    const res = await post("/api/session-shares/redeem", { secret }, bob);
    expect(res.status).toBe(200); expect(res.headers.getSetCookie()).toHaveLength(0);
    const list = await (await get("/api/session-shares/list", bob)).json();
    expect(list.shares).toEqual([expect.objectContaining({ shareId, issued: false })]);
    expect((await post(`/api/session-plus/trust?share=${shareId}`, { decision: "revoke" }, bob)).status).toBe(403);
    expect((await get(`/api/permissions?share=${shareId}`, bob)).status).toBe(403);
    expect((await get(`/sessions-plus?share=sh_${"a".repeat(32)}`, bob)).status).toBe(403);
    expect((await post("/api/session-shares/redeem", { secret }, bob, { "x-csrf-token": "bad" })).status).toBe(403);
    expect((await post("/api/session-shares/redeem", { secret }, undefined, { origin: "https://evil.example" })).status).toBe(403);
  });
  it("lets only the issuer reset a stuck usage lock; a guest or recipient cannot (B14)", async () => {
    store.sessionShares.update(shareId, (row) => { row.meter = { baseline: 10, observed: 10, startedAt: Date.now() }; });
    expect((await post("/api/session-shares/reset", { shareId }, guest)).status).toBe(403);
    expect((await post("/api/session-shares/reset", { shareId }, bob)).status).toBe(400);
    expect(store.sessionShares.get(shareId)?.meter).not.toBeNull();
    const listed = await (await get("/api/session-shares/list", alice)).json();
    expect(listed.shares).toEqual([expect.objectContaining({ shareId, metering: true })]);
    expect((await post("/api/session-shares/reset", { shareId }, alice)).status).toBe(200);
    expect(store.sessionShares.get(shareId)?.meter).toBeNull();
  });
  it("turns an expired login into a renewal request and restores the same link only after issuer approval", async () => {
    store.sessionShares.update(shareId, (row) => { row.expiresAt = Date.now() - 1; });
    const page = await get(`/sessions-plus?share=${shareId}`, guest);
    expect(page.status).toBe(303); expect(page.headers.get("location")).toBe(`/share?id=${shareId}`);
    expect((await post("/api/session-shares/request", { shareId, kind: "lease" }, guest)).status).toBe(200);
    const request = store.sessionShares.requests("alice")[0];
    expect((await post("/api/session-shares/decide", { requestId: request.id, approve: true }, bob)).status).toBe(400);
    expect((await post("/api/session-shares/decide", { requestId: request.id, approve: true, hours: 1 }, alice)).status).toBe(200);
    const res = await post("/api/session-shares/redeem", { secret }, guest);
    expect(await res.json()).toMatchObject({ shareId, expired: false });
    expect((await post("/api/session-shares/revoke", { shareId }, alice)).status).toBe(200);
    expect((await post("/api/session-shares/redeem", { secret }, guest)).status).toBe(403);
  });
});
