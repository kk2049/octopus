/**
 * The feature flag, over real HTTP, in both positions.
 *
 * The retired `/sessions` URL is always only a redirect. The flag decides
 * whether its canonical Session Plus destination exists and is advertised.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readBootstrapPayload } from "./app-page.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { AppRuntimeService, InProcessRuntimeClient } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { resolveSessionPlus } from "../app-core/settings.js";
import { sessionPlusIdentity } from "../app-core/identity.js";
import { bundledAppDir } from "../app-core/app-path.js";
import { SessionPlusAppService } from "../session-plus/app-service.js";

const NOW = "2026-08-04T10:00:00.000Z";
const LABEL = sessionPlusIdentity().packageHostLabel;
const PANEL_URL = "https://bot.example.org";
const VIEW_ORIGIN = `https://${LABEL}.apps.example.org`;

function settings() {
  const r = resolveSessionPlus({
    config: { enabled: true, view_origin: VIEW_ORIGIN },
    publicUrl: PANEL_URL,
  });
  if (!r.enabled || !r.settings) throw new Error(r.errors.join("; "));
  return r.settings;
}

let dir: string;
let store: Store;
let off: DashboardServer;
let on: DashboardServer;
let offBase = "";
let onBase = "";
let key = "";
let app: SessionPlusAppService;
let appState: AppStateService;
let appRuntime: AppRuntimeService;
const browsers = new Map<string, { cookie: string; csrf: string }>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sp-route-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: join(dir, "alice"), created_at: NOW });
  key = mintDashboardToken(store, "alice");
  appState = new AppStateService(join(dir, "app-state"));
  appRuntime = new AppRuntimeService(bundledAppDir("session-plus"));
  app = new SessionPlusAppService({
    state: new InProcessStateClient(appState),
    runtime: new InProcessRuntimeClient(appRuntime),
    identity: sessionPlusIdentity(),
  });

  const common = {
    port: 0,
    host: "127.0.0.1" as const,
    authToken: "sekrit",
    adminUsers: [] as string[],
    surface: "bootstrap-v3" as const,
    sessionHubUi: "unified-v3" as const,
  };
  off = createDashboardTestServer(store, undefined, { ...common });
  on = createDashboardTestServer(store, undefined, { ...common, sessionPlus: settings(), sessionPlusApp: app });
  await off.start();
  await on.start();
  offBase = `http://127.0.0.1:${off.port}`;
  onBase = `http://127.0.0.1:${on.port}`;
  for (const base of [offBase, onBase]) {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ token: key }),
    });
    const set = res.headers.getSetCookie();
    const session = set.find((c) => c.startsWith("octopus_sess="))?.split(";", 1)[0] ?? "";
    const csrf = /octopus_csrf=([0-9a-f]{64})/.exec(set.join(";"))?.[1] ?? "";
    browsers.set(base, { cookie: session, csrf });
  }
});

afterAll(async () => {
  await off.stop();
  await on.stop();
  app.stop();
  await appRuntime.stop();
  appState.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (base: string, path: string) =>
  fetch(base + path, { headers: { cookie: browsers.get(base)?.cookie ?? "" }, redirect: "manual" });

const login = (base: string) => fetch(`${base}/login`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ token: key }),
});

const postOn = (path: string, body: unknown) => {
  const browser = browsers.get(onBase)!;
  return fetch(onBase + path, {
    method: "POST",
    headers: {
      cookie: browser.cookie,
      origin: onBase,
      "x-csrf-token": browser.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
};

describe("flag off: the deployment is unchanged", () => {
  it("lands login on Overview instead of a disabled Session Plus route", async () => {
    const response = await login(offBase);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  });

  it("does not serve /sessions-plus", async () => {
    const res = await get(offBase, "/sessions-plus");
    expect(res.status).toBe(404);
    // Absent, not forbidden: a feature nobody turned on is not a permission
    // problem, and 403 would advertise that it exists.
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("session plus") });
  });

  it("offers no 会话+ tab anywhere in the navigation", async () => {
    for (const path of ["/permissions", "/tickets"]) {
      const res = await get(offBase, path);
      if (res.status !== 200) continue;
      const html = await res.text();
      expect(html, path).not.toContain('href="/sessions-plus"');
      expect(html, path).not.toContain("会话+");
    }
  });

  it("keeps /sessions as the same compatibility redirect in both modes", async () => {
    const [a, b] = await Promise.all([get(offBase, "/sessions"), get(onBase, "/sessions")]);
    expect(a.status).toBe(303);
    expect(b.status).toBe(303);
    expect(a.headers.get("location")).toBe("/sessions-plus");
    expect(b.headers.get("location")).toBe("/sessions-plus");
  });
});

describe("flag on: one page, one origin, one frame", () => {
  it("lands login on the sole session UI", async () => {
    const response = await login(onBase);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sessions-plus");
  });

  it("opens the first-party App without a per-release consent page, bootstrapping only owner-local defaults", async () => {
    // Session Plus is built from this repository (`octopus:first-party`), so
    // there is no publisher-trust page in front of it any more (O12): the
    // first visit already frames the App.
    expect(on.appTrust.status("alice", {
      appId: "session-plus",
      publisher: "octopus:first-party",
      profile: "publisher-js",
      packageDigest: sessionPlusIdentity().packageDigest,
    })).toEqual({ trusted: true, reason: "first_party", decision: null });

    const record = await get(onBase, "/api/session-plus/release");
    expect(record.status).toBe(200);
    const release = (await record.json()) as { packageDigest: string; sourceSnapshot: { files: Array<{ path: string }> } };
    expect(release.packageDigest).toBe(sessionPlusIdentity().packageDigest);
    expect(release.sourceSnapshot.files.map((file) => file.path)).toContain("app/app.yaml");
    const source = await get(onBase, "/api/session-plus/release?source=app%2Fapp.yaml");
    expect(await source.text()).toContain("id: session-plus");

    const opened = await get(onBase, "/sessions-plus");
    expect(opened.status).toBe(200);
    const openedHtml = await opened.text();
    const boot = readBootstrapPayload(openedHtml);
    expect(boot.nav.map((tab) => tab.path)).toContain("/sessions-plus");
    expect(boot.nav.map((tab) => tab.path)).not.toContain("/sessions");
    const openedProps = boot.pageProps as unknown as {
      mode: string;
      authorization: { needsAuthorization: boolean; editable: boolean };
    };
    expect(openedProps.mode).toBe("app");
    // Opening materialises only the owner-local defaults. Shared document
    // operations remain the second door, so authorization is still needed.
    expect(openedProps.authorization).toMatchObject({ needsAuthorization: true, editable: true });
    expect(on.permissions.get("app", "session-plus", "alice")).toMatchObject({
      source: "bootstrap",
      createdBy: "system:self-service",
    });
    expect(openedHtml).toContain("octopus-app-instance");
  });

  it("writes and revokes a user App grant through the existing permission plane", async () => {
    const granted = await postOn("/api/permissions/grant", {
      subject_type: "app",
      subject_id: "session-plus",
      operations: sessionPlusIdentity().contract.operations,
    });
    expect(granted.status).toBe(200);
    expect(on.permissions.get("app", "session-plus", "alice")).toMatchObject({
      source: "user",
      publisher: "octopus:first-party",
      contractDigest: sessionPlusIdentity().permissionContractDigest,
      status: "active",
    });
    const projection = (await (await get(onBase, "/api/permissions")).json()) as {
      subjects: Array<{ id: string; editable: boolean; grant: { source: string } | null; permissions: { entries: unknown[] } }>;
    };
    const sessionPlus = projection.subjects.find((subject) => subject.id === "session-plus");
    expect(sessionPlus).toMatchObject({
      editable: true,
      grant: { source: "user" },
    });
    // One row per operation the RUNNING release declares — eight since the
    // read-only workspace browser, not the union of everything this build could
    // implement. Deriving the expected count from the identity is what keeps
    // this honest when a release with a different ask is activated.
    expect(sessionPlus?.permissions.entries)
      .toHaveLength(sessionPlusIdentity().contract.operations.length);
    expect(sessionPlus?.permissions.entries.map((entry) => (entry as { operation: string }).operation))
      .toEqual(expect.arrayContaining(["list_workspace_entries", "read_workspace_text"]));
    const page = await get(onBase, "/sessions-plus");
    expect(
      (readBootstrapPayload(await page.text()).pageProps as {
        authorization: { needsAuthorization: boolean };
      }).authorization.needsAuthorization,
    ).toBe(false);

    const revoked = await postOn("/api/permissions/revoke", {
      subject_type: "app",
      subject_id: "session-plus",
    });
    expect(revoked.status).toBe(200);
    expect(on.permissions.get("app", "session-plus", "alice")?.status).toBe("revoked");
  });

  it("keeps a deployment-owned App grant visible and read-only", async () => {
    on.permissions.grant({
      subjectType: "app",
      subjectId: "session-plus",
      owner: "alice",
      operations: ["list_recent_sessions"],
      autoAllow: ["list_recent_sessions"],
      source: "config",
      createdBy: "system:config",
    });
    const projection = (await (await get(onBase, "/api/permissions")).json()) as {
      subjects: Array<{ id: string; editable: boolean; grant: { source: string } | null }>;
    };
    expect(projection.subjects.find((subject) => subject.id === "session-plus")).toMatchObject({
      editable: false,
      grant: { source: "config" },
    });
    expect((await postOn("/api/permissions/grant", {
      subject_type: "app",
      subject_id: "session-plus",
      operations: ["read_session"],
    })).status).toBe(400);
    expect((await postOn("/api/permissions/revoke", {
      subject_type: "app",
      subject_id: "session-plus",
    })).status).toBe(400);
    expect(
      (readBootstrapPayload(await (await get(onBase, "/sessions-plus")).text()).pageProps as {
        authorization: { source: string; editable: boolean };
      }).authorization,
    ).toMatchObject({ source: "config", editable: false });
  });

  it("projects a previous publisher's capability grant as invalid", async () => {
    on.permissions.grant({
      subjectType: "app",
      subjectId: "session-plus",
      owner: "alice",
      operations: sessionPlusIdentity().contract.operations,
      autoAllow: sessionPlusIdentity().contract.autoAllow,
      source: "user",
      createdBy: "alice",
      publisher: "retired:publisher",
      contractDigest: sessionPlusIdentity().permissionContractDigest,
    });
    const projection = (await (await get(onBase, "/api/permissions")).json()) as {
      subjects: Array<{
        id: string;
        permissions: { grantedCount: number; effectiveCount: number; needsAuthorization: boolean; entries: Array<{ reasons: string[] }> };
      }>;
    };
    const subject = projection.subjects.find((entry) => entry.id === "session-plus")!;
    expect(subject.permissions).toMatchObject({
      grantedCount: 0,
      effectiveCount: 0,
      needsAuthorization: true,
    });
    expect(subject.permissions.entries.every((entry) => entry.reasons.includes("publisher_changed"))).toBe(true);
    expect(
      (readBootstrapPayload(await (await get(onBase, "/sessions-plus")).text()).pageProps as {
        authorization: { publisherChanged: boolean };
      }).authorization.publisherChanged,
    ).toBe(true);
  });

  it("permits exactly the configured App origin in frame-src, and nothing else", async () => {
    const res = await get(onBase, "/sessions-plus");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`frame-src ${VIEW_ORIGIN}`);
    expect(csp).not.toContain("*.apps.example.org");
    expect(csp).not.toMatch(/frame-src[^;]*\*/);
    // Same-origin mounted App media comes from bytes read through resource
    // authorization, never a new cross-origin media fetch.
    expect(csp.split(";").map((d) => d.trim()).filter((d) => d.startsWith("media-src"))).toEqual(["media-src blob:"]);
    // The deny-all baseline is still underneath it.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
  });

  it("hands the frame nothing but an origin", async () => {
    const html = await (await get(onBase, "/sessions-plus")).text();
    // The frame is created by the trusted transport, whose decisions are
    // asserted in `packages/dashboard-web/src/session-plus/frame-host.test.ts`
    // (including that the frame's src is the bare origin with no query string).
    // What this checks is the payload the SERVER composes for it.
    const props = readBootstrapPayload(html).pageProps as Record<string, unknown>;
    expect(props.mode).toBe("app");
    expect((props.identity as Record<string, unknown>).viewOrigin).toBe(VIEW_ORIGIN);
    // The page IS the trusted shell, so the document legitimately carries the
    // viewer's identity — what matters is that none of it is in the projection
    // the frame receives.
    const projection = JSON.stringify(props.projection ?? {}).toLowerCase();
    for (const forbidden of ["alice", "csrf", "octopus_sess"]) {
      expect(projection, `the projection must not carry ${forbidden}`).not.toContain(forbidden);
    }
    const forbiddenKeys = /^(instance|handle|token|credential|owner|username|csrf|cookie|secret)$/i;
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        expect(forbiddenKeys.test(name), `the projection must not carry a ${name} field`).toBe(false);
        walk(child);
      }
    };
    walk(props.projection);
  });

  it("shows the app's identity on the trusted side, where it is allowed to be", async () => {
    const html = await (await get(onBase, "/sessions-plus")).text();
    const id = sessionPlusIdentity();
    const props = readBootstrapPayload(html).pageProps as unknown as {
      identity: Record<string, string>;
    };
    expect(props.identity.stableAppId).toBe(id.stableAppId);
    expect(props.identity.publisher).toBe(id.publisher);
    expect(props.identity.packageDigest).toBe(id.packageDigest);
    expect(props.identity.permissionContractDigest).toBe(id.permissionContractDigest);
    // The trusted shell shows publication identity but never reflects a user,
    // account scope or credential into a MessagePort response.
    expect(html).not.toContain("boundTo");
  });

  it("gives the trusted side every authorization row it needs to render the second door", async () => {
    // Layout is now a component concern (and is proved end to end by the real
    // browser suite). What the server still owes the page is the DATA for the
    // trusted chrome: the publisher-trust reason and one row per declared
    // operation with its three columns.
    const html = await (await get(onBase, "/sessions-plus")).text();
    const props = readBootstrapPayload(html).pageProps as unknown as {
      trustReason: string;
      authorization: { entries: Array<Record<string, unknown>> };
    };
    expect(props.trustReason).toBe("first_party");
    // One row per operation the RUNNING release declares, not per operation this
    // build knows how to describe. Somebody must not be able to consent, on this
    // screen, to something the release they are about to open never asked for.
    expect(props.authorization.entries.map((entry) => entry.operation))
      .toEqual([...sessionPlusIdentity().contract.operations]);
    for (const entry of props.authorization.entries) {
      expect(entry).toHaveProperty("operation");
      expect(entry).toHaveProperty("granted");
      expect(entry).toHaveProperty("effective");
      expect(entry).toHaveProperty("explanation");
    }
  });

  it("binds the real action and state stream to one header-only tab handle", async () => {
    const page = await get(onBase, "/sessions-plus");
    const html = await page.text();
    // The handle rides in its own JSON block, which the app reads once and
    // removes. It is absent from the bootstrap payload — checked below — and
    // from every URL and MessagePort message.
    const handle = /id="octopus-app-instance">"([a-f0-9]{48})"<\/script>/.exec(html)?.[1];
    expect(handle).toMatch(/^[a-f0-9]{48}$/);
    expect(JSON.stringify(readBootstrapPayload(html))).not.toContain(handle!);
    const browser = browsers.get(onBase)!;
    const action = await fetch(`${onBase}/api/session-plus/act`, {
      method: "POST",
      headers: {
        cookie: browser.cookie,
        origin: onBase,
        "x-csrf-token": browser.csrf,
        "x-session-plus-instance": handle!,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "pin_session",
        params: { session: "demo-codex", owner: "root", approved: true },
      }),
    });
    expect(action.status).toBe(200);
    expect(await action.json()).toMatchObject({
      ok: true,
      result: { session: "demo-codex" },
      projection: { pinned: ["demo-codex"] },
    });

    const controller = new AbortController();
    const stream = await fetch(`${onBase}/api/session-plus/stream`, {
      headers: { cookie: browser.cookie, "x-session-plus-instance": handle! },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    for (let i = 0; i < 4 && !received.includes("event: view"); i++) {
      const part = await reader.read();
      if (part.done) break;
      received += decoder.decode(part.value, { stream: true });
    }
    expect(received).toContain("event: view");
    controller.abort();

    const forged = await fetch(`${onBase}/api/session-plus/act`, {
      method: "POST",
      headers: {
        cookie: browser.cookie,
        origin: onBase,
        "x-csrf-token": browser.csrf,
        "x-session-plus-instance": "0".repeat(48),
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "pin_session", params: { session: "demo-codex" } }),
    });
    expect(forged.status).toBe(404);
  });

  it("accepts bounded content-free browser performance only from a live tab", async () => {
    const page = await get(onBase, "/sessions-plus");
    const handle = /id="octopus-app-instance">"([a-f0-9]{48})"<\/script>/.exec(await page.text())?.[1];
    expect(handle).toBeTruthy();
    const browser = browsers.get(onBase)!;
    const send = (instance: string, body: unknown) => fetch(`${onBase}/api/session-plus/performance`, {
      method: "POST",
      headers: {
        cookie: browser.cookie,
        origin: onBase,
        "x-csrf-token": browser.csrf,
        "x-session-plus-instance": instance,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const report = {
      version: 2,
      windowMs: 60_000,
      projectionCount: 12,
      sessionRowsMax: 84,
      sourceRowsMax: 9,
      transcriptWindowsMax: 4,
      transcriptMessagesMax: 800,
      projectionDispatchMaxMs: 4.2,
      longTaskCount: 3,
      longTaskTotalMs: 210.5,
      longTaskMaxMs: 95.1,
      timerLagCount: 2,
      timerLagMaxMs: 160,
      viewReportCount: 1,
      viewInputEventCount: 14,
      viewInputFrameCount: 12,
      viewInputFrameTotalMs: 180,
      viewInputFrameMaxMs: 42,
      viewInputFrameOver50Count: 0,
      viewProjectionCommitCount: 30,
      viewProjectionCommitTotalMs: 140,
      viewProjectionCommitMaxMs: 10,
      viewProjectionFrameCount: 27,
      viewProjectionFrameTotalMs: 360,
      viewProjectionFrameMaxMs: 25,
      viewLongTaskCount: 1,
      viewLongTaskTotalMs: 72,
      viewLongTaskMaxMs: 72,
      viewTimerLagCount: 1,
      viewTimerLagMaxMs: 180,
      viewDomNodesMax: 11_000,
      ignoredContent: "must not reach the structured metric",
    };

    const accepted = await send(handle!, report);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ ok: true });

    const forged = await send("0".repeat(48), report);
    expect(forged.status).toBe(404);

    const invalid = await send(handle!, { ...report, longTaskCount: -1 });
    expect(invalid.status).toBe(400);

    const legacy: Record<string, unknown> = { ...report, version: 1 };
    for (const key of Object.keys(legacy)) {
      if (key.startsWith("view")) delete legacy[key];
    }
    const acceptedLegacy = await send(handle!, legacy);
    expect(acceptedLegacy.status).toBe(202);
  });

  it("keeps provider refusal codes and the parent resource generation intact over HTTP", async () => {
    const page = await get(onBase, "/sessions-plus");
    const html = await page.text();
    const handle = /id="octopus-app-instance">"([a-f0-9]{48})"<\/script>/.exec(html)?.[1];
    const props = readBootstrapPayload(html).pageProps as { resourceGeneration: number };
    expect(handle).toBeTruthy();
    // This fixture has no hot-release binding plan, so zero is the honest
    // generation. App-service tests exercise the real 1 -> 2 provider swap;
    // this test owns the HTTP/header/serialization seam around it.
    expect(props.resourceGeneration).toBe(0);
    const browser = browsers.get(onBase)!;
    const headers = (generation: number) => ({
      cookie: browser.cookie,
      origin: onBase,
      "x-csrf-token": browser.csrf,
      "x-session-plus-instance": handle!,
      "x-session-plus-resource-generation": String(generation),
    });
    const act = (generation: number) => fetch(`${onBase}/api/session-plus/act`, {
      method: "POST",
      headers: { ...headers(generation), "content-type": "application/json" },
      body: JSON.stringify({ action: "resource.refresh_roots", params: { binding: "workspace" } }),
    });

    const dispatch = vi.spyOn(app, "dispatch").mockResolvedValueOnce({
      ok: false,
      code: "resource_refused",
      resourceCode: "approval_required",
      message: "请先在可信栏批准",
    });
    const refused = await act(0);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, code: "approval_required" });
    expect(dispatch).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({ owner: "alice" }),
      { action: "resource.refresh_roots", params: { binding: "workspace" } },
      0,
    );
    dispatch.mockRestore();

    const reset = await fetch(`${onBase}/api/session-plus/reconstruct`, {
      method: "POST",
      headers: headers(0),
    });
    const resetBody = await reset.json();
    expect({ status: reset.status, body: resetBody }).toEqual({
      status: 200,
      body: { ok: true, generation: 0 },
    });

    const wrong = await fetch(`${onBase}/api/session-plus/reconstruct`, {
      method: "POST",
      headers: headers(1),
    });
    expect(wrong.status).toBe(409);

    const { "x-session-plus-resource-generation": _generation, ...withoutGeneration } = headers(0);
    const missing = await fetch(`${onBase}/api/session-plus/reconstruct`, {
      method: "POST",
      headers: withoutGeneration,
    });
    expect(missing.status).toBe(400);
  });

  it("ships no inline executable script, on the page hosting an independently published App", async () => {
    const res = await get(onBase, "/sessions-plus");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await res.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag.includes('src="/ui/') || tag.includes('type="application/json"') || tag.includes('type="importmap"'), tag).toBe(true);
    }
  });

  it("still requires authentication, like every other page", async () => {
    const res = await fetch(onBase + "/sessions-plus", {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?next=%2Fsessions-plus");
  });

  it("does not treat a raw account bearer as a live browser tab", async () => {
    const res = await fetch(onBase + "/sessions-plus", {
      headers: { authorization: `Bearer ${key}` },
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("浏览器登录会话") });
  });

  it("has no first-party trust to revoke: a revoke leaves the open App and its durable state alone", async () => {
    const before = await get(onBase, "/sessions-plus");
    const handle = /id="octopus-app-instance">"([a-f0-9]{48})"<\/script>/.exec(await before.text())?.[1];
    expect(handle).toBeTruthy();
    const revoked = await postOn("/api/session-plus/trust", { decision: "revoke" });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ trust: { trusted: true, reason: "first_party" } });

    const browser = browsers.get(onBase)!;
    const stale = await fetch(`${onBase}/api/session-plus/act`, {
      method: "POST",
      headers: {
        cookie: browser.cookie,
        origin: onBase,
        "x-csrf-token": browser.csrf,
        "x-session-plus-instance": handle!,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "pin_session", params: { session: "other" } }),
    });
    expect(stale.status).toBe(200);
    const restored = await get(onBase, "/sessions-plus");
    expect(await restored.text()).toMatch(/"pinned":\[[^\]]*"demo-codex"/);
  });
});
