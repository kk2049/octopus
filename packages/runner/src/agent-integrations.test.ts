import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentIntegrationStatus,
  codexIntegrationHomes,
  installAgentIntegrations,
  installLocalAgentIntegrations,
  prepareLocalAgentIntegrations,
  refreshLocalMcpLauncher,
  uninstallAgentIntegrations,
} from "./agent-integrations.js";
import { fakeExecutables, type FakeExecutables } from "../../../tools/test-support/fake-executables.mjs";

const roots: string[] = [];
const fakes: FakeExecutables[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0).reverse()) fake.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Fake clients are the only ones reachable, and HOME is the fixture home. */
function exposeFakeClients(home: string): void {
  const fake = fakeExecutables(Object.fromEntries(["codex", "claude", "omp"].map((client) => [client, "#!/bin/sh\nexit 0\n"])), { home });
  fakes.push(fake);
  fake.apply();
}

function textIfExists(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

describe("agent integration bundle", () => {
  it("installs hooks and an opt-in shared Codex TUI launcher idempotently", async () => {
    const home = mkdtempSync(join(tmpdir(), "octopus-integrations-"));
    roots.push(home);
    exposeFakeClients(home);
    const additionalCodexHome = join(home, ".codex-secondary");
    const first = await installAgentIntegrations(home, "/opt/octopus/runner.js", join(home, ".codex"), {
      additionalCodexHomes: [additionalCodexHome],
    });
    expect(first.hooks.every((row) => row.installed > 0)).toBe(true);
    expect(first.hooks.filter((row) => row.provider === "codex")).toHaveLength(2);
    expect(first.codexLauncher).toMatchObject({ installed: true, changed: true });
    expect(first.localMcp).toMatchObject({ installed: true, changed: true });
    expect(readFileSync(first.localMcp.launcher, "utf8")).toContain("node '/opt/octopus/runner.js' mcp stdio");
    expect(readFileSync(first.localMcp.launcher, "utf8")).toContain("mcp discover");
    const content = readFileSync(first.codexLauncher.file, "utf8");
    expect(content).toContain("codex --remote");
    expect(content).toContain("kill -0 \"$server_pid\"");
    expect(content).toContain("ws://127.0.0.1:*");
    expect(content).toContain("'/opt/octopus/runner.js' agents exec codex \"$@\"");

    const second = await installAgentIntegrations(home, "/opt/octopus/runner.js", join(home, ".codex"), {
      additionalCodexHomes: [additionalCodexHome],
    });
    expect(second.codexLauncher.changed).toBe(false);
    expect(second.localMcp.changed).toBe(false);
    expect((await agentIntegrationStatus(home, join(home, ".codex"), {
      additionalCodexHomes: [additionalCodexHome],
    })).codexLauncher.installed).toBe(true);
    expect((await uninstallAgentIntegrations(home, join(home, ".codex"), {
      additionalCodexHomes: [additionalCodexHome],
    })).codexLauncher.changed).toBe(true);
    const stopped = await agentIntegrationStatus(home, join(home, ".codex"), {
      additionalCodexHomes: [additionalCodexHome],
    });
    expect(stopped.hooks.every((row) => row.installed === 0)).toBe(true);
    expect(stopped.localMcp).toMatchObject({ installed: false, clients: [] });
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(additionalCodexHome, "hooks.json"))).toBe(false);
    expect(existsSync(first.codexLauncher.file)).toBe(false);
    expect(existsSync(first.localMcp.launcher)).toBe(false);
  });

  it("keeps integrations across restarts and backs up a user file only when install changes it", async () => {
    const home = mkdtempSync(join(tmpdir(), "octopus-integrations-"));
    roots.push(home);
    exposeFakeClients(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
    const backups = () => readdirSync(join(home, ".claude")).filter((name) => name.includes("octopus-backup"));
    const install = () => installAgentIntegrations(home, "/opt/octopus/runner.js", join(home, ".codex"), { localMcp: false });
    await install();
    expect(backups()).toHaveLength(1);
    // Every Runner start repeats the same install; an unchanged file is neither rewritten nor backed up.
    for (let restart = 0; restart < 3; restart++) {
      const again = await install();
      expect(again.hooks.some((row) => row.changed)).toBe(false);
      expect(again.codexLauncher.changed).toBe(false);
    }
    expect(backups()).toHaveLength(1);
  });

  it("hook mode off removes hooks and the launcher but leaves policy-managed MCP injection", async () => {
    const home = mkdtempSync(join(tmpdir(), "octopus-integrations-"));
    roots.push(home);
    exposeFakeClients(home);
    const primary = join(home, ".codex");
    const installed = await installAgentIntegrations(home, "/opt/octopus/runner.js", primary);
    const off = await uninstallAgentIntegrations(home, primary, { localMcp: false });
    expect(off.hooks.every((row) => row.installed === 0)).toBe(true);
    expect(existsSync(installed.codexLauncher.file)).toBe(false);
    expect(off.localMcp.clients).toEqual(["codex", "claude", "omp"]);
    expect(readFileSync(join(primary, "config.toml"), "utf8")).toContain("[mcp_servers.octopus]");
    expect(existsSync(installed.localMcp.launcher)).toBe(true);
  });

  it("managed startup refreshes only the launcher and leaves existing injection for the policy", async () => {
    const home = mkdtempSync(join(tmpdir(), "octopus-integrations-"));
    roots.push(home);
    exposeFakeClients(home);
    const primary = join(home, ".codex");
    await installLocalAgentIntegrations(home, "/opt/octopus/runner.js", primary);
    const claudeConfig = readFileSync(join(home, ".claude.json"), "utf8");
    const codexConfig = readFileSync(join(primary, "config.toml"), "utf8");
    const refreshed = await refreshLocalMcpLauncher(home, "/opt/octopus/runner.js", primary);
    expect(refreshed).toMatchObject({ installed: true, changed: false, clients: ["codex", "claude", "omp"] });
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(claudeConfig);
    expect(readFileSync(join(primary, "config.toml"), "utf8")).toBe(codexConfig);
  });

  it("names every Codex home that receives hooks for install and explicit uninstall", () => {
    expect(codexIntegrationHomes("/home/u", "/home/u/.codex-accounts/account-b",
      ["/home/u/.codex-accounts/account-b", "/home/u/.codex-accounts/account-c/"]))
      .toEqual(["/home/u/.codex-accounts/account-b", "/home/u/.codex-accounts/account-c", "/home/u/.codex"]);
  });

  it("never overwrites a user-owned launcher", async () => {
    const home = mkdtempSync(join(tmpdir(), "octopus-integrations-"));
    roots.push(home);
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "octopus-codex"), "#!/bin/sh\necho mine\n");
    await expect(installAgentIntegrations(home, "/opt/runner.js")).rejects.toThrow(/non-Octopus launcher/);
  });

  it("never overwrites a user-owned local MCP launcher", async () => {
    const home = mkdtempSync(join(tmpdir(), "octopus-integrations-"));
    roots.push(home);
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "octopus-runner-mcp"), "#!/bin/sh\necho mine\n");
    await expect(installAgentIntegrations(home, "/opt/runner.js")).rejects.toThrow(/non-Octopus local MCP launcher/);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "octopus-codex"))).toBe(false);
  });

  it("keeps a discoverable launcher while removing global MCP and prompt injection from every Codex home", async () => {
    const home = mkdtempSync(join(tmpdir(), "octopus-integrations-"));
    roots.push(home);
    exposeFakeClients(home);
    const primary = join(home, ".codex");
    const secondary = join(home, ".codex-work");
    const workspace = join(home, "project");
    mkdirSync(workspace, { recursive: true });
    const workspaceAgentDoc = join(workspace, "AGENTS.md");
    writeFileSync(workspaceAgentDoc, "# Project\n\nUse the workspace-scoped octopus MCP when requested.\n");

    const installed = await installLocalAgentIntegrations(
      home,
      "/opt/octopus/runner.js",
      primary,
      [secondary],
    );
    expect(installed.clients).toEqual(["codex", "claude", "omp"]);
    expect(readFileSync(join(primary, "config.toml"), "utf8")).toContain("[mcp_servers.octopus]");
    const routingPrompt = readFileSync(join(secondary, "AGENTS.md"), "utf8");
    expect(routingPrompt).toContain("octopus-runner-mcp:start");
    expect(routingPrompt).toContain("never override the user's explicit transport choice");
    expect(routingPrompt).toContain("If the user asks for SSH");
    expect(routingPrompt).toContain("offer Octopus only as an alternative");
    expect(routingPrompt).toContain("GUI discovery is not consent");
    expect(routingPrompt).toContain("octopus_request_gui_control");
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.octopus).toBeDefined();

    const prepared = await prepareLocalAgentIntegrations(
      home,
      "/opt/octopus/runner.js",
      primary,
      [secondary],
    );
    expect(prepared).toMatchObject({ installed: true, clients: [] });
    expect(readFileSync(prepared.launcher, "utf8")).toContain("octopus-runner-mcp:v1");
    expect(textIfExists(join(primary, "config.toml"))).not.toContain("mcp_servers.octopus");
    expect(textIfExists(join(secondary, "config.toml"))).not.toContain("mcp_servers.octopus");
    expect(textIfExists(join(primary, "AGENTS.md"))).not.toContain("octopus-runner-mcp:start");
    expect(textIfExists(join(secondary, "AGENTS.md"))).not.toContain("octopus-runner-mcp:start");
    expect(textIfExists(join(home, ".claude.json"))).not.toContain('"octopus"');
    expect(readFileSync(workspaceAgentDoc, "utf8")).toContain("workspace-scoped octopus MCP");

    await uninstallAgentIntegrations(home, primary, { additionalCodexHomes: [secondary] });
    expect(existsSync(prepared.launcher)).toBe(false);
  });

  it("writes through an account home's AGENTS.md link to the shared master instead of forking it", async () => {
    const home = mkdtempSync(join(tmpdir(), "octopus-integrations-"));
    roots.push(home);
    exposeFakeClients(home);
    const primary = join(home, ".codex");
    const account = join(home, ".codex-accounts", "account-a");
    mkdirSync(primary, { recursive: true });
    mkdirSync(account, { recursive: true });
    const master = join(primary, "AGENTS.md");
    writeFileSync(master, "# Shared rules\n");
    symlinkSync(master, join(account, "AGENTS.md"));

    // The Runner orders account homes first, so the link is written before the master.
    const [first, ...rest] = codexIntegrationHomes(home, primary, [account]);
    expect(first).toBe(account);
    await installLocalAgentIntegrations(home, "/opt/octopus/runner.js", first, rest);
    expect(lstatSync(join(account, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(account, "AGENTS.md"))).toBe(master);
    const installed = readFileSync(master, "utf8");
    expect(installed).toContain("# Shared rules");
    expect(installed.match(/octopus-runner-mcp:start/g)).toHaveLength(1);

    await prepareLocalAgentIntegrations(home, "/opt/octopus/runner.js", first, rest);
    expect(lstatSync(join(account, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(master, "utf8")).toBe("# Shared rules\n");
  });
});
