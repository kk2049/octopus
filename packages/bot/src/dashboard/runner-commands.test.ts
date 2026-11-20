import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildRunnerCommands,
  buildUnixInstallCommand,
  buildWindowsInstalledCommand,
  unixInstallerScript,
  windowsInstallerScript,
} from "./runner-commands.js";

describe("macOS/Linux Runner onboarding command", () => {
  it("carries only a one-shot enrollment and lets the bundled CLI own installation", () => {
    const command = buildUnixInstallCommand("https://bot.example.com/", `re_${"a".repeat(48)}`);
    expect(command).toContain("https://bot.example.com/install/octopus-runner.sh");
    expect(command).toContain(`re_${"a".repeat(48)}`);
    expect(command).not.toContain("rt_");
    const script = unixInstallerScript();
    expect(script).toContain("Darwin|Linux");
    expect(script).toContain("Node.js >= 20");
    expect(script).toContain("/install/runner.sha256");
    expect(script).toContain("Runner checksum mismatch");
    expect(script).toContain('--linger) linger="1"');
    expect(script).toContain("node --check");
    expect(script).toContain('node "$tmp" install');
  });

  it("accepts an exact lowercase SHA-256 checksum in the rendered shell script", () => {
    const validation = unixInstallerScript()
      .split("\n")
      .find((line) => line.includes("invalid Runner checksum response"));
    expect(validation).toBe(
      `printf '%s\\n' "$expected" | grep -E '^[0-9a-f]{64}$' >/dev/null || { echo "invalid Runner checksum response" >&2; exit 1; }`,
    );

    const runValidation = (expected: string) => spawnSync("sh", ["-c", validation!], {
      env: { ...process.env, expected },
      encoding: "utf8",
    });
    expect(runValidation("a".repeat(64)).status).toBe(0);
    expect(runValidation("a".repeat(63)).status).toBe(1);
    expect(runValidation("A".repeat(64)).status).toBe(1);
  });
});

describe("Windows Runner onboarding command", () => {
  it("uses a short one-shot bootstrap and delegates the durable install to the CLI", () => {
    const code = `re_${"b".repeat(48)}`;
    const command = buildWindowsInstalledCommand("https://bot.example.com/", code);
    expect(command.split("\n")).toHaveLength(2);
    expect(command).toContain("/install/octopus-runner.ps1");
    expect(command).toContain("Join-Path $env:TEMP");
    expect(command).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass -File $i");
    expect(command).toContain(code);
    expect(command).not.toContain("rt_");
    expect(command).not.toContain("Register-ScheduledTask");

    const script = windowsInstallerScript();
    expect(script.charCodeAt(0)).toBe(0xFEFF);
    expect([...Buffer.from(script, "utf8").subarray(0, 3)]).toEqual([0xEF, 0xBB, 0xBF]);
    expect(script).toContain("OpenJS.NodeJS.22");
    expect(script).toContain("Git.Git");
    expect(script).toContain("/install/runner.sha256");
    expect(script).toContain("Get-FileHash -Algorithm SHA256");
    expect(script).toContain("'install', '--server'");
    expect(script).toContain("RUNNER_EXEC_SHELL");
    expect(script.toLowerCase()).not.toContain("wsl.exe");
    expect(script).not.toContain("Register-ScheduledTask");
    expect(script).not.toContain("WindowsBuiltInRole");
  });

  it("keeps the legacy inline installer for already-open dashboard bundles", () => {
    const command = buildRunnerCommands({
      host: "bot.example.com",
      dashboardPort: 9820,
      wsPort: 9910,
      publicUrl: "https://bot.example.com/",
      runnerPublicUrl: "wss://bot.example.com/octopus-runner/v1",
      token: "rt_0123456789abcdef0123456789abcdef",
      device: "win-desktop",
    }).windowsInstall;

    expect(command).toContain("Invoke-WebRequest -UseBasicParsing");
    expect(command).toContain('Authorization = "Bearer $RunnerToken"');
    expect(command).toContain("node --check");
    expect(command).toContain("OpenJS.NodeJS.22");
    const discovery = windowsInstallerScript().split("\r\n");
    const start = discovery.indexOf("function Refresh-Path {");
    const end = discovery.indexOf("function Find-GitBash {");
    for (const line of discovery.slice(start, end)) expect(command).toContain(`  ${line}`);
    expect(command).toContain("Git.Git");
    expect(command).toContain("RUNNER_EXECUTION_ONLY = '1'");
    expect(command).toContain("RUNNER_EXEC_SHELL");
    expect(command).toContain("Register-ScheduledTask");
    expect(command).not.toContain("curl ");
    expect(command.toLowerCase()).not.toContain("& wsl");
    expect(command.toLowerCase()).not.toContain("wsl.exe");
    expect(command).not.toContain("?token=");
  });

  it("keeps a device label inside one PowerShell string literal", () => {
    const command = buildRunnerCommands({
      host: "bot.example.com",
      dashboardPort: 9820,
      wsPort: 9910,
      token: "rt_safe",
      device: "desk'; Write-Host PWN; #",
    }).windowsInstall;

    expect(command).toContain("$Device = 'desk''; Write-Host PWN; #'");
    expect(command).not.toContain("$Device = 'desk'; Write-Host PWN; #'");
  });
});

const powershell = process.env.OCTOPUS_TEST_POWERSHELL
  ?? (process.platform === "win32" ? "powershell.exe" : "pwsh");
const hasPowerShell = spawnSync(powershell, ["-NoProfile", "-Command", "exit 0"]).status === 0;

describe.skipIf(!hasPowerShell)("Windows Node discovery in PowerShell", () => {
  it("finds a newly installed portable Node in the same process and skips old or broken candidates", () => {
    const script = windowsInstallerScript();
    const discovery = script.slice(script.indexOf("function Refresh-Path"), script.indexOf("function Find-GitBash"));
    const nodeInstall = script.slice(script.indexOf("$NodeExe = Find-Node"), script.indexOf("$GitBash = Find-GitBash"));
    const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const fixture = `
$ErrorActionPreference = 'Stop'
$Root = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Root | Out-Null
try {
  $env:ProgramFiles = Join-Path $Root 'Program Files'
  $env:LOCALAPPDATA = Join-Path $Root 'Local App Data'
  $env:Path = $Root
  $script:CommandCandidates = @()
  function Get-Command { param($Name, $CommandType, [switch]$All)
    foreach ($Path in $script:CommandCandidates) { [pscustomobject]@{Source = $Path} }
  }
  ${discovery}
  if (Find-Node) { throw 'Unexpected Node before installation' }
  $Portable = Join-Path $env:LOCALAPPDATA 'Microsoft/WinGet/Links/node.exe'
  $script:Installs = 0
  function Install-WingetPackage([string]$Id) {
    if ($Id -ne 'OpenJS.NodeJS.22') { throw 'Wrong dependency' }
    $script:Installs++
    New-Item -ItemType Directory -Path (Split-Path $Portable -Parent) -Force | Out-Null
    Copy-Item -LiteralPath ${literal(process.execPath)} -Destination $Portable
  }
  ${nodeInstall}
  if ($script:Installs -ne 1 -or $NodeExe -ne $Portable) { throw 'Portable installation was not discovered' }
  ${nodeInstall}
  if ($script:Installs -ne 1) { throw 'Reinstalled an already supported Node' }
  Remove-Item -LiteralPath $Portable

  $Old = Join-Path $Root 'old.ps1'
  $Broken = Join-Path $Root 'broken.ps1'
  $BadExit = Join-Path $Root 'bad-exit.ps1'
  $Supported = Join-Path $Root 'supported.ps1'
  Set-Content -LiteralPath $Old -Value '$global:LASTEXITCODE = 0; 18'
  Set-Content -LiteralPath $Broken -Value 'throw "unusable executable"'
  Set-Content -LiteralPath $BadExit -Value '$global:LASTEXITCODE = 1; 22'
  Set-Content -LiteralPath $Supported -Value '$global:LASTEXITCODE = 0; 22'
  $script:CommandCandidates = @($Old, $Broken, $BadExit)
  if (Find-Node) { throw 'Accepted an old or broken Node' }
  $script:CommandCandidates += $Supported
  if ((Find-Node) -ne $Supported) { throw 'An earlier invalid Node hid the supported version' }

  $MachinePortable = Join-Path $env:ProgramFiles 'WinGet/Links/node.exe'
  New-Item -ItemType Directory -Path (Split-Path $MachinePortable -Parent) -Force | Out-Null
  Copy-Item -LiteralPath ${literal(process.execPath)} -Destination $MachinePortable
  $script:CommandCandidates = @()
  if ((Find-Node) -ne $MachinePortable) { throw 'Machine-scope portable Node was not discovered' }

  $env:Path = $Root + ';' + $Root
  Refresh-Path
  if (@($env:Path -split ';' | Where-Object { $_ -eq $Root }).Count -ne 1) { throw 'Process PATH was lost or duplicated' }
  foreach ($Scope in @('Machine', 'User')) {
    foreach ($Part in ([Environment]::GetEnvironmentVariable('Path', $Scope) -split ';')) {
      if ($Part -and ($env:Path -split ';') -notcontains [Environment]::ExpandEnvironmentVariables($Part)) { throw 'Persisted PATH was not refreshed' }
    }
  }
  Write-Output 'node-discovery-ok'
} finally {
  Remove-Item -LiteralPath $Root -Recurse -Force
}
`;
    const result = spawnSync(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(fixture, "utf16le").toString("base64"),
    ], { encoding: "utf8", timeout: 30_000 });
    expect(result.stderr, result.stdout).toBe("");
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("node-discovery-ok");
  }, 30_000);
});
