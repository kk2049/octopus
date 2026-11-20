/**
 * Shared-scope declared Apps over real HTTP (ADR 0007 P1, slice B).
 *
 * Slice A pinned the membership DOOR (`app-instance.shared.test.ts`); this file
 * pins the four routes that write what the door reads, and the one page that
 * threads a key through to it. The properties that matter:
 *
 *  · **create → join → open is the whole ceremony.** A minted `asi_` key plus a
 *    login is the invitation; there is no invitation object, no notification,
 *    no approval step. The same URL renders "app" to a member and "join" to a
 *    logged-in non-member.
 *  · **The seat count is the store's, not the route's.** A full role refuses
 *    with 409 whatever order the requests arrived in, and re-joining is the
 *    idempotent 200 that answers the CURRENT seat.
 *  · **Account-scoped Apps refuse the whole vocabulary** — an instance key on
 *    one is a 400 about the request, not a lookup that happens to miss.
 *  · **Nobody holds a seat before the publisher-trust door**, for the same
 *    reason nobody gets a frame before it: membership publishes your username
 *    into the App's shared projection.
 *  · **The act path needs no new plumbing**: a member's dispatch rides the same
 *    per-tab handle header the account Apps use, and lands in the shared
 *    stream the other member's next open projects.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { AppReleaseRegistry, FileReleaseContentStore } from "@claude-bot/app-registry";
import type { AppRuntimeClient, InvokeRequest, InvokeResult, ProjectRequest, RuntimeJson } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { Store } from "../store/store.js";
import { AppInstanceService } from "../app-registry/app-instance.js";
import { AppReleaseHost } from "../app-registry/release-host.js";
import { StoreReleaseCatalog } from "../app-registry/store-catalog.js";
import { appReleasePaths } from "../app-registry/paths.js";
import type { SessionPlusManifest } from "../app-core/manifest.js";
import { readBootstrapPayload } from "./app-page.js";
import {
  DashboardServer,
  mintDashboardToken,
  type DeclaredAppDirectory,
  type DeclaredAppSurface,
} from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";

const NOW = "2026-08-11T10:00:00.000Z";
const KEY = /^asi_[0-9a-f]{32}$/;
const HAVE_BROWSER = (() => {
  try { return existsSync(chromium.executablePath()); } catch { return false; }
})();

const SHARED_MANIFEST: SessionPlusManifest = {
  id: "demo-board",
  schema: 3,
  stateScope: "shared",
  stateEpoch: 0,
  stateEpochDeclared: false,
  roles: {
    white: { max: 1, observer: false },
    black: { max: 1, observer: false },
    watcher: { max: 2, observer: true },
  },
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

const ACCOUNT_MANIFEST: SessionPlusManifest = {
  id: "solo-notes",
  schema: 3,
  stateScope: "account",
  stateEpoch: 0,
  stateEpochDeclared: false,
  roles: {},
  pageFile: "pages/main.yaml",
  agents: {},
  actions: { note: { binding: "runtime", humanOnly: false, agentOnly: false, params: {} } },
};

/** An approver role a share link must never hand out (B5). */
const APPROVAL_MANIFEST: SessionPlusManifest = {
  ...SHARED_MANIFEST,
  id: "approval-desk",
  roles: {
    manager: { max: 8, observer: false },
    submitter: { max: 64, observer: false },
  },
  actions: {
    submit: { binding: "runtime", humanOnly: false, agentOnly: false, roles: ["submitter"], params: {} },
    approve: { binding: "runtime", humanOnly: false, agentOnly: false, roles: ["manager"], params: {} },
    reject: { binding: "runtime", humanOnly: false, agentOnly: false, roles: ["manager"], params: {} },
  },
};

const RESEARCH_MANIFEST: SessionPlusManifest = {
  ...SHARED_MANIFEST,
  id: "research-program",
  roles: {
    owner: { max: 1, observer: false },
    member: { max: 64, observer: false },
    viewer: { max: 64, observer: true },
  },
  actions: {
    move: {
      ...SHARED_MANIFEST.actions.move!,
      roles: ["owner", "member"],
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
    const latest = moves.at(-1) as Record<string, RuntimeJson> | undefined;
    return {
      moves,
      project: { title: typeof latest?.from === "string" ? latest.from : "未命名科研项目", archived: false },
      sessions: latest?.to === "ready" ? [{ session_key: "session-a", lastActivity: NOW }] : [],
      documents: latest?.to === "ready" ? [{ key: "document-a", updated_at: NOW }] : [],
      activity: latest?.to === "ready" ? [{ at: NOW }] : [],
    };
  }

  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    const stamp = { at: "1999-01-01T00:00:00.000Z", by: "liar" };
    return { events: [{ type: "moved", data: { from: request.params.from, to: request.params.to }, ...stamp }], result: null };
  }

  async health(): Promise<{ ok: boolean; backendCodeDigest: string }> {
    return { ok: true, backendCodeDigest: "b".repeat(64) };
  }
}

function release(appId: string, digestByte: string) {
  return {
    stableAppId: appId,
    publisher: "demo:acme",
    packageDigest: digestByte.repeat(64),
    permissionContractDigest: "c".repeat(64),
    backendCodeDigest: "b".repeat(64),
    appDir: `/nonexistent/prepared/${appId}`,
  };
}

interface Browser {
  cookie: string;
  csrf: string;
}

let dir: string;
let store: Store;
let state: AppStateService;
let sharedService: AppInstanceService;
let accountService: AppInstanceService;
let researchService: AppInstanceService;
let approvalService: AppInstanceService;
let server: DashboardServer;
let base = "";
const browsers = new Map<string, Browser>();

async function login(username: string): Promise<Browser> {
  const token = mintDashboardToken(store, username);
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ token }),
  });
  const set = res.headers.getSetCookie();
  const browser = {
    cookie: set.find((c) => c.startsWith("octopus_sess="))?.split(";", 1)[0] ?? "",
    csrf: /octopus_csrf=([0-9a-f]{64})/.exec(set.join(";"))?.[1] ?? "",
  };
  if (!browser.cookie || !browser.csrf) throw new Error(`login failed for ${username}`);
  browsers.set(username, browser);
  return browser;
}

function get(username: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  const browser = browsers.get(username)!;
  return fetch(`${base}${path}`, { redirect: "manual", headers: { cookie: browser.cookie, ...headers } });
}

function post(username: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const browser = browsers.get(username)!;
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: browser.cookie,
      origin: base,
      "x-csrf-token": browser.csrf,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** What the page told the browser, not what its markup looked like. */
async function pageProps(username: string, path: string): Promise<Record<string, unknown>> {
  const res = await get(username, path);
  expect(res.status).toBe(200);
  return readBootstrapPayload(await res.text()).pageProps as Record<string, unknown>;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "apps-shared-route-"));
  store = new Store(join(dir, "t.db"));
  for (const [i, name] of ["alice", "bob", "carol", "dave", "erin"].entries()) {
    store.saveUser({ username: name, uid: 6001 + i, home_dir: join(dir, name), created_at: NOW });
  }
  store.setSetting("carol", "display_name", "Chen Carol");
  store.setSetting("dave", "display_name", "Deng An Wei");

  state = new AppStateService(join(dir, "state"));
  // The composition root's wiring, verbatim: the membership directory the door
  // reads is the SAME store the routes write.
  const directory = {
    instance: (appId: string, key: string) => store.getSharedAppInstance(appId, key),
    member: (appId: string, key: string, username: string) => store.getSharedAppMember(appId, key, username),
  };
  sharedService = new AppInstanceService({
    state: new InProcessStateClient(state),
    runtime: new FakeRuntime(),
    activeRelease: () => release("demo-board", "d"),
    servableRelease: (digest) => digest === "d".repeat(64) ? release("demo-board", "d") : null,
    servablePackageDigests: () => new Set(["d".repeat(64)]),
    shared: directory,
    loadManifest: () => SHARED_MANIFEST,
  });
  accountService = new AppInstanceService({
    state: new InProcessStateClient(state),
    runtime: new FakeRuntime(),
    activeRelease: () => release("solo-notes", "e"),
    servableRelease: (digest) => digest === "e".repeat(64) ? release("solo-notes", "e") : null,
    servablePackageDigests: () => new Set(["e".repeat(64)]),
    shared: directory,
    loadManifest: () => ACCOUNT_MANIFEST,
  });
  researchService = new AppInstanceService({
    state: new InProcessStateClient(state),
    runtime: new FakeRuntime(),
    activeRelease: () => release("research-program", "f"),
    servableRelease: (digest) => digest === "f".repeat(64) ? release("research-program", "f") : null,
    servablePackageDigests: () => new Set(["f".repeat(64)]),
    shared: directory,
    loadManifest: () => RESEARCH_MANIFEST,
  });

  approvalService = new AppInstanceService({
    state: new InProcessStateClient(state),
    runtime: new FakeRuntime(),
    activeRelease: () => release("approval-desk", "a"),
    servableRelease: (digest) => digest === "a".repeat(64) ? release("approval-desk", "a") : null,
    servablePackageDigests: () => new Set(["a".repeat(64)]),
    shared: directory,
    loadManifest: () => APPROVAL_MANIFEST,
  });

  const surfaces: Record<string, DeclaredAppSurface> = {
    "demo-board": {
      stableAppId: "demo-board",
      publisher: "demo:acme",
      title: "Demo Board",
      viewOrigin: "http://app-aaaaaaaaaaaaaaaaaaaa.apps.local:9821",
      packageDigest: "d".repeat(64),
      service: sharedService,
      unavailable: null,
    },
    "solo-notes": {
      stableAppId: "solo-notes",
      publisher: "demo:acme",
      title: "Solo Notes",
      viewOrigin: "http://app-bbbbbbbbbbbbbbbbbbbb.apps.local:9821",
      packageDigest: "e".repeat(64),
      service: accountService,
      unavailable: null,
    },
    "approval-desk": {
      stableAppId: "approval-desk",
      publisher: "demo:acme",
      title: "Approval Desk",
      viewOrigin: "http://app-dddddddddddddddddddd.apps.local:9821",
      packageDigest: "a".repeat(64),
      service: approvalService,
      unavailable: null,
    },
    "research-program": {
      stableAppId: "research-program",
      publisher: "octopus:first-party",
      title: "自动科研项目台",
      viewOrigin: "http://app-cccccccccccccccccccc.apps.local:9821",
      packageDigest: "f".repeat(64),
      service: researchService,
      unavailable: null,
    },
  };
  const declaredApps: DeclaredAppDirectory = {
    list: () => Object.values(surfaces),
    get: (id) => surfaces[id] ?? null,
  };

  // An empty release host: `appRegistry` is a composition feature, and the
  // shared routes must exist on any composition that can open declared Apps.
  const paths = appReleasePaths(dir);
  const registry = new AppReleaseRegistry({
    catalog: new StoreReleaseCatalog(store),
    content: new FileReleaseContentStore(paths.contentRoot),
  });
  server = createDashboardTestServer(store, undefined, {
    port: 0,
    host: "127.0.0.1",
    authToken: "sekrit",
    adminUsers: [],
    surface: "bootstrap-v3",
    sessionHubUi: "unified-v3",
    publicUrl: undefined,
    appReleases: new AppReleaseHost({ registry, apps: [] }),
    declaredApps,
  });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;

  for (const name of ["alice", "bob", "carol", "dave", "erin"]) await login(name);
  // Everyone but dave answers the publisher-trust door up front; dave exists to
  // show what the routes say to someone who has not.
  for (const name of ["alice", "bob", "carol", "erin"]) {
    const res = await post(name, "/api/app-view/trust?app=demo-board", { decision: "trust" });
    expect(res.status).toBe(200);
    expect((await post(name, "/api/app-view/trust?app=solo-notes", { decision: "trust" })).status).toBe(200);
    expect((await post(name, "/api/app-view/trust?app=research-program", { decision: "trust" })).status).toBe(200);
    expect((await post(name, "/api/app-view/trust?app=approval-desk", { decision: "trust" })).status).toBe(200);
  }
});

afterAll(async () => {
  await server?.stop();
  sharedService?.stop();
  accountService?.stop();
  researchService?.stop();
  approvalService?.stop();
  await state?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("create → join → open", () => {
  let key = "";

  it("mints a server-named instance and seats the creator", async () => {
    const res = await post("alice", "/api/apps/demo-board/shared-instances", { role: "white" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; instance_key: string; role: string };
    expect(body.ok).toBe(true);
    expect(body.instance_key).toMatch(KEY);
    expect(body.role).toBe("white");
    key = body.instance_key;
    // Creator membership landed in the same transaction.
    expect(store.getSharedAppMember("demo-board", key, "alice")?.role).toBe("white");
  });

  it("opens as mode 'app' for the member, with the key in props", async () => {
    const response = await get("alice", `/apps/demo-board/open?instance=${key}`);
    const props = readBootstrapPayload(await response.text()).pageProps as Record<string, unknown>;
    expect(props.mode).toBe("app");
    expect(props.instanceKey).toBe(key);
    const directives = (response.headers.get("content-security-policy") ?? "").split(";").map((d) => d.trim());
    expect(directives.filter((d) => d.startsWith("media-src"))).toEqual(["media-src blob:"]);
    expect(directives).toContain("default-src 'none'");
  });

  it("renders mode 'join' with live seat counts for a logged-in non-member", async () => {
    const response = await get("bob", `/apps/demo-board/open?instance=${key}`);
    const props = readBootstrapPayload(await response.text()).pageProps as Record<string, unknown>;
    expect(response.headers.get("content-security-policy")).not.toContain("media-src");
    expect(props.mode).toBe("join");
    expect(props.instanceKey).toBe(key);
    // Both player seats drive the same one action here, so neither is a
    // privilege over the other and both are open to a share link (B5).
    expect(props.seats).toEqual([
      { role: "white", max: 1, observer: false, taken: 1, joinable: true },
      { role: "black", max: 1, observer: false, taken: 0, joinable: true },
      { role: "watcher", max: 2, observer: true, taken: 0, joinable: true },
    ]);
  });

  it("seats the joiner, after which the same URL is the app", async () => {
    const res = await post("bob", `/api/apps/demo-board/shared-instances/${key}/join`, { role: "black" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, instance_key: key, role: "black" });
    expect((await pageProps("bob", `/apps/demo-board/open?instance=${key}`)).mode).toBe("app");
  });

  it("reports seats and my membership for the join page's poll", async () => {
    const res = await get("bob", `/api/apps/demo-board/shared-instances/${key}/seats`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      instance_key: key,
      my_role: "black",
      seats: [
        { role: "white", max: 1, taken: 1 },
        { role: "black", max: 1, taken: 1 },
        { role: "watcher", max: 2, taken: 0 },
      ],
    });
  });

  it("dispatches through the untouched act path, into the ONE shared stream", async () => {
    // The per-tab handle rides exactly where an account App's does — the
    // shared routes added no wire field to the act/stream/close family.
    const opened = await get("alice", `/apps/demo-board/open?instance=${key}`);
    const handle = /id="octopus-app-instance">"([^"]+)"<\/script>/.exec(await opened.text())?.[1];
    expect(handle).toBeTruthy();
    const acted = await post(
      "alice",
      "/api/app-view/act?app=demo-board",
      { action: "move", params: { from: "e2", to: "e4" } },
      { "x-app-instance": handle! },
    );
    expect(acted.status).toBe(200);
    // The other member's next open folds the move: one stream, two people.
    const props = await pageProps("bob", `/apps/demo-board/open?instance=${key}`);
    expect(props.projection).toMatchObject({ moves: [{ from: "e2", to: "e4" }] });
  });

  it("refuses the full seat at the store's transaction, names the reason", async () => {
    const res = await post("carol", `/api/apps/demo-board/shared-instances/${key}/join`, { role: "white" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("seat_full");
    expect(store.getSharedAppMember("demo-board", key, "carol")).toBeUndefined();
  });

  it("answers a member's re-join with the CURRENT seat, whatever was asked", async () => {
    const res = await post("bob", `/api/apps/demo-board/shared-instances/${key}/join`, { role: "white" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, role: "black", already_member: true });
  });

  it("seats an observer within the watcher capacity", async () => {
    const res = await post("carol", `/api/apps/demo-board/shared-instances/${key}/join`, { role: "watcher" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, role: "watcher" });
  });
});

describe("a share link cannot hand out a privileged role (B5)", () => {
  let key = "";

  it("seats a visitor in the least-privileged role and refuses the approver seat", async () => {
    const created = await post("alice", "/api/apps/approval-desk/shared-instances", { role: "manager" });
    expect(created.status).toBe(200);
    key = ((await created.json()) as { instance_key: string }).instance_key;

    const seats = (await (await get("bob", `/api/apps/approval-desk/shared-instances/${key}/seats`)).json()) as {
      default_role: string;
      seats: Array<{ role: string; joinable: boolean }>;
    };
    expect(seats.default_role).toBe("submitter");
    expect(seats.seats.map(({ role, joinable }) => ({ role, joinable }))).toEqual([
      { role: "manager", joinable: false },
      { role: "submitter", joinable: true },
    ]);

    const escalate = await post("bob", `/api/apps/approval-desk/shared-instances/${key}/join`, { role: "manager" });
    expect(escalate.status).toBe(403);
    expect(((await escalate.json()) as { code: string }).code).toBe("role_assigned_by_creator");
    expect(store.getSharedAppMember("approval-desk", key, "bob")).toBeUndefined();

    // No role named: the server's default, never the visitor's choice.
    const joined = await post("bob", `/api/apps/approval-desk/shared-instances/${key}/join`, {});
    expect(joined.status).toBe(200);
    expect(await joined.json()).toMatchObject({ ok: true, role: "submitter" });
  });

  it("keeps the creator's member management able to grant the approver role", async () => {
    const granted = await post("alice", `/api/apps/approval-desk/shared-instances/${key}/members`, {
      username: "carol",
      role: "manager",
    });
    expect(granted.status).toBe(200);
    expect(store.getSharedAppMember("approval-desk", key, "carol")?.role).toBe("manager");
    // A member who is not the creator still cannot.
    const foreign = await post("bob", `/api/apps/approval-desk/shared-instances/${key}/members`, {
      username: "bob",
      role: "manager",
    });
    expect(foreign.status).toBe(403);
    expect(store.getSharedAppMember("approval-desk", key, "bob")?.role).toBe("submitter");
  });

  it("does not let a removed member back in through the same link; the creator can re-add", async () => {
    expect((await post("alice", `/api/apps/approval-desk/shared-instances/${key}/members/remove`, { username: "bob" })).status)
      .toBe(200);
    const again = await post("bob", `/api/apps/approval-desk/shared-instances/${key}/join`, {});
    expect(again.status).toBe(403);
    expect(((await again.json()) as { code: string }).code).toBe("membership_removed");
    expect(store.getSharedAppMember("approval-desk", key, "bob")).toBeUndefined();

    expect((await post("alice", `/api/apps/approval-desk/shared-instances/${key}/members`, {
      username: "bob",
      role: "submitter",
    })).status).toBe(200);
    expect(store.getSharedAppMember("approval-desk", key, "bob")?.role).toBe("submitter");
    expect(store.isSharedAppMemberRemoved("approval-desk", key, "bob")).toBe(false);
  });
});

describe("the instances page and owner isolation", () => {
  it("lists only the viewer's own memberships, with role and member count", async () => {
    // A second instance only alice belongs to.
    const created = await post("alice", "/api/apps/demo-board/shared-instances", { role: "black" });
    const second = ((await created.json()) as { instance_key: string }).instance_key;

    const mine = (await (await get("alice", "/api/apps/demo-board/shared-instances")).json()) as {
      instances: Array<{ instance_key: string; role: string; members: number }>;
    };
    const keys = mine.instances.map((row) => row.instance_key);
    expect(keys).toContain(second);
    expect(mine.instances.find((row) => row.instance_key === second)).toMatchObject({ role: "black", members: 1 });

    const bobs = (await (await get("bob", "/api/apps/demo-board/shared-instances")).json()) as {
      instances: Array<{ instance_key: string }>;
    };
    expect(bobs.instances.map((row) => row.instance_key)).not.toContain(second);

    // The page projects the same list, as availability metadata.
    const props = await pageProps("bob", "/apps/demo-board/open");
    expect(props.mode).toBe("instances");
    const listed = (props.instances as Array<{ instanceKey: string }>).map((row) => row.instanceKey);
    expect(listed).not.toContain(second);
    expect(props.roles).toEqual([
      { role: "white", max: 1, observer: false },
      { role: "black", max: 1, observer: false },
      { role: "watcher", max: 2, observer: true },
    ]);

    // Administration is creator-only and generic across shared Apps.
    const added = await post("alice", `/api/apps/demo-board/shared-instances/${second}/members`, {
      username: "dave",
      role: "watcher",
    });
    expect(added.status).toBe(200);
    expect(store.getSharedAppMember("demo-board", second, "dave")?.role).toBe("watcher");
    const released = vi.spyOn(sharedService, "releaseSharedInstance");
    const changedRole = await post("alice", `/api/apps/demo-board/shared-instances/${second}/members`, {
      username: "dave",
      role: "white",
    });
    expect(changedRole.status).toBe(200);
    expect(released).toHaveBeenCalledWith(second, "shared_membership_changed", "dave");
    released.mockRestore();
    const foreign = await post("bob", `/api/apps/demo-board/shared-instances/${second}/members`, {
      username: "carol",
      role: "watcher",
    });
    expect(foreign.status).toBe(403);
    const members = await get("alice", `/api/apps/demo-board/shared-instances/${second}/members`);
    expect(await members.json()).toMatchObject({
      creator: "alice",
      members: [{ username: "alice", role: "black" }, { username: "dave", role: "white" }],
    });
    expect((await post("alice", `/api/apps/demo-board/shared-instances/${second}/members/remove`, { username: "dave" })).status)
      .toBe(200);
    expect(store.getSharedAppMember("demo-board", second, "dave")).toBeUndefined();
    expect((await post("alice", `/api/apps/demo-board/shared-instances/${second}/close`, {})).status).toBe(200);
    expect(store.getSharedAppInstance("demo-board", second)?.status).toBe("closed");
  });

  it("autocompletes non-members by username, display text or initials without empty-query enumeration", async () => {
    const created = await post("alice", "/api/apps/demo-board/shared-instances", { role: "black" });
    const second = ((await created.json()) as { instance_key: string }).instance_key;
    expect(await (await get("alice", `/api/apps/demo-board/shared-instances/${second}/member-candidates?q=`)).json())
      .toEqual({ ok: true, candidates: [] });

    const initials = await get("alice", `/api/apps/demo-board/shared-instances/${second}/member-candidates?q=daw`);
    expect(initials.status).toBe(200);
    expect(await initials.json()).toEqual({
      ok: true,
      candidates: [{ username: "dave", display_name: "Deng An Wei" }],
    });

    expect((await get("bob", `/api/apps/demo-board/shared-instances/${second}/member-candidates?q=car`)).status)
      .toBe(403);
    expect((await post("alice", `/api/apps/demo-board/shared-instances/${second}/members`, {
      username: "dave",
      role: "watcher",
    })).status).toBe(200);
    expect(await (await get("alice", `/api/apps/demo-board/shared-instances/${second}/member-candidates?q=dave`)).json())
      .toEqual({ ok: true, candidates: [] });
  });
});

describe("legacy research project compatibility", () => {
  let key = "";

  it("opens the clean App URL directly on a project and supplies human-titled trusted navigation", async () => {
    const created = await post("alice", "/api/apps/research-program/shared-instances", { role: "owner" });
    key = ((await created.json()) as { instance_key: string }).instance_key;

    const opened = await get("alice", `/apps/research-program/open?instance=${key}`);
    const handle = /id="octopus-app-instance">"([^"]+)"<\/script>/.exec(await opened.text())?.[1];
    expect(handle).toBeTruthy();
    expect((await post(
      "alice",
      "/api/app-view/act?app=research-program",
      { action: "move", params: { from: "ProjectA", to: "ready" } },
      { "x-app-instance": handle! },
    )).status).toBe(200);
    const blank = await post("alice", "/api/apps/research-program/shared-instances", { role: "owner" });
    const blankKey = ((await blank.json()) as { instance_key: string }).instance_key;

    const clean = await get("alice", "/apps/research-program/open");
    expect(clean.status).toBe(200);
    const bootstrap = readBootstrapPayload(await clean.text());
    // Legacy projects remain accessible by URL; the main entry belongs to v2.
    expect(bootstrap.nav).not.toContainEqual(expect.objectContaining({ path: "/apps/research-program/open" }));
    expect(bootstrap.pageProps).toMatchObject({
      mode: "app",
      instanceKey: key,
      workspace: {
        currentInstanceKey: key,
      },
    });
    const projects = (bootstrap.pageProps as unknown as {
      workspace: { projects: Array<Record<string, unknown>> };
    }).workspace.projects;
    expect(projects).toContainEqual(expect.objectContaining({
      instanceKey: key,
      title: "ProjectA",
      role: "owner",
      manageable: true,
    }));
    expect(projects).toContainEqual(expect.objectContaining({ instanceKey: blankKey }));
  });

  it("keeps membership-backed projects discoverable when all projection caches are missing", async () => {
    const count = store.listSharedAppInstancesFor('research-program', 'alice').length;
    const spy = vi.spyOn(researchService, 'readSharedProjections').mockResolvedValueOnce([]);
    try {
      const props = await pageProps('alice', `/apps/research-program/open?instance=${key}`);
      const projects = (props as { workspace: { projects: Array<{ instanceKey: string; title: string }> } }).workspace.projects;
      expect(projects).toHaveLength(count);
      expect(projects).toContainEqual(expect.objectContaining({ instanceKey: key, title: 'ProjectA' }));
      expect(projects.some(row => row.title.startsWith('项目资料待加载'))).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it("renders a share-link visitor's join inside the same workspace contract", async () => {
    const props = await pageProps("bob", `/apps/research-program/open?instance=${key}`);
    expect(props).toMatchObject({
      mode: "join",
      instanceKey: key,
      workspace: { currentInstanceKey: key, projects: [] },
      seats: [
        { role: "owner", max: 1, taken: 1 },
        { role: "member", max: 64, taken: 0 },
        { role: "viewer", max: 64, taken: 0 },
      ],
    });
  });
});

describe("research project directory windows", () => {
  // 150 memberships: more than two windows. Pairs share a created_at so the
  // keyset's instance_key tie-break is exercised, not just the timestamp.
  const TOTAL = 150;
  const keys: string[] = [];
  const createdAt = (index: number) => new Date(Date.UTC(2026, 0, 1) + Math.floor(index / 2) * 60_000).toISOString();

  beforeAll(() => {
    for (let index = 0; index < TOTAL; index += 1) {
      const key = `asi_${index.toString(16).padStart(32, "0")}`;
      keys.push(key);
      store.createSharedAppInstance({
        app_id: "research-program",
        instance_key: key,
        creator: "erin",
        created_at: createdAt(index),
        status: "open",
      }, "owner");
    }
  });

  /** The directory order: newest first, instance_key descending within a tie. */
  const expectedOrder = () => keys
    .map((key, index) => ({ key, at: createdAt(index) }))
    .sort((left, right) => (left.at === right.at ? (left.key < right.key ? 1 : -1) : left.at < right.at ? 1 : -1))
    .map((row) => row.key);

  it("walks every project through the cursor with no duplicate or gap, even while new projects appear", async () => {
    const spy = vi.spyOn(researchService, "readSharedProjections");
    try {
      const seen: string[] = [];
      let cursor: string | undefined;
      let windows = 0;
      let late = "";
      do {
        const res = await get("erin", `/api/apps/research-program/shared-instances${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { instances: Array<{ instance_key: string; role: string; title: string }>; next_cursor?: string };
        expect(body.instances.length).toBeLessThanOrEqual(64);
        expect(body.instances.every((row) => row.role === "owner" && typeof row.title === "string")).toBe(true);
        seen.push(...body.instances.map((row) => row.instance_key));
        cursor = body.next_cursor;
        windows += 1;
        if (windows === 1) {
          // Created after the first window: newer than every cursor, so it
          // cannot shift the windows still ahead.
          const created = await post("erin", "/api/apps/research-program/shared-instances", { role: "owner" });
          late = ((await created.json()) as { instance_key: string }).instance_key;
        }
      } while (cursor);
      expect(windows).toBe(3);
      expect(seen).toEqual(expectedOrder());
      expect(seen).not.toContain(late);
      // Projection work stays one window per request, whatever the total.
      expect(spy.mock.calls.every(([, requested]) => requested.length <= 64)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect((await get("erin", "/api/apps/research-program/shared-instances?cursor=not-a-cursor")).status).toBe(400);
  });

  it("puts the first window and its cursor in the page, and keeps the URL's own project beyond it", async () => {
    const oldest = keys[0]!;
    const props = await pageProps("erin", `/apps/research-program/open?instance=${oldest}`) as {
      mode: string;
      workspace: { projects: Array<{ instanceKey: string; role: string; manageable?: boolean }>; nextCursor?: string; currentInstanceKey?: string };
    };
    expect(props.mode).toBe("app");
    expect(props.workspace.nextCursor).toEqual(expect.any(String));
    expect(props.workspace).not.toHaveProperty("truncated");
    expect(props.workspace.currentInstanceKey).toBe(oldest);
    // 64 windowed rows plus the pinned current project, which is not an invitation.
    expect(props.workspace.projects).toHaveLength(65);
    expect(props.workspace.projects.at(-1)).toMatchObject({ instanceKey: oldest, role: "owner", manageable: true });

    const next = await get("erin", `/api/apps/research-program/shared-instances?cursor=${encodeURIComponent(props.workspace.nextCursor!)}`);
    const window = (await next.json()) as { instances: Array<{ instance_key: string }> };
    const firstWindow = props.workspace.projects.slice(0, 64).map((row) => row.instanceKey);
    expect(window.instances.some((row) => firstWindow.includes(row.instance_key))).toBe(false);
  });
});

describe.skipIf(!HAVE_BROWSER)("legacy research projects in a real browser", () => {
  it("keeps the empty project rail accessible by URL at phone width", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 780 } });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));
    try {
      const token = mintDashboardToken(store, "carol");
      await page.goto(`${base}/login`);
      await page.fill('input[type="password"]', token);
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => !url.pathname.startsWith("/login"));
      await page.goto(`${base}/apps/research-program/open`);
      await page.getByRole("button", { name: "打开主导航" }).click();
      expect(await page.locator('a[href="/apps/research-program/open"]').count()).toBe(0);
      await page.getByRole("heading", { name: "自动科研工作台" }).waitFor();
      await page.getByLabel("科研项目导航").waitFor();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      expect(problems).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

describe("refusals", () => {
  it("refuses an unknown role on create and on join", async () => {
    const create = await post("alice", "/api/apps/demo-board/shared-instances", { role: "king" });
    expect(create.status).toBe(400);
    expect(((await create.json()) as { code: string }).code).toBe("unknown_role");

    const made = await post("alice", "/api/apps/demo-board/shared-instances", { role: "watcher" });
    const key = ((await made.json()) as { instance_key: string }).instance_key;
    const join = await post("bob", `/api/apps/demo-board/shared-instances/${key}/join`, { role: "king" });
    expect(join.status).toBe(400);
    expect(((await join.json()) as { code: string }).code).toBe("unknown_role");
  });

  it("404s a well-formed key nobody minted", async () => {
    const ghost = `asi_${"f".repeat(32)}`;
    const join = await post("bob", `/api/apps/demo-board/shared-instances/${ghost}/join`, { role: "black" });
    expect(join.status).toBe(404);
    expect(((await join.json()) as { code: string }).code).toBe("instance_missing");
    expect((await get("bob", `/api/apps/demo-board/shared-instances/${ghost}/seats`)).status).toBe(404);
    expect((await get("bob", `/apps/demo-board/open?instance=${ghost}`)).status).toBe(404);
  });

  it("400s a key that is not the mint's grammar, before any lookup", async () => {
    for (const bad of ["asi_short", "asi_" + "G".repeat(32), "x".repeat(36)]) {
      expect((await post("bob", `/api/apps/demo-board/shared-instances/${bad}/join`, { role: "black" })).status,
      ).toBe(400);
      expect((await get("bob", `/api/apps/demo-board/shared-instances/${bad}/seats`)).status).toBe(400);
      expect((await get("bob", `/apps/demo-board/open?instance=${bad}`)).status).toBe(400);
    }
  });

  it("refuses the whole vocabulary on an account-scoped App", async () => {
    expect((await get("alice", `/apps/solo-notes/open?instance=asi_${"a".repeat(32)}`)).status).toBe(400);
    expect((await post("alice", "/api/apps/solo-notes/shared-instances", { role: "white" })).status).toBe(400);
    expect((await get("alice", "/api/apps/solo-notes/shared-instances")).status).toBe(400);
    // And without a key the account App still opens exactly as before.
    const props = await pageProps("alice", "/apps/solo-notes/open");
    expect(props.mode).toBe("app");
    expect(props.instanceKey).toBeUndefined();
  });

  it("puts the publisher-trust door before every seat", async () => {
    expect((await post("dave", "/api/apps/demo-board/shared-instances", { role: "white" })).status).toBe(403);
    expect((await get("dave", "/api/apps/demo-board/shared-instances")).status).toBe(403);
    // A share link for an untrusted publisher lands on consent, not join: the
    // reload after trusting keeps `?instance=` and lands on the join page.
    const made = await post("alice", "/api/apps/demo-board/shared-instances", { role: "white" });
    const key = ((await made.json()) as { instance_key: string }).instance_key;
    expect((await post("dave", `/api/apps/demo-board/shared-instances/${key}/join`, { role: "black" })).status).toBe(403);
    const props = await pageProps("dave", `/apps/demo-board/open?instance=${key}`);
    expect(props.mode).toBe("consent");
  });

  it("refuses a bearer credential: a seat belongs to a browser login", async () => {
    const token = mintDashboardToken(store, "alice");
    const res = await fetch(`${base}/api/apps/demo-board/shared-instances`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});
