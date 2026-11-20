/**
 * Trusted-service capability Object for driving a requester's OWN Runner
 * device's Codex app-server through the codex_agent_* relay, plus reading the
 * Codex transcript that app-server persists on that same device (#358).
 *
 * A separate Object rather than four more names in `runner-account-v9`, for the
 * reason `runner/capability.ts` documents: bumping that Object's version costs
 * every live capability and pending card on every account. This plane is
 * independent in identity, root, slot, grant and revocation, and — like the
 * knowledge-index builder — it is a trusted-service-only capability: the
 * policy denies anything outside the grant's autoAllow, so no browser or MCP
 * surface can reach it.
 *
 * `device` stays an argument (as on the main Object's machine ops) because the
 * gateway routes it strictly within the owner's OWN authenticated connection
 * set; the composition root picks it from trusted config/DB state.
 */

import {
  type CapabilityService,
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

export const REMOTE_CODEX_SLOT = "devpipe-remote-codex";
export const REMOTE_CODEX_OBJECT_PREFIX = "devpipe-remote-codex-v2";

const DEVICE_ARG = { type: "string", required: true, maxLength: MACHINE_LIMITS.deviceMaxBytes } as const;
const TUNNEL_ARG = { type: "string", required: true, maxLength: 128 } as const;
const FRAME_ID_ARG = { type: "string", maxLength: 64 } as const;

export const REMOTE_CODEX_OPERATIONS: Record<Operation, OperationSpec> = {
  codex_agent_open: {
    args: {
      device: DEVICE_ARG,
      relay_protocol: { type: "string", enum: [MACHINE_LIMITS.codexAgentRelayProtocol] },
    },
    effect: "execute",
    title: "打开工单 Codex 控制隧道",
  },
  codex_agent_read: {
    args: {
      device: DEVICE_ARG,
      tunnel_id: TUNNEL_ARG,
      wait_ms: { type: "number", min: 0, max: 20_000, integer: true },
    },
    effect: "read",
    title: "读取工单 Codex 隧道帧",
  },
  codex_agent_write: {
    args: {
      device: DEVICE_ARG,
      tunnel_id: TUNNEL_ARG,
      channel: { type: "string", required: true, enum: ["agent", "env"] },
      data: { type: "string", required: true, maxLength: MACHINE_LIMITS.codexAgentRelayChunkBase64MaxBytes },
      binary: { type: "boolean" },
      frame_id: FRAME_ID_ARG,
      chunk_index: { type: "number", min: 0, max: MACHINE_LIMITS.codexAgentRelayMaxChunks - 1, integer: true },
      chunk_count: { type: "number", min: 2, max: MACHINE_LIMITS.codexAgentRelayMaxChunks, integer: true },
    },
    effect: "execute",
    title: "写入工单 Codex 隧道帧",
  },
  codex_agent_close: {
    args: { device: DEVICE_ARG, tunnel_id: TUNNEL_ARG },
    effect: "execute",
    retrySafe: true,
    title: "关闭工单 Codex 控制隧道",
  },
  codex_agent_read_session: {
    args: {
      device: DEVICE_ARG,
      id: { type: "string", required: true, maxLength: MACHINE_LIMITS.sessionIdMaxBytes },
      max_messages: { type: "number", min: 1, max: 500, integer: true },
      offset: { type: "number", min: 0, max: 1_000_000, integer: true },
    },
    effect: "read",
    title: "读取工单 Codex 会话",
  },
};

function serviceOnlyPolicy(input: PolicyInput): PolicyDecision {
  if (!input.object.metadata.owner) return { kind: "deny", reason: "remote Codex relay has no bound owner" };
  return input.terms.autoAllow.includes(input.operation)
    ? { kind: "allow" }
    : { kind: "deny", reason: "remote Codex relay is a trusted-service-only capability" };
}

async function adapter(
  binding: RunnerDispatchBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (operation === "codex_agent_read_session") {
    // Keep the dedicated verb on the wire. The Runner, not this bot-side
    // adapter, owns the isolated CODEX_HOME where its ticket app-server writes
    // rollouts; projecting to the general `read_session` verb would scan the
    // user's ordinary Codex roots and miss the correctly reported thread id.
    return await dispatchToRunner(binding, operation, args, { indeterminateOnLinkLoss: false });
  }
  return await dispatchToRunner(binding, operation, args, {
    // A lost link mid-open/write leaves the device-side tunnel state unknown.
    indeterminateOnLinkLoss: operation !== "codex_agent_read",
  });
}

export class RemoteCodexGrant extends SlotGrant {
  constructor(service: CapabilityService, contextId: ContextId, owner: string, purpose: string, borrowed = false) {
    super(service, contextId, REMOTE_CODEX_SLOT, purpose, owner, borrowed);
  }
}

export interface RemoteCodexCapabilitiesOptions {
  service: CapabilityService;
  transport: RunnerTransport;
  userExists: (username: string) => boolean;
  hasDevice: (username: string) => boolean;
}

/** Independent, versioned Object for the devpipe remote-Codex relay. */
export class RemoteCodexCapabilities {
  private readonly authority: AccountAuthority<RunnerDispatchBinding>;

  constructor(private readonly opts: RemoteCodexCapabilitiesOptions) {
    this.authority = new AccountAuthority<RunnerDispatchBinding>({
      service: opts.service,
      slot: REMOTE_CODEX_SLOT,
      objectPrefix: REMOTE_CODEX_OBJECT_PREFIX,
      kind: "devpipe-remote-codex",
      operations: REMOTE_CODEX_OPERATIONS,
      policy: serviceOnlyPolicy,
      scopeAllows: (device, input) => input.args.device === device,
      adapter: adapter as ObjectDefinition<RunnerDispatchBinding>["adapter"],
      rootAutoAllow: () => Object.keys(REMOTE_CODEX_OPERATIONS),
      bindingFor: (owner) => opts.userExists(owner) && opts.hasDevice(owner)
        ? { owner, transport: opts.transport }
        : null,
    });
  }

  /** One turn-scoped grant; null when the account holds no registered device. */
  open(username: string, purpose: string, device?: string): RemoteCodexGrant | null {
    const derived = this.authority.derive({
      username,
      purpose,
      scope: device,
      kind: "agent-run",
      rights: Object.keys(REMOTE_CODEX_OPERATIONS),
      autoAllow: Object.keys(REMOTE_CODEX_OPERATIONS),
    });
    return derived
      ? new RemoteCodexGrant(this.opts.service, derived.contextId, username, purpose, derived.borrowed)
      : null;
  }

  revokeAccount(username: string): void {
    this.authority.revokeAccount(username);
  }

  attachToRunnerLifecycle(runner: Pick<RunnerCapabilities, "onTargetSetChanged">): () => void {
    return runner.onTargetSetChanged((event) => this.authority.revokeScope(event.username, event.device));
  }
}
