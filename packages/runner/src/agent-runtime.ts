/**
 * Device-local evidence about interactive Claude Code / Codex / omp processes.
 *
 * Hooks are observations, never authority.  A hook tells us which session fired
 * and gives us a short-lived child pid.  The registry walks that child's
 * ancestors, records the actual CLI process, and binds it to Linux's process
 * incarnation (`pid + /proc starttime + boot id`).  Every later liveness check
 * and signal re-validates that tuple, so pid reuse cannot target a stranger.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export type AgentProvider = "claude" | "codex" | "omp";

/** Every provider this device can observe and control, in projection order. */
export const AGENT_PROVIDERS: readonly AgentProvider[] = ["claude", "codex", "omp"];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return AGENT_PROVIDERS.includes(value as AgentProvider);
}
export type AgentTurnState = "working" | "idle" | "needs_input" | "unknown";
export type AgentProcessState = "alive" | "exited" | "unknown";
export type AgentControlMode = "external_cli" | "octopus_headless" | "unknown";

export interface ProcessIdentity {
  pid: number;
  startTicks: string;
  bootId: string;
  pgid: number;
  tty: number;
  command: string;
  /** Private evidence that this Codex TUI opted into Runner's app-server. */
  codexRemoteEndpoint?: string;
}

/** Device-private process evidence used by the control plane, never projected. */
export interface AgentRuntimeInspection {
  process?: ProcessIdentity;
  processState: AgentProcessState;
  turnState: AgentTurnState;
  controlMode: AgentControlMode;
  event: string;
  /** When this device last saw ANY evidence about the session. */
  observedAt: string;
  exactProcessAlive: boolean;
  /**
   * True when `octopus_headless` means "Octopus spawned a DETACHED CLI" rather
   * than "this process is driving an attachment right now". The two look
   * identical in `controlMode`, but only the detached one can be stopped and
   * re-taken; the attached one must be interrupted through its own attachment.
   */
  detached: boolean;
}

/** A session switch proven to belong to one exact, still-live CLI process. */
export interface AgentRuntimeRebound {
  sessionId: string;
  observedAt: string;
}

interface RuntimeRecord {
  provider: AgentProvider;
  sessionId: string;
  process?: ProcessIdentity;
  processState: AgentProcessState;
  turnState: AgentTurnState;
  controlMode: AgentControlMode;
  event: string;
  tool?: string;
  cwd?: string;
  transcriptPath?: string;
  observedAt: string;
  degraded?: boolean;
  /** Octopus started this CLI detached; no attachment in any process owns it. */
  detached?: true;
}

export interface PublicAgentRuntime {
  process_state: AgentProcessState;
  turn_state: AgentTurnState;
  control_mode: AgentControlMode;
  observed_at: string;
  event: string;
  tool?: string;
  degraded: boolean;
  capabilities: {
    observe: true;
    append_when_idle: boolean;
    takeover: boolean;
    interrupt: boolean;
    steer: boolean;
  };
}

export interface ProcSnapshot {
  pid: number;
  ppid: number;
  pgid: number;
  tty: number;
  startTicks: string;
  bootId: string;
  command: string;
  argv: string[];
}

export interface ProcessReader {
  read(pid: number): Promise<ProcSnapshot | null>;
  signal(pid: number, signal: NodeJS.Signals): void;
}

export interface AgentRuntimeOptions {
  stateFile?: string;
  processReader?: ProcessReader;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
  interruptGraceMs?: number;
  terminateGraceMs?: number;
  quiescenceMs?: number;
}

const KNOWN_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "StopFailure",
]);

/** Linux /proc implementation. Unsupported platforms simply degrade. */
export class LinuxProcessReader implements ProcessReader {
  async read(pid: number): Promise<ProcSnapshot | null> {
    if (!Number.isInteger(pid) || pid <= 1 || process.platform !== "linux") return null;
    try {
      const [stat, cmdline, bootId] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, "utf8"),
        fs.readFile(`/proc/${pid}/cmdline`),
        fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      if (fields.length < 20) return null;
      const argv = cmdline.toString("utf8").split("\0").filter(Boolean);
      return {
        pid,
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
        tty: Number(fields[4]),
        startTicks: fields[19],
        bootId: bootId.trim(),
        command: stat.slice(stat.indexOf("(") + 1, close),
        argv,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH" || code === "EACCES") return null;
      throw error;
    }
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    process.kill(pid, signal);
  }
}

/** Find the CLI ancestor of a hook subprocess. Exported for deterministic tests. */
export async function findAgentAncestor(
  reader: ProcessReader,
  reporterPid: number,
  provider: AgentProvider,
): Promise<ProcessIdentity | null> {
  let current = await reader.read(reporterPid);
  // Never match the reporter itself: its argv necessarily contains the provider
  // word and would turn the hook helper into the "agent" process.
  let pid = current?.ppid ?? 0;
  for (let depth = 0; pid > 1 && depth < 32; depth += 1) {
    current = await reader.read(pid);
    if (!current) return null;
    if (matchesProvider(current, provider)) {
      const codexRemoteEndpoint = provider === "codex" ? loopbackCodexRemote(current.argv) : "";
      return {
        pid: current.pid,
        startTicks: current.startTicks,
        bootId: current.bootId,
        pgid: current.pgid,
        tty: current.tty,
        command: current.command,
        ...(codexRemoteEndpoint ? { codexRemoteEndpoint } : {}),
      };
    }
    if (current.ppid === pid) return null;
    pid = current.ppid;
  }
  return null;
}

export class AgentRuntimeRegistry {
  private readonly changedRecords = new Map<string, { provider: AgentProvider; sessionId: string }>();
  private readonly records = new Map<string, RuntimeRecord>();
  private readonly aliveRecords = new Map<string, RuntimeRecord>();
  private readonly managed = new Set<string>();
  /** Subset of `managed` that Octopus launched detached (no live attachment). */
  private readonly detachedLaunches = new Set<string>();
  private readonly takeovers = new Set<string>();
  private readonly reader: ProcessReader;
  private readonly now: () => Date;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly stateFile?: string;
  private readonly interruptGraceMs: number;
  private readonly terminateGraceMs: number;
  private readonly quiescenceMs: number;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly changeListeners = new Set<(change?: { provider: AgentProvider; sessionId: string }) => void>();

  constructor(options: AgentRuntimeOptions = {}) {
    this.reader = options.processReader ?? new LinuxProcessReader();
    this.now = options.now ?? (() => new Date());
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.stateFile = options.stateFile;
    this.interruptGraceMs = options.interruptGraceMs ?? 1_500;
    this.terminateGraceMs = options.terminateGraceMs ?? 2_000;
    this.quiescenceMs = options.quiescenceMs ?? 250;
  }

  async load(): Promise<void> {
    if (!this.stateFile) return;
    try {
      const doc = JSON.parse(await fs.readFile(this.stateFile, "utf8")) as { records?: unknown };
      if (!Array.isArray(doc.records)) return;
      for (const raw of doc.records) {
        const row = runtimeRecord(raw);
        if (!row) continue;
        const key = keyOf(row.provider, row.sessionId);
        // No attachment survives a Runner restart. A restored `octopus_headless`
        // record whose process is still alive is therefore something nobody is
        // driving — treat it as a detached launch so it keeps a stop/takeover
        // route instead of projecting a session with no possible action at all.
        if (row.controlMode === "octopus_headless") {
          this.setRecord(key, { ...row, detached: true });
          this.detachedLaunches.add(key);
          this.managed.add(key);
          continue;
        }
        this.setRecord(key, row);
      }
      await this.reconcile();
      this.changedRecords.clear();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Corrupt observation state must never prevent the Runner from serving.
        this.records.clear();
        this.aliveRecords.clear();
        this.managed.clear();
        this.detachedLaunches.clear();
      }
    }
  }

  async recordHook(provider: AgentProvider, payload: unknown, reporterPid: number): Promise<boolean> {
    const input = hookInput(payload);
    if (!input || !KNOWN_EVENTS.has(input.event)) return false;
    const key = keyOf(provider, input.sessionId);
    const prior = this.records.get(key);
    const identity = await findAgentAncestor(this.reader, reporterPid, provider);
    const eventState = stateForEvent(input.event);
    const ended = input.event === "SessionEnd";
    if (identity) this.detachOtherSessions(provider, key, identity);
    if (identity && prior?.process && !sameIdentity(identity, prior.process)) this.forgetManaged(key);
    if (ended) this.forgetManaged(key);
    const managedIdentity = this.managed.has(key) || Boolean(
      !ended && identity && prior?.process && sameIdentity(identity, prior.process)
        && prior.controlMode === "octopus_headless",
    );
    // A detached launch keeps that label for as long as this exact incarnation
    // is the one being observed; a new incarnation is different evidence.
    const detachedLaunch = managedIdentity && (this.detachedLaunches.has(key) || Boolean(
      identity && prior?.process && sameIdentity(identity, prior.process) && prior.detached,
    ));
    const record: RuntimeRecord = {
      provider,
      sessionId: input.sessionId,
      ...(!ended && identity ? { process: identity } : !ended && prior?.process ? { process: prior.process } : {}),
      // SessionEnd terminates the association, not necessarily the host CLI
      // process (Codex may keep the client alive), so report unknown, not exited.
      processState: ended ? "unknown" : identity ? "alive" : prior?.processState ?? "unknown",
      turnState: eventState.turn,
      controlMode: ended ? "unknown" : managedIdentity ? "octopus_headless" : identity ? "external_cli" : prior?.controlMode ?? "unknown",
      event: input.event,
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
      observedAt: this.now().toISOString(),
      ...(eventState.degraded || !identity ? { degraded: true } : {}),
      ...(detachedLaunch ? { detached: true as const } : {}),
    };
    this.setRecord(key, record);
    await this.persist();
    this.emitChanged({ provider, sessionId: input.sessionId });
    return true;
  }

  /**
   * Record an external CLI this device DISCOVERED rather than one that called
   * a hook.
   *
   * omp needs this because it has no external hook command: its extension
   * points are in-process TS modules, so making an omp TUI report to Octopus
   * would mean installing code into the person's `~/.omp`. It does not need
   * to — omp already publishes the binding itself (a tty→session breadcrumb
   * per terminal), and a session file whose tail says what the agent is doing.
   * Discovery is therefore strictly less invasive than the hook path, and this
   * method is where that evidence enters the same record store.
   *
   * Two facts are deliberately NOT derivable this way: managed ownership (only
   * an attachment this process opened may claim `octopus_headless`, so a
   * managed key is left untouched here) and blocking interactions (nothing is
   * being intercepted, so there is nothing to answer).
   */
  async observeExternalCli(input: {
    provider: AgentProvider;
    sessionId: string;
    identity: ProcessIdentity;
    turnState: AgentTurnState;
    event: string;
    tool?: string;
    cwd?: string;
    transcriptPath?: string;
  }): Promise<boolean> {
    if (!input.sessionId) return false;
    const key = keyOf(input.provider, input.sessionId);
    // An attachment this process drives is the authority on its own session.
    // A discovery pass must never relabel it as somebody else's foreground CLI.
    if (this.managed.has(key) && !this.detachedLaunches.has(key)) return false;
    const prior = this.records.get(key);
    if (prior?.controlMode === "octopus_headless" && prior.detached !== true) return false;
    this.detachOtherSessions(input.provider, key, input.identity);
    if (prior?.process && !sameIdentity(input.identity, prior.process)) this.forgetManaged(key);
    const record: RuntimeRecord = {
      provider: input.provider,
      sessionId: input.sessionId,
      process: input.identity,
      processState: "alive",
      turnState: input.turnState,
      controlMode: this.managed.has(key) ? "octopus_headless" : "external_cli",
      event: input.event,
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
      observedAt: this.now().toISOString(),
      ...(this.detachedLaunches.has(key) ? { detached: true as const } : {}),
    };
    const unchanged = prior
      && prior.processState === record.processState
      && prior.turnState === record.turnState
      && prior.controlMode === record.controlMode
      && prior.event === record.event
      && prior.tool === record.tool
      && prior.process
      && sameIdentity(prior.process, input.identity);
    // A discovery sweep runs on every roster refresh. Only a CHANGED fact is
    // worth a durable write and a wake-up for every SSE listener.
    if (unchanged) { this.records.set(key, record); this.aliveRecords.set(key, record); }
    else this.setRecord(key, record);
    if (unchanged && this.changedRecords.size === 0) return true;
    await this.persist();
    this.emitChanged();
    return true;
  }

  /** A vanished process or explicitly refused discovery no longer proves session ownership. */
  async forgetExternalCli(
    provider: AgentProvider,
    sessionId: string,
    refusedDiscoveryEvent?: "CodexRolloutObserved",
  ): Promise<void> {
    const key = keyOf(provider, sessionId);
    const row = this.records.get(key);
    if (!row || row.controlMode !== "external_cli") return;
    // A still-live PID cannot rescue an old rollout discovery that the fresh
    // inode/header check refused. Do not invalidate stronger hook evidence.
    const proofLost = refusedDiscoveryEvent !== undefined && row.event === refusedDiscoveryEvent;
    if (!proofLost && row.process && await this.sameProcess(row.process)) return;
    const { process: _gone, detached: _wasDetached, ...rest } = row;
    this.setRecord(key, {
      ...rest,
      processState: proofLost ? "unknown" : "exited",
      turnState: "idle",
      controlMode: "unknown",
      event: proofLost ? "DiscoveryLost" : "SessionGone",
      observedAt: this.now().toISOString(),
    });
    this.forgetManaged(key);
    await this.persist();
    this.emitChanged();
  }

  async reconcile(): Promise<void> {
    let changed = false;
    for (const [key, record] of this.aliveRecords) {
      if (!record.process) continue;
      const alive = await this.sameProcess(record.process);
      const state: AgentProcessState = alive ? "alive" : "exited";
      if (record.processState !== state) {
        this.setRecord(key, { ...record, processState: state, observedAt: this.now().toISOString() });
        changed = true;
      }
      if (!alive) this.forgetManaged(key);
    }
    if (changed) {
      await this.persist();
      this.emitChanged();
    }
  }

  /**
   * A foreground CLI's turn ended without a lifecycle hook — Claude Code fires
   * no Stop hook when Esc interrupts a turn. Transcript evidence (`after`) must
   * be newer than the last observation; the Runner's own confirmed stop
   * (`unchangedSince`) applies only if no hook has arrived since it checked.
   * Either way a turn started later keeps its working state.
   */
  async observeTurnEnded(provider: AgentProvider, sessionId: string,
    evidence: { after: string } | { unchangedSince: string; identity: ProcessIdentity }): Promise<boolean> {
    const key = keyOf(provider, sessionId);
    const row = this.records.get(key);
    if (!row || row.controlMode !== "external_cli" || row.turnState !== "working") return false;
    if ("after" in evidence ? !(evidence.after > row.observedAt)
      : row.observedAt !== evidence.unchangedSince || !row.process || !sameIdentity(row.process, evidence.identity)) return false;
    const { tool: _tool, ...rest } = row;
    this.setRecord(key, { ...rest, turnState: "idle", event: "TurnEnded", observedAt: this.now().toISOString() });
    await this.persist();
    this.emitChanged({ provider, sessionId });
    return true;
  }

  /**
   * The session an MCP server's spawning CLI is running now — what "self"
   * means for a tool call that server forwards. The CLI is found exactly as a
   * hook reporter's is (process ancestry, pid + start ticks + boot id), so the
   * answer comes from the process tree, never from the model. A process runs
   * one session at a time; if stale rows linger, the freshest evidence wins.
   */
  async sessionOfCaller(clientPid: number): Promise<{ provider: AgentProvider; sessionId: string } | null> {
    for (const provider of AGENT_PROVIDERS) {
      const identity = await findAgentAncestor(this.reader, clientPid, provider);
      if (!identity) continue;
      const row = [...this.aliveRecords.values()]
        .filter((candidate) => candidate.provider === provider && candidate.process && sameIdentity(candidate.process, identity))
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
      return row ? { provider, sessionId: row.sessionId } : null;
    }
    return null;
  }

  /** Device-private live inventory; historical records never enter a poll. */
  observedSessions():Array<{ source: AgentProvider; id: string; path?: string; process: ProcessIdentity; event: string }> {
    return [...this.aliveRecords.values()].flatMap((row) => row.process ? [{
      source: row.provider, id: row.sessionId, path: row.transcriptPath, process: { ...row.process }, event: row.event,
    }] : []);
  }

  /** Content-free device-local change signal; callers must re-read by capability. */
  onChanged(listener: (change?: { provider: AgentProvider; sessionId: string }) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  publicRuntime(provider: AgentProvider, sessionId: string): PublicAgentRuntime | undefined {
    const row = this.records.get(keyOf(provider, sessionId));
    if (!row) return undefined;
    const alive = row.processState === "alive";
    const external = alive && row.controlMode === "external_cli";
    // A live DETACHED Octopus launch (`claude -p` / `codex exec`, or anything
    // restored after a Runner restart) has no attachment anyone can steer and
    // no tmux pane anyone can type into. Without a takeover route it projects
    // zero usable actions, which is the "Octopus 接管不了这个 agent" dead end.
    const detachedHeadless = alive && row.controlMode === "octopus_headless" && row.detached === true;
    return {
      process_state: row.processState,
      turn_state: row.turnState,
      control_mode: row.controlMode,
      observed_at: row.observedAt,
      event: row.event,
      ...(row.tool ? { tool: row.tool } : {}),
      degraded: row.degraded === true,
      capabilities: {
        observe: true,
        append_when_idle: !alive,
        takeover: external || detachedHeadless,
        // Sending SIGINT to an arbitrary foreground TUI is not a complete
        // provider-level interrupt contract. Only a native managed attachment
        // advertises this capability through AgentControlPlane.
        interrupt: false,
        // Codex app-server can steer a native managed turn, but the CLI-hook
        // compatibility adapter cannot promise that semantic.
        steer: false,
      },
    };
  }

  /**
   * Revalidate and return the local half of one attachment.
   *
   * This method intentionally returns pid identity only inside the Runner. The
   * public projection continues to go through `publicRuntime`, whose shape has
   * no pid, cwd, tty, command line, or transcript path.
   */
  async inspect(provider: AgentProvider, sessionId: string): Promise<AgentRuntimeInspection | undefined> {
    const key = keyOf(provider, sessionId);
    const row = this.records.get(key);
    if (!row) return undefined;
    const exactProcessAlive = Boolean(row.process && await this.sameProcess(row.process));
    if (row.process && row.processState !== (exactProcessAlive ? "alive" : "exited")) {
      this.setRecord(key, {
        ...row,
        processState: exactProcessAlive ? "alive" : "exited",
        observedAt: this.now().toISOString(),
      });
      await this.persist();
    }
    const current = this.records.get(key)!;
    return {
      ...(exactProcessAlive && current.process ? { process: current.process } : {}),
      processState: exactProcessAlive ? "alive" : current.process ? "exited" : current.processState,
      turnState: current.turnState,
      controlMode: current.controlMode,
      event: current.event,
      observedAt: current.observedAt,
      exactProcessAlive,
      detached: current.detached === true,
    };
  }

  /**
   * Resolve the new session after an interactive CLI switches threads without
   * exiting. This is intentionally narrower than a cwd or tty lookup: the old
   * record must have been detached by a hook from the same exact process
   * incarnation, and that process must still map to exactly one new session.
   */
  async reboundSession(
    provider: AgentProvider,
    previousSessionId: string,
    identity: ProcessIdentity,
  ): Promise<AgentRuntimeRebound | undefined> {
    const previousKey = keyOf(provider, previousSessionId);
    const previous = this.records.get(previousKey);
    if (previous?.event !== "SessionRebound" || !(await this.sameProcess(identity))) return undefined;
    const matches = [...this.records.entries()].filter(([key, row]) => (
      key !== previousKey
      && row.provider === provider
      && row.processState === "alive"
      && row.process !== undefined
      && sameIdentity(row.process, identity)
    ));
    if (matches.length !== 1) return undefined;
    const [, rebound] = matches[0]!;
    return { sessionId: rebound.sessionId, observedAt: rebound.observedAt };
  }

  /**
   * Move device-private process/runtime evidence across one provider-issued id
   * change. If a rebound hook already created the target row, that fresher
   * exact-process evidence wins and the detached source row is retired.
   */
  async renameSession(provider: AgentProvider, from: string, to: string): Promise<void> {
    if (from === to) return;
    const sourceKey = keyOf(provider, from);
    const targetKey = keyOf(provider, to);
    const source = this.records.get(sourceKey);
    const target = this.records.get(targetKey);
    let changed = false;

    if (source) {
      if (!target) this.setRecord(targetKey, { ...source, sessionId: to });
      this.records.delete(sourceKey);
      this.aliveRecords.delete(sourceKey);
      changed = true;
    }
    if (this.managed.delete(sourceKey)) {
      this.managed.add(targetKey);
      changed = true;
    }
    if (this.detachedLaunches.delete(sourceKey)) {
      this.detachedLaunches.add(targetKey);
      changed = true;
    }
    if (this.takeovers.delete(sourceKey)) {
      this.takeovers.add(targetKey);
      changed = true;
    }
    if (!changed) return;
    this.changedRecords.set(sourceKey, { provider, sessionId: from });
    this.changedRecords.set(targetKey, { provider, sessionId: to });
    await this.persist();
    this.emitChanged();
  }

  async beginHeadless(provider: AgentProvider, sessionId: string): Promise<() => Promise<void>> {
    const key = keyOf(provider, sessionId);
    this.managed.add(key);
    // This process now owns an attachment for the session, so it is no longer a
    // detached launch: stopping it belongs to that attachment, not to a signal.
    this.detachedLaunches.delete(key);
    const row = this.records.get(key);
    if (row) {
      const { detached: _wasDetached, ...rest } = row;
      this.setRecord(key, { ...rest, controlMode: "octopus_headless", observedAt: this.now().toISOString() });
      await this.persist();
      this.emitChanged();
    }
    return async () => {
      this.managed.delete(key);
      // A headless child normally exits just before this callback. Reconcile
      // first so a dead child is never briefly re-labelled as an external CLI.
      await this.reconcile();
      const current = this.records.get(key);
      if (current?.controlMode === "octopus_headless") {
        this.setRecord(key, {
          ...current,
          controlMode: current.processState === "alive" ? "external_cli" : "unknown",
          observedAt: this.now().toISOString(),
        });
        await this.persist();
        this.emitChanged();
      }
    };
  }

  /** Mark a detached Octopus launch managed until its exact process exits. */
  async markHeadless(provider: AgentProvider, sessionId: string): Promise<void> {
    const key = keyOf(provider, sessionId);
    this.managed.add(key);
    this.detachedLaunches.add(key);
    const row = this.records.get(key);
    if (row) {
      this.setRecord(key, {
        ...row,
        controlMode: "octopus_headless",
        detached: true,
        observedAt: this.now().toISOString(),
      });
      await this.persist();
      this.emitChanged();
    }
  }

  /**
   * Stop exactly the observed CLI incarnation. SIGKILL and process-name scans
   * are deliberately absent: inability to prove a clean stop is a refusal.
   *
   * Two shapes qualify: an interactive external CLI, and a DETACHED Octopus
   * launch. The second one used to be unreachable — no attachment could steer
   * it and no pane could be typed into, so the session projected no action at
   * all. An attachment this process is actively driving is still refused: it
   * has a native interrupt, and signalling it would race that owner.
   */
  async takeover(provider: AgentProvider, sessionId: string): Promise<{ interrupted: true }> {
    const key = keyOf(provider, sessionId);
    if (this.takeovers.has(key)) throw new Error("这个会话正在被另一个接管操作处理");
    this.takeovers.add(key);
    try {
      const row = this.records.get(key);
      const stoppable = row?.controlMode === "external_cli"
        || (row?.controlMode === "octopus_headless" && row.detached === true);
      if (row?.controlMode === "octopus_headless" && row.detached !== true) {
        throw new Error("这个会话已有一轮 Octopus 托管轮次在执行；请用「停止本轮」结束它，而不是接管");
      }
      if (!row?.process || !stoppable) {
        throw new Error("Runner 没有可核验的前台 CLI 进程；请刷新状态后重试");
      }
      if (!(await this.sameProcess(row.process))) {
        this.setRecord(key, { ...row, processState: "exited", observedAt: this.now().toISOString() });
        await this.persist();
        throw new Error("原 CLI 已经退出；请刷新会话后使用普通恢复");
      }

      await this.safeSignal(row.process, "SIGINT");
      let stopped = await this.waitUntilGone(row.process, this.interruptGraceMs);
      if (!stopped) {
        await this.safeSignal(row.process, "SIGTERM");
        stopped = await this.waitUntilGone(row.process, this.terminateGraceMs);
      }
      if (!stopped) throw new Error("原 CLI 没有在 SIGINT/SIGTERM 后退出；为避免误杀，Runner 拒绝继续恢复");
      await this.waitForTranscript(row.transcriptPath);
      // The stopped incarnation was the only thing this bookkeeping described.
      // Leaving it in `managed`/`detachedLaunches` would re-label whatever
      // resumes next as work nobody in this process is actually driving.
      this.forgetManaged(key);
      const { detached: _stopped, ...rest } = row;
      this.setRecord(key, {
        ...rest,
        processState: "exited",
        turnState: "idle",
        event: "OctopusTakeover",
        observedAt: this.now().toISOString(),
      });
      await this.persist();
      this.emitChanged();
      return { interrupted: true };
    } finally {
      this.takeovers.delete(key);
    }
  }

  async assertAppendable(provider: AgentProvider, sessionId: string, takeover: boolean): Promise<void> {
    const row = this.records.get(keyOf(provider, sessionId));
    if (!row?.process || !(await this.sameProcess(row.process))) return;
    const detachedLaunch = row.controlMode === "octopus_headless" && row.detached === true;
    if (row.controlMode === "octopus_headless" && !detachedLaunch) {
      throw new Error("这个会话已有一轮 Octopus 任务在执行");
    }
    if (!takeover) {
      const error = new Error(detachedLaunch
        ? "这个会话是 Octopus 在后台启动的 CLI，它仍在运行；普通续跑会和它并发写入同一个会话。请选择“立即接管并发送”。"
        : "原 CLI 仍在运行；普通续跑不会与它并发写入。请选择“立即接管并发送”。");
      (error as Error & { code?: string }).code = "session_active";
      throw error;
    }
    await this.takeover(provider, sessionId);
  }

  /** One place to drop every "Octopus owns this" fact about a session key. */
  private forgetManaged(key: string): void {
    this.managed.delete(key);
    this.detachedLaunches.delete(key);
  }

  private async sameProcess(identity: ProcessIdentity): Promise<boolean> {
    const current = await this.reader.read(identity.pid);
    return Boolean(current && current.startTicks === identity.startTicks && current.bootId === identity.bootId);
  }

  /** One interactive CLI can switch sessions without exiting. Only its most
   * recently observed session may retain control authority for that process. */
  private detachOtherSessions(provider: AgentProvider, currentKey: string, identity: ProcessIdentity): void {
    for (const [key, row] of this.aliveRecords) {
      if (key === currentKey || row.provider !== provider || !row.process || !sameIdentity(row.process, identity)) continue;
      const { process: _detached, detached: _wasDetached, ...rest } = row;
      this.setRecord(key, {
        ...rest,
        processState: "unknown",
        turnState: "idle",
        controlMode: "unknown",
        event: "SessionRebound",
        observedAt: this.now().toISOString(),
      });
      this.forgetManaged(key);
    }
  }

  private async safeSignal(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<void> {
    // Check immediately before every signal. This closes the pid-reuse gap
    // between the earlier decision and escalation as far as /proc permits.
    if (!(await this.sameProcess(identity))) throw new Error("目标 CLI 在发送信号前已经退出或发生了 PID 复用");
    try {
      this.reader.signal(identity.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private async waitUntilGone(identity: ProcessIdentity, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (!(await this.sameProcess(identity))) return true;
      await this.wait(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    return !(await this.sameProcess(identity));
  }

  private async waitForTranscript(file: string | undefined): Promise<void> {
    if (!file || this.quiescenceMs <= 0) return;
    let prior = await fileStamp(file);
    const deadline = Date.now() + Math.max(1_000, this.quiescenceMs * 4);
    while (Date.now() < deadline) {
      await this.wait(this.quiescenceMs);
      const current = await fileStamp(file);
      if (current === prior) return;
      prior = current;
    }
  }

  private async persist(): Promise<void> {
    if (!this.stateFile) return;
    // Hook processes can finish at nearly the same instant. Serialize snapshots
    // so an older write cannot race a newer observation back onto disk.
    const snapshot = JSON.stringify({ version: 1, records: [...this.records.values()] }, null, 2);
    const work = this.persistQueue.then(async () => {
      await fs.mkdir(path.dirname(this.stateFile!), { recursive: true, mode: 0o700 });
      const temp = `${this.stateFile}.${process.pid}.tmp`;
      await fs.writeFile(temp, snapshot, { mode: 0o600 });
      await fs.rename(temp, this.stateFile!);
    });
    this.persistQueue = work.catch(() => {});
    await work;
  }

  private setRecord(key: string, record: RuntimeRecord): void {
    if (record.process && record.processState === "alive") this.aliveRecords.set(key, record);
    else this.aliveRecords.delete(key);
    this.records.set(key, record);
    this.changedRecords.set(key, { provider: record.provider, sessionId: record.sessionId });
  }

  private emitChanged(change?: { provider: AgentProvider; sessionId: string }): void {
    if (change) this.changedRecords.set(keyOf(change.provider, change.sessionId), change);
    const changes = [...this.changedRecords.values()];
    this.changedRecords.clear();
    for (const change of changes) {
      for (const listener of [...this.changeListeners]) {
        try { listener(change); } catch { /* observation cannot break the CLI */ }
      }
    }
  }
}

export function matchesProvider(proc: ProcSnapshot, provider: AgentProvider): boolean {
  const base = path.basename(proc.argv[0] || proc.command).toLowerCase();
  if (provider === "omp") {
    // omp ships as one self-contained binary, so there is no interpreter
    // spelling to accept. A `--mode rpc` child is Octopus's own attachment,
    // not a person's TUI: treating it as one would advertise a takeover that
    // signals the process this Runner is already driving.
    if (base !== "omp" && base !== "omp.exe") return false;
    return !proc.argv.some((arg, index) => arg === "rpc" && proc.argv[index - 1] === "--mode")
      && !proc.argv.includes("--mode=rpc")
      && !proc.argv.includes("--mode=rpc-ui");
  }
  if (provider === "codex") {
    if (base !== "codex" && base !== "codex.exe") return false;
    // Runner's shared app-server is provider infrastructure, not a user's CLI.
    // Hooks emitted by a managed turn inherit this ancestor; treating it as an
    // external CLI would advertise an unsafe takeover that could kill every
    // managed Codex session on the Runner.
    return proc.argv[1]?.toLowerCase() !== "app-server";
  }
  if (base === "claude" || base === "claude.exe") return true;
  if (base === "node" || base === "nodejs") {
    const launcher = proc.argv.slice(1, 4).join("/").toLowerCase();
    return launcher.includes("@anthropic-ai/claude-code") || launcher.includes("/claude-code/");
  }
  return false;
}

function loopbackCodexRemote(argv: string[]): string {
  const index = argv.indexOf("--remote");
  const endpoint = index >= 0 ? argv[index + 1] ?? "" : "";
  return /^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint) ? endpoint : "";
}

function keyOf(provider: AgentProvider, sessionId: string): string {
  return `${provider}\0${sessionId}`;
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.startTicks === right.startTicks && left.bootId === right.bootId;
}

function hookInput(value: unknown): {
  sessionId: string;
  event: string;
  tool?: string;
  cwd?: string;
  transcriptPath?: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const sessionId = bounded(row.session_id, 256);
  const event = bounded(row.hook_event_name, 64);
  if (!sessionId || !event) return null;
  const tool = bounded(row.tool_name, 160);
  const cwd = bounded(row.cwd, 4_096);
  const transcriptPath = bounded(row.transcript_path, 8_192);
  return {
    sessionId,
    event,
    ...(tool ? { tool } : {}),
    ...(cwd ? { cwd } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
  };
}

function stateForEvent(event: string): { turn: AgentTurnState; degraded?: true } {
  if (event === "PermissionRequest" || event === "PermissionDenied") return { turn: "needs_input" };
  if (event === "Stop" || event === "SessionEnd") return { turn: "idle" };
  if (event === "StopFailure") return { turn: "idle", degraded: true };
  if (event === "SessionStart") return { turn: "idle" };
  return { turn: "working" };
}

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function runtimeRecord(value: unknown): RuntimeRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<RuntimeRecord>;
  if (!isAgentProvider(row.provider) || !bounded(row.sessionId, 256)) return null;
  if (!row.observedAt || !row.event) return null;
  return row as RuntimeRecord;
}

async function fileStamp(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}
