/**
 * Sessions MCP server.
 *
 * Lets a "secretary" agent investigate what the user recently did on this
 * machine (or their laptop) with Claude Code and Codex.
 *
 * Two modes, chosen by environment:
 *  - Local: SESSIONS_HOME points at a home dir on this machine; ops run
 *    against the filesystem directly (scan.ts). The scan root is a per-launch
 *    trust boundary — deliberately NOT overridable by tool arguments, and
 *    explicit `path` args are jailed inside it.
 *  - Remote: SESSIONS_REMOTE_API/_TOKEN/_USER point at the bot's
 *    RunnerGateway loopback; ops are forwarded to the user's connected
 *    laptop Runner, which executes the same scan layer against their real
 *    home. Tool schemas and result shapes are identical either way.
 */

import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { listRecentSessions, readSession, searchSessions, digestRecentSessions } from "./scan.js";
import { remoteConfigFromEnv, remoteSessionsCall } from "./remote.js";
import { withListCursor } from "./list-cursor.js";

const remote = remoteConfigFromEnv();
/** Report-attachment dir (archive mode only): enables the file tools. */
const FILES_DIR = process.env.SESSIONS_FILES_DIR;

function localHome(): string {
  return process.env.SESSIONS_HOME ?? process.env.HOME ?? os.homedir();
}

async function walkAll(dir: string, base: string): Promise<Array<{ path: string; size: number }>> {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ path: string; size: number }> = [];
  for (const d of dirents) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walkAll(p, base)));
    else if (d.isFile()) {
      const st = await fs.stat(p).catch(() => null);
      if (st) out.push({ path: path.relative(base, p).split(path.sep).join("/"), size: st.size });
    }
  }
  return out;
}

async function listReportFiles(): Promise<unknown> {
  if (!FILES_DIR) throw new Error("本会话没有随报告附带的文件");
  const files = await walkAll(FILES_DIR, FILES_DIR);
  return { returned: files.length, files, note: files.length === 0 ? "本报告没有附带文件。" : undefined };
}

async function readReportFile(args: Record<string, unknown>): Promise<unknown> {
  if (!FILES_DIR) throw new Error("本会话没有随报告附带的文件");
  const rel = String(args.path ?? "").trim();
  if (!rel) throw new Error("read_report_file requires `path`");
  const target = path.resolve(FILES_DIR, rel.split("/").join(path.sep));
  const realRoot = await fs.realpath(FILES_DIR);
  const real = await fs.realpath(target);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error("path is outside the report files dir");
  }
  const content = await fs.readFile(real, "utf8");
  // A window of the file; `next_offset` reads on, so no part is out of reach.
  const maxChars = Math.max(200, Math.min(200_000, Number(args.max_chars ?? 50_000) || 50_000));
  const offset = Math.max(0, Math.min(content.length, Math.floor(Number(args.offset ?? 0) || 0)));
  const end = Math.min(content.length, offset + maxChars);
  return {
    path: rel,
    offset,
    total_chars: content.length,
    truncated: end < content.length,
    ...(end < content.length ? { next_offset: end } : {}),
    content: content.slice(offset, end),
  };
}

async function dispatch(method: string, args: Record<string, unknown>): Promise<unknown> {
  // File tools always run against the LOCAL archive dir (the bot machine),
  // even when session ops are remote — attachments were copied at send time.
  if (method === "list_report_files") return listReportFiles();
  if (method === "read_report_file") return readReportFile(args);
  if (remote) {
    const result = await remoteSessionsCall(remote, method, args);
    return method === "list_recent_sessions" ? withListCursor(result, args) : result;
  }
  const home = localHome();
  switch (method) {
    case "list_recent_sessions":
      return withListCursor(await listRecentSessions(home, args), args);
    case "digest_recent_sessions":
      return digestRecentSessions(home, args);
    case "read_session":
      return readSession(home, args);
    case "search_sessions":
      return searchSessions(home, args);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "sessions", version: "2.1.0" },
  { capabilities: { tools: {} } },
);

const FILE_TOOLS = [
  {
    name: "list_report_files",
    description: "列出随本报告一起披露的附件文件(相对路径与大小)。",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "read_report_file",
    description: "读取随本报告披露的一个附件文件的内容(UTF-8 文本),分段返回;回答带 next_offset 时把它作为 offset 继续读。",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "list_report_files 返回的相对路径。" },
        offset: { type: "number", description: "从第几个字符开始读,默认 0。" },
        max_chars: { type: "number", description: "本段最多返回的字符数,默认 50000(200-200000)。" },
      },
      required: ["path"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...(FILES_DIR ? FILE_TOOLS : []),
    {
      name: "list_recent_sessions",
      description:
        "按最近活动倒序列出用户最近的 Claude Code / Codex / Oh My Pi(omp) 会话。每项含 id、source、project/cwd、path、起止时间、消息数、provider 会话名(title,若有)、首条用户提问(first_user_text)和最新预览(preview);多设备时带 device。"
        + "回答带 next_cursor 表示还有会话没列出:把它原样作为 cursor 再调用,续页按稳定的会话标识顺序遍历全部会话(可能与首页重复,按 source+id 去重),直到回答不再带 next_cursor——没有 next_cursor 就表示列表已完整。",
      inputSchema: {
        type: "object" as const,
        properties: {
          source: {
            type: "string",
            enum: ["claude", "codex", "omp", "all"],
            description: "会话来源，默认 all。",
          },
          limit: { type: "number", description: "本页返回条数上限，默认 20（1-500）；总数不受限，用 next_cursor 翻页。" },
          since_hours: {
            type: "number",
            description: "只保留最近 N 小时内有活动的会话（按文件修改时间）。",
          },
          cursor: { type: "string", description: "上一页回答里的 next_cursor，原样传回；翻页时保持 source/since_hours 不变。缺省返回最近活动的一页。" },
        },
      },
    },
    {
      name: "digest_recent_sessions",
      description:
        "一次通读最近多个会话的对话骨架:每个会话给出用户提问与 agent 自然语言回复(已滤掉工具调用/思考/结果细节,每条截断),含开头 2 条(任务定义)与最近若干条(结论)。**这是调查的首选起点**——先通读锁定相关会话,再用 read_session 细读;不要靠 search 猜关键词。",
      inputSchema: {
        type: "object" as const,
        properties: {
          source: { type: "string", enum: ["claude", "codex", "omp", "all"], description: "会话来源,默认 all。" },
          limit: { type: "number", description: "通读的会话数上限,默认 8(1-20)。" },
          turns_per_session: { type: "number", description: "每会话保留的对话条数,默认 14(2-40)。" },
          chars_per_turn: { type: "number", description: "每条截断字符数,默认 160(40-400)。" },
          since_hours: { type: "number", description: "只看最近 N 小时内有活动的会话。" },
        },
      },
    },
    {
      name: "read_session",
      description:
        "读取指定会话的对话内容。用 id 或 path 二选一定位（path 优先）。返回 meta 与拍平后的 messages（role/text，工具调用压成 tool: name），截断到最近 max_messages 条。",
      inputSchema: {
        type: "object" as const,
        properties: {
          source: {
            type: "string",
            enum: ["claude", "codex", "omp"],
            description: "会话来源。用 id 定位时建议填写；用 path 定位时可省略（会自动推断）。",
          },
          id: { type: "string", description: "会话 id（Claude 为文件名 uuid；Codex 为 rollout 文件名中的 uuid；omp 为文件名 `<时间戳>_<uuid>` 中的 uuid）。" },
          path: { type: "string", description: "会话文件绝对路径（与 id 二选一，优先）。" },
          max_messages: { type: "number", description: "最多返回最近多少条消息，默认 40（1-500）。" },
          tool_detail: { type: "boolean", description: "true 时工具调用行附带输入参数摘要(截断);默认只有工具名。" },
        },
      },
    },
    {
      name: "search_sessions",
      description:
        "在全部会话的文本里做不区分大小写的子串搜索（从最新到最旧），返回命中的会话摘要与命中片段(snippet)。"
        + "一次调用只做有界的一页；回答带 next_cursor 时表示还有更旧的会话没搜到，把它作为 cursor 再调用即可继续，直到 complete=true。",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "要搜索的子串（不区分大小写）。" },
          source: {
            type: "string",
            enum: ["claude", "codex", "omp", "all"],
            description: "会话来源，默认 all。",
          },
          limit: { type: "number", description: "本页返回命中会话数上限，默认 10（1-50）。" },
          cursor: { type: "string", description: "上一页回答里的 next_cursor；留空从最新会话开始。" },
          since_hours: { type: "number", description: "只搜索最近 N 小时内有活动的会话。" },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  try {
    const result = await dispatch(request.params.name, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
