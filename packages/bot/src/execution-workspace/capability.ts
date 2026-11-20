/**
 * Launch-scoped command execution on one registered workspace.
 *
 * This is deliberately not another operation on runner-account/v3. Its root,
 * grants and revocation line are independent because an approved agent launch
 * creates a different authority than the dashboard's general machine controls.
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

export const EXECUTION_WORKSPACE_SLOT = "execution-workspace";
// v2 removes the command text cap without retargeting existing v1 grants.
export const EXECUTION_WORKSPACE_OBJECT_PREFIX = "execution-workspace-runner-v2";
export const RUN_WORKSPACE_COMMAND = "run_workspace_command" as const;

const DEVICE_ARG = { type: "string", required: true, maxLength: MACHINE_LIMITS.deviceMaxBytes } as const;

export const EXECUTION_WORKSPACE_OPERATIONS: Record<string, OperationSpec> = {
  [RUN_WORKSPACE_COMMAND]: {
    args: {
      device: DEVICE_ARG,
      workspace_id: { type: "string", required: true, maxLength: MACHINE_LIMITS.workspaceIdMaxBytes },
      command: { type: "string", required: true },
      timeout_ms: {
        type: "number",
        min: 1_000,
        max: MACHINE_LIMITS.execTimeoutMaxMs,
        integer: true,
      },
    },
    effect: "execute",
    title: "在已登记工作区运行命令",
  },
};

function executionPolicy(input: PolicyInput): PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner) return { kind: "deny", reason: "execution-workspace object has no bound owner" };
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
      title: `远程 Agent 命令 · ${owner}/${device}`,
      target: `${owner}/${device}`,
      details: [
        `工作区：${String(input.args.workspace_id ?? "").slice(0, 64)}`,
        `命令：${String(input.args.command ?? "").slice(0, 500)}`,
      ],
      allowedApprover: owner,
    },
  };
}

async function executionAdapter(
  binding: RunnerDispatchBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (operation !== RUN_WORKSPACE_COMMAND) throw new Error("unknown execution workspace operation");
  return await dispatchToRunner(binding, "exec_workspace", args, { indeterminateOnLinkLoss: true });
}

export class ExecutionWorkspaceGrant extends SlotGrant {
  constructor(service: CapabilityService, contextId: ContextId, purpose: string, owner: string, borrowed = false) {
    super(service, contextId, EXECUTION_WORKSPACE_SLOT, purpose, owner, borrowed);
  }
}

export interface ExecutionWorkspaceCapabilitiesOptions {
  service: CapabilityService;
  transport: RunnerTransport;
  userExists(username: string): boolean;
  hasDevice(username: string): boolean;
  now?: () => number;
}

export class ExecutionWorkspaceCapabilities {
  private readonly authority: AccountAuthority<RunnerDispatchBinding>;

  constructor(private readonly options: ExecutionWorkspaceCapabilitiesOptions) {
    this.authority = new AccountAuthority<RunnerDispatchBinding>({
      service: options.service,
      slot: EXECUTION_WORKSPACE_SLOT,
      objectPrefix: EXECUTION_WORKSPACE_OBJECT_PREFIX,
      kind: "execution-workspace-runner",
      operations: EXECUTION_WORKSPACE_OPERATIONS,
      policy: executionPolicy,
      scopeAllows: (device, input) => input.args.device === device,
      adapter: executionAdapter as ObjectDefinition<RunnerDispatchBinding>["adapter"],
      now: options.now,
      rootAutoAllow: () => Object.keys(EXECUTION_WORKSPACE_OPERATIONS),
      bindingFor: (username) => options.userExists(username) && options.hasDevice(username)
        ? { owner: username, transport: options.transport }
        : null,
    });
  }

  open(input: {
    username: string;
    purpose: string;
    autoAllow?: readonly Operation[];
    metadata?: Record<string, string>;
    device?: string;
    pool?: string;
  }): ExecutionWorkspaceGrant | null {
    const username = String(input.username ?? "").trim();
    const derived = this.authority.derive({
      username,
      purpose: input.purpose,
      kind: "agent-run",
      rights: [RUN_WORKSPACE_COMMAND],
      autoAllow: input.autoAllow,
      metadata: input.metadata,
      scope: input.device,
      pool: input.pool,
    });
    return derived
      ? new ExecutionWorkspaceGrant(
          this.options.service,
          derived.contextId,
          input.purpose,
          username,
          derived.borrowed,
        )
      : null;
  }

  revokeAccount(username: string): void {
    this.authority.revokeAccount(username);
  }

  revokeDevice(username: string, device: string): void {
    this.authority.revokeScope(username, device);
  }
}
