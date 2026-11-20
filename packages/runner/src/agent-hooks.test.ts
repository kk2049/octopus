import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentHookStatus,
  installAgentHooks,
  uninstallAgentHooks,
  CLAUDE_EVENTS,
  CODEX_EVENTS,
} from "./agent-hooks.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "octopus-hooks-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("agent hook installation", () => {
  it("preserves user hooks, installs both providers, and is idempotent", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      theme: "dark",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "user-hook" }] }] },
    }));

    const first = await installAgentHooks(home, "/opt/octopus runner/runner.js");
    expect(first.find((row) => row.provider === "claude")?.installed).toBe(CLAUDE_EVENTS.length);
    expect(first.find((row) => row.provider === "codex")?.installed).toBe(CODEX_EVENTS.length);
    expect(first.find((row) => row.provider === "codex")?.warning).toMatch(/trust review/);
    const second = await installAgentHooks(home, "/opt/octopus runner/runner.js");
    expect(second.every((row) => row.changed === false)).toBe(true);

    const claude = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(claude.theme).toBe("dark");
    expect(claude.hooks.Stop[0].hooks[0].command).toBe("user-hook");
    expect(JSON.stringify(claude)).toContain("octopus-agent-runtime:v1");
    expect(JSON.stringify(claude)).toContain("hook-reporter.mjs");
    expect(readFileSync(join(home, ".octopus", "runner", "hook-reporter.mjs"), "utf8")).not.toContain("standalone.js");
    expect(claude.hooks.PreToolUse.at(-1).hooks[0].timeout).toBe(600);
    expect(claude.hooks.PermissionRequest.at(-1).hooks[0].timeout).toBe(600);
    expect(claude.hooks.Stop.at(-1).hooks[0].timeout).toBe(10);

    const codex = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
    for (const event of CODEX_EVENTS) {
      const expected = event === "SessionEnd" ? 3 : 10;
      expect(codex.hooks[event].at(-1).hooks[0].timeout).toBe(expected);
    }
  });

  it("uninstall removes only marker-owned handlers", async () => {
    await installAgentHooks(home, "/opt/runner.js");
    await uninstallAgentHooks(home);
    const status = await agentHookStatus(home);
    expect(status.every((row) => row.installed === 0)).toBe(true);
  });

  it("writes Codex hooks to the effective CODEX_HOME without moving Claude hooks", async () => {
    const codexHome = join(home, "codex-state");
    await installAgentHooks(home, "/opt/runner.js", codexHome);

    expect(JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8")).hooks.Stop).toBeDefined();
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks.Stop).toBeDefined();
    await uninstallAgentHooks(home, codexHome);
    expect((await agentHookStatus(home, codexHome)).every((row) => row.installed === 0)).toBe(true);
  });

  it("refuses to overwrite malformed user JSON", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "hooks.json"), "not-json");
    await expect(installAgentHooks(home, "/opt/runner.js")).rejects.toThrow(/cannot update/);
    expect(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).toBe("not-json");
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))).toEqual({ theme: "dark" });
  });
});
