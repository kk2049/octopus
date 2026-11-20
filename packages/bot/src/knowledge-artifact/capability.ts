import {
  type CapabilityService,
  type ContextId,
  type ObjectDefinition,
  type Operation,
  type OperationSpec,
  type PolicyDecision,
  type PolicyInput,
} from "@claude-bot/capability-kernel";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import { dispatchToRunner, type RunnerDispatchBinding } from "../runner/dispatch.js";
import type { RunnerCapabilities } from "../runner/capability.js";
import type { RunnerTransport } from "../runner/gateway.js";

export const KNOWLEDGE_INDEX_SLOT = "knowledge-index-builder";
export const KNOWLEDGE_INDEX_OBJECT_PREFIX = "knowledge-index-builder-v1";
export const KNOWLEDGE_INDEX_PROTOCOL = "knowledge-index-jobs/v1";
export const KNOWLEDGE_INDEX_CHUNK_BYTES = 1024 * 1024;

export const KNOWLEDGE_INDEX_OPERATIONS: Record<Operation, OperationSpec> = {
  knowledge_index_start: {
    args: {
      job_key: { type: "string", required: true, maxLength: 64 },
      repo_sha: { type: "string", required: true, maxLength: 40 },
      input_url: { type: "string", required: true, maxLength: 2_048 },
      input_sha256: { type: "string", required: true, maxLength: 64 },
      input_bytes: { type: "number", required: true, integer: true, min: 1, max: 4 * 1024 * 1024 * 1024 },
    },
    effect: "execute",
    retrySafe: true,
    title: "启动固定知识索引任务",
  },
  knowledge_index_status: {
    args: { job_key: { type: "string", required: true, maxLength: 64 } },
    effect: "observe",
    title: "读取知识索引任务状态",
  },
  knowledge_index_cancel: {
    args: { job_key: { type: "string", required: true, maxLength: 64 } },
    effect: "modify",
    retrySafe: true,
    title: "取消固定知识索引任务",
  },
  knowledge_index_read: {
    args: {
      job_key: { type: "string", required: true, maxLength: 64 },
      file: { type: "string", required: true, maxLength: 240 },
      offset: { type: "number", required: true, integer: true, min: 0, max: Number.MAX_SAFE_INTEGER },
      length: { type: "number", required: true, integer: true, min: 1, max: KNOWLEDGE_INDEX_CHUNK_BYTES },
    },
    effect: "read",
    title: "读取不可变知识索引分块",
  },
};

interface KnowledgeIndexBinding extends RunnerDispatchBinding {
  /** Fixed by trusted bootstrap; no capability request schema contains a device. */
  device: string;
}

function serviceOnlyPolicy(input: PolicyInput): PolicyDecision {
  if (!input.object.metadata.owner) return { kind: "deny", reason: "knowledge index builder has no bound owner" };
  return input.terms.autoAllow.includes(input.operation)
    ? { kind: "allow" }
    : { kind: "deny", reason: "knowledge index builder is a trusted-service-only capability" };
}

async function adapter(
  binding: KnowledgeIndexBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const key = String(args.job_key ?? "");
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("invalid deterministic knowledge job key");
  let wire: Record<string, unknown>;
  if (operation === "knowledge_index_start") {
    const repoSha = String(args.repo_sha ?? "");
    const inputSha = String(args.input_sha256 ?? "");
    const inputBytes = Number(args.input_bytes);
    const inputUrl = String(args.input_url ?? "");
    if (!/^[0-9a-f]{40}$/.test(repoSha) || !/^[0-9a-f]{64}$/.test(inputSha)) throw new Error("invalid exact-SHA input binding");
    if (!Number.isSafeInteger(inputBytes) || inputBytes <= 0 || inputBytes > 4 * 1024 * 1024 * 1024) throw new Error("invalid input size");
    if (!inputUrl || inputUrl.length > 2_048) throw new Error("invalid one-use input URL");
    wire = { device: binding.device, job_key: key, repo_sha: repoSha, input: { url: inputUrl, sha256: inputSha, bytes: inputBytes } };
  } else if (operation === "knowledge_index_read") {
    wire = { device: binding.device, job_key: key, file: args.file, offset: args.offset, length: args.length };
  } else {
    wire = { device: binding.device, job_key: key };
  }
  return await dispatchToRunner(binding, operation, wire, {
    indeterminateOnLinkLoss: operation === "knowledge_index_start" || operation === "knowledge_index_cancel",
  });
}

export class KnowledgeIndexGrant extends SlotGrant {
  constructor(service: CapabilityService, contextId: ContextId, owner: string, borrowed = false) {
    super(service, contextId, KNOWLEDGE_INDEX_SLOT, "knowledge-artifact-service", owner, borrowed);
  }
}

export interface KnowledgeIndexCapabilitiesOptions {
  service: CapabilityService;
  transport: RunnerTransport;
  owner: string;
  device: string;
  userExists: (username: string) => boolean;
  hasDevice: (username: string, device: string) => boolean;
}

/** Independent, versioned Object for the private durable builder protocol. */
export class KnowledgeIndexCapabilities {
  private readonly authority: AccountAuthority<KnowledgeIndexBinding>;
  readonly owner: string;
  readonly device: string;

  constructor(private readonly opts: KnowledgeIndexCapabilitiesOptions) {
    this.owner = String(opts.owner ?? "").trim();
    this.device = String(opts.device ?? "").trim();
    if (!this.owner || !this.device) throw new Error("knowledge index builder requires one trusted owner/device target");
    this.authority = new AccountAuthority<KnowledgeIndexBinding>({
      service: opts.service,
      slot: KNOWLEDGE_INDEX_SLOT,
      objectPrefix: KNOWLEDGE_INDEX_OBJECT_PREFIX,
      kind: "knowledge-index-builder",
      operations: KNOWLEDGE_INDEX_OPERATIONS,
      policy: serviceOnlyPolicy,
      adapter: adapter as ObjectDefinition<KnowledgeIndexBinding>["adapter"],
      rootAutoAllow: () => Object.keys(KNOWLEDGE_INDEX_OPERATIONS),
      bindingFor: (owner) => owner === this.owner && opts.userExists(owner) && opts.hasDevice(owner, this.device)
        ? { owner, device: this.device, transport: opts.transport }
        : null,
    });
  }

  /** Rotate the internal root at composition so a trusted device config change never reuses old placement authority. */
  resetAuthority(): void {
    this.authority.authorityFor(this.owner);
    this.authority.revokeAccount(this.owner);
  }

  open(): KnowledgeIndexGrant | null {
    const derived = this.authority.derive({
      username: this.owner,
      purpose: "knowledge-artifact-service",
      kind: "job",
      rights: Object.keys(KNOWLEDGE_INDEX_OPERATIONS),
      autoAllow: Object.keys(KNOWLEDGE_INDEX_OPERATIONS),
    });
    return derived ? new KnowledgeIndexGrant(this.opts.service, derived.contextId, this.owner, derived.borrowed) : null;
  }

  revoke(): void { this.authority.revokeAccount(this.owner); }

  attachToRunnerLifecycle(runner: Pick<RunnerCapabilities, "onTargetSetChanged">, onChanged?: () => void): () => void {
    return runner.onTargetSetChanged((event) => {
      if (event.username !== this.owner) return;
      this.revoke();
      onChanged?.();
    });
  }
}
