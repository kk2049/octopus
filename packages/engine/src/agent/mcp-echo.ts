/**
 * Demo MCP server for the factory's per-agent grant UI — proves the unlock
 * plumbing end-to-end without granting anything dangerous. One tool: echo.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo-demo", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "原样回显 text（演示用：证明这个 agent 被解锁了额外 MCP）",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: `echo: ${String((req.params.arguments as { text?: unknown })?.text ?? "")}` }],
}));
await server.connect(new StdioServerTransport());
console.error("echo-demo mcp ready");
