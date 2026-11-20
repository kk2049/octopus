/**
 * Public surface of the capability kernel.
 *
 * ── What to read, in order, if you are auditing this ────────────────────────
 *
 *   core.ts      the trusted computing base: the Context tree, the slot table,
 *                capabilities, and `authorize`. If this file is right, one
 *                account cannot reach another's resource.
 *   gate.ts      the one door: authorize → validate → hash → policy → adapter.
 *                Deny and approval never reach the adapter.
 *   objects.ts   what a resource is and what may be asked of it.
 *   approval.ts  "this needs a human", with exactly-once semantics. A bug here
 *                costs consent or idempotence, never isolation — approving
 *                re-runs the original call through the whole gate again.
 *   service.ts   the wiring, plus Context lifecycle bookkeeping.
 *
 * Deliberately absent from this surface: `mintApprovalEvidence` (only the
 * approval desk may forge approval proof), `CapabilityGraph` and `Gate` (the
 * control plane drives them through `CapabilityService`, so there is one way to
 * reach them), and any raw store handle. App/controller/agent code never imports
 * this package at all — it receives a `BoundCapabilities` object over a channel.
 */

export { CapabilityService } from "./service.js";
export type { PendingResultView, PendingState, PendingView, ServiceOptions } from "./service.js";
export { validateArgs } from "./objects.js";
/**
 * The Gate's own per-call argument bound, as a predicate a caller can ask
 * BEFORE it builds a proposal.
 *
 * Exported so an adapter carrying a large argument (a file body, say) can refuse
 * in its own vocabulary instead of letting the Gate deny with "arguments too
 * large" — the same number either way, because it is the same function. A second
 * copy of the constant on the calling side is exactly the drift this avoids.
 */
export { argsTooLarge } from "./objects.js";
export { SqliteCapabilityStore, StoreOwnershipError } from "./sqlite-store.js";
export type { SqliteStoreOptions } from "./sqlite-store.js";
export type {
  AuditRow,
  CapabilityRow,
  CapabilityStore,
  ContextRow,
  ObjectIdentityRow,
  PendingOutcome,
  PendingRow,
  RootRef,
  SlotRow,
} from "./store.js";
export { canonicalJson, hashArgs } from "./canonical.js";
export { ApprovalEvidence, EFFECTS, IndeterminateOutcome, DependencyUnavailable } from "./types.js";
export type {
  ArgSpec,
  AuditEvent,
  AuditRecord,
  AuditSink,
  BoundCapabilities,
  CapabilityId,
  ContextId,
  ContextView,
  Effect,
  GrantTerms,
  InvokeResult,
  ObjectAdapter,
  ObjectDefinition,
  ObjectId,
  ObjectPolicy,
  ObjectView,
  Operation,
  OperationSpec,
  PolicyDecision,
  PolicyInput,
  Slot,
  TrustedSummary,
} from "./types.js";
