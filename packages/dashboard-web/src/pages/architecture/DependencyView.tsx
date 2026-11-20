import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { UiButton, UiSelect } from "../../ui-kit/primitives.js";
/**
 * 剖面 3 · 依赖 — two renderings of the same records, matrix first.
 *
 * The default is a dependency structure matrix (DSM): rows are the depending
 * module, columns the depended-on module, both axes in one shared order —
 * zones grouped by trust tier, modules by size. Cell depth encodes the number
 * of runtime+dynamic import edges on a √ scale; circular pairs fill red, and
 * zone pairs a forbid-dependency constraint outlaws get a red frame so a
 * violation is one glance, not one expansion-click away.
 *
 * The original collapse/expand zone graph survives untouched as the「图」mode
 * (GraphView below): one node per zone in four trust columns, click to expand
 * in place, deterministic hand-computed layout — no force simulation.
 */

import { useEffect, useMemo, useState } from "react";
import type { ArchModule, ArchZone } from "../ArchitecturePage.js";
import type { DepFilter, GraphEdge, GraphNodeRef, SafeView } from "./model.js";
import {
  TRUST_LABEL,
  buildGraphEdges,
  edgeKey,
  trustRank,
  zonesByTrust,
} from "./model.js";
import { CopyButton } from "./bits.js";
import { DependencyMatrix } from "./DependencyMatrix.js";
import styles from "../ArchitecturePage.module.css";

// ── Mode switch (matrix is the default) ─────────────────────────────────────

type DepMode = "matrix" | "graph";

export function DependencyView({
  snap,
  focus,
  selected,
  onSelectModule,
}: {
  snap: SafeView;
  focus: string[];
  selected: string | null;
  onSelectModule: (id: string) => void;
}) {
  useDashboardLanguage();
  const [mode, setMode] = useState<DepMode>("matrix");
  return (
    <div>
      <div className={styles.depsModeBar} role="tablist" aria-label={uiText("依赖呈现方式")}>
        <UiButton
          className={mode === "matrix" ? styles.tabOn : styles.tab}
          aria-pressed={mode === "matrix"}
          onClick={() => setMode("matrix")}
        >
          {uiText("矩阵")}</UiButton>
        <UiButton
          className={mode === "graph" ? styles.tabOn : styles.tab}
          aria-pressed={mode === "graph"}
          onClick={() => setMode("graph")}
        >
          {uiText("图")}</UiButton>
      </div>
      {mode === "matrix" ? (
        <DependencyMatrix snap={snap} focus={focus} selected={selected} onSelectModule={onSelectModule} />
      ) : (
        <GraphView snap={snap} focus={focus} selected={selected} onSelectModule={onSelectModule} />
      )}
    </div>
  );
}

// ── 图模式 (原折叠/展开依赖图，代码原样保留) ────────────────────────────────

const PAD = 12;
const COL_W = 200;
const COL_GAP = 72;
const ZONE_H = 44;
const ZONE_HEAD = 30;
const ROW_H = 26;
const ZONE_GAP = 20;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  zones: Array<{ zone: ArchZone; box: Box; expanded: boolean }>;
  columns: Array<{ trust: string; x: number }>;
  moduleBoxes: Map<string, Box>;
  zoneBoxes: Map<string, Box>;
  modulesOf: Map<string, string[]>;
  width: number;
  height: number;
}

/** Add focus-derived defaults without removing any choice the reader made. */
export function mergeFocusedZones(
  expanded: ReadonlySet<string>,
  focus: readonly string[],
  modules: readonly Pick<ArchModule, "id" | "zone">[],
): ReadonlySet<string> {
  const zoneOf = new Map(modules.map((module) => [module.id, module.zone]));
  let next: Set<string> | null = null;
  for (const id of focus) {
    const zone = zoneOf.get(id);
    if (zone === undefined || expanded.has(zone)) continue;
    next ??= new Set(expanded);
    next.add(zone);
  }
  return next ?? expanded;
}

function computeLayout(snap: SafeView, expanded: ReadonlySet<string>): Layout {
  const declared = new Map(snap.zones.map((z) => [z.id, z]));
  for (const mod of snap.modules) {
    if (!declared.has(mod.zone)) {
      declared.set(mod.zone, { id: mod.zone, label: mod.zone || uiText("（未声明 zone）"), trust: "?", color: "" });
    }
  }
  const ordered = zonesByTrust([...declared.values()]);
  const tiers: string[] = [];
  for (const zone of ordered) if (!tiers.includes(zone.trust)) tiers.push(zone.trust);
  tiers.sort((a, b) => trustRank(a) - trustRank(b));

  const modulesOf = new Map<string, string[]>();
  for (const mod of snap.modules) {
    const list = modulesOf.get(mod.zone) ?? [];
    list.push(mod.id);
    modulesOf.set(mod.zone, list);
  }
  // Busiest modules first inside an expanded zone.
  const traffic = new Map(snap.modules.map((m) => [m.id, (m.runtimeFanIn || 0) + (m.runtimeFanOut || 0)]));
  for (const list of modulesOf.values()) {
    list.sort((a, b) => (traffic.get(b) ?? 0) - (traffic.get(a) ?? 0) || a.localeCompare(b));
  }

  const columns = tiers.map((trust, at) => ({ trust, x: PAD + at * (COL_W + COL_GAP) }));
  const colX = new Map(columns.map((c) => [c.trust, c.x]));
  const colY = new Map(tiers.map((t) => [t, 44]));

  const zones: Layout["zones"] = [];
  const zoneBoxes = new Map<string, Box>();
  const moduleBoxes = new Map<string, Box>();
  for (const zone of ordered) {
    const x = colX.get(zone.trust) ?? PAD;
    const y = colY.get(zone.trust) ?? 44;
    const isOpen = expanded.has(zone.id);
    const members = modulesOf.get(zone.id) ?? [];
    const h = isOpen ? ZONE_HEAD + members.length * ROW_H + 8 : ZONE_H;
    const box = { x, y, w: COL_W, h };
    zones.push({ zone, box, expanded: isOpen });
    zoneBoxes.set(zone.id, box);
    if (isOpen) {
      members.forEach((id, at) => {
        moduleBoxes.set(id, { x: x + 8, y: y + ZONE_HEAD + at * ROW_H + 2, w: COL_W - 16, h: ROW_H - 4 });
      });
    }
    colY.set(zone.trust, y + h + ZONE_GAP);
  }
  const width = PAD + columns.length * (COL_W + COL_GAP);
  const height = Math.max(240, ...[...colY.values()]) + 16;
  return { zones, columns, moduleBoxes, zoneBoxes, modulesOf, width, height };
}

function boxOf(layout: Layout, ref: GraphNodeRef): Box | null {
  return (ref.kind === "zone" ? layout.zoneBoxes.get(ref.id) : layout.moduleBoxes.get(ref.id)) ?? null;
}

/** A deterministic bezier between two boxes, plus its visual midpoint. */
function edgePath(a: Box, b: Box): { d: string; mx: number; my: number } {
  const acy = a.y + a.h / 2;
  const bcy = b.y + b.h / 2;
  let s: [number, number];
  let t: [number, number];
  let c1: [number, number];
  let c2: [number, number];
  if (b.x >= a.x + a.w) {
    // Forward: out of the right edge, into the left edge.
    s = [a.x + a.w, acy];
    t = [b.x, bcy];
    const dx = Math.min(64, Math.max(24, (t[0] - s[0]) / 2));
    c1 = [s[0] + dx, s[1]];
    c2 = [t[0] - dx, t[1]];
  } else if (a.x >= b.x + b.w) {
    // Backward: leave left, arrive right.
    s = [a.x, acy];
    t = [b.x + b.w, bcy];
    const dx = Math.min(64, Math.max(24, (s[0] - t[0]) / 2));
    c1 = [s[0] - dx, s[1]];
    c2 = [t[0] + dx, t[1]];
  } else {
    // Same column: loop out of the right side.
    s = [a.x + a.w, acy];
    t = [b.x + b.w, bcy];
    c1 = [s[0] + 52, s[1]];
    c2 = [t[0] + 52, t[1]];
  }
  // Cubic bezier point at u = 0.5.
  const mx = (s[0] + 3 * c1[0] + 3 * c2[0] + t[0]) / 8;
  const my = (s[1] + 3 * c1[1] + 3 * c2[1] + t[1]) / 8;
  return { d: `M ${s[0]} ${s[1]} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${t[0]} ${t[1]}`, mx, my };
}

function strokeWidth(count: number): number {
  return Math.min(1 + Math.log2(count + 1), 5);
}

function SampleBar({ edge }: { edge: GraphEdge }) {
  useDashboardLanguage();
  let shown = 0;
  return (
    <section className={styles.sampleBar}>
      <h4 className={styles.subhead}>
        {edge.from.id} → {edge.to.id}
        <span className={styles.muted}>
          {" "}
          · {edge.count} {uiText(" 条模块级 runtime 依赖")}{edge.circular ? uiText(" · 含循环") : ""}
        </span>
      </h4>
      {edge.deps.map((dep, at) => (
        <div key={at} className={styles.sampleGroup}>
          <div className={styles.mono}>
            {dep.from} → {dep.to}
            {dep.circular && <span className={styles.sevErr + " " + styles.sev}>{uiText("循环")}</span>}
          </div>
          {(dep.samples ?? []).map((sample, sat) => {
            if (shown >= 30) return null;
            shown += 1;
            const refText = `${sample.path}:${sample.line}`;
            return (
              <div key={sat} className={styles.sampleRow}>
                <span className={styles.mono}>{refText}</span>
                <span className={`${styles.mono} ${styles.muted}`}>{sample.specifier}</span>
                <CopyButton text={refText} />
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}

function GraphView({
  snap,
  focus,
  selected,
  onSelectModule,
}: {
  snap: SafeView;
  focus: string[];
  selected: string | null;
  onSelectModule: (id: string) => void;
}) {
  const language = useDashboardLanguage();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<DepFilter>("all");
  const [pickedEdge, setPickedEdge] = useState<string | null>(null);
  const focusKey = focus.join("\u0000");

  // A review-view jump is a semantic boundary: open its zones once, merging
  // them into the reader's choices. Snapshot polls create fresh module arrays,
  // but must neither replay this default nor undo a manual expand/collapse.
  useEffect(() => {
    if (!focusKey) return;
    setExpanded((previous) => mergeFocusedZones(previous, focus, snap.modules));
  }, [focusKey]);

  const layout = useMemo(() => computeLayout(snap, expanded), [snap, expanded, language]);
  const edges = useMemo(
    () => buildGraphEdges(snap.dependencies, snap.modules, expanded, filter),
    [snap, expanded, filter],
  );
  const focusSet = useMemo(() => new Set(focus), [focus]);
  const current = pickedEdge ? edges.find((e) => edgeKey(e) === pickedEdge) ?? null : null;
  const labelOf = new Map(snap.modules.map((m) => [m.id, m.label || m.id]));

  const toggleZone = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPickedEdge(null);
  };

  if (layout.zones.length === 0) {
    return (
      <section className={styles.card}>
        <p className={styles.muted}>{uiText("快照里没有 zone 可画。")}</p>
      </section>
    );
  }

  return (
    <div>
      <section className={styles.card}>
        <div className={styles.depsToolbar}>
          <h3>{uiText("依赖图")}</h3>
          <label className={styles.muted}>{uiText("筛选")}</label>
          <UiSelect
            aria-label={uiText("依赖筛选")}
            value={filter}
            onValueChange={(value) => { setFilter(value as DepFilter); setPickedEdge(null); }}
            options={[
              { value: "all", label: uiText("全部") },
              { value: "cross", label: uiText("只看跨 zone") },
              { value: "critical", label: uiText("只看 critical 模块相关") },
            ]}
          />
          <span className={styles.muted}>{uiText("点击 zone 展开，点击边查看样本；红色为循环。")}</span>
        </div>
        <div className={styles.depsSvgWrap}>
          <svg
            width={layout.width}
            height={layout.height}
            role="img"
            aria-label={uiText("按信任列排布的 zone 依赖图")}
          >
            <defs>
              <marker id="arch-dep-arrow" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
                <path d="M0,0 L10,4 L0,8 z" fill="var(--line-strong)" />
              </marker>
              <marker id="arch-dep-arrow-err" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
                <path d="M0,0 L10,4 L0,8 z" fill="var(--err)" />
              </marker>
              <marker id="arch-dep-arrow-on" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
                <path d="M0,0 L10,4 L0,8 z" fill="var(--accent)" />
              </marker>
            </defs>

            {layout.columns.map((col) => (
              <text key={col.trust} x={col.x + COL_W / 2} y={24} textAnchor="middle" className={styles.tierLabel}>
                {TRUST_LABEL()[col.trust] ?? col.trust}
              </text>
            ))}

            {edges.map((edge) => {
              const a = boxOf(layout, edge.from);
              const b = boxOf(layout, edge.to);
              if (!a || !b) return null;
              const key = edgeKey(edge);
              const picked = key === pickedEdge;
              const { d, mx, my } = edgePath(a, b);
              const stroke = edge.circular ? "var(--err)" : picked ? "var(--accent)" : "var(--line-strong)";
              const marker = edge.circular
                ? "url(#arch-dep-arrow-err)"
                : picked
                  ? "url(#arch-dep-arrow-on)"
                  : "url(#arch-dep-arrow)";
              return (
                <g key={key}>
                  <path
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={strokeWidth(edge.count) + (edge.circular ? 1.2 : 0)}
                    markerEnd={marker}
                    opacity={picked || edge.circular ? 1 : 0.75}
                  />
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={12}
                    className={styles.edgeHit}
                    onClick={() => setPickedEdge(picked ? null : key)}
                  >
                    <title>
                      {edge.from.id} → {edge.to.id} · {edge.count} {uiText(" 条")}</title>
                  </path>
                  <text x={mx} y={my - 4} textAnchor="middle" className={styles.edgeLabel}>
                    {edge.count}
                  </text>
                </g>
              );
            })}

            {layout.zones.map(({ zone, box, expanded: isOpen }) => {
              const members = layout.modulesOf.get(zone.id) ?? [];
              const hasFocus = members.some((id) => focusSet.has(id));
              return (
                <g key={zone.id}>
                  <rect
                    x={box.x}
                    y={box.y}
                    width={box.w}
                    height={box.h}
                    rx={8}
                    className={`${styles.zoneBox} ${hasFocus ? styles.zoneBoxFocus : ""}`}
                  />
                  <g onClick={() => toggleZone(zone.id)} className={styles.zoneHead} role="button" aria-label={`${isOpen ? uiText("折叠") : uiText("展开")} ${zone.label}`}>
                    <rect x={box.x} y={box.y} width={box.w} height={isOpen ? ZONE_HEAD : box.h} fill="transparent" />
                    {zone.color && <circle cx={box.x + 14} cy={box.y + (isOpen ? ZONE_HEAD : box.h) / 2} r={4} fill={zone.color} />}
                    <text x={box.x + (zone.color ? 24 : 12)} y={box.y + (isOpen ? ZONE_HEAD : box.h) / 2 + 4} className={styles.zoneBoxLabel}>
                      {isOpen ? "▾ " : "▸ "}
                      {zone.label}
                      {!isOpen && members.length > 0 ? `（${members.length}）` : ""}
                    </text>
                    <title>
                      {zone.label} · {TRUST_LABEL()[zone.trust] ?? zone.trust}
                      {zone.description ? ` · ${zone.description}` : ""}
                    </title>
                  </g>
                  {isOpen &&
                    members.map((id) => {
                      const row = layout.moduleBoxes.get(id);
                      if (!row) return null;
                      const isFocus = focusSet.has(id);
                      const isSelected = selected === id;
                      return (
                        <g key={id} onClick={() => onSelectModule(id)} className={styles.moduleRow} role="button" aria-label={uiText("模块 {v0}", { v0: id })}>
                          <rect
                            x={row.x}
                            y={row.y}
                            width={row.w}
                            height={row.h}
                            rx={5}
                            className={`${styles.moduleRowBox} ${isFocus ? styles.moduleRowFocus : ""} ${isSelected ? styles.moduleRowSelected : ""}`}
                          />
                          <text x={row.x + 8} y={row.y + row.h / 2 + 4} className={styles.moduleRowLabel}>
                            {labelOf.get(id) ?? id}
                          </text>
                          <title>{id}</title>
                        </g>
                      );
                    })}
                </g>
              );
            })}
          </svg>
        </div>
        {edges.length === 0 && <p className={styles.muted}>{uiText("当前筛选下没有 runtime 依赖边。")}</p>}
      </section>
      {current && <SampleBar edge={current} />}
    </div>
  );
}
