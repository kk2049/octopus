/**
 * The MCP apps tool group against a REAL `AppInstanceService`, a REAL
 * `AppStateService` and a real `PermissionService`; only the App Runtime
 * sandbox is faked, at the `AppRuntimeClient` seam it already has for the
 * backend child process.
 *
 * The properties pinned here are the surface's own claims: the tool list
 * mirrors the effective `service:mcp` grant and the composed plane; every call
 * is one agent turn through the SAME dispatch door a page button drives, so
 * the manifest refusals (`unknown action`, missing/over-long/undeclared
 * params, `human_only`) and the rules-door refusal arrive as typed results;
 * the commit log carries the agent actor and evidence hashes but never raw
 * params or event payloads; and one token's owner can neither read nor write
 * another owner's stream because the owner never rides an argument.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppRuntimeClient, InvokeRequest, InvokeResult, ProjectRequest, RuntimeJson } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient, canonicalJson } from "@claude-bot/app-state";
import { AppInstanceService } from "../app-registry/app-instance.js";
import { PermissionService } from "../permissions/service.js";
import type { SessionPlusManifest } from "../app-core/manifest.js";
import { SessionHubService } from "../sessionhub/service.js";
import { Store } from "../store/store.js";
import { MCP_APPS_OPERATION_IDS, MCP_SUBJECT_ID, mcpSubjectEntry } from "./catalog.js";
import { McpSurface, type McpDeclaredApp } from "./service.js";
import { mcpTokenPolicy } from "./tokens.js";

const NOW = "2026-08-11T00:00:00.000Z";
const SESSION_ONLY = ["list_recent_sessions", "search_sessions", "read_session"];

/** The declaration the door normalises against, via the test seam production fills from `app.yaml`. */
const MANIFEST: SessionPlusManifest = {
  id: "demo-notes",
  schema: 2,
  stateScope: "account",
  stateEpoch: 0,
  stateEpochDeclared: false,
  roles: {},
  pageFile: "pages/main.yaml",
  agents: { mcp: { name: "mcp", adapter: "openai-loop", prompt: "Act through the trusted MCP turn." } },
  actions: {
    add_note: {
      binding: "runtime",
      title: "记一条",
      description: "添加一条笔记",
      humanOnly: false,
      agentOnly: false,
      params: { text: { type: "string", max: 40, required: true, description: "内容" } },
    },
    clear_all: { binding: "runtime", title: "清空", humanOnly: true, agentOnly: false, params: {} },
  },
};

/** The sandbox, faked at the client seam: fold note events, refuse "bad" at the rules door. */
class FakeRuntime implements AppRuntimeClient {
  projects = 0;

  async project(request: ProjectRequest): Promise<RuntimeJson> {
    this.projects += 1;
    const snapshot = request.snapshot && typeof request.snapshot === "object" && !Array.isArray(request.snapshot)
      ? request.snapshot as Record<string, RuntimeJson>
      : {};
    const notes = Array.isArray(snapshot.notes) ? [...snapshot.notes] : [];
    notes.push(...request.events
      .filter((event) => event.type === "note_added")
      .map((event) => (event.data as { text: string }).text));
    return {
      notes,
    };
  }

  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    if (request.action !== "add_note") throw Object.assign(new Error("no handler"), { code: "invalid_action" });
    const text = String(request.params.text ?? "");
    if (text === "bad") throw Object.assign(new Error("rules door refused"), { code: "handler_failed" });
    // The claimed author/time are overwritten by the trusted coordinator.
    return { events: [{ type: "note_added", data: { text }, at: "1999-01-01T00:00:00.000Z", by: "liar" }], result: { added: text } };
  }

  async health(): Promise<{ ok: boolean; backendCodeDigest: string }> {
    return { ok: true, backendCodeDigest: "b".repeat(64) };
  }
}

describe("McpSurface apps tools", () => {
  let dir: string;
  let store: Store;
  let state: AppStateService;
  let permissions: PermissionService;
  let surface: McpSurface;
  let bare: McpSurface;
  let service: AppInstanceService;
  let runtime: FakeRuntime;
  let releaseActive = true;
  const alice = { owner: "alice", credential: "mcp:a1" };
  const bob = { owner: "bob", credential: "mcp:b1" };

  const release = {
    stableAppId: "demo-notes",
    publisher: "demo:acme",
    packageDigest: "pkg-digest-1",
    permissionContractDigest: "c".repeat(64),
    backendCodeDigest: "b".repeat(64),
    appDir: "/nonexistent/prepared/demo-notes",
  };

  const grant = (owner: string, operations: readonly string[]) =>
    permissions.grant({
      subjectType: "service",
      subjectId: MCP_SUBJECT_ID,
      owner,
      operations: [...operations],
      autoAllow: [],
      source: "user",
      createdBy: owner,
    });

  const call = (principal: { owner: string; credential: string }, name: string, args: unknown) =>
    surface.callTool(principal, name, args);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-apps-"));
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/b", created_at: NOW });
    state = new AppStateService(join(dir, "state"));
    runtime = new FakeRuntime();
    service = new AppInstanceService({
      state: new InProcessStateClient(state),
      runtime,
      activeRelease: () => (releaseActive ? release : null),
      servableRelease: (digest) => releaseActive && digest === release.packageDigest ? release : null,
      servablePackageDigests: () => new Set(releaseActive ? [release.packageDigest] : []),
      loadManifest: () => MANIFEST,
    });
    const app: McpDeclaredApp = {
      stableAppId: "demo-notes",
      publisher: "demo:acme",
      title: "Demo Notes",
      packageDigest: release.packageDigest,
      service,
      unavailable: null,
    };
    const directory = { list: () => [app], get: (id: string) => (id === "demo-notes" ? app : null) };
    permissions = new PermissionService({
      store,
      subjects: [
        mcpSubjectEntry({ workspaceComposed: () => false, crdtComposed: () => false, appsComposed: () => true }),
      ],
      extraAccountOperations: [() => [...MCP_APPS_OPERATION_IDS, ...SESSION_ONLY]],
    });
    const hub = new SessionHubService({ store, permissions });
    surface = new McpSurface({ hub, permissions, apps: directory });
    // The same permission rows, but a composition that did not wire the plane.
    bare = new McpSurface({ hub, permissions });
  });

  afterAll(() => {
    surface.close();
    bare.close();
    service.stop();
    state.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("without the apps plane the tools do not exist, whatever the grant says", async () => {
    grant("alice", ["list_apps", "read_app_projection", "read_app_log"]);
    expect(bare.listTools("alice").map((t) => t.name)).toEqual(SESSION_ONLY);
    expect(await bare.callTool(alice, "app_list", {})).toMatchObject({ ok: false, code: "unknown_tool" });
  });

  it("tools/list mirrors the effective grant, and no approval verb exists on this face", () => {
    const names = surface.listTools("alice").map((t) => t.name);
    expect(names).toContain("app_list");
    expect(names).toContain("app_read_projection");
    expect(names).toContain("app_read_log");
    expect(names).not.toContain("app_dispatch");
    grant("alice", [...MCP_APPS_OPERATION_IDS]);
    const widened = surface.listTools("alice").map((t) => t.name);
    expect(widened).toContain("app_dispatch");
    // The invariant the browser-only Approve rests on, extended to this group:
    // nothing enumerable here approves, decides or administers anything.
    for (const name of widened) expect(name).not.toMatch(/approve|decide|admin|install|activate/i);
  });

  it("intersects the live grant with an immutable token-local tool and App allowlist", async () => {
    const appOnly = { ...alice, policy: mcpTokenPolicy({ groups: ["apps"], appIds: ["demo-notes"], appActions: ["add_note"] }) };
    expect(surface.listTools(appOnly).map((tool) => tool.name)).toEqual([
      "app_list",
      "app_read_projection",
      "app_read_log",
      "app_dispatch",
    ]);
    const listed = await surface.callTool(appOnly, "app_list", {});
    expect(listed).toMatchObject({ ok: true, result: { apps: [{ app: "demo-notes", actions: [{ name: "add_note" }] }] } });
    expect(await surface.callTool(appOnly, "list_recent_sessions", {})).toMatchObject({ ok: false, code: "unknown_tool" });

    const wrongApp = { ...alice, policy: mcpTokenPolicy({ groups: ["apps"], appIds: ["daily-brief"] }) };
    expect(await surface.callTool(wrongApp, "app_list", {})).toMatchObject({ ok: true, result: { apps: [] } });
    expect(await surface.callTool(wrongApp, "app_read_projection", { app: "demo-notes" }))
      .toMatchObject({ ok: false, code: "no_authority" });

    const readOnlyAction = { ...alice, policy: mcpTokenPolicy({ groups: ["apps"], appActions: [] }) };
    expect(await surface.callTool(readOnlyAction, "app_dispatch", { app: "demo-notes", action: "add_note", params: { text: "x" } }))
      .toMatchObject({ ok: false, code: "no_authority" });
  });

  it("research tool forwarding intersects both outer and nested token action allowlists", async () => {
    let invoked = 0;
    const researchRelease = { ...release, stableAppId: "research-v2" };
    const researchService = new AppInstanceService({
      stableAppId: "research-v2",
      state: new InProcessStateClient(state),
      runtime: {
        project: async () => ({}),
        invoke: async () => { invoked++; return { events: [], result: { dispatched: true } }; },
        health: () => runtime.health(),
      },
      activeRelease: () => researchRelease,
      servableRelease: digest => digest === researchRelease.packageDigest ? researchRelease : null,
      servablePackageDigests: () => new Set([researchRelease.packageDigest]),
      loadManifest: () => ({ ...MANIFEST, id: "research-v2", actions: {
        tools_invoke: { binding: "runtime", title: "项目工具", humanOnly: false, agentOnly: false, params: {
          tool: { type: "string", max: 160, required: true },
          params: { type: "string", max: 24000, required: true },
        } },
      } }),
    });
    const researchApp: McpDeclaredApp = { stableAppId: "research-v2", publisher: "octopus:first-party", title: "Research", packageDigest: release.packageDigest, service: researchService, unavailable: null };
    const researchSurface = new McpSurface({ hub: new SessionHubService({ store, permissions }), permissions, apps: { list: () => [researchApp], get: id => id === "research-v2" ? researchApp : null } });
    const args = { app: "research-v2", action: "tools_invoke", params: { tool: "node_add", params: "{}" } };
    const principal = (actions: string[]) => ({ ...alice, policy: mcpTokenPolicy({ groups: ["apps"], appIds: ["research-v2"], appActions: actions }) });
    try {
      expect(await researchSurface.callTool(principal(["tools_invoke", "canvas_read"]), "app_dispatch", args)).toMatchObject({ ok: false, code: "no_authority" });
      expect(await researchSurface.callTool(principal(["node_add"]), "app_dispatch", args)).toMatchObject({ ok: false, code: "no_authority" });
      expect(invoked).toBe(0);
      expect(await researchSurface.callTool(principal(["tools_invoke", "node_add"]), "app_dispatch", args)).toMatchObject({ ok: true, result: { result: { dispatched: true } } });
      expect(invoked).toBe(1);
    } finally {
      researchSurface.close();
      researchService.stop();
    }
  });

  it("an ungranted owner refuses before the door: no instance, no projection", async () => {
    const before = runtime.projects;
    const out = await call(bob, "app_list", {});
    expect(out).toMatchObject({ ok: false, code: "no_authority" });
    expect(runtime.projects).toBe(before);
  });

  it("app_list publishes the agent half of the declared action surface", async () => {
    const out = await call(alice, "app_list", {});
    expect(out.ok).toBe(true);
    const apps = (out as { result: { apps: Array<Record<string, unknown>> } }).result.apps;
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      app: "demo-notes",
      title: "Demo Notes",
      publisher: "demo:acme",
      package_digest: "pkg-digest-1",
      backend_code_digest: "b".repeat(64),
    });
    const actions = apps[0].actions as Array<{ name: string; parameters: Record<string, unknown> }>;
    // `human_only` actions are absent here AND refused at the door below.
    expect(actions.map((a) => a.name)).toEqual(["add_note"]);
    expect(actions[0].parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string", maxLength: 40, description: "内容" } },
      required: ["text"],
      additionalProperties: false,
    });
  });

  it("dispatch → projection → log: one door, agent authorship, evidence not payloads", async () => {
    const dispatched = await call(alice, "app_dispatch", {
      app: "demo-notes",
      action: "add_note",
      params: { text: "买牛奶" },
    });
    expect(dispatched.ok).toBe(true);
    expect((dispatched as { result: Record<string, unknown> }).result).toMatchObject({
      app: "demo-notes",
      action: "add_note",
      revision: 1,
      result: { added: "买牛奶" },
      projection: { notes: ["买牛奶"] },
    });

    const projected = await call(alice, "app_read_projection", { app: "demo-notes" });
    expect(projected.ok).toBe(true);
    // Every MCP call owns a fresh agent turn. The dispatch above advanced its
    // instance's projection frame from 0 to 1; this independent read opens a
    // new instance at frame 0. Durable State progress is the log head below.
    expect((projected as { result: Record<string, unknown> }).result).toMatchObject({
      revision: 0,
      projection: { notes: ["买牛奶"] },
    });
    // A part of it by JSON Pointer — how an agent reaches into a projection
    // larger than one answer.
    expect(await call(alice, "app_read_projection", { app: "demo-notes", path: "/notes/0" }))
      .toMatchObject({ ok: true, result: { path: "/notes/0", projection: "买牛奶" } });
    expect(await call(alice, "app_read_projection", { app: "demo-notes", path: "/missing" }))
      .toMatchObject({ ok: false, code: "invalid_params" });

    const log = await call(alice, "app_read_log", { app: "demo-notes" });
    expect(log.ok).toBe(true);
    const body = (log as { result: { head: number; commits: Array<Record<string, unknown>> } }).result;
    expect(body.head).toBe(1);
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0]).toMatchObject({
      seq_from: 1,
      seq_to: 1,
      actor: "agent:demo-notes/mcp@alice",
      action: "add_note",
      params_hash: createHash("sha256").update(canonicalJson({ text: "买牛奶" })).digest("hex"),
      backend_code_digest: "b".repeat(64),
      event_count: 1,
    });
    expect(typeof body.commits[0].at).toBe("string");
    // The log answer is evidence only: the note text does not travel in it.
    expect(JSON.stringify(body)).not.toContain("买牛奶");
  });

  it("the door's refusals arrive as typed results and append nothing", async () => {
    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ app: "demo-notes", action: "nope", params: {} }, "unknown_action", /不在当前 release/],
      // Param-shape refusals carry the door's code (`action_rejected`, the
      // same flattening SessionPlusAppService applies) with the normaliser's
      // precise sentence — the message, not a second validator, is what tells
      // a model which parameter to fix.
      [{ app: "demo-notes", action: "add_note", params: {} }, "action_rejected", /必填参数/],
      [{ app: "demo-notes", action: "add_note", params: { text: "长".repeat(41) } }, "action_rejected", /40/],
      [{ app: "demo-notes", action: "add_note", params: { text: "x", extra: "y" } }, "invalid_params", /未声明的参数：extra/],
      // Structurally browser-only: the agent actor cannot drive a human_only
      // action, whatever the token's grant says.
      [{ app: "demo-notes", action: "clear_all", params: {} }, "unknown_action", /只接受本人操作/],
      // The rules door (the App's own code) refuses inside the sandbox.
      [{ app: "demo-notes", action: "add_note", params: { text: "bad" } }, "action_rejected", /不被当前应用 release 接受/],
      [{ app: "no-such-app", action: "add_note", params: {} }, "unknown_app", /app_list/],
    ];
    for (const [args, code, message] of cases) {
      const out = await call(alice, "app_dispatch", args);
      expect(out, JSON.stringify(args)).toMatchObject({ ok: false, code });
      expect((out as { message: string }).message).toMatch(message);
    }
    const log = await call(alice, "app_read_log", { app: "demo-notes" });
    expect((log as { result: { head: number } }).result.head).toBe(1);
  });

  it("the log pages by seq and refuses out-of-bounds pages", async () => {
    await call(alice, "app_dispatch", { app: "demo-notes", action: "add_note", params: { text: "two" } });
    await call(alice, "app_dispatch", { app: "demo-notes", action: "add_note", params: { text: "three" } });

    const first = await call(alice, "app_read_log", { app: "demo-notes", limit: 2 });
    const page = (first as { result: { head: number; commits: Array<{ seq_to: number }> } }).result;
    expect(page.head).toBe(3);
    expect(page.commits.map((c) => c.seq_to)).toEqual([1, 2]);

    const rest = await call(alice, "app_read_log", { app: "demo-notes", since_seq: 2 });
    expect((rest as { result: { commits: Array<{ seq_from: number }> } }).result.commits.map((c) => c.seq_from)).toEqual([3]);

    expect(await call(alice, "app_read_log", { app: "demo-notes", limit: 101 })).toMatchObject({
      ok: false,
      code: "invalid_params",
    });
    expect(await call(alice, "app_read_log", { app: "demo-notes", limit: 0 })).toMatchObject({
      ok: false,
      code: "invalid_params",
    });
    expect(await call(alice, "app_read_log", { app: "demo-notes", since_seq: -1 })).toMatchObject({
      ok: false,
      code: "invalid_params",
    });
  });

  it("owners are isolated by the token, not by an argument", async () => {
    grant("bob", [...MCP_APPS_OPERATION_IDS]);
    // Bob's stream is bob's: empty, however much alice has written.
    const log = await call(bob, "app_read_log", { app: "demo-notes" });
    expect((log as { result: { head: number; commits: unknown[] } }).result).toMatchObject({ head: 0, commits: [] });
    const projected = await call(bob, "app_read_projection", { app: "demo-notes" });
    expect((projected as { result: Record<string, unknown> }).result).toMatchObject({
      revision: 0,
      projection: { notes: [] },
    });
    // And bob's write lands in bob's stream only.
    await call(bob, "app_dispatch", { app: "demo-notes", action: "add_note", params: { text: "bob-note" } });
    const bobLog = await call(bob, "app_read_log", { app: "demo-notes" });
    expect((bobLog as { result: { head: number } }).result.head).toBe(1);
    expect((bobLog as { result: { commits: Array<{ actor: string }> } }).result.commits[0].actor).toBe(
      "agent:demo-notes/mcp@bob",
    );
    const aliceLog = await call(alice, "app_read_log", { app: "demo-notes" });
    expect((aliceLog as { result: { head: number } }).result.head).toBe(3);
  });

  it("an App without an active release lists no actions and refuses the door", async () => {
    releaseActive = false;
    try {
      const listed = await call(alice, "app_list", {});
      const apps = (listed as { result: { apps: Array<Record<string, unknown>> } }).result.apps;
      expect(apps[0].actions).toEqual([]);
      expect(await call(alice, "app_dispatch", { app: "demo-notes", action: "add_note", params: { text: "x" } }))
        .toMatchObject({ ok: false, code: "unavailable" });
      expect(await call(alice, "app_read_log", { app: "demo-notes" })).toMatchObject({ ok: false, code: "no_release" });
    } finally {
      releaseActive = true;
    }
  });

  it("revoking the service:mcp grant closes the group for that owner", async () => {
    permissions.revoke({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice", by: "alice" });
    expect(await call(alice, "app_list", {})).toMatchObject({ ok: false, code: "no_authority" });
    expect(surface.listTools("alice").map((t) => t.name)).toEqual(SESSION_ONLY);
  });
});
