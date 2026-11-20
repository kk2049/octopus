import type {
  ArchBackendModule,
  ArchFrontendModule,
  ArchModuleContract,
  ArchModuleEcosystem,
} from "../ArchitecturePage.js";

export interface EcosystemBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrontendGroupLayout {
  packageId: string;
  packagePath: string;
  box: EcosystemBox;
  modules: Array<{ module: ArchFrontendModule; key: string; box: EcosystemBox }>;
}

export interface ContractNodeLayout {
  module: ArchModuleContract;
  key: string;
  box: EcosystemBox;
}

export interface BackendNodeLayout {
  module: ArchBackendModule;
  key: string;
  rank: number;
  box: EcosystemBox;
  cyclic: boolean;
}

export interface ModuleEcosystemLayout {
  frontend: FrontendGroupLayout[];
  contracts: ContractNodeLayout[];
  backend: BackendNodeLayout[];
  boxes: Map<string, EcosystemBox>;
  ranks: Map<string, number>;
  cyclicEdges: Set<string>;
  width: number;
  height: number;
}

export const FRONTEND_WIDTH = 268;
export const CONTRACT_WIDTH = 220;
export const BACKEND_WIDTH = 238;
const FRONTEND_HEADER = 30;
const FRONTEND_ROW = 38;
const FRONTEND_GAP = 16;
const CONTRACT_HEIGHT = 54;
const BACKEND_HEIGHT = 68;
const ROW_GAP = 18;
const LAYER_GAP = 82;
const TOP = 46;
const LEFT = 16;
const CONTRACT_LEFT = LEFT + FRONTEND_WIDTH + 96;
const BACKEND_LEFT = CONTRACT_LEFT + CONTRACT_WIDTH + 104;

export function frontendModuleKey(module: Pick<ArchFrontendModule, "packageId" | "id">): string {
  return `frontend:${module.packageId}:${module.id}`;
}

export function contractModuleKey(contractId: string): string {
  return `contract:${contractId}`;
}

export function backendModuleKey(providerId: string): string {
  return `backend:${providerId}`;
}

export function ecosystemEdgeKey(edge: ArchModuleEcosystem["dependencies"][number]): string {
  return `${edge.kind}:${edge.from}->${edge.to}:${edge.label}`;
}

interface Components {
  componentOf: Map<string, number>;
  members: string[][];
}

/** Tarjan SCC, kept local so the layout has no graph-library runtime. */
function stronglyConnected(nodes: string[], edges: Array<{ from: string; to: string }>): Components {
  const adjacency = new Map(nodes.map((node) => [node, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);
  for (const list of adjacency.values()) list.sort();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const members: string[][] = [];
  let next = 0;
  const visit = (node: string): void => {
    index.set(node, next);
    low.set(node, next);
    next += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node)!, low.get(target)!));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node)!, index.get(target)!));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    members.push(component.sort());
  };
  for (const node of [...nodes].sort()) if (!index.has(node)) visit(node);
  const componentOf = new Map<string, number>();
  members.forEach((component, at) => component.forEach((node) => componentOf.set(node, at)));
  return { componentOf, members };
}

function componentRanks(components: Components, edges: Array<{ from: string; to: string }>): Map<number, number> {
  const outgoing = new Map<number, Set<number>>();
  const incoming = new Map<number, number>(components.members.map((_members, at) => [at, 0]));
  for (const edge of edges) {
    const from = components.componentOf.get(edge.from);
    const to = components.componentOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const targets = outgoing.get(from) ?? new Set<number>();
    if (!targets.has(to)) incoming.set(to, (incoming.get(to) ?? 0) + 1);
    targets.add(to);
    outgoing.set(from, targets);
  }
  const rank = new Map<number, number>(components.members.map((_members, at) => [at, 0]));
  const queue = [...incoming.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort((a, b) => a - b);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const target of [...(outgoing.get(current) ?? [])].sort((a, b) => a - b)) {
      rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(current) ?? 0) + 1));
      incoming.set(target, (incoming.get(target) ?? 0) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
    queue.sort((a, b) => a - b);
  }
  return rank;
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Deterministic three-tier layout: View contribution → contract → trusted Provider. */
export function layoutModuleEcosystem(ecosystem: ArchModuleEcosystem): ModuleEcosystemLayout {
  const byPackage = new Map<string, ArchFrontendModule[]>();
  for (const module of ecosystem.frontend) {
    byPackage.set(module.packageId, [...(byPackage.get(module.packageId) ?? []), module]);
  }
  const frontend: FrontendGroupLayout[] = [];
  const boxes = new Map<string, EcosystemBox>();
  let frontY = TOP;
  for (const [packageId, modules] of [...byPackage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    modules.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    const height = FRONTEND_HEADER + modules.length * FRONTEND_ROW + 6;
    const group: FrontendGroupLayout = {
      packageId,
      packagePath: modules[0]?.packagePath ?? "",
      box: { x: LEFT, y: frontY, w: FRONTEND_WIDTH, h: height },
      modules: modules.map((module, at) => {
        const key = frontendModuleKey(module);
        const box = { x: LEFT + 8, y: frontY + FRONTEND_HEADER + at * FRONTEND_ROW, w: FRONTEND_WIDTH - 16, h: FRONTEND_ROW - 5 };
        boxes.set(key, box);
        return { module, key, box };
      }),
    };
    frontend.push(group);
    frontY += height + FRONTEND_GAP;
  }

  const frontOrder = new Map<string, number>();
  frontend.flatMap((group) => group.modules).forEach((entry, at) => frontOrder.set(entry.key, at));
  const contractOrder = new Map<string, number>();
  for (const contract of ecosystem.contracts) {
    const key = contractModuleKey(contract.id);
    const consumers = ecosystem.dependencies
      .filter((edge) => edge.kind === "requires" && edge.to === key)
      .flatMap((edge) => frontOrder.has(edge.from) ? [frontOrder.get(edge.from)!] : []);
    contractOrder.set(key, average(consumers) ?? Number.MAX_SAFE_INTEGER);
  }
  const contracts: ContractNodeLayout[] = [...ecosystem.contracts]
    .sort((a, b) => (contractOrder.get(contractModuleKey(a.id)) ?? 0) - (contractOrder.get(contractModuleKey(b.id)) ?? 0)
      || a.id.localeCompare(b.id))
    .map((module, at) => {
      const key = contractModuleKey(module.id);
      const box = { x: CONTRACT_LEFT, y: TOP + at * (CONTRACT_HEIGHT + ROW_GAP), w: CONTRACT_WIDTH, h: CONTRACT_HEIGHT };
      boxes.set(key, box);
      return { module, key, box };
    });

  const backendKeys = ecosystem.backend.map((module) => backendModuleKey(module.id));
  const backendSet = new Set(backendKeys);
  const backendEdges = ecosystem.dependencies
    .filter((edge) => edge.kind === "provider" && backendSet.has(edge.from) && backendSet.has(edge.to));
  const components = stronglyConnected(backendKeys, backendEdges);
  const componentRank = componentRanks(components, backendEdges);
  const ranks = new Map<string, number>();
  for (const key of backendKeys) ranks.set(key, componentRank.get(components.componentOf.get(key) ?? -1) ?? 0);
  const maxRank = Math.max(0, ...ranks.values());
  const layers = Array.from({ length: maxRank + 1 }, () => [] as string[]);
  for (const key of backendKeys) layers[ranks.get(key) ?? 0].push(key);
  const providerOrder = new Map<string, number>();
  contracts.forEach((entry, at) => {
    for (const edge of ecosystem.dependencies.filter((edge) => edge.kind === "provides" && edge.from === entry.key)) {
      providerOrder.set(edge.to, Math.min(providerOrder.get(edge.to) ?? Number.MAX_SAFE_INTEGER, at));
    }
  });
  for (const layer of layers) {
    layer.sort((a, b) => (providerOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (providerOrder.get(b) ?? Number.MAX_SAFE_INTEGER)
      || a.localeCompare(b));
  }

  const cyclicNodes = new Set<string>();
  for (const component of components.members) if (component.length > 1) component.forEach((key) => cyclicNodes.add(key));
  const cyclicEdges = new Set<string>();
  for (const edge of backendEdges) {
    if (edge.from === edge.to || components.componentOf.get(edge.from) === components.componentOf.get(edge.to)) {
      cyclicNodes.add(edge.from);
      cyclicEdges.add(ecosystemEdgeKey(edge));
    }
  }

  const backendByKey = new Map(ecosystem.backend.map((module) => [backendModuleKey(module.id), module]));
  const backend: BackendNodeLayout[] = [];
  let backendBottom = TOP;
  layers.forEach((layer, rank) => {
    layer.forEach((key, at) => {
      const module = backendByKey.get(key);
      if (!module) return;
      const box = {
        x: BACKEND_LEFT + rank * (BACKEND_WIDTH + LAYER_GAP),
        y: TOP + at * (BACKEND_HEIGHT + ROW_GAP),
        w: BACKEND_WIDTH,
        h: BACKEND_HEIGHT,
      };
      boxes.set(key, box);
      backend.push({ module, key, rank, box, cyclic: cyclicNodes.has(key) });
      backendBottom = Math.max(backendBottom, box.y + box.h);
    });
  });

  const contractBottom = contracts.at(-1)?.box ? contracts.at(-1)!.box.y + CONTRACT_HEIGHT : TOP;
  return {
    frontend,
    contracts,
    backend,
    boxes,
    ranks,
    cyclicEdges,
    width: BACKEND_LEFT + (maxRank + 1) * BACKEND_WIDTH + maxRank * LAYER_GAP + 28,
    height: Math.max(300, frontY, contractBottom + 32, backendBottom + 32),
  };
}
