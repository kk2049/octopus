import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentExecutableError } from "./agent-executable-errors.js";
import { SESSION_OPERATION_PROTOCOL } from "./gateway-protocol.js";
import {
  codexSplitExecutionAvailable,
  discoverRunnerInventory,
  publicCodexEmailLabel,
  runnerAgentPath,
  RunnerInventoryRefresh,
  type RunnerInventoryProbe,
} from "./inventory.js";

it("accepts unmasked local parts up to five characters and rejects longer raw public ids", () => {
  expect(publicCodexEmailLabel("alice@example.com")).toBe("alice@example.com");
  expect(publicCodexEmailLabel("abcdef@example.com")).toBeUndefined();
  expect(publicCodexEmailLabel("abcdef…@example.com")).toBe("abcdef…@example.com");
});

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("discoverRunnerInventory", () => {
  it("makes safe scan-home CLI bins visible to discovery and later provider spawns", () => {
    const home = mkdtempSync(join(tmpdir(), "runner-agent-path-"));
    homes.push(home);
    const localBin = join(home, ".local", "bin");
    const unsafeBin = join(home, "bin");
    mkdirSync(localBin, { recursive: true });
    mkdirSync(unsafeBin);
    chmodSync(localBin, 0o700);
    chmodSync(unsafeBin, 0o777);

    expect(runnerAgentPath(home, "/usr/bin:/bin"))
      .toBe(`/usr/bin:/bin:${localBin}`);
  });

  it("reports bounded backend and execution facts without paths", async () => {
    const probe: RunnerInventoryProbe = {
      async command(bin) {
        if (bin === "claude") return { stdout: "2.1.3\nextra" };
        if (bin === "codex") throw Object.assign(new Error("missing"), { code: "ENOENT" });
        throw new Error("broken probe");
      },
      async workspaceCount() {
        return 12_000;
      },
    };
    const inventory = await discoverRunnerInventory("/secret/home", {
      allowMachineOps: false,
      probe,
      dsh: async () => ({ available: true, port: 9931 }),
      localMcp: { available: true, clients: ["codex", "omp"] },
    });
    expect(inventory.agent_backends).toEqual([
      { kind: "claude", available: true, split_execution: true, version: "2.1.3" },
      {
        kind: "codex",
        available: false,
        split_execution: false,
        split_execution_reason: "local_tools_unfilterable",
        reason: "command_unavailable",
      },
      { kind: "omp", available: false, split_execution: true, reason: "probe_failed" },
    ]);
    expect(inventory.session_roster).toBe(true);
    expect(inventory.execution).toMatchObject({ shell: false, workspace_files: false, workspace_count: 10_000 });
    expect(inventory.dsh).toEqual({ available: true, port: 9931 });
    expect(inventory.local_mcp).toEqual({
      available: true,
      protocol: "runner-local-mcp/v1",
      clients: ["codex", "omp"],
    });
    expect(JSON.stringify(inventory)).not.toContain("/secret/home");
  });

  it("declares durable session operations separately from installed backends and execution-only workspaces", async () => {
    const probe: RunnerInventoryProbe = {
      async command() { return { stdout: "codex 0.154.0" }; },
      async workspaceCount() { return 1; },
    };
    const enabled = await discoverRunnerInventory("/work", { probe });
    expect(enabled.session_operations).toEqual({ protocol: SESSION_OPERATION_PROTOCOL });
    expect(enabled.file_transfer).toEqual({ protocol: "workspace-file-transfer/v1" });
    expect(enabled.agent_backends.every((backend) => backend.available)).toBe(true);
    expect(enabled).not.toHaveProperty("read_only");
    const readonly = await discoverRunnerInventory("/work", { probe, allowMachineOps: false });
    expect(readonly.read_only).toBe(true);
    expect(readonly).not.toHaveProperty("session_operations");
    expect(readonly).not.toHaveProperty("file_transfer");
    expect(readonly.agent_backends.every((backend) => backend.available)).toBe(true);
    const executionOnly = await discoverRunnerInventory("/work", { probe, executionOnly: true });
    expect(executionOnly).not.toHaveProperty("session_operations");
    expect(executionOnly).not.toHaveProperty("read_only");
    expect(executionOnly.execution.shell).toBe(true);
    expect(executionOnly.file_transfer).toEqual({ protocol: "workspace-file-transfer/v1" });
    const noInstalledAgent = await discoverRunnerInventory("/work", { probe: {
      ...probe, command: async () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
    } });
    expect(noInstalledAgent.session_operations).toEqual({ protocol: SESSION_OPERATION_PROTOCOL });
    expect(noInstalledAgent.agent_backends.every((backend) => !backend.available)).toBe(true);
  });

  it("advertises the private job protocol only when the durable manager started", async () => {
    const probe: RunnerInventoryProbe = {
      async command() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      async workspaceCount() { return 0; },
    };
    const oldCompatible = await discoverRunnerInventory("/work", { probe, knowledgeIndexJobs: false });
    expect(oldCompatible).not.toHaveProperty("knowledge_index_jobs");
    expect(oldCompatible.session_roster).toBe(true); // Existing logs remain readable without CLI binaries.
    const enabled = await discoverRunnerInventory("/work", { probe, knowledgeIndexJobs: true });
    expect(enabled.knowledge_index_jobs).toEqual({
      protocol: "knowledge-index-jobs/v1",
      concurrency: 1,
      max_chunk_bytes: 1024 * 1024,
    });
  });

  it("advertises macOS GUI automation only when the eligible controller is available and machine ops are allowed", async () => {
    const probe: RunnerInventoryProbe = {
      async command() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      async workspaceCount() { return 0; },
    };
    const enabled = await discoverRunnerInventory("/work", {
      probe,
      allowMachineOps: true,
      guiAutomation: { available: true },
    });
    expect(enabled.gui_automation).toEqual({
      available: true,
      protocol: "runner-macos-gui/v1",
      consent_ttl_seconds: 900,
    });
    const machineOpsOff = await discoverRunnerInventory("/work", {
      probe,
      allowMachineOps: false,
      guiAutomation: { available: true },
    });
    expect(machineOpsOff).not.toHaveProperty("gui_automation");
    const executionOnly = await discoverRunnerInventory("/work", {
      probe,
      executionOnly: true,
      guiAutomation: { available: true },
    });
    expect(executionOnly).not.toHaveProperty("gui_automation");
  });

  it("keeps a backend's facts through one failed re-probe and reports a second", async () => {
    let codexFailure: Error | undefined;
    const probe: RunnerInventoryProbe = {
      async command(bin, args) {
        if (bin === "codex" && codexFailure) throw codexFailure;
        // A leading notice line must not hide the version.
        if (bin === "codex" && args[0] === "--version") return { stdout: "notice: update available\ncodex-cli 0.161.0\n" };
        return { stdout: "1.0.0" };
      },
      async workspaceCount() { return 1; },
    };
    const probeMemory = new Map();
    let execServer: boolean | undefined;
    const codex = async () => {
      const inventory = await discoverRunnerInventory("/home/runner", { probe, probeMemory });
      execServer = inventory.execution.codex_exec_server;
      return inventory.agent_backends.find(({ kind }) => kind === "codex");
    };
    const ready = { available: true, split_execution: true, version: "codex-cli 0.161.0" };
    expect(await codex()).toMatchObject(ready);
    expect(execServer).toBe(true);
    codexFailure = Object.assign(new Error("slow"), { killed: true });
    expect(await codex()).toMatchObject(ready);
    // The workspace side of a split pool keeps the same remembered fact.
    expect(execServer).toBe(true);
    expect(await codex()).toMatchObject({ available: false, split_execution: false, reason: "probe_failed", diagnostic_code: "probe_timeout" });
    expect(execServer).toBe(false);
    codexFailure = undefined;
    expect(await codex()).toMatchObject(ready);
    // A missing executable is reported at once.
    codexFailure = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(await codex()).toMatchObject({ available: false, reason: "command_unavailable" });
    // Without the resident's memory every probe stands alone, as before.
    codexFailure = new Error("broken");
    expect((await discoverRunnerInventory("/home/runner", { probe })).agent_backends.find(({ kind }) => kind === "codex"))
      .toMatchObject({ available: false, split_execution: false, reason: "probe_failed" });
  });

  it("advertises split Codex execution only for environment-capable releases", () => {
    expect(codexSplitExecutionAvailable("codex-cli 0.146.9")).toBe(false);
    expect(codexSplitExecutionAvailable("codex-cli 0.147.0")).toBe(true);
    expect(codexSplitExecutionAvailable("codex-cli 1.0.0")).toBe(true);
    expect(codexSplitExecutionAvailable("development")).toBe(false);
  });

  it("reports exec-server separately when Codex is installed without model credentials", async () => {
    const probe: RunnerInventoryProbe = {
      async command(bin, args) {
        if (bin === "codex" && args[0] === "--version") return { stdout: "codex-cli 0.147.0" };
        if (bin === "codex") throw new Error("not logged in");
        return { stdout: "1.0.0" };
      },
      async workspaceCount() {
        return 1;
      },
    };
    const inventory = await discoverRunnerInventory("/home/runner", { probe });
    expect(inventory.agent_backends.find(({ kind }) => kind === "codex")).toMatchObject({
      available: false,
      version: "codex-cli 0.147.0",
      split_execution: true,
      reason: "authentication_unavailable",
    });
    expect(inventory.execution.codex_exec_server).toBe(true);
    // This Runner's session MCP proxy accepts a read-only scope (a Feishu document assistant).
    expect(inventory.execution.read_only_scope).toBe(true);
  });

  it.each([true, false, "failed"])("uses native provider auth after login status fails: %s", async (nativeAuth) => {
    const codexAuthentication = vi.fn(async () => {
      if (nativeAuth === "failed") throw new Error("private provider failure");
      return nativeAuth === true;
    });
    const inventory = await discoverRunnerInventory("/home/runner", { probe: {
      async command(bin, args) {
        if (bin === "codex" && args[0] === "login") throw new Error("not logged in");
        return { stdout: "codex-cli 0.162.0" };
      },
      codexAuthentication,
      async workspaceCount() { return 0; },
    } });
    expect(codexAuthentication).toHaveBeenCalledOnce();
    expect(inventory.agent_backends.find(({ kind }) => kind === "codex")).toMatchObject({
      available: nativeAuth === true, split_execution: true,
      ...(nativeAuth === true ? {} : { reason: "authentication_unavailable" }),
    });
    expect(inventory.execution.codex_exec_server).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain("private provider failure");
  });

  it.each(["logged-in", "execution-only", "untrusted"])("does not start native auth unnecessarily: %s", async (mode) => {
    const codexAuthentication = vi.fn(async () => true);
    const inventory = await discoverRunnerInventory("/home/runner", { executionOnly: mode === "execution-only", probe: {
      async command(bin, args) {
        if (bin === "codex" && args[0] === "login" && mode === "untrusted") {
          throw Object.assign(new Error("unsafe executable"), { code: "EACCES" });
        }
        return { stdout: "codex-cli 0.162.0" };
      },
      codexAuthentication,
      async workspaceCount() { return 0; },
    } });
    expect(codexAuthentication).not.toHaveBeenCalled();
    expect(inventory.agent_backends.find(({ kind }) => kind === "codex")?.available).toBe(mode === "logged-in");
  });

  it("preserves executable identity failures from the native auth fallback", async () => {
    const inventory = await discoverRunnerInventory("/home/runner", { probe: {
      async command(bin, args) {
        if (bin === "codex" && args[0] === "login") throw new Error("not logged in");
        return { stdout: "codex-cli 0.162.0" };
      },
      async codexAuthentication() { throw new AgentExecutableError("executable_changed"); },
      async workspaceCount() { return 0; },
    } });
    expect(inventory.agent_backends.find(({ kind }) => kind === "codex")).toMatchObject({
      available: false, diagnostic_code: "executable_changed",
    });
  });

  it.each([false, true])("keeps execution-only agent isolation when fixed knowledge jobs are enabled=%s", async (knowledgeIndexJobs) => {
    let commandProbes = 0;
    let dshProbes = 0;
    const inventory = await discoverRunnerInventory("/home/runner", {
      allowMachineOps: true,
      executionOnly: true,
      knowledgeIndexJobs,
      localMcp: { available: true, clients: ["codex"] },
      probe: {
        async command() {
          commandProbes++;
          return { stdout: "installed" };
        },
        async workspaceCount() {
          return 2;
        },
      },
      dsh: async () => {
        dshProbes++;
        return { available: true, port: 9931 };
      },
    });
    expect(inventory.session_roster).toBe(false);
    expect(commandProbes).toBe(0);
    expect(dshProbes).toBe(0);
    expect(inventory.agent_backends).toHaveLength(3);
    expect(inventory.agent_backends.every((backend) => backend.available === false)).toBe(true);
    expect(inventory.execution).toMatchObject({ shell: true, workspace_files: true, workspace_count: 2, codex_exec_server: false });
    expect(inventory).not.toHaveProperty("dsh");
    expect(Boolean(inventory.knowledge_index_jobs)).toBe(knowledgeIndexJobs);
    expect(inventory).not.toHaveProperty("local_mcp");
  });
});

it("workspace jobs require an explicit manager opt-in and machine ops", async () => {
  const probe: RunnerInventoryProbe = { async command() { throw new Error("missing"); }, async workspaceCount() { return 1; } };
  expect(await discoverRunnerInventory("/work", { probe, executionOnly: true })).not.toHaveProperty("workspace_jobs");
  const enabled = await discoverRunnerInventory("/work", { probe, executionOnly: true, workspaceJobs: true });
  expect(enabled.workspace_jobs).toEqual({ protocol: "workspace-jobs/v1", concurrency: 1, max_log_chunk_bytes: 65536, max_artifact_chunk_bytes: 1048576 });
  expect(enabled.agent_backends.every((backend) => !backend.available)).toBe(true);
  expect(await discoverRunnerInventory("/work", { probe, executionOnly: true, workspaceJobs: true, allowMachineOps: false })).not.toHaveProperty("workspace_jobs");
});

it("advertises only bounded registered workspace and account identities", async () => {
  const inventory = await discoverRunnerInventory("/private-home", { codexAccounts: [{ slot: "pool-b", label: "b" }, { slot: "default", label: "a" }],
    probe: { command: async () => ({ stdout: "0.154.0" }), workspaceCount: async () => 1,
      workspaces: async () => [{ id: `ws_${"a".repeat(24)}`, label: "Project", path: "/private-home/project" }] } });
  expect(inventory.ticket_options).toEqual({ protocol: "ticket-options/v1",
    codex_accounts: [{ id: "@default", label: "codex" }, { id: "pool-b", label: "codexb" }, { id: "default", label: "codexa" }],
    workspaces: [{ id: `ws_${"a".repeat(24)}`, label: "Project" }] });
  expect(JSON.stringify(inventory)).not.toContain("/private-home");
});

it("reports Claude quota independently and never reads logins on execution-only devices", async () => {
  let reads = 0;
  const claude = [{ id: "@default", label: "Claude" }];
  const options = { probe: { command: async () => ({ stdout: "2.1.0" }), workspaceCount: async () => 0 },
    codexAccountInventory: async () => [], claudeAccountInventory: async () => { reads++; return claude; } };
  expect((await discoverRunnerInventory("/unused", options)).ticket_options).toMatchObject({ codex_accounts: [], claude_accounts: claude });
  expect((await discoverRunnerInventory("/unused", { ...options, executionOnly: true })).ticket_options).not.toHaveProperty("claude_accounts");
  expect(reads).toBe(1);
});

it("advertises persistent development only with its actual Git toolchain and machine authority", async () => {
  const options = { executionOnly: true, workspaceDevelopment: true, probe: {
    command: async () => ({ stdout: "available" }), workspaceCount: async () => 1,
  } };
  expect((await discoverRunnerInventory("/unused", options)).workspace_development)
    .toMatchObject({ protocol: "workspace-development/v1", available: true, max_bundle_bytes: 134217728 });
  expect((await discoverRunnerInventory("/unused", { ...options, allowMachineOps: false })).workspace_development)
    .toMatchObject({ available: false, reason: "machine_ops_disabled" });
  expect((await discoverRunnerInventory("/unused", { ...options, workspaceDevelopment: false })).workspace_development)
    .toMatchObject({ available: false, reason: "disabled" });
  expect((await discoverRunnerInventory("/unused", { ...options, probe: { ...options.probe,
    command: async (bin: string) => { if (bin === "git") throw new Error("missing"); return { stdout: "available" }; },
  } })).workspace_development).toMatchObject({ available: false, reason: "git_unavailable" });
});

describe("RunnerInventoryRefresh", () => {
  it("registers with the newest completed inventory while a later refresh never settles", async () => {
    const results = [Promise.resolve("first"), new Promise<string>(() => {})];
    const inventory = new RunnerInventoryRefresh(() => results.shift()!);
    expect(await inventory.forRegistration()).toBe("first");
    void inventory.refresh();
    expect(await inventory.forRegistration()).toBe("first");
  });

  it("waits for the first inventory and follows the refresh that supersedes it", async () => {
    let release: (value: string) => void = () => {};
    const results = [new Promise<string>((resolve) => { release = resolve; }), Promise.resolve("second")];
    const inventory = new RunnerInventoryRefresh(() => results.shift()!);
    const registration = inventory.forRegistration();
    expect(await inventory.refresh()).toBe("second");
    release("first");
    expect(await registration).toBe("second");
    expect(await inventory.latest()).toBe("second");
  });
});
