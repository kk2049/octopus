/**
 * The App-author surface.
 *
 * Six hooks, and the split between them is the boundary restated in an API:
 *
 *   useProjection()      what the Host chose to show us — read-only, replaced
 *                        wholesale on every update, never merged locally
 *   useOperations()      the lifecycle of submissions the Host is running
 *   useAgentViewStatus() whether we have a channel at all, and how many
 *                        proposals are outstanding
 *   usePropose()         the ONLY way to ask for anything
 *   useRefusal()         the last bounded refusal, for showing a person
 *   useWake()            how many times the Host has hinted that one held
 *                        resource changed — a counter, never a read
 *
 * There is no `useIdentity`, no `useOwner`, no `useCapability` and no way to
 * add one: the View is never told who it is drawing for, so a hook that
 * returned it would have to invent it.
 */

import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { AgentViewOperation, AgentViewSnapshot, PendingProposal, Projection, ProposalReply, TransportPhase } from "./client.js";
import { AgentViewContext, type AgentViewContextValue } from "./context.js";

export function useAgentView(): AgentViewContextValue {
  const value = useContext(AgentViewContext);
  if (!value) throw new Error("Agent View hooks require an <AgentViewProvider> above them");
  return value;
}

/**
 * The whole transport snapshot.
 *
 * `subscribe` and `snapshot` are stable methods on the client, and the client
 * publishes a fresh object per change, so `useSyncExternalStore` compares by
 * identity and never tears — including under concurrent rendering, which is
 * exactly what a hand-rolled `useEffect` + `useState` pair gets wrong.
 */
export function useAgentViewSnapshot(): AgentViewSnapshot {
  const { client } = useAgentView();
  return useSyncExternalStore(client.subscribe, client.snapshot, client.snapshot);
}

/**
 * The Host's current projection, or `null` before the first boot frame.
 *
 * Typed by the caller because the shape is the App's contract with its own
 * backend, not something this SDK can know. It is REPLACED, never merged: the
 * Host is the author, so a View that patched it locally would be rendering its
 * own opinion of state that something else owns.
 */
export function useProjection<T = Projection>(): T | null {
  return useAgentViewSnapshot().projection as T | null;
}

/** Operation records, newest first, one per id. */
export function useOperations(): AgentViewOperation[] {
  return useAgentViewSnapshot().operations;
}

export interface AgentViewStatus {
  phase: TransportPhase;
  inFlight: number;
  /** True once a boot frame has arrived and the channel is still open. */
  ready: boolean;
}

export function useAgentViewStatus(): AgentViewStatus {
  const { phase, inFlight } = useAgentViewSnapshot();
  return useMemo(() => ({ phase, inFlight, ready: phase === "open" }), [phase, inFlight]);
}

/** The only way to ask the Host for anything. Never rejects. */
export function usePropose(): (action: string, params?: Record<string, string>) => Promise<ProposalReply> {
  return useAgentView().propose;
}

/**
 * The wake token for one resource ref (ADR 0006): 0 until the Host first
 * hints that the ref changed, then monotonically increasing.
 *
 * Deliberately a number and not a callback: the CLIENT never issues a read,
 * because a capability read can cost the person an approval card, and whether
 * to spend one belongs to the module holding the refusal state. A module
 * effect-depends on the token and decides — including deciding NOT to act,
 * which is ADR 0006's cooldown rule after a refusal. `null` ref reads as 0.
 */
export function useWake(ref: string | null): number {
  const { wakes } = useAgentViewSnapshot();
  return ref === null ? 0 : wakes[ref] ?? 0;
}

export interface ProposalLedger {
  /** Oldest first: in-flight proposals plus retained refusals. */
  proposals: readonly PendingProposal[];
  /** Drop one refused entry after showing it. In-flight entries stay. */
  dismiss(rid: string): void;
}

/**
 * The action-lifecycle ledger (design:
 * `doc/development/frontend-interaction-stability-design.md` §2 原则 2).
 *
 * Every proposal appears here the moment it is sent, so a component can paint
 * a pending overlay in the same frame as the click; a refusal stays (bounded)
 * with the Host's sentence until the component dismisses it. The projection
 * remains authoritative and is never merged locally — the ledger is a render
 * INPUT layered on top, not a second source of truth.
 */
export function useProposals(): ProposalLedger {
  const { client } = useAgentView();
  const { proposals } = useAgentViewSnapshot();
  const dismiss = useCallback((rid: string) => client.dismissProposal(rid), [client]);
  return useMemo(() => ({ proposals, dismiss }), [proposals, dismiss]);
}

export interface Refusal {
  text: string;
  clear(): void;
}

/** The last bounded refusal text, for showing a person. "" when there is none. */
export function useRefusal(): Refusal {
  const { notice, clearNotice } = useAgentView();
  return useMemo(() => ({ text: notice, clear: clearNotice }), [notice, clearNotice]);
}
