/**
 * The execution backend behind the Feishu Gateway — the existing
 * `@larksuiteoapi/lark-mcp` server, reused, but started HERE.
 *
 * The change SEC-03 makes is not what runs the API call; it is who starts it
 * and what holds the credential. Before, the agent's own subprocess tree
 * contained a lark-mcp child launched with the app id, the app secret and the
 * user's access token on its command line — so "does this agent act as the
 * user?" was decided by whether a token happened to be available, and a missing
 * token silently produced a process with tenant-level authority instead.
 *
 * Now the child lives in the bot process, one per credential, outside every
 * agent's process tree, and is reachable only from the Object adapter. The
 * agent's environment contains a loopback URL and a per-turn token that
 * resolves to a bound capability facade — no UAT, no refresh token, no app
 * secret, no tenant token.
 *
 * The child still necessarily HOLDS a user token: something has to call the
 * Feishu API as the user. What `childEnv()` below bounds is how much else it
 * holds and who else can read it — a short allow-list instead of the bot's
 * whole environment, credentials in the environment instead of on a
 * world-readable command line, and the token mode pinned so the downstream
 * server has no `auto` branch that could reach for the tenant token.
 *
 * The downstream server is an EXECUTOR, not an authorizer. If it exposes tools
 * the catalog does not list, or reinterprets arguments, it changes nothing:
 * `call()` only ever sends a tool name the catalog produced.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import { createRequire } from "node:module";
import { createLogger } from "../logger.js";
import { FEISHU_FILE_MAX_BYTES } from "./catalog.js";
import { LARK_CLI_TOOL, type LarkCliExecutor, type LarkCliRequest } from "./lark-cli.js";

const log = createLogger("feishu-backend");

export interface FeishuCall {
  tool: string;
  payload: Record<string, unknown>;
  /** Chosen by the resolver. The backend never picks a credential. */
  credential: { mode: "user_oauth"; token: string } | { mode: "service_account" };
}

export interface FeishuToolBackend {
  call(c: FeishuCall): Promise<unknown>;
  /** Names the downstream server actually offers — for the startup audit. */
  listTools(): Promise<string[]>;
  stop(): void;
}

/** How long an idle downstream child is kept before it is reaped. */
const IDLE_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Child {
  retain: boolean;
  proc: ChildProcess;
  reader: Interface;
  pending: Map<number, Pending>;
  nextId: number;
  ready: Promise<void>;
  lastUsed: number;
}

export interface LarkMcpOptions {
  appId: string;
  appSecret: string;
  /** Resolved from the workspace by default. */
  cliPath?: string;
  /** The `-t` preset list handed to lark-mcp. */
  tools?: string;
  idleMs?: number;
  /** Injectable for tests. */
  spawnFn?: typeof spawn;
  /** Injectable transport for the built-in upload/send operation. */
  fetchFn?: typeof fetch;
  /** The lark-cli executor; absent or failing its self-test, its operations are not offered. */
  larkCli?: Pick<LarkCliExecutor, "available" | "run">;
}

export const FEISHU_DIRECT_FILE_TOOL = "octopus_im_file_send";
const FEISHU_API = "https://open.feishu.cn/open-apis";
/** Feishu's own ceiling for `im/v1/files`: 30 MB, and no empty files. */
const MAX_FILE_BYTES = FEISHU_FILE_MAX_BYTES;

/** Exact reviewed backend surface. Presets drift across lark-mcp releases. */
const DEFAULT_TOOLS = [
  "im.v1.message.create", "im.v1.message.list", "im.v1.chat.create", "im.v1.chat.list",
  "im.v1.chatMembers.get", "im.v1.chatMembers.create", "im.v1.chatMembers.delete",
  "docx.v1.document.rawContent", "docx.builtin.import", "docx.builtin.search",
  "docx.v1.document.get", "docx.v1.documentBlock.list", "docx.v1.documentBlock.get", "docx.v1.documentBlock.patch",
  "drive.v1.permissionMember.create",
  "bitable.v1.app.create", "bitable.v1.appTable.create", "bitable.v1.appTable.list",
  "bitable.v1.appTableField.list", "bitable.v1.appTableRecord.search",
  "bitable.v1.appTableRecord.create", "bitable.v1.appTableRecord.update",
  "calendar.v4.calendarEvent.create", "calendar.v4.calendarEvent.patch", "calendar.v4.calendarEvent.get",
  "calendar.v4.calendarEvent.list", "calendar.v4.calendarEvent.delete", "calendar.v4.calendarEvent.search",
  "calendar.v4.freebusy.list", "calendar.v4.calendar.primary",
  "task.v2.task.create", "task.v2.task.get", "task.v2.task.list", "task.v2.task.patch",
  "task.v2.task.delete", "task.v2.task.addMembers", "task.v2.task.addReminders", "task.v2.task.addTasklist",
  "wiki.v2.space.getNode", "wiki.v2.space.list", "wiki.v2.spaceNode.list", "wiki.v1.node.search",
  "contact.v3.user.batchGetId",
].join(",");

/**
 * What the downstream child gets to see. Everything, minus everything.
 *
 * Two separate reasons to build this by hand rather than spreading
 * `process.env`:
 *
 *  · the bot's environment holds the Anthropic and OpenAI keys, the data
 *    directory and whatever else the deployment exports. The Feishu executor
 *    needs none of it, and a subprocess that cannot read a secret cannot leak
 *    one. The allow-list is short enough to read: how to run node, where the
 *    CA bundle is, and how to reach the network through a proxy.
 *  · the credentials go in the ENVIRONMENT rather than on `argv`. On Linux
 *    `/proc/<pid>/cmdline` is world-readable and `/proc/<pid>/environ` is not
 *    — so the app secret and the user's access token stop being visible to
 *    every account on the host. lark-mcp reads `APP_ID`/`APP_SECRET`/
 *    `USER_ACCESS_TOKEN`/`LARK_TOKEN_MODE` itself, so this is its own
 *    interface, not a trick.
 *
 * `LARK_TOKEN_MODE` is the part that matters most. Its default is `auto`,
 * which means the downstream server decides between the user's token and the
 * TENANT token by looking at a `useUAT` flag in the arguments — i.e. exactly
 * the silent identity downgrade SEC-03 exists to remove, one layer below where
 * we removed it. Pinning the mode per child makes the fallback unexpressible:
 * the user child can only ever use the user's token, and the service child
 * never reads one.
 */
export function childEnv(
  opts: Pick<LarkMcpOptions, "appId" | "appSecret">,
  credential: FeishuCall["credential"],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: process.env.LANG,
    TZ: process.env.TZ,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy,
    HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy,
    NO_PROXY: process.env.NO_PROXY ?? process.env.no_proxy,
    APP_ID: opts.appId,
    APP_SECRET: opts.appSecret,
  };
  if (credential.mode === "user_oauth") {
    env.USER_ACCESS_TOKEN = credential.token;
    env.LARK_TOKEN_MODE = "user_access_token";
  } else {
    env.LARK_TOKEN_MODE = "tenant_access_token";
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

export class LarkMcpBackend implements FeishuToolBackend {
  private children = new Map<string, Child>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private opts: LarkMcpOptions) {}

  /**
   * One child per credential.
   *
   * Keyed by a HASH of the token, never the token: this map is the kind of
   * thing that ends up in a heap dump or a log line, and a key that is itself
   * the secret makes both of those a credential leak.
   */
  private keyOf(c: FeishuCall["credential"]): string {
    return c.mode === "service_account"
      ? "service"
      : `user:${createHash("sha256").update(c.token).digest("hex").slice(0, 16)}`;
  }

  private cliPath(): string {
    if (this.opts.cliPath) return this.opts.cliPath;
    return createRequire(import.meta.url).resolve("@larksuiteoapi/lark-mcp/dist/cli.js");
  }

  private ensure(c: FeishuCall["credential"], retain = true): Child {
    const key = this.keyOf(c);
    const hit = this.children.get(key);
    if (hit && !hit.proc.killed) {
      hit.retain ||= retain;
      hit.lastUsed = Date.now();
      return hit;
    }
    const args = [this.cliPath(), "mcp", "-t", this.opts.tools ?? DEFAULT_TOOLS];
    const proc = (this.opts.spawnFn ?? spawn)(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv(this.opts, c),
    });
    const child: Child = {
      retain,
      proc,
      reader: createInterface({ input: proc.stdout! }),
      pending: new Map(),
      nextId: 1,
      lastUsed: Date.now(),
      ready: Promise.resolve(),
    };
    child.reader.on("line", (line) => this.onLine(child, line));
    // A pipe with no `error` handler takes the whole process down when the
    // child dies mid-write. It has happened here before.
    proc.on("error", (err) => this.failAll(key, child, err));
    proc.stdin?.on("error", (err) => this.failAll(key, child, err));
    proc.on("exit", (code) => this.failAll(key, child, new Error(`lark-mcp exited (${code})`)));
    proc.stderr?.on("data", (b: Buffer) => log.debug({ line: String(b).slice(0, 400) }, "lark-mcp stderr"));
    child.ready = this.handshake(child);
    this.children.set(key, child);
    this.startSweeper();
    return child;
  }

  private failAll(key: string, child: Child, err: Error): void {
    for (const p of child.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    child.pending.clear();
    if (this.children.get(key) === child) this.children.delete(key);
  }

  private onLine(child: Child, line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = child.pending.get(msg.id);
    if (!p) return;
    child.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? "lark-mcp error"));
    else p.resolve(msg.result);
  }

  private send(child: Child, method: string, params: unknown): Promise<unknown> {
    const id = child.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.pending.delete(id);
        reject(new Error(`飞书后端超时（${method}）`));
      }, CALL_TIMEOUT_MS);
      child.pending.set(id, { resolve, reject, timer });
      try {
        child.proc.stdin!.write(body);
      } catch (err) {
        child.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  private async handshake(child: Child): Promise<void> {
    await this.send(child, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "octopus-feishu-gateway", version: "1" },
    });
    try {
      child.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    } catch {
      /* the exit handler will fail the pending calls */
    }
  }

  async call(c: FeishuCall): Promise<unknown> {
    if (c.tool === FEISHU_DIRECT_FILE_TOOL) return await this.sendFile(c);
    if (c.tool === LARK_CLI_TOOL) {
      if (!this.opts.larkCli) throw new Error("这台服务器没有组合 lark-cli");
      if (c.credential.mode !== "user_oauth") throw new Error("lark-cli 只以用户自己的 OAuth 身份运行");
      // The payload is the catalog's parsed request, built by trusted code in the adapter.
      return await this.opts.larkCli.run(c.payload as unknown as LarkCliRequest, c.credential.token);
    }
    const child = this.ensure(c.credential);
    await child.ready;
    return await this.send(child, "tools/call", { name: c.tool, arguments: c.payload });
  }

  async listTools(): Promise<string[]> {
    const larkCli = this.opts.larkCli ? this.opts.larkCli.available() : Promise.resolve(false);
    const child = this.ensure({ mode: "service_account" }, false);
    try {
      await child.ready;
      const out = (await this.send(child, "tools/list", {})) as { tools?: Array<{ name?: string }> } | null;
      return [
        ...(out?.tools ?? []).map((t) => String(t.name ?? "")).filter(Boolean),
        FEISHU_DIRECT_FILE_TOOL,
        ...(await larkCli ? [LARK_CLI_TOOL] : []),
      ];
    } finally {
      // The startup audit needs names, not a ten-minute, >1 GiB resident
      // executor. A real call can adopt this child before the audit finishes.
      if (!child.retain && child.pending.size === 0 && this.children.get("service") === child) {
        this.children.delete("service");
        child.reader.close();
        child.proc.kill();
      }
    }
  }

  private async sendFile(c: FeishuCall): Promise<unknown> {
    if (c.credential.mode !== "service_account") throw new Error("飞书文件发送只允许已审计的系统 Bot 操作");
    const fileName = String(c.payload.file_name ?? "").trim();
    const fileType = String(c.payload.file_type ?? "").trim();
    const targetId = String(c.payload.target_id ?? "").trim();
    const targetKind = String(c.payload.target_kind ?? "");
    // Inline base64, or bytes the gateway already read and checked for a by-reference send.
    let bytes: Buffer;
    if (Buffer.isBuffer(c.payload.file_bytes)) {
      bytes = c.payload.file_bytes;
    } else {
      const encoded = String(c.payload.file_base64 ?? "").replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("飞书文件参数无效");
      bytes = Buffer.from(encoded, "base64");
    }
    if (!fileName || !targetId) throw new Error("飞书文件参数无效");
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error("飞书只接收 1 字节到 30 MB 的文件（im/v1/files 的上限）");
    const appToken = await this.appAccessToken();
    const form = new FormData();
    form.set("file_type", fileType);
    form.set("file_name", fileName);
    form.set("file", new Blob([new Uint8Array(bytes)]), fileName);
    const fetcher = this.opts.fetchFn ?? fetch;
    const upload = await fetcher(`${FEISHU_API}/im/v1/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${appToken}` },
      body: form,
    });
    const uploaded = await feishuJson(upload, "上传文件");
    const fileKey = String((uploaded.data as Record<string, unknown> | undefined)?.file_key ?? "");
    if (!fileKey) throw new Error("飞书上传文件成功响应缺少 file_key");
    const sent = await fetcher(`${FEISHU_API}/im/v1/messages?receive_id_type=${targetKind === "people" ? "open_id" : "chat_id"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ receive_id: targetId, msg_type: "file", content: JSON.stringify({ file_key: fileKey }) }),
    });
    return await feishuJson(sent, "发送文件消息");
  }

  private async appAccessToken(): Promise<string> {
    const fetcher = this.opts.fetchFn ?? fetch;
    const response = await fetcher(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }),
    });
    const body = await feishuJson(response, "取得应用访问令牌");
    const token = String(body.tenant_access_token ?? "");
    if (!token) throw new Error("飞书应用访问令牌响应无 token");
    return token;
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - (this.opts.idleMs ?? IDLE_MS);
      for (const [key, child] of this.children) {
        if (child.lastUsed > cutoff || child.pending.size) continue;
        this.children.delete(key);
        child.reader.close();
        child.proc.kill();
      }
    }, 60_000);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const [key, child] of this.children) {
      child.reader.close();
      child.proc.kill();
      this.failAll(key, child, new Error("backend stopped"));
    }
    this.children.clear();
  }
}

async function feishuJson(response: Response, action: string): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok || Number(body.code ?? 0) !== 0) {
    throw new Error(`${action}失败：${String(body.msg ?? response.status)}`.slice(0, 300));
  }
  return body;
}
