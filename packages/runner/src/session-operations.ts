/** Durable, site-scoped receipts for the ordinary start/append session calls.
 * A receipt is claimed before dispatch. Losing its resident is unknown, never
 * permission to replay a prompt. No prompt or bearer is persisted here.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { SESSION_OPERATION_PROTOCOL, sessionInputReceiptFromWire, type SessionInputReceipt, type SessionOperationReceipt } from "./gateway-protocol.js";
import { LaunchJournal, receiptText } from "./launch-journal.js";
import { siteOperationId } from "./gateway-sites.js";

interface RecordRow extends SessionOperationReceipt {
  fingerprint: string;
  resident: string;
  launch_request_id?: string;
}

export class RunnerSessionOperations {
  private readonly resident = randomUUID();
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly home: string, private readonly capacityReceipt?: (
    sessionId: string, turnId: string,
  ) => { state: "running" | "succeeded" | "failed" | "unknown"; result?: Record<string, unknown> } | undefined) {}

  private file(site: string | undefined, id: string): string {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) throw new Error("invalid session operation id");
    const key = createHash("sha256").update(JSON.stringify([site ?? "primary", id])).digest("hex");
    return path.join(this.home, ".octopus", "session-operations", `${key}.json`);
  }

  private async read(file: string): Promise<RecordRow | null> {
    try { return JSON.parse(await fs.readFile(file, "utf8")) as RecordRow; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  async status(site: string | undefined, id: string): Promise<SessionOperationReceipt> {
    const file = this.file(site, id);
    let row = await this.read(file);
    if (row?.launch_request_id && (!row.session_id || row.state === "running" || row.state === "unknown")) {
      const launch = await new LaunchJournal(this.home).reconcile(row.launch_request_id);
      if (launch?.prepared && !row.session_id) {
        await this.serial(file, async () => {
          const current = await this.read(file);
          if (current && !current.session_id) await this.write(file, { ...current, session_id: launch.prepared!.session_id });
        });
      }
      if (launch?.started && !row.input) {
        await this.updateInput(file, { phase: "provider_accepted", evidence: "launch_identity",
          at: launch.started.at, session_id: launch.started.session_id, transport: launch.started.transport });
      }
      if (launch?.exit) {
        await this.update(file, { ok: launch.exit.code === 0, session_id: launch.started?.session_id ?? launch.prepared?.session_id,
          ...launch.managed_result,
          ...(launch.exit.error ? { error: launch.exit.error } : {}), exit_code: launch.exit.code }, true);
      }
      row = await this.read(file);
    }
    if (!row) return { protocol: SESSION_OPERATION_PROTOCOL, operation_id: id, state: "missing", live_input: "steer-only/v1", native_input: "cli-only/v1" };
    if (row.state === "running" && row.resident !== this.resident && row.session_id && row.input?.turn_id) {
      const recovered = this.capacityReceipt?.(row.session_id, row.input.turn_id);
      if (recovered) {
        if (recovered.state !== "running") {
          await this.update(file, recovered.result ?? { ok: recovered.state === "succeeded" }, true);
        }
        const { fingerprint: _fingerprint, resident: _resident, launch_request_id: _launch, ...receipt } = row;
        return { ...receipt, ...recovered, live_input: "steer-only/v1", native_input: "cli-only/v1" };
      }
    }
    const { fingerprint: _fingerprint, resident, launch_request_id: _launch, ...receipt } = row;
    return { ...receipt, live_input: "steer-only/v1", native_input: "cli-only/v1", state: row.state === "running" && resident !== this.resident ? "unknown" : row.state };
  }

  async submit(
    site: string | undefined,
    id: string,
    method: string,
    args: Record<string, unknown>,
    run: (complete: (result: Record<string, unknown>) => Promise<void>, input: (receipt: SessionInputReceipt) => Promise<void>) => Promise<Record<string, unknown>>,
  ): Promise<SessionOperationReceipt> {
    const file = this.file(site, id);
    // Short-lived execution credentials may rotate on reconnect. Only the
    // approved public request is identity; private dispatch fields are omitted.
    const publicArgs = Object.fromEntries(Object.entries(args)
      .filter(([key]) => !key.startsWith("_octopus_")).sort(([a], [b]) => a.localeCompare(b)));
    const fingerprint = createHash("sha256").update(JSON.stringify([method, publicArgs])).digest("hex");
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const row: RecordRow = { protocol: SESSION_OPERATION_PROTOCOL, operation_id: id,
      state: "running", resident: this.resident, fingerprint,
      ...(method === "start_session" && typeof args.client_request_id === "string"
        ? { launch_request_id: siteOperationId(site, args.client_request_id) } : {}),
      ...(typeof args.id === "string" ? { session_id: args.id } : {}) };
    // Serialize the claim as well as updates. The single resident shares this
    // object across all gateway sockets, so same-site retries join one claim.
    let claimed = false;
    await this.serial(file, async () => {
      const prior = await this.read(file);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("session operation id was reused for a different request");
        return;
      }
      const handle = await fs.open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(row)); await handle.sync(); }
      finally { await handle.close(); }
      await this.syncDirectory(file);
      claimed = true;
    });
    if (claimed) {
      const complete = (result: Record<string, unknown>): Promise<void> => this.update(file, result, true);
      // Dispatch is deliberately independent of the gateway request lifetime.
      void Promise.resolve().then(() => run(complete, (input) => this.updateInput(file, input))).then(
        async (result) => {
          const input = sessionInputReceiptFromWire(result.input);
          if (input) await this.updateInput(file, input);
          await this.update(file, result, method !== "start_session" || result.ok === false);
        },
        (error) => complete({ ok: false, code: "unknown", error: error instanceof Error ? error.message : String(error) }),
      ).catch(() => { /* A durable running receipt remains unknown after a crash. */ });
    }
    return await this.status(site, id);
  }

  private async updateInput(file: string, value: SessionInputReceipt): Promise<void> {
    const input = sessionInputReceiptFromWire(value);
    if (!input) throw new Error("invalid session input evidence");
    await this.serial(file, async () => {
      const row = await this.read(file);
      if (!row) return;
      const ranks = { dispatched: 0, local_queued: 1, provider_accepted: 2, input_observed: 3 };
      if (row.input && ranks[row.input.phase] >= ranks[input.phase]) return;
      await this.write(file, { ...row, input,
        ...(input.session_id ? { session_id: input.session_id } : {}) });
    });
  }

  private async update(file: string, result: Record<string, unknown>, terminal: boolean): Promise<void> {
    await this.serial(file, async () => {
      const row = await this.read(file);
      if (!row || (row.state !== "running" && row.state !== "unknown")) return;
      const publicResult = Object.fromEntries(Object.entries(result).filter(([key]) => [
        "ok", "code", "session_id", "new_session_id", "result_text", "result_text_truncated", "error", "usage", "duration_ms", "exit_code", "timed_out", "turn_id", "transport", "control_action", "confirmed", "queued_submission_id",
      ].includes(key)));
      const sessionId = publicResult.new_session_id ?? publicResult.session_id ?? row.session_id;
      const next: RecordRow = { ...row,
        ...(typeof sessionId === "string" ? { session_id: sessionId } : {}),
        ...(terminal ? { state: result.code === "unknown" ? "unknown" : result.ok === false ? "failed" : "succeeded", result: publicResult } : {}),
      };
      let body = JSON.stringify(next);
      if (Buffer.byteLength(body) > 512 * 1024) {
        // A large transcript must not strand a completed turn as running. The
        // receipt says what it cut; the complete reply stays in the transcript.
        next.result = { ok: result.ok !== false,
          ...(typeof result.result_text === "string"
            ? receiptText(result.result_text)
            : { result_text: "结果过长，请在原会话查看完整输出。", result_text_truncated: true as const }),
          ...(result.result_text_truncated === true ? { result_text_truncated: true as const } : {}),
          ...(typeof result.error === "string" ? { error: result.error.slice(0, 2_000) } : {}),
          receipt_truncated: true };
        body = JSON.stringify(next);
      }
      await this.write(file, next, body);
    });
  }

  private async write(file: string, row: RecordRow, body = JSON.stringify(row)): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
    await this.syncDirectory(file);
  }

  private async serial(file: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(file) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.writes.set(file, next);
    try { await next; } finally { if (this.writes.get(file) === next) this.writes.delete(file); }
  }
  private async syncDirectory(file: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await fs.open(path.dirname(file), "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
