import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import type { AppRuntimeClient, RuntimeJson } from "@claude-bot/app-runtime";
import { AppReleaseRegistry, FileReleaseContentStore, MemoryReleaseCatalog } from "@claude-bot/app-registry";
import { AppReleaseHost } from "../app-registry/release-host.js";
import { DashboardServer, mintDashboardToken } from "../dashboard/server.js";
import { readBootstrapPayload } from "../dashboard/app-page.js";
import { RESEARCH_APP } from "@claude-bot/research-canvas-contract";
import { composeDashboardServices } from "../bootstrap-v3.js";
import { AppInstanceService, type AppInstanceRelease } from "../app-registry/app-instance.js";
import { Store } from "../store/store.js";
import { ManagedExecutionSupervisor } from "../managed-execution/supervisor.js";
import { ResourceRecoveryService } from "../resources/recovery.js";
import { RESEARCH_CANVAS_CONTRACT, RESEARCH_CANVAS_DIGEST } from "./contract.js";
import type { ResearchCanvasPlane } from "./plane.js";
import { mintMcpToken, mcpTokenPolicy } from "../mcp/tokens.js";
import { ResearchWorkspaceMcp } from "./workspace-mcp.js";
import { buildAppBundle, readAppPackConfig } from "../app-registry/app-package.js";
import type { ManagedApp } from "../app-registry/hosted-app.js";
import { browserAcceptance } from "./browser-acceptance.js";
import { readGraphYaml, writeGraphYaml } from "./graph-yaml.js";

it("opens a newly activated research project and only permits editing after the owner grants through HTTP", { timeout: process.env.RESEARCH_TEST_BROWSER ? 300_000 : 120_000 }, async () => {
  const { project }: { project(events: readonly unknown[], context?: unknown): RuntimeJson } =
    await import(new URL("../../../research-canvas-view/app/projection.ts", import.meta.url).href);
  const root = mkdtempSync(join(tmpdir(), "research-open-"));
  const store = new Store(join(root, "bot.db"));
  const state = new AppStateService(join(root, "app-state"));
  const supervisor = new ManagedExecutionSupervisor(store.managedExecutions, new ResourceRecoveryService(store.resourceWaiters));
  const at = new Date().toISOString();
  store.saveUser({ username: "alice", uid: 1001, home_dir: root, created_at: at });
  const release: AppInstanceRelease = {
    stableAppId: RESEARCH_APP,
    publisher: "octopus:first-party",
    packageDigest: "a".repeat(64),
    permissionContractDigest: RESEARCH_CANVAS_DIGEST,
    backendCodeDigest: "b".repeat(64),
    appDir: fileURLToPath(new URL("../../../research-canvas-view/app/", import.meta.url)),
  };
  const registry = new AppReleaseRegistry({ catalog: new MemoryReleaseCatalog(), content: new FileReleaseContentStore(join(root, "releases")) });
  const owners: ManagedApp[] = [];
  if (process.env.RESEARCH_TEST_BROWSER) {
    const config = await import(new URL("../../../research-canvas-view/src/pack.ts", import.meta.url).href);
    const bundle = await buildAppBundle(readAppPackConfig(config.default));
    const installed = registry.install({ ...bundle, installedBy: "research-browser-test" });
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    release.packageDigest = bundle.descriptor.packageDigest;
    const unused = (): never => { throw new Error("asset owner must not activate a backend"); };
    owners.push({ appId: RESEARCH_APP, publisher: release.publisher,
      start: unused, unavailable: unused, install: unused, activate: unused, deactivate: unused,
      uninstall: unused, describe: unused, publishedLabels: unused, documentFor: unused });
  }
  let active: AppInstanceRelease | null = null;
  // Use the shipped projector and real State/manifest/permissions/resource plane.
  // Only the sandbox transport is replaced; no synthetic canvas boot is injected.
  const runtime: AppRuntimeClient = {
    project: async request => project(request.events, request.context),
    invoke: async () => { throw new Error("resource actions must not enter the sandbox"); },
    health: async () => ({ ok: true, backendCodeDigest: release.backendCodeDigest }),
  };
  const service = new AppInstanceService({
    stableAppId: RESEARCH_APP,
    state: new InProcessStateClient(state),
    runtime,
    activeRelease: () => active,
    servableRelease: digest => active?.packageDigest === digest ? active : null,
    servablePackageDigests: () => new Set(active ? [active.packageDigest] : []),
    shared: {
      instance: (app, key) => store.getSharedAppInstance(app, key),
      member: (app, key, owner) => store.getSharedAppMember(app, key, owner),
    },
  });
  const surface = { stableAppId: RESEARCH_APP, publisher: release.publisher, title: "自动科研 v2", packageDigest: release.packageDigest, viewOrigin: "http://app.local", service, unavailable: null };
  let plane: ResearchCanvasPlane | undefined;
  const composition = composeDashboardServices(store, undefined, {
    port: 0,
    host: "127.0.0.1",
    authToken: "test-admin",
    adminUsers: [],
    surface: "bootstrap-v3",
    appReleases: new AppReleaseHost({ registry, apps: owners }),
    declaredApps: { list: () => [surface], get: app => app === RESEARCH_APP ? surface : null },
    mcpApps: { list: () => [surface], get: app => app === RESEARCH_APP ? surface : null },
    managedSupervisor: supervisor,
    researchCanvas: { root: join(root, "research"), model: { baseUrl: "", apiKey: "", models: [], defaultModel: "", filterModel: "" } },
    attachDeclaredResources: factory => {
      plane = factory(RESEARCH_APP, "octopus:first-party") as ResearchCanvasPlane;
      return () => {};
    },
  });
  service.attachResources(plane!);
  const server = new DashboardServer(composition.options, composition.services);
  composition.attachTransport(server.transportLifecycle);
  const projectKey = `asi_${"a".repeat(32)}`;
  const alice = { owner: "alice", credential: "test:alice", session: true };
  try {
    await expect(service.open(alice, { instanceKey: projectKey })).rejects.toThrow("no active release");
    active = release;
    store.createSharedAppInstance({ app_id: RESEARCH_APP, instance_key: projectKey, creator: "alice", status: "open", created_at: at }, "owner");
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;
    const login = await fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ token: mintDashboardToken(store, "alice") }) });
    const cookies = login.headers.getSetCookie();
    const cookie = cookies.find(value => value.startsWith("octopus_sess="))?.split(";", 1)[0] ?? "";
    const csrf = /octopus_csrf=([0-9a-f]{64})/.exec(cookies.join(";"))?.[1] ?? "";
    expect(cookie).not.toBe("");
    expect(csrf).not.toBe("");
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
    const page = async () => {
      const response = await fetch(`${base}/apps/${RESEARCH_APP}/open?instance=${projectKey}`, { headers: { cookie } });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      return readBootstrapPayload(body).pageProps;
    };
    // A first-party release has no per-release consent page (O12): the
    // project opens directly, still with zero capability grants.
    expect(await page()).toMatchObject({ mode: "app", app: { resourcePermissions: { requestedCount: RESEARCH_CANVAS_CONTRACT.operations.length, grantedCount: 0, effectiveCount: 0 } } });
    expect(composition.services.permissions.get("app", RESEARCH_APP, "alice")).toBeNull();

    await expect(service.open(alice)).rejects.toThrow("实例标识");
    await expect(service.open({ ...alice, owner: "outsider" }, { instanceKey: projectKey })).rejects.toThrow("成员");
    const opened = await service.open(alice, { instanceKey: projectKey });
    expect(opened.projection).toMatchObject({ canvas: { project: projectKey, viewer: "alice", role: "owner", epoch: 0 } });
    expect(service.instances.resolve(opened.handle, alice)).toMatchObject({ ok: true, binding: { stableAppId: RESEARCH_APP, sharedInstanceKey: projectKey } });
    expect(await service.dispatch(opened.handle, alice, { action: "canvas_read", params: {} })).toMatchObject({ ok: false, message: "请在权限中心授权自动科研 v2 对应操作" });
    const grant = await post("/api/permissions/grant", { subject_type: "app", subject_id: RESEARCH_APP, operations: ["read_project", "edit_graph"] });
    expect(grant.status).toBe(200);
    expect(composition.services.permissions.get("app", RESEARCH_APP, "alice")).toMatchObject({ source: "user", publisher: release.publisher, contractDigest: RESEARCH_CANVAS_DIGEST, operations: ["edit_graph", "read_project"], autoAllow: ["edit_graph", "read_project"] });
    expect(await page()).toMatchObject({ mode: "app", app: { resourcePermissions: { requestedCount: RESEARCH_CANVAS_CONTRACT.operations.length, grantedCount: 2, effectiveCount: 2 } } });
    expect(await service.dispatch(opened.handle, alice, { action: "canvas_read", params: {} })).toMatchObject({ ok: true, result: { nodes: [] } });
    expect(await service.dispatch(opened.handle, alice, { action: "node_add", params: { request: "first-note", data: JSON.stringify({ type: "note", title: "首个便签" }) } })).toMatchObject({ ok: true, result: { node: { title: "首个便签", created: { owner: "alice" } } } });
    const reopened = await service.open(alice, { instanceKey: projectKey });
    expect(await service.dispatch(reopened.handle, alice, { action: "canvas_read", params: {} })).toMatchObject({ ok: true, result: { nodes: [{ title: "首个便签" }] } });
    const layoutCheck = await service.dispatch(reopened.handle, alice, { action: "canvas_layout_check", params: {} });
    expect(layoutCheck, JSON.stringify(layoutCheck)).toMatchObject({ ok: true, result: { layout: "canvas", complete: true, counts: { nodes: 1 }, warnings: [] } });
    const agentTurn = await service.openAgentTurn({ owner: "alice", agent: "mcp", useMemberRole: true, turnId: "inspect-via-mcp", instanceKey: projectKey });
    try {
      expect(await service.dispatch(agentTurn.handle, agentTurn.principal, { action: "canvas_snapshot", params: {} })).toMatchObject({ ok: true, result: { kind: "structure-preview", mime: "image/svg+xml", layout: "canvas" } });
      expect(await service.dispatch(agentTurn.handle, agentTurn.principal, { action: "node_add", params: { request: "agent-inspection-note", data: JSON.stringify({ type: "note", title: "Agent 记录", x: 400 }) } })).toMatchObject({ ok: true, result: { node: { created: { kind: "agent", agent: "mcp" } }, warnings: [], layoutDiagnostics: { complete: true, reports: [{ layout: "canvas" }] } } });
    } finally {
      service.closeInstance(agentTurn.handle, agentTurn.principal);
    }
    expect(await service.dispatch(reopened.handle, alice, { action: "node_add", params: { request: "named-goal", data: JSON.stringify({ type: "goal", title: "ACC · GOAL", x: 800 }) } })).toMatchObject({ ok: true });
    const picker = await fetch(`${base}/apps/${RESEARCH_APP}/open`, { headers: { cookie } });
    expect(readBootstrapPayload(await picker.text()).pageProps).toMatchObject({ mode: "instances", instances: [{ instanceKey: projectKey, title: "ACC" }] });
    expect(await service.dispatch(reopened.handle, alice, { action: "canvas_read", params: {} })).toMatchObject({ ok: true, result: { title: "ACC" } });
    // Real stateless MCP -> app_dispatch -> the same plane used by browser actions.
    composition.services.permissions.grant({
      subjectType: "service", subjectId: "mcp", owner: "alice",
      operations: ["dispatch_app_action"], autoAllow: [], source: "user", createdBy: "alice",
    });
    const minted = mintMcpToken(store, { username: "alice", label: "research workspace test", ttlMs: process.env.RESEARCH_TEST_BROWSER ? 600000 : 120000,
      policy: mcpTokenPolicy({ groups: ["apps"], appIds: [RESEARCH_APP], appInstances: [projectKey] }) });
    const tokenFile = join(root, "mcp-token");
    writeFileSync(tokenFile, minted.token, { mode: 0o600 });
    const workspace = join(root, "workspace"); mkdirSync(workspace);
    const config = { endpoint: base + "/api/mcp", instance: projectKey, tokenFile, workspace };
    const agentWorkspace = new ResearchWorkspaceMcp(config);
    await agentWorkspace.initialize();
    try {
      await agentWorkspace.invoke("graph_checkout", { path: "graph.yaml" });
      const originalYaml = readFileSync(join(workspace, "graph.yaml"), "utf8");
      expect(originalYaml).toContain("首个便签");
      const edited = readGraphYaml(originalYaml);
      const noteId = Object.keys(edited.nodes).find(id => edited.nodes[id].label === "首个便签")!;
      const evidenceId = Object.keys(edited.nodes).find(id => edited.nodes[id].label === "Agent 记录")!;
      edited.nodes[noteId].label = "YAML 合并后的便签";
      edited.edges.evidence = { from: evidenceId, to: noteId, relation: "supports" };
      writeFileSync(join(workspace, "graph.yaml"), writeGraphYaml(edited.snapshot, edited));
      const result = await agentWorkspace.invoke("graph_commit", { path: "graph.yaml", request: "mcp-yaml-edit" });
      expect(result.status).toBe("merged");
      expect(result.changes).toMatchObject({ edges: ["evidence"] });
      expect(await agentWorkspace.invoke("graph_commit", { path: "graph.yaml", request: "mcp-yaml-edit" })).toEqual(result);
      expect(await service.dispatch(reopened.handle, alice, { action: "canvas_read", params: {} }))
        .toMatchObject({ ok: true, result: { nodes: expect.arrayContaining([expect.objectContaining({ title: "YAML 合并后的便签" })]) } });
      if (process.env.RESEARCH_TEST_BROWSER) {
        // Saving a draft exercises the run permission without starting a session.
        expect((await post("/api/permissions/grant", { subject_type: "app", subject_id: RESEARCH_APP, operations: ["read_project", "edit_graph", "run_agent"] })).status).toBe(200);
        await browserAcceptance({
          base, instance: projectKey, browser: process.env.RESEARCH_TEST_BROWSER,
          cookies, root, config, workspace: agentWorkspace,
          artifacts: process.env.RESEARCH_TEST_ARTIFACTS ?? join(root, "artifacts"),
        });
      }
    } finally { await agentWorkspace.close(); }
    expect((await post("/api/permissions/revoke", { subject_type: "app", subject_id: RESEARCH_APP })).status).toBe(200);
    expect(await service.dispatch(reopened.handle, alice, { action: "canvas_read", params: {} })).toMatchObject({ ok: false });
    expect((await post("/api/permissions/grant", { subject_type: "app", subject_id: RESEARCH_APP, operations: ["read_project"] })).status).toBe(200);
    const renewed = await service.open(alice, { instanceKey: projectKey });
    expect(await service.dispatch(renewed.handle, alice, { action: "canvas_read", params: {} })).toMatchObject({ ok: true });
    store.removeSharedAppMember(RESEARCH_APP, projectKey, "alice");
    expect(await service.dispatch(renewed.handle, alice, { action: "canvas_read", params: {} })).toMatchObject({ ok: false });
  } finally {
    await server.stop();
    service.stop();
    await composition.close();
    await supervisor.close();
    await state.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
