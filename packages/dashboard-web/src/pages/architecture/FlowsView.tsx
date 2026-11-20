import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { UiButton } from "../../ui-kit/primitives.js";
/**
 * 剖面 5 · 流程 — swimlane diagrams of the declared flows.
 *
 * Lanes are the zones this flow touches (in trust order), columns are the
 * topological rank derived from `after` (rank = max(predecessors) + 1), and the
 * flow's coverage statement is rendered above the picture so the diagram is
 * honest about what it does not claim to cover.
 */

import { useMemo, useState } from "react";
import type { ArchFlow, ArchFlowStep } from "../ArchitecturePage.js";
import type { SafeView } from "./model.js";
import { flowRanks, truncate, trustRank } from "./model.js";
import styles from "../ArchitecturePage.module.css";

const LANE_LABEL_W = 120;
const STEP_W = 156;
const STEP_H = 42;
const CELL_W = STEP_W + 48;
const STEP_GAP = 10;
const LANE_PAD = 10;

interface Placed {
  step: ArchFlowStep;
  x: number;
  y: number;
}

interface Diagram {
  lanes: Array<{ zone: string; y: number; h: number }>;
  placed: Map<string, Placed>;
  width: number;
  height: number;
}

function computeDiagram(flow: ArchFlow, zoneTrust: Map<string, string>): Diagram {
  const steps = flow.steps;
  const ranks = flowRanks(steps);
  const maxRank = steps.reduce((max, s) => Math.max(max, ranks.get(s.id) ?? 0), 0);

  // Lanes: zones in trust order, then first-appearance order.
  const seen: string[] = [];
  for (const step of steps) if (!seen.includes(step.zone)) seen.push(step.zone);
  const lanesOrder = seen
    .map((zone, at) => ({ zone, at }))
    .sort((a, b) => trustRank(zoneTrust.get(a.zone) ?? "?") - trustRank(zoneTrust.get(b.zone) ?? "?") || a.at - b.at)
    .map((entry) => entry.zone);

  // Stack steps sharing a (zone, rank) cell.
  const cell = new Map<string, ArchFlowStep[]>();
  for (const step of steps) {
    const key = `${step.zone}|${ranks.get(step.id) ?? 0}`;
    const list = cell.get(key) ?? [];
    list.push(step);
    cell.set(key, list);
  }

  const lanes: Diagram["lanes"] = [];
  const placed = new Map<string, Placed>();
  let y = 8;
  for (const zone of lanesOrder) {
    let deepest = 1;
    for (let rank = 0; rank <= maxRank; rank++) {
      deepest = Math.max(deepest, (cell.get(`${zone}|${rank}`) ?? []).length);
    }
    const h = LANE_PAD * 2 + deepest * (STEP_H + STEP_GAP) - STEP_GAP;
    lanes.push({ zone, y, h });
    for (let rank = 0; rank <= maxRank; rank++) {
      const members = cell.get(`${zone}|${rank}`) ?? [];
      members.forEach((step, at) => {
        placed.set(step.id, {
          step,
          x: LANE_LABEL_W + rank * CELL_W + 12,
          y: y + LANE_PAD + at * (STEP_H + STEP_GAP),
        });
      });
    }
    y += h + 8;
  }
  return {
    lanes,
    placed,
    width: LANE_LABEL_W + (maxRank + 1) * CELL_W + 12,
    height: Math.max(y + 4, 120),
  };
}

function StepBox({
  placed,
  selected,
  onSelect,
}: {
  placed: Placed;
  selected: boolean;
  onSelect: () => void;
}) {
  useDashboardLanguage();
  const { step, x, y } = placed;
  const sub = step.condition || step.outcome || step.role || "";
  return (
    <g onClick={onSelect} className={styles.stepBox} role="button" aria-label={uiText("步骤 {v0}", { v0: step.label })}>
      <rect
        x={x}
        y={y}
        width={STEP_W}
        height={STEP_H}
        rx={9}
        className={`${styles.stepRect} ${selected ? styles.stepRectOn : ""}`}
      />
      {step.terminal && (
        <rect x={x + 3} y={y + 3} width={STEP_W - 6} height={STEP_H - 6} rx={6} className={styles.stepRectInner} />
      )}
      <text x={x + 10} y={y + (sub ? 18 : 26)} className={styles.stepLabel}>
        {truncate(step.label, 18)}
      </text>
      {sub && (
        <text x={x + 10} y={y + 33} className={styles.stepSub}>
          {truncate(sub, 20)}
        </text>
      )}
      <title>
        {step.label}
        {step.condition ? uiText("\n条件：{v0}", { v0: step.condition }) : ""}
        {step.outcome ? uiText("\n结果：{v0}", { v0: step.outcome }) : ""}
        {step.terminal ? uiText("\n（终点）") : ""}
      </title>
    </g>
  );
}

export function FlowsView({
  snap,
  selectedStep,
  onSelectStep,
}: {
  snap: SafeView;
  selectedStep: { flow: string; step: string } | null;
  onSelectStep: (flow: string, step: string) => void;
}) {
  useDashboardLanguage();
  const [picked, setPicked] = useState<string | null>(null);
  const flow = snap.flows.find((f) => f.id === picked) ?? snap.flows[0] ?? null;
  const zoneTrust = useMemo(() => new Map(snap.zones.map((z) => [z.id, z.trust])), [snap.zones]);
  const zoneLabel = useMemo(() => new Map(snap.zones.map((z) => [z.id, z.label])), [snap.zones]);
  const diagram = useMemo(
    () => (flow ? computeDiagram(flow, zoneTrust) : null),
    [flow, zoneTrust],
  );

  if (snap.flows.length === 0) {
    return (
      <section className={styles.card}>
        <p className={styles.muted}>{uiText("快照里没有声明任何流程。")}</p>
      </section>
    );
  }

  return (
    <div className={styles.flowsWrap}>
      <nav className={styles.flowList} aria-label={uiText("流程列表")}>
        {snap.flows.map((f) => (
          <UiButton
            key={f.id}
            className={f.id === flow?.id ? styles.flowRowOn : styles.flowRow}
            aria-pressed={f.id === flow?.id}
            onClick={() => setPicked(f.id)}
            title={f.description}
          >
            <span>{f.title}</span>
            {f.perspective && <span className={styles.perspective}>{f.perspective}</span>}
          </UiButton>
        ))}
      </nav>

      {flow && diagram && (
        <section className={`${styles.card} ${styles.flowMain}`}>
          <h3>{flow.title}</h3>
          {flow.description && <p className={styles.muted}>{flow.description}</p>}
          {flow.coverage && (
            <p className={styles.coverage}>
              {uiText("覆盖：")}{flow.coverage.mode} · {flow.coverage.scope}
              {flow.coverage.exclusions.length > 0 && (
                <span className={styles.muted}>{uiText("（不含：")}{flow.coverage.exclusions.join("、")}）</span>
              )}
            </p>
          )}
          <div className={styles.depsSvgWrap}>
            <svg width={diagram.width} height={diagram.height} role="img" aria-label={uiText("{v0} 泳道图", { v0: flow.title })}>
              <defs>
                <marker id="arch-flow-arrow" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
                  <path d="M0,0 L10,4 L0,8 z" fill="var(--line-strong)" />
                </marker>
              </defs>

              {diagram.lanes.map((lane, at) => (
                <g key={lane.zone}>
                  <rect
                    x={0}
                    y={lane.y}
                    width={diagram.width}
                    height={lane.h}
                    className={at % 2 === 0 ? styles.laneEven : styles.laneOdd}
                  />
                  <text x={8} y={lane.y + lane.h / 2 + 4} className={styles.laneLabel}>
                    {truncate(zoneLabel.get(lane.zone) ?? lane.zone, 12)}
                  </text>
                </g>
              ))}

              {flow.steps.map((step) => {
                const target = diagram.placed.get(step.id);
                if (!target) return null;
                return step.after.map((predId, at) => {
                  const source = diagram.placed.get(predId);
                  if (!source) return null;
                  const sx = source.x + STEP_W;
                  const sy = source.y + STEP_H / 2;
                  const tx = target.x;
                  const ty = target.y + STEP_H / 2;
                  const dx = Math.max(20, Math.min(48, (tx - sx) / 2));
                  const d = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
                  return (
                    <g key={`${predId}->${step.id}`}>
                      <path d={d} fill="none" stroke="var(--line-strong)" strokeWidth={1.5} markerEnd="url(#arch-flow-arrow)" />
                      {at === 0 && step.condition && (
                        <text x={(sx + tx) / 2} y={(sy + ty) / 2 - 5} textAnchor="middle" className={styles.edgeLabel}>
                          {truncate(step.condition, 40)}
                        </text>
                      )}
                    </g>
                  );
                });
              })}

              {[...diagram.placed.values()].map((placed) => (
                <StepBox
                  key={placed.step.id}
                  placed={placed}
                  selected={selectedStep?.flow === flow.id && selectedStep?.step === placed.step.id}
                  onSelect={() => onSelectStep(flow.id, placed.step.id)}
                />
              ))}
            </svg>
          </div>
          <p className={styles.muted}>{uiText("双层边框 = 终态步骤。点一个步骤，右侧档案卡显示它的完整声明。")}</p>
        </section>
      )}
    </div>
  );
}
