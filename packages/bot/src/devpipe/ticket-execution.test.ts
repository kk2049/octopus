import { expect, it } from "vitest";
import type { RunnerDeviceStatus } from "../runner/gateway.js";
import { ticketExecutionOptions, resolveTicketExecution, withoutDiagnosticPaths } from "./ticket-execution.js";

const wid = `ws_${"1".repeat(24)}`;
const remoteWid = `ws_${"2".repeat(24)}`;
// Device names are fixture data only: which workspace is the default is
// configuration (`default: true`), never a device name the code knows.
const target = { device: "aws-workbench", workspace_id: wid, workspaces: [
  { device: "aws-workbench", workspace_id: wid },
  { device: "gpu-box", workspace_id: remoteWid, default: true },
] };
function device(name: string, workspaceId: string, accounts: NonNullable<NonNullable<RunnerDeviceStatus["inventory"]>["ticket_options"]>["codex_accounts"] = [{ id: "@default", label: "codex" }]): RunnerDeviceStatus {
  return { device: name, online: true, created_at: "now", last_seen_at: "now", inventory: {
    schema: "runner-inventory/v1", agent_backends: [{ kind: "codex", available: name !== "gpu-box", split_execution: true }],
    execution: { shell: true, workspace_files: true, codex_exec_server: true, workspace_count: 1, platform: "linux", arch: "x64" },
    session_operations: { protocol: "runner-session-operation/v1" },
    workspace_development: { protocol: "workspace-development/v1", available: true, max_bundle_bytes: 134217728, max_artifact_chunk_bytes: 1048576 },
    ticket_options: { protocol: "ticket-options/v1", codex_accounts: accounts, workspaces: [{ id: workspaceId, label: "Project" }] },
  } };
}
function fixtures() {
  const devices = [device("aws-local", wid, [{ id: "@default", label: "codex" }, { id: "pool-a", label: "codexa", emailLabel: "alice@example.com" }, { id: "pool-b", label: "codexb", emailLabel: "long-…@example.com" }]),
    device(target.device, wid), device("gpu-box", remoteWid)];
  return { devices, options: ticketExecutionOptions(devices, target) };
}
it("projects four independent Codex sources and defaults to the configured workspace", () => {
  const { options } = fixtures();
  expect(options.sources.filter((s) => s.source === "codex").map((s) => s.label)).toEqual(["aws-local · codex", "aws-local · alice@example.com", "aws-local · long-…@example.com", "aws-workbench · codex"]);
  expect(options.source_default).toBe(JSON.stringify([target.device, "codex", "@default"]));
  expect(options.workspace_default).toBe(JSON.stringify(["gpu-box", remoteWid]));
});
it("resolves distinct account and workspace identities without machine or home paths from the caller", () => {
  const { devices, options } = fixtures();
  const input = { owner: "alice", model: "codex-gpt-6-astra", devices, target };
  expect(resolveTicketExecution(input)).toEqual({ owner: "alice", device: target.device, source: "codex", codexAccount: "@default", executionDevice: "gpu-box", workspaceId: remoteWid });
  expect(resolveTicketExecution({ ...input, sourceId: options.sources.find((s) => s.label === "aws-local · long-…@example.com")!.id,
    workspaceId: JSON.stringify([target.device, wid]) })).toMatchObject({ device: "aws-local", codexAccount: "pool-b", executionDevice: target.device, workspaceId: wid });
  expect(() => resolveTicketExecution({ ...input, sourceId: JSON.stringify(["another-owner", "codex", "/secret"]) })).toThrow("来源不可用");
  expect(() => resolveTicketExecution({ ...input, workspaceId: "/home/other" })).toThrow("工作区不可用");
  expect(() => resolveTicketExecution({ ...input, model: "claude-opus-5", sourceId: options.source_default })).toThrow("模型不匹配");
});
it("refuses offline and unsupported split targets rather than falling back locally", () => {
  const { devices } = fixtures();
  const input = { owner: "alice", model: "codex-gpt-6-astra", devices, target };
  devices[2]!.inventory!.execution.codex_exec_server = false;
  expect(() => resolveTicketExecution(input)).toThrow("不支持分离执行");
  devices[2]!.online = false;
  expect(() => resolveTicketExecution(input)).toThrow("工作区不可用");
  expect(ticketExecutionOptions(devices, target).workspace_default).toBe(JSON.stringify(["gpu-box", remoteWid]));
});
it("does not manufacture registrations for an older Runner", () => {
  const { devices } = fixtures();
  delete devices[0]!.inventory!.ticket_options;
  const options = ticketExecutionOptions(devices, target);
  expect(options.sources.filter((source) => source.device === "aws-local" && source.source === "codex"))
    .toEqual([expect.objectContaining({ label: "aws-local · codex" })]);
});

it("allows a default account without named-account inventory only when durable operations are explicitly supported", () => {
  const { devices } = fixtures();
  delete devices[0]!.inventory!.ticket_options;
  const sourceId = JSON.stringify(["aws-local", "codex", "@default"]);
  const source = ticketExecutionOptions(devices, target).sources.find((s) => s.id === sourceId);
  expect(source).toMatchObject({ label: "aws-local · codex", available: true, split_execution: true });
  expect(source).not.toHaveProperty("reason");
  const input = { owner: "alice", model: "codex-gpt-6-astra", devices, target, sourceId };
  expect(resolveTicketExecution(input)).toEqual({
    owner: "alice", device: "aws-local", source: "codex", executionDevice: "gpu-box", workspaceId: remoteWid,
  });
  // No invented named-account slot or fallback to a different execution device.
  devices[0]!.inventory!.agent_backends[0]!.split_execution = false;
  expect(() => resolveTicketExecution(input)).toThrow("不支持分离执行");
});

it.each(["offline", "backend_unavailable"] as const)("refuses another device's default account when %s", (reason) => {
  const { devices } = fixtures();
  delete devices[0]!.inventory!.ticket_options;
  if (reason === "offline") devices[0]!.online = false;
  else devices[0]!.inventory!.agent_backends[0]!.available = false;
  const sourceId = JSON.stringify(["aws-local", "codex", "@default"]);
  const listed = ticketExecutionOptions(devices, target).sources.find((s) => s.id === sourceId);
  // An offline device stays listed (disabled); a backend the device reports as
  // unavailable is not offered at all unless it is the target device.
  if (reason === "offline") expect(listed).toMatchObject({ available: false, reason });
  else expect(listed).toBeUndefined();
  expect(() => resolveTicketExecution({ owner: "alice", model: "codex-gpt-6-astra", devices, target, sourceId })).toThrow("来源不可用");
});


it("keeps an old AWS backend visible but refuses it before a ticket can be created", () => {
  const { devices } = fixtures();
  delete devices[0]!.inventory!.session_operations;
  delete devices[0]!.inventory!.ticket_options;
  const sourceId = JSON.stringify(["aws-local", "codex", "@default"]);
  expect(ticketExecutionOptions(devices, target).sources.find((s) => s.id === sourceId))
    .toMatchObject({ available: false, reason: "runner_upgrade_required" });
  expect(() => resolveTicketExecution({ owner: "alice", model: "codex-gpt-6-astra", devices, target, sourceId }))
    .toThrow("aws-local 需要更新 Runner 的可恢复会话协议");
  expect(resolveTicketExecution({ owner: "alice", model: "codex-gpt-6-astra", devices, target }))
    .toMatchObject({ device: "aws-workbench", executionDevice: "gpu-box" });
});

it("does not treat generic workspace inventory as first-party development readiness", () => {
  const { devices } = fixtures();
  delete devices[2]!.inventory!.workspace_development;
  const workspaceId = JSON.stringify(["gpu-box", remoteWid]);
  expect(ticketExecutionOptions(devices, target).workspaces.find((w) => w.id === workspaceId))
    .toMatchObject({ available: false, reason: "runner_upgrade_required" });
  expect(() => resolveTicketExecution({ owner: "alice", model: "codex-gpt-6-astra", devices, target, workspaceId }))
    .toThrow("gpu-box 需要更新 Runner 的开发工作区协议");
});

it("respects a Runner explicitly disabling development while still offering files and shell", () => {
  const { devices } = fixtures();
  devices[2]!.inventory!.workspace_development!.available = false;
  expect(ticketExecutionOptions(devices, target).workspaces.find((w) => w.device === "gpu-box"))
    .toMatchObject({ available: false, reason: "workspace_unavailable" });
});


it("changes source and workspace presentation without changing persisted selectors or defaults", () => {
  const { devices, options: before } = fixtures();
  devices[1]!.display_name = "aliyun";
  const after = ticketExecutionOptions(devices, target);
  expect(after.sources.find((row) => row.id === before.source_default)?.label).toBe("aliyun · codex");
  expect(after.workspaces.find((row) => row.device === target.device)?.label).toBe("aliyun · Project");
  expect(after.sources.map(({ id }) => id)).toEqual(before.sources.map(({ id }) => id));
  expect(after.workspaces.map(({ id }) => id)).toEqual(before.workspaces.map(({ id }) => id));
  expect(after.source_default).toBe(before.source_default);
  expect(after.workspace_default).toBe(before.workspace_default);
  expect(resolveTicketExecution({ owner: "alice", model: "codex-gpt-6-astra", devices, target }))
    .toMatchObject({ device: "aws-workbench", executionDevice: "gpu-box", workspaceId: remoteWid });
});

it("only offers the configured development roots and keeps the configured default with unrelated registrations", () => {
  const { devices } = fixtures();
  devices.push(device("octopus-service", `ws_${"3".repeat(24)}`), device("ci", `ws_${"4".repeat(24)}`));
  devices[1]!.inventory!.ticket_options!.workspaces.unshift({ id: `ws_${"5".repeat(24)}`, label: "old-worktree" });
  devices[2]!.inventory!.ticket_options!.workspaces.push({ id: `ws_${"6".repeat(24)}`, label: "acceptance" });
  const options = ticketExecutionOptions(devices, target);
  expect(options.workspaces.map((row) => row.id)).toEqual([JSON.stringify([target.device, wid]), JSON.stringify(["gpu-box", remoteWid])]);
  expect(options.workspace_default).toBe(JSON.stringify(["gpu-box", remoteWid]));
  expect(() => resolveTicketExecution({ owner: "alice", model: "codex-gpt-6-astra", devices, target,
    workspaceId: JSON.stringify(["octopus-service", `ws_${"3".repeat(24)}`]) })).toThrow("工作区不可用");
});

it("honors exact configured workspace ids and refuses missing registrations", () => {
  const { devices } = fixtures();
  const configured = { ...target, workspaces: [{ device: "gpu-box", workspace_id: remoteWid }] };
  expect(ticketExecutionOptions(devices, configured).workspaces).toHaveLength(1);
  devices[2]!.inventory!.ticket_options!.workspaces = [];
  expect(ticketExecutionOptions(devices, configured).workspaces[0]).toMatchObject({ available: false, reason: "workspace_inventory_required" });
});

it("projects quota against the exact source account without using it as authorization", () => {
  const { devices } = fixtures();
  const quota = { status: "available" as const, fetchedAt: "2026-09-15T12:00:00Z", windows: [{ remainingPercent: 0, windowMinutes: 300, resetsAt: "2026-09-15T15:00:00Z" }] };
  devices[0]!.inventory!.ticket_options!.codex_accounts[1]!.quota = quota;
  expect(ticketExecutionOptions(devices, target).sources.find((source) => source.id === JSON.stringify(["aws-local", "codex", "pool-a"])))
    .toMatchObject({ quota, available: true });
});

it("carries the Runner's diagnostic and offending path to the owner, never to a shared requester", () => {
  const { devices } = fixtures();
  devices[1]!.inventory!.agent_backends = [{ kind: "codex", available: false, split_execution: false, reason: "probe_failed",
    diagnostic_code: "unsafe_permissions", diagnostic_detail: { path: "/home/alice/.local/bin", rule: "group_writable" } }];
  const source = ticketExecutionOptions(devices, target).sources.find((s) => s.device === target.device)!;
  expect(source).toMatchObject({ available: false, reason: "backend_unavailable",
    diagnostic: { code: "unsafe_permissions", path: "/home/alice/.local/bin", rule: "group_writable" } });
  const shared = withoutDiagnosticPaths([source])[0]!;
  expect(shared.diagnostic).toEqual({ code: "unsafe_permissions", rule: "group_writable" });
  expect(JSON.stringify(shared)).not.toContain("/home/alice");
  devices[1]!.inventory!.agent_backends = [{ kind: "codex", available: false, split_execution: false, reason: "authentication_unavailable" }];
  expect(ticketExecutionOptions(devices, target).sources.find((s) => s.device === target.device)?.diagnostic)
    .toEqual({ code: "authentication_unavailable" });
});

it("without a mark falls back to the first available configured workspace, then to the target root", () => {
  const { devices } = fixtures();
  const unmarked = { ...target, workspaces: [
    { device: "gpu-box", workspace_id: remoteWid },
    { device: "aws-workbench", workspace_id: wid },
  ] };
  expect(ticketExecutionOptions(devices, unmarked).workspace_default).toBe(JSON.stringify(["gpu-box", remoteWid]));
  // A missing mark must not leave ticket creation pinned to an offline root
  // while another configured root can run it.
  devices[2]!.online = false;
  expect(ticketExecutionOptions(devices, unmarked).workspace_default).toBe(JSON.stringify(["aws-workbench", wid]));
  expect(resolveTicketExecution({ owner: "alice", model: "codex-gpt-6-astra", devices, target: unmarked }))
    .toMatchObject({ executionDevice: "aws-workbench", workspaceId: wid });
  // An explicit mark stays the operator's choice even while it is offline.
  expect(ticketExecutionOptions(devices, target).workspace_default).toBe(JSON.stringify(["gpu-box", remoteWid]));
  devices[1]!.online = false;
  expect(ticketExecutionOptions(devices, unmarked).workspace_default).toBe(JSON.stringify(["gpu-box", remoteWid]));
  devices[1]!.online = true;
  devices[2]!.online = true;
  const bare = { device: target.device, workspace_id: wid };
  const options = ticketExecutionOptions(devices, bare);
  // Without configured roots only the target's own root is offered — no
  // workspace on another device is preferred by name.
  expect(options.workspaces.map((row) => row.id)).toEqual([JSON.stringify([target.device, wid])]);
  expect(options.workspace_default).toBe(JSON.stringify([target.device, wid]));
});
