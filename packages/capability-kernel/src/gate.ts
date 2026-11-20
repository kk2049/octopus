/**
 * The one door. Every real resource call in the system passes through here.
 *
 * It is a composition and nothing else — five steps, in this order, each of
 * which can only narrow the previous one:
 *
 *   1. `graph.authorize`   does this Context hold this operation?   (core.ts)
 *   2. `validateArgs`      are the arguments inside the schema?     (objects.ts)
 *   3. `hashArgs`          freeze exactly what was checked          (canonical.ts)
 *   4. the Object's policy allow / deny / ask a human               (the Object)
 *   5. `registry.dispatch` the adapter, holding the fixed binding   (objects.ts)
 *
 * Deny and approval_required never reach step 5. That is the property the whole
 * design rests on, and keeping this file short is how it stays checkable.
 */

import { hashArgs } from "./canonical.js";
import type { CapabilityGraph } from "./core.js";
import { ObjectRegistry, argsTooLarge, validateArgs } from "./objects.js";
import {
  ApprovalEvidence,
  IndeterminateOutcome,
  DependencyUnavailable,
  type AuditRecord,
  type CapabilityId,
  type ContextId,
  type ContextView,
  type ObjectId,
  type Operation,
  type PolicyDecision,
  type Slot,
  type TrustedSummary,
} from "./types.js";

/**
 * What the gate reports. `approval_required` carries the policy's
 * server-authored summary; the gate itself holds no interaction state.
 */
export type GateOutcome =
  | { status: "succeeded"; result: unknown; capabilityId: CapabilityId; objectId: ObjectId; argsHash: string }
  | { status: "denied"; reason: string; argsHash: string }
  | { status: "failed"; reason: string; dependency?: { resource: string; detail: string }; capabilityId: CapabilityId; objectId: ObjectId; argsHash: string }
  | { status: "unknown"; reason: string; capabilityId: CapabilityId; objectId: ObjectId; argsHash: string }
  | {
      status: "approval_required";
      summary: TrustedSummary;
      capabilityId: CapabilityId;
      objectId: ObjectId;
      argsHash: string;
      canonicalArgs: Record<string, unknown>;
    };

export class Gate {
  constructor(
    private graph: CapabilityGraph,
    private registry: ObjectRegistry,
    private emit: (record: AuditRecord) => void,
    private nowMs: () => number = Date.now,
  ) {}

  /**
   * `approval` is non-null ONLY on the approval desk's internal resume path;
   * the bound facade has no way to supply it.
   */
  async invoke(
    contextId: ContextId,
    slot: Slot,
    operation: Operation,
    rawArgs: unknown,
    approval: ApprovalEvidence | null = null,
  ): Promise<GateOutcome> {
    const started = this.nowMs();
    // The brand is a runtime gate, not a type annotation. Anything that is not
    // a real ApprovalEvidence throws BEFORE any lookup, so a structural
    // look-alike cannot even reach the policy to be compared field by field.
    if (approval !== null && !(approval instanceof ApprovalEvidence)) {
      // @architecture flow=capability-invocation step=forged-approval after=bound-request role=refusal label="Reject forged approval evidence" condition="approval is non-null but not the opaque server-minted brand" outcome=failure authority=none terminal=true
      throw new TypeError("invoke received a forged approval evidence object");
    }

    const ctx = this.graph.contextOf(contextId);
    // @architecture flow=capability-invocation step=deny after=authorize,validate-args,freeze-args,mandatory-policy role=refusal label="Audit and return a closed denial" condition="any authority, schema, integrity, registry, or policy check refuses" outcome=deny authority=none terminal=true
    const deny = (reason: string, argsHash = ""): GateOutcome => {
      this.emit({
        event: "denied",
        at: new Date(this.nowMs()).toISOString(),
        contextId,
        contextKind: ctx?.kind ?? "(unknown)",
        contextMetadata: ctx?.metadata ?? {},
        ancestry: ctx ? this.graph.ancestry(contextId) : [],
        slot,
        capabilityId: null,
        objectId: null,
        operation,
        argsHash,
        decision: "deny",
        reason,
      });
      return { status: "denied", reason, argsHash };
    };

    // 1. Authority. The Object comes from the capability, never the caller.
    // @architecture flow=capability-invocation step=authorize after=bound-request role=gate label="Authorize bound Context and slot" condition="bound request enters the only Gate" outcome=object-binding authority="capability graph ancestry and slot" enforces=AUTH-001,AUTH-002,AUTH-003
    const auth = this.graph.authorize(contextId, slot, operation);
    if (!auth.ok) return deny(auth.reason);

    // 2. The operation exists in the closed registry and the args fit it.
    // @architecture flow=capability-invocation step=validate-args after=authorize role=validation label="Validate operation and closed argument schema" condition="authority check succeeds" outcome=canonical-arguments authority="closed Object registry specification" enforces=AUTH-002
    const spec = this.registry.specOf(auth.objectId, operation);
    if (!spec) return deny(`operation "${operation}" is not in the object registry`);
    const parsed = validateArgs(spec, rawArgs);
    if (!parsed.ok) return deny(parsed.message);

    // 3. Freeze exactly what was checked.
    // @architecture flow=capability-invocation step=freeze-args after=validate-args role=integrity label="Hash the canonical arguments" condition="argument schema accepts" outcome=frozen-arguments authority="canonical argument hash" enforces=AUTH-002
    let argsHash: string;
    try {
      argsHash = hashArgs(parsed.value);
    } catch (err) {
      return deny(String((err as Error)?.message ?? err));
    }
    if (argsTooLarge(parsed.value)) return deny("arguments too large", argsHash);

    const objectView = this.registry.viewOf(auth.objectId);
    const policy = this.registry.policyOf(auth.objectId);
    if (!objectView || !policy) return deny("object no longer registered", argsHash);
    const view: ContextView = {
      id: contextId,
      kind: ctx!.kind,
      metadata: ctx!.metadata,
      ancestry: this.graph.ancestry(contextId),
    };

    // 4. Mandatory policy. Deny and approval never reach the resource.
    // @architecture flow=capability-invocation step=mandatory-policy after=freeze-args role=gate label="Mandatory Object policy" condition="arguments and Object registration remain valid" outcome=policy-decision authority="Object-owned mandatory policy" enforces=AUTH-002
    let decision: PolicyDecision;
    try {
      decision = policy({
        object: objectView,
        context: view,
        operation,
        spec,
        effect: spec.effect,
        args: parsed.value,
        argsHash,
        slot,
        terms: auth.terms,
        approval,
      });
    } catch (err) {
      // A policy that throws is a policy that did not say allow.
      return deny(`policy error: ${String((err as Error)?.message ?? err)}`, argsHash);
    }

    if (decision.kind === "deny") return deny(decision.reason, argsHash);

    const base = {
      at: new Date(this.nowMs()).toISOString(),
      contextId,
      contextKind: ctx!.kind,
      contextMetadata: ctx!.metadata,
      ancestry: view.ancestry,
      slot,
      capabilityId: auth.capabilityId,
      objectId: auth.objectId,
      operation,
      argsHash,
    } as const;

    // @architecture flow=capability-invocation step=approval-required after=mandatory-policy role=approval label="Return a server-authored approval request" condition="policy returns approval_required" outcome=approval-required authority="server-authored frozen call coordinates" terminal=true enforces=AUTH-002
    if (decision.kind === "approval_required") {
      this.emit({ ...base, event: "invoked", decision: "approval_required" });
      return {
        status: "approval_required",
        summary: decision.summary,
        capabilityId: auth.capabilityId,
        objectId: auth.objectId,
        argsHash,
        canonicalArgs: parsed.value,
      };
    }

    // 5. Only now does the single trusted adapter see the fixed binding.
    this.emit({
      ...base,
      event: "invoked",
      decision: "allow",
      approver: approval?.approver,
      pendingCallId: approval?.pendingCallId,
    });
    // @architecture flow=capability-invocation step=adapter after=mandatory-policy role=effect label="Dispatch the fixed Object adapter" condition="policy returns allow" outcome=effect-dispatched authority="authorized Object binding and narrowed terms" enforces=AUTH-002
    try {
      const result = await this.registry.dispatch(auth.objectId, operation, parsed.value);
      // @architecture flow=capability-invocation step=audit-result after=adapter role=audit label="Record the successful resource outcome" condition="adapter resolves" outcome=success authority="fixed Object adapter" terminal=true
      this.emit({
        ...base,
        event: "executed",
        decision: "allow",
        outcome: "succeeded",
        durationMs: this.nowMs() - started,
      });
      return { status: "succeeded", result, capabilityId: auth.capabilityId, objectId: auth.objectId, argsHash };
    } catch (err) {
      const reason = String((err as Error)?.message ?? err);
      // Only the adapter can say the outcome is indeterminate, and it says so
      // by throwing a typed error. Nothing here parses a message.
      const outcome: "failed" | "unknown" = err instanceof IndeterminateOutcome ? "unknown" : "failed";
      // @architecture flow=capability-invocation step=audit-failure after=adapter role=audit label="Record failed or indeterminate execution" condition="adapter throws" outcome=failure-or-unknown authority="fixed Object adapter" terminal=true
      this.emit({
        ...base,
        event: "executed",
        decision: "allow",
        outcome,
        reason,
        durationMs: this.nowMs() - started,
      });
      return { status: outcome, reason, capabilityId: auth.capabilityId, objectId: auth.objectId, argsHash,
        ...(err instanceof DependencyUnavailable ? { dependency: { ...err.dependency } } : {}) };
    }
  }
}
