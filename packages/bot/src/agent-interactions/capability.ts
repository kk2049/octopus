/** Capability plane for answering one provider-originated interaction. */

import { SESSION_CLI_KINDS } from "@claude-bot/agent-sessions-contract";
import {
  CapabilityService,
  type ContextId,
  type ObjectDefinition,
  type Operation,
  type OperationSpec,
  type PolicyDecision,
  type PolicyInput,
} from "@claude-bot/capability-kernel";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import { dispatchToRunner, type RunnerDispatchBinding } from "../runner/dispatch.js";
import type { RunnerCapabilities } from "../runner/capability.js";
import type { RunnerTransport } from "../runner/gateway.js";

export const AGENT_INTERACTIONS_SLOT = "agent-interactions";
export const AGENT_INTERACTIONS_OBJECT_PREFIX = "agent-interactions-runner-v1";
export const RESPOND_AGENT_INTERACTION = "respond_agent_interaction";

const DEVICE = { type: "string", required: true, maxLength: MACHINE_LIMITS.deviceMaxBytes } as const;

export const AGENT_INTERACTION_OPERATIONS: Record<Operation, OperationSpec> = {
  [RESPOND_AGENT_INTERACTION]: {
    args: {
      device: DEVICE,
      // Derived, never re-spelled: this schema rejecting a kind the runner
      // can raise an interaction for strands that session with no way to answer.
      provider: { type: "string", required: true, enum: [...SESSION_CLI_KINDS] },
      session_id: { type: "string", required: true, maxLength: MACHINE_LIMITS.sessionIdMaxBytes },
      interaction_id: { type: "string", required: true, maxLength: 128 },
      response_json: { type: "string", required: true, maxLength: 32 * 1024 },
    },
    effect: "execute",
    // A response token is single-use. Replaying it can only report "already
    // answered"; it cannot make the provider execute the decision twice.
    retrySafe: true,
    title: "回答 Agent 的当前请求",
  },
};

function interactionPolicy(input: PolicyInput): PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner) return { kind: "deny", reason: "agent-interactions object has no bound owner" };
  if (input.context.kind === 'session' && input.context.metadata.surface === 'research-v2'
    && input.context.metadata.humanResponse === 'true' && input.context.metadata.project
    && input.context.metadata.trigger && ['device', 'provider', 'session_id'].every(key => input.context.metadata[key] === input.args[key])) return {kind: 'allow'};
  // The provider prompt IS the approval surface. Requiring a second generic
  // PendingCall would turn one Allow click into two. This metadata is written
  // only by `openHumanResponse`, after HTTP authentication, live browser
  // session verification and CSRF checks; no business arg can name it.
  if (
    input.context.kind === "session"
    && input.context.metadata.surface === "session-hub"
    && input.context.metadata.humanResponse === "true"
  ) return { kind: "allow" };
  return { kind: "deny", reason: "agent interactions require a live owner browser session" };
}

async function interactionAdapter(
  binding: RunnerDispatchBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return await dispatchToRunner(binding, operation, args, { indeterminateOnLinkLoss: true });
}

export class AgentInteractionGrant extends SlotGrant {
  constructor(service: CapabilityService, contextId: ContextId, purpose: string, owner: string) {
    super(service, contextId, AGENT_INTERACTIONS_SLOT, purpose, owner, false);
  }
}

export interface AgentInteractionCapabilitiesOptions {
  service: CapabilityService;
  transport: RunnerTransport;
  userExists: (username: string) => boolean;
  hasDevice: (username: string) => boolean;
}

export class AgentInteractionCapabilities {
  private authority: AccountAuthority<RunnerDispatchBinding>;

  constructor(private options: AgentInteractionCapabilitiesOptions) {
    this.authority = new AccountAuthority<RunnerDispatchBinding>({
      service: options.service,
      slot: AGENT_INTERACTIONS_SLOT,
      objectPrefix: AGENT_INTERACTIONS_OBJECT_PREFIX,
      kind: "agent-interactions-runner",
      operations: AGENT_INTERACTION_OPERATIONS,
      policy: interactionPolicy,
      adapter: interactionAdapter as ObjectDefinition<RunnerDispatchBinding>["adapter"],
      bindingFor: (owner) => options.userExists(owner) && options.hasDevice(owner)
        ? { owner, transport: options.transport }
        : null,
    });
  }

  openHumanResponse(owner: string, purpose: string): AgentInteractionGrant | null {
    const derived = this.authority.derive({
      username: owner,
      purpose,
      kind: "session",
      rights: [RESPOND_AGENT_INTERACTION],
      autoAllow: [],
      metadata: { surface: "session-hub", humanResponse: "true" },
    });
    return derived
      ? new AgentInteractionGrant(this.options.service, derived.contextId, purpose, owner)
      : null;
  }

  /** Trusted project adapter has checked the live human, role and exact binding. */
  openProjectHumanResponse(owner: string, trigger: string, project: string, device: string, provider: string, sessionId: string): AgentInteractionGrant | null {
    const purpose = `research-v2/${project} response by ${trigger}`;
    const derived = this.authority.derive({username: owner, purpose, kind: 'session', rights: [RESPOND_AGENT_INTERACTION], autoAllow: [],
      metadata: {surface: 'research-v2', humanResponse: 'true', project, trigger, device, provider, session_id: sessionId}});
    return derived ? new AgentInteractionGrant(this.options.service, derived.contextId, purpose, owner) : null;
  }

  revokeAccount(owner: string): void {
    this.authority.revokeAccount(owner);
  }

  attachToRunnerLifecycle(runner: Pick<RunnerCapabilities, "onTargetSetChanged">): () => void {
    return runner.onTargetSetChanged((event) => this.revokeAccount(event.username));
  }
}
