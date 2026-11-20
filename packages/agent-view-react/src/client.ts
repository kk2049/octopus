/** Shared App runtime types. Transport construction belongs to the shell. */
import type { AgentViewPerformanceWindow, AppearanceSpec } from "@claude-bot/web-trust/frame-protocol";

/** Anything the Host chose to declassify to this package. */
export type Projection = Record<string, unknown>;

/** One operation record as the trusted coordinator writes it. */
export interface AgentViewOperation {
  id?: string;
  status?: string;
  message?: string;
  detail?: string;
  operation?: string;
  resourceId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

/** The Host's answer to one proposal. Note what is absent: any identity. */
export interface ProposalReply {
  ok: boolean;
  code?: string;
  result?: unknown;
  /** Bounded refusal text the Host wrote, or "" when it accepted. */
  message: string;
}

/**
 * One proposal's lifecycle as the View can see it.
 *
 * `inflight` means the Host has not answered yet; `refused` keeps the bounded
 * answer around so a component can show WHY an action bounced (and animate a
 * revert) instead of silently snapping back. Accepted proposals leave the
 * ledger the moment the result frame arrives — by then the authoritative
 * projection carrying their effect has already been applied (`MSG.view` is
 * sent before `MSG.result` on the same port), so there is no flicker window.
 */
export type ProposalPhase = "inflight" | "refused";

export interface PendingProposal {
  rid: string;
  action: string;
  params: Readonly<Record<string, string>>;
  phase: ProposalPhase;
  /** Present when phase === "refused". */
  code?: string;
  /** Bounded refusal text when refused; "" while in flight. */
  message: string;
}

/**
 * What the View knows about its own channel.
 *
 * `waiting` is the only state in which nothing has been received; after `open`
 * the Host may still tear the channel down, which surfaces as `closed`. There is
 * deliberately no `error`: a channel that stops answering is a fact about the
 * transport, not an exception for App code to catch.
 */
export type TransportPhase = "waiting" | "open" | "closed";

export interface AgentViewSnapshot {
  phase: TransportPhase;
  /** The last projection the Host sent, or `null` before boot. */
  projection: Projection | null;
  /** Local monotonic time when the accepted projection entered this View. */
  projectionReceivedAt?: number;
  /** Newest first, capped; the Host is the author of every field. */
  operations: AgentViewOperation[];
  /** Proposals sent and not yet answered. */
  inFlight: number;
  /**
   * The action-lifecycle ledger, oldest first: every proposal this View sent
   * that is still in flight, plus refused ones retained (bounded) until
   * `dismissProposal`. This is what lets a module paint a pending overlay the
   * moment the user acts and explain a refusal when the Host says no — the
   * projection itself stays authoritative and is never merged locally.
   */
  proposals: readonly PendingProposal[];
  /**
   * A monotonic wake token per resource ref (ADR 0006).
   *
   * The Host may forward a content-free "this ref changed" hint. The client
   * records ONLY a counter — it never issues a read of its own, because a
   * read on this platform can cost the person an approval card and whether
   * to spend one is the MODULE's decision, made with the refusal state only
   * it holds. Refs the View was never handed simply never appear here, and
   * the map is bounded so a hostile Host cannot grow it without limit.
   */
  wakes: Readonly<Record<string, number>>;
  /**
   * The outer shell's appearance choice, defended and defaulted (ticket #45).
   *
   * Starts at `classic` before any boot. Any live update the defensive
   * reader cannot classify folds to `classic` too (the "reachable pre-theme
   * render" contract) — the snapshot NEVER carries an unrepresentable value,
   * and it does not persist a "last known good" theme across a bad update.
   * That choice keeps failure recovery simple: a subsequent well-formed
   * frame moves to whatever it names, without a hidden retained state.
   *
   * The transport publishes a new snapshot identity every time appearance
   * changes, so a `useSyncExternalStore` subscriber re-renders in the
   * ordinary way; nothing here writes to the DOM (see `provider.tsx` for
   * that effect).
   */
  appearance: AppearanceSpec;
  /** Browser-only best-effort checkpoint returned by the trusted shell on boot. */
  recovery: string | null;
}


export interface AgentViewClient {
  /** Current transport + data snapshot. Cheap; safe to call in a render. */
  snapshot(): AgentViewSnapshot;
  /** Subscribe to snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: (snapshot: AgentViewSnapshot) => void): () => void;
  /**
   * Ask the Host to do something.
   *
   * Resolves with the Host's bounded answer; it never rejects, because "the
   * trusted side said no" is an answer and not an exception. A proposal sent
   * before the channel opens, or after it closes, resolves as a refusal rather
   * than hanging forever.
   */
  propose(action: string, params?: Record<string, string>): Promise<ProposalReply>;
  /**
   * Volunteer one closed, content-free performance window to the trusted Host.
   * No channel or malformed numbers are a quiet false; diagnostics never throw.
   */
  reportPerformance(report: AgentViewPerformanceWindow): boolean;
  /**
   * Drop one REFUSED entry from the proposal ledger (e.g. after the revert
   * animation played, or the person closed the notice). In-flight entries
   * cannot be dismissed — their answer is still owed.
   */
  dismissProposal(rid: string): void;
  /**
   * Lossy text drafts stored by the trusted parent in this browser only.
   * Keys are semantic but identity-free; the parent supplies viewer/release
   * scoping and never sends that namespace back into the opaque View.
   */
  drafts: AgentViewDraftStore;
  /**
   * Publish one bounded browser-recovery checkpoint. This is display state,
   * not a proposal: the Host may retain or ignore it, but never dispatches it.
   */
  publishRecovery(checkpoint: string): boolean;
  /** Stop listening and drop the port. Idempotent. */
  destroy(): void;
}

export interface AgentViewDraftSnapshot {
  readonly text: string;
  readonly updatedAt: number;
}

export interface AgentViewDraftStore {
  get(key: string): AgentViewDraftSnapshot;
  set(key: string, text: string): void;
  subscribe(key: string, listener: (snapshot: AgentViewDraftSnapshot) => void): () => void;
}
