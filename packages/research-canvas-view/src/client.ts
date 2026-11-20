import type {
  GraphPage,
  ProjectRole,
  ResearchNode,
  ResearchEdge,
  ResearchRun,
  ResearchSubscription,
  ResearchProposal,
} from "@claude-bot/research-canvas-contract";

export type Call = <T = unknown>(
  action: string,
  params?: Record<string, unknown>,
) => Promise<T>;
export interface CanvasBoot {
  project: string;
  title?: string;
  viewer: string;
  role: ProjectRole;
  epoch: number;
  dataEpoch?: number;
}
export interface CanvasGraph {
  revision?: string;
  nodes: ResearchNode[];
  edges: ResearchEdge[];
  subscriptions: ResearchSubscription[];
  proposals: ResearchProposal[];
  runs: ResearchRun[];
  cursor: number;
}
export const emptyGraph = (): CanvasGraph => ({
  nodes: [],
  edges: [],
  subscriptions: [],
  proposals: [],
  runs: [],
  cursor: 0,
});
export const requestId = (): string => crypto.randomUUID();
export function encodeParams(
  params: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      ]),
  );
}
export async function readGraph(call: Call): Promise<CanvasGraph> {
  const result = emptyGraph();
  let after: string | undefined;
  let initialized = false;
  do {
    const page = await call<GraphPage & { next: string | null; revision?: string }>(
      "canvas_read",
      after ? { after, active: true } : { active: true },
    );
    for (const key of ["nodes", "edges", "subscriptions", "proposals"] as const)
      (result[key] as { id: string }[]).push(...page[key]);
    result.runs = page.runs;
    result.revision = page.revision;
    // Keep the earliest cursor: changes arriving during pagination must replay.
    result.cursor = initialized
      ? Math.min(result.cursor, page.cursor)
      : page.cursor;
    initialized = true;
    after = page.next ?? undefined;
  } while (after);
  return result;
}
export async function refreshGraph(
  call: Call,
  graph: CanvasGraph,
): Promise<CanvasGraph> {
  const result = { ...graph };
  for (;;) {
    const page = await call<{
      revision?: string;
      changes: { bucket: string; id: string; record: unknown }[];
      cursor: number;
      hasMore: boolean;
    }>("canvas_changes", { after: result.cursor });
    for (const change of page.changes) {
      if (
        !change.record ||
        !["nodes", "edges", "subscriptions", "proposals", "runs"].includes(
          change.bucket,
        )
      )
        continue;
      const key = change.bucket as Exclude<keyof CanvasGraph, "cursor" | "revision">;
      const items = result[key] as { id: string }[];
      (result[key] as { id: string }[]) = [
        ...items.filter((item) => item.id !== change.id),
        change.record as { id: string },
      ];
    }
    result.cursor = page.cursor;
    result.revision = page.revision;
    const active = new Set(result.nodes.filter(node => !node.archived).map(node => node.id));
    result.edges = result.edges.map(edge => !active.has(edge.source) || !active.has(edge.target) ? { ...edge, archived: true } : edge);
    if (!page.hasMore) return result;
  }
}
export function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota/private mode never discards the in-memory working copy. But the
    // entry still holds an OLDER value that a reload would restore as current
    // (an old draft would even be saved over newer text), so drop it.
    try { localStorage.removeItem(key); } catch { /* nothing left to try */ }
  }
}
