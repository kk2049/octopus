/**
 * Machines MCP server — the user's own machines and their central memory,
 * exposed to their ordinary private chat with the bot.
 *
 * Two halves, with deliberately different trust models
 * (doc/design-machines-and-memory.md):
 *
 *  - MACHINES: `machine_*` tools forward to the user's connected Runners via
 *    the bot's capability loopback. There is no path jail — the Runner
 *    executes as the user's own OS account on the user's own hardware, so the
 *    OS is the boundary. What guarantees isolation is the token: it resolves,
 *    server-side, to ONE bound capability facade, so this server can never
 *    address anybody else's devices, whatever it asks for. Writes (`exec`,
 *    `machine_write_file`) additionally return "approval required" until the
 *    device owner approves that exact call on the trusted panel. The follow-up
 *    is `machine_call_result`, NOT re-issuing the operation: while the call is
 *    undecided a repeat joins the same pending id, but once it has run a
 *    repeat is a brand-new card and a second execution if approved.
 *
 *  - MEMORY: `memory_*` tools read and write a private directory on the BOT
 *    host, which is a shared machine holding config, the database, and every
 *    user's archives. That half therefore gets no shell and a strict
 *    realpath jail rooted at this user's own memory dir. The root arrives in
 *    the environment (server-derived from the session owner) and is never
 *    taken from tool arguments.
 *
 * Purpose of the memory half: survive laptop churn. "Which machine holds what"
 * and "what we did last week" live here, not on any one laptop that might be
 * offline.
 */

import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Config is read lazily (not captured at import time) so the process env is
// the single source of truth and tests can exercise each configuration.
const gatewayApi = (): string | undefined => process.env.MACHINES_API?.replace(/\/$/, "");
const gatewayToken = (): string | undefined => process.env.MACHINES_TOKEN;
const memoryDir = (): string | undefined => process.env.MACHINES_MEMORY_DIR;
const fixedDevice = (): string | undefined => process.env.MACHINES_DEVICE?.trim() || undefined;
const machineCallsAreAutoAllowed = (): boolean => process.env.MACHINES_AUTO_ALLOW === "1";

/**
 * Memory bounds are per call, never on what the directory holds — the same
 * rules as the `user-memory-v1` capability plane over this directory: a read
 * returns a window (`offset` → `next_offset`), a listing or search a page
 * (`cursor` → `next_cursor`), and a write one chunk (`memory_write` at an
 * `offset`, or `memory_append`). The old 1 MiB-per-file and 1000-file caps
 * existed only because a read or listing returned everything at once.
 */
const MEMORY_WINDOW_BYTES = 1024 * 1024;
/** Content one write/append carries here (stdio, no capability-call envelope). */
const MEMORY_WRITE_MAX_BYTES = 1024 * 1024;
const MEMORY_LIST_PAGE = 500;
const MEMORY_SEARCH_MAX_HITS = 50;
const MEMORY_SEARCH_SCAN_BYTES = 64 * 1024 * 1024;

// ── memory jail (realpath-based; mirrors packages/bot/src/session/path-jail.ts) ──

function within(realRoot: string, realTarget: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

async function memoryPathForRead(input: string): Promise<string> {
  const root = requireMemoryDir();
  const candidate = path.resolve(root, input.trim());
  const realRoot = await fs.realpath(root);
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    throw new Error(`记忆文件不存在: ${input}`);
  }
  if (!within(realRoot, real)) throw new Error("路径越界：只能访问你自己的记忆目录");
  return real;
}

async function memoryPathForWrite(input: string): Promise<string> {
  const root = requireMemoryDir();
  const raw = input.trim();
  if (!raw) throw new Error("path 不能为空");
  const candidate = path.resolve(root, raw);
  const realRoot = await fs.realpath(root);
  try {
    const real = await fs.realpath(candidate);
    if (!within(realRoot, real)) throw new Error("路径越界：只能访问你自己的记忆目录");
    return real;
  } catch (err) {
    if (err instanceof Error && err.message.includes("路径越界")) throw err;
  }
  // Not there yet: the nearest existing ancestor must still be inside, which
  // is what stops a write through a symlinked directory.
  let dir = path.dirname(candidate);
  const tail: string[] = [path.basename(candidate)];
  for (;;) {
    try {
      const realDir = await fs.realpath(dir);
      if (!within(realRoot, realDir)) throw new Error("路径越界：只能访问你自己的记忆目录");
      return path.join(realDir, ...tail.reverse());
    } catch (err) {
      if (err instanceof Error && err.message.includes("路径越界")) throw err;
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error("路径越界：只能访问你自己的记忆目录");
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

function requireMemoryDir(): string {
  const dir = memoryDir();
  if (!dir) throw new Error("本会话没有配置记忆目录");
  return dir;
}

/** Length of `bytes` without a trailing incomplete UTF-8 sequence. */
function completeUtf8Length(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(4, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

function wholeArg(value: unknown, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`${name} 必须是 0 到 ${max} 之间的整数`);
  return n;
}

/** One window of a memory file, cut only between UTF-8 characters. */
async function readMemoryWindow(file: string, offset: number, maxBytes: number) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("目标不是普通文件");
    if (offset > stat.size) throw new Error(`offset ${offset} 超过文件大小 ${stat.size}`);
    const length = Math.min(maxBytes, stat.size - offset);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const kept = offset + read >= stat.size ? read : completeUtf8Length(buffer.subarray(0, read)) || read;
    const next = offset + kept;
    return { size: stat.size, offset, content: buffer.subarray(0, kept).toString("utf8"), eof: next >= stat.size,
      ...(next < stat.size ? { next_offset: next } : {}) };
  } finally {
    await handle.close();
  }
}

/** `old[0, offset) + content`, so repeating one chunk leaves the same bytes. Returns the new size. */
async function writeMemoryAt(file: string, offset: number, content: string): Promise<number> {
  const handle = await fs.open(file, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("目标不是普通文件");
    if (offset > stat.size) {
      throw new Error(`offset ${offset} 超过当前文件大小 ${stat.size}：分块写入请从 0 开始，每块的 offset 等于上一块返回的 size`);
    }
    const bytes = Buffer.from(content, "utf8");
    await handle.truncate(offset);
    let written = 0;
    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, offset + written);
      written += bytesWritten;
    }
    return offset + bytes.length;
  } finally {
    await handle.close();
  }
}

/**
 * Plain files in code-unit order of their relative paths, strictly after
 * `after`. Directories sort as `name/`, so depth-first order is the global
 * path order and a cursor resumes exactly. Symlinks are neither followed nor
 * listed.
 */
async function* walkMemorySorted(root: string, after?: string, prefix = ""): AsyncGenerator<{ path: string; full: string }> {
  let dirents;
  try {
    dirents = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return;
  }
  const keyed = dirents
    .filter((d) => d.isFile() || d.isDirectory())
    .map((d) => ({ d, key: d.isDirectory() ? `${prefix}${d.name}/` : `${prefix}${d.name}` }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { d, key } of keyed) {
    if (d.isDirectory()) {
      if (after !== undefined && after > key && !after.startsWith(key)) continue;
      yield* walkMemorySorted(root, after, key);
    } else if (after === undefined || key > after) {
      yield { path: key, full: path.join(root, key) };
    }
  }
}

/** Excerpt around the first case-insensitive hit of `needle`, reading the file in chunks. */
async function firstMemoryMatch(file: string, needle: string, counted: (bytes: number) => void): Promise<string | null> {
  const handle = await fs.open(file, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = "";
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      counted(bytesRead);
      const text = carry + (bytesRead ? decoder.write(chunk.subarray(0, bytesRead)) : decoder.end());
      const index = text.toLowerCase().indexOf(needle);
      if (index >= 0) {
        let tail = text.slice(index, index + 200);
        if (tail.length < 200 && bytesRead) {
          const { bytesRead: more } = await handle.read(chunk, 0, 4096, null);
          tail = (text + decoder.write(chunk.subarray(0, more))).slice(index, index + 200);
        }
        return text.slice(Math.max(0, index - 100), index) + tail;
      }
      if (!bytesRead) return null;
      carry = text.slice(-(needle.length + 100));
    }
  } finally {
    await handle.close();
  }
}

// ── machines (gateway loopback) ──

async function gatewayCall(operation: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
  const api = gatewayApi();
  const token = gatewayToken();
  if (!api || !token) throw new Error("本会话没有连接机器端点的能力");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("机器请求超时")), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${api}/rpc`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", "x-internal-token": token },
      // Identity is a property of the token's server-side binding. Stating a
      // user here is rejected by the loopback, not reconciled.
      body: JSON.stringify({ slot: "runner", operation, args }),
    });
  } finally {
    clearTimeout(timer);
  }
  const body = (await resp.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: unknown;
    error?: string;
    approval_required?: boolean;
    pending_call_id?: string;
  };
  if (!resp.ok || !body.ok) throw new Error(body.error || `机器网关错误 (HTTP ${resp.status})`);
  return body.result;
}

/**
 * Read what happened to a call that needed approval.
 *
 * This is the ONLY correct follow-up to "需要批准". Re-issuing the operation
 * looks like a retry but is a fresh request: once the first one has run, a
 * second identical call produces a second approval card and, if the owner says
 * yes, a second execution. Asking is not executing; the pending id is a lookup
 * key that only works for the session that created it.
 */
async function gatewayResult(pendingCallId: string): Promise<unknown> {
  const api = gatewayApi();
  const token = gatewayToken();
  if (!api || !token) throw new Error("本会话没有连接机器端点的能力");
  const resp = await fetch(`${api}/result`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": token },
    body: JSON.stringify({ pending_call_id: pendingCallId }),
  });
  const body = (await resp.json().catch(() => ({}))) as {
    ok?: boolean;
    state?: string;
    outcome?: string | null;
    result?: unknown;
    retry_safe?: boolean;
    error?: string;
  };
  if (!resp.ok || !body.ok) throw new Error(body.error || `查询待批准结果失败 (HTTP ${resp.status})`);
  return {
    state: body.state,
    outcome: body.outcome ?? null,
    result: body.result ?? null,
    retry_safe: body.retry_safe === true,
    error: body.error ?? null,
    // `unknown` says the call left this process and we could not learn what
    // happened — the honest answer for a laptop that went offline mid-exec. What
    // to DO about it depends on whether running it twice is the same as running
    // it once, which is a property of the operation, not of this failure.
    advice:
      body.outcome === "unknown"
        ? body.retry_safe === true
          ? "结果不可判定,但这个操作重跑一次与跑一次等价,可以重新发起(会再排一张批准卡)。"
          : "结果不可判定,且这个操作重跑一次就是第二次副作用。不要自动重发——请把情况如实告诉用户,由他决定。"
        : undefined,
  };
}

/**
 * Device targeting. Ordinary user sessions require an explicit `device`,
 * because a dangerous call's approval card must name the machine it will run
 * on. A trusted composition may instead pin this MCP process to one device via
 * MACHINES_DEVICE. That is only a truthful tool-shaping hint: the capability
 * kernel still enforces `runner_device_scope` server-side.
 */
function withDevice(args: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  // "This session has no machine capability" is the more fundamental answer, so
  // it wins: complaining about a missing argument to a tool that could not have
  // worked anyway tells the caller to fix the wrong thing.
  if (!gatewayApi() || !gatewayToken()) throw new Error("本会话没有连接机器端点的能力");
  const scoped = fixedDevice();
  const requested = String(args.device ?? "").trim();
  if (scoped && requested && requested !== scoped) {
    throw new Error(`本会话只授权设备 ${scoped},不能改为 ${requested}`);
  }
  const device = scoped ?? requested;
  if (!device) throw new Error("device 必填:先用 machines_list 看有哪些设备,再指定要操作哪一台");
  return { ...extra, device };
}

// ── tool definitions ──

const MACHINE_TOOLS = [
  {
    name: "machines_list",
    description: "列出你名下已注册的机器端点及在线状态。要在某台机器上做事之前，先用它确认设备名。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "machine_exec",
    description:
      "在你的某台机器上执行 shell 命令（以你自己的系统账号身份）。默认超时 60 秒、最长 300 秒；更久的任务请后台运行并把输出写到文件再轮询。"
      + "输出不会因为量大而中止命令：每个流超过 100KB 时只内联头尾各约 50KB（truncated=true），完整输出保存在设备上的 stdout_path / stderr_path（保留约一天；每流落盘上限 1GiB，超出时 stdout_spill_truncated / stderr_spill_truncated=true），"
      + "用 machine_read_file 按 offset 分页读取。"
      + "**每次调用都需要机器主人在可信面板上逐次批准**（包括 ls/cat 这类看起来只读的命令）。返回「需要批准」时请如实告诉用户去批准，"
      + "然后用 `machine_call_result` 查结果——不要再发一次同样的命令，那会变成第二次执行。",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", description: "设备名（必填；先用 machines_list 查）" },
        command: { type: "string", description: "要执行的命令" },
        cwd: { type: "string", description: "工作目录，默认该机器上你的 home" },
        timeout_ms: { type: "number", description: "超时毫秒数，默认 60000，上限 300000" },
      },
      required: ["device", "command"],
    },
  },
  {
    name: "machine_read_file",
    description:
      "读取某台机器上的文本文件。每次返回一个窗口（max_bytes，最大 1MB）；eof=false 时用返回的 next_offset 作为下一次的 offset 继续读，任意大小的文件都能读完。"
      + "**每次读取都需要机器主人在可信面板上逐次批准**——"
      + "文件内容可能被这次对话转发出去，所以读和写一样要人点头。返回「需要批准」时如实告诉用户去批准，"
      + "然后用 `machine_call_result` 查结果，不要重发同一次读取。",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", description: "设备名（必填；先用 machines_list 查）" },
        path: { type: "string", description: "绝对路径" },
        max_bytes: { type: "number", description: "本次窗口的字节数，默认与上限都是 1MB" },
        offset: { type: "number", description: "起始字节偏移，默认 0；续读时传上一次返回的 next_offset" },
      },
      required: ["device", "path"],
    },
  },
  {
    name: "machine_write_file",
    description:
      "写入某台机器上的文件（自动创建父目录）；append=true 时追加。单次 content 受请求包上限约束（约 256KB 内最稳妥）；"
      + "更大的内容分块写：首块覆盖，其余各块 append=true，并核对每次返回的 size 等于已写字节累计。分块期间文件处于中间状态，"
      + "需要原子替换时先写到同目录临时文件再 mv。**每次写入都需要机器主人在可信面板上逐次批准**，"
      + "批准后用 `machine_call_result` 查结果，不要重发同一次写入。",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", description: "设备名（必填；先用 machines_list 查）" },
        path: { type: "string", description: "绝对路径" },
        content: { type: "string" },
        append: { type: "boolean" },
      },
      required: ["device", "path", "content"],
    },
  },
  {
    name: "machine_list_dir",
    description: "列出某台机器上的目录内容（名称/类型/大小/修改时间），按名称排序分页；next_cursor 非空时传给 cursor 取下一页，直到列全。认路用，不需要批准。",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", description: "设备名（必填；先用 machines_list 查）" },
        path: { type: "string", description: "绝对路径，默认该机器上你的 home" },
        limit: { type: "number", description: "每页条数，默认 200，最大 500" },
        cursor: { type: "string", description: "上一页返回的 next_cursor" },
      },
      required: ["device"],
    },
  },
  {
    name: "machine_host_info",
    description: "查看某台机器的基本信息（主机名、平台、home、当前目录、内存）。认路用。",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string", description: "设备名（必填；先用 machines_list 查）" } },
      required: ["device"],
    },
  },
  {
    name: "machine_call_result",
    description:
      "查询一条「需要批准」的调用现在怎么样了（pending=还没批 / finished+succeeded=已执行，带执行结果 / rejected=被拒 / expired=超时作废 / unknown=结果不可判定）。"
      + "**被告知需要批准时，唯一正确的后续动作就是它**：重新发起同一个操作不是重试，而是再排一张新的批准卡，批了就会再执行一次。查询本身不会执行任何东西。"
      + "结果为 unknown 时看 `retry_safe` 与 `advice`：只有重跑与跑一次等价的操作才可以重新发起，`exec`/写文件这类不行。",
    inputSchema: {
      type: "object",
      properties: { pending_call_id: { type: "string", description: "上一次返回里的待批准编号" } },
      required: ["pending_call_id"],
    },
  },
];

/**
 * A device-scoped grant must not advertise account-wide discovery. Ticket
 * agents receive one device and no `__list_devices` right; exposing
 * `machines_list` made the model follow the ordinary-chat instructions and hit
 * a deterministic authorization error before doing any work.
 *
 * The schema omits `device` in this mode because `withDevice()` injects the
 * trusted value. Auto-allow only changes descriptions (and hides the approval
 * result helper); enforcement remains entirely in the server-side grant.
 */
function scopedMachineTools(device: string) {
  const autoAllowed = machineCallsAreAutoAllowed();
  const descriptions: Record<string, string> = {
    machine_exec: "执行 shell 命令。默认超时 60 秒、最长 300 秒,更久的任务后台运行再轮询。输出不会因量大中止命令:每个流超过 100KB 时内联头尾,"
      + "完整输出在返回的 stdout_path / stderr_path,用 machine_read_file 按 offset 分页读。",
    machine_read_file: "读取文本文件的一个窗口(max_bytes 最大 1MB);eof=false 时把 next_offset 作为 offset 继续读,任意大小都能读完。",
    machine_write_file: "写入文件并自动创建父目录;append=true 时追加。大内容分块写:首块覆盖,其余 append=true,核对返回的 size;需要原子替换时写临时文件再 mv。",
    machine_list_dir: "按名称分页列出目录内容(名称、类型、大小、修改时间);next_cursor 非空时传给 cursor 取下一页。",
    machine_host_info: "查看主机名、平台、home、当前目录与内存。",
    machine_call_result: "查询需要逐次批准的调用结果;不要重新发起同一个有副作用的操作。",
  };
  return MACHINE_TOOLS
    .filter((tool) => tool.name !== "machines_list" && (!autoAllowed || tool.name !== "machine_call_result"))
    .map((tool) => {
      const schema = tool.inputSchema as {
        type: string;
        properties: Record<string, unknown>;
        required?: string[];
      };
      const properties = { ...schema.properties };
      delete properties.device;
      const required = (schema.required ?? []).filter((name) => name !== "device");
      const execution = autoAllowed
        ? `本会话已固定授权设备 ${device},调用会直接执行,不需要逐次批准。`
        : `本会话已固定设备 ${device},无需也不能枚举或改选设备。`;
      const inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] } = {
        ...schema,
        properties,
      };
      if (required.length) inputSchema.required = required;
      else delete inputSchema.required;
      return {
        ...tool,
        description: `${execution}${descriptions[tool.name] ?? tool.description}`,
        inputSchema,
      };
    });
}

const MEMORY_TOOLS = [
  {
    name: "memory_read",
    description:
      "分段读取你在 bot 主机上的中心化记忆文件：每次返回从 offset 起的一个窗口（最多 1 MiB，只切在字符之间）和文件总大小 size；eof=false 时把 next_offset 作为 offset 继续读，任意大小都能读完。"
      + "这里的内容与任何一台机器是否在线无关——用它记住「什么东西在哪台机器」「历史上做过什么」。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对记忆目录的路径，如 MEMORY.md 或 machines/laptop.md" },
        offset: { type: "number", description: "从第几个字节开始读，默认 0；续读时传上一次的 next_offset" },
        max_bytes: { type: "number", description: "本次窗口的字节数，默认与上限都是 1 MiB" },
      },
      required: ["path"],
    },
  },
  {
    name: "memory_write",
    description:
      "写入中心化记忆文件。content 一次最多 1 MiB；不传 offset 时整份覆盖。更大的文件分块写：第一块不传 offset，之后每块传 offset=上一块返回的 size（这一块从该处写入并成为文件结尾，重复同一块结果不变）。"
      + "约定：MEMORY.md 放最重要的索引性事实（每轮会自动带给你），细节分文件存放。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        offset: { type: "number", description: "分块写入时这一块的起始字节；不传或 0 表示整份覆盖" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "memory_append",
    description: "向记忆文件追加一段内容（适合流水式记录：今天在哪台机器做了什么）；一次最多 1 MiB，文件本身没有大小上限。回答里的 size 是追加后的大小。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "memory_list",
    description: "按路径顺序分页列出记忆目录下的文件（路径/大小/修改时间）；回答带 next_cursor 时把它作为 cursor 取下一页，直到没有 next_cursor 才算列全。",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "string", description: "上一页的 next_cursor；第一页不传" },
        limit: { type: "number", description: "每页最多多少个文件，默认与上限都是 500" },
      },
    },
  },
  {
    name: "memory_search",
    description: "在全部记忆文件里做不区分大小写的子串搜索，按路径顺序返回命中的文件与片段（每个文件报第一处命中）；带 next_cursor 时用它继续搜索其余文件，没有 next_cursor 才表示搜完。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "这一页最多返回多少条命中，默认 10，最多 50" },
        cursor: { type: "string", description: "上一页的 next_cursor；第一页不传" },
      },
      required: ["query"],
    },
  },
];

// ── dispatch ──

export async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "machines_list":
      if (fixedDevice()) throw new Error(`本会话固定授权设备 ${fixedDevice()},无账户级设备枚举权`);
      return await gatewayCall("__list_devices", {});
    case "machine_exec":
      return await gatewayCall(
        "exec",
        withDevice(args, { command: args.command, cwd: args.cwd, timeout_ms: args.timeout_ms }),
        Math.min(310_000, Number(args.timeout_ms ?? 60_000) + 30_000),
      );
    case "machine_read_file":
      return await gatewayCall(
        "read_file",
        withDevice(args, { path: args.path, max_bytes: args.max_bytes, offset: args.offset }),
      );
    case "machine_write_file":
      return await gatewayCall(
        "write_file",
        withDevice(args, { path: args.path, content: args.content, append: args.append }),
      );
    case "machine_list_dir":
      return await gatewayCall(
        "list_dir",
        withDevice(args, { path: args.path, limit: args.limit, cursor: args.cursor }),
      );
    case "machine_host_info":
      return await gatewayCall("host_info", withDevice(args, {}));
    case "machine_call_result":
      return await gatewayResult(String(args.pending_call_id ?? ""));

    case "memory_read": {
      const target = await memoryPathForRead(String(args.path ?? ""));
      const window = await readMemoryWindow(target, wholeArg(args.offset, "offset", 0),
        Math.max(64, wholeArg(args.max_bytes, "max_bytes", MEMORY_WINDOW_BYTES, MEMORY_WINDOW_BYTES)));
      return { path: args.path, ...window };
    }
    case "memory_write":
    case "memory_append": {
      const content = String(args.content ?? "");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MEMORY_WRITE_MAX_BYTES) {
        throw new Error(`单次内容过大 (${bytes} > ${MEMORY_WRITE_MAX_BYTES} 字节)：请分块写入（memory_write 带 offset，或多次 memory_append）`);
      }
      const target = await memoryPathForWrite(String(args.path ?? ""));
      const existing = await fs.lstat(target).catch(() => null);
      if (existing && !existing.isFile()) throw new Error("目标不是普通文件，拒绝写入");
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (name === "memory_append") {
        await fs.appendFile(target, content, "utf8");
        return { path: args.path, bytes, mode: "append", size: (await fs.stat(target)).size };
      }
      const offset = wholeArg(args.offset, "offset", 0);
      if (offset > 0) {
        if (!existing) throw new Error("文件不存在：分块写入的第一块请用 offset 0（或不传 offset）");
        return { path: args.path, bytes, mode: "write", offset, size: await writeMemoryAt(target, offset, content) };
      }
      await fs.writeFile(target, content, "utf8");
      return { path: args.path, bytes, mode: "write", size: bytes };
    }
    case "memory_list": {
      const root = requireMemoryDir();
      const limit = Math.max(1, wholeArg(args.limit, "limit", MEMORY_LIST_PAGE, MEMORY_LIST_PAGE));
      const cursor = typeof args.cursor === "string" && args.cursor ? args.cursor : undefined;
      const files: Array<{ path: string; size: number; mtime: string }> = [];
      let more = false;
      for await (const file of walkMemorySorted(root, cursor)) {
        if (files.length >= limit) { more = true; break; }
        const st = await fs.stat(file.full).catch(() => null);
        if (st) files.push({ path: file.path, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
      }
      return { returned: files.length, files, ...(more ? { next_cursor: files.at(-1)!.path } : {}) };
    }
    case "memory_search": {
      const root = requireMemoryDir();
      const query = String(args.query ?? "");
      if (!query) throw new Error("memory_search 需要 query");
      const limit = Math.max(1, Math.min(MEMORY_SEARCH_MAX_HITS, Number(args.limit ?? 10) || 10));
      const cursor = typeof args.cursor === "string" && args.cursor ? args.cursor : undefined;
      const needle = query.toLowerCase();
      const hits: Array<{ path: string; excerpt: string }> = [];
      let scanned = 0;
      let last: string | undefined;
      let more = false;
      for await (const file of walkMemorySorted(root, cursor)) {
        if (hits.length >= limit || (last !== undefined && scanned >= MEMORY_SEARCH_SCAN_BYTES)) { more = true; break; }
        last = file.path;
        try {
          const found = await firstMemoryMatch(file.full, needle, (n) => { scanned += n; });
          if (found !== null) hits.push({ path: file.path, excerpt: found });
        } catch {
          // unreadable file — skip
        }
      }
      return { query, returned: hits.length, hits, ...(more && last !== undefined ? { next_cursor: last } : {}) };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export function availableTools() {
  return [
    ...(gatewayApi() && gatewayToken()
      ? fixedDevice()
        ? scopedMachineTools(fixedDevice()!)
        : MACHINE_TOOLS
      : []),
    ...(memoryDir() ? MEMORY_TOOLS : []),
  ];
}

async function main(): Promise<void> {
  const server = new Server({ name: "machines", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: availableTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await dispatch(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
      };
    }
  });

  await server.connect(new StdioServerTransport());
}

// Only run the server when executed directly (tests import dispatch).
if (process.env.MACHINES_PLUGIN_TEST !== "1") {
  void main();
}
