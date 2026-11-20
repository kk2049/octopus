import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import type { DevTicketRow } from "../store/repositories/dev-tickets.js";
import {
  FABLE_TICKET_APPROVER,
  FableTicketApprovalService,
} from "./ticket-agent-approval.js";
import { FABLE_TICKET_MODEL } from "./ticket-models.js";

function row(input: Record<string, unknown>, id: number): DevTicketRow {
  return {
    id,
    title: String(input.title),
    body: String(input.body),
    requester: String(input.requester),
    model: String(input.model),
    effort: String(input.effort),
  } as DevTicketRow;
}

describe("Fable ticket approval", () => {
  let service: CapabilityService | null = null;

  afterEach(() => {
    service?.close();
    service = null;
  });

  function harness() {
    service = new CapabilityService();
    let nextId = 1;
    const createTicket = vi.fn((input: Record<string, unknown>) => row(input, nextId++));
    const approvals = new FableTicketApprovalService({
      service,
      pipeline: { createApprovedFableTicket: createTicket as never },
      userExists: (username) => username === "alice" || username === FABLE_TICKET_APPROVER,
      knownUsers: ["alice", FABLE_TICKET_APPROVER],
      isAdmin: (username) => username === FABLE_TICKET_APPROVER,
    });
    return { service, approvals, createTicket };
  }

  it("parks a non-lht Fable request and shows lht the exact ticket input", async () => {
    const h = harness();
    const original = "  第一段原始需求\n\n第二段：不要省略附件引用 /tmp/a.png  ";
    const asked = await h.approvals.request({
      actor: "alice",
      credential: "web:alice:1",
      originalInput: original,
      ticket: {
        title: "新工单",
        body: original.trim(),
        requester: "alice",
        kind: "simple",
        model: FABLE_TICKET_MODEL,
        effort: "xhigh",
        via: "web",
        actor_kind: "token",
      },
    });

    expect(asked.status).toBe("approval_required");
    expect(h.createTicket).not.toHaveBeenCalled();
    expect(h.service.listPending("alice")).toEqual([]);
    const [card] = h.service.listPending(FABLE_TICKET_APPROVER);
    expect(card).toMatchObject({ title: "Fable 工单申请 · alice", target: "dev-ticket/alice" });
    expect(card!.details.join("\n")).toContain("发起用户：alice");
    expect(card!.details.join("\n")).toContain(original);

    if (asked.status !== "approval_required") throw new Error("unreachable");
    await expect(h.service.approve(asked.pendingCallId, "alice")).resolves.toMatchObject({ status: "denied" });
    await expect(h.service.approve(asked.pendingCallId, FABLE_TICKET_APPROVER))
      .resolves.toMatchObject({ status: "succeeded", result: { ticket_id: 1 } });
    expect(h.createTicket).toHaveBeenCalledWith(expect.objectContaining({
      body: original.trim(),
      requester: "alice",
      model: FABLE_TICKET_MODEL,
      effort: "xhigh",
      // How the request reached the route survives the approval replay.
      actor_kind: "token",
    }));
  });

  it("creates an administrator's own Fable ticket without asking them to approve themselves (O1)", async () => {
    const h = harness();
    const outcome = await h.approvals.request({
      actor: FABLE_TICKET_APPROVER,
      credential: "web:lht:1",
      originalInput: "lht 主动选择 Fable",
      ticket: {
        title: "新工单",
        body: "lht 主动选择 Fable",
        requester: FABLE_TICKET_APPROVER,
        kind: "discuss",
        model: FABLE_TICKET_MODEL,
        effort: "max",
        via: "web",
      },
    });

    expect(outcome).toMatchObject({ status: "succeeded", result: { ticket_id: 1, requester: FABLE_TICKET_APPROVER } });
    expect(h.createTicket).toHaveBeenCalledOnce();
    // A request that did not say (e.g. frozen before v86) creates an unknown row.
    expect(h.createTicket.mock.calls[0]![0]).not.toHaveProperty("actor_kind");
    expect(h.service.listPending(FABLE_TICKET_APPROVER)).toHaveLength(0);
  });

  it("freezes the whole input past the old 100,000-character cut, carrying the text once", async () => {
    const h = harness();
    const original = `${"需求".repeat(60_000)}\n${"tail-marker"}`;
    const asked = await h.approvals.request({
      actor: "alice",
      credential: "web:alice:1",
      originalInput: original,
      ticket: {
        title: "新工单", body: original.trim(), requester: "alice", kind: "simple",
        model: FABLE_TICKET_MODEL, effort: "high", via: "web",
      },
    });
    expect(asked.status).toBe("approval_required");
    if (asked.status !== "approval_required") throw new Error("unreachable");
    expect(h.service.listPending(FABLE_TICKET_APPROVER)[0]!.details.join("\n")).toContain("tail-marker");
    await expect(h.service.approve(asked.pendingCallId, FABLE_TICKET_APPROVER)).resolves.toMatchObject({ status: "succeeded" });
    expect(h.createTicket.mock.calls[0]![0]).toMatchObject({ body: original.trim() });
  });

  it("still parks a ticket an administrator files on somebody else's behalf", async () => {
    const h = harness();
    const outcome = await h.approvals.request({
      actor: FABLE_TICKET_APPROVER,
      credential: "web:lht:1",
      originalInput: "替 alice 提",
      ticket: {
        title: "代提工单",
        body: "替 alice 提",
        requester: "alice",
        kind: "simple",
        model: FABLE_TICKET_MODEL,
        effort: "high",
        via: "web",
      },
    });
    expect(outcome).toMatchObject({ status: "approval_required" });
    expect(h.createTicket).not.toHaveBeenCalled();
  });
});
