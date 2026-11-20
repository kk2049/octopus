import { capabilityCommand } from "./capability-cli.js";
import { installGuest, installGuestFromInstaller, uninstallGuest } from "./guest-install.js";
import { packGuest } from "./guest-pack.js";
import { relaunchInWindowsTerminal, runGuestConsole, windowsTerminalRelaunch } from "./guest-console.js";
import { DEFAULT_GUEST_SESSIONS_PORT, GuestSessionHost } from "./guest-sessions.js";
import { isGuestAgent } from "./guest-terminal.js";
import { executableRecovery } from "./agent-executable-recovery.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  applyInstalledEnvironment,
  captureInstalledAgentPath,
  installedAgentPath,
  installedAgentRegistry,
  installCliWrapper,
  installManagedBundle,
  readGuestSessionsConfig,
  readInstalledConfig,
  removeCliWrapper,
  runnerInstallPaths,
  writeInstalledConfig,
  writeRunnerToken,
  writeRunnerSiteToken,
  windowsPrivatePathIsRestricted,
  type RunnerInstallConfig,
} from "./install-config.js";
import {
  enableRunnerLinger,
  installRunnerService,
  restartRunnerService,
  runnerServiceFiles,
  runnerServiceStatus,
  showRunnerLogs,
  startRunnerService,
  stopRunnerService,
  uninstallRunnerService,
} from "./service-manager.js";
import {
  addWorkspace,
  ensureDefaultWorkspace,
  listRegisteredWorkspaces,
  removeWorkspace,
  renameWorkspace,
} from "./workspaces.js";
import { runnerAutostartStatus } from "./service-autostart.js";
import { codexIntegrationHomes, uninstallAgentIntegrations } from "./agent-integrations.js";
import { discoverCodexAccountHomes } from "./codex-account-inventory.js";
import { parseRunnerCodexAccounts } from "./codex-account-routing.js";
import { discoverRunnerInventory, runnerAgentPath } from "./inventory.js";
import { fileSha256, stageBundle } from "./self-update.js";
import { clearLegacyRunnerLogs } from "./resident-privacy.js";
import { parseAdditionalSites, resolveRunnerSites, validateSiteId } from "./gateway-sites.js";
import { AGENT_EXECUTABLE_PROVIDERS, agentCommand, isExecutableProvider, usingAgentExecutables, probeAgentExecutable } from "./agent-executables.js";

const PUBLIC_COMMANDS = new Set([
  "help", "--help", "-h", "install", "enroll", "start", "stop", "restart", "status", "logs",
  "doctor", "update", "workspace", "config", "version", "--version", "uninstall", "run", "agents", "sites", "capabilities",
  "guest",
]);
const INTERNAL_COMMANDS = new Set(["mcp", "hook", "hooks", "integrations", "knowledge-index-job"]);

interface EnrollmentReply {
  ok: true;
  token: string;
  device: string;
  runner_url: string;
  dashboard_url: string;
}

/**
 * Run an installed-user CLI command. `null` means the caller should continue
 * into the resident Runner (legacy no-arg launch, `daemon`, or an internal
 * hook/MCP subcommand owned by index.ts).
 */
export async function runRunnerCli(args = process.argv.slice(2)): Promise<number | null> {
  const command = args[0];
  if (!command) return null; // Backwards-compatible `node runner.js` daemon.
  if (command === "daemon") {
    applyInstalledEnvironment(commandHome());
    return null;
  }
  if (command === "run" && args[1] === "--foreground") {
    captureInstalledAgentPath(commandHome());
    applyInstalledEnvironment(commandHome());
    return null;
  }
  if (INTERNAL_COMMANDS.has(command)) return null;
  // Run by the guest client's Windows installer/uninstaller with its bundled Node.
  if (command === "guest-install" || command === "guest-uninstall") {
    try {
      return await guestInstallerCommand(command, args.slice(1));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (!PUBLIC_COMMANDS.has(command)) {
    console.error(`未知命令: ${command}\n运行 octopus-runner help 查看可用命令。`);
    return 2;
  }

  try {
    if (["start", "restart", "update", "enroll"].includes(command)) {
      captureInstalledAgentPath(installedHome());
    }
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        console.log(HELP);
        return 0;
      case "install":
        await installCommand(args.slice(1));
        return 0;
      case "enroll":
        await enrollCommand(args.slice(1));
        return 0;
      case "start":
        startRunnerService(installedHome());
        console.log("Octopus Runner 已启动");
        return 0;
      case "stop":
        stopRunnerService(installedHome());
        console.log("Octopus Runner 已停止");
        return 0;
      case "restart":
        restartRunnerService(installedHome());
        console.log("Octopus Runner 已重启");
        return 0;
      case "status":
        await statusCommand(args.slice(1));
        return 0;
      case "logs":
        if (args[1] === "--clear") {
          const result = await clearLegacyRunnerLogs(installedOrCommandHome());
          console.log(JSON.stringify(result));
          return result.failed.length ? 1 : 0;
        }
        logsCommand(args.slice(1));
        return 0;
      case "doctor":
        return await doctorCommand() ? 0 : 1;
      case "agents":
        return await agentsCommand(args.slice(1));
      case "update":
        await updateCommand();
        return 0;
      case "workspace":
        await workspaceCommand(args.slice(1));
        return 0;
      case "config":
        configCommand(args.slice(1));
        return 0;
      case "capabilities":
        await capabilityCommand(installedOrCommandHome(), args.slice(1));
        return 0;
      case "sites":
        await sitesCommand(args.slice(1));
        return 0;
      case "guest":
        return await guestCommand(args.slice(1));
      case "version":
      case "--version":
        console.log(`octopus-runner ${runnerVersion()}`);
        return 0;
      case "uninstall":
        await uninstallCommand(args.slice(1));
        return 0;
      default:
        console.error(HELP);
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function installCommand(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      server: { type: "string" },
      enroll: { type: "string" },
      workspace: { type: "string", multiple: true },
      label: { type: "string" },
      linger: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  const dashboardUrl = normalizeDashboardUrl(parsed.values.server);
  const enrollment = requireValue(parsed.values.enroll, "install 需要 --enroll <一次性代码>");
  if (parsed.values.linger && process.platform !== "linux") throw new Error("--linger 只适用于 Linux");
  const scanHome = commandHome();
  const executionShell = process.platform === "win32"
    ? requireValue(process.env.RUNNER_EXEC_SHELL, "Windows 安装需要 Git Bash；请使用 Dashboard 提供的 PowerShell 安装命令")
    : undefined;
  // Do every local, non-authoritative check before consuming the one-shot
  // enrollment. A typo in --workspace must not burn the credential.
  const workspaces = parsed.values.workspace ?? [];
  for (const [index, directory] of workspaces.entries()) {
    const added = await addWorkspace(scanHome, directory, index === 0 ? parsed.values.label : undefined);
    console.log(`workspace 已登记: ${added.id} ${added.display}`);
  }
  await ensureDefaultWorkspace(scanHome);
  const reply = await redeemEnrollment(dashboardUrl, enrollment);
  const config: RunnerInstallConfig = {
    version: 1,
    dashboard_url: reply.dashboard_url,
    runner_url: reply.runner_url,
    device: reply.device,
    scan_home: scanHome,
    codex_home: path.resolve(process.env.CODEX_HOME?.trim() || path.join(scanHome, ".codex")),
    ...(process.platform === "win32" ? { execution_only: true, execution_shell: path.resolve(executionShell!) } : {}),
    installed_at: new Date().toISOString(),
  };
  try {
    installManagedBundle(scanHome, process.argv[1]);
    writeInstalledConfig(config);
    captureInstalledAgentPath(scanHome);
    writeRunnerToken(scanHome, reply.token);
    installCliWrapper(scanHome);
    installRunnerService(scanHome);
    if (parsed.values.linger) enableRunnerLinger();
  } catch (error) {
    // The durable credential exists only after redemption. If local service
    // setup then fails, revoke it rather than leaving an invisible live key.
    const revoked = await revokeRunnerCredential(config.dashboard_url, reply.token).catch(() => false);
    try { stopRunnerService(scanHome); } catch { /* definition may not exist yet */ }
    throw new Error(
      `安装未完成，${revoked ? "已撤销本次设备凭据" : "本次设备凭据未能自动撤销，请在 Dashboard 删除该设备"}: `
      + (error instanceof Error ? error.message : String(error)),
    );
  }
  const online = await waitForOnline(config, reply.token);
  console.log(`Octopus Runner 已安装并${online ? "上线" : "启动（服务器仍在等待连接，请运行 doctor）"}: ${reply.device}`);
  console.log(`命令路径: ${runnerInstallPaths(scanHome).wrapper}`);
}

async function enrollCommand(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: { server: { type: "string" }, enroll: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  const home = installedHome();
  const current = readInstalledConfig(home);
  const dashboardUrl = parsed.values.server ? normalizeDashboardUrl(parsed.values.server) : current.dashboard_url;
  const enrollment = requireValue(parsed.values.enroll, "enroll 需要 --enroll <一次性代码>");
  const reply = await redeemEnrollment(dashboardUrl, enrollment);
  const next = { ...current, dashboard_url: reply.dashboard_url, runner_url: reply.runner_url, device: reply.device };
  try {
    writeInstalledConfig(next);
    writeRunnerToken(home, reply.token);
    restartRunnerService(home);
  } catch (error) {
    const revoked = await revokeRunnerCredential(next.dashboard_url, reply.token).catch(() => false);
    try { stopRunnerService(home); } catch { /* the service may already be absent */ }
    throw new Error(
      `重新登记未完成，${revoked ? "已撤销新设备凭据" : "新设备凭据未能自动撤销，请在 Dashboard 删除该设备"}: `
      + (error instanceof Error ? error.message : String(error)),
    );
  }
  console.log(`Octopus Runner 已重新登记为 ${reply.device}`);
}

async function statusCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean", default: false } }, strict: true });
  const home = installedHome();
  const config = readInstalledConfig(home);
  const service = runnerServiceStatus(home);
  const gateway = await queryRunnerSelf(config, readFileSync(runnerInstallPaths(home).token, "utf8").trim());
  const value = {
    installed: true,
    service: service.active ? "active" : "inactive",
    service_details: service.output,
    gateway: gateway.reachable ? (gateway.online ? "online" : "offline") : "unreachable",
    device: config.device,
    runner_url: config.runner_url,
    scan_home: config.scan_home,
    version: runnerVersion(),
    running_sha: gateway.runningSha ?? null,
    target_sha: gateway.targetSha ?? null,
    update_status: gateway.updateStatus ?? "unknown",
  };
  if (values.json) console.log(JSON.stringify(value, null, 2));
  else console.log([
    `服务: ${value.service}`,
    `服务设置: ${value.service_details}`,
    `连接: ${value.gateway}`,
    `设备: ${value.device}`,
    `网关: ${value.runner_url}`,
    `扫描根: ${value.scan_home}`,
    `版本: ${value.version}`,
    `实际运行: ${value.running_sha?.slice(0, 12) ?? "未知"}`,
    `服务端目标: ${value.target_sha?.slice(0, 12) ?? "未知"}`,
    `更新状态: ${value.update_status}`,
  ].join("\n"));
}

function logsCommand(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      follow: { type: "boolean", short: "f", default: false },
      lines: { type: "string", short: "n", default: "200" },
    },
    strict: true,
  });
  const lines = Math.max(1, Math.min(10_000, Number(values.lines) || 200));
  showRunnerLogs(installedHome(), values.follow, lines);
}

async function doctorCommand(): Promise<boolean> {
  const home = installedHome();
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  let config: RunnerInstallConfig;
  try {
    config = readInstalledConfig(home);
    checks.push({ name: "config", ok: true, detail: config.device });
  } catch (error) {
    console.log(`✗ config: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  const paths = runnerInstallPaths(home);
  checks.push(fileCheck("bundle", paths.bundle, false));
  checks.push(fileCheck("token", paths.token, true));
  checks.push(fileCheck("cli", paths.wrapper, false));
  checks.push(fileCheck("service", runnerServiceFiles(home).definitionPath, false));
  const autostart = runnerAutostartStatus(home);
  checks.push({ name: "service-autostart", ok: autostart.enabled && autostart.restart, detail: autostart.detail });
  const service = runnerServiceStatus(home);
  checks.push({ name: "service-active", ok: service.active, detail: service.output || "inactive" });
  try {
    const token = readFileSync(paths.token, "utf8").trim();
    const gateway = await queryRunnerSelf(config, token);
    checks.push({
      name: "gateway-online",
      ok: gateway.reachable && gateway.online,
      detail: gateway.reachable ? (gateway.online ? "online" : "offline") : gateway.detail,
    });
  } catch (error) {
    checks.push({ name: "gateway-online", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  for (const workspace of await listRegisteredWorkspaces(config.scan_home)) {
    checks.push({ name: `workspace ${workspace.id}`, ok: workspace.available, detail: workspace.path });
  }
  for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  if ((process.platform === "darwin" || process.platform === "linux") && !config.execution_only) {
    // Model the configured service environment, not this interactive terminal.
    // Optional Agent installations do not determine execution-only health.
    const registry = installedAgentRegistry(config.scan_home, { diagnostic: true });
    const inventory = await usingAgentExecutables(registry, () => discoverRunnerInventory(config.scan_home, {
      env: {
        PATH: runnerAgentPath(config.scan_home, installedAgentPath(config)),
        HOME: config.scan_home,
        CODEX_HOME: config.codex_home,
      },
    }));
    console.log("Agent 命令检查（后台配置环境；注册表在后续启动与周期盘点中自动刷新）:");
    for (const backend of inventory.agent_backends) {
      console.log(`${backend.available ? "✓" : "!"} agent ${backend.kind}: ${[backend.version, backend.reason].filter(Boolean).join(" · ")}`);
      const state = registry.inspect(backend.kind);
      console.log(JSON.stringify(state));
    }
    if (!config.agent_path || inventory.agent_backends.some((backend) => backend.reason === "command_unavailable")) {
      console.log("提示: 使用 octopus-runner agents list 查看候选；自定义安装或多安装歧义可用 agents bind 显式选择，无需 restart。");
    }
  }
  if (process.platform === "darwin" && checks.some((check) => check.name.startsWith("workspace ") && !check.ok)) {
    console.log("提示: Desktop/Documents/Downloads 可能需要在“系统设置 → 隐私与安全性 → 文件与文件夹”中授权。");
  }
  return checks.every((check) => check.ok);
}

async function agentsCommand(args: string[]): Promise<number> {
  const registry = installedAgentRegistry(installedHome(), { diagnostic: true });
  if (!registry.enabled) throw new Error("该设备仅提供执行环境，不启用 Agent 注册表");
  const action = args[0] ?? "list";
  if (action === "exec") {
    const provider = args[1] ?? "";
    if (!isExecutableProvider(provider)) throw new Error("agents exec 需要 claude、codex 或 omp");
    const command = usingAgentExecutables(registry, () => agentCommand(provider, args.slice(2)));
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command.bin, command.args, { env: command.env, stdio: "inherit" });
      const interrupt = () => { child.kill("SIGINT"); };
      const terminate = () => { child.kill("SIGTERM"); };
      const cleanup = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      child.once("error", (error) => { cleanup(); reject(error); });
      child.once("exit", (code, signal) => { cleanup(); resolve(code ?? (signal === "SIGINT" ? 130 : 143)); });
    });
  }
  if (action === "bind" || action === "unbind") {
    const provider = args[1] ?? "";
    if (!isExecutableProvider(provider)) throw new Error("agents bind/unbind 需要 claude、codex 或 omp");
    const parsed = parseArgs({ args: args.slice(2), options: { interpreter: { type: "string" }, "trust-installation": { type: "boolean" } }, allowPositionals: true, strict: true });
    if (action === "bind" && parsed.positionals.length !== 1) throw new Error("用法: agents bind <Agent> <绝对路径> [--interpreter <绝对路径>] [--trust-installation]");
    if (action === "unbind" && (parsed.positionals.length || parsed.values.interpreter || parsed.values["trust-installation"])) throw new Error("用法: agents unbind <Agent>");
    registry.bind(provider, action === "bind" ? { entry: parsed.positionals[0], ...(parsed.values.interpreter ? { interpreter: parsed.values.interpreter } : {}) } : null, parsed.values["trust-installation"]);
    if (parsed.values["trust-installation"]) console.log("已记录本安装当前路径、所有者、组及组写权限的信任例外；这些本机用户可替换程序。世界可写路径仍拒绝，权限或路径改变后重新校验。\n" + JSON.stringify(registry.bindings()[provider], null, 2));
    console.log(`Agent ${provider} ${action === "bind" ? "已绑定" : "已恢复自动选择"}；后续启动自动读取，在运行的会话保持原进程。`);
  } else if (action !== "list" || args.slice(1).some((arg) => arg !== "--json")) {
    throw new Error("用法: octopus-runner agents list [--json] | bind <Agent> <路径> | unbind <Agent>");
  }
  const states = await usingAgentExecutables(registry, async () => {
    const result = [];
    for (const provider of AGENT_EXECUTABLE_PROVIDERS) {
      const state = registry.inspect(provider);
      let version: string | undefined;
      let probe: string | undefined;
      if (state.selected) {
        try { version = await probeAgentExecutable(provider); } catch { probe = "probe_failed"; }
      }
      const recovery = executableRecovery(state, registry.bindings()[provider]);
      result.push({ ...state, ...(version ? { version } : {}), ...(probe ? { probe } : {}), ...(recovery ? { recovery } : {}) });
    }
    return result;
  });
  console.log(JSON.stringify(states, null, 2));
  return 0;
}

async function updateCommand(): Promise<void> {
  const home = installedHome();
  const installed = readInstalledConfig(home);
  const authority = resolveRunnerSites({ runnerUrl: installed.runner_url, tokenFile: runnerInstallPaths(home).token }, installed)
    .find((site) => site.providesUpdates);
  if (!authority) throw new Error("Runner updates are pinned off; choose a site with sites updates <id> first");
  const config = authority.id === "primary" ? installed : {
    ...installed, dashboard_url: installed.additional_sites!.find((site) => site.id === authority.id)!.dashboard_url,
    runner_url: authority.runnerUrl,
  };
  const paths = runnerInstallPaths(home);
  const token = readFileSync(authority.tokenFile!, "utf8").trim();
  const response = await fetch(`${config.dashboard_url}/download/runner.js`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Runner 更新下载失败: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const announced = response.headers.get("x-octopus-runner-bundle-sha");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!announced) throw new Error("Runner 更新响应缺少摘要，拒绝替换当前版本");
  if (announced !== actual) throw new Error("Runner 更新摘要不匹配");
  const candidate = path.join(paths.root, "standalone.next.js");
  writeFileSync(candidate, bytes, { mode: 0o700 });
  const checked = spawnSync(process.execPath, ["--check", candidate], { encoding: "utf8", windowsHide: true });
  if (checked.status !== 0) {
    rmSync(candidate, { force: true });
    throw new Error(`Runner 更新语法检查失败: ${String(checked.stderr || checked.stdout).trim()}`);
  }
  try {
    stageBundle(home, { sha: actual, size: bytes.length, data: bytes.toString("base64") });
  } finally {
    rmSync(candidate, { force: true });
  }
  try {
    restartRunnerService(home);
    if (!await waitForOnline(config, token, actual)) {
      throw new Error(`Gateway 未确认设备正在运行目标版本 ${actual.slice(0, 12)}`);
    }
  } catch (error) {
    if (fileSha256(paths.bundle) !== actual) {
      throw new Error("Runner 更新未确认，安装版本已由另一更新改变；未覆盖或回滚该版本");
    }
    if (!existsSync(paths.previousBundle)) throw new Error("Runner 更新未确认，且没有可恢复的上一版本");
    writeFileSync(candidate, readFileSync(paths.previousBundle), { mode: 0o700 });
    renameSync(candidate, paths.bundle);
    try { restartRunnerService(home); } catch { /* retain the original error */ }
    throw new Error(`Runner 更新未通过验收，已恢复上一版本文件并尝试重启: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`Octopus Runner 已更新并确认运行: ${actual.slice(0, 12)}`);
}

async function workspaceCommand(args: string[]): Promise<void> {
  const action = args[0];
  const home = installedOrCommandHome();
  if (action === "list") {
    const json = args.includes("--json");
    const rows = await listRegisteredWorkspaces(home);
    if (json) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log("尚未登记 workspace");
    else for (const row of rows) console.log(`${row.available ? "✓" : "✗"} ${row.id}  ${row.label}  ${row.display}`);
    return;
  }
  if (action === "add") {
    const parsed = parseArgs({
      args: args.slice(1),
      options: { label: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    const directory = parsed.positionals[0];
    if (!directory) throw new Error("usage: octopus-runner workspace add <目录> [--label <名称>]");
    // Keep the old `workspace add <dir> <label>` spelling working for people
    // who started with standalone.js before the installed CLI existed.
    const positionalLabel = parsed.positionals.slice(1).join(" ").trim() || undefined;
    if (parsed.values.label && positionalLabel) throw new Error("workspace 名称请只使用位置参数或 --label 其中一种");
    const row = await addWorkspace(home, directory, parsed.values.label ?? positionalLabel);
    console.log(JSON.stringify(row, null, 2));
    return;
  }
  if (action === "remove") {
    const id = args[1] ?? "";
    if (!id) throw new Error("usage: octopus-runner workspace remove <workspace_id>");
    if (!await removeWorkspace(home, id)) throw new Error("workspace 不存在或未登记");
    console.log(`workspace 已移除: ${id}`);
    return;
  }
  if (action === "rename") {
    const id = args[1] ?? "";
    const label = args.slice(2).join(" ").trim();
    if (!id || !label) throw new Error("usage: octopus-runner workspace rename <workspace_id> <名称>");
    console.log(JSON.stringify(await renameWorkspace(home, id, label), null, 2));
    return;
  }
  throw new Error("usage: octopus-runner workspace list|add|remove|rename");
}

function configCommand(args: string[]): void {
  if (args[0] !== "show") throw new Error("usage: octopus-runner config show");
  const config = readInstalledConfig(installedHome());
  console.log(JSON.stringify({ ...config, token: "<stored in mode-0600 file>" }, null, 2));
}

async function sitesCommand(args: string[]): Promise<void> {
  const home = installedHome();
  const config = readInstalledConfig(home);
  const primary = { runnerUrl: config.runner_url, tokenFile: runnerInstallPaths(home).token };
  if (args[0] === "list") {
    const rows = await Promise.all(resolveRunnerSites(primary, config).map(async (site) => {
      const dashboardUrl = site.id === "primary" ? config.dashboard_url : config.additional_sites!.find((row) => row.id === site.id)!.dashboard_url;
      const gateway = await queryRunnerSelf({ ...config, dashboard_url: dashboardUrl }, readFileSync(site.tokenFile!, "utf8").trim());
      return { id: site.id, runner_url: site.runnerUrl, controls_machine: site.controlsMachine, provides_updates: site.providesUpdates, reachable: gateway.reachable, online: gateway.online, running_sha: gateway.runningSha ?? null };
    }));
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const next = { ...config };
  if (args[0] === "add") {
    const id = validateSiteId(args[1]);
    const { values } = parseArgs({ args: args.slice(2), options: { server: { type: "string" }, "token-file": { type: "string" } }, strict: true });
    const dashboardUrl = normalizeDashboardUrl(values.server);
    const gateway = new URL(config.runner_url); const target = new URL(dashboardUrl);
    gateway.protocol = target.protocol === "https:" ? "wss:" : "ws:"; gateway.host = target.host;
    const tokenFile = path.join(runnerInstallPaths(home).root, "sites", `${id}.token`);
    const candidate = parseAdditionalSites([{ id, dashboard_url: dashboardUrl, runner_url: gateway.href, token_file: tokenFile }])[0]!;
    next.additional_sites = [...(config.additional_sites ?? []).filter((site) => site.id !== id), candidate];
    resolveRunnerSites(primary, next);
    const token = readFileSync(path.resolve(requireValue(values["token-file"], "sites add 需要 --token-file <本地凭据文件>")), "utf8").trim();
    writeRunnerSiteToken(home, id, token);
  } else if (args[0] === "remove") {
    const id = validateSiteId(args[1]);
    if (id === "primary") throw new Error("Use sites disable-primary after moving control and updates to another site");
    next.additional_sites = (config.additional_sites ?? []).filter((site) => site.id !== id);
  } else if (args[0] === "control") next.control_site = validateSiteId(args[1]);
  else if (args[0] === "updates") next.update_site = validateSiteId(args[1]);
  else if (args[0] === "disable-primary") next.primary_enabled = false;
  else if (args[0] === "enable-primary") next.primary_enabled = true;
  else throw new Error("usage: octopus-runner sites list|add <id> --server <url> --token-file <file>|remove <id>|control <id>|updates <id|none>|disable-primary|enable-primary");
  resolveRunnerSites(primary, next);
  writeInstalledConfig(next);
  console.log("Runner site configuration saved; the resident service applies changes within five seconds. Existing provider sessions stay on this machine.");
}

async function uninstallCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { force: { type: "boolean", default: false } },
    strict: true,
  });
  const home = installedHome();
  const config = readInstalledConfig(home);
  const paths = runnerInstallPaths(home);
  const token = readFileSync(paths.token, "utf8").trim();
  const revoked = await revokeRunnerCredential(config.dashboard_url, token).catch(() => false);
  if (!revoked && !values.force) {
    throw new Error("服务器凭据未能撤销；网络恢复后重试，或明确使用 --force 仅清理本机");
  }
  uninstallRunnerService(home);
  if (!config.execution_only) {
    // Stop and restart keep integrations installed, so remove them from every
    // Codex home the resident installs into, not only the configured one.
    await uninstallInstalledAgentIntegrations(config).catch((error) => {
      console.warn(`Agent integrations 清理未完成: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  removeCliWrapper(home);
  rmSync(paths.root, { recursive: true, force: true });
  console.log(`Octopus Runner 已卸载${revoked ? "，设备凭据已撤销" : "（仅本机；服务器凭据未撤销）"}`);
}

async function uninstallInstalledAgentIntegrations(config: RunnerInstallConfig): Promise<void> {
  let configured: Record<string, string> | undefined;
  try { configured = parseRunnerCodexAccounts(process.env.RUNNER_CODEX_ACCOUNTS); } catch { configured = undefined; }
  const accounts = await discoverCodexAccountHomes(config.scan_home, configured);
  const [codexHome, ...additionalCodexHomes] = codexIntegrationHomes(config.scan_home, config.codex_home, Object.values(accounts ?? {}));
  await uninstallAgentIntegrations(config.scan_home, codexHome, { additionalCodexHomes });
}

async function redeemEnrollment(dashboardUrl: string, code: string): Promise<EnrollmentReply> {
  const response = await fetch(`${dashboardUrl}/api/runner-enrollment/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null) as EnrollmentReply | { error?: string } | null;
  if (!response.ok || !isEnrollmentReply(body)) {
    const message = body && "error" in body ? body.error : `HTTP ${response.status}`;
    throw new Error(`Runner enrollment 失败: ${message || "unknown response"}`);
  }
  return body;
}

function isEnrollmentReply(value: unknown): value is EnrollmentReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.ok === true
    && typeof row.token === "string"
    && typeof row.device === "string"
    && typeof row.runner_url === "string"
    && typeof row.dashboard_url === "string";
}

async function waitForOnline(config: RunnerInstallConfig, token: string, expectedSha?: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${config.dashboard_url}/api/runner-self-status`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      const body = await response.json() as { online?: boolean; bundle_sha?: string };
      if (response.ok && body.online && (!expectedSha || body.bundle_sha === expectedSha)) return true;
    } catch {
      // The service may still be starting; the final result remains honest.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function queryRunnerSelf(
  config: RunnerInstallConfig,
  token: string,
): Promise<{ reachable: boolean; online: boolean; detail: string; runningSha?: string; targetSha?: string; updateStatus?: string }> {
  try {
    const response = await fetch(`${config.dashboard_url}/api/runner-self-status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json().catch(() => null) as {
      online?: boolean; error?: string; bundle_sha?: string; bundle_target_sha?: string; bundle_update_status?: string;
    } | null;
    if (!response.ok) return { reachable: false, online: false, detail: body?.error || `HTTP ${response.status}` };
    const digest = (value: unknown): string | undefined =>
      typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
    return {
      reachable: true, online: body?.online === true, detail: body?.online === true ? "online" : "offline",
      runningSha: digest(body?.bundle_sha), targetSha: digest(body?.bundle_target_sha),
      ...(["current", "pending", "updating", "retry_pending", "disabled", "blocked"].includes(body?.bundle_update_status ?? "")
        ? { updateStatus: body!.bundle_update_status } : {}),
    };
  } catch (error) {
    return { reachable: false, online: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function revokeRunnerCredential(dashboardUrl: string, token: string): Promise<boolean> {
  const response = await fetch(`${dashboardUrl}/api/runner-self-revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  return response.ok;
}

async function guestInstallerCommand(command: "guest-install" | "guest-uninstall", args: string[]): Promise<number> {
  if (command === "guest-install") {
    const { values } = parseArgs({ args, options: { package: { type: "string" }, installer: { type: "string" }, app: { type: "string" } }, strict: true });
    const result = values.installer
      ? await installGuestFromInstaller(path.resolve(values.installer), path.resolve(requireValue(values.app, "guest-install --installer 需要 --app <目录>")))
      : await installGuest(path.resolve(requireValue(values.package, "guest-install 需要 --installer <安装包> --app <目录> 或 --package <guest.json>")));
    console.log(`安装完成：${result.device}${result.online ? "（已在线）" : ""}`);
    return 0;
  }
  const { values } = parseArgs({ args, options: { app: { type: "string" } }, strict: true });
  await uninstallGuest(path.resolve(requireValue(values.app, "guest-uninstall 需要 --app <目录>")));
  return 0;
}

async function guestCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "console") {
    // Run from the guest's desktop shortcut with the bundled Node.
    const { values } = parseArgs({
      args: args.slice(1),
      options: { agent: { type: "string" }, home: { type: "string" }, "in-terminal": { type: "boolean", default: false } },
      strict: true,
    });
    if (!isGuestAgent(values.agent)) throw new Error("guest console 需要 --agent claude|codex");
    const relaunch = windowsTerminalRelaunch(process.argv.slice(1), values.agent);
    if (relaunch && await relaunchInWindowsTerminal(relaunch)) return 0;
    const home = path.resolve(values.home ?? commandHome());
    const config = readInstalledConfig(home);
    const tokenFile = runnerInstallPaths(home).token;
    return await runGuestConsole({
      gatewayUrl: config.runner_url,
      token: () => readFileSync(tokenFile, "utf8").trim(),
      agent: values.agent,
    });
  }
  const home = installedHome();
  if (sub === "host") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        "claude-dir": { type: "string" }, "codex-home": { type: "string" }, off: { type: "boolean", default: false },
        "sessions-root": { type: "string" }, "sessions-port": { type: "string" },
        "sessions-launch-prefix": { type: "string" }, "sessions-env": { type: "string", multiple: true },
      },
      strict: true,
    });
    const current = readInstalledConfig(home);
    if (current.execution_only) throw new Error("仅执行模式的 Runner 不能做访客会话主机");
    const next = { ...current };
    if (values.off) {
      delete next.model_egress;
      delete next.guest_sessions;
    } else {
      // The logins guests use directly (the key name is historical): the owner's
      // Claude login, and a Codex home logged in to just for guests.
      const logins = { ...current.model_egress };
      if (values["claude-dir"]) {
        const claudeDir = path.resolve(values["claude-dir"]);
        if (!existsSync(path.join(claudeDir, ".credentials.json"))) throw new Error(`${claudeDir} 里没有 Claude 登录 (.credentials.json)`);
        logins.anthropic = { config_dir: claudeDir };
      }
      const ownCodexHome = path.resolve(current.codex_home);
      if (values["codex-home"] === "") delete logins.openai;
      else if (values["codex-home"] !== undefined) {
        const codexHome = path.resolve(values["codex-home"]);
        if (codexHome === ownCodexHome) {
          throw new Error(`访客要用单独登录的 Codex 目录，不能用本机 Runner 自己的 ${ownCodexHome}（里面有本用户的 AGENTS.md、hooks、MCP 和会话记录）`);
        }
        if (!existsSync(path.join(codexHome, "auth.json"))) {
          throw new Error(`${codexHome} 里没有 Codex 登录 (auth.json)，先运行 CODEX_HOME=${codexHome} codex login --device-auth`);
        }
        logins.openai = { codex_home: codexHome };
      }
      // An entry left from the earlier egress design pointed at the Runner's own Codex home.
      if (logins.openai && path.resolve(logins.openai.codex_home) === ownCodexHome) delete logins.openai;
      if (!logins.anthropic && !logins.openai) {
        throw new Error("guest host 需要 --claude-dir <本用户的 Claude 配置目录> 和/或 --codex-home <访客专用的 Codex 目录>，或 --off");
      }
      next.model_egress = logins;
    }
    if (!values.off && values["sessions-root"]) {
      const root = path.resolve(values["sessions-root"]);
      if (root === home || root.startsWith(`${home}${path.sep}`)) {
        throw new Error("访客会话目录不能放在本用户的 home 里：守卫不让访客碰 /home");
      }
      const env = values["sessions-env"]
        ? Object.fromEntries(values["sessions-env"].map((pair) => {
          const at = pair.indexOf("=");
          if (at < 1) throw new Error(`--sessions-env 需要 KEY=VALUE：${pair}`);
          return [pair.slice(0, at), pair.slice(at + 1)];
        }))
        : current.guest_sessions?.env;
      // One string split on whitespace ("" clears it): parseArgs refuses option values that start with "-".
      const prefix = values["sessions-launch-prefix"] !== undefined
        ? values["sessions-launch-prefix"].trim().split(/\s+/).filter(Boolean)
        : current.guest_sessions?.launch_prefix ?? [];
      next.guest_sessions = readGuestSessionsConfig({
        root,
        port: values["sessions-port"] ? Number(values["sessions-port"]) : current.guest_sessions?.port ?? DEFAULT_GUEST_SESSIONS_PORT,
        ...(prefix.length ? { launch_prefix: prefix } : {}),
        ...(env ? { env } : {}),
      });
    }
    writeInstalledConfig(next);
    console.log(values.off ? "已关闭访客会话" : [
      `访客使用的 Claude 登录：${next.model_egress?.anthropic?.config_dir ?? "无"}`,
      `访客使用的 Codex 登录：${next.model_egress?.openai?.codex_home ?? "无"}`,
      next.guest_sessions ? `访客会话：${next.guest_sessions.root}，本机端口 ${next.guest_sessions.port}` : "访客会话：未开启（加 --sessions-root <目录>）",
      "常驻 Runner 约一分钟内生效",
    ].join("\n"));
    return 0;
  }
  if (sub === "sessions") {
    const { values } = parseArgs({ args: args.slice(1), options: { stop: { type: "string" }, purge: { type: "string" } }, strict: true });
    const config = readInstalledConfig(home);
    const sessions = new GuestSessionHost({
      config: () => config.guest_sessions,
      logins: () => config.model_egress,
      stateDir: runnerInstallPaths(home).root,
    });
    if (values.stop) {
      if (!await sessions.stop(values.stop)) throw new Error(`没有访客 ${values.stop}`);
      console.log(`已结束 ${values.stop} 的 tmux 会话（目录保留）`);
      return 0;
    }
    if (values.purge) {
      if (!await sessions.purge(values.purge)) throw new Error(`没有访客 ${values.purge}`);
      console.log(`已删除 ${values.purge} 的目录和口令`);
      return 0;
    }
    console.log(JSON.stringify({ root: config.guest_sessions?.root ?? null, guests: sessions.list() }, null, 2));
    return 0;
  }
  if (sub === "pack") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        device: { type: "string" },
        providers: { type: "string", default: "anthropic" },
        "ttl-days": { type: "string" },
        out: { type: "string" },
        "runner-bundle": { type: "string" },
      },
      strict: true,
    });
    const providers = String(values.providers).split(",").map((value) => value.trim()).filter(Boolean)
      .map((value) => value === "claude" ? "anthropic" : value === "codex" ? "openai" : value);
    if (!providers.length || providers.some((value) => value !== "anthropic" && value !== "openai")) {
      throw new Error("--providers 只能是 anthropic(claude)、openai(codex) 或两者");
    }
    const result = await packGuest(home, {
      device: requireValue(values.device, "guest pack 需要 --device <新设备名>"),
      providers: [...new Set(providers)] as Array<"anthropic" | "openai">,
      ...(values["ttl-days"] ? { ttlDays: Number(values["ttl-days"]) } : {}),
      ...(values.out ? { out: values.out } : {}),
      ...(values["runner-bundle"] ? { runnerBundle: values["runner-bundle"] } : {}),
    });
    console.log([
      `安装包：${result.file}`,
      `大小：${(result.bytes / 1024 / 1024).toFixed(1)} MiB  sha256：${result.sha256}`,
      `设备：${result.owner}/${result.device}，安装码 ${result.expires_at} 前有效，只能安装一次`,
      `版本：${Object.entries(result.versions).map(([key, value]) => `${key} ${value}`).join("，")}`,
    ].join("\n"));
    return 0;
  }
  if (sub === "status") {
    const config = readInstalledConfig(home);
    console.log(JSON.stringify({
      model_egress: config.model_egress ?? null,
      guest_sessions: config.guest_sessions ?? null,
      guest: config.guest ?? null,
      service_name: config.service_name ?? null,
    }, null, 2));
    return 0;
  }
  console.error(HELP);
  return 2;
}

function installedHome(): string {
  const home = commandHome();
  readInstalledConfig(home);
  return home;
}

function installedOrCommandHome(): string {
  const home = commandHome();
  try {
    return readInstalledConfig(home).scan_home;
  } catch {
    return home;
  }
}

function commandHome(): string {
  return path.resolve(process.env.RUNNER_SCAN_HOME?.trim() || os.homedir());
}

function normalizeDashboardUrl(value: string | undefined): string {
  const input = requireValue(value, "install 需要 --server <Dashboard URL>").replace(/\/$/, "");
  const url = new URL(input);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw new Error("Dashboard URL 必须使用 HTTPS（仅 loopback 允许 HTTP）");
  }
  return url.toString().replace(/\/$/, "");
}

function requireValue(value: string | undefined, message: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(message);
  return normalized;
}

function fileCheck(name: string, file: string, privateFile: boolean): { name: string; ok: boolean; detail: string } {
  try {
    const stat = statSync(file);
    const mode = stat.mode & 0o777;
    const permissionsOk = !privateFile || (process.platform === "win32"
      ? windowsPrivatePathIsRestricted(file)
      : (mode & 0o077) === 0);
    const permissionDetail = process.platform === "win32" ? `acl=${permissionsOk ? "restricted" : "too broad"}` : `mode=${mode.toString(8)}`;
    return { name, ok: stat.isFile() && permissionsOk, detail: `${file} ${permissionDetail}` };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function runnerVersion(): string {
  try {
    return createHash("sha256").update(readFileSync(process.argv[1])).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

export const HELP = `Octopus Runner

Usage:
  octopus-runner install --server <url> --enroll <一次性代码> [--workspace <目录>] [--linger(Linux)]
  octopus-runner status [--json]
  octopus-runner start|stop|restart
  octopus-runner logs --clear                 清空旧版 Runner 专属日志
  octopus-runner logs [-f] [-n 200]           仅查看旧日志；新版常驻进程不产生日志
  octopus-runner doctor
  octopus-runner agents list [--json]
  octopus-runner agents bind <claude|codex|omp> <绝对路径> [--interpreter <绝对路径>] [--trust-installation]
    --trust-installation 明确信任本安装当前的所有者及组写权限；不放行世界可写路径
  octopus-runner agents unbind <claude|codex|omp>
  octopus-runner agents exec <claude|codex|omp> [CLI 参数...]
  octopus-runner update
  octopus-runner enroll --server <url> --enroll <一次性代码>
  octopus-runner workspace list [--json]
  octopus-runner workspace add <目录> [--label <名称>]
  octopus-runner workspace remove <workspace_id>
  octopus-runner workspace rename <workspace_id> <名称>
  octopus-runner capabilities list
  octopus-runner capabilities register <private-manifest.json> [current-digest]
  octopus-runner capabilities reload|enable|disable|remove <id> <current-digest>
  octopus-runner config show
  octopus-runner sites list
  octopus-runner sites add <id> --server <url> --token-file <本地凭据文件>
  octopus-runner sites remove <id>
  octopus-runner sites control <id>
  octopus-runner sites updates <id|none>
  octopus-runner sites disable-primary|enable-primary
  octopus-runner guest host [--claude-dir <目录>] [--codex-home <目录>|""] --sessions-root <目录> [--sessions-port 47830]
      [--sessions-launch-prefix "<命令及参数>"] [--sessions-env KEY=VALUE ...] | --off
    在本机开启/关闭访客会话：访客的 Claude Code / Codex 以本用户在本机运行，限定在它自己的目录里。
    Claude 用本用户的登录；Codex 用单独登录的目录（CODEX_HOME=<目录> codex login --device-auth），"" 表示不再提供
  octopus-runner guest pack --device <新设备名> [--providers anthropic,openai] [--ttl-days 7] [--out <文件.exe>]
    生成一个双击即可安装的 Windows 访客客户端（内含一次性登记码，装过即失效）
  octopus-runner guest sessions [--stop <设备> | --purge <设备>]
    查看本机的访客；结束某个访客的 tmux 会话，或连同目录和口令一起删除
  octopus-runner guest status
  octopus-runner uninstall [--force]
  octopus-runner run --foreground
  octopus-runner version|--version
  octopus-runner help
`;
