import type { DiscussionSegment, DiscussionSourceStatus, ResearchNode, ResourceBinding } from "@claude-bot/research-canvas-contract";
import type { ResearchContext, ResearchGraph } from "./graph.js";
import type { ResearchFile, ResearchResources } from "./resources.js";
import { SourceIntegrityError } from "./moss.js";
import type { DiscussionSummary, SourceCandidateDraft } from "./source-summary.js";
import { digest } from "./validation.js";
export interface StoredSource extends DiscussionSourceStatus {
  owner: string;
  binding: ResourceBinding;
  segments: DiscussionSegment[];
  summaryResult?: DiscussionSummary;
}
interface CandidatePort {
  (context: ResearchContext, input: { source: string; items: SourceCandidateDraft[]; request: string; title?: string }): unknown;
}
const ref = (node: ResearchNode) => ({ id: node.id, ref: `${node.type}:${node.id}` });
const terminal = new Set(["transcribed", "completed", "needs_review", "failed", "unknown"]);
/** One source record owns capture, derived files and the candidate batch; it never publishes tasks. */
export class ResearchDiscussionSources {
  private readonly work = new Map<string, AbortController>();
  private closed = false;
  private audioReady?: (context: ResearchContext, source: StoredSource) => Promise<boolean>;
  attachAudioReady(handler: NonNullable<ResearchDiscussionSources["audioReady"]>) { this.audioReady = handler; }
  constructor(private readonly graph: ResearchGraph, private readonly resources: ResearchResources,
    private readonly changed: (project: string) => void, private readonly prepareCandidates: CandidatePort,
    private readonly allowed: (context: ResearchContext, operation: string) => boolean = () => true) {
    resources.attachSourceProcessor((context, binding, file, signal) => this.audio(context, binding, file, signal));
    for (const project of graph.repo.projects()) for (const record of graph.records<StoredSource>(project, "discussion-sources"))
      if (!terminal.has(record.stage) && !record.summary) this.save(project, { ...record, stage: "unknown", message: "服务重启，上一轮结果需要核对；不会自动重复转写" });
  }
  private public(record: StoredSource): DiscussionSourceStatus {
    const { owner: _owner, binding: _binding, segments: _segments, summaryResult: _summary, ...status } = record;
    return status;
  }
  private save(project: string, record: StoredSource) {
    const next = { ...record, updatedAt: new Date().toISOString() };
    this.graph.repo.put(project, "discussion-sources", record.id, next);
    if (record.kind === "audio") this.resources.meetingStatus(project, record.node, record.sourceVersion, record.stage, record.summary?.state);
    this.changed(project); return next;
  }
  require(context: ResearchContext, node: string, version: string, operation = "read_project"): StoredSource {
    this.graph.authorize(context, operation);
    const resource = this.graph.resolveResource(context.project, node);
    const row = this.graph.repo.get<StoredSource>(context.project, "discussion-sources", "source_" + digest([resource.id, version]).slice(0, 40));
    if (!row) throw new Error("指定版本的完整来源尚未就绪");
    this.check(context, row.binding, operation);
    return row;
  }
  update(context: ResearchContext, row: StoredSource, patch: Partial<DiscussionSourceStatus>) {
    this.check(context, row.binding, "run_agent");
    return this.public(this.save(context.project, { ...row, ...patch }));
  }
  private check(context: ResearchContext, binding: ResourceBinding, operation: string) {
    if (this.closed) throw new Error("讨论来源服务已关闭");
    this.graph.authorize(context, operation);
    if (!this.allowed(context, operation) || !this.allowed({ project: context.project, actor: { kind: "human", owner: binding.owner } }, operation))
      throw new Error("讨论来源处理授权已撤销");
    const current = this.resources.binding(context, binding.node, binding.kind, operation);
    if (current.version !== binding.version || current.resource !== binding.resource) throw new Error("处理期间来源绑定已变化");
  }
  list(context: ResearchContext) {
    this.graph.role(context);
    const items = [...this.graph.records<StoredSource>(context.project, "discussion-sources")]
      .filter(record => { try { this.resources.binding(context, record.binding.node); return true; } catch { return false; } })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 200).map(record => this.public(record));
    return { items };
  }
  read(context: ResearchContext, params: Record<string, string>) {
    this.graph.role(context);
    const node = this.graph.resolveResource(context.project, params.node);
    const rows = [...this.graph.records<StoredSource>(context.project, "discussion-sources")]
      .filter(row => (row.node === node.id || row.binding.node === node.id || row.transcript?.id === node.id || row.minutes?.id === node.id) && (!params.version || row.sourceVersion === params.version))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const source = rows[0];
    if (!source && node.type === "audio") {
      const run = this.graph.repo.runs(context.project, { node: node.id, limit: 1 })[0];
      if (run && run.binding.kind === "audio") {
        this.resources.binding(context, node.id);
        return { source: { id: `pending_${run.id}`, node: node.id, title: node.title, kind: "audio", sourceVersion: run.binding.resource,
          stage: run.status === "queued" ? "queued" : ["running", "waiting"].includes(run.status) ? "transcribing" : "unknown",
          progress: null, message: run.error ?? "后台已登记转写任务", createdAt: run.at, updatedAt: run.finished ?? run.at } satisfies DiscussionSourceStatus };
      }
    }
    if (source) this.resources.binding(context, source.binding.node);
    return { source: source ? this.public(source) : null, follow: this.graph.repo.get(context.project, "discussion-follows", node.id) };
  }
  private newRecord(node: ResearchNode, kind: "audio" | "chat", sourceVersion: string, binding: ResourceBinding): StoredSource {
    const now = new Date().toISOString();
    return { id: "source_" + digest([node.id, sourceVersion]).slice(0, 40), node: node.id, title: node.title, kind,
      sourceVersion, stage: "queued", progress: null, message: "等待处理", createdAt: now, updatedAt: now,
      owner: binding.owner, binding, segments: [] };
  }
  async audio(context: ResearchContext, binding: ResourceBinding, file: ResearchFile, signal: AbortSignal, resume = false): Promise<{ artifact: ResearchNode; model: string | null }> {
    this.check(context, binding, "transcribe_audio");
    const node = this.graph.resourceNode(context.project, binding.node);
    let record = this.newRecord(node, "audio", file.id, binding);
    const previous = this.graph.repo.get<StoredSource>(context.project, "discussion-sources", record.id);
    if (previous?.integrity?.complete && previous.transcript) return { artifact: this.graph.resourceNode(context.project, previous.transcript.id), model: previous.model ?? null };
    if (previous && !resume && !["queued", "uploaded"].includes(previous.stage)) throw new Error("该音频版本已有处理记录；请先核对结果，不会自动重复转写");
    record = this.save(context.project, record);
    try {
      const result = await this.resources.adapters.transcribe(binding, { path: this.resources.blobPath(file.sha256), name: file.name, mime: file.mime }, signal,
        (stage, message, progress = null) => {
          this.check(context, binding, "transcribe_audio"); signal.throwIfAborted();
          record = this.save(context.project, { ...record, stage, message, progress });
        }, () => { this.check(context, binding, "transcribe_audio"); signal.throwIfAborted(); });
      this.check(context, binding, "transcribe_audio"); signal.throwIfAborted();
      if (!result.integrity?.complete || !result.segments?.length) throw new Error("转写未提供可核验的完整性与讲话人片段，不能标记成功");
      const artifact = this.resources.sourceFile(context, node.id, file.id, "完整转写", result.text);
      const evidence = this.resources.sourceFile(context, node.id, file.id, "转写证据", result.evidence ?? JSON.stringify(result.integrity), "application/json");
      record = this.save(context.project, { ...record, transcript: ref(artifact), evidence: ref(evidence), integrity: result.integrity,
        model: result.model, segments: result.segments, stage: "transcribed", message: "完整转写已保存，可继续整理纪要" });
      this.resources.transcriptionCompleted(context, node.id, file.id, artifact);
      if (!await this.audioReady?.(context, record)) await this.derive(context, record, signal);
      return { artifact, model: result.model };
    } catch (error) {
      if (this.closed) throw error;
      record = this.graph.repo.get<StoredSource>(context.project, "discussion-sources", record.id) ?? record;
      if (error instanceof SourceIntegrityError) {
        this.check(context, binding, "transcribe_audio");
        const evidence = this.resources.sourceFile(context, node.id, file.id, "完整性待审证据", error.evidence, "application/json");
        const partial = error.partial ? this.resources.sourceFile(context, node.id, file.id, "部分转写（待审）", error.partial) : null;
        record = { ...record, integrity: error.integrity, evidence: ref(evidence), ...(partial ? { transcript: ref(partial) } : {}) };
      }
      this.save(context.project, { ...record, stage: error instanceof SourceIntegrityError ? "needs_review" : "failed", progress: null,
        message: (error instanceof Error ? error.message : "录音处理失败").slice(0, 600) });
      throw error;
    }
  }
  /** Chat ingestion already has text: it never goes through the audio adapter. */
  captured(context: ResearchContext, input: { record: ResearchNode; minutes: ResearchNode; binding: ResourceBinding; messages: { message_id: string; sender?: string; body?: string; create_time?: string }[] }) {
    const sourceVersion = digest(input.messages);
    const next = this.newRecord(input.record, "chat", sourceVersion, input.binding);
    const prior = this.graph.repo.get<StoredSource>(context.project, "discussion-sources", next.id);
    if (prior) return { source: this.public(prior) };
    const row = this.save(context.project, { ...next, transcript: ref(input.record), minutes: ref(input.minutes), segments: input.messages.map(message => ({
      id: message.message_id, text: messageText(message.body ?? ""), speaker: message.sender ?? "未署名", at: message.create_time,
    })) });
    this.start(context, row);
    return { source: this.public(row) };
  }
  retry(context: ResearchContext, params: Record<string, string>) {
    const node = this.graph.resolveResource(context.project, params.node);
    const row = [...this.graph.records<StoredSource>(context.project, "discussion-sources")]
      .filter(item => item.node === node.id && (!params.version || item.sourceVersion === params.version)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!row) throw new Error("尚未取得讨论来源");
    this.check(context, row.binding, row.kind === "audio" ? "transcribe_audio" : "run_agent");
    if (row.stage === "completed") return { source: this.public(row) };
    if (!terminal.has(row.stage)) return { source: this.public(row) };
    if (row.kind === "audio" && (!row.segments.length || !row.integrity?.complete)) {
      const key = `${context.project}:${row.id}`;
      if (!this.work.has(key)) {
        const controller = new AbortController(); this.work.set(key, controller);
        const file = this.resources.file(context, row.node, row.sourceVersion);
        void this.audio(context, row.binding, file, controller.signal, true).catch(() => {}).finally(() => this.work.delete(key));
      }
      return { source: this.public(this.graph.repo.get<StoredSource>(context.project, "discussion-sources", row.id) ?? row) };
    }
    if (!row.segments.length) throw new Error("尚无可整理的完整来源");
    if (row.summary || row.stage === "transcribed") throw new Error("请明确选择纪要来源并重新整理；不会自动重放 Agent 任务");
    this.start(context, row); return { source: this.public(row) };
  }
  private start(context: ResearchContext, row: StoredSource) {
    const key = `${context.project}:${row.id}`;
    if (this.work.has(key) || this.closed) return;
    const abort = new AbortController(); this.work.set(key, abort);
    void this.derive(context, row, abort.signal).catch(error => {
      if (this.closed) return;
      const current = this.graph.repo.get<StoredSource>(context.project, "discussion-sources", row.id) ?? row;
      this.save(context.project, { ...current, stage: "failed", message: (error instanceof Error ? error.message : "纪要整理失败").slice(0, 600) });
    }).finally(() => this.work.delete(key));
  }
  private async derive(context: ResearchContext, initial: StoredSource, signal: AbortSignal) {
    const operation = initial.kind === "audio" ? "transcribe_audio" : "run_agent";
    this.check(context, initial.binding, operation); signal.throwIfAborted();
    let row = this.save(context.project, { ...initial, stage: "summarizing", message: "正在整理全部讨论记录与来源引用", progress: null });
    if (!this.resources.adapters.summarize) throw new Error("讨论纪要处理资源尚未配置");
    const summary = row.summaryResult ?? await this.resources.adapters.summarize(row.binding, {
      source: `${row.kind === "audio" ? "audio" : "workgroup"}:${row.node}`, title: row.title, segments: row.segments,
    }, signal);
    this.check(context, row.binding, operation); signal.throwIfAborted();
    await this.publish(context, row, summary, signal);
  }
  async publish(context: ResearchContext, initial: StoredSource, summary: DiscussionSummary, signal: AbortSignal, attempt?: string) {
    const operation = attempt ? "run_agent" : initial.kind === "audio" ? "transcribe_audio" : "run_agent";
    this.check(context, initial.binding, operation); signal.throwIfAborted();
    let row = initial;
    const request = attempt ? digest([row.id, attempt]) : row.id;
    row = this.save(context.project, { ...row, summaryResult: summary, stage: "candidates", message: "纪要已生成，正在登记可编辑候选事项" });
    let minutes: ResearchNode;
    if (row.minutes && !attempt) {
      minutes = this.graph.resourceNode(context.project, row.minutes.id);
      const current = this.graph.texts.read(context.project, minutes);
      // Only replace the capture template if nobody has edited it since capture.
      const marker = (minutes.data.meta as Record<string, unknown> | undefined)?.sourceTemplateDigest;
      if (marker && digest(current.text) === marker)
        this.graph.texts.write(context.project, minutes, summary.minutes);
    } else {
      minutes = (this.graph.mutate(context, "node_add", { request: request + "_minutes", data: JSON.stringify({ type: "note", title: row.title + " · 纪要",
        summary: summary.warning ?? "自动整理，待审阅；可编辑并回查原始来源。", data: { text: summary.minutes, meta: { sourceNode: row.node,
          sourceRevision: row.sourceVersion, excerptKind: "model", status: "todo", acceptanceStatus: "pending", discussionSource: row.id } } }) }) as { node: ResearchNode }).node;
      this.graph.mutate(context, "edge_add", { request: request + "_minutes_edge", source: minutes.id, target: row.node, label: "依据" });
    }
    const batchResult = await this.prepareCandidates(context, { source: `${row.kind === "audio" ? "audio" : "workgroup"}:${row.node}`,
      items: summary.candidates, request: request + "_candidates", title: row.title + " · 候选事项" });
    this.check(context, row.binding, operation); signal.throwIfAborted();
    const batch = batchResult as { id?: string; batch?: string | { id: string } };
    const batchId = typeof batch.batch === "string" ? batch.batch : batch.batch?.id ?? batch.id;
    if (!batchId) throw new Error("候选事项登记未返回稳定批次 ID");
    const latest = this.graph.repo.get<StoredSource>(context.project, "discussion-sources", row.id) ?? row;
    if (attempt && latest.summary?.attempt !== attempt) throw new Error("纪要整理轮次已变化，未覆盖新结果");
    this.save(context.project, { ...latest, minutes: ref(minutes), batch: batchId, stage: summary.warning ? "needs_review" : "completed", progress: 100,
      ...(attempt && latest.summary ? { summary: { ...latest.summary, state: "completed", model: summary.model } } : {}),
      message: summary.warning ?? `完整来源、纪要与 ${summary.candidates.length} 条待审候选已就绪；尚未发布或执行` });
  }
  close() { this.closed = true; for (const job of this.work.values()) job.abort(); this.work.clear(); }
}
export function messageText(body: string): string {
  try {
    const value = JSON.parse(body);
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.content)) return value.content.flat().map((item: { text?: string }) => item.text ?? "").join("");
  } catch {}
  return body;
}
