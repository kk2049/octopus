import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { hashRunnerToken } from "../runner/gateway.js";
import { mcpCredentialOf, mcpSessionExecutionPolicy } from "./tokens.js";
import { SessionExecutionRegistry, TARGET_WORKSPACES_BUDGET_MS, defaultTargetWorkspace } from "./session-execution.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionExecutionRegistry", () => {
  it("mints a single-session token over the selected device and destroys its authority on release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-execution-"));
    dirs.push(dir);
    const store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: "2026-08-18T00:00:00.000Z" });
    const destroyWorkspace = vi.fn();
    const destroyExecution = vi.fn();
    const closeScope = vi.fn(async () => {});
    const requestCommand = vi.fn(async () => ({ status: "succeeded" as const, result: { stdout: "ok" } }));
    const workspaceCapabilities = {
      open: vi.fn(() => ({ contextId: "ctx_workspace", destroy: destroyWorkspace })),
    };
    const executionCapabilities = {
      open: vi.fn(() => ({
        request: requestCommand,
        destroy: destroyExecution,
      })),
    };
    const workspacePort = { listRoots: vi.fn(async () => ({ ok: true, value: [] })) };
    const workspaceFilesService = {
      open: vi.fn(() => workspacePort),
      closeScope,
    };
    const registry = new SessionExecutionRegistry({
      store,
      workspaceCapabilities: workspaceCapabilities as never,
      executionCapabilities: executionCapabilities as never,
      workspaceFilesService: workspaceFilesService as never,
      dashboardPort: 9820,
    });
    const policyInput = {
      operationId: "op_12345678",
      runtimeDevice: "runner1",
      executionDevice: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
      permissionProfile: "manual" as const,
    };

    expect(() => registry.issue({ owner: "alice", runtimeOwner: "lht", ...policyInput }))
      .toThrow(/同时固定跨 owner 资源/);

    const issued = registry.issue({
      owner: "alice",
      runtimeOwner: "lht",
      runtimeResourceId: "agent-runtime:0123456789abcdef0123456789abcdef",
      ...policyInput,
    });
    expect(issued.token).toMatch(/^mcp_/);
    expect(issued.endpoint).toBe("http://127.0.0.1:9820/api/mcp");
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
    expect(registry.dispatchForSession({
      owner: "alice",
      runtimeDevice: "runner1",
      source: "codex",
      sessionId: "thread-split",
    })).toBeNull();
    issued.bindSession("codex", "thread-split");
    expect(registry.dispatchForSession({
      owner: "alice",
      runtimeDevice: "runner1",
      source: "codex",
      sessionId: "thread-split",
    })).toMatchObject({
      token: issued.token,
      endpoint: issued.endpoint,
      operationId: "op_12345678",
      executionDevice: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
    });
    expect(registry.dispatchForSession({
      owner: "alice",
      runtimeDevice: "runner1",
      source: "claude",
      sessionId: "thread-split",
    })).toBeNull();
    expect(workspaceCapabilities.open).toHaveBeenCalledWith(expect.objectContaining({
      username: "alice",
      kind: "agent-run",
      rights: [
        "list_session_workspaces",
        "list_workspace_entries",
        "access_owner_files",
        "read_workspace_text",
        "read_workspace_binary",
        "download_workspace_file",
        "replace_workspace_text",
      ],
      autoAllow: [],
      metadata: { surface: "session-execution", operation: "op_12345678" },
    }));
    expect(executionCapabilities.open).toHaveBeenCalledWith(expect.objectContaining({
      username: "alice",
      autoAllow: [],
      metadata: { surface: "session-execution", operation: "op_12345678" },
    }));
    expect(workspaceCapabilities.open).not.toHaveBeenCalledWith(expect.objectContaining({ username: "lht" }));
    expect(executionCapabilities.open).not.toHaveBeenCalledWith(expect.objectContaining({ username: "lht" }));
    expect(store.getSessionExecutionBinding(
      "alice", "runner1", "codex", "thread-split", "0000-01-01T00:00:00.000Z",
    )).toMatchObject({
      runtime_owner: "lht",
      runtime_resource_id: "agent-runtime:0123456789abcdef0123456789abcdef",
      execution_device: "val15",
    });
    const tokenHash = hashRunnerToken(issued.token);
    const credential = mcpCredentialOf(tokenHash);
    const principal = {
      owner: "alice",
      credential,
      policy: mcpSessionExecutionPolicy(policyInput),
    };
    expect(registry.resolve(principal)).toMatchObject({
      owner: "alice",
      executionDevice: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
    });
    expect(registry.workspacePort(principal)).toBe(workspacePort);
    // The scope's backend stages a save past one call's window, like every
    // other workspace-files scope; without these it would answer read_only.
    expect((workspaceFilesService.open.mock.calls[0] as unknown as [{ backend: object }])[0].backend).toMatchObject({
      stageText: expect.any(Function),
      commitStagedText: expect.any(Function),
    });
    await expect(registry.runCommand(principal, { command: "pwd", timeout_ms: 5_000 }))
      .resolves.toEqual({ ok: true, result: { stdout: "ok" } });
    expect(requestCommand).toHaveBeenCalledWith("run_workspace_command", {
      device: "val15",
      workspace_id: "ws_0123456789abcdef01234567",
      command: "pwd",
      timeout_ms: 5_000,
    });
    expect(registry.authorizeRelay({
      token: issued.token,
      owner: "alice",
      runtimeDevice: "runner1",
      executionDevice: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
      method: "codex_exec_open",
    })).toBe(true);
    // A resumed Codex environment needs a fresh upstream connection under the same scope.
    expect(registry.authorizeRelay({
      token: issued.token,
      owner: "alice",
      runtimeDevice: "runner1",
      executionDevice: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
      method: "codex_exec_reconnect",
    })).toBe(true);
    expect(registry.authorizeRelay({
      token: issued.token,
      owner: "alice",
      runtimeDevice: "runner1",
      executionDevice: "val15",
      workspaceId: "ws_other",
      method: "codex_exec_open",
    })).toBe(false);
    expect(registry.authorizeRelay({
      token: issued.token,
      owner: "alice",
      runtimeDevice: "runner1",
      executionDevice: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
      method: "exec",
    })).toBe(false);

    issued.release();
    expect(registry.resolve(principal)).toBeNull();
    expect(registry.dispatchForSession({
      owner: "alice",
      runtimeDevice: "runner1",
      source: "codex",
      sessionId: "thread-split",
    })).toBeNull();
    expect(registry.authorizeRelay({
      token: issued.token,
      owner: "alice",
      runtimeDevice: "runner1",
      executionDevice: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
      method: "codex_exec_open",
    })).toBe(false);
    expect(store.getActiveMcpTokenByHash(tokenHash, new Date(Date.now() + 1_000).toISOString())).toBeUndefined();
    expect(closeScope).toHaveBeenCalledOnce();
    expect(destroyExecution).toHaveBeenCalledOnce();
    expect(destroyWorkspace).toHaveBeenCalledOnce();
    registry.close();
    store.close();
  });

  it.each(["recovery", "dispatch"] as const)("restores without a bearer and refuses %s after durable revocation", (path) => {
    const dir = mkdtempSync(join(tmpdir(), "session-execution-restart-"));
    dirs.push(dir);
    const store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: "2026-08-18T00:00:00.000Z" });
    const now = Date.parse("2026-08-25T09:00:00.000Z");
    const workspaceCapabilities = {
      open: vi.fn(() => ({ contextId: "ctx_workspace", destroy: vi.fn() })),
    };
    const executionCapabilities = {
      open: vi.fn(() => ({ request: vi.fn(), destroy: vi.fn() })),
    };
    const workspaceFilesService = {
      open: vi.fn(() => ({ listRoots: vi.fn(async () => ({ ok: true, value: [] })) })),
      closeScope: vi.fn(async () => {}),
    };
    const options = {
      store,
      workspaceCapabilities: workspaceCapabilities as never,
      executionCapabilities: executionCapabilities as never,
      workspaceFilesService: workspaceFilesService as never,
      dashboardPort: 9820,
      now: () => now,
    };
    const policy = {
      operationId: "op_restart_1234",
      runtimeDevice: "runner1",
      executionDevice: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
      permissionProfile: "full_access" as const,
    };
    const before = new SessionExecutionRegistry(options);
    const issued = before.issue({ owner: "alice", ...policy });
    issued.bindSession("codex", "thread-restart");
    const oldHash = hashRunnerToken(issued.token);
    const durable = store.getSessionExecutionBinding(
      "alice",
      "runner1",
      "codex",
      "thread-restart",
      new Date(now).toISOString(),
    );
    expect(durable).toMatchObject({
      token_hash: oldHash,
      execution_device: "val15",
      workspace_id: policy.workspaceId,
    });
    expect(JSON.stringify(durable)).not.toContain(issued.token);

    // Bot shutdown destroys process-local grants but deliberately leaves the
    // original short-lived token and its bearer-free binding intact.
    before.close();
    expect(store.getActiveMcpTokenByHash(oldHash, new Date(now).toISOString())).toBeDefined();

    const after = new SessionExecutionRegistry(options);
    expect(after.restore()).toBe(1);
    expect(after.authorizeRelay({
      token: issued.token,
      owner: "alice",
      runtimeDevice: "runner1",
      executionDevice: "val15",
      workspaceId: policy.workspaceId,
      method: "codex_exec_open",
    })).toBe(true);
    expect(after.issueRecovery({
      owner: "alice",
      runtimeDevice: "other-runner",
      source: "codex",
      sessionId: "thread-restart",
    })).toBeNull();

    const rotated = after.issueRecovery({
      owner: "alice",
      runtimeDevice: "runner1",
      source: "codex",
      sessionId: "thread-restart",
    });
    expect(rotated).toMatchObject({
      executionDevice: "val15",
      workspaceId: policy.workspaceId,
    });
    expect(rotated!.token).toMatch(/^mcp_/);
    expect(rotated!.token).not.toBe(issued.token);
    expect(rotated!.expiresAt).toBe(issued.expiresAt);
    expect(after.authorizeRelay({
      token: issued.token,
      owner: "alice",
      runtimeDevice: "runner1",
      executionDevice: "val15",
      workspaceId: policy.workspaceId,
      method: "codex_exec_open",
    })).toBe(false);
    expect(after.authorizeRelay({
      token: rotated!.token,
      owner: "alice",
      runtimeDevice: "runner1",
      executionDevice: "val15",
      workspaceId: policy.workspaceId,
      method: "codex_exec_open",
    })).toBe(true);
    expect(store.getSessionExecutionBinding(
      "alice",
      "runner1",
      "codex",
      "thread-restart",
      new Date(now).toISOString(),
    )?.token_hash).toBe(hashRunnerToken(rotated!.token));

    const beforeRevocation = workspaceCapabilities.open.mock.calls.length;
    store.revokeMcpToken("alice", hashRunnerToken(rotated!.token), new Date(now).toISOString());
    // Storage changes before process-local revoke notification: neither
    // recovery nor an ordinary dispatch may resurrect that authority.
    const identity = { owner: "alice", runtimeDevice: "runner1", source: "codex", sessionId: "thread-restart" };
    if (path === "dispatch") expect(after.dispatchForSession(identity)).toBeNull();
    expect(after.issueRecovery(identity)).toBeNull();
    expect(after.dispatchForSession(identity)).toBeNull();
    expect(workspaceCapabilities.open).toHaveBeenCalledTimes(beforeRevocation);

    after.releaseOwner("alice");
    after.close();
    store.close();
  });
});

describe("SessionExecutionRegistry on-demand scopes", () => {
  const WS = "ws_0123456789abcdef01234567";

  function harness(options: {
    roots?: boolean;
    online?: boolean;
    devicesByOwner?: Record<string, string[]>;
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "session-execution-od-"));
    dirs.push(dir);
    const store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: "2026-08-18T00:00:00.000Z" });
    const grantRequest = vi.fn(async (operation: string) => operation === "list_session_workspaces"
      ? { status: "succeeded" as const, result: { workspaces: [{ id: WS, label: "proj" }] } }
      : { status: "denied" as const, reason: "no" });
    const workspaceCapabilities = {
      open: vi.fn(() => ({ contextId: "ctx_workspace", request: grantRequest, destroy: vi.fn(), close: vi.fn() })),
    };
    const executionCapabilities = {
      open: vi.fn(() => ({ request: vi.fn(), destroy: vi.fn() })),
    };
    const refreshRoots = vi.fn(async () => options.roots === false
      ? { ok: false as const, code: "not_found", message: "gone" }
      : { ok: true as const, value: { roots: [{ ref: "wf_root", label: "proj", sourceLabel: "val15" }], truncated: false } });
    const workspaceFilesService = {
      open: vi.fn(() => ({ refreshRoots })),
      closeScope: vi.fn(async () => {}),
    };
    const devices = vi.fn((owner: string) => {
      if (options.devicesByOwner) {
        return (options.devicesByOwner[owner] ?? []).map((device) => ({
          device,
          online: true,
          created_at: "2026-08-17T00:00:00.000Z",
          last_seen_at: null,
          inventory: {
            schema: "runner-inventory/v1",
            agent_backends: [],
            execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 1, codex_exec_server: false },
          } as never,
        }));
      }
      return [
        {
          device: "val15",
          online: options.online ?? true,
          created_at: "2026-08-17T00:00:00.000Z",
          last_seen_at: null,
          inventory: {
            schema: "runner-inventory/v1",
            agent_backends: [],
            execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 1, codex_exec_server: false },
          } as never,
        },
        { device: "phone", online: true, created_at: "2026-08-17T00:00:00.000Z", last_seen_at: null },
      ];
    });
    const registry = new SessionExecutionRegistry({
      store,
      workspaceCapabilities: workspaceCapabilities as never,
      executionCapabilities: executionCapabilities as never,
      workspaceFilesService: workspaceFilesService as never,
      devices,
      dashboardPort: 9820,
    });
    return { store, registry, workspaceCapabilities, executionCapabilities, workspaceFilesService, grantRequest, devices };
  }

  it("keeps local bridge scopes beyond bearer TTL and releases only affected devices", async () => {
    vi.useFakeTimers();
    const { registry, store, executionCapabilities, workspaceCapabilities } = harness({
      devicesByOwner: { alice: ["val15", "windows"] },
    });
    try {
      const ci = await registry.openLocalAgent({ owner: "alice", runtimeDevice: "aws-local",
        executionDevice: "val15", workspaceId: WS, permissionProfile: "full_access" });
      const windows = await registry.openLocalAgent({ owner: "alice", runtimeDevice: "aws-local",
        executionDevice: "windows", workspaceId: WS, permissionProfile: "full_access" });
      await vi.advanceTimersByTimeAsync(25 * 60 * 60_000);
      expect(ci.isActive()).toBe(true);
      expect(registry.resolve(ci.principal)).not.toBeNull();
      for (const [options] of (executionCapabilities.open.mock.calls as unknown as [unknown][])) expect(options).not.toHaveProperty("pool");
      for (const [options] of (workspaceCapabilities.open.mock.calls as unknown as [unknown][])) expect(options).not.toHaveProperty("pool");
      registry.releaseDevice("alice", "windows");
      expect(windows.isActive()).toBe(false);
      expect(ci.isActive()).toBe(true);
      registry.releaseDevice("alice", "aws-local");
      expect(ci.isActive()).toBe(false);
      expect(registry.resolve(ci.principal)).toBeNull();
    } finally { registry.close(); store.close(); vi.useRealTimers(); }
  });

  it("reclaims a connection-bound scope if workspace verification throws", async () => {
    const { registry, store, executionCapabilities, workspaceCapabilities, workspaceFilesService } = harness();
    workspaceFilesService.open.mockImplementation(() => ({ refreshRoots: vi.fn(async () => { throw new Error("runner lost"); }) }));
    try {
      await expect(registry.openLocalAgent({ owner: "alice", runtimeDevice: "aws-local",
        executionDevice: "val15", workspaceId: WS, permissionProfile: "full_access" })).rejects.toThrow("runner lost");
      expect(executionCapabilities.open.mock.results[0].value.destroy).toHaveBeenCalledOnce();
      expect(workspaceCapabilities.open.mock.results[0].value.destroy).toHaveBeenCalledOnce();
      expect(store.listMcpTokens("alice")).toEqual([]);
    } finally { registry.close(); store.close(); }
  });

  it("lists only capable online devices, with the workspaces each reports", async () => {
    const { registry, store } = harness();
    await expect(registry.listTargets("alice")).resolves.toEqual([
      { device: "val15", online: true, shell: true, workspace_files: true, workspaces: [{ workspace_id: WS, label: "proj" }] },
    ]);
    registry.close();
    store.close();
  });

  it("reports a device that does not answer instead of listing it with no workspace", async () => {
    vi.useFakeTimers();
    const { registry, store, grantRequest } = harness({ devicesByOwner: { alice: ["val15", "laptop", "denied-box"] } });
    grantRequest.mockImplementation(async (_operation: string, args?: Record<string, unknown>) => {
      if (args?.device === "laptop") return await new Promise<never>(() => {});
      if (args?.device === "denied-box") return { status: "failed" as const, reason: "lost" } as never;
      return { status: "succeeded" as const, result: { workspaces: [{ id: WS, label: "proj" }] } };
    });
    try {
      const listing = registry.listTargets("alice");
      await vi.advanceTimersByTimeAsync(TARGET_WORKSPACES_BUDGET_MS);
      const targets = await listing;
      expect(targets.find((target) => target.device === "val15")).toMatchObject({ workspaces: [{ workspace_id: WS, label: "proj" }] });
      expect(targets.find((target) => target.device === "val15")).not.toHaveProperty("workspaces_unavailable");
      expect(targets.find((target) => target.device === "laptop")).toMatchObject({
        workspaces: [], workspaces_unavailable: expect.stringContaining("设备暂不响应"),
      });
      expect(targets.find((target) => target.device === "denied-box")).toMatchObject({
        workspaces: [], workspaces_unavailable: expect.stringContaining("没有返回工作区列表"),
      });
    } finally { registry.close(); store.close(); vi.useRealTimers(); }
  });

  it("binds a local-agent scope that names no workspace to the device's Home", async () => {
    const HOME = "ws_fedcba9876543210fedcba98";
    const { registry, store, grantRequest } = harness({ devicesByOwner: { alice: ["laptop"] } });
    grantRequest.mockImplementation(async () => ({ status: "succeeded" as const, result: { workspaces: [
      { id: WS, label: "proj", display: "~/proj" },
      { id: HOME, label: "Home", display: "~" },
    ] } }));
    try {
      const scope = await registry.openLocalAgent({ owner: "alice", runtimeDevice: "aws-local",
        executionDevice: "laptop", permissionProfile: "full_access" });
      expect(scope.workspaceId).toBe(HOME);
      const named = await registry.openLocalAgent({ owner: "alice", runtimeDevice: "aws-local",
        executionDevice: "laptop", workspaceId: WS, permissionProfile: "full_access" });
      expect(named.workspaceId).toBe(WS);
    } finally { registry.close(); store.close(); }
  });

  it("picks the scan home, then a Home label, then a single workspace", () => {
    expect(defaultTargetWorkspace([{ workspace_id: "a", label: "Home", display: "~/x" }, { workspace_id: "b", label: "mine", display: "~" }])).toBe("b");
    expect(defaultTargetWorkspace([{ workspace_id: "a", label: "proj" }, { workspace_id: "b", label: "Home" }])).toBe("b");
    expect(defaultTargetWorkspace([{ workspace_id: "a", label: "proj" }])).toBe("a");
    expect(defaultTargetWorkspace([{ workspace_id: "a", label: "x" }, { workspace_id: "b", label: "y" }])).toBeUndefined();
    expect(defaultTargetWorkspace([])).toBeUndefined();
  });

  it("rejects a local-agent target that exists only under another owner", async () => {
    const { registry, store, workspaceCapabilities, executionCapabilities, devices } = harness({
      devicesByOwner: { alice: ["alice-target"], bob: ["bob-only"] },
    });
    await expect(registry.listTargets("alice")).resolves.toEqual([
      expect.objectContaining({ device: "alice-target" }),
    ]);
    await expect(registry.openLocalAgent({
      owner: "alice",
      runtimeDevice: "alice-runtime",
      executionDevice: "bob-only",
      workspaceId: WS,
      permissionProfile: "full_access",
    })).rejects.toThrow(/不属于你/);
    expect(devices).toHaveBeenCalledWith("alice");
    expect(devices).not.toHaveBeenCalledWith("bob");
    expect(workspaceCapabilities.open).toHaveBeenCalledOnce();
    expect(executionCapabilities.open).not.toHaveBeenCalled();
    registry.close();
    store.close();
  });

  it("opens a verified scope behind a one-time pickup, bound to owner + issuer, and cascades on issuer release", async () => {
    const { registry, store, workspaceFilesService } = harness();
    const pickup = await registry.open({
      owner: "alice",
      issuer: "mcp:issuer01",
      device: "val15",
      workspaceId: WS,
      permissionProfile: "full_access",
      runtime: "dsh:web",
      ttlMs: 30 * 60_000,
    });
    expect(pickup).toMatchObject({ device: "val15", workspace_id: WS, permission_profile: "full_access" });
    expect(pickup.pickup).toMatch(/^pick_/);
    expect(JSON.stringify(pickup)).not.toMatch(/mcp_/);

    // Wrong owner / wrong issuer: nothing.
    expect(registry.redeem(pickup.pickup, { owner: "bob", credential: "mcp:issuer01" })).toBeNull();
    expect(registry.redeem(pickup.pickup, { owner: "alice", credential: "mcp:other" })).toBeNull();
    const issued = registry.redeem(pickup.pickup, { owner: "alice", credential: "mcp:issuer01" });
    expect(issued).not.toBeNull();
    expect(issued!.token).toMatch(/^mcp_/);
    expect(issued!.endpoint).toBe("http://127.0.0.1:9820/api/mcp");
    expect(issued!.expires_at).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    // Exactly once.
    expect(registry.redeem(pickup.pickup, { owner: "alice", credential: "mcp:issuer01" })).toBeNull();

    const tokenHash = hashRunnerToken(issued!.token);
    const child = {
      owner: "alice",
      credential: mcpCredentialOf(tokenHash),
      policy: mcpSessionExecutionPolicy({
        operationId: issued!.operation_id,
        runtimeDevice: "dsh:web",
        executionDevice: "val15",
        workspaceId: WS,
        permissionProfile: "full_access",
      }),
    };
    expect(registry.resolve(child)).toMatchObject({ executionDevice: "val15", workspaceId: WS });
    expect(workspaceFilesService.open).toHaveBeenCalledOnce();

    // Releasing the ISSUER credential takes its children with it.
    registry.releaseCredential("mcp:issuer01");
    expect(registry.resolve(child)).toBeNull();
    expect(store.getActiveMcpTokenByHash(tokenHash, new Date(Date.now() + 1_000).toISOString())).toBeUndefined();
    registry.close();
    store.close();
  });

  it("refuses an offline or incapable device, and releases a scope whose workspace is not registered", async () => {
    const offline = harness({ online: false });
    await expect(offline.registry.open({
      owner: "alice", issuer: "mcp:i", device: "val15", workspaceId: WS, permissionProfile: "manual", runtime: "dsh", ttlMs: 60_000,
    })).rejects.toThrow(/不在线/);
    await expect(offline.registry.open({
      owner: "alice", issuer: "mcp:i", device: "phone", workspaceId: WS, permissionProfile: "manual", runtime: "dsh", ttlMs: 60_000,
    })).rejects.toThrow(/不在线/);
    expect(offline.workspaceCapabilities.open).not.toHaveBeenCalled();
    offline.registry.close();
    offline.store.close();

    const missing = harness({ roots: false });
    await expect(missing.registry.open({
      owner: "alice", issuer: "mcp:i", device: "val15", workspaceId: WS, permissionProfile: "manual", runtime: "dsh", ttlMs: 60_000,
    })).rejects.toThrow(/没有登记/);
    expect(missing.workspaceFilesService.closeScope).toHaveBeenCalledOnce();
    expect(missing.store.listMcpTokens("alice").filter((row) => !row.revoked_at)).toEqual([]);
    missing.registry.close();
    missing.store.close();
  });
});
