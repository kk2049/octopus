import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { type CapabilityService, type PolicyInput, type PolicyDecision } from "@claude-bot/capability-kernel";
import { FILE_TRANSFER_CHUNK_BYTES, FILE_TRANSFER_PROTOCOL } from "@claude-bot/runner/file-transfer";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import type { RunnerDeviceStatus, RunnerLocalAgentBridgeSubject, RunnerTransport } from "../runner/gateway.js";
import { FILE_TRANSFER_DECLARATION, FILE_TRANSFER_OPERATIONS, FILE_TRANSFER_REFUSALS, TRANSFER_OPERATION, readFileTransferArgs } from "./protocol.js";

const SLOT = "runner-file-transfer";
const TERMINAL = new Set(["completed", "failed", "cancelled", "indeterminate"]);
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
interface Endpoint { device: string; workspace: string; path: string; stream: string }
interface Transfer {
  id: string;
  owner: string;
  origin: string;
  source: Endpoint;
  destination: Endpoint;
  intent: Record<string, string>;
  grant: SlotGrant;
  authorized(): boolean;
  abort: AbortController;
  state: string;
  bytes: bigint;
  size?: bigint;
  digest?: string;
  error?: string;
  pending?: string;
  commitDispatched: boolean;
  createdAt: number;
  finishedAt?: number;
  running?: Promise<void>;
}
export interface RunnerFileTransfersOptions {
  service: CapabilityService;
  transport: RunnerTransport;
  userExists(owner: string): boolean;
  devices(owner: string): readonly RunnerDeviceStatus[];
}
export interface TransferCaller {
  subject: Readonly<RunnerLocalAgentBridgeSubject>;
  mode: "manual" | "full_access";
  /** Captures the authenticated WebSocket and policy generation at dispatch. */
  isActive(): boolean;
}

/** One independent capability Object, no changes to old file/execute grants. */
export class RunnerFileTransfers {
  readonly contract = FILE_TRANSFER_DECLARATION.contract;
  private readonly jobs = new Map<string, Transfer>();
  private readonly authority: AccountAuthority<{ owner: string }>;
  private readonly sweep: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly options: RunnerFileTransfersOptions) {
    this.authority = new AccountAuthority({
      service: options.service, slot: SLOT,
      objectPrefix: "runner-file-transfer-v1", kind: "runner-file-transfer",
      operations: FILE_TRANSFER_OPERATIONS,
      rootAutoAllow: () => [TRANSFER_OPERATION],
      scopeAllows: (origin, input) => input.args.origin_device === origin,
      bindingFor: (owner) => options.userExists(owner) && options.devices(owner).length ? { owner } : null,
      policy: (input) => this.policy(input),
      adapter: async ({ owner }, operation, args) => {
        const job = this.jobs.get(String(args.transfer_id));
        if (operation !== TRANSFER_OPERATION || !job || job.owner !== owner
          || Object.keys(args).length !== Object.keys(job.intent).length
          || Object.entries(job.intent).some(([key, value]) => args[key] !== value)) throw new Error("file transfer binding is unavailable");
        this.check(job);
        if (job.state !== "authorizing" && job.state !== "approval_required") throw new Error("file transfer already started; query its original receipt");
        job.state = "copying";
        job.running = this.copy(job);
        return this.view(job);
      },
    });
    this.sweep = setInterval(() => {
      for (const job of this.jobs.values()) {
        if (!TERMINAL.has(job.state) && !job.authorized()) this.cancel(job);
        if (job.state === "approval_required" && Date.now() - job.createdAt > 30 * 60_000) this.cancel(job);
        if (job.finishedAt && Date.now() - job.finishedAt > 60 * 60_000) this.jobs.delete(job.id);
      }
    }, 1_000);
    this.sweep.unref?.();
  }

  supports(owner: string, device: string): boolean {
    return this.options.devices(owner).some((row) => row.device === device && row.online
      && row.inventory?.execution.workspace_files && row.inventory.file_transfer?.protocol === FILE_TRANSFER_PROTOCOL);
  }

  async call(caller: TransferCaller, tool: string, raw: Readonly<Record<string, unknown>>): Promise<unknown> {
    let args: Record<string, string>;
    try { args = readFileTransferArgs(tool, raw); }
    catch (error) { return FILE_TRANSFER_REFUSALS.refuse("invalid_input", message(error)); }
    if (this.closed || !caller.isActive()) return FILE_TRANSFER_REFUSALS.refuse("denied", "file transfer authorization ended");
    if (tool !== "octopus_copy_file") {
      const job = this.jobs.get(args.transfer_id);
      if (!job || job.owner !== caller.subject.owner || job.origin !== caller.subject.device) {
        return FILE_TRANSFER_REFUSALS.refuse("unavailable", "transfer receipt is unavailable to this originating Runner");
      }
      if (tool === "octopus_cancel_file_transfer") this.cancel(job);
      return { ok: true, result: this.view(job) };
    }
    const owner = caller.subject.owner;
    const origin = caller.subject.device;
    const destination = args.destination_device ?? origin;
    if (!this.supports(owner, args.source_device) || !this.supports(owner, destination)) {
      return FILE_TRANSFER_REFUSALS.refuse("unavailable", "both devices must be online, owned by this account and advertise workspace-file-transfer/v1; update older Runners");
    }
    if (args.source_device === destination && args.source_workspace_id === args.destination_workspace_id
      && args.source_path === args.destination_path) return FILE_TRANSFER_REFUSALS.refuse("invalid_input", "source and destination are the same file");
    // Receipt retention is bounded independently of file size and duration.
    for (const [id, held] of this.jobs) {
      if (this.jobs.size < 256) break;
      if (TERMINAL.has(held.state)) this.jobs.delete(id);
    }
    const active = [...this.jobs.values()].filter((job) => !TERMINAL.has(job.state));
    if (active.length >= 8 || active.filter((job) => job.owner === owner).length >= 4) {
      return FILE_TRANSFER_REFUSALS.refuse("capacity", "file transfer concurrency is full; query or cancel an existing transfer");
    }
    const derived = this.authority.derive({
      username: owner, purpose: "Runner file copy", kind: "agent-run", scope: origin,
      rights: [TRANSFER_OPERATION], autoAllow: caller.mode === "full_access" ? [TRANSFER_OPERATION] : [],
    });
    if (!derived) return FILE_TRANSFER_REFUSALS.refuse("denied", "file transfer authority unavailable");
    const grant = new SlotGrant(this.options.service, derived.contextId, SLOT, "Runner file copy", owner);
    const id = randomUUID();
    const intent = { ...args, destination_device: destination, expected_digest: args.expected_digest ?? "absent",
      origin_device: origin, transfer_id: id };
    const job: Transfer = {
      id, owner, origin, intent, grant,
      source: { device: args.source_device, workspace: args.source_workspace_id, path: args.source_path, stream: randomUUID() },
      destination: { device: destination, workspace: args.destination_workspace_id, path: args.destination_path, stream: randomUUID() },
      authorized: () => caller.isActive() && this.options.service.contextIsLive(grant.contextId)
        && this.options.service.rightsOf(grant.contextId, SLOT).includes(TRANSFER_OPERATION),
      abort: new AbortController(), state: "authorizing", bytes: 0n, commitDispatched: false, createdAt: Date.now(),
    };
    this.jobs.set(id, job);
    try {
      const result = await grant.request(TRANSFER_OPERATION, intent);
      if (result.status === "approval_required") {
        job.state = "approval_required";
        job.pending = result.pendingCallId;
      } else if (result.status !== "succeeded") {
        job.state = "failed";
        job.error = result.reason;
        this.finish(job);
      }
      return { ok: true, result: this.view(job) };
    } catch (error) {
      job.state = "failed"; job.error = message(error); this.finish(job);
      return { ok: true, result: this.view(job) };
    }
  }

  private policy(input: PolicyInput): PolicyDecision {
    const owner = input.object.metadata.owner;
    const job = this.jobs.get(String(input.args.transfer_id));
    if (!owner || !job || job.owner !== owner || job.abort.signal.aborted || !job.authorized()) {
      return { kind: "deny", reason: "file transfer authorization ended" };
    }
    const approval = input.approval;
    if (approval && approval.objectId === input.object.id && approval.operation === input.operation
      && approval.argsHash === input.argsHash && approval.contextId === input.context.id
      && approval.slot === input.slot && approval.approver === owner) return { kind: "allow" };
    if (input.terms.autoAllow.includes(input.operation)) return { kind: "allow" };
    return { kind: "approval_required", summary: {
      title: "Runner 文件复制", target: owner + "/" + job.destination.device,
      details: [
        "来源：" + job.source.device + " / " + job.source.workspace + " / " + job.source.path,
        "目标：" + job.destination.device + " / " + job.destination.workspace + " / " + job.destination.path,
        "目标前提：" + job.intent.expected_digest,
      ], allowedApprover: owner,
    } };
  }

  private check(job: Transfer): void {
    if (this.closed || job.abort.signal.aborted || !job.authorized()) throw new Error("file transfer authorization ended or copy cancelled");
  }
  private async rpc(job: Transfer, endpoint: Endpoint, action: string, args: Record<string, unknown> = {}) {
    this.check(job);
    const raw = await this.options.transport.dispatch(job.owner, "workspace_file_transfer", {
      device: endpoint.device, workspace_id: endpoint.workspace, stream_id: endpoint.stream, action, ...args,
    });
    this.check(job);
    const result = record(raw);
    if (result.protocol !== FILE_TRANSFER_PROTOCOL || result.stream_id !== endpoint.stream
      || result.workspace_id !== endpoint.workspace) throw new Error("file transfer response binding mismatch");
    return result;
  }

  private async copy(job: Transfer): Promise<void> {
    const hash = createHash("sha256");
    let finalState = "failed";
    try {
      const source = await this.rpc(job, job.source, "open_read", { relative_path: job.source.path });
      if (source.state !== "reading" || source.bytes !== "0") throw new Error("invalid source open receipt");
      job.size = count(source.size);
      const destination = await this.rpc(job, job.destination, "open_write", {
        relative_path: job.destination.path, expected_digest: job.intent.expected_digest,
      });
      if (destination.state !== "writing" || destination.bytes !== "0") throw new Error("invalid destination open receipt");
      for (;;) {
        const next = await this.rpc(job, job.source, "read", { offset: job.bytes.toString() });
        if (next.offset !== job.bytes.toString() || count(next.size) !== job.size || typeof next.eof !== "boolean"
          || typeof next.data !== "string" || next.data.length > Math.ceil(FILE_TRANSFER_CHUNK_BYTES / 3) * 4) throw new Error("invalid source chunk receipt");
        const bytes = Buffer.from(next.data, "base64");
        if (bytes.toString("base64") !== next.data || bytes.length > FILE_TRANSFER_CHUNK_BYTES
          || (!bytes.length && !next.eof)) throw new Error("invalid source chunk payload");
        const advanced = job.bytes + BigInt(bytes.length);
        if (count(next.bytes) !== advanced || advanced > job.size || next.eof !== (advanced === job.size)) throw new Error("source size or offset mismatch");
        hash.update(bytes);
        if (bytes.length) {
          const written = await this.rpc(job, job.destination, "write", { offset: job.bytes.toString(), data: next.data });
          if (written.state !== "writing" || count(written.bytes) !== advanced) throw new Error("destination write receipt mismatch");
        }
        job.bytes = advanced;
        if (next.eof) {
          job.digest = "sha256:" + hash.digest("hex");
          if (!SHA256.test(String(next.digest)) || next.digest !== job.digest) throw new Error("source checksum mismatch");
          break;
        }
      }
      await this.closeStream(job, job.source);
      this.check(job);
      job.state = "committing";
      job.commitDispatched = true;
      let committed = await this.rpc(job, job.destination, "commit", { size: job.bytes.toString(), digest: job.digest });
      while (committed.state === "committing") {
        await delay(250, undefined, { signal: job.abort.signal });
        committed = await this.rpc(job, job.destination, "status");
      }
      if (committed.state === "failed") {
        // The receiver confirms it refused before publication.
        job.commitDispatched = false;
        throw new Error(String(committed.error ?? "destination commit failed"));
      }
      if (committed.state !== "completed" || count(committed.bytes) !== job.bytes || committed.digest !== job.digest) {
        throw new Error("destination commit receipt mismatch");
      }
      finalState = "completed";
    } catch (error) {
      finalState = job.commitDispatched ? "indeterminate" : job.abort.signal.aborted ? "cancelled" : "failed";
      job.error = message(error);
    } finally {
      await Promise.allSettled([this.closeStream(job, job.source), this.closeStream(job, job.destination)]);
      job.state = finalState;
      this.finish(job);
    }
  }

  private async closeStream(job: Transfer, endpoint: Endpoint): Promise<void> {
    // Cleanup spends no new authority: only opaque handles this job created.
    await this.options.transport.dispatch(job.owner, "workspace_file_transfer", {
      device: endpoint.device, workspace_id: endpoint.workspace, stream_id: endpoint.stream, action: "close",
    }).catch(() => undefined);
  }
  private cancel(job: Transfer): void {
    if (TERMINAL.has(job.state)) return;
    job.abort.abort();
    job.grant.destroy();
    if (!job.running) { job.state = "cancelled"; this.finish(job); }
    else job.state = "cancelling";
  }
  private finish(job: Transfer): void {
    job.finishedAt = Date.now();
    job.grant.destroy();
  }
  private view(job: Transfer): Record<string, unknown> {
    return {
      transfer_id: job.id, state: job.state,
      source: { device: job.source.device, workspace_id: job.source.workspace, relative_path: job.source.path },
      destination: { device: job.destination.device, workspace_id: job.destination.workspace, relative_path: job.destination.path },
      bytes_copied: job.bytes.toString(), ...(job.size === undefined ? {} : { total_bytes: job.size.toString() }),
      ...(job.digest ? { digest: job.digest } : {}), ...(job.error ? { error: job.error.slice(0, 500) } : {}),
      ...(job.pending ? { pending_call_id: job.pending } : {}),
      ...(job.state === "indeterminate" ? { instruction: "Inspect the destination and its SHA-256 before retrying; atomic commit may have completed." } : {}),
    };
  }
  revokeDevice(owner: string, device: string): void {
    for (const job of this.jobs.values()) if (job.owner === owner
      && [job.origin, job.source.device, job.destination.device].includes(device)) this.cancel(job);
    this.authority.revokeScope(owner, device);
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweep);
    for (const job of this.jobs.values()) this.cancel(job);
    await Promise.allSettled([...this.jobs.values()].map((job) => job.running));
  }
}
function count(value: unknown): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error("invalid transfer byte count");
  return BigInt(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid file transfer response");
  return value as Record<string, unknown>;
}
function message(error: unknown): string { return error instanceof Error ? error.message : "file transfer failed"; }
