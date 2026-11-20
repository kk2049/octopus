export const RESEARCH_APP = "research-v2";
export const RESEARCH_PUBLISHER = "octopus:first-party";
export const NODE_TYPES = [
  "note",
  "file",
  "agent",
  "group",
  "workgroup",
  "audio",
  "task",
  "finding",
  "collection",
  "folder",
  "goal",
  "review",
  "adapter",
  "timer",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export type ProjectRole = "owner" | "editor" | "researcher" | "viewer";
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Provenance = {
  kind: "human" | "agent" | "system";
  owner: string;
  trigger: string;
  agent: string | null;
  run: string | null;
  model: string | null;
  at: string;
};
export interface Versioned {
  id: string;
  version: number;
  created: Provenance;
  updated: Provenance;
  archived: boolean;
}
export interface ResearchNode extends Versioned {
  /** Stable resource identity; graph membership has its own id and version. */
  snapshot?: string;
  ref?: string;
  resourceVersion?: number;
  type: NodeType | (string & {});
  schema: number;
  title: string;
  summary: string;
  phase: "past" | "present" | "future";
  x: number;
  y: number;
  data: Record<string, Json>;
}
export interface ResearchEdge extends Versioned {
  source: string;
  target: string;
  label: string;
}
export const EVENT_TYPES = [
  "group.message",
  "agent.completed",
  "file.created",
  "file.updated",
  "audio.transcribed",
  "timer.tick",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type Schedule =
  | { kind: "once"; at: string; timezone: string; missed: "skip" | "latest" }
  | {
      kind: "interval";
      start: string;
      minutes: number;
      timezone: string;
      missed: "skip" | "latest";
    }
  | {
      kind: "daily" | "weekly";
      time: string;
      weekdays: number[];
      timezone: string;
      missed: "skip" | "latest";
    };
export interface ResearchSubscription extends Versioned {
  source: string;
  target: string;
  event: EventType;
  enabled: boolean;
  filter: {
    mode: "all" | "mention" | "model";
    mentionId: string;
    instruction: string;
    statuses: string[];
  };
  prompt: string;
  conversation: string;
  state: "ready" | "paused" | "running" | "error";
  error: string | null;
}
export interface ResourceBinding extends Versioned {
  node: string;
  kind: "agent" | "session" | "group" | "file" | "audio";
  owner: string;
  resource: string;
  config: Record<string, Json>;
}
export interface ResearchEvent {
  id: string;
  project: string;
  source: string;
  type: EventType;
  version: number;
  at: string;
  trigger: string;
  root: string;
  chain: string[];
  payload: Record<string, Json>;
}
export interface ResearchRun {
  id: string;
  project: string;
  node: string;
  conversation: string;
  subscription: string | null;
  event: string | null;
  root: string;
  chain: string[];
  binding: ResourceBinding;
  trigger: string;
  prompt: string;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "cancelled"
    | "unknown";
  at: string;
  finished: string | null;
  model: string | null;
  usage: { input: number; output: number; receipt: string } | null;
  error: string | null;
  stopRequested?: { by: string; at: string };
}
export interface ResearchMessage {
  sequence?: number;
  id: string;
  run: string;
  conversation: string;
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  at: string;
  tool?: string;
  arguments?: string;
}
export interface ResearchProposal extends Versioned {
  action: string;
  params: Record<string, string>;
  reason: string;
  state: "pending" | "approved" | "rejected";
  resolvedBy: Provenance | null;
}
export interface GraphPage {
  project: string;
  title: string;
  viewer: string;
  role: ProjectRole;
  nodes: ResearchNode[];
  edges: ResearchEdge[];
  subscriptions: ResearchSubscription[];
  proposals: ResearchProposal[];
  runs: ResearchRun[];
  cursor: number;
  hasMore: boolean;
}
export interface ToolDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export const canEdit = (role: ProjectRole): boolean =>
  role === "owner" || role === "editor";
export const canRun = (role: ProjectRole): boolean => role !== "viewer";
