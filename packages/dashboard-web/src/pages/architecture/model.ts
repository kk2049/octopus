import { uiText, localizedLabels } from "../../i18n/ui-text.js";
/**
 * Pure computation for the architecture page: defensive normalisation of the
 * snapshot, dependency aggregation for the zone graph, the trust matrix, the
 * forbidden-pair scan and flow topological ranks.
 *
 * Everything here is deterministic and DOM-free so it can be unit-tested; the
 * views only translate these results into SVG/HTML.
 */

import type {
  ArchConstraint,
  ArchDependency,
  ArchFlowStep,
  ArchModuleEcosystem,
  ArchModule,
  ArchZone,
  ArchitectureView,
} from "../ArchitecturePage.js";

// ── Defensive normalisation ─────────────────────────────────────────────────

/**
 * The two sides of `/api/architecture` are developed in parallel, so the shape
 * may drift a little. Missing arrays become empty, missing objects stay
 * undefined/null — every view renders from this and never touches the raw wire.
 */
export interface SafeView {
  meta: ArchitectureView["meta"] | undefined;
  zones: ArchZone[];
  modules: ArchModule[];
  dependencies: ArchDependency[];
  moduleEcosystem: ArchModuleEcosystem;
  flows: ArchitectureView["flows"];
  constraints: ArchConstraint[];
  findings: ArchitectureView["findings"];
  tcb: ArchitectureView["tcb"];
  hotspots: ArchitectureView["hotspots"];
}

function arr<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

export function emptyView(snapshot: Partial<ArchitectureView> | undefined | null): SafeView {
  const tcb = snapshot?.tcb;
  return {
    meta: snapshot?.meta,
    zones: arr(snapshot?.zones),
    modules: arr(snapshot?.modules).map((m) => ({
      ...m,
      tags: arr(m?.tags),
      docs: arr(m?.docs),
      runtimeFanIn: m.runtimeFanIn ?? m.fanIn ?? 0,
      runtimeFanOut: m.runtimeFanOut ?? m.fanOut ?? 0,
      typeOnlyFanIn: m.typeOnlyFanIn ?? 0,
      typeOnlyFanOut: m.typeOnlyFanOut ?? 0,
    })),
    dependencies: arr(snapshot?.dependencies).map((d) => ({ ...d, samples: arr(d?.samples) })),
    moduleEcosystem: {
      frontend: arr(snapshot?.moduleEcosystem?.frontend).map((module) => ({
        ...module,
        slots: arr(module?.slots),
        ports: arr(module?.ports),
        opens: arr(module?.opens),
        configKeys: arr(module?.configKeys),
      })),
      contracts: arr(snapshot?.moduleEcosystem?.contracts).map((contract) => ({
        ...contract,
        actions: arr(contract?.actions),
      })),
      backend: arr(snapshot?.moduleEcosystem?.backend).map((module) => ({
        ...module,
        contracts: arr(module?.contracts),
        actions: arr(module?.actions),
        dependencies: arr(module?.dependencies),
      })),
      dependencies: arr(snapshot?.moduleEcosystem?.dependencies),
      issues: arr(snapshot?.moduleEcosystem?.issues),
    },
    flows: arr(snapshot?.flows).map((flow) => ({
      ...flow,
      steps: arr(flow?.steps).map((step) => ({ ...step, after: arr(step?.after) })),
    })),
    constraints: arr(snapshot?.constraints).map((c) => ({
      ...c,
      violations: arr(c?.violations),
      evidence: arr(c?.evidence),
    })),
    findings: arr(snapshot?.findings).map((f) => ({ ...f, moduleIds: arr(f?.moduleIds) })),
    tcb: tcb
      ? { ...tcb, files: arr(tcb.files), unregistered: arr(tcb.unregistered), stale: arr(tcb.stale) }
      : null,
    hotspots: arr(snapshot?.hotspots),
  };
}

// ── Trust ordering ──────────────────────────────────────────────────────────

export const TRUST_ORDER = ["external", "untrusted", "trusted", "critical"] as const;

export const TRUST_LABEL = localizedLabels((): Record<string, string> => ({
  external: uiText("外部"),
  untrusted: uiText("不可信"),
  trusted: uiText("可信"),
  critical: uiText("关键 (TCB)"),
}));

export function trustRank(trust: string): number {
  const at = (TRUST_ORDER as readonly string[]).indexOf(trust);
  return at < 0 ? TRUST_ORDER.length : at;
}

/** Zones sorted by trust tier then declaration order — the row/column order everywhere. */
export function zonesByTrust(zones: ArchZone[]): ArchZone[] {
  return zones
    .map((zone, at) => ({ zone, at }))
    .sort((a, b) => trustRank(a.zone.trust) - trustRank(b.zone.trust) || a.at - b.at)
    .map((entry) => entry.zone);
}

export function moduleZoneMap(modules: ArchModule[]): Map<string, string> {
  return new Map(modules.map((m) => [m.id, m.zone]));
}

// ── Dependency aggregation (依赖剖面) ───────────────────────────────────────

export type DepFilter = "all" | "cross" | "critical";

export interface GraphNodeRef {
  kind: "zone" | "module";
  id: string;
}

export interface GraphEdge {
  from: GraphNodeRef;
  to: GraphNodeRef;
  /** Number of module-level runtime dependency records folded in. */
  count: number;
  circular: boolean;
  crossZone: boolean;
  /** The underlying records, for the sample bar. */
  deps: ArchDependency[];
}

export function edgeKey(edge: Pick<GraphEdge, "from" | "to">): string {
  return `${edge.from.kind}:${edge.from.id}->${edge.to.kind}:${edge.to.id}`;
}

function isRuntime(dep: ArchDependency): boolean {
  return (dep.runtimeCount ?? 0) > 0 || (dep.dynamicCount ?? 0) > 0;
}

/**
 * Fold module-level runtime dependencies into the collapse/expand graph.
 *
 * Endpoints inside an expanded zone stay module-level; everything else folds to
 * its zone. Same-node self loops (a collapsed zone's internal edges) are
 * dropped. Deterministic: output order follows first appearance in the input.
 */
export function buildGraphEdges(
  deps: ArchDependency[],
  modules: ArchModule[],
  expanded: ReadonlySet<string>,
  filter: DepFilter = "all",
): GraphEdge[] {
  const zoneOf = moduleZoneMap(modules);
  const critical = new Set(modules.filter((m) => m.criticality === "critical").map((m) => m.id));
  const grouped = new Map<string, GraphEdge>();
  for (const dep of deps) {
    if (!isRuntime(dep)) continue;
    const zoneF = zoneOf.get(dep.from);
    const zoneT = zoneOf.get(dep.to);
    if (zoneF === undefined || zoneT === undefined) continue;
    if (filter === "cross" && zoneF === zoneT) continue;
    if (filter === "critical" && !critical.has(dep.from) && !critical.has(dep.to)) continue;
    const from: GraphNodeRef = expanded.has(zoneF)
      ? { kind: "module", id: dep.from }
      : { kind: "zone", id: zoneF };
    const to: GraphNodeRef = expanded.has(zoneT)
      ? { kind: "module", id: dep.to }
      : { kind: "zone", id: zoneT };
    if (from.kind === to.kind && from.id === to.id) continue; // collapsed self loop
    const key = edgeKey({ from, to });
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      existing.circular = existing.circular || dep.circular === true;
      existing.deps.push(dep);
    } else {
      grouped.set(key, {
        from,
        to,
        count: 1,
        circular: dep.circular === true,
        crossZone: zoneF !== zoneT,
        deps: [dep],
      });
    }
  }
  return [...grouped.values()];
}

// ── DSM 矩阵 (依赖剖面 · 矩阵模式) ──────────────────────────────────────────

export interface MatrixGroup {
  zone: ArchZone;
  /** Index of the group's first module in `MatrixOrder.modules`. */
  start: number;
  count: number;
}

export interface MatrixOrder {
  /** Row order == column order: the DSM axis. */
  modules: ArchModule[];
  groups: MatrixGroup[];
}

/**
 * Row/column order for the dependency structure matrix. Zones are grouped by
 * trust tier (external → untrusted → trusted → critical, undeclared last, same
 * as everywhere else on the page); modules inside a zone sort by codeLoc
 * descending so the heavyweights hug the diagonal block's corner. Zones without
 * modules disappear — an empty stripe says nothing.
 */
export function matrixOrder(modules: ArchModule[], zones: ArchZone[]): MatrixOrder {
  const declared = new Map(zones.map((z) => [z.id, z]));
  for (const mod of modules) {
    if (!declared.has(mod.zone)) {
      declared.set(mod.zone, { id: mod.zone, label: mod.zone || uiText("（未声明 zone）"), trust: "?", color: "" });
    }
  }
  const byZone = new Map<string, ArchModule[]>();
  for (const mod of modules) {
    const list = byZone.get(mod.zone) ?? [];
    list.push(mod);
    byZone.set(mod.zone, list);
  }
  const ordered: ArchModule[] = [];
  const groups: MatrixGroup[] = [];
  for (const zone of zonesByTrust([...declared.values()])) {
    const members = (byZone.get(zone.id) ?? [])
      .slice()
      .sort((a, b) => (b.codeLoc || 0) - (a.codeLoc || 0) || a.id.localeCompare(b.id));
    if (members.length === 0) continue;
    groups.push({ zone, start: ordered.length, count: members.length });
    ordered.push(...members);
  }
  return { modules: ordered, groups };
}

export interface MatrixCell {
  /** runtimeCount + dynamicCount folded over the records; typeOnly/test 不计. */
  count: number;
  circular: boolean;
  /** Underlying records, for the detail bar. */
  deps: ArchDependency[];
}

/**
 * from-module → to-module cells for the DSM, keyed by `pairKey(from, to)`.
 * Cell value counts runtime + dynamic imports; pairs with none are absent so
 * the matrix stays sparse.
 */
export function matrixCells(deps: ArchDependency[]): Map<string, MatrixCell> {
  const cells = new Map<string, MatrixCell>();
  for (const dep of deps) {
    const weight = (dep.runtimeCount ?? 0) + (dep.dynamicCount ?? 0);
    if (weight <= 0) continue;
    const key = pairKey(dep.from, dep.to);
    const cell = cells.get(key);
    if (cell) {
      cell.count += weight;
      cell.circular = cell.circular || dep.circular === true;
      cell.deps.push(dep);
    } else {
      cells.set(key, { count: weight, circular: dep.circular === true, deps: [dep] });
    }
  }
  return cells;
}

// ── Trust matrix (权限剖面) ─────────────────────────────────────────────────

export function pairKey(from: string, to: string): string {
  return `${from}|${to}`;
}

/** from-zone → to-zone runtime edge counts. Key is `pairKey(from, to)`. */
export function zoneMatrix(deps: ArchDependency[], modules: ArchModule[]): Map<string, number> {
  const zoneOf = moduleZoneMap(modules);
  const matrix = new Map<string, number>();
  for (const dep of deps) {
    if (!isRuntime(dep)) continue;
    const zoneF = zoneOf.get(dep.from);
    const zoneT = zoneOf.get(dep.to);
    if (zoneF === undefined || zoneT === undefined) continue;
    const key = pairKey(zoneF, zoneT);
    matrix.set(key, (matrix.get(key) ?? 0) + 1);
  }
  return matrix;
}

/**
 * Which module / zone ids does this free text mention? Boundary-aware so that
 * `bot` does not match inside `bot-host`.
 */
export function mentionedIds(text: string, ids: readonly string[]): string[] {
  const found: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\w./-])${escaped}(?![\\w./-])`);
    if (re.test(text)) found.push(id);
  }
  return found;
}

function constraintText(constraint: ArchConstraint): string {
  return [
    constraint.title,
    constraint.description,
    constraint.summary ?? "",
    ...constraint.violations.map((v) => v.message),
  ].join("\n");
}

/**
 * Zone pairs forbidden by `forbid-dependency` constraints, derived by reading
 * the constraint's own prose: `a -> b` / `a → b` arrows between known module or
 * zone ids, resolved to zones. Best-effort by design — the constraint DTO has
 * no structured from/to, and a pair we cannot resolve is simply not framed.
 */
export function forbiddenZonePairs(
  constraints: ArchConstraint[],
  modules: ArchModule[],
  zones: ArchZone[],
): Set<string> {
  const zoneOf = moduleZoneMap(modules);
  const zoneIds = new Set(zones.map((z) => z.id));
  const resolve = (token: string): string | null => {
    const clean = token.replace(/^[^\w./-]+|[^\w./-]+$/g, "");
    if (zoneIds.has(clean)) return clean;
    const viaModule = zoneOf.get(clean);
    return viaModule ?? null;
  };
  const pairs = new Set<string>();
  for (const constraint of constraints) {
    if (constraint.mechanismKind !== "forbid-dependency") continue;
    const text = constraintText(constraint);
    for (const match of text.matchAll(/([\w./-]+)\s*(?:->|→|=>)\s*([\w./-]+)/g)) {
      const from = resolve(match[1]);
      const to = resolve(match[2]);
      if (from !== null && to !== null && from !== to) pairs.add(pairKey(from, to));
    }
  }
  return pairs;
}

/** Module ids a constraint's prose points at — for dep-graph highlighting. */
export function constraintModules(constraint: ArchConstraint, modules: ArchModule[]): string[] {
  return mentionedIds(constraintText(constraint), modules.map((m) => m.id));
}

// ── Flow ranks (流程剖面) ───────────────────────────────────────────────────

/**
 * Topological rank per step: rank = max(rank of predecessors) + 1, roots at 0.
 * Unknown predecessors are ignored; cycles converge by bounded relaxation
 * instead of hanging.
 */
export function flowRanks(steps: Array<Pick<ArchFlowStep, "id" | "after">>): Map<string, number> {
  const rank = new Map<string, number>(steps.map((step) => [step.id, 0]));
  for (let pass = 0; pass < steps.length; pass++) {
    let changed = false;
    for (const step of steps) {
      const preds = (step.after ?? []).filter((id) => rank.has(id) && id !== step.id);
      const next = preds.length === 0 ? 0 : Math.max(...preds.map((id) => rank.get(id) ?? 0)) + 1;
      if (next > (rank.get(step.id) ?? 0)) {
        rank.set(step.id, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

// ── Sequential fill (总览剖面) ──────────────────────────────────────────────

/**
 * Percent along the one-hue sequential ramp for a churn value. √-scaled so the
 * long tail does not flatten everything near the minimum; 12–100 keeps a
 * zero-churn module visibly on the ramp rather than invisible.
 */
export function seqFillPercent(touches: number, maxTouches: number): number {
  if (!(maxTouches > 0)) return 12;
  const ratio = Math.max(0, Math.min(1, touches / maxTouches));
  return Math.round(12 + 88 * Math.sqrt(ratio));
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
