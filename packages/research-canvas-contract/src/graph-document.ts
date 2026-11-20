/** The editable graph projection. Resource contents and positions are separate APIs. */
export const GRAPH_SCHEMA = "research-graph/v1" as const;
export interface GraphNodeSpec {
  ref: string;
  label: string;
}
export interface GraphEdgeSpec {
  from: string;
  to: string;
  relation: string;
}
export interface GraphSpec {
  nodes: Record<string, GraphNodeSpec>;
  edges: Record<string, GraphEdgeSpec>;
}
export interface GraphYamlSnapshot extends GraphSpec {
  schema: typeof GRAPH_SCHEMA;
  snapshot: string;
}
export interface GraphConflict {
  object: string;
  field: string;
  base: unknown;
  current: unknown;
  submitted: unknown;
  effective: unknown;
}
export interface GraphIssue {
  code: "missing_endpoint" | "missing_resource" | "concurrent_delete";
  object: string;
  message: string;
}
export interface GraphEditResult {
  status: "merged" | "merged_with_conflicts" | "unchanged";
  revision: string;
  changes: { nodes: string[]; edges: string[] };
  conflicts: GraphConflict[];
  issues: GraphIssue[];
}
export interface GraphPosition {
  x: number;
  y: number;
  pinned?: boolean;
  /** Shared preview dimensions, independent of resource contents and YAML. */
  width?: number;
  height?: number;
}
/** Each geometry field is an atomic register; omitted fields are untouched. */
export interface LayoutEdit {
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  pinned?: boolean;
}
export type CanvasSide = "top" | "right" | "bottom" | "left";
/** Edge routing is presentation geometry, not a semantic relation or resource field. */
export interface GraphEdgePorts { sourceSide?: CanvasSide; targetSide?: CanvasSide }
export interface LayoutSnapshot {
  edgePorts?: Record<string, GraphEdgePorts>;
  /** Monotonic receipt/projection ordering on the authoritative Head. */
  sequence?: number;
  revision: string;
  positions: Record<string, GraphPosition>;
}
