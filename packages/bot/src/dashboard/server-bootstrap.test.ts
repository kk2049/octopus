import { appPageScriptCsp } from "./app-page.js";
/**
 * The bootstrap surface over real HTTP.
 *
 * `authz-bootstrap.test.ts` proves the decision; this proves the wiring — that
 * the panel actually asks, on every path including the ones answered before the
 * identity gate, and that what a browser is shown matches what the router will
 * serve. The last part matters more than it looks: a nav link to a 404 is how a
 * "disabled" feature turns into a support question.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readBootstrapPayload } from "./app-page.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { hashRunnerToken } from "../runner/gateway.js";
import type { RunnerCapabilities } from "../runner/capability.js";
import type { DevPipeline } from "../devpipe/pipeline.js";
import type { DeployService } from "../devpipe/deploy.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer, runnerBundleSourceFromFile } from "../e2e/dashboard-test-support.js";

const NOW = "2026-08-03T10:00:00.000Z";

/** Enough of the capability service for token minting and device listing. */
function stubCaps(store: Store): RunnerCapabilities {
  return {
    listDevices: () => [],
    isOnline: () => false,
    open: () => null,
    dropPooled: () => 0,
    listPending: () => [],
    deviceRevoked: () => {},
    // No devices registered, so this account has no Runner root — the
    // permission projection then reports `device_revoked` rather than throwing.
    accountAuthority: () => null,
    mintDeviceToken: (u: string, d: string) => {
      store.deleteRunnerToken(u, d);
      const t = "rt_stub";
      store.saveRunnerToken(hashRunnerToken(t), u, d, NOW);
      return t;
    },
  } as unknown as RunnerCapabilities;
}

/**
 * The pipeline only has to EXIST for the dev routes to be on the surface —
 * the `dev-pipeline` feature is about configuration, not behaviour, and every dev
 * route below is asserted at the surface/authorization layer rather than by
 * driving a real turn (that is `server-tickets.test.ts`'s job).
 */
function stubPipeline(): DevPipeline {
  return {
    baseBranch: "v3",
    specConcurrency: 2,
    ticketExecutionChoices: () => null,
    usesRunnerTickets: () => false,
    lockWaiterIds: () => [],
    mergeLockHolder: () => null,
  } as unknown as DevPipeline;
}

describe("dashboard on the bootstrap-v3 surface", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let full: DashboardServer;
  let base: string;
  let fullBase: string;
  let aliceKey: string;
  const releaseSnapshot = {
    mainlineSha: "a".repeat(40),
    ready: { sha: "a".repeat(40), manifestSha256: "b".repeat(64) },
    checkedAt: NOW,
  };
  const checkUpdates = vi.fn(async () => releaseSnapshot);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dash-boot-"));
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: join(dir, "alice"), created_at: NOW });
    store.setSetting("alice", "display_name", "爱丽丝");
    aliceKey = mintDashboardToken(store, "alice");
    const bundle = join(dir, "standalone.js");
    writeFileSync(bundle, "// fake runner bundle");

    const opts = {
      port: 0,
      host: "127.0.0.1",
      authToken: "sekrit",
      adminUsers: ["alice"],
      runnerWsPort: 9910,
      runnerBundle: runnerBundleSourceFromFile(bundle),
      publicHost: "203.0.113.9",
      devPipeline: stubPipeline(),
      deployService: { checkUpdates } as unknown as DeployService,
    };
    dash = createDashboardTestServer(store, stubCaps(store), { ...opts, surface: "bootstrap-v3" as const });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;

    // The control: the same store, the same options, the full surface.
    full = createDashboardTestServer(store, stubCaps(store), opts);
    await full.start();
    fullBase = `http://127.0.0.1:${full.port}`;
  });

  afterAll(async () => {
    await dash.stop();
    await full.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (p: string, b = base) =>
    fetch(b + p, { headers: { authorization: `Bearer ${aliceKey}` }, redirect: "manual" });
  const post = (p: string, body?: unknown, b = base) =>
    fetch(b + p, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });

  it("serves the control plane's pages", async () => {
    for (const p of ["/", "/permissions", "/pending", "/tickets", "/admin"]) {
      expect((await get(p)).status, p).toBe(200);
    }
    const legacy = await get("/sessions");
    expect(legacy.status).toBe(303);
    expect(legacy.headers.get("location")).toBe("/sessions-plus");
  });

  it("ships no inline executable script on any live control-plane page", async () => {
    const pages = [
      [base, "/login"],
      [base, "/permissions"],
      [base, "/pending"],
      [base, "/tickets"],
      [base, "/admin"],
      [base, "/"],
    ] as const;
    for (const [at, path] of pages) {
      const res = path === "/login" ? await fetch(at + path) : await get(path, at);
      expect(res.status, path).toBe(200);
      // `script-src 'self'` with no nonce and no `unsafe-inline`: strictly
      // stronger than the per-response nonce this used to require, because a
      // nonce admits whatever the renderer put beside it while `'self'` admits
      // only files this server published.
      const csp = res.headers.get("content-security-policy") ?? "";
      const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
      expect(scriptSrc, `${path} CSP`).toBe(appPageScriptCsp());
      expect(csp, `${path} CSP`).not.toContain("unsafe-eval");
      const html = await res.text();
      const scripts = html.match(/<script\b[^>]*>/g) ?? [];
      expect(scripts.length, `${path} scripts`).toBeGreaterThan(0);
      for (const tag of scripts) {
        // Every script element is either a module from /ui/ or an inert JSON
        // data block or the exact CSP-authorized module import map.
        expect(
          tag.includes('src="/ui/') || tag.includes('type="application/json"') || tag.includes('type="importmap"'),
          `${path}: ${tag}`,
        ).toBe(true);
      }
    }
  });

  it("serves the control plane's APIs", async () => {
    for (const p of [
      "/api/overview",
      "/api/sessions?username=alice",
      "/api/permissions?username=alice",
      "/api/permissions/devices?username=alice",
      "/api/capabilities/pending",
      "/api/tickets",
      "/api/admin/users",
    ]) {
      expect((await get(p)).status, p).toBe(200);
    }
  });

  it("keeps stored display names", async () => {
    const body = await (await get("/api/admin/users")).json() as {
      users: Array<{ username: string; display_name: string }>;
    };
    expect(body.users.find((u) => u.username === "alice")?.display_name).toBe("爱丽丝");
  });

  it("persists one account theme across fresh browser documents on the bootstrap surface", async () => {
    const initial = readBootstrapPayload(await (await get("/")).text());
    expect(initial.themePreference).toBeNull();

    const saved = await post("/api/theme-preference", { theme: "apple" });
    expect(saved.status).toBe(200);
    expect(store.getSetting("alice", "dashboard_theme")).toBe("apple");

    // A fresh document stands in for another browser/device login: the value
    // comes from the account row, not that browser's localStorage.
    const next = readBootstrapPayload(await (await get("/permissions")).text());
    expect(next.themePreference).toBe("apple");

    const invalid = await post("/api/theme-preference", { theme: "spatial-2027" });
    expect(invalid.status).toBe(400);
    expect(store.getSetting("alice", "dashboard_theme")).toBe("apple");
  });

  it("navigation offers only what the surface serves", async () => {
    // The navigation is data now, so this asks the question the server answered
    // rather than matching anchors: a cosmetic change to a tab cannot silently
    // delete this coverage.
    const boot = readBootstrapPayload(await (await get("/permissions")).text());
    const paths = boot.nav.map((tab) => tab.path);
    // Present.
    expect(paths).not.toContain("/sessions");
    expect(paths).not.toContain("/sessions-plus");
    expect(paths).toContain("/permissions");
    expect(paths).toContain("/tickets");
    expect(paths).toContain("/admin");
    // Approval is a shell pill/drawer, not a navigation destination. This
    // request uses a bearer, so it must not pretend a person is present either.
    expect(paths).not.toContain("/pending");
    expect(boot.approvals).toBe(false);
    // Overview is the honest fallback when Session Plus is not composed.
    expect(paths).toContain("/");

    // The full panel, same viewer: since the legacy pages were retired every
    // route is on the bootstrap surface, so both compositions offer the same
    // tabs. (The surface filter itself is proven in authz-bootstrap.test.ts.)
    const fullBoot = readBootstrapPayload(await (await get("/permissions", fullBase)).text());
    const fullPaths = fullBoot.nav.map((tab) => tab.path);
    expect(fullPaths).toEqual(paths);
  });

  it("renders Overview and uses it as the login fallback when Session Plus is absent", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(readBootstrapPayload(await res.text()).page).toBe("page.overview");

    const login = await fetch(base + "/login", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ token: aliceKey }),
    });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/");
  });

  it("keeps the pre-route paths that the bootstrap needs", async () => {
    // Login is the door; without it nobody reaches any of the above.
    expect((await fetch(base + "/login", { redirect: "manual" })).status).toBe(200);
    // Logout is a write, so it keeps its method check rather than becoming a
    // 404 — that would be the wrong reason to refuse.
    expect((await fetch(base + "/logout", { method: "GET", redirect: "manual" })).status).toBe(405);
    // The bundle a device token exists to run.
    expect((await get("/download/runner.js")).status).toBe(200);
    // The dev agent's loopback tool endpoint keeps its own boundary: it is on
    // the surface, and still refuses a call without a live per-turn token.
    expect((await post("/api/devpipe/submit", { token: "nope" })).status).not.toBe(404);
  });

  it("checks GitLab release updates through the production bootstrap HTTP surface", async () => {
    const calls = checkUpdates.mock.calls.length;
    const response = await post("/api/deploy/check", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ snapshot: releaseSnapshot });
    expect(checkUpdates).toHaveBeenCalledTimes(calls + 1);
  });

  it("still authorizes after admitting a route: dev does not imply deploy", async () => {
    // alice is an admin here; bob is a plain user with no capabilities. The
    // surface admitted /tickets for everyone — authorization is what separates
    // them, and the bootstrap gate must not have replaced it.
    store.saveUser({ username: "bob", uid: 5002, home_dir: join(dir, "bob"), created_at: NOW });
    const bobKey = mintDashboardToken(store, "bob");
    const asBob = (p: string, method = "GET") =>
      fetch(base + p, { method, headers: { authorization: `Bearer ${bobKey}` }, redirect: "manual" });

    expect((await asBob("/tickets")).status).toBe(403);
    expect((await asBob("/admin")).status).toBe(403);
    expect((await asBob("/api/deploy", "POST")).status).toBe(403);
    const checks = checkUpdates.mock.calls.length;
    expect((await asBob("/api/deploy/check", "POST")).status).toBe(403);
    expect(checkUpdates).toHaveBeenCalledTimes(checks);
    // The retired URL is only a compatibility redirect for every account.
    const legacy = await asBob("/sessions");
    expect(legacy.status).toBe(303);
    expect(legacy.headers.get("location")).toBe("/sessions-plus");
  });

  it("does not let a bearer approve a dangerous call, on this surface either", async () => {
    // The Approve rule needs a browser session; a bearer proves a credential
    // exists somewhere. Pinned here because the bootstrap surface is where
    // approvals now happen.
    const res = await post("/api/capabilities/pending/anything", { decision: "approve" });
    expect(res.status).toBe(403);
  });
});
