import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { readInstalledConfig, runnerInstallPaths } from "./install-config.js";
import { WINDOWS_RESIDENT_HOST_NAME, WINDOWS_RESIDENT_HOST_SOURCE } from "./windows-resident-host.js";

export const RUNNER_SERVICE_LABEL = "org.example.octopus-runner";
const execFileAsync = promisify(execFile);

export interface ServiceFiles {
  kind: "launchd" | "systemd" | "windows-task";
  definitionPath: string;
  definition: string;
}

export const DEFAULT_WINDOWS_TASK_NAME = "OctopusRunner";

export function runnerServiceFiles(
  scanHome: string,
  platform: NodeJS.Platform = process.platform,
  nodePath = process.execPath,
  taskName = installedServiceName(scanHome),
): ServiceFiles {
  const paths = runnerInstallPaths(scanHome, platform);
  if (platform === "win32") {
    return {
      kind: "windows-task",
      definitionPath: path.win32.join(paths.root, "octopus-runner-task.ps1"),
      definition: windowsTaskScript(paths, path.win32.resolve(nodePath), taskName, path.win32.resolve(scanHome)),
    };
  }
  if (platform === "darwin") {
    const definitionPath = path.join(scanHome, "Library", "LaunchAgents", `${RUNNER_SERVICE_LABEL}.plist`);
    return {
      kind: "launchd",
      definitionPath,
      definition: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${RUNNER_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(paths.bundle)}</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(paths.root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`,
    };
  }
  if (platform === "linux") {
    const configRoot = process.env.XDG_CONFIG_HOME?.trim() || path.join(scanHome, ".config");
    const definitionPath = path.join(configRoot, "systemd", "user", "octopus-runner.service");
    return {
      kind: "systemd",
      definitionPath,
      definition: `[Unit]
Description=Octopus Runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(paths.bundle)} daemon
# WorkingDirectory is a literal path, not an ExecStart argument list.
WorkingDirectory=${paths.root.replace(/%/g, "%%")}
Restart=on-failure
RestartSec=3
# Agent sessions deliberately outlive a Runner upgrade/restart. The Runner's
# SIGTERM handler closes only the helper processes it owns.
KillMode=process
TimeoutStopSec=20

[Install]
WantedBy=default.target
`,
    };
  }
  throw new Error(`当前系统不支持自动服务管理: ${platform}`);
}

/** A guest client installs its own task beside an ordinary Runner's. */
function installedServiceName(scanHome: string): string {
  try {
    return readInstalledConfig(scanHome).service_name ?? DEFAULT_WINDOWS_TASK_NAME;
  } catch {
    return DEFAULT_WINDOWS_TASK_NAME;
  }
}

function writeServiceDefinition(scanHome: string, files: ServiceFiles): void {
  const paths = runnerInstallPaths(scanHome);
  mkdirSync(path.dirname(files.definitionPath), { recursive: true, mode: 0o700 });
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const candidate = `${files.definitionPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(candidate, files.kind === "windows-task" ? `\uFEFF${files.definition}` : files.definition, { mode: 0o600 });
    renameSync(candidate, files.definitionPath);
  } finally {
    rmSync(candidate, { force: true });
  }
  chmodSync(files.definitionPath, 0o600);
}

/**
 * Reconcile managed log sinks without restarting the current owner.
 *
 * Windows is deliberately excluded: the daemon never rewrites or re-registers
 * its scheduled task. On a remote personal machine the Runner is the only
 * channel, a task registered elevated refuses changes from the Limited token
 * (0x80070005), and Task Scheduler does not restart a killed action. Only an
 * explicit `octopus-runner install` changes the task (2026-10-22, jim-laptop).
 */
export async function reconcileRunnerService(scanHome: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const files = runnerServiceFiles(scanHome);
  if (files.kind === "windows-task" || !existsSync(files.definitionPath)) return false;
  const previous = readFileSync(files.definitionPath);
  const oldText = previous.toString("utf8");
  // Preserve local environment, executable, restart policy and Agent lifetime.
  if (!oldText.includes("octopus") || !oldText.includes("daemon")) return false;
  // Linux keeps the journal: undo only the null sinks an earlier bundle added.
  files.definition = files.kind === "systemd"
    ? oldText.replace(/^Standard(?:Output|Error)=null\r?\n/gm, "")
    : oldText.replace(/(<key>Standard(?:Out|Error)Path<\/key>\s*<string>)[^<]*(<\/string>)/g, "$1/dev/null$2");
  if (oldText === files.definition) return false;
  // Commit the file only after the reload succeeds, so failure retries on the
  // next daemon start. No credential or principal is replaced.
  writeServiceDefinition(scanHome, files);
  try {
    if (files.kind === "launchd") return true; // Applied at the next service start.
    // The reload must neither block the event loop/handshake nor outlive this
    // owner's update handover.
    const operation = execFileAsync("systemctl", ["--user", "daemon-reload"], {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
      killSignal: "SIGKILL", maxBuffer: 64 * 1024, signal,
    });
    const closed = new Promise<void>((resolve) => operation.child.once("close", () => resolve()));
    // Abort rejects execFile before the child necessarily closes. Wait for
    // close before restoring the file or allowing a successor to migrate it.
    try { await operation; } finally { await closed; }
  }
  catch (error) {
    writeFileSync(files.definitionPath, previous, { mode: 0o600 });
    throw error;
  }
  return true;
}

export function installRunnerService(scanHome: string): ServiceFiles {
  const files = runnerServiceFiles(scanHome);
  writeServiceDefinition(scanHome, files);
  if (files.kind === "windows-task") {
    windowsTask(files, "install");
  } else if (files.kind === "launchd") {
    launchctl(["bootout", launchDomain(), files.definitionPath], true);
    launchctl(["enable", `${launchDomain()}/${RUNNER_SERVICE_LABEL}`]);
    launchctl(["bootstrap", launchDomain(), files.definitionPath]);
    launchctl(["kickstart", "-k", `${launchDomain()}/${RUNNER_SERVICE_LABEL}`]);
  } else {
    systemctl(["daemon-reload"]);
    systemctl(["enable", "--now", "octopus-runner.service"]);
  }
  return files;
}

export function startRunnerService(scanHome: string): void {
  const files = runnerServiceFiles(scanHome);
  if (files.kind === "windows-task") {
    windowsTask(files, "start");
  } else if (files.kind === "launchd") {
    launchctl(["enable", `${launchDomain()}/${RUNNER_SERVICE_LABEL}`]);
    launchctl(["bootstrap", launchDomain(), files.definitionPath], true);
    launchctl(["kickstart", `${launchDomain()}/${RUNNER_SERVICE_LABEL}`]);
  } else {
    systemctl(["start", "octopus-runner.service"]);
  }
}

export function stopRunnerService(scanHome: string): void {
  const files = runnerServiceFiles(scanHome);
  if (files.kind === "windows-task") windowsTask(files, "stop", true);
  else if (files.kind === "launchd") launchctl(["bootout", launchDomain(), files.definitionPath], true);
  else systemctl(["stop", "octopus-runner.service"]);
}

export function restartRunnerService(scanHome: string): void {
  const files = runnerServiceFiles(scanHome);
  if (files.kind === "windows-task") {
    windowsTask(files, "restart");
  } else if (files.kind === "launchd") {
    launchctl(["bootout", launchDomain(), files.definitionPath], true);
    launchctl(["enable", `${launchDomain()}/${RUNNER_SERVICE_LABEL}`]);
    launchctl(["bootstrap", launchDomain(), files.definitionPath]);
    launchctl(["kickstart", "-k", `${launchDomain()}/${RUNNER_SERVICE_LABEL}`]);
  } else {
    systemctl(["restart", "octopus-runner.service"]);
  }
}

export function runnerServiceStatus(scanHome: string, inherit = false): { active: boolean; output: string } {
  const files = runnerServiceFiles(scanHome);
  const result = files.kind === "windows-task"
    ? windowsTask(files, "status", true, inherit)
    : files.kind === "launchd"
      ? run("launchctl", ["print", `${launchDomain()}/${RUNNER_SERVICE_LABEL}`], true, inherit)
      : run("systemctl", ["--user", "is-active", "octopus-runner.service"], true, inherit);
  return {
    active: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`.trim(),
  };
}

export function showRunnerLogs(scanHome: string, follow: boolean, lines: number): void {
  const files = runnerServiceFiles(scanHome);
  if (files.kind === "windows-task") {
    const logs = runnerInstallPaths(scanHome);
    const script = [
      "$files = @(" + [logs.stdoutLog, logs.stderrLog].map(powershellLiteral).join(",") + ")",
      `$existing = @($files | Where-Object { Test-Path -LiteralPath $_ })`,
      `if ($existing.Count -eq 0) { throw '尚无 Runner 日志' }`,
      `Get-Content -LiteralPath $existing -Tail ${lines}${follow ? " -Wait" : ""}`,
    ].join("\n");
    runPowerShell(script, false, true);
    return;
  }
  if (files.kind === "systemd") {
    run("journalctl", ["--user", "-u", "octopus-runner.service", "-n", String(lines), ...(follow ? ["-f"] : []), "--no-pager"], false, true);
    return;
  }
  const logs = runnerInstallPaths(scanHome);
  run("tail", ["-n", String(lines), ...(follow ? ["-f"] : []), logs.stdoutLog, logs.stderrLog], false, true);
}

export function uninstallRunnerService(scanHome: string): void {
  const files = runnerServiceFiles(scanHome);
  if (files.kind === "windows-task") {
    windowsTask(files, "uninstall", true);
  } else if (files.kind === "launchd") {
    launchctl(["bootout", launchDomain(), files.definitionPath], true);
    launchctl(["disable", `${launchDomain()}/${RUNNER_SERVICE_LABEL}`], true);
  } else {
    systemctl(["disable", "--now", "octopus-runner.service"], true);
  }
  rmSync(files.definitionPath, { force: true });
  if (files.kind === "systemd") systemctl(["daemon-reload"], true);
}

export function enableRunnerLinger(): void {
  if (process.platform !== "linux") throw new Error("--linger 只适用于 Linux");
  const result = run("loginctl", ["enable-linger", os.userInfo().username], true, true);
  if (result.status !== 0) throw new Error("无法启用 systemd user linger；请按上方提示完成管理员授权");
}

function launchDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd 需要当前用户 uid");
  return `gui/${uid}`;
}

function launchctl(args: string[], tolerate = false): void {
  const result = run("launchctl", args, tolerate, false);
  if (!tolerate && result.status !== 0) throw commandError("launchctl", args, result);
}

function systemctl(args: string[], tolerate = false): void {
  const full = ["--user", ...args];
  const result = run("systemctl", full, tolerate, false);
  if (!tolerate && result.status !== 0) throw commandError("systemctl", full, result);
}

function windowsTask(
  files: ServiceFiles,
  action: "install" | "start" | "stop" | "restart" | "status" | "uninstall",
  tolerate = false,
  inherit = false,
) {
  return run("powershell.exe", windowsTaskArgs(files, action), tolerate, inherit);
}

function windowsTaskArgs(files: ServiceFiles, action: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    files.definitionPath,
    action,
  ];
}

function runPowerShell(script: string, tolerate: boolean, inherit: boolean) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ], tolerate, inherit);
}

function run(command: string, args: string[], tolerate: boolean, inherit: boolean) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.error && !tolerate) throw result.error;
  if (result.status !== 0 && !tolerate) throw commandError(command, args, result);
  return result;
}

function commandError(command: string, args: string[], result: ReturnType<typeof spawnSync>): Error {
  const detail = String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim();
  return new Error(`${command} ${args.join(" ")} 失败: ${detail}`);
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function systemdQuote(value: string): string {
  // `%` is a systemd specifier even inside quotes. Paths are literal here.
  return `"${value.replace(/%/g, "%%").replace(/([\\"])/g, "\\$1")}"`;
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function windowsTaskScript(
  paths: ReturnType<typeof runnerInstallPaths>,
  nodePath: string,
  taskName = DEFAULT_WINDOWS_TASK_NAME,
  scanHome?: string,
): string {
  return `# Octopus managed task format 4
param(
  [ValidateSet('install','start','stop','restart','status','uninstall','run')]
  [string]$Mode
)
$ErrorActionPreference = 'Stop'
$TaskName = ${powershellLiteral(taskName)}
$RunnerRoot = ${powershellLiteral(paths.root)}
$NodeExe = ${powershellLiteral(nodePath)}
$RunnerFile = ${powershellLiteral(paths.bundle)}

if ($Mode -eq 'run') {
  Set-Location -LiteralPath $RunnerRoot${scanHome ? `
  # The daemon finds this installation's config through its scan home.
  $env:RUNNER_SCAN_HOME = ${powershellLiteral(scanHome)}` : ""}
  # Task Scheduler owns this foreground process tree. An explicit task stop
  # terminates the supervisor too; ordinary child crashes never exhaust a
  # finite Scheduled Task retry budget. Discard all native output locally.
  while ($true) {
    $ErrorActionPreference = 'Continue'
    try { & $NodeExe $RunnerFile daemon *> $null }
    catch { }
    $ErrorActionPreference = 'Stop'
    Start-Sleep -Seconds 3
  }
}

if ($Mode -eq 'install') {
  $CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $ScriptPath = $MyInvocation.MyCommand.Path
  $HostPath = Join-Path $RunnerRoot '${WINDOWS_RESIDENT_HOST_NAME}'
  if (-not (Test-Path -LiteralPath $HostPath -PathType Leaf)) {
    # Compile with the .NET Framework already required by PowerShell 5.1.
    # A content-addressed name avoids overwriting a running executable.
    $Candidate = $HostPath + '.' + [guid]::NewGuid().ToString('N') + '.exe'
    try {
      Add-Type -TypeDefinition @'
${WINDOWS_RESIDENT_HOST_SOURCE}
'@ -OutputAssembly $Candidate -OutputType WindowsApplication
      Move-Item -LiteralPath $Candidate -Destination $HostPath -Force
    } finally { Remove-Item -LiteralPath $Candidate -Force -ErrorAction SilentlyContinue }
  }
  $ActionArgs = '"' + $ScriptPath.Replace('"', '""') + '"'
  $Action = New-ScheduledTaskAction -Execute $HostPath -Argument $ActionArgs -WorkingDirectory $RunnerRoot
  $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
  $Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
  $Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  $Settings.ExecutionTimeLimit = 'PT0S'
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  exit 0
}

function Get-RunnerProcesses {
  # Old task actions had no Job and can leave the installed daemon orphaned.
  # Match only this installation's executable and daemon entry, never all Node.
  $Entries = @($RunnerFile, (Join-Path $RunnerRoot 'standalone.prev.js'))
  $Pattern = '(?:^|\\s)"?(?:' + (($Entries | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')"?\\s+daemon(?:\\s|$)'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.ExecutablePath -eq $NodeExe -and $_.CommandLine -match $Pattern
  } | ForEach-Object {
    $Resident = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($Resident) {
      # Open a handle now so a later PID reuse cannot target another process.
      try { $null = $Resident.Handle; $Resident } catch { $Resident.Dispose() }
    }
  }
}

function Stop-RunnerTask($Residents) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  foreach ($Resident in $Residents) {
    try { if (-not $Resident.HasExited) { $Resident.Kill() } }
    finally { $Resident.Dispose() }
  }
}

if ($Mode -eq 'uninstall') {
  Stop-RunnerTask @(Get-RunnerProcesses)
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}

$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $Task) { Write-Error ($TaskName + ' task is not installed'); exit 2 }
switch ($Mode) {
  'start' { Start-ScheduledTask -TaskName $TaskName; exit 0 }
  'stop' { Stop-RunnerTask @(Get-RunnerProcesses); exit 0 }
  'restart' {
    # A restart requested through Runner is itself in the task's Job. Stopping
    # the task kills this caller too, so entrust the next start to the OS first.
    $Residents = @(Get-RunnerProcesses)
    $Restart = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5)
    $Restart.Id = 'OctopusRestart'
    $Triggers = @($Task.Triggers | Where-Object { $_.Id -ne 'OctopusRestart' }) + @($Restart)
    Set-ScheduledTask -TaskName $TaskName -Trigger $Triggers | Out-Null
    Stop-RunnerTask $Residents
    exit 0
  }
  'status' {
    $Task = Get-ScheduledTask -TaskName $TaskName
    $Info = Get-ScheduledTaskInfo -TaskName $TaskName
    $Hidden = [IO.Path]::GetFileName($Task.Actions[0].Execute) -eq '${WINDOWS_RESIDENT_HOST_NAME}'
    Write-Output ("{0}; last={1}; result={2}; windowless_action={3}; logon={4}; runlevel={5}; battery_start={6}; battery_continue={7}; restart_count={8}" -f $Task.State, $Info.LastRunTime, $Info.LastTaskResult, $Hidden, $Task.Principal.LogonType, $Task.Principal.RunLevel, (-not $Task.Settings.DisallowStartIfOnBatteries), (-not $Task.Settings.StopIfGoingOnBatteries), $Task.Settings.RestartCount)
    if ($Task.State -eq 'Running') { exit 0 } else { exit 3 }
  }
}
`;
}
