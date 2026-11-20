import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AgentExecutableRegistry } from "./agent-executables.js";
import { parseAdditionalSites, validateSiteId, type RunnerSitePolicy } from "./gateway-sites.js";

export interface RunnerInstallConfig extends RunnerSitePolicy {
  version: 1;
  dashboard_url: string;
  runner_url: string;
  device: string;
  scan_home: string;
  codex_home: string;
  /** Explicit local CLI PATH, persisted for macOS services which lack the terminal environment. */
  agent_path?: string[];
  execution_only?: boolean;
  execution_shell?: string;
  /** Trusted local executable directories, ahead of app-launcher aliases on Windows. */
  execution_path?: string[];
  installed_at: string;
  /**
   * Windows scheduled task name. Absent means the historical `OctopusRunner`;
   * a guest client installs beside an ordinary Runner as `OctopusGuest`.
   */
  service_name?: string;
  /** This device is a guest client: which agents its console windows offer. */
  guest?: RunnerGuestConfig;
  /** The owner's logins that guest sessions on this host use directly (historical key name). */
  model_egress?: ModelEgressConfig;
  /** This device hosts its owner's guests' agents, sandboxed (`guest-sessions.ts`). */
  guest_sessions?: GuestSessionsConfig;
}

export const RUNNER_GUEST_PROVIDERS = ["anthropic", "openai"] as const;
export type RunnerGuestProvider = typeof RUNNER_GUEST_PROVIDERS[number];

export interface RunnerGuestConfig {
  providers: RunnerGuestProvider[];
}

export interface GuestSessionsConfig {
  /** Guest homes and the shared read-only tools; must not be inside a 0700 home. */
  root: string;
  /** Loopback HTTPS port for the guests' model requests and PC tools. */
  port: number;
  /** Prepended to the agent's command, e.g. a memory guard: ["memguard", "--rss-gib", "8", "--"]. */
  launch_prefix?: string[];
  /** Extra environment for guest sessions, e.g. package mirrors (PIP_INDEX_URL, NPM_CONFIG_REGISTRY). */
  env?: Record<string, string>;
}

/** Where the host's own model logins live; they are read on the host only. */
export interface ModelEgressConfig {
  /** Claude Code config directory holding `.credentials.json` (OAuth login). */
  anthropic?: { config_dir: string };
  /** Codex home holding a ChatGPT-login `auth.json`. */
  openai?: { codex_home: string };
}

export interface RunnerInstallPaths {
  root: string;
  bundle: string;
  previousBundle: string;
  config: string;
  token: string;
  logs: string;
  stdoutLog: string;
  stderrLog: string;
  wrapperDir: string;
  wrapper: string;
}

export function runnerInstallPaths(
  scanHome = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): RunnerInstallPaths {
  const paths = platform === "win32" ? path.win32 : path;
  const home = paths.resolve(scanHome);
  const root = paths.join(home, ".octopus", "runner");
  const logs = paths.join(root, "logs");
  const wrapperDir = paths.join(home, ".local", "bin");
  return {
    root,
    bundle: paths.join(root, "standalone.js"),
    previousBundle: paths.join(root, "standalone.prev.js"),
    config: paths.join(root, "config.json"),
    token: paths.join(root, "token"),
    logs,
    stdoutLog: paths.join(logs, "runner.out.log"),
    stderrLog: paths.join(logs, "runner.err.log"),
    wrapperDir,
    wrapper: paths.join(wrapperDir, platform === "win32" ? "octopus-runner.cmd" : "octopus-runner"),
  };
}

export function readInstalledConfig(scanHome = os.homedir()): RunnerInstallConfig {
  const file = runnerInstallPaths(scanHome).config;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 Runner 安装配置 ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Runner 安装配置格式无效");
  const value = parsed as Record<string, unknown>;
  const config: RunnerInstallConfig = {
    version: Number(value.version) as 1,
    dashboard_url: String(value.dashboard_url ?? ""),
    runner_url: String(value.runner_url ?? ""),
    device: String(value.device ?? ""),
    scan_home: String(value.scan_home ?? ""),
    codex_home: String(value.codex_home ?? ""),
    ...(value.agent_path !== undefined ? { agent_path: readAgentPath(value.agent_path) } : {}),
    ...(typeof value.execution_only === "boolean" ? { execution_only: value.execution_only } : {}),
    ...(typeof value.execution_shell === "string" && value.execution_shell ? { execution_shell: value.execution_shell } : {}),
    ...(value.execution_path !== undefined ? { execution_path: readExecutionPath(value.execution_path) } : {}),
    installed_at: String(value.installed_at ?? ""),
    ...(value.additional_sites !== undefined ? { additional_sites: parseAdditionalSites(value.additional_sites) } : {}),
    ...(typeof value.control_site === "string" ? { control_site: value.control_site } : {}),
    ...(typeof value.update_site === "string" ? { update_site: value.update_site } : {}),
    ...(typeof value.primary_enabled === "boolean" ? { primary_enabled: value.primary_enabled } : {}),
    ...(value.service_name !== undefined ? { service_name: readServiceName(value.service_name) } : {}),
    ...(value.guest !== undefined ? { guest: readGuestConfig(value.guest) } : {}),
    ...(value.model_egress !== undefined ? { model_egress: readModelEgressConfig(value.model_egress) } : {}),
    ...(value.guest_sessions !== undefined ? { guest_sessions: readGuestSessionsConfig(value.guest_sessions) } : {}),
  };
  if (config.version !== 1
    || !/^https?:\/\//.test(config.dashboard_url)
    || !/^wss?:\/\//.test(config.runner_url)
    || !config.device
    || !path.isAbsolute(config.scan_home)
    || !path.isAbsolute(config.codex_home)
    || (config.execution_shell !== undefined && !path.isAbsolute(config.execution_shell))
    || !config.installed_at) {
    throw new Error("Runner 安装配置缺少有效的版本、地址、设备或目录");
  }
  return config;
}

export function writeInstalledConfig(config: RunnerInstallConfig): RunnerInstallPaths {
  const paths = runnerInstallPaths(config.scan_home);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  mkdirSync(paths.wrapperDir, { recursive: true, mode: 0o755 });
  chmodSync(paths.root, 0o700);
  atomicWrite(paths.config, JSON.stringify(config, null, 2) + "\n", 0o600);
  if (process.platform === "win32") {
    hardenWindowsPath(paths.root, true);
    hardenWindowsPath(paths.config, false);
  }
  return paths;
}

export function writeRunnerToken(scanHome: string, token: string): string {
  if (!/^rt_[0-9a-f]{32,}$/.test(token)) throw new Error("服务器返回了无效的 Runner token");
  const paths = runnerInstallPaths(scanHome);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  atomicWrite(paths.token, token + "\n", 0o600);
  if (process.platform === "win32") hardenWindowsPath(paths.token, false);
  return paths.token;
}

export function writeRunnerSiteToken(scanHome: string, siteId: string, token: string): string {
  validateSiteId(siteId);
  if (siteId === "primary" || siteId === "none") throw new Error("Reserved site id");
  if (!/^rt_[0-9a-f]{32,}$/.test(token)) throw new Error("Invalid Runner site token");
  const root = path.join(runnerInstallPaths(scanHome).root, "sites");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `${siteId}.token`);
  atomicWrite(file, token + "\n", 0o600);
  if (process.platform === "win32") { hardenWindowsPath(root, true); hardenWindowsPath(file, false); }
  return file;
}

export function installManagedBundle(scanHome: string, source: string): string {
  const paths = runnerInstallPaths(scanHome);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const bytes = readFileSync(path.resolve(source));
  if (existsSync(paths.bundle) && path.resolve(source) !== paths.bundle) {
    atomicWrite(paths.previousBundle, readFileSync(paths.bundle), 0o755);
  }
  if (path.resolve(source) !== paths.bundle) atomicWrite(paths.bundle, bytes, 0o755);
  else chmodSync(paths.bundle, 0o755);
  return paths.bundle;
}

export function installCliWrapper(scanHome: string, nodePath = process.execPath): string {
  const paths = runnerInstallPaths(scanHome);
  mkdirSync(paths.wrapperDir, { recursive: true, mode: 0o755 });
  const script = runnerCliWrapper(scanHome, nodePath);
  atomicWrite(paths.wrapper, script, 0o755);
  ensureUserPath(scanHome, paths.wrapperDir);
  return paths.wrapper;
}

export function applyInstalledEnvironment(
  scanHome = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): RunnerInstallConfig {
  const config = readInstalledConfig(scanHome);
  const paths = runnerInstallPaths(config.scan_home);
  process.env.OCTOPUS_URL ??= config.runner_url;
  process.env.OCTOPUS_RUNNER_TOKEN_FILE ??= paths.token;
  process.env.RUNNER_DEVICE ??= config.device;
  process.env.RUNNER_SCAN_HOME ??= config.scan_home;
  process.env.CODEX_HOME ??= config.codex_home;
  if (platform === "darwin") process.env.PATH = installedAgentPath(config, process.env.PATH);
  if (platform === "win32" && config.execution_path?.length) {
    process.env.PATH = [...new Set([...config.execution_path, ...(process.env.PATH ?? "").split(";")])].join(";");
  }
  if (config.execution_only) process.env.RUNNER_EXECUTION_ONLY ??= "1";
  if (config.execution_shell) process.env.RUNNER_EXEC_SHELL ??= config.execution_shell;
  if (config.execution_only) {
    process.env.RUNNER_AGENT_HOOKS ??= "off";
    process.env.RUNNER_LOCAL_MCP ??= "off";
    process.env.OCTOPUS_RUNNER_DSH_TUNNEL ??= "0";
    process.env.RUNNER_KNOWLEDGE_INDEX ??= "0";
  }
  process.env.OCTOPUS_RUNNER_SUPERVISED ??= "1";
  return config;
}

export const MACOS_SERVICE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Old installation fields remain intact for rollback; they seed discovery instead of selecting at spawn. */
export function installedAgentRegistry(
  home: string,
  options: { executionOnly?: boolean; persistSelections?: boolean; diagnostic?: boolean } = {},
): AgentExecutableRegistry {
  const config = existsSync(runnerInstallPaths(home).config) ? readInstalledConfig(home) : undefined;
  const inherited = options.diagnostic ? MACOS_SERVICE_PATH : process.env.PATH ?? MACOS_SERVICE_PATH;
  return new AgentExecutableRegistry({
    home, executionOnly: options.executionOnly || config?.execution_only,
    persistSelections: options.persistSelections,
    directories: [...(config?.agent_path ?? []), ...inherited.split(path.delimiter)],
  });
}

/**
 * These directories are explicit authority from the local CLI environment,
 * like its inherited PATH. Never source profiles or infer a version-manager
 * directory from scan_home. Drop relative/empty entries so daemon cwd cannot
 * turn a terminal PATH into authority over a different directory.
 */
function absoluteAgentPath(values: string[]): string[] {
  return [...new Set(values.filter((value) => path.posix.isAbsolute(value) && !/[\x00-\x1f\x7f:]/.test(value)))];
}

function readServiceName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,47}$/.test(value)) {
    throw new Error("Runner service_name 只能是字母开头的字母、数字或连字符");
  }
  return value;
}

export function readGuestConfig(value: unknown): RunnerGuestConfig {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const providers = Array.isArray(row?.providers) ? row.providers : [];
  if (!row || !providers.length
    || providers.some((provider) => !(RUNNER_GUEST_PROVIDERS as readonly unknown[]).includes(provider))) {
    throw new Error("Runner guest 配置需要 anthropic/openai providers");
  }
  return { providers: [...new Set(providers as RunnerGuestProvider[])] };
}

export function readGuestSessionsConfig(value: unknown): GuestSessionsConfig {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const port = Number(row?.port);
  const prefix = row?.launch_prefix;
  const prefixValid = prefix === undefined || (Array.isArray(prefix) && prefix.length <= 32
    && prefix.every((part) => typeof part === "string" && part.length > 0 && part.length <= 512));
  const env = row?.env;
  const envValid = env === undefined || (Boolean(env) && typeof env === "object" && !Array.isArray(env)
    && Object.entries(env as Record<string, unknown>).every(([key, value]) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(key) && typeof value === "string" && value.length <= 1024));
  if (!row || typeof row.root !== "string" || !path.isAbsolute(row.root)
    || !Number.isInteger(port) || port < 1024 || port > 65_535
    || !prefixValid || !envValid) {
    throw new Error("Runner guest_sessions 需要绝对路径 root、1024–65535 的 port，launch_prefix 为字符串数组，env 为大写变量名到字符串");
  }
  return {
    root: path.resolve(row.root), port,
    ...(prefix !== undefined ? { launch_prefix: [...prefix as string[]] } : {}),
    ...(env !== undefined ? { env: { ...env as Record<string, string> } } : {}),
  };
}

export function readModelEgressConfig(value: unknown): ModelEgressConfig {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!row) throw new Error("Runner model_egress 配置格式无效");
  const directory = (entry: unknown, key: string): string => {
    const raw = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>)[key] : undefined;
    if (typeof raw !== "string" || !path.isAbsolute(raw)) throw new Error(`Runner model_egress.${key} 必须是绝对路径`);
    return path.resolve(raw);
  };
  const result: ModelEgressConfig = {
    ...(row.anthropic !== undefined ? { anthropic: { config_dir: directory(row.anthropic, "config_dir") } } : {}),
    ...(row.openai !== undefined ? { openai: { codex_home: directory(row.openai, "codex_home") } } : {}),
  };
  if (!result.anthropic && !result.openai) throw new Error("Runner model_egress 至少要配置 anthropic 或 openai");
  return result;
}

function readAgentPath(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")
    || absoluteAgentPath(value).length !== value.length) {
    throw new Error("Runner agent_path 必须是无重复的绝对命令目录列表");
  }
  return value;
}

function readExecutionPath(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"
    || !path.win32.isAbsolute(entry) || /[\x00-\x1f\x7f;]/.test(entry))
    || new Set(value.map((entry: string) => entry.toLowerCase())).size !== value.length) {
    throw new Error("Runner execution_path 必须是无重复的 Windows 绝对命令目录列表");
  }
  return value;
}

/** Effective macOS daemon PATH; also used by doctor without its terminal PATH. */
export function installedAgentPath(
  config: RunnerInstallConfig,
  inherited = MACOS_SERVICE_PATH,
  nodePath = process.execPath,
): string {
  return absoluteAgentPath([
    ...(config.agent_path ?? []), ...inherited.split(":"), path.dirname(nodePath), ...MACOS_SERVICE_PATH.split(":"),
  ]).join(":");
}

/** Only explicit local lifecycle commands capture PATH; daemon/self-update never recaptures it. */
export function captureInstalledAgentPath(
  scanHome: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "darwin") return;
  const config = readInstalledConfig(scanHome);
  const agentPath = absoluteAgentPath([
    ...(process.env.PATH ?? "").split(":"), ...(config.agent_path ?? []), path.dirname(process.execPath),
    ...MACOS_SERVICE_PATH.split(":"),
  ]);
  if (JSON.stringify(config.agent_path) !== JSON.stringify(agentPath)) {
    writeInstalledConfig({ ...config, agent_path: agentPath });
  }
}

export function removeCliWrapper(scanHome: string): void {
  const paths = runnerInstallPaths(scanHome);
  rmSync(paths.wrapper, { force: true });
  removeUserPathMarker(scanHome);
}

export const PATH_MARKER_START = "# octopus-runner:path:start";
export const PATH_MARKER_END = "# octopus-runner:path:end";

function ensureUserPath(scanHome: string, wrapperDir: string): void {
  if ((process.env.PATH ?? "").split(path.delimiter).includes(wrapperDir)) return;
  if (process.platform === "win32") {
    updateWindowsUserPath(wrapperDir, false);
    return;
  }
  const profile = path.join(scanHome, process.platform === "darwin" && (process.env.SHELL ?? "").endsWith("/zsh")
    ? ".zprofile"
    : ".profile");
  const current = existsSync(profile) ? readFileSync(profile, "utf8") : "";
  if (current.includes(PATH_MARKER_START)) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  const block = `${prefix}${PATH_MARKER_START}\nexport PATH="$HOME/.local/bin:$PATH"\n${PATH_MARKER_END}\n`;
  atomicWrite(profile, current + block, existingMode(profile, 0o600));
}

function removeUserPathMarker(scanHome: string): void {
  if (process.platform === "win32") {
    updateWindowsUserPath(runnerInstallPaths(scanHome).wrapperDir, true);
    return;
  }
  for (const name of [".zprofile", ".profile"]) {
    const file = path.join(scanHome, name);
    if (!existsSync(file)) continue;
    const current = readFileSync(file, "utf8");
    const pattern = new RegExp(`\\n?${escapeRegex(PATH_MARKER_START)}\\nexport PATH="\\$HOME/\\.local/bin:\\$PATH"\\n${escapeRegex(PATH_MARKER_END)}\\n?`, "g");
    const next = current.replace(pattern, (match) => match.startsWith("\n") && match.endsWith("\n") ? "\n" : "");
    if (next !== current) atomicWrite(file, next, existingMode(file, 0o600));
  }
}

function atomicWrite(file: string, content: string | Buffer, mode: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, content, { mode });
    renameSync(temp, file);
    chmodSync(file, mode);
  } finally {
    rmSync(temp, { force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function runnerCliWrapper(
  scanHome: string,
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = runnerInstallPaths(scanHome, platform);
  if (platform === "win32") {
    return `@echo off\r\n"${cmdEscape(path.win32.resolve(nodePath))}" "${cmdEscape(paths.bundle)}" %*\r\n`;
  }
  return `#!/bin/sh\nexec ${shellQuote(path.resolve(nodePath))} ${shellQuote(paths.bundle)} "$@"\n`;
}

/** Check the ACL boundary that replaces POSIX mode bits on Windows. */
export function windowsPrivatePathIsRestricted(file: string): boolean {
  if (process.platform !== "win32") return true;
  const script = `
$acl = Get-Acl -LiteralPath ${powershellLiteral(file)}
$allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
$bad = @($acl.Access | Where-Object {
  $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
  $allowed -notcontains $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
})
if ($acl.AreAccessRulesProtected -and $bad.Count -eq 0) { exit 0 } else { exit 1 }
`;
  return powershell(script).status === 0;
}

export function hardenWindowsPath(target: string, directory: boolean): void {
  const script = `
$target = ${powershellLiteral(target)}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$rights = [Security.AccessControl.FileSystemRights]::FullControl
$type = [Security.AccessControl.AccessControlType]::Allow
$inherit = ${directory ? "[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'" : "[Security.AccessControl.InheritanceFlags]::None"}
$propagate = [Security.AccessControl.PropagationFlags]::None
$acl = Get-Acl -LiteralPath $target
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleAll($rule) }
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, $rights, $inherit, $propagate, $type)))
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, $rights, $inherit, $propagate, $type)))
Set-Acl -LiteralPath $target -AclObject $acl
`;
  const result = powershell(script);
  if (result.status !== 0) throw new Error(`无法收紧 Windows Runner 文件权限: ${String(result.stderr || result.stdout).trim()}`);
}

function updateWindowsUserPath(wrapperDir: string, remove: boolean): void {
  const script = `
$dir = ${powershellLiteral(wrapperDir)}
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($current -split ';' | Where-Object { $_ -and $_ -ne $dir })
${remove ? "" : "$parts += $dir"}
[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
`;
  const result = powershell(script);
  if (result.status !== 0) throw new Error(`无法更新当前用户 PATH: ${String(result.stderr || result.stdout).trim()}`);
}

function powershell(script: string) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    encoding: "utf8",
  });
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function cmdEscape(value: string): string {
  return value.replace(/%/g, "%%").replace(/"/g, '""');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function existingMode(file: string, fallback: number): number {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return fallback;
  }
}
