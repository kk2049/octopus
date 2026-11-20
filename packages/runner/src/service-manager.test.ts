import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runnerServiceFiles, RUNNER_SERVICE_LABEL } from "./service-manager.js";

describe("installed Runner service definitions", () => {
  it("uses a per-user macOS LaunchAgent with managed absolute paths", () => {
    const files = runnerServiceFiles("/Users/alice", "darwin", "/opt/homebrew/bin/node");
    expect(files.kind).toBe("launchd");
    expect(files.definitionPath).toBe(`/Users/alice/Library/LaunchAgents/${RUNNER_SERVICE_LABEL}.plist`);
    expect(files.definition).toContain("<key>KeepAlive</key><true/>");
    expect(files.definition).toContain("/Users/alice/.octopus/runner/standalone.js");
    expect(files.definition).toContain("<string>daemon</string>");
    expect(files.definition).toContain("<key>StandardOutPath</key><string>/dev/null</string>");
    expect(files.definition).toContain("<key>StandardErrorPath</key><string>/dev/null</string>");
    expect(files.definition).not.toMatch(/rt_[a-f0-9]{32}/);
  });

  it("uses a systemd user unit without placing detached Agent sessions in the stop set", () => {
    const files = runnerServiceFiles("/home/alice", "linux", "/usr/bin/node");
    expect(files.kind).toBe("systemd");
    expect(files.definitionPath).toBe("/home/alice/.config/systemd/user/octopus-runner.service");
    expect(files.definition).toContain('ExecStart="/usr/bin/node" "/home/alice/.octopus/runner/standalone.js" daemon');
    expect(files.definition).toContain("WorkingDirectory=/home/alice/.octopus/runner\n");
    expect(files.definition).toContain("Restart=on-failure");
    expect(files.definition).toContain("KillMode=process");
    // Linux keeps its journal; only Windows/macOS discard resident output.
    expect(files.definition).not.toContain("StandardOutput");
    expect(files.definition).not.toContain("OCTOPUS_RUNNER_TOKEN");
  });

  it("escapes systemd path specifiers instead of interpreting a username as a unit placeholder", () => {
    const files = runnerServiceFiles("/home/al%ice", "linux", "/opt/node%20/bin/node");
    expect(files.definition).toContain('ExecStart="/opt/node%%20/bin/node" "/home/al%%ice/.octopus/runner/standalone.js" daemon');
    expect(files.definition).toContain("WorkingDirectory=/home/al%%ice/.octopus/runner\n");
  });

  const hasSystemdAnalyzer = process.platform === "linux"
    && spawnSync("systemd-analyze", ["--version"]).status === 0;
  it.skipIf(!hasSystemdAnalyzer).each(["alice", 'al ice%with"quotes'])
    ("loads a Linux unit in the real systemd parser for %s", (username) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-systemd-"));
      try {
        const files = runnerServiceFiles(`/home/${username}`, "linux", process.execPath);
        const unit = path.join(directory, "octopus-runner.service");
        writeFileSync(unit, files.definition);
        // Verify only: never install, reload or start a real Runner service.
        const result = spawnSync("systemd-analyze", ["--user", "--man=no", "verify", unit], {
          encoding: "utf8",
          // CI may have systemd's parser without a logged-in user manager.
          env: { ...process.env, XDG_RUNTIME_DIR: directory },
        });
        expect(result.status, result.stderr || result.error?.message).toBe(0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

  it("uses a limited current-user Windows scheduled task backed by the managed CLI", () => {
    const files = runnerServiceFiles("C:\\Users\\alice", "win32", "C:\\Program Files\\nodejs\\node.exe");
    expect(files.kind).toBe("windows-task");
    expect(files.definitionPath).toBe("C:\\Users\\alice\\.octopus\\runner\\octopus-runner-task.ps1");
    expect(files.definition).toContain("New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser");
    expect(files.definition).toContain("-LogonType Interactive -RunLevel Limited");
    expect(files.definition).toContain("Register-ScheduledTask -TaskName $TaskName");
    expect(files.definition).toContain("C:\\Program Files\\nodejs\\node.exe");
    expect(files.definition).toContain("C:\\Users\\alice\\.octopus\\runner\\standalone.js");
    expect(files.definition).toContain("daemon *> $null");
    expect(files.definition).not.toContain("AppendAllText");
    expect(files.definition).not.toContain("runner.out.log");
    expect(files.definition).not.toContain("runner.err.log");
    expect(files.definition).not.toMatch(/rt_[a-f0-9]{32}/);
    expect(files.definition).not.toContain("Highest");
    expect(files.definition).toContain("-OutputType WindowsApplication");
    expect(files.definition).toContain("start.CreateNoWindow = true");
    expect(files.definition).toContain("OctopusResidentJob.Attach()");
    expect(files.definition).toContain("child.WaitForExit()");
    expect(files.definition).not.toContain("-WindowStyle Hidden");
    expect(files.definition).toContain("-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries");
    expect(files.definition).toContain("while ($true)");
    expect(files.definition).toContain("Start-Sleep -Seconds 3");
    // Only an explicit install changes the task; the daemon has no migration mode.
    expect(files.definition).not.toContain("'reconcile'");
    expect(files.definition).not.toContain("-Action $Action -Settings $Settings");
  });
});
