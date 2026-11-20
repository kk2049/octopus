import { CapabilityService, SqliteCapabilityStore } from "@claude-bot/capability-kernel";
import { expect, it, vi } from "vitest";
import type { RunnerTransport } from "../runner/gateway.js";
import { SESSION_EXECUTION_TOOL, readToolArgs, toolDefinitionOf } from "../mcp/tools.js";
import {
  ExecutionWorkspaceCapabilities,
  EXECUTION_WORKSPACE_OBJECT_PREFIX,
  RUN_WORKSPACE_COMMAND,
} from "./capability.js";

it("passes long MCP commands through the bound workspace Gate and preserves its safety boundaries", async () => {
  const store = new SqliteCapabilityStore(":memory:");
  const old = { id: "execution-workspace-runner-v1:alice", kind: "execution-workspace-runner",
    metadata: { owner: "alice" }, operations: [RUN_WORKSPACE_COMMAND] };
  store.putObject(old);
  const service = new CapabilityService({ store });
  const dispatch = vi.fn(async () => ({ stdout: "done" }));
  const transport = { dispatch } as unknown as RunnerTransport;
  try {
    const caps = new ExecutionWorkspaceCapabilities({ service, transport,
      userExists: (owner) => owner === "alice", hasDevice: () => true });
    const grant = caps.open({ username: "alice", purpose: "test", device: "ci" })!;
    const command = `# ${"章鱼".repeat(10_000)}\nprintf done`;
    expect(toolDefinitionOf(SESSION_EXECUTION_TOOL).inputSchema.properties.command).not.toHaveProperty("maxLength");
    expect(readToolArgs(SESSION_EXECUTION_TOOL, { command })).toEqual({ ok: true, value: { command } });
    expect(readToolArgs(SESSION_EXECUTION_TOOL, { command: 1 }).ok).toBe(false);
    const args = { device: "ci", workspace_id: `ws_${"1".repeat(24)}`, command };
    const waiting = await grant.request(RUN_WORKSPACE_COMMAND, args);
    expect(waiting.status).toBe("approval_required");
    expect(dispatch).not.toHaveBeenCalled();
    if (waiting.status !== "approval_required") throw new Error("expected approval");
    expect((await service.approve(waiting.pendingCallId, "alice")).status).toBe("succeeded");
    expect(dispatch).toHaveBeenCalledWith("alice", "exec_workspace", args);
    for (const invalid of [{ ...args, device: "other" }, { ...args, command: "x".repeat(512 * 1024) }, { ...args, command: 1 }]) {
      expect((await grant.request(RUN_WORKSPACE_COMMAND, invalid)).status).toBe("denied");
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(EXECUTION_WORKSPACE_OBJECT_PREFIX).toBe("execution-workspace-runner-v2");
    expect(store.getObject(old.id)).toEqual(old);
    caps.revokeDevice("alice", "ci");
    expect((await grant.request(RUN_WORKSPACE_COMMAND, args)).status).toBe("denied");
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally { service.close(); }
});
