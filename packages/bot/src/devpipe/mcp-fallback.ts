import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_CONFIG_FILE, parsePipelineMcpConfig, type PipelineMcpServer } from "./mcp-config.js";

export const MCP_FALLBACK_TIMEOUT_MS = 45 * 60_000;

export interface McpFallbackConnection {
  listTools(params?: { cursor?: string }, options?: { timeout?: number; maxTotalTimeout?: number }): Promise<{
    tools: Array<{ name: string }>;
    nextCursor?: string;
  }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number; maxTotalTimeout?: number },
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export type McpFallbackConnector = (
  server: PipelineMcpServer,
  cwd: string,
) => Promise<McpFallbackConnection>;

async function connect(server: PipelineMcpServer, cwd: string): Promise<McpFallbackConnection> {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...getDefaultEnvironment(), ...(server.env ?? {}) },
    cwd,
    stderr: "pipe",
  });
  // MCP server diagnostics must not block on an unread pipe. They are omitted
  // deliberately: the short-lived config contains credentials and this CLI's
  // output is often copied verbatim into a ticket transcript.
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "octopus-devpipe-recovery", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    await transport.close().catch(() => undefined);
    throw err;
  }
  return client as unknown as McpFallbackConnection;
}

/**
 * Read only this worktree's live per-turn credential. O_NOFOLLOW plus fstat
 * prevents a symlink swap from turning the recovery command into a generic
 * config loader; exact 0600 and owner checks preserve the pipeline contract.
 */
export async function readLiveMcpConfig(cwd: string): Promise<Record<string, PipelineMcpServer>> {
  const file = path.join(path.resolve(cwd), MCP_CONFIG_FILE);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(`live MCP config is unavailable: ${MCP_CONFIG_FILE}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`live MCP config is not a regular file: ${MCP_CONFIG_FILE}`);
    if ((stat.mode & 0o777) !== 0o600) throw new Error(`live MCP config must have mode 0600: ${MCP_CONFIG_FILE}`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`live MCP config is not owned by this process user: ${MCP_CONFIG_FILE}`);
    }
    const body = await handle.readFile("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new Error(`live MCP config is invalid JSON: ${MCP_CONFIG_FILE}`);
    }
    return parsePipelineMcpConfig(parsed);
  } finally {
    await handle.close();
  }
}

export async function callLiveMcpTool(input: {
  cwd: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number;
}, connector: McpFallbackConnector = connect): Promise<Record<string, unknown>> {
  const cwd = path.resolve(input.cwd);
  const servers = await readLiveMcpConfig(cwd);
  const server = servers[input.server];
  if (!server) throw new Error(`MCP server is not declared by this turn: ${input.server}`);
  const timeout = input.timeoutMs ?? MCP_FALLBACK_TIMEOUT_MS;
  const options = { timeout, maxTotalTimeout: timeout };
  const client = await connector(server, cwd);
  try {
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (cursors.size >= 100) throw new Error("MCP tool listing exceeded 100 pages");
      const page = await client.listTools(cursor ? { cursor } : undefined, options);
      for (const tool of page.tools) names.add(tool.name);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("MCP tool listing returned a repeated cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!names.has(input.tool)) throw new Error(`MCP tool is not declared by server ${input.server}: ${input.tool}`);
    return await client.callTool({ name: input.tool, arguments: input.arguments }, undefined, options);
  } finally {
    await client.close();
  }
}

export function renderMcpToolResult(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item): item is { type: "text"; text: string } => Boolean(
      item && typeof item === "object" && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string",
    ))
    .map((item) => item.text)
    .join("\n");
  if (text) return text;
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
  return JSON.stringify({ isError: result.isError === true, content: [] });
}
