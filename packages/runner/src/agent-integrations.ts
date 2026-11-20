import { agentCommand, isExecutableProvider } from "./agent-executables.js";
/** One-command, marker-owned local integration bundle shipped with Runner. */

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  agentHookStatus,
  installAgentHooks,
  uninstallAgentHooks,
  type HookInstallResult,
} from "./agent-hooks.js";
import { OCTOPUS_REMOTE_ROUTING_GUIDANCE } from "./agent-routing-guidance.js";
import { defaultCodexAppServerEndpointFile } from "./codex-app-server-host.js";

const LAUNCHER_MARKER = "octopus-agent-launcher:v1";
const LOCAL_MCP_LAUNCHER_MARKER = "octopus-runner-mcp:v1";
const LOCAL_MCP_BLOCK_START = "<!-- octopus-runner-mcp:start -->";
const LOCAL_MCP_BLOCK_END = "<!-- octopus-runner-mcp:end -->";
const CODEX_MCP_BLOCK_START = "# octopus-runner-mcp:start";
const CODEX_MCP_BLOCK_END = "# octopus-runner-mcp:end";
const OMP_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const execFileAsync = promisify(execFile);

export interface AgentIntegrationResult {
  hooks: HookInstallResult[];
  codexLauncher: {
    file: string;
    installed: boolean;
    changed: boolean;
  };
  localMcp: LocalMcpIntegrationResult;
}

export interface LocalMcpIntegrationResult {
  launcher: string;
  installed: boolean;
  changed: boolean;
  clients: Array<"claude" | "codex" | "omp">;
  warnings: string[];
}

export async function installAgentIntegrations(
  home: string,
  executable: string,
  codexHome = path.join(home, ".codex"),
  options: { localMcp?: boolean; additionalCodexHomes?: readonly string[] } = {},
): Promise<AgentIntegrationResult> {
  const launcher = launcherPath(home);
  await assertLauncherOwnedOrAbsent(launcher);
  if (options.localMcp !== false) {
    await assertOwnedOrAbsent(localMcpLauncherPath(home), LOCAL_MCP_LAUNCHER_MARKER, "local MCP launcher");
  }
  const hooks = await installAgentHooks(home, executable, codexHome);
  for (const additional of uniqueCodexHomes(codexHome, options.additionalCodexHomes).slice(1)) {
    hooks.push(...(await installAgentHooks(home, executable, additional)).filter((row) => row.provider === "codex"));
  }
  const changed = await writeLauncher(launcher, defaultCodexAppServerEndpointFile(), executable);
  const localMcp = options.localMcp === false
    ? await localAgentIntegrationStatus(home, codexHome, options.additionalCodexHomes)
    : await installLocalAgentIntegrations(home, executable, codexHome, options.additionalCodexHomes);
  return { hooks, codexLauncher: { file: launcher, installed: true, changed }, localMcp };
}

export async function agentIntegrationStatus(
  home: string,
  codexHome = path.join(home, ".codex"),
  options: { additionalCodexHomes?: readonly string[] } = {},
): Promise<AgentIntegrationResult> {
  const launcher = launcherPath(home);
  const hooks = await agentHookStatus(home, codexHome);
  for (const additional of uniqueCodexHomes(codexHome, options.additionalCodexHomes).slice(1)) {
    hooks.push(...(await agentHookStatus(home, additional)).filter((row) => row.provider === "codex"));
  }
  return {
    hooks,
    codexLauncher: { file: launcher, installed: await launcherOwned(launcher), changed: false },
    localMcp: await localAgentIntegrationStatus(home, codexHome, options.additionalCodexHomes),
  };
}

/** Only explicit uninstall (or hook mode `off`) removes integrations; stop and restart leave them in place. */
export async function uninstallAgentIntegrations(
  home: string,
  codexHome = path.join(home, ".codex"),
  options: { additionalCodexHomes?: readonly string[]; localMcp?: boolean } = {},
): Promise<AgentIntegrationResult> {
  const launcher = launcherPath(home);
  const installed = await launcherOwned(launcher);
  if (installed) await fs.unlink(launcher);
  const hooks = await uninstallAgentHooks(home, codexHome);
  for (const additional of uniqueCodexHomes(codexHome, options.additionalCodexHomes).slice(1)) {
    hooks.push(...(await uninstallAgentHooks(home, additional)).filter((row) => row.provider === "codex"));
  }
  return {
    hooks,
    codexLauncher: { file: launcher, installed: false, changed: installed },
    localMcp: options.localMcp === false
      ? await localAgentIntegrationStatus(home, codexHome, options.additionalCodexHomes)
      : await uninstallLocalAgentIntegrations(home, codexHome, options.additionalCodexHomes),
  };
}

/** Every Codex home that receives Runner hooks: account homes, the configured home and the default. */
export function codexIntegrationHomes(scanHome: string, codexHome: string, accountHomes: readonly string[] = []): string[] {
  return [...new Set([...accountHomes, codexHome, path.join(scanHome, ".codex")].map((root) => path.resolve(root)))];
}

export async function installLocalAgentIntegrations(
  home: string,
  executable: string,
  codexHome = path.join(home, ".codex"),
  additionalCodexHomes: readonly string[] = [],
): Promise<LocalMcpIntegrationResult> {
  const launcher = localMcpLauncherPath(home);
  await assertOwnedOrAbsent(launcher, LOCAL_MCP_LAUNCHER_MARKER, "local MCP launcher");
  const changedParts: boolean[] = [await writeLocalMcpLauncher(launcher, executable)];
  const clients: LocalMcpIntegrationResult["clients"] = [];
  const warnings: string[] = [];
  const candidates = ["codex", "claude", "omp"] as const;
  const available = await Promise.all(candidates.map(async (client) => ({
    client,
    available: await commandAvailable(client),
  })));
  for (const { client, available: clientAvailable } of available) {
    if (!clientAvailable) continue;
    try {
      if (client === "codex") {
        for (const root of [...new Set([codexHome, ...additionalCodexHomes])]) {
          changedParts.push(await installCodexMcp(path.join(root, "config.toml"), launcher));
          changedParts.push(await installPromptBlock(await codexPromptPath(root)));
        }
      } else if (client === "claude") {
        changedParts.push(await installJsonMcp(path.join(home, ".claude.json"), launcher));
        changedParts.push(await installPromptBlock(path.join(home, ".claude", "CLAUDE.md")));
      } else {
        changedParts.push(await installJsonMcp(
          path.join(home, ".omp", "agent", "mcp.json"),
          launcher,
          OMP_MCP_SCHEMA,
        ));
        changedParts.push(await installPromptBlock(path.join(home, ".omp", "agent", "APPEND_SYSTEM.md")));
      }
      clients.push(client);
    } catch (error) {
      warnings.push(`${client}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { launcher, installed: true, changed: changedParts.some(Boolean), clients, warnings };
}

export async function localAgentIntegrationStatus(
  home: string,
  codexHome = path.join(home, ".codex"),
  additionalCodexHomes: readonly string[] = [],
): Promise<LocalMcpIntegrationResult> {
  const launcher = localMcpLauncherPath(home);
  const installed = await fileContains(launcher, LOCAL_MCP_LAUNCHER_MARKER);
  const clients: LocalMcpIntegrationResult["clients"] = [];
  if ((await Promise.all(uniqueCodexHomes(codexHome, additionalCodexHomes).map(
    (root) => fileContains(path.join(root, "config.toml"), CODEX_MCP_BLOCK_START),
  ))).some(Boolean)) clients.push("codex");
  if (await jsonMcpOwned(path.join(home, ".claude.json"), launcher)) clients.push("claude");
  if (await jsonMcpOwned(path.join(home, ".omp", "agent", "mcp.json"), launcher)) clients.push("omp");
  return { launcher, installed, changed: false, clients, warnings: [] };
}

export async function uninstallLocalAgentIntegrations(
  home: string,
  codexHome = path.join(home, ".codex"),
  additionalCodexHomes: readonly string[] = [],
  options: { keepLauncher?: boolean } = {},
): Promise<LocalMcpIntegrationResult> {
  const launcher = localMcpLauncherPath(home);
  const before = await localAgentIntegrationStatus(home, codexHome, additionalCodexHomes);
  const changes: boolean[] = [];
  const warnings: string[] = [];
  const launcherOwnership = await markerOwnership(launcher, LOCAL_MCP_LAUNCHER_MARKER);
  for (const root of uniqueCodexHomes(codexHome, additionalCodexHomes)) {
    changes.push(await removeMarkedBlock(path.join(root, "config.toml"), CODEX_MCP_BLOCK_START, CODEX_MCP_BLOCK_END));
  }
  if (launcherOwnership === "foreign") {
    warnings.push(`preserved JSON MCP entries because ${launcher} is not Octopus-owned`);
  } else {
    changes.push(await removeJsonMcp(path.join(home, ".claude.json"), launcher));
    changes.push(await removeJsonMcp(path.join(home, ".omp", "agent", "mcp.json"), launcher, OMP_MCP_SCHEMA));
  }
  const promptFiles = [
    path.join(home, ".claude", "CLAUDE.md"),
    path.join(home, ".omp", "agent", "APPEND_SYSTEM.md"),
  ];
  for (const root of uniqueCodexHomes(codexHome, additionalCodexHomes)) {
    promptFiles.push(path.join(root, "AGENTS.md"), path.join(root, "AGENTS.override.md"));
  }
  for (const file of promptFiles) {
    changes.push(await removeMarkedBlock(file, LOCAL_MCP_BLOCK_START, LOCAL_MCP_BLOCK_END));
  }
  if (!options.keepLauncher && launcherOwnership === "owned") {
    await fs.unlink(launcher);
    changes.push(true);
  }
  return {
    launcher,
    installed: Boolean(options.keepLauncher && await fileContains(launcher, LOCAL_MCP_LAUNCHER_MARKER)),
    changed: changes.some(Boolean),
    clients: before.clients,
    warnings,
  };
}

/**
 * Keep the stable local launcher discoverable without changing any ordinary
 * Agent's user-level MCP or prompt configuration. Workspace-scoped configs may
 * point at this launcher and are deliberately outside the managed file set.
 */
export async function prepareLocalAgentIntegrations(
  home: string,
  executable: string,
  codexHome = path.join(home, ".codex"),
  additionalCodexHomes: readonly string[] = [],
): Promise<LocalMcpIntegrationResult> {
  const launcher = localMcpLauncherPath(home);
  await assertOwnedOrAbsent(launcher, LOCAL_MCP_LAUNCHER_MARKER, "local MCP launcher");
  const removed = await uninstallLocalAgentIntegrations(
    home,
    codexHome,
    additionalCodexHomes,
    { keepLauncher: true },
  );
  const launcherChanged = await writeLocalMcpLauncher(launcher, executable);
  return {
    launcher,
    installed: true,
    changed: removed.changed || launcherChanged,
    clients: [],
    warnings: removed.warnings,
  };
}

/**
 * Managed startup only refreshes the stable launcher and reports what is
 * injected. The Dashboard policy then installs or removes idempotently, so a
 * restart does not strip and rewrite every user-level config file.
 */
export async function refreshLocalMcpLauncher(
  home: string,
  executable: string,
  codexHome = path.join(home, ".codex"),
  additionalCodexHomes: readonly string[] = [],
): Promise<LocalMcpIntegrationResult> {
  const launcher = localMcpLauncherPath(home);
  await assertOwnedOrAbsent(launcher, LOCAL_MCP_LAUNCHER_MARKER, "local MCP launcher");
  const changed = await writeLocalMcpLauncher(launcher, executable);
  return { ...await localAgentIntegrationStatus(home, codexHome, additionalCodexHomes), installed: true, changed };
}

async function codexPromptPath(codexHome: string): Promise<string> {
  const override = path.join(codexHome, "AGENTS.override.md");
  try {
    await fs.access(override);
    return override;
  } catch {
    return path.join(codexHome, "AGENTS.md");
  }
}

function launcherPath(home: string): string {
  return path.join(home, ".local", "bin", "octopus-codex");
}

function localMcpLauncherPath(home: string): string {
  return path.join(home, ".local", "bin", "octopus-runner-mcp");
}

function uniqueCodexHomes(primary: string, additional: readonly string[] = []): string[] {
  return [...new Set([primary, ...additional].map((root) => path.resolve(root)))];
}

async function assertLauncherOwnedOrAbsent(file: string): Promise<void> {
  try {
    const content = await fs.readFile(file, "utf8");
    if (!content.includes(LAUNCHER_MARKER)) {
      throw new Error(`refusing to replace non-Octopus launcher: ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertOwnedOrAbsent(file: string, marker: string, label: string): Promise<void> {
  try {
    if (!(await fs.readFile(file, "utf8")).includes(marker)) {
      throw new Error(`refusing to replace non-Octopus ${label}: ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function markerOwnership(file: string, marker: string): Promise<"owned" | "absent" | "foreign"> {
  try {
    return (await fs.readFile(file, "utf8")).includes(marker) ? "owned" : "foreign";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

async function launcherOwned(file: string): Promise<boolean> {
  try {
    return (await fs.readFile(file, "utf8")).includes(LAUNCHER_MARKER);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeLauncher(file: string, endpointFile: string, executable: string): Promise<boolean> {
  const launch = `${shellQuote(process.execPath)} ${shellQuote(executable)} agents exec codex`;
  const content = `#!/bin/sh\n# ${LAUNCHER_MARKER}\n`
    + `endpoint_file=${shellQuote(endpointFile)}\n`
    + `if read -r server_pid endpoint < "$endpoint_file" 2>/dev/null && kill -0 "$server_pid" 2>/dev/null; then\n`
    + `  case "$endpoint" in\n    ws://127.0.0.1:*) exec ${launch} --remote "$endpoint" "$@" ;;\n  esac\nfi\n`
    + `printf '%s\\n' 'Octopus Codex control endpoint is unavailable; starting the normal local CLI.' >&2\n`
    + `exec ${launch} "$@"\n`;
  try {
    if (await fs.readFile(file, "utf8") === content) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, { mode: 0o700 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o700);
  return true;
}

async function writeLocalMcpLauncher(file: string, executable: string): Promise<boolean> {
  const content = `#!/bin/sh\n# ${LOCAL_MCP_LAUNCHER_MARKER}\n`
    + `case "\${1:-}" in\n`
    + `  discover|--help|-h) exec node ${shellQuote(executable)} mcp discover ;;\n`
    + `esac\n`
    + `exec node ${shellQuote(executable)} mcp stdio\n`;
  try {
    if (await fs.readFile(file, "utf8") === content) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, { mode: 0o700 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o700);
  return true;
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    const selected = isExecutableProvider(command) ? agentCommand(command, ["--version"]) : { bin: command, args: ["--version"], env: process.env };
    await execFileAsync(selected.bin, selected.args, { env: selected.env, timeout: 5_000, maxBuffer: 64 * 1024 });
    return true;
  } catch (error) {
    return !["ENOENT", "AGENT_EXECUTABLE_UNAVAILABLE"].includes(String((error as NodeJS.ErrnoException).code));
  }
}

const ROUTING_PROMPT = `${LOCAL_MCP_BLOCK_START}\n`
  + `${OCTOPUS_REMOTE_ROUTING_GUIDANCE}\n`
  + LOCAL_MCP_BLOCK_END;

async function installPromptBlock(file: string): Promise<boolean> {
  return await replaceMarkedBlock(file, LOCAL_MCP_BLOCK_START, LOCAL_MCP_BLOCK_END, ROUTING_PROMPT);
}

async function replaceMarkedBlock(file: string, start: string, end: string, block: string): Promise<boolean> {
  let current = "";
  try { current = await fs.readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pattern = markedPattern(start, end);
  const hasExistingBlock = pattern.test(current);
  pattern.lastIndex = 0;
  const next = hasExistingBlock
    ? current.replace(pattern, `${block}\n`)
    : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
  if (next === current) return false;
  await atomicText(file, next);
  return true;
}

async function removeMarkedBlock(file: string, start: string, end: string): Promise<boolean> {
  let current: string;
  try { current = await fs.readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const pattern = markedPattern(start, end);
  if (!pattern.test(current)) return false;
  pattern.lastIndex = 0;
  const next = current.replace(pattern, "").replace(/^\s+|\s+$/g, "");
  if (next) await atomicText(file, `${next}\n`);
  // Emptying a shared file keeps it, and every link to it, in place.
  else if ((await fs.lstat(file)).isSymbolicLink()) await atomicText(file, "");
  else await fs.unlink(file);
  return true;
}

function markedPattern(start: string, end: string): RegExp {
  return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
}

async function installJsonMcp(file: string, launcher: string, schema?: string): Promise<boolean> {
  const doc = await readJsonObject(file);
  const servers = doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)
    ? doc.mcpServers as Record<string, unknown>
    : {};
  const desired = { type: "stdio", command: launcher, args: [] };
  const existing = servers.octopus as { command?: unknown } | undefined;
  if (existing && existing.command !== launcher) {
    throw new Error(`refusing to replace non-Octopus MCP server named octopus: ${file}`);
  }
  const schemaChanged = Boolean(schema && doc.$schema === undefined);
  if (schemaChanged) doc.$schema = schema;
  if (JSON.stringify(servers.octopus) === JSON.stringify(desired) && !schemaChanged) return false;
  doc.mcpServers = { ...servers, octopus: desired };
  await atomicText(file, `${JSON.stringify(doc, null, 2)}\n`);
  return true;
}

async function installCodexMcp(file: string, launcher: string): Promise<boolean> {
  let current = "";
  try { current = await fs.readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!current.includes(CODEX_MCP_BLOCK_START) && /^\s*\[mcp_servers\.octopus\]\s*$/m.test(current)) {
    throw new Error(`refusing to replace non-Octopus MCP server named octopus: ${file}`);
  }
  return await replaceMarkedBlock(
    file,
    CODEX_MCP_BLOCK_START,
    CODEX_MCP_BLOCK_END,
    `${CODEX_MCP_BLOCK_START}\n[mcp_servers.octopus]\ncommand = ${tomlString(launcher)}\n${CODEX_MCP_BLOCK_END}`,
  );
}

async function removeJsonMcp(file: string, launcher: string, removableSchema?: string): Promise<boolean> {
  const doc = await readJsonObject(file, true);
  if (!doc) return false;
  const servers = doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)
    ? doc.mcpServers as Record<string, unknown>
    : null;
  const row = servers?.octopus as { command?: unknown } | undefined;
  if (!servers || row?.command !== launcher) return false;
  delete servers.octopus;
  if (Object.keys(servers).length > 0) doc.mcpServers = servers;
  else delete doc.mcpServers;
  if (
    removableSchema
    && doc.$schema === removableSchema
    && Object.keys(doc).every((key) => key === "$schema")
  ) delete doc.$schema;
  if (Object.keys(doc).length > 0) await atomicText(file, `${JSON.stringify(doc, null, 2)}\n`);
  else await fs.unlink(file);
  return true;
}

async function jsonMcpOwned(file: string, launcher: string): Promise<boolean> {
  const doc = await readJsonObject(file, true);
  const servers = doc?.mcpServers as Record<string, unknown> | undefined;
  return (servers?.octopus as { command?: unknown } | undefined)?.command === launcher;
}

async function readJsonObject(file: string): Promise<Record<string, unknown>>;
async function readJsonObject(file: string, absentOk: true): Promise<Record<string, unknown> | null>;
async function readJsonObject(file: string, absentOk = false): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`expected a JSON object: ${file}`);
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absentOk ? null : {};
    throw error;
  }
}

/**
 * Replaces the file a path names. A user's instruction or config file may be a
 * symlink into a shared home (each Codex account's AGENTS.md links to one
 * master); renaming over the link would silently fork the copies.
 */
async function atomicText(file: string, content: string): Promise<void> {
  const target = await fs.realpath(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return file;
    throw error;
  });
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, { mode: 0o600 });
  await fs.rename(temp, target);
}

async function fileContains(file: string, marker: string): Promise<boolean> {
  try { return (await fs.readFile(file, "utf8")).includes(marker); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export { LAUNCHER_MARKER as AGENT_LAUNCHER_MARKER };
