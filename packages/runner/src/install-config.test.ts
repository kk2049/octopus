import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PATH_MARKER_START,
  MACOS_SERVICE_PATH,
  applyInstalledEnvironment,
  captureInstalledAgentPath,
  installedAgentPath,
  installCliWrapper,
  readInstalledConfig,
  removeCliWrapper,
  runnerCliWrapper,
  runnerInstallPaths,
  writeInstalledConfig,
  writeRunnerToken,
} from "./install-config.js";
import { discoverRunnerInventory, runnerAgentPath } from "./inventory.js";

const dirs: string[] = [];
const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function installedMac() {
  const home = mkdtempSync(join(tmpdir(), "runner-mac-path-"));
  dirs.push(home);
  const config = {
    version: 1 as const,
    dashboard_url: "https://bot.example.com",
    runner_url: "wss://bot.example.com/runner",
    device: "mac",
    scan_home: home,
    codex_home: join(home, ".codex"),
    installed_at: "2026-09-05T00:00:00.000Z",
  };
  writeInstalledConfig(config);
  return config;
}

describe("macOS installed Agent PATH", () => {
  it("uses explicitly configured Windows executable directories before Store aliases without altering Unix PATH", () => {
    const config = { ...installedMac(), execution_path: ["D:\\Application\\Python313"] };
    writeInstalledConfig(config);
    process.env.PATH = "C:\\Windows\\System32;C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps";
    const original = process.env.PATH;
    applyInstalledEnvironment(config.scan_home, "linux");
    expect(process.env.PATH).toBe(original);
    applyInstalledEnvironment(config.scan_home, "win32");
    expect(process.env.PATH).toBe(`D:\\Application\\Python313;${original}`);
    applyInstalledEnvironment(config.scan_home, "win32");
    expect(process.env.PATH).toBe(`D:\\Application\\Python313;${original}`);
  });
  it("restores terminal CLIs and their Node interpreter under a minimal daemon environment", async () => {
    const config = installedMac();
    const bin = join(config.scan_home, ".nvm", "versions", "node", "v22.0.0", "bin with spaces");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(join(bin, "codex"), '#!/usr/bin/env node\nconsole.log("codex-cli 0.153.2");\n', { mode: 0o700 });
    writeFileSync(join(bin, "claude"), '#!/bin/sh\necho "2.1.236 (Claude Code)"\n', { mode: 0o700 });
    const before = await discoverRunnerInventory(config.scan_home, { env: { PATH: MACOS_SERVICE_PATH } });
    expect(before.agent_backends.find((backend) => backend.kind === "codex")?.reason).toBe("command_unavailable");

    process.env.PATH = `${bin}:${MACOS_SERVICE_PATH}`;
    process.env.RUNNER_TEST_PRIVATE_VALUE = "do-not-save-other-environment";
    captureInstalledAgentPath(config.scan_home, "darwin");
    const saved = readFileSync(runnerInstallPaths(config.scan_home).config, "utf8");
    expect(saved).not.toContain(process.env.RUNNER_TEST_PRIVATE_VALUE);
    expect(readInstalledConfig(config.scan_home).agent_path?.[0]).toBe(bin);

    process.env = { PATH: MACOS_SERVICE_PATH };
    applyInstalledEnvironment(config.scan_home, "darwin");
    process.env.PATH = runnerAgentPath(config.scan_home, process.env.PATH);
    const after = await discoverRunnerInventory(config.scan_home);
    expect(after.agent_backends.find((backend) => backend.kind === "codex"))
      .toMatchObject({ available: true, split_execution: true, version: "codex-cli 0.153.2" });
    expect(after.agent_backends.find((backend) => backend.kind === "claude"))
      .toMatchObject({ available: true, version: "2.1.236 (Claude Code)" });
    expect(execFileSync("codex", ["app-server"], { encoding: "utf8" })).toBe("codex-cli 0.153.2\n");

    // A supervised restart rereads the snapshot without replacing it with launchd's PATH.
    process.env.PATH = MACOS_SERVICE_PATH;
    applyInstalledEnvironment(config.scan_home, "darwin");
    expect(readFileSync(runnerInstallPaths(config.scan_home).config, "utf8")).toBe(saved);
    expect(process.env.PATH?.split(":")[0]).toBe(bin);
  });

  it("preserves explicit absolute paths and ordering without importing relative cwd entries", () => {
    const config = installedMac();
    process.env.PATH = "/opt/homebrew/bin::.:relative/bin:/Users/alice/custom bin:/opt/homebrew/bin:/bad\npath";
    captureInstalledAgentPath(config.scan_home, "darwin");
    const saved = readInstalledConfig(config.scan_home);
    expect(saved.agent_path?.slice(0, 2)).toEqual(["/opt/homebrew/bin", "/Users/alice/custom bin"]);
    for (const invalid of ["", ".", "relative/bin", "/bad\npath"]) expect(saved.agent_path).not.toContain(invalid);
    expect(saved.agent_path?.filter((entry) => entry === "/opt/homebrew/bin")).toHaveLength(1);
    expect(installedAgentPath(saved, MACOS_SERVICE_PATH, "/opt/node/bin/node").split(":"))
      .toContain("/opt/node/bin");

    process.env.PATH = "/Users/alice/new-cli/bin:/usr/bin";
    captureInstalledAgentPath(config.scan_home, "darwin");
    expect(readInstalledConfig(config.scan_home).agent_path?.slice(0, 2)).toEqual(["/Users/alice/new-cli/bin", "/usr/bin"]);
    expect(readInstalledConfig(config.scan_home).agent_path).toContain("/opt/homebrew/bin");
  });

  it.each(["linux", "win32"] as const)("leaves %s installation and PATH unchanged", (platform) => {
    const config = installedMac();
    process.env.PATH = "/terminal-only/bin";
    captureInstalledAgentPath(config.scan_home, platform);
    expect(readInstalledConfig(config.scan_home)).toEqual(config);
    applyInstalledEnvironment(config.scan_home, platform);
    expect(process.env.PATH).toBe("/terminal-only/bin");
  });

  it.each(["/bin", ["relative/bin"], ["/bin", "/bin"], ["/bin:/tmp"], [1]].map((value) => [value]))("rejects invalid persisted directories: %j", (agentPath) => {
    const config = installedMac();
    writeFileSync(runnerInstallPaths(config.scan_home).config, JSON.stringify({ ...config, agent_path: agentPath }));
    expect(() => readInstalledConfig(config.scan_home)).toThrow("agent_path");
  });
});

describe("installed Runner config", () => {
  it("keeps the durable token out of config/service arguments and mode-0600", () => {
    const home = mkdtempSync(join(tmpdir(), "runner-install-"));
    dirs.push(home);
    const config = {
      version: 1 as const,
      dashboard_url: "https://bot.example.com",
      runner_url: "wss://bot.example.com/runner",
      device: "mac",
      scan_home: home,
      codex_home: join(home, ".codex"),
      installed_at: "2026-08-28T00:00:00.000Z",
    };
    const paths = writeInstalledConfig(config);
    writeRunnerToken(home, `rt_${"a".repeat(32)}`);
    expect(readInstalledConfig(home)).toEqual(config);
    expect(readFileSync(paths.config, "utf8")).not.toContain("rt_");
    expect(statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(statSync(paths.token).mode & 0o777).toBe(0o600);
  });

  it("installs an idempotent PATH-owned wrapper and removes only its marker", () => {
    const home = mkdtempSync(join(tmpdir(), "runner-install-"));
    dirs.push(home);
    const profile = join(home, ".profile");
    writeFileSync(profile, "export KEEP=1\n", "utf8");
    const wrapper = installCliWrapper(home, "/usr/bin/node");
    expect(wrapper).toBe(runnerInstallPaths(home).wrapper);
    expect(readFileSync(wrapper, "utf8")).toContain("standalone.js");
    expect(readFileSync(profile, "utf8")).toContain(PATH_MARKER_START);
    installCliWrapper(home, "/usr/bin/node");
    expect(readFileSync(profile, "utf8").match(new RegExp(PATH_MARKER_START, "g"))).toHaveLength(1);
    removeCliWrapper(home);
    expect(readFileSync(profile, "utf8")).toBe("export KEEP=1\n");
  });

  it("uses native Windows locations and a cmd shim without embedding credentials", () => {
    const paths = runnerInstallPaths("C:\\Users\\alice", "win32");
    expect(paths.root).toBe("C:\\Users\\alice\\.octopus\\runner");
    expect(paths.wrapper).toBe("C:\\Users\\alice\\.local\\bin\\octopus-runner.cmd");
    const wrapper = runnerCliWrapper("C:\\Users\\alice", "C:\\Program Files\\nodejs\\node.exe", "win32");
    expect(wrapper).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(wrapper).toContain('"C:\\Users\\alice\\.octopus\\runner\\standalone.js" %*');
    expect(wrapper).not.toContain("rt_");
  });

  it("round-trips the Windows execution-only boundary in installed config", () => {
    const home = mkdtempSync(join(tmpdir(), "runner-install-"));
    dirs.push(home);
    const config = {
      version: 1 as const,
      dashboard_url: "https://bot.example.com",
      runner_url: "wss://bot.example.com/runner",
      device: "win",
      scan_home: home,
      codex_home: join(home, ".codex"),
      execution_only: true,
      execution_shell: join(home, "git-bash"),
      installed_at: "2026-08-29T00:00:00.000Z",
    };
    writeInstalledConfig(config);
    expect(readInstalledConfig(home)).toEqual(config);
  });
});
