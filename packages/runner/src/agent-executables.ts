/** Device-private Agent selection. Library consumers opt in only at the Runner composition root. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readTrustGrant, type AgentTrustGrant, type AgentTrustPath } from "./agent-executable-policy.js";
import { AgentExecutableError, executableDiagnostic, type AgentDiagnosticCode, type AgentLocalDiagnostic } from "./agent-executable-errors.js";
import {
  absoluteCommandPath, AGENT_EXECUTABLE_PROVIDERS, discoverAgentCandidates, executablePlan, trustedExecutablePath, trustedDirectoryPath,
  type AgentCandidate, type AgentExecutablePlan, type ExecutableProvider,
} from "./agent-executable-discovery.js";

export { AGENT_EXECUTABLE_PROVIDERS, type AgentExecutablePlan, type ExecutableProvider };
export interface AgentBinding { entry: string; interpreter?: string; trust?: AgentTrustGrant }
type Selection = Pick<AgentCandidate, "entry" | "source">;
export interface AgentExecutableStatus {
  provider: ExecutableProvider;
  selected?: AgentExecutablePlan;
  reason?: string;
  diagnostic?: AgentDiagnosticCode;
  detail?: AgentLocalDiagnostic;
  candidates: Array<AgentCandidate & { reason?: string; target?: string; detail?: AgentLocalDiagnostic }>;
}
export interface AgentExecutableRegistryOptions {
  home: string;
  platform?: NodeJS.Platform;
  executionOnly?: boolean;
  /** Frozen bootstrap environment. Discovery never imports a later terminal's PATH. */
  directories?: readonly string[];
  persistSelections?: boolean;
  /** Test/embedding seam; normal Runner uses the platform's fixed system locations. */
  systemDirectories?: readonly string[];
}

export class AgentExecutableRegistry {
  readonly enabled: boolean;
  readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly directories: string[];
  private readonly persistSelections: boolean;
  private readonly systemDirectories?: readonly string[];
  private selections: Partial<Record<ExecutableProvider, Selection>>;

  constructor(options: AgentExecutableRegistryOptions) {
    this.home = path.resolve(options.home);
    this.platform = options.platform ?? process.platform;
    this.enabled = !options.executionOnly && (this.platform === "darwin" || this.platform === "linux");
    this.directories = [...new Set((options.directories ?? (process.env.PATH ?? "").split(path.delimiter))
      .filter(absoluteCommandPath))].slice(0, 128);
    this.persistSelections = options.persistSelections === true;
    this.systemDirectories = options.systemDirectories;
    this.selections = {};
    if (this.enabled) {
      // Automatic selections are a disposable cache; explicit bindings are not.
      try { this.selections = this.readSelections(); } catch { /* reconstruct from trusted sources */ }
    }
  }

  private file(name: string): string { return path.join(this.home, ".octopus", "runner", name); }

  private readSelections(): Partial<Record<ExecutableProvider, Selection>> {
    const rows = readPrivateJson(this.file("agent-selections.json"));
    const result: Partial<Record<ExecutableProvider, Selection>> = {};
    for (const provider of AGENT_EXECUTABLE_PROVIDERS) {
      const row = asRecord(rows[provider]);
      if (absoluteCommandPath(row.entry) && typeof row.source === "string") {
        result[provider] = { entry: row.entry, source: row.source };
      }
    }
    return result;
  }

  bindings(): Partial<Record<ExecutableProvider, AgentBinding>> {
    if (!this.enabled) return {};
    const rows = readPrivateJson(this.file("agent-bindings.json"));
    const result: Partial<Record<ExecutableProvider, AgentBinding>> = {};
    for (const key of Object.keys(rows)) {
      if (!isExecutableProvider(key)) throw new Error("invalid_bindings");
      const row = asRecord(rows[key]);
      if (!absoluteCommandPath(row.entry) || (row.interpreter !== undefined && !absoluteCommandPath(row.interpreter))) {
        throw new Error("invalid_bindings");
      }
      const trust = readTrustGrant(row.trust);
      result[key] = { entry: row.entry, ...(typeof row.interpreter === "string" ? { interpreter: row.interpreter } : {}), ...(trust ? { trust } : {}) };
    }
    return result;
  }

  bind(provider: ExecutableProvider, binding: AgentBinding | null, trustInstallation = false): void {
    if (!this.enabled) throw new Error("该设备仅提供执行环境，不启用 Agent 注册表");
    const rows = this.bindings();
    if (binding) {
      const capture: AgentTrustPath[] = [];
      executablePlan(provider, { entry: binding.entry, source: "binding" }, this.runtimeDirectories(), binding.interpreter,
        { platform: this.platform, ...(trustInstallation ? { capture } : {}) });
      rows[provider] = { entry: binding.entry, ...(binding.interpreter ? { interpreter: binding.interpreter } : {}),
        ...(trustInstallation ? { trust: { version: 1, paths: capture } as const } : {}) };
    } else delete rows[provider];
    writePrivateJson(this.file("agent-bindings.json"), rows);
  }

  private runtimeDirectories(): string[] {
    return [...this.directories, path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin",
      ...(this.platform === "darwin" ? ["/opt/homebrew/bin"] : [])];
  }

  inspect(provider: ExecutableProvider): AgentExecutableStatus {
    if (!this.enabled) return { provider, reason: "execution_only", candidates: [] };
    let binding: AgentBinding | undefined;
    try { binding = this.bindings()[provider]; }
    catch (error) { return { provider, reason: "invalid_bindings", diagnostic: "invalid_bindings", candidates: [],
      ...(error instanceof AgentExecutableError && error.detail ? { detail: error.detail } : {}) }; }
    const candidates = binding ? [{ entry: binding.entry, source: "binding" }]
      : discoverAgentCandidates(this.home, provider, this.directories, this.platform, this.systemDirectories);
    const plans: AgentExecutablePlan[] = [];
    const observed: AgentExecutableStatus["candidates"] = [];
    for (const candidate of candidates) {
      try {
        const plan = executablePlan(provider, candidate, this.runtimeDirectories(), binding?.interpreter, { platform: this.platform, trust: binding?.trust });
        plans.push(plan);
        observed.push({ ...candidate, target: plan.target });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (binding || code !== "ENOENT") observed.push({ ...candidate, reason: code === "ENOENT" ? "command_unavailable" : executableDiagnostic(error),
          ...(error instanceof AgentExecutableError && error.detail ? { detail: error.detail } : {}) });
      }
    }
    const previous = this.selections[provider];
    let selected: AgentExecutablePlan | undefined;
    if (binding) selected = plans[0];
    // The first trusted PATH entry is what this user's terminal runs. It is
    // re-resolved on every operation, so an installation placed earlier in
    // PATH (or removed from it) is followed; a remembered choice never beats it.
    else selected = plans.find((plan) => plan.preferred);
    if (!binding && !selected && previous) {
      // Without a PATH candidate, follow an explicitly declared nvm default, or the same stable installed entry.
      selected = plans.find((plan) => previous.source === "nvm_default"
        ? plan.source === "nvm_default" : plan.entry === previous.entry);
      // The entry may have disappeared from PATH metadata; retain and validate it locally.
      if (!selected && previous.source !== "nvm_default") {
        try { selected = executablePlan(provider, previous, this.runtimeDirectories(), undefined, { platform: this.platform }); }
        catch (error) {
          if (!observed.some((row) => row.entry === previous.entry)) observed.push({ ...previous, reason: executableDiagnostic(error),
            ...(error instanceof AgentExecutableError && error.detail ? { detail: error.detail } : {}) });
        }
      }
    } else if (!binding && !selected) {
      // nvm's explicit default suppresses other versions from that one manager, not other installations.
      const hasDefault = plans.some((plan) => plan.source === "nvm_default");
      const unique = plans.filter((plan) => !(hasDefault && plan.source === "nvm"))
        .filter((plan, index, all) => all.findIndex((other) => other.target === plan.target && other.interpreter === plan.interpreter) === index);
      if (unique.length === 1) selected = unique[0];
    }
    if (selected) {
      if (!binding && (!previous || previous.entry !== selected.entry || previous.source !== selected.source)) {
        const next = { ...this.selections, [provider]: { entry: selected.entry, source: selected.source } };
        if (this.persistSelections) {
          try { writePrivateJson(this.file("agent-selections.json"), next); }
          catch (error) { return { provider, reason: "selection_write_failed", candidates: observed,
            ...(error instanceof AgentExecutableError && error.detail ? { detail: error.detail } : {}) }; }
        }
        this.selections = next;
      }
      return { provider, selected, candidates: observed };
    }
    const failed = observed.find((row) => row.reason && (!previous || binding || row.entry === previous.entry));
    const reason = binding ? "binding_unavailable" : previous ? "selection_unavailable"
      : plans.length ? "multiple_installations" : failed?.reason ?? "command_unavailable";
    return { provider, candidates: observed, reason,
      diagnostic: executableDiagnostic(new Error((binding || previous) && failed?.reason === "command_unavailable" ? reason : failed?.reason ?? reason)),
      ...(failed?.detail ? { detail: failed.detail } : {}) };
  }

  resolve(provider: ExecutableProvider): AgentExecutablePlan {
    const status = this.inspect(provider);
    if (status.selected) return status.selected;
    const error = new AgentExecutableError(status.diagnostic ?? executableDiagnostic(new Error(status.reason)), status.detail);
    error.message = `Agent ${provider}: ${status.reason}${status.diagnostic && status.diagnostic !== status.reason ? ` (${status.diagnostic})` : ""}; 使用 octopus-runner agents list 检查本机选择`;
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function readPrivateJson(file: string): Record<string, unknown> {
  try { lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const target = trustedExecutablePath(file, false);
  const stat = statSync(target);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new AgentExecutableError("invalid_bindings", { stage: "registry", path: file, rule: "private_owner_mode" });
  if (statSync(target).size > 64 * 1024) throw new Error("registry_too_large");
  const value: unknown = JSON.parse(readFileSync(target, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_registry");
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== 1 || !envelope.entries || typeof envelope.entries !== "object" || Array.isArray(envelope.entries)) throw new Error("invalid_registry_version");
  return envelope.entries as Record<string, unknown>;
}
function writePrivateJson(file: string, value: unknown): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  trustedDirectoryPath(directory);
  // Validate before creating a temporary file; do not write through foreign/writable parents.
  const anchor = path.join(directory, `.agent-write-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(anchor, JSON.stringify({ version: 1, entries: value }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(anchor, file);
    chmodSync(file, 0o600);
  } finally { rmSync(anchor, { force: true }); }
}
export function isExecutableProvider(value: string): value is ExecutableProvider {
  return (AGENT_EXECUTABLE_PROVIDERS as readonly string[]).includes(value);
}

let registry: AgentExecutableRegistry | undefined;
const registryContext = new AsyncLocalStorage<AgentExecutableRegistry>();
const selections = new AsyncLocalStorage<Map<ExecutableProvider, AgentExecutablePlan>>();
/** Only the resident Runner opts in. Bot imports of provider libraries keep their explicit host environment. */
export function configureAgentExecutables(value?: AgentExecutableRegistry): void { registry = value; }
export function usingAgentExecutables<T>(value: AgentExecutableRegistry, run: () => T): T {
  return registryContext.run(value, run);
}
/** Lazy selection lets controls on a live process work even after its installed file was removed. */
export function withAgentOperation<T>(run: () => T): T {
  return selections.getStore() ? run() : selections.run(new Map(), run);
}

export function withAgentExecutable<T>(provider: ExecutableProvider, run: () => T): T {
  const currentRegistry = registryContext.getStore() ?? registry;
  if (!currentRegistry || selections.getStore()?.has(provider)) return run();
  const selected = currentRegistry.resolve(provider);
  const operation = selections.getStore();
  if (operation) { operation.set(provider, selected); return run(); }
  return selections.run(new Map([[provider, selected]]), run);
}

export function agentExecutable(provider: ExecutableProvider): AgentExecutablePlan | undefined {
  const selected = selections.getStore()?.get(provider);
  if (!selected) {
    const plan = (registryContext.getStore() ?? registry)?.resolve(provider);
    if (plan) selections.getStore()?.set(provider, plan);
    return plan;
  }
  // Bind one operation to one exact installation. A replacement after probing fails before spawn.
  const current = executablePlan(provider, selected, [], selected.interpreter, selected.policy);
  if (current.fingerprint !== selected.fingerprint) throw new AgentExecutableError("executable_changed");
  return selected;
}

export function agentCommand(provider: ExecutableProvider, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const plan = agentExecutable(provider);
  if (!plan) return { bin: provider as string, args: [...args], env, fingerprint: "ambient", entry: provider as string };
  // Only this child's environment gets its selected runtime; project tool PATH remains available.
  const childEnv = plan.interpreter ? { ...env, PATH: [path.dirname(plan.interpreter), env.PATH].filter(Boolean).join(path.delimiter) } : env;
  return {
    bin: plan.interpreter ?? plan.entry,
    args: [...(plan.interpreter ? [plan.target] : []), ...args],
    env: childEnv, fingerprint: plan.fingerprint, entry: plan.target,
  };
}

/** Bounded local diagnostics only. Authentication is deliberately handled by the account-aware caller. */
export async function probeAgentExecutable(provider: ExecutableProvider, env?: NodeJS.ProcessEnv): Promise<string> {
  const command = agentCommand(provider, ["--version"], env);
  const result = await promisify(execFile)(command.bin, command.args, {
    env: command.env, timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8",
  });
  return (result.stdout || result.stderr).split(/\r?\n/, 1)[0].slice(0, 120);
}

/** Check the replacement before an authorized takeover stops its exact old process. */
export async function preflightAgentExecutable(provider: ExecutableProvider): Promise<void> {
  if (!(registryContext.getStore() ?? registry)) return;
  await probeAgentExecutable(provider);
}
