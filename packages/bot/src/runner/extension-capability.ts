import { createHash } from "node:crypto";
import { IndeterminateOutcome, type CapabilityService, type OperationSpec, type PolicyInput, type PolicyDecision } from "@claude-bot/capability-kernel";
import { CAPABILITY_ACTIONS, jsonObject, type RunnerCapabilityProvider, type RunnerCapabilityTool } from "@claude-bot/runner/capability-protocol";
import { AccountAuthority, SlotGrant } from "./account-authority.js";
import { dispatchToRunner, type RunnerDispatchBinding } from "./dispatch.js";
import type { RunnerTransport } from "./gateway.js";

export const RUNNER_EXTENSION_OPERATIONS: Record<string, OperationSpec> = Object.fromEntries(
  Object.entries(CAPABILITY_ACTIONS).map(([action, value]) => [value.operation, {
    title: value.summary, effect: action === "call" ? "execute" : "read", retrySafe: action !== "call",
    args: Object.fromEntries(Object.entries(value.params).map(([name, field]) =>
      [name, { type: field.type, required: !("optional" in field && field.optional), maxLength: field.maxLength }])),
  }]),
);
const SLOT = "runner-extension";
interface Entry { capability_ref: string; device: string; provider: RunnerCapabilityProvider; tool: RunnerCapabilityTool }
export class RunnerExtensionCapabilities {
  private readonly authority: AccountAuthority<RunnerDispatchBinding>;
  constructor(private readonly options: { service: CapabilityService; transport: RunnerTransport;
    userExists: (owner: string) => boolean; hasDevice: (owner: string) => boolean }) {
    this.authority = new AccountAuthority({ service: options.service, slot: SLOT,
      objectPrefix: "runner-extension-v1", kind: "runner-extension", operations: RUNNER_EXTENSION_OPERATIONS,
      rootAutoAllow: () => Object.keys(RUNNER_EXTENSION_OPERATIONS),
      bindingFor: owner => options.userExists(owner) && options.hasDevice(owner) ? { owner, transport: options.transport } : null,
      policy: input => this.policy(input),
      adapter: async (binding, operation, args) => {
        if (operation === CAPABILITY_ACTIONS.list.operation) {
          const query = String(args.query ?? "").toLowerCase();
          const entries = this.entries(binding.owner).filter(row =>
            [row.device, row.provider.id, row.tool.name, row.tool.description].some(text => text.toLowerCase().includes(query)));
          const start = args.after ? entries.findIndex(row => row.capability_ref === args.after) + 1 : 0;
          if (args.after && start === 0) throw new Error("stale_cursor");
          const page = entries.slice(start, start + 20);
          return { capabilities: page.map(row => ({ capability_ref: row.capability_ref, device: row.device,
            provider: row.provider.id, version: row.provider.version, revision: row.provider.revision,
            tool: row.tool.name, description: row.tool.description, effect: "execute" })),
            ...(entries.length > start + 20 ? { next_cursor: page.at(-1)!.capability_ref } : {}) };
        }
        const entry = this.resolve(binding.owner, String(args.capability_ref));
        if (!entry) throw new Error("stale_capability_ref");
        if (operation === CAPABILITY_ACTIONS.describe.operation) return { capability_ref: entry.capability_ref,
          device: entry.device, provider: entry.provider.id, revision: entry.provider.revision,
          version: entry.provider.version, ...entry.tool, effect: "execute" };
        const output = await dispatchToRunner(binding, "invoke_runner_capability", {
          device: entry.device, provider: entry.provider.id, revision: entry.provider.revision, tool: entry.tool.name,
          request_id: args.request_id, input_json: args.input_json,
        }, { indeterminateOnLinkLoss: true });
        if (!jsonObject(output) || output.request_id !== args.request_id || output.revision !== entry.provider.revision) throw new IndeterminateOutcome("Runner capability response identity mismatch; do not retry");
        if (output.status === "indeterminate") throw new IndeterminateOutcome("Runner capability result is indeterminate; do not retry with a new ID");
        if (output.status === "refused") throw new Error(`Runner capability refused: ${String(output.reason)}`);
        if (output.status !== "succeeded") throw new IndeterminateOutcome("Invalid capability result; do not retry");
        return output;
      },
    });
  }
  private entries(owner: string): Entry[] {
    return this.options.transport.listDevices(owner).filter(device => device.online).flatMap(device =>
      (device.inventory?.capabilities?.providers ?? []).filter(provider => provider.status === "ready").flatMap(provider =>
        provider.tools.map(tool => ({ device: device.device, provider, tool,
          capability_ref: "rcap_" + createHash("sha256").update(JSON.stringify([owner, device.device, provider.id, provider.revision, tool.name])).digest("hex") }))))
      .sort((a, b) => a.capability_ref.localeCompare(b.capability_ref));
  }
  private resolve(owner: string, ref: string): Entry | undefined { return this.entries(owner).find(row => row.capability_ref === ref); }
  private policy(input: PolicyInput): PolicyDecision {
    const owner = input.object.metadata.owner;
    if (!owner || !this.options.userExists(owner)) return { kind: "deny", reason: "owner unavailable" };
    const entry = input.operation === CAPABILITY_ACTIONS.list.operation ? undefined : this.resolve(owner, String(input.args.capability_ref));
    if (input.operation !== CAPABILITY_ACTIONS.list.operation && !entry) return { kind: "deny", reason: "stale_capability_ref" };
    const approval = input.approval;
    if (approval && approval.objectId === input.object.id && approval.contextId === input.context.id
      && approval.operation === input.operation && approval.argsHash === input.argsHash && approval.slot === input.slot && approval.approver === owner) return { kind: "allow" };
    if (input.terms.autoAllow.includes(input.operation)) return { kind: "allow" };
    return { kind: "approval_required", summary: { title: "Runner capability",
      target: entry ? `${entry.device}/${entry.provider.id}/${entry.tool.name}` : owner, allowedApprover: owner,
      details: [entry ? `Version ${entry.provider.version} · revision ${entry.provider.revision}` : "Read capability directory",
        "The extension runs with its Runner OS account's authority. Tool annotations do not reduce this permission.",
        ...(input.operation === CAPABILITY_ACTIONS.call.operation ? [String(input.args.input_json)] : [])] } };
  }
  open(owner: string, rights: readonly string[], autoAllow: readonly string[]): SlotGrant | null {
    const context = this.authority.derive({ username: owner, purpose: "MCP Runner capabilities", kind: "agent-run", rights, autoAllow });
    return context ? new SlotGrant(this.options.service, context.contextId, SLOT, "MCP Runner capabilities", owner) : null;
  }
  accountOperations(owner: string): readonly string[] { return this.options.userExists(owner) && this.options.hasDevice(owner) ? Object.keys(RUNNER_EXTENSION_OPERATIONS) : []; }
  revokeAccount(owner: string): void { this.authority.revokeAccount(owner); }
}
