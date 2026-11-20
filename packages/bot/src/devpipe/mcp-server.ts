/**
 * devpipe MCP server — the dev agent's control surface (ticket #12).
 *
 * A thin stdio shell like hq/mcp-server.ts: the actual claim/submit/status
 * logic lives in DevPipeline inside the bot process; this server only relays
 * tool calls over loopback HTTP with a per-turn bearer token (DEVPIPE_TOKEN),
 * so validation, the dev lock and the merge all happen exactly once, in one
 * process. The token dies with the turn — a stale server from a killed turn
 * gets "token 无效" instead of a lock.
 *
 * Transport is node:http, NOT fetch: undici's default headersTimeout (5 min)
 * would sever a devpipe_submit whose gate run takes longer — and a severed
 * submit looks to the agent like a failure while the merge may still land.
 * These requests must be allowed to sit for as long as the gates take.
 */

import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { devpipeToolsForTicket, DEVPIPE_OP_BY_TOOL } from "./tool-contract.js";

const API = process.env.DEVPIPE_API ?? "";
const TOKEN = process.env.DEVPIPE_TOKEN ?? "";
const tools = devpipeToolsForTicket(process.env.DEVPIPE_KNOWLEDGE_CONFLICT === "1");

if (!API || !TOKEN) {
  console.error("DEVPIPE_API and DEVPIPE_TOKEN environment variables are required");
  process.exit(1);
}

/** POST with no timeouts — a submit legitimately runs for the gate's duration. */
function post(op: string, body: unknown = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/devpipe/${op}`, API);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(body) as Record<string, unknown>);
          } catch {
            reject(new Error(`bot 返回了非 JSON 响应 (HTTP ${res.statusCode}): ${body.slice(0, 300)}`));
          }
        });
      },
    );
    req.on("error", (err) => reject(err));
    req.end(JSON.stringify(body ?? {}));
  });
}

/** Render the pipeline's structured result as agent-readable text. */
function renderResult(data: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof data.message === "string") parts.push(data.message);
  if (typeof data.ff_commits === "string" && data.ff_commits.trim() && !parts[0]?.includes(data.ff_commits)) {
    parts.push(`期间合入:\n${data.ff_commits}`);
  }
  if (Array.isArray(data.files) && data.files.length) parts.push(`涉及文件:${data.files.join(", ")}`);
  if (typeof data.gate_log_tail === "string" && data.gate_log_tail) {
    parts.push(`--- 测试日志尾 ---\n${data.gate_log_tail}`);
  }
  // rename returns { ok, message }; message is already picked up above.
  if (!parts.length) parts.push(JSON.stringify(data));
  return parts.join("\n\n");
}

const server = new Server({ name: "devpipe", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const op = DEVPIPE_OP_BY_TOOL[req.params.name];
  if (!op || !tools.some((tool) => tool.name === req.params.name)) {
    return { content: [{ type: "text", text: `未知工具: ${req.params.name}` }], isError: true };
  }
  try {
    const data = await post(op, req.params.arguments ?? {});
    // Denials and gate failures are expected flow, not errors — the agent is
    // supposed to read the guidance and act, not see a red tool result.
    return { content: [{ type: "text", text: renderResult(data) }] };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `devpipe 调用失败: ${m}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
console.error(`devpipe MCP server ready · api=${API}`);
