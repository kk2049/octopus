import {
  canvasScope,
  diagnoseCanvasLayout,
  renderCanvasSnapshot,
  type CanvasLayoutInput,
  type CanvasLayoutMode,
  type CanvasPosition,
  type GraphEdgePorts,
  type CanvasRelationMode,
  type ResearchEdge,
  type ResearchNode,
  type ResearchProposal,
  type ResearchSubscription,
} from "@claude-bot/research-canvas-contract";
import type { ResearchCollaboration } from "./collaboration.js";
import type { ResearchContext, ResearchGraph } from "./graph.js";
import { object, parse } from "./validation.js";

/** Inspection is instance-bound, read-only and cannot fetch URLs or start browsers. */
export class ResearchCanvasInspection {
  constructor(private readonly graph: ResearchGraph, private readonly collaboration: ResearchCollaboration) {}

  private input(context: ResearchContext): CanvasLayoutInput & { revision: string } {
    this.graph.role(context);
    const read = <T extends { id: string }>(bucket: "nodes" | "edges" | "subscriptions", limit: number): T[] => {
      const rows: T[] = [];
      for (const row of this.graph.records<T>(context.project, bucket)) {
        if (rows.length === limit) throw new Error("项目超过结构检查读取预算，请拆分项目后重试");
        rows.push(row);
      }
      return rows;
    };
    const nodes = read<ResearchNode>("nodes", 2_000);
    const edges = read<ResearchEdge>("edges", 5_000);
    const subscriptions = read<ResearchSubscription>("subscriptions", 500);
    const document = this.collaboration.document(context, { node: "board", field: "layout" });
    return { nodes, edges, subscriptions, positions: object(document.data).positions as Record<string, CanvasPosition>, edgePorts: object(document.data).edgePorts as Record<string, GraphEdgePorts> | undefined, revision: document.revision };
  }

  inspect(context: ResearchContext, params: Record<string, string>, snapshot = false) {
    const input = this.input(context);
    const expanded: unknown = params.expanded ? JSON.parse(params.expanded) : undefined;
    if (expanded !== undefined && (!Array.isArray(expanded) || expanded.length > 1000 || expanded.some(id => typeof id !== "string" || id.length > 160))) throw new Error("展开节点必须是有界 ID 数组");
    const scoped = { ...input, expanded: expanded as string[] | undefined, scope: params.scope ?? "", relations: params.relations as CanvasRelationMode | undefined, layout: params.layout as CanvasLayoutMode | undefined };
    return {
      project: context.project,
      cursor: this.graph.repo.cursor(context.project),
      layoutRevision: input.revision,
      ...(snapshot ? renderCanvasSnapshot(scoped) : diagnoseCanvasLayout(scoped)),
    };
  }

  /** A successful edit stays successful if optional diagnostics hit their budget. */
  receipt(context: ResearchContext, action: string, params: Record<string, string>, result: unknown): unknown {
    if (!(["node_add", "node_update", "node_archive", "edge_add", "edge_archive", "document_propose", "proposal_resolve", "subscription_save"].includes(action) || action === "doc_apply" && params.field === "layout")) return result;
    if (action === "document_propose" && params.field !== "layout") return result;
    const receipt = object(result);
    try {
      let input = this.input(context);
      const proposal = receipt.proposal as ResearchProposal | undefined;
      const pending = proposal?.state === "pending";
      let layout: CanvasLayoutMode = "canvas";
      const affected = new Set<string>();
      let allScopes = false;
      if (proposal?.action === "document_replace" && proposal.params.field === "layout") {
        const positions = object(parse(proposal.params.data).positions) as Record<string, CanvasPosition>;
        const before = object(parse(proposal.params.before).positions) as Record<string, CanvasPosition>;
        // Prioritize changed scopes, not the first four folders in the project.
        // Replacement drops omitted coordinates, so compare effective fallbacks too.
        for (const node of input.nodes) {
          const prior = before[node.id] ?? node, next = positions[node.id] ?? node;
          if (prior.x !== next.x || prior.y !== next.y) affected.add(node.id);
        }
        if (pending) input = { ...input, positions };
        layout = "canvas";
      } else if (pending && proposal.action === "node_update") {
        const patch = parse(proposal.params.data);
        input = { ...input, nodes: input.nodes.map((node) => node.id === proposal.params.node ? { ...node, ...patch } as ResearchNode : node) };
        affected.add(proposal.params.node);
        const prior = this.graph.node(context.project, proposal.params.node);
        for (const id of Array.isArray(prior.data.members) ? prior.data.members : []) if (typeof id === "string") affected.add(id);
      } else if (pending && proposal.action === "node_archive") {
        const prior = this.graph.node(context.project, proposal.params.node);
        input = { ...input, nodes: input.nodes.map((node) => node.id === prior.id ? { ...node, archived: true } : node) };
        affected.add(prior.id);
        for (const id of Array.isArray(prior.data.members) ? prior.data.members : []) if (typeof id === "string") affected.add(id);
      } else if (action === "doc_apply") {
        allScopes = true;
        layout = "canvas";
      }
      const changedNode = receipt.node as ResearchNode | undefined;
      const changedEdge = receipt.edge as ResearchEdge | undefined;
      for (const id of [changedNode?.id, changedEdge?.source, changedEdge?.target, params.node, params.source, params.target]) if (id) affected.add(id);
      const parents = canvasScope(input.nodes).parents;
      const scopes = new Set<string>();
      if (allScopes) {
        scopes.add("");
        for (const node of input.nodes) if (!node.archived && node.type === "folder") scopes.add(node.id);
      } else for (const id of affected) {
        const parent = parents.get(id);
        if (parent?.length) parent.forEach((scope) => scopes.add(scope));
        else scopes.add("");
        if (input.nodes.some((node) => node.id === id && node.type === "folder" && !node.archived)) scopes.add(id);
      }
      if (!scopes.size) scopes.add("");
      const reports = [...scopes].slice(0, 4).map((scope) => diagnoseCanvasLayout({ ...input, scope, layout }));
      const warnings = reports.flatMap((report) => report.warnings.map((warning) => ({ ...warning, scope: report.scope, layout: report.layout }))).slice(0, 30);
      if (scopes.size > reports.length && warnings.length < 30) warnings.push({ code: "inspection_limit", message: "本次回执最多检查 4 个层级；其余层级请通过 canvas_layout_check 分别检查。", nodes: [], edges: [], scope: "", layout });
      return { ...receipt, warnings, layoutDiagnostics: { state: pending ? "proposal" : "current", complete: scopes.size <= reports.length && reports.every((report) => report.complete), reports } };
    } catch (error) {
      return { ...receipt, warnings: [{ code: "inspection_unavailable", message: `修改已保存；布局检查未完成：${error instanceof Error ? error.message.slice(0, 180) : "检查失败"}`, nodes: [], edges: [] }], layoutDiagnostics: { complete: false, reports: [] } };
    }
  }
}
