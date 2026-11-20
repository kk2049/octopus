import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { UiButton } from "../../ui-kit/primitives.js";
/**
 * 剖面 2 · 总览 — circle packing of trust tier → zone → module.
 *
 * Area encodes codeLoc, fill depth encodes git churn on one sequential hue
 * (a churn heatmap, not identity colors), and a critical module wears a status
 * stroke. Layout is d3-hierarchy's pack — pure computation, deterministic for
 * the same snapshot; all drawing is plain React SVG.
 *
 * The SVG is a hand-rolled viewBox camera: wheel zooms about the cursor,
 * pointer drag pans (a >4px move suppresses the click so panning never selects
 * a module). Labels are level-of-detail — visibility keys on *apparent* radius
 * (r × scale) and font-size divides by scale, so zooming in reveals each
 * layer's names at a constant on-screen size instead of scaling blurry text.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, pack, type HierarchyCircularNode } from "d3-hierarchy";
import type { ArchModule, ArchZone } from "../ArchitecturePage.js";
import type { SafeView } from "./model.js";
import { TRUST_LABEL, seqFillPercent, truncate, trustRank, zonesByTrust } from "./model.js";
import styles from "../ArchitecturePage.module.css";

const W = 760;
const H = 560;

// Camera limits: scale = W / viewBox.w, wheel steps ×1.15 per notch.
const MIN_SCALE = 0.6;
const MAX_SCALE = 25;
const WHEEL_STEP = 1.15;
/** Pointer travel (px) beyond which a press counts as a drag, not a click. */
const DRAG_SLOP = 4;

// Apparent-size (screen px) thresholds where each layer's labels come in, and
// the ramp width over which they fade from 0 to full opacity.
const MODULE_LABEL_AT = 22;
const ZONE_LABEL_AT = 36;
const TIER_LABEL_AT = 56;

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const HOME: ViewBox = { x: 0, y: 0, w: W, h: H };

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** 0 → 1 over `ramp` screen px past `from`; the label fade-in. */
function fadeIn(apparent: number, from: number, ramp: number): number {
  return Math.max(0, Math.min(1, (apparent - from) / ramp));
}

interface PackDatum {
  kind: "root" | "trust" | "zone" | "module";
  trust?: string;
  zone?: ArchZone;
  module?: ArchModule;
  value?: number;
  children?: PackDatum[];
}

function buildPack(snap: SafeView): HierarchyCircularNode<PackDatum> | null {
  // Modules may reference zones the snapshot forgot to declare — invent them
  // rather than dropping the modules on the floor.
  const declared = new Map(snap.zones.map((z) => [z.id, z]));
  const zones = new Map<string, ArchZone>(declared);
  for (const mod of snap.modules) {
    if (!zones.has(mod.zone)) {
      zones.set(mod.zone, { id: mod.zone, label: mod.zone || uiText("（未声明 zone）"), trust: "?", color: "" });
    }
  }
  const byZone = new Map<string, ArchModule[]>();
  for (const mod of snap.modules) {
    const list = byZone.get(mod.zone) ?? [];
    list.push(mod);
    byZone.set(mod.zone, list);
  }
  const orderedZones = zonesByTrust([...zones.values()]).filter((z) => (byZone.get(z.id) ?? []).length > 0);
  if (orderedZones.length === 0) return null;

  const tiers = new Map<string, PackDatum>();
  for (const zone of orderedZones) {
    const tier = tiers.get(zone.trust) ?? { kind: "trust" as const, trust: zone.trust, children: [] };
    tier.children!.push({
      kind: "zone",
      zone,
      children: (byZone.get(zone.id) ?? []).map((mod) => ({
        kind: "module" as const,
        module: mod,
        // Area = codeLoc; an empty module still deserves a visible dot.
        value: Math.max(mod.codeLoc || 0, 20),
      })),
    });
    tiers.set(zone.trust, tier);
  }
  const root: PackDatum = {
    kind: "root",
    children: [...tiers.values()].sort((a, b) => trustRank(a.trust ?? "?") - trustRank(b.trust ?? "?")),
  };
  const tree = hierarchy(root)
    .sum((d) => d.value ?? 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return pack<PackDatum>().size([W, H]).padding(5)(tree);
}

export function OverviewView({
  snap,
  selected,
  onSelectModule,
}: {
  snap: SafeView;
  selected: string | null;
  onSelectModule: (id: string) => void;
}) {
  const language = useDashboardLanguage();
  const root = useMemo(() => buildPack(snap), [snap, language]);
  const maxTouches = useMemo(
    () => snap.modules.reduce((max, m) => Math.max(max, m.gitTouches || 0), 0),
    [snap],
  );
  const hotspots = snap.hotspots.slice(0, 8);
  const maxScore = hotspots.reduce((max, h) => Math.max(max, h.score || 0), 0);

  const [vb, setVb] = useState<ViewBox>(HOME);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    id: number;
    sx: number;
    sy: number;
    vb: ViewBox;
    rect: DOMRect;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const scale = W / vb.w;

  // React's onWheel attaches passively at the root, so preventDefault (needed
  // to stop the page scrolling under the chart) must go through a real
  // non-passive listener.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return;
      setVb((prev) => {
        const factor = Math.pow(WHEEL_STEP, -e.deltaY / 100);
        const nextScale = clampScale((W / prev.w) * factor);
        const w = W / nextScale;
        const h = H / nextScale;
        // Keep the world point under the cursor fixed while w/h change.
        const px = prev.x + ((e.clientX - rect.left) / rect.width) * prev.w;
        const py = prev.y + ((e.clientY - rect.top) / rect.height) * prev.h;
        return {
          x: px - ((px - prev.x) * w) / prev.w,
          y: py - ((py - prev.y) * h) / prev.h,
          w,
          h,
        };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const svg = svgRef.current;
    if (!svg) return;
    dragRef.current = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      vb,
      rect: svg.getBoundingClientRect(),
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) <= DRAG_SLOP) return;
      drag.moved = true;
      // Capture only once this is demonstrably a drag. Capturing immediately
      // on pointerdown retargets pointerup/click to the SVG in real browsers,
      // making a plain click on the child module group appear to do nothing.
      try {
        svgRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // jsdom & co: capture is an enhancement, dragging still works.
      }
      if (svgRef.current) svgRef.current.style.cursor = "grabbing";
    }
    if (!(drag.rect.width > 0) || !(drag.rect.height > 0)) return;
    setVb({
      x: drag.vb.x - dx * (drag.vb.w / drag.rect.width),
      y: drag.vb.y - dy * (drag.vb.h / drag.rect.height),
      w: drag.vb.w,
      h: drag.vb.h,
    });
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    // A real drag must not fall through as a click on whatever circle the
    // pointer happens to be over when released.
    if (drag.moved) suppressClickRef.current = true;
    dragRef.current = null;
    if (svgRef.current) svgRef.current.style.cursor = "";
  };

  const onClickCapture = (e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  if (!root) {
    return (
      <section className={styles.card}>
        <p className={styles.muted}>{uiText("快照里没有模块可画。")}</p>
      </section>
    );
  }

  return (
    <div className={styles.overviewWrap}>
      <section className={`${styles.card} ${styles.packCard}`}>
        <div className={styles.packHead}>
          <h3>{uiText("模块地图")}</h3>
          <UiButton className={styles.resetBtn} onClick={() => setVb(HOME)}>
            {uiText("重置视图")}</UiButton>
        </div>
        <p className={styles.muted}>
          {uiText("层级：信任档 → zone → 模块；面积为代码行数，颜色表示改动，红框表示 critical。拖拽或滚轮浏览，点击模块看档案。")}</p>
        <svg
          ref={svgRef}
          className={styles.packSvg}
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          role="img"
          aria-label={uiText("按信任分层的模块 circle packing 图（可拖拽平移、滚轮缩放）")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClickCapture={onClickCapture}
        >
          {root.descendants().map((node, at) => {
            const datum = node.data;
            const apparent = node.r * scale;
            if (datum.kind === "trust") {
              const opacity = fadeIn(apparent, TIER_LABEL_AT, 14);
              return (
                <g key={`t${at}`}>
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r}
                    className={styles.trustCircle}
                    vectorEffect="non-scaling-stroke"
                  />
                  {opacity > 0 && (
                    <text
                      x={node.x}
                      y={node.y - node.r + 14 / scale}
                      className={styles.tierLabel}
                      textAnchor="middle"
                      style={{ fontSize: `${12 / scale}px`, opacity }}
                    >
                      {TRUST_LABEL()[datum.trust ?? ""] ?? datum.trust}
                    </text>
                  )}
                </g>
              );
            }
            if (datum.kind === "zone" && datum.zone) {
              const opacity = fadeIn(apparent, ZONE_LABEL_AT, 10);
              return (
                <g key={`z${datum.zone.id}`}>
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r}
                    className={styles.zoneCircle}
                    vectorEffect="non-scaling-stroke"
                  />
                  {opacity > 0 && (
                    <text
                      x={node.x}
                      y={node.y - node.r + 13 / scale}
                      className={styles.zoneLabel}
                      textAnchor="middle"
                      style={{ fontSize: `${11 / scale}px`, opacity }}
                    >
                      {truncate(datum.zone.label, Math.max(4, Math.floor(apparent / 4)))}
                    </text>
                  )}
                  <title>
                    {datum.zone.label} · {datum.zone.trust}
                    {datum.zone.description ? ` · ${datum.zone.description}` : ""}
                  </title>
                </g>
              );
            }
            if (datum.kind === "module" && datum.module) {
              const mod = datum.module;
              const pct = seqFillPercent(mod.gitTouches || 0, maxTouches);
              const critical = mod.criticality === "critical";
              const opacity = fadeIn(apparent, MODULE_LABEL_AT, 8);
              return (
                <g
                  key={`m${mod.id}`}
                  className={styles.moduleDot}
                  onClick={() => onSelectModule(mod.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectModule(mod.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={uiText("模块 {v0}", { v0: mod.label })}
                >
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r}
                    fill={`color-mix(in oklab, var(--arch-seq-high) ${pct}%, var(--arch-seq-low))`}
                    stroke={critical ? "var(--err)" : "color-mix(in srgb, var(--fg) 30%, transparent)"}
                    strokeWidth={critical ? 2.5 : 1}
                    vectorEffect="non-scaling-stroke"
                  />
                  {selected === mod.id && (
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={node.r + 3 / scale}
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth={2}
                      strokeDasharray="4 3"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {opacity > 0 && (
                    <text
                      x={node.x}
                      y={node.y + 4 / scale}
                      className={styles.moduleLabel}
                      textAnchor="middle"
                      style={{ fontSize: `${11 / scale}px`, opacity }}
                    >
                      {truncate(mod.label, Math.max(3, Math.floor(apparent / 4)))}
                    </text>
                  )}
                  <title>
                    {mod.label} · {mod.codeLoc} LOC · {mod.gitTouches} {uiText(" 次改动")}{critical ? " · critical" : ""}
                  </title>
                </g>
              );
            }
            return null;
          })}
        </svg>
        <p className={styles.legendRow}>
          <span className={styles.legendSwatch} style={{ background: "color-mix(in oklab, var(--arch-seq-high) 12%, var(--arch-seq-low))" }} />
          {uiText("改动少")}<span className={styles.legendSwatch} style={{ background: "var(--arch-seq-high)" }} />
          {uiText("改动多")}<span className={styles.legendCritical} />
          {uiText("关键")}</p>
      </section>

      <section className={`${styles.card} ${styles.hotspots}`}>
        <h3>{uiText("先看这 8 个")}</h3>
        {hotspots.length === 0 && <p className={styles.muted}>{uiText("没有热点数据。")}</p>}
        {hotspots.map((hot, at) => (
          <UiButton
            key={`${hot.moduleId}:${hot.path}:${at}`}
            className={styles.hotRow}
            onClick={() => onSelectModule(hot.moduleId)}
          >
            <span className={styles.hotName}>{hot.moduleId}</span>
            <span className={`${styles.mono} ${styles.hotPath}`}>{hot.path}</span>
            <span className={styles.hotBar} aria-hidden="true">
              <span
                className={styles.hotBarFill}
                style={{ width: `${maxScore > 0 ? Math.max(4, Math.round((hot.score / maxScore) * 100)) : 4}%` }}
              />
            </span>
            <span className={styles.muted}>
              {hot.codeLoc} LOC · {hot.touches} {uiText(" 次改动")}</span>
          </UiButton>
        ))}
      </section>
    </div>
  );
}
