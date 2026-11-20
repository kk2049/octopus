/**
 * Generic MCP stdio shim for CLI agents (claude-code / codex adapters).
 *
 * A thin relay in the devpipe/mcp-server.ts mold: the CLI speaks MCP to this
 * process; every tools/call is forwarded over loopback HTTP with a per-turn
 * bearer token to the engine host, where the REAL tool (the app's dispatch
 * door) runs. Tool definitions arrive via a file (V3_SHIM_TOOLS_FILE) instead
 * of an env blob — TOML/JSON quoting across two CLIs' config syntaxes is
 * exactly the kind of fight one should refuse to have.
 *
 * Transport is node:http with no timeout, matching devpipe's reasoning: a
 * tool call is allowed to take as long as the host says it takes.
 */

import * as fs from "node:fs";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const API = process.env.V3_SHIM_URL ?? "";
const TOKEN = process.env.V3_SHIM_TOKEN ?? "";
const TOOLS_FILE = process.env.V3_SHIM_TOOLS_FILE ?? "";

if (!API || !TOKEN || !TOOLS_FILE) {
  console.error("V3_SHIM_URL / V3_SHIM_TOKEN / V3_SHIM_TOOLS_FILE are required");
  process.exit(1);
}

interface ShimTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const tools = (JSON.parse(fs.readFileSync(TOOLS_FILE, "utf8")) as ShimTool[]).map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.parameters,
}));

function call(name: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/shim/call", API);
    const req = http.request(
      url,
      { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            const doc = JSON.parse(body) as { ok?: boolean; result?: string; message?: string };
            if (doc.ok) resolve(doc.result ?? "");
            else reject(new Error(doc.message ?? `HTTP ${res.statusCode}`));
          } catch {
            reject(new Error(`host 返回非 JSON (HTTP ${res.statusCode}): ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ name, args }));
  });
}

const server = new Server({ name: "v3-app", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const text = await call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    // Denials are guidance, not crashes — same ruling as devpipe's server.
    return {
      content: [{ type: "text", text: `工具调用失败: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
console.error(`v3 mcp shim ready · ${tools.length} tools · api=${API}`);
