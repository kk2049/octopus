import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WORKSPACE_DEVELOPMENT_PROTOCOL, WORKSPACE_DEVELOPMENT_LIMITS,
  type WorkspaceDevelopmentMethod, type WorkspaceDevelopmentIdentity, type WorkspaceDevelopmentStatus,
  type WorkspaceDevelopmentCandidate, type WorkspaceDevelopmentArtifact } from "@claude-bot/runner/workspace-development-protocol";
import type { TicketDevelopmentBinding, TicketDevelopmentOperation, TicketDevelopmentRepository } from "../store/repositories/ticket-development.js";
import type { TicketRunnerBinding } from "../store/repositories/ticket-runner.js";
import type { BundleHandoff } from "./bundle-handoff.js";
import { git, gitOrThrow } from "./worktree.js";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
export interface DevelopmentTurnBinding { owner: string; ticketId: number; turn: number; developmentId: string }
export interface DevelopmentMcpCredential { token: string; endpoint: string; expiresAt: number; release(): void }
export class DevelopmentWorkspaceError extends Error {
  constructor(readonly code: "dirty" | "mid_rebase" | "base_moved" | "unavailable" | "unknown" | "invalid_candidate", message: string, readonly requiredHeadSha?: string) { super(message); }
}
export interface DevelopmentWorkspaceOptions {
  repository: TicketDevelopmentRepository; repoDir: string; stateDir: string; baseBranch: string; repositoryId: string;
  publicUrl: string; bundles: BundleHandoff;
  /** Opens the original owner/device/parent capability on every use. */
  call(binding: TicketDevelopmentBinding, method: WorkspaceDevelopmentMethod, args: Record<string, unknown>): Promise<unknown>;
  /** Inventory and authorization preflight, not a replacement for the capability. */
  available(binding: TicketDevelopmentBinding): boolean;
  /** A typed transient error only after ownership/authorization were checked. */
  assertAvailable?(binding: TicketDevelopmentBinding): void;
  withGitLock<T>(work: () => Promise<T>): Promise<T>;
  pollMs?: number; timeoutMs?: number;
}
/** Head coordination only: Runner owns development; Head owns verified candidate custody. */
export class DevelopmentWorkspaceService {
  private readonly active = new Set<number>();
  constructor(private readonly opts: DevelopmentWorkspaceOptions) {}
  binding(ticketId: number): TicketDevelopmentBinding | null { return this.opts.repository.binding(ticketId); }
  private identity(binding: TicketDevelopmentBinding): WorkspaceDevelopmentIdentity {
    return { workspace_id: binding.parentWorkspaceId, repository_id: binding.repositoryId, development_id: binding.developmentId, ticket_id: binding.ticketId };
  }
  private async exclusive<T>(ticketId: number, work: () => Promise<T>): Promise<T> {
    if (this.active.has(ticketId)) throw new DevelopmentWorkspaceError("unavailable", "本票开发工作区操作仍在执行，请查询原操作，不能并发改写候选。");
    this.active.add(ticketId);
    try { return await work(); } finally { this.active.delete(ticketId); }
  }
  private bound(ticketId: number): TicketDevelopmentBinding {
    const binding = this.binding(ticketId);
    if (!binding) throw new DevelopmentWorkspaceError("unavailable", "原开发工作区绑定不存在。");
    this.opts.assertAvailable?.(binding);
    if (!this.opts.available(binding)) throw new DevelopmentWorkspaceError("unavailable", "原开发工作区不可用，请检查设备能力与工作区授权。");
    return binding;
  }
  private decode(binding: TicketDevelopmentBinding, raw: unknown): WorkspaceDevelopmentStatus {
    const row = raw as WorkspaceDevelopmentStatus | null;
    if (!row || row.protocol !== WORKSPACE_DEVELOPMENT_PROTOCOL || Object.entries(this.identity(binding)).some(([key, value]) => row[key as keyof WorkspaceDevelopmentIdentity] !== value)) {
      throw new DevelopmentWorkspaceError("unknown", "开发操作回执身份不匹配，未重播操作。");
    }
    if (row.development && (!/^ws_[0-9a-f]{24}$/.test(row.development.worktree_workspace_id)
      || row.development.base_sha !== binding.baseSha || !SHA.test(row.development.head_sha) || !SHA.test(row.development.synced_head_sha)
      || typeof row.development.dirty !== "boolean" || typeof row.development.conflicted !== "boolean"
      || (binding.worktreeWorkspaceId && row.development.worktree_workspace_id !== binding.worktreeWorkspaceId))) {
      throw new DevelopmentWorkspaceError("unknown", "开发工作区回执无法验证。");
    }
    return row;
  }
  private async status(binding: TicketDevelopmentBinding, requestId?: string): Promise<WorkspaceDevelopmentStatus> {
    return this.decode(binding, await this.opts.call(binding, "workspace_development_status", { ...this.identity(binding), ...(requestId ? { request_id: requestId } : {}) }));
  }
  async facts(ticketId: number): Promise<WorkspaceDevelopmentStatus> { return this.status(this.bound(ticketId)); }
  private async input(sha: string, basis?: string): Promise<{ value: { url: string; sha256: string; bytes: number }; revoke(): void }> {
    await fs.mkdir(this.opts.stateDir, { recursive: true });
    const file = path.join(this.opts.stateDir, `source-${randomUUID()}.bundle`);
    try {
      // A private detached no-checkout tree gives the wire its one fixed HEAD
      // without changing v4 or a caller-owned directory.
      const sourceTree = path.join(this.opts.stateDir, `source-tree-${randomUUID()}`);
      await this.opts.withGitLock(async () => {
        await gitOrThrow(this.opts.repoDir, ["worktree", "add", "--detach", "--no-checkout", sourceTree, sha]);
        try {
          const incremental = basis && SHA.test(basis) && basis !== sha
            && (await git(this.opts.repoDir, ["merge-base", "--is-ancestor", basis, sha])).ok ? [`^${basis}`] : [];
          await gitOrThrow(sourceTree, ["bundle", "create", file, "HEAD", ...incremental]);
        }
        finally { await gitOrThrow(this.opts.repoDir, ["worktree", "remove", "--force", sourceTree]); }
      });
      const heads = (await gitOrThrow(this.opts.repoDir, ["bundle", "list-heads", file])).split("\n").filter(Boolean);
      if (heads.length !== 1 || heads[0] !== `${sha} HEAD`) throw new DevelopmentWorkspaceError("base_moved", "权威水位在源码打包期间变化，请重新同步。", await this.head());
      const bytes = (await fs.stat(file)).size;
      if (bytes < 1 || bytes > WORKSPACE_DEVELOPMENT_LIMITS.bundleBytes) throw new Error("development source bundle exceeds byte limit");
      const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk);
      const token = this.opts.bundles.offer(file, { cleanup: true, purpose: "development-source", identity: sha });
      return { value: { url: `${this.opts.publicUrl.replace(/\/+$/, "")}/api/contrib/bundle/${token}`, sha256: hash.digest("hex"), bytes }, revoke: () => this.opts.bundles.revoke(token) };
    } catch (error) { await fs.rm(file, { force: true }); throw error; }
  }
  async head(): Promise<string> { return await gitOrThrow(this.opts.repoDir, ["rev-parse", this.opts.baseBranch]); }
  private async operation(binding: TicketDevelopmentBinding, action: TicketDevelopmentOperation["action"], args: Record<string, unknown>, sourceSha?: string, sourceBasis?: string): Promise<WorkspaceDevelopmentStatus> {
    const key = JSON.stringify([action, args]);
    let operation = this.opts.repository.operation(binding.ticketId, key);
    if (!operation || (operation.state === "finished" && operation.receipt?.operation?.state === "failed")) {
      operation = { id: `dev_${randomUUID().replace(/-/g, "")}`, ticketId: binding.ticketId, key, action, args, state: "prepared" };
      this.opts.repository.save(operation);
    }
    let row: WorkspaceDevelopmentStatus;
    if (operation.state === "finished" && operation.receipt) row = operation.receipt;
    else if (operation.state === "dispatched") row = await this.status(binding, operation.id);
    else {
      const source = sourceSha ? await this.input(sourceSha, sourceBasis) : null;
      try {
        operation = { ...operation, state: "dispatched" };
        this.opts.repository.save(operation); // Dispatch barrier: never persist bearer URL.
        try {
          row = this.decode(binding, await this.opts.call(binding, `workspace_development_${action}`, {
            ...this.identity(binding), ...args, request_id: operation.id, ...(source ? { input: source.value } : {}),
          }));
        } catch { row = await this.status(binding, operation.id); }
      } finally { /* BundleHandoff retains the one-shot input until download or expiry; accepted is not consumed. */ }
    }
    const started = Date.now();
    for (;;) {
      if (row.operation?.request_id !== operation.id || row.operation.action !== action
        || !["accepted", "running", "succeeded", "failed", "unknown", "missing"].includes(row.operation.state)) {
        throw new DevelopmentWorkspaceError("unknown", "原开发操作没有可信回执，未新建或重播。");
      }
      if (row.operation.state === "succeeded" || row.operation.state === "failed") {
        this.opts.repository.save({ ...operation, state: "finished", receipt: row });
        if (row.operation.state === "failed") throw new DevelopmentWorkspaceError(
          row.operation.error === "dirty_worktree" ? "dirty" : row.operation.error === "conflicted_worktree" ? "mid_rebase" : "unavailable",
          `开发操作被拒绝：${row.operation.error ?? "internal_error"}。保留原工作区，未发送 Agent 输入。`);
        return row;
      }
      if (row.operation.state === "unknown" || row.operation.state === "missing" || Date.now() - started >= (this.opts.timeoutMs ?? 125000)) {
        throw new DevelopmentWorkspaceError("unknown", `原开发操作 ${operation.id} 状态未知；保留原 request_id 查询，不自动重播。`);
      }
      await delay(this.opts.pollMs ?? 250);
      row = await this.status(binding, operation.id);
    }
  }
  async prepare(ticketId: number, runner: TicketRunnerBinding): Promise<TicketDevelopmentBinding> {
    return this.exclusive(ticketId, async () => {
      let binding = this.binding(ticketId);
      if (!binding) {
        binding = { ticketId, owner: runner.owner, ...(runner.requester ? { requester: runner.requester } : {}), device: runner.executionDevice || runner.device, parentWorkspaceId: runner.workspaceId,
          repositoryId: this.opts.repositoryId, developmentId: `ticket_${ticketId}_${randomUUID().replace(/-/g, "")}`, baseSha: await this.head() };
        this.opts.repository.bind(binding);
      }
      if (binding.owner !== runner.owner || binding.requester !== runner.requester || binding.device !== (runner.executionDevice || runner.device)
        || (runner.workspaceId !== binding.parentWorkspaceId && runner.workspaceId !== binding.worktreeWorkspaceId)) throw new Error("ticket development placement mismatch");
      this.bound(ticketId);
      let row: WorkspaceDevelopmentStatus;
      if (binding.worktreeWorkspaceId) row = await this.status(binding);
      else {
        const args = { base_sha: binding.baseSha };
        try { row = await this.operation(binding, "prepare", args); }
        catch (error) {
          const refused = this.opts.repository.operation(ticketId, JSON.stringify(["prepare", args]));
          if (refused?.state !== "finished" || refused.receipt?.operation?.state !== "failed" || refused.receipt.operation.error !== "base_missing") throw error;
          // A proven absent base admits a fresh request with bounded source bytes.
          // Lost/unknown acknowledgements never take this branch.
          row = await this.operation(binding, "prepare", args, binding.baseSha);
        }
      }
      if (!row.development) throw new DevelopmentWorkspaceError("unknown", "Runner 尚未确认开发子工作区。");
      binding = { ...binding, worktreeWorkspaceId: row.development.worktree_workspace_id };
      this.opts.repository.bind(binding);
      return binding;
    });
  }
  async sync(ticketId: number): Promise<WorkspaceDevelopmentStatus> {
    return this.exclusive(ticketId, async () => {
      const binding = this.bound(ticketId), sha = await this.head();
      const previous = (await this.status(binding)).development?.synced_head_sha;
      return await this.operation(binding, "sync", { base_sha: binding.baseSha, target_sha: sha }, previous === sha ? undefined : sha, previous);
    });
  }
  /** Copies only a clean immutable candidate. Never writes the Runner worktree. */
  async importCandidate(ticketId: number, candidateDirectory: string, requireCurrentBase: boolean): Promise<WorkspaceDevelopmentCandidate | null> {
    return this.exclusive(ticketId, async () => {
      const binding = this.bound(ticketId), facts = await this.status(binding), snapshot = facts.development;
      if (!snapshot) throw new DevelopmentWorkspaceError("unknown", "原开发工作区不可读。");
      if (snapshot.conflicted) throw new DevelopmentWorkspaceError("mid_rebase", "Runner 开发树仍有冲突，请在原工作区解决并完成 rebase。");
      if (snapshot.dirty) throw new DevelopmentWorkspaceError("dirty", "Runner 开发树有未提交内容；先 commit，再运行上下文、CI 或 submit，不能忽略未提交改动。");
      const required = await this.head();
      if (requireCurrentBase && snapshot.synced_head_sha !== required) throw new DevelopmentWorkspaceError("base_moved", "Head 水位已推进；请 devpipe_workspace_sync，在 Runner 原工作区 rebase 并复验。", required);
      if (snapshot.head_sha === required || (!requireCurrentBase && snapshot.head_sha === snapshot.synced_head_sha)) {
        await this.opts.withGitLock(async () => {
          if (await gitOrThrow(candidateDirectory, ["status", "--porcelain"])) throw new DevelopmentWorkspaceError("dirty", "Head 候选目录有未提交内容，拒绝覆盖。");
          await gitOrThrow(candidateDirectory, ["reset", "--hard", snapshot.head_sha]);
        });
        return null;
      }
      const base = requireCurrentBase ? required : snapshot.synced_head_sha;
      const exportArgs = { expected_base_sha: base, expected_head_sha: snapshot.head_sha };
      let row: WorkspaceDevelopmentStatus;
      try { row = await this.operation(binding, "export", exportArgs); }
      catch (error) {
        const refused = this.opts.repository.operation(ticketId, JSON.stringify(["export", exportArgs]));
        if (refused?.receipt?.operation?.state === "failed" && refused.receipt.operation.error === "head_mismatch"
          && refused.receipt.development?.head_sha === snapshot.head_sha) {
          throw new DevelopmentWorkspaceError("base_moved", "Runner 候选尚未包含已同步的权威基线；请在原开发树 rebase、解决冲突并复验。", required);
        }
        throw error;
      }
      const candidate = row.operation?.candidate;
      if (!candidate || !ID.test(candidate.candidate_id) || candidate.development_id !== binding.developmentId || candidate.base_sha !== base
        || candidate.head_sha !== snapshot.head_sha || candidate.clean !== true || !candidate.bundle || candidate.bundle.artifact_id !== "source.bundle"
        || !DIGEST.test(candidate.bundle.sha256) || !Number.isSafeInteger(candidate.bundle.bytes) || candidate.bundle.bytes < 1 || candidate.bundle.bytes > WORKSPACE_DEVELOPMENT_LIMITS.bundleBytes) {
        throw new DevelopmentWorkspaceError("invalid_candidate", "候选身份、基线、提交或摘要不匹配。");
      }
      this.opts.repository.saveCandidate({ ticketId, candidate, imported: false });
      await fs.mkdir(this.opts.stateDir, { recursive: true });
      const bundle = path.join(this.opts.stateDir, `candidate-${ticketId}-${randomUUID()}.bundle`);
      const temporary = `${bundle}.${randomUUID()}.partial`;
      const handle = await fs.open(temporary, "wx", 0o600), hash = createHash("sha256");
      try {
        for (let offset = 0; offset < candidate.bundle.bytes;) {
          const length = Math.min(WORKSPACE_DEVELOPMENT_LIMITS.artifactChunkBytes, candidate.bundle.bytes - offset);
          const part = await this.opts.call(binding, "workspace_development_artifact", { ...this.identity(binding), candidate_id: candidate.candidate_id,
            artifact_id: candidate.bundle.artifact_id, offset, length }) as WorkspaceDevelopmentArtifact;
          const bytes = typeof part?.data === "string" ? Buffer.from(part.data, "base64") : Buffer.alloc(0);
          if (part?.protocol !== WORKSPACE_DEVELOPMENT_PROTOCOL || Object.entries(this.identity(binding)).some(([key, value]) => part[key as keyof WorkspaceDevelopmentIdentity] !== value)
            || part.candidate_id !== candidate.candidate_id || part.artifact_id !== candidate.bundle.artifact_id || part.offset !== offset
            || part.total !== candidate.bundle.bytes || part.bytes !== bytes.length || bytes.length < 1 || bytes.length > length
            || part.eof !== (offset + bytes.length === candidate.bundle.bytes)) throw new DevelopmentWorkspaceError("invalid_candidate", "候选分块回执不一致。");
          hash.update(bytes); await handle.writeFile(bytes); offset += bytes.length;
        }
        await handle.sync();
      } catch (error) { await handle.close(); await fs.rm(temporary, { force: true }); throw error; }
      await handle.close();
      if (hash.digest("hex") !== candidate.bundle.sha256) { await fs.rm(temporary); throw new DevelopmentWorkspaceError("invalid_candidate", "候选 bundle 摘要不一致。"); }
      await fs.rename(temporary, bundle);
      try {
        await this.opts.withGitLock(async () => {
          const heads = (await gitOrThrow(this.opts.repoDir, ["bundle", "list-heads", bundle])).split("\n").filter(Boolean);
          if (heads.length !== 1 || heads[0] !== `${candidate.head_sha} HEAD`) throw new DevelopmentWorkspaceError("invalid_candidate", "候选 bundle 必须只含已声明的 HEAD。");
          await gitOrThrow(this.opts.repoDir, ["bundle", "verify", bundle]);
          const current = await this.head();
          if (requireCurrentBase && current !== candidate.base_sha) throw new DevelopmentWorkspaceError("base_moved", "Head 水位已推进；请 devpipe_workspace_sync，再在 Runner 原工作区 rebase、解决冲突并重新提交。", current);
          await gitOrThrow(this.opts.repoDir, ["fetch", "--no-tags", "--no-write-fetch-head", bundle, "HEAD"]);
          if (!(await git(this.opts.repoDir, ["merge-base", "--is-ancestor", candidate.base_sha, candidate.head_sha])).ok) throw new DevelopmentWorkspaceError("base_moved", "候选未包含权威基线；请在 Runner 同步并解决冲突。", current);
          if (await gitOrThrow(candidateDirectory, ["status", "--porcelain"])) throw new DevelopmentWorkspaceError("dirty", "Head 候选目录存在未提交改动，拒绝覆盖。");
          await gitOrThrow(candidateDirectory, ["reset", "--hard", candidate.head_sha]);
          this.opts.repository.saveCandidate({ ticketId, candidate, imported: true });
        });
      } finally { await fs.rm(bundle, { force: true }); }
      return candidate;
    });
  }
}
