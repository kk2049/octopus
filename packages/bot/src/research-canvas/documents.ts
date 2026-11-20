import type { CloudDocumentRead, PaperSyncPreview, PaperSyncStrategy, ResearchCloudDocument, ResearchNode } from "@claude-bot/research-canvas-contract";
import type { ResearchContext, ResearchGraph } from "./graph.js";
import { digest, object, parse, text } from "./validation.js";

export interface CloudDocumentProvider {
  read(owner: string, document: string, current: () => void): Promise<{ text: string; revision: string; blocks: { id: string; text: string; supported: boolean }[] }>;
  readBlock(owner: string, document: string, block: string, current: () => void): Promise<{ text: string; digest: string; revision: number }>;
  writeBlock(owner: string, document: string, block: string, value: string, expected: { digest: string; revision: number }, request: string, current: () => void): Promise<void>;
}
export interface ResearchDocumentIO {
  read(context: ResearchContext, node: string): Promise<{ text: string; digest: string }>;
  write(context: ResearchContext, node: string, value: string, expected: string, request: string, current?: () => void): Promise<void>;
}
interface SyncIntent {
  id: string;
  fingerprint: string;
  status: "writing" | "complete" | "unknown";
  local: { text: string; digest: string };
  cloud: { text: string; digest: string; revision: number };
  desired: string;
  direction: string;
  at: string;
  result?: PaperSyncPreview;
}
export function parseCloudDocumentUrl(raw: string): { url: string; document: string } {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("请输入完整的飞书云文档地址"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)) throw new Error("仅支持飞书或 Lark 的 HTTPS 云文档地址");
  const match = /^\/docx\/([A-Za-z0-9_-]{8,128})\/?$/.exec(url.pathname);
  if (!match) throw new Error("请使用文档原始 /docx/ 地址；Wiki 请先在飞书打开原文档");
  url.search = ""; url.hash = "";
  return { url: url.href, document: match[1] };
}
export function syncStatus(binding: ResearchCloudDocument, local: { text: string; digest: string }, cloud: { text: string; digest: string }): ResearchCloudDocument["status"] {
  if (local.text === cloud.text) return "synced";
  if (!binding.baseline) return "conflict";
  const changedLocal = local.digest !== binding.baseline.local, changedCloud = cloud.digest !== binding.baseline.cloud;
  return changedLocal && !changedCloud ? "local_changed" : changedCloud && !changedLocal ? "cloud_changed" : "conflict";
}

/** The task chooses its own sync policy. A material link alone authorizes no cloud writes. */
export class ResearchDocuments {
  private readonly active = new Set<string>();
  constructor(private readonly graph: ResearchGraph, private readonly provider: CloudDocumentProvider | undefined,
    private readonly io: ResearchDocumentIO, private readonly allowed: (context: ResearchContext, operation: string) => boolean,
    private readonly changed: (project: string) => void) {}
  private get(context: ResearchContext, node: string, write = false): ResearchCloudDocument {
    this.graph.role(context);
    this.graph.node(context.project, node);
    const binding = this.graph.repo.get<ResearchCloudDocument>(context.project, "cloud-documents", node);
    if (!binding) throw new Error("该材料尚未绑定云文档");
    this.check(context, binding, write);
    return binding;
  }
  private check(context: ResearchContext, binding: ResearchCloudDocument, write: boolean): void {
    this.graph.role(context);
    const owner: ResearchContext = { project: context.project, actor: { kind: "human", owner: binding.owner } };
    this.graph.role(owner);
    if (write) { this.graph.authorize(context, "edit_graph"); this.graph.authorize(owner, "edit_graph"); }
    const op = write ? "sync_cloud_document" : "read_cloud_document";
    if (!this.allowed(context, op) || !this.allowed({ project: context.project, actor: { kind: "human", owner: binding.owner } }, op)) throw new Error("云文档读取或同步授权已撤销");
    this.graph.node(context.project, binding.node);
    const current = this.graph.repo.get<ResearchCloudDocument>(context.project, "cloud-documents", binding.id);
    if (!current || current.version !== binding.version || current.owner !== binding.owner || current.document !== binding.document) throw new Error("文档绑定或同步范围已变化");
  }
  async bind(context: ResearchContext, params: Record<string, string>) {
    this.graph.authorize(context, "manage_resources");
    if (!this.provider) throw new Error("飞书文档服务尚未连接");
    const node = this.graph.node(context.project, params.node), data = parse(params.data);
    if (Object.keys(data).some(key => !["url", "version"].includes(key))) throw new Error("文档绑定包含未知字段");
    const target = parseCloudDocumentUrl(text(data.url, "文档地址", 2000));
    const old = this.graph.repo.get<ResearchCloudDocument>(context.project, "cloud-documents", node.id);
    const fp = digest(params), prior = this.graph.repo.receipt(context.project, `cloud:${context.actor.owner}`, params.request, fp);
    if (prior) return prior;
    if (old && old.version !== data.version) throw new Error("文档绑定已变化，请重新读取");
    const current = () => {
      this.graph.authorize(context, "manage_resources");
      this.graph.node(context.project, node.id);
      if (!this.allowed(context, "manage_resources") || !this.allowed(context, "read_cloud_document")) throw new Error("云文档读取或资源绑定授权已撤销");
      if (this.graph.repo.get<ResearchCloudDocument>(context.project, "cloud-documents", node.id)?.version !== old?.version) throw new Error("绑定期间文档范围已变化");
    };
    current();
    await this.provider.read(context.actor.owner, target.document, current);
    current();
    const binding: ResearchCloudDocument = { id: node.id, node: node.id, owner: context.actor.owner, version: (old?.version ?? 0) + 1, ...target, block: "", localNode: "", strategy: null, instructions: "", baseline: null, status: "unconfigured", checkedAt: null, message: "尚未为这个任务设置同步范围与策略" };
    const resource = this.graph.resolveResource(context.project, node.id);
    this.graph.mutate(context, "node_update", { request: `cloud-meta:${digest(params.request).slice(0, 40)}`, node: node.id, version: String(node.version), data: JSON.stringify({ data: { ...resource.data, meta: { ...object(resource.data.meta ?? {}), cloudDocument: node.id, cloudUrl: target.url } } }) });
    this.graph.repo.put(context.project, "cloud-documents", node.id, binding);
    this.graph.repo.remember(context.project, `cloud:${context.actor.owner}`, params.request, fp, { binding });
    this.changed(context.project);
    return { binding };
  }
  async read(context: ResearchContext, node: string): Promise<CloudDocumentRead> {
    const binding = this.get(context, node);
    if (!this.provider) throw new Error("飞书文档服务尚未连接");
    const current = () => this.check(context, binding, false);
    current();
    const result = await this.provider.read(binding.owner, binding.document, current);
    current();
    return { binding, ...result, embed: { available: false, reason: "本页提供经授权的文档内容；完整协作请打开原文档。官方嵌入组件需要站点与用户签名配置，当前未启用。" } };
  }
  async configure(context: ResearchContext, params: Record<string, string>) {
    this.graph.authorize(context, "manage_resources");
    const binding = this.get(context, params.node), data = parse(params.data);
    if (binding.owner !== context.actor.owner) throw new Error("请由文档绑定归属人设置同步策略");
    if (Object.keys(data).some(key => !["version", "block", "localNode", "strategy", "instructions", "watch"].includes(key))) throw new Error("同步设置包含未知字段");
    if (binding.version !== data.version) throw new Error("同步设置已变化");
    const strategy = text(data.strategy, "本任务同步策略", 32) as PaperSyncStrategy;
    if (!["manual", "local_to_cloud", "cloud_to_local", "bidirectional"].includes(strategy)) throw new Error("请明确选择本任务的同步策略");
    const watch = data.watch === undefined ? binding.watch ?? false : data.watch;
    if (typeof watch !== "boolean") throw new Error("持续同步设置无效");
    const localNode = text(data.localNode, "本地 Markdown 节点", 160), block = text(data.block, "云端文本块", 160);
    this.graph.node(context.project, localNode);
    const prior = this.graph.repo.receipt(context.project, `sync-config:${context.actor.owner}`, params.request, digest(params));
    if (prior) return prior;
    if (!this.provider) throw new Error("飞书文档服务尚未连接");
    const current = () => {
      this.check(context, binding, false);
      this.graph.authorize(context, "manage_resources");
      if (!this.allowed(context, "manage_resources")) throw new Error("资源管理授权已撤销");
      if (watch) this.check(context, binding, true);
    };
    current();
    const local = await this.io.read(context, localNode);
    current();
    const cloud = await this.provider.readBlock(binding.owner, binding.document, block, current);
    current();
    const next: ResearchCloudDocument = { ...binding, version: binding.version + 1, localNode, block, strategy, watch, instructions: text(data.instructions, "本任务补充策略", 4000, ""), baseline: local.text === cloud.text ? { local: local.digest, cloud: cloud.digest } : null, status: local.text === cloud.text ? "synced" : "conflict", checkedAt: new Date().toISOString(), message: local.text === cloud.text ? "两边内容一致" : "首次绑定的两边内容不同，请比较后明确选择同步方向" };
    this.graph.repo.put(context.project, "cloud-documents", binding.id, next);
    this.graph.repo.remember(context.project, `sync-config:${context.actor.owner}`, params.request, digest(params), { binding: next });
    this.changed(context.project);
    return { binding: next };
  }
  /** A watch grant never outlives its explicit opt-in, binding version or unresolved write. */
  watchCurrent(context: ResearchContext, node: string, version: number): void {
    const binding = this.get(context, node, true);
    if (!binding.watch || binding.version !== version) throw new Error("持续同步已关闭或设置已变化");
    if (binding.status === "unknown") throw new Error("上次同步结果尚未确认，请人工核对；后台不会重试");
  }
  async preview(context: ResearchContext, node: string, parentCurrent: () => void = () => {}): Promise<PaperSyncPreview> {
    return this.previewState(context, node, parentCurrent);
  }
  private async previewState(context: ResearchContext, node: string, parentCurrent: () => void, settleUnknown?: string): Promise<PaperSyncPreview> {
    const binding = this.get(context, node);
    if (!binding.strategy || !binding.block || !binding.localNode) throw new Error("先为本任务选择本地 Markdown、云端文本块和同步策略");
    if (!this.provider) throw new Error("飞书文档服务尚未连接");
    const current = () => { parentCurrent(); this.check(context, binding, false); };
    current();
    const local = await this.io.read(context, binding.localNode);
    current();
    const cloud = await this.provider.readBlock(binding.owner, binding.document, binding.block, current);
    current();
    // Status can become unknown without a config version change while these reads are in flight.
    const latest = this.graph.repo.get<ResearchCloudDocument>(context.project, "cloud-documents", binding.id)!;
    const unsettled = (latest.status === "unknown" || binding.status === "unknown") &&
      !(settleUnknown !== undefined && local.text === settleUnknown && cloud.text === settleUnknown);
    const status = unsettled ? "unknown" : syncStatus(latest, local, cloud);
    const next: ResearchCloudDocument = { ...latest, status, checkedAt: new Date().toISOString(), baseline: status === "synced" ? { local: local.digest, cloud: cloud.digest } : latest.baseline, message: unsettled ? (latest.status === "unknown" ? latest.message : binding.message) : status === "conflict" ? "两边变化或尚无共同基线；原文均保留，请明确选用内容" : status === "synced" ? "两边内容一致" : status === "local_changed" ? "本地大纲有更新" : "飞书大纲有更新" };
    this.graph.repo.put(context.project, "cloud-documents", node, next);
    this.changed(context.project);
    return { binding: next, local, cloud };
  }
  async sync(context: ResearchContext, params: Record<string, string>, parentCurrent: () => void = () => {}): Promise<PaperSyncPreview> {
    this.graph.authorize(context, "edit_graph");
    const binding = this.get(context, params.node, true), key = `${context.project}:${binding.id}`;
    if (this.active.has(key)) throw new Error("这份大纲正在同步，请等待当前结果");
    const request = text(params.request, "请求 ID", 100), fp = digest(params), intentKey = digest([context.actor.owner, request]);
    const prior = this.graph.repo.get<SyncIntent>(context.project, "paper-sync-intents", intentKey);
    if (prior && prior.fingerprint !== fp) throw new Error("请求 ID 已用于不同同步内容");
    if (prior?.status === "complete" && prior.result) return prior.result;
    if (prior) throw new Error("之前的同步结果尚未确认；请先核对两边内容，不会重放覆盖");
    const explicitHuman = context.actor.kind === "human" && ["local_to_cloud", "cloud_to_local"].includes(params.direction);
    if (params.direction !== "auto" && !explicitHuman) throw new Error("Agent 遇到同步冲突只能按本任务策略推进，不能替人强制选边");
    const current = () => {
      parentCurrent();
      this.check(context, binding, true);
      if (!explicitHuman && this.graph.repo.get<ResearchCloudDocument>(context.project, "cloud-documents", binding.id)?.status === "unknown")
        throw new Error("上次同步结果尚未确认，请人工核对；不会自动重试");
    };
    current();
    this.active.add(key);
    try {
      const state = await this.preview(context, binding.node, current);
      current();
      if (state.local.digest !== params.local_digest || state.cloud.digest !== params.cloud_digest) throw new Error("两边内容已变化，请重新核对后同步");
      if (state.binding.status === "synced") return state;
      let direction = params.direction;
      if (direction === "auto") {
        const policy = binding.strategy;
        if (state.binding.status === "conflict" || policy === "manual" || !policy) throw new Error("本任务需要人工选择同步方向，未修改任何一边");
        if (state.binding.status === "local_changed" && ["local_to_cloud", "bidirectional"].includes(policy)) direction = "local_to_cloud";
        else if (state.binding.status === "cloud_changed" && ["cloud_to_local", "bidirectional"].includes(policy)) direction = "cloud_to_local";
        else throw new Error("当前变化方向不符合这个任务的同步策略，未覆盖另一边");
      } else if (context.actor.kind !== "human") throw new Error("Agent 遇到同步冲突只能按本任务策略推进，不能替人强制选边");
      if (!["local_to_cloud", "cloud_to_local"].includes(direction)) throw new Error("同步方向无效");
      const desired = direction === "local_to_cloud" ? state.local.text : state.cloud.text;
      if (!/[\u3400-\u9fff]/.test(desired)) throw new Error("论文大纲需要可供审阅的中文内容");
      const intent: SyncIntent = { id: intentKey, fingerprint: fp, status: "writing", local: state.local, cloud: state.cloud, desired, direction, at: new Date().toISOString() };
      // Persist both preimages before any remote write. A crash is unknown, never an automatic overwrite retry.
      this.graph.repo.put(context.project, "paper-sync-intents", intentKey, intent, 0);
      try {
        current();
        if (direction === "local_to_cloud") await this.provider!.writeBlock(binding.owner, binding.document, binding.block, desired, state.cloud, request, current);
        else await this.io.write(context, binding.localNode, desired, state.local.digest, request, current);
        current();
        const result = await this.previewState(context, binding.node, current, explicitHuman ? desired : undefined);
        if (result.local.text !== desired || result.cloud.text !== desired) throw new Error("同步后的内容出现新变化，请比较两边；本次原文已保留");
        this.graph.repo.put(context.project, "paper-sync-intents", intentKey, { ...intent, status: "complete", result });
        return result;
      } catch (reason) {
        this.graph.repo.put(context.project, "paper-sync-intents", intentKey, { ...intent, status: "unknown" });
        const current = this.graph.repo.get<ResearchCloudDocument>(context.project, "cloud-documents", binding.id);
        if (current?.version === binding.version) this.graph.repo.put(context.project, "cloud-documents", binding.id, { ...current, status: "unknown", message: String(reason).slice(0, 600) });
        this.changed(context.project);
        throw reason;
      }
    } finally { this.active.delete(key); }
  }
  async invoke(context: ResearchContext, action: string, params: Record<string, string>) {
    if (action === "cloud_document_bind") return this.bind(context, params);
    if (action === "cloud_document_read") return this.read(context, params.node);
    if (action === "paper_sync_configure") return this.configure(context, params);
    if (action === "paper_sync_check") return this.preview(context, params.node);
    if (action === "paper_sync_run") return this.sync(context, params);
    throw new Error("未知云文档动作");
  }
}
