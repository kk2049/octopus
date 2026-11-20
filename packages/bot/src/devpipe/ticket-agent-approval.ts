/**
 * The one costly dev-ticket agent admission path.
 *
 * Normal ticket creation stays a direct call into `DevPipeline`. Selecting
 * Fable is different: every caller receives a durable PendingCall, and the
 * named budget owner's approval replays the exact original ticket input through
 * the same Gate before the pipeline can create or start anything.
 */

import {
  type CapabilityService,
  type InvokeResult,
  type ObjectDefinition,
  type Operation,
  type OperationSpec,
  type PolicyDecision,
  type PolicyInput,
} from "@claude-bot/capability-kernel";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import { TICKET_ACTOR_KINDS, type TicketActorKind } from "../store/repositories/dev-tickets.js";
import type { DevPipeline } from "./pipeline.js";
import {
  DEV_TICKET_EFFORTS,
  FABLE_TICKET_MODEL,
  type DevTicketInput,
} from "./ticket-models.js";

export const FABLE_TICKET_APPROVER = "lht";
export const FABLE_TICKET_SLOT = "dev-ticket-fable";
export const FABLE_TICKET_OBJECT_PREFIX = "dev-ticket-fable-v1";
export const CREATE_FABLE_TICKET = "create_fable_ticket";

export const FABLE_TICKET_OPERATIONS: Record<Operation, OperationSpec> = {
  [CREATE_FABLE_TICKET]: {
    args: {
      title: { type: "string", required: true, maxLength: 120 },
      // UTF-8 bytes. The panel route refuses input past the session prompt
      // budget (393,216 bytes) before this; 400,000 stays so calls frozen under
      // the old 100,000-character bound still replay. Absent when it is exactly
      // `original_input` trimmed (the route's own rule), so the approval
      // envelope (the kernel's 512 KiB argument cap) carries the text once.
      body: { type: "string", maxLength: 400_000 },
      original_input: { type: "string", required: true, maxLength: 400_000 },
      kind: { type: "string", required: true, enum: ["simple", "discuss"] },
      effort: { type: "string", required: true, enum: [...DEV_TICKET_EFFORTS] },
      parent_ticket_id: { type: "number", integer: true, min: 1 },
      via: { type: "string", required: true, maxLength: 64 },
      // How the request reached the route (review 6.10). Optional so pending
      // calls frozen before it existed still replay; they create NULL rows.
      actor_kind: { type: "string", enum: [...TICKET_ACTOR_KINDS] },
    },
    effect: "execute",
    // Creating twice means two agents and two bills. An interrupted approval
    // is therefore terminal unknown, never silently put back in front of lht.
    retrySafe: false,
    title: "创建 Fable 开发工单",
  },
};

interface FableTicketBinding {
  requester: string;
  pipeline: Pick<DevPipeline, "createApprovedFableTicket">;
}

function fableTicketPolicy(input: PolicyInput): PolicyDecision {
  const approver = FABLE_TICKET_APPROVER;
  // An administrator's own Fable ticket is the budget owner deciding for
  // themselves (O1): the derive grants that term only to admin requesters.
  if (input.terms.autoAllow.includes(input.operation)) return { kind: "allow" };
  const approval = input.approval;
  if (
    approval
    && approval.objectId === input.object.id
    && approval.operation === input.operation
    && approval.argsHash === input.argsHash
    && approval.contextId === input.context.id
    && approval.slot === input.slot
    && approval.approver === approver
  ) {
    return { kind: "allow" };
  }
  const actor = input.context.metadata.actor ?? "(unknown)";
  const requester = input.object.metadata.owner ?? "(unknown)";
  return {
    kind: "approval_required",
    summary: {
      title: `Fable 工单申请 · ${requester}`,
      target: `dev-ticket/${requester}`,
      details: [
        `发起用户：${actor}`,
        `工单验收人：${requester}`,
        `Agent：${FABLE_TICKET_MODEL}`,
        `Effort：${String(input.args.effort ?? "")}`,
        `工单类型：${String(input.args.kind ?? "")}`,
        `工单原始输入（原样）：\n${String(input.args.original_input ?? "")}`,
      ],
      allowedApprover: approver,
    },
  };
}

async function createFableTicket(
  binding: FableTicketBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (operation !== CREATE_FABLE_TICKET) throw new Error("unknown Fable ticket operation");
  const ticket = binding.pipeline.createApprovedFableTicket({
    title: String(args.title ?? ""),
    body: typeof args.body === "string" ? args.body : String(args.original_input ?? "").trim(),
    requester: binding.requester,
    kind: String(args.kind ?? "simple"),
    model: FABLE_TICKET_MODEL,
    effort: String(args.effort ?? ""),
    ...(typeof args.parent_ticket_id === "number" ? { parent_ticket_id: args.parent_ticket_id } : {}),
    via: String(args.via ?? "web"),
    ...(typeof args.actor_kind === "string" ? { actor_kind: args.actor_kind as TicketActorKind } : {}),
  });
  return { ticket_id: ticket.id, requester: ticket.requester, title: ticket.title };
}

/** Trusted input captured after the Dashboard route resolves its identity. */
export interface FableTicketRequest {
  actor: string;
  credential: string;
  originalInput: string;
  ticket: DevTicketInput & { kind: "simple" | "discuss"; effort: string };
}

/**
 * Fable ticket admission over the process's one capability service.
 *
 * The Object is fixed per requester, so neither a browser body nor approval
 * replay can swap the account the eventual ticket belongs to. The actor and
 * credential are trusted route bindings and live only in Context metadata.
 */
export class FableTicketApprovalService {
  private readonly authority: AccountAuthority<FableTicketBinding>;

  private readonly isAdmin: (username: string) => boolean;

  constructor(options: {
    service: CapabilityService;
    pipeline: Pick<DevPipeline, "createApprovedFableTicket">;
    userExists(username: string): boolean;
    knownUsers?: readonly string[];
    /**
     * Configured administrators. Their OWN Fable tickets need no approval
     * (O1); every other requester's still waits for the budget owner.
     */
    isAdmin?(username: string): boolean;
  }) {
    this.isAdmin = options.isAdmin ?? (() => false);
    this.authority = new AccountAuthority<FableTicketBinding>({
      service: options.service,
      slot: FABLE_TICKET_SLOT,
      objectPrefix: FABLE_TICKET_OBJECT_PREFIX,
      kind: "dev-ticket-fable",
      operations: FABLE_TICKET_OPERATIONS,
      policy: fableTicketPolicy,
      adapter: createFableTicket as ObjectDefinition<FableTicketBinding>["adapter"],
      // Only an administrator's own requests may skip the card; for everyone
      // else the approver identity authorises a decision, not a direct call.
      rootAutoAllow: (requester) => (this.isAdmin(requester) ? [CREATE_FABLE_TICKET] : []),
      bindingFor: (requester) => options.userExists(requester)
        ? { requester, pipeline: options.pipeline }
        : null,
    });
    // Re-register durable Objects before somebody tries to approve a card
    // restored from the previous process lifetime.
    for (const requester of options.knownUsers ?? []) this.authority.rightsOfAccount(requester);
  }

  async request(input: FableTicketRequest): Promise<InvokeResult> {
    const actor = String(input.actor ?? "").trim();
    const requester = String(input.ticket.requester ?? "").trim();
    const credential = String(input.credential ?? "").trim();
    if (!actor || !requester || !credential) {
      return { status: "denied", reason: "Fable 工单需要已绑定的发起用户、验收人和登录凭据" };
    }
    const derived = this.authority.derive({
      username: requester,
      purpose: `Fable 工单申请（${actor}）`,
      kind: "dashboard-ticket-request",
      rights: [CREATE_FABLE_TICKET],
      autoAllow: this.isAdmin(requester) && actor === requester ? [CREATE_FABLE_TICKET] : [],
      metadata: { actor, surface: "dashboard", requester },
      pool: `dashboard:${credential}`,
    });
    if (!derived) return { status: "denied", reason: "Fable 工单审批服务不可用" };
    const grant = new SlotGrant(
      this.authority.service,
      derived.contextId,
      FABLE_TICKET_SLOT,
      `Fable 工单申请（${actor}）`,
      requester,
      derived.borrowed,
    );
    const original = String(input.originalInput ?? "");
    const body = String(input.ticket.body ?? "");
    try {
      return await grant.request(CREATE_FABLE_TICKET, {
        title: String(input.ticket.title ?? "").slice(0, 120),
        // Whole: the route already refused text past the prompt budget, and a
        // cut here would freeze a different request than the one approved.
        ...(body === original.trim() ? {} : { body }),
        original_input: original,
        kind: input.ticket.kind,
        effort: input.ticket.effort,
        ...(input.ticket.parent_ticket_id != null ? { parent_ticket_id: input.ticket.parent_ticket_id } : {}),
        via: String(input.ticket.via ?? "web").slice(0, 64),
        ...(input.ticket.actor_kind ? { actor_kind: input.ticket.actor_kind } : {}),
      });
    } finally {
      grant.close();
    }
  }
}
