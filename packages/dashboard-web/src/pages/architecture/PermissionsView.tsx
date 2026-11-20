import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
/**
 * 剖面 4 · 权限 — the TCB budget, the trust matrix and a compact constraint
 * roll-up grouped by concern.
 *
 * The matrix's red frames come from `forbid-dependency` constraints resolved to
 * zone pairs (best-effort prose scan — the DTO carries no structured from/to);
 * a non-zero count inside a red frame is a violation the server also reports,
 * shown redundantly here so the matrix reads on its own.
 */

import type { ArchConstraint } from "../ArchitecturePage.js";
import type { SafeView } from "./model.js";
import { TRUST_LABEL, forbiddenZonePairs, pairKey, zoneMatrix, zonesByTrust } from "./model.js";
import { SeverityBadge, StatusBadge, VerifyBadge } from "./bits.js";
import styles from "../ArchitecturePage.module.css";

const BULLET_W = 620;
const BAR_X = 10;
const BAR_W = BULLET_W - 90;

function TcbPanel({ tcb }: { tcb: SafeView["tcb"] }) {
  useDashboardLanguage();
  if (!tcb) {
    return (
      <section className={styles.card}>
        <h3>{uiText("TCB 预算")}</h3>
        <p className={styles.muted}>{uiText("本快照无 TCB 数据。")}</p>
      </section>
    );
  }
  const lines = Math.max(0, tcb.lines || 0);
  const baseline = Math.max(0, tcb.baseline || 0);
  // Tolerance ≤ 1 reads as a fraction of the baseline, otherwise absolute lines.
  const tolAbs = tcb.tolerance > 0 && tcb.tolerance <= 1 ? baseline * tcb.tolerance : Math.max(0, tcb.tolerance || 0);
  const scaleMax = Math.max(lines, baseline + tolAbs, 1) * 1.08;
  const x = (v: number) => BAR_X + (v / scaleMax) * BAR_W;
  const overBudget = lines > baseline + tolAbs;
  const over = lines > baseline;
  return (
    <section className={styles.card}>
      <h3>
        {uiText("TCB 预算 ")}<span className={styles.muted}>{tcb.label}</span>
      </h3>
      <svg viewBox={`0 0 ${BULLET_W} 52`} className={styles.bullet} role="img" aria-label={uiText("TCB {v0} 行，基线 {v1} 行", { v0: lines, v1: baseline })}>
        {/* track */}
        <rect x={BAR_X} y={20} width={BAR_W} height={12} rx={3} className={styles.bulletTrack} />
        {/* tolerance band: the overrun the budget still tolerates */}
        {tolAbs > 0 && (
          <rect x={x(baseline)} y={16} width={Math.max(1, x(baseline + tolAbs) - x(baseline))} height={20} className={styles.bulletTolerance}>
            <title>{uiText("容差区间：")}{Math.round(baseline)} – {Math.round(baseline + tolAbs)} {uiText(" 行")}</title>
          </rect>
        )}
        {/* measured bar, split at the baseline */}
        <rect x={BAR_X} y={22} width={Math.max(0, x(Math.min(lines, baseline)) - BAR_X)} height={8} rx={2} fill="var(--accent)" />
        {over && (
          <rect
            x={x(baseline)}
            y={22}
            width={Math.max(1, x(lines) - x(baseline))}
            height={8}
            fill={overBudget ? "var(--err)" : "var(--q-warning)"}
          />
        )}
        {/* baseline tick */}
        <line x1={x(baseline)} x2={x(baseline)} y1={12} y2={40} stroke="var(--fg)" strokeWidth={2} />
        <text x={x(baseline)} y={50} textAnchor="middle" className={styles.bulletText}>
          {uiText("基线 ")}{baseline}
        </text>
        <text x={BULLET_W - 4} y={30} textAnchor="end" className={styles.bulletText}>
          {lines} {uiText(" 行")}</text>
        <title>
          TCB {lines} {uiText(" 行 / 基线 ")}{baseline} {uiText(" 行")}{tolAbs > 0 ? uiText("（容差到 {v0}）", { v0: Math.round(baseline + tolAbs) }) : ""}
        </title>
      </svg>
      {overBudget && <p className={styles.errText}>{uiText("超出预算：")}{lines - baseline} {uiText(" 行超过基线，已越过容差区间。")}</p>}
      {!overBudget && over && <p className={styles.warnText}>{uiText("超过基线 ")}{lines - baseline} {uiText(" 行，仍在容差内。")}</p>}

      <div className={styles.tcbLists}>
        <div>
          <h4 className={styles.subhead}>{uiText("未登记的 TCB 文件")}</h4>
          {tcb.unregistered.length === 0 && <p className={styles.muted}>{uiText("无")}</p>}
          {tcb.unregistered.map((path) => (
            <div key={path} className={styles.mono}>
              {path}
            </div>
          ))}
        </div>
        <div>
          <h4 className={styles.subhead}>{uiText("已过期条目")}</h4>
          {tcb.stale.length === 0 && <p className={styles.muted}>{uiText("无")}</p>}
          {tcb.stale.map((path) => (
            <div key={path} className={styles.mono}>
              {path}
            </div>
          ))}
        </div>
      </div>

      <details className={styles.tcbFiles}>
        <summary>{uiText("files 明细（")}{tcb.files.length}）</summary>
        <table className={styles.plainTable}>
          <thead>
            <tr>
              <th>{uiText("路径")}</th>
              <th>LOC</th>
            </tr>
          </thead>
          <tbody>
            {tcb.files.map((file) => (
              <tr key={file.path}>
                <td className={styles.mono}>{file.path}</td>
                <td>{file.loc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function TrustMatrix({ snap }: { snap: SafeView }) {
  useDashboardLanguage();
  const zones = zonesByTrust(snap.zones);
  if (zones.length === 0) {
    return (
      <section className={styles.card}>
        <h3>{uiText("信任矩阵")}</h3>
        <p className={styles.muted}>{uiText("快照里没有 zone。")}</p>
      </section>
    );
  }
  const matrix = zoneMatrix(snap.dependencies, snap.modules);
  const forbidden = forbiddenZonePairs(snap.constraints, snap.modules, snap.zones);
  return (
    <section className={styles.card}>
      <h3>{uiText("信任矩阵")}</h3>
      <p className={styles.muted}>
        {uiText("行 = 依赖方 zone，列 = 被依赖 zone，格 = runtime 依赖边数。红框 = forbid-dependency 约束禁止的组合；红框内非零即违规。")}</p>
      <div className={styles.matrixWrap}>
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th className={styles.matrixCorner}>{uiText("依赖方 ↓ / 被依赖方 →")}</th>
              {zones.map((zone) => (
                <th key={zone.id} title={`${zone.label} · ${TRUST_LABEL()[zone.trust] ?? zone.trust}`}>
                  {zone.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {zones.map((from) => (
              <tr key={from.id}>
                <th title={`${from.label} · ${TRUST_LABEL()[from.trust] ?? from.trust}`}>{from.label}</th>
                {zones.map((to) => {
                  const n = matrix.get(pairKey(from.id, to.id)) ?? 0;
                  const isForbidden = forbidden.has(pairKey(from.id, to.id));
                  const cls = isForbidden
                    ? n > 0
                      ? styles.cellViolation
                      : styles.cellForbidden
                    : from.id === to.id
                      ? styles.cellDiag
                      : undefined;
                  return (
                    <td
                      key={to.id}
                      className={cls}
                      title={uiText("{v0} → {v1}：{v2} 条 runtime 依赖{v3}", { v0: from.label, v1: to.label, v2: n, v3: isForbidden ? uiText("（该组合被 forbid-dependency 约束禁止）") : "" })}
                    >
                      {n > 0 ? n : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ConstraintCards({ constraints }: { constraints: ArchConstraint[] }) {
  useDashboardLanguage();
  const byConcern = new Map<string, ArchConstraint[]>();
  for (const constraint of constraints) {
    const key = constraint.concern || uiText("（未分组）");
    const list = byConcern.get(key) ?? [];
    list.push(constraint);
    byConcern.set(key, list);
  }
  return (
    <section className={styles.card}>
      <h3>{uiText("约束一览")}</h3>
      {byConcern.size === 0 && <p className={styles.muted}>{uiText("没有声明任何约束。")}</p>}
      {[...byConcern.entries()].map(([concern, list]) => (
        <div key={concern} className={styles.concernGroup}>
          <h4 className={styles.subhead}>{concern}</h4>
          <div className={styles.compactGrid}>
            {list.map((constraint) => (
              <div key={constraint.id} className={styles.compactCard} title={constraint.description}>
                <div className={styles.rowTitle}>
                  <StatusBadge status={constraint.status} />
                  <strong>{constraint.title}</strong>
                </div>
                <div className={styles.rowTitle}>
                  <SeverityBadge severity={constraint.severity} />
                  <VerifyBadge mechanismKind={constraint.mechanismKind} />
                  {constraint.violations.length > 0 && (
                    <span className={styles.errText}>{constraint.violations.length} {uiText(" 条违规")}</span>
                  )}
                </div>
                {constraint.summary && <p className={styles.muted}>{constraint.summary}</p>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

export function PermissionsView({ snap }: { snap: SafeView }) {
  useDashboardLanguage();
  return (
    <div>
      <TcbPanel tcb={snap.tcb} />
      <TrustMatrix snap={snap} />
      <ConstraintCards constraints={snap.constraints} />
    </div>
  );
}
