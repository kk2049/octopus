import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import type { GraphPatch } from "./graph-crdt.js";
import { createdResourceId, type ResearchContext, type ResearchGraph } from "./graph.js";
import type { ResearchResources } from "./resources.js";
import { digest, parse, text } from "./validation.js";
import type { ResearchDiscussionSources } from "./discussion-sources.js";

export type DiscussionMessage = { message_id: string; sender?: string; body?: string; create_time?: string; truncated?: boolean };
type Page = { items: DiscussionMessage[]; has_more: boolean; page_token?: string };
/** Select a contiguous interval in the provider's newest-first history, across pages. */
export async function readDiscussionRange(read: (cursor?: string) => Promise<Page>, from: string, to: string) {
  const messages: DiscussionMessage[] = [], seen = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined, started = false;
  for (let page = 0; page < 64; page++) {
    const result = await read(cursor);
    if (!Array.isArray(result.items)) throw new Error("群历史格式不可用");
    for (const message of result.items) {
      if (seen.has(message.message_id)) continue;
      seen.add(message.message_id);
      if (message.message_id === to) started = true;
      if (started) {
        if (message.truncated) throw new Error("所选区间含截断消息；请读取完整来源后再归档");
        messages.push(message);
        if (messages.length > 1000 || JSON.stringify(messages).length > 18000) throw new Error("所选讨论过大，请分成更短区间");
        if (message.message_id === from) return messages.reverse();
      } else if (message.message_id === from) throw new Error("讨论起止顺序不正确");
    }
    if (!result.has_more) throw new Error("讨论边界未找到；消息可能已撤回，请重新选择");
    if (!result.page_token || cursors.has(result.page_token)) throw new Error("群历史分页未推进");
    cursors.add(result.page_token); cursor = result.page_token;
  }
  throw new Error("讨论超过本次 64 页读取预算，请缩小区间");
}

/** Plain immutable source file + editable minutes file; only their membership enters CRDT. */
export class ResearchDiscussions {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Set<string>();
  private closed = false;
  constructor(private readonly graph: ResearchGraph, private readonly resources: ResearchResources, private readonly sources?: ResearchDiscussionSources,
    private readonly changed: (project: string) => void = () => {}, private readonly allowed: (context: ResearchContext, operation: string) => boolean = () => true) {}

  async capture(context: ResearchContext, params: Record<string, string>, current: () => void = () => {}) {
    current();
    this.graph.authorize(context, "edit_graph");
    this.graph.node(context.project, params.node);
    const source = this.graph.resolveResource(context.project, params.node);
    if (source.type !== "group") throw new Error("请选择已绑定的群讨论节点");
    const binding = this.resources.binding(context, source.id);
    const from = text(params.from, "首条消息", 200), to = text(params.to, "末条消息", 200);
    const title = text(params.title, "讨论标题", 160);
    const fingerprint = digest({ source: source.id, binding: binding.version, resource: binding.resource, from, to });
    const clientRequest = "capture_" + digest([context.actor.owner, text(params.request, "请求 ID", 100)]).slice(0, 40);
    const previous = this.graph.repo.receipt(context.project, context.actor.owner, clientRequest, fingerprint);
    if (previous) return previous as { record: { id: string; ref: string }; minutes: { id: string; ref: string }; range: unknown; edit: unknown };
    const request = "discussion_" + fingerprint.slice(0, 40);
    const recordRequest = request + "_record", recordId = createdResourceId(context, recordRequest);
    let record = this.graph.repo.get<ResearchNode>(context.project, "node-resources", recordId);
    if (record && (record.data.meta as Record<string, unknown>)?.captureFingerprint !== fingerprint) throw new Error("该请求 ID 已用于另一区间");
    if (!record) {
      const messages = await readDiscussionRange(async cursor => { current(); const result = await this.resources.read(context, { node: source.id, ...(cursor ? { cursor } : {}) }) as Page; current(); return result; }, from, to);
      current();
      const latestBinding = this.resources.binding(context, source.id);
      if (latestBinding.version !== binding.version || latestBinding.resource !== binding.resource) throw new Error("讨论读取期间资源绑定已变化");
      this.graph.authorize(context, "edit_graph");
      const payload = { source: source.id, sourceTitle: source.title, binding: { resource: binding.resource, version: binding.version }, from, to, capturedAt: new Date().toISOString(), messages };
      const rawText = "# 讨论原始记录\n\n```json\n" + JSON.stringify(payload, null, 2) + "\n```";
      if (rawText.length > 20000) throw new Error("所选讨论过大，请分成更短区间");
      record = (this.graph.mutate(context, "ref_create", { request: recordRequest, data: JSON.stringify({ type: "workgroup", title, summary: `${messages.length} 条消息 · 已固定所选区间`, data: { text: rawText, meta: { read_only: true, captureFingerprint: fingerprint, sourceNode: params.node, sourceRevision: digest(messages), sourceAt: payload.capturedAt, rangeFrom: from, rangeTo: to, messageCount: messages.length, excerptKind: "verbatim" } } }) }) as { resource: ResearchNode }).resource;
    }
    const template = "# 讨论纪要（待整理）\n\n## 讨论结论\n待填写，并引用原始记录中的 message_id。\n\n## 待推进事项\n待填写。\n\n## 分歧与不确定性\n待填写；不得将未确认提议记作结论。";
    const minutes = (this.graph.mutate(context, "ref_create", { request: request + "_minutes", data: JSON.stringify({ type: "note", title: record.title + " · 纪要", summary: "待整理；尚未形成研究结论", data: { text: template, meta: { sourceTemplateDigest: digest(template), sourceNode: record.id, sourceRevision: (record.data.meta as Record<string, string>).sourceRevision, excerptKind: "human", status: "todo", acceptanceStatus: "pending" } } }) }) as { resource: ResearchNode }).resource;
    const patches: GraphPatch[] = [
      { bucket: "nodes", id: record.id, field: "create", value: { ref: record.type + ":" + record.id, label: record.title } },
      { bucket: "nodes", id: minutes.id, field: "create", value: { ref: minutes.type + ":" + minutes.id, label: minutes.title } },
      { bucket: "edges", id: request + "_source", field: "create", value: { from: params.node, to: record.id, relation: "contains" } },
      { bucket: "edges", id: request + "_summary", field: "create", value: { from: record.id, to: minutes.id, relation: "contains" } },
      { bucket: "edges", id: request + "_trace", field: "create", value: { from: minutes.id, to: record.id, relation: "依据" } },
    ];
    const edit = this.graph.documents.patch(context, request + "_graph", fingerprint, patches, this.graph.provenance(context));
    if (this.sources) {
      const frozen = this.graph.texts.read(context.project, record).text;
      const payload = JSON.parse(frozen.slice(frozen.indexOf("```json\n") + 8, frozen.lastIndexOf("\n```"))) as { messages: DiscussionMessage[] };
      this.sources.captured(context, { record, minutes, binding, messages: payload.messages });
    }
    const result = { record: { id: record.id, ref: record.type + ":" + record.id }, minutes: { id: minutes.id, ref: minutes.type + ":" + minutes.id }, range: record.data.meta, edit };
    const replay = this.graph.repo.receipt(context.project, context.actor.owner, clientRequest, fingerprint);
    if (replay) return replay as typeof result;
    this.graph.repo.remember(context.project, context.actor.owner, clientRequest, fingerprint, result);
    return result;
  }

  async create(context: ResearchContext, params: Record<string, string>) {
    this.graph.authorize(context, "manage_resources");
    this.graph.authorize(context, "create_discussion_group");
    if (!this.allowed(context, "create_discussion_group")) throw new Error("请先授权创建飞书讨论群");
    const node = this.graph.resourceNode(context.project, params.node);
    if (node.type !== "group") throw new Error("请选择空的飞书群来源");
    const title = text(params.title, "群标题", 100), agenda = text(params.agenda, "群说明", 1000, "");
    const id = "chat_create_" + digest([context.actor.owner, text(params.request, "请求 ID", 100)]).slice(0, 36);
    const fingerprint = digest([node.id, title, agenda]);
    let row = this.graph.repo.get<{ id: string; fingerprint: string; status: string; chat?: string }>(context.project, "discussion-create-outbox", id);
    if (row && row.fingerprint !== fingerprint) throw new Error("建群请求 ID 已用于其他内容");
    if (row && row.status !== "created") throw new Error("上一次建群结果尚未确认，请在飞书核对后手动绑定；不会重复创建");
    if (!row) {
      if (!this.resources.adapters.createGroup) throw new Error("飞书建群资源未配置");
      if (this.graph.repo.get(context.project, "bindings", node.id)) throw new Error("该来源已绑定群，不能覆盖");
      row = { id, fingerprint, status: "creating" };
      this.graph.repo.put(context.project, "discussion-create-outbox", id, row);
      try {
        const chat = await this.resources.adapters.createGroup(context.actor.owner, { title, agenda, request: id });
        row = { ...row, status: "created", chat }; this.graph.repo.put(context.project, "discussion-create-outbox", id, row);
      } catch (error) { this.graph.repo.put(context.project, "discussion-create-outbox", id, { ...row, status: "unknown" }); throw error; }
    }
    if (!this.allowed(context, "create_discussion_group")) throw new Error("建群后授权变化；群已保留，可在飞书核对");
    const result = await this.resources.bind(context, { request: id + "_bind", node: node.id,
      data: JSON.stringify({ kind: "group", resource: row.chat, config: {} }) });
    return { status: "created", chat: row.chat, result };
  }
  async follow(context: ResearchContext, params: Record<string, string>) {
    this.graph.authorize(context, "run_agent");
    if (!this.allowed(context, "run_agent")) throw new Error("请先授权持续接入讨论");
    const binding = this.resources.binding(context, params.node, "group", "run_agent");
    const data = parse(params.data);
    if (typeof data.enabled !== "boolean" || Object.keys(data).some(key => !["enabled", "cursor"].includes(key))) throw new Error("增量接入配置无效");
    const request = text(params.request, "请求 ID", 100), fingerprint = digest([binding.node, binding.version, data]);
    const replay = this.graph.repo.receipt(context.project, context.actor.owner, "follow_" + request, fingerprint);
    if (replay) return replay as { follow: DiscussionFollow };
    const old = this.graph.repo.get<DiscussionFollow>(context.project, "discussion-follows", binding.node);
    let cursor = typeof data.cursor === "string" ? text(data.cursor, "增量起点", 200) : old?.cursor ?? "";
    if (data.enabled && !cursor) {
      const history = await this.resources.read(context, { node: binding.node }) as Page;
      cursor = history.items[0]?.message_id ?? "";
      if (!cursor) throw new Error("群中尚无消息；先导入一条有明确 ID 的记录再启用增量接入");
    }
    const currentBinding = this.resources.binding(context, binding.node, "group", "run_agent");
    if (currentBinding.version !== binding.version || currentBinding.resource !== binding.resource) throw new Error("读取期间群来源绑定已变化");
    if (!this.allowed(context, "run_agent")) throw new Error("增量接入授权已变化");
    const row: DiscussionFollow = { id: binding.node, owner: context.actor.owner, enabled: data.enabled, cursor,
      bindingVersion: binding.version, resource: binding.resource, updatedAt: new Date().toISOString(), lastCheck: 0, version: (old?.version ?? 0) + 1 };
    this.graph.repo.put(context.project, "discussion-follows", row.id, row);
    if (!row.enabled) { const key = `${context.project}:${row.id}`; clearTimeout(this.timers.get(key)); this.timers.delete(key); }
    const result = { follow: row };
    this.graph.repo.remember(context.project, context.actor.owner, "follow_" + request, fingerprint, result);
    this.changed(context.project); return result;
  }
  event(project: string, node: string) {
    const key = `${project}:${node}`, row = this.graph.repo.get<DiscussionFollow>(project, "discussion-follows", node);
    if (this.closed || !row?.enabled || this.timers.has(key) || this.active.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.sync({ project, actor: { kind: "human", owner: row.owner } }, { node }).catch(() => {});
    }, Math.max(1000, 60_000 - (Date.now() - row.lastCheck)));
    timer.unref(); this.timers.set(key, timer);
  }
  async sync(context: ResearchContext, params: Record<string, string>) {
    const node = this.graph.resourceNode(context.project, params.node), key = `${context.project}:${node.id}`;
    const initial = this.graph.repo.get<DiscussionFollow>(context.project, "discussion-follows", node.id);
    if (!initial?.enabled) throw new Error("请先启用这个来源的增量接入");
    if (this.active.has(key)) return { status: "running" };
    const check = () => {
      const current = this.graph.repo.get<DiscussionFollow>(context.project, "discussion-follows", node.id);
      if (this.closed || !current?.enabled || current.version !== initial.version) throw new Error("增量接入已暂停或配置已变化");
      this.graph.authorize(context, "run_agent");
      if (!this.allowed(context, "run_agent")) throw new Error("增量接入授权已撤销");
      const binding = this.resources.binding(context, node.id, "group", "run_agent");
      if (binding.version !== initial.bindingVersion || binding.resource !== initial.resource) throw new Error("群来源绑定已变化，请重新启用接入");
    };
    check(); this.active.add(key);
    try {
      const pending: DiscussionMessage[] = [], seen = new Set<string>(), cursors = new Set<string>();
      let cursor: string | undefined, found = false;
      for (let page = 0; page < 64; page++) {
        check(); const result = await this.resources.read(context, { node: node.id, ...(cursor ? { cursor } : {}) }) as Page; check();
        for (const message of result.items) {
          if (message.message_id === initial.cursor) { found = true; break; }
          if (seen.has(message.message_id)) continue;
          if (message.truncated) throw new Error("增量区间含截断消息；请手动缩小区间");
          seen.add(message.message_id); pending.push(message);
          if (pending.length > 1000 || JSON.stringify(pending).length > 18000) throw new Error("增量区间超出预算；请按区间导入，游标未推进");
        }
        if (found) break;
        if (!result.has_more) throw new Error("增量游标未找到，可能消息撤回；请重新选择已确认起点");
        if (!result.page_token || cursors.has(result.page_token)) throw new Error("增量分页未推进");
        cursors.add(result.page_token); cursor = result.page_token;
      }
      if (!found) throw new Error("增量读取超过 64 页预算，游标未推进");
      if (pending.length) {
        check();
        await this.capture(context, { request: "incremental_" + digest([node.id, initial.cursor, pending[0].message_id]).slice(0, 40),
          node: node.id, from: pending.at(-1)!.message_id, to: pending[0].message_id, title: node.title + " · 增量讨论" }, check);
        check();
      }
      const next: DiscussionFollow = { ...initial, cursor: pending[0]?.message_id ?? initial.cursor, updatedAt: new Date().toISOString(), lastCheck: Date.now(), error: undefined };
      this.graph.repo.put(context.project, "discussion-follows", next.id, next); this.changed(context.project);
      return { status: "completed", imported: pending.length, follow: next };
    } catch (error) {
      const current = this.graph.repo.get<DiscussionFollow>(context.project, "discussion-follows", node.id);
      if (current?.enabled && current.version === initial.version) this.graph.repo.put(context.project, "discussion-follows", node.id, {
        ...current, enabled: false, error: (error instanceof Error ? error.message : "增量读取失败").slice(0, 600), lastCheck: Date.now() });
      this.changed(context.project); throw error;
    } finally { this.active.delete(key); }
  }
  close() { this.closed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
}
interface DiscussionFollow { id: string; owner: string; enabled: boolean; cursor: string; bindingVersion: number; resource: string; updatedAt: string; lastCheck: number; version: number; error?: string }
