import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { runRunnerCli } from "./cli.js";
import { listRegisteredWorkspaces } from "./workspaces.js";
import { MACOS_SERVICE_PATH, readInstalledConfig, runnerInstallPaths, writeInstalledConfig, writeRunnerToken } from "./install-config.js";
import * as services from "./service-manager.js";
import * as autostart from "./service-autostart.js";

const homes: string[] = [];
const originalEnv = { ...process.env };
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArgv = process.argv;

afterEach(() => {
  process.env = { ...originalEnv };
  process.argv = originalArgv;
  Object.defineProperty(process, "platform", originalPlatform);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function macInstallation() {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
  // These fixtures execute bound Agent commands. Public /tmp ancestors are
  // correctly refused by the installation trust checks (and may be noexec).
  const home = mkdtempSync(join(homedir(), ".octopus-runner-cli-test-"));
  homes.push(home);
  process.env.RUNNER_SCAN_HOME = home;
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
  vi.spyOn(autostart, "runnerAutostartStatus").mockReturnValue({ enabled: true, restart: true, trigger: "login", detail: "LaunchAgent" });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return config;
}

describe("macOS CLI environment handoff", () => {
  it("requires an explicit trust flag for a shared installation and never restarts the service", async () => {
    const config = macInstallation();
    const shared = join(config.scan_home, "shared"); mkdirSync(shared); chmodSync(shared, 0o775);
    const file = join(shared, "codex"); writeFileSync(file, "#!/bin/sh\necho 'codex-cli 0.153.4'\n", { mode: 0o755 });
    const restart = vi.spyOn(services, "restartRunnerService");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runRunnerCli(["agents", "bind", "codex", file])).toBe(1);
    expect(await runRunnerCli(["agents", "bind", "codex", file, "--trust-installation"])).toBe(0);
    expect(await runRunnerCli(["agents", "exec", "codex", "--version"])).toBe(0);
    expect(JSON.parse(readFileSync(join(config.scan_home, ".octopus/runner/agent-bindings.json"), "utf8")).entries.codex.trust.paths)
      .toEqual([expect.objectContaining({ path: shared, writable: 0o020 })]);
    expect(restart).not.toHaveBeenCalled();
  });
  it("binds and executes a custom Agent through the installed CLI without restarting the service", async () => {
    const config = macInstallation();
    const file = join(config.scan_home, "custom-codex");
    writeFileSync(file, "#!/bin/sh\nexit 17\n", { mode: 0o700 });
    const restart = vi.spyOn(services, "restartRunnerService");
    expect(await runRunnerCli(["agents", "bind", "codex", file])).toBe(0);
    expect(await runRunnerCli(["agents", "exec", "codex", "--version"])).toBe(17);
    expect(restart).not.toHaveBeenCalled();
    expect(readFileSync(join(config.scan_home, ".octopus/runner/agent-bindings.json"), "utf8")).toContain(file);
    expect(await runRunnerCli(["agents", "unbind", "codex"])).toBe(0);
  });
  it("returns the daemon environment without running service migration on its startup path", async () => {
    macInstallation();
    const migrate = vi.spyOn(services, "reconcileRunnerService").mockImplementation(() => new Promise(() => {}));
    expect(await runRunnerCli(["daemon"])).toBeNull();
    expect(migrate).not.toHaveBeenCalled();
  });

  it.each(["start", "restart"] as const)("migrates an old installation before %s reaches launchctl", async (command) => {
    const config = macInstallation();
    process.env.PATH = "/opt/homebrew/bin:/Users/alice/.nvm/versions/node/v22/bin:/usr/bin";
    const service = vi.spyOn(services, command === "start" ? "startRunnerService" : "restartRunnerService")
      .mockImplementation(() => {
        expect(readInstalledConfig(config.scan_home).agent_path?.slice(0, 2))
          .toEqual(["/opt/homebrew/bin", "/Users/alice/.nvm/versions/node/v22/bin"]);
      });
    expect(await runRunnerCli([command])).toBe(0);
    expect(service).toHaveBeenCalledOnce();

    const saved = readFileSync(runnerInstallPaths(config.scan_home).config, "utf8");
    process.env.PATH = MACOS_SERVICE_PATH;
    expect(await runRunnerCli(["daemon"])).toBeNull();
    expect(process.env.PATH?.split(":")[0]).toBe("/opt/homebrew/bin");
    expect(readFileSync(runnerInstallPaths(config.scan_home).config, "utf8")).toBe(saved);
  });

  it("saves the working foreground environment for the next background start", async () => {
    const config = macInstallation();
    process.env.PATH = "/custom/toolchain/bin:/usr/bin";
    expect(await runRunnerCli(["run", "--foreground"])).toBeNull();
    expect(readInstalledConfig(config.scan_home).agent_path?.[0]).toBe("/custom/toolchain/bin");
    process.env.PATH = MACOS_SERVICE_PATH;
    expect(await runRunnerCli(["daemon"])).toBeNull();
    expect(process.env.PATH?.split(":")[0]).toBe("/custom/toolchain/bin");
  });

  it("captures the installer environment before registering the background service", async () => {
    const config = macInstallation();
    const source = join(config.scan_home, "download.js");
    writeFileSync(source, "// runner bundle fixture\n");
    process.argv = [process.execPath, source];
    process.env.PATH = "/custom/npm/bin:/usr/bin";
    const install = vi.spyOn(services, "installRunnerService").mockImplementation(() => {
      expect(readInstalledConfig(config.scan_home).agent_path?.[0]).toBe("/custom/npm/bin");
      return services.runnerServiceFiles(config.scan_home);
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, token: `rt_${"a".repeat(32)}`, device: config.device,
        runner_url: config.runner_url, dashboard_url: config.dashboard_url }))
      .mockResolvedValueOnce(Response.json({ online: true })));
    expect(await runRunnerCli(["install", "--server", config.dashboard_url, "--enroll", "re_fixture"])).toBe(0);
    expect(install).toHaveBeenCalledOnce();
  });

  it("diagnoses the configured daemon PATH instead of a working terminal-only Codex", async () => {
    const config = macInstallation();
    const terminalBin = join(config.scan_home, "terminal-bin");
    const configuredBin = join(config.scan_home, "configured-bin");
    for (const bin of [terminalBin, configuredBin]) mkdirSync(bin, { mode: 0o700 });
    writeFileSync(join(terminalBin, "codex"), '#!/bin/sh\necho "codex-cli 9.9.9"\n', { mode: 0o700 });
    writeFileSync(join(configuredBin, "codex"), '#!/bin/sh\necho "codex-cli 0.153.2"\n', { mode: 0o700 });
    writeInstalledConfig({ ...config, agent_path: [configuredBin] });
    const paths = runnerInstallPaths(config.scan_home);
    writeRunnerToken(config.scan_home, `rt_${"b".repeat(32)}`);
    for (const file of [paths.bundle, paths.wrapper, services.runnerServiceFiles(config.scan_home).definitionPath]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "fixture");
    }
    process.env.PATH = `${terminalBin}:${MACOS_SERVICE_PATH}`;
    vi.spyOn(services, "runnerServiceStatus").mockReturnValue({ active: true, output: "running" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ online: true })));
    expect(await runRunnerCli(["doctor"])).toBe(0);
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("后台配置环境");
    expect(output).toContain("agent codex: codex-cli 0.153.2");
    expect(output).not.toContain("9.9.9");
    expect(output).toContain("agent omp: command_unavailable");
    expect(output).toContain("agents bind");
    expect(readInstalledConfig(config.scan_home).agent_path).toEqual([configuredBin]);
  });
});

describe("installed Runner CLI", () => {
  it.each([true, false])("accepts manual update only after the running digest matches (matches=%s)", async (matches) => {
    vi.useFakeTimers();
    const config = macInstallation();
    const paths = runnerInstallPaths(config.scan_home);
    writeRunnerToken(config.scan_home, `rt_${"c".repeat(32)}`);
    const old = "console.log('previous')";
    writeFileSync(paths.bundle, old);
    const next = "console.log('updated')";
    const sha = createHash("sha256").update(next).digest("hex");
    const restart = vi.spyOn(services, "restartRunnerService").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let statusReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/download/runner.js")) return new Response(next, { headers: { "x-octopus-runner-bundle-sha": sha } });
      statusReads += 1;
      // An online old process is not success, even when service restart returned.
      return Response.json({ online: true, bundle_sha: matches && statusReads > 1 ? sha : "0".repeat(64) });
    }));
    const update = runRunnerCli(["update"]);
    await vi.runAllTimersAsync();
    expect(await update).toBe(matches ? 0 : 1);
    expect(statusReads).toBeGreaterThan(1);
    expect(restart).toHaveBeenCalledTimes(matches ? 1 : 2);
    expect(readFileSync(paths.bundle, "utf8")).toBe(matches ? next : old);
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output.includes("已更新并确认运行")).toBe(matches);
  });

  it("distinguishes installed files from the connected process in status", async () => {
    const config = macInstallation();
    writeRunnerToken(config.scan_home, `rt_${"d".repeat(32)}`);
    vi.spyOn(services, "runnerServiceStatus").mockReturnValue({ active: true, output: "running" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ online: true,
      bundle_sha: "1".repeat(64), bundle_target_sha: "2".repeat(64), bundle_update_status: "retry_pending" })));
    expect(await runRunnerCli(["status", "--json"])).toBe(0);
    const value = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
    expect(value).toMatchObject({ gateway: "online", running_sha: "1".repeat(64),
      target_sha: "2".repeat(64), update_status: "retry_pending" });
  });

  it("exposes the service and workspace lifecycle in help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runRunnerCli(["help"])).toBe(0);
    const help = String(log.mock.calls[0]?.[0]);
    expect(help).toContain("start|stop|restart");
    expect(help).toContain("workspace add");
    expect(help).toContain("uninstall");
  });

  it("refuses a typo instead of accidentally starting a resident Runner", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runRunnerCli(["resetart"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("未知命令");
  });

  it("accepts both the installed --label spelling and the legacy positional label", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-cli-"));
    homes.push(home);
    process.env.RUNNER_SCAN_HOME = home;
    const project = join(home, "project");
    mkdirSync(project);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runRunnerCli(["workspace", "add", project, "Legacy Project"])).toBe(0);
    expect(await listRegisteredWorkspaces(home)).toMatchObject([{ label: "Legacy Project", path: project, available: true }]);
  });
});

describe("guest host", () => {
  it("points guest sessions at the owner's Claude login and drops the old Codex egress", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-guest-host-"));
    homes.push(home);
    process.env.RUNNER_SCAN_HOME = home;
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir);
    writeFileSync(join(claudeDir, ".credentials.json"), "{}");
    writeInstalledConfig({
      version: 1, dashboard_url: "https://bot.example.com", runner_url: "wss://bot.example.com/runner", device: "host",
      scan_home: home, codex_home: join(home, ".codex"), installed_at: "2026-11-13T00:00:00.000Z",
      model_egress: { anthropic: { config_dir: claudeDir }, openai: { codex_home: join(home, ".codex") } },
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(join(tmpdir(), "runner-guest-root-"));
    homes.push(root);
    expect(await runRunnerCli(["guest", "host", "--claude-dir", claudeDir, "--sessions-root", root,
      "--sessions-launch-prefix", " memguard --rss-gib 8  -- "])).toBe(0);
    const config = readInstalledConfig(home);
    expect(config.model_egress).toEqual({ anthropic: { config_dir: claudeDir } });
    expect(config.guest_sessions).toMatchObject({ root, port: 47830, launch_prefix: ["memguard", "--rss-gib", "8", "--"] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The guard keeps guests out of /home, so their directories cannot live there.
    expect(await runRunnerCli(["guest", "host", "--sessions-root", join(home, "guests")])).toBe(1);
    // Codex: never the Runner's own Codex home, only one logged in to for guests.
    expect(await runRunnerCli(["guest", "host", "--codex-home", join(home, ".codex")])).toBe(1);
    const guestCodex = join(root, "codex-home");
    mkdirSync(guestCodex);
    expect(await runRunnerCli(["guest", "host", "--codex-home", guestCodex])).toBe(1);
    writeFileSync(join(guestCodex, "auth.json"), "{}");
    expect(await runRunnerCli(["guest", "host", "--codex-home", guestCodex])).toBe(0);
    expect(readInstalledConfig(home).model_egress).toEqual({ anthropic: { config_dir: claudeDir }, openai: { codex_home: guestCodex } });
    expect(await runRunnerCli(["guest", "host", "--codex-home", ""])).toBe(0);
    expect(readInstalledConfig(home).model_egress).toEqual({ anthropic: { config_dir: claudeDir } });
    expect(readInstalledConfig(home).guest_sessions?.root).toBe(root);
  });
});
