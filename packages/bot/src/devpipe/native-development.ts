import { randomUUID } from "node:crypto";
import { sessionOperationReceiptFromWire, type SessionOperationReceipt } from "@claude-bot/runner/gateway-protocol";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import type { DevTicketsRepository, DevTicketRow, NativeTicketInput, TicketActorKind } from "../store/repositories/dev-tickets.js";
import type { TicketRunnerBinding } from "../store/repositories/ticket-runner.js";
import type { TicketRunnerAccess, TicketExecution } from "./runner-ticket.js";
import { gitOrThrow } from "./worktree.js";

/** External native sessions are observed, never entered into the managed turn pump. */
export class NativeDevelopmentService {
  constructor(private readonly opts: { repository: DevTicketsRepository; repoDir: string; remote?: string;
    access: () => TicketRunnerAccess | null }) {}
  async register(subject: { owner: string; device: string }, proof: Readonly<Record<string, unknown>>, stillAuthorized: () => boolean = () => true): Promise<{ ticket_id: number; owner: string; execution_owner: "native_cli" }> {
    if (proof.protocol !== "native-development/v1" || (proof.source !== "codex" && proof.source !== "claude")
      || (proof.ticket_id !== undefined && (!Number.isSafeInteger(proof.ticket_id) || Number(proof.ticket_id) < 1))
      || typeof proof.session_id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(proof.session_id)
      || typeof proof.workspace_id !== "string" || !proof.workspace_id || proof.workspace_id.length > 200
      || typeof proof.relative_path !== "string" || proof.relative_path.length > 1024
      || proof.relative_path.startsWith("/") || proof.relative_path.split("/").includes("..")
      || typeof proof.branch !== "string" || !proof.branch.startsWith("dev/") || proof.branch.length > 200
      || typeof proof.title !== "string" || !proof.title || proof.title.length > 120
      || typeof proof.observed_at !== "string" || Math.abs(Date.now() - Date.parse(proof.observed_at)) > 120000
      || !Number.isFinite(Date.parse(proof.observed_at))) throw new Error("invalid or stale native development proof");
    if (proof.remote !== await gitOrThrow(this.opts.repoDir, ["remote", "get-url", this.opts.remote ?? "origin"])) throw new Error("native worktree belongs to a different repository");
    const access = this.opts.access();
    if (!access?.devicesFor(subject.owner).some(row => row.device === subject.device && row.online)) throw new Error("native development Runner is unavailable");
    if (!stillAuthorized()) throw new Error("native registration permission was revoked");
    const ticket = this.opts.repository.registerNativeTicket({ ...subject, source: proof.source, sessionId: proof.session_id,
      workspaceId: proof.workspace_id, relativePath: proof.relative_path, branch: proof.branch, remote: String(proof.remote), title: proof.title,
      ...(proof.ticket_id !== undefined ? { ticketId: Number(proof.ticket_id) } : {}) });
    return { ticket_id: ticket.id, owner: subject.owner, execution_owner: "native_cli" };
  }
  private bound(ticket: DevTicketRow): { access: TicketRunnerAccess; binding: TicketRunnerBinding; relativePath: string; source: "codex" | "claude" } {
    if (!ticket.native_binding || !ticket.session_id || ticket.dev_status === "cancelled") throw new Error("ticket is not attached to a native CLI");
    const native = JSON.parse(ticket.native_binding) as { owner: string; device: string; source?: "codex" | "claude"; sessionId: string; relativePath: string; workspaceId: string };
    const binding = this.opts.repository.runner.binding(ticket.id), access = this.opts.access();
    if (!binding || !access || binding.owner !== ticket.requester || native.owner !== binding.owner || native.device !== binding.device
      || native.sessionId !== ticket.session_id || native.workspaceId !== binding.workspaceId) throw new Error("native ticket binding is unavailable");
    return { access, binding, relativePath: native.relativePath, source: native.source ?? "codex" };
  }
  private settle(input: NativeTicketInput, receipt: SessionOperationReceipt): NativeTicketInput {
    const uncertain = receipt.state === "unknown" || receipt.state === "missing" || /unknown|uncertain|indeterminate/u.test(String(receipt.result?.code ?? ""));
    const next: NativeTicketInput = { ...input, state: uncertain ? "unknown"
      : receipt.input || (receipt.state === "succeeded" && receipt.result?.ok !== false) ? "accepted"
      : receipt.state === "failed" || receipt.result?.ok === false ? "failed" : "dispatched",
      ...(receipt.input ? { receipt: receipt.input } : {}),
      ...(uncertain ? { error: "原操作结果不确定；只查询回执，不自动重发" }
        : receipt.result?.error ? { error: String(receipt.result.error).slice(0, 600) } : {}) };
    this.opts.repository.saveNativeInput(next); return next;
  }
  async input(ticket: DevTicketRow, author: string, prompt?: string, actorKind?: TicketActorKind | null): Promise<NativeTicketInput> {
    if (ticket.chat_paused || ticket.dev_status === "completed") throw new Error("原生 CLI 已结束网页跟踪；请从本地重新注册后再发送");
    const { access, binding, relativePath, source } = this.bound(ticket);
    const id = `native-${randomUUID()}`;
    const capability = sessionOperationReceiptFromWire(await access.call(binding, "get_session_operation", { operation_id: id }), id);
    if (capability?.native_input !== "cli-only/v1") throw new Error("请升级 Runner；当前设备尚未支持保持原生 CLI 所有权的输入协议");
    if (prompt !== undefined && (!prompt.trim() || Buffer.byteLength(prompt, "utf8") > MACHINE_LIMITS.appendMaxPromptBytes)) {
      throw new Error(`native message must be non-empty and at most ${MACHINE_LIMITS.appendMaxPromptBytes} bytes (the shared session prompt budget)`);
    }
    const input = this.opts.repository.createNativeInput({ id, ticketId: ticket.id, kind: prompt === undefined ? "interrupt" : "message", state: "dispatched" }, author, prompt, actorKind);
    try {
      const response = await access.call(binding, "append_session", { id: ticket.session_id!, source, operation_id: id,
        native_cli_only: true, native_workspace_id: binding.workspaceId, native_relative_path: relativePath,
        ...(prompt === undefined ? { interrupt: true } : { prompt, input_receipt: true }) });
      const receipt = sessionOperationReceiptFromWire(response, id);
      if (!receipt) throw new Error("native operation acknowledgement is unrecognized");
      return this.settle(input, receipt);
    } catch {
      const unknown: NativeTicketInput = { ...input, state: "unknown", error: "原生操作已派发，但响应不确定；不会自动重发" };
      this.opts.repository.saveNativeInput(unknown); return unknown;
    }
  }
  async execution(ticket: DevTicketRow): Promise<TicketExecution | undefined> {
    const input = this.opts.repository.latestNativeInput(ticket.id); if (!input) return undefined;
    const { access, binding } = this.bound(ticket);
    let state = input;
    // An interrupt/new message can become latest before the preceding input's
    // acknowledgement is observed. Keep reconciling those durable receipts so
    // a delivered message does not remain "sending" forever. Reads only.
    const earlier = this.opts.repository.pendingNativeInputs(ticket.id).filter(row => row.id !== input.id);
    for (const pending of [input, ...earlier]) {
      if (!["dispatched", "unknown"].includes(pending.state)) continue;
      const wire = await access.call(binding, "get_session_operation", { operation_id: pending.id });
      const receipt = sessionOperationReceiptFromWire(wire, pending.id);
      if (!receipt) throw new Error("native operation receipt is unavailable");
      const settled = this.settle(pending, receipt); // Missing after restart remains uncertain, never replayed.
      if (pending.id === input.id) state = settled;
    }
    return { operation_id: input.id, session_id: ticket.session_id!, state: state.state === "accepted" ? "succeeded" : state.state === "dispatched" ? "running" : state.state,
      ...(state.receipt ? { input: state.receipt } : {}), observed_at: new Date().toISOString() };
  }
}
