
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$root=Join-Path $env:TEMP ('octopus-residency-test-'+[guid]::NewGuid().ToString('N'))
$taskName='OctopusRunnerRecoveryTest-'+[guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Path $root | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'logs') | Out-Null
$definition=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__SERVICE_DEFINITION_BASE64__'))
$definition=$definition.Replace("$"+"TaskName = 'OctopusRunner'", "$"+"TaskName = '"+$taskName+"'")
$definition=$definition.Replace('C:\Users\octopus-test-placeholder\.octopus\runner', $root)
$scriptPath=Join-Path $root 'task.ps1'
# Start with the historical action: visible, with no Job owning its Node child.
$legacyAction = @'
  $ActionArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $ScriptPath + '" run'
  $Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $ActionArgs -WorkingDirectory $RunnerRoot
'@
$legacyDefinition=[regex]::Replace($definition,'(?s)  \$HostPath = Join-Path.*?  \$Action = New-ScheduledTaskAction[^\r\n]*',[System.Text.RegularExpressions.MatchEvaluator]{param($match) $legacyAction})
[IO.File]::WriteAllText($scriptPath,$legacyDefinition,[Text.UTF8Encoding]::new($true))
$bundle=Join-Path $root 'standalone.js'
$counter=Join-Path $root 'starts.txt'
$counterJson=ConvertTo-Json $counter -Compress
$restartPath=Join-Path $root 'restart.request'
$restartJson=ConvertTo-Json $restartPath -Compress
$scriptJson=ConvertTo-Json $scriptPath -Compress
$fake='const fs=require("node:fs");fs.appendFileSync('+$counterJson+', "start\n");setInterval(()=>{if(fs.existsSync('+$restartJson+')){fs.unlinkSync('+$restartJson+');require("node:child_process").spawn("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",'+$scriptJson+',"restart"]);}},200);'
[IO.File]::WriteAllText($bundle,$fake,[Text.UTF8Encoding]::new($false))
function Count-Starts { if(Test-Path $counter){return @(Get-Content $counter).Count};return 0 }
function Find-Child { return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -like ('*'+$root+'*')}) }
try {
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath install
  if($LASTEXITCODE -ne 0){throw 'test task install failed'}
  $deadline=(Get-Date).AddSeconds(15)
  while((Count-Starts) -lt 1 -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200}
  if((Count-Starts) -ne 1){throw 'test daemon did not start'}
  $before=Get-ScheduledTask -TaskName $taskName
  $legacyPid=@(Find-Child)[0].ProcessId
  [IO.File]::WriteAllText($scriptPath,$definition,[Text.UTF8Encoding]::new($true))
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath reconcile
  if($LASTEXITCODE -ne 0){throw 'test task reconciliation failed'}
  $task=Get-ScheduledTask -TaskName $taskName
  if([IO.Path]::GetFileName($task.Actions[0].Execute) -notmatch '^octopus-runner-host-[a-f0-9]+\.exe$'){throw 'GUI action missing'}
  if($task.Principal.UserId -ne $before.Principal.UserId -or $task.Principal.RunLevel -ne $before.Principal.RunLevel){throw 'task identity changed'}
  if($task.Settings.DisallowStartIfOnBatteries -or $task.Settings.StopIfGoingOnBatteries){throw 'battery policy stops residency'}
  [IO.File]::WriteAllText($restartPath,'restart')
  $deadline=(Get-Date).AddSeconds(20)
  while((Count-Starts) -lt 2 -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200}
  if((Count-Starts) -ne 2 -or (Get-Process -Id $legacyPid -ErrorAction SilentlyContinue)){throw 'legacy task restart left its old daemon or failed to start the replacement'}
  $nodes=@(Find-Child)
  if($nodes.Count -ne 1){throw ('expected one test daemon; found='+$nodes.Count+'; state='+$task.State+'; starts='+(Count-Starts)+'; stderr='+(Get-Content (Join-Path $root 'logs\stderr.log') -ErrorAction SilentlyContinue))}
  # Check the wrapper and GUI owner too: a delegated Terminal leaves
  # a PseudoConsoleWindow on its console client, even if MainWindowHandle=0.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OctopusTestWindows {
  public delegate bool Callback(IntPtr hwnd, IntPtr state);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint id);
  public static int Count(uint[] processes) {
    int count = 0;
    EnumWindows((hwnd, state) => {
      uint id; GetWindowThreadProcessId(hwnd, out id);
      if (Array.IndexOf(processes, id) >= 0) count++;
      return true;
    }, IntPtr.Zero);
    return count;
  }
}
'@
  $wrapper=Get-CimInstance Win32_Process -Filter ("ProcessId="+$nodes[0].ParentProcessId)
  $hostProcess=Get-CimInstance Win32_Process -Filter ("ProcessId="+$wrapper.ParentProcessId)
  if($hostProcess.ExecutablePath -ne $task.Actions[0].Execute){throw 'GUI host is not the resident owner'}
  $visible=[OctopusTestWindows]::Count([uint32[]]@($nodes[0].ProcessId,$wrapper.ProcessId,$hostProcess.ProcessId))
  if($visible -ne 0){throw 'resident still owns a native window or pseudo-console'}
  $firstPid=$nodes[0].ProcessId
  Stop-Process -Id $firstPid -Force
  $deadline=(Get-Date).AddSeconds(12)
  while((Count-Starts) -lt 3 -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200}
  if((Count-Starts) -ne 3){throw 'daemon was not restarted after child crash'}
  [IO.File]::WriteAllText($restartPath,'restart')
  $deadline=(Get-Date).AddSeconds(20)
  while((Count-Starts) -lt 4 -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200}
  if((Count-Starts) -ne 4){throw 'restart from inside task failed to bring the daemon back'}
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath stop
  Start-Sleep -Seconds 4
  $left=@(Find-Child)
  if($left.Count -ne 0 -or (Count-Starts) -ne 4){throw 'explicit task stop left a daemon or restarted it'}
  [pscustomobject]@{Installed=$true;Migrated=$true;LegacyProcessRemoved=$true;Hidden=($visible -eq 0);CrashRecovered=$true;RemoteRestartRecovered=$true;Starts=(Count-Starts);ExplicitStopRemovedChildren=$true;UserId=$task.Principal.UserId;RunLevel=[string]$task.Principal.RunLevel} | ConvertTo-Json -Compress
} finally {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Find-Child | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
