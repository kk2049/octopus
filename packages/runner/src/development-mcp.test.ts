import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DevelopmentMcpManager } from "./development-mcp.js";
import { RunnerSessionOperations } from "./session-operations.js";
import { handleRpc } from "./core.js";
import { openManagedRemoteExecution } from "./managed-remote-execution.js";
const managers: DevelopmentMcpManager[] = [], servers: Server[] = [], roots: string[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function upstream() {
  let accepted = "mcp_first";
  const received: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push(String(req.headers.authorization));
    if (req.headers.authorization !== "Bearer " + accepted) { res.writeHead(401).end(); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = body.method === "initialize" ? { serverInfo: { name: "octopus" } }
      : body.method === "tools/list" ? { tools: [
        { name: "devpipe_status", inputSchema: { type: "object", properties: {} } },
        { name: "run_workspace_command", inputSchema: { type: "object", properties: {} } },
      ] }
      : { content: [{ type: "text", text: "current ticket" }] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  }); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  return { endpoint: "http://127.0.0.1:" + address.port + "/api/mcp",
    rotate: (token: string) => { accepted = token; }, received };
}
function manager(options: { idleMs?: number; capacity?: number } = {}) {
  const value = new DevelopmentMcpManager(options); managers.push(value); return value;
}
async function tool(url: string) {
  return await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "devpipe_status", arguments: {} } }) });
}
describe("ticket development proxy lifetime", () => {
  it("keeps the provider URL while Head restart rotates authority and rejects incomplete binding", async () => {
    const up = await upstream(), m = manager();
    const binding = { developmentId: "ticket-1", endpoint: up.endpoint, token: "mcp_first" };
    const original = await m.renew("head-a", binding);
    expect(original).not.toContain("mcp_first");
    expect((await tool(original)).status).toBe(200);
    up.rotate("mcp_after_head_restart");
    expect(await m.renew("head-a", { ...binding, token: "mcp_after_head_restart" })).toBe(original);
    expect((await tool(original)).status).toBe(200);
    expect(up.received.at(-1)).toBe("Bearer mcp_after_head_restart");
    expect(() => m.credential({ _octopus_development_id: "ticket-1" })).toThrow("绑定不完整");
    expect(await m.renew("head-b", { ...binding, token: "mcp_after_head_restart" })).not.toBe(original);
  });
  it("holds active sessions, reclaims idle ports, and closes all resources on Runner shutdown", async () => {
    const up = await upstream(), m = manager({ idleMs: 30, capacity: 1 });
    const binding = { developmentId: "ticket-1", endpoint: up.endpoint, token: "mcp_first" };
    const url = await m.renew(undefined, binding), release = m.retain(undefined, "ticket-1");
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect((await tool(url)).status).toBe(200);
    await expect(m.renew(undefined, { ...binding, developmentId: "ticket-2" })).rejects.toThrow("容量已满");
    release(); release();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(tool(url)).rejects.toThrow();
    const restored = await m.renew(undefined, binding);
    await m.close();
    await expect(tool(restored)).rejects.toThrow();
    await expect(m.renew(undefined, binding)).rejects.toThrow("已关闭");
  });
  it("renews a running ticket credential through get_session_operation without submitting input", async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), "development-query-")); roots.push(home);
    const up = await upstream(), m = manager(), operations = new RunnerSessionOperations(home);
    const args = { operation_id: "ticket-query", _octopus_development_id: "ticket-1",
      _octopus_development_mcp_url: up.endpoint, _octopus_development_mcp_token: "mcp_first" };
    const reply = await handleRpc(home, { id: "query", method: "get_session_operation", args },
      { gatewaySite: "head-a", sessionOperations: operations, developmentMcp: m });
    expect(reply).toMatchObject({ ok: true, result: { state: "missing" } });
    const url = await m.renew("head-a", m.credential(args)!);
    up.rotate("mcp_new_turn");
    await handleRpc(home, { id: "query2", method: "get_session_operation",
      args: { ...args, _octopus_development_mcp_token: "mcp_new_turn" } },
      { gatewaySite: "head-a", sessionOperations: operations, developmentMcp: m });
    expect((await tool(url)).status).toBe(200);
    expect(up.received.at(-1)).toBe("Bearer mcp_new_turn");
    expect(await fs.readdir(home)).toEqual([]);
  });
});

it("uses fresh local development configuration before provider recovery after Runner restart", async () => {
  const up = await upstream(), before = manager(), after = manager();
  const credential = { developmentId: "ticket-1", endpoint: up.endpoint, token: "mcp_first", expiresAt: Date.now() + 60000 };
  const oldUrl = await before.renew("head-a", credential);
  await before.close();
  up.rotate("mcp_recovered");
  const recovered = await openManagedRemoteExecution({
    provider: "claude", cwd: "/unused", gatewaySite: "head-a", developmentMcp: after,
    scope: { endpoint: up.endpoint, token: "mcp_recovered", expiresAt: Date.now() + 60000,
      operationId: "recover-original", executionDevice: "compute", workspaceId: "ws_" + "a".repeat(24),
      development: { ...credential, token: "mcp_recovered" } },
  });
  expect(recovered.developmentMcpUrl).toBeTruthy();
  expect(recovered.developmentMcpUrl).not.toBe(oldUrl);
  expect((await tool(recovered.developmentMcpUrl!)).status).toBe(200);
  await recovered.close();
  await after.close();
});
