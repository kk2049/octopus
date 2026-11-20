import { isHierarchyRelation, researchRole } from "@claude-bot/research-canvas-contract";
import { join } from "node:path";
import {
  NODE_TYPES,
  RESEARCH_APP,
  canEdit,
  canRun,
  type ProjectRole,
  type Provenance,
  type Json,
  type ResearchNode,
  type ResearchEdge,
  type GraphPosition,
  type ResearchProposal,
  type ResearchRun,
  type ResearchSubscription,
} from "@claude-bot/research-canvas-contract";
import type { Store } from "../store/store.js";
import type {
  ResearchBucket,
  ResearchCanvasRepository,
} from "../store/repositories/research-canvas.js";
import {
  coordinate,
  digest,
  id,
  integer,
  jsonObject,
  object,
  parse,
  text,
} from "./validation.js";
import { readSchedule } from "./schedule.js";
import { ResearchGraphDocuments, type IndexedGraphNode } from "./graph-documents.js";
import { ResearchTextFiles, hasTextFile } from "./text-files.js";
import type { GraphPatch } from "./graph-crdt.js";
import {
  adapterData,
  controlAdapter,
  createAdapterDescriptor,
  publishAdapter,
  type AdapterPublishInput,
  type AdapterRegisterInput,
} from "./projections.js";

export interface ResearchActor {
  owner: string;
  kind: "human" | "agent" | "system";
  agent?: string;
  run?: string;
  model?: string | null;
  trigger?: string;
}
export interface ResearchContext {
  project: string;
  actor: ResearchActor;
}

export class ResearchGraph {
  readonly repo: ResearchCanvasRepository;
  readonly documents: ResearchGraphDocuments;
  readonly texts: ResearchTextFiles;
  constructor(
    private readonly store: Pick<
      Store,
      "researchCanvas" | "getSharedAppInstance" | "getSharedAppMember"
    >,
    root: string,
    private readonly now = () => new Date().toISOString(),
    changed: (project: string) => void = () => {},
  ) {
    this.repo = store.researchCanvas;
    this.documents = new ResearchGraphDocuments(this.repo, root);
    this.texts = new ResearchTextFiles(this.repo, join(root, "projects"), (project, node) => this.documents.legacyText(project, node), changed);
  }
  role(context: ResearchContext): ProjectRole {
    const project = this.store.getSharedAppInstance(
      RESEARCH_APP,
      context.project,
    );
    const seat = this.store.getSharedAppMember(
      RESEARCH_APP,
      context.project,
      context.actor.owner,
    );
    if (
      !project ||
      project.status !== "open" ||
      !seat ||
      !["owner", "editor", "researcher", "viewer"].includes(seat.role)
    )
      throw new Error("项目不存在或成员权限已撤销");
    return seat.role as ProjectRole;
  }
  authorize(context: ResearchContext, operation: string): void {
    const role = this.role(context);
    if (
      ["manage_resources", "create_discussion_group"].includes(operation) &&
      (context.actor.kind !== "human" || role !== "owner")
    )
      throw new Error("仅项目管理者可以绑定共享资源");
    if (
      ["edit_project", "edit_graph", "sync_cloud_document"].includes(operation) &&
      !(canEdit(role) || (context.actor.kind === "agent" && canRun(role)))
    )
      throw new Error("没有项目编辑权限");
    if (["run_agent", "send_message", "transcribe_audio"].includes(operation) && !canRun(role))
      throw new Error("没有项目运行权限");
  }
  provenance(context: ResearchContext): Provenance {
    return {
      kind: context.actor.kind,
      owner: context.actor.owner,
      trigger: context.actor.trigger ?? context.actor.owner,
      agent: context.actor.agent ?? null,
      run: context.actor.run ?? null,
      model: context.actor.model ?? null,
      at: this.now(),
    };
  }
  close(): void { this.texts.close(); this.documents.close(); }
  title(project: string): string {
    const state = this.documents.inspect(project);
    const goals = Object.entries(state.spec.nodes).filter(([, node]) => node.ref.startsWith("goal:"))
      .flatMap(([id]) => { const item = this.repo.get<IndexedGraphNode>(project, "graph-nodes", id); return item ? [this.composeNode(project, item, state)] : []; });
    const children = new Set(Object.values(state.spec.edges).filter(edge => isHierarchyRelation(edge.relation)).map(edge => edge.to));
    return this.titleFromNodes(goals, children);
  }
  private titleFromNodes(records: ResearchNode[], children = new Set(records.filter(node => !node.archived).flatMap(node => Array.isArray(node.data.members) ? node.data.members : []))): string {
    const nodes = records.filter(node => !node.archived);
    const goals = nodes.filter(node => node.type === "goal");
    const goal = goals.find(node => !children.has(node.id) && researchRole(node) !== "target")
      ?? goals.find(node => !children.has(node.id))
      ?? goals.find(node => researchRole(node) !== "target")
      ?? goals[0];
    return goal?.title.replace(/\s*[·•|｜-]?\s*GOAL\s*$/i, "").trim().slice(0, 120) || "未命名科研项目";
  }
  /** Resource lifetime is independent from any card displaying it. */
  resourceNode(project: string, reference: string): ResearchNode {
    this.documents.inspect(project);
    const separator = reference.indexOf(":");
    const resourceId = separator < 0 ? reference : reference.slice(separator + 1);
    const resource = this.repo.get<ResearchNode>(project, "node-resources", resourceId);
    if (!resource || (separator >= 0 && reference.slice(0, separator) !== resource.type))
      throw new Error("引用资源不存在或类型不匹配");
    return resource;
  }
  resolveResource(project: string, reference: string): ResearchNode {
    if (reference.includes(":")) return this.resourceNode(project, reference);
    this.documents.inspect(project);
    const card = this.repo.get<IndexedGraphNode>(project, "graph-nodes", reference);
    return this.resourceNode(project, card?.ref ?? reference);
  }
  private composeNode(project: string, item: IndexedGraphNode, state: ReturnType<ResearchGraphDocuments["inspect"]>): ResearchNode {
    const resourceId = item.ref.slice(item.ref.indexOf(":") + 1);
    const found = this.repo.get<ResearchNode>(project, "node-resources", resourceId);
    const resource = found?.type === item.ref.split(":")[0] ? found : null;
    const position = state.layout.positions[item.id] ?? { x: resource?.x ?? 0, y: resource?.y ?? 0 };
    const data = { ...(resource?.data ?? {}) };
    const members = Object.values(state.spec.edges).filter(edge => edge.from === item.id && isHierarchyRelation(edge.relation) && state.spec.nodes[edge.to]).map(edge => edge.to);
    if (resource?.type === "folder" || members.length) data.members = members;
    return {
      ...(resource ?? { schema: 1, type: item.ref.split(":")[0], summary: "资源暂不可用", phase: "present" as const, data: {} }),
      id: item.id, ref: item.ref, title: item.label, version: item.version,
      resourceVersion: resource?.version, archived: item.archived,
      created: item.created, updated: item.updated, data, x: position.x, y: position.y,
    };
  }
  node(project: string, nodeId: string, archived = false): ResearchNode {
    const state = this.documents.inspect(project);
    const item = this.repo.get<IndexedGraphNode>(project, "graph-nodes", nodeId);
    if (!item || (item.archived && !archived)) throw new Error("节点不存在或已归档");
    return this.composeNode(project, item, state);
  }
  assertWritableNode(project: string, nodeId: string): ResearchNode {
    return this.node(project, nodeId);
  }
  *records<T extends { id: string }>(project: string, bucket: ResearchBucket): Generator<T> {
    const state = bucket === "nodes" || bucket === "edges" ? this.documents.inspect(project) : undefined;
    yield* this.recordsWithState<T>(project, bucket, state);
  }
  private *recordsWithState<T extends { id: string }>(project: string, bucket: ResearchBucket, state: ReturnType<ResearchGraphDocuments["inspect"]> | undefined): Generator<T> {
    const source = bucket === "nodes" ? "graph-nodes" : bucket === "edges" ? "graph-edges" : bucket;
    let after = "";
    for (;;) {
      const rows = this.repo.list<T>(project, source, after, 200);
      for (const row of rows) {
        if (bucket === "nodes") yield this.composeNode(project, row as unknown as IndexedGraphNode, state!) as unknown as T;
        else if (bucket === "edges") {
          const edge = row as unknown as ResearchEdge;
          yield { ...edge, archived: edge.archived || !state!.spec.nodes[edge.source] || !state!.spec.nodes[edge.target] } as unknown as T;
        } else yield row;
      }
      if (rows.length < 200) break;
      after = rows.at(-1)!.id;
    }
  }
  read(context: ResearchContext, params: Record<string, string>): unknown {
    const role = this.role(context);
    const exported = this.documents.snapshot(context);
    if (params.node) {
      const node = { ...this.node(context.project, params.node, true), snapshot: exported.snapshot };
      return {
        node: node.type === "review" ? this.withReviewStatus(context.project, node) : node,
        edges: [...this.records<ResearchEdge>(context.project, "edges")].filter(
          (e) => e.source === node.id || e.target === node.id,
        ),
        cursor: this.repo.cursor(context.project),
      };
    }
    // One shared lexical cursor for all semantic buckets. A busy bucket cannot
    // cause the slower buckets to skip rows when the client requests the next page.
    const buckets = ["nodes", "edges", "subscriptions", "proposals"] as const;
    const allNodes = [...this.records<ResearchNode>(context.project, "nodes")];
    const activeOnly = params.active === "true", pageSize = activeOnly ? 200 : 60;
    const nodeIndex = new Map(allNodes.map(node => [node.id, node]));
    const rows = buckets.map((bucket) =>
      (bucket === "nodes" ? allNodes : [...this.records<{ id: string }>(context.project, bucket)]).filter(row => row.id > (params.after ?? "") && (!activeOnly || !(row as { archived?: boolean }).archived)).slice(0, pageSize + 1),
    );
    const boundaries = rows
      .filter((row) => row.length > pageSize)
      .map((row) => row[pageSize - 1].id)
      .sort();
    const next = boundaries[0] ?? null;
    const page = Object.fromEntries(
      buckets.map((bucket, index) => [
        bucket,
        rows[index].filter((row) => next === null || row.id <= next),
      ]),
    ) as Record<string, unknown[]>;
    // Reviews are first-class nodes. Their status is derived from current target
    // versions so an old approval cannot silently survive a changed artifact.
    page.nodes = (page.nodes as ResearchNode[]).map((node) =>
      node.type === "review" ? this.withReviewStatus(context.project, node, nodeIndex) : node,
    );
    return {
      project: context.project,
      title: this.titleFromNodes(allNodes),
      viewer: context.actor.owner,
      role,
      ...page,
      nodes: (page.nodes as ResearchNode[]).map(node => ({ ...node, snapshot: exported.snapshot })),
      revision: exported.revision,
      next,
      runs: this.repo.runs(context.project, { limit: 30 }),
      cursor: this.repo.cursor(context.project),
      hasMore: next !== null,
    };
  }
  changes(context: ResearchContext, after: string): unknown {
    this.role(context);
    const exported = this.documents.snapshot(context);
    const rows = this.repo.changes(context.project, integer(after, 0, Number.MAX_SAFE_INTEGER));
    const page = rows.slice(0, 100);
    // Reuse projections only within this request. Reopening the full CRDT for
    // every changed resource/card allocated up to 100 copies of the graph.
    let state: ReturnType<ResearchGraphDocuments["inspect"]> | undefined;
    let nodes: ResearchNode[] | undefined;
    const nodesById = new Map<string, ResearchNode>();
    let edgesById: Map<string, ResearchEdge> | undefined;
    const readState = () => state ??= this.documents.inspect(context.project);
    const readNodes = () => {
      if (!nodes) {
        nodes = [...this.recordsWithState<ResearchNode>(context.project, "nodes", readState())];
        for (const node of nodes) nodesById.set(node.id, node);
      }
      return nodes;
    };
    const readNode = (nodeId: string) => {
      const cached = nodesById.get(nodeId);
      if (cached) return cached;
      // A lone card edit must not compose every other card in a large graph.
      const current = readState();
      const item = this.repo.get<IndexedGraphNode>(context.project, "graph-nodes", nodeId);
      if (!item) throw new Error("节点不存在或已归档");
      const node = this.composeNode(context.project, item, current);
      nodesById.set(nodeId, node);
      return node;
    };
    const readEdge = (edgeId: string) => {
      edgesById ??= new Map([...this.recordsWithState<ResearchEdge>(context.project, "edges", readState())].map(edge => [edge.id, edge]));
      return edgesById.get(edgeId) ?? null;
    };
    const changes = page.flatMap<{ bucket: string; id: string; seq: number; record: unknown }>(row => {
      if (row.bucket === "node-resources") {
        return readNodes()
          .filter(node => node.ref?.endsWith(":" + row.id))
          .map(node => ({ ...row, bucket: "nodes", id: node.id, record: { ...node, snapshot: exported.snapshot } }));
      }
      if (row.bucket === "graph-nodes") return [{ ...row, bucket: "nodes", record: { ...readNode(row.id), snapshot: exported.snapshot } }];
      if (row.bucket === "graph-edges") return [
        { ...row, bucket: "edges", record: readEdge(row.id) },

      ];
      return [{ ...row, record: ["subscriptions", "proposals", "runs"].includes(row.bucket) ? this.repo.get(context.project, row.bucket, row.id) : null }];
    });
    if (page.some(row => row.bucket === "graph-edges")) {
      // Any node may own contains edges; refresh once, not every container per edge.
      for (const node of readNodes())
        changes.push({ bucket: "nodes", id: node.id, seq: 0, record: { ...node, snapshot: exported.snapshot } });
    }
    const latest = [...new Map(changes.map(change => [change.bucket + ":" + change.id, change])).values()];
    return { changes: latest, revision: exported.revision, cursor: page.at(-1)?.seq ?? Number(after), hasMore: rows.length > 100 };
  }
  mutate(context: ResearchContext, action: string, params: Record<string, string>, _approved = false): unknown {
    this.authorize(context, "edit_project");
    const request = text(params.request, "请求 ID", 100);
    // External MCP assigns a new turn to every call. The request identity must survive it.
    const actorKey = `mutation:${context.actor.kind}:${context.actor.owner}:${context.actor.agent ?? ""}`;
    const fingerprint = digest({ action, params });
    const prior = this.repo.receipt(context.project, actorKey, request, fingerprint);
    if (prior !== null) return prior;
    const result = this.apply(context, action, params);
    this.repo.remember(context.project, actorKey, request, fingerprint, result);
    return result;
  }
  private edit(context: ResearchContext, action: string, params: Record<string, string>, patches: GraphPatch[], initial?: Record<string, GraphPosition>): unknown {
    return this.documents.patch(context, params.request, digest({ action, params }), patches, this.provenance(context), params.snapshot, initial);
  }
  private apply(
    context: ResearchContext,
    action: string,
    params: Record<string, string>,
    trusted = false,
  ): unknown {
    const stamp = this.provenance(context);
    if (action === "ref_create") return this.apply(context, "node_add", { ...params, data: JSON.stringify({ ...parse(params.data), attach: false }) });
    if (action === "adapter_register") {
      const data = parse(params.data);
      const input: AdapterRegisterInput = {
        title: text(data.title, "适配器标题", 200),
        summary: text(data.summary, "适配器摘要", 2000, "已登记，等待来源发布"),
        source: text(data.source ?? data.watch, "适配器来源", 1000),
        entry: text(data.entry, "适配器入口", 500),
        schema: data.schema as unknown as AdapterRegisterInput["schema"],
        tools: data.tools as unknown as AdapterRegisterInput["tools"],
      };
      const descriptor = createAdapterDescriptor(input, this.provenance(context), stamp.at);
      return this.apply(context, "node_add", {
        ...params,
        data: JSON.stringify({
          type: "adapter",
          attach: params.attach !== "false",
          title: input.title,
          summary: input.summary,
          phase: data.phase ?? "present",
          x: data.x ?? 0,
          y: data.y ?? 0,
          data: { adapter: descriptor as unknown as Json, ...(data.meta === undefined ? {} : { meta: data.meta }) },
        }),
      }, true);
    }
    if (action === "adapter_publish") {
      const prior = this.resolveResource(context.project, params.node);
      if (prior.type !== "adapter") throw new Error("目标不是适配器节点");
      const version = integer(params.version, 1, 2_147_483_647);
      if (prior.version !== version) throw new Error("适配器版本已变化");
      const descriptor = publishAdapter(adapterData(prior), parse(params.data) as unknown as AdapterPublishInput, this.provenance(context), stamp.at);
      const next: ResearchNode = { ...prior, version: version + 1, updated: stamp, data: { ...prior.data, adapter: descriptor as unknown as Json } };
      this.repo.put(context.project, "node-resources", next.id, next, version);
      return { node: { ...next, resourceVersion: next.version, ref: next.type + ":" + next.id } };
    }
    if (action === "adapter_control") {
      const prior = this.resolveResource(context.project, params.node);
      if (prior.type !== "adapter") throw new Error("目标不是适配器节点");
      const version = integer(params.version, 1, 2_147_483_647);
      if (prior.version !== version) throw new Error("适配器版本已变化");
      const state = text(params.state, "适配器状态", 20) as ReturnType<typeof adapterData>["status"];
      const descriptor = controlAdapter(adapterData(prior), state, this.provenance(context), stamp.at);
      const next: ResearchNode = { ...prior, version: version + 1, updated: stamp, data: { ...prior.data, adapter: descriptor as unknown as Json } };
      this.repo.put(context.project, "node-resources", next.id, next, version);
      return { node: { ...next, resourceVersion: next.version, ref: next.type + ":" + next.id } };
    }
    if (action === "review_decide") {
      if (context.actor.kind !== "human") throw new Error("只有人可以更新审查结论");
      const prior = this.resolveResource(context.project, params.node);
      if (prior.type !== "review") throw new Error("目标不是独立审查节点");
      const version = integer(params.version, 1, 2_147_483_647);
      if (prior.version !== version) throw new Error("审查节点版本已变化");
      const data = jsonObject(prior.data);
      const targets = this.targetVersions(context.project, data.targets);
      const provided = jsonObject(parse(params.targets));
      const targetKeys = Object.keys(targets).sort();
      const providedKeys = Object.keys(provided).sort();
      if (targetKeys.length !== providedKeys.length || targetKeys.some((key, index) => key !== providedKeys[index]))
        throw new Error("审查目标已变化，请重新读取");
      for (const [id, expected] of Object.entries(targets)) {
        if (provided[id] !== expected) throw new Error("审查目标已变化，请重新读取");
      }
      const decision = text(params.decision, "审查结论", 40);
      if (!["approved", "changes_requested", "pending"].includes(decision))
        throw new Error("审查结论无效");
      const next: ResearchNode = {
        ...prior, version: version + 1, updated: stamp,
        data: { ...prior.data, decision: { status: decision, targets, by: stamp.owner, at: stamp.at } },
      };
      this.repo.put(context.project, "node-resources", next.id, next, version);
      return { node: this.withReviewStatus(context.project, this.node(context.project, params.node)) };
    }
    if (action === "node_add") {
      const data = parse(params.data);
      const type = text(data.type, "节点类型", 60);
      if (!(NODE_TYPES as readonly string[]).includes(type)) throw new Error("尚未安装此节点插件");
      if (type === "adapter" && !trusted) throw new Error("适配器必须通过 adapter_register 登记");
      const parent = action === "node_add" && data.parent !== undefined ? data.parent as { id: string; label: string } : undefined;
      if (data.parent !== undefined) {
        if (!parent || Array.isArray(parent) || Object.keys(parent).some(key => !["id", "label"].includes(key)) || typeof parent !== "object" || !["contains", "decomposes"].includes(parent.label)) throw new Error("新节点归属关系无效");
        this.assertWritableNode(context.project, text(parent.id, "父节点", 100));
      }
      const nodeId = createdResourceId(context, params.request);
      let resource = this.repo.get<ResearchNode>(context.project, "node-resources", nodeId);
      if (!resource) {
        resource = {
          id: nodeId, version: 1, schema: 1, archived: false, created: stamp, updated: stamp, type,
          title: text(data.title, "标题", 200), summary: text(data.summary, "摘要", 2000, ""),
          phase: this.phase(data.phase ?? "present"), x: coordinate(data.x ?? 0), y: coordinate(data.y ?? 0),
          data: jsonObject(data.data),
        };
        this.validateNodeData(resource, context.project);
        this.repo.put(context.project, "node-resources", nodeId, resource, 0);
      }
      if (hasTextFile(resource)) this.texts.readWindow(context.project, resource, 0);
      if (data.attach === false) return { ref: resource.type + ":" + resource.id, resource, node: { ...resource, ref: resource.type + ":" + resource.id, resourceVersion: resource.version } };
      const patches: GraphPatch[] = [{ bucket: "nodes", id: nodeId, field: "create", value: { label: resource.title, ref: resource.type + ":" + nodeId } }];
      if (resource.type === "folder" && Array.isArray(resource.data.members))
        for (const child of resource.data.members)
          patches.push({ bucket: "edges", id: "member_" + digest([nodeId, child]).slice(0, 40), field: "create", value: { from: nodeId, to: child, relation: "contains" } });
      if (parent) patches.push({ bucket: "edges", id: "member_" + digest([parent.id, nodeId]).slice(0, 40), field: "create", value: { from: parent.id, to: nodeId, relation: parent.label } });
      const edit = this.edit(context, action, params, patches, data.x !== undefined || data.y !== undefined ? { [nodeId]: { x: coordinate(data.x ?? 0), y: coordinate(data.y ?? 0) } } : undefined);
      return { ref: resource.type + ":" + resource.id, node: this.node(context.project, nodeId, true), ...(parent ? { attached: true, parent: this.node(context.project, parent.id), edge: this.repo.get<ResearchEdge>(context.project, "graph-edges", "member_" + digest([parent.id, nodeId]).slice(0, 40)) } : {}), edit };
    }
    if (action === "node_update" || action === "node_archive") {
      const prior = this.node(context.project, params.node, true);
      if (!params.snapshot && !this.documents.received(context, params.request, digest({ action, params })) && prior.version !== integer(params.version, 1, 2_147_483_647))
        throw new Error("节点版本已变化，请重新读取");
      if (action === "node_archive") {
        const edit = this.edit(context, action, params, [{ bucket: "nodes", id: prior.id, field: "deleted", value: true }]);
        // Membership has no control over resources, subscriptions, or running agents.
        return { node: this.node(context.project, prior.id, true), edit };
      }
      const data = parse(params.data);
      if (Object.keys(data).some(key => !["title", "summary", "phase", "data", "cardKind"].includes(key)))
        throw new Error("不可修改节点身份；位置使用 layout_move");
      const patches: GraphPatch[] = [];
      if (data.title !== undefined) patches.push({ bucket: "nodes", id: prior.id, field: "label", value: text(data.title, "标题", 200) });
      const resource = this.resourceNode(context.project, prior.ref ?? prior.id);
      const next: ResearchNode = {
        ...resource, updated: stamp, version: resource.version + 1,
        summary: data.summary === undefined ? resource.summary : text(data.summary, "摘要", 2000, ""),
        phase: data.phase === undefined ? resource.phase : this.phase(data.phase),
        data: data.data === undefined ? resource.data : jsonObject(data.data),
      };
      if (data.cardKind !== undefined) {
        if (!hasTextFile(resource) || !["goal", "target", "motivation", "note", "task", "finding", "workgroup"].includes(String(data.cardKind))) throw new Error("此资源类型不能转换为内容卡片");
        next.data = { ...next.data, meta: { ...(next.data.meta && typeof next.data.meta === "object" && !Array.isArray(next.data.meta) ? next.data.meta : {}), cardKind: String(data.cardKind), researchRole: ["goal", "target", "motivation"].includes(String(data.cardKind)) ? String(data.cardKind) : null } };
      }
      this.validateNodeData(next, context.project);
      const modifiesResource = data.summary !== undefined || data.phase !== undefined || data.data !== undefined || data.cardKind !== undefined;
      if (modifiesResource && resource.data.meta && typeof resource.data.meta === "object" && !Array.isArray(resource.data.meta) && resource.data.meta.read_only === true)
        throw new Error("此来源资源只读；可以修改图中的标签和关系");
      if (data.data !== undefined && resource.type === "adapter") throw new Error("适配器内容请使用 adapter_publish 或 adapter_control");
      if (resource.type === "folder" && data.data !== undefined) {
        const members = new Set(Array.isArray(next.data.members) ? next.data.members as string[] : []);
        const edges = this.documents.inspect(context.project).spec.edges;
        for (const [edgeId, edge] of Object.entries(edges)) {
          if (edge.from !== prior.id || edge.relation !== "contains") continue;
          if (!members.delete(edge.to)) patches.push({ bucket: "edges", id: edgeId, field: "deleted", value: true });
        }
        for (const child of members)
          patches.push({ bucket: "edges", id: "member_" + digest([prior.id, child, params.request]).slice(0, 40), field: "create", value: { from: prior.id, to: child, relation: "contains" } });
      }
      const edit = this.edit(context, action, params, patches);
      if (modifiesResource) {
        const key = "resource:" + context.actor.kind + ":" + context.actor.owner + ":" + (context.actor.agent ?? "");
        const fingerprint = digest({ action, params });
        if (this.repo.receipt(context.project, key, params.request, fingerprint) === null) {
          if (hasTextFile(next) && data.data !== undefined && typeof next.data.text === "string")
            this.texts.write(context.project, resource, next.data.text);
          this.repo.atomic(() => {
            this.repo.put(context.project, "node-resources", resource.id, next, resource.version);
            this.repo.remember(context.project, key, params.request, fingerprint, { resource: resource.id });
          });
        }
      }
      return { node: this.node(context.project, prior.id, true), edit };
    }
    if (action === "edge_add") {
      this.node(context.project, params.source);
      this.node(context.project, params.target);
      const edgeId = "edge_" + digest([context.project, context.actor.kind, context.actor.owner, context.actor.agent ?? "", params.request]).slice(0, 40);
      const edit = this.edit(context, action, params, [{ bucket: "edges", id: edgeId, field: "create", value: { from: params.source, to: params.target, relation: text(params.label, "关系", 120) } }]);
      return { edge: this.repo.get<ResearchEdge>(context.project, "graph-edges", edgeId), edit };
    }
    if (action === "edge_archive") {
      this.documents.inspect(context.project);
      const edge = this.repo.get<ResearchEdge>(context.project, "graph-edges", params.edge);
      if (!edge) throw new Error("关系不存在");
      if (!params.snapshot && !this.documents.received(context, params.request, digest({ action, params })) && edge.version !== integer(params.version, 1, 2_147_483_647)) throw new Error("关系版本已变化，请重新读取");
      const edit = this.edit(context, action, params, [{ bucket: "edges", id: edge.id, field: "deleted", value: true }]);
      return { edge: this.repo.get<ResearchEdge>(context.project, "graph-edges", edge.id), edit };
    }
    if (action === "proposal_resolve") {
      if (context.actor.kind !== "human")
        throw new Error("只有人可以确认整理提案");
      const proposal = this.repo.get<ResearchProposal>(
        context.project,
        "proposals",
        params.proposal,
      );
      if (
        !proposal ||
        proposal.state !== "pending" ||
        proposal.version !== integer(params.version, 1, 2_147_483_647)
      )
        throw new Error("提案已处理或已变化");
      if (!["approve", "reject"].includes(params.decision))
        throw new Error("决定无效");
      // Authorship remains the proposing Agent; endorsement is a separate human stamp.
      const result =
        params.decision === "approve"
          ? this.apply(
              {
                ...context,
                actor: {
                  kind: "agent",
                  owner: proposal.created.owner,
                  agent: proposal.created.agent ?? undefined,
                  run: proposal.created.run ?? undefined,
                  model: proposal.created.model,
                  trigger: proposal.created.trigger,
                },
              },
              proposal.action,
              proposal.params,
            )
          : null;
      const next: ResearchProposal = {
        ...proposal,
        version: proposal.version + 1,
        state: params.decision === "approve" ? "approved" : "rejected",
        resolvedBy: stamp,
        updated: stamp,
      };
      this.repo.put(
        context.project,
        "proposals",
        next.id,
        next,
        proposal.version,
      );
      return { proposal: next, result };
    }
    throw new Error("未知研究图操作");
  }
  private targetVersions(project: string, value: unknown, nodes?: ReadonlyMap<string, ResearchNode>): Record<string, number> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("审查目标版本摘要无效");
    const targets: Record<string, number> = {};
    for (const [target, version] of Object.entries(value)) {
      if (nodes) { if (!nodes.has(target)) throw new Error("节点不存在或已归档"); }
      else this.node(project, target, true);
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new Error("审查目标版本无效");
      targets[target] = version;
    }
    return targets;
  }
  private withReviewStatus(project: string, node: ResearchNode, nodes?: ReadonlyMap<string, ResearchNode>): ResearchNode {
    if (node.type !== "review") return node;
    const nodeIndex = nodes ?? new Map([...this.records<ResearchNode>(project, "nodes")].map(item => [item.id, item]));
    const targets = this.targetVersions(project, node.data.targets, nodeIndex);
    const decision = node.data.decision;
    let status = "pending";
    if (decision && typeof decision === "object" && !Array.isArray(decision) && typeof decision.status === "string") status = decision.status;
    for (const [target, version] of Object.entries(targets)) {
      const current = nodeIndex.get(target);
      if (!current || current.archived || (current.resourceVersion ?? current.version) !== version) { status = "stale"; break; }
    }
    return { ...node, data: { ...node.data, reviewStatus: status } };
  }

  private phase(value: unknown): ResearchNode["phase"] {
    if (value !== "past" && value !== "present" && value !== "future")
      throw new Error("节点阶段无效");
    return value;
  }
  private validateNodeData(node: ResearchNode, project: string): void {
    // Config here is descriptive. Executable bindings are separate host records.
    const allowed: Record<string, string[]> = {
      note: ["text", "meta"],
      task: ["text", "meta"],
      finding: ["text", "meta"],
      agent: ["instructions", "meta"],
      group: ["meta"],
      // A workgroup is a local research coordination surface. It deliberately
      // has no Feishu binding; the semantic edges around it are the shared
      // roster and evidence index, while a real group node remains the only
      // kind that can send external messages.
      workgroup: ["text", "meta"],
      file: ["collection", "workspace", "meta"],
      audio: ["collection", "meta"],
      collection: ["description", "meta"],
      folder: ["description", "members", "meta"],
      goal: ["text", "meta"],
      review: ["targets", "decision", "meta"],
      adapter: ["adapter", "meta"],
      timer: ["schedule", "meta"],
    };
    if (
      Object.keys(node.data).some(
        (key) => !(allowed[node.type] ?? []).includes(key),
      )
    )
      throw new Error("节点数据包含不支持的字段");
    if (node.data.workspace !== undefined) {
      const linked = object(node.data.workspace);
      if (Object.keys(linked).some(key => !["agent", "path", "binding"].includes(key)))
        throw new Error("工作区引用字段无效");
      const agent = this.resourceNode(project, text(linked.agent, "Agent ref", 320));
      if (agent.type !== "agent") throw new Error("文件必须引用已绑定工作区的 Agent 资源");
      text(linked.path, "工作区相对路径", 2000);
      integer(linked.binding, 1, 2_147_483_647);
    }
    if (node.data.text !== undefined) text(node.data.text, "正文", 20_000, "");
    if (node.data.instructions !== undefined)
      text(node.data.instructions, "Agent 指令", 20_000, "");
    if (node.data.meta !== undefined) {
      const meta = object(node.data.meta);
      if (JSON.stringify(meta).length > 12_000)
        throw new Error("来源元数据过大");
      for (const [key, value] of Object.entries(meta)) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key))
          throw new Error("来源元数据键无效");
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null)
          throw new Error("来源元数据值必须是标量");
      }
    }
    if (node.type === "folder") {
      const members = node.data.members;
      if (members !== undefined) {
        if (!Array.isArray(members) || members.some((item) => typeof item !== "string"))
          throw new Error("文件夹成员必须是节点 ID 列表");
        const seen = new Set<string>();
        for (const member of members as string[]) {
          if (seen.has(member) || member === node.id) throw new Error("文件夹成员不能重复或包含自身");
          seen.add(member);
          this.node(project, member);
        }
      }
    }
    if (node.type === "review") {
      const targets = node.data.targets;
      if (!targets || typeof targets !== "object" || Array.isArray(targets)) throw new Error("审查节点需要目标版本摘要");
      for (const [target, version] of Object.entries(targets)) {
        this.node(project, target);
        if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new Error("审查目标版本无效");
      }
      if (node.data.decision !== undefined) jsonObject(node.data.decision);
    }
    if (node.type === "adapter" && node.data.adapter !== undefined) jsonObject(node.data.adapter);
    if (node.data.collection) {
      const collection = this.node(project, text(node.data.collection, "资料集合", 160));
      if (
        !collection ||
        collection.archived ||
        collection.type !== "collection"
      )
        throw new Error("资料集合不存在");
    }
    if (node.type === "timer" && node.data.schedule !== undefined)
      readSchedule(node.data.schedule);
  }
}

/** Stable registration identity shared by recoverable multi-step resource workflows. */
export const createdResourceId = (context: ResearchContext, request: string): string => "node_" + digest([context.project, context.actor.kind, context.actor.owner, context.actor.agent ?? "", request]).slice(0, 40);
