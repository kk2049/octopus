/**
 * The MCP JSON-RPC handler as a value function, and the tool table's two
 * derivations against each other.
 */

import { describe, expect, it } from "vitest";
import { handleMcpRpc, MCP_PROTOCOL_VERSIONS } from "./http.js";
import {
  CRDT_TOOLS,
  SESSION_TOOLS,
  WORKSPACE_TOOLS,
  readToolArgs,
  toolDefinitionOf,
} from "./tools.js";
import type { McpSurface } from "./service.js";

/** A surface double: the handler must not care what a tool does. */
function fakeSurface(overrides: Partial<Pick<McpSurface, "listTools" | "callTool">> = {}): McpSurface {
  return {
    listTools: () => [{ name: "t", description: "d", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    callTool: async (_p: unknown, name: string) =>
      name === "known" ? { ok: true, result: { hello: 1 } } : { ok: false, code: "unknown_tool", message: "no" },
    ...overrides,
  } as unknown as McpSurface;
}

const P = { owner: "alice", credential: "mcp:abc" };

describe("handleMcpRpc", () => {
  it("initialize negotiates a known protocol version and echoes the client's when supported", async () => {
    const out = await handleMcpRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      fakeSurface(),
      P,
    );
    expect(out.status).toBe(200);
    const body = out.body as { result: { protocolVersion: string; capabilities: { tools: object } } };
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("initialize answers our newest version for an unknown ask", async () => {
    const out = await handleMcpRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      fakeSurface(),
      P,
    );
    expect((out.body as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      MCP_PROTOCOL_VERSIONS[0],
    );
  });

  it("a notification is acknowledged with 202 and no body", async () => {
    const out = await handleMcpRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, fakeSurface(), P);
    expect(out.status).toBe(202);
    expect(out.body).toBeUndefined();
  });

  it("tools/list relays the surface's permission-filtered list", async () => {
    const out = await handleMcpRpc({ jsonrpc: "2.0", id: 7, method: "tools/list" }, fakeSurface(), P);
    const body = out.body as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(["t"]);
  });

  it("tools/call wraps success as text + structured content", async () => {
    const out = await handleMcpRpc(
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "known", arguments: {} } },
      fakeSurface(),
      P,
    );
    const body = out.body as {
      result: { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent: unknown };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0].text).toContain("hello");
    expect(body.result.structuredContent).toEqual({ hello: 1 });
  });

  it("tools/call for an unknown tool is a JSON-RPC invalid-params error", async () => {
    const out = await handleMcpRpc(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope", arguments: {} } },
      fakeSurface(),
      P,
    );
    expect((out.body as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("relays authorized Runner screenshots as image blocks and keeps receipt metadata without base64 text", async () => {
    const data = Buffer.from("bounded-test-image").toString("base64");
    const receipt = { status: "succeeded", request_id: "screenshot-once", revision: "a".repeat(32),
      result: { content: [{ type: "text", text: "private screenshot artifact" }, { type: "image", mimeType: "image/jpeg", data }] } };
    const out = await handleMcpRpc({ jsonrpc: "2.0", id: 20, method: "tools/call",
      params: { name: "runner_capability_call", arguments: {} } },
    fakeSurface({ callTool: async () => ({ ok: true, result: receipt }) }), P);
    const result = (out.body as { result: { content: Array<Record<string, unknown>>; structuredContent: unknown } }).result;
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/jpeg", data });
    expect(result.content[0]!.text).not.toContain(data);
    expect(result.structuredContent).toMatchObject({ request_id: "screenshot-once", revision: "a".repeat(32),
      result: { content: [{ type: "text" }, { type: "image", data_omitted: true, bytes: 18 }] } });
    expect(JSON.stringify(result.structuredContent)).not.toContain(data);
  });

  it.each([
    { mimeType: "image/jpeg", data: "not base64" },
    { mimeType: "image/svg+xml", data: "YWJj" },
    { mimeType: "image/png", data: "YWJj".repeat(70_000) },
  ])("refuses malformed or oversized provider images without claiming the input failed safely", async (image) => {
    const out = await handleMcpRpc({ jsonrpc: "2.0", id: 21, method: "tools/call",
      params: { name: "runner_capability_call", arguments: {} } }, fakeSurface({ callTool: async () => ({ ok: true,
      result: { status: "succeeded", result: { content: [{ type: "image", ...image }] } } }) }), P);
    expect(out.body).toMatchObject({ result: { isError: true, content: [{ type: "text", text: expect.stringContaining("do not replay") }] } });
  });

  it("preserves provider errors and never promotes image-shaped JSON from another tool", async () => {
    const receipt = { status: "succeeded", result: { isError: true, content: [{ type: "image", mimeType: "image/png", data: "YWJj" }] } };
    for (const name of ["runner_capability_call", "known"]) {
      const out = await handleMcpRpc({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name } },
        fakeSurface({ callTool: async () => ({ ok: true, result: receipt }) }), P);
      const result = (out.body as { result: { isError?: boolean; content: Array<{ type: string }> } }).result;
      expect(result.content.some(item => item.type === "image")).toBe(name === "runner_capability_call");
      expect(result.isError).toBe(name === "runner_capability_call" ? true : undefined);
    }
  });

  it("renders images a surface lifted out of a result as image blocks beside its JSON", async () => {
    const data = Buffer.from("slide-one").toString("base64");
    const result = { exit_code: 0, files: [{ path: "1.png", media_type: "image/png", image: 1 }] };
    const out = await handleMcpRpc({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "feishu_lark_cli_read" } },
      fakeSurface({ callTool: async () => ({ ok: true, result, images: [{ mimeType: "image/png", data }] }) }), P);
    const rendered = (out.body as { result: { content: Array<Record<string, unknown>>; structuredContent: unknown } }).result;
    expect(rendered.content).toEqual([{ type: "text", text: JSON.stringify(result, null, 2) }, { type: "image", mimeType: "image/png", data }]);
    expect(rendered.structuredContent).toEqual(result);
    const bad = await handleMcpRpc({ jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "feishu_lark_cli_read" } },
      fakeSurface({ callTool: async () => ({ ok: true, result, images: [{ mimeType: "image/svg+xml", data }] }) }), P);
    expect(bad.body).toMatchObject({ result: { isError: true, content: [{ type: "text", text: expect.stringContaining("do not replay") }] } });
  });

  it("a refusal travels as isError content, not as a protocol error", async () => {
    const out = await handleMcpRpc(
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "known", arguments: {} } },
      fakeSurface({
        callTool: async () => ({ ok: false, code: "approval_required", message: "待批准" }),
      }),
      P,
    );
    const body = out.body as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("approval_required");
  });

  it("an unknown method is -32601 and a non-2.0 message is -32600", async () => {
    const unknown = await handleMcpRpc({ jsonrpc: "2.0", id: 2, method: "wat" }, fakeSurface(), P);
    expect((unknown.body as { error: { code: number } }).error.code).toBe(-32601);
    const old = await handleMcpRpc({ jsonrpc: "1.0", id: 3, method: "ping" }, fakeSurface(), P);
    expect((old.body as { error: { code: number } }).error.code).toBe(-32600);
  });
});

describe("the tool table", () => {
  it("every derived schema is closed and carries its declared bounds", () => {
    for (const spec of [...SESSION_TOOLS, ...WORKSPACE_TOOLS]) {
      const def = toolDefinitionOf(spec);
      expect(def.inputSchema.additionalProperties).toBe(false);
      expect(def.description.length).toBeGreaterThan(0);
    }
    // The bound the Gate enforces is the bound the model reads: search query.
    const search = toolDefinitionOf(SESSION_TOOLS.find((t) => t.name === "search_sessions")!);
    expect(search.inputSchema.properties.query).toMatchObject({ maxLength: 512 });
    expect(search.inputSchema.required).toContain("query");
    const send = toolDefinitionOf(SESSION_TOOLS.find((t) => t.name === "send_session_message")!);
    expect(typeof (send.inputSchema.properties.prompt as { maxLength?: number }).maxLength).toBe("number");
    expect(send.inputSchema.required).toEqual(expect.arrayContaining(["resource_id", "prompt"]));
    // The CAS write carries the device's own byte ceiling.
    const write = toolDefinitionOf(WORKSPACE_TOOLS.find((t) => t.name === "replace_workspace_text")!);
    expect(write.inputSchema.properties.expected_digest).toMatchObject({ maxLength: 71 });
    expect(typeof (write.inputSchema.properties.text as { maxLength?: number }).maxLength).toBe("number");
    // 2026-10-20: the body and the precondition are per-stage requirements (a
    // staged append has no precondition, begin/commit no body); the port
    // checks them, the schema demands only the ref.
    expect(write.inputSchema.required).toEqual(["ref"]);
    expect(write.inputSchema.properties.stage).toMatchObject({ enum: ["begin", "append", "commit"] });
    const entries = toolDefinitionOf(WORKSPACE_TOOLS.find((t) => t.name === "list_workspace_entries")!);
    expect(entries.inputSchema.properties.after).toMatchObject({ type: "string" });
  });

  it("the crdt tools derive from the contract declaration with their gates split read/edit", () => {
    const names = CRDT_TOOLS.map((t) => t.definition.name);
    expect(names).toEqual(["crdt_open_doc", "crdt_apply_update", "crdt_read_updates"]);
    expect(CRDT_TOOLS.find((t) => t.definition.name === "crdt_apply_update")!.gate.operation).toBe("edit_document");
    expect(CRDT_TOOLS.find((t) => t.definition.name === "crdt_open_doc")!.gate.operation).toBe("read_document");
  });

  it("readToolArgs enforces exactly what the schema says", () => {
    const spec = SESSION_TOOLS.find((t) => t.name === "search_sessions")!;
    expect(readToolArgs(spec, { query: "x" }).ok).toBe(true);
    expect(readToolArgs(spec, {})).toMatchObject({ ok: false, message: expect.stringContaining("query") });
    expect(readToolArgs(spec, { query: "x", nope: 1 })).toMatchObject({
      ok: false,
      message: expect.stringContaining("nope"),
    });
    expect(readToolArgs(spec, { query: "x", limit: 999999 }).ok).toBe(false);
    expect(readToolArgs(spec, { query: "x", source: "wat" }).ok).toBe(false);
    expect(readToolArgs(spec, { query: 5 }).ok).toBe(false);
  });
});
