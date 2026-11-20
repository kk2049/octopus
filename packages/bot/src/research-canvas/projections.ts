import type { Json, Provenance, ResearchNode } from "@claude-bot/research-canvas-contract";

/** Scalars are intentionally the only values an adapter can project. */
export type AdapterScalar = string | number | boolean | null;
export type AdapterView = "table" | "metrics" | "text";
export interface AdapterColumn {
  key: string;
  label: string;
  kind?: "text" | "number" | "boolean" | "date";
}
export interface AdapterSchema {
  view: AdapterView;
  columns: AdapterColumn[];
  primary?: string;
}
export interface AdapterRow {
  id: string;
  cells: Record<string, AdapterScalar>;
}
export interface AdapterTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface AdapterDescriptor {
  tools?: AdapterTool[];
  source: string;
  entry: string;
  schema: AdapterSchema;
  status: "registered" | "live" | "paused" | "removed";
  sourceRevision: string;
  cursor: string | null;
  rows: AdapterRow[];
  publisher: string;
  updatedAt: string;
  error?: string | null;
}
export interface AdapterRegisterInput {
  tools?: AdapterTool[];
  title: string;
  summary?: string;
  source: string;
  entry: string;
  schema: AdapterSchema;
}
export interface AdapterPublishInput {
  sourceRevision: string;
  cursor?: string | null;
  rows: AdapterRow[];
}
export function publisherKey(publisher: Provenance): string {
  // Agent namespaces remain distinct even when two agents share one resource owner.
  return `${publisher.owner}:${publisher.kind === "agent" ? publisher.agent ?? publisher.run ?? "agent" : "human"}`;
}
const MAX_ROWS = 200;
const MAX_COLUMNS = 32;
const MAX_CELL = 4_000;
const MAX_SOURCE = 1_000;
const MAX_ENTRY = 500;
const MAX_SCHEMA = 8_000;

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}无效`);
  return value;
}
function scalar(value: unknown): AdapterScalar {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > MAX_CELL) throw new Error("投影单元格过大");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("投影数值无效");
    return value;
  }
  throw new Error("投影只允许标量单元格");
}
export function normalizeSchema(input: unknown): AdapterSchema {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("适配器 schema 无效");
  const value = input as Record<string, unknown>;
  const view = value.view;
  if (view !== "table" && view !== "metrics" && view !== "text") throw new Error("适配器视图无效");
  if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > MAX_COLUMNS) throw new Error("适配器列无效");
  const keys = new Set<string>();
  const columns = value.columns.map((column) => {
    if (!column || typeof column !== "object" || Array.isArray(column)) throw new Error("适配器列无效");
    const item = column as Record<string, unknown>;
    const key = boundedText(item.key, "适配器列键", 100);
    if (keys.has(key)) throw new Error("适配器列键重复");
    keys.add(key);
    const kind = item.kind;
    if (kind !== undefined && !["text", "number", "boolean", "date"].includes(String(kind))) throw new Error("适配器列类型无效");
    return { key, label: boundedText(item.label, "适配器列名", 100), ...(kind === undefined ? {} : { kind: kind as AdapterColumn["kind"] }) };
  });
  const primary = value.primary === undefined ? undefined : boundedText(value.primary, "适配器主键", 100);
  if (primary !== undefined && !keys.has(primary)) throw new Error("适配器主键必须是列");
  if (JSON.stringify({ view, columns, primary }).length > MAX_SCHEMA) throw new Error("适配器 schema 过大");
  return { view, columns, ...(primary === undefined ? {} : { primary }) };
}
export function normalizeRows(input: unknown, schema: AdapterSchema): AdapterRow[] {
  if (!Array.isArray(input) || input.length > MAX_ROWS) throw new Error("适配器行数超出上限");
  const allowed = new Set(schema.columns.map((column) => column.key));
  return input.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("适配器行无效");
    const value = row as Record<string, unknown>;
    const id = boundedText(value.id, "适配器行 ID", 200);
    if (!value.cells || typeof value.cells !== "object" || Array.isArray(value.cells)) throw new Error("适配器单元格无效");
    const cells: Record<string, AdapterScalar> = {};
    for (const [key, cell] of Object.entries(value.cells as Record<string, unknown>)) {
      if (!allowed.has(key)) throw new Error("适配器写入了未声明列");
      cells[key] = scalar(cell);
    }
    return { id, cells };
  });
}
export function createAdapterDescriptor(input: AdapterRegisterInput, publisher: Provenance, now: string): AdapterDescriptor {
  const source = boundedText(input.source, "适配器来源", MAX_SOURCE);
  const entry = boundedText(input.entry, "适配器入口", MAX_ENTRY);
  const schema = normalizeSchema(input.schema);
  if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 32 || JSON.stringify(input.tools).length > 12000)) throw new Error("插件工具声明过大");
  const tools = input.tools?.map(tool => {
    if (!tool || !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(tool.name) || typeof tool.description !== "string" || tool.description.length > 1000 || !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) throw new Error("插件工具声明无效");
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  });
  if (tools && new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("插件工具名重复");
  return { source, entry, schema, ...(tools ? { tools } : {}), status: "registered", sourceRevision: "", cursor: null, rows: [], publisher: publisherKey(publisher), updatedAt: now, error: null };
}
export function publishAdapter(descriptor: AdapterDescriptor, input: AdapterPublishInput, publisher: Provenance, now: string): AdapterDescriptor {
  if (descriptor.status === "removed") throw new Error("适配器已移除");
  if (descriptor.status === "paused") throw new Error("适配器已暂停");
  if (descriptor.publisher !== publisherKey(publisher)) throw new Error("只有适配器登记者可以发布投影");
  const sourceRevision = boundedText(input.sourceRevision, "来源版本", 300);
  const rows = normalizeRows(input.rows, descriptor.schema);
  return { ...descriptor, status: "live", sourceRevision, cursor: input.cursor === undefined || input.cursor === null ? null : boundedText(input.cursor, "适配器游标", 500), rows, updatedAt: now, error: null };
}
export function controlAdapter(descriptor: AdapterDescriptor, state: AdapterDescriptor["status"], publisher: Provenance, now: string): AdapterDescriptor {
  if (descriptor.publisher !== publisherKey(publisher) && publisher.kind !== "human") throw new Error("只有登记者或项目管理者可以停用适配器");
  if (!["registered", "paused", "removed"].includes(state)) throw new Error("适配器状态无效");
  return { ...descriptor, status: state, updatedAt: now };
}
export function adapterData(node: ResearchNode): AdapterDescriptor {
  const value = node.data.adapter;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("适配器节点数据无效");
  return value as unknown as AdapterDescriptor;
}
/** Keep the adapter namespace separate from normal node metadata when persisted. */
export function asNodeData(descriptor: AdapterDescriptor): Record<string, Json> {
  return { adapter: descriptor as unknown as Json };
}
