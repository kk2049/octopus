import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorizationService } from "../authorization/service.js";
import type { RunnerDeviceStatus } from "../runner/gateway.js";
import { Store } from "../store/store.js";
import { AgentRuntimeCreditService } from "./service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtimeRow(owner: string): RunnerDeviceStatus {
  return {
    device: owner === "lht" ? "provider-box" : "alice-box",
    online: true,
    created_at: "2026-08-30T00:00:00.000Z",
    last_seen_at: "2026-08-30T18:00:00.000Z",
    inventory: {
      schema: "runner-inventory/v1",
      ticket_options: { protocol: "ticket-options/v1", workspaces: [], codex_accounts: [{ id: "account_a", label: "codexa",
        quota: { status: "available", fetchedAt: "2026-09-15T12:00:00Z", windows: [{ remainingPercent: 42, windowMinutes: 300, resetsAt: "2026-09-15T13:00:00Z" }] } }] },
      agent_backends: [{ kind: "claude", available: true, split_execution: true, version: "2.1.0" }],
      execution: {
        platform: "linux",
        arch: "x64",
        shell: true,
        workspace_files: true,
        workspace_count: 1,
        codex_exec_server: true,
      },
    },
  };
}

describe("AgentRuntimeCreditService", () => {
  it("projects only exact permits, gates zero balance, charges once, and observes revocation immediately", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-runtime-credit-"));
    dirs.push(dir);
    const store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "lht", uid: 5000, home_dir: "/x/lht", created_at: "2026-08-30T00:00:00.000Z" });
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: "2026-08-30T00:00:00.000Z" });
    const authorization = new AuthorizationService({ repository: store.authorization });
    const devices = (owner: string) => owner === "lht" ? [runtimeRow(owner)] : [runtimeRow(owner)];
    const service = new AgentRuntimeCreditService({
      store,
      authorization,
      devices,
      hostOwners: ["lht"],
    });

    expect(service.projectFor("alice")).toEqual([]);
    service.grantRuntime("lht", "provider-box", "alice", "lht");
    const projected = service.projectFor("alice");
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      device: expect.stringMatching(/^agent-/),
      sharedAgentRuntime: true,
      codexAccounts: [{ id: "account_a", label: "codexa", quota: { status: "available", windows: [{ remainingPercent: 42 }] } }],
      creditBalance: 0,
      execution: { shell: false, workspaceFiles: false },
    });
    const alias = String(projected[0]!.device);
    expect(service.resolveAlias("alice", alias)).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringMatching(/余额为 0.*提交开发工单/),
    });

    store.credits.record({
      username: "alice",
      delta: 100,
      reason: "admin_adjust",
      refKind: "test",
      refId: "seed-alice",
    });
    const resolved = service.resolveAlias("alice", alias);
    expect(resolved).toMatchObject({
      ok: true,
      runtime: { holder: "alice", owner: "lht", device: "provider-box", balance: 100 },
    });
    if (!resolved.ok) throw new Error("expected shared runtime");
    store.saveSessionExecutionBinding({
      owner: "alice",
      runtime_owner: "lht",
      runtime_device: "provider-box",
      runtime_resource_id: resolved.runtime.resourceId,
      source: "claude",
      session_id: "session-a",
      operation_id: "op_launch_a",
      execution_device: "alice-box",
      workspace_id: "ws_0123456789abcdef01234567",
      permission_profile: "full_access",
      token_hash: "hash",
      expires_at: "2026-08-31T00:00:00.000Z",
      created_at: "2026-08-30T18:00:00.000Z",
      updated_at: "2026-08-30T18:00:00.000Z",
    });
    const completion = {
      schema: "runner-managed-completion/v1" as const,
      provider: "claude" as const,
      session_id: "session-rebound",
      logical_session_id: "session-a",
      turn_id: "turn-1",
      status: "succeeded" as const,
      completed_at: "2026-08-30T18:10:00.000Z",
      usage: { tokens_in: 20, tokens_out: 5, tokens_cached: 10 },
    };
    expect(service.spendCompletion("lht", "provider-box", completion))
      .toEqual({ applied: true, balance: 65 });
    expect(service.spendCompletion("lht", "provider-box", completion))
      .toEqual({ applied: false, balance: 65 });

    expect(service.revokeRuntime("lht", "provider-box", "alice", "lht")).toBe(true);
    expect(service.projectFor("alice")).toEqual([]);
    expect(service.resolveAlias("alice", alias)).toMatchObject({ ok: false, status: 403 });
    expect(service.authorizeResource("alice", resolved.runtime.resourceId, "lht", "provider-box"))
      .toMatchObject({ ok: false, status: 403 });

    authorization.close();
    store.close();
  });
});
