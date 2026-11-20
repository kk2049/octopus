import type { RunnerCapabilityAdvertisement } from "./capability-protocol.js";
import type { MeetingTranscriptionAdvertisement } from "./meeting-transcription-protocol.js";
import { agentCommand, withAgentExecutable } from "./agent-executables.js";
import { codexAuthenticationAvailable } from "./codex-account-routing.js";
import { AgentExecutableError, executableDiagnostic, type AgentDiagnosticCode } from "./agent-executable-errors.js";
export { AGENT_DIAGNOSTIC_CODES, agentDiagnosticCode } from "./agent-executable-errors.js";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { listSessionWorkspaces } from "./workspaces.js";
import { SESSION_OPERATION_PROTOCOL } from "./gateway-protocol.js";

export const RUNNER_INVENTORY_SCHEMA = "runner-inventory/v1" as const;
export const RUNNER_AGENT_BACKENDS = ["claude", "codex", "omp"] as const;
export type RunnerAgentBackend = (typeof RUNNER_AGENT_BACKENDS)[number];

export interface RunnerCodexQuota {
  status: "available" | "unavailable";
  fetchedAt: string;
  windows: Array<{ remainingPercent: number; windowMinutes: number; resetsAt: string }>;
  /** Number of reset credits currently available for this subscription. */
  creditCount?: number;
  /** Earliest expiry among available reset credits reported by the provider. */
  creditExpiresAt?: string;
}
export interface RunnerCodexAccount {
  models?: import("@claude-bot/agent-sessions-contract/providers").ModelChoice[];
  id: string;
  /** Stable routing label, such as codexb; never derived from list position. */
  label: string;
  /** Masked subscription email for display; raw identity never leaves Runner. */
  emailLabel?: string;
  quota?: RunnerCodexQuota;
}

/** Claude uses the same bounded aggregate-window projection, without reset credits. */
export type RunnerClaudeAccount = RunnerCodexAccount;

/** Accept only the short or ellipsis-masked email form emitted by Runner. */
export function publicCodexEmailLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 3 || value.length > 160 || /[\s]/.test(value)) return undefined;
  const match = /^([^@]{1,40})@([^@]{1,120})$/.exec(value);
  if (!match || !match[1] || !match[2]) return undefined;
  const local = match[1];
  if (local.length > 5 && !local.includes("…")) return undefined;
  return value;
}

/** Additive public fields only; malformed quota never invalidates the device inventory. */
export function publicCodexQuota(value: unknown): RunnerCodexQuota | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!['available', 'unavailable'].includes(String(row.status)) || typeof row.fetchedAt !== "string"
    || !Number.isFinite(Date.parse(row.fetchedAt)) || row.fetchedAt.length > 40
    || !Array.isArray(row.windows) || row.windows.length > 2) return undefined;
  const windows: RunnerCodexQuota["windows"] = [];
  for (const value of row.windows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { remainingPercent, windowMinutes, resetsAt } = value;
    if (typeof remainingPercent !== "number" || !Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100
      || typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes) || windowMinutes <= 0 || windowMinutes > 525_600
      || typeof resetsAt !== "string" || resetsAt.length > 40 || !Number.isFinite(Date.parse(resetsAt))) return undefined;
    windows.push({ remainingPercent, windowMinutes, resetsAt });
  }
  const creditCount = row.creditCount;
  if (creditCount !== undefined
    && (typeof creditCount !== "number" || !Number.isInteger(creditCount) || creditCount < 0 || creditCount > 100_000)) return undefined;
  const creditExpiresAt = typeof creditCount === "number" && creditCount > 0
    && typeof row.creditExpiresAt === "string" && row.creditExpiresAt.length <= 40
    && Number.isFinite(Date.parse(row.creditExpiresAt)) ? row.creditExpiresAt : undefined;
  return { status: row.status as RunnerCodexQuota["status"], fetchedAt: row.fetchedAt, windows,
    ...(creditCount === undefined ? {} : { creditCount }),
    ...(creditExpiresAt === undefined ? {} : { creditExpiresAt }) };
}

export interface RunnerAgentBackendInventory {
  kind: RunnerAgentBackend;
  available: boolean;
  version?: string;
  /** Can this backend run with every workspace/command tool bound to another Runner? */
  split_execution: boolean;
  split_execution_reason?: "local_tools_unfilterable";
  reason?: "command_unavailable" | "probe_failed" | "authentication_unavailable";
  /** Additive v1 detail; old Gateways can retain the legacy reason and ignore this field. */
  diagnostic_code?: AgentDiagnosticCode;
  /** The local path and rule that made an executable unavailable, shown to the device owner. */
  diagnostic_detail?: AgentDiagnosticDetail;
}

export interface AgentDiagnosticDetail { path: string; rule: string }

/** Bounded wire form of a local executable diagnostic; anything else is dropped, never fatal. */
export function publicAgentDiagnosticDetail(value: unknown): AgentDiagnosticDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { path: file, rule } = value as Record<string, unknown>;
  return typeof file === "string" && file.startsWith("/") && file.length <= 1024 && !/[\x00-\x1f\x7f]/.test(file)
    && typeof rule === "string" && /^[a-z][a-z_]{0,63}$/.test(rule) ? { path: file, rule } : undefined;
}

/**
 * Bounded capability facts reported by one authenticated Runner connection.
 * Credentials and environment values never enter this projection; the only
 * local path is the offending one of an unavailable Agent executable.
 */
export interface RunnerInventory {
  capabilities?: RunnerCapabilityAdvertisement;
  schema: typeof RUNNER_INVENTORY_SCHEMA;
  /** Native session listing/projection is enabled; absent on older Runners. */
  session_roster?: boolean;
  /** Durable managed model operations are enabled; absent on older/execution-only Runners. */
  session_operations?: { protocol: typeof SESSION_OPERATION_PROTOCOL };
  /**
   * `RUNNER_ALLOW_MACHINE_OPS=0`: the device lists and reads sessions and
   * refuses everything else — sending, starting, forking, shell, files. Cards
   * and tools use it to offer reading only. Absent means a normal device.
   */
  read_only?: true;
  agent_backends: RunnerAgentBackendInventory[];
  /** Public registered choices only; no home paths, credentials or new grants. */
  ticket_options?: {
    protocol: "ticket-options/v1";
    codex_accounts: RunnerCodexAccount[];
    claude_accounts?: RunnerClaudeAccount[];
    workspaces: Array<{ id: string; label: string }>;
  };
  execution: {
    platform: string;
    arch: string;
    shell: boolean;
    workspace_files: boolean;
    workspace_count: number;
    /** Codex exec-server can serve remote execution without model credentials. */
    codex_exec_server: boolean;
    /**
     * The session MCP proxy accepts a read-only execution scope (one that
     * lists and reads its workspace and runs no command): a Feishu document
     * assistant. Absent on older Runners, whose probe would refuse that launch.
     */
    read_only_scope?: true;
  };
  /** Private durable builder protocol. Omitted on old/disabled Runners so the bot never probes unknown RPC methods. */
  workspace_development?: { protocol: "workspace-development/v1"; available: boolean;
    reason?: "disabled" | "machine_ops_disabled" | "unsupported_platform" | "git_unavailable" | "timeout_unavailable";
    max_bundle_bytes: number; max_artifact_chunk_bytes: number };
  file_transfer?: { protocol: "workspace-file-transfer/v1" };
  workspace_jobs?: { protocol: "workspace-jobs/v1"; concurrency: 1; max_log_chunk_bytes: 65536; max_artifact_chunk_bytes?: 1048576 };
  meeting_transcription_jobs?: MeetingTranscriptionAdvertisement;
  knowledge_index_jobs?: {
    protocol: "knowledge-index-jobs/v1";
    concurrency: 1;
    max_chunk_bytes: number;
  };
  /** Opt-in loopback DSH endpoint; no path, credential or non-loopback host is disclosed. */
  dsh?: {
    available: boolean;
    port?: number;
  };
  /** Private per-OS-user MCP endpoint; policy is server-side and intentionally absent here. */
  local_mcp?: {
    available: boolean;
    protocol: "runner-local-mcp/v1";
    clients: RunnerAgentBackend[];
  };
  /**
   * This host injects its owner's model login into guest clients' model
   * requests (`model-tunnel/v1`). Opt-in per host; providers are the routes
   * it can serve. No path, account or credential is disclosed.
   */
  model_egress?: {
    available: boolean;
    protocol: "model-egress/v1";
    providers: Array<"anthropic" | "openai">;
  };
  /** Physical-screen automation, advertised only for the logged-in macOS console user. */
  gui_automation?: {
    available: boolean;
    protocol: "runner-macos-gui/v1";
    consent_ttl_seconds: 900;
  };
}

export interface RunnerInventoryProbe {
  command(bin: string, args: readonly string[]): Promise<{ stdout: string }>;
  /** Native account/read fallback for providers that do not use Codex login. */
  codexAuthentication?(): Promise<boolean>;
  workspaceCount(home: string): Promise<number>;
  workspaces?(home: string): Promise<Array<{ id: string; label: string }>>;
}

const VERSION_MAX = 120;
const WORKSPACE_COUNT_MAX = 10_000;
const execFileAsync = promisify(execFile);

/**
 * Build the PATH used by both backend discovery and provider child processes.
 *
 * A resident Runner commonly starts under systemd with only the system PATH,
 * while the same user's interactive shell finds OMP and other CLIs in
 * `~/.local/bin`. Advertising from one PATH and spawning from another would be
 * worse, so bootstrap installs this value process-wide before either happens.
 * Only directories owned by the Runner uid and not writable by group/other are
 * added; RUNNER_SCAN_HOME must not turn somebody else's writable bin directory
 * into executable authority for this process.
 */
export function runnerAgentPath(home: string, inherited = process.env.PATH ?? ""): string {
  if (typeof process.getuid !== "function") return inherited;
  const uid = process.getuid();
  const root = path.resolve(home);
  const homeBins = [path.join(root, ".local", "bin"), path.join(root, "bin")]
    .filter((directory) => safeOwnedBin(directory, uid));
  // Preserve the service's explicit/system command precedence; user-local bins
  // are a fallback for commands the inherited PATH genuinely cannot resolve.
  return [inherited, ...homeBins].filter(Boolean).join(path.delimiter);
}

function safeOwnedBin(directory: string, uid: number): boolean {
  try {
    const stat = statSync(directory);
    return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function defaultProbe(env?: NodeJS.ProcessEnv): RunnerInventoryProbe {
  return {
    codexAuthentication: () => codexAuthenticationAvailable({ env, timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }),
    async command(bin, args) {
      const command = (RUNNER_AGENT_BACKENDS as readonly string[]).includes(bin)
        ? agentCommand(bin as RunnerAgentBackend, args, env)
        : { bin, args: [...args], env };
      const result = await execFileAsync(command.bin, command.args, {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        env: command.env,
      });
      return { stdout: result.stdout };
    },
    async workspaces(home) {
      return (await listSessionWorkspaces(home, [], { includeManaged: false })).workspaces.map(({ id, label }) => ({ id, label }));
    },
    async workspaceCount(home) {
      const result = await listSessionWorkspaces(home, [], { includeManaged: false });
      return Math.min(result.workspaces.length, WORKSPACE_COUNT_MAX);
    },
  };
}

/** First Codex release whose app-server and local exec-server expose environments. */
const CODEX_REMOTE_ENVIRONMENT_MIN = [0, 147, 0] as const;

export function codexSplitExecutionAvailable(version: string): boolean {
  const match = version.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$|-)/);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let index = 0; index < CODEX_REMOTE_ENVIRONMENT_MIN.length; index++) {
    if (actual[index] !== CODEX_REMOTE_ENVIRONMENT_MIN[index]) {
      return actual[index] > CODEX_REMOTE_ENVIRONMENT_MIN[index];
    }
  }
  return true;
}

/** Probe bounded local facts; callers may repeat this to discover installation changes. */
export async function discoverRunnerInventory(
  home: string,
  options: {
    allowMachineOps?: boolean;
    executionOnly?: boolean;
    codexAccounts?: Array<{ slot: string; label: string }>;
    codexAccountInventory?: () => Promise<RunnerCodexAccount[]>;
    claudeAccountInventory?: () => Promise<RunnerClaudeAccount[]>;
    probe?: RunnerInventoryProbe;
    /** Explicit environment for local diagnostics of an installed service. */
    env?: NodeJS.ProcessEnv;
    dsh?: () => Promise<{ available: boolean; port?: number }>;
    meetingTranscription?: () => Promise<MeetingTranscriptionAdvertisement>;
    knowledgeIndexJobs?: boolean;
    capabilities?: RunnerCapabilityAdvertisement;
    workspaceJobs?: boolean;
    workspaceDevelopment?: boolean;
    localMcp?: { available: boolean; clients?: readonly RunnerAgentBackend[] };
    guiAutomation?: { available: boolean };
    /**
     * The resident's memory of each backend's last successful probe. One
     * failed re-probe (a slow `--version` under load) is not evidence that the
     * installation changed: it keeps the previous facts for that refresh, and a
     * second consecutive failure is reported. Missing or untrusted executables
     * are reported at once.
     */
    probeMemory?: Map<RunnerAgentBackend, { backend: RunnerAgentBackendInventory; failed: boolean }>;
  } = {},
): Promise<RunnerInventory> {
  const probe = options.probe ?? defaultProbe(options.env);
  let developmentReason: NonNullable<RunnerInventory["workspace_development"]>["reason"];
  if (options.workspaceDevelopment !== undefined) {
    developmentReason = options.allowMachineOps === false ? "machine_ops_disabled"
      : os.platform() !== "linux" ? "unsupported_platform" : !options.workspaceDevelopment ? "disabled" : undefined;
    if (!developmentReason) {
      try { await probe.command("git", ["--version"]); } catch { developmentReason = "git_unavailable"; }
      if (!developmentReason) {
        try { await probe.command("timeout", ["--version"]); } catch { developmentReason = "timeout_unavailable"; }
      }
    }
  }
  let codexExecServer = false;
  const agentBackends = options.executionOnly
    ? RUNNER_AGENT_BACKENDS.map((kind): RunnerAgentBackendInventory => ({
        kind,
        available: false,
        split_execution: kind !== "codex",
        ...(kind === "codex" ? { split_execution_reason: "local_tools_unfilterable" as const } : {}),
        reason: "command_unavailable",
      }))
    : await Promise.all(RUNNER_AGENT_BACKENDS.map(async (kind): Promise<RunnerAgentBackendInventory> => {
      try {
        const backend = await withAgentExecutable(kind, async (): Promise<RunnerAgentBackendInventory> => {
        const result = await probe.command(kind, ["--version"]);
        const version = versionLine(result.stdout);
        const splitExecution = kind !== "codex" || codexSplitExecutionAvailable(version);
        if (kind === "codex") {
          codexExecServer = splitExecution;
          try {
            await probe.command("codex", ["login", "status"]);
          } catch (error) {
            if (error instanceof AgentExecutableError || ["ENOENT", "EACCES", "EPERM"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
            const authenticated = await probe.codexAuthentication?.().catch((probeError: unknown) => {
              // Do not turn a changed/untrusted executable into an auth verdict.
              if (probeError instanceof AgentExecutableError) throw probeError;
              return false;
            });
            if (!authenticated) return {
              kind,
              available: false,
              split_execution: splitExecution,
              ...(version ? { version } : {}),
              reason: "authentication_unavailable" as const,
            };
          }
        }
        return {
          kind,
          available: true,
          split_execution: splitExecution,
          ...(kind === "codex" && !splitExecution
            ? { split_execution_reason: "local_tools_unfilterable" as const }
            : {}),
          ...(version ? { version } : {}),
        };
        });
        options.probeMemory?.set(kind, { backend, failed: false });
        return backend;
      } catch (error) {
        const diagnostic = executableDiagnostic(error);
        const previous = options.probeMemory?.get(kind);
        if ((diagnostic === "probe_failed" || diagnostic === "probe_timeout") && previous && !previous.failed) {
          previous.failed = true;
          // The execution side's exec-server fact comes from the same probe.
          if (kind === "codex") codexExecServer = previous.backend.split_execution;
          return previous.backend;
        }
        options.probeMemory?.delete(kind);
        const detail = publicAgentDiagnosticDetail(error instanceof AgentExecutableError ? error.detail : undefined);
        return {
          kind,
          available: false,
          split_execution: kind !== "codex",
          ...(kind === "codex" ? { split_execution_reason: "local_tools_unfilterable" as const } : {}),
          reason: diagnostic === "command_unavailable" ? "command_unavailable" : "probe_failed",
          ...(!["command_unavailable", "probe_failed"].includes(diagnostic) ? { diagnostic_code: diagnostic } : {}),
          ...(detail ? { diagnostic_detail: detail } : {}),
        };
      }
    }));
  let workspaceCount = 0;
  try {
    workspaceCount = await probe.workspaceCount(home);
  } catch {
    workspaceCount = 0;
  }
  const dsh = !options.executionOnly && options.dsh
    ? await options.dsh().catch(() => ({ available: false as const }))
    : undefined;
  return {
    schema: RUNNER_INVENTORY_SCHEMA,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    session_roster: !options.executionOnly,
    ...(!options.executionOnly && options.allowMachineOps !== false
      ? { session_operations: { protocol: SESSION_OPERATION_PROTOCOL } } : {}),
    ...(!options.executionOnly && options.allowMachineOps === false ? { read_only: true as const } : {}),
    agent_backends: agentBackends,
    ticket_options: {
      protocol: "ticket-options/v1",
      codex_accounts: options.executionOnly ? [] : options.codexAccountInventory ? await options.codexAccountInventory() : [
        { id: "@default", label: "codex" },
        ...(options.codexAccounts ?? []).slice(0, 26).map(({ slot, label }) => ({ id: slot, label: `codex${label}` })),
      ],
      ...(!options.executionOnly && options.claudeAccountInventory
        ? { claude_accounts: await options.claudeAccountInventory() } : {}),
      workspaces: options.allowMachineOps === false ? [] : (await probe.workspaces?.(home).catch(() => []) ?? [])
        .slice(0, 100).map(({ id, label }) => ({ id, label: label.slice(0, 120) })),
    },
    execution: {
      platform: os.platform().slice(0, 32),
      arch: os.arch().slice(0, 32),
      shell: options.allowMachineOps !== false,
      workspace_files: options.allowMachineOps !== false,
      workspace_count: Math.max(0, Math.min(Math.trunc(workspaceCount), WORKSPACE_COUNT_MAX)),
      codex_exec_server: options.executionOnly ? false : codexExecServer,
      read_only_scope: true,
    },
    ...(options.allowMachineOps !== false ? { file_transfer: { protocol: "workspace-file-transfer/v1" as const } } : {}),
    ...(options.workspaceDevelopment !== undefined ? {
      workspace_development: { protocol: "workspace-development/v1" as const,
        available: !developmentReason, ...(developmentReason ? { reason: developmentReason } : {}),
        max_bundle_bytes: 128 * 1024 * 1024, max_artifact_chunk_bytes: 1024 * 1024 },
    } : {}),
    ...(options.meetingTranscription ? { meeting_transcription_jobs: await options.meetingTranscription() } : {}),
    ...(options.workspaceJobs && options.allowMachineOps !== false ? { workspace_jobs: { protocol: "workspace-jobs/v1" as const, concurrency: 1 as const, max_log_chunk_bytes: 65536 as const, max_artifact_chunk_bytes: 1048576 as const } } : {}),
      ...(options.knowledgeIndexJobs && options.allowMachineOps !== false
        ? {
            knowledge_index_jobs: {
              protocol: "knowledge-index-jobs/v1" as const,
              concurrency: 1 as const,
              max_chunk_bytes: 1024 * 1024,
            },
          }
        : {}),
    ...(dsh ? { dsh } : {}),
    ...(options.localMcp && !options.executionOnly
      ? {
          local_mcp: {
            available: options.localMcp.available,
            protocol: "runner-local-mcp/v1" as const,
            clients: [...new Set(options.localMcp.clients ?? [])]
              .filter((kind): kind is RunnerAgentBackend =>
                (RUNNER_AGENT_BACKENDS as readonly string[]).includes(kind)),
          },
        }
      : {}),
    ...(options.guiAutomation?.available && !options.executionOnly && options.allowMachineOps !== false
      ? {
          gui_automation: {
            available: true,
            protocol: "runner-macos-gui/v1" as const,
            consent_ttl_seconds: 900 as const,
          },
        }
      : {}),
  };
}

/**
 * Generation-ordered inventory refreshes. A refresh superseded by a newer one
 * resolves `null`; one whose probe never settles never resolves at all.
 * Registration is the liveness path and must wait on neither: it takes the
 * newest completed inventory and waits only until the first one exists. A
 * fresher inventory follows on the next periodic `inventory_changed`.
 */
export class RunnerInventoryRefresh<T> {
  private generation = 0;
  private completed: T | undefined;
  private current: Promise<T | null>;

  constructor(private readonly discover: () => Promise<T>) {
    this.current = this.begin();
  }

  /** Start a refresh that supersedes any still in flight. */
  refresh(): Promise<T | null> {
    this.current = this.begin();
    return this.current;
  }

  /** The newest refresh's result, waiting for it. */
  async latest(): Promise<T> {
    for (;;) {
      const inventory = await this.current;
      if (inventory) return inventory;
    }
  }

  /** What a connecting gateway socket registers with. */
  async forRegistration(): Promise<T> {
    return this.completed ?? await this.latest();
  }

  private begin(): Promise<T | null> {
    const generation = ++this.generation;
    return this.discover().then((inventory) => {
      if (generation !== this.generation) return null;
      this.completed = inventory;
      return inventory;
    });
  }
}

/** The first line naming a version; a leading notice line must not hide it. */
function versionLine(value: string): string {
  const lines = String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines.find((line) => /\d+\.\d+\.\d+/.test(line)) ?? lines[0] ?? "").slice(0, VERSION_MAX);
}
