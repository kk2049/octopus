import type { CapabilityService, ContextId, ObjectDefinition, Operation, OperationSpec, PolicyInput, PolicyDecision } from "@claude-bot/capability-kernel";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import { dispatchToRunner, type RunnerDispatchBinding } from "../runner/dispatch.js";
import type { RunnerTransport } from "../runner/gateway.js";

const SLOT = "workspace-job-provider";
// Capability object operation tables are immutable across process lifetimes.
// v3 removes the command text cap; the Gate still bounds the whole argument object.
export const WORKSPACE_JOB_OBJECT_PREFIX = "workspace-job-provider-v3";
export const WORKSPACE_JOB_OPERATIONS: Record<Operation, OperationSpec> = {
  workspace_job_start: {
    args: { job_id: { type: "string", required: true, maxLength: 100 }, workspace_key: { type: "string", required: true, maxLength: 80 },
      repo_sha: { type: "string", required: true, maxLength: 40 }, command: { type: "string", required: true },
      timeout_ms: { type: "number", required: true, integer: true, min: 1000, max: 2700000 },
      input_url: { type: "string", maxLength: 2048 }, input_sha256: { type: "string", maxLength: 64 },
      files_json: { type: "string", maxLength: 16384 },
      input_bytes: { type: "number", integer: true, min: 1, max: 134217728 } },
    effect: "execute", retrySafe: true, title: "提交持久工作区任务",
  },
  workspace_job_status: { args: { job_id: { type: "string", required: true, maxLength: 100 } }, effect: "observe", title: "查询原工作区任务" },
  workspace_job_cancel: { args: { job_id: { type: "string", required: true, maxLength: 100 } }, effect: "modify", retrySafe: true, title: "取消原工作区任务" },
  workspace_job_read: { args: { job_id: { type: "string", required: true, maxLength: 100 },
    offset: { type: "number", required: true, integer: true, min: 0, max: Number.MAX_SAFE_INTEGER },
    length: { type: "number", required: true, integer: true, min: 1, max: 65536 } }, effect: "read", title: "读取原工作区任务日志" },
  workspace_job_artifact: { args: { job_id: { type: "string", required: true, maxLength: 100 },
    name: { type: "string", required: true, maxLength: 128 },
    offset: { type: "number", required: true, integer: true, min: 0, max: Number.MAX_SAFE_INTEGER },
    length: { type: "number", required: true, integer: true, min: 1, max: 1048576 } }, effect: "read", title: "读取原工作区任务产物" },
};
interface Binding extends RunnerDispatchBinding { device: string; workspaceId: string }
function policy(input: PolicyInput): PolicyDecision {
  return input.object.metadata.owner && input.terms.autoAllow.includes(input.operation)
    ? { kind: "allow" } : { kind: "deny", reason: "workspace jobs require an explicit trusted provider binding" };
}
export class WorkspaceJobGrant extends SlotGrant {
  constructor(service: CapabilityService, contextId: ContextId, owner: string, borrowed = false) {
    super(service, contextId, SLOT, "devpipe-workspace-job", owner, borrowed);
  }
}
export class WorkspaceJobCapabilities {
  private readonly authority: AccountAuthority<Binding>;
  constructor(private readonly opts: { service: CapabilityService; transport: RunnerTransport; owner: string; device: string; workspaceId: string;
    userExists: (owner: string) => boolean; hasDevice: (owner: string, device: string) => boolean }) {
    if (!opts.owner || !opts.device || !/^ws_[0-9a-f]{24}$/.test(opts.workspaceId)) throw new Error("workspace provider requires explicit owner/device/workspace identity");
    this.authority = new AccountAuthority<Binding>({ service: opts.service, slot: SLOT, objectPrefix: WORKSPACE_JOB_OBJECT_PREFIX,
      kind: "workspace-job-provider", operations: WORKSPACE_JOB_OPERATIONS, policy,
      rootAutoAllow: () => Object.keys(WORKSPACE_JOB_OPERATIONS),
      bindingFor: (owner) => owner === opts.owner && opts.userExists(owner) && opts.hasDevice(owner, opts.device)
        ? { owner, device: opts.device, workspaceId: opts.workspaceId, transport: opts.transport } : null,
      adapter: (async (binding: Binding, operation: string, args: Readonly<Record<string, unknown>>) => {
        const { input_url, input_sha256, input_bytes, files_json, ...rest } = args;
        return await dispatchToRunner(binding, operation, { ...rest, device: binding.device, workspace_id: binding.workspaceId,
          ...(input_url ? { input: { url: input_url, sha256: input_sha256, bytes: input_bytes } } : {}),
          ...(files_json ? { files: JSON.parse(String(files_json)) as unknown } : {}) },
        { indeterminateOnLinkLoss: operation === "workspace_job_start" || operation === "workspace_job_cancel" });
      }) as ObjectDefinition<Binding>["adapter"],
    });
  }
  resetAuthority(): void { this.authority.authorityFor(this.opts.owner); this.authority.revokeAccount(this.opts.owner); }
  open(): WorkspaceJobGrant | null {
    const grant = this.authority.derive({ username: this.opts.owner, purpose: "devpipe-workspace-job", kind: "job",
      rights: Object.keys(WORKSPACE_JOB_OPERATIONS), autoAllow: Object.keys(WORKSPACE_JOB_OPERATIONS) });
    return grant ? new WorkspaceJobGrant(this.opts.service, grant.contextId, this.opts.owner, grant.borrowed) : null;
  }
  revoke(): void { this.authority.revokeAccount(this.opts.owner); }
}
