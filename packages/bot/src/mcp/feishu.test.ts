import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionService } from "../permissions/service.js";
import { SessionHubService } from "../sessionhub/service.js";
import { Store } from "../store/store.js";
import { MCP_FEISHU_OPERATION_IDS, MCP_SUBJECT_ID, mcpSubjectEntry } from "./catalog.js";
import { McpSurface, type McpFeishuGrant, type McpFeishuPlane } from "./service.js";
import { mcpTokenPolicy } from "./tokens.js";

describe("MCP Feishu capability adapter", () => {
  let dir: string;
  let store: Store;
  let surface: McpSurface;
  const calls: Array<{ operation: string; args: unknown }> = [];
  const views = new Map<string, ReturnType<McpFeishuGrant["capabilities"]["result"]>>();
  const grant: McpFeishuGrant = {
    slot: "feishu",
    capabilities: {
      request: async (_slot, operation, args) => {
        calls.push({ operation, args });
        if (operation === "calendar_create_event" || operation === "message_send_as_bot" || operation === "task_create") {
          return { status: "approval_required" as const, pendingCallId: `pc_${calls.length}` };
        }
        return { status: "succeeded" as const, result: { operation, args } };
      },
      result: (pendingCallId) => views.get(pendingCallId) ?? null,
    },
    destroy() {},
  };
  const plane: McpFeishuPlane = {
    runnable: () => new Set(MCP_FEISHU_OPERATION_IDS),
    open: () => grant,
    openPrivileged: () => ({ ...grant, slot: "feishu-privileged" }),
  };
  const alice = { owner: "alice", credential: "mcp:alice" };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-feishu-"));
    store = new Store(join(dir, "bot.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: "2026-08-13T00:00:00.000Z" });
    const permissions = new PermissionService({
      store,
      subjects: [mcpSubjectEntry({
        workspaceComposed: () => false,
        crdtComposed: () => false,
        feishuComposed: () => true,
        feishuPrivilegedOperations: (owner) => owner === "alice" ? ["message_send_as_bot"] : [],
      })],
      extraAccountOperations: [() => [...MCP_FEISHU_OPERATION_IDS]],
    });
    permissions.grant({
      subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice",
      operations: ["calendar_primary", "calendar_list_events", "calendar_create_event", "task_create", "message_send_as_bot"],
      autoAllow: ["calendar_primary", "calendar_list_events"], source: "user", createdBy: "alice",
    });
    surface = new McpSurface({
      hub: new SessionHubService({ store, permissions }),
      permissions,
      feishu: plane,
      feishuPrivilegedRights: (owner) => owner === "alice" ? ["message_send_as_bot"] : [],
      publicUrl: "https://bot.example",
    });
  });

  afterAll(() => {
    surface.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("derives the visible schema and validated call from the reviewed catalog", async () => {
    const names = surface.listTools(alice).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "feishu_calendar_primary", "feishu_calendar_list_events", "feishu_calendar_create_event",
    ]));
    const listed = surface.listTools(alice).find((tool) => tool.name === "feishu_calendar_list_events")!;
    expect(listed.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["calendar_id"],
      properties: { calendar_id: { type: "string", maxLength: 256 }, page_size: { type: "integer", maximum: 100 } },
    });
    expect(await surface.callTool(alice, "feishu_calendar_list_events", { calendar_id: "cal_1", page_size: 10 }))
      .toMatchObject({ ok: true, result: { operation: "calendar_list_events" } });
    expect(calls.at(-1)).toEqual({ operation: "calendar_list_events", args: { calendar_id: "cal_1", page_size: 10 } });
    expect(await surface.callTool(alice, "feishu_calendar_list_events", { calendar_id: "cal_1", surprise: true }))
      .toMatchObject({ ok: false, code: "invalid_params" });
  });

  it("keeps Feishu writes behind the capability approval desk", async () => {
    expect(await surface.callTool(alice, "feishu_calendar_create_event", {
      calendar_id: "cal_1", summary: "复盘", start_timestamp: "1786608000", end_timestamp: "1786611600",
    })).toMatchObject({ ok: false, code: "approval_required" });
  });

  it("collects an approved write with the same arguments instead of asking twice", async () => {
    const args = { summary: "复盘", description: "第二轮" };
    const asked = await surface.callTool(alice, "feishu_task_create", args);
    expect(asked).toMatchObject({ ok: false, code: "approval_required" });
    const pendingCallId = `pc_${calls.length}`;
    expect(JSON.stringify(asked)).toContain(pendingCallId);
    const before = calls.length;
    views.set(pendingCallId, { state: "pending", outcome: null, result: null, reason: null });
    expect(await surface.callTool(alice, "feishu_task_create", args)).toMatchObject({ ok: false, code: "approval_required" });
    views.set(pendingCallId, { state: "finished", outcome: "succeeded", result: { task: { guid: "t-1" } }, reason: null });
    expect(await surface.callTool(alice, "feishu_task_create", args)).toEqual({ ok: true, result: { task: { guid: "t-1" } } });
    expect(calls.length).toBe(before);
    // Collected once; the same arguments afterwards are a new request.
    expect(await surface.callTool(alice, "feishu_task_create", args)).toMatchObject({ ok: false, code: "approval_required" });
    expect(calls.length).toBe(before + 1);
  });

  it("exposes a standard bot message tool only inside the exact deployment ceiling", async () => {
    expect(surface.listTools(alice).map((tool) => tool.name)).toContain("feishu_message_send_as_bot");
    expect(await surface.callTool(alice, "feishu_message_send_as_bot", {
      target_ref: "feishu://people/ou_1",
      text: "hello",
    })).toMatchObject({ ok: false, code: "approval_required" });
    const withoutCeiling = mcpSubjectEntry({
      workspaceComposed: () => false,
      crdtComposed: () => false,
      feishuComposed: () => true,
    });
    expect(withoutCeiling.declared?.("alice")).not.toContain("message_send_as_bot");
  });

  it("lets the credential-local policy remove the whole plane without widening grants", async () => {
    const appsOnly = { ...alice, policy: mcpTokenPolicy({ groups: ["apps"] }) };
    expect(surface.listTools(appsOnly)).toEqual([]);
    expect(await surface.callTool(appsOnly, "feishu_calendar_primary", {}))
      .toMatchObject({ ok: false, code: "unknown_tool" });
  });
});

describe("MCP Feishu file send by path", () => {
  let dir: string;
  let store: Store;
  let surface: McpSurface;
  const calls: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const resolved: Array<{ session: unknown; mention: string }> = [];
  const bytes = Buffer.alloc(5 * 1024 * 1024, 9);
  const grant: McpFeishuGrant = {
    slot: "feishu-privileged",
    capabilities: {
      request: async (_slot, operation, args) => {
        calls.push({ operation, args: args as Record<string, unknown> });
        return { status: "approval_required" as const, pendingCallId: "pc_file" };
      },
      result: () => null,
    },
    destroy() {},
  };
  const plane: McpFeishuPlane = { runnable: () => new Set(MCP_FEISHU_OPERATION_IDS), open: () => null, openPrivileged: () => grant };
  const caller = { device: "laptop", source: "claude", sessionId: "sess-1" };
  const alice = { owner: "alice", credential: "runner-local:laptop", caller };
  const base = { target_ref: "feishu://chats/oc_1", file_name: "five.bin", file_type: "stream" };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-feishu-file-"));
    store = new Store(join(dir, "bot.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: "2026-08-13T00:00:00.000Z" });
    const permissions = new PermissionService({
      store,
      subjects: [mcpSubjectEntry({
        workspaceComposed: () => false, crdtComposed: () => false, feishuComposed: () => true,
        feishuPrivilegedOperations: () => ["message_send_file_as_bot"],
      })],
      extraAccountOperations: [() => [...MCP_FEISHU_OPERATION_IDS]],
    });
    permissions.grant({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice",
      operations: ["message_send_file_as_bot"], autoAllow: [], source: "user", createdBy: "alice" });
    surface = new McpSurface({
      hub: new SessionHubService({ store, permissions }),
      permissions,
      feishu: plane,
      feishuPrivilegedRights: () => ["message_send_file_as_bot"],
      callerFiles: () => ({
        resolve: async (session, mention) => {
          resolved.push({ session, mention });
          if (mention !== "out/five.bin") throw new Error("这个路径不在所有者登记的任何工作区里");
          return { workspace: { workspaceId: "ws_1", label: "proj" }, relativePath: "out/five.bin" };
        },
        read: async (_owner, _device, target) => ({
          kind: "file", workspace: target.workspace, path: target.relativePath, name: "five.bin", size: bytes.length, modifiedAt: "",
          chunks: (async function* () { for (let at = 0; at < bytes.length; at += 256 * 1024) yield bytes.subarray(at, at + 256 * 1024); })(),
        }),
      }),
    });
  });

  afterAll(() => {
    surface.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("offers path, never the surface-owned source fields", () => {
    const tool = surface.listTools(alice).find((entry) => entry.name === "feishu_message_send_file_as_bot")!;
    const properties = Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(properties).toContain("path");
    expect(properties).toContain("file_base64");
    for (const hidden of ["source_device", "source_workspace", "source_path", "file_size", "file_sha256"]) expect(properties).not.toContain(hidden);
  });

  it("names the caller's own device and the approved digest for a 5 MiB file", async () => {
    expect(await surface.callTool(alice, "feishu_message_send_file_as_bot", { ...base, path: "out/five.bin" }))
      .toMatchObject({ ok: false, code: "approval_required" });
    expect(resolved.at(-1)).toEqual({ session: { owner: "alice", device: "laptop", cliKind: "claude", sessionId: "sess-1" }, mention: "out/five.bin" });
    expect(calls.at(-1)).toEqual({ operation: "message_send_file_as_bot", args: {
      ...base, source_device: "laptop", source_workspace: "ws_1", source_path: "out/five.bin",
      file_size: bytes.length, file_sha256: createHash("sha256").update(bytes).digest("hex"),
    } });
  });

  it("cannot be steered to another device and explains what a caller without a session needs", async () => {
    const before = calls.length;
    expect(await surface.callTool(alice, "feishu_message_send_file_as_bot", { ...base, path: "out/five.bin", source_device: "server" }))
      .toMatchObject({ ok: false, code: "invalid_params" });
    const remote = { owner: "alice", credential: "mcp:alice" };
    const refused = await surface.callTool(remote, "feishu_message_send_file_as_bot", { ...base, path: "out/five.bin" });
    expect(refused).toMatchObject({ ok: false, code: "invalid_params" });
    expect(JSON.stringify(refused)).toContain("Runner 桥接");
    expect(await surface.callTool(alice, "feishu_message_send_file_as_bot", { ...base, path: "out/five.bin", file_base64: "YQ==" }))
      .toMatchObject({ ok: false, code: "invalid_params" });
    expect(calls.length).toBe(before);
  });
});

describe("MCP lark-cli results", () => {
  let dir: string;
  let store: Store;
  let surface: McpSurface;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]).toString("base64");
  const grant: McpFeishuGrant = {
    slot: "feishu",
    capabilities: {
      request: async (_slot, operation) => ({ status: "succeeded" as const, result: operation === "lark_cli_read"
        ? { exit_code: 0, stdout: { ok: true }, files: [
          { path: ".lark-slides/screenshots/1.png", bytes: 9, sha256: "a", media_type: "image/png", base64: png },
          { path: "deck.xml", bytes: 3, sha256: "b", text: "<p/>" },
        ] }
        : { files: [{ path: "x.png", media_type: "image/png", base64: png }] } }),
      result: () => null,
    },
    destroy() {},
  };
  const alice = { owner: "alice", credential: "mcp:alice" };
  const opened: Array<{ rights: readonly string[]; autoAllow?: readonly string[] }> = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-feishu-cli-"));
    store = new Store(join(dir, "bot.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: "2026-08-13T00:00:00.000Z" });
    const permissions = new PermissionService({
      store,
      subjects: [mcpSubjectEntry({ workspaceComposed: () => false, crdtComposed: () => false, feishuComposed: () => true })],
      extraAccountOperations: [() => [...MCP_FEISHU_OPERATION_IDS]],
    });
    // As the permission page grants: every chosen operation, auto-allow where the catalog permits it.
    const chosen = ["lark_cli_read", "lark_cli_write", "doc_read", "doc_create"];
    permissions.grant({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice",
      operations: chosen, autoAllow: chosen, source: "user", createdBy: "alice" });
    surface = new McpSurface({
      hub: new SessionHubService({ store, permissions }),
      permissions,
      feishu: { runnable: () => new Set(MCP_FEISHU_OPERATION_IDS), open: (o) => { opened.push(o); return grant; }, openPrivileged: () => null },
      publicUrl: "https://bot.example",
    });
  });

  afterAll(() => {
    surface.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("offers both tools with the catalog's argument descriptions", () => {
    const tools = surface.listTools(alice).filter((tool) => tool.name.startsWith("feishu_lark_cli_"));
    expect(tools.map((tool) => tool.name).sort()).toEqual(["feishu_lark_cli_read", "feishu_lark_cli_write"]);
    const read = tools.find((tool) => tool.name === "feishu_lark_cli_read")!;
    expect(JSON.stringify(read.inputSchema)).toContain("JSON 字符串数组");
    expect((read.inputSchema as { required?: string[] }).required).toEqual(["args"]);
  });

  it("lifts screenshots out of the JSON into image blocks and keeps the file list", async () => {
    const out = await surface.callTool(alice, "feishu_lark_cli_read", { args: JSON.stringify(["slides", "+screenshot"]) });
    expect(out).toEqual({
      ok: true,
      result: { exit_code: 0, stdout: { ok: true }, files: [
        { path: ".lark-slides/screenshots/1.png", bytes: 9, sha256: "a", media_type: "image/png", image: 1 },
        { path: "deck.xml", bytes: 3, sha256: "b", text: "<p/>" },
      ] },
      images: [{ mimeType: "image/png", data: png }],
    });
  });

  it("lets a granted CLI write run unattended while other Feishu writes keep asking", async () => {
    await surface.callTool(alice, "feishu_lark_cli_write", { args: JSON.stringify(["slides", "+add-slide"]) });
    const { autoAllow } = opened.at(-1)!;
    expect(autoAllow).toEqual(expect.arrayContaining(["lark_cli_read", "lark_cli_write", "doc_read"]));
    expect(autoAllow).not.toContain("doc_create");
  });

  it("never promotes image-shaped JSON from another Feishu tool", async () => {
    const out = await surface.callTool(alice, "feishu_doc_read", { document_id: "d" });
    expect(out).toEqual({ ok: true, result: { files: [{ path: "x.png", media_type: "image/png", base64: png }] } });
  });
});
