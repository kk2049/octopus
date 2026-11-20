import { ResourceUnavailableError } from "../resources/recovery.js";
import { describe, expect, it, vi } from "vitest";
import { runRunnerTicketTurn, TicketRunnerAccess, TICKET_RUNNER_SUBJECT, type TicketRunnerConfig } from "./runner-ticket.js";
import type { TicketRunnerTurn } from "../store/repositories/ticket-runner.js";

const binding = { owner: "alice", device: "laptop", workspaceId: "ws_alice", source: "codex" as const };
const turn = (): TicketRunnerTurn => ({ id: "ticket-1-test", ticketId: 1, turn: 1, method: "start_session", args: { prompt: "do once" }, state: "prepared" });
const result = (state: string, more = {}) => ({ protocol: "runner-session-operation/v1", live_input: "steer-only/v1", operation_id: "ticket-1-test", state, ...more });

it("shares Claude usage only for the owner's explicitly shared Claude devices", () => {
  const claude = [{ id: "@default", label: "Claude" }];
  const devices = ["shared", "private-claude"].map((device) => ({ device, online: true,
    inventory: { ticket_options: { codex_accounts: [], claude_accounts: claude } } }));
  const access = new TicketRunnerAccess({ targets: { alice: { device: "shared", workspace_id: "parent", workspaces: [{ device: "shared", workspace_id: "parent" }] } },
    shared_pool: { owner: "alice", requesters: ["bob"], source_devices: ["shared", "private-claude"], claude_devices: ["shared"] },
  }, { listDevices: (owner: string) => owner === "alice" ? devices : [] } as never, {} as never, undefined, () => true);
  expect(access.quotaHosts("alice").map((host) => host.device)).toEqual(["shared", "private-claude"]);
  expect(access.quotaHosts("bob")).toEqual([{ key: JSON.stringify(["bob", "shared"]), device: "shared", label: "shared", online: true,
    accounts: [], claudeAccounts: claude }]);
  expect(access.quotaHosts("eve")).toEqual([]);
});

describe("Runner ticket reattachment", () => {
  it.each(["failed", "denied", "unknown"] as const)("keeps the Gate's %s result distinct across ticket dispatch", async (status) => {
    const request = vi.fn(async () => ({ status, reason: "precise binding refusal" }));
    const destroy = vi.fn();
    const read = vi.fn(async () => result("missing"));
    const access = new TicketRunnerAccess({ targets: {} }, { open: () => ({ request, call: read, destroy }) } as never,
      { effectiveFor: () => ({ entries: ["get_session_operation", "start_session"].map(operation => ({ operation, effective: true, autoAllow: true })) }) } as never);
    const op: TicketRunnerTurn = { ...turn(), args: { prompt: "do once", source: "codex", input_receipt: true } };
    const observed = vi.fn(async () => {});
    const out = await runRunnerTicketTurn({ turn: op, binding, access, save: vi.fn(), session: vi.fn(),
      detached: () => false, cancelled: () => false, observe: observed, pause: async () => {} });
    expect(out.receipt).toMatchObject({ state: status === "unknown" ? "unknown" : "failed", result: { error: "precise binding refusal" } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ state: status === "unknown" ? "unknown" : "failed" }));
    expect(destroy).toHaveBeenCalled();
    expect(op.receipt?.state).toBe(status === "unknown" ? undefined : "failed");
  });

  it("retains a definite refusal across restart without replaying a missing device operation", async () => {
    const op: TicketRunnerTurn = { ...turn(), state: "dispatched", receipt: {
      protocol: "runner-session-operation/v1", operation_id: "ticket-1-test", state: "failed",
      result: { code: "dispatch_refused", error: "original exact refusal" },
    } };
    const call = vi.fn(async () => result("missing"));
    const out = await runRunnerTicketTurn({ turn: op, binding, access: { call }, save: vi.fn(), session: vi.fn(),
      detached: () => false, cancelled: () => false });
    expect(out.receipt).toMatchObject({ state: "failed", result: { error: "original exact refusal" } });
    expect(call.mock.calls).toEqual([[binding, "get_session_operation", { operation_id: op.id }]]);
  });
  it("saves prepared session identity and keeps observing until the delayed original answer arrives", async () => {
    const calls = [result("running", { session_id: "late-native" }), result("running", { session_id: "late-native" }),
      result("succeeded", { session_id: "late-native", result: { result_text: "original answer" } })];
    const session = vi.fn();
    const call = vi.fn(async () => calls.shift());
    const pause = vi.fn(async () => { expect(session).toHaveBeenCalledWith("late-native"); });
    const out = await runRunnerTicketTurn({ turn: { ...turn(), state: "dispatched" }, binding, access: { call },
      save: vi.fn(), session, detached: () => false, cancelled: () => false, pause });
    expect(pause).toHaveBeenCalledTimes(2);
    expect(out.receipt?.result?.result_text).toBe("original answer");
    expect(call.mock.calls).toHaveLength(3);
    for (const args of call.mock.calls) expect(args).toEqual([binding, "get_session_operation", { operation_id: "ticket-1-test" }]);
  });
  it("writes dispatch intent before sending and reads the same execution after a lost ack", async () => {
    const op = turn();
    let sent = false;
    const save = vi.fn();
    const call = vi.fn(async (_binding, method) => {
      if (method === "start_session") { expect(save).toHaveBeenCalled(); sent = true; throw new Error("connection lost"); }
      return sent ? result("succeeded", { session_id: "real", result: { result_text: "done" } }) : result("missing");
    });
    const out = await runRunnerTicketTurn({ turn: op, binding, access: { call }, save, session: vi.fn(),
      detached: () => false, cancelled: () => false, pause: async () => {} });
    expect(out.receipt?.state).toBe("succeeded");
    expect(call.mock.calls.filter((row) => row[1] === "start_session")).toHaveLength(1);
  });
  it("reattaches after a service restart without a start or append", async () => {
    const op = { ...turn(), state: "dispatched" as const };
    const call = vi.fn(async () => result("succeeded", { session_id: "retained" }));
    await runRunnerTicketTurn({ turn: op, binding, access: { call }, save: vi.fn(), session: vi.fn(),
      detached: () => false, cancelled: () => false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(binding, "get_session_operation", { operation_id: op.id });
  });
  it("reports missing receipt after dispatch as unknown instead of replaying", async () => {
    const call = vi.fn(async () => result("missing"));
    const out = await runRunnerTicketTurn({ turn: { ...turn(), state: "dispatched" }, binding, access: { call },
      save: vi.fn(), session: vi.fn(), detached: () => false, cancelled: () => false });
    expect(out.receipt?.state).toBe("unknown");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("refuses an old Runner before any side effect", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    await expect(runRunnerTicketTurn({ turn: turn(), binding, access: { call }, save: vi.fn(), session: vi.fn(),
      detached: () => false, cancelled: () => false })).rejects.toThrow("尚不支持");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("requires the live-input contract before starting a new turn", async () => {
    const call = vi.fn(async () => result("missing", { live_input: undefined }));
    await expect(runRunnerTicketTurn({ turn: turn(), binding, access: { call }, save: vi.fn(), session: vi.fn(),
      detached: () => false, cancelled: () => false })).rejects.toThrow("升级工单会话所在 Runner");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("interrupts only the bound session, once, and retains its identity", async () => {
    let stopped = false;
    const call = vi.fn(async (_binding, method, args) => {
      if (method === "append_session") { expect(args).toMatchObject({ id: "original", interrupt: true }); stopped = true; }
      return result(stopped ? "failed" : "running", { session_id: "original" });
    });
    await runRunnerTicketTurn({ turn: { ...turn(), state: "dispatched" }, binding, access: { call }, save: vi.fn(),
      session: vi.fn(), detached: () => false, cancelled: () => true, pause: async () => {} });
    expect(call.mock.calls.filter((row) => row[1] === "append_session")).toHaveLength(1);
  });
  it("per-call permission does not leave a deferred background effect", async () => {
    const open = vi.fn();
    const access = new TicketRunnerAccess({ targets: {} }, { open } as never,
      { effectiveFor: () => ({ entries: [{ operation: "start_session", effective: true, autoAllow: false }] }) } as never);
    await expect(access.call(binding, "start_session", {})).rejects.toThrow("自动批准");
    expect(open).not.toHaveBeenCalled();
  });
  it("a revoked owner grant produces no Runner frame", async () => {
    const open = vi.fn();
    const access = new TicketRunnerAccess({ targets: {} }, { open } as never,
      { effectiveFor: () => ({ entries: [{ operation: "start_session", effective: false }] }) } as never);
    await expect(access.call(binding, "start_session", {})).rejects.toThrow("主人授权");
    expect(open).not.toHaveBeenCalled();
    expect(TICKET_RUNNER_SUBJECT.info.enforced).toBe(true);
  });
});

it("uses the real owner Gate, persists revocation, and cannot switch devices", async () => {
  const { Store } = await import("../store/store.js");
  const { RunnerCapabilities } = await import("../runner/capability.js");
  const { PermissionService } = await import("../permissions/service.js");
  const { seedTicketRunnerGrants, TICKET_RUNNER_OPERATIONS } = await import("./runner-ticket.js");
  const store = new Store(":memory:");
  const frames: unknown[] = [];
  const transport = {
    dispatch: async (owner: string, method: string, args: unknown) => { frames.push({ owner, method, args }); return result("missing"); },
    listDevices: () => [{ device: "laptop", online: true }],
    isOnline: () => true,
    disconnect: () => true,
  };
  const caps = new RunnerCapabilities(store, transport as never);
  const permissions = new PermissionService({ store, caps, subjects: [TICKET_RUNNER_SUBJECT] });
  try {
    store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: new Date().toISOString() });
    caps.mintDeviceToken("alice", "laptop");
    const config = { targets: { alice: { device: "laptop", workspace_id: "ws_test" } },
      initial_grants: { alice: { operations: [...TICKET_RUNNER_OPERATIONS], auto_allow: [...TICKET_RUNNER_OPERATIONS] } } };
    const access = new TicketRunnerAccess(config, caps, permissions);
    await expect(access.call(binding, "get_session_operation", { operation_id: "ticket-1-test" })).rejects.toThrow("主人授权");
    expect(frames).toHaveLength(0);
    seedTicketRunnerGrants(config, permissions);
    expect(permissions.get("service", "ticket-runner", "alice")?.source).toBe("bootstrap");
    await access.call(binding, "get_session_operation", { operation_id: "ticket-1-test" });
    expect(frames).toHaveLength(1);
    await expect(access.call({ ...binding, device: "service-host" }, "get_session_operation", { operation_id: "ticket-1-test" })).rejects.toThrow();
    expect(frames).toHaveLength(1);
    permissions.revoke({ subjectType: "service", subjectId: "ticket-runner", owner: "alice", by: "alice" });
    seedTicketRunnerGrants(config, permissions);
    await expect(access.call(binding, "get_session_operation", { operation_id: "ticket-1-test" })).rejects.toThrow("主人授权");
    expect(frames).toHaveLength(1);
  } finally { permissions.close(); store.close(); }
});

it.each(["runner_offline", "runner_timeout", "runner_gone"])("keeps a dispatched turn through the real Gate transport error (%s), but stops on revocation", async (code) => {
  const { Store } = await import("../store/store.js");
  const { RunnerCapabilities } = await import("../runner/capability.js");
  const { PermissionService } = await import("../permissions/service.js");
  const { seedTicketRunnerGrants, TICKET_RUNNER_OPERATIONS } = await import("./runner-ticket.js");
  const store = new Store(":memory:");
  let online = false;
  const frames: string[] = [];
  const transport = {
    dispatch: async (_owner: string, method: string) => {
      frames.push(method);
      if (!online) throw Object.assign(new Error("Runner 连接已断开"), { code });
      return result("succeeded", { session_id: "retained", result: { result_text: "original result" } });
    },
    listDevices: () => [{ device: "laptop", online }], isOnline: () => online, disconnect: () => true,
  };
  const caps = new RunnerCapabilities(store, transport as never);
  const permissions = new PermissionService({ store, caps, subjects: [TICKET_RUNNER_SUBJECT] });
  try {
    store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: new Date().toISOString() });
    caps.mintDeviceToken("alice", "laptop");
    const config = { targets: { alice: { device: "laptop", workspace_id: "ws_alice" } },
      initial_grants: { alice: { operations: [...TICKET_RUNNER_OPERATIONS], auto_allow: [...TICKET_RUNNER_OPERATIONS] } } };
    seedTicketRunnerGrants(config, permissions);
    const access = new TicketRunnerAccess(config, caps, permissions);
    const save = vi.fn();
    const pause = vi.fn(async () => { online = true; });
    const input = { turn: { ...turn(), state: "dispatched" as const }, binding, access, save,
      session: vi.fn(), detached: () => false, cancelled: () => false, pause };
    await expect(runRunnerTicketTurn(input)).resolves.toMatchObject({ receipt: { state: "succeeded", session_id: "retained" } });
    expect(frames).toEqual(["get_session_operation", "get_session_operation"]);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ receipt: expect.objectContaining({ state: "succeeded", session_id: "retained" }) }));
    online = false;
    await expect(runRunnerTicketTurn({ ...input, suspendOnUnavailable: true })).rejects.toBeInstanceOf(ResourceUnavailableError);
    permissions.revoke({ subjectType: "service", subjectId: "ticket-runner", owner: "alice", by: "alice" });
    await expect(runRunnerTicketTurn(input)).rejects.toThrow("主人授权");
    expect(frames).toHaveLength(3);
    expect(pause).toHaveBeenCalledTimes(1);
  } finally { permissions.close(); store.close(); }
});

it("keeps split starts on the runtime and attachment uploads on the bound execution workspace", async () => {
  const { Store } = await import("../store/store.js");
  const { RunnerCapabilities } = await import("../runner/capability.js");
  const { PermissionService } = await import("../permissions/service.js");
  const { seedTicketRunnerGrants, TICKET_RUNNER_OPERATIONS } = await import("./runner-ticket.js");
  const store = new Store(":memory:");
  const frames: unknown[] = [];
  const caps = new RunnerCapabilities(store, { dispatch: async (owner: string, method: string, args: unknown) => {
    frames.push({ owner, method, args });
    return method === "upload_session_file" ? { workspace_id: (args as { workspace_id: string }).workspace_id } : result("missing");
  }, listDevices: () => [{ device: "laptop", online: true }, { device: "4090", online: true }], isOnline: () => true, disconnect: () => true } as never);
  const permissions = new PermissionService({ store, caps, subjects: [TICKET_RUNNER_SUBJECT] });
  try {
    store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: "now" });
    caps.mintDeviceToken("alice", "laptop"); caps.mintDeviceToken("alice", "4090");
    const config = { targets: { alice: { device: "laptop", workspace_id: "ws_test" } },
      initial_grants: { alice: { operations: [...TICKET_RUNNER_OPERATIONS], auto_allow: [...TICKET_RUNNER_OPERATIONS] } } };
    seedTicketRunnerGrants(config, permissions);
    const access = new TicketRunnerAccess(config, caps, permissions);
    const split = { ...binding, executionDevice: "4090", codexAccount: "pool-b" };
    await access.call(split, "start_session", { source: "codex", prompt: "one task", client_request_id: "op_split_ticket", execution_device: "forged" });
    expect(frames).toEqual([{ owner: "alice", method: "start_session", args: expect.objectContaining({ device: "laptop", execution_device: "4090", workspace_id: "ws_alice", codex_account: "pool-b" }) }]);
    await access.call(split, "upload_session_file", { device: "forged", workspace_id: "forged", id: "ticket-578",
      name: "image.png", media_type: "image/png", chunk_index: 0, chunk_count: 1, data: "aGVsbG8=" });
    expect(frames[1]).toMatchObject({ owner: "alice", method: "upload_session_file",
      args: { device: "4090", workspace_id: "ws_alice", id: "ticket-578" } });
    await expect(access.call({ ...split, executionDevice: "other-owner" }, "start_session", {})).rejects.toThrow("属于工单主人");
    expect(frames).toHaveLength(2);
  } finally { permissions.close(); store.close(); }
});


it("does not silently add upload authority to existing ticket grants or accept an old Runner's temporary receipt", async () => {
  const open = vi.fn();
  const denied = new TicketRunnerAccess({ targets: {} }, { open } as never,
    { effectiveFor: () => ({ entries: [{ operation: "start_session", effective: true, autoAllow: true }] }) } as never);
  await expect(denied.call(binding, "upload_session_file", {})).rejects.toThrow("缺少 upload_session_file");
  expect(open).not.toHaveBeenCalled();
  const destroy = vi.fn();
  const call = vi.fn(async () => ({ complete: true, attachment: { path: "/tmp/wrong-machine.png" } }));
  const old = new TicketRunnerAccess({ targets: {} }, { open: () => ({ call, destroy }) } as never,
    { effectiveFor: () => ({ entries: [{ operation: "upload_session_file", effective: true, autoAllow: true }] }) } as never);
  await expect(old.call({ ...binding, executionDevice: "4090" }, "upload_session_file", {})).rejects.toThrow("未确认附件目标工作区");
  expect(destroy).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledOnce();
});

it("delegates only the configured ticket parent through the real owner's Gate and rechecks both grants", async () => {
  const { Store } = await import("../store/store.js");
  const { RunnerCapabilities } = await import("../runner/capability.js");
  const { PermissionService } = await import("../permissions/service.js");
  const { seedTicketRunnerGrants, TICKET_RUNNER_OPERATIONS } = await import("./runner-ticket.js");
  const store = new Store(":memory:");
  const frames: unknown[] = [];
  const caps = new RunnerCapabilities(store, {
    dispatch: async (owner: string, method: string, args: unknown) => { frames.push({ owner, method, args }); return result("missing"); },
    listDevices: () => [{ device: "laptop", online: true }, { device: "service-host", online: true }],
    isOnline: () => true, disconnect: () => true,
  } as never);
  const permissions = new PermissionService({ store, caps, subjects: [TICKET_RUNNER_SUBJECT] });
  try {
    store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: "now" });
    store.saveUser({ username: "bob", uid: 2, home_dir: "/unused", created_at: "now" });
    caps.mintDeviceToken("alice", "laptop"); caps.mintDeviceToken("alice", "service-host");
    const config = {
      targets: { alice: { device: "laptop", workspace_id: "parent", workspaces: [{ device: "laptop", workspace_id: "parent" }] } },
      shared_pool: { owner: "alice", requesters: ["bob"], source_devices: ["laptop"] },
      initial_grants: { alice: { operations: [...TICKET_RUNNER_OPERATIONS], auto_allow: [...TICKET_RUNNER_OPERATIONS] } },
    };
    let developer = true;
    const access = new TicketRunnerAccess(config, caps, permissions, undefined, (user) => user === "bob" && developer);
    seedTicketRunnerGrants(config, permissions);
    const shared = { ...binding, requester: "bob", parentWorkspaceId: "parent", workspaceId: "verified-child" };
    expect(access.resourceOwner("bob")).toBe("alice");
    expect(access.resourceOwner("eve")).toBe("eve");
    expect(access.devicesFor("bob").map((row) => row.device)).toEqual(["laptop"]);
    expect(permissions.get("service", "ticket-runner", "bob")).toBeNull();
    await access.call(shared, "get_session_operation", { operation_id: "ticket-1-test", device: "service-host" });
    expect(frames).toEqual([{ owner: "alice", method: "get_session_operation", args: { operation_id: "ticket-1-test", device: "laptop" } }]);
    for (const invalid of [{ ...shared, parentWorkspaceId: "private-root" }, { ...shared, requester: "eve" }, { ...shared, device: "service-host" }]) {
      await expect(access.call(invalid, "start_session", {})).rejects.toThrow("授权已撤销");
    }
    developer = false;
    await expect(access.call(shared, "get_session_operation", {})).rejects.toThrow("授权已撤销");
    developer = true;
    permissions.revoke({ subjectType: "service", subjectId: "ticket-runner", owner: "alice", by: "alice" });
    seedTicketRunnerGrants(config, permissions);
    expect(access.authorized(shared)).toBe(false);
    await expect(access.call(shared, "start_session", {})).rejects.toThrow("授权已撤销");
    expect(frames).toHaveLength(1);
  } finally { permissions.close(); store.close(); }
});

it("shares a fixed Codex package and only 4090 execution, never local aliyun or newly discovered accounts", async () => {
  // The explicit operator configuration (formerly synthesized in code from a
  // device fingerprint): two exact ticket roots, 4090 marked as the default.
  const config: TicketRunnerConfig = {
    targets: { lht: { device: "aws-workbench", workspace_id: "ws_8c410918a6511e9bee1b52be", workspaces: [
      { device: "gpu-box", workspace_id: "ws_c41327ecf8889e341e712b24", label: "4090", default: true },
      { device: "aws-workbench", workspace_id: "ws_8c410918a6511e9bee1b52be", label: "aliyun · aws-env" },
    ] } },
    shared_pool: { owner: "lht", requesters: [], all_developers: true, source_devices: ["aws-workbench"],
      workspaces: [{ device: "gpu-box", workspace_id: "ws_c41327ecf8889e341e712b24" }], split_only: true,
      codex_accounts: ["@default", "account_b", "account_c", "account_d"].map((account) => ({ device: "aws-workbench", account })) },
  };
  const devRoot = "ws_c41327ecf8889e341e712b24", modelRoot = config.targets.lht!.workspace_id;
  const device = (name: string, root: string) => ({ device: name, online: true, inventory: {
    schema: "runner-inventory/v1", agent_backends: [{ kind: "codex", available: true, split_execution: true }, { kind: "claude", available: true, split_execution: true }],
    execution: { shell: true, workspace_files: true, codex_exec_server: true, workspace_count: 1, platform: "linux", arch: "x64" },
    session_operations: { protocol: "runner-session-operation/v1" },
    workspace_development: { protocol: "workspace-development/v1", available: true, max_bundle_bytes: 134217728, max_artifact_chunk_bytes: 1048576 },
    ticket_options: { protocol: "ticket-options/v1", codex_accounts: ["@default", "account_a", "account_b", "account_c", "account_d", "new_account"]
      .map((id) => ({ id, label: id })), workspaces: [{ id: root, label: "workspace" }] },
  } });
  const devices = [device("aws-workbench", modelRoot), device("gpu-box", devRoot), device("aws-local", modelRoot)];
  let developer = true, granted = true;
  const call = vi.fn(async () => result("missing")), destroy = vi.fn(), open = vi.fn(() => ({ call, destroy }));
  const access = new TicketRunnerAccess(config, { listDevices: () => devices, open } as never,
    { effectiveFor: () => ({ entries: ["start_session", "append_session", "get_session_operation"].map((operation) => ({ operation, effective: granted, autoAllow: true })) }) } as never,
    undefined, (user) => user === "wfn" && developer);
  const key = (...parts: string[]) => JSON.stringify(parts);
  const options = access.choices("wfn");
  expect(options.sources.map((row) => row.id)).toEqual(["@default", "account_b", "account_c", "account_d"].map((id) => key("aws-workbench", "codex", id)));
  expect(options.workspaces.map((row) => row.id)).toEqual([key("gpu-box", devRoot)]);
  expect(options.workspace_default).toBe(key("gpu-box", devRoot));
  expect(access.choices("lht").workspaces).toHaveLength(2);
  expect(access.choices("lht").sources.some((row) => row.id === key("aws-workbench", "codex", "account_a"))).toBe(true);
  const shared = access.resolve("wfn", "codex-gpt-6-astra");
  expect(shared).toMatchObject({ owner: "lht", requester: "wfn", executionDevice: "gpu-box", parentWorkspaceId: devRoot, codexAccount: "@default" });
  const sourceDevice = devices.shift()!;
  // A reconnect temporarily removes live inventory, not the owner's static
  // delegation. Keep querying the exact operation; do not release its turn.
  expect(access.authorized(shared)).toBe(true);
  expect(access.choices("wfn").sources).toEqual([]);
  await access.call(shared, "get_session_operation", { operation_id: "original-turn" });
  expect(call).toHaveBeenLastCalledWith("get_session_operation", expect.objectContaining({ device: "aws-workbench", operation_id: "original-turn" }));
  devices.unshift(sourceDevice);
  open.mockClear(); call.mockClear();
  for (const account of ["account_a", "new_account"]) {
    expect(() => access.resolve("wfn", "codex-gpt-6-astra", key("aws-workbench", "codex", account))).toThrow("共享账号授权不可用");
    await expect(access.call({ ...shared, codexAccount: account }, "start_session", {})).rejects.toThrow("授权已撤销");
  }
  expect(() => access.resolve("wfn", "codex-gpt-6-astra", undefined, key("aws-workbench", modelRoot))).toThrow("工作区不可用");
  for (const invalid of [{ ...shared, executionDevice: "aws-workbench", parentWorkspaceId: modelRoot },
    { ...shared, device: "aws-local" }, { ...shared, source: "claude" as const }, { ...shared, codexAccount: undefined }]) {
    await expect(access.call(invalid, "append_session", {})).rejects.toThrow("授权已撤销");
  }
  expect(open).not.toHaveBeenCalled();
  await access.call(shared, "start_session", { execution_device: "aws-workbench", codex_account: "account_a" });
  expect(call).toHaveBeenCalledWith("start_session", expect.objectContaining({ device: "aws-workbench", execution_device: "gpu-box", codex_account: "@default" }));
  // Missing quota/plan metadata has no effect on the static grant; new inventory cannot expand it.
  devices[0]!.inventory.ticket_options.codex_accounts.push({ id: "new_pro", label: "new Pro" });
  expect(access.choices("wfn").sources.map((row) => row.id)).toEqual(options.sources.map((row) => row.id));
  config.shared_pool!.codex_accounts = [{ device: "aws-workbench", account: "account_b" }];
  expect(access.choices("wfn").source_default).toBe(key("aws-workbench", "codex", "account_b"));
  expect(access.resolve("wfn", "codex-gpt-6-astra").codexAccount).toBe("account_b");
  await expect(access.call(shared, "append_session", {})).rejects.toThrow("授权已撤销");
  config.shared_pool!.codex_accounts = [{ device: "aws-workbench", account: "@default" }];
  developer = false;
  expect(access.authorized(shared)).toBe(false);
  developer = true; granted = false;
  expect(access.authorized(shared)).toBe(false);
  granted = true;
  config.targets.lht!.workspaces = [];
  expect(access.authorized(shared)).toBe(false);
  expect(open).toHaveBeenCalledOnce();
});

it("shares Claude only on explicitly listed source devices, split into the shared workspace", async () => {
  const sharedRoot = "ws_shared", ownerRoot = "ws_owner";
  const device = (name: string, root: string, claudeSplit = true) => ({ device: name, online: true, inventory: {
    schema: "runner-inventory/v1", agent_backends: [{ kind: "codex", available: true, split_execution: true }, { kind: "claude", available: true, split_execution: claudeSplit }],
    execution: { shell: true, workspace_files: true, codex_exec_server: true, workspace_count: 1, platform: "linux", arch: "x64" },
    session_operations: { protocol: "runner-session-operation/v1" },
    workspace_development: { protocol: "workspace-development/v1", available: true, max_bundle_bytes: 134217728, max_artifact_chunk_bytes: 1048576 },
    ticket_options: { protocol: "ticket-options/v1", codex_accounts: [{ id: "@default", label: "codex" }], workspaces: [{ id: root, label: "workspace" }] },
  } });
  const devices = [device("model-a", ownerRoot), device("model-b", ownerRoot), device("tools", sharedRoot)];
  const config = {
    targets: { lht: { device: "model-a", workspace_id: ownerRoot, workspaces: [{ device: "tools", workspace_id: sharedRoot }] } },
    shared_pool: { owner: "lht", requesters: [], all_developers: true, source_devices: ["model-a", "model-b"],
      workspaces: [{ device: "tools", workspace_id: sharedRoot }], split_only: true,
      codex_accounts: [{ device: "model-a", account: "@default" }], claude_devices: ["model-b"] },
  };
  const call = vi.fn(async () => result("missing")), open = vi.fn(() => ({ call, destroy: vi.fn() }));
  const access = new TicketRunnerAccess(config, { listDevices: () => devices, open } as never,
    { effectiveFor: () => ({ entries: ["start_session", "append_session", "get_session_operation"].map((operation) => ({ operation, effective: true, autoAllow: true })) }) } as never,
    undefined, (user) => user === "dev");
  const key = (...parts: string[]) => JSON.stringify(parts);
  expect(access.choices("dev").sources.map((row) => row.id)).toEqual([key("model-a", "codex", "@default"), key("model-b", "claude", "@default")]);
  // A Claude model without an explicit source follows its provider, not the Codex default.
  const claude = access.resolve("dev", "claude-opus-5-5");
  expect(claude).toMatchObject({ owner: "lht", requester: "dev", device: "model-b", source: "claude", executionDevice: "tools", parentWorkspaceId: sharedRoot });
  expect(claude).not.toHaveProperty("codexAccount");
  expect(access.authorized(claude)).toBe(true);
  expect(access.resolve("dev", "codex-gpt-6-astra")).toMatchObject({ device: "model-a", source: "codex" });
  // Unlisted devices never share Claude, and same-device placement is not split.
  expect(() => access.resolve("dev", "claude-opus-5-5", key("model-a", "claude", "@default"))).toThrow("共享账号授权不可用");
  expect(access.authorized({ ...claude, device: "model-a" })).toBe(false);
  expect(access.authorized({ ...claude, executionDevice: "model-b" })).toBe(false);
  // Selecting a new source requires the backend's split support; an existing binding survives inventory loss.
  devices[1] = device("model-b", ownerRoot, false);
  expect(access.choices("dev").sources.map((row) => row.source)).toEqual(["codex"]);
  expect(access.authorized(claude)).toBe(true);
  config.shared_pool.claude_devices = [];
  expect(access.authorized(claude)).toBe(false);
  await expect(access.call(claude, "start_session", {})).rejects.toThrow("授权已撤销");
  expect(open).not.toHaveBeenCalled();
});
