import type { CapabilityService, OperationSpec, PolicyInput, PolicyDecision, ObjectDefinition } from "@claude-bot/capability-kernel";
import { MEETING_TRANSCRIPTION_ACTIONS, MEETING_TRANSCRIPTION_PROTOCOL, type MeetingTranscriptionAction } from "@claude-bot/runner/meeting-transcription-protocol";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import { dispatchToRunner, type RunnerDispatchBinding } from "../runner/dispatch.js";
import type { RunnerCapabilities } from "../runner/capability.js";
import type { RunnerTransport } from "../runner/gateway.js";
import { MEETING_TRANSCRIPTION_CONTRACT } from "./contract.js";
export const MEETING_TRANSCRIPTION_SLOT = "meeting-transcription";
export const MEETING_TRANSCRIPTION_OBJECT_PREFIX = "meeting-transcription-runner-v1";
/** Dedicated Object; adding this backend does not revoke or expand runner-account roots. */
export const MEETING_TRANSCRIPTION_OPERATIONS: Record<string, OperationSpec> = Object.fromEntries(
  Object.entries(MEETING_TRANSCRIPTION_CONTRACT.byAction).map(([action, declaration]) => [declaration.operation!, {
    title: declaration.summary,
    effect: ["status", "read"].includes(action) ? "read" : action === "start" ? "execute" : "modify",
    // Stable job + immutable digest, sequential chunk CAS and monotonic cancellation make explicit repeats safe.
    retrySafe: true,
    args: { device: { type: "string", required: true, maxLength: 128 }, ...Object.fromEntries(
      Object.entries(declaration.params).map(([name, field]) => [name, { type: field.type === "integer" ? "number" : field.type,
        required: !field.optional, ...(field.type === "integer" ? { integer: true, min: field.minimum, max: field.maximum } : { maxLength: field.maxLength }) }])) },
  } as OperationSpec]),
);
function policy(input: PolicyInput): PolicyDecision {
  const owner = input.object.metadata.owner;
  if (!owner) return { kind: "deny", reason: "missing transcription owner" };
  const approval = input.approval;
  if (approval && approval.objectId === input.object.id && approval.operation === input.operation && approval.argsHash === input.argsHash &&
    approval.contextId === input.context.id && approval.slot === input.slot && approval.approver === owner) return { kind: "allow" };
  if (input.terms.autoAllow.includes(input.operation)) return { kind: "allow" };
  return { kind: "approval_required", summary: { title: `录音转写 · ${owner}/${String(input.args.device)}`, target: `${owner}/${String(input.args.device)}`,
    allowedApprover: owner, details: [input.spec.title ?? input.operation, `作业：${String(input.args.job_key).slice(0, 16)}`, "录音将发送到已绑定设备上的固定 MOSS 管线；无任意命令执行。"] } };
}
export interface MeetingTranscriptionCapabilitiesOptions { service: CapabilityService; transport: RunnerTransport;
  userExists: (owner: string) => boolean; hasDevice: (owner: string) => boolean }
export class MeetingTranscriptionCapabilities {
  private readonly authority: AccountAuthority<RunnerDispatchBinding>;
  constructor(private readonly options: MeetingTranscriptionCapabilitiesOptions) {
    this.authority = new AccountAuthority({ service: options.service, slot: MEETING_TRANSCRIPTION_SLOT,
      objectPrefix: MEETING_TRANSCRIPTION_OBJECT_PREFIX, kind: "meeting-transcription-runner", operations: MEETING_TRANSCRIPTION_OPERATIONS,
      policy, scopeAllows: (device, input) => input.args.device === device,
      adapter: (async (binding, operation, args) => dispatchToRunner(binding, operation, args)) as ObjectDefinition<RunnerDispatchBinding>["adapter"],
      rootAutoAllow: () => Object.keys(MEETING_TRANSCRIPTION_OPERATIONS),
      bindingFor: owner => options.userExists(owner) && options.hasDevice(owner) ? { owner, transport: options.transport } : null });
  }
  open(input: { username: string; device: string; purpose: string; rights: readonly string[]; autoAllow?: readonly string[]; kind?: "job" | "app-instance" | "agent-run" }): SlotGrant | null {
    const result = this.authority.derive({ username: input.username, purpose: input.purpose, kind: input.kind ?? "job", rights: input.rights,
      autoAllow: input.autoAllow, scope: input.device });
    return result ? new SlotGrant(this.options.service, result.contextId, MEETING_TRANSCRIPTION_SLOT, input.purpose, input.username, result.borrowed) : null;
  }
  accountOperations(owner: string): readonly string[] {
    return this.options.userExists(owner) && this.options.hasDevice(owner) ? Object.keys(MEETING_TRANSCRIPTION_OPERATIONS) : [];
  }
  /** `maxInputBytes` is the device's own advertised ceiling: 64 MiB on Runners before 2026-10-20, unbounded after. */
  readiness(owner: string, device: string): { available: boolean; status: string; backend: "MOSS-Transcribe-Diarize"; maxInputBytes?: number } {
    const row = this.options.transport.listDevices(owner).find(item => item.device === device);
    const provider = row?.inventory?.meeting_transcription_jobs;
    const status = !this.options.userExists(owner) || !row ? "unregistered" : !row.online ? "offline" : !row.inventory ? "inventory_unavailable"
      : provider?.protocol !== MEETING_TRANSCRIPTION_PROTOCOL ? "unsupported" : !provider.available ? provider.reason ?? "environment_unavailable" : "available";
    return { available: status === "available", status, backend: "MOSS-Transcribe-Diarize",
      ...(provider?.protocol === MEETING_TRANSCRIPTION_PROTOCOL ? { maxInputBytes: provider.max_input_bytes } : {}) };
  }
  attachToRunnerLifecycle(runner: Pick<RunnerCapabilities, "onTargetSetChanged">): () => void {
    return runner.onTargetSetChanged(event => this.authority.revokeScope(event.username, event.device));
  }
  revokeAccount(owner: string): void { this.authority.revokeAccount(owner); }
}
/** Bound adapters expose named operations from the single declaration, never a caller-provided device. */
export function openMeetingTranscriptionProvider(caps: MeetingTranscriptionCapabilities, identity: { owner: string; device: string; purpose: string }) {
  const operations = Object.keys(MEETING_TRANSCRIPTION_OPERATIONS);
  const grant = caps.open({ username: identity.owner, device: identity.device, purpose: identity.purpose, rights: operations, autoAllow: operations });
  if (!grant) throw new Error("transcription authority unavailable");
  let closed = false;
  return { async dispatch(action: MeetingTranscriptionAction, args: Record<string, unknown>) {
    if (closed) throw new Error("transcription provider closed");
    const declaration = MEETING_TRANSCRIPTION_ACTIONS[action];
    if (!declaration || Object.keys(args).some(key => !Object.hasOwn(declaration.params, key))) throw new Error("invalid transcription action");
    const result = await grant.call(declaration.operation, { ...args, device: identity.device });
    if (closed) throw new Error("transcription provider closed"); return result;
  }, close() { closed = true; grant.destroy(); } };
}
