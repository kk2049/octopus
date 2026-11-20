import type { RuntimeJson } from "@claude-bot/app-runtime";
import {
  WORKFLOW_ACTIONS,
  EVIDENCE_ACTIONS,
  CLOUD_DOCUMENT_ACTIONS,
  CANVAS_ACTIONS,
  CANVAS_CONTRACT,
  RESEARCH_APP,
  RESEARCH_PUBLISHER,
  type CanvasAction,
  type ResearchNode,
  type GraphPosition, type LayoutEdit, type GraphEdgePorts,
  type ResearchProposal,
  type ResearchRun,
} from "@claude-bot/research-canvas-contract";
import {
  actionOf,
  decodeWireParams,
  encodeWireParams,
  mcpToolsOf,
} from "@claude-bot/typed-port-kit";
import type { SessionPlusInstanceBinding } from "../app-core/instance.js";
import type { DeclaredResourcePlane } from "../app-registry/resource-plane.js";
import type { ResearchGraph, ResearchContext } from "./graph.js";
import type { ResearchCollaboration } from "./collaboration.js";
import type { ResearchResources } from "./resources.js";
import type { ResearchAutomation } from "./automation.js";
import type { ResearchCapabilities } from "./capability.js";
import { isResearchCanvasContract } from "./contract.js";
import { digest, id, integer, object, parse, text } from "./validation.js";
import type { ResearchNative } from "./native.js";
import { GraphInputError } from "./graph-yaml.js";
import { ResearchDiscussions } from "./discussions.js";
import type { ResearchWorkflows } from "./workflows.js";
import type { ResearchDiscussionSources } from "./discussion-sources.js";
import type { ResearchEvidenceService } from "./evidence.js";
import type { ResearchDocuments } from "./documents.js";
import type { ResearchMeetingFlow } from "./meeting-flow.js";
export interface ResearchWorkbenchServices {
  workflows: ResearchWorkflows;
  sources: ResearchDiscussionSources;
  discussions: ResearchDiscussions;
  evidence: ResearchEvidenceService;
  documents: ResearchDocuments;
  meeting?: ResearchMeetingFlow;
}
import { arrangeGraph } from "./layout.js";
import { hasTextFile, TEXT_WHOLE_BYTES } from "./text-files.js";
import { boundFilePath, UPLOAD_TOKEN, uploadToken } from "./native-files.js";
import { ResearchCanvasInspection } from "./inspection.js";

const tools = mcpToolsOf(CANVAS_CONTRACT, {
  namePrefix: "",
  describeRefusals: false,
}).map((tool) => ({ ...tool, name: tool.name.slice(1) }));
export const RESEARCH_DISCOVERY_TOOLS = tools
  .filter((tool) =>
    [
      "graph_read",
      "graph_apply",
      "ref_describe",
      "ref_create",
      "layout_read",
      "layout_move",
      "layout_patch",
      "layout_arrange",
      "layout_auto",
      "canvas_read",
      "canvas_changes",
      "canvas_layout_check",
      "canvas_snapshot",
      "tools_search",
      "tools_describe",
      "tools_invoke",
    ].includes(tool.name),
  )
  .map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: { ...tool.inputSchema },
  }));
interface Watch {
  project: string;
  current(): SessionPlusInstanceBinding | null;
  publish(): void;
}
type Dispatch = Parameters<DeclaredResourcePlane["dispatch"]>[0];
const asJson = (value: unknown): RuntimeJson =>
  JSON.parse(JSON.stringify(value)) as RuntimeJson;

export class ResearchCanvasPlane implements DeclaredResourcePlane {
  private readonly watches = new Map<string, Watch>();
  private readonly observers = new Set<(project: string) => void>();
  observeChanges(listener: (project: string) => void): () => void {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }
  private readonly epochs = new Map<string, number>();
  private readonly dataEpochs = new Map<string, number>();
  constructor(
    private readonly graph: ResearchGraph,
    private readonly collaboration: ResearchCollaboration,
    private readonly resources: ResearchResources,
    private readonly automation: ResearchAutomation,
    private readonly capabilities: ResearchCapabilities,
    private readonly native?: ResearchNative,
    private readonly workbench?: ResearchWorkbenchServices,
  ) {}
  projectTitle(project: string): string { return this.graph.title(project); }
  static matches(app: string, publisher: string): boolean {
    return app === RESEARCH_APP && publisher === RESEARCH_PUBLISHER;
  }
  project(
    binding: SessionPlusInstanceBinding,
    durable: RuntimeJson,
  ): RuntimeJson {
    try {
      const context = this.context(binding),
        role = this.graph.role(context);
      return asJson({
        ...object(durable),
        canvas: {
          project: context.project,
          title: this.graph.title(context.project),
          viewer: binding.owner,
          role,
          epoch: this.epochs.get(context.project) ?? 0,
          dataEpoch: this.dataEpochs.get(context.project) ?? 0,
        },
      });
    } catch {
      return asJson({ ...object(durable), canvas: null });
    }
  }
  changed(project: string, kind: "data" | "layout" = "data"): void {
    if (kind === "data") {
      this.dataEpochs.set(project, (this.dataEpochs.get(project) ?? 0) + 1);
      for (const observer of this.observers) observer(project);
    }
    this.epochs.set(project, (this.epochs.get(project) ?? 0) + 1);
    for (const [key, watch] of this.watches)
      if (watch.project === project) {
        if (watch.current()) watch.publish();
        else this.watches.delete(key);
      }
  }
  close(instanceId: string): void {
    this.watches.delete(instanceId);
  }
  async dispatch(
    input: Dispatch,
  ): ReturnType<DeclaredResourcePlane["dispatch"]> {
    try {
      const live = input.current();
      if (!live) throw new Error("项目连接已失效");
      const context = this.context(live);
      this.watches.set(live.id, {
        project: context.project,
        current: input.current,
        publish: input.publish,
      });
      const result = await this.invoke(context, input.action, input.params);
      if (!input.current()) throw new Error("项目连接或权限已变化");
      input.publish();
      return { ok: true, result: asJson(result) };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error ? error.message.slice(0, 600) : "项目操作失败",
      };
    }
  }
  async invokeTool(
    context: ResearchContext,
    action: string,
    values: Record<string, unknown>,
  ): Promise<unknown> {
    if (!(CANVAS_ACTIONS as string[]).includes(action))
      throw new Error("工具未登记");
    const declaration = actionOf(CANVAS_CONTRACT, action as CanvasAction)!;
    const encoded = encodeWireParams(declaration, {
      ...values,
      ...(declaration.params.request && !values.request
        ? { request: id("agentrequest") }
        : {}),
    });
    if (!encoded.ok) throw new Error("工具参数不符合声明");
    return this.invoke(context, action, encoded.value);
  }
  async invoke(context: ResearchContext, action: string, params: Record<string, string>): Promise<unknown> {
    const result = await this.perform(context, action, params);
    this.workbench?.workflows.recordChange(context, action, params, result);
    return result;
  }
  private async perform(
    context: ResearchContext,
    action: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    if (!(CANVAS_ACTIONS as string[]).includes(action))
      throw new Error("项目动作未登记");
    const declaration = actionOf(CANVAS_CONTRACT, action as CanvasAction)!;
    // The hosted manifest normalizer fills omitted optional fields with "".
    // Restore absence before validating enums and applying domain defaults.
    params = Object.fromEntries(
      Object.entries(params).filter(
        ([key, value]) => !(value === "" && declaration.params[key]?.optional),
      ),
    );
    if (!decodeWireParams(declaration, params).ok)
      throw new Error("参数不符合项目动作声明");
    await this.capabilities.check(
      context,
      declaration.operation!,
      params.node ?? params.source ?? "",
    );
    let result: unknown;
    if (["meeting_options", "source_summarize", "source_segments", "source_summary_submit"].includes(action)) {
      const meeting = this.workbench?.meeting;
      if (!meeting) throw new Error("会议处理服务尚未连接");
      if (action === "meeting_options") return meeting.options(context, params.node);
      if (action === "source_segments") return meeting.segments(context, params);
      if (action === "source_summary_submit") return meeting.submit(context, params);
      if (parse(params.selection).kind === "codex") await this.capabilities.check(context, "manage_resources");
      return meeting.summarize(context, params);
    }
    if (Object.hasOwn(WORKFLOW_ACTIONS, action)) {
      if (!this.workbench) throw new Error("协作工作台尚未连接");
      if (action === "candidates_publish" && parse(params.data).mode === "publish_execute") await this.capabilities.check(context, "run_agent");
      return this.workbench.workflows.invoke(context, action, params);
    }
    if (Object.hasOwn(EVIDENCE_ACTIONS, action)) {
      if (!this.workbench) throw new Error("研究报告服务尚未连接");
      const evidence = this.workbench.evidence;
      if (action === "evidence_publish") return evidence.publish(context, params);
      if (action === "evidence_read") return evidence.read(context, params.node);
      if (action === "evidence_list") return evidence.list(context, params.after);
      if (action === "evidence_adopt") return evidence.adopt(context, params);
    }
    if (Object.hasOwn(CLOUD_DOCUMENT_ACTIONS, action)) {
      if (!this.workbench) throw new Error("云文档服务尚未连接");
      return this.workbench.documents.invoke(context, action, params);
    }
    if (action.startsWith("source_") || ["discussion_create", "discussion_follow", "discussion_sync"].includes(action)) {
      if (!this.workbench) throw new Error("讨论来源服务尚未连接");
      if (action === "source_list") return this.workbench.sources.list(context);
      if (action === "source_read") return this.workbench.sources.read(context, params);
      if (action === "source_retry") return this.workbench.sources.retry(context, params);
      if (action === "discussion_create") return this.workbench.discussions.create(context, params);
      if (action === "discussion_follow") return this.workbench.discussions.follow(context, params);
      if (action === "discussion_sync") return this.workbench.discussions.sync(context, params);
    }
    if (action === "graph_read") return this.graph.documents.snapshot(context, params.scope);
    if (action === "graph_apply") {
      try { result = this.graph.documents.apply(context, params.request, params.yaml, this.graph.provenance(context)); }
      catch (error) {
        if (!(error instanceof GraphInputError)) throw error;
        return { status: "rejected", error: { code: error.code, message: error.message, path: error.path, line: error.line, column: error.column } };
      }
      this.changed(context.project);
      return result;
    }
    if (action === "layout_read") return this.graph.documents.inspect(context.project).layout;
    if (action === "layout_lease") return this.graph.documents.lease(context, params.lease);
    if (action === "layout_release") { this.graph.documents.release(context, params.lease); return { released: true }; }
    if (action === "layout_patch") {
      try {
        const data = parse(params.data);
        if (Object.keys(data).some(key => !["edits", "base", "ports", "basePorts"].includes(key))) throw new GraphInputError("invalid_graph", "布局提交字段无效");
        result = this.graph.documents.patchLayout(context, params.request, data.edits as Record<string, LayoutEdit>, data.base as Record<string, GraphPosition>, false, undefined, data.ports as Record<string, GraphEdgePorts>, data.basePorts as Record<string, GraphEdgePorts>);
      }
      catch (error) {
        if (!(error instanceof GraphInputError)) throw error;
        return { status: "rejected", error: { code: error.code, message: error.message, path: error.path } };
      }
      this.changed(context.project, "layout");
      return result;
    }
    if (["layout_move", "layout_auto", "layout_arrange"].includes(action)) {
      try {
        const state = this.graph.documents.inspect(context.project);
        const options: Record<string, unknown> = action === "layout_arrange" ? parse(params.data) : { nodes: params.nodes ? JSON.parse(params.nodes) : undefined, mode: params.mode, node: params.node };
        if (options.nodes !== undefined && (!Array.isArray(options.nodes) || options.nodes.length > 1000 || options.nodes.some(node => typeof node !== "string"))) throw new GraphInputError("invalid_graph", "排版范围必须是有界节点列表");
        if (options.mode !== undefined && !["tree", "compact"].includes(String(options.mode))) throw new GraphInputError("invalid_graph", "排版模式无效");
        if (action === "layout_arrange" && (!options.base || typeof options.base !== "object" || Array.isArray(options.base) || Object.keys(options).some(key => !["nodes", "mode", "base", "revision"].includes(key)))) throw new GraphInputError("invalid_graph", "排版需要节点布局基线");
        const positions = action !== "layout_move" ? arrangeGraph(state.spec, state.layout.positions, typeof options.node === "string" ? options.node : undefined, false, [...this.graph.records<ResearchNode>(context.project, "nodes")], { nodes: options.nodes as string[] | undefined, mode: options.mode as "tree" | "compact" | undefined }) : parse(params.positions) as Record<string, GraphPosition>;
        const baseline = options.base as Record<string, GraphPosition> | undefined;
        result = action === "layout_arrange" && baseline
          ? this.graph.documents.patchLayout(context, params.request, Object.fromEntries(Object.entries(positions).filter(([node]) => Object.hasOwn(baseline, node)).map(([node, point]) => [node, { position: { x: point.x, y: point.y } }])), baseline, true, digest({ action, params }))
          : this.graph.documents.move(context, params.request, positions, params.revision, params.lease, action === "layout_auto" ? digest({ action, params }) : undefined);
      } catch (error) {
        if (!(error instanceof GraphInputError)) throw error;
        return { status: "rejected", error: { code: error.code, message: error.message, path: error.path } };
      }
      this.changed(context.project, "layout");
      return result;
    }
    if (action === "ref_describe") {
      let resource: ResearchNode;
      try { resource = this.graph.resourceNode(context.project, params.ref); }
      catch { return { ref: params.ref, status: "missing", tools: [], message: "图引用保留；资源尚未登记或暂不可用" }; }
      const names = hasTextFile(resource) ? ["document_read", "document_write", "text_versions", "text_restore"]
        : resource.type === "agent" ? ["resource_read", "agent_send", "agent_stop", "session_read", "session_file_read"]
        : resource.type === "adapter" ? ["adapter_publish", "adapter_control"]
        : resource.type === "file" && resource.data.workspace ? ["resource_read", "file_write"]
        : resource.type === "file" || resource.type === "audio" ? ["resource_read", "file_versions", "file_begin", "file_chunk", "file_commit"]
        : ["resource_read"];
      return { ref: params.ref, status: "available", resource,
        ...(resource.type === "adapter" ? { plugin: resource.data.adapter } : {}),
        // The first window of the body; `next` continues it through document_read's offset.
        ...(hasTextFile(resource) ? { file: this.graph.texts.readWindow(context.project, resource, 0) } : {}),
        tools: tools.filter(tool => names.includes(tool.name)).map(tool => ({ ...tool, defaults: { node: resource.id, ...(tool.name === "document_read" ? { field: "text" } : {}) } })),
      };
    }
    if (action === "file_link") {
      if (!this.native) throw new Error("Runner 文件模块不可用");
      const agent = this.graph.resolveResource(context.project, params.agent);
      const binding = this.resources.binding(context, agent.id, "session");
      const path = boundFilePath(binding, params.path);
      const part = await this.native.files.read(context, binding, { path });
      result = this.graph.mutate(context, "ref_create", {
        request: params.request, data: JSON.stringify({
          type: "file", title: params.title ?? part.file.name,
          data: { workspace: { agent: agent.id, path, binding: binding.version } },
        }),
      });
      this.changed(context.project);
      return result;
    }
    if (action === "discussion_capture") { result = await (this.workbench?.discussions ?? new ResearchDiscussions(this.graph, this.resources)).capture(context, params); this.changed(context.project); return result; }
    if (action === "file_write") return this.writeLinkedFile(context, params);
    if (action === "document_write") {
      result = this.collaboration.write(context, params);
      // A staged begin/append changes nothing anyone can see yet.
      if (params.stage !== "begin" && params.stage !== "append") this.changed(context.project);
      return result;
    }
    if (action === "text_versions") return this.graph.texts.versions(context.project, this.graph.resolveResource(context.project, params.node).id, params.after);
    if (action === "text_restore") return this.collaboration.write(context, { request: params.request, node: params.node, restore: params.version });
    if (action === "canvas_read") {
      const graph = this.graph.read(context, params);
      return params.node
        ? {
            ...object(graph),
            ...(hasTextFile(this.graph.node(context.project, params.node, true)) ? this.collaboration.textPreview(context, params.node) : { text: undefined }),
          }
        : graph;
    }
    if (params.node && ["resource_bind", "resource_read", "file_versions", "file_begin", "agent_send", "agent_stop", "audio_transcribe", "group_send", "session_read", "session_file_read", "session_attach", "session_respond"].includes(action))
      params = { ...params, node: this.graph.resolveResource(context.project, params.node).id };
    if (action === "canvas_layout_check" || action === "canvas_snapshot")
      return new ResearchCanvasInspection(this.graph, this.collaboration).inspect(context, params, action === "canvas_snapshot");
    if (action === "canvas_changes")
      return this.graph.changes(context, params.after);
    if (action === "document_read")
      return this.collaboration.document(context, params);
    if (
      action === "proposal_resolve" &&
      this.graph.repo.get<ResearchProposal>(
        context.project,
        "proposals",
        params.proposal,
      )?.action === "document_replace"
    )
      result = this.collaboration.resolveProposal(context, params);
    else if (
      action.startsWith("node_") ||
      action.startsWith("edge_") ||
      action === "ref_create" ||
      action === "adapter_register" ||
      action === "adapter_publish" ||
      action === "adapter_control" ||
      action === "review_decide" ||
      action === "proposal_resolve"
    )
      result = this.graph.mutate(context, action, params);
    else if (action === "resources_list")
      return { resources: await this.resources.list(context) };
    else if (action === "resource_bind")
      result = await this.resources.bind(context, params, () => {
        if (!this.capabilities.allowed(context, "manage_resources")) throw new Error("资源绑定授权已撤销");
      });
    else if (action === "resource_read") {
      const node = this.graph.resolveResource(context.project, params.node);
      if (node.type === "file" && node.data.workspace) {
        const { binding, path } = this.linkedFile(context, node, "read_project");
        if (!this.native) throw new Error("Runner 文件模块不可用");
        return this.native.files.read(context, binding, { ...params, path });
      }
      return node.type === "agent"
        ? this.automation.history(context, node.id, params.cursor)
        : this.resources.read(context, params);
    } else if (action === "file_versions")
      return this.resources.versions(context, params);
    else if (action === "file_begin")
      result = this.resources.begin(context, params);
    else if (action === "file_chunk")
      return this.resources.chunk(context, params);
    else if (action === "file_commit")
      result = this.resources.commit(context, params);
    else if (action === "agent_send")
      result = this.automation.send(context, params);
    else if (action === "audio_transcribe") {
      if (params.summary && parse(params.summary).kind !== "none") await this.capabilities.check(context, "run_agent");
      if (params.summary && parse(params.summary).kind === "codex") await this.capabilities.check(context, "manage_resources");
      result = this.workbench?.meeting ? await this.workbench.meeting.transcribe(context, params) : this.automation.transcribe(context, params);
    }
    else if (action === "agent_stop") {
      if (params.node && this.graph.repo.get<ResearchRun>(context.project, "runs", params.run)?.node !== params.node)
        throw new Error("运行不属于此 Agent ref");
      result = await this.automation.stop(context, params);
    }
    else if (action.startsWith("session_")) {
      if (!this.native) throw new Error("Runner 会话模块不可用");
      const binding = this.resources.binding(context, params.node, "session");
      if (action === "session_file_read")
        return this.native.files.read(context, binding, params);
      if (action === "session_read")
        return {
          transcript: await this.native.read(
            context,
            binding,
            params.conversation,
            params.offset,
          ),
        };
      if (action === "session_attach")
        result = await this.native.attachFile(context, binding, params);
      else if (action === "session_respond")
        result = await this.native.respond(context, binding, params);
      else throw new Error("会话动作未登记");
    } else if (action === "group_send")
      result = await this.resources.send(context, params);
    else if (action === "subscription_save")
      result = this.automation.save(context, params);
    else if (action === "tools_search") {
      const query = params.query?.toLowerCase() ?? "";
      const matches = tools.filter((tool) =>
        `${tool.name} ${tool.description}`.toLowerCase().includes(query),
      );
      const nodes = [
        ...this.graph.records<ResearchNode>(context.project, "nodes"),
      ].filter(
        (node) =>
          !node.archived &&
          (!params.node || node.id === params.node) &&
          (!query ||
            `${node.title} ${node.type}`.toLowerCase().includes(query)),
      );
      return {
        tools: matches.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
        nodes: nodes
          .slice(0, 40)
          .map((node) => ({ id: node.id, type: node.type, title: node.title })),
        hasMore: nodes.length > 40,
        cursor: this.graph.repo.cursor(context.project),
      };
    } else if (action === "tools_describe") {
      const tool = tools.find((tool) => tool.name === params.tool);
      if (!tool) throw new Error("工具未登记");
      return tool;
    } else if (action === "tools_invoke") {
      if (params.tool.startsWith("tools_"))
        throw new Error("工具调用不能递归调用目录");
      return this.invokeTool(context, params.tool, parse(params.params));
    } else throw new Error("此资源适配器尚不可用");
    this.changed(context.project);
    return new ResearchCanvasInspection(this.graph, this.collaboration).receipt(context, action, params, result);
  }
  async readPaperLocal(context: ResearchContext, id: string): Promise<{ text: string; digest: string }> {
    await this.capabilities.check(context, "read_project", id);
    const node = this.graph.resolveResource(context.project, id);
    if (hasTextFile(node)) {
      const file = this.graph.texts.read(context.project, node);
      return { text: file.text, digest: file.revision };
    }
    const { binding, path } = this.linkedFile(context, node, "read_project");
    if (!this.native || !/\.(md|txt)$/i.test(path)) throw new Error("请选择可编辑的 Markdown 或文本文件");
    // Version-pinned windows to the end. The comparison needs the whole value, so it is
    // held to the same whole-body budget as note files; the windows themselves have no total.
    let cursor = "0", version = "";
    const chunks: Buffer[] = [];
    for (;;) {
      const part = await this.native.files.read(context, binding, { path, cursor, version });
      if (part.file.bytes > TEXT_WHOLE_BYTES) throw new Error(`大纲文件 ${(part.file.bytes / 1024 / 1024).toFixed(1)} MiB，超过同步比较一次整份载入的 16 MiB；请关联独立的短大纲文件`);
      version = part.file.sha256;
      chunks.push(Buffer.from(part.data, "base64"));
      if (part.next === null) {
        const value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        if (value.includes("\0")) throw new Error("大纲不是有效文本");
        return { text: value, digest: version };
      }
      cursor = String(part.next);
    }
  }
  async writePaperLocal(context: ResearchContext, id: string, value: string, expected: string, request: string, current: () => void = () => {}): Promise<void> {
    current();
    await this.capabilities.check(context, "edit_graph", id);
    current();
    const node = this.graph.resolveResource(context.project, id), action = hasTextFile(node) ? "document_write" : "file_write";
    const params = { node: id, text: value, expected, request: `paper:${digest(request).slice(0, 60)}` };
    const result = object(action === "document_write" ? this.collaboration.write(context, params) : await this.writeLinkedFile(context, params, current));
    current();
    this.workbench?.workflows.recordChange(context, action, params, result);
    if (result.status === "unknown") throw new Error(String(result.message ?? "本地保存结果待核对"));
  }
  private linkedFile(context: ResearchContext, node: ResearchNode, operation: string) {
    if (node.type !== "file" || !node.data.workspace) throw new Error("此资源不是工作区文件");
    const link = object(node.data.workspace);
    const agent = this.graph.resourceNode(context.project, String(link.agent));
    const binding = this.resources.binding(context, agent.id, "session", operation);
    if (binding.version !== link.binding) throw new Error("Agent 工作区绑定已变化；请重新登记文件 ref，原引用未转向其他文件");
    return { binding, path: boundFilePath(binding, String(link.path)) };
  }
  private async writeLinkedFile(context: ResearchContext, params: Record<string, string>, current: () => void = () => {}) {
    current();
    if (!this.native) throw new Error("Runner 文件模块不可用");
    const node = this.graph.resolveResource(context.project, params.node);
    if (object(node.data.meta ?? {}).read_only === true) throw new Error("此来源资源只读");
    const { binding, path } = this.linkedFile(context, node, "edit_graph");
    // A text larger than one call is staged on the device (begin → append × N
    // → commit); only commit replaces the file, through the same receipts below.
    if (params.stage === "begin") {
      const before = await this.native.files.read(context, binding, { path });
      current();
      if (params.expected && before.file.sha256 !== params.expected) throw new Error("本地文件已变化，请重新比较；未覆盖新内容");
      // `digest` is the commit's precondition: pass it back as `expected`.
      return { ...await this.native.files.stage(context, binding, { path, token: uploadToken(), step: "begin", digest: before.file.sha256 }),
        digest: before.file.sha256 };
    }
    if (params.stage === "append") {
      return await this.native.files.stage(context, binding, { path, token: String(params.upload ?? ""), step: "append",
        offset: integer(params.offset, 0, Number.MAX_SAFE_INTEGER), text: text(params.text, "文件正文", Number.MAX_SAFE_INTEGER, "") });
    }
    if (params.stage === "commit" && !params.expected) throw new Error("分段保存的 commit 需要 begin 回答的 digest 作为 expected");
    // Malformed commit arguments are refusals before any intent is recorded, not an "unknown" write.
    if (params.stage === "commit" && !UPLOAD_TOKEN.test(String(params.upload ?? ""))) throw new Error("分段保存的 upload 无效");
    const stagedSize = params.stage === "commit" ? integer(params.size, 0, Number.MAX_SAFE_INTEGER) : 0;
    // `text` is optional only for staged steps: a whole save without it is a
    // malformed call, never "replace the file with nothing".
    if (params.stage === undefined && typeof params.text !== "string") throw new Error("整份保存需要 text");
    if (params.stage !== undefined && params.stage !== "commit") throw new Error("分段保存的步骤无效");
    const actor = "file:" + context.actor.kind + ":" + context.actor.owner + ":" + (context.actor.agent ?? "");
    // A staged commit is identified by what it commits, not by the upload
    // carrying it, so a retried save joins the first one's receipt or intent.
    const fingerprint = digest(params.stage === "commit" ? { ...params, upload: undefined } : params);
    const prior = this.graph.repo.receipt(context.project, actor, params.request, fingerprint);
    if (prior !== null) return prior;
    const key = digest({ actor, request: params.request });
    const intent = this.graph.repo.get<{ fingerprint: string }>(context.project, "file-write-intents", key);
    if (intent) {
      if (intent.fingerprint !== fingerprint) throw new Error("请求 ID 已用于不同内容");
      return { status: "unknown", message: "之前的写入结果尚未确认；请读取真实文件后决定下一次编辑，不会重放覆盖" };
    }
    const before = await this.native.files.read(context, binding, { path });
    current();
    if (params.expected && before.file.sha256 !== params.expected) throw new Error("本地文件已变化，请重新比较；未覆盖新内容");
    if (this.graph.repo.get(context.project, "file-write-intents", key))
      return { status: "unknown", message: "相同写入正在处理，请读取文件确认结果" };
    this.graph.repo.put(context.project, "file-write-intents", key, {
      fingerprint, node: node.id, path, digest: before.file.sha256, at: new Date().toISOString(),
    });
    let result: unknown;
    try {
      current();
      result = params.stage === "commit"
        ? await this.native.files.commit(context, binding, { path, token: String(params.upload), digest: before.file.sha256, size: stagedSize })
        : await this.native.files.write(context, binding, { path, text: params.text, digest: before.file.sha256 });
      current();
    }
    catch (error) {
      result = { status: "unknown", message: String(error).slice(0, 500) + "；请读取真实文件确认，未自动重试" };
    }
    this.graph.repo.remember(context.project, actor, params.request, fingerprint, result);
    this.changed(context.project);
    return result;
  }
  private context(binding: SessionPlusInstanceBinding): ResearchContext {
    if (
      !isResearchCanvasContract(
        binding.stableAppId,
        RESEARCH_PUBLISHER,
        binding.contractDigest,
      ) ||
      !binding.sharedInstanceKey
    )
      throw new Error("研究项目契约不匹配");
    return {
      project: binding.sharedInstanceKey,
      actor:
        binding.actor.kind === "agent"
          ? {
              kind: "agent",
              owner: binding.owner,
              agent: binding.actor.agent,
              run: binding.actor.turnId,
              model: null,
            }
          : { kind: "human", owner: binding.owner },
    };
  }
}
