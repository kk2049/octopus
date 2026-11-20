import type { ResearchCloudDocument } from "@claude-bot/research-canvas-contract";
import type { ResearchContext, ResearchGraph } from "./graph.js";
import type { ResearchDocuments } from "./documents.js";
import type { ResearchWorkflows } from "./workflows.js";
import { digest } from "./validation.js";

interface PaperTask { context: ResearchContext; binding: ResearchCloudDocument }
interface PaperWatchPorts {
  tasks(): PaperTask[];
  current(task: PaperTask): void;
  documents: Pick<ResearchDocuments, "preview" | "sync">;
  problem(task: PaperTask, message: string, identity: string): Promise<void> | void;
}
/** Only a task's explicit watch opt-in schedules work. One bounded, serial sweep at a time. */
export class ResearchDocumentWatch {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private closed = false;
  private cursor = 0;
  constructor(private readonly ports: PaperWatchPorts, interval = 60_000) {
    if (interval > 0) { this.timer = setInterval(() => { void this.tick(); }, interval); this.timer.unref(); }
  }
  close() { this.closed = true; clearInterval(this.timer); }
  async tick() {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      const tasks = this.ports.tasks().filter(task => task.binding.watch === true && task.binding.strategy);
      const limit = Math.min(20, tasks.length);
      for (let i = 0; i < limit && !this.closed; i++) {
        const task = tasks[(this.cursor + i) % tasks.length], { context, binding } = task;
        const current = () => {
          if (this.closed) throw new Error("持续同步服务已关闭");
          this.ports.current(task);
        };
        try {
          // A timeout/crash after an external write is not a failed retryable transfer.
          if (binding.status === "unknown") {
            await this.ports.problem(task, binding.message, `unknown:${binding.version}`);
            continue;
          }
          current();
          const state = await this.ports.documents.preview(context, binding.node, current);
          current();
          if (!state.binding.watch || state.binding.version !== binding.version) continue;
          if (state.binding.status === "unknown") {
            await this.ports.problem(task, state.binding.message, `unknown:${binding.version}`);
            continue;
          }
          const identity = digest([binding.version, state.local.digest, state.cloud.digest]);
          if (state.binding.status === "synced") continue;
          const allowedDirection = state.binding.status === "local_changed"
            ? ["local_to_cloud", "bidirectional"].includes(binding.strategy!)
            : state.binding.status === "cloud_changed" && ["cloud_to_local", "bidirectional"].includes(binding.strategy!);
          if (!allowedDirection) {
            await this.ports.problem(task, state.binding.status === "conflict" ? "中文大纲两边发生变化，请比较后决定如何合并。" : "大纲出现变化；当前任务策略要求人工处理这个方向。", identity);
            continue;
          }
          await this.ports.documents.sync(context, { node: binding.node, request: `watch:${digest([context.project, binding.id, identity])}`, direction: "auto", local_digest: state.local.digest, cloud_digest: state.cloud.digest }, current);
          current();
        } catch (reason) {
          if (this.closed) break;
          const message = (reason instanceof Error ? reason.message : "论文同步失败").slice(0, 600);
          try { await this.ports.problem(task, message, digest([binding.version, message])); } catch { /* Revocation must not cause retries or stop other explicitly enabled tasks. */ }
        }
      }
      this.cursor = tasks.length ? (this.cursor + limit) % tasks.length : 0;
    } finally { this.running = false; }
  }
}

export function createResearchDocumentWatch(graph: ResearchGraph, documents: ResearchDocuments, workflows: ResearchWorkflows, changed: (project: string) => void) {
  return new ResearchDocumentWatch({
    documents,
    current: ({ context, binding }) => documents.watchCurrent(context, binding.node, binding.version),
    tasks: () => graph.repo.projects().flatMap(project => [...graph.records<ResearchCloudDocument>(project, "cloud-documents")]
      .filter(binding => binding.watch).map(binding => ({ context: { project, actor: { kind: "human" as const, owner: binding.owner } }, binding }))),
    problem: async ({ context, binding }, message, identity) => {
      graph.authorize(context, "edit_graph");
      const current = graph.repo.get<ResearchCloudDocument>(context.project, "cloud-documents", binding.id);
      if (!current?.watch || current.version !== binding.version) return;
      if (current.message !== message) {
        graph.repo.put(context.project, "cloud-documents", binding.id, { ...current, message, status: ["conflict", "unknown"].includes(current.status) ? current.status : "failed" });
        changed(context.project);
      }
      await workflows.invoke(context, "review_flag_open", { request: `paper-review:${digest([binding.id, identity])}`, data: JSON.stringify({ kind: "review", title: "论文大纲同步需要复核", background: message, options: [], related: [binding.node, binding.localNode].filter(Boolean), sources: [], affected: [binding.node], }) });
    },
  });
}
