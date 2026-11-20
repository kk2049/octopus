import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ScopedMcpProxy } from "./scoped-mcp-proxy.js";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("ScopedMcpProxy", () => {
  it("keeps the credential out of the provider URL, overwrites auth, and revokes on close", async () => {
    const requests: Array<{ method: string; authorization: string; body: string }> = [];
    const upstream = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({
          method: request.method ?? "",
          authorization: String(request.headers.authorization ?? ""),
          body,
        });
        response.writeHead(request.method === "DELETE" ? 204 : 200, { "content-type": "application/json" });
        const parsed = body ? JSON.parse(body) as { id?: unknown; method?: unknown } : {};
        response.end(request.method === "DELETE"
          ? undefined
          : parsed.method === "initialize"
            ? JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: { listChanged: false } },
                  serverInfo: { name: "octopus", version: "1.0.0" },
                },
              })
            : JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { tools: [{ name: "run_workspace_command" }] },
              }));
      });
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const token = "mcp_1234567890abcdef";
    const proxy = new ScopedMcpProxy(new URL(`http://127.0.0.1:${address.port}/api/mcp`), token);
    const localUrl = await proxy.start();
    expect(localUrl).not.toContain(token);
    const result = await fetch(localUrl, {
      method: "POST",
      headers: { authorization: "Bearer attacker", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
    });
    expect(result.status).toBe(200);
    await proxy.close();

    expect(requests).toHaveLength(4);
    expect(requests[0]).toMatchObject({
      method: "POST",
      authorization: `Bearer ${token}`,
    });
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ method: "initialize" });
    expect(JSON.parse(requests[1]!.body)).toMatchObject({ method: "tools/list" });
    expect(requests[2]).toEqual({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
    });
    expect(requests[3]).toEqual({ method: "DELETE", authorization: `Bearer ${token}`, body: "" });

    const reusable = new ScopedMcpProxy(
      new URL(`http://127.0.0.1:${address.port}/api/mcp`),
      token,
      { revokeOnClose: false },
    );
    const reusableUrl = await reusable.start();
    expect((await fetch(reusableUrl, { method: "DELETE" })).status).toBe(204);
    await reusable.close();
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("accepts a read-only scope that lists its workspace and runs no command, and still refuses anything that is not that scope", async () => {
    const upstream = async (server: { name: string; tools: readonly string[] }) => {
      const listening = http.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const parsed = JSON.parse(body) as { id?: unknown; method?: unknown };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: parsed.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: server.name, version: "1" } }
            : { tools: server.tools.map((name) => ({ name })) } }));
        });
      });
      servers.push(listening);
      await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
      const address = listening.address();
      if (!address || typeof address === "string") throw new Error("test server has no port");
      return new URL(`http://127.0.0.1:${address.port}/api/mcp`);
    };
    const readOnly = ["list_session_workspaces", "list_workspace_entries", "read_workspace_text", "feishu_shared_doc_read"];
    const proxy = new ScopedMcpProxy(await upstream({ name: "octopus", tools: readOnly }), "mcp_1234567890abcdef", { revokeOnClose: false });
    await expect(proxy.start()).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+\/session\//);
    await proxy.close();
    for (const [server, options, refusal] of [
      [{ name: "octopus", tools: ["feishu_shared_doc_read"] }, {}, /缺少执行工具/],
      [{ name: "imitation", tools: readOnly }, {}, /不是 Octopus MCP/],
      [{ name: "octopus", tools: readOnly }, { requiredTool: "devpipe_status" }, /缺少绑定工具/],
    ] as const) {
      const refused = new ScopedMcpProxy(await upstream(server), "mcp_1234567890abcdef", { revokeOnClose: false, ...options });
      await expect(refused.start(), JSON.stringify(server)).rejects.toThrow(refusal);
    }
  });

  it("refuses plaintext credentials to a non-loopback endpoint", () => {
    expect(() => new ScopedMcpProxy(new URL("http://example.com/api/mcp"), "mcp_1234567890abcdef"))
      .toThrow(/HTTPS/);
  });

  it("fails closed when the credential endpoint is not Octopus MCP", async () => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const proxy = new ScopedMcpProxy(
      new URL(`http://127.0.0.1:${address.port}/api/mcp`),
      "mcp_1234567890abcdef",
    );
    await expect(proxy.start()).rejects.toThrow(/不是 Octopus MCP|initialize 响应无效/);
  });

  it("owns upstream response failures and aborted client uploads", async () => {
    let mode: "normal" | "break-response" | "upload" = "normal";
    let uploadStarted!: () => void;
    let uploadAborted!: () => void;
    const uploadStartedPromise = new Promise<void>((resolve) => { uploadStarted = resolve; });
    const uploadAbortedPromise = new Promise<void>((resolve) => { uploadAborted = resolve; });
    const upstream = http.createServer((request, response) => {
      if (mode === "upload") {
        uploadStarted();
        request.once("error", () => {});
        request.once("aborted", uploadAborted);
        request.resume();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (mode === "break-response") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"partial":');
          setImmediate(() => response.socket?.destroy());
          return;
        }
        const parsed = JSON.parse(body) as { id?: unknown; method?: unknown };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(parsed.method === "initialize"
          ? JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "octopus", version: "1" },
              },
            })
          : JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { tools: [{ name: "run_workspace_command" }] } }));
      });
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const proxy = new ScopedMcpProxy(
      new URL(`http://127.0.0.1:${address.port}/api/mcp`),
      "mcp_1234567890abcdef",
      { revokeOnClose: false },
    );
    const localUrl = await proxy.start();

    try {
      mode = "break-response";
      await expect(fetch(localUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
      }).then((response) => response.text())).rejects.toThrow();

      mode = "upload";
      const target = new URL(localUrl);
      const client = http.request({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "4096" },
      });
      client.once("error", () => {});
      client.write("partial");
      await uploadStartedPromise;
      client.destroy();
      await uploadAbortedPromise;

      mode = "normal";
      const recovered = await fetch(localUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "recovered", method: "tools/list" }),
      });
      expect(recovered.status).toBe(200);
      await expect(recovered.json()).resolves.toMatchObject({ result: { tools: [{ name: "run_workspace_command" }] } });
    } finally {
      await proxy.close();
    }
  });
});
