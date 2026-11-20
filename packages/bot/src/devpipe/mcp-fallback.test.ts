import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callLiveMcpTool,
  readLiveMcpConfig,
  renderMcpToolResult,
  type McpFallbackConnection,
} from "./mcp-fallback.js";
import { runMcpFallbackCli } from "./call-mcp.js";

const dirs: string[] = [];

async function fixture(config: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "octopus-mcp-recovery-"));
  dirs.push(dir);
  await writeFile(path.join(dir, ".mcp-devpipe.json"), JSON.stringify(config), { mode: 0o600 });
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("readLiveMcpConfig", () => {
  it("reads only a regular owner-only config in the current worktree", async () => {
    const dir = await fixture({
      mcpServers: { devpipe: { command: "node", args: ["server.js"], env: { DEVPIPE_TOKEN: "secret" } } },
    });
    await expect(readLiveMcpConfig(dir)).resolves.toEqual({
      devpipe: { command: "node", args: ["server.js"], env: { DEVPIPE_TOKEN: "secret" } },
    });

    await chmod(path.join(dir, ".mcp-devpipe.json"), 0o640);
    await expect(readLiveMcpConfig(dir)).rejects.toThrow(/mode 0600/);
  });

  it("does not follow a replacement symlink", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "octopus-mcp-recovery-link-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "target.json"), JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    await symlink("target.json", path.join(dir, ".mcp-devpipe.json"));
    await expect(readLiveMcpConfig(dir)).rejects.toThrow(/unavailable/);
  });
});

describe("callLiveMcpTool", () => {
  it("connects to a real stdio MCP server through the SDK", async () => {
    const dir = await mkdtemp(path.join(process.cwd(), "packages/bot/.mcp-recovery-e2e-"));
    dirs.push(dir);
    const serverFile = path.join(dir, "server.mjs");
    await writeFile(serverFile, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: JSON.stringify(request.params.arguments) }] }));
await server.connect(new StdioServerTransport());
`);
    await writeFile(path.join(dir, ".mcp-devpipe.json"), JSON.stringify({
      mcpServers: { fixture: { command: process.execPath, args: [serverFile] } },
    }), { mode: 0o600 });

    const result = await callLiveMcpTool({
      cwd: dir,
      server: "fixture",
      tool: "echo",
      arguments: { verified: true },
      timeoutMs: 10_000,
    });
    expect(renderMcpToolResult(result)).toBe('{"verified":true}');
  });

  it("lists the declared server tools, calls an exact match, and preserves the long timeout", async () => {
    const dir = await fixture({ mcpServers: { machines: { command: "node", env: { MACHINES_TOKEN: "secret" } } } });
    const close = vi.fn(async () => undefined);
    const listTools = vi.fn()
      .mockResolvedValueOnce({ tools: [{ name: "machine_host_info" }], nextCursor: "p2" })
      .mockResolvedValueOnce({ tools: [{ name: "machine_exec" }] });
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const client = { listTools, callTool, close } as McpFallbackConnection;
    const connector = vi.fn(async () => client);

    await expect(callLiveMcpTool({
      cwd: dir,
      server: "machines",
      tool: "machine_exec",
      arguments: { command: "pnpm test" },
      timeoutMs: 123_000,
    }, connector)).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });

    expect(connector).toHaveBeenCalledWith(
      { command: "node", env: { MACHINES_TOKEN: "secret" } },
      path.resolve(dir),
    );
    expect(listTools.mock.calls[1]?.[0]).toEqual({ cursor: "p2" });
    expect(callTool).toHaveBeenCalledWith(
      { name: "machine_exec", arguments: { command: "pnpm test" } },
      undefined,
      { timeout: 123_000, maxTotalTimeout: 123_000 },
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses tools absent from listTools and still closes the client", async () => {
    const dir = await fixture({ mcpServers: { devpipe: { command: "node" } } });
    const close = vi.fn(async () => undefined);
    const client = {
      listTools: vi.fn(async () => ({ tools: [{ name: "devpipe_status" }] })),
      callTool: vi.fn(),
      close,
    } as unknown as McpFallbackConnection;
    await expect(callLiveMcpTool({
      cwd: dir,
      server: "devpipe",
      tool: "devpipe_submit_typo",
      arguments: {},
    }, async () => client)).rejects.toThrow(/not declared/);
    expect(client.callTool).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("runMcpFallbackCli", () => {
  it("accepts pnpm's leading -- separator before validating the live config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "octopus-mcp-recovery-cli-"));
    dirs.push(dir);
    await expect(runMcpFallbackCli(["--", "devpipe", "devpipe_status", "{}"], { cwd: dir }))
      .rejects.toThrow(/live MCP config is unavailable/);
  });
});

describe("renderMcpToolResult", () => {
  it("prints text without echoing unrelated result fields", () => {
    expect(renderMcpToolResult({
      content: [{ type: "text", text: "done" }],
      accidental_secret: "must-not-print",
    })).toBe("done");
  });

  it("uses structured content when no text block exists", () => {
    expect(renderMcpToolResult({ structuredContent: { ok: true } })).toBe('{\n  "ok": true\n}');
  });
});
