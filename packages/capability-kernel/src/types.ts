/**
 * The closed vocabulary. Scenario- and policy-independent: this package knows
 * about Contexts, Context-local slots, fixed Objects, operation rights and one
 * ancestry chain. It does NOT know about users, apps, agents, Runners, HTTP or
 * MCP — those live in the control plane that drives it.
 *
 * The single rule that shapes these types: an untrusted caller may name a
 * slot, an operation and business args. It may never name a Context, a
 * capability, an Object, a principal or an approval.
 */

/** Opaque server-side ids. Never accepted from a business request. */
export type ContextId = string;
export type CapabilityId = string;
export type ObjectId = string;
/** Context-local name for one capability. Meaningless outside its Context. */
export type Slot = string;
export type Operation = string;

// ── argument schema (closed; unknown key / wrong type / missing = deny) ──

export type ArgSpec =
  | { type: "string"; required?: boolean; maxLength?: number; enum?: readonly string[] }
  | { type: "number"; required?: boolean; min?: number; max?: number; integer?: boolean }
  | { type: "boolean"; required?: boolean };

/**
 * How much of the resource an operation touches. Declared ONCE per operation,
 * in the Object's registry, rather than re-derived by every policy from the
 * method name.
 *
 * Deliberately four coarse classes and deliberately scenario-neutral — this
 * package must not learn what a "session" or a "device" is. The distinction
 * between two operations of the same class (read my transcripts vs. read any
 * path I name) is made where it belongs: they are two operations, and a grant
 * can hold one without the other.
 */
export type Effect =
  /** Presence, identity, capability listings — no resource content. */
  | "observe"
  /** Returns content out of the resource. */
  | "read"
  /** Changes the resource. */
  | "modify"
  /** Runs caller-supplied code on the resource. */
  | "execute";

export const EFFECTS: readonly Effect[] = ["observe", "read", "modify", "execute"];

export interface OperationSpec {
  args: Record<string, ArgSpec>;
  /**
   * What this operation does to the resource. The kernel decides nothing from
   * it; it sets the DEFAULT terms of a root capability, it is handed to the
   * policy, and it is what an auditor reads to answer "what can this grant do".
   */
  effect: Effect;
  /**
   * Whether running this a SECOND time leaves the resource where running it once
   * would. A property of the operation, declared here once, exactly like
   * `effect` — and deliberately not inferred at the moment it matters.
   *
   * It answers a different question from every other flag in this package.
   * `effect` says how much of the resource is touched; `GrantTerms.autoAllow`
   * says whether a human decides each call. Retry-safety says whether the
   * SYSTEM may put an interrupted call back in front of that human instead of
   * writing it off. `read_file` is the case that proves the three are
   * independent: a chat agent's grant makes it approval-required (a
   * prompt-injected model can name `~/.ssh/id_ed25519`), and yet reading a file
   * twice is the same as reading it once.
   *
   * Defaults from `effect`: `observe`/`read` are retry-safe, `modify`/`execute`
   * are not — so a newly registered dangerous operation is un-retryable from the
   * moment it exists. Declare it explicitly only to contradict that, which means
   * you know something the effect class does not say.
   */
  retrySafe?: boolean;
  /** Human-readable, server-authored. Used in trusted approval summaries. */
  title?: string;
}

/**
 * The conditions attached to one capability — the part of an authority that is
 * not "which operations" but "on what terms".
 *
 * There is exactly one term today and that is the point: it is the answer to
 * "may this grant do that by itself, or does a human decide each time?", and
 * it belongs on the CAPABILITY rather than in a Context metadata string,
 * because it has to attenuate the same way rights do. A derived grant can only
 * narrow it, so no descendant can talk itself into acting unsupervised.
 */
export interface GrantTerms {
  /**
   * Operations this capability may exercise without a per-call human decision.
   * Always a subset of the capability's own rights AND of its parent's
   * `autoAllow` — the kernel enforces both at derive time.
   */
  autoAllow: readonly Operation[];
}

// ── policy ──

/** What a policy may look at about the calling Context. Trusted metadata only. */
export interface ContextView {
  readonly id: ContextId;
  /** Server-written lifecycle label, e.g. "app-instance" / "agent-run". */
  readonly kind: string;
  /**
   * Server-written, non-authoritative descriptors for audit and typed policy
   * (owner, app, controller, run, code digest). A policy MAY read them, but
   * the kernel never derives authority from them.
   */
  readonly metadata: Readonly<Record<string, string>>;
  /** Ancestry, root first: every Context this one was derived through. */
  readonly ancestry: readonly ContextId[];
}

export interface ObjectView {
  readonly id: ObjectId;
  readonly kind: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Proof that a specific PendingCall was approved by an entitled principal.
 *
 * Deliberately a class instance with a runtime-private brand and a minting
 * token that never leaves this package: it cannot be produced by JSON, an HTTP
 * body, an MCP argument or app code, and a structurally-typed look-alike fails
 * `instanceof`. Only the approval desk constructs one, and a policy compares
 * its fields against the call it is being asked to allow.
 */
const APPROVAL_MINT = Symbol("capability.approval.mint");

export class ApprovalEvidence {
  /** Runtime-private: an object literal can never satisfy this class. */
  readonly #minted = true;

  constructor(
    mint: symbol,
    readonly pendingCallId: string,
    readonly contextId: ContextId,
    readonly slot: Slot,
    readonly objectId: ObjectId,
    readonly operation: Operation,
    readonly argsHash: string,
    readonly approver: string,
  ) {
    if (mint !== APPROVAL_MINT) throw new Error("ApprovalEvidence is mintable only inside the capability service");
    void this.#minted;
  }
}

/**
 * Internal minting door. Exported from this module for the approval desk, but
 * NOT re-exported from the package index — nothing outside can make evidence.
 */
export function mintApprovalEvidence(
  pendingCallId: string,
  contextId: ContextId,
  slot: Slot,
  objectId: ObjectId,
  operation: Operation,
  argsHash: string,
  approver: string,
): ApprovalEvidence {
  return new ApprovalEvidence(APPROVAL_MINT, pendingCallId, contextId, slot, objectId, operation, argsHash, approver);
}

export interface PolicyInput {
  readonly object: ObjectView;
  readonly context: ContextView;
  readonly operation: Operation;
  readonly spec: OperationSpec;
  /** Shorthand for `spec.effect` — what this call does to the resource. */
  readonly effect: Effect;
  /** Already validated against the closed schema. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly argsHash: string;
  readonly slot: Slot;
  /**
   * The terms of the capability that authorised this call, resolved by the
   * kernel from the capability chain. Not caller-supplied, and already
   * attenuated by every derive between the root and here.
   */
  readonly terms: GrantTerms;
  /** Non-null only on the internal resume path. */
  readonly approval: ApprovalEvidence | null;
}

/** Server-authored description of a call, shown on the trusted approval face. */
export interface TrustedSummary {
  /** One line: what will happen, in the operator's language. */
  title: string;
  /** Concrete target ("alice/laptop"), never taken from caller-stated ids. */
  target: string;
  /** Short, typed, redaction-aware detail lines. */
  details: string[];
  /** Who may approve. Resolved by the policy from trusted facts. */
  allowedApprover: string;
  /** Milliseconds the pending call stays approvable. */
  ttlMs?: number;
}

export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "approval_required"; summary: TrustedSummary };

export type ObjectPolicy = (input: PolicyInput) => PolicyDecision;

/**
 * The ONLY code allowed to touch the real resource. It receives the Object's
 * own fixed binding, never a caller-stated address.
 */
export type ObjectAdapter<B = unknown> = (
  binding: B,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

/**
 * The adapter's way of saying "this left the process and I cannot tell you
 * whether it happened".
 *
 * A typed signal, not a message an outer layer greps for: matching
 * /timeout|断开|.../ against `err.message` both misses a real indeterminate
 * failure phrased differently AND classifies a deterministic config error
 * containing the word "timeout" as unknown. Only the code that actually made
 * the call knows, so only it may say so.
 */
export class IndeterminateOutcome extends Error {
  readonly indeterminate = true as const;
  constructor(reason: string) {
    super(reason);
    this.name = "IndeterminateOutcome";
  }
}

/** Trusted adapter evidence that a dependency was unavailable before an effect.
 * This describes a failure, not permission to retry; callers retain dispatch ownership.
 * Plain error text or properties received from an external resource are not evidence.
 */
export class DependencyUnavailable extends Error {
  readonly dependency: { resource: string; detail: string };
  constructor(resource: string, detail: string, reason = detail) {
    super(reason);
    this.name = "DependencyUnavailable";
    this.dependency = { resource, detail };
  }
}

export interface ObjectDefinition<B = unknown> {
  /** Stable id chosen by the trusted control plane (e.g. "runner-account:7"). */
  id: ObjectId;
  kind: string;
  /** The fixed target. Resolved once, at registration, from trusted facts. */
  binding: B;
  metadata?: Record<string, string>;
  operations: Record<Operation, OperationSpec>;
  policy: ObjectPolicy;
  adapter: ObjectAdapter<B>;
}

// ── results ──

export type InvokeResult =
  | { status: "succeeded"; result: unknown }
  | { status: "approval_required"; pendingCallId: string }
  | { status: "denied"; reason: string }
  | { status: "failed"; reason: string; dependency?: { resource: string; detail: string } }
  /** External call left the process and the outcome could not be determined. */
  | { status: "unknown"; reason: string };

/** What a caller may learn about a dangerous call of its own. */
export interface PendingOutcomeView {
  state: "pending" | "claimed" | "rejected" | "expired" | "finished";
  outcome: "succeeded" | "failed" | "unknown" | null;
  result: unknown;
  reason: string | null;
  /**
   * Whether re-issuing this exact call is safe. It exists because `unknown`
   * means two different things to a caller — "we cannot tell, and asking again
   * would be a second side effect" versus "we cannot tell, but asking again
   * costs nothing" — and a caller that cannot distinguish them has to assume the
   * first. The declaration is the Object's, recorded when the call was made.
   */
  retrySafe: boolean;
}

/**
 * The whole API an untrusted runtime gets. No principal, no Context, no
 * Object, no approval: those come from the channel this facade was bound to.
 *
 * `result` exists so that "my call needed approval" has a safe ending. Without
 * it the only way to find out what happened is to make the call again, and a
 * second identical call after the first one RAN is a second side effect — the
 * recovery instruction would be the bug. It takes only an id: the Context
 * still comes from the binding, so an id learned from somewhere else reads
 * nothing.
 */
export interface BoundCapabilities {
  request(slot: Slot, operation: Operation, args: unknown): Promise<InvokeResult>;
  result(pendingCallId: string): PendingOutcomeView | null;
}

// ── audit ──

/** What happened, as a closed vocabulary rather than an inferred shape. */
export type AuditEvent =
  | "invoked"
  | "denied"
  | "pending_created"
  | "approved"
  | "rejected"
  | "expired"
  | "claimed"
  /**
   * A claim that did not survive the process, put back in front of the human
   * because the operation declared itself retry-safe. Its own word rather than a
   * second `pending_created`: the card was never created twice, and an auditor
   * reading the trail has to be able to see that an approval was consumed and
   * then handed back.
   */
  | "requeued"
  | "executed";

export interface AuditRecord {
  event: AuditEvent;
  at: string;
  contextId: ContextId;
  contextKind: string;
  contextMetadata: Readonly<Record<string, string>>;
  ancestry: readonly ContextId[];
  slot: Slot;
  capabilityId: CapabilityId | null;
  objectId: ObjectId | null;
  operation: Operation;
  argsHash: string;
  decision: "allow" | "deny" | "approval_required";
  reason?: string;
  approver?: string;
  pendingCallId?: string;
  outcome?: "succeeded" | "failed" | "unknown";
  durationMs?: number;
}

export type AuditSink = (record: AuditRecord) => void;
