import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { openCodeIndex } from "../knowledge/code-index.js";
import { WorkspaceProviderUnavailable } from "./workspace-provider.js";
import { CONTEXTUAL_RECORD_SCHEMA_DIGEST } from "../knowledge/contextual-record.js";
import {
  EMBEDDING_BINDING_DIGEST,
  MULTILINGUAL_E5_SMALL_BINDING,
  canonicalJson,
  verifyLocalModelDirectory,
} from "../knowledge/model-binding.js";
import { createLogger } from "../logger.js";
import type { BundleHandoff } from "./bundle-handoff.js";
import type { KnowledgeGraphService, VerifiedGenerationDigests } from "./knowledge-graph-service.js";

const log = createLogger("knowledge-artifact");
const CHUNK_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const RECONCILE_MS = 30_000;
/** One remote status/start/cancel/read call may not silently outlive the transport's own ceiling. */
const REMOTE_CALL_DEADLINE_MS = 6 * 60_000;
/** Source materialisation legitimately includes a bundle sync plus install. */
const SOURCE_SYNC_DEADLINE_MS = 30 * 60_000;
/**
 * A pass is wedged only when it stops making step progress for longer than
 * the LONGEST bounded await inside it (source sync, 30 min). The first
 * threshold, ten minutes from pass START, fenced two perfectly healthy
 * pull+project cycles (~11 min) on 2026-08-24 and the concurrent replacement
 * pass then raced the fenced one over the same .partial directory.
 */
const RECONCILE_STALL_MS = 35 * 60_000;
const ORPHAN_TEMP_MIN_AGE_MS = 60 * 60_000;
const ORPHAN_TEMP_SCAN_LIMIT = 256;
const PULL_FREE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 32;
const ACTIVATION_HISTORY_LIMIT = 10;
/** Runner publication and bot ingestion intentionally share these fixed ceilings. */
export const KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES = 512 * 1024 * 1024;
export const KNOWLEDGE_ARTIFACT_AGGREGATE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const KNOWLEDGE_ARTIFACT_MANIFEST_MAX_BYTES = 1024 * 1024;
export const KNOWLEDGE_ARTIFACT_MAX_RETRIES = 2;
export const KNOWLEDGE_ARTIFACT_RETRY_BASE_MS = 1_000;
const CODE_TOOLCHAIN = Object.freeze({
  typescript: "5.9.3",
  scipTypescript: "0.4.0",
  scip: "0.9.0",
  protobuf: "2.11.0",
});

export interface RemoteKnowledgeStatus {
  job_key: string;
  repo_sha: string;
  state: "queued" | "running" | "upload_pending" | "succeeded" | "failed" | "cancellation_requested" | "cancelled" | "timed_out" | "orphaned";
  error?: { code: string; message: string };
  files: Array<{ file: string; bytes: number; sha256: string }>;
}

export interface RemoteKnowledgeRead {
  job_key: string;
  file: string;
  offset: number;
  bytes: number;
  data: string;
  eof: boolean;
  sha256: string;
}

export interface KnowledgeArtifactProvider {
  owner: string;
  device: string;
  checkoutDir: string;
}
export interface KnowledgeArtifactRemote {
  /** Discovery explains absence; it never changes the configured provider. */
  availability?(): "available" | "unregistered" | "offline" | "inventory_unavailable" | "unsupported";
  /** Exact inventory negotiation. False means never send a private method. */
  protocolAvailable(): boolean;
  /** Existing one-shot bundle materialization, fixed to the service's source workspace. */
  syncSource(repoSha: string): Promise<void>;
  start(input: { jobKey: string; repoSha: string; inputUrl: string; inputSha256: string; inputBytes: number }): Promise<RemoteKnowledgeStatus>;
  status(jobKey: string): Promise<RemoteKnowledgeStatus>;
  cancel(jobKey: string): Promise<RemoteKnowledgeStatus>;
  read(jobKey: string, file: string, offset: number, length: number): Promise<RemoteKnowledgeRead>;
}

export type KnowledgeArtifactJobPhase = "prepared" | "remote" | "pulling" | "failed" | "stale";
interface PersistedJob {
  provider?: KnowledgeArtifactProvider;
  jobKey: string;
  repoSha: string;
  inputSha256: string;
  inputBytes: number;
  phase: KnowledgeArtifactJobPhase;
  remoteState?: RemoteKnowledgeStatus["state"];
  error?: string;
  failureCode?: string;
  retryCount: number;
  retryAt?: string;
}
interface ActiveGeneration {
  repoSha: string;
  inputSha256: string;
  recordSetSha256: string;
  jobKey: string;
  manifestDigest: string;
  generation: string;
}
interface ServiceState {
  version: 1;
  job?: PersistedJob;
  active?: ActiveGeneration;
  /** Explicit operator retirement preserves the complete old intent and fences its key forever. */
  retiredJobs?: PersistedJob[];
}

export type KnowledgeArtifactEvaluationName = "journeys" | "vectorBenchmark";
export type KnowledgeArtifactEvaluationState = "pending" | "running" | "passed" | "failed" | "unavailable";
export interface KnowledgeArtifactEvaluationHealth {
  /** Missing on preserved historical runtime evaluations. */
  scope?: "repository" | "artifact";
  executor?: string;
  state: KnowledgeArtifactEvaluationState;
  startedAt: string | null;
  finishedAt: string | null;
  failureCode: string | null;
  metrics: Record<string, number | boolean>;
}
export interface KnowledgeArtifactActivationHealth {
  repoSha: string;
  manifestDigest: string;
  activatedAt: string;
  evaluations: Record<KnowledgeArtifactEvaluationName, KnowledgeArtifactEvaluationHealth>;
}
export interface KnowledgeArtifactHealth {
  configured: boolean;
  status: "healthy" | "evaluating" | "degraded" | "unavailable";
  protocolAvailable: boolean;
  vectorSearchOnline: boolean;
  active: (KnowledgeArtifactActivationHealth & {
    ageMs: number;
    baselineRef: string | null;
    baselineSha: string | null;
    commitsBehind: number | null;
    baselineCheckedAt: string | null;
  }) | null;
  task: {
    phase: KnowledgeArtifactJobPhase | "idle";
    remoteState: RemoteKnowledgeStatus["state"] | null;
    reconcileStep: string | null;
    unavailableReason?: string | null;
    provider?: { owner: string; device: string };
  };
  lastFailureCode: string | null;
  lastFailureAt: string | null;
  recentActivations: KnowledgeArtifactActivationHealth[];
}

interface PersistedArtifactHealth {
  version: 1;
  activations: KnowledgeArtifactActivationHealth[];
  baseline?: {
    activeRepoSha: string;
    baselineRef: string;
    baselineSha: string;
    commitsBehind: number;
    checkedAt: string;
  };
  lastFailure?: { key: string; code: string; at: string };
}

export interface KnowledgeArtifactEvaluationInput {
  repoSha: string;
  graphFile: string;
  generation: string;
}

export interface KnowledgeArtifactEvaluationResult {
  unavailable?: boolean;
  scope?: "repository" | "artifact";
  executor?: string;
  startedAt?: string;
  finishedAt?: string;
  passed: boolean;
  failureCode?: string;
  metrics?: Record<string, number | boolean>;
}

export interface KnowledgeArtifactServiceOptions {
  /** Bound once by trusted composition; never inferred from a persisted job. */
  provider?: KnowledgeArtifactProvider;
  graph: Pick<KnowledgeGraphService, "file" | "artifactInput" | "prepareArtifacts" | "activateArtifacts" | "artifactsActive" | "commit">;
  remote: KnowledgeArtifactRemote;
  bundles: BundleHandoff;
  publicUrl: string;
  dir: string;
  /** Exact trusted checkout whose evaluation commands and journey corpus are used. */
  repoRoot: string;
  /** Includes current/new v4 and deployed SHA. Only the graph-bound member is buildable. */
  desiredShas: () => Promise<readonly string[]>;
  /** Injectable only for deterministic disk-capacity tests. */
  availableBytes?: (root: string) => Promise<number>;
  /** Current base-branch distance, injected by the composition that owns the repository. */
  baselineStatus?: (activeRepoSha: string) => Promise<{
    baselineRef: string;
    baselineSha: string;
    commitsBehind: number;
  } | null>;
  /** Injectable so activation/evaluation lifecycle tests never spawn heavyweight model work. */
  evaluateArtifact?: (
    name: KnowledgeArtifactEvaluationName,
    input: KnowledgeArtifactEvaluationInput,
  ) => Promise<KnowledgeArtifactEvaluationResult>;
  reconcileMs?: number;
  now?: () => number;
}

/**
 * Bot-side scheduler/puller. Remote job identity and local activation are both
 * durable; transport loss only changes when the same key is queried again.
 */
export class KnowledgeArtifactService {
  readonly generationsDir: string;
  readonly activeFile: string;
  readonly stateFile: string;
  readonly healthFile: string;
  private state: ServiceState = { version: 1 };
  private healthState: PersistedArtifactHealth = { version: 1, activations: [] };
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;
  private reconcileToken = 0;
  private reconcileStep = "idle";
  private reconcileStartedMs: number | null = null;
  private reconcileProgressMs = 0;
  private waitingReason: string | null = null;
  private waitingLoggedMs = 0;
  private readonly reconcileMs: number;
  private readonly now: () => number;
  private readonly availableBytes: (root: string) => Promise<number>;
  private readonly publicOrigin: string;
  private readonly provider: KnowledgeArtifactProvider | undefined;
  private activeGenerationName: string | null = null;
  private activeValidated = false;
  /** Digests streamed by the validation that set activeValidated; rebinding reuses them. */
  private activeDigests: VerifiedGenerationDigests | undefined;
  private initialized = false;
  private healthTail: Promise<void> = Promise.resolve();
  private evaluationTail: Promise<void> = Promise.resolve();
  private readonly evaluatingGenerations = new Set<string>();
  private readonly queuedEvaluations = new Set<string>();

  constructor(private readonly opts: KnowledgeArtifactServiceOptions) {
    this.provider = opts.provider ? Object.freeze(parseProvider(opts.provider)) : undefined;
    this.generationsDir = path.join(opts.dir, "generations");
    this.activeFile = path.join(opts.dir, "active.json");
    this.stateFile = path.join(opts.dir, "service-state.json");
    this.healthFile = path.join(opts.dir, "health.json");
    this.reconcileMs = Math.max(1_000, Math.min(opts.reconcileMs ?? RECONCILE_MS, 5 * 60_000));
    this.now = opts.now ?? Date.now;
    this.availableBytes = opts.availableBytes ?? freeBytesAt;
    this.publicOrigin = secureHttpOrigin(opts.publicUrl, "knowledge input handoff");
  }

  async start(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
    const serviceRoot = await lstat(this.opts.dir);
    if (!serviceRoot.isDirectory() || serviceRoot.isSymbolicLink()) throw new Error("knowledge artifact root must be a regular directory");
    await chmod(this.opts.dir, 0o700);
    await mkdir(this.generationsDir, { recursive: true, mode: 0o700 });
    const generations = await lstat(this.generationsDir);
    if (!generations.isDirectory() || generations.isSymbolicLink()) throw new Error("knowledge generations root must be a regular directory");
    this.state = serviceState(await readJson<unknown>(this.stateFile, { version: 1 }));
    try {
      this.healthState = artifactHealthState(await readJson<unknown>(this.healthFile, { version: 1, activations: [] }));
    } catch (error) {
      this.healthState = { version: 1, activations: [] };
      log.warn({ error: bounded(error) }, "persisted knowledge artifact health could not be read");
    }
    await this.captureJobFailure();
    await this.reopenPersistedActive();
    await this.seedRecoveredActivation();
    await this.gcGenerations();
    this.resumePendingEvaluation();
    this.initialized = true;
    await this.kick();
    this.timer = setInterval(() => void this.kick().catch(() => undefined), this.reconcileMs);
    this.timer.unref?.();
    this.watchdog = setInterval(() => this.checkStalledReconciliation(), Math.min(this.reconcileMs, 60_000));
    this.watchdog.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    // Fence any in-flight pass so it cannot mutate durable state after stop,
    // then wait briefly instead of inheriting a wedged await forever.
    this.reconcileToken += 1;
    await Promise.race([
      this.tail.catch(() => undefined),
      new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5_000); timer.unref?.(); }),
    ]);
    await Promise.race([
      Promise.all([this.evaluationTail.catch(() => undefined), this.healthTail.catch(() => undefined)]).then(() => undefined),
      new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5_000); timer.unref?.(); }),
    ]);
  }

  /**
   * Watchdog: a reconciliation pass that exceeds RECONCILE_STALL_MS is fenced
   * off — its later continuations abandon before mutating durable state — and
   * the serial chain restarts, so one lost await can never freeze the
   * scheduler silently again. Returns true when a stall was fenced.
   */
  checkStalledReconciliation(): boolean {
    if (this.stopped || this.reconcileStartedMs === null) return false;
    const stalledMs = this.now() - Math.max(this.reconcileStartedMs, this.reconcileProgressMs);
    if (stalledMs <= RECONCILE_STALL_MS) return false;
    log.warn({ step: this.reconcileStep, stalledMs }, "knowledge artifact reconciliation stalled; fencing the stuck pass");
    this.reconcileToken += 1;
    this.reconcileStartedMs = null;
    this.reconcileStep = "idle";
    this.tail = Promise.resolve();
    void this.kick().catch(() => undefined);
    return true;
  }

  /** Content-free reconnect/landing/deploy signal. Calls coalesce behind one serial reconciliation. */
  kick(): Promise<void> {
    // Presence can arrive as soon as the factory exposes this instance.
    // start() schedules a pass after all durable state has been restored.
    if (!this.initialized || this.stopped) return Promise.resolve();
    const next = this.tail.then(() => this.reconcile(), () => this.reconcile());
    this.tail = next.catch((error) => log.warn({ error: bounded(error) }, "knowledge artifact reconciliation failed"));
    return next;
  }

  status(): { job?: PersistedJob; active?: ActiveGeneration; protocolAvailable: boolean; reconcile?: { step: string; inFlightMs: number } } {
    return {
      ...(this.state.job ? { job: { ...this.state.job, ...(this.state.job.provider ? { provider: { ...this.state.job.provider } } : {}) } } : {}),
      ...(this.state.active ? { active: { ...this.state.active } } : {}),
      protocolAvailable: this.opts.remote.protocolAvailable(),
      ...(this.reconcileStartedMs === null ? {} : { reconcile: { step: this.reconcileStep, inFlightMs: this.now() - this.reconcileStartedMs } }),
    };
  }

  /**
   * Privacy-bounded dashboard projection. Absolute generation paths, remote
   * error strings and deterministic job keys intentionally stay inside the
   * service; the UI receives only lifecycle identity and bounded outcomes.
   */
  health(): KnowledgeArtifactHealth {
    const rawActive = this.state.active;
    const activation = rawActive
      ? this.healthState.activations.find((row) => row.manifestDigest === rawActive.manifestDigest) ?? null
      : null;
    const baseline = rawActive && this.healthState.baseline?.activeRepoSha === rawActive.repoSha
      ? this.healthState.baseline
      : null;
    const vectorSearchOnline = Boolean(
      rawActive
      && this.activeValidated
      && this.opts.graph.artifactsActive(rawActive.generation, rawActive.repoSha),
    );
    const active = activation ? {
      ...copyActivationHealth(activation),
      ageMs: Math.max(0, this.now() - Date.parse(activation.activatedAt)),
      baselineRef: baseline?.baselineRef ?? null,
      baselineSha: baseline?.baselineSha ?? null,
      commitsBehind: baseline?.commitsBehind ?? null,
      baselineCheckedAt: baseline?.checkedAt ?? null,
    } : null;
    const evaluationStates = active ? Object.values(active.evaluations).map((evaluation) => evaluation.state) : [];
    const lastFailureAfterActivation = Boolean(
      active
      && this.healthState.lastFailure
      && Date.parse(this.healthState.lastFailure.at) >= Date.parse(active.activatedAt),
    );
    let status: KnowledgeArtifactHealth["status"] = "healthy";
    if (!active) status = "unavailable";
    else if (
      !vectorSearchOnline
      || evaluationStates.includes("failed")
      || evaluationStates.includes("unavailable")
      || lastFailureAfterActivation
      || (active.commitsBehind !== null && active.commitsBehind > 0)
    ) status = "degraded";
    else if (evaluationStates.some((state) => state === "pending" || state === "running")) status = "evaluating";
    return {
      configured: true,
      status,
      protocolAvailable: this.opts.remote.protocolAvailable(),
      vectorSearchOnline,
      active,
      task: {
        phase: this.state.job?.phase ?? "idle",
        remoteState: this.state.job?.remoteState ?? null,
        reconcileStep: this.reconcileStartedMs === null ? null : this.reconcileStep,
        unavailableReason: this.waitingReason,
        ...(this.state.job?.provider ? { provider: { owner: this.state.job.provider.owner, device: this.state.job.provider.device } } : {}),
      },
      lastFailureCode: this.healthState.lastFailure?.code ?? null,
      lastFailureAt: this.healthState.lastFailure?.at ?? null,
      recentActivations: this.healthState.activations.map(copyActivationHealth),
    };
  }

  /**
   * A pass that ends without reaching the remote is not an error, but three
   * silent-return incidents (2026-08-24) each hid hours of degraded retrieval.
   * Name the gate once per reason per ten minutes so the blocker is visible.
   */
  private waiting(reason: string, detail?: Record<string, unknown>): void {
    const now = this.now();
    if (this.waitingReason === reason && now - this.waitingLoggedMs < 10 * 60_000) return;
    this.waitingReason = reason;
    this.waitingLoggedMs = now;
    log.warn({ reason, ...(detail ?? {}) }, "knowledge artifact reconciliation is waiting");
  }

  /** Throws when a fenced (stalled) pass resumes; the replacement pass owns the state. */
  private fence(token: number): void {
    if (this.reconcileToken !== token) {
      throw Object.assign(new Error("knowledge reconciliation pass was fenced after a stall"), { code: "knowledge_reconcile_fenced" });
    }
  }

  private step(token: number, step: string): void {
    this.fence(token);
    this.reconcileStep = step;
    this.reconcileProgressMs = this.now();
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    const token = this.reconcileToken;
    this.reconcileStartedMs = this.now();
    this.reconcileStep = "start";
    try {
      await this.reconcilePass(token);
    } finally {
      if (this.reconcileToken === token) {
        this.reconcileStartedMs = null;
        this.reconcileStep = "idle";
      }
    }
  }

  private async reconcilePass(token: number): Promise<void> {
    // Changing configuration never moves an uncertain operation to another device.
    const jobProvider = this.state.job?.provider;
    if (this.state.job && (jobProvider || this.provider) && !sameProvider(jobProvider, this.provider)) {
      this.waiting(jobProvider ? "provider_changed" : "provider_identity_missing");
      return;
    }
    this.step(token, "gc");
    await this.gcGenerations();
    this.step(token, "baseline_status");
    await this.refreshBaselineStatus();
    this.step(token, "graph_input");
    const graphInput = await this.opts.graph.artifactInput();
    if (!graphInput || !GIT_SHA.test(graphInput.repoSha) || !SHA256.test(graphInput.sha256)) {
      this.waiting("graph_input_unavailable");
      return;
    }
    const desired = new Set((await this.opts.desiredShas()).filter((sha) => GIT_SHA.test(sha)));
    if (!desired.has(graphInput.repoSha)) {
      this.waiting("repo_sha_not_desired", { repoSha: graphInput.repoSha.slice(0, 12) });
      return;
    }
    if (this.state.active?.repoSha === graphInput.repoSha && this.state.active.recordSetSha256 === graphInput.recordSetSha256) {
      if (this.opts.graph.artifactsActive(this.state.active.generation, graphInput.repoSha)) return;
      if (this.activeValidated) {
        try {
          this.opts.graph.activateArtifacts(this.state.active.generation, graphInput.repoSha, undefined, this.activeDigests);
          return;
        } catch (error) {
          this.activeValidated = false;
          this.activeDigests = undefined;
          log.warn({ error: bounded(error) }, "validated knowledge generation could not be rebound");
        }
      }
      if (await this.activatePersisted(this.state.active)) return;
    }

    const jobKey = knowledgeArtifactJobKey(graphInput.repoSha, graphInput.sha256);
    if (this.state.retiredJobs?.some((retired) => retired.jobKey === jobKey)) {
      this.waiting("job_retired_no_replay");
      return;
    }
    if (this.state.job && this.state.job.jobKey !== jobKey) {
      const prior = this.state.job;
      // Provider-bound jobs were introduced together with persist-before-start.
      // A first-attempt prepared record has not crossed that durable dispatch
      // boundary. A startup graph refresh can safely supersede it without
      // querying a nonexistent remote receipt. Legacy, retry and dispatched
      // records keep the conservative reconciliation/no-replay path below.
      if (prior.provider && prior.phase === "prepared" && prior.retryCount === 0
        && !prior.remoteState && !prior.failureCode && !prior.error && !prior.retryAt) {
        prior.phase = "stale";
        await this.persist();
      }
      if (["prepared", "remote", "pulling"].includes(this.state.job.phase)) {
        await this.reconcileExistingJob(this.state.job, token);
        if (["prepared", "remote", "pulling"].includes(this.state.job.phase)) return;
      }
      this.state.job = undefined;
    }
    if (!this.state.job) {
      this.state.job = {
        jobKey,
        repoSha: graphInput.repoSha,
        inputSha256: graphInput.sha256,
        inputBytes: graphInput.bytes,
        phase: "prepared",
        retryCount: 0,
        ...(this.provider ? { provider: { ...this.provider } } : {}),
      };
      await this.persist();
    }
    if (!this.opts.remote.protocolAvailable()) {
      this.waiting(this.opts.remote.availability?.() ?? "protocol_unavailable");
      return;
    }

    const job = this.state.job;
    if (job.phase === "stale") return;
    if (job.phase === "failed") {
      if (!retryablePersistedFailure(job) || job.retryCount >= KNOWLEDGE_ARTIFACT_MAX_RETRIES) {
        this.waiting("job_failed_terminally", { failureCode: job.failureCode ?? job.remoteState ?? "unknown" });
        return;
      }
      job.retryCount += 1;
      job.phase = "prepared";
      job.retryAt = iso(this.now());
      await this.persist();
    }
    const retryStart = job.phase === "prepared" && retryablePersistedFailure(job);
    if (retryStart && Date.parse(job.retryAt ?? "") > this.now()) return;
    let remote: RemoteKnowledgeStatus | null = null;
    if (!retryStart) {
      try {
        this.step(token, "remote_status");
        remote = await withDeadline(this.opts.remote.status(job.jobKey), REMOTE_CALL_DEADLINE_MS, "knowledge_index_status");
      } catch (error) {
        this.fence(token);
        if (!notFound(error)) {
          this.waiting("remote_status_unavailable");
          return;
        }
        // A dispatched job that disappeared is unknown, not permission to replay.
        if (job.phase === "remote" || job.phase === "pulling") {
          this.waiting("remote_job_missing");
          return;
        }
      }
    }
    if (!remote) {
      if (job.repoSha !== graphInput.repoSha || job.inputSha256 !== graphInput.sha256) { job.phase = "stale"; await this.persist(); return; }
      if (!retryStart) {
        try {
          this.step(token, "source_sync");
          await withDeadline(this.opts.remote.syncSource(job.repoSha), SOURCE_SYNC_DEADLINE_MS, "knowledge source sync");
        } catch (error) {
          this.fence(token);
          if (retryableReconcileError(error)) { this.waiting("source_sync_unavailable"); return; }
          job.phase = "failed";
          job.failureCode = "source_sync_rejected";
          job.error = bounded(error);
          await this.persist();
          return;
        }
      }
      const handoff = this.opts.bundles.offer(graphInput.file, { cleanup: false, purpose: "knowledge-input", identity: job.jobKey });
      try {
        this.step(token, "remote_start");
        // Persist the uncertainty boundary before the request can leave this process.
        job.phase = "remote";
        await this.persist();
        remote = await withDeadline(this.opts.remote.start({
          jobKey: job.jobKey,
          repoSha: job.repoSha,
          inputUrl: `${this.publicOrigin}/api/contrib/bundle/${handoff}`,
          inputSha256: job.inputSha256,
          inputBytes: job.inputBytes,
        }), REMOTE_CALL_DEADLINE_MS, "knowledge_index_start");
      } catch {
        this.fence(token);
        // The request may have reached the Runner. Never launch a second
        // attempt until the same durable key reports an explicit outcome.
        job.phase = "remote";
        await this.persist();
        return;
      } finally {
        this.opts.bundles.revoke(handoff);
      }
    }
    await this.consumeRemote(job, remote, token);
  }

  private async reconcileExistingJob(job: PersistedJob, token: number): Promise<void> {
    if (!this.opts.remote.protocolAvailable()) {
      this.waiting(this.opts.remote.availability?.() ?? "protocol_unavailable");
      return;
    }
    try {
      this.step(token, "remote_status");
      const remote = await withDeadline(this.opts.remote.status(job.jobKey), REMOTE_CALL_DEADLINE_MS, "knowledge_index_status");
      await this.consumeRemote(job, remote, token);
    } catch (error) {
      this.fence(token);
      this.waiting(notFound(error) ? "remote_job_missing" : "remote_status_unavailable");
    }
  }

  private async consumeRemote(job: PersistedJob, remote: RemoteKnowledgeStatus, token: number): Promise<void> {
    this.fence(token);
    this.waitingReason = null;
    if (remote.job_key !== job.jobKey || remote.repo_sha !== job.repoSha) {
      job.phase = "failed";
      job.failureCode = "identity_mismatch";
      job.error = "remote identity mismatch";
      await this.persist();
      await this.gcGenerations();
      return;
    }
    job.remoteState = remote.state;
    if (remote.state === "queued" && remote.error?.code === "input_pending") {
      await this.scheduleRetry(job, remote, token);
      return;
    }
    if (remote.state === "queued" || remote.state === "running" || remote.state === "cancellation_requested") {
      job.phase = "remote";
      delete job.failureCode;
      delete job.retryAt;
      delete job.error;
      await this.persist();
      return;
    }
    if (remote.state === "failed" || remote.state === "cancelled" || remote.state === "timed_out" || remote.state === "orphaned") {
      if (retryableRemoteOutcome(remote)) {
        await this.scheduleRetry(job, remote, token);
        return;
      }
      job.phase = "failed";
      job.failureCode = remote.error?.code ?? remote.state;
      job.error = bounded(remote.error?.message ?? remote.state);
      await this.persist();
      await this.gcGenerations();
      return;
    }
    job.phase = "pulling";
    delete job.failureCode;
    delete job.retryAt;
    delete job.error;
    await this.persist();
    try {
      await this.pullAndActivate(job, remote, token);
    } catch (error) {
      // A fenced pass no longer owns the durable state: its replacement may be
      // pulling into the same .partial directory right now.
      if ((error as { code?: unknown }).code === "knowledge_reconcile_fenced") throw error;
      this.fence(token);
      if (retryableReconcileError(error)) {
        job.phase = "pulling";
        job.error = bounded(error);
        await this.persist();
        return;
      }
      await removeContainedTree(path.join(this.generationsDir, `${job.jobKey}.partial`), this.generationsDir);
      job.phase = "failed";
      job.failureCode = "artifact_rejected";
      job.error = bounded(error);
      await this.persist();
      await this.gcGenerations();
    }
  }

  private async scheduleRetry(job: PersistedJob, remote: RemoteKnowledgeStatus, token: number): Promise<void> {
    this.fence(token);
    const graphInput = await this.opts.graph.artifactInput();
    if (!graphInput || graphInput.repoSha !== job.repoSha || graphInput.sha256 !== job.inputSha256) {
      job.phase = "stale";
      job.error = "graph changed before deterministic retry";
      delete job.retryAt;
      await this.persist();
      return;
    }
    job.remoteState = remote.state;
    job.failureCode = remote.error?.code ?? remote.state;
    job.error = bounded(remote.error?.message ?? remote.state);
    if (job.retryCount >= KNOWLEDGE_ARTIFACT_MAX_RETRIES) {
      job.phase = "failed";
      delete job.retryAt;
      await this.persist();
      await this.gcGenerations();
      return;
    }
    const delayMs = KNOWLEDGE_ARTIFACT_RETRY_BASE_MS * (2 ** job.retryCount);
    job.retryCount += 1;
    job.retryAt = iso(this.now() + delayMs);
    job.phase = "prepared";
    await this.persist();
  }

  private async pullAndActivate(job: PersistedJob, remote: RemoteKnowledgeStatus, token: number): Promise<void> {
    this.step(token, "pull");
    const graphInput = await this.opts.graph.artifactInput();
    if (!graphInput || graphInput.repoSha !== job.repoSha || graphInput.sha256 !== job.inputSha256) {
      job.phase = "stale"; job.error = "graph changed before activation"; await this.persist(); return;
    }
    const files = validateRemoteFiles(remote.files);
    const partial = path.join(this.generationsDir, `${job.jobKey}.partial`);
    await ensureContainedDirectory(partial, this.generationsDir);
    await this.assertPullCapacity(partial, files);
    for (const file of files) await this.pullFile(job.jobKey, partial, file, token);
    const verified = await validateGeneration(partial, job.repoSha, job.inputSha256, job.inputBytes);
    const target = path.join(this.generationsDir, verified.manifestDigest);
    let generation = partial;
    let digests = verified.digests;
    try {
      const targetInfo = await lstat(target);
      if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error("generation target is not a regular directory");
      const existing = await validateGeneration(target, job.repoSha, job.inputSha256, job.inputBytes);
      if (existing.recordSetDigest !== verified.recordSetDigest) throw new Error("existing generation record-set identity mismatch");
      await rm(partial, { recursive: true, force: true });
      generation = target;
      digests = existing.digests;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const projection = await this.opts.graph.prepareArtifacts(path.join(generation, "code"), job.repoSha);
    if (projection.input.recordSetSha256 !== verified.recordSetDigest) {
      await rm(projection.graphFile, { force: true });
      await rm(projection.contextFile, { force: true });
      throw new Error("remote vectors do not match the local code-aware graph projection");
    }
    if (generation === partial) {
      await makeReadonly(partial);
      await rename(partial, target);
      generation = target;
    }

    // Constructor performs readonly/query_only/coverage queries over the bytes
    // validateGeneration streamed. One explicit symbol query proves the adapter,
    // not just SQLite, can read.
    const smoke = openCodeIndex(path.join(generation, "code"), { verifiedDigests: digests.code });
    try {
      if (smoke.gitSha !== job.repoSha) throw new Error("code smoke returned a stale SHA");
      smoke.searchSymbols({ repoSha: job.repoSha, query: "Knowledge", limit: 1 });
    } finally { smoke.close(); }

    const current = await this.opts.graph.artifactInput();
    if (!current || current.repoSha !== job.repoSha || current.sha256 !== job.inputSha256) {
      await rm(projection.graphFile, { force: true });
      await rm(projection.contextFile, { force: true });
      job.phase = "stale"; job.error = "graph changed during artifact smoke"; await this.persist(); return;
    }
    this.opts.graph.activateArtifacts(generation, job.repoSha, projection, digests);
    const active: ActiveGeneration = {
      repoSha: job.repoSha,
      inputSha256: job.inputSha256,
      recordSetSha256: verified.recordSetDigest,
      jobKey: job.jobKey,
      manifestDigest: verified.manifestDigest,
      generation,
    };
    await atomicJson(this.activeFile, { version: 1, ...active });
    this.activeGenerationName = active.manifestDigest;
    this.activeValidated = true;
    this.activeDigests = digests;
    this.state.active = active;
    this.state.job = undefined;
    await this.persist();
    await this.recordActivation(active);
    await this.refreshBaselineStatus();
    this.queueEvaluation(active);
    await this.gcGenerations();
    log.info({ sha: job.repoSha.slice(0, 12), generation: verified.manifestDigest.slice(0, 12) }, "knowledge artifact activated");
  }

  private async pullFile(jobKey: string, generation: string, expected: ArtifactFile, token: number): Promise<void> {
    const final = safeFile(generation, expected.file);
    const partial = `${final}.partial`;
    await ensureArtifactParents(generation, expected.file);
    if (await matchesFile(final, expected)) return;
    let offset = 0;
    try {
      const info = await lstat(partial);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("artifact partial is not a regular file");
      offset = info.size;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (offset > expected.bytes) { await rm(partial, { force: true }); offset = 0; }
    const handle = await open(partial, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {
      while (offset < expected.bytes) {
        const length = Math.min(CHUNK_BYTES, expected.bytes - offset);
        this.step(token, "pull");
        const chunk = await withDeadline(this.opts.remote.read(jobKey, expected.file, offset, length), REMOTE_CALL_DEADLINE_MS, "knowledge_index_read");
        if (chunk.job_key !== jobKey || chunk.file !== expected.file || chunk.offset !== offset || chunk.sha256 !== expected.sha256) throw new Error("remote chunk identity mismatch");
        const data = Buffer.from(chunk.data, "base64");
        if (data.toString("base64") !== chunk.data || data.length !== chunk.bytes || data.length < 1 || data.length > length) throw new Error("remote chunk framing mismatch");
        if (chunk.eof !== (offset + data.length === expected.bytes)) throw new Error("remote chunk EOF mismatch");
        await handle.write(data); offset += data.length;
      }
      await handle.sync();
    } finally { await handle.close(); }
    if (!await matchesFile(partial, expected)) {
      await rm(partial, { force: true });
      throw new Error(`pulled artifact checksum mismatch: ${expected.file}`);
    }
    await rename(partial, final);
  }

  private async gcGenerations(): Promise<void> {
    await this.gcOrphanTemporaryFiles();
    const keep = new Set<string>(this.activeGenerationName ? [this.activeGenerationName] : []);
    for (const generation of this.evaluatingGenerations) keep.add(generation);
    if (this.state.active && path.dirname(path.resolve(this.state.active.generation)) === path.resolve(this.generationsDir)) {
      const name = path.basename(this.state.active.generation);
      if (SHA256.test(name) && name === this.state.active.manifestDigest) keep.add(name);
    }
    if (this.state.job?.phase === "pulling") {
      const name = `${this.state.job.jobKey}.partial`;
      try {
        const info = await lstat(path.join(this.generationsDir, name));
        if (info.isDirectory() && !info.isSymbolicLink()) keep.add(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const name of await readdir(this.generationsDir)) {
      if (keep.has(name)) continue;
      await removeContainedTree(path.join(this.generationsDir, name), this.generationsDir);
    }
  }

  private async reopenPersistedActive(): Promise<void> {
    let fileActive: ActiveGeneration | null = null;
    try {
      const raw = await readJson<unknown>(this.activeFile, null);
      fileActive = parseActiveGeneration(raw, true);
    } catch (error) {
      log.warn({ error: bounded(error) }, "persisted knowledge activation marker could not be read");
    }
    const candidates = [fileActive, this.state.active].filter((active): active is ActiveGeneration => active != null)
      .filter((active, index, all) => all.findIndex((candidate) => candidate.manifestDigest === active.manifestDigest) === index);
    for (const active of candidates) if (await this.activatePersisted(active)) return;
  }

  private async activatePersisted(active: ActiveGeneration): Promise<boolean> {
    const expectedGeneration = path.join(this.generationsDir, active.manifestDigest);
    if (path.resolve(active.generation) !== path.resolve(expectedGeneration)) return false;
    // Once metadata proves this is a contained digest generation, protect it
    // before every expensive validation/graph-input early return below.
    this.activeGenerationName = active.manifestDigest;
    try {
      // Most restarts follow a new deployment. Reject its obsolete generation
      // before reading/hashing model weights or opening a code-index database.
      if (this.opts.graph.commit() !== active.repoSha) {
        throw new Error("persisted knowledge generation does not match the current graph commit");
      }
      const current = await this.opts.graph.artifactInput();
      if (!current || current.repoSha !== active.repoSha || current.recordSetSha256 !== active.recordSetSha256) {
        throw new Error("persisted knowledge generation does not match the current graph input");
      }
      const generationInfo = await lstat(active.generation);
      if (!generationInfo.isDirectory() || generationInfo.isSymbolicLink()) throw new Error("persisted knowledge generation is not a regular directory");
      const verified = await validateGeneration(active.generation, active.repoSha, active.inputSha256, undefined);
      // Full validation still runs for eligible generations. Its awaits cannot
      // authorize a generation against a graph replaced while checks ran.
      const latest = await this.opts.graph.artifactInput();
      if (this.opts.graph.commit() !== active.repoSha || !latest || latest.repoSha !== active.repoSha
        || latest.recordSetSha256 !== active.recordSetSha256 || verified.recordSetDigest !== active.recordSetSha256) {
        throw new Error("persisted knowledge generation does not match the current graph input");
      }
      this.opts.graph.activateArtifacts(active.generation, active.repoSha, undefined, verified.digests);
      this.activeValidated = true;
      this.activeDigests = verified.digests;
      this.state.active = active;
      if (this.state.job?.jobKey === active.jobKey) this.state.job = undefined;
      await this.persist();
      return true;
    } catch (error) {
      log.warn({ error: bounded(error) }, "persisted knowledge generation refused");
      return false;
    }
  }

  private async assertPullCapacity(root: string, files: readonly ArtifactFile[]): Promise<void> {
    let remaining = 0;
    for (const expected of files) {
      const final = safeFile(root, expected.file);
      if (await matchesFile(final, expected)) continue;
      let offset = 0;
      try {
        const info = await lstat(`${final}.partial`);
        if (info.isFile() && !info.isSymbolicLink() && info.size <= expected.bytes) offset = info.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      remaining += expected.bytes - offset;
    }
    const required = remaining + PULL_FREE_SPACE_RESERVE_BYTES;
    const available = await this.availableBytes(root);
    if (!Number.isSafeInteger(available) || available < required) {
      throw Object.assign(
        new Error(`knowledge artifact pull requires ${required} bytes but only ${Number.isSafeInteger(available) ? available : 0} are available`),
        { code: "ENOSPC" },
      );
    }
  }

  private async gcOrphanTemporaryFiles(): Promise<void> {
    const entries = (await readdir(this.opts.dir, { withFileTypes: true }))
      .filter((entry) => entry.name.endsWith(".tmp"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, ORPHAN_TEMP_SCAN_LIMIT);
    for (const entry of entries) {
      if (!entry.name.endsWith(".tmp") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const file = path.join(this.opts.dir, entry.name);
      try {
        const info = await lstat(file);
        if (this.now() - info.mtimeMs < ORPHAN_TEMP_MIN_AGE_MS) continue;
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn({ error: bounded(error), file }, "knowledge artifact temporary-file cleanup failed");
      }
    }
  }

  private async persist(): Promise<void> {
    await atomicJson(this.stateFile, this.state);
    await this.captureJobFailure();
  }

  private async captureJobFailure(): Promise<void> {
    const job = this.state.job;
    if (!job?.failureCode) return;
    const key = [job.jobKey, job.phase, job.remoteState ?? "", job.failureCode, job.retryCount].join(":");
    if (this.healthState.lastFailure?.key === key) return;
    await this.updateHealth((health) => {
      health.lastFailure = { key, code: job.failureCode!.slice(0, 100), at: iso(this.now()) };
    });
  }

  private async seedRecoveredActivation(): Promise<void> {
    const active = this.state.active;
    if (!active || !this.activeValidated || this.healthState.activations.some((row) => row.manifestDigest === active.manifestDigest)) return;
    let activatedAt = iso(this.now());
    try { activatedAt = iso((await lstat(this.activeFile)).mtimeMs); } catch { /* current time is the bounded fallback */ }
    await this.recordActivation(active, activatedAt);
  }

  private async recordActivation(active: ActiveGeneration, activatedAt = iso(this.now())): Promise<void> {
    await this.updateHealth((health) => {
      const existing = health.activations.find((row) => row.manifestDigest === active.manifestDigest);
      const activation: KnowledgeArtifactActivationHealth = existing ?? {
        repoSha: active.repoSha,
        manifestDigest: active.manifestDigest,
        activatedAt,
        evaluations: {
          journeys: pendingEvaluation(),
          vectorBenchmark: pendingEvaluation(),
        },
      };
      health.activations = [activation, ...health.activations.filter((row) => row.manifestDigest !== active.manifestDigest)]
        .slice(0, ACTIVATION_HISTORY_LIMIT);
      if (health.baseline?.activeRepoSha !== active.repoSha) delete health.baseline;
    });
  }

  private resumePendingEvaluation(): void {
    const active = this.state.active;
    if (!active || !this.activeValidated) return;
    const activation = this.healthState.activations.find((row) => row.manifestDigest === active.manifestDigest);
    if (!activation || !Object.values(activation.evaluations).some((evaluation) => evaluation.state === "pending" || evaluation.state === "running")) return;
    this.queueEvaluation(active);
  }

  private queueEvaluation(active: ActiveGeneration): void {
    if (this.stopped || this.queuedEvaluations.has(active.manifestDigest)) return;
    this.queuedEvaluations.add(active.manifestDigest);
    this.evaluatingGenerations.add(active.manifestDigest);
    const next = this.evaluationTail.then(() => this.evaluateActivation(active), () => this.evaluateActivation(active));
    this.evaluationTail = next.catch((error) => {
      log.warn({ error: bounded(error), generation: active.manifestDigest.slice(0, 12) }, "knowledge artifact evaluation failed");
    }).finally(() => {
      this.queuedEvaluations.delete(active.manifestDigest);
      this.evaluatingGenerations.delete(active.manifestDigest);
    });
  }

  private async evaluateActivation(active: ActiveGeneration): Promise<void> {
    const input: KnowledgeArtifactEvaluationInput = {
      repoSha: active.repoSha,
      graphFile: this.opts.graph.file,
      generation: active.generation,
    };
    for (const name of ["journeys", "vectorBenchmark"] as const) {
      if (this.stopped) return;
      const startedAt = iso(this.now());
      await this.updateEvaluation(active.manifestDigest, name, {
        state: "running",
        startedAt,
        finishedAt: null,
        failureCode: null,
        metrics: {},
      });
      let result: KnowledgeArtifactEvaluationResult;
      try {
        result = this.opts.evaluateArtifact
          ? await this.opts.evaluateArtifact(name, input)
          : await readArtifactEvaluation(active, name);
      } catch (error) {
        result = { passed: false, failureCode: `${evaluationSlug(name)}_error` };
        log.warn({ error: bounded(error), evaluation: name, sha: active.repoSha.slice(0, 12) }, "knowledge artifact evaluation command failed");
      }
      if (this.stopped) return;
      await this.updateEvaluation(active.manifestDigest, name, {
        state: result.unavailable ? "unavailable" : result.passed ? "passed" : "failed",
        startedAt,
        finishedAt: iso(this.now()),
        failureCode: result.passed ? null : (result.failureCode ?? `${evaluationSlug(name)}_failed`).slice(0, 100),
        metrics: sanitizeMetrics(result.metrics),
        ...(result.scope ? { scope: result.scope } : {}),
        ...(result.executor ? { executor: result.executor } : {}),
        ...(result.startedAt ? { startedAt: result.startedAt } : {}),
        ...(result.finishedAt ? { finishedAt: result.finishedAt } : {}),
      });
    }
  }

  private async updateEvaluation(
    manifestDigest: string,
    name: KnowledgeArtifactEvaluationName,
    evaluation: KnowledgeArtifactEvaluationHealth,
  ): Promise<void> {
    await this.updateHealth((health) => {
      const activation = health.activations.find((row) => row.manifestDigest === manifestDigest);
      if (activation) activation.evaluations[name] = evaluation;
    });
  }

  private async refreshBaselineStatus(): Promise<void> {
    const active = this.state.active;
    if (!active || !this.opts.baselineStatus) return;
    try {
      const result = await this.opts.baselineStatus(active.repoSha);
      if (
        !result
        || !result.baselineRef
        || result.baselineRef.length > 100
        || !GIT_SHA.test(result.baselineSha)
        || !Number.isSafeInteger(result.commitsBehind)
        || result.commitsBehind < 0
      ) return;
      await this.updateHealth((health) => {
        health.baseline = {
          activeRepoSha: active.repoSha,
          baselineRef: result.baselineRef,
          baselineSha: result.baselineSha,
          commitsBehind: result.commitsBehind,
          checkedAt: iso(this.now()),
        };
      });
    } catch (error) {
      log.warn({ error: bounded(error) }, "knowledge artifact baseline distance could not be read");
    }
  }

  private async updateHealth(change: (health: PersistedArtifactHealth) => void): Promise<void> {
    const next = this.healthTail.then(async () => {
      change(this.healthState);
      await atomicJson(this.healthFile, this.healthState);
    });
    this.healthTail = next.catch((error) => {
      log.warn({ error: bounded(error) }, "knowledge artifact health could not be persisted");
    });
    await this.healthTail;
  }
}

function serviceState(value: unknown): ServiceState {
  const root = object(value);
  if (root.version !== 1) throw new Error("invalid durable knowledge service state");
  const result: ServiceState = { version: 1 };
  if (root.retiredJobs !== undefined) {
    if (!Array.isArray(root.retiredJobs) || root.retiredJobs.length > 64) throw new Error("invalid retired knowledge jobs");
    result.retiredJobs = root.retiredJobs.map((job) => {
      const parsed = serviceState({ version: 1, job }).job;
      if (!parsed) throw new Error("invalid retired knowledge job");
      return parsed;
    });
    const keys = result.retiredJobs.map((job) => job.jobKey);
    if (new Set(keys).size !== keys.length) throw new Error("duplicate retired knowledge job");
  }
  if (root.active !== undefined) {
    const active = parseActiveGeneration(root.active, false);
    if (!active) throw new Error("invalid durable knowledge active state");
    result.active = active;
  }
  if (root.job !== undefined) {
    const row = object(root.job);
    const phases: PersistedJob["phase"][] = ["prepared", "remote", "pulling", "failed", "stale"];
    const remoteStates: RemoteKnowledgeStatus["state"][] = ["queued", "running", "upload_pending", "succeeded", "failed", "cancellation_requested", "cancelled", "timed_out", "orphaned"];
    if (
      !SHA256.test(String(row.jobKey ?? ""))
      || !GIT_SHA.test(String(row.repoSha ?? ""))
      || !SHA256.test(String(row.inputSha256 ?? ""))
      || typeof row.inputBytes !== "number"
      || !Number.isSafeInteger(row.inputBytes)
      || row.inputBytes <= 0
      || !phases.includes(String(row.phase ?? "") as PersistedJob["phase"])
      || (row.remoteState !== undefined && !remoteStates.includes(String(row.remoteState) as RemoteKnowledgeStatus["state"]))
      || (row.error !== undefined && typeof row.error !== "string")
      || (row.failureCode !== undefined && typeof row.failureCode !== "string")
      || !Number.isSafeInteger(row.retryCount)
      || Number(row.retryCount) < 0
      || Number(row.retryCount) > KNOWLEDGE_ARTIFACT_MAX_RETRIES
      || (row.retryAt !== undefined && (typeof row.retryAt !== "string" || !Number.isFinite(Date.parse(row.retryAt))))
    ) throw new Error("invalid durable knowledge job state");
    result.job = {
      ...(row.provider !== undefined ? { provider: parseProvider(row.provider) } : {}),
      jobKey: String(row.jobKey),
      repoSha: String(row.repoSha),
      inputSha256: String(row.inputSha256),
      inputBytes: row.inputBytes,
      phase: row.phase as PersistedJob["phase"],
      retryCount: Number(row.retryCount),
      ...(row.remoteState ? { remoteState: row.remoteState as RemoteKnowledgeStatus["state"] } : {}),
      ...(row.error ? { error: String(row.error).slice(0, 500) } : {}),
      ...(row.failureCode ? { failureCode: String(row.failureCode).slice(0, 100) } : {}),
      ...(row.retryAt ? { retryAt: String(row.retryAt) } : {}),
    };
  }
  return result;
}

function artifactHealthState(value: unknown): PersistedArtifactHealth {
  const root = object(value);
  if (root.version !== 1 || !Array.isArray(root.activations)) throw new Error("invalid durable knowledge artifact health state");
  const activations = root.activations.slice(0, ACTIVATION_HISTORY_LIMIT).map((value) => {
    const row = object(value);
    if (
      !GIT_SHA.test(String(row.repoSha ?? ""))
      || !SHA256.test(String(row.manifestDigest ?? ""))
      || !validIso(row.activatedAt)
    ) throw new Error("invalid durable knowledge activation history");
    const evaluations = object(row.evaluations);
    return {
      repoSha: String(row.repoSha),
      manifestDigest: String(row.manifestDigest),
      activatedAt: String(row.activatedAt),
      evaluations: {
        journeys: parseEvaluationHealth(evaluations.journeys),
        vectorBenchmark: parseEvaluationHealth(evaluations.vectorBenchmark),
      },
    } satisfies KnowledgeArtifactActivationHealth;
  });
  if (new Set(activations.map((row) => row.manifestDigest)).size !== activations.length) {
    throw new Error("duplicate durable knowledge activation history");
  }
  const result: PersistedArtifactHealth = { version: 1, activations };
  if (root.baseline !== undefined) {
    const baseline = object(root.baseline);
    if (
      !GIT_SHA.test(String(baseline.activeRepoSha ?? ""))
      || typeof baseline.baselineRef !== "string"
      || !baseline.baselineRef
      || baseline.baselineRef.length > 100
      || !GIT_SHA.test(String(baseline.baselineSha ?? ""))
      || !Number.isSafeInteger(baseline.commitsBehind)
      || Number(baseline.commitsBehind) < 0
      || !validIso(baseline.checkedAt)
    ) throw new Error("invalid durable knowledge baseline health");
    result.baseline = {
      activeRepoSha: String(baseline.activeRepoSha),
      baselineRef: String(baseline.baselineRef),
      baselineSha: String(baseline.baselineSha),
      commitsBehind: Number(baseline.commitsBehind),
      checkedAt: String(baseline.checkedAt),
    };
  }
  if (root.lastFailure !== undefined) {
    const failure = object(root.lastFailure);
    if (
      typeof failure.key !== "string"
      || failure.key.length > 400
      || typeof failure.code !== "string"
      || !failure.code
      || failure.code.length > 100
      || !validIso(failure.at)
    ) throw new Error("invalid durable knowledge failure health");
    result.lastFailure = { key: failure.key, code: failure.code, at: String(failure.at) };
  }
  return result;
}

function parseEvaluationHealth(value: unknown): KnowledgeArtifactEvaluationHealth {
  const row = object(value);
  const states: KnowledgeArtifactEvaluationState[] = ["pending", "running", "passed", "failed", "unavailable"];
  if (
    !states.includes(String(row.state ?? "") as KnowledgeArtifactEvaluationState)
    || (row.startedAt !== null && !validIso(row.startedAt))
    || (row.finishedAt !== null && !validIso(row.finishedAt))
    || (row.failureCode !== null && (typeof row.failureCode !== "string" || row.failureCode.length > 100))
  ) throw new Error("invalid durable knowledge evaluation health");
  return {
    state: row.state as KnowledgeArtifactEvaluationState,
    startedAt: row.startedAt === null ? null : String(row.startedAt),
    finishedAt: row.finishedAt === null ? null : String(row.finishedAt),
    failureCode: row.failureCode === null ? null : String(row.failureCode),
    metrics: sanitizeMetrics(object(row.metrics)),
    ...(row.scope === "repository" || row.scope === "artifact" ? { scope: row.scope } : {}),
    ...(typeof row.executor === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(row.executor) ? { executor: row.executor } : {}),
  };
}

function pendingEvaluation(): KnowledgeArtifactEvaluationHealth {
  return { state: "pending", startedAt: null, finishedAt: null, failureCode: null, metrics: {} };
}

function copyActivationHealth(value: KnowledgeArtifactActivationHealth): KnowledgeArtifactActivationHealth {
  return {
    repoSha: value.repoSha,
    manifestDigest: value.manifestDigest,
    activatedAt: value.activatedAt,
    evaluations: {
      journeys: { ...value.evaluations.journeys, metrics: { ...value.evaluations.journeys.metrics } },
      vectorBenchmark: { ...value.evaluations.vectorBenchmark, metrics: { ...value.evaluations.vectorBenchmark.metrics } },
    },
  };
}

function sanitizeMetrics(value: unknown): Record<string, number | boolean> {
  const metrics: Record<string, number | boolean> = {};
  for (const [key, child] of Object.entries(object(value)).slice(0, 16)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/u.test(key)) continue;
    if (typeof child === "boolean" || (typeof child === "number" && Number.isFinite(child))) metrics[key] = child;
  }
  return metrics;
}

function validIso(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function evaluationSlug(name: KnowledgeArtifactEvaluationName): string {
  return name === "journeys" ? "journeys" : "vector_benchmark";
}

function parseProvider(value: unknown): KnowledgeArtifactProvider {
  const row = object(value);
  if (typeof row.owner !== "string" || !row.owner || row.owner.length > 100
    || typeof row.device !== "string" || !row.device || row.device.length > 100
    || typeof row.checkoutDir !== "string" || !path.isAbsolute(row.checkoutDir) || row.checkoutDir.length > 4096) {
    throw new Error("invalid durable knowledge provider identity");
  }
  return { owner: row.owner, device: row.device, checkoutDir: row.checkoutDir };
}

function sameProvider(a: KnowledgeArtifactProvider | undefined, b: KnowledgeArtifactProvider | undefined): boolean {
  return Boolean(a && b && a.owner === b.owner && a.device === b.device && a.checkoutDir === b.checkoutDir);
}

/** The manifest was fully verified before activation; recheck identity/digest at read time. */
export async function readArtifactEvaluation(
  active: Pick<ActiveGeneration, "generation" | "repoSha" | "inputSha256" | "manifestDigest">,
  name: KnowledgeArtifactEvaluationName,
): Promise<KnowledgeArtifactEvaluationResult> {
  const source = await readBoundedRegularFile(path.join(active.generation, "knowledge-artifact-manifest.json"), KNOWLEDGE_ARTIFACT_MANIFEST_MAX_BYTES, "evaluation manifest");
  const manifest = object(JSON.parse(source.toString("utf8")));
  const unsigned = { ...manifest }; delete unsigned.manifestDigest;
  if (manifest.repoSha !== active.repoSha || object(manifest.input).sha256 !== active.inputSha256
    || manifest.manifestDigest !== active.manifestDigest
    || sha256(Buffer.from(canonicalJson(unsigned))) !== active.manifestDigest) {
    throw new Error("remote evaluation manifest identity mismatch");
  }
  if (manifest.evaluations === undefined) return { passed: false, unavailable: true, failureCode: "remote_evaluation_unavailable" };
  const evaluations = object(manifest.evaluations);
  const row = object(evaluations[name]);
  const scope = name === "journeys" ? "repository" : "artifact";
  if (evaluations.schemaVersion !== 1 || evaluations.repoSha !== active.repoSha
    || evaluations.inputSha256 !== active.inputSha256
    || row.scope !== scope || typeof row.passed !== "boolean"
    || !validIso(row.startedAt) || !validIso(row.finishedAt)
    || Date.parse(String(row.finishedAt)) < Date.parse(String(row.startedAt))
    || !Number.isInteger(row.exitCode)
    || (row.passed && row.exitCode !== 0)
    || typeof evaluations.executor !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(evaluations.executor)
    || (row.failureCode !== undefined && (typeof row.failureCode !== "string" || row.failureCode.length > 100))) {
    throw new Error("invalid remote knowledge evaluation");
  }
  return {
    passed: row.passed,
    scope,
    executor: evaluations.executor,
    startedAt: String(row.startedAt),
    finishedAt: String(row.finishedAt),
    ...(!row.passed ? { failureCode: String(row.failureCode ?? (evaluationSlug(name) + "_failed")) } : {}),
    metrics: sanitizeMetrics(row.metrics),
  };
}

export function knowledgeArtifactJobKey(repoSha: string, inputSha256: string): string {
  if (!GIT_SHA.test(repoSha) || !SHA256.test(inputSha256)) throw new Error("invalid deterministic knowledge job input");
  return sha256(Buffer.from(canonicalJson({
    kind: "octopus-knowledge-artifact-v1",
    repoSha,
    inputSha256,
    contractSchema: 2,
    codeIndexToolchain: CODE_TOOLCHAIN,
    contextualRecordSchemaDigest: CONTEXTUAL_RECORD_SCHEMA_DIGEST,
    embeddingBindingDigest: EMBEDDING_BINDING_DIGEST,
  })));
}

interface ArtifactFile { file: string; bytes: number; sha256: string }
function validateRemoteFiles(input: readonly ArtifactFile[]): ArtifactFile[] {
  if (!Array.isArray(input) || input.length < 2 || input.length > MAX_FILES) throw new Error("remote artifact file list is invalid");
  const seen = new Set<string>();
  let aggregateBytes = 0;
  const files = input.map((entry) => {
    const row = object(entry);
    const file = String(row.file ?? ""), bytes = row.bytes, digest = String(row.sha256 ?? "");
    assertArtifactPath(file);
    if (
      seen.has(file)
      || typeof bytes !== "number"
      || !Number.isSafeInteger(bytes)
      || bytes < 0
      || bytes > KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES
      || (file === "knowledge-artifact-manifest.json" && bytes > KNOWLEDGE_ARTIFACT_MANIFEST_MAX_BYTES)
      || !SHA256.test(digest)
    ) throw new Error("remote artifact metadata is invalid or oversized");
    aggregateBytes += bytes;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > KNOWLEDGE_ARTIFACT_AGGREGATE_MAX_BYTES) {
      throw new Error("remote artifact aggregate exceeds fixed byte ceiling");
    }
    seen.add(file); return { file, bytes, sha256: digest };
  }).sort((a, b) => a.file.localeCompare(b.file));
  if (!seen.has("knowledge-artifact-manifest.json")) throw new Error("remote artifact has no combined manifest");
  return files;
}

async function validateGeneration(
  root: string,
  repoSha: string,
  inputSha: string,
  inputBytes: number | undefined,
): Promise<{ manifestDigest: string; recordSetDigest: string; digests: VerifiedGenerationDigests }> {
  const manifestFile = path.join(root, "knowledge-artifact-manifest.json");
  const source = await readBoundedRegularFile(manifestFile, KNOWLEDGE_ARTIFACT_MANIFEST_MAX_BYTES, "combined manifest");
  const manifest = JSON.parse(source.toString("utf8")) as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || manifest.kind !== "octopus-knowledge-artifact" || manifest.repoSha !== repoSha) throw new Error("combined manifest identity/SHA mismatch");
  const input = object(manifest.input);
  if (input.sha256 !== inputSha || (inputBytes !== undefined && input.bytes !== inputBytes)) throw new Error("combined manifest graph input mismatch");
  const digest = String(manifest.manifestDigest ?? ""), unsigned = { ...manifest }; delete unsigned.manifestDigest;
  if (!SHA256.test(digest) || sha256(Buffer.from(canonicalJson(unsigned))) !== digest) throw new Error("combined manifest digest mismatch");
  const bindings = object(manifest.bindings);
  const recordSetDigest = String(bindings.recordSetDigest ?? "");
  if (!SHA256.test(recordSetDigest)) throw new Error("combined manifest has no resolved contextual record-set binding");
  const declared = Array.isArray(manifest.files) ? manifest.files : [];
  if (!declared.length || declared.length > MAX_FILES - 1) throw new Error("combined manifest file list is invalid");
  const expected = new Set<string>();
  const streamed = new Map<string, string>();
  let aggregateBytes = source.length;
  for (const raw of declared) {
    const row = object(raw), file = String(row.path ?? ""), bytes = row.bytes, checksum = String(row.sha256 ?? "");
    assertArtifactPath(file);
    if (
      file === "knowledge-artifact-manifest.json"
      || expected.has(file)
      || typeof bytes !== "number"
      || !Number.isSafeInteger(bytes)
      || bytes < 0
      || bytes > KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES
      || !SHA256.test(checksum)
    ) throw new Error("combined file identity is invalid or oversized");
    aggregateBytes += bytes;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > KNOWLEDGE_ARTIFACT_AGGREGATE_MAX_BYTES) {
      throw new Error("combined artifact aggregate exceeds fixed byte ceiling");
    }
    expected.add(file);
    if (!await matchesFile(safeFile(root, file), { file, bytes, sha256: checksum })) throw new Error(`combined file checksum mismatch: ${file}`);
    streamed.set(file, checksum);
  }
  // Every byte was hashed above without blocking the event loop; the
  // synchronous model/code checks below only compare manifests against it.
  const digests = { code: subdirectoryDigests(streamed, "code"), model: subdirectoryDigests(streamed, "model") };
  const actual = listFiles(root).filter((file) => file !== "knowledge-artifact-manifest.json" && !file.endsWith(".partial"));
  if (canonicalJson(actual) !== canonicalJson([...expected].sort())) throw new Error("generation contains unlisted files");

  const vector = JSON.parse(await readFile(path.join(root, "vector/vector-manifest.json"), "utf8")) as Record<string, unknown>;
  if (
    vector.repo_sha !== repoSha
    || vector.contextual_record_schema_digest !== CONTEXTUAL_RECORD_SCHEMA_DIGEST
    || vector.record_set_digest !== recordSetDigest
  ) throw new Error("vector manifest is stale, wrong-schema, or wrong-record-set");
  const binding = { ...object(vector.binding) }; delete binding.model_manifest_sha256;
  if (sha256(Buffer.from(canonicalJson(binding))) !== EMBEDDING_BINDING_DIGEST || canonicalJson(binding) !== canonicalJson(MULTILINGUAL_E5_SMALL_BINDING)) throw new Error("vector embedding binding mismatch");
  const model = verifyLocalModelDirectory(path.join(root, "model"), digests.model);
  if (object(vector.binding).model_manifest_sha256 !== model.manifest_sha256) throw new Error("vector/model manifest binding mismatch");
  const conformance = JSON.parse(await readFile(path.join(root, "conformance-tests.json"), "utf8")) as Record<string, unknown>;
  if (conformance.repo_sha !== repoSha || object(conformance.aggregate).failed !== 0 || object(conformance.aggregate).passed !== 4) throw new Error("contract conformance evidence did not pass");
  const smoke = openCodeIndex(path.join(root, "code"), { verifiedDigests: digests.code });
  try { if (smoke.gitSha !== repoSha) throw new Error("code index manifest is stale"); } finally { smoke.close(); }
  return { manifestDigest: digest, recordSetDigest, digests };
}

/** Streamed digests under `<generation>/<subdirectory>/`, keyed relative to that subdirectory. */
function subdirectoryDigests(files: ReadonlyMap<string, string>, subdirectory: string): ReadonlyMap<string, string> {
  const prefix = `${subdirectory}/`;
  return new Map([...files].flatMap(([file, digest]) => (file.startsWith(prefix) ? [[file.slice(prefix.length), digest] as const] : [])));
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("generation contains a symbolic link");
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error("generation contains a non-regular member");
    }
  };
  walk(root, ""); return files.sort();
}
function assertArtifactPath(file: string): void {
  if (!file || file.length > 240 || file.startsWith("/") || file.includes("\\") || file.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe artifact path");
  if (
    !(file.startsWith("code/") || file.startsWith("vector/") || file.startsWith("model/") || file === "conformance-tests.json" || file === "knowledge-artifact-manifest.json")
    || !/^[A-Za-z0-9._/-]+$/.test(file)
  ) throw new Error("artifact outside fixed allowlist");
}
function safeFile(root: string, file: string): string {
  assertArtifactPath(file);
  const result = path.resolve(root, file);
  if (!result.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("artifact traversal refused");
  return result;
}
async function matchesFile(file: string, expected: ArtifactFile): Promise<boolean> {
  try { const info = await lstat(file); return info.isFile() && !info.isSymbolicLink() && info.size === expected.bytes && await sha256File(file) === expected.sha256; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function makeReadonly(root: string): Promise<void> {
  for (const file of listFiles(root)) await chmod(path.join(root, file), 0o400);
  const directories: string[] = [];
  const walk = (dir: string) => { directories.push(dir); for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) walk(path.join(dir, entry.name)); };
  walk(root); for (const dir of directories.sort((a, b) => b.length - a.length)) await chmod(dir, 0o500);
}
async function ensureContainedDirectory(directory: string, root: string): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error("generation directory escaped its root");
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("generation partial is not a regular directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { mode: 0o700 });
  }
}
async function ensureArtifactParents(root: string, file: string): Promise<void> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("generation root is not a regular directory");
  let current = path.resolve(root);
  for (const part of file.split("/").slice(0, -1)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("artifact parent is not a regular directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}
async function removeContainedTree(target: string, root: string): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("refusing generation cleanup outside root");
  let info;
  try { info = await lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    await unlink(target);
    return;
  }
  await chmod(target, 0o700);
  for (const name of await readdir(target)) await removeContainedTree(path.join(target, name), root);
  await rm(target, { recursive: true, force: true });
}
async function readBoundedRegularFile(file: string, maxBytes: number, label: string): Promise<Buffer> {
  const handle = await open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error(`${label} exceeds fixed byte ceiling`);
    const buffer = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} changed while being read`);
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, buffer.length)).bytesRead !== 0) throw new Error(`${label} changed while being read`);
    return buffer;
  } finally {
    await handle.close();
  }
}
function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4 && octets.every((value) => /^\d{1,3}$/.test(value) && Number(value) <= 255) && Number(octets[0]) === 127;
}
function secureHttpOrigin(raw: string, label: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} requires dashboard.public_url`); }
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHost(url.hostname)))
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) throw new Error(`${label} must use an HTTPS origin except on an explicit loopback host`);
  return url.origin;
}
function retryableRemoteOutcome(remote: RemoteKnowledgeStatus): boolean {
  if (remote.state === "orphaned" || remote.state === "timed_out") return true;
  return remote.error?.code === "input_pending"
    || remote.error?.code === "process_lost"
    || remote.error?.code === "deadline"
    || remote.error?.code === "ENOSPC"
    || remote.error?.code === "EDQUOT";
}
function retryablePersistedFailure(job: PersistedJob): boolean {
  return job.remoteState === "orphaned"
    || job.remoteState === "timed_out"
    || job.failureCode === "input_pending"
    || job.failureCode === "process_lost"
    || job.failureCode === "deadline"
    || job.failureCode === "ENOSPC"
    || job.failureCode === "EDQUOT";
}
function retryableReconcileError(error: unknown): boolean {
  // Code-aware graph preparation uses a separate workspace provider. Its
  // temporary absence does not invalidate the already verified generation.
  // Keep pulling the original durable job; never restart the vector builder.
  if (error instanceof WorkspaceProviderUnavailable) return true;
  const row = object(error);
  const code = String(row.code ?? object(row.cause).code ?? "");
  const transientCodes: Record<string, true> = {
    EAI_AGAIN: true,
    ECONNRESET: true,
    ECONNREFUSED: true,
    EDQUOT: true,
    EHOSTUNREACH: true,
    ENOSPC: true,
    ENETUNREACH: true,
    EPIPE: true,
    ETIMEDOUT: true,
    ERR_SOCKET_CLOSED: true,
    UND_ERR_CONNECT_TIMEOUT: true,
    UND_ERR_SOCKET: true,
    knowledge_remote_deadline: true,
  };
  return transientCodes[code] === true;
}
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${label} did not settle within ${ms}ms`), { code: "knowledge_remote_deadline" })), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    promise.catch(() => undefined);
  }
}
function iso(value: number): string { return new Date(value).toISOString(); }
async function atomicJson(file: string, value: unknown): Promise<void> { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`; await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(temporary, file); await chmod(file, 0o600); }
async function readJson<T>(file: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(file, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; } }
async function sha256File(file: string): Promise<string> { const digest = createHash("sha256"); for await (const chunk of fs.createReadStream(file)) digest.update(chunk); return digest.digest("hex"); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function bounded(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/\b(?:rt|bt|sk)_[A-Za-z0-9_-]+\b/g, "[REDACTED]").slice(0, 500); }
function notFound(error: unknown): boolean { return /job not found|not found/i.test(error instanceof Error ? error.message : String(error)); }
function parseActiveGeneration(value: unknown, requireVersion: boolean): ActiveGeneration | null {
  const row = object(value);
  if (
    (requireVersion && row.version !== 1)
    || !GIT_SHA.test(String(row.repoSha ?? ""))
    || !SHA256.test(String(row.inputSha256 ?? ""))
    || !SHA256.test(String(row.recordSetSha256 ?? ""))
    || !SHA256.test(String(row.jobKey ?? ""))
    || !SHA256.test(String(row.manifestDigest ?? ""))
    || typeof row.generation !== "string"
  ) return null;
  return {
    repoSha: String(row.repoSha),
    inputSha256: String(row.inputSha256),
    recordSetSha256: String(row.recordSetSha256),
    jobKey: String(row.jobKey),
    manifestDigest: String(row.manifestDigest),
    generation: row.generation,
  };
}
async function freeBytesAt(root: string): Promise<number> { const info = await statfs(root, { bigint: true }); const value = info.bavail * info.bsize; return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value); }
