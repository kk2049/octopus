/**
 * The local App management surface, over real HTTP.
 *
 * The API is the only way to change what this host serves, so what is asserted
 * here is not "the buttons work" but the four boundaries around them:
 *
 *  1. **Nobody but an admin.** Not a plain account, not the shared key (which
 *     names no person), not a page that merely renders.
 *  2. **The composition decides existence.** With no registry composed, every
 *     one of these paths is a 404 — not a 403, because on that composition the
 *     service does not exist.
 *  3. **The gate runs first.** Every write crosses the mutation gate: a browser
 *     session needs a precise Origin and the CSRF double-submit, a bearer does
 *     not (it is not ambient) — the same rule as every other write here.
 *  4. **Install and activate are two decisions**, and a candidate this build
 *     cannot run never replaces one it can.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppReleaseRegistry, FileReleaseContentStore } from "@claude-bot/app-registry";
import { Store } from "../store/store.js";
import { DashboardServer, PANEL_RESOURCE_CONTRACTS, mintDashboardToken } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { StoreReleaseCatalog } from "../app-registry/store-catalog.js";
import { appReleasePaths } from "../app-registry/paths.js";
import { SessionPlusReleaseAdapter } from "../app-registry/session-plus-adapter.js";
import { AppReleaseHost, HostedApp } from "../app-registry/release-host.js";
import { DeclaredAppComposer } from "../app-registry/declared-apps.js";
import { declaredAppHostingFrom } from "../app-registry/declared-adapter.js";
import { buildCheckoutBundle, bundleToWire } from "../app-registry/session-plus-package.js";
import { resolveSessionPlus } from "../app-core/settings.js";
import { sessionPlusDescriptor, sessionPlusReleasePackage } from "../app-core/identity.js";
import { viewPackage } from "../app-core/view-app.js";

const NOW = "2026-08-06T10:00:00.000Z";
const PANEL_URL = "https://bot.example.org";

let dir: string;
let store: Store;
let host: AppReleaseHost;
let withRegistry: DashboardServer;
let withoutRegistry: DashboardServer;
let declaring: DashboardServer;
let base = "";
let bareBase = "";
let declaringBase = "";
let adminKey = "";
let plainKey = "";
let browser = { cookie: "", csrf: "" };
const publishActors: string[] = [];
const approvalDecisions: Array<{ id: string; decision: "approve" | "reject"; actor: string }> = [];
const APPROVAL_ID = "ahr_00000000-0000-4000-8000-000000000001";

function settings() {
  const r = resolveSessionPlus({
    config: { enabled: true, app_domain: "apps.example.org" },
    publicUrl: PANEL_URL,
  });
  if (!r.enabled || !r.settings) throw new Error(r.errors.join("; "));
  return r.settings;
}

/** A second release: the real checkout with one View byte changed. */
function variantWire(marker: string): unknown {
  const view = viewPackage();
  const pkg = sessionPlusReleasePackage({
    assets: view.assets.map((asset) =>
      asset.name === "view.js" ? { ...asset, source: `${asset.source}\n/* ${marker} */` } : asset),
  });
  const descriptor = sessionPlusDescriptor({ pkg, lockfileHash: "3".repeat(64) });
  return bundleToWire({
    descriptor,
    assets: pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: {
      kind: "external-attestation",
      builder: "test",
      statement: "arrived built",
      signatureVerification: "none",
    },
  });
}

/**
 * The management page's payload: one block per app this host serves, plus one
 * registry-wide reconciliation. Session Plus is the only entry in this suite,
 * and it is read by id rather than by position — "the first app" is exactly the
 * assumption the catalog exists to remove.
 */
interface AppsView {
  apps: Array<{
    stableAppId: string;
    /** Null for an app that has nothing active — a freshly declared one, say. */
    activePackageDigest: string | null;
    checkout: { packageDigest: string; installed: boolean } | null;
    releases: Array<{ packageDigest: string; installedBy: string }>;
  }>;
  reconcile: { activeUnusable: Array<{ packageDigest: string }> };
  hotswap_approvals: Array<{
    id: string;
    app_id: string;
    ticket_id: number;
    source_commit: string;
    package_digest: string;
    contract_digest: string;
    coexistence: string;
  }>;
}

const APP = "session-plus";

async function appsView(): Promise<AppsView["apps"][number]> {
  const raw = (await asAdminBearer("/api/apps").then((r) => r.json())) as AppsView;
  const app = raw.apps.find((row) => row.stableAppId === APP);
  if (!app) throw new Error(`no ${APP} block in ${JSON.stringify(raw.apps.map((row) => row.stableAppId))}`);
  return app;
}

const asAdminBearer = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}${path}`, {
    ...init,
    redirect: "manual",
    headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "apps-route-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "root", uid: 5001, home_dir: join(dir, "root"), created_at: NOW });
  store.saveUser({ username: "bob", uid: 5002, home_dir: join(dir, "bob"), created_at: NOW });
  adminKey = mintDashboardToken(store, "root");
  plainKey = mintDashboardToken(store, "bob");

  const paths = appReleasePaths(dir);
  const registry = new AppReleaseRegistry({
    catalog: new StoreReleaseCatalog(store),
    content: new FileReleaseContentStore(paths.contentRoot),
  });
  // The composition root's shape: a catalog of hosted apps, Session Plus first.
  host = new AppReleaseHost({
    registry,
    apps: [
      new HostedApp({
        registry,
        adapter: new SessionPlusReleaseAdapter({
          preparedRoot: paths.preparedRoot,
          // Exactly what the composition root passes: the typed-port contracts the
          // panel this suite is about to build installs a provider for. Without it
          // the adapter would correctly report that this deployment cannot serve a
          // release declaring `workspace-files/v1`, and nothing would be activatable.
          resourceContracts: () => new Set(PANEL_RESOURCE_CONTRACTS),
          baseSettings: settings(),
        }),
        // No runtime attached: this suite is about the HTTP boundary, and the
        // hosted-app suite already owns the candidate/commit ordering.
      }),
    ],
  });
  await host.start();

  const common = {
    port: 0,
    host: "127.0.0.1" as const,
    authToken: "sekrit",
    adminUsers: ["root"],
    surface: "bootstrap-v3" as const,
    sessionHubUi: "unified-v3" as const,
    publicUrl: undefined,
  };
  withRegistry = createDashboardTestServer(store, undefined, {
    ...common,
    appReleases: host,
    publishPendingAppReleases: async (actor) => {
      publishActors.push(actor);
      return { ok: true, results: [], remaining: [] };
    },
    appHotswapApprovals: {
      list: () => [{
        id: APPROVAL_ID,
        ticketId: 91,
        appId: APP,
        sourceCommit: "1".repeat(40),
        packageDigest: "2".repeat(64),
        previousDigest: null,
        contractDigest: "3".repeat(64),
        coexistence: "refresh_required" as const,
        coexistenceReason: "state_epoch_changed",
        requestedBy: "devpipe:ticket-91",
        requestedAt: NOW,
        expiresAt: "2026-08-08T10:00:00.000Z",
        state: "pending" as const,
        outcome: null,
      }],
      decide: async (id, decision, actor) => {
        approvalDecisions.push({ id, decision, actor });
        return {
          ok: true as const,
          decision,
          id,
          appId: APP,
          packageDigest: "2".repeat(64),
          changed: decision === "approve",
          message: decision === "approve" ? "已激活 exact digest" : "已拒绝",
        };
      },
    },
  });
  withoutRegistry = createDashboardTestServer(store, undefined, { ...common });

  // A third composition: one that can also DECLARE apps. Separate from
  // `withRegistry` on purpose — being able to manage releases and being able to
  // add an app are two capabilities of a composition, and the suite has to be
  // able to show the first without the second.
  const hosting = declaredAppHostingFrom(settings());
  if (!hosting.ok) throw new Error(hosting.error);
  const declareHost = new AppReleaseHost({ registry, apps: [] });
  const composer = new DeclaredAppComposer({
    store,
    registry,
    host: declareHost,
    preparedRoot: paths.preparedRoot,
    hosting: hosting.hosting,
    backends: null,
  });
  declaring = createDashboardTestServer(store, undefined, {
    ...common,
    appReleases: declareHost,
    declareApp: (input) => composer.declare(input),
  });
  await withRegistry.start();
  await withoutRegistry.start();
  await declaring.start();
  base = `http://127.0.0.1:${withRegistry.port}`;
  bareBase = `http://127.0.0.1:${withoutRegistry.port}`;
  declaringBase = `http://127.0.0.1:${declaring.port}`;

  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ token: adminKey }),
  });
  const set = login.headers.getSetCookie();
  browser = {
    cookie: set.find((c) => c.startsWith("octopus_sess="))?.split(";", 1)[0] ?? "",
    csrf: /octopus_csrf=([0-9a-f]{64})/.exec(set.join(";"))?.[1] ?? "",
  };
});

afterAll(async () => {
  await withRegistry.stop();
  await withoutRegistry.stop();
  await declaring.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Declaring one more App over HTTP.
 *
 * The composition root owns every decision (the grammar, the collision check,
 * the row, the adapter, the catalog entry); what is asserted here is the
 * boundary around it — who may ask, on which compositions the verb exists at
 * all, and that a refusal is a status code rather than a 200 with a sad
 * message. The composer's own semantics are pinned in
 * `app-registry/declared-app.test.ts`, which is the acceptance test for "an App
 * is pure data".
 */
describe("declaring one more App", () => {
  const declareAs = (token: string, body: unknown): Promise<Response> =>
    fetch(`${declaringBase}/api/apps/declare`, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("does not exist on a composition that manages releases but cannot host declared Apps", async () => {
    // 404, not 403: `withRegistry` has a catalog and no way to compose a
    // declaration, and answering 403 would advertise a verb it does not have.
    const res = await asAdminBearer("/api/apps/declare", {
      method: "POST",
      body: JSON.stringify({ app: "x", publisher: "demo:acme", title: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("refuses a plain account", async () => {
    const res = await declareAs(plainKey, { app: "nope", publisher: "demo:acme", title: "Nope" });
    expect(res.status).toBe(403);
  });

  it("declares an App, and declaring serves nothing", async () => {
    const res = await declareAs(adminKey, { app: "route-notes", publisher: "demo:acme", title: "Route Notes" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      app: "route-notes",
      publisher: "demo:acme",
      installed: false,
      activated: false,
    });

    // It is in the catalog immediately, with nothing active — installing and
    // activating remain two further, separate decisions.
    const listed = (await fetch(`${declaringBase}/api/apps`, {
      headers: { authorization: `Bearer ${adminKey}` },
    }).then((r) => r.json())) as AppsView;
    const row = listed.apps.find((app) => app.stableAppId === "route-notes");
    expect(row).toBeTruthy();
    expect(row!.activePackageDigest).toBeNull();
    expect(row!.releases).toEqual([]);
    expect(store.appCatalog.getAppDeclaration("route-notes")?.declared_by).toBe("user:root");
  });

  it("answers a collision with 409 and a malformed declaration with 400", async () => {
    expect((await declareAs(adminKey, { app: "route-notes", publisher: "demo:acme", title: "Again" })).status)
      .toBe(409);
    for (const body of [
      { app: "Route-Notes", publisher: "demo:acme", title: "x" },
      { app: "route notes", publisher: "demo:acme", title: "x" },
      { app: "fine-id", publisher: "NOT OK", title: "x" },
      { app: "fine-id", publisher: "demo:acme", title: "" },
      {},
    ]) {
      const res = await declareAs(adminKey, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
  });

  it("types the three fields and nothing more", async () => {
    // The schema rejects a non-string before the handler coerces one, which is
    // the compatibility decision the panel already made for every other route.
    const res = await declareAs(adminKey, { app: 123, publisher: "demo:acme", title: "x" });
    expect(res.status).toBe(400);
  });
});

describe("who may manage releases", () => {
  it("serves the page and the API to an admin", async () => {
    expect((await asAdminBearer("/apps")).status).toBe(200);
    const view = await appsView();
    expect(Array.isArray(view.releases)).toBe(true);
  });

  it("refuses a plain account, on the page and on every verb", async () => {
    const headers = { authorization: `Bearer ${plainKey}`, "content-type": "application/json" };
    expect((await fetch(`${base}/apps`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/api/apps`, { headers })).status).toBe(403);
    for (const path of [
      "/api/apps/install",
      "/api/apps/activate",
      "/api/apps/deactivate",
      "/api/apps/uninstall",
      "/api/apps/publish-pending",
      `/api/apps/hotswap/${APPROVAL_ID}/approve`,
    ]) {
      const res = await fetch(`${base}${path}`, { method: "POST", headers, body: "{}" });
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  it("runs the pending-release drain as the authenticated administrator", async () => {
    const before = publishActors.length;
    const res = await asAdminBearer("/api/apps/publish-pending", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, results: [], remaining: [] });
    expect(publishActors.slice(before)).toEqual(["user:root"]);
  });

  it("shows exact approval facts and only a real Administer browser session may decide", async () => {
    const listed = (await asAdminBearer("/api/apps").then((r) => r.json())) as AppsView;
    expect(listed.hotswap_approvals).toEqual([
      expect.objectContaining({
        id: APPROVAL_ID,
        app_id: APP,
        ticket_id: 91,
        source_commit: "1".repeat(40),
        package_digest: "2".repeat(64),
        contract_digest: "3".repeat(64),
        coexistence: "refresh_required",
      }),
    ]);

    // Administer bearer is enough for ordinary host administration, but not
    // for consuming an agent-created activation approval.
    const bearer = await asAdminBearer(`/api/apps/hotswap/${APPROVAL_ID}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(bearer.status).toBe(403);

    const before = approvalDecisions.length;
    const approved = await fetch(`${base}/api/apps/hotswap/${APPROVAL_ID}/approve`, {
      method: "POST",
      headers: {
        cookie: browser.cookie,
        origin: base,
        "x-csrf-token": browser.csrf,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ ok: true, decision: "approve", changed: true });
    expect(approvalDecisions.slice(before)).toEqual([
      { id: APPROVAL_ID, decision: "approve", actor: "user:root" },
    ]);
  });

  it("admits the shared auth_token, which is this host's master credential — and records it as one", async () => {
    // Stated rather than assumed, because it is the one credential here with no
    // account behind it. `dashboard.auth_token` lives in `config.yaml` next to
    // the database, and it already administers `/admin`; refusing it HERE would
    // mean the host's own key could hand out deploy rights but not decide which
    // App release the host publishes, which is not a line anybody drew.
    //
    // What it does not get is anonymity: the record says which credential acted.
    const headers = { authorization: "Bearer sekrit", "content-type": "application/json" };
    expect((await fetch(`${base}/api/apps`, { headers })).status).toBe(200);
    const installed = await fetch(`${base}/api/apps/install`, {
      method: "POST",
      headers,
      body: JSON.stringify({ bundle: variantWire("shared-key") }),
    });
    expect(installed.status).toBe(200);
    const digest = ((await installed.json()) as { package_digest: string }).package_digest;
    const view = await appsView();
    expect(view.releases.find((row) => row.packageDigest === digest)?.installedBy).toBe("shared:auth_token");
  });

  it("does not exist at all on a composition with no registry", async () => {
    const headers = { authorization: `Bearer ${adminKey}`, "content-type": "application/json" };
    // 404, not 403: on this composition the service was never constructed, and
    // answering 403 would advertise a service that is not there.
    expect((await fetch(`${bareBase}/apps`, { headers })).status).toBe(404);
    expect((await fetch(`${bareBase}/api/apps`, { headers })).status).toBe(404);
    const res = await fetch(`${bareBase}/api/apps/activate`, { method: "POST", headers, body: "{}" });
    expect(res.status).toBe(404);
  });

  it("makes a browser write cross the mutation gate", async () => {
    const cookie = { cookie: browser.cookie, "content-type": "application/json", origin: base };
    // No CSRF header: an ambient credential without the double-submit is
    // exactly the shape a cross-site page can produce.
    const noCsrf = await fetch(`${base}/api/apps/deactivate`, { method: "POST", headers: cookie, body: "{}" });
    expect(noCsrf.status).toBe(403);
    // Wrong Origin, with the CSRF header present.
    const badOrigin = await fetch(`${base}/api/apps/deactivate`, {
      method: "POST",
      headers: { ...cookie, origin: "https://evil.example", "x-csrf-token": browser.csrf },
      body: "{}",
    });
    expect(badOrigin.status).toBe(403);
  });
});

describe("install, activate, roll back", () => {
  it("installs without activating, then activates as a second decision", async () => {
    const before = await appsView();
    const wire = variantWire("route-test") as { descriptor: { packageDigest: string } };

    const installed = await asAdminBearer("/api/apps/install", {
      method: "POST",
      body: JSON.stringify({ bundle: wire }),
    });
    expect(installed.status).toBe(200);
    // Routed by the descriptor the bundle carries: an install names no app.
    expect(await installed.json()).toMatchObject({
      ok: true,
      app: APP,
      package_digest: wire.descriptor.packageDigest,
      activated: false,
    });

    const middle = await appsView();
    expect(middle.activePackageDigest).toBe(before.activePackageDigest);
    expect(middle.releases).toHaveLength(before.releases.length + 1);

    const activated = await asAdminBearer("/api/apps/activate", {
      method: "POST",
      body: JSON.stringify({ app: APP, package_digest: wire.descriptor.packageDigest }),
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      ok: true,
      previous_package_digest: before.activePackageDigest,
      changed: true,
      coexistence: "refresh_required",
      reason: "adapter_does_not_support_coexistence",
    });

    // Rolling back is the same call with the older digest.
    const back = await asAdminBearer("/api/apps/activate", {
      method: "POST",
      body: JSON.stringify({ app: APP, package_digest: before.activePackageDigest }),
    });
    expect(back.status).toBe(200);
    expect((await appsView()).activePackageDigest).toBe(before.activePackageDigest);
  });

  it("refuses a malformed bundle, an unknown digest and a bad digest shape", async () => {
    const bad = await asAdminBearer("/api/apps/install", {
      method: "POST",
      body: JSON.stringify({ bundle: { kind: "not-a-bundle" } }),
    });
    expect(bad.status).toBe(400);

    const unknown = await asAdminBearer("/api/apps/activate", {
      method: "POST",
      body: JSON.stringify({ app: APP, package_digest: "f".repeat(64) }),
    });
    expect(unknown.status).toBe(422);

    const shape = await asAdminBearer("/api/apps/activate", {
      method: "POST",
      body: JSON.stringify({ app: APP, package_digest: "../../etc/passwd" }),
    });
    expect(shape.status).toBe(400);
  });

  it("refuses a verb that names an app this host does not serve", async () => {
    // 404 rather than 422: on this composition that app does not exist, and
    // "your release is bad" would be a different, wrong sentence. Every verb
    // names its app — there is deliberately no "the only one" default, because
    // a default is right exactly until a second app is composed.
    const cases: Array<[string, Record<string, unknown>]> = [
      ["/api/apps/activate", { app: "ghost-app", package_digest: "a".repeat(64) }],
      ["/api/apps/deactivate", { app: "ghost-app" }],
      ["/api/apps/uninstall", { app: "ghost-app", package_digest: "a".repeat(64) }],
      ["/api/apps/deactivate", {}],
    ];
    for (const [path, body] of cases) {
      const res = await asAdminBearer(path, { method: "POST", body: JSON.stringify(body) });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(((await res.json()) as { code: string }).code).toBe("unknown_app");
    }
    // And nothing moved.
    expect((await appsView()).activePackageDigest).toBeTruthy();
  });

  it("never returns an artifact byte or a local path", async () => {
    const text = await asAdminBearer("/api/apps").then((r) => r.text());
    expect(text).not.toContain(dir);
    expect(text).not.toContain("<!doctype html>");
    expect(text).not.toContain("contentRoot");
    // But it does return the inventory an operator compares against a build.
    expect(text).toContain("view.js");
    expect(text).toContain("packageDigest");
  });

  it("keeps working when the active artifact is damaged, so a rollback is possible", async () => {
    const view = await appsView();
    const paths = appReleasePaths(dir);
    writeFileSync(join(paths.contentRoot, "releases", `${view.activePackageDigest}.json`), "broken", "utf8");
    // Reconciliation is registry-wide, not per app: a damaged or orphaned
    // artifact belongs to no app by definition.
    const after = (await asAdminBearer("/api/apps").then((r) => r.json())) as AppsView;
    expect(after.reconcile.activeUnusable.map((row) => row.packageDigest)).toContain(view.activePackageDigest);
  });
});

describe("the checkout is described, not published", () => {
  it("reports this checkout's digest and whether it is installed", async () => {
    const view = await appsView();
    expect(view.checkout?.packageDigest).toBe(buildCheckoutBundle().descriptor.packageDigest);
    expect(view.checkout?.installed).toBe(true);
  });
});
