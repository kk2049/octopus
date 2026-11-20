import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppRuntimeClient, InvokeRequest, InvokeResult, ProjectRequest, RuntimeJson } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { SharedAppManagement } from "../app-registry/shared-management.js";
import { AppTrustService } from "../permissions/app-trust.js";
import { AppInstanceService } from "../app-registry/app-instance.js";
import { PermissionService } from "../permissions/service.js";
import type { SessionPlusManifest } from "../app-core/manifest.js";
import { SessionHubService } from "../sessionhub/service.js";
import { Store } from "../store/store.js";
import { MCP_APPS_OPERATION_IDS, MCP_SUBJECT_ID, mcpSubjectEntry } from "./catalog.js";
import { McpSurface, type McpDeclaredApp } from "./service.js";
import { mcpTokenPolicy } from "./tokens.js";

const NOW = "2026-08-13T00:00:00.000Z";
const MANIFEST: SessionPlusManifest = {
  id: "team-reports",
  schema: 4,
  stateScope: "shared",
  stateEpoch: 0,
  stateEpochDeclared: false,
  roles: { member: { max: 64, observer: false }, observer: { max: 64, observer: true } },
  pageFile: "pages/main.yaml",
  agents: {
    mcp: { name: "mcp", adapter: "openai-loop", prompt: "Act through the trusted MCP turn.", role: "member" },
  },
  actions: {
    submit: {
      binding: "runtime",
      humanOnly: false,
      agentOnly: false,
      roles: ["member"],
      params: { text: { type: "string", max: 200, required: true } },
    },
  },
};

class Runtime implements AppRuntimeClient {
  async project(request: ProjectRequest): Promise<RuntimeJson> {
    const snapshot = request.snapshot && typeof request.snapshot === "object" && !Array.isArray(request.snapshot)
      ? request.snapshot as Record<string, RuntimeJson>
      : {};
    const reports = Array.isArray(snapshot.reports) ? [...snapshot.reports] : [];
    reports.push(...request.events.filter((event) => event.type === "submitted").map((event) => event.data as RuntimeJson));
    const viewer = request.context?.viewer as { role?: string } | undefined;
    return { reports, ...(viewer ? { viewer_role: viewer.role ?? null } : {}) };
  }
  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    return { events: [{ type: "submitted", data: { text: request.params.text }, at: NOW, by: "ignored" }], result: null };
  }
  async health() { return { ok: true, backendCodeDigest: "b".repeat(64) }; }
}

describe("MCP shared App addressing", () => {
  let dir: string;
  let store: Store;
  let state: AppStateService;
  let service: AppInstanceService;
  let surface: McpSurface;
  let permissions: PermissionService;
  let trust: AppTrustService;
  const instance = "asi_reports1";
  const alice = { owner: "alice", credential: "mcp:alice" };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-shared-app-"));
    store = new Store(join(dir, "bot.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    store.saveUser({ username: "mallory", uid: 5002, home_dir: "/x/m", created_at: NOW });
    store.createSharedAppInstance({ app_id: "team-reports", instance_key: instance, creator: "alice", created_at: NOW, status: "open" }, "member");
    state = new AppStateService(join(dir, "state"));
    const release = {
      stableAppId: "team-reports", publisher: "acme:reports", packageDigest: "a".repeat(64),
      permissionContractDigest: "c".repeat(64), backendCodeDigest: "b".repeat(64), appDir: "/nonexistent/team-reports",
    };
    service = new AppInstanceService({
      state: new InProcessStateClient(state), runtime: new Runtime(),
      activeRelease: () => release,
      servableRelease: (digest) => digest === release.packageDigest ? release : null,
      servablePackageDigests: () => new Set([release.packageDigest]),
      shared: {
        instance: (appId, key) => store.getSharedAppInstance(appId, key),
        member: (appId, key, username) => store.getSharedAppMember(appId, key, username),
      },
      loadManifest: () => MANIFEST,
    });
    const app: McpDeclaredApp = {
      stableAppId: "team-reports", publisher: release.publisher, title: "Team Reports",
      packageDigest: release.packageDigest, service, unavailable: null,
    };
    trust = new AppTrustService(store);
    trust.trust("alice", { appId: app.stableAppId, publisher: app.publisher, profile: "publisher-js", packageDigest: app.packageDigest! }, false);
    permissions = new PermissionService({
      store,
      subjects: [mcpSubjectEntry({ workspaceComposed: () => false, crdtComposed: () => false, appsComposed: () => true })],
      extraAccountOperations: [() => [...MCP_APPS_OPERATION_IDS]],
    });
    permissions.grant({
      subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice",
      operations: [...MCP_APPS_OPERATION_IDS], autoAllow: [], source: "user", createdBy: "alice",
    });
    const hub = new SessionHubService({ store, permissions });
    surface = new McpSurface({
      hub,
      permissions,
      apps: {
        management: new SharedAppManagement({ store, trust, get: (id) => id === app.stableAppId ? { ...app, service } : null }),
        list: () => [app],
        get: (id) => id === app.stableAppId ? app : null,
        instancesFor: (appId, owner) => store.listSharedAppInstancesFor(appId, owner).map((row) => ({
          instance: row.instance_key,
          role: store.getSharedAppMember(appId, row.instance_key, owner)!.role,
          creator: row.creator,
          status: row.status,
          members: store.listSharedAppMembers(appId, row.instance_key).length,
        })),
      },
    });
  });

  afterAll(async () => {
    surface.close();
    service.stop();
    await state.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists only memberships and routes projection, dispatch and log to that partition", async () => {
    expect(await surface.callTool(alice, "app_list", {})).toMatchObject({
      ok: true,
      result: { apps: [{ app: "team-reports", state_scope: "shared", instances: [{ instance, role: "member" }] }] },
    });
    expect(await surface.callTool(alice, "app_dispatch", {
      app: "team-reports", instance, action: "submit", params: { text: "本周进展" },
    })).toMatchObject({ ok: true, result: { instance, projection: { reports: [{ text: "本周进展" }] } } });
    expect(await surface.callTool(alice, "app_read_projection", { app: "team-reports", instance }))
      .toMatchObject({ ok: true, result: { instance, projection: { reports: [{ text: "本周进展" }] } } });
    expect(await surface.callTool(alice, "app_read_log", { app: "team-reports", instance }))
      .toMatchObject({ ok: true, result: { instance, head: 1, commits: [{ action: "submit" }] } });
  });

  it("intersects shared membership with a token-local instance allowlist", async () => {
    const narrowed = { ...alice, policy: mcpTokenPolicy({ groups: ["apps"], appInstances: ["asi_other"] }) };
    expect(await surface.callTool(narrowed, "app_list", {}))
      .toMatchObject({ ok: true, result: { apps: [{ instances: [] }] } });
    expect(await surface.callTool(narrowed, "app_read_projection", { app: "team-reports", instance }))
      .toMatchObject({ ok: false, code: "no_authority" });
  });
  it("keeps an external MCP observer read-only instead of borrowing the declared agent role", async () => {
    store.saveUser({ username: "bob", uid: 5003, home_dir: "/x/b", created_at: NOW });
    store.setSharedAppMember("team-reports", instance, "bob", "observer", 64, NOW);
    permissions.grant({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "bob",
      operations: [...MCP_APPS_OPERATION_IDS], autoAllow: [], source: "user", createdBy: "bob" });
    const bob = { owner: "bob", credential: "mcp:bob" };
    expect(await surface.callTool(bob, "app_read_projection", { app: "team-reports", instance }))
      .toMatchObject({ ok: true, result: { projection: { viewer_role: "observer" } } });
    expect(await surface.callTool(bob, "app_dispatch", { app: "team-reports", instance, action: "submit", params: { text: "borrow member role" } }))
      .toMatchObject({ ok: false, code: "action_rejected" });
  });

  const sharedArgs = { app: "team-reports", role: "member" };
  async function createProject() {
    const answer = await surface.callTool(alice, "app_shared_create", sharedArgs);
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error(answer.message);
    return String((answer.result as { instance_key: string }).instance_key);
  }

  it("requires a new management grant, without expanding existing dispatch grants", async () => {
    permissions.grant({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice",
      operations: ["list_apps", "dispatch_app_action"], autoAllow: [], source: "user", createdBy: "alice" });
    expect(surface.listTools(alice).some(t => t.name === "app_shared_create")).toBe(false);
    expect(await surface.callTool(alice, "app_shared_create", sharedArgs)).toMatchObject({ ok: false, code: "no_authority" });
    permissions.grant({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice",
      operations: [...MCP_APPS_OPERATION_IDS], autoAllow: [], source: "user", createdBy: "alice" });
    const key = await createProject();
    expect(store.getSharedAppInstance("team-reports", key)?.creator).toBe("alice");
    expect(store.getSharedAppMember("team-reports", key, "alice")?.role).toBe("member");
    expect(await surface.callTool(alice, "app_shared_members", { app: "team-reports", instance: key }))
      .toMatchObject({ ok: true, result: { members: [{ username: "alice", role: "member" }] } });
  });

  it("enforces token group, App, instance and action narrowing for administration", async () => {
    for (const policy of [mcpTokenPolicy({ groups: ["sessions"] }), mcpTokenPolicy({ groups: ["apps"], appIds: ["another-app"] }),
      mcpTokenPolicy({ groups: ["apps"], appInstances: [instance] }), mcpTokenPolicy({ groups: ["apps"], appActions: ["submit"] })]) {
      const answer = await surface.callTool({ ...alice, policy }, "app_shared_create", sharedArgs);
      expect(answer.ok).toBe(false);
    }
    const key = await createProject();
    const narrowed = { ...alice, policy: mcpTokenPolicy({ groups: ["apps"], appInstances: [instance] }) };
    expect(await surface.callTool(narrowed, "app_shared_members", { app: "team-reports", instance: key }))
      .toMatchObject({ ok: false, code: "no_authority" });
    expect(await surface.callTool(alice, "app_shared_create", { ...sharedArgs, owner: "mallory" }))
      .toMatchObject({ ok: false, code: "invalid_params" });
  });

  it("shares creator checks, role invalidation, removal and close with trusted chrome", async () => {
    const key = await createProject();
    const release = vi.spyOn(service, "releaseSharedInstance");
    const target = { app: "team-reports", instance: key };
    try {
      expect(await surface.callTool(alice, "app_shared_set_member", { ...target, member: "mallory", role: "member" })).toMatchObject({ ok: true });
      permissions.grant({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "mallory",
        operations: [...MCP_APPS_OPERATION_IDS], autoAllow: [], source: "user", createdBy: "mallory" });
      trust.trust("mallory", { appId: "team-reports", publisher: "acme:reports", profile: "publisher-js", packageDigest: "a".repeat(64) }, false);
      const mallory = { owner: "mallory", credential: "mcp:mallory" };
      expect(await surface.callTool(mallory, "app_shared_set_member", { ...target, member: "mallory", role: "observer" })).toMatchObject({ ok: false, code: "creator_required" });
      expect(await surface.callTool(mallory, "app_shared_members", target)).toMatchObject({ ok: false, code: "creator_required" });
      expect(await surface.callTool(alice, "app_shared_set_member", { ...target, member: "mallory", role: "observer" })).toMatchObject({ ok: true });
      expect(release).toHaveBeenCalledWith(key, "shared_membership_changed", "mallory");
      expect(await surface.callTool(mallory, "app_dispatch", { ...target, action: "submit", params: { text: "stale write" } })).toMatchObject({ ok: false, code: "action_rejected" });
      expect(await surface.callTool(alice, "app_shared_remove_member", { ...target, member: "alice" })).toMatchObject({ ok: false, code: "creator_required" });
      expect(await surface.callTool(alice, "app_shared_remove_member", { ...target, member: "mallory" })).toMatchObject({ ok: true, result: { changed: true } });
      expect(release).toHaveBeenCalledWith(key, "shared_membership_revoked", "mallory");
      expect(await surface.callTool(mallory, "app_read_projection", target)).toMatchObject({ ok: false });
      expect(await surface.callTool(alice, "app_shared_close", target)).toMatchObject({ ok: true, result: { changed: true } });
      expect(release).toHaveBeenCalledWith(key, "shared_instance_closed");
      expect(await surface.callTool(alice, "app_shared_set_member", { ...target, member: "mallory", role: "member" })).toMatchObject({ ok: false, code: "seat_unavailable" });
    } finally { release.mockRestore(); }
  });

  it("refuses unknown roles/users and revoked publisher trust without mutating membership", async () => {
    const key = await createProject();
    const target = { app: "team-reports", instance: key };
    expect(await surface.callTool(alice, "app_shared_create", { ...sharedArgs, role: "constructor" })).toMatchObject({ ok: false, code: "unknown_role" });
    expect(await surface.callTool(alice, "app_shared_set_member", { ...target, member: "missing", role: "member" })).toMatchObject({ ok: false, code: "unknown_user" });
    trust.revoke("alice", { appId: "team-reports", publisher: "acme:reports" });
    expect(await surface.callTool(alice, "app_shared_close", target)).toMatchObject({ ok: false, code: "trust_required" });
    expect(store.getSharedAppInstance("team-reports", key)?.status).toBe("open");
  });
});
