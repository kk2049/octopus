/**
 * The MCP surface over real HTTP: token lifecycle, the mcp_ identity's hard
 * boundary (one route, no login, no approval), and the endpoint's JSON-RPC
 * behaviour including permission-filtered tools/list and owner-scoped session
 * reads against a real on-disk scan fixture.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { hashRunnerToken } from "../runner/gateway.js";
import { mcpTicketDevelopmentPolicy, mintMcpToken } from "../mcp/tokens.js";
import { MCP_REQUEST_MAX_BYTES } from "../mcp/tools.js";
import { FeishuOAuthPortal } from "../feishu/oauth-portal.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";

const NOW = "2026-08-10T00:00:00.000Z";
const SESSION_ID = "ab12cd34-1111-2222-3333-444455556666";
const ADMIN = "admin-secret";

describe("dashboard MCP surface", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let base: string;
  let dtAlice: string;
  let mcpAlice = "";
  let mcpAliceHash = "";
  let feishuOAuth: FeishuOAuthPortal;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dashmcp-"));
    const home = join(dir, "alice-home");
    const proj = join(home, ".claude", "projects", "-work-proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, `${SESSION_ID}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          sessionId: SESSION_ID,
          cwd: "/work/proj",
          timestamp: "2026-08-10T09:00:00.000Z",
          message: { role: "user", content: "查一下部署状态" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-10T09:00:05.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "部署一切正常" }] },
        }),
      ].join("\n"),
    );

    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/b", created_at: NOW });
    dtAlice = mintDashboardToken(store, "alice");
    feishuOAuth = new FeishuOAuthPortal({
      startDeviceAuth: async () => ({
        device_code: "device", user_code: "ABCD", verification_uri: "https://accounts.example/device",
        verification_uri_complete: "https://accounts.example/device?code=ABCD", expires_in: 300, interval: 5,
      }),
      pollForToken: () => new Promise(() => undefined),
    } as never, {
      getFeishuToken: () => undefined,
      saveFeishuToken: async () => undefined,
    });
    dash = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN,
      runnerWsPort: 9910,
      scanHomeFor: (u) => (u === "alice" ? home : undefined),
      feishuOAuth,
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterAll(async () => {
    await dash.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rpc = async (token: string, message: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };

  it("minting needs an owner credential: the shared admin key cannot sign as alice", async () => {
    const res = await fetch(`${base}/api/mcp/tokens/create`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", label: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("authenticates an internal development token without granting panel or unbound tool authority", async () => {
    // Keep this token outside alice's independent token-list lifecycle fixture.
    const issued = mintMcpToken(store, {
      username: "bob", label: "ticket turn", ttlMs: 60_000,
      policy: mcpTicketDevelopmentPolicy({ ticketId: 578, turn: 4, developmentId: "development_578" }),
    });
    try {
      const listed = await rpc(issued.token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(listed.status).toBe(200);
      expect(listed.body.result.tools).toEqual([]);
      const called = await rpc(issued.token, {
        jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "devpipe_submit", arguments: {} },
      });
      expect(called.body.result.isError).toBe(true);
      expect((await fetch(base + "/api/sessions", { headers: { authorization: "Bearer " + issued.token } })).status).toBe(403);
      expect((await fetch(base + "/api/mcp", { method: "DELETE", headers: { authorization: "Bearer " + issued.token } })).status).toBe(204);
    } finally {
      // No live registry owns this deliberately unbound token; revoke the fixture
      // row even when an assertion fails. Token history is intentionally retained.
      store.revokeMcpToken("bob", issued.row.token_hash, new Date().toISOString());
    }
  });

  it("starts Feishu device OAuth only for the account owner", async () => {
    const bearerStatus = await fetch(`${base}/api/feishu/oauth/status?username=alice`, {
      headers: { authorization: `Bearer ${dtAlice}` },
    });
    expect(bearerStatus.status).toBe(403);

    const login = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ token: dtAlice }),
    });
    const setCookies = login.headers.getSetCookie();
    const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
    const csrf = /octopus_csrf=([0-9a-f]{64})/.exec(setCookies.join(";"))?.[1] ?? "";
    const status = await fetch(`${base}/api/feishu/oauth/status?username=alice`, { headers: { cookie } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ available: true, state: "disconnected" });

    const forged = await fetch(`${base}/api/feishu/oauth/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    expect(forged.status).toBe(403);

    const started = await fetch(`${base}/api/feishu/oauth/start`, {
      method: "POST",
      headers: { cookie, origin: base, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      available: true,
      state: "pending",
      userCode: "ABCD",
      verificationUri: "https://accounts.example/device?code=ABCD",
    });

    await feishuOAuth.requireReconnect("alice", "doc_read", "用户授权已过期");
    const queue = await fetch(`${base}/api/capabilities/pending`, { headers: { cookie } });
    expect(await queue.json()).toMatchObject({
      pending: [],
      notices: [{
        kind: "feishu_reauth",
        url: "https://accounts.example/device?code=ABCD",
        detail: expect.stringContaining("doc_read"),
      }],
    });
  });

  it("the owner mints a token; the plaintext appears once and only the hash is stored", async () => {
    const res = await fetch(`${base}/api/mcp/tokens/create`, {
      method: "POST",
      headers: { authorization: `Bearer ${dtAlice}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "test agent" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      token_hash: string;
      registration: { endpoint: string; command: string };
    };
    expect(body.token).toMatch(/^mcp_[0-9a-f]{32}$/);
    expect(body.token_hash).toBe(hashRunnerToken(body.token));
    expect(body.registration.endpoint).toContain("/api/mcp");
    expect(body.registration.command).toContain("claude mcp add");
    mcpAlice = body.token;
    mcpAliceHash = body.token_hash;

    const list = await fetch(`${base}/api/mcp/tokens`, { headers: { authorization: `Bearer ${dtAlice}` } });
    const rows = ((await list.json()) as { tokens: Array<{ token_hash: string; label: string; active: boolean }> })
      .tokens;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token_hash: mcpAliceHash, label: "test agent", active: true });
    expect(JSON.stringify(rows)).not.toContain(mcpAlice);
  });

  it("initialize answers as a stateless streamable-http server; GET is 405", async () => {
    const init = await rpc(mcpAlice, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("octopus");
    const note = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpAlice}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);
    const get = await fetch(`${base}/api/mcp`, { headers: { authorization: `Bearer ${mcpAlice}` } });
    expect(get.status).toBe(405);
  });

  it("takes one JSON-RPC message as large as the declared MCP request window, and no larger", async () => {
    // Past the panel's 1 MB default, inside the window: answered as JSON-RPC, not refused as a body.
    const inside = await rpc(mcpAlice, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "no_such_tool", arguments: { data: "x".repeat(4_000_000) } } });
    expect(inside.status).toBe(200);
    expect(inside.body.id).toBe(9);
    const over = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpAlice}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "ping", params: { pad: "x".repeat(MCP_REQUEST_MAX_BYTES) } }),
    });
    expect(over.status).toBe(413);
  });

  it("tools/list is the owner's effective permissions: session tools only on this composition", async () => {
    const out = await rpc(mcpAlice, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (out.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(["list_recent_sessions", "search_sessions", "read_session"]);
    // No workspace plane and no document store were composed, so those tools
    // do not exist rather than being listed-and-refused.
    expect(names).not.toContain("list_session_workspaces");
    expect(names).not.toContain("crdt_open_doc");
  });

  it("the session tools reach the owner's fixture and stay inside the owner", async () => {
    const listed = await rpc(mcpAlice, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_recent_sessions", arguments: {} },
    });
    const roster = listed.body.result.structuredContent as {
      sessions: Array<{ resource_id: string; session_id: string }>;
    };
    expect(roster.sessions.some((s) => s.session_id === SESSION_ID)).toBe(true);
    const resourceId = roster.sessions.find((s) => s.session_id === SESSION_ID)!.resource_id;

    const searched = await rpc(mcpAlice, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "search_sessions", arguments: { query: "部署" } },
    });
    expect(searched.body.result.isError).toBeUndefined();
    expect(JSON.stringify(searched.body.result.structuredContent)).toContain(SESSION_ID);

    const read = await rpc(mcpAlice, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "read_session", arguments: { resource_id: resourceId } },
    });
    expect(read.body.result.isError).toBeUndefined();
    expect(JSON.stringify(read.body.result.structuredContent)).toContain("部署一切正常");

    // A handle for somebody else's account: refused, with no session material.
    const foreign = Buffer.from(JSON.stringify(["bob", "mac", "claude", "s1"])).toString("base64url");
    const stolen = await rpc(mcpAlice, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "read_session", arguments: { resource_id: foreign } },
    });
    expect(stolen.body.result.isError).toBe(true);
    expect(stolen.body.result.content[0].text).toContain("forbidden");
  });

  it("an mcp_ token is pinned to /api/mcp: every other route answers 403, login refuses it, approval is unreachable", async () => {
    const sessions = await fetch(`${base}/api/sessions`, { headers: { authorization: `Bearer ${mcpAlice}` } });
    expect(sessions.status).toBe(403);
    expect(((await sessions.json()) as { error: string }).error).toContain("/api/mcp");

    const tokens = await fetch(`${base}/api/mcp/tokens`, { headers: { authorization: `Bearer ${mcpAlice}` } });
    expect(tokens.status).toBe(403);

    const mint = await fetch(`${base}/api/mcp/tokens/create`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpAlice}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "self-replicate" }),
    });
    expect(mint.status).toBe(403);

    const decide = await fetch(`${base}/api/capabilities/pending/pc_1/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpAlice}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(decide.status).toBe(403);

    const login = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ token: mcpAlice }),
    });
    expect(login.status).toBe(403);
    expect(login.headers.get("set-cookie")).toBeNull();
  });

  it("an admin account's mcp_ token carries no admin capability", async () => {
    // bob is promoted to admin via config-equivalent grants; even then his MCP
    // token must not read across accounts or reach admin routes.
    const dtBob = mintDashboardToken(store, "bob");
    const minted = await fetch(`${base}/api/mcp/tokens/create`, {
      method: "POST",
      headers: { authorization: `Bearer ${dtBob}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "bob agent" }),
    });
    const bobToken = ((await minted.json()) as { token: string }).token;
    const admin = await fetch(`${base}/api/admin/users`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(admin.status).toBe(403);
    // And bob's MCP roster is bob's: alice's fixture session is not in it.
    const listed = await rpc(bobToken, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "list_recent_sessions", arguments: {} },
    });
    const text = JSON.stringify(listed.body.result);
    expect(text).not.toContain(SESSION_ID);
  });

  it("ttl and revocation both end the credential; revocation is owner-scoped", async () => {
    // Somebody else cannot revoke alice's token, even the admin key.
    const foreign = await fetch(`${base}/api/mcp/tokens/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", token_hash: mcpAliceHash }),
    });
    expect(foreign.status).toBe(403);

    const revoked = await fetch(`${base}/api/mcp/tokens/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${dtAlice}`, "content-type": "application/json" },
      body: JSON.stringify({ token_hash: mcpAliceHash }),
    });
    expect(((await revoked.json()) as { changed: boolean }).changed).toBe(true);
    const after = await rpc(mcpAlice, { jsonrpc: "2.0", id: 7, method: "ping" });
    expect(after.status).toBe(401);

    // An expired row is the same absence as a revoked one.
    const expired = "mcp_" + "e".repeat(32);
    store.saveMcpToken({
      token_hash: hashRunnerToken(expired),
      username: "alice",
      label: "expired",
      created_at: NOW,
      expires_at: "2026-08-01T00:00:00.000Z",
      last_used_at: null,
      revoked_at: null,
      policy_json: null,
    });
    const stale = await rpc(expired, { jsonrpc: "2.0", id: 8, method: "ping" });
    expect(stale.status).toBe(401);
  });
});
