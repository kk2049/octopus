/**
 * The onboarding commands, composed on the server.
 *
 * They are built here rather than in the browser for two reasons that are both
 * about correctness rather than taste: only the server knows the bot's real
 * outside address (config, or IMDS probing at startup), and the commands are
 * pasted into a shell, so the quoting has to be right once instead of at every
 * place that renders them. The download is also the upgrade path: fetch beside
 * the live bundle, syntax-check, then atomically replace it. A failed transfer
 * or malformed response therefore leaves the currently runnable file intact.
 *
 * One source of truth: the overview page's tutorial (with a placeholder token)
 * and the mint API / Feishu reply (with the real one) both render from here.
 *
 * Extracted from the retired `page.ts` when the panel moved to a React bundle;
 * these two functions were the only parts of that file that were not markup.
 */

const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "[::1]", "::1"]);

/** Best outside-reachable host for tutorial commands; guessed=true → warn the viewer. */
export function resolveTutorialHost(
  publicHost?: string,
  requestHost?: string,
): { host: string; guessed: boolean } {
  const req = requestHost ?? "";
  const solid = publicHost || (!LOCAL_HOSTS.has(req) ? req : "");
  return solid ? { host: solid, guessed: false } : { host: req || "<bot服务器地址>", guessed: true };
}

export interface RunnerCommands {
  download: string;
  /** Multi-line, backslash-continued (tutorial display). */
  run: string;
  /** Single-line equivalent (chat replies, copy-paste). */
  runOneline: string;
  daemon: string;
  /** Native Windows PowerShell installer: dependencies, bundle and login task. */
  windowsInstall: string;
  /** Installed-service flow for macOS and systemd Linux. */
  unixInstall: string;
}

export function buildUnixInstallCommand(dashboardUrl: string, enrollmentCode: string): string {
  const base = dashboardUrl.replace(/\/$/, "");
  return [
    `curl -fsSL ${shellLiteral(`${base}/install/octopus-runner.sh`)} -o /tmp/octopus-runner-install.sh`,
    `sh /tmp/octopus-runner-install.sh --server ${shellLiteral(base)} --enroll ${shellLiteral(enrollmentCode)}`,
  ].join(" && \\\n  ");
}

export function buildWindowsInstalledCommand(dashboardUrl: string, enrollmentCode: string): string {
  const base = dashboardUrl.replace(/\/$/, "");
  return [
    `$ErrorActionPreference='Stop'; $i=Join-Path $env:TEMP 'octopus-runner-install.ps1'; Invoke-WebRequest -UseBasicParsing ${powershellLiteral(`${base}/install/octopus-runner.ps1`)} -OutFile $i`,
    `& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $i -Server ${powershellLiteral(base)} -Enroll ${powershellLiteral(enrollmentCode)}; if ($LASTEXITCODE -ne 0) { throw "Octopus Runner 安装失败（exit $LASTEXITCODE）" }`,
  ].join("\n");
}

/**
 * winget can install Node as a portable ZIP. Its PATH additions are persisted
 * for future shells, so refresh this process and check the stable WinGet links.
 * Both Windows entry points must use the same version-aware discovery.
 */
function windowsNodeDiscoveryLines(): string[] {
  return [
    "function Refresh-Path {",
    "  $Paths = @($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))",
    "  $env:Path = (($Paths -join ';') -split ';' | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_) } | Select-Object -Unique) -join ';'",
    "}",
    "function Find-Node {",
    "  Refresh-Path",
    "  $Found = @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)",
    "  $Candidates = @(",
    "    (Join-Path $env:ProgramFiles 'nodejs\\node.exe'),",
    "    (Join-Path $env:LOCALAPPDATA 'Programs\\nodejs\\node.exe'),",
    "    (Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links\\node.exe'),",
    "    (Join-Path $env:ProgramFiles 'WinGet\\Links\\node.exe')",
    "  ) + @($Found | ForEach-Object { $_.Source })",
    "  foreach ($Candidate in ($Candidates | Select-Object -Unique)) {",
    "    if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { continue }",
    "    try {",
    "      $Major = & $Candidate -p \"process.versions.node.split('.')[0]\" 2>$null",
    "      if ($LASTEXITCODE -eq 0 -and \"$Major\" -match '^\\d+$' -and [int]$Major -ge 20) { return (Resolve-Path -LiteralPath $Candidate).Path }",
    "    } catch { continue }",
    "  }",
    "  return $null",
    "}",
  ];
}

/** Public Windows bootstrap; the one-shot enrollment is its only authority. */
export function windowsInstallerScript(): string {
  // Windows PowerShell 5.1 decodes a BOM-less script through the active ANSI
  // code page even when HTTP declares UTF-8. A UTF-8 BOM is therefore part of
  // this public byte contract, not cosmetic text formatting: without it the
  // Chinese diagnostics can be decoded into quote-like bytes and break parse.
  return "\uFEFF" + [
    "param(",
    "  [Parameter(Mandatory=$true)][string]$Server,",
    "  [Parameter(Mandatory=$true)][string]$Enroll,",
    "  [string]$Workspace = ''",
    ")",
    "$ErrorActionPreference = 'Stop'",
    "$Server = $Server.TrimEnd('/')",
    "$ServerUri = [Uri]$Server",
    "$Loopback = @('localhost', '127.0.0.1', '::1') -contains $ServerUri.Host",
    "if ($ServerUri.Scheme -ne 'https' -and -not ($ServerUri.Scheme -eq 'http' -and $Loopback)) { throw 'Server 必须使用 HTTPS（仅本机回环允许 HTTP）' }",
    "if ($Enroll -notmatch '^re_[0-9a-f]{48}$') { throw 'enrollment 格式无效' }",
    "",
    "function Require-Winget {",
    "  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw '缺少 Node.js/Git 且未找到 winget；请先安装 Microsoft App Installer' }",
    "}",
    "function Install-WingetPackage([string]$Id) {",
    "  Require-Winget",
    "  & winget.exe install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements",
    "  if ($LASTEXITCODE -ne 0) { throw \"$Id 安装失败（winget $LASTEXITCODE）；请尝试以管理员身份重新运行 PowerShell\" }",
    "  Refresh-Path",
    "}",
    ...windowsNodeDiscoveryLines(),
    "function Find-GitBash {",
    "  $Git = Get-Command git.exe -ErrorAction SilentlyContinue",
    "  $GitRoot = if ($Git -and $Git.Source) { Split-Path (Split-Path $Git.Source -Parent) -Parent } else { $null }",
    "  $Candidates = @((Join-Path $env:ProgramFiles 'Git\\bin\\bash.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\\Git\\bin\\bash.exe'), $(if ($GitRoot) { Join-Path $GitRoot 'bin\\bash.exe' }))",
    "  foreach ($Candidate in $Candidates) { if ($Candidate -and (Test-Path -LiteralPath $Candidate)) { return (Resolve-Path -LiteralPath $Candidate).Path } }",
    "  return $null",
    "}",
    "",
    "$NodeExe = Find-Node",
    "$NodeMajor = if ($NodeExe) { [int](& $NodeExe -p \"process.versions.node.split('.')[0]\") } else { 0 }",
    "if ($NodeMajor -lt 20) { Install-WingetPackage 'OpenJS.NodeJS.22'; $NodeExe = Find-Node }",
    "if (-not $NodeExe) { throw '安装后仍未找到 Node.js >= 20' }",
    "$NodeMajor = [int](& $NodeExe -p \"process.versions.node.split('.')[0]\")",
    "if ($NodeMajor -lt 20) { throw \"Runner 需要 Node.js >= 20，当前为 $NodeMajor\" }",
    "$GitBash = Find-GitBash",
    "if (-not $GitBash) { Install-WingetPackage 'Git.Git'; $GitBash = Find-GitBash }",
    "if (-not $GitBash) { throw '安装后仍未找到 Git Bash；不会回退到 WSL' }",
    "",
    "$Candidate = Join-Path ([IO.Path]::GetTempPath()) ('octopus-runner-' + [Guid]::NewGuid().ToString('N') + '.js')",
    "$ShaFile = $Candidate + '.sha256'",
    "try {",
    "  Invoke-WebRequest -UseBasicParsing -Uri \"$Server/install/runner.js\" -OutFile $Candidate",
    "  Invoke-WebRequest -UseBasicParsing -Uri \"$Server/install/runner.sha256\" -OutFile $ShaFile",
    "  $Expected = (Get-Content -LiteralPath $ShaFile -Raw).Trim()",
    "  if ($Expected -notmatch '^[0-9a-f]{64}$') { throw 'Runner checksum 响应无效' }",
    "  $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Candidate).Hash.ToLowerInvariant()",
    "  if ($Actual -ne $Expected) { throw 'Runner checksum 不匹配' }",
    "  & $NodeExe --check $Candidate",
    "  if ($LASTEXITCODE -ne 0) { throw 'Runner 未通过 node --check' }",
    "  $env:RUNNER_EXEC_SHELL = $GitBash",
    "  $InstallArgs = @($Candidate, 'install', '--server', $Server, '--enroll', $Enroll)",
    "  if ($Workspace) { $InstallArgs += @('--workspace', $Workspace) }",
    "  & $NodeExe @InstallArgs",
    "  if ($LASTEXITCODE -ne 0) { throw \"Octopus Runner 安装失败（exit $LASTEXITCODE）\" }",
    "} finally {",
    "  Remove-Item -LiteralPath $Candidate, $ShaFile -Force -ErrorAction SilentlyContinue",
    "}",
    "Write-Host '安装完成。请打开新的 PowerShell，然后运行 octopus-runner status。' -ForegroundColor Green",
    "",
  ].join("\r\n");
}

/** Public bootstrap bytes. Authority enters only through the one-shot code. */
export function unixInstallerScript(): string {
  return `#!/bin/sh
set -eu

server=""
enroll=""
workspace=""
linger="0"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) server="$2"; shift 2 ;;
    --enroll) enroll="$2"; shift 2 ;;
    --workspace) workspace="$2"; shift 2 ;;
    --linger) linger="1"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$server" ] || [ -z "$enroll" ]; then
  echo "usage: install.sh --server <https-url> --enroll <one-shot-code> [--workspace <dir>] [--linger]" >&2
  exit 2
fi
case "$(uname -s)" in Darwin|Linux) ;; *) echo "only macOS and Linux are supported" >&2; exit 1 ;; esac
command -v node >/dev/null 2>&1 || { echo "Node.js >= 20 is required" >&2; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || { echo "Node.js >= 20 is required (found $major)" >&2; exit 1; }
tmp="$(mktemp "\${TMPDIR:-/tmp}/octopus-runner.XXXXXX.js")"
sha_file="$tmp.sha256"
trap 'rm -f "$tmp" "$sha_file"' EXIT HUP INT TERM
curl -fsSL "$server/install/runner.js" -o "$tmp"
curl -fsSL "$server/install/runner.sha256" -o "$sha_file"
expected="$(tr -d '[:space:]' < "$sha_file")"
printf '%s\\n' "$expected" | grep -E '^[0-9a-f]{64}$' >/dev/null || { echo "invalid Runner checksum response" >&2; exit 1; }
case "$(uname -s)" in
  Darwin) actual="$(shasum -a 256 "$tmp" | awk '{print $1}')" ;;
  Linux) actual="$(sha256sum "$tmp" | awk '{print $1}')" ;;
esac
[ "$actual" = "$expected" ] || { echo "Runner checksum mismatch" >&2; exit 1; }
node --check "$tmp"
if [ -n "$workspace" ] && [ "$linger" = "1" ]; then
  node "$tmp" install --server "$server" --enroll "$enroll" --workspace "$workspace" --linger
elif [ -n "$workspace" ]; then
  node "$tmp" install --server "$server" --enroll "$enroll" --workspace "$workspace"
elif [ "$linger" = "1" ]; then
  node "$tmp" install --server "$server" --enroll "$enroll" --linger
else
  node "$tmp" install --server "$server" --enroll "$enroll"
fi
`;
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildWindowsInstallCommand(o: {
  wsUrl: string;
  dashBase: string;
  token: string;
  device: string;
}): string {
  const wsUrl = powershellLiteral(o.wsUrl);
  const dashBase = powershellLiteral(o.dashBase);
  const token = powershellLiteral(o.token);
  const device = powershellLiteral(o.device);
  return [
    "& {",
    "  $ErrorActionPreference = 'Stop'",
    "  $Admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    "  if (-not $Admin) { throw '请用“以管理员身份运行”的 PowerShell 执行此命令' }",
    "  function Require-Winget { if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw '缺少依赖且未找到 winget；请先从 Microsoft Store 安装 App Installer' } }",
    "",
    ...windowsNodeDiscoveryLines().map((line) => `  ${line}`),
    "  $NodeExe = Find-Node",
    "  $NodeMajor = if ($NodeExe) { [int](& $NodeExe -p \"process.versions.node.split('.')[0]\") } else { 0 }",
    "  if ($NodeMajor -lt 20) {",
    "    Require-Winget",
    "    & winget.exe install --id OpenJS.NodeJS.22 --exact --silent --accept-package-agreements --accept-source-agreements",
    "    if ($LASTEXITCODE -ne 0) { throw \"Node.js 22 安装失败，winget 退出码 $LASTEXITCODE\" }",
    "    $NodeExe = Find-Node",
    "  }",
    "  if (-not $NodeExe) { throw 'Node.js 安装完成后仍未找到 node.exe' }",
    "  $NodeMajor = [int](& $NodeExe -p \"process.versions.node.split('.')[0]\")",
    "  if ($NodeMajor -lt 20) { throw \"Runner 需要 Node.js >= 20，当前主版本为 $NodeMajor\" }",
    "",
    "  function Find-GitBash {",
    "    $Git = Get-Command git.exe -ErrorAction SilentlyContinue",
    "    $GitRoot = if ($Git.Source) { Split-Path (Split-Path $Git.Source -Parent) -Parent } else { $null }",
    "    $Candidates = @(",
    "      $(if ($GitRoot) { Join-Path $GitRoot 'bin\\bash.exe' }),",
    "      (Join-Path $env:ProgramFiles 'Git\\bin\\bash.exe'),",
    "      $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Git\\bin\\bash.exe' }),",
    "      (Join-Path $env:LOCALAPPDATA 'Programs\\Git\\bin\\bash.exe')",
    "    )",
    "    foreach ($Candidate in $Candidates) { if ($Candidate -and (Test-Path $Candidate)) { return (Resolve-Path $Candidate).Path } }",
    "    return $null",
    "  }",
    "  $GitBash = Find-GitBash",
    "  if (-not $GitBash) {",
    "    Require-Winget",
    "    & winget.exe install --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements",
    "    if ($LASTEXITCODE -ne 0) { throw \"Git for Windows 安装失败，winget 退出码 $LASTEXITCODE\" }",
    "    Refresh-Path",
    "    $GitBash = Find-GitBash",
    "  }",
    "  if (-not $GitBash) { throw 'Git 安装完成后仍未找到 Git Bash；不会回退到 WSL' }",
    "",
    "  $RunnerRoot = Join-Path $env:USERPROFILE '.octopus\\runner'",
    "  $RunnerFile = Join-Path $RunnerRoot 'runner.js'",
    "  $CandidateFile = Join-Path $RunnerRoot 'runner.next.js'",
    "  $TokenFile = Join-Path $RunnerRoot 'token.txt'",
    "  $LauncherFile = Join-Path $RunnerRoot 'run-runner.ps1'",
    "  New-Item -ItemType Directory -Force -Path $RunnerRoot | Out-Null",
    `  $RunnerToken = ${token}`,
    `  $WsUrl = ${wsUrl}`,
    `  $DashBase = ${dashBase}`,
    `  $Device = ${device}`,
    "  try {",
    "    Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = \"Bearer $RunnerToken\" } -Uri \"$DashBase/download/runner.js\" -OutFile $CandidateFile",
    "    & $NodeExe --check $CandidateFile",
    "    if ($LASTEXITCODE -ne 0) { throw '下载的 Runner 未通过 node --check' }",
    "    Move-Item -Force $CandidateFile $RunnerFile",
    "    [IO.File]::WriteAllText($TokenFile, $RunnerToken, (New-Object Text.UTF8Encoding($false)))",
    "    $CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "    & icacls.exe $TokenFile /inheritance:r /grant:r \"${CurrentUser}:(F)\" 'SYSTEM:(F)' | Out-Null",
    "    if ($LASTEXITCODE -ne 0) { throw '无法收紧 Runner token 文件权限' }",
    "  } finally {",
    "    Remove-Item -Force $CandidateFile -ErrorAction SilentlyContinue",
    "    $RunnerToken = $null",
    "  }",
    "",
    "  function ConvertTo-PsLiteral([string]$Value) { return \"'\" + $Value.Replace(\"'\", \"''\") + \"'\" }",
    "  $RunnerPath = (Split-Path $NodeExe -Parent) + ';' + (Split-Path $GitBash -Parent) + ';' + $env:Path",
    "  $LauncherLines = [string[]]@(",
    "    \"`$ErrorActionPreference = 'Stop'\",",
    "    ('$env:OCTOPUS_URL = ' + (ConvertTo-PsLiteral $WsUrl)),",
    "    ('$env:OCTOPUS_RUNNER_TOKEN_FILE = ' + (ConvertTo-PsLiteral $TokenFile)),",
    "    ('$env:RUNNER_DEVICE = ' + (ConvertTo-PsLiteral $Device)),",
    "    ('$env:RUNNER_SCAN_HOME = ' + (ConvertTo-PsLiteral $env:USERPROFILE)),",
    "    \"`$env:RUNNER_AGENT_HOOKS = 'off'\",",
    "    \"`$env:RUNNER_LOCAL_MCP = 'off'\",",
    "    \"`$env:RUNNER_ALLOW_MACHINE_OPS = '1'\",",
    "    \"`$env:RUNNER_EXECUTION_ONLY = '1'\",",
    "    ('$env:RUNNER_EXEC_SHELL = ' + (ConvertTo-PsLiteral $GitBash)),",
    "    \"`$env:OCTOPUS_RUNNER_DSH_TUNNEL = '0'\",",
    "    \"`$env:RUNNER_KNOWLEDGE_INDEX = '0'\",",
    "    \"`$env:RUNNER_SELF_UPDATE = '1'\",",
    "    ('$env:Path = ' + (ConvertTo-PsLiteral $RunnerPath)),",
    "    ('$NodeExe = ' + (ConvertTo-PsLiteral $NodeExe)),",
    "    ('$RunnerFile = ' + (ConvertTo-PsLiteral $RunnerFile)),",
    "    ('$StdoutFile = ' + (ConvertTo-PsLiteral (Join-Path $RunnerRoot 'runner.out.log'))),",
    "    ('$StderrFile = ' + (ConvertTo-PsLiteral (Join-Path $RunnerRoot 'runner.err.log'))),",
    "    '$Arguments = ''\"'' + $RunnerFile + ''\"''',",
    "    '$Process = Start-Process -FilePath $NodeExe -ArgumentList $Arguments -WorkingDirectory (Split-Path $RunnerFile -Parent) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $StdoutFile -RedirectStandardError $StderrFile',",
    "    'exit $Process.ExitCode'",
    "  )",
    "  [IO.File]::WriteAllLines($LauncherFile, $LauncherLines, (New-Object Text.UTF8Encoding($false)))",
    "",
    "  $TaskName = 'OctopusRunner'",
    "  $Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument \"-NoProfile -ExecutionPolicy Bypass -File `\"$LauncherFile`\"\"",
    "  $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser",
    "  $Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited",
    "  $Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1)",
    "  $Settings.ExecutionTimeLimit = 'PT0S'",
    "  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {",
    "    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue",
    "    Set-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null",
    "  } else {",
    "    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null",
    "  }",
    "  Start-ScheduledTask -TaskName $TaskName",
    "  Write-Host \"Runner 已安装并启动：$CurrentUser/$Device\" -ForegroundColor Green",
    "  Write-Host \"日志：$RunnerRoot\\runner.out.log 和 runner.err.log\"",
    "}",
  ].join("\n");
}

/**
 * Token and device are single-quoted: harmless for real values, and it keeps
 * `<placeholder>` text from being parsed as shell redirection when pasted.
 */
export function buildRunnerCommands(o: {
  host: string;
  dashboardPort: number;
  wsPort: number;
  runnerPublicUrl?: string;
  /** Dashboard's public https base; beats the plaintext host:port form. */
  publicUrl?: string;
  token: string;
  device: string;
}): RunnerCommands {
  const wsUrl = o.runnerPublicUrl || `ws://${o.host}:${o.wsPort}`;
  const dashBase = o.publicUrl?.replace(/\/$/, "") || `http://${o.host}:${o.dashboardPort}`;
  // Header, not a query string: this command is pasted into a shell, so a token
  // in the URL lands in shell history and in every log the request passes
  // through. The bundle is not secret; the credential is.
  // Keep the candidate's final extension recognizable by Node. Node 22 resolves
  // the module format before --check, so `runner.js.next` is rejected as an
  // unknown file type without ever checking the downloaded JavaScript.
  const download = `curl -fL -H "Authorization: Bearer ${o.token}" -o runner.next.js "${dashBase}/download/runner.js"`
    + " && node --check runner.next.js && mv -f runner.next.js runner.js";
  const envs = `OCTOPUS_URL=${wsUrl} OCTOPUS_RUNNER_TOKEN='${o.token}' RUNNER_DEVICE='${o.device}' RUNNER_SCAN_HOME=$HOME CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}" OCTOPUS_RUNNER_DSH_TUNNEL=1`;
  const unixInstall = buildUnixInstallCommand(dashBase, o.token);
  return {
    download,
    run: [
      `OCTOPUS_URL=${wsUrl} \\`,
      `  OCTOPUS_RUNNER_TOKEN='${o.token}' \\`,
      `  RUNNER_DEVICE='${o.device}' \\`,
      `  RUNNER_SCAN_HOME=$HOME \\`,
      `  CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}" \\`,
      `  OCTOPUS_RUNNER_DSH_TUNNEL=1 \\`,
      `  node runner.js`,
    ].join("\n"),
    runOneline: `${envs} node runner.js`,
    daemon: `setsid nohup env ${envs} node runner.js >> runner.log 2>&1 &`,
    windowsInstall: buildWindowsInstallCommand({ wsUrl, dashBase, token: o.token, device: o.device }),
    unixInstall,
  };
}

/** The placeholder the tutorial shows in place of a real device token. */
export const TOKEN_PLACEHOLDER = "<第1步拿到的rt_令牌>";

function shellLiteral(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
