/**
 * Bounded, in-memory activity projected into the trusted global chrome.
 *
 * This is deliberately not localStorage and never contains proposal params,
 * transcript text or resource ids. A page reload starts clean; the durable
 * audit remains server-side. The store only lets the top-right panel follow
 * activity produced by the App page currently mounted in this document.
 */
import { useSyncExternalStore } from "react";
import type { HostSnapshot } from "../session-plus/frame-host.js";

export type AgenticActivityState =
  | "accepted"
  | "refused"
  | "submitted"
  | "waiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "unknown";

export interface AgenticActivity {
  id: string;
  appId: string;
  appTitle: string;
  action: string;
  state: AgenticActivityState;
  detail: string;
  at: string;
}

const MAX_ACTIVITY = 40;
let activity: readonly AgenticActivity[] = Object.freeze([]);
const listeners = new Set<() => void>();

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function publish(next: AgenticActivity): void {
  const without = activity.filter((row) => row.id !== next.id);
  activity = Object.freeze([next, ...without].slice(0, MAX_ACTIVITY));
  for (const listener of listeners) listener();
}

export function recordAgenticProposal(
  app: { id: string; title: string },
  snapshot: HostSnapshot,
): void {
  if (!snapshot.lastAnswer) return;
  const action = bounded(snapshot.lastAnswer.action, 64);
  if (!action) return;
  publish({
    id: `${app.id}:proposal:${snapshot.generation}:${snapshot.accepted}:${snapshot.refused}`,
    appId: bounded(app.id, 128),
    appTitle: bounded(app.title, 120),
    action,
    state: snapshot.lastAnswer.ok ? "accepted" : "refused",
    detail: bounded(snapshot.lastAnswer.code, 64),
    at: new Date().toISOString(),
  });
}

const OPERATION_STATES = new Set<AgenticActivityState>([
  "submitted",
  "waiting_approval",
  "running",
  "succeeded",
  "failed",
  "rejected",
  "unknown",
]);

export function recordAgenticOperation(
  app: { id: string; title: string },
  value: unknown,
): void {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  const operationId = bounded(row.id, 160);
  const action = bounded(row.operation, 64);
  const state = bounded(row.status, 32) as AgenticActivityState;
  if (!operationId || !action || !OPERATION_STATES.has(state)) return;
  publish({
    id: `${app.id}:operation:${operationId}`,
    appId: bounded(app.id, 128),
    appTitle: bounded(app.title, 120),
    action,
    state,
    detail: bounded(row.message, 240),
    at: bounded(row.updatedAt, 40) || new Date().toISOString(),
  });
}

export function subscribeAgenticActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function agenticActivitySnapshot(): readonly AgenticActivity[] {
  return activity;
}

export function useAgenticActivity(): readonly AgenticActivity[] {
  return useSyncExternalStore(subscribeAgenticActivity, agenticActivitySnapshot, agenticActivitySnapshot);
}

/** Unit-test isolation; production code never clears another surface's history. */
export function resetAgenticActivityForTests(): void {
  activity = Object.freeze([]);
  for (const listener of listeners) listener();
}
