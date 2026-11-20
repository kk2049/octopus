/**
 * Branching a session: where its last completed turn ends, and a new session
 * holding the conversation through such a turn.
 *
 * Deliberately not two more operations on runner-account: adding them there
 * would version that Object and retire every account's live capabilities and
 * undecided approval cards for a feature most of them never touch. A branch is
 * its own authority, with its own root, grants and revocation line, over the
 * same laptops through the same transport.
 */
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
import type { RunnerTransport } from "../runner/gateway.js";

export const SESSION_BRANCH_SLOT = "session-branch";
export const SESSION_BRANCH_OBJECT_PREFIX = "session-branch-runner-v1";
export const SESSION_ANCHOR = "session_anchor" as const;
export const FORK_SESSION = "fork_session" as const;

const DEVICE_ARG = { type: "string", required: true, maxLength: MACHINE_LIMITS.deviceMaxBytes } as const;
const SESSION_ARGS = {
  device: DEVICE_ARG,
  source: { type: "string", required: true, enum: ["claude", "codex"] },
  id: { type: "string", required: true, maxLength: MACHINE_LIMITS.sessionIdMaxBytes },
} as const;

export const SESSION_BRANCH_OPERATIONS: Record<string, OperationSpec> = {
  // Where the session's last completed turn ends: the point a snapshot keeps.
  [SESSION_ANCHOR]: { args: SESSION_ARGS, effect: "read", title: "读取会话的分叉位置" },
  // A new session holding the conversation through one completed turn; it runs nothing.
  [FORK_SESSION]: {
    args: {
      ...SESSION_ARGS,
      // Named by an earlier snapshot; absent means the session's last completed turn.
      anchor: { type: "string", maxLength: 80 },
      title: { type: "string", maxLength: 200 },
    },
    effect: "modify",
    title: "分叉会话",
  },
};

function branchPolicy(input: PolicyInput): PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner) return { kind: "deny", reason: "session-branch object has no bound owner" };
  const approval = input.approval;
  if (
    approval
    && approval.objectId === input.object.id
    && approval.operation === input.operation
    && approval.argsHash === input.argsHash
    && approval.contextId === input.context.id
    && approval.slot === input.slot
    && approval.approver === owner
  ) {
    return { kind: "allow" };
  }
  if (input.terms.autoAllow.includes(input.operation)) return { kind: "allow" };
  const device = String(input.args.device ?? "");
  return {
    kind: "approval_required",
    summary: {
      title: `${input.spec.title ?? input.operation} · ${owner}/${device}`,
      target: `${owner}/${device}`,
      details: [
        `会话：${String(input.args.source ?? "")} ${String(input.args.id ?? "").slice(0, 64)}`,
        ...(input.operation === FORK_SESSION ? ["结果：一个新会话，带着原会话到所选一轮为止的对话；原会话不变"] : []),
        `发起方：${input.context.metadata.purpose ?? input.context.kind}`,
      ],
      allowedApprover: owner,
    },
  };
}

async function branchAdapter(
  binding: RunnerDispatchBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (operation !== SESSION_ANCHOR && operation !== FORK_SESSION) throw new Error("unknown session branch operation");
  // A fork whose answer was lost may exist: that is an unknown outcome, never a failure to retry.
  return await dispatchToRunner(binding, operation, args, operation === FORK_SESSION ? { indeterminateOnLinkLoss: true } : undefined);
}

export class SessionBranchGrant extends SlotGrant {
  constructor(service: CapabilityService, contextId: ContextId, purpose: string, owner: string, borrowed = false) {
    super(service, contextId, SESSION_BRANCH_SLOT, purpose, owner, borrowed);
  }
}

export interface SessionBranchCapabilitiesOptions {
  service: CapabilityService;
  transport: RunnerTransport;
  userExists(username: string): boolean;
  hasDevice(username: string): boolean;
  now?: () => number;
}

export class SessionBranchCapabilities {
  private readonly authority: AccountAuthority<RunnerDispatchBinding>;

  constructor(private readonly options: SessionBranchCapabilitiesOptions) {
    this.authority = new AccountAuthority<RunnerDispatchBinding>({
      service: options.service,
      slot: SESSION_BRANCH_SLOT,
      objectPrefix: SESSION_BRANCH_OBJECT_PREFIX,
      kind: "session-branch-runner",
      operations: SESSION_BRANCH_OPERATIONS,
      policy: branchPolicy,
      scopeAllows: (device, input) => input.args.device === device,
      adapter: branchAdapter as ObjectDefinition<RunnerDispatchBinding>["adapter"],
      now: options.now,
      rootAutoAllow: () => Object.keys(SESSION_BRANCH_OPERATIONS),
      bindingFor: (username) => options.userExists(username) && options.hasDevice(username)
        ? { owner: username, transport: options.transport }
        : null,
    });
  }

  /** A Context over one account's session branches; null when the account, its device or the rights are gone. */
  open(input: {
    username: string;
    purpose: string;
    rights: readonly Operation[];
    autoAllow?: readonly Operation[];
    metadata?: Record<string, string>;
    device?: string;
  }): SessionBranchGrant | null {
    const username = String(input.username ?? "").trim();
    const derived = this.authority.derive({
      username,
      purpose: input.purpose,
      kind: "job",
      rights: input.rights,
      autoAllow: input.autoAllow,
      metadata: input.metadata,
      scope: input.device,
    });
    return derived ? new SessionBranchGrant(this.options.service, derived.contextId, input.purpose, username, derived.borrowed) : null;
  }

  revokeAccount(username: string): void {
    this.authority.revokeAccount(username);
  }

  revokeDevice(username: string, device: string): void {
    this.authority.revokeScope(username, device);
  }
}
