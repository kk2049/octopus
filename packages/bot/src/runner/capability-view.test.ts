import { describe, expect, it } from "vitest";
import { runnerCapabilityView } from "./capability-view.js";
import type { RunnerInventory } from "@claude-bot/runner/inventory";
describe("Runner capability presentation", () => {
  it("distinguishes missing inventory from unavailable builtins and projects extension diagnostics", () => {
    expect(runnerCapabilityView()).toBeUndefined();
    const inventory: RunnerInventory = { schema: "runner-inventory/v1", session_roster: false, agent_backends: [{ kind: "claude", available: true, split_execution: true, version: "1.0" }],
      execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 0, codex_exec_server: false },
      capabilities: { protocol: "runner-capabilities/v1", providers: [{ id: "broken", title: "Broken", version: "1",
        revision: "a".repeat(32), status: "error", reason: "provider_unavailable", tools: [] }] } };
    const rows = runnerCapabilityView(inventory)!;
    expect(rows.find(row => row.id === "shell")).toMatchObject({ kind: "builtin", status: "ready" });
    expect(rows.find(row => row.id === "sessions")).toMatchObject({ status: "unavailable" });
    expect(rows.find(row => row.id === "agent:claude")).toMatchObject({ version: "1.0" });
    expect(rows.find(row => row.id === "agent:claude")?.protocol).toBeUndefined();
    expect(rows.find(row => row.id === "broken")).toMatchObject({ kind: "extension", reason: "provider_unavailable", status: "error" });
  });
});
