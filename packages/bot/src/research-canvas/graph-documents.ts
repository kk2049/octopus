import { CANVAS_SIZE_LIMITS, decompositionCycle } from "@claude-bot/research-canvas-contract";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { join } from "node:path";
import * as Y from "yjs";
import type {
  GraphEditResult,
  LayoutEdit,
  GraphEdgePorts,
  GraphPosition,
  GraphSpec,
  LayoutSnapshot,
  Provenance,
  ResearchEdge,
  ResearchNode,
} from "@claude-bot/research-canvas-contract";
import { CrdtDocumentStore } from "../crdt-doc/store.js";
import type { ResearchCanvasRepository } from "../store/repositories/research-canvas.js";
import type { ResearchContext } from "./graph.js";
import { applyGraphPatches, cloneGraph, compileGraphEdit, graphSpec, projectGraph, type GraphCoverage, type GraphPatch } from "./graph-crdt.js";
import { GraphInputError, readGraphYaml, writeGraphYaml } from "./graph-yaml.js";
import { arrangeGraph } from "./layout.js";
import { coordinate, digest, id, text } from "./validation.js";

interface SavedSnapshot {
  project: string;
  owner: string;
  expires: number;
  update: string;
  compressed?: boolean;
  coverage: GraphCoverage;
}
interface RequestMarker {
  actor: string;
  request: string;
  fingerprint: string;
  at: string;
  result: GraphEditResult & { layout?: LayoutSnapshot };
}
export interface IndexedGraphNode {
  id: string;
  ref: string;
  label: string;
  archived: boolean;
  version: number;
  created: Provenance;
  updated: Provenance;
}
const layoutSnapshot = (doc: Y.Doc): LayoutSnapshot => {
  // Encoding/reopening a Y.Doc can change map iteration order without changing
  // any geometry. A revision must describe the values, not that local order.
  const ordered = <T>(map: Y.Map<T>): Record<string, T> =>
    Object.fromEntries([...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const positions = ordered(doc.getMap<GraphPosition>("layout")), edgePorts = ordered(doc.getMap<GraphEdgePorts>("edgePorts"));
  return { positions, edgePorts, revision: digest(Object.keys(edgePorts).length ? { positions, edgePorts } : positions), sequence: Number(doc.getMap("meta").get("layoutSequence") ?? 0) };
};
type GraphInspection = { spec: GraphSpec; layout: LayoutSnapshot; revision: string };
const snapshotLifetime = 2 * 60 * 60 * 1000;
const actorKey = (context: ResearchContext) => `graph:${context.actor.kind}:${context.actor.owner}:${context.actor.agent ?? ""}`;
const markerKey = (context: ResearchContext, request: string) => digest([actorKey(context), request]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const docKey = (project: string) => `research_graph_${digest(project).slice(0, 48)}`;

/** One graph replica. SQL holds resource state and rebuildable graph indexes. */
export class ResearchGraphDocuments {
  private readonly docs: CrdtDocumentStore;
  private readonly legacy: CrdtDocumentStore;
  private readonly snapshotsRoot: string;
  private readonly exported = new Map<string, { snapshot: string; yaml: string; revision: string; expires: string; graph: GraphSpec }>();
  private readonly projections = new Map<string, GraphInspection>();
  private readonly recovered = new Set<string>();
  private readonly leases = new Map<string, { actor: string; token: string; expires: number }>();
  constructor(
    private readonly repo: ResearchCanvasRepository,
    root: string,
    private readonly now = Date.now,
  ) {
    // No document ceiling: the graph CRDT never leaves the Head whole. Clients read
    // paged projections (canvas_read) and scoped YAML exports, each bounded per call.
    this.docs = new CrdtDocumentStore({ root: join(root, "graphs") });
    this.legacy = new CrdtDocumentStore({ root: join(root, "documents") });
    this.snapshotsRoot = join(root, "graph-snapshots");
    mkdirSync(this.snapshotsRoot, { recursive: true, mode: 0o700 });
  }
  close(): void {
    this.docs.close();
    this.legacy.close();
    this.leases.clear();
    this.exported.clear();
    this.projections.clear(); this.recovered.clear();
  }
  private *rows<T extends { id: string }>(project: string, bucket: "nodes" | "edges"): Generator<T> {
    let after = "";
    for (;;) {
      const rows = this.repo.list<T>(project, bucket, after, 500);
      yield* rows;
      if (rows.length < 500) break;
      after = rows.at(-1)!.id;
    }
  }
  /** Legacy bytes remain in place. Resource copies and the seed marker are restart-safe. */
  private seed(project: string, doc: Y.Doc): void {
    if (doc.getMap("meta").get("schema") === 1) return;
    const nodes = [...this.rows<ResearchNode>(project, "nodes")];
    const edges = [...this.rows<ResearchEdge>(project, "edges")];
    const legacyLayout = this.legacy.read(`rv2_${digest([project, "board", "layout"]).slice(0, 48)}`);
    if (!legacyLayout.ok) throw new Error(legacyLayout.code);
    const layoutDoc = cloneGraph(legacyLayout.value.update);
    try {
      const positions = layoutDoc.getMap<GraphPosition>("layout");
      for (const node of nodes)
        if (!this.repo.get(project, "node-resources", node.id))
          this.repo.put(project, "node-resources", node.id, node, 0, false);
      doc.transact(() => {
        for (const node of nodes) {
          applyGraphPatches(doc, [{ bucket: "nodes", id: node.id, field: "create", value: { label: node.title, ref: `${node.type}:${node.id}` } }], node.created);
          const entry = doc.getMap<Y.Map<unknown>>("nodes").get(node.id)!;
          entry.set("legacyVersion", node.version);
          entry.set("updated", node.updated);
          entry.set("deleted", node.archived);
          doc.getMap("layout").set(node.id, positions.get(node.id) ?? { x: node.x, y: node.y });
        }
        for (const edge of edges) {
          applyGraphPatches(doc, [{ bucket: "edges", id: edge.id, field: "create", value: { from: edge.source, to: edge.target, relation: edge.label } }], edge.created);
          const entry = doc.getMap<Y.Map<unknown>>("edges").get(edge.id)!;
          entry.set("legacyVersion", edge.version);
          entry.set("updated", edge.updated);
          entry.set("deleted", edge.archived);
        }
        for (const node of nodes) {
          if (node.type !== "folder" || !Array.isArray(node.data.members)) continue;
          for (const child of node.data.members) {
            if (typeof child !== "string") continue;
            const edge = `member_${digest([node.id, child]).slice(0, 40)}`;
            applyGraphPatches(doc, [{ bucket: "edges", id: edge, field: "create", value: { from: node.id, to: child, relation: "contains" } }], node.created);
          }
        }
        doc.getMap("meta").set("schema", 1);
      });
      this.persist(project, Y.encodeStateAsUpdate(doc));
    } finally { layoutDoc.destroy(); }
  }
  private markRecovered(project: string): void {
    this.recovered.delete(project);
    if (this.recovered.size >= 32) this.recovered.delete(this.recovered.values().next().value!);
    this.recovered.add(project);
  }
  private persist(project: string, update: Uint8Array, layoutOnly = false): void {
    const written = this.docs.applyUpdate(docKey(project), update);
    if (!written.ok) throw new Error(written.code);
    this.projections.delete(project); this.recovered.delete(project);
    // Layout and receipts do not change the causal graph baseline. Keep its
    // persisted snapshot reusable, without a new full-state export per drag.
    if (!layoutOnly) for (const key of this.exported.keys())
      if (key.startsWith(project + ":")) this.exported.delete(key);
  }
  open(project: string): Y.Doc {
    const state = this.docs.read(docKey(project));
    if (!state.ok) throw new Error(state.code);
    const doc = cloneGraph(state.value.update);
    try {
      this.seed(project, doc);
      if (!this.recovered.has(project)) {
        for (const marker of doc.getMap<RequestMarker>("requests").values()) this.remember(project, marker);
        this.index(project, doc);
        this.markRecovered(project);
      }
      return doc;
    } catch (error) { doc.destroy(); throw error; }
  }
  private remember(project: string, marker: RequestMarker): void {
    if (this.repo.receipt(project, marker.actor, marker.request, marker.fingerprint) === null)
      this.repo.remember(project, marker.actor, marker.request, marker.fingerprint, marker.result);
  }
  /** These rows can be deleted and rebuilt; all graph changes come from the replica. */
  private index(project: string, doc: Y.Doc): void {
    this.repo.atomic(() => {
      for (const [id, entry] of doc.getMap<Y.Map<unknown>>("nodes")) {
        const prior = this.repo.get<IndexedGraphNode>(project, "graph-nodes", id);
        const shape = {
          id, ref: String(entry.get("ref")), label: String(entry.get("label")),
          archived: entry.get("deleted") === true,
          created: entry.get("created") as Provenance,
          updated: entry.get("updated") as Provenance,
        };
        if (prior && same({ ...prior, version: undefined }, shape)) continue;
        this.repo.put(project, "graph-nodes", id, { ...shape, version: prior ? prior.version + 1 : Number(entry.get("legacyVersion") ?? 1) });
      }
      for (const [id, entry] of doc.getMap<Y.Map<unknown>>("edges")) {
        const endpoints = entry.get("endpoints") as { from: string; to: string };
        const prior = this.repo.get<ResearchEdge>(project, "graph-edges", id);
        const shape = {
          id, source: endpoints.from, target: endpoints.to, label: String(entry.get("relation")),
          archived: entry.get("deleted") === true,
          created: entry.get("created") as Provenance,
          updated: entry.get("updated") as Provenance,
        };
        if (prior && same({ ...prior, version: undefined }, shape)) continue;
        this.repo.put(project, "graph-edges", id, { ...shape, version: prior ? prior.version + 1 : Number(entry.get("legacyVersion") ?? 1) });
      }
    });
  }
  inspect(project: string): GraphInspection {
    const cached = this.projections.get(project);
    if (cached) { this.projections.delete(project); this.projections.set(project, cached); return cached; }
    const doc = this.open(project);
    try {
      const spec = graphSpec(doc);
      const view = { spec, revision: digest(spec), layout: layoutSnapshot(doc) };
      if (this.projections.size >= 8) {
        const oldest = this.projections.keys().next().value!;
        this.projections.delete(oldest); this.recovered.delete(oldest);
      }
      this.projections.set(project, view);
      return view;
    } finally { doc.destroy(); }
  }
  snapshot(context: ResearchContext, scope?: string): { snapshot: string; yaml: string; revision: string; expires: string; graph: GraphSpec } {
    const cacheKey = context.project + ":" + digest([context.actor.owner, scope]);
    const cached = this.exported.get(cacheKey);
    if (cached && Date.parse(cached.expires) > this.now()) return cached;
    const doc = this.open(context.project);
    try {
      const spec = graphSpec(doc);
      let coverage: GraphCoverage = { nodes: Object.keys(spec.nodes), edges: Object.keys(spec.edges) };
      if (scope) {
        if (!spec.nodes[scope]) throw new GraphInputError("snapshot_scope", "读取范围不存在", scope);
        const selected = new Set([scope]);
        for (const edge of Object.values(spec.edges))
          if (edge.from === scope || edge.to === scope) { selected.add(edge.from); selected.add(edge.to); }
        coverage = { nodes: [...selected].filter(id => spec.nodes[id]), edges: Object.keys(spec.edges).filter(id => selected.has(spec.edges[id].from) && selected.has(spec.edges[id].to)) };
      }
      const token = `snapshot_${this.now()}_${id("s")}`;
      const yaml = writeGraphYaml(token, projectGraph(spec, coverage));
      this.pruneSnapshots();
      const saved: SavedSnapshot = { project: context.project, owner: context.actor.owner, expires: this.now() + snapshotLifetime, update: deflateSync(Y.encodeStateAsUpdate(doc)).toString("base64"), compressed: true, coverage };
      const handle = openSync(join(this.snapshotsRoot, token + ".json"), "wx", 0o600);
      try { writeFileSync(handle, JSON.stringify(saved)); fsyncSync(handle); } finally { closeSync(handle); }
      const directory = openSync(this.snapshotsRoot, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      const exported = { snapshot: token, yaml, graph: projectGraph(spec, coverage), revision: digest(spec), expires: new Date(saved.expires).toISOString() };
      if (this.exported.size >= 256) this.exported.delete(this.exported.keys().next().value!);
      this.exported.set(cacheKey, exported);
      return exported;
    } finally { doc.destroy(); }
  }
  private pruneSnapshots(): void {
    const active: string[] = [];
    for (const name of readdirSync(this.snapshotsRoot)) {
      const match = /^snapshot_(\d+)_.*\.json$/.exec(name);
      if (!match) continue;
      if (Number(match[1]) + snapshotLifetime < this.now()) unlinkSync(join(this.snapshotsRoot, name));
      else active.push(name);
    }
    if (active.length >= 4096) throw new GraphInputError("snapshot_scope", "活动快照过多，请复用已有快照");
  }
  private baseline(context: ResearchContext, token: string): SavedSnapshot {
    if (!/^snapshot_\d+_[A-Za-z0-9_-]+$/.test(token))
      throw new GraphInputError("snapshot_expired", "快照无效，请重新读取");
    const path = join(this.snapshotsRoot, token + ".json");
    if (!existsSync(path)) throw new GraphInputError("snapshot_expired", "快照已过期，请重新读取");
    const saved = JSON.parse(readFileSync(path, "utf8")) as SavedSnapshot;
    if (saved.project !== context.project || saved.owner !== context.actor.owner)
      throw new GraphInputError("snapshot_scope", "快照不属于当前项目或调用者");
    if (saved.expires < this.now()) throw new GraphInputError("snapshot_expired", "快照已过期，请重新读取");
    // The snapshot file is this Head's own deflate of a graph state, so it inflates without a ceiling.
    if (saved.compressed) saved.update = inflateSync(Buffer.from(saved.update, "base64")).toString("base64");
    return saved;
  }
  private prior(context: ResearchContext, request: string, fingerprint: string): (GraphEditResult & { layout?: LayoutSnapshot }) | null {
    return this.repo.receipt(context.project, actorKey(context), request, fingerprint);
  }
  received(context: ResearchContext, request: string, fingerprint: string): boolean {
    const doc = this.open(context.project);
    try { return this.prior(context, request, fingerprint) !== null; } finally { doc.destroy(); }
  }
  apply(context: ResearchContext, request: string, source: string, stamp: Provenance): GraphEditResult {
    text(request, "请求 ID", 100);
    const fingerprint = digest({ action: "graph_apply", source });
    const doc = this.open(context.project);
    try {
      const prior = this.prior(context, request, fingerprint);
      if (prior) return prior;
      const next = readGraphYaml(source), saved = this.baseline(context, next.snapshot);
      const before = Y.encodeStateAsUpdate(doc);
      const compiled = compileGraphEdit(Buffer.from(saved.update, "base64"), before, next, saved.coverage, stamp);
      try {
        const result: GraphEditResult = {
          status: compiled.conflicts.length || compiled.issues.some(issue => issue.code === "concurrent_delete") ? "merged_with_conflicts" : compiled.patches.length ? "merged" : "unchanged",
          revision: digest(graphSpec(compiled.merged)),
          changes: { nodes: [...new Set(compiled.patches.filter(p => p.bucket === "nodes").map(p => p.id))], edges: [...new Set(compiled.patches.filter(p => p.bucket === "edges").map(p => p.id))] },
          conflicts: compiled.conflicts,
          issues: compiled.issues,
        };
        this.commit(context, request, fingerprint, doc, compiled.merged, result);
        return result;
      } finally { compiled.merged.destroy(); }
    } finally { doc.destroy(); }
  }
  /** UI gestures and compatibility actions enter exactly the same graph replica. */
  patch(context: ResearchContext, request: string, fingerprint: string, patches: GraphPatch[], stamp: Provenance, token?: string, initial?: Record<string, GraphPosition>): GraphEditResult {
    const doc = this.open(context.project);
    try {
      const prior = this.prior(context, request, fingerprint);
      if (prior) return prior;
      const saved = token ? this.baseline(context, token) : null;
      const base = saved ? cloneGraph(Buffer.from(saved.update, "base64")) : cloneGraph(Y.encodeStateAsUpdate(doc));
      try {
        const spec = graphSpec(base);
        // Materialise desired fields only on this caller's baseline.
        applyGraphPatches(base, patches, stamp);
        const coverage = { nodes: Object.keys(spec.nodes), edges: Object.keys(spec.edges) };
        const compiled = compileGraphEdit(saved ? Buffer.from(saved.update, "base64") : Y.encodeStateAsUpdate(doc), Y.encodeStateAsUpdate(doc), graphSpec(base), coverage, stamp);
        try {
          const result: GraphEditResult = { status: compiled.conflicts.length || compiled.issues.some(issue => issue.code === "concurrent_delete") ? "merged_with_conflicts" : compiled.patches.length ? "merged" : "unchanged", revision: digest(graphSpec(compiled.merged)), changes: { nodes: [...new Set(patches.filter(p => p.bucket === "nodes").map(p => p.id))], edges: [...new Set(patches.filter(p => p.bucket === "edges").map(p => p.id))] }, conflicts: compiled.conflicts, issues: compiled.issues };
          if (initial) for (const [id, point] of Object.entries(initial))
            if (!doc.getMap("layout").has(id)) compiled.merged.getMap("layout").set(id, point);
          this.commit(context, request, fingerprint, doc, compiled.merged, result);
          return result;
        } finally { compiled.merged.destroy(); }
      } finally { base.destroy(); }
    } finally { doc.destroy(); }
  }
  private commit(context: ResearchContext, request: string, fingerprint: string, before: Y.Doc, after: Y.Doc, result: GraphEditResult & { layout?: LayoutSnapshot }): void {
    const cycle = decompositionCycle(graphSpec(after));
    if (cycle.length) throw new GraphInputError("invalid_graph", "目标分解不能形成循环：" + cycle.join(" → "));
    const positions = after.getMap<GraphPosition>("layout");
    for (const [node, point] of Object.entries(arrangeGraph(graphSpec(after), positions.toJSON(), undefined, true))) positions.set(node, point);
    const sequence = Number(before.getMap("meta").get("layoutSequence") ?? 0) + 1;
    after.getMap("meta").set("layoutSequence", sequence);
    if (result.layout) result.layout = layoutSnapshot(after);
    const marker: RequestMarker = { actor: actorKey(context), request, fingerprint, at: new Date(this.now()).toISOString(), result };
    const markers = after.getMap<RequestMarker>("requests");
    // Archived receipts are durable in SQL. Keep a bounded recovery bridge in the CRDT.
    for (const [key, previous] of [...markers].slice(0, Math.max(0, markers.size - 63)))
      if (this.repo.receipt(context.project, previous.actor, previous.request, previous.fingerprint) !== null) markers.delete(key);
    markers.set(markerKey(context, request), marker);
    this.persist(context.project, Y.encodeStateAsUpdate(after, Y.encodeStateVector(before)), Boolean(result.layout));
    this.index(context.project, after);
    this.remember(context.project, marker);
    this.markRecovered(context.project);
  }
  move(context: ResearchContext, request: string, positions: Record<string, GraphPosition>, revision: string, lease?: string, fingerprintOverride?: string): GraphEditResult & { layout: LayoutSnapshot } {
    text(request, "请求 ID", 100);
    if (!positions || typeof positions !== "object" || Array.isArray(positions)) throw new GraphInputError("invalid_graph", "positions 必须是坐标对象");
    const fingerprint = fingerprintOverride ?? digest({ action: "layout_move", positions, revision, lease });
    const doc = this.open(context.project);
    try {
      const prior = this.prior(context, request, fingerprint);
      if (prior?.layout) return { ...prior, layout: prior.layout };
      this.assertLease(context, lease);
      const current = doc.getMap<GraphPosition>("layout").toJSON();
      if (revision !== layoutSnapshot(doc).revision) throw new GraphInputError("layout_stale", "布局已变化，请重新读取或排版");
      if (Object.keys(positions).length > 1000) throw new GraphInputError("invalid_graph", "请分批调整位置");
      const nodes = graphSpec(doc).nodes;
      for (const [node, point] of Object.entries(positions)) {
        if (!nodes[node]) throw new GraphInputError("invalid_graph", "布局节点不存在", node);
        if (!point || typeof point !== "object" || Array.isArray(point)) throw new GraphInputError("invalid_graph", "坐标必须是对象", node);
        coordinate(point.x); coordinate(point.y);
        if (point.pinned !== undefined && typeof point.pinned !== "boolean")
          throw new GraphInputError("invalid_graph", "pinned 必须是布尔值", node);
        for (const field of ["width", "height"] as const) {
          const value = point[field], min = field === "width" ? CANVAS_SIZE_LIMITS.minWidth : CANVAS_SIZE_LIMITS.minHeight, max = field === "width" ? CANVAS_SIZE_LIMITS.maxWidth : CANVAS_SIZE_LIMITS.maxHeight;
          if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max))
            throw new GraphInputError("invalid_graph", `${field} 必须在 ${min}–${max} 之间`, node);
        }
        if (Object.keys(point).some(key => !["x", "y", "pinned", "width", "height"].includes(key)))
          throw new GraphInputError("invalid_graph", "布局字段无效", node);
      }
      const after = cloneGraph(Y.encodeStateAsUpdate(doc));
      try {
        after.transact(() => {
          for (const [node, point] of Object.entries(positions))
            after.getMap("layout").set(node, { ...current[node], ...point });
        });
        const result: GraphEditResult & { layout: LayoutSnapshot } = { layout: layoutSnapshot(after), status: "merged", revision: digest(graphSpec(after)), changes: { nodes: [], edges: [] }, conflicts: [], issues: [] };
        this.commit(context, request, fingerprint, doc, after, result);
        return result;
      } finally { after.destroy(); }
    } finally { doc.destroy(); }
  }
  /** The single authoritative Head serializes accepted field operations into Yjs.
   * No board lease/CAS: unrelated fields survive. Concurrent writes to one field
   * use Head acceptance order and return both intents. Retries keep their receipt. */
  patchLayout(context: ResearchContext, request: string, edits: Record<string, LayoutEdit>, base: Record<string, GraphPosition>, automatic = false, fingerprintOverride?: string, ports?: Record<string, GraphEdgePorts>, basePorts?: Record<string, GraphEdgePorts>): GraphEditResult & { layout: LayoutSnapshot } {
    text(request, "请求 ID", 100);
    const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    if (!object(edits) || !object(base) || Object.keys(edits).length > 1000) throw new GraphInputError("invalid_graph", "布局动作需要有界对象");
    if (ports !== undefined && (!object(ports) || !object(basePorts) || Object.keys(ports).length > 1000)) throw new GraphInputError("invalid_graph", "连线布局需要有界对象与基线");
    const fingerprint = fingerprintOverride ?? digest({ action: "layout_patch", edits, base, ...(ports === undefined ? {} : { ports, basePorts }) });
    const doc = this.open(context.project);
    try {
      const prior = this.prior(context, request, fingerprint);
      if (prior?.layout) return { ...prior, layout: prior.layout };
      const current = doc.getMap<GraphPosition>("layout").toJSON(), spec = graphSpec(doc), nodes = spec.nodes;
      const currentPorts = doc.getMap<GraphEdgePorts>("edgePorts").toJSON(), portChanges: Record<string, GraphEdgePorts> = Object.create(null);
      const conflicts: GraphEditResult["conflicts"] = [], issues: GraphEditResult["issues"] = [];
      const changes: Record<string, GraphPosition> = Object.create(null);
      const field = (point: GraphPosition | undefined, name: keyof LayoutEdit): unknown => !point ? null : name === "position" ? { x: point.x, y: point.y } : name === "size" ? { width: point.width ?? null, height: point.height ?? null } : point.pinned ?? false;
      for (const [node, edit] of Object.entries(edits)) {
        if (!object(edit) || Object.keys(edit).some(key => !["position", "size", "pinned"].includes(key))) throw new GraphInputError("invalid_graph", "布局字段无效", node);
        if (!Object.hasOwn(base, node) || !object(base[node])) throw new GraphInputError("invalid_graph", "缺少节点布局基线", node);
        if (edit.position !== undefined) {
          if (!object(edit.position) || Object.keys(edit.position).some(key => !["x", "y"].includes(key))) throw new GraphInputError("invalid_graph", "位置需要完整坐标对", node);
          coordinate(edit.position.x); coordinate(edit.position.y);
        }
        if (edit.size !== undefined) {
          if (!object(edit.size) || Object.keys(edit.size).some(key => !["width", "height"].includes(key))) throw new GraphInputError("invalid_graph", "尺寸需要完整宽高", node);
          for (const key of ["width", "height"] as const) {
            const value = edit.size[key], min = key === "width" ? CANVAS_SIZE_LIMITS.minWidth : CANVAS_SIZE_LIMITS.minHeight, max = key === "width" ? CANVAS_SIZE_LIMITS.maxWidth : CANVAS_SIZE_LIMITS.maxHeight;
            if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new GraphInputError("invalid_graph", "卡片尺寸超出范围", node);
          }
        }
        if (edit.pinned !== undefined && typeof edit.pinned !== "boolean") throw new GraphInputError("invalid_graph", "固定标记无效", node);
        if (!Object.hasOwn(nodes, node)) { issues.push({ code: "concurrent_delete", object: node, message: "节点已被摘除，布局动作不会恢复它" }); continue; }
        if (automatic && !same(base[node], current[node])) continue;
        for (const key of Object.keys(edit) as (keyof LayoutEdit)[]) {
          const was = field(base[node], key), now = field(current[node], key), submitted = edit[key];
          if (!same(was, now) && !same(now, submitted)) conflicts.push({ object: node, field: key, base: was, current: now, submitted, effective: submitted });
        }
        changes[node] = { ...current[node], ...edit.position, ...(edit.size ?? {}), ...(edit.pinned === undefined ? {} : { pinned: edit.pinned }) };
      }
      for (const [edge, edit] of Object.entries(ports ?? {})) {
        if (!object(edit) || Object.keys(edit).some(key => !["sourceSide", "targetSide"].includes(key))) throw new GraphInputError("invalid_graph", "连线方向字段无效", edge);
        if (!Object.hasOwn(basePorts!, edge) || !object(basePorts![edge])) throw new GraphInputError("invalid_graph", "缺少连线布局基线", edge);
        const link = spec.edges[edge];
        for (const side of Object.values(edit)) if (!["top", "right", "bottom", "left"].includes(String(side))) throw new GraphInputError("invalid_graph", "连线方向无效", edge);
        if (!link || !nodes[link.from] || !nodes[link.to]) { issues.push({ code: "concurrent_delete", object: edge, message: "关系已被摘除，布局动作不会恢复它" }); continue; }
        for (const key of Object.keys(edit) as (keyof GraphEdgePorts)[]) {
          const was = basePorts![edge][key] ?? null, now = currentPorts[edge]?.[key] ?? null, submitted = edit[key];
          if (!same(was, now) && !same(now, submitted)) conflicts.push({ object: edge, field: key, base: was, current: now, submitted, effective: submitted });
        }
        portChanges[edge] = { ...currentPorts[edge], ...edit };
      }
      const after = cloneGraph(Y.encodeStateAsUpdate(doc));
      try {
        after.transact(() => {
          for (const [node, point] of Object.entries(changes)) after.getMap("layout").set(node, point);
          for (const [edge, value] of Object.entries(portChanges)) after.getMap("edgePorts").set(edge, value);
        });
        const result: GraphEditResult & { layout: LayoutSnapshot } = { status: conflicts.length || issues.length ? "merged_with_conflicts" : Object.keys(changes).length || Object.keys(portChanges).length ? "merged" : "unchanged", revision: digest(graphSpec(after)), changes: { nodes: [], edges: [] }, conflicts, issues, layout: { revision: "", positions: {} } };
        this.commit(context, request, fingerprint, doc, after, result);
        return result;
      } finally { after.destroy(); }
    } finally { doc.destroy(); }
  }
  lease(context: ResearchContext, token?: string): { lease: string; expires: string } {
    const held = this.leases.get(context.project), actor = actorKey(context);
    if (held && held.expires > this.now() && (held.actor !== actor || token !== held.token))
      throw new GraphInputError("layout_busy", "这个视图正在调整布局");
    const next = { actor, token: held?.actor === actor && token === held.token ? held.token : id("layout"), expires: this.now() + 10_000 };
    this.leases.set(context.project, next);
    return { lease: next.token, expires: new Date(next.expires).toISOString() };
  }
  release(context: ResearchContext, token: string): void {
    const held = this.leases.get(context.project);
    if (held?.actor === actorKey(context) && held.token === token) this.leases.delete(context.project);
  }
  private assertLease(context: ResearchContext, token?: string): void {
    const held = this.leases.get(context.project);
    if (token && (!held || held.expires <= this.now() || held.token !== token || held.actor !== actorKey(context)))
      throw new GraphInputError("layout_stale", "布局动作已过期，请重新开始");
    if (held && held.expires > this.now() && (held.actor !== actorKey(context) || held.token !== token))
      throw new GraphInputError("layout_busy", "这个视图正在调整布局");
  }
  legacyText(project: string, node: ResearchNode): string {
    const state = this.legacy.read(`rv2_${digest([project, node.id, "text"]).slice(0, 48)}`);
    if (!state.ok) throw new Error(state.code);
    const doc = cloneGraph(state.value.update);
    try { return doc.getMap("meta").get("seeded") ? doc.getText("text").toString() : typeof node.data.text === "string" ? node.data.text : ""; }
    finally { doc.destroy(); }
  }
}
