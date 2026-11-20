import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { RUNNER_SERVICE_LABEL, runnerServiceFiles } from "./service-manager.js";
import { WINDOWS_RESIDENT_HOST_NAME } from "./windows-resident-host.js";

export interface RunnerAutostartStatus {
  enabled: boolean;
  restart: boolean;
  trigger: "boot" | "login";
  detail: string;
}
type Probe = (command: string, args: string[]) => { status: number | null; stdout: string };
const probe: Probe = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 32 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "" };
};

/** Read OS registration, not just whether today's Runner happens to be alive. */
export function runnerAutostartStatus(
  home: string,
  platform: NodeJS.Platform = process.platform,
  query: Probe = probe,
): RunnerAutostartStatus {
  const unknown = { enabled: false, restart: false, trigger: "login" as const, detail: "无法确认系统自启配置；请检查服务注册" };
  if (platform === "linux") {
    const enabled = query("systemctl", ["--user", "is-enabled", "octopus-runner.service"]);
    const linger = query("loginctl", ["show-user", os.userInfo().username, "--property=Linger", "--value"]);
    const restart = query("systemctl", ["--user", "show", "octopus-runner.service", "--property=Restart", "--value"]);
    const boot = linger.status === 0 && linger.stdout.trim() === "yes";
    const policy = restart.stdout.trim();
    return {
      enabled: enabled.status === 0 && enabled.stdout.trim() === "enabled",
      restart: restart.status === 0 && ["always", "on-failure"].includes(policy),
      trigger: boot ? "boot" : "login",
      detail: (boot ? "开机启动（linger=yes）" : linger.status === 0 ? "用户登录后启动（linger=no）；未登录启动需要 loginctl enable-linger " + os.userInfo().username : "无法确认 linger；不能确认未登录开机启动")
        + "；systemd Restart=" + (policy || "unknown"),
    };
  }
  if (platform === "darwin") {
    const uid = process.getuid?.();
    if (uid === undefined) return unknown;
    const disabled = query("launchctl", ["print-disabled", "gui/" + uid]);
    let definition = "";
    try { definition = readFileSync(runnerServiceFiles(home, platform).definitionPath, "utf8"); } catch { return unknown; }
    const load = /<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(definition);
    const keep = /<key>KeepAlive<\/key>\s*<true\s*\/>/.test(definition);
    return {
      enabled: disabled.status === 0 && !disabled.stdout.includes('"' + RUNNER_SERVICE_LABEL + '" => true') && load,
      restart: keep, trigger: "login",
      detail: "当前桌面用户登录后由 LaunchAgent 启动；KeepAlive=" + keep + "；注销后不运行",
    };
  }
  if (platform === "win32") {
    // COM avoids the much slower ScheduledTasks CIM provider on some laptops.
    const script = "$ErrorActionPreference='Stop';$s=New-Object -ComObject Schedule.Service;$s.Connect();"
      + "$t=$s.GetFolder('\\').GetTask('OctopusRunner');$x=[xml]$t.Xml;"
      + "$logon=@($x.Task.Triggers.LogonTrigger|Where-Object {$_ -and $_.Enabled -ne 'false'}).Count -gt 0;"
      + "[pscustomobject]@{enabled=($t.Enabled -and $logon);restart=[int]$x.Task.Settings.RestartOnFailure.Count;"
      + "host=[IO.Path]::GetFileName([string]$x.Task.Actions.Exec.Command)}|ConvertTo-Json -Compress";
    const result = query("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
    try {
      const row = JSON.parse(result.stdout) as Record<string, unknown>;
      if (result.status !== 0) return unknown;
      const windowless = row.host === WINDOWS_RESIDENT_HOST_NAME;
      return { enabled: row.enabled === true, restart: windowless && Number(row.restart) > 0, trigger: "login",
        detail: "当前用户登录后由普通权限计划任务启动；无控制台启动器=" + windowless + "；不需要管理员权限或保存登录密码" };
    } catch { return unknown; }
  }
  return unknown;
}
