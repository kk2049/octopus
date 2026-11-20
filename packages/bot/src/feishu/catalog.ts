/**
 * Closed, reviewed mapping from Octopus operations to the pinned lark-mcp
 * surface plus the one built-in file upload/send operation.
 *
 * Identity and privilege are catalog facts. `FEISHU_USER_CATALOG` contains
 * things an ordinary account may do with its own UAT. Administrative UAT
 * mutations and every tenant-token-only tool live in
 * `FEISHU_PRIVILEGED_CATALOG`; they are absent from ordinary grants even when
 * the account happens to have the corresponding Feishu role. The two
 * bot-internal sends remain a third, trusted-control-plane-only catalog.
 */

import type { OperationSpec } from "@claude-bot/capability-kernel";
import { parseResourceUri } from "../authorization/namespace.js";
import { describeLarkCliRequest, LARK_CLI_DOMAINS, LARK_CLI_TOOL, parseLarkCliRequest } from "./lark-cli.js";

export type CredentialMode = "user_oauth" | "service_account";
export type FeishuRisk = "read" | "write" | "external-send" | "admin";
export type FeishuResource = "document" | "wiki" | "calendar" | "task" | "user" | "chat" | "bitable" | "lark_cli";
export interface FeishuReferenceField {
  kinds: FeishuReferenceKind | readonly FeishuReferenceKind[];
  multiple?: boolean;
}


export interface FeishuOperation {
  operation: string;
  title: string;
  description: string;
  spec: OperationSpec;
  credentialMode: CredentialMode;
  scopes: readonly string[];
  resource: FeishuResource;
  risk: FeishuRisk;
  tool: string;
  references?: Readonly<Record<string, FeishuReferenceField>>;
  payload(args: Readonly<Record<string, unknown>>): Record<string, unknown>;
  /** Approval-card lines for the arguments, when the generic one-line-per-argument view would hide what matters. */
  describe?(args: Readonly<Record<string, unknown>>): string[];
  /** Agent-facing field descriptions; the default is "<title> · <name>". */
  argDescriptions?: Readonly<Record<string, string>>;
  /**
   * A write its owner may let run without per-call approval, by granting it in
   * the permission center. Absent, a write always asks.
   */
  ownerMayAutoAllow?: boolean;
  version: string;
}

const S = (maxLength: number, required = false) => ({ type: "string" as const, required, maxLength });

/**
 * Inline file bytes for `message_send_file_as_bot`, in base64 characters. One
 * capability call carries at most 512 KiB of JSON arguments (the kernel's
 * per-call window, `capability-kernel/src/objects.ts`); the other fields take
 * well under 8 KiB even fully escaped, so this much always fits: about 378 KiB
 * of file. Larger files go by reference (`SEND_FILE_SOURCE_ARGS`).
 */
export const SEND_FILE_BASE64_MAX = 512 * 1024 - 8 * 1024;

/** Feishu's own ceiling for `im/v1/files`: 30 MB, and no empty files. */
export const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024;

/**
 * The by-reference form of `message_send_file_as_bot`: a file in one of the
 * owner's registered workspaces on the device of the calling session, read in
 * windows when the send executes and checked against the size and SHA-256 the
 * owner approved. These arguments are set only by the trusted MCP surface from
 * the authenticated caller session (the `issuer` precedent); they are never
 * part of the agent-facing schema, which takes a `path` instead.
 */
export const SEND_FILE_SOURCE_ARGS = ["source_device", "source_workspace", "source_path", "file_size", "file_sha256"] as const;
const N = (min: number, max: number) => ({ type: "number" as const, min, max, integer: true });
const B = () => ({ type: "boolean" as const });
const uat = (body: Record<string, unknown>): Record<string, unknown> => ({ ...body, useUAT: true });
const csv = (value: unknown): string[] | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.split(",").map((part) => part.trim()).filter(Boolean);
};
const jsonObject = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== "string") return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} 必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
};

export type FeishuReferenceKind = "people" | "chats";

function feishuReference(
  value: unknown,
  expected: FeishuReferenceKind | readonly FeishuReferenceKind[],
  field: string,
): { kind: FeishuReferenceKind; id: string } {
  if (typeof value !== "string") throw new Error(`${field} 必须是飞书资源 URL`);
  const parsed = parseResourceUri(value, field);
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (
    parsed.scheme !== "feishu"
    || !allowed.includes(parsed.authority as FeishuReferenceKind)
    || parsed.segments.length !== 1
  ) {
    throw new Error(`${field} 必须是 ${allowed.map((kind) => `feishu://${kind}/<id>`).join(" 或 ")}`);
  }
  return { kind: parsed.authority as FeishuReferenceKind, id: parsed.segments[0]! };
}

function feishuReferences(value: unknown, expected: FeishuReferenceKind, field: string): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${field} 必须是逗号分隔的飞书资源 URL`);
  const values = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${field} 至少需要一个飞书资源 URL`);
  return values.map((item) => feishuReference(item, expected, field).id);
}

export function canonicalizeFeishuOperationArgs(
  entry: FeishuOperation,
  args: Readonly<Record<string, unknown>>,
  resolve: (value: string, expected: FeishuReferenceKind | readonly FeishuReferenceKind[]) => string,
): Record<string, unknown> {
  if (!entry.references) return { ...args };
  const canonical = { ...args };
  for (const [field, reference] of Object.entries(entry.references)) {
    const value = args[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") throw new Error(`${field} 必须是飞书资源 URL`);
    canonical[field] = reference.multiple
      ? value.split(",").map((item) => resolve(item.trim(), reference.kinds)).join(",")
      : resolve(value, reference.kinds);
  }
  return canonical;
}

/** User-OAuth operations available to every connected user by default. */
export const FEISHU_USER_CATALOG: readonly FeishuOperation[] = [
  {
    operation: "doc_read", title: "读取云文档正文", description: "按文档 id 读取你有权访问的云文档纯文本正文。",
    spec: { args: { document_id: S(128, true) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["docx:document:readonly"], resource: "document", risk: "read", tool: "docx_v1_document_rawContent",
    payload: (a) => uat({ path: { document_id: a.document_id } }), version: "1",
  },
  {
    operation: "doc_metadata_read", title: "读取云文档版本", description: "读取真实文档的标题和版本号，用于核对同步范围。",
    spec: { args: { document_id: S(128, true) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["docx:document:readonly"], resource: "document", risk: "read", tool: "docx_v1_document_get",
    payload: (a) => uat({ path: { document_id: a.document_id } }), version: "1",
  },
  {
    operation: "doc_blocks_list", title: "列出云文档内容块", description: "分页列出文档块，供用户明确选择要同步的中文大纲范围。",
    spec: { args: { document_id: S(128, true), page_size: N(1, 100), page_token: S(512) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["docx:document:readonly"], resource: "document", risk: "read", tool: "docx_v1_documentBlock_list",
    payload: (a) => uat({ path: { document_id: a.document_id }, params: { page_size: a.page_size ?? 100, page_token: a.page_token } }), version: "1",
  },
  {
    operation: "doc_block_read", title: "读取云文档内容块", description: "读取明确选择的文档块；保留文档版本。",
    spec: { args: { document_id: S(128, true), block_id: S(160, true), revision: N(0, 2147483647) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["docx:document:readonly"], resource: "document", risk: "read", tool: "docx_v1_documentBlock_get",
    payload: (a) => uat({ path: { document_id: a.document_id, block_id: a.block_id }, params: { document_revision_id: a.revision } }), version: "1",
  },
  {
    operation: "doc_block_write", title: "更新云文档大纲块", description: "以自己的飞书身份更新指定文本块；其余文档内容不变。",
    spec: { args: { document_id: S(128, true), block_id: S(160, true), revision: { ...N(0, 2147483647), required: true }, text: S(20000, true), client_token: S(64, true) }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["docx:document"], resource: "document", risk: "write", tool: "docx_v1_documentBlock_patch",
    payload: (a) => uat({ path: { document_id: a.document_id, block_id: a.block_id }, params: { document_revision_id: a.revision, client_token: a.client_token }, data: { update_text_elements: { elements: [{ text_run: { content: a.text } }] } } }), version: "1",
  },
  {
    operation: "doc_search", title: "搜索云文档", description: "按关键词搜索你有权访问的云文档。",
    spec: { args: { query: S(256, true), count: N(1, 50) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["search:docs:read"], resource: "document", risk: "read", tool: "docx_builtin_search",
    payload: (a) => uat({ data: { search_key: a.query, count: a.count ?? 10 } }), version: "2",
  },
  {
    operation: "doc_create", title: "创建云文档", description: "用 Markdown 正文导入一篇新的云文档。",
    spec: { args: { file_name: S(200, true), markdown: S(512 * 1024, true) }, effect: "modify" },
    credentialMode: "user_oauth", scopes: ["docs:document:import"], resource: "document", risk: "write",
    tool: "docx_builtin_import", payload: (a) => uat({ data: { file_name: a.file_name, markdown: a.markdown } }), version: "2",
  },
  {
    operation: "wiki_list_spaces", title: "列出知识空间", description: "列出你有权访问的知识空间。",
    spec: { args: { page_size: N(1, 50), page_token: S(256) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["wiki:space:read"], resource: "wiki", risk: "read", tool: "wiki_v2_space_list",
    payload: (a) => uat({ params: { page_size: a.page_size ?? 20, page_token: a.page_token } }), version: "2",
  },
  {
    operation: "wiki_list_nodes", title: "列出知识空间节点", description: "列出知识空间或父节点下的节点。",
    spec: { args: { space_id: S(128, true), parent_node_token: S(256), page_size: N(1, 50), page_token: S(256) }, effect: "read" },
    credentialMode: "user_oauth", scopes: ["wiki:node:read"], resource: "wiki", risk: "read", tool: "wiki_v2_spaceNode_list",
    payload: (a) => uat({ path: { space_id: a.space_id }, params: { parent_node_token: a.parent_node_token, page_size: a.page_size ?? 20, page_token: a.page_token } }), version: "2",
  },
  {
    operation: "wiki_get_node", title: "读取 Wiki 节点", description: "按链接 token 读取 Wiki 节点信息。",
    spec: { args: { token: S(256, true), obj_type: S(32) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["wiki:node:read"], resource: "wiki", risk: "read", tool: "wiki_v2_space_getNode",
    payload: (a) => uat({ params: { token: a.token, obj_type: a.obj_type } }), version: "2",
  },
  {
    operation: "wiki_search", title: "搜索 Wiki", description: "全局或按知识空间搜索 Wiki 节点。",
    spec: { args: { query: S(256, true), space_id: S(128), node_id: S(128) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["wiki:node:read"], resource: "wiki", risk: "read", tool: "wiki_v1_node_search",
    payload: (a) => uat({ data: { query: a.query, space_id: a.space_id, node_id: a.node_id } }), version: "2",
  },
  {
    operation: "chat_list", title: "列出我的会话", description: "列出当前用户有权查看的飞书会话。",
    spec: { args: { page_size: N(1, 100), page_token: S(256) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["im:chat:readonly"], resource: "chat", risk: "read", tool: "im_v1_chat_list",
    payload: (a) => uat({ params: { page_size: a.page_size ?? 50, page_token: a.page_token } }), version: "1",
  },
  {
    operation: "chat_list_members", title: "列出会话成员", description: "列出 feishu://chats/<chat-id> 会话的成员。",
    spec: { args: { chat_ref: S(512, true), page_size: N(1, 100), page_token: S(256) }, effect: "read" }, credentialMode: "user_oauth",
    references: { chat_ref: { kinds: "chats" } },
    scopes: ["im:chat.members:read"], resource: "chat", risk: "read", tool: "im_v1_chatMembers_get",
    payload: (a) => uat({ path: { chat_id: feishuReference(a.chat_ref, "chats", "chat_ref").id }, params: { member_id_type: "open_id", page_size: a.page_size ?? 50, page_token: a.page_token } }), version: "2",
  },
  {
    operation: "bitable_create_app", title: "创建多维表格", description: "创建一个新的多维表格应用。",
    spec: { args: { name: S(200, true), folder_token: S(256) }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["base:app:create"], resource: "bitable", risk: "write", tool: "bitable_v1_app_create",
    payload: (a) => uat({ data: { name: a.name, folder_token: a.folder_token } }), version: "1",
  },
  {
    operation: "bitable_create_table", title: "创建数据表", description: "在多维表格应用内创建一张数据表。",
    spec: { args: { app_token: S(256, true), name: S(200, true), default_view_name: S(200) }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["bitable:app"], resource: "bitable", risk: "write", tool: "bitable_v1_appTable_create",
    payload: (a) => uat({ path: { app_token: a.app_token }, data: { table: { name: a.name, default_view_name: a.default_view_name } } }), version: "1",
  },
  {
    operation: "bitable_list_tables", title: "列出数据表", description: "列出多维表格应用中的数据表。",
    spec: { args: { app_token: S(256, true), page_size: N(1, 100), page_token: S(256) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["base:table:read"], resource: "bitable", risk: "read", tool: "bitable_v1_appTable_list",
    payload: (a) => uat({ path: { app_token: a.app_token }, params: { page_size: a.page_size ?? 50, page_token: a.page_token } }), version: "1",
  },
  {
    operation: "bitable_list_fields", title: "列出字段", description: "列出一张多维表格数据表的字段。",
    spec: { args: { app_token: S(256, true), table_id: S(256, true), page_size: N(1, 100), page_token: S(256) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["base:field:read"], resource: "bitable", risk: "read", tool: "bitable_v1_appTableField_list",
    payload: (a) => uat({ path: { app_token: a.app_token, table_id: a.table_id }, params: { page_size: a.page_size ?? 50, page_token: a.page_token } }), version: "1",
  },
  {
    operation: "bitable_search_records", title: "搜索记录", description: "按视图或过滤条件搜索多维表格记录。",
    spec: { args: { app_token: S(256, true), table_id: S(256, true), view_id: S(256), filter_json: S(32 * 1024), field_names: S(8192), page_size: N(1, 500), page_token: S(256) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["base:record:read"], resource: "bitable", risk: "read", tool: "bitable_v1_appTableRecord_search",
    payload: (a) => uat({ path: { app_token: a.app_token, table_id: a.table_id }, params: { page_size: a.page_size ?? 100, page_token: a.page_token }, data: { view_id: a.view_id, field_names: csv(a.field_names), ...(a.filter_json ? { filter: jsonObject(a.filter_json, "filter_json") } : {}) } }), version: "1",
  },
  {
    operation: "bitable_create_record", title: "创建记录", description: "用明确给出的字段 JSON 创建一条多维表格记录。",
    spec: { args: { app_token: S(256, true), table_id: S(256, true), fields_json: S(128 * 1024, true) }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["base:record:create"], resource: "bitable", risk: "write", tool: "bitable_v1_appTableRecord_create",
    payload: (a) => uat({ path: { app_token: a.app_token, table_id: a.table_id }, data: { fields: jsonObject(a.fields_json, "fields_json") } }), version: "1",
  },
  {
    operation: "bitable_update_record", title: "更新记录", description: "用明确给出的字段 JSON 更新一条多维表格记录。",
    spec: { args: { app_token: S(256, true), table_id: S(256, true), record_id: S(256, true), fields_json: S(128 * 1024, true) }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["base:record:update"], resource: "bitable", risk: "write", tool: "bitable_v1_appTableRecord_update",
    payload: (a) => uat({ path: { app_token: a.app_token, table_id: a.table_id, record_id: a.record_id }, data: { fields: jsonObject(a.fields_json, "fields_json") } }), version: "1",
  },
  {
    operation: "calendar_primary", title: "读取主日历 ID", description: "取得当前用户的主日历 ID。",
    spec: { args: {}, effect: "read" }, credentialMode: "user_oauth", scopes: ["calendar:calendar:read"],
    resource: "calendar", risk: "read", tool: "calendar_v4_calendar_primary", payload: () => uat({}), version: "2",
  },
  {
    operation: "calendar_list_events", title: "列出日程", description: "列出某个日历在一段时间内的日程。",
    spec: { args: { calendar_id: S(256, true), start_time: S(32), end_time: S(32), page_size: N(1, 100), page_token: S(256) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["calendar:calendar.event:read"], resource: "calendar", risk: "read", tool: "calendar_v4_calendarEvent_list",
    payload: (a) => uat({ path: { calendar_id: a.calendar_id }, params: { start_time: a.start_time, end_time: a.end_time, page_size: a.page_size ?? 50, page_token: a.page_token } }), version: "2",
  },
  {
    operation: "calendar_get_event", title: "读取日程", description: "读取一个日程的详情。",
    spec: { args: { calendar_id: S(256, true), event_id: S(256, true) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["calendar:calendar.event:read"], resource: "calendar", risk: "read", tool: "calendar_v4_calendarEvent_get",
    payload: (a) => uat({ path: { calendar_id: a.calendar_id, event_id: a.event_id } }), version: "1",
  },
  {
    operation: "calendar_search_events", title: "搜索日程", description: "在当前用户可访问的日历中搜索日程。",
    spec: { args: { query: S(256, true), start_time: S(32), end_time: S(32), page_size: N(1, 100), page_token: S(256) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["calendar:calendar.event:read"], resource: "calendar", risk: "read", tool: "calendar_v4_calendarEvent_search",
    payload: (a) => uat({ data: { query: a.query, filter: { start_time: a.start_time, end_time: a.end_time } }, params: { page_size: a.page_size ?? 50, page_token: a.page_token } }), version: "1",
  },
  {
    operation: "calendar_freebusy", title: "查询忙闲", description: "查询 feishu://people/<open-id> 用户在时间范围内的忙闲状态。",
    spec: { args: { person_ref: S(512, true), time_min: S(64, true), time_max: S(64, true) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["calendar:calendar.free_busy:read"], resource: "calendar", risk: "read", tool: "calendar_v4_freebusy_list",
    references: { person_ref: { kinds: "people" } },
    payload: (a) => uat({ data: { user_id: feishuReference(a.person_ref, "people", "person_ref").id, time_min: a.time_min, time_max: a.time_max } }), version: "2",
  },
  {
    operation: "calendar_create_event", title: "创建日程", description: "在指定日历上创建一个日程（时间戳为秒级）。",
    spec: { args: { calendar_id: S(256, true), summary: S(200, true), description: S(4096), start_timestamp: S(32, true), end_timestamp: S(32, true), timezone: S(64) }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["calendar:calendar.event:create"], resource: "calendar", risk: "write", tool: "calendar_v4_calendarEvent_create",
    payload: (a) => uat({ path: { calendar_id: a.calendar_id }, data: { summary: a.summary, description: a.description, start_time: { timestamp: a.start_timestamp, timezone: a.timezone ?? "Asia/Shanghai" }, end_time: { timestamp: a.end_timestamp, timezone: a.timezone ?? "Asia/Shanghai" } } }), version: "2",
  },
  {
    operation: "calendar_update_event", title: "修改日程", description: "修改日程的标题、描述或起止时间。",
    spec: { args: { calendar_id: S(256, true), event_id: S(256, true), summary: S(200), description: S(4096), start_timestamp: S(32), end_timestamp: S(32), timezone: S(64) }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["calendar:calendar.event:update"], resource: "calendar", risk: "write", tool: "calendar_v4_calendarEvent_patch",
    payload: (a) => {
      const event: Record<string, unknown> = {};
      const updateFields: string[] = [];
      for (const field of ["summary", "description"] as const) if (a[field] !== undefined) { event[field] = a[field]; updateFields.push(field); }
      if (a.start_timestamp !== undefined) { event.start_time = { timestamp: a.start_timestamp, timezone: a.timezone ?? "Asia/Shanghai" }; updateFields.push("start_time"); }
      if (a.end_timestamp !== undefined) { event.end_time = { timestamp: a.end_timestamp, timezone: a.timezone ?? "Asia/Shanghai" }; updateFields.push("end_time"); }
      return uat({ path: { calendar_id: a.calendar_id, event_id: a.event_id }, data: { event, update_fields: updateFields } });
    }, version: "1",
  },
  {
    operation: "calendar_delete_event", title: "删除日程", description: "删除指定日历上的一个日程。",
    spec: { args: { calendar_id: S(256, true), event_id: S(256, true) }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["calendar:calendar"], resource: "calendar", risk: "write", tool: "calendar_v4_calendarEvent_delete",
    payload: (a) => uat({ path: { calendar_id: a.calendar_id, event_id: a.event_id } }), version: "2",
  },
  {
    operation: "task_list", title: "列出任务", description: "列出当前用户的任务。",
    spec: { args: { page_size: N(1, 100), page_token: S(256) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["task:task:read"], resource: "task", risk: "read", tool: "task_v2_task_list",
    payload: (a) => uat({ params: { page_size: a.page_size ?? 50, page_token: a.page_token } }), version: "1",
  },
  {
    operation: "task_get", title: "读取任务", description: "读取一个任务的详情。",
    spec: { args: { task_guid: S(128, true) }, effect: "read" }, credentialMode: "user_oauth", scopes: ["task:task:read"],
    resource: "task", risk: "read", tool: "task_v2_task_get", payload: (a) => uat({ path: { task_guid: a.task_guid } }), version: "1",
  },
  {
    operation: "task_create", title: "创建任务", description: "创建一个任务（截止时间为毫秒级时间戳），可用 feishu://people/<open-id> 指定负责人。",
    spec: { args: { summary: S(200, true), description: S(4096), due_timestamp_ms: S(32), assignee_ref: S(512) }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["task:task:write"], resource: "task", risk: "write", tool: "task_v2_task_create",
    references: { assignee_ref: { kinds: "people" } },
    payload: (a) => uat({ data: { summary: a.summary, description: a.description, ...(a.due_timestamp_ms ? { due: { timestamp: a.due_timestamp_ms, is_all_day: false } } : {}), ...(a.assignee_ref ? { members: [{ id: feishuReference(a.assignee_ref, "people", "assignee_ref").id, type: "user", role: "assignee" }] } : {}) } }), version: "2",
  },
  {
    operation: "task_patch", title: "修改任务", description: "修改任务的标题或描述。",
    spec: { args: { task_guid: S(128, true), summary: S(200), description: S(4096) }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["task:task:write"], resource: "task", risk: "write", tool: "task_v2_task_patch",
    payload: (a) => {
      const task: Record<string, unknown> = {}; const updateFields: string[] = [];
      for (const field of ["summary", "description"] as const) if (a[field] !== undefined) { task[field] = a[field]; updateFields.push(field); }
      return uat({ path: { task_guid: a.task_guid }, data: { task, update_fields: updateFields } });
    }, version: "1",
  },
  {
    operation: "task_delete", title: "删除任务", description: "删除一个任务。",
    spec: { args: { task_guid: S(128, true) }, effect: "modify" }, credentialMode: "user_oauth", scopes: ["task:task:write"],
    resource: "task", risk: "write", tool: "task_v2_task_delete", payload: (a) => uat({ path: { task_guid: a.task_guid } }), version: "1",
  },
  {
    operation: "task_add_members", title: "添加任务成员", description: "用 feishu://people/<open-id> 给任务添加一个负责人或关注人。",
    spec: { args: { task_guid: S(128, true), member_ref: S(512, true), role: { type: "string", enum: ["assignee", "follower"] } }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["task:task:write"], resource: "task", risk: "write", tool: "task_v2_task_addMembers",
    payload: (a) => uat({ path: { task_guid: a.task_guid }, data: { members: [{ id: feishuReference(a.member_ref, "people", "member_ref").id, type: "user", role: a.role ?? "assignee" }] } }), version: "2",
    references: { member_ref: { kinds: "people" } },
  },
  {
    operation: "task_add_reminder", title: "添加任务提醒", description: "给任务添加相对截止时间的提醒。",
    spec: { args: { task_guid: S(128, true), relative_fire_minute: N(-525600, 525600) }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["task:task:write"], resource: "task", risk: "write", tool: "task_v2_task_addReminders",
    payload: (a) => uat({ path: { task_guid: a.task_guid }, data: { reminders: [{ relative_fire_minute: a.relative_fire_minute ?? 0 }] } }), version: "1",
  },
  {
    operation: "task_add_tasklist", title: "加入任务清单", description: "把任务加入指定任务清单。",
    spec: { args: { task_guid: S(128, true), tasklist_guid: S(128, true) }, effect: "modify" }, credentialMode: "user_oauth",
    scopes: ["task:tasklist:write"], resource: "task", risk: "write", tool: "task_v2_task_addTasklist",
    payload: (a) => uat({ path: { task_guid: a.task_guid }, data: { tasklist_guid: a.tasklist_guid } }), version: "1",
  },
  {
    operation: "contact_lookup", title: "按邮箱或手机查用户", description: "把邮箱或手机号解析成飞书用户 ID。",
    spec: { args: { email: S(256), mobile: S(64) }, effect: "read" }, credentialMode: "user_oauth",
    scopes: ["contact:user.base:readonly"], resource: "user", risk: "read", tool: "contact_v3_user_batchGetId",
    payload: (a) => uat({ data: { emails: a.email ? [a.email] : undefined, mobiles: a.mobile ? [a.mobile] : undefined }, params: { user_id_type: "open_id" } }), version: "2",
  },
  ...(["read", "write"] as const).map((mode): FeishuOperation => ({
    operation: `lark_cli_${mode}`,
    title: mode === "read" ? "运行 lark-cli 读取命令" : "运行 lark-cli 写入命令",
    description: (mode === "read"
      ? "运行官方飞书 CLI（lark-cli）的只读命令，覆盖幻灯片、云文档、云盘、表格、多维表格、日历、消息、邮件、知识库、任务、会议等全部业务域。"
        + "幻灯片整份 XML 可能有几十万字符：先取页 id（[\"slides\",\"+xml-get\",\"--presentation\",\"<token>\",\"--jq\",\"[.data.xml_presentation.content | scan(\\\"<slide id=.([A-Za-z0-9_-]+)\\\") | .[0]]\"]），再用 --slide-id 逐页读。"
        + "看页面效果：[\"drive\",\"+export\",\"--url\",\"<幻灯片链接>\",\"--file-extension\",\"pdf\"] 加 pdf_pages=\"1-10\" 返回页面图片（不含隐藏页；+screenshot 不可用），"
        + "其余页用 [\"drive\",\"+export-download\",\"--file-token\",\"<结果里的 data.file_token>\"] 加 pdf_pages，不必重新导出。"
        + "只读由 lark-cli 自己的风险标注强制：写命令在这里会被拒绝，请改用 feishu_lark_cli_write。"
        + "不熟悉的命令先查 [\"slides\",\"--help\"]、[\"schema\",\"slides.xml_presentations.get\"] 或 [\"skills\",\"read\",\"lark-slides\"]。"
      : "运行 lark-cli 的写命令（--help 里标为 write 或 high-risk-write），例如 slides 的 +update-slide、+replace-slide、+add-slide、+delete-slide、+media-upload、+history-revert，各业务域的创建、修改、删除，以及原始 api 调用。"
        + "改一页：整页 XML 作为 files 里的 page.xml 传入，用 [\"slides\",\"+update-slide\",\"--presentation\",\"<token>\",\"--slide-id\",\"<id>\",\"--content\",\"@page.xml\"]；只改个别元素用 +replace-slide，细节见各命令 --help。"
        + "账号主人在权限中心授予后直接执行；若返回待批准，请本人批准后用完全相同的参数再调用一次取回结果，不要换参数重发。high-risk-write 命令按 lark-cli 约定在 args 里带 --yes。")
      + "命令在服务器上的隔离目录里运行：路径只能写相对路径；输入文件用 files 传入，命令写出的文件随结果返回。"
      + "auth、config、update、event、apps 等管理与本地开发命令不可用。",
    spec: { args: { args: S(256 * 1024, true), stdin: S(400 * 1024), files: S(500 * 1024), pdf_pages: S(64) }, effect: mode === "read" ? "read" : "modify" },
    credentialMode: "user_oauth",
    // Which scopes a command needs is the CLI's and Feishu's to say; a missing
    // one comes back as the CLI's `missing_scope` envelope.
    scopes: [],
    resource: "lark_cli",
    risk: mode,
    tool: LARK_CLI_TOOL,
    // The owner's call (2026-10-27): CLI writes run unattended once granted.
    ...(mode === "write" ? { ownerMayAutoAllow: true } : {}),
    payload: (a) => ({ ...parseLarkCliRequest(mode, a) }),
    describe: (a) => describeLarkCliRequest(parseLarkCliRequest(mode, a)),
    argDescriptions: {
      args: `lark-cli 之后的参数，JSON 字符串数组，不经过 shell、原样传递。第一个元素是 ${LARK_CLI_DOMAINS.join("、")} 之一。`,
      stdin: "可选：作为标准输入交给命令的文本，对应参数里的 -（例如 --content -）。",
      files: "可选：运行前放进工作目录的输入文件，JSON 数组，每项 {\"path\":\"page.xml\",\"text\":\"…\"} 或 {\"path\":\"fig.png\",\"base64\":\"…\"}；命令里用相对路径或 @page.xml 引用。三个参数合计不超过约 500 KB。",
      pdf_pages: "可选：命令写出 PDF 后，把其中这些页渲染成图片（JPEG，宽 1280 像素）随结果返回，例如 \"1-5\"、\"3\"、\"1,4,7\"，每次最多 10 页。",
    },
    version: "1",
  })),
];

/** Explicit-only operations. They are never part of an ordinary user grant. */
export const FEISHU_PRIVILEGED_CATALOG: readonly FeishuOperation[] = [
  {
    operation: "chat_add_members", title: "向群聊添加成员", description: "以用户身份把 feishu://people/<open-id> 成员加入指定群聊（特权能力）。",
    spec: { args: { chat_ref: S(512, true), member_refs: S(8192, true) }, effect: "modify" }, credentialMode: "user_oauth",
    references: {
      chat_ref: { kinds: "chats" },
      member_refs: { kinds: "people", multiple: true },
    },
    scopes: ["im:chat.members:write_only"], resource: "chat", risk: "admin", tool: "im_v1_chatMembers_create",
    payload: (a) => uat({
      path: { chat_id: feishuReference(a.chat_ref, "chats", "chat_ref").id },
      params: { member_id_type: "open_id" },
      data: { id_list: feishuReferences(a.member_refs, "people", "member_refs") ?? [] },
    }), version: "2",
  },
  {
    operation: "chat_remove_members", title: "从群聊移除成员", description: "以用户身份从指定群聊移除 feishu://people/<open-id> 成员（特权能力）。",
    spec: { args: { chat_ref: S(512, true), member_refs: S(8192, true) }, effect: "modify" }, credentialMode: "user_oauth",
    references: {
      chat_ref: { kinds: "chats" },
      member_refs: { kinds: "people", multiple: true },
    },
    scopes: ["im:chat.members:write_only"], resource: "chat", risk: "admin", tool: "im_v1_chatMembers_delete",
    payload: (a) => uat({
      path: { chat_id: feishuReference(a.chat_ref, "chats", "chat_ref").id },
      params: { member_id_type: "open_id" },
      data: { id_list: feishuReferences(a.member_refs, "people", "member_refs") ?? [] },
    }), version: "2",
  },
  {
    operation: "document_grant_member", title: "授予文档权限", description: "给文档或文件授予成员权限（特权能力）。",
    spec: { args: { token: S(256, true), file_type: S(32, true), member_type: { type: "string", required: true, enum: ["email", "openid", "unionid", "openchat"] }, member_id: S(256, true), perm: { type: "string", required: true, enum: ["view", "edit", "full_access"] }, notify: B() }, effect: "modify" },
    credentialMode: "user_oauth", scopes: ["docs:permission.member:create"], resource: "document", risk: "admin", tool: "drive_v1_permissionMember_create",
    payload: (a) => uat({ path: { token: a.token }, params: { type: a.file_type, need_notification: a.notify ?? true }, data: { member_type: a.member_type, member_id: a.member_id, perm: a.perm } }), version: "2",
  },
  {
    operation: "message_send_as_bot", title: "以系统 Bot 发消息", description: "以租户应用身份向 feishu://people/<open-id> 或 feishu://chats/<chat-id> 发送文本（特权能力）。",
    spec: { args: { target_ref: S(512, true), text: S(8192, true) }, effect: "modify" }, credentialMode: "service_account",
    scopes: [], resource: "chat", risk: "external-send", tool: "im_v1_message_create",
    references: { target_ref: { kinds: ["people", "chats"] } },
    payload: (a) => {
      const target = feishuReference(a.target_ref, ["people", "chats"], "target_ref");
      return {
        params: { receive_id_type: target.kind === "people" ? "open_id" : "chat_id" },
        data: { receive_id: target.id, msg_type: "text", content: JSON.stringify({ text: a.text }) },
      };
    }, version: "2",
  },
  {
    operation: "message_send_file_as_bot", title: "以系统 Bot 发文件", description: `上传文件并以租户应用身份发送给 feishu://people/<open-id> 或 feishu://chats/<chat-id>（特权能力）。飞书接收 1 字节到 30 MB 的文件。二选一：path 指你所在设备上已登记工作区里的文件（读取与批准都按这一份内容的大小和 SHA-256，最大 30 MB）；或 file_base64 内联（一次最多 ${SEND_FILE_BASE64_MAX} 个字符，约 ${Math.floor(SEND_FILE_BASE64_MAX * 3 / 4 / 1024)} KB，这是一次能力调用的参数上限）。`,
    spec: {
      args: {
        target_ref: S(512, true),
        file_name: S(240, true),
        file_type: { type: "string", required: true, enum: ["opus", "mp4", "pdf", "doc", "xls", "ppt", "stream"] },
        file_base64: S(SEND_FILE_BASE64_MAX),
        source_device: S(256),
        source_workspace: S(256),
        source_path: S(4096),
        file_size: N(1, FEISHU_FILE_MAX_BYTES),
        file_sha256: S(64),
      },
      effect: "modify",
    },
    credentialMode: "service_account", scopes: [], resource: "chat", risk: "external-send",
    tool: "octopus_im_file_send",
    references: { target_ref: { kinds: ["people", "chats"] } },
    payload: (a) => {
      const target = feishuReference(a.target_ref, ["people", "chats"], "target_ref");
      const given = SEND_FILE_SOURCE_ARGS.filter((key) => a[key] !== undefined);
      const inline = a.file_base64 !== undefined;
      if (inline === (given.length > 0)) throw new Error("文件内容二选一：file_base64 内联，或按引用（path）发送");
      if (!inline && given.length !== SEND_FILE_SOURCE_ARGS.length) throw new Error("文件引用不完整");
      if (!inline && !/^[0-9a-f]{64}$/.test(String(a.file_sha256))) throw new Error("文件引用的 SHA-256 无效");
      return {
        target_kind: target.kind,
        target_id: target.id,
        file_name: a.file_name,
        file_type: a.file_type,
        ...(inline ? { file_base64: a.file_base64 } : {
          source: { device: a.source_device, workspace: a.source_workspace, path: a.source_path, size: a.file_size, sha256: a.file_sha256 },
        }),
      };
    }, version: "2",
  },
  {
    operation: "message_list_as_bot", title: "以系统 Bot 读取群消息", description: "以租户应用身份读取 feishu://chats/<chat-id> 的消息记录（特权能力）。",
    spec: { args: { chat_ref: S(512, true), start_time: S(32), end_time: S(32), page_size: N(1, 50), page_token: S(256) }, effect: "read" }, credentialMode: "service_account",
    scopes: [], resource: "chat", risk: "admin", tool: "im_v1_message_list",
    references: { chat_ref: { kinds: "chats" } },
    payload: (a) => ({
      params: {
        container_id_type: "chat",
        container_id: feishuReference(a.chat_ref, "chats", "chat_ref").id,
        start_time: a.start_time,
        end_time: a.end_time,
        page_size: a.page_size ?? 50,
        page_token: a.page_token,
        sort_type: "ByCreateTimeAsc",
      },
    }), version: "2",
  },
  {
    operation: "chat_create_as_bot", title: "以系统 Bot 创建群聊", description: "以租户应用身份创建群聊，可用 feishu://people/<open-id> 指定群主和成员（特权能力）。",
    spec: { args: { name: S(200, true), description: S(4096), owner_ref: S(512), member_refs: S(8192) }, effect: "modify" }, credentialMode: "service_account",
    references: {
      owner_ref: { kinds: "people" },
      member_refs: { kinds: "people", multiple: true },
    },
    scopes: [], resource: "chat", risk: "admin", tool: "im_v1_chat_create",
    payload: (a) => ({
      params: { user_id_type: "open_id" },
      data: {
        name: a.name,
        description: a.description,
        owner_id: a.owner_ref ? feishuReference(a.owner_ref, "people", "owner_ref").id : undefined,
        user_id_list: feishuReferences(a.member_refs, "people", "member_refs"),
      },
    }), version: "2",
  },
];

/** Narrow operations held only by the trusted bot control plane. */
export const FEISHU_SYSTEM_CATALOG: readonly FeishuOperation[] = [
  {
    operation: "system_reply_in_chat", title: "在当前会话回复", description: "以系统 Bot 身份在已有会话回复。",
    spec: { args: { chat_id: S(256, true), text: S(8192, true) }, effect: "modify" }, credentialMode: "service_account",
    scopes: [], resource: "chat", risk: "external-send", tool: "im_v1_message_create",
    payload: (a) => ({ params: { receive_id_type: "chat_id" }, data: { receive_id: a.chat_id, msg_type: "text", content: JSON.stringify({ text: a.text }) } }), version: "1",
  },
  {
    operation: "system_send_card", title: "发送审批卡", description: "以系统 Bot 身份发送一张交互卡片。",
    spec: { args: { chat_id: S(256, true), card: S(64 * 1024, true) }, effect: "modify" }, credentialMode: "service_account",
    scopes: [], resource: "chat", risk: "external-send", tool: "im_v1_message_create",
    payload: (a) => ({ params: { receive_id_type: "chat_id" }, data: { receive_id: a.chat_id, msg_type: "interactive", content: a.card } }), version: "1",
  },
];

const index = (catalog: readonly FeishuOperation[]): Record<string, FeishuOperation> => Object.fromEntries(
  catalog.map((entry) => [entry.operation, entry]),
);
export const FEISHU_USER_OPERATIONS = index(FEISHU_USER_CATALOG);
export const FEISHU_PRIVILEGED_OPERATIONS = index(FEISHU_PRIVILEGED_CATALOG);
export const FEISHU_SYSTEM_OPERATIONS = index(FEISHU_SYSTEM_CATALOG);

/** The reviewed Agent surface: pinned lark-mcp operations plus built-ins. */
export const FEISHU_MCP_CATALOG: readonly FeishuOperation[] = Object.freeze([
  ...FEISHU_USER_CATALOG,
  ...FEISHU_PRIVILEGED_CATALOG,
]);
export const CATALOGUED_TOOLS: readonly string[] = [...new Set(
  [...FEISHU_MCP_CATALOG, ...FEISHU_SYSTEM_CATALOG].map((entry) => entry.tool),
)].sort();
export const FEISHU_USER_READ_OPS: readonly string[] = FEISHU_USER_CATALOG
  .filter((entry) => entry.spec.effect === "observe" || entry.spec.effect === "read")
  .map((entry) => entry.operation);
export const FEISHU_USER_OPS: readonly string[] = FEISHU_USER_CATALOG.map((entry) => entry.operation);
/** The most a user's Feishu root lets run unsupervised: reads, and writes their owner may auto-allow. */
export const FEISHU_USER_AUTO_ALLOWABLE_OPS: readonly string[] = FEISHU_USER_CATALOG
  .filter((entry) => entry.spec.effect === "observe" || entry.spec.effect === "read" || entry.ownerMayAutoAllow)
  .map((entry) => entry.operation);
export const FEISHU_PRIVILEGED_OPS: readonly string[] = FEISHU_PRIVILEGED_CATALOG.map((entry) => entry.operation);
export const FEISHU_SYSTEM_OPS: readonly string[] = FEISHU_SYSTEM_CATALOG.map((entry) => entry.operation);

/** MCP descriptors contain business arguments only — never identity fields. */
export function gatewayToolDescriptors(
  allowed: readonly string[],
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const allowedSet = new Set(allowed);
  const out: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
  for (const entry of FEISHU_MCP_CATALOG) {
    if (!allowedSet.has(entry.operation)) continue;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, arg] of Object.entries(entry.spec.args)) {
      properties[name] = { type: arg.type, ...(arg.type === "string" && arg.enum ? { enum: arg.enum } : {}) };
      if (arg.required) required.push(name);
    }
    const privileged = Boolean(FEISHU_PRIVILEGED_OPERATIONS[entry.operation]);
    out.push({
      name: `feishu_${entry.operation}`,
      description: entry.description
        + (privileged ? "（特权能力：每次都需要账号主人在可信面板批准。）" : "")
        + (entry.spec.effect === "read" || entry.spec.effect === "observe"
          ? ""
          : "（需要账号主人在可信面板逐次批准；收到待批准结果后用 feishu_call_result 查询，不要重发。）"),
      inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
    });
  }
  return out;
}
