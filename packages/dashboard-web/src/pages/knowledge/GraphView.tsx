import { dateLocale } from "../../lib/format.js";
import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, errorText } from "../../lib/api.js";
import { Loading } from "../../ui/misc.js";
import styles from "./GraphView.module.css";
import {
  AUTHORITY_LABEL,
  KIND_LABEL,
  RELATION_LABEL,
  STATUS_LABEL,
  type WikiGraphEdge,
  type WikiGraphNode,
  type WikiGraphView,
} from "./types.js";

const GRAPH_PATH = "/api/knowledge/graph";
const COLORS = ["#71d6c2", "#f2c66d", "#ef7d73", "#8ca8ff", "#c29bea", "#75b8e7", "#b3d66f", "#e59b63"] as const;
const RELATION_COLORS = ["#85d7c9", "#e9bf65", "#ec8276", "#98aeef", "#c29bea", "#91c7e8"] as const;

interface PositionedNode extends WikiGraphNode {
  x: number;
  y: number;
  color: string;
  shape: number;
  degree: number;
}

interface KindCluster {
  kind: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  count: number;
}

interface GraphLayout {
  key: string;
  width: number;
  height: number;
  nodes: PositionedNode[];
  byId: Map<string, PositionedNode>;
  clusters: KindCluster[];
}

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function hash(value: string): number {
  let out = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    out ^= value.charCodeAt(index);
    out = Math.imul(out, 16777619);
  }
  return out >>> 0;
}

function labelFor(map: Record<string, string>, value: string): string {
  return map[value] ?? value.replaceAll("_", " ");
}

function buildLayout(data: WikiGraphView): GraphLayout {
  const degree = new Map<string, number>();
  for (const edge of data.edges ?? []) {
    degree.set(edge.from_id, (degree.get(edge.from_id) ?? 0) + 1);
    degree.set(edge.to_id, (degree.get(edge.to_id) ?? 0) + 1);
  }
  const groups = new Map<string, WikiGraphNode[]>();
  for (const node of data.nodes ?? []) {
    const bucket = groups.get(node.kind) ?? [];
    bucket.push(node);
    groups.set(node.kind, bucket);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => labelFor(KIND_LABEL(), a).localeCompare(labelFor(KIND_LABEL(), b), dateLocale()));
  const largest = Math.max(1, ...ordered.map(([, nodes]) => nodes.length));
  const cellWidth = Math.max(330, Math.ceil(Math.sqrt(largest)) * 18 + 110);
  const cellHeight = Math.max(250, Math.ceil(Math.sqrt(largest)) * 16 + 100);
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length * 1.65)));
  const rows = Math.max(1, Math.ceil(ordered.length / columns));
  const width = Math.max(960, columns * cellWidth);
  const height = Math.max(620, rows * cellHeight);
  const nodes: PositionedNode[] = [];
  const clusters: KindCluster[] = [];

  ordered.forEach(([kind, items], groupIndex) => {
    const column = groupIndex % columns;
    const row = Math.floor(groupIndex / columns);
    const x = column * cellWidth + cellWidth / 2;
    const y = row * cellHeight + cellHeight / 2;
    const color = COLORS[hash(kind) % COLORS.length];
    const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
    const spread = Math.min(cellWidth * 0.42, Math.max(44, Math.sqrt(sorted.length) * 10 + 18));
    clusters.push({ kind, label: labelFor(KIND_LABEL(), kind), x, y, radius: spread + 30, color, count: sorted.length });
    sorted.forEach((node, index) => {
      const angle = index * 2.399963229728653 + (hash(kind) % 31) / 31;
      const radius = sorted.length === 1 ? 0 : Math.min(spread, 10 * Math.sqrt(index + 1));
      nodes.push({
        ...node,
        x: x + Math.cos(angle) * radius,
        y: y + Math.sin(angle) * radius * 0.78,
        color,
        shape: hash(kind) % 4,
        degree: degree.get(node.id) ?? 0,
      });
    });
  });

  return {
    key: `${data.meta?.commit ?? "none"}:${nodes.length}:${data.edges?.length ?? 0}`,
    width,
    height,
    nodes,
    byId: new Map(nodes.map((node) => [node.id, node])),
    clusters,
  };
}

function fullView(layout: GraphLayout): ViewBox {
  return { x: 0, y: 0, width: layout.width, height: layout.height };
}

function edgePath(edge: WikiGraphEdge, from: PositionedNode, to: PositionedNode): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const bend = ((hash(`${edge.from_id}\0${edge.relation}\0${edge.to_id}`) % 41) - 20) * Math.min(1, length / 280);
  const middleX = (from.x + to.x) / 2 - (dy / length) * bend;
  const middleY = (from.y + to.y) / 2 + (dx / length) * bend;
  return `M ${from.x} ${from.y} Q ${middleX} ${middleY} ${to.x} ${to.y}`;
}

function NodeGlyph({ node, emphasized }: { node: PositionedNode; emphasized: boolean }) {
  const radius = emphasized ? 8 : Math.min(6.5, 3.3 + Math.log2(node.degree + 1) * 0.75);
  if (node.shape === 1) {
    return <rect x={node.x - radius} y={node.y - radius} width={radius * 2} height={radius * 2} rx="1.5" />;
  }
  if (node.shape === 2) {
    return <path d={`M ${node.x} ${node.y - radius * 1.25} L ${node.x + radius} ${node.y} L ${node.x} ${node.y + radius * 1.25} L ${node.x - radius} ${node.y} Z`} />;
  }
  if (node.shape === 3) {
    return <path d={`M ${node.x} ${node.y - radius} L ${node.x + radius} ${node.y + radius} L ${node.x - radius} ${node.y + radius} Z`} />;
  }
  return <circle cx={node.x} cy={node.y} r={radius} />;
}


export function GraphView() {
  const language = useDashboardLanguage();
  const query = useQuery<WikiGraphView>({
    queryKey: ["knowledge", "graph"],
    queryFn: () => api<WikiGraphView>(GRAPH_PATH),
  });
  const data = query.data;
  const layout = useMemo(() => buildLayout(data ?? { generated: false, nodes: [], edges: [] }), [data, language]);
  const [kind, setKind] = useState("all");
  const [relation, setRelation] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<ViewBox>(() => fullView(layout));
  const drag = useRef<{ x: number; y: number; view: ViewBox; pointerId: number } | null>(null);

  useEffect(() => {
    setView(fullView(layout));
    setSelected(null);
  }, [layout.key]);

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of data?.nodes ?? []) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => labelFor(KIND_LABEL(), a).localeCompare(labelFor(KIND_LABEL(), b), dateLocale(language)));
  }, [data, language]);
  const relations = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of data?.edges ?? []) counts.set(edge.relation, (counts.get(edge.relation) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => labelFor(RELATION_LABEL(), a).localeCompare(labelFor(RELATION_LABEL(), b), dateLocale(language)));
  }, [data, language]);
  const visibleNodes = useMemo(() => layout.nodes.filter((node) => kind === "all" || node.kind === kind), [kind, layout.nodes]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => (data?.edges ?? []).filter((edge) => visibleIds.has(edge.from_id) && visibleIds.has(edge.to_id) && (relation === "all" || edge.relation === relation)),
    [data, relation, visibleIds],
  );
  const selectedEdges = useMemo(
    () => selected ? visibleEdges.filter((edge) => edge.from_id === selected || edge.to_id === selected) : [],
    [selected, visibleEdges],
  );
  const neighborIds = useMemo(() => new Set(selectedEdges.flatMap((edge) => [edge.from_id, edge.to_id])), [selectedEdges]);
  const searchResults = useMemo(() => {
    const needle = search.trim().normalize("NFKC").toLowerCase();
    if (!needle) return [];
    return visibleNodes
      .filter((node) => `${node.id}\n${node.statement}\n${node.source_ref}`.normalize("NFKC").toLowerCase().includes(needle))
      .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
      .slice(0, 8);
  }, [search, visibleNodes]);
  const selectedNode = selected ? layout.byId.get(selected) ?? null : null;

  const zoom = (factor: number) => {
    setView((current) => {
      const width = Math.max(180, Math.min(layout.width * 1.35, current.width * factor));
      const height = width * (current.height / current.width);
      return {
        x: current.x + (current.width - width) / 2,
        y: current.y + (current.height - height) / 2,
        width,
        height,
      };
    });
  };

  const selectNode = (id: string) => {
    const node = layout.byId.get(id);
    if (!node || !visibleIds.has(id)) return;
    setSelected(id);
    setSearch("");
    const related = new Set([id]);
    for (const edge of visibleEdges) {
      if (edge.from_id === id) related.add(edge.to_id);
      if (edge.to_id === id) related.add(edge.from_id);
    }
    const points = [...related].map((nodeId) => layout.byId.get(nodeId)).filter((item): item is PositionedNode => Boolean(item));
    const minX = Math.min(...points.map((item) => item.x));
    const maxX = Math.max(...points.map((item) => item.x));
    const minY = Math.min(...points.map((item) => item.y));
    const maxY = Math.max(...points.map((item) => item.y));
    const width = Math.max(320, maxX - minX + 180);
    const height = Math.max(240, maxY - minY + 150);
    setView({ x: (minX + maxX - width) / 2, y: (minY + maxY - height) / 2, width, height });
  };

  const reset = () => {
    setKind("all");
    setRelation("all");
    setSearch("");
    setSelected(null);
    setView(fullView(layout));
  };

  if (query.isLoading) return <Loading what={uiText("加载关系图…")} />;
  if (query.error || !data) {
    return (
      <section className={styles.state} role="alert">
        <span className={styles.stateMark}>!</span>
        <h3>{uiText("关系图读取失败")}</h3>
        <p>{query.error ? errorText(query.error) : uiText("服务端没有返回关系图。")}</p>
        <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>{uiText("重试读取")}</button>
      </section>
    );
  }
  if (!data.generated || data.nodes.length === 0) {
    return (
      <section className={styles.state}>
        <span className={styles.stateMark}>0</span>
        <h3>{data.generated ? uiText("当前关系图为空") : uiText("知识图谱尚未构建")}</h3>
        <p>{uiText("图谱更新后可重新读取。")}</p>
        <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>{uiText("重新读取")}</button>
      </section>
    );
  }

  const activeClusters = layout.clusters.filter((cluster) => kind === "all" || cluster.kind === kind);
  const labelNodes = new Set(
    visibleNodes
      .filter((node) => node.degree > 0)
      .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
      .slice(0, Math.min(24, Math.max(8, Math.ceil(visibleNodes.length / 35))))
      .map((node) => node.id),
  );

  return (
    <section className={styles.graphPage} aria-label={uiText("知识关系图")}>
      <div className={styles.intro}>
        <div>
          <p className={styles.kicker}>{uiText("只读关系图")}</p>
          <h3>{uiText("全量知识关系图")}</h3>
          <p>{uiText("选择节点查看一跳关系。")}</p>
        </div>
        <div className={styles.stats} aria-label={uiText("关系图统计")}>
          <strong>{data.nodes.length}</strong><span>{uiText("节点")}</span>
          <strong>{data.edges.length}</strong><span>{uiText("边")}</span>
          <strong>{kinds.length}</strong><span>{uiText("类型")}</span>
        </div>
      </div>

      <div className={styles.controls}>
        <div className={styles.searchWrap}>
          <label htmlFor="knowledge-graph-search">{uiText("定位节点")}</label>
          <input
            id="knowledge-graph-search"
            className={styles.searchInput}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={uiText("标题、节点 id 或来源…")}
            autoComplete="off"
          />
          {search.trim() ? (
            <div className={styles.searchResults} aria-label={uiText("节点搜索结果")}>
              {searchResults.length ? searchResults.map((node) => (
                <button key={node.id} type="button" onClick={() => selectNode(node.id)}>
                  <span>{labelFor(KIND_LABEL(), node.kind)}</span>
                  <strong>{node.statement}</strong>
                  <small>{node.id}</small>
                </button>
              )) : <p>{uiText("当前筛选中没有匹配节点。")}</p>}
            </div>
          ) : null}
        </div>
        <label>
          {uiText("节点类型")}<select value={kind} onChange={(event) => { setKind(event.currentTarget.value); setSelected(null); }}>
            <option value="all">{uiText("全部节点 · ")}{data.nodes.length}</option>
            {kinds.map(([value, count]) => <option key={value} value={value}>{labelFor(KIND_LABEL(), value)} · {count}</option>)}
          </select>
        </label>
        <label>
          {uiText("关系类型")}<select value={relation} onChange={(event) => { setRelation(event.currentTarget.value); setSelected(null); }}>
            <option value="all">{uiText("全部关系 · ")}{data.edges.length}</option>
            {relations.map(([value, count]) => <option key={value} value={value}>{labelFor(RELATION_LABEL(), value)} · {count}</option>)}
          </select>
        </label>
        <div className={styles.viewButtons} aria-label={uiText("图面视图控制")}>
          <button type="button" onClick={() => zoom(0.8)} aria-label={uiText("放大关系图")}>＋</button>
          <button type="button" onClick={() => zoom(1.25)} aria-label={uiText("缩小关系图")}>−</button>
          <button type="button" onClick={reset}>{uiText("回到全局")}</button>
        </div>
      </div>

      <div className={styles.workspace}>
        <div className={styles.stage}>
          <div className={styles.stageHead}>
            <span>{visibleNodes.length} {uiText(" 个节点 · ")}{visibleEdges.length} {uiText(" 条关系")}</span>
            <span>{selectedNode ? uiText("聚焦 {v0}", { v0: selectedNode.id }) : uiText("全局视图")}</span>
          </div>
          <svg
            className={styles.graph}
            viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
            role="img"
            aria-label={uiText("知识关系图，显示 {v0} 个节点与 {v1} 条关系", { v0: visibleNodes.length, v1: visibleEdges.length })}
            onWheel={(event) => { event.preventDefault(); zoom(event.deltaY > 0 ? 1.12 : 0.88); }}
            onPointerDown={(event) => {
              if ((event.target as Element).closest("[data-node-id]")) return;
              drag.current = { x: event.clientX, y: event.clientY, view: { ...view }, pointerId: event.pointerId };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const active = drag.current;
              if (!active) return;
              const rect = event.currentTarget.getBoundingClientRect();
              if (!rect.width || !rect.height) return;
              setView({
                ...active.view,
                x: active.view.x - ((event.clientX - active.x) / rect.width) * active.view.width,
                y: active.view.y - ((event.clientY - active.y) / rect.height) * active.view.height,
              });
            }}
            onPointerUp={(event) => {
              if (drag.current?.pointerId === event.pointerId) drag.current = null;
            }}
            onPointerCancel={() => { drag.current = null; }}
          >
            <defs>
              {RELATION_COLORS.map((color, index) => (
                <marker key={color} id={`kg-arrow-${index}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                </marker>
              ))}
            </defs>
            <g aria-hidden="true">
              {activeClusters.map((cluster) => (
                <g key={cluster.kind}>
                  <circle className={styles.cluster} cx={cluster.x} cy={cluster.y} r={cluster.radius} style={{ "--cluster-color": cluster.color } as React.CSSProperties} />
                  <text className={styles.clusterLabel} x={cluster.x - cluster.radius} y={cluster.y - cluster.radius - 12}>{cluster.label.toUpperCase()} · {cluster.count}</text>
                </g>
              ))}
            </g>
            <g className={styles.edges} aria-hidden="true">
              {visibleEdges.map((edge) => {
                const from = layout.byId.get(edge.from_id);
                const to = layout.byId.get(edge.to_id);
                if (!from || !to) return null;
                const direct = Boolean(selected && (edge.from_id === selected || edge.to_id === selected));
                const dimmed = Boolean(selected && !direct);
                const colorIndex = hash(edge.relation) % RELATION_COLORS.length;
                return (
                  <path
                    key={`${edge.from_id}\0${edge.relation}\0${edge.to_id}`}
                    className={direct ? styles.edgeDirect : dimmed ? styles.edgeDim : styles.edge}
                    d={edgePath(edge, from, to)}
                    stroke={RELATION_COLORS[colorIndex]}
                    markerEnd={direct ? `url(#kg-arrow-${colorIndex})` : undefined}
                  />
                );
              })}
            </g>
            <g className={styles.nodes}>
              {visibleNodes.map((node, index) => {
                const emphasized = node.id === selected || neighborIds.has(node.id);
                const dimmed = Boolean(selected && !emphasized);
                return (
                  <g
                    key={node.id}
                    data-node-id={node.id}
                    className={node.id === selected ? styles.nodeSelected : dimmed ? styles.nodeDim : emphasized ? styles.nodeNeighbor : styles.node}
                    style={{ "--node-color": node.color } as React.CSSProperties}
                    role="button"
                    aria-label={`${labelFor(KIND_LABEL(), node.kind)}：${node.statement}`}
                    tabIndex={node.id === selected || (!selected && index === 0) ? 0 : -1}
                    onClick={() => selectNode(node.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        selectNode(node.id);
                      }
                    }}
                  >
                    <NodeGlyph node={node} emphasized={emphasized} />
                    {(node.id === selected || labelNodes.has(node.id)) && <text x={node.x + 10} y={node.y - 8}>{node.statement.slice(0, 24)}</text>}
                  </g>
                );
              })}
            </g>
          </svg>
          <p className={styles.graphHint}>{uiText("滚轮缩放 · 拖动平移 · 选择节点查看关系方向")}</p>
        </div>

        <aside className={styles.inspector} aria-label={uiText("节点关系详情")}>
          {selectedNode ? (
            <>
              <p className={styles.kicker} style={{ color: selectedNode.color }}>{labelFor(KIND_LABEL(), selectedNode.kind)} · {selectedNode.id}</p>
              <h4>{selectedNode.statement}</h4>
              <dl>
                <dt>{uiText("状态")}</dt><dd>{labelFor(STATUS_LABEL(), selectedNode.status)}</dd>
                <dt>{uiText("权威")}</dt><dd>{labelFor(AUTHORITY_LABEL(), selectedNode.authority)}</dd>
                <dt>{uiText("确定性")}</dt><dd>{selectedNode.certainty}</dd>
                <dt>{uiText("来源")}</dt><dd><code>{selectedNode.source_ref}</code></dd>
              </dl>
              <div className={styles.relationships}>
                <h5>{uiText("直接关系 ")}<span>{selectedEdges.length}</span></h5>
                {selectedEdges.length ? selectedEdges.map((edge) => {
                  const outgoing = edge.from_id === selectedNode.id;
                  const otherId = outgoing ? edge.to_id : edge.from_id;
                  const other = layout.byId.get(otherId);
                  if (!other) return null;
                  return (
                    <button key={`${edge.from_id}\0${edge.relation}\0${edge.to_id}`} type="button" onClick={() => selectNode(other.id)} style={{ "--edge-color": RELATION_COLORS[hash(edge.relation) % RELATION_COLORS.length] } as React.CSSProperties}>
                      <span>{outgoing ? "→" : "←"} {labelFor(RELATION_LABEL(), edge.relation)}</span>
                      <strong>{other.statement}</strong>
                      <small>{other.id}</small>
                    </button>
                  );
                }) : <p>{uiText("当前筛选下没有直接关系。")}</p>}
              </div>
              <Link className={styles.detailLink} to={`/knowledge?v=node&id=${encodeURIComponent(selectedNode.id)}`}>{uiText("打开完整节点页 →")}</Link>
            </>
          ) : (
            <div className={styles.inspectorEmpty}>
              <span className={styles.orbitMark} aria-hidden="true">◎</span>
              <h4>{uiText("选择一个知识节点")}</h4>
              <p>{uiText("从图面或搜索结果选择，查看来源和一跳关系。")}</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
