import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { useMemo, useState } from "react";
import type { ArchDependency } from "../ArchitecturePage.js";
import {
  TRUST_LABEL,
  forbiddenZonePairs,
  matrixCells,
  matrixOrder,
  pairKey,
} from "./model.js";
import type { SafeView } from "./model.js";
import { CopyButton } from "./bits.js";
import styles from "../ArchitecturePage.module.css";

/** √-scaled percent along the sequential ramp; 15–100 keeps count=1 visible. */
function cellPercent(count: number, maxCount: number): number {
  if (!(maxCount > 0)) return 15;
  const ratio = Math.max(0, Math.min(1, count / maxCount));
  return Math.round(15 + 85 * Math.sqrt(ratio));
}

export function DependencyMatrix({
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
  const order = useMemo(() => matrixOrder(snap.modules, snap.zones), [snap, language]);
  const cells = useMemo(() => matrixCells(snap.dependencies), [snap]);
  const forbidden = useMemo(
    () => forbiddenZonePairs(snap.constraints, snap.modules, snap.zones),
    [snap],
  );
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);
  const [picked, setPicked] = useState<{ from: string; to: string } | null>(null);
  const focusSet = useMemo(() => new Set(focus), [focus]);

  const mods = order.modules;
  const maxCount = useMemo(() => {
    let max = 0;
    for (const cell of cells.values()) max = Math.max(max, cell.count);
    return max;
  }, [cells]);
  const groupStart = useMemo(() => new Set(order.groups.map((group) => group.start)), [order]);
  const groupEnd = useMemo(
    () => new Set(order.groups.map((group) => group.start + group.count - 1)),
    [order],
  );
  const pickedCell = picked ? cells.get(pairKey(picked.from, picked.to)) ?? null : null;

  if (mods.length === 0) {
    return (
      <section className={styles.card}>
        <p className={styles.muted}>{uiText("快照里没有模块可画。")}</p>
      </section>
    );
  }

  const cellShadow = (row: number, col: number, forbiddenCell: boolean): string | undefined => {
    const parts: string[] = [];
    if (forbiddenCell) {
      if (groupStart.has(row)) parts.push("inset 0 2px 0 var(--err)");
      if (groupEnd.has(row)) parts.push("inset 0 -2px 0 var(--err)");
      if (groupStart.has(col)) parts.push("inset 2px 0 0 var(--err)");
      if (groupEnd.has(col)) parts.push("inset -2px 0 0 var(--err)");
    }
    if (!forbiddenCell && groupStart.has(row) && row > 0) parts.push("inset 0 1.5px 0 var(--line-strong)");
    if (!forbiddenCell && groupStart.has(col) && col > 0) parts.push("inset 1.5px 0 0 var(--line-strong)");
    const cross =
      (hover !== null && (hover.row === row || hover.col === col)) ||
      (selected !== null && (mods[row].id === selected || mods[col].id === selected));
    if (cross) parts.push("inset 0 0 0 99px color-mix(in srgb, var(--accent) 14%, transparent)");
    return parts.length > 0 ? parts.join(", ") : undefined;
  };

  const headClass = (id: string, hot: boolean): string =>
    [hot ? styles.dsmHeadHover : "", selected === id ? styles.dsmHeadSel : "", focusSet.has(id) ? styles.dsmHeadFocus : ""]
      .filter(Boolean)
      .join(" ");

  return (
    <div>
      <section className={styles.card}>
        <div className={styles.depsToolbar}>
          <h3>{uiText("依赖矩阵")}</h3>
          <span className={styles.muted}>{uiText("行→列；色深为边数，红色为循环，红框为禁止方向。")}</span>
        </div>
        <div className={styles.dsmWrap} onMouseLeave={() => setHover(null)}>
          <table className={styles.dsm} aria-label={uiText("模块依赖结构矩阵")}>
            <thead>
              <tr>
                <th className={styles.dsmCorner} colSpan={2} rowSpan={2}>{uiText("行→列")}</th>
                {order.groups.map((group) => (
                  <th
                    key={group.zone.id}
                    colSpan={group.count}
                    className={styles.dsmGroupCol}
                    title={`${group.zone.label} · ${TRUST_LABEL()[group.zone.trust] ?? group.zone.trust}`}
                  >
                    <span>{group.zone.label}</span>
                  </th>
                ))}
              </tr>
              <tr>
                {mods.map((mod, col) => (
                  <th
                    key={mod.id}
                    className={styles.dsmColHead}
                    style={groupStart.has(col) && col > 0 ? { boxShadow: "inset 1.5px 0 0 var(--line-strong)" } : undefined}
                    title={mod.id}
                    onClick={() => onSelectModule(mod.id)}
                  >
                    <span className={headClass(mod.id, hover?.col === col)}>{mod.label || mod.id}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mods.map((from, row) => {
                const group = groupStart.has(row) ? order.groups.find((entry) => entry.start === row) : undefined;
                return (
                  <tr key={from.id}>
                    {group ? (
                      <th
                        rowSpan={group.count}
                        className={styles.dsmGroupRowHead}
                        title={`${group.zone.label} · ${TRUST_LABEL()[group.zone.trust] ?? group.zone.trust}`}
                      >
                        <span>{group.zone.label}</span>
                      </th>
                    ) : null}
                    <th
                      className={`${styles.dsmRowHead} ${headClass(from.id, hover?.row === row)}`}
                      style={groupStart.has(row) && row > 0 ? { boxShadow: "inset 0 1.5px 0 var(--line-strong)" } : undefined}
                      title={from.id}
                      onClick={() => onSelectModule(from.id)}
                    >
                      {from.label || from.id}
                    </th>
                    {mods.map((to, col) => {
                      if (row === col) {
                        return (
                          <td
                            key={to.id}
                            className={`${styles.dsmCell} ${styles.dsmDiag}`}
                            style={{ boxShadow: cellShadow(row, col, false) }}
                            onMouseEnter={() => setHover({ row, col })}
                          />
                        );
                      }
                      const cell = cells.get(pairKey(from.id, to.id));
                      const forbiddenCell = forbidden.has(pairKey(from.zone, to.zone));
                      const background = cell
                        ? cell.circular
                          ? "var(--err)"
                          : forbiddenCell
                            ? `color-mix(in srgb, var(--err) ${Math.max(35, cellPercent(cell.count, maxCount))}%, transparent)`
                            : `color-mix(in oklab, var(--arch-seq-high) ${cellPercent(cell.count, maxCount)}%, var(--arch-seq-low))`
                        : undefined;
                      const isPicked = picked !== null && picked.from === from.id && picked.to === to.id;
                      return (
                        <td
                          key={to.id}
                          className={`${styles.dsmCell} ${cell ? styles.dsmCellHit : ""} ${isPicked ? styles.dsmPicked : ""}`}
                          style={{ background, boxShadow: cellShadow(row, col, forbiddenCell) }}
                          title={cell
                            ? uiText("{v0} → {v1} · {v2} 条{v3}{v4}", { v0: from.id, v1: to.id, v2: cell.count, v3: cell.circular ? uiText(" · 循环") : "", v4: forbiddenCell ? uiText(" · 禁止方向") : "" })
                            : `${from.id} → ${to.id}`}
                          onMouseEnter={() => setHover({ row, col })}
                          onClick={() => setPicked(isPicked || !cell ? null : { from: from.id, to: to.id })}
                        />
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className={styles.legendRow}>
          <span className={styles.legendSwatch} style={{ background: "color-mix(in oklab, var(--arch-seq-high) 15%, var(--arch-seq-low))", borderRadius: 3 }} />
          {uiText("1 条")}<span className={styles.legendSwatch} style={{ background: "var(--arch-seq-high)", borderRadius: 3 }} />
          {uiText("最多（√ 标尺）")}<span className={styles.legendSwatch} style={{ background: "var(--err)", borderRadius: 3 }} />
          {uiText("循环依赖")}<span className={styles.legendSwatch} style={{ background: "transparent", border: "2px solid var(--err)", borderRadius: 3 }} />
          {uiText("禁止的信任方向 · 点格子看依赖样本，点模块名联动档案卡")}</p>
      </section>
      {picked ? (
        <section className={styles.sampleBar}>
          <h4 className={styles.subhead}>
            {picked.from} → {picked.to}
            {pickedCell ? (
              <span className={styles.muted}>
                {" "}{uiText("· 运行时")}{sumOf(pickedCell.deps, "runtimeCount")} {uiText("· 动态")}{sumOf(pickedCell.deps, "dynamicCount")} {uiText("· 仅类型")}{sumOf(pickedCell.deps, "typeOnlyCount")} {uiText("· 测试")}{sumOf(pickedCell.deps, "testCount")}
                {pickedCell.circular ? uiText(" · 循环") : ""}
              </span>
            ) : null}
          </h4>
          {!pickedCell || pickedCell.deps.every((dependency) => (dependency.samples ?? []).length === 0) ? (
            <p className={styles.muted}>{uiText("快照没有为这条边记录 import 样本。")}</p>
          ) : null}
          {pickedCell ? <MatrixSamples deps={pickedCell.deps} /> : null}
        </section>
      ) : null}
    </div>
  );
}

function sumOf(
  dependencies: ArchDependency[],
  key: "runtimeCount" | "dynamicCount" | "typeOnlyCount" | "testCount",
): number {
  return dependencies.reduce((sum, dependency) => sum + (dependency[key] ?? 0), 0);
}

function MatrixSamples({ deps }: { deps: ArchDependency[] }) {
  useDashboardLanguage();
  let shown = 0;
  return (
    <>
      {deps.map((dependency, index) => (
        <div key={index} className={styles.sampleGroup}>
          {(dependency.samples ?? []).map((sample, sampleIndex) => {
            if (shown >= 30) return null;
            shown += 1;
            const refText = `${sample.path}:${sample.line}`;
            return (
              <div key={sampleIndex} className={styles.sampleRow}>
                <span className={styles.mono}>{refText}</span>
                <span className={`${styles.mono} ${styles.muted}`}>{sample.specifier}</span>
                <CopyButton text={refText} />
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
