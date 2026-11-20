/**
 * SEC-03 — the downstream lark-mcp child is a trusted gateway backend, and the
 * two things that make that claim survivable are what it is given and what it
 * is allowed to decide.
 *
 * It necessarily holds a user access token: something has to call the Feishu
 * API as the user. What must NOT be true is that it also holds the bot's other
 * secrets, that any account on the host can read the token, or that it retains
 * a branch which answers "this call cannot use the user's identity" with the
 * tenant's.
 */

import { describe, expect, it, vi } from "vitest";
import { childEnv, FEISHU_DIRECT_FILE_TOOL, LarkMcpBackend } from "./backend.js";
import { LARK_CLI_TOOL } from "./lark-cli.js";

const opts = { appId: "cli_app", appSecret: "s3cret" };

describe("SEC-03 · what the downstream Feishu executor is given", () => {
  it("carries the credentials in the environment, not on a world-readable argv", () => {
    const env = childEnv(opts, { mode: "user_oauth", token: "uat-alice" });
    expect(env.APP_ID).toBe("cli_app");
    expect(env.APP_SECRET).toBe("s3cret");
    expect(env.USER_ACCESS_TOKEN).toBe("uat-alice");
  });

  it("pins the token mode per credential, so `auto` can never reach for the tenant token", () => {
    expect(childEnv(opts, { mode: "user_oauth", token: "t" }).LARK_TOKEN_MODE).toBe("user_access_token");
    const service = childEnv(opts, { mode: "service_account" });
    expect(service.LARK_TOKEN_MODE).toBe("tenant_access_token");
    // And the service child is never handed a user's token to fall back to.
    expect(service.USER_ACCESS_TOKEN).toBeUndefined();
  });

  it("is a short allow-list, not the bot's environment", () => {
    const before = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-travel";
    process.env.OPENAI_API_KEY = "sk-oai-should-not-travel";
    process.env.DATA_DIR = "/srv/octopus/data";
    try {
      const env = childEnv(opts, { mode: "user_oauth", token: "uat-alice" });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.DATA_DIR).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain("should-not-travel");
      // Everything present is either how to run, or the Feishu credential.
      const allowed = new Set([
        "PATH",
        "HOME",
        "LANG",
        "TZ",
        "NODE_EXTRA_CA_CERTS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "APP_ID",
        "APP_SECRET",
        "USER_ACCESS_TOKEN",
        "LARK_TOKEN_MODE",
      ]);
      for (const key of Object.keys(env)) expect(allowed.has(key)).toBe(true);
    } finally {
      process.env = before;
    }
  });

  it("drops absent optionals rather than passing empty strings", () => {
    const before = { ...process.env };
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.NODE_EXTRA_CA_CERTS;
    try {
      const env = childEnv(opts, { mode: "service_account" });
      expect("HTTP_PROXY" in env).toBe(false);
      expect("NODE_EXTRA_CA_CERTS" in env).toBe(false);
      expect(env.PATH).toBeTruthy();
    } finally {
      process.env = before;
    }
  });
});

describe("the built-in Feishu file sender", () => {
  it("uploads bounded bytes then sends only the returned file key", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant" }), { status: 200 });
      }
      if (url.endsWith("/im/v1/files")) {
        return new Response(JSON.stringify({ code: 0, data: { file_key: "file_1" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "m1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const backend = new LarkMcpBackend({ ...opts, fetchFn });
    await backend.call({
      tool: FEISHU_DIRECT_FILE_TOOL,
      credential: { mode: "service_account" },
      payload: {
        target_kind: "chats", target_id: "oc_1", file_name: "material.txt", file_type: "stream",
        file_base64: Buffer.from("material").toString("base64"),
      },
    });
    expect(requests.map((request) => request.url)).toEqual([
      expect.stringContaining("tenant_access_token"),
      expect.stringContaining("/im/v1/files"),
      expect.stringContaining("receive_id_type=chat_id"),
    ]);
    expect(String(requests[2].init?.body)).toContain("file_1");
    expect(String(requests[2].init?.body)).not.toContain("material");
  });

  it("uploads the bytes of a by-reference file the gateway already read and checked", async () => {
    let uploaded: Blob | null = null;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("tenant_access_token")) return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant" }), { status: 200 });
      if (url.endsWith("/im/v1/files")) {
        uploaded = (init?.body as FormData).get("file") as Blob;
        return new Response(JSON.stringify({ code: 0, data: { file_key: "file_5m" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "m1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const bytes = Buffer.alloc(5 * 1024 * 1024, 3);
    await new LarkMcpBackend({ ...opts, fetchFn }).call({
      tool: FEISHU_DIRECT_FILE_TOOL,
      credential: { mode: "service_account" },
      payload: { target_kind: "people", target_id: "ou_1", file_name: "five.bin", file_type: "stream", file_bytes: bytes },
    });
    expect(uploaded).not.toBeNull();
    expect(Buffer.from(await uploaded!.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("refuses user tokens and oversized payloads before network access", async () => {
    const fetchFn = vi.fn();
    const backend = new LarkMcpBackend({ ...opts, fetchFn: fetchFn as unknown as typeof fetch });
    await expect(backend.call({
      tool: FEISHU_DIRECT_FILE_TOOL,
      credential: { mode: "user_oauth", token: "uat" },
      payload: {},
    })).rejects.toThrow(/系统 Bot/);
    await expect(backend.call({
      tool: FEISHU_DIRECT_FILE_TOOL,
      credential: { mode: "service_account" },
      payload: {
        target_kind: "people", target_id: "ou_1", file_name: "big.bin", file_type: "stream",
        file_base64: Buffer.alloc(30 * 1024 * 1024 + 1).toString("base64"),
      },
    })).rejects.toThrow(/30 MB/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

/** Exercise actual stdio framing without launching the large vendor catalog. */
describe("catalog-only child lifetime", () => {
  async function fixture() {
    const { EventEmitter } = await import("node:events");
    const { PassThrough, Writable } = await import("node:stream");
    const children: Array<{ proc: import("node:child_process").ChildProcess; respond: (id: number, result: unknown) => void; requests: Array<{ id: number; method: string }> }> = [];
    const spawnFn = vi.fn(() => {
      const proc = new EventEmitter() as import("node:child_process").ChildProcess;
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
      const requests: Array<{ id: number; method: string }> = [];
      const respond = (id: number, result: unknown) => (proc.stdout as InstanceType<typeof PassThrough>).write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      proc.stdin = new Writable({ write(chunk, _encoding, done) {
        const request = JSON.parse(String(chunk));
        if (request.id) requests.push(request);
        if (request.method === "initialize") queueMicrotask(() => respond(request.id, {}));
        done();
      } });
      proc.kill = vi.fn(() => true);
      children.push({ proc, respond, requests }); return proc;
    }) as unknown as typeof import("node:child_process").spawn;
    return { children, backend: new LarkMcpBackend({ ...opts, cliPath: "/fixture/lark.js", spawnFn }), spawnFn };
  }

  it("reaps an audit-only child as soon as its tool names have been checked", async () => {
    const { backend, children } = await fixture();
    try {
      const listing = backend.listTools();
      await vi.waitFor(() => expect(children[0].requests.some(r => r.method === "tools/list")).toBe(true));
      const child = children[0]; child.respond(child.requests.find(r => r.method === "tools/list")!.id, { tools: [{ name: "tool" }] });
      expect(await listing).toContain("tool");
      expect(child.proc.kill).toHaveBeenCalledTimes(1);
    } finally { backend.stop(); }
  });

  it("does not reap a child adopted by a real call while the audit is in flight", async () => {
    const { backend, children } = await fixture();
    try {
      const listing = backend.listTools();
      await vi.waitFor(() => expect(children[0].requests.some(r => r.method === "tools/list")).toBe(true));
      const call = backend.call({ tool: "tool", credential: { mode: "service_account" }, payload: {} });
      const child = children[0]; child.respond(child.requests.find(r => r.method === "tools/list")!.id, { tools: [] });
      await listing;
      expect(child.proc.kill).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(child.requests.some(r => r.method === "tools/call")).toBe(true));
      child.respond(child.requests.find(r => r.method === "tools/call")!.id, { ok: true });
      expect(await call).toEqual({ ok: true });
    } finally { backend.stop(); }
  });
});

describe("lark-cli as a gateway backend tool", () => {
  const listed = async (larkCli: { available: () => Promise<boolean>; run: () => Promise<{ exit_code: number }> }) => {
    const { EventEmitter } = await import("node:events");
    const { PassThrough, Writable } = await import("node:stream");
    const spawnFn = vi.fn(() => {
      const proc = new EventEmitter() as import("node:child_process").ChildProcess;
      const stdout = new PassThrough();
      proc.stdout = stdout; proc.stderr = new PassThrough();
      proc.stdin = new Writable({ write(chunk, _encoding, done) {
        const request = JSON.parse(String(chunk));
        if (request.id) queueMicrotask(() => stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "tools/list" ? { tools: [{ name: "docx_v1_document_get" }] } : {} }) + "\n"));
        done();
      } });
      proc.kill = vi.fn(() => true);
      return proc;
    }) as unknown as typeof import("node:child_process").spawn;
    const backend = new LarkMcpBackend({ ...opts, cliPath: "/fixture/lark.js", spawnFn, larkCli });
    try { return { tools: await backend.listTools(), backend }; } finally { backend.stop(); }
  };

  it("is offered only when its executor passed the self-test", async () => {
    expect((await listed({ available: async () => true, run: async () => ({ exit_code: 0 }) })).tools).toContain(LARK_CLI_TOOL);
    expect((await listed({ available: async () => false, run: async () => ({ exit_code: 0 }) })).tools).not.toContain(LARK_CLI_TOOL);
  });

  it("runs with the user's token and refuses the tenant identity", async () => {
    const run = vi.fn(async () => ({ exit_code: 0 }));
    const backend = new LarkMcpBackend({ ...opts, larkCli: { available: async () => true, run } });
    const request = { mode: "read", argv: ["slides", "+xml-get"], files: [] };
    expect(await backend.call({ tool: LARK_CLI_TOOL, payload: request, credential: { mode: "user_oauth", token: "uat-alice" } }))
      .toEqual({ exit_code: 0 });
    expect(run).toHaveBeenCalledWith(request, "uat-alice");
    await expect(backend.call({ tool: LARK_CLI_TOOL, payload: request, credential: { mode: "service_account" } }))
      .rejects.toThrow(/OAuth/);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
