import { randomUUID } from "node:crypto";
import type { SessionOperationReceipt } from "@claude-bot/runner/gateway-protocol";
import { sessionOperationReceiptFromWire } from "@claude-bot/runner/gateway-protocol";
import type { TicketRunnerBinding, TicketRunnerInput, TicketRunnerRepository, TicketRunnerTurn } from "../store/repositories/ticket-runner.js";
import type { TicketMessageRow } from "../store/repositories/dev-tickets.js";
import type { TicketRunnerAccess } from "./runner-ticket.js";

/** The ticket's durable input adapter over the ordinary Runner session API.
 * Provider execution and input acceptance remain separate operations. A lost
 * acknowledgement is queried by its original id; it never authorizes a resend.
 */
export class RunnerTicketInputDelivery {
  constructor(private readonly options: {
    turn: TicketRunnerTurn;
    binding: TicketRunnerBinding;
    repository: TicketRunnerRepository;
    access: Pick<TicketRunnerAccess, "call" | "prepareAttachments">;
    unread(): TicketMessageRow[];
    blocked(): boolean;
    prompt(messages: TicketMessageRow[]): string;
  }) {}

  async observe(receipt: SessionOperationReceipt): Promise<void> {
    const { turn, repository, binding } = this.options;
    const admitted = receipt.input && receipt.input.phase !== "dispatched";
    if (admitted || receipt.state === "succeeded") repository.messageDelivery(turn.messageIds ?? [], "delivered", undefined, receipt.input);
    else if (receipt.state === "failed" || receipt.state === "unknown") {
      repository.messageDelivery(turn.messageIds ?? [], receipt.state, String(receipt.result?.error ?? "输入结果未确认，请核对原会话。"));
    }

    // Always reconcile already-dispatched input, including after stop/restart.
    // Read before send: a persisted dispatched record is never re-executed.
    for (const input of repository.inputs(turn.id)) await this.advance(input, receipt);
    if (receipt.state !== "running") {
      for (const input of repository.inputs(turn.id)) repository.settleInput(input, "unknown", "轮次已结束，消息的发送结果尚未确认；请核对原会话。");
      return;
    }
    if (receipt.state !== "running" || !receipt.session_id || !admitted || this.options.blocked()) return;
    const unread = this.options.unread();
    if (!unread.length || repository.inputs(turn.id).length || repository.inputChannelClosed(turn.id)) return;
    // An older Runner might ignore an unknown append field and start a turn.
    // Do not send until the device explicitly advertises the narrowing contract.
    if (receipt.live_input !== "steer-only/v1") return;
    const input: TicketRunnerInput = {
      id: `ticket-input-${randomUUID()}`, ticketId: turn.ticketId, turnId: turn.id,
      turn: turn.turn, messageIds: unread.map((row) => row.id), state: "prepared",
      attachmentBodies: unread.map((row) => row.body),
      args: { id: receipt.session_id, source: binding.source, input_receipt: true,
        steer_only: true, prompt: this.options.prompt(unread) },
    };
    if (!repository.claimInput(input)) return;
    await this.advance(input, receipt);
  }

  private async advance(input: TicketRunnerInput, turnReceipt: SessionOperationReceipt): Promise<void> {
    const { repository, binding, access } = this.options;
    if (input.state === "prepared" && (this.options.blocked() || turnReceipt.state !== "running")) {
      repository.settleInput(input, "queued");
      return;
    }
    try {
      let receipt = sessionOperationReceiptFromWire(await access.call(binding, "get_session_operation", { operation_id: input.id }), input.id);
      if (!receipt) throw new Error("Runner 输入回执协议不可用");
      if (receipt.state === "missing") {
        if (input.state !== "prepared") {
          repository.settleInput(input, "unknown", "Runner 未找到已派发消息的回执，请核对原会话；没有重复发送。");
          return;
        }
        if (this.options.blocked()) { repository.settleInput(input, "queued"); return; }
        // Recover an input claimed before attachment transfer completed. Upload
        // is idempotent; only the append below crosses the execution barrier.
        if (input.attachmentBodies) {
          input.args.prompt = await access.prepareAttachments(binding, String(input.args.prompt), input.attachmentBodies, String(input.args.id));
          delete input.attachmentBodies;
          repository.saveInput(input);
        }
        if (this.options.blocked()) { repository.settleInput(input, "queued"); return; }
        input.state = "dispatched";
        repository.saveInput(input);
        receipt = sessionOperationReceiptFromWire(await access.call(binding, "append_session", { ...input.args, operation_id: input.id }), input.id);
        if (!receipt) throw new Error("Runner 输入回执协议不可用");
      }
      if ((receipt.input && receipt.input.phase !== "dispatched") || receipt.state === "succeeded") {
        repository.settleInput(input, "accepted", undefined, receipt.input);
      } else if (receipt.state === "failed" && receipt.result?.code === "turn_not_active") {
        // The device proved it sent nothing. Only this refusal may return the
        // original rows to the ordinary inbox for the next explicit/idle turn.
        repository.settleInput(input, "queued");
      } else if (receipt.state === "failed" || receipt.state === "unknown") {
        repository.settleInput(input, receipt.state, String(receipt.result?.error ?? "输入结果未确认，请核对原会话。"));
      }
    } catch (error) {
      // No transport result after the barrier proves either acceptance or
      // failure. Keep the operation dispatched so subsequent reads can settle it.
      if (input.state === "prepared") repository.settleInput(input, "failed", String(error));
      else repository.messageDelivery(input.messageIds, "unknown", "发送结果尚未确认，正在查询原消息回执。");
    }
  }
}
