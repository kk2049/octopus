import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  AgentExecutableRegistry, agentCommand, usingAgentExecutables, withAgentExecutable, probeAgentExecutable,
  withAgentOperation,
} from "./agent-executables.js";
import { discoverRunnerInventory } from "./inventory.js";
import { executablePlan } from "./agent-executable-discovery.js";
import { probeCodex } from "./probe.js";
import { spawnHeadlessCli, readHeadlessCapture } from "./headless-cli-launch.js";
import { ClaudeManagedSession } from "./claude-agent-sdk.js";
import { AgentInteractionBroker } from "./agent-interactions.js";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture(options: { platform?: NodeJS.Platform; executionOnly?: boolean; persistSelections?: boolean } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "agent-registry-"));
  homes.push(home);
  const registry = new AgentExecutableRegistry({ home, directories: [], systemDirectories: [], ...options });
  return { home, registry };
}
function cli(home: string, relative: string, version = "codex-cli 0.153.2", body?: string): string {
  const file = path.join(home, relative);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, body ?? `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 });
  return file;
}

describe("device-private Agent executable registry", () => {
  it.each(["darwin", "linux"] as const)("discovers nvm on %s with a bound Node interpreter under minimal PATH", async (platform) => {
    const { home, registry } = fixture({ platform });
    const file = cli(home, ".nvm/versions/node/v22.1.0/bin/codex", "", '#!/usr/bin/env node\nconsole.log("codex-cli 0.153.2");\n');
    symlinkSync(process.execPath, path.join(path.dirname(file), "node"));
    await usingAgentExecutables(registry, async () => {
      const before = process.env.PATH;
      const inventory = await discoverRunnerInventory(home, { env: { PATH: "/nonexistent", HOME: home } });
      expect(inventory.agent_backends.find((row) => row.kind === "codex")).toMatchObject({ available: true, version: "codex-cli 0.153.2" });
      const command = agentCommand("codex", ["app-server"], { PATH: "/nonexistent" });
      expect(execFileSync(command.bin, command.args, { env: command.env, encoding: "utf8" }).trim()).toBe("codex-cli 0.153.2");
      expect(process.env.PATH).toBe(before);
      expect(JSON.stringify(inventory)).not.toContain(home);
    });
  });

  it("does not replace a missing nvm interpreter with an unrelated system Node", () => {
    const { home, registry } = fixture();
    cli(home, ".nvm/versions/node/v22.1.0/bin/codex", "", '#!/usr/bin/env node\nconsole.log("codex-cli");\n');
    expect(registry.inspect("codex").candidates).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "interpreter_unavailable" })]));
    expect(() => registry.resolve("codex")).toThrow("interpreter_unavailable");
  });

  it("keeps the script candidate and reports a missing absolute shebang or explicitly selected interpreter", async () => {
    const { home, registry } = fixture();
    const missing = path.join(home, "removed-node");
    const file = cli(home, ".local/bin/codex", "", `#!${missing}\nconsole.log('codex-cli');\n`);
    expect(registry.inspect("codex")).toMatchObject({ reason: "interpreter_unavailable", detail: {
      stage: "interpreter", path: missing, rule: "interpreter_missing",
    } });
    expect(registry.inspect("codex").candidates).toHaveLength(1);
    expect(() => registry.bind("codex", { entry: file, interpreter: missing })).toThrow("interpreter_unavailable");
    const inventory = await usingAgentExecutables(registry, () => discoverRunnerInventory(home));
    expect(inventory.agent_backends.find((row) => row.kind === "codex")).toMatchObject({ reason: "probe_failed", diagnostic_code: "interpreter_unavailable" });
  });

  it("retains an interpreter policy refusal after skipping a missing earlier runtime", () => {
    const { home } = fixture();
    const file = cli(home, "scripts/codex", "", "#!/usr/bin/env node\n");
    const node = cli(home, "runtime/node"); chmodSync(path.dirname(node), 0o775);
    expect(() => executablePlan("codex", { entry: file, source: "standard" }, [path.dirname(node)]))
      .toThrow("unsafe_permissions");
  });

  it("follows a declared nvm default but never selects the highest unrelated installation", () => {
    const { home, registry } = fixture({ persistSelections: true });
    const a = cli(home, ".nvm/versions/node/v22.1.0/bin/codex");
    const b = cli(home, ".nvm/versions/node/v24.0.0/bin/codex");
    expect(registry.inspect("codex").reason).toBe("multiple_installations");
    const alias = cli(home, ".nvm/alias/default", "", "22\n");
    expect(registry.resolve("codex").entry).toBe(a);
    writeFileSync(alias, "24\n");
    expect(registry.resolve("codex").entry).toBe(b);
    cli(home, ".nvm/versions/node/v26.0.0/bin/codex");
    expect(registry.resolve("codex").entry).toBe(b);
    expect(statSync(path.join(home, ".octopus/runner/agent-selections.json")).mode & 0o777).toBe(0o600);
  });

  it("retains a working selection across new candidates and process restarts", () => {
    const { home, registry } = fixture({ persistSelections: true });
    const first = cli(home, ".local/bin/codex");
    expect(registry.resolve("codex").entry).toBe(first);
    cli(home, "bin/codex", "codex-cli 99.0.0");
    const restarted = new AgentExecutableRegistry({ home, directories: [], systemDirectories: [] });
    expect(restarted.resolve("codex").entry).toBe(first);
    unlinkSync(first);
    expect(restarted.inspect("codex").reason).toBe("selection_unavailable");
  });

  it("follows PATH order over a remembered selection and re-resolves when PATH contents change", () => {
    const home = mkdtempSync(path.join(tmpdir(), "agent-registry-"));
    homes.push(home);
    const first = path.join(home, "terminal-bin"), second = path.join(home, "system-bin");
    const options = { home, directories: [first, second], systemDirectories: [], persistSelections: true };
    const registry = new AgentExecutableRegistry(options);
    const older = cli(home, "system-bin/codex", "codex-cli 0.157.0");
    expect(registry.resolve("codex").entry).toBe(older);
    // A newer CLI earlier in PATH is what the terminal runs; the cached choice must not win.
    const newer = cli(home, "terminal-bin/codex", "codex-cli 0.161.0");
    expect(registry.resolve("codex").entry).toBe(newer);
    expect(new AgentExecutableRegistry(options).resolve("codex").entry).toBe(newer);
    unlinkSync(newer);
    expect(registry.resolve("codex").entry).toBe(older);
    // An untrusted earlier entry is still refused and reported, never executed.
    cli(home, "terminal-bin/codex", "codex-cli 0.162.0"); chmodSync(first, 0o775);
    const status = registry.inspect("codex");
    expect(status.selected?.entry).toBe(older);
    expect(status.candidates).toContainEqual(expect.objectContaining({ entry: path.join(first, "codex"), reason: "unsafe_permissions" }));
  });

  it("reads local binding changes without restart and never falls back from a broken binding", () => {
    const { home, registry } = fixture();
    const automatic = cli(home, ".local/bin/codex");
    const custom = cli(home, "custom/codex");
    expect(registry.resolve("codex").entry).toBe(automatic);
    const editor = new AgentExecutableRegistry({ home, directories: [], systemDirectories: [] });
    editor.bind("codex", { entry: custom });
    expect(registry.resolve("codex").entry).toBe(custom);
    unlinkSync(custom);
    expect(registry.inspect("codex").reason).toBe("binding_unavailable");
    editor.bind("codex", null);
    expect(registry.resolve("codex").entry).toBe(automatic);
    expect(statSync(path.join(home, ".octopus/runner/agent-bindings.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects malformed explicit bindings rather than treating them as an absent cache", () => {
    const { home, registry } = fixture();
    const file = cli(home, ".local/bin/codex");
    registry.bind("codex", { entry: file });
    writeFileSync(path.join(home, ".octopus/runner/agent-bindings.json"), "broken");
    expect(registry.inspect("codex").reason).toBe("invalid_bindings");
  });

  it("validates executable and parent permissions before running even a version probe", () => {
    const { home, registry } = fixture();
    const file = cli(home, ".local/bin/codex", "", `#!/bin/sh\ntouch '${home}/executed'\n`);
    chmodSync(path.dirname(file), 0o777);
    expect(registry.inspect("codex").candidates[0].reason).toBe("unsafe_permissions");
    expect(existsSync(path.join(home, "executed"))).toBe(false);
    chmodSync(path.dirname(file), 0o700);
    chmodSync(file, 0o600);
    expect(registry.inspect("codex").candidates[0].reason).toBe("not_executable");
  });

  it("reports a policy refusal with its offending path through inventory and contract probes", async () => {
    const { home, registry } = fixture();
    const file = cli(home, ".local/bin/codex");
    chmodSync(path.dirname(file), 0o775);
    expect(registry.inspect("codex")).toMatchObject({ reason: "unsafe_permissions", detail: {
      path: path.dirname(file), mode: "0775", rule: "group_writable",
    } });
    await usingAgentExecutables(registry, async () => {
      const inventory = await discoverRunnerInventory(home);
      const codex = inventory.agent_backends.find((row) => row.kind === "codex");
      expect(codex).toEqual(expect.objectContaining({
        available: false, reason: "probe_failed", diagnostic_code: "unsafe_permissions",
        diagnostic_detail: { path: path.dirname(file), rule: "group_writable" },
      }));
      // Only the offending path leaves the device; other backends stay path-free.
      expect(JSON.stringify(inventory.agent_backends.filter((row) => row.kind !== "codex"))).not.toContain(home);
      expect(await probeCodex(home)).toMatchObject({ supported: false, reason: "unsafe_permissions" });
    });
  });

  it("explicit local installation trust survives restart and a same-path upgrade, but not a new unsafe target", async () => {
    const { home, registry } = fixture();
    const file = cli(home, "shared/codex");
    chmodSync(path.dirname(file), 0o775);
    expect(() => registry.bind("codex", { entry: file })).toThrow("unsafe_permissions");
    registry.bind("codex", { entry: file }, true);
    const restarted = new AgentExecutableRegistry({ home, directories: [], systemDirectories: [] });
    await usingAgentExecutables(restarted, async () => {
      expect(await probeAgentExecutable("codex")).toBe("codex-cli 0.153.2");
      writeFileSync(file, "#!/bin/sh\necho 'codex-cli 0.154.0'\n");
      expect(await probeAgentExecutable("codex")).toBe("codex-cli 0.154.0");
      const other = cli(home, "other/codex"); chmodSync(path.dirname(other), 0o775);
      unlinkSync(file); symlinkSync(other, file);
      expect(() => agentCommand("codex", [])).toThrow("unsafe_permissions");
    });
    chmodSync(path.dirname(file), 0o777);
    expect(() => registry.bind("codex", { entry: file }, true)).toThrow("unsafe_permissions");
  });

  it("an executable trust grant cannot relax private registry permissions or be inferred from an old binding", () => {
    const { home, registry } = fixture();
    const file = cli(home, "shared/codex");
    registry.bind("codex", { entry: file });
    chmodSync(path.dirname(file), 0o775);
    expect(registry.inspect("codex").reason).toBe("binding_unavailable");
    registry.bind("codex", { entry: file }, true);
    chmodSync(path.join(home, ".octopus/runner/agent-bindings.json"), 0o644);
    expect(registry.inspect("codex")).toMatchObject({ reason: "invalid_bindings", detail: { rule: "private_owner_mode" } });
  });

  it("refuses registry writes through a symlink with a writable real ancestor on every attempt", () => {
    const { home, registry } = fixture({ persistSelections: true });
    cli(home, ".local/bin/codex");
    const shared = path.join(home, "shared");
    const target = path.join(shared, "private");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    chmodSync(shared, 0o777);
    mkdirSync(path.join(home, ".octopus"));
    symlinkSync(target, path.join(home, ".octopus/runner"));
    expect(registry.inspect("codex").reason).toBe("selection_write_failed");
    expect(registry.inspect("codex").reason).toBe("selection_write_failed");
    expect(existsSync(path.join(target, "agent-selections.json"))).toBe(false);
  });

  it("does not treat a dangling explicit binding file as absent", () => {
    const { home, registry } = fixture();
    cli(home, ".local/bin/codex");
    mkdirSync(path.join(home, ".octopus/runner"), { recursive: true });
    symlinkSync(path.join(home, "missing"), path.join(home, ".octopus/runner/agent-bindings.json"));
    expect(registry.inspect("codex").reason).toBe("invalid_bindings");
  });

  it("checks symlink targets and follows a safe atomic upgrade on the next operation", async () => {
    const { home, registry } = fixture();
    const a = cli(home, "versions/a", "codex-cli 0.153.2");
    const b = cli(home, "versions/b", "codex-cli 0.154.0");
    const entry = path.join(home, ".local/bin/codex");
    mkdirSync(path.dirname(entry), { recursive: true });
    symlinkSync(a, entry);
    await usingAgentExecutables(registry, async () => {
      await withAgentExecutable("codex", async () => {
        expect(await probeAgentExecutable("codex")).toBe("codex-cli 0.153.2");
        unlinkSync(entry); symlinkSync(b, entry);
        expect(() => agentCommand("codex", [])).toThrow("executable_changed");
      });
      expect(await probeAgentExecutable("codex")).toBe("codex-cli 0.154.0");
      chmodSync(b, 0o777);
      expect(() => agentCommand("codex", [])).toThrow("selection_unavailable");
    });
  });

  it("invalidates the contract cache when a different file reports the same version", async () => {
    const { home, registry } = fixture();
    const body = (help: string) => `#!/bin/sh\nif [ "$1" = --version ]; then echo 'codex-cli 0.153.2'; else echo '${help}'; fi\n`;
    cli(home, ".local/bin/codex", "", body("--json"));
    const second = cli(home, "custom/codex", "", body("no json flag"));
    await usingAgentExecutables(registry, async () => {
      expect((await probeCodex(home)).supported).toBe(true);
      registry.bind("codex", { entry: second });
      expect((await probeCodex(home)).supported).toBe(false);
    });
  });

  it("keeps a failed pre-prompt adapter and its fallback on the same selected installation", async () => {
    const { home, registry } = fixture();
    const original = cli(home, ".local/bin/codex");
    const replacement = cli(home, "custom/codex");
    await usingAgentExecutables(registry, () => withAgentOperation(async () => {
      await expect(withAgentExecutable("codex", async () => {
        expect(agentCommand("codex", []).entry).toBe(original);
        registry.bind("codex", { entry: replacement });
        throw new Error("adapter setup failed");
      })).rejects.toThrow("setup failed");
      expect(agentCommand("codex", []).entry).toBe(original);
    }));
    expect(usingAgentExecutables(registry, () => agentCommand("codex", []).entry)).toBe(replacement);
  });

  it("keeps authentication separate from executable identity", async () => {
    const { home, registry } = fixture();
    cli(home, ".local/bin/codex", "", '#!/bin/sh\nif [ "$1" = login ]; then exit 1; fi\necho "codex-cli 0.153.2"\n');
    const inventory = await usingAgentExecutables(registry, () => discoverRunnerInventory(home));
    expect(inventory.agent_backends.find((row) => row.kind === "codex")).toMatchObject({ available: false, reason: "authentication_unavailable" });
    expect(inventory.execution.codex_exec_server).toBe(true);
    expect(registry.resolve("codex").source).toBe("standard");
  });

  it("accepts a config provider without login through the selected CLI and environment", async () => {
    const { home, registry } = fixture();
    const executable = cli(home, "custom/codex.mjs", "", `#!${process.execPath}
      import readline from "node:readline";
      if (process.argv[2] === "--version") {
        console.log("codex-cli 0.162.0"); process.exit(0);
      }
      if (process.argv[2] === "login") process.exit(1);
      if (process.argv[2] !== "app-server" || process.argv.length !== 3) process.exit(2);
      let initialized = false;
      readline.createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        if (request.method === "initialize") {
          console.log(JSON.stringify({ id: request.id, result: {} }));
        } else if (request.method === "initialized") {
          initialized = true;
        } else if (initialized && request.method === "account/read"
          && request.params?.refreshToken === false
          && process.env.CODEX_HOME === process.env.HOME + "/provider-config"
          && process.env.FIXTURE_PROVIDER_KEY === "fake-key") {
          console.log(JSON.stringify({ id: request.id, result: { account: null, requiresOpenaiAuth: false } }));
        } else process.exit(3);
      });
    `);
    registry.bind("codex", { entry: executable });
    const inventory = await usingAgentExecutables(registry, () => discoverRunnerInventory(home, {
      env: { HOME: home, CODEX_HOME: path.join(home, "provider-config"), PATH: "/nonexistent", FIXTURE_PROVIDER_KEY: "fake-key" },
    }));
    expect(inventory.agent_backends.find((row) => row.kind === "codex")).toMatchObject({ available: true, split_execution: true });
    expect(JSON.stringify(inventory)).not.toMatch(/fake-key|provider-config/);
    expect(registry.resolve("codex").entry).toBe(executable);
  });

  it.each([{ platform: "win32" as const }, { executionOnly: true }])("does no discovery or persistence in disabled mode: %j", async (options) => {
    const { home, registry } = fixture({ ...options, persistSelections: true });
    cli(home, ".local/bin/codex");
    expect(registry.inspect("codex")).toEqual({ provider: "codex", reason: "execution_only", candidates: [] });
    expect(() => registry.bind("codex", { entry: "/bin/sh" })).toThrow("执行环境");
    const inventory = await usingAgentExecutables(registry, () => discoverRunnerInventory(home, { executionOnly: true }));
    expect(inventory.agent_backends.every((backend) => !backend.available)).toBe(true);
    expect(existsSync(path.join(home, ".octopus"))).toBe(false);
  });

  it("launches detached Agent CLIs from a registered path containing spaces", async () => {
    const { home, registry } = fixture();
    const executable = cli(home, "custom bin/codex", "codex-cli 0.153.2");
    registry.bind("codex", { entry: executable });
    await usingAgentExecutables(registry, async () => {
      const launched = await spawnHeadlessCli(home, home, "registry-launch", { bin: "codex", args: ["--version"] });
      for (let attempt = 0; attempt < 100; attempt++) {
        const output = await readHeadlessCapture(launched.outputFile);
        if (output) { expect(output).toBe("codex-cli 0.153.2"); await launched.cleanup(); return; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("registered child did not produce output");
    });
  });

  it("lets the Claude SDK keep protocol arguments while spawning the registered Node script", async () => {
    const { home, registry } = fixture();
    const file = cli(home, ".nvm/versions/node/v22.1.0/bin/claude", "", '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
    symlinkSync(process.execPath, path.join(path.dirname(file), "node"));
    let output = "";
    const session = usingAgentExecutables(registry, () => withAgentExecutable("claude", () => new ClaudeManagedSession({
      sessionId: "registered-claude", cwd: home, timeoutMs: 2000, resume: true,
      interactions: new AgentInteractionBroker(),
      queryFactory: ({ prompt, options }) => ({
        close: () => {},
        async *[Symbol.asyncIterator]() {
          for await (const row of prompt) {
            void row;
            const start = options.spawnClaudeCodeProcess as (options: SpawnOptions) => ChildProcessWithoutNullStreams;
            const child = start({ command: "node", args: [String(options.pathToClaudeCodeExecutable), "--sdk-argument", "literal with spaces"],
              cwd: home, env: { PATH: "/missing" }, signal: new AbortController().signal });
            child.stdout.on("data", (chunk) => { output += String(chunk); });
            await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(String(code)))); });
            yield { type: "result", subtype: "success", result: "registered", session_id: "registered-claude" };
          }
        },
      }),
    })));
    await expect(session.dispatch("test").completion).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(output)).toEqual(["--sdk-argument", "literal with spaces"]);
    await session.close();
  });
});
