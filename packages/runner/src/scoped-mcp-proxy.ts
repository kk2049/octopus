import { randomUUID } from "node:crypto";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";

const REQUEST_TIMEOUT_MS = 15 * 60_000;
const UPSTREAM_PROBE_TIMEOUT_MS = 5_000;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "mcp-session-id"] as const;

/**
 * One process-local proxy keeps the mcp_ credential out of provider config,
 * rollout metadata and command lines. Its unguessable loopback URL dies with
 * the managed session.
 */
export class ScopedMcpProxy {
  private server: http.Server | null = null;
  private revoked = false;
  private readonly localPath = `/session/${randomUUID().replace(/-/g, "")}/mcp`;

  constructor(
    private endpoint: URL,
    private token: string,
    private readonly options: { revokeOnClose?: boolean; requiredTool?: string; onRequest?: () => void } = {},
  ) {
    this.validateCredential(endpoint, token);
  }

  private validateCredential(endpoint: URL, token: string): void {
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("远程 MCP endpoint 必须使用 http 或 https");
    }
    if (
      endpoint.protocol === "http:"
      && endpoint.hostname !== "127.0.0.1"
      && endpoint.hostname !== "localhost"
      && endpoint.hostname !== "::1"
    ) {
      throw new Error("远程 MCP 凭证只允许通过 HTTPS 传输");
    }
    if (!token.startsWith("mcp_")) throw new Error("远程 MCP 凭证无效");
  }

  async start(): Promise<string> {
    if (this.server) throw new Error("MCP credential proxy 已经启动");
    const server = http.createServer((request, response) => this.forward(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("MCP credential proxy 没有获得 loopback 端口");
    }
    const localUrl = `http://127.0.0.1:${address.port}${this.localPath}`;
    try {
      await this.assertUpstream(localUrl);
    } catch (error) {
      await this.close();
      throw new Error(`会话 MCP 不可达：${error instanceof Error ? error.message : String(error)}`);
    }
    return localUrl;
  }

  /** Keep a managed provider's configured loopback URL while the Head rotates authority. */
  async renew(endpoint: URL, token: string): Promise<void> {
    if (!this.server) throw new Error("MCP credential proxy 已关闭");
    this.validateCredential(endpoint, token);
    if (this.endpoint.href === endpoint.href && this.token === token) return;
    this.endpoint = endpoint;
    this.token = token;
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("MCP credential proxy 没有监听端口");
    await this.assertUpstream("http://127.0.0.1:" + address.port + this.localPath);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    await Promise.all([
      server ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve(),
      this.options.revokeOnClose === false ? Promise.resolve() : this.revoke(),
    ]);
  }

  private async assertUpstream(localUrl: string): Promise<void> {
    const response = await fetch(localUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "octopus-runner-probe",
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "octopus-runner", version: "1" } },
      }),
      signal: AbortSignal.timeout(UPSTREAM_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`initialize HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("result" in body)) throw new Error("initialize 响应无效");
    const result = body.result;
    if (!result || typeof result !== "object" || !("serverInfo" in result)) throw new Error("initialize 响应无效");
    const serverInfo = result.serverInfo;
    if (!serverInfo || typeof serverInfo !== "object" || !("name" in serverInfo) || serverInfo.name !== "octopus") {
      throw new Error("endpoint 不是 Octopus MCP");
    }
    const toolsResponse = await fetch(localUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "octopus-runner-tools-probe", method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(UPSTREAM_PROBE_TIMEOUT_MS),
    });
    if (!toolsResponse.ok) throw new Error(`tools/list HTTP ${toolsResponse.status}`);
    const toolsBody: unknown = await toolsResponse.json();
    if (!toolsBody || typeof toolsBody !== "object" || !("result" in toolsBody)) {
      throw new Error("tools/list 响应无效");
    }
    const toolsResult = toolsBody.result;
    if (!toolsResult || typeof toolsResult !== "object" || !("tools" in toolsResult) || !Array.isArray(toolsResult.tools)) {
      throw new Error("tools/list 响应无效");
    }
    // A session scope either runs commands or, for a read-only one (a Feishu
    // document assistant), only lists and reads its workspace: either tool
    // proves the bound execution scope answers. The Runner never needs to
    // know which; the Head decides what the scope may do.
    const accepted = this.options.requiredTool ? [this.options.requiredTool] : ["run_workspace_command", "list_session_workspaces"];
    const hasCommand = toolsResult.tools.some((tool) =>
      tool && typeof tool === "object" && "name" in tool && accepted.includes(String(tool.name)));
    if (!hasCommand) throw new Error(this.options.requiredTool ? "会话 MCP 缺少绑定工具" : "会话 MCP 缺少执行工具");
  }

  private forward(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (request.url !== this.localPath || !["GET", "POST", "DELETE"].includes(request.method ?? "")) {
      response.writeHead(404).end();
      return;
    }
    this.options.onRequest?.();
    if (request.method === "DELETE" && this.options.revokeOnClose === false) {
      response.writeHead(204).end();
      return;
    }
    const headers: IncomingHttpHeaders = {
      accept: request.headers.accept,
      "content-type": request.headers["content-type"],
      "mcp-session-id": request.headers["mcp-session-id"],
      authorization: `Bearer ${this.token}`,
    };
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    const transport = this.endpoint.protocol === "https:" ? https : http;
    let upstreamResponse: http.IncomingMessage | null = null;
    let tornDown = false;
    const upstream = transport.request({
      protocol: this.endpoint.protocol,
      hostname: this.endpoint.hostname,
      port: this.endpoint.port || undefined,
      method: request.method,
      path: `${this.endpoint.pathname}${this.endpoint.search}`,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    }, (nextUpstreamResponse) => {
      upstreamResponse = nextUpstreamResponse;
      nextUpstreamResponse.once("error", () => teardown(true));
      nextUpstreamResponse.once("aborted", () => teardown(true));
      if (tornDown || response.destroyed || response.writableEnded) {
        nextUpstreamResponse.destroy();
        return;
      }
      try {
        for (const name of FORWARDED_RESPONSE_HEADERS) {
          const value = nextUpstreamResponse.headers[name];
          if (value !== undefined) response.setHeader(name, value);
        }
        response.writeHead(nextUpstreamResponse.statusCode ?? 502);
        nextUpstreamResponse.pipe(response);
      } catch {
        teardown(true);
      }
    });

    const teardown = (destroyResponse: boolean): void => {
      if (tornDown) return;
      tornDown = true;
      if (upstreamResponse && !upstreamResponse.destroyed) upstreamResponse.destroy();
      if (!upstream.destroyed) upstream.destroy();
      if (destroyResponse && !response.destroyed) response.destroy();
    };
    const failUpstream = (): void => {
      if (tornDown) return;
      if (response.destroyed || response.writableEnded || response.headersSent) {
        teardown(true);
        return;
      }
      tornDown = true;
      if (upstreamResponse && !upstreamResponse.destroyed) upstreamResponse.destroy();
      if (!upstream.destroyed) upstream.destroy();
      try {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        response.end("MCP upstream unavailable");
      } catch {
        if (!response.destroyed) response.destroy();
      }
    };

    upstream.once("timeout", () => upstream.destroy(new Error("MCP upstream timed out")));
    upstream.once("error", failUpstream);
    request.once("error", () => teardown(true));
    request.once("aborted", () => teardown(true));
    response.once("error", () => teardown(true));
    response.once("close", () => teardown(false));
    request.pipe(upstream);
  }

  /** Revoke the upstream scope when the managed turn releases this proxy. */
  private async revoke(): Promise<void> {
    if (this.revoked) return;
    this.revoked = true;
    const transport = this.endpoint.protocol === "https:" ? https : http;
    await new Promise<void>((resolve) => {
      const request = transport.request({
        protocol: this.endpoint.protocol,
        hostname: this.endpoint.hostname,
        port: this.endpoint.port || undefined,
        method: "DELETE",
        path: `${this.endpoint.pathname}${this.endpoint.search}`,
        headers: { authorization: `Bearer ${this.token}` },
        timeout: 5_000,
      }, (response) => {
        response.resume();
        response.once("end", resolve);
      });
      request.once("timeout", () => request.destroy());
      request.once("error", () => resolve());
      request.end();
    });
  }
}
