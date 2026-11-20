/**
 * McpSurface against a real PermissionService, a real WorkspaceFilesService
 * (with a device faked at the WorkspaceFilesAuthority seam, answering the
 * device wire shapes the backend re-validates) and a real CrdtDocumentStore.
 *
 * The properties pinned here are the surface's own: tools/list mirrors the
 * effective permission projection, refs round-trip within one token's scope
 * and die with it, the write maps the Gate's approval outcome to an explicit
 * `approval_required`, a foreign owner sees nothing, and revocation closes
 * what the token opened.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Store } from "../store/store.js";
import { PermissionService } from "../permissions/service.js";
import { SessionHubService } from "../sessionhub/service.js";
import { CrdtDocumentStore } from "../crdt-doc/store.js";
import { WorkspaceFilesService } from "../workspace-files/service.js";
import type { RunnerCallOutcome, WorkspaceDevice } from "../workspace-files/types.js";
import { MCP_CRDT_OPERATION_IDS, MCP_EXECUTION_OPERATION_IDS, MCP_WORKSPACE_OPERATION_IDS, MCP_SUBJECT_ID, mcpSubjectEntry } from "./catalog.js";
import { McpSurface } from "./service.js";
import { SessionExecutionRegistry } from "./session-execution.js";
import { hashRunnerToken } from "../runner/gateway.js";
import { mcpCredentialOf, mcpSessionExecutionPolicy, mcpTokenPolicy } from "./tokens.js";

const NOW = "2026-08-10T00:00:00.000Z";
const WS_ID = "ws_0123456789abcdef01234567";

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** A fake laptop: answers the device wire shapes the backend re-validates. */
class FakeDevice {
  files = new Map<string, string>([["a.txt", "hello"]]);
  approveWrites = true;
  calls: string[] = [];

  devices(): readonly WorkspaceDevice[] {
    return [{ device: "mac", label: "mac" }];
  }

  async call(_device: string, operation: string, args: Record<string, unknown>): Promise<RunnerCallOutcome> {
    this.calls.push(operation);
    switch (operation) {
      case "list_session_workspaces":
        return { status: "succeeded", result: { workspaces: [{ id: WS_ID, label: "proj" }] } };
      case "list_workspace_entries": {
        const parent = String(args.relative_path ?? "");
        if (parent !== "") return { status: "succeeded", result: { status: "refused", code: "not_found" } };
        return {
          status: "succeeded",
          result: {
            status: "ok",
            workspace_id: WS_ID,
            relative_path: parent,
            truncated: false,
            entries: [...this.files.entries()].map(([name, text]) => ({
              name,
              kind: "file",
              relative_path: name,
              size: Buffer.byteLength(text, "utf8"),
              modified_at: NOW,
            })),
          },
        };
      }
      case "read_workspace_text": {
        const path = String(args.relative_path ?? "");
        const text = this.files.get(path);
        if (text === undefined) return { status: "succeeded", result: { status: "refused", code: "not_found" } };
        const bytes = Buffer.byteLength(text, "utf8");
        return {
          status: "succeeded",
          result: {
            status: "ok",
            encoding: "utf-8",
            workspace_id: WS_ID,
            relative_path: path,
            digest: digestOf(text),
            size: bytes,
            offset: Number(args.offset ?? 0),
            bytes,
            eof: true,
            text,
            modified_at: NOW,
          },
        };
      }
      case "replace_workspace_text": {
        if (!this.approveWrites) return { status: "approval_required", pendingCallId: "pc_1" };
        const path = String(args.relative_path ?? "");
        const current = this.files.get(path);
        if (current === undefined) return { status: "succeeded", result: { status: "refused", code: "not_found" } };
        if (digestOf(current) !== args.expected_digest) {
          return { status: "succeeded", result: { status: "refused", code: "digest_mismatch" } };
        }
        const next = String(args.text ?? "");
        this.files.set(path, next);
        return {
          status: "succeeded",
          result: {
            status: "ok",
            encoding: "utf-8",
            workspace_id: WS_ID,
            relative_path: path,
            previous_digest: args.expected_digest,
            digest: digestOf(next),
            size: Buffer.byteLength(next, "utf8"),
            modified_at: NOW,
          },
        };
      }
      default:
        return { status: "denied" };
    }
  }
}

describe("McpSurface", () => {
  let dir: string;
  let store: Store;
  let permissions: PermissionService;
  let surface: McpSurface;
  let hub: SessionHubService;
  let device: FakeDevice;
  let crdtStore: CrdtDocumentStore;
  const alice = { owner: "alice", credential: "mcp:a1" };
  const bob = { owner: "bob", credential: "mcp:b1" };
  /** Every workspace grant the surface derived, with the terms it asked for. */
  const workspaceGrants: Array<{ owner: string; rights: string[]; autoAllow: string[] }> = [];

  const grant = (operations: string[], autoAllow: string[] = operations) =>
    permissions.grant({
      subjectType: "service",
      subjectId: MCP_SUBJECT_ID,
      owner: "alice",
      operations,
      autoAllow,
      source: "user",
      createdBy: "alice",
    });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-surface-"));
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/b", created_at: NOW });
    crdtStore = new CrdtDocumentStore({ root: join(dir, "crdt") });
    const documentsFor = (owner: string) => (owner === "alice" ? [{ id: "notes", label: "Alice 笔记" }] : []);
    permissions = new PermissionService({
      store,
      subjects: [mcpSubjectEntry({ workspaceComposed: () => true, crdtComposed: () => true })],
      extraAccountOperations: [
        // What the account "holds": the fake device backs the workspace plane
        // and the hub's three reads; the document plane reports per documents.
        () => [
          ...MCP_WORKSPACE_OPERATION_IDS,
          "list_recent_sessions",
          "search_sessions",
          "read_session",
          "append_session",
        ],
        (owner) => (documentsFor(owner).length ? MCP_CRDT_OPERATION_IDS : []),
      ],
    });
    hub = new SessionHubService({ store, permissions });
    device = new FakeDevice();
    surface = new McpSurface({
      hub,
      permissions,
      workspaceFilesService: new WorkspaceFilesService(),
      openWorkspaceAuthority: ({ owner, rights, autoAllow }) => {
        workspaceGrants.push({ owner, rights: [...rights], autoAllow: [...autoAllow] });
        return {
        authority: { devices: async () => device.devices(), call: (d, op, a) => device.call(d, op, a) },
        writable: rights.includes("replace_workspace_text"),
        close: () => {},
        };
      },
      crdt: { store: crdtStore, documentsFor },
      publicUrl: "https://bot.example",
    });
  });

  afterAll(() => {
    surface.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tools/list starts with the owner-bound session tools only (bootstrap grant), nothing else", () => {
    const names = surface.listTools("alice").map((t) => t.name);
    expect(names).toEqual(["list_recent_sessions", "search_sessions", "read_session", "send_session_message"]);
  });

  it("gives a session credential only its fixed workspace and command tool vocabulary", async () => {
    const sessionExecution = {
      resolve: () => ({}),
      workspacePort: () => null,
      runCommand: vi.fn(),
      releaseCredential: vi.fn(),
      releaseOwner: vi.fn(),
      close: vi.fn(),
    };
    const scoped = new McpSurface({
      hub,
      permissions,
      workspaceFilesService: new WorkspaceFilesService(),
      sessionExecution: sessionExecution as never,
    });
    const principal = {
      owner: "alice",
      credential: "mcp:session",
      policy: mcpSessionExecutionPolicy({
        operationId: "op_12345678",
        runtimeDevice: "runner1",
        executionDevice: "val15",
        workspaceId: WS_ID,
        permissionProfile: "full_access",
      }),
    };
    expect(scoped.listTools(principal).map((tool) => tool.name)).toEqual([
      "list_session_workspaces",
      "list_workspace_entries",
      "read_workspace_text",
      "replace_workspace_text",
      "run_workspace_command",
    ]);
    await expect(scoped.callTool(principal, "read_session", {})).resolves.toMatchObject({
      ok: false,
      code: "unknown_tool",
    });
    scoped.close();
  });

  it("an ungranted workspace call refuses without touching any device", async () => {
    const before = device.calls.length;
    const out = await surface.callTool(alice, "list_session_workspaces", {});
    expect(out).toMatchObject({ ok: false, code: "no_authority" });
    expect(device.calls.length).toBe(before);
  });

  it("exposes project tools only behind a live internal execution credential", async () => {
    let live = true;
    const invoke = vi.fn(async () => ({ok: true as const, result: {project: 'bound-project'}}));
    const scoped = new McpSurface({hub, permissions,
      sessionExecution: {resolve: () => live ? {} : null, close: () => {}} as never,
      research: {list: () => [{name: 'research_canvas_read', description: 'project', inputSchema: {type:'object', properties:{}, additionalProperties:false}}], call: invoke},
    });
    const principal = {owner:'alice', credential:'mcp:research-test', policy:mcpSessionExecutionPolicy({operationId:'op_12345678', runtimeDevice:'runner1', executionDevice:'val15', workspaceId:WS_ID, permissionProfile:'full_access'})};
    expect(scoped.listTools('alice').map(row=>row.name)).not.toContain('research_canvas_read');
    expect(scoped.listTools(principal).map(row=>row.name)).toContain('research_canvas_read');
    expect(await scoped.callTool(principal,'research_canvas_read',{})).toMatchObject({ok:true,result:{project:'bound-project'}});
    live = false;
    expect(scoped.listTools(principal)).toEqual([]);
    expect(await scoped.callTool(principal,'research_canvas_read',{})).toMatchObject({ok:false});
    expect(invoke).toHaveBeenCalledTimes(1); scoped.close();
  });

  it("granting read operations makes exactly those tools appear", () => {
    grant(["list_session_workspaces", "list_workspace_entries", "read_workspace_text", "read_document"]);
    const names = surface.listTools("alice").map((t) => t.name);
    expect(names).toContain("list_session_workspaces");
    expect(names).toContain("read_workspace_text");
    expect(names).toContain("crdt_list_docs");
    expect(names).toContain("crdt_open_doc");
    expect(names).toContain("crdt_read_updates");
    expect(names).not.toContain("replace_workspace_text");
    expect(names).not.toContain("crdt_apply_update");
  });

  it("workspace refs round-trip: roots → entries → text, all within one token's scope", async () => {
    const roots = await surface.callTool(alice, "list_session_workspaces", {});
    expect(roots.ok).toBe(true);
    const rootRef = (roots as { result: { roots: Array<{ ref: string }> } }).result.roots[0].ref;
    expect(rootRef).toBeTruthy();

    const listing = await surface.callTool(alice, "list_workspace_entries", { ref: rootRef });
    expect(listing.ok).toBe(true);
    const entries = (listing as { result: { entries: Array<{ ref?: string; label: string }> } }).result.entries;
    const fileRef = entries.find((e) => e.label === "a.txt")?.ref;
    expect(fileRef).toBeTruthy();

    const read = await surface.callTool(alice, "read_workspace_text", { ref: fileRef });
    expect(read.ok).toBe(true);
    const value = (read as { result: { document: { digest: string }; text: string } }).result;
    expect(value.text).toBe("hello");
    expect(value.document.digest).toBe(digestOf("hello"));
  });

  it("a foreign token's scope does not resolve another scope's ref", async () => {
    const roots = await surface.callTool(alice, "list_session_workspaces", {});
    const rootRef = (roots as { result: { roots: Array<{ ref: string }> } }).result.roots[0].ref;
    const out = await surface.callTool(bob, "list_workspace_entries", { ref: rootRef });
    // Bob has no grant at all, so he stops before any vault lookup.
    expect(out).toMatchObject({ ok: false, code: "no_authority" });
  });

  it("the ungranted write refuses before any frame; granting it reopens the scope and old refs die", async () => {
    const roots = await surface.callTool(alice, "list_session_workspaces", {});
    const oldRef = (roots as { result: { roots: Array<{ ref: string }> } }).result.roots[0].ref;
    const denied = await surface.callTool(alice, "replace_workspace_text", {
      ref: oldRef,
      expected_digest: digestOf("hello"),
      text: "x",
    });
    expect(denied).toMatchObject({ ok: false, code: "no_authority" });

    grant([...MCP_WORKSPACE_OPERATION_IDS, "read_document"], [
      "list_session_workspaces",
      "list_workspace_entries",
      "read_workspace_text",
      "read_document",
    ]);
    // The rights set changed, so the next call runs in a NEW scope: the old
    // ref is unknown there — refs do not outlive the authority they were
    // minted under.
    const stale = await surface.callTool(alice, "list_workspace_entries", { ref: oldRef });
    expect(stale).toMatchObject({ ok: false, code: "unknown_ref" });
    // O1: the token owner's own workspaces. The stored row above left the
    // write out of its auto-allow terms, yet the derived grant holds it
    // silently — a granted write on one's own files asks nobody.
    expect(workspaceGrants.at(-1)).toEqual({
      owner: "alice",
      rights: [...MCP_WORKSPACE_OPERATION_IDS],
      autoAllow: [...MCP_WORKSPACE_OPERATION_IDS],
    });
    expect(workspaceGrants.at(-1)!.autoAllow).toContain("replace_workspace_text");
    // Nobody else's workspace is reachable through Alice's grant: Bob holds no
    // grant, so no scope is derived for him at all.
    const before = workspaceGrants.length;
    expect(await surface.callTool(bob, "list_session_workspaces", {})).toMatchObject({ ok: false, code: "no_authority" });
    expect(workspaceGrants.length).toBe(before);
  });

  it("the CAS write: approval_required surfaces as pending semantics; approved path returns a receipt; stale digest refuses", async () => {
    const roots = await surface.callTool(alice, "list_session_workspaces", {});
    const rootRef = (roots as { result: { roots: Array<{ ref: string }> } }).result.roots[0].ref;
    const listing = await surface.callTool(alice, "list_workspace_entries", { ref: rootRef });
    const fileRef = (listing as { result: { entries: Array<{ ref?: string; label: string }> } }).result.entries.find(
      (e) => e.label === "a.txt",
    )!.ref!;

    device.approveWrites = false;
    const pending = await surface.callTool(alice, "replace_workspace_text", {
      ref: fileRef,
      expected_digest: digestOf("hello"),
      text: "hello v2",
    });
    expect(pending).toMatchObject({ ok: false, code: "approval_required" });
    expect((pending as { message: string }).message).toContain("/pending");

    device.approveWrites = true;
    const written = await surface.callTool(alice, "replace_workspace_text", {
      ref: fileRef,
      expected_digest: digestOf("hello"),
      text: "hello v2",
    });
    expect(written.ok).toBe(true);
    const receipt = (written as { result: { afterDigest: string; beforeDigest: string } }).result;
    expect(receipt.beforeDigest).toBe(digestOf("hello"));
    expect(receipt.afterDigest).toBe(digestOf("hello v2"));

    const stale = await surface.callTool(alice, "replace_workspace_text", {
      ref: fileRef,
      expected_digest: digestOf("hello"),
      text: "third write",
    });
    expect(stale).toMatchObject({ ok: false, code: "digest_mismatch" });
    expect(device.files.get("a.txt")).toBe("hello v2");
  });

  it("crdt: list → open → read_updates for the owner; apply refused without the edit token", async () => {
    const docs = await surface.callTool(alice, "crdt_list_docs", {});
    expect(docs.ok).toBe(true);
    const ref = (docs as { result: { documents: Array<{ ref: string; label: string }> } }).result.documents[0];
    expect(ref.label).toBe("Alice 笔记");

    const opened = await surface.callTool(alice, "crdt_open_doc", { doc: ref.ref });
    expect(opened.ok).toBe(true);
    expect((opened as { result: { stateVector: string } }).result.stateVector).toBeTruthy();

    const local = new Y.Doc();
    local.getText("t").insert(0, "hi from mcp");
    const update = Buffer.from(Y.encodeStateAsUpdate(local)).toString("base64");
    const denied = await surface.callTool(alice, "crdt_apply_update", { doc: ref.ref, update });
    expect(denied).toMatchObject({ ok: false, code: "no_authority" });
  });

  it("crdt: with edit granted the update merges durably (and the old scope's refs died with the widening)", async () => {
    grant([...MCP_WORKSPACE_OPERATION_IDS, ...MCP_CRDT_OPERATION_IDS]);
    const docs = await surface.callTool(alice, "crdt_list_docs", {});
    const ref = (docs as { result: { documents: Array<{ ref: string }> } }).result.documents[0].ref;
    const local = new Y.Doc();
    local.getText("t").insert(0, "hi from mcp");
    const update = Buffer.from(Y.encodeStateAsUpdate(local)).toString("base64");
    const applied = await surface.callTool(alice, "crdt_apply_update", { doc: ref, update });
    expect(applied.ok).toBe(true);

    const read = crdtStore.read("notes");
    expect(read.ok).toBe(true);
    const check = new Y.Doc();
    Y.applyUpdate(check, (read as { value: { update: Uint8Array } }).value.update);
    expect(check.getText("t").toString()).toBe("hi from mcp");
  });

  it("bob holds no documents and no grant: crdt tools refuse and list nothing", async () => {
    expect(surface.listTools("bob").map((t) => t.name)).toEqual([
      "list_recent_sessions",
      "search_sessions",
      "read_session",
      "send_session_message",
    ]);
    const out = await surface.callTool(bob, "crdt_list_docs", {});
    expect(out).toMatchObject({ ok: false, code: "no_authority" });
  });

  it("lists one device's sessions for an agent, with when each began and which are unattended runs", async () => {
    const roster = vi.spyOn(hub, "roster").mockResolvedValue({
      username: "alice", sources: [{ device: "observer", kind: "runner", online: true }], returned: 1,
      sessions: [{ resourceId: "r1", deviceId: "observer", deviceLabel: "observer", cliKind: "codex", sessionId: "s1", status: "idle",
        resumable: false, executionMode: "exec", started_at: "2026-10-19T01:00:00.000Z", lastActivity: "2026-10-19T02:00:00.000Z" }],
      permissions: { effective: [] },
    } as never);
    try {
      const out = await surface.callTool(alice, "list_recent_sessions", { device: "observer", since_hours: 48 });
      expect(roster).toHaveBeenCalledWith(expect.anything(), "alice", expect.objectContaining({ device: "observer", sinceHours: 48 }));
      expect(out).toMatchObject({ ok: true, result: { sessions: [{ device: "observer", execution_mode: "exec", started_at: "2026-10-19T01:00:00.000Z" }] } });
    } finally { roster.mockRestore(); }
  });

  it("a foreign session resource_id is refused with zero dispatch", async () => {
    const hub = new SessionHubService({ store, permissions });
    const foreign = hub.resourceId({ owner: "bob", device: "mac", cliKind: "claude", sessionId: "s1" });
    const out = await surface.callTool(alice, "read_session", { resource_id: foreign });
    expect(out).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("sends through the durable coordinator as a bearer and reports one approval without retrying", async () => {
    const resourceId = hub.resourceId({ owner: "alice", device: "runtime", cliKind: "codex", sessionId: "s1" });
    const submit = vi.fn().mockResolvedValue({ ok: true, settled: Promise.resolve({ view: {
      id: "op_mcp", status: "waiting_approval", pendingCallId: "pc_1", message: "请批准",
    } }) });
    const durable = new McpSurface({ hub, permissions, sessionOperations: { submit, endCredential: vi.fn() } });
    const append = vi.spyOn(hub, "append");
    try {
      const out = await durable.callTool(alice, "send_session_message", { resource_id: resourceId, prompt: "请同步当前进度" });
      expect(out).toMatchObject({ ok: false, code: "approval_required", message: expect.stringContaining("pc_1") });
      expect(submit).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledWith("mcp:sessions",
        { username: "alice", admin: false, session: false, credential: "mcp:a1" },
        { owner: "alice", device: "runtime", source: "codex", sessionId: "s1", prompt: "请同步当前进度", operation: "append_session" });
      expect(append).not.toHaveBeenCalled();
    } finally { durable.close(); append.mockRestore(); }
  });

  it("refuses a foreign send_session_message resource before Session Hub append", async () => {
    const foreign = hub.resourceId({ owner: "bob", device: "runtime", cliKind: "omp", sessionId: "s2" });
    const append = vi.spyOn(hub, "append");
    const out = await surface.callTool(alice, "send_session_message", {
      resource_id: foreign,
      prompt: "hello",
    });
    expect(out).toMatchObject({ ok: false, code: "forbidden" });
    expect(append).not.toHaveBeenCalled();
    append.mockRestore();
  });

  it("revoking the subject grant closes the owner's scopes; the next call refuses", async () => {
    permissions.revoke({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice", by: "alice" });
    const out = await surface.callTool(alice, "list_session_workspaces", {});
    expect(out).toMatchObject({ ok: false, code: "no_authority" });
    expect(surface.listTools("alice").map((t) => t.name)).toEqual([
      "list_recent_sessions",
      "search_sessions",
      "read_session",
      "send_session_message",
    ]);
  });

  it("unknown tool and undeclared arguments are refused as such", async () => {
    expect(await surface.callTool(alice, "made_up", {})).toMatchObject({ ok: false, code: "unknown_tool" });
    expect(await surface.callTool(alice, "search_sessions", { query: "x", owner: "bob" })).toMatchObject({
      ok: false,
      code: "invalid_params",
    });
  });
});

describe("McpSurface execution scopes (the dsh remote-backend door)", () => {
  let dir: string;
  let store: Store;
  let permissions: PermissionService;
  let surface: McpSurface;
  let registry: SessionExecutionRegistry;
  let planeOpen: ReturnType<typeof vi.fn>;
  const issuerToken = { owner: "alice", credential: "mcp:issuer01", policy: mcpTokenPolicy({ groups: ["execution"] }) };
  const workspaceOnly = { owner: "alice", credential: "mcp:ws01", policy: mcpTokenPolicy({ groups: ["workspace"] }) };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-execution-"));
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    permissions = new PermissionService({
      store,
      subjects: [mcpSubjectEntry({ workspaceComposed: () => false, crdtComposed: () => false, executionComposed: () => true })],
      extraAccountOperations: [() => [...MCP_EXECUTION_OPERATION_IDS]],
    });
    const hub = new SessionHubService({ store, permissions });
    const grantRequest = vi.fn(async (operation: string) => operation === "list_session_workspaces"
      ? { status: "succeeded" as const, result: { workspaces: [{ id: WS_ID, label: "proj" }] } }
      : { status: "denied" as const, reason: "no" });
    registry = new SessionExecutionRegistry({
      store,
      workspaceCapabilities: { open: () => ({ contextId: "ctx_w", request: grantRequest, destroy() {}, close() {} }) } as never,
      executionCapabilities: { open: () => ({ request: vi.fn(), destroy() {} }) } as never,
      workspaceFilesService: {
        open: () => ({ refreshRoots: async () => ({ ok: true, value: { roots: [{ ref: "wf_r", label: "proj", sourceLabel: "val15" }], truncated: false } }) }),
        closeScope: async () => {},
      } as never,
      devices: () => [{
        device: "val15",
        online: true,
        created_at: NOW,
        last_seen_at: null,
        inventory: {
          schema: "runner-inventory/v1",
          agent_backends: [],
          execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 1, codex_exec_server: false },
        } as never,
      }],
      publicUrl: "https://bot.example",
      dashboardPort: 9820,
    });
    // A structural stand-in for the issuer Object's grant: it dispatches to the
    // registry exactly as the real adapter does, and never sees a token.
    planeOpen = vi.fn(({ autoAllow }: { autoAllow?: readonly string[] }) => ({
      slot: "execution-scope",
      capabilities: { result: () => null },
      request: async (operation: string, args: Record<string, unknown>) => {
        if (!autoAllow?.includes(operation)) return { status: "approval_required" as const, pendingCallId: "pc_scope" };
        if (operation === "list_execution_targets") return { status: "succeeded" as const, result: { targets: await registry.listTargets("alice") } };
        return {
          status: "succeeded" as const,
          result: await registry.open({
            owner: "alice",
            issuer: String(args.issuer),
            device: String(args.device),
            workspaceId: String(args.workspace_id),
            permissionProfile: args.permission_profile as "full_access" | "manual",
            runtime: String(args.runtime ?? "dsh"),
            ttlMs: Number(args.ttl_minutes ?? 480) * 60_000,
          }),
        };
      },
      destroy() {},
    }));
    surface = new McpSurface({
      hub,
      permissions,
      workspaceFilesService: new WorkspaceFilesService(),
      sessionExecution: registry,
      executionScopes: { open: planeOpen } as never,
      publicUrl: "https://bot.example",
    });
  });

  afterAll(() => {
    surface.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows the execution tools only to an execution-group token after the owner granted them", async () => {
    expect(surface.listTools(issuerToken).map((t) => t.name)).toEqual([]);
    await expect(surface.callTool(issuerToken, "list_execution_targets", {})).resolves.toMatchObject({ ok: false, code: "no_authority" });
    permissions.grant({
      subjectType: "service",
      subjectId: MCP_SUBJECT_ID,
      owner: "alice",
      operations: ["list_execution_targets", "open_workspace_execution"],
      autoAllow: ["list_execution_targets"],
      source: "user",
      createdBy: "alice",
    });
    expect(surface.listTools(issuerToken).map((t) => t.name)).toEqual(["list_execution_targets", "open_workspace_execution"]);
    expect(surface.listTools(workspaceOnly).map((t) => t.name)).toEqual([]);
    await expect(surface.callTool(workspaceOnly, "open_workspace_execution", {})).resolves.toMatchObject({ ok: false, code: "unknown_tool" });
  });

  it("lists targets, refuses an unapproved open with a card, and hands the token over once after auto-allow", async () => {
    await expect(surface.callTool(issuerToken, "list_execution_targets", {})).resolves.toMatchObject({
      ok: true,
      result: { targets: [{ device: "val15", workspaces: [{ workspace_id: WS_ID, label: "proj" }] }] },
    });
    const args = { device: "val15", workspace_id: WS_ID, permission_profile: "full_access", runtime: "dsh:web" };
    await expect(surface.callTool(issuerToken, "open_workspace_execution", args)).resolves.toMatchObject({
      ok: false,
      code: "approval_required",
    });
    await expect(surface.callTool(issuerToken, "open_workspace_execution", { ...args, extra: 1 })).resolves.toMatchObject({
      ok: false,
      code: "invalid_params",
    });

    permissions.grant({
      subjectType: "service",
      subjectId: MCP_SUBJECT_ID,
      owner: "alice",
      operations: ["list_execution_targets", "open_workspace_execution"],
      autoAllow: ["list_execution_targets", "open_workspace_execution"],
      source: "user",
      createdBy: "alice",
    });
    const opened = await surface.callTool(issuerToken, "open_workspace_execution", args);
    expect(opened.ok).toBe(true);
    const issued = (opened as { result: { token: string; endpoint: string; operation_id: string; device: string; workspace_id: string } }).result;
    expect(issued.token).toMatch(/^mcp_/);
    expect(issued.endpoint).toBe("https://bot.example/api/mcp");
    expect(issued).toMatchObject({ device: "val15", workspace_id: WS_ID, permission_profile: "full_access" });
    // The grant was derived with the caller's credential as issuer metadata.
    expect(planeOpen).toHaveBeenLastCalledWith(expect.objectContaining({
      username: "alice",
      rights: ["list_execution_targets", "open_workspace_execution"],
      metadata: { surface: "mcp", credential: "mcp:issuer01" },
    }));

    // The child credential sees exactly the five session tools, nothing else.
    const child = {
      owner: "alice",
      credential: mcpCredentialOf(hashRunnerToken(issued.token)),
      policy: mcpSessionExecutionPolicy({
        operationId: issued.operation_id,
        runtimeDevice: "dsh:web",
        executionDevice: "val15",
        workspaceId: WS_ID,
        permissionProfile: "full_access",
      }),
    };
    expect(surface.listTools(child).map((t) => t.name)).toEqual([
      "list_session_workspaces",
      "list_workspace_entries",
      "read_workspace_text",
      "replace_workspace_text",
      "run_workspace_command",
    ]);
    await expect(surface.callTool(child, "open_workspace_execution", args)).resolves.toMatchObject({ ok: false, code: "unknown_tool" });

    // Revoking the issuing token ends the child scope too.
    surface.releaseCredential("alice", "mcp:issuer01");
    expect(surface.listTools(child)).toEqual([]);
    await expect(surface.callTool(child, "list_session_workspaces", {})).resolves.toMatchObject({ ok: false, code: "no_authority" });
  });
});
