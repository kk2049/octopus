import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { Store } from "../store/store.js";
import type { RunnerTransport } from "../runner/gateway.js";
import { WorkspaceFilesCapabilities } from "../workspace-files/capability.js";
import { WorkspaceFilesService } from "../workspace-files/service.js";
import { ExecutionWorkspaceCapabilities } from "../execution-workspace/capability.js";
import { SessionExecutionRegistry } from "./session-execution.js";

const WS = "ws_0123456789abcdef01234567";

describe("execution scope lifetime against the real capability kernel", () => {
  it("survives browser pool collection after 15 minutes, with precise revocation and no bearer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "execution-lifecycle-"));
    const store = new Store(join(dir, "bot.db"));
    let now = Date.now();
    const service = new CapabilityService();
    const dispatched: string[] = [];
    const transport = { async dispatch(_owner: string, operation: string, args: Record<string, unknown>) {
      if (operation === "list_session_workspaces") return { workspaces: [{ id: WS, label: "work" }] };
      if (operation === "exec_workspace") { dispatched.push(String(args.device)); return { exit_code: 0 }; }
      throw new Error(`unexpected ${operation}`);
    } } as RunnerTransport;
    const shared = { service, transport, userExists: () => true, hasDevice: () => true, now: () => now };
    const files = new WorkspaceFilesCapabilities(shared);
    const execution = new ExecutionWorkspaceCapabilities(shared);
    const registry = new SessionExecutionRegistry({
      store, workspaceCapabilities: files, executionCapabilities: execution,
      workspaceFilesService: new WorkspaceFilesService(), dashboardPort: 9820, now: () => now,
      devices: () => ["ci", "windows"].map((device) => ({ device, online: true,
        created_at: new Date(now).toISOString(), last_seen_at: null,
        inventory: { schema: "runner-inventory/v1", agent_backends: [], execution: {
          platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 1, codex_exec_server: false,
        } } as never,
      })),
    });
    try {
      const input = { owner: "alice", runtimeDevice: "aws-local", workspaceId: WS, permissionProfile: "full_access" as const };
      const ci = await registry.openLocalAgent({ ...input, executionDevice: "ci" });
      const windows = await registry.openLocalAgent({ ...input, executionDevice: "windows" });
      // Exercise the actual AccountAuthority pool collector, the original
      // trigger for destroying long-running execution scopes.
      execution.open({ username: "alice", purpose: "browser", pool: "browser" })?.close();
      now += 25 * 60 * 60_000;
      execution.open({ username: "alice", purpose: "browser-next", pool: "browser-next" })?.close();
      const another = await registry.openLocalAgent({ ...input, executionDevice: "windows" });
      await expect(registry.runCommand(ci.principal, { command: "true" })).resolves.toMatchObject({ ok: true });
      await expect(registry.workspacePort(ci.principal)!.refreshRoots()).resolves.toMatchObject({ ok: true });
      files.revokeDevice("alice", "windows");
      execution.revokeDevice("alice", "windows");
      registry.releaseDevice("alice", "windows");
      expect(windows.isActive()).toBe(false);
      expect(another.isActive()).toBe(false);
      await expect(registry.runCommand(windows.principal, { command: "true" })).resolves.toMatchObject({ ok: false });
      await expect(registry.runCommand(ci.principal, { command: "true" })).resolves.toMatchObject({ ok: true });
      registry.releaseDevice("alice", "aws-local");
      await expect(registry.runCommand(ci.principal, { command: "true" })).resolves.toMatchObject({ ok: false });
      expect(dispatched).toEqual(["ci", "ci"]);
      expect(store.listMcpTokens("alice")).toEqual([]);
    } finally { registry.close(); service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
