/**
 * `external-app-host/v1` over real HTTP: the transport half.
 *
 * `app-external/service.test.ts` pins what a binding MEANS. This file pins the
 * things only a server can get wrong on its own, and every one of them is a
 * property a browser will then rely on:
 *
 *  · the trusted grant face is a browser-session route like any other, and it
 *    is the ONLY way agent authority is created;
 *  · the external face answers exactly one allow-listed origin, never a
 *    wildcard, and never with `access-control-allow-credentials` — so a browser
 *    holding an Octopus cookie gains nothing by pointing at it;
 *  · the credential travels in a header. A secret in the query string is not
 *    accepted anywhere, and the surface is a 404 on a deployment that
 *    configured no host at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppRuntimeClient, InvokeRequest, InvokeResult, ProjectRequest, RuntimeJson } from "@claude-bot/app-runtime";
import { AppReleaseRegistry, FileReleaseContentStore } from "@claude-bot/app-registry";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { AppReleaseHost } from "../app-registry/release-host.js";
import { appReleasePaths } from "../app-registry/paths.js";
import { StoreReleaseCatalog } from "../app-registry/store-catalog.js";
import { externalAppHostSettings } from "../app-external/settings.js";
import { AppInstanceService } from "../app-registry/app-instance.js";
import type { SessionPlusManifest } from "../app-core/manifest.js";
import { Store } from "../store/store.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import {
  DashboardServer,
  mintDashboardToken,
  type DeclaredAppDirectory,
  type DeclaredAppSurface,
} from "./server.js";

const NOW = "2026-08-17T10:00:00.000Z";
const APP = "demo-board";
const DIGEST = "d".repeat(64);
const DSH = "http://127.0.0.1:9931";
const STRANGER = "http://127.0.0.1:9999";

const MANIFEST: SessionPlusManifest = {
  id: APP,
  schema: 3,
  stateScope: "shared",
  stateEpoch: 0,
  stateEpochDeclared: false,
  roles: { white: { max: 1, observer: false }, black: { max: 1, observer: false } },
  pageFile: "pages/main.yaml",
  agents: {},
  actions: {
    move: {
      binding: "runtime",
      humanOnly: false,
      agentOnly: false,
      roles: ["white", "black"],
      params: { from: { type: "string", max: 8, required: true }, to: { type: "string", max: 8, required: true } },
    },
  },
};

class FakeRuntime implements AppRuntimeClient {
  async project(request: ProjectRequest): Promise<RuntimeJson> {
    const snapshot = request.snapshot && typeof request.snapshot === "object" && !Array.isArray(request.snapshot)
      ? request.snapshot as Record<string, RuntimeJson>
      : {};
    const moves = Array.isArray(snapshot.moves) ? [...snapshot.moves] : [];
    moves.push(...request.events.filter((e) => e.type === "moved").map((e) => e.data as RuntimeJson));
    return { moves };
  }

  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    const stamp = { at: NOW, by: "liar" };
    return { events: [{ type: "moved", data: { from: request.params.from, to: request.params.to }, ...stamp }], result: null };
  }

  async health(): Promise<{ ok: boolean; backendCodeDigest: string }> {
    return { ok: true, backendCodeDigest: "b".repeat(64) };
  }
}

const RELEASE = {
  stableAppId: APP,
  publisher: "demo:acme",
  packageDigest: DIGEST,
  permissionContractDigest: "c".repeat(64),
  backendCodeDigest: "b".repeat(64),
  appDir: `/nonexistent/prepared/${APP}`,
};

let dir: string;
let store: Store;
let state: AppStateService;
let instances: AppInstanceService;
let server: DashboardServer;
let bare: DashboardServer;
let base = "";
let bareBase = "";
let cookie = "";
let csrf = "";
let instanceKey = "";

async function login(username: string): Promise<void> {
  const token = mintDashboardToken(store, username);
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ token }),
  });
  const set = res.headers.getSetCookie();
  cookie = set.find((c) => c.startsWith("octopus_sess="))?.split(";", 1)[0] ?? "";
  csrf = /octopus_csrf=([0-9a-f]{64})/.exec(set.join(";"))?.[1] ?? "";
  if (!cookie || !csrf) throw new Error("login failed");
}

function panelPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: base, "x-csrf-token": csrf, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function external(path: string, init: RequestInit & { origin?: string | null } = {}): Promise<Response> {
  const { origin, headers, ...rest } = init;
  return fetch(`${base}/api/external/app${path}`, {
    redirect: "manual",
    ...rest,
    headers: {
      ...(origin === null ? {} : { origin: origin ?? DSH }),
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(headers as Record<string, string> | undefined),
    },
  });
}

/** One full handoff: mint on the trusted page, redeem from the host. */
async function bindOne(authority: "human" | "agent"): Promise<{
  credential: string;
  credentialId: string;
  launchUrl: string;
}> {
  const minted = await panelPost(`/api/app-external/launch?app=${APP}`, {
    instance_key: instanceKey,
    host: "dsh-local",
    authority,
  });
  expect(minted.status).toBe(200);
  const body = await minted.json() as { launch_url: string };
  const token = new URL(body.launch_url).hash.split("=")[1]!;
  const exchanged = await external("/exchange", { method: "POST", body: JSON.stringify({ token: decodeURIComponent(token) }) });
  expect(exchanged.status).toBe(200);
  const value = await exchanged.json() as { credential: string; binding: { credential_id: string } };
  return { credential: value.credential, credentialId: value.binding.credential_id, launchUrl: body.launch_url };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "app-external-route-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 7001, home_dir: join(dir, "alice"), created_at: NOW });
  state = new AppStateService(join(dir, "state"));
  instances = new AppInstanceService({
    state: new InProcessStateClient(state),
    runtime: new FakeRuntime(),
    activeRelease: () => RELEASE,
    servableRelease: (digest) => (digest === DIGEST ? RELEASE : null),
    servablePackageDigests: () => new Set([DIGEST]),
    shared: {
      instance: (appId, key) => store.getSharedAppInstance(appId, key),
      member: (appId, key, username) => store.getSharedAppMember(appId, key, username),
    },
    loadManifest: () => MANIFEST,
  });
  const surface: DeclaredAppSurface = {
    stableAppId: APP,
    publisher: "demo:acme",
    title: "Demo Board",
    viewOrigin: "http://app-aaaaaaaaaaaaaaaaaaaa.apps.local:9821",
    packageDigest: DIGEST,
    service: instances,
    unavailable: null,
  };
  const declaredApps: DeclaredAppDirectory = { list: () => [surface], get: (id) => (id === APP ? surface : null) };
  // An empty release host: `appRegistry` is what puts the App routes on the
  // surface at all, exactly as `apps-shared-route.test.ts` composes it.
  const paths = appReleasePaths(dir);
  const appReleases = new AppReleaseHost({
    registry: new AppReleaseRegistry({
      catalog: new StoreReleaseCatalog(store),
      content: new FileReleaseContentStore(paths.contentRoot),
    }),
    apps: [],
  });
  const common = {
    port: 0,
    host: "127.0.0.1",
    authToken: "sekrit",
    adminUsers: [],
    surface: "bootstrap-v3" as const,
    sessionHubUi: "unified-v3" as const,
    appReleases,
    declaredApps,
  };
  server = createDashboardTestServer(store, undefined, {
    ...common,
    externalAppHosts: externalAppHostSettings({
      enabled: true,
      hosts: [{ id: "dsh-local", origin: DSH, label: "本机 DSH" }],
    })!,
  });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
  // The same composition with NO external host configured: the surface must be
  // absent rather than merely refusing.
  bare = createDashboardTestServer(store, undefined, common);
  await bare.start();
  bareBase = `http://127.0.0.1:${bare.port}`;

  await login("alice");
  expect((await panelPost(`/api/app-view/trust?app=${APP}`, { decision: "trust" })).status).toBe(200);
  const created = await panelPost(`/api/apps/${APP}/shared-instances`, { role: "white" });
  expect(created.status).toBe(200);
  instanceKey = (await created.json() as { instance_key: string }).instance_key;
  // Two full panel compositions plus a login on a 2-core box: the default
  // 10s hook budget is about the machine, not about the code under test.
}, 120_000);

afterAll(async () => {
  await server?.stop();
  await bare?.stop();
  instances?.stop();
  await state?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe("the trusted grant face", () => {
  it("mints a launch URL whose secret is only in the fragment", async () => {
    const { launchUrl } = await bindOne("human");
    const url = new URL(launchUrl);
    expect(url.origin).toBe(DSH);
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#octopus_app_launch=xlg_/);
    expect(url.pathname).toBe("/octopus/app-launch");
  });

  it("refuses an unknown host, an unknown authority and a malformed instance", async () => {
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ instance_key: instanceKey, host: "nope", authority: "human" }, 403],
      [{ instance_key: instanceKey, host: "dsh-local", authority: "root" }, 400],
      [{ instance_key: instanceKey, host: "dsh-local" }, 400],
      [{ instance_key: "not-a-key", host: "dsh-local", authority: "human" }, 400],
    ];
    for (const [body, status] of cases) {
      const res = await panelPost(`/api/app-external/launch?app=${APP}`, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
    }
  });

  it("lists and revokes bindings for the caller's own account only", async () => {
    const { credential, credentialId } = await bindOne("human");
    const listed = await fetch(`${base}/api/app-external/bindings?app=${APP}`, { headers: { cookie } });
    expect(listed.status).toBe(200);
    const body = await listed.json() as { bindings: Array<{ credential_id: string; status: string }>; hosts: unknown[] };
    expect(body.hosts).toHaveLength(1);
    const active = body.bindings.filter((row) => row.status === "active");
    expect(active.map((row) => row.credential_id)).toContain(credentialId);
    // The list is what a person reads; the secret it describes is not in it.
    expect(JSON.stringify(body)).not.toContain(credential);
    const target = credentialId;
    expect((await panelPost(`/api/app-external/revoke?app=${APP}`, { credential_id: target })).status).toBe(200);
    // Twice is honest rather than fatal: there is nothing left to revoke.
    expect((await panelPost(`/api/app-external/revoke?app=${APP}`, { credential_id: target })).status).toBe(401);
    const after = await external("/describe", { headers: { authorization: `Bearer ${credential}` } });
    expect(after.status).toBe(401);
  });

  it("is unreachable without a browser session", async () => {
    const res = await fetch(`${base}/api/app-external/launch?app=${APP}`, {
      method: "POST",
      headers: { authorization: "Bearer sekrit", "content-type": "application/json", origin: base },
      body: JSON.stringify({ instance_key: instanceKey, host: "dsh-local", authority: "human" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("the external transport", () => {
  it("answers ONE exact origin, with no wildcard and no cookie authority", async () => {
    const { credential } = await bindOne("human");
    const res = await external("/describe", { headers: { authorization: `Bearer ${credential}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(DSH);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(res.headers.get("vary")).toContain("origin");
    // The header that would make a browser attach an Octopus cookie.
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.json() as { view: { origin: string; frame_protocol: string } };
    // The View a host is told to frame: the App's own immutable document.
    expect(body.view.origin).toBe("http://app-aaaaaaaaaaaaaaaaaaaa.apps.local:9821");
    expect(body.view.frame_protocol).toBe("session-plus/2");
  });

  it("answers the preflight for an allow-listed origin and refuses any other", async () => {
    const ok = await external("/propose", { method: "OPTIONS" });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(DSH);
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(ok.headers.get("access-control-allow-headers")).toContain("x-app-instance");
    const refused = await external("/propose", { method: "OPTIONS", origin: STRANGER });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a valid credential presented from an origin it was not minted for", async () => {
    const { credential } = await bindOne("human");
    const wrong = await external("/describe", {
      origin: STRANGER,
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get("access-control-allow-origin")).toBeNull();
    const none = await external("/describe", { origin: null, headers: { authorization: `Bearer ${credential}` } });
    expect(none.status).toBe(403);
  });

  it("takes the credential from the header and from nowhere else", async () => {
    const { credential } = await bindOne("human");
    // A query parameter is not a credential here: the request is simply
    // unauthenticated, and the secret would have been in the access log.
    const viaQuery = await fetch(`${base}/api/external/app/describe?credential=${encodeURIComponent(credential)}`, {
      headers: { origin: DSH },
    });
    expect(viaQuery.status).toBe(401);
    const viaCookie = await external("/describe", { headers: { cookie } });
    expect(viaCookie.status).toBe(401);
  });

  it("holds the two authorities apart at the route, before any body is read", async () => {
    const human = await bindOne("human");
    const agent = await bindOne("agent");
    const asAgent = await external("/agent-propose", {
      method: "POST",
      headers: { authorization: `Bearer ${human.credential}` },
      body: JSON.stringify({ action: "move", params: { from: "6,4", to: "4,4" } }),
    });
    expect(asAgent.status).toBe(403);
    expect((await asAgent.json() as { code: string }).code).toBe("operation_refused");
    const asHuman = await external("/propose", {
      method: "POST",
      headers: { authorization: `Bearer ${agent.credential}` },
      body: JSON.stringify({ action: "move", params: { from: "6,4", to: "4,4" } }),
    });
    expect(asHuman.status).toBe(403);
  });

  it("drives one real move end to end, through open → propose → close", async () => {
    const { credential } = await bindOne("human");
    const auth = { authorization: `Bearer ${credential}` };
    const opened = await external("/open", { method: "POST", headers: auth, body: "{}" });
    expect(opened.status).toBe(200);
    const handle = (await opened.json() as { handle: string }).handle;
    const moved = await external("/propose", {
      method: "POST",
      headers: { ...auth, "x-app-instance": handle },
      body: JSON.stringify({ action: "move", params: { from: "6,4", to: "4,4" } }),
    });
    expect(moved.status).toBe(200);
    expect((await moved.json() as { projection: { moves: unknown[] } }).projection.moves).toContainEqual({
      from: "6,4",
      to: "4,4",
    });
    const read = await external("/read", { method: "POST", headers: auth, body: "{}" });
    expect(read.status).toBe(200);
    const closed = await external("/close", { method: "POST", headers: { ...auth, "x-app-instance": handle } });
    expect(closed.status).toBe(200);
  });

  /**
   * The gate runs in `onRequest`, before Fastify reads a body. The observable
   * consequence — and the reason it is worth a test — is that a caller who was
   * never admitted is never told anything about the SHAPE of a request, and
   * never gets to spend this process's parser to find that out.
   */
  it("refuses an unknown origin before the body is parsed", async () => {
    const malformed = await fetch(`${base}/api/external/app/exchange`, {
      method: "POST",
      headers: { origin: STRANGER, "content-type": "application/json" },
      body: "{ this is not json",
    });
    expect(malformed.status).toBe(403);
    expect((await malformed.json() as { code: string }).code).toBe("origin_refused");
    // The same broken body from an allow-listed origin DOES reach the parser,
    // which is what proves the refusal above happened earlier than parsing.
    const admitted = await fetch(`${base}/api/external/app/exchange`, {
      method: "POST",
      headers: { origin: DSH, "content-type": "application/json" },
      body: "{ this is not json",
    });
    expect(admitted.status).toBe(400);
    expect(admitted.headers.get("access-control-allow-origin")).toBe(DSH);
  });

  it("refuses an unknown origin ahead of the operation table", async () => {
    // A stranger cannot map which operations exist by reading status codes:
    // a real path and a nonsense one answer identically.
    const real = await external("/propose", { method: "POST", origin: STRANGER, body: "{}" });
    const fake = await external("/nonsense", { method: "POST", origin: STRANGER, body: "{}" });
    expect(real.status).toBe(403);
    expect(fake.status).toBe(403);
    expect((await real.json() as { code: string }).code).toBe("origin_refused");
    expect((await fake.json() as { code: string }).code).toBe("origin_refused");
  });

  it("refuses the wrong method and an unknown operation without leaking either", async () => {
    const { credential } = await bindOne("human");
    const auth = { authorization: `Bearer ${credential}` };
    expect((await external("/describe", { method: "POST", headers: auth, body: "{}" })).status).toBe(405);
    expect((await external("/propose", { headers: auth })).status).toBe(405);
    expect((await external("/nonsense", { headers: auth })).status).toBe(404);
  });

  it("does not exist at all on a deployment that configured no external host", async () => {
    const res = await fetch(`${bareBase}/api/external/app/describe`, { headers: { origin: DSH } });
    expect(res.status).toBe(404);
    const launch = await fetch(`${bareBase}/api/app-external/bindings?app=${APP}`, { headers: { cookie } });
    // The route exists on the surface, and the composition serves no host, so
    // it answers "not here" rather than half-working.
    expect(launch.status).toBe(404);
  });
});
