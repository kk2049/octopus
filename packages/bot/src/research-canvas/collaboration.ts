import { createHash, randomBytes } from "node:crypto";
import type { ResearchNode, ResearchProposal } from "@claude-bot/research-canvas-contract";
import type { ResearchContext, ResearchGraph } from "./graph.js";
import { digest, integer, text } from "./validation.js";
import { TEXT_LEGACY_INLINE_BYTES } from "./text-files.js";

/** Text is an ordinary file; layout belongs to the graph replica. */
export class ResearchCollaboration {
  constructor(private readonly graph: ResearchGraph, _legacyRoot: string, private readonly changed: (project: string) => void) {}
  close(): void {}
  private resource(context: ResearchContext, node: string) { this.graph.role(context); return this.graph.resolveResource(context.project, node); }
  document(context: ResearchContext, params: Record<string, string>): { revision: string; data: unknown } {
    this.graph.role(context);
    if (params.field === "layout" && params.node === "board") {
      const layout = this.graph.documents.inspect(context.project).layout;
      return { revision: layout.revision, data: { positions: layout.positions, edgePorts: layout.edgePorts } };
    }
    if (params.field !== "text") throw new Error("文档字段无效");
    const resource = this.resource(context, params.node);
    if (params.offset !== undefined) {
      // Windowed: a body of any size, one bounded window per call, all pinned to one revision.
      const window = this.graph.texts.readWindow(context.project, resource, integer(params.offset, 0, Number.MAX_SAFE_INTEGER));
      return { revision: window.revision, data: { text: window.text, path: window.path, offset: window.offset, next: window.next, bytes: window.bytes } };
    }
    // Without an offset the caller expects the whole body in one answer (older Views do).
    const file = this.graph.texts.read(context.project, resource, TEXT_LEGACY_INLINE_BYTES);
    return { revision: file.revision, data: { text: file.text, path: file.path } };
  }
  /**
   * Save a body: whole in one call (the call's window bounds the text), or
   * staged past it (stage = begin | append | commit, 2026-10-20). A staged
   * upload is a temp file beside the workspace; commit backs up the old
   * version and renames it into place, so the body has no size limit and is
   * never loaded whole.
   */
  write(context: ResearchContext, params: Record<string, string>): unknown {
    this.graph.authorize(context, "edit_graph");
    const resource = this.resource(context, params.node);
    if (resource.data.meta && typeof resource.data.meta === "object" && !Array.isArray(resource.data.meta) && resource.data.meta.read_only === true) throw new Error("此来源资源只读");
    const current = () => this.graph.texts.currentRevision(context.project, resource);
    if (params.stage === "begin") {
      if (params.expected && current() !== params.expected) throw new Error("正文已变化，请重新比较；未覆盖新内容");
      const upload = randomBytes(16).toString("hex");
      this.graph.texts.stageBegin(context.project, resource, this.uploadKey(context, resource, upload));
      // The revision the upload is based on: pass it back as `expected` at commit.
      return { status: "staged", upload, size: 0, revision: current() };
    }
    if (params.stage === "append") {
      const size = this.graph.texts.stageAppend(context.project, this.uploadKey(context, resource, params.upload),
        integer(params.offset, 0, Number.MAX_SAFE_INTEGER), text(params.text, "正文", Number.MAX_SAFE_INTEGER, ""));
      return { status: "staged", upload: params.upload, size };
    }
    // `text` is optional only for staged steps: a whole save without it is a
    // malformed call, never "replace the body with nothing".
    if (!params.restore && params.stage === undefined && typeof params.text !== "string") throw new Error("整份保存需要 text");
    if (params.stage !== undefined && params.stage !== "commit") throw new Error("分段保存的步骤无效");
    const request = text(params.request, "请求 ID", 100);
    const actor = "text:" + context.actor.kind + ":" + context.actor.owner + ":" + (context.actor.agent ?? "");
    // A staged commit is identified by what it commits, not by the upload
    // carrying it: a retried save (a fresh upload of the same body under the
    // same request) joins the first one's receipt instead of saving twice.
    const fingerprint = digest(params.stage === "commit" ? { ...params, upload: undefined } : params);
    const prior = this.graph.repo.receipt(context.project, actor, request, fingerprint);
    if (prior) return prior;
    if (params.expected && current() !== params.expected) throw new Error("正文已变化，请重新比较；未覆盖新内容");
    const result = params.restore ? this.graph.texts.restore(context.project, resource, params.restore)
      : params.stage === "commit" ? this.graph.texts.stageCommit(context.project, resource, this.uploadKey(context, resource, params.upload),
        integer(params.size, 0, Number.MAX_SAFE_INTEGER))
      // The action call's own window bounds a whole text; an in-process caller may pass any size.
      : this.graph.texts.write(context.project, resource, text(params.text, "正文", Number.MAX_SAFE_INTEGER, ""));
    this.graph.repo.remember(context.project, actor, request, fingerprint, result);
    this.changed(context.project);
    return result;
  }
  /** Where an actor's upload token stages for one body: meaningless for any other actor or node. */
  private uploadKey(context: ResearchContext, resource: ResearchNode, upload: unknown): string {
    if (typeof upload !== "string" || !/^[0-9a-f]{32}$/.test(upload)) throw new Error("分段保存的 upload 无效");
    return createHash("sha256").update(JSON.stringify([
      "research-text-upload", context.project, context.actor.kind, context.actor.owner, context.actor.agent ?? "", resource.id, upload,
    ])).digest("hex").slice(0, 32);
  }
  resolveProposal(context: ResearchContext, params: Record<string, string>): unknown {
    this.graph.authorize(context, "edit_graph");
    if (context.actor.kind !== "human") throw new Error("只有人可以处理历史提案");
    const proposal = this.graph.repo.get<ResearchProposal>(context.project, "proposals", params.proposal);
    if (!proposal || proposal.state !== "pending" || proposal.version !== integer(params.version, 1, 2_147_483_647)) throw new Error("提案已变化");
    if (params.decision !== "reject") throw new Error("旧正文提案的基准已经迁移；请重新读取文件或布局后直接修改");
    const next = { ...proposal, state: "rejected", version: proposal.version + 1, resolvedBy: this.graph.provenance(context) };
    this.graph.repo.put(context.project, "proposals", proposal.id, next, proposal.version);
    return { proposal: next };
  }
  /** The body's first window; `textNext` names where the rest continues, so nothing is cut silently. */
  textPreview(context: ResearchContext, node: string): { text: string; textNext?: number; textBytes?: number } {
    const window = this.graph.texts.readWindow(context.project, this.resource(context, node), 0);
    return window.next === null ? { text: window.text } : { text: window.text, textNext: window.next, textBytes: window.bytes };
  }
  /** The whole body, for a caller that needs it in one string (within the whole-body budget). */
  text(context: ResearchContext, node: string): string { return this.graph.texts.read(context.project, this.resource(context, node)).text; }
}
