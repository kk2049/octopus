import { CAPABILITY_ACTIONS } from "@claude-bot/runner/capability-protocol";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { RUNNER_EXTENSION_MCP_TOOLS } from "../runner/extension-contract.js";
import { MEETING_TRANSCRIPTION_OPERATIONS } from "../meeting-transcription/capability.js";
import { MEETING_TRANSCRIPTION_MCP_TOOLS } from "../meeting-transcription/contract.js";
/**
 * The MCP tool table — every tool the endpoint can serve, with the permission
 * token that must be EFFECTIVE for it to be listed or called.
 *
 * ── One field table, two derivations ────────────────────────────────────────
 *
 * Each tool is declared once as a field table; the JSON Schema an agent reads
 * (`inputSchema`) and the check its arguments pass at call time
 * (`readToolArgs`) are both derived from that table. The repository's one
 * hand-written generator (`gatewayToolDescriptors`) is the named counter-
 * example: its shape allowed a bound to exist in the handler and be absent
 * from the schema, and a model that cannot see a bound exceeds it and is
 * refused for a reason it was never shown. Bounds here are LIFTED from the
 * kernel Object tables (`RUNNER_OPERATIONS`, `WORKSPACE_FILES_OPERATIONS`) and
 * from the `crdt-doc/v1` declaration rather than retyped, so the schema, the
 * Gate and the device agree on every number.
 *
 * `additionalProperties: false` everywhere, and `readToolArgs` enforces it: an
 * invented argument that reaches a handler which ignores it reads to the model
 * as "accepted".
 *
 * ── What is deliberately NOT an argument ────────────────────────────────────
 *
 * No caller owner, username, device path, workspace id or file path anywhere.
 * Shared administration accepts a target member account; it never chooses the caller.
 * Identity comes from the presented token; files and documents are named by
 * opaque refs the trusted side minted in an earlier answer (`loopback.ts`'s
 * FORBIDDEN_BODY_KEYS is the same rule at another door, enforced here by the
 * closed field tables rather than by a blocklist).
 *
 * The memory and skill tools DO take a relative path or a skill name — those
 * planes' Objects are per-owner directories whose binding fixes the root, so
 * a relative name cannot address anything the token's owner does not hold,
 * and the plane's realpath jail refuses every escape shape. What stays
 * impossible by construction is naming another OWNER.
 */

import { CRDT_DOC_DECLARATION } from "@claude-bot/crdt-doc-contract";
import { WORKSPACE_FILES_LIMITS, WORKSPACE_LIST_CURSOR_MAX_LENGTH } from "@claude-bot/workspace-files-contract";
import { mcpToolsOf, type McpToolDefinition } from "@claude-bot/typed-port-kit";
import type { ArgSpec } from "@claude-bot/capability-kernel";
import { RUNNER_OPERATIONS } from "../runner/capability.js";
import {
  WORKSPACE_FILES_OPERATIONS,
  WORKSPACE_FILES_WRITE_OPERATION,
} from "../workspace-files/capability.js";
import { USER_MEMORY_LIMITS, USER_MEMORY_OPERATIONS } from "../user-memory/capability.js";
import { USER_SKILLS_LIMITS, USER_SKILLS_OPERATIONS } from "../user-skills/capability.js";
import { FEISHU_MCP_CATALOG, SEND_FILE_SOURCE_ARGS } from "../feishu/catalog.js";

/** The one Feishu operation that also takes a file by path on the caller's own device. */
export const SEND_FILE_BY_PATH_OPERATION = "message_send_file_as_bot";
const SEND_FILE_PATH_FIELD: McpFieldSpec = {
  type: "string",
  maxLength: 4096,
  description: "要发送的文件：你所在设备上、某个已登记工作区里的路径（相对当前工作目录、~/ 或绝对路径）。与 file_base64 二选一；最大 30 MB（飞书 im/v1/files 的上限）。只有经本机 Runner 桥接的 Agent 会话能用。",
};
import { DISCUSSION_OPERATIONS } from '../discussions/capability.js';
import {
  EXECUTION_WORKSPACE_OPERATIONS,
  RUN_WORKSPACE_COMMAND,
} from "../execution-workspace/capability.js";
import {
  EXECUTION_SCOPE_OPERATIONS,
  LIST_EXECUTION_TARGETS,
  OPEN_WORKSPACE_EXECUTION,
} from "../execution-workspace/scope-issuer.js";
import type { McpToolGroup } from "./policy-contract.js";

export { MCP_TOOL_GROUPS, type McpToolGroup } from "./policy-contract.js";

/**
 * One MCP call is one JSON-RPC message. The local Runner bridge carries a line
 * of at most 16 MiB (`runner/src/local-agent-bridge.ts`) and `/api/mcp` takes
 * a body of the same size (`dashboard/routes/mcp.ts`); this is the window, not
 * a bound on what a document or file may total. Inline fields are declared to
 * fit inside it — base64 is one byte per character, text up to three — so a
 * declared maximum is always deliverable. More than that goes by reference (a
 * path on the caller's device) or over several calls.
 */
export const MCP_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
export const MCP_INLINE_BASE64_MAX = 12_000_000;
export const MCP_INLINE_TEXT_MAX = 4_000_000;

/** Which subject's EFFECTIVE set admits a tool, and which operation in it. */
export interface McpToolGate {
  subject: "session-hub" | "mcp";
  operation: string;
}

export interface McpFieldSpec {
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
  maxLength?: number;
  enum?: readonly string[];
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface McpToolSpec {
  name: string;
  description: string;
  fields: Readonly<Record<string, McpFieldSpec>>;
  gate: McpToolGate;
  group: McpToolGroup;
}

export const RUNNER_CAPABILITY_TOOLS: readonly McpToolSpec[] = Object.entries(CAPABILITY_ACTIONS).map(([action, declaration]) => ({
  name: "runner_capability_" + action, description: declaration.summary, group: "runner_capabilities",
  gate: { subject: "mcp", operation: declaration.operation },
  fields: Object.fromEntries(Object.entries(declaration.params).map(([name, field]) => [name, {
    type: field.type, description: field.description, maxLength: field.maxLength, required: !("optional" in field && field.optional),
  }])),
}));
export const KNOWLEDGE_TOOLS: readonly McpToolSpec[] = [
  {name:"knowledge_sources",group:"knowledge",gate:{subject:"mcp",operation:"manage_knowledge_sources"},
    description:"管理本人选择性导入的 CLI 来源。导入只证明字节，不证明人类身份；read 可返回本人已在认证页面针对具体设计创建的新确认。Agent 无确认操作，不能读取其它用户或任意文件路径。",
    fields:{action:{type:"string",required:true,enum:["list","read","import"],description:"来源操作"},id:{type:"string",maxLength:80,description:"来源 id"},after:{type:"string",maxLength:80,description:"上一页游标"},source_json:{type:"string",maxLength:16000,description:"单条 JSON：provider/device/session_id/message_id/source_at/role(user|assistant)/text；正文最多 12000 字"}}},
  {name:"knowledge_repairs",group:"knowledge",gate:{subject:"mcp",operation:"maintain_development_knowledge"},
    description:"有界知识纠错：按记录指纹报告候选，核对原始来源后调查，在 Git 修正及添加正反回放。replay 只验证当前精确激活产物，不会部署、修改记录或批准设计。",
    fields:{action:{type:"string",required:true,enum:["list","report","investigate","replay"],description:"纠错操作"},after:{type:"string",maxLength:80,description:"上一页游标"},id:{type:"string",maxLength:80,description:"纠错候选 id"},record_id:{type:"string",maxLength:512,description:"知识记录 id"},fingerprint:{type:"string",maxLength:64,description:"节点的 repair_fingerprint"},problem:{type:"string",enum:["wrong_scope","wrong_lifecycle","missing_slot","invalid_anchor","evaluation_failed"],description:"问题类别"},investigation_json:{type:"string",maxLength:4000,description:"KnowledgeChange JSON：record_id、original_motivation、proposed_motivation、proposed_behavior、alternatives、impact、verification；每项动机至少 12 字"}}},
  { name: "knowledge_context", group: "knowledge", gate: { subject: "mcp", operation: "read_development_knowledge" },
    description: "开发前与调试中检索功能规格、原则、三档证据、来源、模块及测试。修改知识须经 Git 和正常落地管线；CLI 最终简报仍须包含 pnpm knowledge:context 的实际检索回执。",
    fields: { query: { type: "string", required: true, maxLength: 1000, description: "当前问题和已定位的仓库相对路径。" }, subject: { type: "string", maxLength: 400, description: "可选的知识节点或冲突 id；读取其来源与已保存批注。" } } },
  { name: "knowledge_annotate", group: "knowledge", gate: { subject: "mcp", operation: "annotate_development_knowledge" },
    description: "把 Agent 的调查补充到知识冲突，记录两边动机、代码/测试和替代方案。写入审阅历史，不能冒充人类背书、批准修改或直接改知识。",
    fields: { subject: { type: "string", required: true, maxLength: 400, description: "knowledge_context 返回的冲突 id。" }, body: { type: "string", required: true, maxLength: 2000, description: "有来源的调查内容。" } } },
  { name: "knowledge_investigate", group: "knowledge", gate: { subject: "mcp", operation: "annotate_development_knowledge" },
    description: "提交完整冲突调查，绑定当前双方原文；必须先查原始动机、实现、替代方案、影响和测试。调查不是人类背书，第三档修改仍需管理员在知识库明确确认批准。",
    fields: {
      subject: { type: "string", required: true, maxLength: 400, description: "当前冲突 id。" },
      record_id: { type: "string", required: true, maxLength: 200, description: "冲突一方的知识记录 id。" },
      original_motivation: { type: "string", required: true, maxLength: 400, description: "原设计的动机和原始来源，至少 12 字。" },
      proposed_motivation: { type: "string", required: true, maxLength: 400, description: "新任务为何需要调整及来源，至少 12 字。" },
      proposed_behavior: { type: "string", required: true, maxLength: 400, description: "拟采用的具体产品行为，至少 12 字。" },
      alternatives: { type: "string", required: true, maxLength: 400, description: "替代方案及未采用原因，至少 12 字。" },
      impact: { type: "string", required: true, maxLength: 400, description: "用户影响和妥协代价，至少 12 字。" },
      verification: { type: "string", required: true, maxLength: 400, description: "核对的代码与测试及结果，至少 12 字。" },
    } },
];

/** Lift one kernel ArgSpec, carrying every declared bound. */
function fromArgSpec(spec: ArgSpec, description: string, overrides: Partial<McpFieldSpec> = {}): McpFieldSpec {
  const base: McpFieldSpec = { type: spec.type, description };
  if (spec.type === "string") {
    if (spec.maxLength !== undefined) base.maxLength = spec.maxLength;
    if (spec.enum !== undefined) base.enum = spec.enum;
  } else if (spec.type === "number") {
    if (spec.min !== undefined) base.min = spec.min;
    if (spec.max !== undefined) base.max = spec.max;
    if (spec.integer !== undefined) base.integer = spec.integer;
  }
  if (spec.required) base.required = true;
  return { ...base, ...overrides };
}

const DISCUSSION_DESCRIPTIONS: Record<string, string> = {
  discussion_start: '为一个新议题创建飞书群，把当前召集人与 participants 中的已注册真人账号及 Bot 拉到一起，启动常驻会议秘书。默认 Sol 快速过滤、GPT-6 秘书；返回会议记录与真实状态。request_id 必须稳定，相同请求不能换 id 重试。approval_required 后等本人批准再用原参数领取结果。',
  discussion_list: '列出当前账号参与的会议及秘书运行进展。',
  discussion_read: '读取本会议群消息、纪要、Agent 活动与不确定的发送回执；after 是消息序号，用于向后分页。',
  discussion_append: '把消息追加到本会议秘书的持久收件箱，忙时排队；秘书自行判断是否需要在群里发言。request_id 必须稳定。',
  discussion_configure: '仅召集人可修改 filter/secretary 的 model、effort、prompt 和预算，或暂停/继续/结束会议。revision 来自最新读取；修改不改变会议工具权限。',
};
const DISCUSSION_FIELDS: Record<string, string> = {
  request_id: '本次意图的稳定唯一标识；重试必须复用。', topic: '一句话议题。', agenda: '目标、背景、讨论问题和预期产出。',
  participants: '真实 Octopus 用户名，以逗号分隔，例如 lht,lilei；召集人自动加入。',
  settings: '可选 JSON 对象：filter/secretary 各含 model、effort、prompt；maxToolTurns（非负整数，0 = 不设上限，默认 0）、maxRepliesPerTurn (1..5)。只修改传入项。',
  discussion_id: 'discussion_start/list 返回的会议 id。', after: '读取此消息序号之后的记录。', text: '要追加给秘书的内容；不会直接冒充真人在群发言。', revision: '最新会议配置版本，用于防止覆盖并发编辑。', status: 'active 继续、paused 暂停、closed 结束。',
};
export const DISCUSSION_TOOLS: readonly McpToolSpec[] = Object.entries(DISCUSSION_OPERATIONS).map(([name, spec]) => ({
  name, group: 'discussions', gate: { subject: 'mcp', operation: name }, description: DISCUSSION_DESCRIPTIONS[name]!,
  fields: Object.fromEntries(Object.entries(spec.args).map(([key, field]) => [key, fromArgSpec(field, DISCUSSION_FIELDS[key] ?? key)])),
}));

/** Same contract and bounds as the Runner typed port; device is injected by composition. */
export const MEETING_TRANSCRIPTION_TOOLS: readonly McpToolSpec[] = MEETING_TRANSCRIPTION_MCP_TOOLS.map(definition => ({
  name: definition.name, description: definition.description, group: "transcription", gate: { subject: "mcp", operation: definition.name },
  fields: Object.fromEntries(Object.entries(MEETING_TRANSCRIPTION_OPERATIONS[definition.name]!.args).filter(([key]) => key !== "device")
    .map(([key, field]) => [key, fromArgSpec(field, String((definition.inputSchema.properties?.[key] as { description?: string } | undefined)?.description ?? key))])),
}));

/**
 * An opaque ref minted by an earlier answer of THIS surface. 200 mirrors the
 * `crdt-doc/v1` ref bound; workspace refs are far shorter.
 */
const REF_FIELD: McpFieldSpec = {
  type: "string",
  required: true,
  maxLength: 200,
  description: "不透明引用：来自本 MCP 服务此前一次列表/读取回答，只对当前令牌有意义。不是路径。",
};

const LIST_SPEC = RUNNER_OPERATIONS.list_recent_sessions.args;
const SEARCH_SPEC = RUNNER_OPERATIONS.search_sessions.args;
const READ_SPEC = RUNNER_OPERATIONS.read_session.args;
const APPEND_SPEC = RUNNER_OPERATIONS.append_session.args;
const WRITE_SPEC = WORKSPACE_FILES_OPERATIONS[WORKSPACE_FILES_WRITE_OPERATION].args;

export const SESSION_TOOLS: readonly McpToolSpec[] = [
  {
    name: "list_recent_sessions",
    description:
      "列出你自己的 Claude Code / Codex / omp 会话（在线设备与 bot 主机合并）。回答里的 resource_id 供 read_session 使用。"
      + "不带 cursor 时返回按最近活动排序的一页；回答带 next_cursor 表示还有会话没列出：把它原样作为 cursor 再调用，"
      + "续页按稳定的会话标识顺序遍历全部会话（可能与首页重复，按 resource_id 去重），直到回答不再带 next_cursor——"
      + "没有 next_cursor 就表示列表已完整。每页最多 limit 条。",
    group: "sessions",
    gate: { subject: "session-hub", operation: "list_sessions" },
    fields: {
      source: fromArgSpec(LIST_SPEC.source, "只看某一种 CLI 的会话；缺省 all。"),
      limit: fromArgSpec(LIST_SPEC.limit, "本页最多返回多少条；缺省 50。总数不受限，用 next_cursor 翻页。"),
      since_hours: fromArgSpec(LIST_SPEC.since_hours, "只看最近多少小时内活跃的会话。"),
      device: fromArgSpec(LIST_SPEC.device, "只看这一台设备（回答里的 device 名）；缺省是全部在线设备与 bot 主机。"),
      cursor: fromArgSpec(LIST_SPEC.cursor, "上一页回答里的 next_cursor，原样传回；翻页时保持 source/device/since_hours 不变。缺省返回最近活动的一页。"),
    },
  },
  {
    name: "search_sessions",
    description:
      "在你自己的全部会话记录里按关键字检索（从最新到最旧），返回命中片段与所属会话（含 resource_id）。"
      + "一次调用只搜索有界的一页：回答带 next_cursor 时还有更早的会话没搜到，把它作为 cursor 再调用即可继续，直到 complete=true；"
      + "incomplete_sources 列出本页没能完整搜索的设备。",
    group: "sessions",
    gate: { subject: "session-hub", operation: "search_sessions" },
    fields: {
      query: fromArgSpec(SEARCH_SPEC.query, "要检索的关键字。"),
      source: fromArgSpec(SEARCH_SPEC.source, "只在某一种 CLI 的会话里检索；缺省 all。"),
      limit: fromArgSpec(SEARCH_SPEC.limit, "最多返回多少条命中；缺省 15。"),
      since_hours: fromArgSpec(SEARCH_SPEC.since_hours, "只检索最近多少小时内活跃的会话。"),
      cursor: fromArgSpec(SEARCH_SPEC.cursor, "上一页回答里的 next_cursor；缺省从最新的会话开始。"),
    },
  },
  {
    name: "read_session",
    description:
      "读取一个会话的 transcript。resource_id 来自 list_recent_sessions 或 search_sessions 的回答。"
      + "缺省读最新的消息；用 offset 向后翻页（下一页 offset = offset + returned_messages），用 before 向前翻页（上一页 before = offset）。"
      + "一页同时受条数和字节上限约束，byte_limited=true 表示本页提前结束。"
      + "思考与工具输入/输出在页里被截断时带 truncated=true；用 offset（消息序号）+ block（块序号）+ field 读取该块的完整内容，"
      + "回答带 next_char_offset 时把它作为 char_offset 继续读。",
    group: "sessions",
    gate: { subject: "session-hub", operation: "read_session" },
    fields: {
      resource_id: {
        type: "string",
        required: true,
        maxLength: 512,
        description: "会话引用：list/search 回答里的 resourceId。",
      },
      max_messages: fromArgSpec(READ_SPEC.max_messages, "最多返回多少条消息；缺省 200。"),
      offset: fromArgSpec(READ_SPEC.offset, "从第几条消息开始读；与 block 一起时是该块所在消息的序号。"),
      before: fromArgSpec(READ_SPEC.before, "读到这条消息之前为止（向前翻页）。"),
      block: fromArgSpec(READ_SPEC.block, "读取 offset 处消息里这个序号的内容块的完整内容。"),
      field: fromArgSpec(READ_SPEC.field, "内容块字段：text（正文/思考）、input 或 output；缺省 text。"),
      char_offset: fromArgSpec(READ_SPEC.char_offset, "完整内容从第几个字符开始读；上一回答的 next_char_offset。"),
    },
  },
  {
    name: "send_session_message",
    description:
      "向 list_recent_sessions / search_sessions 返回的一个可写会话追加消息。"
      + "这是跨会话通讯，不替代当前 Codex、Claude 或 OMP 的原生 subagent 通讯工具；"
      + "发给令牌所属账号自己的会话无需批准；若仍返回 approval_required，不得自动重发。",
    group: "sessions",
    gate: { subject: "session-hub", operation: "append_session" },
    fields: {
      resource_id: {
        type: "string",
        required: true,
        maxLength: 512,
        description: "会话引用：list/search 回答里的 resource_id。",
      },
      prompt: fromArgSpec(
        APPEND_SPEC.prompt,
        "要发送给该会话的一条消息。会由设备侧选择安全的 provider-native append/steer/resume 路径。",
        { required: true },
      ),
    },
  },
];

export const WORKSPACE_TOOLS: readonly McpToolSpec[] = [
  {
    name: "list_session_workspaces",
    description:
      `列出你设备上已登记的工作区（文件访问的根）。回答里的 ref 供 list_workspace_entries 使用。一次最多 ${WORKSPACE_FILES_LIMITS.maxRoots} 个；`
      + "truncated=true 时把回答里的 next_after 作为 after 再调用，直到 truncated=false，即可拿到全部工作区。",
    group: "workspace",
    gate: { subject: "mcp", operation: "list_session_workspaces" },
    fields: {
      after: { ...REF_FIELD, required: false, description: "上一页回答里的 next_after；缺省从第一页开始。" },
    },
  },
  {
    name: "list_workspace_entries",
    description:
      "列出工作区里一个目录的条目。目录用它的 ref 指名（来自 list_session_workspaces 或上一次列目录）。"
      + `一页最多 ${WORKSPACE_FILES_LIMITS.maxEntries} 条，按目录、文件、其它排序，同类按名称；truncated=true 时把回答里的 next_after 作为 after 再调用，`
      + "直到 truncated=false，即可列全任意大的目录。翻页期间其它条目的增删不会让结果重复或遗漏。",
    group: "workspace",
    gate: { subject: "mcp", operation: "list_workspace_entries" },
    fields: {
      ref: REF_FIELD,
      after: {
        type: "string",
        maxLength: WORKSPACE_LIST_CURSOR_MAX_LENGTH,
        description: "上一页回答里的 next_after（形如 file/名称）；缺省从第一页开始。",
      },
    },
  },
  {
    name: "read_workspace_text",
    description:
      `分段读取工作区里一个文本文件：每次返回从 offset（UTF-8 字节，缺省 0）起的一个窗口 text，最多 ${Math.round(WORKSPACE_FILES_LIMITS.textChunkBytes / 1024)} KiB，只切在字符之间；`
      + "回答里的 document 带整份文件的 SHA-256 摘要 digest（改写时要用）与总字节数 sizeBytes。"
      + "eof=false 时把 next_offset 作为 offset 再调用，直到 eof=true，即可读完任意大小的文件；"
      + "各窗口的 digest 不一致说明文件在读取期间被改过，应从 0 重新读取。",
    group: "workspace",
    gate: { subject: "mcp", operation: "read_workspace_text" },
    fields: {
      ref: REF_FIELD,
      offset: {
        type: "number",
        integer: true,
        min: 0,
        description: "从第几个字节开始读；缺省 0，续读时用上一次回答的 next_offset。",
      },
      max_bytes: {
        type: "number",
        integer: true,
        min: 1024,
        max: WORKSPACE_FILES_LIMITS.textChunkBytes,
        description: `本次窗口最多多少字节；缺省与上限都是 ${Math.round(WORKSPACE_FILES_LIMITS.textChunkBytes / 1024)} KiB。上下文紧张时可取更小的窗口。`,
      },
    },
  },
  {
    name: "replace_workspace_text",
    description:
      "整份替换一个已存在文本文件的内容（带锁写入）：必须带上先前读取到的 expected_digest，文件在此期间被改过则拒绝写入。"
      + `不带 stage 时 text 是完整新内容（最多 ${MCP_INLINE_TEXT_MAX} 字符），服务端按单次调用窗口分段写入并在最后原子替换。`
      + "更大的文件分多次调用：stage=begin（带 expected_digest）取得 upload；stage=append 依次带 upload、offset（已写入的 UTF-8 字节数）和一段 text；"
      + "stage=commit 带 upload、expected_digest 与总字节数 size，比对通过才原子替换，失败则文件不变。"
      + "令牌所属账号自己的工作区：授权后直接写入，无需逐次批准；若仍返回 approval_required，不得自动重发。",
    group: "workspace",
    gate: { subject: "mcp", operation: WORKSPACE_FILES_WRITE_OPERATION },
    fields: {
      ref: REF_FIELD,
      expected_digest: fromArgSpec(
        WRITE_SPEC.expected_digest,
        "该文件当前内容的摘要（read_workspace_text 回答里的 digest，形如 sha256:…）。整份替换、begin 与 commit 必填；与设备上的实际内容不符时不写入。",
      ),
      text: fromArgSpec(
        WRITE_SPEC.text,
        "不带 stage：文件的完整新内容（UTF-8）；stage=append：从 offset 起的一段。这是整份替换，不支持局部修改。",
        { maxLength: MCP_INLINE_TEXT_MAX },
      ),
      stage: fromArgSpec(WRITE_SPEC.stage, "分段写入的步骤：begin、append 或 commit；整份内容一次给出时省略。"),
      upload: {
        type: "string",
        maxLength: 32,
        description: "stage=begin 回答里的 upload；append 与 commit 必填。",
      },
      offset: fromArgSpec(WRITE_SPEC.offset, "stage=append：这一段在新全文中的起始字节，必须等于上一次回答的 sizeBytes。"),
      size: fromArgSpec(WRITE_SPEC.size, "stage=commit：新全文的总字节数，必须等于最后一次 append 回答的 sizeBytes。"),
    },
  },
];
const RUN_WORKSPACE_SPEC = EXECUTION_WORKSPACE_OPERATIONS[RUN_WORKSPACE_COMMAND].args;

/** Added only for a live, internally minted split-placement credential. */
export const SESSION_EXECUTION_TOOL: McpToolSpec = {
  name: "run_workspace_command",
  description:
    "在这次会话绑定的执行设备与已登记工作区中运行一条命令。设备、工作区和身份由会话凭证固定，参数不能改写。"
    + "输出量不会中止命令：单个流超过约 100KB 时内联头尾（truncated=true），完整输出在执行设备上的 stdout_path / stderr_path（保留约一天；每流落盘上限 1GiB，超出时 *_spill_truncated=true），"
    + "可再用命令分页读取，例如 tail -c +起始字节(从 1 数) 文件 | head -c 字节数。",
  group: "workspace",
  gate: { subject: "mcp", operation: RUN_WORKSPACE_COMMAND },
  fields: {
    command: fromArgSpec(RUN_WORKSPACE_SPEC.command, "要在绑定工作区中运行的 shell 命令。"),
    timeout_ms: fromArgSpec(RUN_WORKSPACE_SPEC.timeout_ms, "超时毫秒数；缺省由执行端决定。"),
  },
};


const OPEN_SCOPE_SPEC = EXECUTION_SCOPE_OPERATIONS[OPEN_WORKSPACE_EXECUTION].args;

/**
 * The on-demand execution-scope group: a personal harness (dsh) discovers the
 * owner's own devices + registered workspaces and asks for a short-lived,
 * revocable session-execution credential over exactly one of them. The answer
 * of `open_workspace_execution` is a SEPARATE `mcp_` token whose scope is the
 * five session tools; the issuing token never gains them itself. `issuer` is
 * not a field here: the surface injects the caller's credential handle before
 * the Gate sees the call.
 */
export const EXECUTION_TOOLS: readonly McpToolSpec[] = [
  {
    name: LIST_EXECUTION_TARGETS,
    description:
      "列出你自己的在线设备里能承接远程执行的那些（报告了 shell 与 workspace-files），以及每台设备上已登记的工作区 id 与标签。"
      + "不读文件、不跑命令；答案里的 device / workspace_id 供 open_workspace_execution 使用。",
    group: "execution",
    gate: { subject: "mcp", operation: LIST_EXECUTION_TARGETS },
    fields: {},
  },
  {
    name: OPEN_WORKSPACE_EXECUTION,
    description:
      "为你自己的一台在线设备与其上一个已登记工作区签发一枚独立的会话执行凭证（mcp_ 令牌，只含工作区文件与 run_workspace_command 五个工具，"
      + "设备与工作区由凭证固定）。令牌只返回这一次；过期、撤销本令牌或对它 DELETE /api/mcp 都会立刻作废。",
    group: "execution",
    gate: { subject: "mcp", operation: OPEN_WORKSPACE_EXECUTION },
    fields: {
      device: fromArgSpec(OPEN_SCOPE_SPEC.device, "执行设备名（来自 list_execution_targets）。"),
      workspace_id: fromArgSpec(OPEN_SCOPE_SPEC.workspace_id, "该设备上已登记工作区的不透明 id（ws_…）。"),
      permission_profile: fromArgSpec(
        OPEN_SCOPE_SPEC.permission_profile,
        "full_access：五个会话工具自动放行；manual：写入与命令仍逐次在待批准页审批。",
      ),
      runtime: fromArgSpec(OPEN_SCOPE_SPEC.runtime, "调用方 harness 的标识（如 dsh:web），只用于审计与显示；缺省 dsh。"),
      ttl_minutes: fromArgSpec(OPEN_SCOPE_SPEC.ttl_minutes, "凭证有效期（分钟）；缺省 480，最长 1440。"),
    },
  },
];

const MEM_LIST = USER_MEMORY_OPERATIONS.list_memory.args;
const MEM_READ = USER_MEMORY_OPERATIONS.read_memory.args;
const MEM_SEARCH = USER_MEMORY_OPERATIONS.search_memory.args;
const MEM_WRITE = USER_MEMORY_OPERATIONS.write_memory.args;
const MEM_APPEND = USER_MEMORY_OPERATIONS.append_memory.args;
const KiB = (bytes: number) => `${Math.round(bytes / 1024)} KiB`;

/**
 * The user's central memory directory on the bot host. Field names equal the
 * kernel operation's own argument names, so `args.value` passes through the
 * Gate unchanged and the schema's bounds are the Gate's bounds.
 */
export const MEMORY_TOOLS: readonly McpToolSpec[] = [
  {
    name: "memory_list",
    description: "按路径顺序分页列出你在 bot 主机上的中心记忆文件（路径/大小/修改时间）。回答带 next_cursor 时把它作为 cursor 取下一页，直到没有 next_cursor 才算列全。内容用 memory_read 读取。",
    group: "memory",
    gate: { subject: "mcp", operation: "list_memory" },
    fields: {
      cursor: fromArgSpec(MEM_LIST.cursor, "上一页回答里的 next_cursor；第一页不传。"),
      limit: fromArgSpec(MEM_LIST.limit, `每页最多多少个文件；缺省 ${USER_MEMORY_LIMITS.listPageMax}。`),
    },
  },
  {
    name: "memory_read",
    description: `分段读取一个中心记忆文件：每次返回从 offset 起的一个窗口（最多 ${KiB(USER_MEMORY_LIMITS.readWindowBytes)}，只切在字符之间），附文件总大小 size；eof=false 时把 next_offset 作为 offset 继续读，任意大小的文件都能读完。路径相对记忆目录，如 MEMORY.md 或 machines/laptop.md。`,
    group: "memory",
    gate: { subject: "mcp", operation: "read_memory" },
    fields: {
      path: fromArgSpec(MEM_READ.path, "相对记忆目录的路径（来自 memory_list 的回答）。"),
      offset: fromArgSpec(MEM_READ.offset, "从第几个字节开始读；缺省 0，续读时用上一次的 next_offset。"),
      max_bytes: fromArgSpec(MEM_READ.max_bytes, `本次窗口的字节数；缺省与上限都是 ${KiB(USER_MEMORY_LIMITS.readWindowBytes)}。`),
    },
  },
  {
    name: "memory_search",
    description: "在全部记忆文件里做不区分大小写的子串搜索，按路径顺序返回命中的文件与片段（每个文件报第一处命中）。一页最多 limit 条命中；带 next_cursor 时用它继续搜索其余文件，没有 next_cursor 才表示全部搜完。",
    group: "memory",
    gate: { subject: "mcp", operation: "search_memory" },
    fields: {
      query: fromArgSpec(MEM_SEARCH.query, "要检索的关键字。"),
      limit: fromArgSpec(MEM_SEARCH.limit, "这一页最多返回多少条命中；缺省 10。"),
      cursor: fromArgSpec(MEM_SEARCH.cursor, "上一页回答里的 next_cursor；第一页不传。"),
    },
  },
  {
    name: "memory_write",
    description:
      `写入一个中心记忆文件（不存在则创建）。content 一次最多 ${KiB(USER_MEMORY_LIMITS.writeMaxBytes)}；不传 offset 时整份覆盖。更大的文件分块写：第一块不传 offset，之后每块传 offset=上一块返回的 size——这一块从该处写入并成为文件结尾，重复同一块结果不变。`
      + "每次写入都会生成一张待批准卡，由记忆区所有者在网页上点头后才执行（所有者授权后可免批）。"
      + "约定：MEMORY.md 放最重要的索引性事实（它的开头会自动注入所有者未来的会话），细节分文件存放。",
    group: "memory",
    gate: { subject: "mcp", operation: "write_memory" },
    fields: {
      path: fromArgSpec(MEM_WRITE.path, "相对记忆目录的路径。"),
      content: fromArgSpec(MEM_WRITE.content, "这次写入的内容（UTF-8）。不传 offset 时是文件的完整新内容。"),
      offset: fromArgSpec(MEM_WRITE.offset, "分块写入时这一块的起始字节，等于上一块返回的 size；不传或 0 表示整份覆盖。"),
    },
  },
  {
    name: "memory_append",
    description:
      `向一个中心记忆文件末尾追加一段内容（适合流水式记录；一次最多 ${KiB(USER_MEMORY_LIMITS.appendMaxBytes)}，文件本身没有大小上限）。回答里的 size 是追加后的文件大小。每次追加都会生成一张待批准卡，由所有者点头后才执行。`,
    group: "memory",
    gate: { subject: "mcp", operation: "append_memory" },
    fields: {
      path: fromArgSpec(MEM_APPEND.path, "相对记忆目录的路径。"),
      content: fromArgSpec(MEM_APPEND.content, "要追加的内容（UTF-8）。原内容保留。"),
    },
  },
];

const SKILL_LIST = USER_SKILLS_OPERATIONS.list_skills.args;
const SKILL_READ = USER_SKILLS_OPERATIONS.read_skill.args;
const SKILL_WRITE = USER_SKILLS_OPERATIONS.write_skill.args;
const SKILL_REMOVE = USER_SKILLS_OPERATIONS.remove_skill.args;

/**
 * The user's skill registry (`.claude/skills/<name>/`, SKILL.md as the main
 * file). Same pass-through relationship to the kernel table as the memory
 * tools above.
 */
export const SKILL_TOOLS: readonly McpToolSpec[] = [
  {
    name: "skill_list",
    description: "按名字分页列出你的技能库：每个技能的名字、全部文件与总大小。回答带 next_cursor 时把它作为 cursor 取下一页。内容用 skill_read 读取。",
    group: "skills",
    gate: { subject: "mcp", operation: "list_skills" },
    fields: {
      cursor: fromArgSpec(SKILL_LIST.cursor, "上一页回答里的 next_cursor；第一页不传。"),
      limit: fromArgSpec(SKILL_LIST.limit, `每页最多多少个技能；缺省 ${USER_SKILLS_LIMITS.listPageMax}。`),
    },
  },
  {
    name: "skill_read",
    description: `分段读取某个技能目录里的一个文件（file 缺省为 SKILL.md）：每次返回从 offset 起的一个窗口（最多 ${KiB(USER_SKILLS_LIMITS.readWindowBytes)}，只切在字符之间）；eof=false 时把 next_offset 作为 offset 继续读。`,
    group: "skills",
    gate: { subject: "mcp", operation: "read_skill" },
    fields: {
      name: fromArgSpec(SKILL_READ.name, "技能名（小写字母/数字/连字符）。"),
      file: fromArgSpec(SKILL_READ.file, "技能目录内的相对文件路径；缺省 SKILL.md。"),
      offset: fromArgSpec(SKILL_READ.offset, "从第几个字节开始读；缺省 0，续读时用上一次的 next_offset。"),
      max_bytes: fromArgSpec(SKILL_READ.max_bytes, `本次窗口的字节数；缺省与上限都是 ${KiB(USER_SKILLS_LIMITS.readWindowBytes)}。`),
    },
  },
  {
    name: "skill_write",
    description:
      `写入某个技能目录里的一个文件（技能或文件不存在则创建；file 缺省为 SKILL.md）。content 一次最多 ${KiB(USER_SKILLS_LIMITS.writeMaxBytes)}；不传 offset 时整份覆盖，更大的文件分块写：之后每块传 offset=上一块返回的 size。`
      + `技能库配额：每个技能合计不超过 ${KiB(USER_SKILLS_LIMITS.skillTotalMaxBytes)}、${USER_SKILLS_LIMITS.maxFilesPerSkill} 个文件，每个账号 ${USER_SKILLS_LIMITS.maxSkills} 个技能。`
      + "技能是会被所有者的 agent 加载执行的指令，所以每次写入都会生成一张待批准卡，由所有者在网页上点头后才执行（所有者授权后可免批）。",
    group: "skills",
    gate: { subject: "mcp", operation: "write_skill" },
    fields: {
      name: fromArgSpec(SKILL_WRITE.name, "技能名（小写字母/数字/连字符，最长 64）。"),
      file: fromArgSpec(SKILL_WRITE.file, "技能目录内的相对文件路径；缺省 SKILL.md。"),
      content: fromArgSpec(SKILL_WRITE.content, "这次写入的内容（UTF-8）。不传 offset 时是文件的完整新内容。"),
      offset: fromArgSpec(SKILL_WRITE.offset, "分块写入时这一块的起始字节，等于上一块返回的 size；不传或 0 表示整份覆盖。"),
    },
  },
  {
    name: "skill_remove",
    description: "删除整个技能目录（不可恢复）。每次删除都会生成一张待批准卡，由所有者点头后才执行。",
    group: "skills",
    gate: { subject: "mcp", operation: "remove_skill" },
    fields: {
      name: fromArgSpec(SKILL_REMOVE.name, "要删除的技能名。"),
    },
  },
];

/**
 * Feishu's reviewed user and privileged catalogs, projected mechanically into
 * MCP. The trusted catalog remains the single source of operation, bounds,
 * identity, effect, scopes and downstream payload mapping.
 */
export const FEISHU_TOOLS: readonly McpToolSpec[] = FEISHU_MCP_CATALOG.map((entry) => ({
  name: `feishu_${entry.operation}`,
  description: `${entry.description} ${
    entry.credentialMode === "user_oauth"
      ? "使用你的飞书 OAuth 身份。"
      : "使用租户应用 / 系统 Bot 身份。"
  }${entry.ownerMayAutoAllow ? "是否逐次批准由账号主人在权限中心决定。" : "特权、写入和外发动作逐次批准。"}`,
  group: "feishu" as const,
  gate: { subject: "mcp" as const, operation: entry.operation },
  fields: {
    ...Object.fromEntries(
      Object.entries(entry.spec.args)
        // A by-reference file is named by `path`; where it lives is the
        // surface's to state from the caller session, never the model's.
        .filter(([name]) => !(SEND_FILE_SOURCE_ARGS as readonly string[]).includes(name))
        .map(([name, spec]) => [
          name,
          fromArgSpec(spec, entry.argDescriptions?.[name] ?? `${entry.title} · ${name}`),
        ]),
    ),
    ...(entry.operation === SEND_FILE_BY_PATH_OPERATION ? { path: SEND_FILE_PATH_FIELD } : {}),
  },
}));

/**
 * Putting agents into Feishu documents, and starting agents. Deliberately
 * ungated (owner decision 2026-10-18: no approval cards for now); each call is
 * audited here and the owner is notified in Feishu by the docs service. The
 * `gate.operation` names the audit row only.
 */
export const FEISHU_DOC_PLACE_TOOL: McpToolSpec = {
  name: "feishu_doc_place",
  description:
    "把一个 Agent 会话放进飞书新版文档：插入一张实时 Agent 卡片（snapshot=true 时是一份固定的快照），缺省在文档末尾；给出 after 时紧跟在文档里那段文字之后。文档读者可以实时只读观看对话，所有者（和所有者授权的人）可以在卡片里继续布置任务或分叉。"
    + "session 缺省为 self（你自己当前所在的会话）；也可以是 list_recent_sessions 返回的 resource_id 或 title（终端标题栏里的会话名），或原生会话 ID（Claude Code: $CLAUDE_CODE_SESSION_ID；Codex: $CODEX_THREAD_ID）。"
    + "document 可以是链接、token 或文档标题（按标题在所有者能访问的文档里查找，有多篇候选时会列出链接请你选）。会话标题或 after 对应多处时同样列出候选、不替你猜。以所有者的飞书身份写入，需要所有者能编辑那篇文档；所有者会收到飞书通知。",
  group: "feishu",
  gate: { subject: "mcp", operation: "feishu_doc_place" },
  fields: {
    document: { type: "string", required: true, maxLength: 2000, description: "飞书新版文档链接（…/docx/… 或 …/wiki/…）、文档 token，或文档标题。" },
    session: { type: "string", maxLength: 512, description: "要放入的会话：self（缺省）、resource_id、会话标题或原生会话 ID。" },
    title: { type: "string", maxLength: 60, description: "卡片标题（文档读者看到的名字）；缺省用会话标题。" },
    after: { type: "string", maxLength: 2000, description: "把卡片插在文档里这段文字之后：照抄标题或段落（可以跨相邻几段，空白不必一致），或给一个块 ID。卡片紧跟在这段文字所在的内容块后面；给出时忽略 position。" },
    position: { type: "string", enum: ["end", "start"], description: "没有 after 时，插在文档末尾（缺省）还是开头。" },
    snapshot: { type: "boolean", description: "true：放一份快照而不是实时卡片。快照固定在会话最近一轮完成时（给自己放时，就是请你放快照的这一轮之前），之后不再变化；读者可以从快照分叉出新的对话继续聊。适合把某个阶段的结论作为里程碑留在文档里。" },
  },
};

export const FEISHU_DOC_BOARD_TOOL: McpToolSpec = {
  name: "feishu_doc_board",
  description:
    "在飞书新版文档里放一块可视化看板卡片，或更新已有看板：内容是一页静态 HTML（表格、进度条、状态色块、内联 SVG 图表都可以），文档读者实时看到最新版本。"
    + "第一次发布给 document（位置规则同 feishu_doc_place：after 或 position），返回 board；之后只用 board 加新的 html 更新，卡片自动刷新，不会重复通知所有者。"
    + "只渲染静态内容：脚本、iframe、表单和外部资源（外链图片、字体、样式表）都不会加载；图片用 data:image URI，图表用内联 SVG（请给 SVG 设 width/height，否则会按卡片宽度放大），样式写在 <style> 或 style 属性里。"
    + "卡片宽约 600–900px、初始高 560px，超出部分在卡片内滚动；配色请用主题变量以适配深色模式：var(--board-text) var(--board-muted) var(--board-border) var(--board-surface) var(--board-accent) var(--board-good) var(--board-warn) var(--board-bad)。"
    + "所有者会收到一次飞书通知。",
  group: "feishu",
  gate: { subject: "mcp", operation: "feishu_doc_board" },
  fields: {
    html: { type: "string", required: true, maxLength: 200_000, description: "完整的一页静态 HTML（可含 <style>），不含脚本。" },
    title: { type: "string", maxLength: 60, description: "看板标题（卡片顶栏显示）。" },
    board: { type: "string", maxLength: 64, description: "更新已有看板时给出第一次发布返回的 board；不给则新建。" },
    document: { type: "string", maxLength: 2000, description: "新建时必填：飞书新版文档链接、token 或标题。" },
    after: { type: "string", maxLength: 2000, description: "新建时可选：插在文档里这段文字所在的内容块之后（同 feishu_doc_place）。" },
    position: { type: "string", enum: ["end", "start"], description: "新建且没有 after 时，插在文档末尾（缺省）还是开头。" },
  },
};

export const FEISHU_DOC_REMOVE_TOOL: McpToolSpec = {
  name: "feishu_doc_remove",
  description:
    "把所有者自己的一张 Octopus 卡片（会话卡片或看板）从飞书文档里移走：停止它的共享并删除这个块。block 是 feishu_doc_place / feishu_doc_board 返回的 card.block。"
    + "只移动或删除 Octopus 卡片；别人的卡片和普通内容不会被动。所有者会收到飞书通知。",
  group: "feishu",
  gate: { subject: "mcp", operation: "feishu_doc_remove" },
  fields: {
    document: { type: "string", required: true, maxLength: 2000, description: "卡片所在的飞书新版文档：链接、token 或标题。" },
    block: { type: "string", required: true, maxLength: 128, description: "卡片的块 ID（放置时返回的 card.block）。" },
  },
};

const DOC_FIELD: McpFieldSpec = { type: "string", required: true, maxLength: 2000, description: "飞书新版文档链接（…/docx/… 或 …/wiki/…）、文档 token，或文档标题。" };
const AT_FIELDS: Readonly<Record<string, McpFieldSpec>> = {
  after: { type: "string", maxLength: 2000, description: "插在文档里这段文字所在的内容块之后（照抄标题或段落，可跨相邻几段，空白不必一致），或给一个块 ID。" },
  position: { type: "string", enum: ["end", "start"], description: "没有 after 时，插在文档末尾（缺省）还是开头。" },
};

export const FEISHU_DOC_OUTLINE_TOOL: McpToolSpec = {
  name: "feishu_doc_outline",
  description: "读取飞书新版文档的结构：按阅读顺序列出每个内容块的 id、类型（h1、text、bullet、table、image…）、层级和文字（每块最多 300 字）。用它找到要插入、替换或删除的位置；长文档用 from 翻页。以所有者的飞书身份读取。",
  group: "feishu",
  gate: { subject: "mcp", operation: "feishu_doc_outline" },
  fields: {
    document: DOC_FIELD,
    from: { type: "number", integer: true, min: 0, description: "从第几个块开始（上一页返回的 next）；缺省 0。" },
    limit: { type: "number", integer: true, min: 1, max: 500, description: "最多返回多少个块；缺省 200。" },
  },
};

export const FEISHU_DOC_WRITE_TOOL: McpToolSpec = {
  name: "feishu_doc_write",
  description: "以所有者身份往飞书新版文档里写内容：markdown 由飞书转换成文档块（标题、段落、列表、代码块、引用、待办、表格），插在 after 那段文字或那个块之后，或 position 开头 / 末尾；给 replace（块 ID 或一段原文）则用新内容替换那一个块。"
    + "Markdown 里的图片不会插入，请用 feishu_doc_image。所有者会收到通知（同一篇文档 10 分钟内合并成一条）。",
  group: "feishu",
  gate: { subject: "mcp", operation: "feishu_doc_write" },
  fields: {
    document: DOC_FIELD,
    markdown: { type: "string", required: true, maxLength: MCP_INLINE_TEXT_MAX, description: "要写入的 Markdown。很长的内容会分段交给飞书转换，再按顺序写在同一处。" },
    ...AT_FIELDS,
    replace: { type: "string", maxLength: 2000, description: "可选：要被替换掉的那个块（块 ID，或它里面原样出现的一段文字）；给出时忽略 after / position。" },
  },
};

export const FEISHU_DOC_IMAGE_TOOL: McpToolSpec = {
  name: "feishu_doc_image",
  description: "往飞书新版文档里插入一张图片（PNG、JPEG、GIF、WEBP、BMP；SVG 请先转成 PNG）。path 是你所在设备上的文件：绝对路径、~/… 或相对当前工作目录都可以，但必须在这台设备已登记的某个工作区里；大图请用 path。"
    + "没有 path 时用 data 传 base64（一次调用最多 1200 万个字符，约 9 MB 的图片）。超过 20 MB 的图片会分片上传给飞书。位置规则同 feishu_doc_write。",
  group: "feishu",
  gate: { subject: "mcp", operation: "feishu_doc_image" },
  fields: {
    document: DOC_FIELD,
    path: { type: "string", maxLength: 4096, description: "图片在你所在设备上的路径：绝对路径、~/… 或相对当前工作目录。" },
    data: { type: "string", maxLength: MCP_INLINE_BASE64_MAX, description: "没有 path 时：图片的 base64（可带 data: 前缀）。" },
    name: { type: "string", maxLength: 120, description: "用 data 时的文件名。" },
    ...AT_FIELDS,
  },
};

export const FEISHU_DOC_DELETE_TOOL: McpToolSpec = {
  name: "feishu_doc_delete",
  description: "删除飞书新版文档里的内容块：blocks 是用逗号或空格分隔的块 ID（来自 feishu_doc_outline，一次最多 50 个），连同它们的子块一起删除。其中的 Octopus 卡片会同时停止共享。",
  group: "feishu",
  gate: { subject: "mcp", operation: "feishu_doc_delete" },
  fields: {
    document: DOC_FIELD,
    blocks: { type: "string", required: true, maxLength: 4000, description: "要删除的块 ID，逗号或空格分隔。" },
  },
};

/** The ungated document tools, in the order agents see them. */
export const FEISHU_DOC_TOOLS: readonly McpToolSpec[] = [
  FEISHU_DOC_OUTLINE_TOOL, FEISHU_DOC_WRITE_TOOL, FEISHU_DOC_IMAGE_TOOL, FEISHU_DOC_DELETE_TOOL,
  FEISHU_DOC_PLACE_TOOL, FEISHU_DOC_BOARD_TOOL, FEISHU_DOC_REMOVE_TOOL,
];

/**
 * The owner's document access keys (`feishu/doc-share.ts`): ungated like the
 * other document tools; the control card in the document lists every key,
 * those readers take for themselves included.
 */
export const FEISHU_DOC_SHARE_TOOLS: readonly McpToolSpec[] = [
  {
    name: "feishu_doc_share_create",
    description:
      "为一篇飞书新版文档创建一个访问密钥（待领取）。接入方式（Claude Code 的一行 `claude mcp add`、Codex 的一行配置命令，都含令牌）只在文档里的 Octopus 控制卡片上、由所有者本人点「显示接入命令」领取，只显示一次；这个工具的结果和飞书通知里都没有令牌。"
      + "协作者（可以在别的组织、没有 Octopus 账号）接入后，就能通过 Octopus 读写（或只读）这一篇文档，身份是 Octopus 飞书应用。"
      + "其实多数时候不必替别人创建：能看到控制卡片的读者可以在卡片上自己领取访问密钥，权限不超过所有者在卡片上设的上限（默认读写，可改成只读或关闭），每张卡片每小时最多 10 个、同时最多 50 个未终止的密钥；看不到卡片的人（例如组织外的人）可以用所有者在卡片上生成的领取链接领取。能看到卡片的人也都可以终止卡片上的密钥。"
      + "前提：所有者在飞书里有这篇文档的分享权限，且已在文档右上角「…」→「添加文档应用」里加入 Octopus 应用并给编辑权限；结果里的 app_access 是应用现在的权限，读写密钥缺编辑权限时附 warning。知识库里的快捷方式不行，要给原文档的链接。文档末尾会放一张 Octopus 控制卡片（已有则复用），卡片列出所有密钥，所有者可以在卡片上领取、暂停、恢复或终止；删除卡片后密钥在 24 小时内停止。密钥不按时间过期。",
    group: "feishu",
    gate: { subject: "mcp", operation: "feishu_doc_share_create" },
    fields: {
      document: DOC_FIELD,
      label: { type: "string", required: true, maxLength: 60, description: "这个访问密钥的名字，例如协作者的名字；显示在控制卡片上。" },
      rights: { type: "string", enum: ["write", "read"], description: "write（缺省）：可读可写；read：只读。" },
    },
  },
  {
    name: "feishu_doc_share_list",
    description: "列出你的文档访问密钥（可以只看一篇文档），包括读者在控制卡片上或用领取链接自己领取的：名字、权限、状态、来源 via（owner 你创建的，card 读者在卡片上领取的，invite 用领取链接领取的）、创建与最近使用时间、控制卡片状态。不会再给出令牌。",
    group: "feishu",
    gate: { subject: "mcp", operation: "feishu_doc_share_list" },
    fields: {
      document: { ...DOC_FIELD, required: false, description: "可选：只看这篇文档的访问密钥（链接、token 或标题）。" },
    },
  },
  {
    name: "feishu_doc_share_update",
    description: "暂停或终止你的一个文档访问密钥，立即生效。terminate 不可恢复，同时作废它的令牌。恢复只能由所有者在文档里的 Octopus 控制卡片上操作。",
    group: "feishu",
    gate: { subject: "mcp", operation: "feishu_doc_share_update" },
    fields: {
      share_id: { type: "string", required: true, maxLength: 64, description: "feishu_doc_share_create 或 feishu_doc_share_list 返回的 share_id。" },
      action: { type: "string", required: true, enum: ["pause", "terminate"], description: "pause 暂停、terminate 终止。" },
    },
  },
];

/**
 * A collaborator's tools on the one document a share names: served ONLY to a
 * `feishuDocShare` token, never to an account token. No field names a
 * document — the share is the document — and this is the whole list: nothing
 * creates, deletes or moves a document, or changes who may open it.
 */
export const FEISHU_SHARED_DOC_TOOLS: readonly McpToolSpec[] = [
  {
    name: "feishu_shared_doc_read",
    description: "读取共享给你的这篇飞书文档：按阅读顺序输出 Markdown，每个内容块前有一行 <!-- 块ID · 类型 --> 标记。一次最多约 10 万字；回答带 next 时，把它作为 from 继续读。revision 是文档当前版本。",
    group: "feishu",
    gate: { subject: "mcp", operation: "feishu_shared_doc_read" },
    fields: {
      from: { type: "number", integer: true, min: 0, description: "从第几个块开始（上一页回答的 next）；缺省 0。" },
    },
  },
  {
    name: "feishu_shared_doc_outline",
    description: "列出这篇文档的结构：按阅读顺序给出每个内容块的 id、类型（h1、text、bullet、table、image…）、层级和开头文字（每块最多 300 字）。用它找要写入、替换或删除的位置；长文档用 from 翻页。",
    group: "feishu",
    gate: { subject: "mcp", operation: "feishu_shared_doc_outline" },
    fields: {
      from: { type: "number", integer: true, min: 0, description: "从第几个块开始（上一页返回的 next）；缺省 0。" },
      limit: { type: "number", integer: true, min: 1, max: 500, description: "最多返回多少个块；缺省 200。" },
    },
  },
  {
    name: "feishu_shared_doc_block_read",
    description: "读取这篇文档里一个内容块的完整文字、类型、父块和子块。",
    group: "feishu",
    gate: { subject: "mcp", operation: "feishu_shared_doc_block_read" },
    fields: {
      block_id: { type: "string", required: true, maxLength: 128, description: "块 ID（来自 feishu_shared_doc_read 或 feishu_shared_doc_outline）。" },
    },
  },
  {
    name: "feishu_shared_doc_write",
    description: "往这篇文档写入 Markdown：飞书把它转换成内容块（标题、段落、列表、代码、引用、待办、表格），插在 after 指定的块或那段文字之后，或 position 开头 / 末尾（缺省末尾）。一次最多 1 MB；Markdown 里的图片不会插入；不能写进同步块。",
    group: "feishu",
    gate: { subject: "mcp", operation: "feishu_shared_doc_write" },
    fields: {
      // The service enforces the same bound in UTF-8 bytes (SHARED_WRITE_MAX_BYTES, feishu/doc-share.ts).
      markdown: { type: "string", required: true, maxLength: 1024 * 1024, description: "要写入的 Markdown（UTF-8 最多 1 MB）。较长的内容会分段转换，再按顺序写在同一处。" },
      ...AT_FIELDS,
    },
  },
  {
    name: "feishu_shared_doc_block_update",
    description: "把一个文本块（段落、标题、列表项、代码、引用、待办）的文字整体替换为 text：纯文本，块的 ID、类型和位置不变，原有的行内格式会被清除。同步块里的内容不能改。可选 revision：读取时的文档版本，飞书按该版本处理这次修改；缺省用修改前刚读到的版本，文档在这期间被改动时会拒绝，重新读取后再试即可。",
    group: "feishu",
    gate: { subject: "mcp", operation: "feishu_shared_doc_block_update" },
    fields: {
      block_id: { type: "string", required: true, maxLength: 128, description: "要修改的文本块 ID。" },
      text: { type: "string", required: true, maxLength: 20_000, description: "这个块的新文字（纯文本）。" },
      revision: { type: "number", integer: true, min: 1, description: "可选：读取时的文档版本（feishu_shared_doc_read / outline 回答里的 revision）；缺省按最新版本修改。" },
    },
  },
  {
    name: "feishu_shared_doc_remove",
    description: "删除这篇文档里的内容块（连同子块）：blocks 是逗号或空格分隔的块 ID，一次最多 50 个。组件块（包括 Octopus 控制卡片）和同步块不能删除；删除前会先核对全部块，有一个不行就一个都不删。文档在删除过程中被别人改动时会拒绝，重新读取后再试即可。",
    group: "feishu",
    gate: { subject: "mcp", operation: "feishu_shared_doc_remove" },
    fields: {
      blocks: { type: "string", required: true, maxLength: 4000, description: "要删除的块 ID，逗号或空格分隔。" },
    },
  },
];

export const SESSION_START_TOOL: McpToolSpec = {
  name: "session_start",
  description:
    "在所有者自己的一台在线设备上新建一个 Claude Code 或 Codex Agent 会话，并把 prompt 作为它的第一条任务；可选地同时把它放进一篇飞书文档。"
    + "最多等待约 90 秒拿到新会话 ID。不经审批直接启动（完全授权），所有者会收到飞书通知；不要为同一意图重复调用。",
  group: "sessions",
  gate: { subject: "mcp", operation: "session_start" },
  fields: {
    prompt: { type: "string", required: true, maxLength: MACHINE_LIMITS.startMaxPromptBytes, description: "新 Agent 的第一条任务（UTF-8 最多 384 KB，Runner 一条任务的上限）。" },
    directory: { type: "string", required: true, maxLength: 4096, description: "工作目录：绝对路径或 ~/… 。必须已经存在。" },
    device: { type: "string", maxLength: 128, description: "设备名；从本机 Runner 调用时缺省为当前设备。" },
    provider: { type: "string", enum: ["claude", "codex"], description: "claude 或 codex；缺省沿用所有者上次的选择。" },
    model: { type: "string", maxLength: 120, description: "模型，如 opus / sonnet / gpt-6-astra；空字符串表示 Runner 默认。" },
    effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "思考强度。" },
    document: { type: "string", maxLength: 2000, description: "可选：启动后放进这篇飞书文档（链接、token 或标题）。" },
    title: { type: "string", maxLength: 60, description: "可选：卡片与会话的显示标题。" },
    after: { type: "string", maxLength: 2000, description: "可选：放进文档时紧跟在这段文字之后（同 feishu_doc_place）。" },
    position: { type: "string", enum: ["end", "start"], description: "可选：放进文档且没有 after 时，插在末尾（缺省）还是开头。" },
  },
};

/**
 * One declared App's stable id, as `app_list` publishes it. 64 mirrors the
 * `DECLARED_APP_ID` grammar's own ceiling.
 */
const APP_FIELD: McpFieldSpec = {
  type: "string",
  required: true,
  maxLength: 64,
  description: "App 的稳定 id（app_list 回答里的 app 字段）。",
};

/**
 * A server-minted shared-instance key from `app_list`. Account-scoped Apps
 * omit it; shared Apps require it. It names a partition only — membership is
 * still re-read by the App door on every open and dispatch.
 */
const APP_INSTANCE_FIELD: McpFieldSpec = {
  type: "string",
  maxLength: 96,
  description: "共享 App 的实例标识（app_list 回答里的 instances[].instance）；账户型 App 不填。",
};

/**
 * Agentic-App reads and trusted shared administration. `app_dispatch` is not in this table: its
 * `params` field is a MAP whose keys belong to each App's own `app.yaml`, a
 * shape the closed field tables cannot express — see `APP_DISPATCH_TOOL`.
 */
export const APP_TOOLS: readonly McpToolSpec[] = [
  {
    name: "app_shared_create", group: "apps",
    description: "创建共享项目并将令牌持有人登记为创建者。需要独立的共享管理授权和既有发布者信任；角色取自 app_list。创建后通过 app_dispatch 配置项目内容。结果未知时先用 app_list 核对，不能盲目重试。",
    gate: { subject: "mcp", operation: "manage_shared_apps" },
    fields: { app: APP_FIELD, role: { type: "string", required: true, maxLength: 64, description: "app_list 声明的角色名。" } },
  },
  {
    name: "app_shared_members", group: "apps",
    description: "创建者读取指定共享项目的成员、角色和容量；不枚举其他项目或账号目录。",
    gate: { subject: "mcp", operation: "read_app_members" },
    fields: { app: APP_FIELD, instance: { ...APP_INSTANCE_FIELD, required: true } },
  },
  {
    name: "app_shared_set_member", group: "apps",
    description: "由创建者添加已注册成员或修改其角色；角色容量由可信存储检查，降权立即关闭该成员旧连接。member 是受管理的目标账号，操作者始终来自令牌。",
    gate: { subject: "mcp", operation: "manage_shared_apps" },
    fields: { app: APP_FIELD, instance: { ...APP_INSTANCE_FIELD, required: true },
      member: { type: "string", required: true, maxLength: 64, description: "要添加或修改的已注册账号。" },
      role: { type: "string", required: true, maxLength: 64, description: "app_list 声明的角色名。" } },
  },
  {
    name: "app_shared_remove_member", group: "apps",
    description: "创建者移除指定成员并立即关闭其旧连接；不能移除创建者。",
    gate: { subject: "mcp", operation: "manage_shared_apps" },
    fields: { app: APP_FIELD, instance: { ...APP_INSTANCE_FIELD, required: true },
      member: { type: "string", required: true, maxLength: 64, description: "要移除的成员账号。" } },
  },
  {
    name: "app_shared_close", group: "apps",
    description: "创建者关闭共享实例并停止所有连接；保留历史。不是科研项目的 archive/reopen 状态动作。",
    gate: { subject: "mcp", operation: "manage_shared_apps" },
    fields: { app: APP_FIELD, instance: { ...APP_INSTANCE_FIELD, required: true } },
  },

  {
    name: "app_list",
    description:
      "列出你可通过 MCP 操作的 Agentic App：id、标题、当前 release 指纹，以及每个 App 面向 agent 声明的动作与参数 schema"
      + "（app_dispatch 用得到）。",
    group: "apps",
    gate: { subject: "mcp", operation: "list_apps" },
    fields: {},
  },
  {
    name: "app_read_projection",
    description:
      "读取一个 App 为你投影的当前状态与版本号 — 与页面所见相同的投影路径。投影不限大小，单次回答约 256K 字符："
      + "放得下就整份返回（projection）；放不下时返回子项分页（projection_page：每个子项要么完整、要么只给 omitted_chars，"
      + "用更长的 path 下钻），超长字符串返回字符分页（projection_text）；用回答里的 next 作为 cursor 翻页。",
    group: "apps",
    gate: { subject: "mcp", operation: "read_app_projection" },
    fields: {
      app: APP_FIELD,
      instance: APP_INSTANCE_FIELD,
      path: {
        type: "string",
        maxLength: 4096,
        description: "可选：JSON Pointer（RFC 6901，如 /rows/12/title），只读投影里的这一部分；缺省为整份投影。",
      },
      cursor: {
        type: "number",
        integer: true,
        min: 0,
        description: "可选：目标放不下一页时，从第几个子项（字符串则为字符偏移）开始；用上一页回答里的 next。",
      },
    },
  },
  {
    name: "app_read_log",
    description:
      "按提交分页读取一个 App 状态流的历史：每条含 seq 区间、时间、操作者、动作名、参数摘要与后端代码指纹。"
      + "不含参数原文和事件内容；看现状用 app_read_projection。",
    group: "apps",
    gate: { subject: "mcp", operation: "read_app_log" },
    fields: {
      app: APP_FIELD,
      instance: APP_INSTANCE_FIELD,
      since_seq: {
        type: "number",
        integer: true,
        min: 0,
        description: "只返回 seq 大于此值的提交；缺省 0（从头读）。用上一页最后一条的 seq_to 翻页。",
      },
      limit: {
        type: "number",
        integer: true,
        min: 1,
        max: 100,
        description: "最多返回多少条提交；缺省 50，上限 100。",
      },
    },
  },
];

/**
 * The dispatch tool, spelled by hand because `params` is a map: its keys and
 * bounds belong to each App's declaration, and the EXACT per-action schema is
 * published in `app_list`'s answer rather than re-declared here. The top level
 * stays closed; undeclared param KEYS are refused by the surface against the
 * same manifest table the door normalises with, so an invented argument never
 * reads as accepted.
 */
export const APP_DISPATCH_TOOL: { definition: McpToolDefinition; gate: McpToolGate } = {
  gate: { subject: "mcp", operation: "dispatch_app_action" },
  definition: {
    name: "app_dispatch",
    description:
      "向一个 App 提交它声明过的动作（动作与参数 schema 见 app_list）。动作先过 App 自己的规则校验，被拒绝时返回结构化 refusal；"
      + "标记「仅限本人」的动作对令牌永远拒绝。成功后返回新的版本号，可用 app_read_log 复核这次提交。",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", maxLength: 64, description: APP_FIELD.description },
        instance: { type: "string", maxLength: 96, description: APP_INSTANCE_FIELD.description },
        action: { type: "string", maxLength: 64, description: "动作名（app_list 回答里 actions[].name）。" },
        params: {
          type: "object",
          description: "动作参数：扁平键值表。键、类型与长度上限见 app_list 里该动作的 parameters。",
          additionalProperties: { type: ["string", "number", "boolean"] },
        },
      },
      required: ["app", "action"],
      additionalProperties: false,
    },
  },
};

/**
 * The three synchronisation verbs, derived from the contract declaration — the
 * same derivation decision 5 prescribes, so the schema an agent reads carries
 * the declaration's exact bounds and refusal vocabulary.
 *
 * `list_docs` joined the DECLARATION on 2026-08-10 (the App plane needed a
 * bootstrap verb too), so its derived twin is filtered here: this surface
 * already ships `CRDT_LIST_TOOL`, whose description is written for a token
 * holder rather than a View, and two `crdt_list_docs` rows in one tool table
 * would be one answer published twice.
 */
const CRDT_DERIVED: readonly McpToolDefinition[] = mcpToolsOf(CRDT_DOC_DECLARATION, { namePrefix: "crdt" });

const CRDT_GATES: Readonly<Record<string, string>> = Object.fromEntries(
  CRDT_DOC_DECLARATION.actionIds.map((id) => [
    `crdt_${id}`,
    CRDT_DOC_DECLARATION.byAction[id].operation ?? "read_document",
  ]),
);

export interface McpCrdtTool {
  definition: McpToolDefinition;
  gate: McpToolGate;
  /** The contract action id (`open_doc` …), for the provider dispatch. */
  action: string;
}

export const CRDT_TOOLS: readonly McpCrdtTool[] = CRDT_DERIVED
  .filter((definition) => definition.name !== "crdt_list_docs")
  .map((definition) => ({
    definition,
    action: definition.name.slice("crdt_".length),
    gate: { subject: "mcp", operation: CRDT_GATES[definition.name] },
  }));

/**
 * The list tool, spelled by hand rather than derived.
 *
 * `crdt-doc/v1` gained its own `list_docs` on 2026-08-10, so a derived twin
 * exists; this one is kept (and the derived one filtered above) because the
 * description a TOKEN holder reads differs from the contract's View-facing
 * summary, and its answer shape is this surface's own. It lists the owner's
 * OWN documents to the owner's OWN token — the same disclosure the trusted
 * shell makes when it builds a link.
 */
export const CRDT_LIST_TOOL: McpToolSpec = {
  name: "crdt_list_docs",
  description: "列出你可访问的协作文档（ref + 标题）。ref 供 crdt_open_doc / crdt_read_updates / crdt_apply_update 使用。",
  group: "crdt",
  gate: { subject: "mcp", operation: "read_document" },
  fields: {},
};

// ── derivations ──

interface JsonSchemaObject {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
}

export function toolDefinitionOf(spec: McpToolSpec): McpToolDefinition {
  if (spec.group === "runner_capabilities") return RUNNER_EXTENSION_MCP_TOOLS.find(tool => tool.name === spec.name)!;
  if (spec.group === "transcription") return MEETING_TRANSCRIPTION_MCP_TOOLS.find(tool => tool.name === spec.name)!;
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(spec.fields)) {
    const out: Record<string, unknown> = { type: field.type, description: field.description };
    if (field.enum !== undefined) out.enum = [...field.enum];
    if (field.maxLength !== undefined) out.maxLength = field.maxLength;
    if (field.min !== undefined) out.minimum = field.min;
    if (field.max !== undefined) out.maximum = field.max;
    if (field.integer) out.type = "integer";
    properties[name] = out;
    if (field.required) required.push(name);
  }
  const schema: JsonSchemaObject = { type: "object", properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return { name: spec.name, description: spec.description, inputSchema: schema as McpToolDefinition["inputSchema"] };
}

export type ToolArgsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

/** The call-time half of the same table `toolDefinitionOf` derives from. */
export function readToolArgs(spec: McpToolSpec, raw: unknown): ToolArgsResult {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "arguments 必须是对象" };
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(spec.fields, key)) {
      return { ok: false, message: `未声明的参数：${key}` };
    }
  }
  const value: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(spec.fields)) {
    const v = input[name];
    if (v === undefined || v === null) {
      if (field.required) return { ok: false, message: `缺少必填参数：${name}` };
      continue;
    }
    switch (field.type) {
      case "string": {
        if (typeof v !== "string") return { ok: false, message: `${name} 必须是字符串` };
        if (field.maxLength !== undefined && v.length > field.maxLength) {
          return { ok: false, message: `${name} 超过上限 ${field.maxLength} 字符` };
        }
        if (field.enum && !field.enum.includes(v)) {
          return { ok: false, message: `${name} 只能是 ${field.enum.join("/")}` };
        }
        value[name] = v;
        break;
      }
      case "number": {
        if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, message: `${name} 必须是数字` };
        if (field.integer && !Number.isInteger(v)) return { ok: false, message: `${name} 必须是整数` };
        if (field.min !== undefined && v < field.min) return { ok: false, message: `${name} 不能小于 ${field.min}` };
        if (field.max !== undefined && v > field.max) return { ok: false, message: `${name} 不能大于 ${field.max}` };
        value[name] = v;
        break;
      }
      case "boolean": {
        if (typeof v !== "boolean") return { ok: false, message: `${name} 必须是布尔值` };
        value[name] = v;
        break;
      }
    }
  }
  return { ok: true, value };
}
