/**
 * The two child services behind ONE Agentic App, and the registry of them.
 *
 * ── Two processes, and why they are not one ─────────────────────────────────
 *
 * `State` owns durable App state, keyed by `(publisher, stableAppId, scope)`;
 * it belongs to the APP and outlives every release. `Runtime` loads one
 * specific release's backend code; it belongs to the RELEASE and is replaced by
 * every activation. Splitting them is what makes a hot update a swap of one
 * child rather than a restart that drops state, and what makes a crashed
 * sandbox a degraded App rather than a lost history.
 *
 * ── One pair per app, which is what the registry is for ─────────────────────
 *
 * Nothing in the supervisor was ever Session-Plus-specific: it takes a state
 * directory, a materialised app directory and two module paths. What made it
 * one app's object was that exactly one existed, wired by name in the
 * composition root. `AppBackendRegistry` holds one supervisor per stable app
 * id, gives each its own state directory under a shared root, and owns the
 * teardown — so "every app gets its own pair of children, and no two apps can
 * share a state directory" is a property of the structure rather than of
 * whoever writes the next composition root.
 *
 * The registry deliberately does NOT start anything: whether an app wants a
 * Runtime child depends on whether it has an active release, which is the
 * release host's answer, not this file's.
 */

import * as path from "node:path";
import type {
  AppRuntimeClient,
} from "@claude-bot/app-runtime";
import { backendRelease, RuntimeProcessClient } from "@claude-bot/app-runtime";
import type {
  StateClient,
} from "@claude-bot/app-state";
import { StateProcessClient } from "@claude-bot/app-state";
import { DEFAULT_MAX_HOSTED_APPS, MAX_HOSTED_APPS } from "../app-core/hosting-limits.js";
import type { RuntimeCommitMode } from "./hosted-app.js";

export interface AppBackendSupervisorOptions {
  /** Includes module loading and durable recovery; separate from RPC calls. */
  stateReadyTimeoutMs?: number;
  stateExecArgv?: readonly string[];
  onStartupFailure?: (failure: AppBackendStartupFailure) => void;
  stateDir: string;
  appDir: string;
  stateModulePath: string;
  runtimeModulePath: string;
  execArgv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  restartDelaysMs?: readonly number[];
  retainedRestartDelaysMs?: readonly number[];
  retainedCrashLimit?: number;
  maxRetainedRuntimes?: number;
  retainedLingerMs?: number;
  /** Internal registry seam used to enforce the process-wide retained limit. */
  onRuntimeRetained?: (
    backendCodeDigest: string,
    retainedAt: number,
    retire: () => void,
  ) => void;
  /** Paired with `onRuntimeRetained`; also fires when a retained record becomes active. */
  onRuntimeRemoved?: (backendCodeDigest: string) => void;
  onDiagnostic?: (service: "state" | "runtime", stream: "stdout" | "stderr", line: string) => void;
  onStatus?: (status: AppBackendStatus) => void;
}

export interface AppBackendStartupFailure {
  service: "state" | "runtime";
  code: string;
  phase: string;
  elapsedMs: number;
}

// Full durable recovery verifies every immutable commit before readiness; large
// histories can exceed 60s. Keep this bounded below the 240s platform health gate.
export const APP_STATE_READY_MS = 180_000;

export interface AppBackendStatus {
  state: "starting" | "ready" | "restarting" | "down" | "stopped";
  runtime: "starting" | "ready" | "restarting" | "down" | "stopped";
  statePid?: number;
  runtimePid?: number;
}

export class AppBackendUnavailable extends Error {
  constructor(
    readonly service: "state" | "runtime",
    readonly reason: "unavailable" | "version_retired" = "unavailable",
  ) {
    super(reason === "version_retired"
      ? "runtime version has been retired"
      : `${service} service is unavailable`);
    this.name = "AppBackendUnavailable";
  }
}

export interface AppRuntimeVersionStatus {
  backendCodeDigest: string;
  appDir: string;
  role: "active" | "retained";
  pid?: number;
  references: number;
  crashCount: number;
  adoptedAt: number;
  retainedAt?: number;
}

/**
 * A started-but-not-adopted App Runtime child.
 *
 * It exists so an activation can prove the new backend comes up BEFORE the
 * active pointer moves. Until `commitRuntime`, this child answers nobody: the
 * supervisor's facade still routes to the incumbent, and the candidate's exit is
 * ignored by the restart logic (which only reacts to the process it is actually
 * serving from).
 */
export interface AppRuntimeCandidate {
  readonly appDir: string;
  readonly backendCodeDigest: string;
}

interface CandidateRecord extends AppRuntimeCandidate {
  kind: "spawned" | "reused";
  client: RuntimeProcessClient | null;
  reused: RuntimeRecord | null;
  adopted: RuntimeRecord | null;
  exited: boolean;
}

interface RuntimeRecord {
  client: RuntimeProcessClient | null;
  appDir: string;
  backendCodeDigest: string;
  role: "active" | "retained" | "retiring";
  references: number;
  crashCount: number;
  restartAttempt: number;
  restartTimer: NodeJS.Timeout | null;
  retireTimer: NodeJS.Timeout | null;
  adoptedAt: number;
  retainedAt: number | null;
}

export class AppBackendSupervisor {
  private stateProcess: StateProcessClient | null = null;
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private activeRuntimeDigest: string | null = null;
  private runtimeAppDir: string;
  private candidates = new Set<CandidateRecord>();
  private stopping = false;
  private acceptRestarts = false;
  /** False after an explicit App deactivation; State still remains wanted. */
  private runtimeWanted = false;
  private stateAttempt = 0;
  private stateTimer: NodeJS.Timeout | null = null;
  private status_: AppBackendStatus = { state: "stopped", runtime: "stopped" };

  readonly state: StateClient;
  readonly runtime: AppRuntimeClient;

  constructor(private readonly options: AppBackendSupervisorOptions) {
    this.runtimeAppDir = options.appDir;
    this.state = {
      resolveStream: (request) => this.withState((client) => client.resolveStream(request)),
      commit: (request) => this.withState((client) => client.commit(request)),
      readSince: (streamId, after, limit) => this.withState((client) => client.readSince(streamId, after, limit)),
      readCommits: (streamId, after, limit) =>
        this.withState((client) => client.readCommits(streamId, after, limit)),
      putSnapshot: (streamId, revision, projectionDigest, view) =>
        this.withState((client) => client.putSnapshot(streamId, revision, projectionDigest, view)),
      snapshot: (streamId, projectionDigest) =>
        this.withState((client) => client.snapshot(streamId, projectionDigest)),
      health: () => this.withState((client) => client.health()),
    };
    this.runtime = {
      invoke: (request) => this.withRuntime(request.backendCodeDigest, (client) => client.invoke(request)),
      project: (request) => this.withRuntime(request.backendCodeDigest, (client) => client.project(request)),
      health: () => this.withActiveRuntime((client) => client.health()),
    };
  }

  get status(): AppBackendStatus {
    return { ...this.status_ };
  }

  /** Which release's backend tree the serving child was started from. */
  get appDir(): string {
    return this.runtimeAppDir;
  }

  /** A bounded, read-only operational view used by tests and RSS accounting. */
  runtimeVersions(): AppRuntimeVersionStatus[] {
    return [...this.runtimes.values()]
      .filter((record) => record.role !== "retiring")
      .map<AppRuntimeVersionStatus>((record) => ({
        backendCodeDigest: record.backendCodeDigest,
        appDir: record.appDir,
        role: record.role === "active" ? "active" : "retained",
        ...(record.client?.rpc.pid ? { pid: record.client.rpc.pid } : {}),
        references: record.references,
        crashCount: record.crashCount,
        adoptedAt: record.adoptedAt,
        ...(record.retainedAt === null ? {} : { retainedAt: record.retainedAt }),
      }))
      .sort((left, right) => {
        if (left.role !== right.role) return left.role === "active" ? -1 : 1;
        return left.adoptedAt - right.adoptedAt;
      });
  }

  /** Whether a digest still owns a routable record, even while it is restarting. */
  hasRuntimeVersion(backendCodeDigest: string): boolean {
    const record = this.runtimes.get(backendCodeDigest);
    return Boolean(record && record.role !== "retiring");
  }

  /**
   * Start a candidate App Runtime and prove it loaded the expected code.
   *
   * The digest comparison is the actual health check. "The child answered" only
   * says a process exists; what an activation needs to know is that the sandbox
   * loaded THESE bytes, and the Runtime reports the digest it computed from the
   * files it opened. A mismatch means the materialised tree is not the release
   * that was prepared, which must stop the activation rather than be corrected.
   */
  async prepareRuntime(appDir: string, expectedBackendCodeDigest: string): Promise<AppRuntimeCandidate> {
    if (this.stopping) throw new Error("the App backend supervisor is stopping");
    const existing = this.runtimes.get(expectedBackendCodeDigest);
    if (existing?.role !== "retiring" && existing?.client?.rpc.isReady) {
      const candidate: CandidateRecord = {
        kind: "reused",
        client: null,
        reused: existing,
        adopted: null,
        appDir,
        backendCodeDigest: expectedBackendCodeDigest,
        exited: false,
      };
      this.candidates.add(candidate);
      return candidate;
    }
    let candidate!: CandidateRecord;
    const client = new RuntimeProcessClient({
      modulePath: this.options.runtimeModulePath,
      appDir,
      execArgv: this.options.execArgv,
      env: this.childEnv(),
      readyTimeoutMs: 20_000,
      requestTimeoutMs: 25_000,
      onDiagnostic: (stream, line) => this.options.onDiagnostic?.("runtime", stream, line),
      // Before adoption this only marks the candidate dead. After adoption the
      // same callback becomes the serving child's ordinary restart path.
      onExit: (info) => this.candidateExited(candidate, info.expected),
    });
    candidate = {
      kind: "spawned",
      client,
      reused: null,
      adopted: null,
      appDir,
      backendCodeDigest: expectedBackendCodeDigest,
      exited: false,
    };
    this.candidates.add(candidate);
    try {
      await client.start();
      const health = await client.health();
      if (!health.ok) throw new Error("candidate App Runtime reported an unhealthy state");
      if (health.backendCodeDigest !== expectedBackendCodeDigest) {
        throw new Error(
          `candidate App Runtime loaded ${String(health.backendCodeDigest).slice(0, 16)}… `
            + `but this release declares ${expectedBackendCodeDigest.slice(0, 16)}…`,
        );
      }
      if (candidate.exited || !client.rpc.isReady) throw new Error("candidate App Runtime exited after health check");
    } catch (error) {
      this.candidates.delete(candidate);
      await client.stop().catch(() => {});
      throw error;
    }
    return candidate;
  }

  /**
   * Adopt a candidate in retain or byte-for-byte-compatible swap mode. Never
   * rejects: this runs AFTER the pointer has moved, so
   * a throw here would leave the catalog and the process disagreeing about which
   * release is live.
   */
  commitRuntime(candidate: AppRuntimeCandidate, mode: RuntimeCommitMode): void {
    const prepared = this.asCandidate(candidate);
    if (!prepared) return;
    this.candidates.delete(prepared);

    const previous = this.activeRuntimeDigest
      ? this.runtimes.get(this.activeRuntimeDigest) ?? null
      : null;
    const existingAtDigest = this.runtimes.get(prepared.backendCodeDigest) ?? null;
    let selected: RuntimeRecord;
    if (
      prepared.kind === "reused"
      && prepared.reused
      && existingAtDigest === prepared.reused
      && prepared.reused.role !== "retiring"
    ) {
      selected = prepared.reused;
    } else {
      const references = existingAtDigest?.references ?? 0;
      if (existingAtDigest) this.retireRecord(existingAtDigest);
      selected = this.newRuntimeRecord({
        appDir: prepared.appDir,
        backendCodeDigest: prepared.backendCodeDigest,
        client: prepared.kind === "spawned" && !prepared.exited && prepared.client?.rpc.isReady
          ? prepared.client
          : null,
        references,
      });
      if (prepared.kind === "spawned") prepared.adopted = selected;
      this.runtimes.set(selected.backendCodeDigest, selected);
    }

    this.promoteRuntime(selected, prepared.appDir);
    this.runtimeWanted = true;
    this.acceptRestarts = true;

    if (mode === "retain" && previous && previous !== selected && previous.role !== "retiring") {
      this.retainRuntime(previous);
    } else {
      for (const record of [...this.runtimes.values()]) {
        if (record !== selected) this.retireRecord(record);
      }
    }

    if (selected.client?.rpc.isReady) {
      this.setStatus({ runtime: "ready", runtimePid: selected.client.rpc.pid });
    } else {
      this.setStatus({ runtime: "down", runtimePid: undefined });
      this.scheduleRuntimeRestart(selected);
    }
  }

  /** Throw a candidate away. Used on every activation failure path. */
  async discardRuntime(candidate: AppRuntimeCandidate): Promise<void> {
    const prepared = this.asCandidate(candidate);
    if (!prepared) return;
    this.candidates.delete(prepared);
    if (prepared.kind === "spawned") await prepared.client?.stop().catch(() => {});
  }

  /** Count a live binding against a backend version. */
  addRuntimeReference(backendCodeDigest: string): boolean {
    const record = this.runtimes.get(backendCodeDigest);
    if (!record || record.role === "retiring") return false;
    record.references += 1;
    if (record.retireTimer) {
      clearTimeout(record.retireTimer);
      record.retireTimer = null;
    }
    return true;
  }

  /** Release a binding; a retained zero-reference cohort drains after linger. */
  removeRuntimeReference(backendCodeDigest: string): boolean {
    const record = this.runtimes.get(backendCodeDigest);
    if (!record || record.role === "retiring" || record.references === 0) return false;
    record.references -= 1;
    if (record.role === "retained" && record.references === 0) this.scheduleRetirement(record);
    return true;
  }

  /** Force-retire one old cohort. The active version is never removed here. */
  retireRuntime(backendCodeDigest: string): boolean {
    const record = this.runtimes.get(backendCodeDigest);
    if (!record || record.role !== "retained") return false;
    this.retireRecord(record);
    return true;
  }

  /** Stop only the release-bound Runtime; durable State remains available. */
  deactivateRuntime(): void {
    this.runtimeWanted = false;
    this.activeRuntimeDigest = null;
    for (const record of [...this.runtimes.values()]) this.retireRecord(record);
    this.setStatus({ runtime: "stopped", runtimePid: undefined });
  }

  private asCandidate(candidate: AppRuntimeCandidate): CandidateRecord | null {
    for (const record of this.candidates) if (record === candidate) return record;
    return null;
  }

  private candidateExited(candidate: CandidateRecord, expected: boolean): void {
    candidate.exited = true;
    if (candidate.adopted && candidate.client) {
      this.runtimeExited(candidate.adopted, candidate.client, expected);
    }
  }

  /**
   * Start the two children.
   *
   * `runtime: false` starts only State, which is the shape a host with no
   * ACTIVE release needs: durable App state is keyed by
   * `(publisher, stableAppId, scope)` and belongs to the app rather than to a
   * release, while the Runtime loads one specific release's code and therefore
   * has nothing to load. A later activation brings it up through
   * `prepareRuntime`/`commitRuntime`, which is the same path a hot update takes
   * — one door, not a special case.
   */
  async start(options: { runtime?: boolean } = {}): Promise<void> {
    if (this.stateProcess || this.runtimes.size > 0) return;
    this.stopping = false;
    this.runtimeWanted = options.runtime !== false;
    this.setStatus({ state: "starting", runtime: "stopped" });
    try {
      await this.startState();
      if (options.runtime === false) {
        const state = await this.stateProcess!.health();
        if (!state.ok) throw new Error("App State child health check failed during startup");
        this.acceptRestarts = true;
        this.setStatus({ state: "ready", runtime: "stopped" });
        return;
      }
      this.setStatus({ runtime: "starting" });
      const digest = backendRelease(this.runtimeAppDir).backendCodeDigest;
      const candidate = await this.prepareRuntime(this.runtimeAppDir, digest);
      this.commitRuntime(candidate, "swap");
      const [state, runtime] = await Promise.all([this.stateProcess!.health(), this.runtime.health()]);
      if (!state.ok || !runtime.ok) throw new Error("App backend child health check failed during startup");
      this.acceptRestarts = true;
      this.setStatus({ state: "ready", runtime: "ready" });
    } catch (error) {
      this.acceptRestarts = false;
      this.runtimeWanted = false;
      await this.stopProcesses();
      this.setStatus({ state: "down", runtime: "down", statePid: undefined, runtimePid: undefined });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.acceptRestarts = false;
    this.runtimeWanted = false;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    await this.stopProcesses();
    this.setStatus({ state: "stopped", runtime: "stopped", statePid: undefined, runtimePid: undefined });
  }

  private async stopProcesses(): Promise<void> {
    const state = this.stateProcess;
    const candidates = [...this.candidates];
    const runtimes = [...this.runtimes.values()];
    this.candidates.clear();
    this.runtimes.clear();
    this.activeRuntimeDigest = null;
    this.stateProcess = null;
    for (const record of runtimes) {
      if (record.restartTimer) clearTimeout(record.restartTimer);
      if (record.retireTimer) clearTimeout(record.retireTimer);
      if (record.role === "retained") this.options.onRuntimeRemoved?.(record.backendCodeDigest);
      record.role = "retiring";
    }
    for (const candidate of candidates) await candidate.client?.stop().catch(() => {});
    for (const record of runtimes) await record.client?.stop().catch(() => {});
    await state?.stop().catch(() => {});
  }

  private async startState(): Promise<void> {
    const started = Date.now();
    let phase = "module_loading";
    const client = new StateProcessClient({
      modulePath: this.options.stateModulePath,
      stateDir: this.options.stateDir,
      execArgv: this.options.stateExecArgv ?? this.options.execArgv,
      env: this.childEnv(),
      readyTimeoutMs: this.options.stateReadyTimeoutMs ?? APP_STATE_READY_MS,
      requestTimeoutMs: 20_000,
      onDiagnostic: (stream, line) => {
        if (line.startsWith("app-state-startup ")) {
          try {
            const value = JSON.parse(line.slice("app-state-startup ".length)) as { phase?: string };
            if (["entry", "database", "schema", "recovery", "ready"].includes(value.phase ?? "")) phase = value.phase!;
          } catch { /* Diagnostics never become protocol or authority. */ }
        }
        this.options.onDiagnostic?.("state", stream, line);
      },
      onExit: (info) => this.stateExited(client, info.expected),
    });
    this.stateProcess = client;
    try {
      await client.start();
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code.slice(0, 80) : "startup_failed";
      this.options.onStartupFailure?.({ service: "state", code, phase, elapsedMs: Date.now() - started });
      throw error;
    }
    this.stateAttempt = 0;
    this.setStatus({ state: "ready", statePid: client.rpc.pid });
  }

  private newRuntimeRecord(input: {
    appDir: string;
    backendCodeDigest: string;
    client: RuntimeProcessClient | null;
    references?: number;
  }): RuntimeRecord {
    return {
      ...input,
      role: "active",
      references: input.references ?? 0,
      crashCount: 0,
      restartAttempt: 0,
      restartTimer: null,
      retireTimer: null,
      adoptedAt: Date.now(),
      retainedAt: null,
    };
  }

  private promoteRuntime(record: RuntimeRecord, appDir: string): void {
    if (record.role === "retained") this.options.onRuntimeRemoved?.(record.backendCodeDigest);
    if (record.restartTimer) clearTimeout(record.restartTimer);
    if (record.retireTimer) clearTimeout(record.retireTimer);
    record.restartTimer = null;
    record.retireTimer = null;
    record.role = "active";
    record.appDir = appDir;
    record.adoptedAt = Date.now();
    record.retainedAt = null;
    record.restartAttempt = 0;
    record.crashCount = 0;
    this.runtimes.set(record.backendCodeDigest, record);
    this.activeRuntimeDigest = record.backendCodeDigest;
    this.runtimeAppDir = appDir;
  }

  private retainRuntime(record: RuntimeRecord): void {
    if (record.restartTimer) clearTimeout(record.restartTimer);
    record.restartTimer = null;
    record.restartAttempt = 0;
    record.crashCount = 0;
    record.role = "retained";
    record.retainedAt = Date.now();
    if (!record.client?.rpc.isReady) this.scheduleRuntimeRestart(record);
    if (record.references === 0) this.scheduleRetirement(record);
    this.enforcePerAppRetainedLimit();
    if (this.runtimes.get(record.backendCodeDigest) === record) {
      this.options.onRuntimeRetained?.(
        record.backendCodeDigest,
        record.retainedAt,
        () => this.retireRuntime(record.backendCodeDigest),
      );
    }
  }

  private enforcePerAppRetainedLimit(): void {
    const limit = Math.max(0, Math.floor(this.options.maxRetainedRuntimes ?? 1));
    const retained = [...this.runtimes.values()]
      .filter((record) => record.role === "retained")
      .sort((left, right) => (left.retainedAt ?? 0) - (right.retainedAt ?? 0));
    while (retained.length > limit) {
      const oldest = retained.shift();
      if (oldest) this.retireRecord(oldest);
    }
  }

  private scheduleRetirement(record: RuntimeRecord): void {
    if (record.retireTimer || record.role !== "retained") return;
    const delay = Math.max(0, this.options.retainedLingerMs ?? 60_000);
    record.retireTimer = setTimeout(() => {
      record.retireTimer = null;
      if (record.role === "retained" && record.references === 0) this.retireRecord(record);
    }, delay);
    record.retireTimer.unref?.();
  }

  private retireRecord(record: RuntimeRecord): void {
    if (this.runtimes.get(record.backendCodeDigest) !== record) return;
    this.runtimes.delete(record.backendCodeDigest);
    if (record.role === "retained") this.options.onRuntimeRemoved?.(record.backendCodeDigest);
    if (this.activeRuntimeDigest === record.backendCodeDigest) this.activeRuntimeDigest = null;
    if (record.restartTimer) clearTimeout(record.restartTimer);
    if (record.retireTimer) clearTimeout(record.retireTimer);
    record.restartTimer = null;
    record.retireTimer = null;
    record.role = "retiring";
    const client = record.client;
    record.client = null;
    void client?.stop().catch(() => {});
  }

  private async startRuntime(record: RuntimeRecord): Promise<void> {
    if (this.runtimes.get(record.backendCodeDigest) !== record || record.role === "retiring") return;
    let client!: RuntimeProcessClient;
    client = new RuntimeProcessClient({
      modulePath: this.options.runtimeModulePath,
      appDir: record.appDir,
      execArgv: this.options.execArgv,
      env: this.childEnv(),
      readyTimeoutMs: 20_000,
      requestTimeoutMs: 25_000,
      onDiagnostic: (stream, line) => this.options.onDiagnostic?.("runtime", stream, line),
      onExit: (info) => this.runtimeExited(record, client, info.expected),
    });
    record.client = client;
    try {
      await client.start();
      const health = await client.health();
      if (!health.ok || health.backendCodeDigest !== record.backendCodeDigest) {
        throw new Error("restarted App Runtime did not load its recorded backend digest");
      }
      if (record.client !== client || !client.rpc.isReady) throw new Error("restarted App Runtime exited");
      record.restartAttempt = 0;
      if (record.role === "active") {
        this.setStatus({ runtime: "ready", runtimePid: client.rpc.pid });
      }
    } catch (error) {
      const stillCurrent = record.client === client;
      if (stillCurrent) record.client = null;
      await client.stop().catch(() => {});
      if (stillCurrent) this.runtimeFailed(record);
      throw error;
    }
  }

  private stateExited(client: StateProcessClient, expected: boolean): void {
    if (this.stateProcess !== client) return;
    this.stateProcess = null;
    this.setStatus({ state: expected || this.stopping ? "stopped" : "down", statePid: undefined });
    if (!expected && this.acceptRestarts && !this.stopping) this.scheduleStateRestart();
  }

  private runtimeExited(record: RuntimeRecord, client: RuntimeProcessClient, expected: boolean): void {
    if (this.runtimes.get(record.backendCodeDigest) !== record || record.client !== client) return;
    record.client = null;
    if (record.role === "active") {
      this.setStatus({ runtime: expected || this.stopping ? "stopped" : "down", runtimePid: undefined });
    }
    if (!expected) this.runtimeFailed(record);
  }

  private runtimeFailed(record: RuntimeRecord): void {
    if (this.stopping || !this.acceptRestarts || this.runtimes.get(record.backendCodeDigest) !== record) return;
    if (record.role === "active") {
      if (this.runtimeWanted) this.scheduleRuntimeRestart(record);
      return;
    }
    if (record.role !== "retained") return;
    record.crashCount += 1;
    const limit = Math.max(1, Math.floor(this.options.retainedCrashLimit ?? 3));
    if (record.crashCount >= limit) {
      this.retireRecord(record);
      return;
    }
    this.scheduleRuntimeRestart(record);
  }

  private scheduleRuntimeRestart(record: RuntimeRecord): void {
    if (record.restartTimer || record.role === "retiring") return;
    const delays = record.role === "active"
      ? this.options.restartDelaysMs ?? [1_000, 5_000, 30_000]
      : this.options.retainedRestartDelaysMs ?? [1_000, 5_000];
    const attempt = record.restartAttempt++;
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? delays.at(-1) ?? 30_000;
    if (record.role === "active") this.setStatus({ runtime: "restarting", runtimePid: undefined });
    record.restartTimer = setTimeout(() => {
      record.restartTimer = null;
      if (
        this.stopping
        || !this.acceptRestarts
        || record.role === "retiring"
        || this.runtimes.get(record.backendCodeDigest) !== record
      ) return;
      void this.startRuntime(record).catch(() => {});
    }, delay);
    record.restartTimer.unref?.();
  }

  private scheduleStateRestart(): void {
    // A failed start normally reports through both the child's `exit` callback
    // and the rejected start promise. They are two observations of one crash,
    // not two restart jobs.
    if (this.stateTimer) return;
    const delays = this.options.restartDelaysMs ?? [1_000, 5_000, 30_000];
    const attempt = this.stateAttempt++;
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 30_000;
    this.setStatus({ state: "restarting" });
    const timer = setTimeout(() => {
      this.stateTimer = null;
      if (this.stopping || !this.acceptRestarts) return;
      void this.startState().catch(() => this.scheduleStateRestart());
    }, delay);
    timer.unref?.();
    this.stateTimer = timer;
  }

  private childEnv(): NodeJS.ProcessEnv {
    return {
      PATH: this.options.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin",
      NODE_ENV: this.options.env?.NODE_ENV ?? process.env.NODE_ENV ?? "production",
    };
  }

  private setStatus(patch: Partial<AppBackendStatus>): void {
    this.status_ = { ...this.status_, ...patch };
    this.options.onStatus?.(this.status);
  }

  private async withState<T>(call: (client: StateProcessClient) => Promise<T>): Promise<T> {
    const client = this.stateProcess;
    if (!client?.rpc.isReady) throw new AppBackendUnavailable("state");
    return await call(client);
  }

  private async withRuntime<T>(
    backendCodeDigest: string,
    call: (client: RuntimeProcessClient) => Promise<T>,
  ): Promise<T> {
    const record = this.runtimes.get(backendCodeDigest);
    if (!record || record.role === "retiring") {
      throw new AppBackendUnavailable("runtime", "version_retired");
    }
    const client = record.client;
    if (!client?.rpc.isReady) throw new AppBackendUnavailable("runtime");
    return await call(client);
  }

  private async withActiveRuntime<T>(call: (client: RuntimeProcessClient) => Promise<T>): Promise<T> {
    const record = this.activeRuntimeDigest ? this.runtimes.get(this.activeRuntimeDigest) : null;
    const client = record?.client;
    if (!client?.rpc.isReady) throw new AppBackendUnavailable("runtime");
    return await call(client);
  }
}

/**
 * Shared wiring for every app's children: where their code is, how they run.
 *
 * All of it is about THIS process (module paths inside the checkout, the child
 * `execArgv`, the environment to sanitise from) rather than about any app, so
 * it is declared once and every registered app inherits it. The per-app halves
 * — which directory holds its durable state, which materialised release its
 * sandbox loads — are the two arguments to `register`.
 */
export interface AppBackendRegistryOptions {
  stateExecArgv?: readonly string[];
  onStartupFailure?: (app: string, failure: AppBackendStartupFailure) => void;
  /**
   * Root under which each app gets its own state directory, named by its
   * stable app id. One root, one directory per app: two apps sharing a state
   * directory would interleave their commit files, and no later check could
   * separate them again.
   */
  stateRoot: string;
  stateModulePath: string;
  runtimeModulePath: string;
  execArgv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  restartDelaysMs?: readonly number[];
  retainedRestartDelaysMs?: readonly number[];
  retainedCrashLimit?: number;
  /** Old backend process pairs retained by one App; default 1. */
  maxRetainedRuntimes?: number;
  /** Old backend process pairs retained by this bot process; default 4. */
  maxRetainedRuntimesGlobal?: number;
  /** Simultaneously hosted App supervisors, including Session Plus; default 12. */
  maxHostedApps?: number;
  retainedLingerMs?: number;
  onDiagnostic?: (
    app: string,
    service: "state" | "runtime",
    stream: "stdout" | "stderr",
    line: string,
  ) => void;
  onStatus?: (app: string, status: AppBackendStatus) => void;
}

/** What an app's own composition contributes: where its release was materialised. */
export interface AppBackendRegistration {
  /** The materialised backend tree of the release this app starts on. */
  appDir: string;
}

/**
 * One `AppBackendSupervisor` per stable app id.
 *
 * Thin on purpose. It does three things a caller would otherwise repeat per
 * app: derive a private state directory, refuse a duplicate registration, and
 * own teardown. Starting stays with the caller because `runtime: boolean`
 * depends on whether that app has an active release.
 */
export class AppBackendRegistry {
  private readonly supervisors = new Map<string, AppBackendSupervisor>();
  private readonly retained = new Map<string, { retainedAt: number; retire: () => void }>();
  private readonly maxHostedApps: number;

  constructor(private readonly options: AppBackendRegistryOptions) {
    const limit = options.maxHostedApps ?? DEFAULT_MAX_HOSTED_APPS;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HOSTED_APPS) {
      throw new Error(`maxHostedApps must be an integer from 1 through ${MAX_HOSTED_APPS}`);
    }
    this.maxHostedApps = limit;
  }

  private trackRetained(key: string, retainedAt: number, retire: () => void): void {
    this.retained.set(key, { retainedAt, retire });
    const limit = Math.max(0, Math.floor(this.options.maxRetainedRuntimesGlobal ?? 4));
    while (this.retained.size > limit) {
      const oldest = [...this.retained.entries()]
        .sort((left, right) => left[1].retainedAt - right[1].retainedAt)[0];
      if (!oldest) return;
      this.retained.delete(oldest[0]);
      oldest[1].retire();
    }
  }

  /**
   * Build one app's supervisor. Not started; the caller decides that.
   *
   * The app id becomes a directory name, so it is checked against the same
   * grammar release descriptors already use. A composition that gets this wrong
   * fails loudly at construction rather than writing durable state somewhere
   * surprising.
   */
  assertCanRegister(stableAppId: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(stableAppId)) {
      throw new Error(`stable app id ${JSON.stringify(stableAppId)} is not usable as a state directory name`);
    }
    if (this.supervisors.has(stableAppId)) {
      throw new Error(`app ${stableAppId} already has a backend supervisor in this process`);
    }
    if (this.supervisors.size >= this.maxHostedApps) {
      throw new AppBackendCapacityExceeded(this.maxHostedApps);
    }
  }

  register(stableAppId: string, registration: AppBackendRegistration): AppBackendSupervisor {
    this.assertCanRegister(stableAppId);
    const supervisor = new AppBackendSupervisor({
      stateDir: path.join(this.options.stateRoot, stableAppId),
      appDir: registration.appDir,
      stateModulePath: this.options.stateModulePath,
      runtimeModulePath: this.options.runtimeModulePath,
      execArgv: this.options.execArgv,
      env: this.options.env,
      stateExecArgv: this.options.stateExecArgv,
      onStartupFailure: (failure) => this.options.onStartupFailure?.(stableAppId, failure),
      restartDelaysMs: this.options.restartDelaysMs,
      retainedRestartDelaysMs: this.options.retainedRestartDelaysMs,
      retainedCrashLimit: this.options.retainedCrashLimit,
      maxRetainedRuntimes: this.options.maxRetainedRuntimes,
      retainedLingerMs: this.options.retainedLingerMs,
      onRuntimeRetained: (digest, retainedAt, retire) =>
        this.trackRetained(`${stableAppId}\0${digest}`, retainedAt, retire),
      onRuntimeRemoved: (digest) => this.retained.delete(`${stableAppId}\0${digest}`),
      onDiagnostic: (service, stream, line) =>
        this.options.onDiagnostic?.(stableAppId, service, stream, line),
      onStatus: (status) => this.options.onStatus?.(stableAppId, status),
    });
    this.supervisors.set(stableAppId, supervisor);
    return supervisor;
  }

  get(stableAppId: string): AppBackendSupervisor | null {
    return this.supervisors.get(stableAppId) ?? null;
  }

  ids(): string[] {
    return [...this.supervisors.keys()];
  }

  /** Every app's children, for a shutdown that must not skip one. */
  async stopAll(): Promise<void> {
    for (const supervisor of this.supervisors.values()) {
      await supervisor.stop().catch(() => {});
    }
    this.retained.clear();
  }
}

/** Stable, bounded refusal for declaration and startup surfaces. */
export class AppBackendCapacityExceeded extends Error {
  readonly code = "app_backend_capacity";

  constructor(readonly limit: number) {
    super(
      `App 后端承载已满（上限 ${limit} 个，包含 Session Plus）；`
        + "请停用一个 App 或提高 session_plus.max_hosted_apps 后重启",
    );
    this.name = "AppBackendCapacityExceeded";
  }
}
