import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { BundleHandoff } from "./bundle-handoff.js";
import { git, gitOrThrow } from "./worktree.js";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "../logger.js";
import type { WorkspaceSourceState } from "./workspace-source.js";
const log = createLogger("workspace-provider");
import type { WorkspaceJobGrant } from "./workspace-job-capability.js";
import type { WorkspaceJobStatus } from "@claude-bot/runner/workspace-jobs";

export interface WorkspaceProviderTarget { owner: string; device: string; workspaceId: string }
export interface WorkspaceTask { key: string; workspaceKey: string; sha: string; command: string; timeoutMs: number; sourceDir?: string;
  files?: Array<{ name: string; file: string }> }
interface Intent { version: 1; jobId: string; target: WorkspaceProviderTarget; task: Omit<WorkspaceTask, "sourceDir" | "files"> & {
  prepare: boolean; files?: Array<{ name: string; bytes: number; sha256: string }> }; submitted: boolean; cancelRequested?: boolean }
export class WorkspaceProviderUnavailable extends Error {}
export class WorkspaceProviderUnknown extends Error {}
/** Durable control-side intent belongs to a fixed owner/device/workspace. Rebinds never move a job. */
export class WorkspaceProvider {
  private readonly pending = new Map<string, Promise<WorkspaceJobStatus>>();
  private cancellationTimer: ReturnType<typeof setInterval> | undefined;
  private reconciling = false;
  /** Re-deliver only durable cancellation requests; never starts or replays work. */
  startCancellationRecovery(): void {
    if (this.cancellationTimer) return;
    this.cancellationTimer = setInterval(() => { void this.reconcileCancellations().catch(() => undefined); }, 10000);
    this.cancellationTimer.unref();
    void this.reconcileCancellations().catch(() => undefined);
  }
  close(): void { if (this.cancellationTimer) clearInterval(this.cancellationTimer); this.cancellationTimer = undefined; }
  async reconcileCancellations(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const intent of await this.intents()) {
        if (!intent.cancelRequested || JSON.stringify(intent.target) !== JSON.stringify(this.target)) continue;
        try {
          const status = await this.query(intent.task.key);
          if (["succeeded", "failed", "cancelled", "timed_out"].includes(status.state)) {
            intent.cancelRequested = false;
            await this.writeIntent(this.intentFile(intent.task.key), intent);
          }
        } catch { /* Durable request remains pending until this original target returns. */ }
      }
    } finally { this.reconciling = false; }
  }
  private async intents(): Promise<Intent[]> {
    const files = await fs.readdir(this.opts.stateDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    return await Promise.all(files.filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).map(async (file) =>
      JSON.parse(await fs.readFile(path.join(this.opts.stateDir, file), "utf8")) as Intent));
  }
  constructor(readonly target: WorkspaceProviderTarget, private readonly opts: {
    stateDir: string; publicUrl: string; bundles: BundleHandoff;
    status: () => string; open: () => WorkspaceJobGrant | null;
    pollMs?: number; recoveryMs?: number;
    /** Read the actual destination object store; never mutate an executing workspace. */
    sourceState?: (task: WorkspaceTask) => Promise<WorkspaceSourceState>;
  }) {}
  private id(key: string): string {
    return `ci_${createHash("sha256").update(JSON.stringify([this.target, key])).digest("hex")}`;
  }
  private intentFile(key: string): string {
    return path.join(this.opts.stateDir, `${createHash("sha256").update(key).digest("hex")}.json`);
  }
  private async checkedId(key: string): Promise<string> {
    try {
      const intent = JSON.parse(await fs.readFile(this.intentFile(key), "utf8")) as Intent;
      if (JSON.stringify(intent.target) !== JSON.stringify(this.target)) throw new WorkspaceProviderUnknown("original workspace task belongs to another provider placement; do not dispatch to the new target");
      return intent.jobId;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.id(key); throw error; }
  }
  private async call(operation: string, args: Record<string, unknown>): Promise<unknown> {
    const availability = this.opts.status();
    if (availability !== "available") throw new WorkspaceProviderUnavailable(`workspace provider ${this.target.owner}/${this.target.device}: ${availability}`);
    const grant = this.opts.open();
    if (!grant) throw new WorkspaceProviderUnavailable("workspace provider authorization unavailable");
    try { return await grant.call(operation, args); } finally { grant.close(); }
  }
  private decode(raw: unknown, jobId: string): WorkspaceJobStatus {
    const row = raw as WorkspaceJobStatus;
    if (!row || row.protocol !== "workspace-jobs/v1" || row.job_id !== jobId || row.workspace_id !== this.target.workspaceId
      || !["accepted", "running", "succeeded", "failed", "cancelled", "timed_out", "unknown", "missing", "not_started"].includes(row.state)) {
      throw new WorkspaceProviderUnknown(`invalid workspace receipt for ${jobId}; do not replay`);
    }
    return row;
  }
  async query(key: string): Promise<WorkspaceJobStatus> {
    const jobId = await this.checkedId(key);
    const status = this.decode(await this.call("workspace_job_status", { job_id: jobId }), jobId);
    const intent = await fs.readFile(this.intentFile(key), "utf8").then((text) => JSON.parse(text) as Intent).catch(() => null);
    if (intent && status.state !== "missing" && (status.repo_sha !== intent.task.sha || status.workspace_key !== intent.task.workspaceKey)) {
      throw new WorkspaceProviderUnknown("workspace receipt source binding mismatch");
    }
    if (intent?.cancelRequested && ["accepted", "running"].includes(status.state)) {
      return this.decode(await this.call("workspace_job_cancel", { job_id: jobId }), jobId);
    }
    return status;
  }
  async cancel(key: string): Promise<WorkspaceJobStatus> {
    const jobId = await this.checkedId(key);
    const file = this.intentFile(key);
    const intent = JSON.parse(await fs.readFile(file, "utf8")) as Intent;
    intent.cancelRequested = true;
    await this.writeIntent(file, intent);
    return this.decode(await this.call("workspace_job_cancel", { job_id: jobId }), jobId);
  }
  async cancelTicket(ticketId: number): Promise<void> {
    await fs.mkdir(this.opts.stateDir, { recursive: true, mode: 0o700 });
    const marker = await fs.open(path.join(this.opts.stateDir, `ticket-${ticketId}-cancelled`), "a", 0o600);
    try { await marker.sync(); } finally { await marker.close(); }
    const parent = await fs.open(this.opts.stateDir, "r");
    try { await parent.sync(); } finally { await parent.close(); }
    const intents = (await this.intents()).filter((intent) => intent.task.key.startsWith(`ticket:${ticketId}:`));
    // Persist every request before attempting any possibly-offline target.
    for (const intent of intents) {
      intent.cancelRequested = true;
      await this.writeIntent(this.intentFile(intent.task.key), intent);
    }
    const results = await Promise.allSettled(intents.map((intent) => this.query(intent.task.key)));
    if (results.some((result) => result.status === "rejected")) throw new WorkspaceProviderUnavailable("ticket cancellation persisted; original provider has not confirmed it yet");
  }

  private async writeIntent(file: string, intent: Intent): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const h = await fs.open(temporary, "wx", 0o600);
    try { await h.writeFile(JSON.stringify(intent)); await h.sync(); } finally { await h.close(); }
    await fs.rename(temporary, file);
    const parent = await fs.open(this.opts.stateDir, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
  async log(key: string, offset = 0, length = 65536): Promise<{ text: string; offset: number; bytes: number; eof: boolean }> {
    const jobId = await this.checkedId(key);
    const row = await this.call("workspace_job_read", { job_id: jobId, offset, length }) as Record<string, unknown>;
    if (row.protocol !== "workspace-jobs/v1" || row.job_id !== jobId || row.workspace_id !== this.target.workspaceId || row.offset !== offset
      || !Number.isInteger(row.bytes) || Number(row.bytes) < 0 || Number(row.bytes) > length || typeof row.data !== "string") throw new WorkspaceProviderUnknown("invalid workspace log receipt");
    const bytes = Buffer.from(row.data, "base64");
    if (bytes.length !== row.bytes) throw new WorkspaceProviderUnknown("workspace log byte count mismatch");
    return { text: bytes.toString("utf8"), offset, bytes: bytes.length, eof: row.eof === true };
  }
  async submit(task: WorkspaceTask): Promise<WorkspaceJobStatus> {
    const previous = this.pending.get(task.key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => this.submitOnce(task));
    this.pending.set(task.key, result);
    try { return await result; } finally { if (this.pending.get(task.key) === result) this.pending.delete(task.key); }
  }
  async artifact(key: string, name: string, offset = 0, length = 1048576, signal?: AbortSignal): Promise<{ data: Buffer; total: number; eof: boolean }> {
    signal?.throwIfAborted();
    const jobId = await this.checkedId(key);
    // Retrying a bounded read cannot replay execution. Keep the same offset across short network outages.
    const started = Date.now();
    let row: Record<string, unknown>;
    for (;;) {
      signal?.throwIfAborted();
      try { row = await this.call("workspace_job_artifact", { job_id: jobId, name, offset, length }) as Record<string, unknown>; break; }
      catch (error) {
        if (Date.now() - started >= (this.opts.recoveryMs ?? 180000)) throw new WorkspaceProviderUnavailable(`artifact read interrupted for ${jobId}; resume original byte offset: ${String(error)}`);
        await delay(Math.min(3000, this.opts.recoveryMs ?? 3000), undefined, { signal });
      }
    }
    const intent = JSON.parse(await fs.readFile(this.intentFile(key), "utf8")) as Intent;
    if (row.protocol !== "workspace-jobs/v1" || row.job_id !== jobId || row.workspace_id !== this.target.workspaceId
      || row.repo_sha !== intent.task.sha
      || row.name !== name || row.offset !== offset || !Number.isSafeInteger(row.total) || Number(row.total) < 0
      || !Number.isInteger(row.bytes) || Number(row.bytes) < 0 || Number(row.bytes) > length || typeof row.data !== "string") {
      throw new WorkspaceProviderUnknown("invalid workspace artifact receipt");
    }
    const data = Buffer.from(row.data, "base64");
    if (data.length !== row.bytes || offset + data.length > Number(row.total) || row.eof !== (offset + data.length === row.total)) throw new WorkspaceProviderUnknown("workspace artifact byte count mismatch");
    return { data, total: Number(row.total), eof: row.eof === true };
  }
  private async submitOnce(task: WorkspaceTask): Promise<WorkspaceJobStatus> {
    if (!/^[0-9a-f]{40}$/.test(task.sha)) throw new Error("workspace tasks require exact SHA");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(task.workspaceKey) || !task.command.trim()
      || !Number.isInteger(task.timeoutMs) || task.timeoutMs < 1000 || task.timeoutMs > 2700000) throw new Error("invalid workspace task command, key or deadline");
    const { sourceDir, files, ...fields } = task;
    if (files && (files.length > 8 || new Set(files.map(f => f.name)).size !== files.length)) throw new Error("invalid workspace side input list");
    const fileMetadata = files ? await Promise.all(files.map(async (file) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(file.name)) throw new Error("invalid workspace side input name");
      const stat = await fs.stat(file.file);
      if (!stat.isFile() || stat.size < 1 || stat.size > 32 * 1024 * 1024) throw new Error("invalid workspace side input size");
      const hash = createHash("sha256"); for await (const bytes of createReadStream(file.file)) hash.update(bytes);
      return { name: file.name, bytes: stat.size, sha256: hash.digest("hex") };
    })) : undefined;
    if (fileMetadata && fileMetadata.reduce((total, f) => total + f.bytes, 0) > 64 * 1024 * 1024) throw new Error("workspace side inputs exceed budget");
    const publicTask = { ...fields, prepare: Boolean(sourceDir), ...(fileMetadata ? { files: fileMetadata } : {}) };
    const jobId = this.id(task.key), file = this.intentFile(task.key);
    await fs.mkdir(this.opts.stateDir, { recursive: true, mode: 0o700 });
    let prior: Intent | null;
    try { prior = JSON.parse(await fs.readFile(file, "utf8")) as Intent; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; prior = null; }
    if (prior) {
      if (JSON.stringify(prior.target) !== JSON.stringify(this.target) || JSON.stringify(prior.task) !== JSON.stringify(publicTask)) throw new Error("workspace task key already binds different input or placement");
      const status = await this.query(task.key);
      if (status.state === "missing" && prior.submitted) throw new WorkspaceProviderUnknown(`workspace task ${jobId} disappeared after dispatch; do not replay`);
      if (status.state !== "missing") return status;
    }
    // Preflight availability before recording dispatch intent. A preflight
    // rejection proves no start was sent; dispatch uncertainty never does.
    if (this.opts.status() !== "available") throw new WorkspaceProviderUnavailable(`workspace provider ${this.target.device} unavailable before dispatch`);
    let input: Record<string, unknown> = {}, offer: string | undefined, bundle: string | undefined;
    try {
      if (files && fileMetadata) {
        const uploads = await Promise.all(files.map(async (file, index) => {
          const meta = fileMetadata[index];
          // Own the offered bytes: the caller may remove its temporary input as soon as observation stops.
          const snapshot = path.join(this.opts.stateDir, `input-${randomUUID()}`);
          await fs.copyFile(file.file, snapshot);
          await fs.chmod(snapshot, 0o600);
          const offer = this.opts.bundles.offer(snapshot, { cleanup: true, purpose: "workspace-side-input", identity: meta.sha256 });
          return { ...meta, url: `${this.opts.publicUrl.replace(/\/+$/, "")}/api/contrib/bundle/${offer}` };
        }));
        input.files_json = JSON.stringify(uploads);
        log.info({ key: task.key, sha: task.sha, direction: "outbound", bytes: fileMetadata.reduce((n, f) => n + f.bytes, 0) }, "workspace side inputs offered");
      }
      if (sourceDir) {
        if (await gitOrThrow(sourceDir, ["rev-parse", "HEAD"]) !== task.sha) throw new Error("source SHA changed before bundle preparation");
        const remote = await this.opts.sourceState?.(task);
        const basis: string[] = [];
        if (remote?.head !== task.sha) {
          for (const sha of [...new Set(remote?.refs ?? [])].slice(0, 64)) {
            if (!/^[0-9a-f]{40}$/.test(sha) || sha === task.sha) continue;
            if ((await git(sourceDir, ["merge-base", "--is-ancestor", sha, task.sha])).ok) basis.push(sha);
          }
          bundle = path.join(this.opts.stateDir, `bundle-${randomUUID()}.git`);
          await gitOrThrow(sourceDir, ["bundle", "create", bundle, "HEAD", ...basis.map((sha) => `^${sha}`)]);
          const bytes = (await fs.stat(bundle)).size;
          if (bytes > 128 * 1024 * 1024) throw new Error("workspace input bundle exceeds 128 MiB");
          const hash = createHash("sha256"); for await (const chunk of createReadStream(bundle)) hash.update(chunk);
          offer = this.opts.bundles.offer(bundle, { cleanup: true, purpose: "workspace-source", identity: task.sha });
          log.info({ key: task.key, sha: task.sha, direction: "outbound", bytes, basisCount: basis.length }, "workspace source bundle offered");
          input = { ...input, input_url: `${this.opts.publicUrl.replace(/\/+$/, "")}/api/contrib/bundle/${offer}`, input_sha256: hash.digest("hex"), input_bytes: bytes };
        } else {
          log.info({ key: task.key, sha: task.sha, direction: "outbound", bytes: 0 }, "workspace source already at requested commit");
        }
      }
      const intent: Intent = { version: 1, jobId, target: this.target, task: publicTask, submitted: true };
      if (prior) await this.writeIntent(file, intent);
      else {
        const h = await fs.open(file, "wx", 0o600);
        try { await h.writeFile(JSON.stringify(intent)); await h.sync(); } finally { await h.close(); }
      }
      const parent = await fs.open(this.opts.stateDir, "r");
      try { await parent.sync(); } finally { await parent.close(); }
      const ticketId = /^ticket:(\d+):/.exec(task.key)?.[1];
      if (ticketId && await fs.stat(path.join(this.opts.stateDir, `ticket-${ticketId}-cancelled`)).then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false; throw error;
      })) {
        intent.submitted = false; intent.cancelRequested = false;
        await this.writeIntent(file, intent);
        return { protocol: "workspace-jobs/v1", job_id: jobId, workspace_id: this.target.workspaceId,
          workspace_key: task.workspaceKey, repo_sha: task.sha, state: "not_started", error: "ticket_cancelled" };
      }
      try {
        const status = this.decode(await this.call("workspace_job_start", { job_id: jobId, workspace_key: task.workspaceKey, repo_sha: task.sha,
          command: task.command, timeout_ms: task.timeoutMs, ...input }), jobId);
        if (status.repo_sha !== task.sha || status.workspace_key !== task.workspaceKey) throw new WorkspaceProviderUnknown("workspace receipt source binding mismatch");
        if (status.state === "not_started") {
          intent.submitted = false;
          await this.writeIntent(file, intent);
        }
        return status;
      } catch (error) {
        // Even if the transport's start response is lost, query is safe. A
        // missing result remains unknown; it does not authorize another start.
        try { const status = await this.query(task.key); if (status.state !== "missing") return status; } catch { /* report uncertainty below */ }
        throw new WorkspaceProviderUnknown(`workspace task ${jobId} dispatch unconfirmed; query original task, do not replay: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      // The bundle's one-use request normally consumes it immediately. Do not
      // revoke a start's input before its detached worker has downloaded it.
      if (!offer && bundle) await fs.rm(bundle, { force: true });
    }
  }
  async wait(task: WorkspaceTask, signal?: AbortSignal): Promise<WorkspaceJobStatus> {
    signal?.throwIfAborted();
    let current = await this.submit(task);
    const deadline = Date.now() + task.timeoutMs + (this.opts.recoveryMs ?? 180000);
    let awaySince: number | null = null;
    while (["accepted", "running"].includes(current.state)) {
      if (Date.now() > deadline) throw new WorkspaceProviderUnknown(`workspace task ${current.job_id} observation deadline; query/cancel original task`);
      // Stop observing on service drain; the durable remote task remains alive.
      await delay(this.opts.pollMs ?? 1000, undefined, { signal });
      try { current = await this.query(task.key); awaySince = null; }
      catch (error) {
        awaySince ??= Date.now();
        if (Date.now() - awaySince >= (this.opts.recoveryMs ?? 180000)) throw new WorkspaceProviderUnavailable(`workspace task ${current.job_id} disconnected; task may continue; query original task`);
      }
    }
    signal?.throwIfAborted();
    if (current.state === "unknown" || current.state === "missing") throw new WorkspaceProviderUnknown(`workspace task ${current.job_id} is ${current.state}; do not replay`);
    if (current.repo_sha !== task.sha || current.workspace_key !== task.workspaceKey) throw new WorkspaceProviderUnknown("workspace receipt source binding mismatch");
    return current;
  }
}
