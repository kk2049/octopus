import { createHash } from "node:crypto";
import type { CapabilityService, ArgSpec, ObjectDefinition, OperationSpec } from "@claude-bot/capability-kernel";
import { WORKSPACE_DEVELOPMENT_METHODS, WORKSPACE_DEVELOPMENT_LIMITS, type WorkspaceDevelopmentMethod } from "@claude-bot/runner/workspace-development-protocol";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import { dispatchToRunner, type RunnerDispatchBinding } from "../runner/dispatch.js";
import type { RunnerTransport } from "../runner/gateway.js";

const SLOT = "workspace-development";
const text = (maxLength: number, required = true): ArgSpec => ({ type: "string", maxLength, required });
const number = (max: number, min = 0): ArgSpec => ({ type: "number", min, max, integer: true, required: true });
const identity = { repository_id: text(100), development_id: text(100), ticket_id: number(Number.MAX_SAFE_INTEGER, 1) };
const source = { request_id: text(100), base_sha: text(40), input_url: text(2048, false), input_sha256: text(64, false),
  input_bytes: { ...number(WORKSPACE_DEVELOPMENT_LIMITS.bundleBytes, 1), required: false } };
export const WORKSPACE_DEVELOPMENT_OPERATIONS: Record<WorkspaceDevelopmentMethod, OperationSpec> = {
  workspace_development_prepare: { args: { ...identity, ...source }, effect: "modify", retrySafe: true, title: "准备工单开发工作区" },
  workspace_development_sync: { args: { ...identity, ...source, target_sha: text(40) }, effect: "modify", retrySafe: true, title: "同步权威源码水位" },
  workspace_development_status: { args: { ...identity, request_id: text(100, false) }, effect: "observe", title: "读取原开发工作区状态" },
  workspace_development_export: { args: { ...identity, request_id: text(100), expected_base_sha: text(40), expected_head_sha: text(40) }, effect: "modify", retrySafe: true, title: "导出工单提交候选" },
  workspace_development_artifact: { args: { ...identity, candidate_id: text(100), artifact_id: text(100), offset: number(Number.MAX_SAFE_INTEGER), length: number(WORKSPACE_DEVELOPMENT_LIMITS.artifactChunkBytes, 1) }, effect: "read", title: "读取已导出候选" },
};
interface Binding extends RunnerDispatchBinding { device: string; workspaceId: string }
/** One independently revocable closed Object per trusted owner/device/parent workspace. */
export class WorkspaceDevelopmentCapabilities {
  private readonly authority: AccountAuthority<Binding>;
  constructor(private readonly opts: { service: CapabilityService; transport: RunnerTransport; owner: string; device: string; workspaceId: string;
    /** Recheck current owner, target membership, selected workspace and dev authorization. */
    authorized(): boolean }) {
    if (!opts.owner || !opts.device || !/^ws_[0-9a-f]{24}$/.test(opts.workspaceId)) throw new Error("development requires a registered owner/device/parent workspace");
    const target = createHash("sha256").update(JSON.stringify([opts.device, opts.workspaceId])).digest("hex").slice(0, 24);
    this.authority = new AccountAuthority<Binding>({ service: opts.service, slot: SLOT, objectPrefix: `workspace-development-v1:${target}`,
      kind: SLOT, operations: WORKSPACE_DEVELOPMENT_OPERATIONS,
      policy: (input) => input.terms.autoAllow.includes(input.operation) ? { kind: "allow" } : { kind: "deny", reason: "development provider binding required" },
      rootAutoAllow: () => WORKSPACE_DEVELOPMENT_METHODS,
      bindingFor: (owner) => owner === opts.owner && opts.authorized() ? { owner, device: opts.device, workspaceId: opts.workspaceId, transport: opts.transport } : null,
      adapter: (async (binding: Binding, operation: string, args: Readonly<Record<string, unknown>>) => {
        const { input_url, input_sha256, input_bytes, ...rest } = args;
        return await dispatchToRunner(binding, operation, { ...rest, device: binding.device, workspace_id: binding.workspaceId,
          ...(input_url ? { input: { url: input_url, sha256: input_sha256, bytes: input_bytes } } : {}) },
          { indeterminateOnLinkLoss: operation !== "workspace_development_status" && operation !== "workspace_development_artifact" });
      }) as ObjectDefinition<Binding>["adapter"],
    });
  }
  revoke(): void { this.authority.revokeAccount(this.opts.owner); }
  async call(method: WorkspaceDevelopmentMethod, args: Record<string, unknown>): Promise<unknown> {
    if (args.workspace_id !== this.opts.workspaceId) throw new Error("development parent workspace mismatch");
    const derived = this.authority.derive({ username: this.opts.owner, purpose: SLOT, kind: "job", rights: [method], autoAllow: [method] });
    if (!derived) throw new Error("development provider is unavailable or authorization was revoked");
    const grant = new SlotGrant(this.opts.service, derived.contextId, SLOT, SLOT, this.opts.owner, derived.borrowed);
    try {
      const { workspace_id: _parent, input, ...rest } = args;
      const source = input as { url: string; sha256: string; bytes: number } | undefined;
      return await grant.call(method, { ...rest, ...(source ? { input_url: source.url, input_sha256: source.sha256, input_bytes: source.bytes } : {}) });
    } finally { grant.close(); }
  }
}
