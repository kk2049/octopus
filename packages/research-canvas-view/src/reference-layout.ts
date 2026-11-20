import type { GraphPosition } from "@claude-bot/research-canvas-contract";

export type ReferenceLayouts = Record<string, Record<string, Pick<GraphPosition, "x" | "y">>>;
/** Personal view coordinates never contain shared size, pin or ownership fields. */
export function readReferenceLayouts(value: unknown): ReferenceLayouts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([scope, entries]) => {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return [];
    return [[scope, Object.fromEntries(Object.entries(entries).flatMap(([id, position]) => {
      if (!position || typeof position !== "object") return [];
      const { x, y } = position as GraphPosition;
      return Number.isFinite(x) && Number.isFinite(y) ? [[id, { x, y }]] : [];
    }))]];
  }));
}
export function rememberReferencePositions(previous: ReferenceLayouts, scope: string, points: ReadonlyMap<string, GraphPosition>, replace = false): ReferenceLayouts {
  const entries = { ...previous[scope] };
  let changed = false;
  for (const [id, { x, y }] of points) {
    if (!replace && Object.hasOwn(entries, id) || entries[id]?.x === x && entries[id]?.y === y) continue;
    entries[id] = { x, y }; changed = true;
  }
  return changed ? { ...previous, [scope]: entries } : previous;
}
