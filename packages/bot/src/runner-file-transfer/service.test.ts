import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { WorkspaceFileTransferStore, FILE_TRANSFER_CHUNK_BYTES } from "@claude-bot/runner/file-transfer";
import { addWorkspace } from "@claude-bot/runner/workspaces";
import { handleRpc } from "@claude-bot/runner/core";
import { RUNNER_INVENTORY_SCHEMA } from "@claude-bot/runner/inventory";
import type { RunnerDeviceStatus, RunnerTransport } from "../runner/gateway.js";
import { RunnerFileTransfers, type TransferCaller } from "./service.js";
import { FILE_TRANSFER_MCP_TOOLS, FILE_TRANSFER_OPERATIONS, TRANSFER_OPERATION } from "./protocol.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const hash = (data: Buffer) => "sha256:" + createHash("sha256").update(data).digest("hex");
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "octopus-copy-e2e-"));
  const endpoints = new Map<string, { home: string; root: string; workspace: string; store: WorkspaceFileTransferStore }>();
  for (const device of ["aws", "windows", "other"]) {
    const home = path.join(directory, device);
    const root = path.join(home, "workspace");
    await fs.mkdir(root, { recursive: true });
    const workspace = await addWorkspace(home, root, device);
    endpoints.set(device, { home, root, workspace: workspace.id, store: new WorkspaceFileTransferStore() });
  }
  const devices: RunnerDeviceStatus[] = [...endpoints.keys()].map((device) => ({
    device, online: true, created_at: "", last_seen_at: null,
    inventory: { schema: RUNNER_INVENTORY_SCHEMA, agent_backends: [],
      execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 1, codex_exec_server: false },
      file_transfer: { protocol: "workspace-file-transfer/v1" },
    },
  }));
  const service = new CapabilityService();
  const rawDispatch = async (owner: string, method: string, args: Record<string, unknown>) => {
    if (owner !== "alice") throw new Error("wrong owner reached transport");
    const endpoint = endpoints.get(String(args.device));
    if (!endpoint) throw new Error("unknown device");
    const response = await handleRpc(endpoint.home, { id: "rpc", method, args }, {
      executionOnly: true, allowMachineOps: true, fileTransfers: endpoint.store,
    });
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };
  const dispatch = vi.fn(rawDispatch);
  const transport = { dispatch, listDevices: () => devices } as unknown as RunnerTransport;
  const transfers = new RunnerFileTransfers({ service, transport, userExists: (owner) => owner === "alice",
    devices: (owner) => owner === "alice" ? devices : [] });
  let active = true;
  const caller: TransferCaller = { subject: { owner: "alice", device: "aws" }, mode: "full_access", isActive: () => active };
  const source = endpoints.get("windows")!;
  const destination = endpoints.get("aws")!;
  const args = { source_device: "windows", source_workspace_id: source.workspace, source_path: "binary.dat",
    destination_workspace_id: destination.workspace, destination_path: "分析 output.dat" };
  cleanups.push(
    () => fs.rm(directory, { recursive: true, force: true }),
    async () => { service.close(); },
    async () => { await Promise.all([...endpoints.values()].map((endpoint) => endpoint.store.close())); },
    () => transfers.close(),
  );
  const start = async (values = args, sourceCaller = caller) =>
    await transfers.call(sourceCaller, "octopus_copy_file", values) as { ok: boolean; result: Record<string, unknown> };
  const status = async (id: unknown, sourceCaller = caller) =>
    await transfers.call(sourceCaller, "octopus_get_file_transfer", { transfer_id: id }) as { ok: boolean; result: Record<string, unknown> };
  const settle = async (id: unknown) => {
    let result: Record<string, unknown> = {};
    await vi.waitFor(async () => {
      result = (await status(id)).result;
      expect(["completed", "failed", "cancelled", "indeterminate"]).toContain(result.state);
    }, { timeout: 5_000, interval: 10 });
    return result;
  };
  return { directory, endpoints, devices, transfers, service, dispatch, rawDispatch, caller, source, destination, args,
    start, status, settle, revokeOrigin: () => { active = false; } };
}

describe("authorized Runner-to-Runner file copies", () => {
  it("copies binary content larger than the old 8 MiB limit through bounded RPC chunks to the local Runner", async () => {
    const f = await fixture();
    const data = Buffer.alloc(9 * 1024 * 1024 + 37);
    for (let index = 0; index < data.length; index += 4093) data[index] = index % 256;
    await fs.writeFile(path.join(f.source.root, "binary.dat"), data);
    const start = await f.start();
    expect(start.ok).toBe(true);
    expect(start.result).toMatchObject({ state: "copying", destination: { device: "aws" } });
    expect(await f.settle(start.result.transfer_id)).toMatchObject({
      state: "completed", bytes_copied: String(data.length), total_bytes: String(data.length), digest: hash(data),
    });
    expect((await fs.readFile(path.join(f.destination.root, "分析 output.dat"))).equals(data)).toBe(true);
    for (const [, , args] of f.dispatch.mock.calls) {
      if (args.action === "write") expect(Buffer.from(String(args.data), "base64").length).toBeLessThanOrEqual(FILE_TRANSFER_CHUNK_BYTES);
    }
    expect((await fs.readdir(f.destination.root)).some((name) => name.endsWith(".part"))).toBe(false);
  });

  it("supports local-to-remote and remote-to-remote using the same registered endpoint bindings", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.destination.root, "binary.dat"), Buffer.from([0, 255, 1]));
    const third = f.endpoints.get("other")!;
    const push = await f.start({ ...f.args, source_device: "aws", source_workspace_id: f.destination.workspace,
      destination_device: "windows", destination_workspace_id: f.source.workspace } as typeof f.args);
    expect(await f.settle(push.result.transfer_id)).toMatchObject({ state: "completed" });
    const relay = await f.start({ ...f.args, source_path: f.args.destination_path,
      destination_device: "other", destination_workspace_id: third.workspace } as typeof f.args);
    expect(await f.settle(relay.result.transfer_id)).toMatchObject({ state: "completed" });
    expect(await fs.readFile(path.join(third.root, f.args.destination_path))).toEqual(Buffer.from([0, 255, 1]));
  });

  it("spends a separate modify capability once and manual approval resumes only its original immutable copy", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source.root, "binary.dat"), "approved");
    const opened = await f.start(f.args, { ...f.caller, mode: "manual" });
    expect(opened.result.state).toBe("approval_required");
    expect(f.dispatch).not.toHaveBeenCalled();
    const pending = String(opened.result.pending_call_id);
    expect(f.service.getPending(pending, "alice")?.details.join("\n")).toContain(f.args.destination_path);
    await expect(f.service.approve(pending, "bob")).resolves.toMatchObject({ status: "denied" });
    await expect(f.service.approve(pending, "alice")).resolves.toMatchObject({ status: "succeeded" });
    expect(await f.settle(opened.result.transfer_id)).toMatchObject({ state: "completed" });
    expect(f.dispatch.mock.calls.filter(([, , args]) => args.action === "open_write")).toHaveLength(1);
    expect(FILE_TRANSFER_OPERATIONS[TRANSFER_OPERATION]).toMatchObject({ effect: "modify", retrySafe: false });
    expect(f.service.hasObject("runner-file-transfer-v1:alice")).toBe(true);
    expect(f.service.hasObject("workspace-files-runner-v5:alice")).toBe(false);
  });

  it("refuses unknown arguments, foreign devices, old Runners and another origin's receipt", async () => {
    const f = await fixture();
    expect(await f.transfers.call(f.caller, "octopus_copy_file", { ...f.args, owner: "bob" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await f.transfers.call(f.caller, "octopus_copy_file", { ...f.args, source_device: "foreign" })).toMatchObject({ ok: false, code: "unavailable" });
    delete f.devices[1].inventory!.file_transfer;
    expect(await f.start()).toMatchObject({ ok: false, code: "unavailable" });
    f.devices[1].inventory!.file_transfer = { protocol: "workspace-file-transfer/v1" };
    await fs.writeFile(path.join(f.source.root, "binary.dat"), "");
    const opened = await f.start();
    expect(await f.status(opened.result.transfer_id, { ...f.caller, subject: { owner: "alice", device: "other" } })).toMatchObject({ ok: false });
    expect(await f.status(opened.result.transfer_id, { ...f.caller, subject: { owner: "bob", device: "aws" } })).toMatchObject({ ok: false });
    expect(await f.settle(opened.result.transfer_id)).toMatchObject({ state: "completed", bytes_copied: "0" });
  });

  it("cancels after a chunk without publishing or leaving staging files", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source.root, "binary.dat"), Buffer.alloc(FILE_TRANSFER_CHUNK_BYTES + 1));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.dispatch.mockImplementation(async (owner, method, args) => {
      const result = await f.rawDispatch(owner, method, args);
      if (args.action === "write") await gate;
      return result;
    });
    const opened = await f.start();
    await vi.waitFor(() => expect(f.dispatch.mock.calls.some(([, , args]) => args.action === "write")).toBe(true));
    expect(await f.transfers.call(f.caller, "octopus_cancel_file_transfer", { transfer_id: opened.result.transfer_id })).toMatchObject({ ok: true, result: { state: "cancelling" } });
    release();
    expect(await f.settle(opened.result.transfer_id)).toMatchObject({ state: "cancelled" });
    expect(await fs.readdir(f.destination.root)).toEqual([]);
  });

  it("rechecks origin authorization after every awaited read and never forwards revoked bytes", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source.root, "binary.dat"), "private");
    f.dispatch.mockImplementation(async (owner, method, args) => {
      const reply = await f.rawDispatch(owner, method, args);
      if (args.action === "read") f.revokeOrigin();
      return reply;
    });
    const opened = await f.start();
    // A reconnected client may inspect a receipt, but does not resume old work.
    let result: Record<string, unknown> = {};
    await vi.waitFor(async () => {
      result = (await f.status(opened.result.transfer_id, { ...f.caller, isActive: () => true })).result;
      expect(["failed", "cancelled"]).toContain(result.state);
    });
    expect(f.dispatch.mock.calls.some(([, , args]) => args.action === "write")).toBe(false);
    expect(await fs.readdir(f.destination.root)).toEqual([]);
  });

  it("fails closed on reply identity corruption and does not replay an uncertain commit", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source.root, "binary.dat"), "once");
    f.dispatch.mockImplementation(async (owner, method, args) => {
      const result = await f.rawDispatch(owner, method, args);
      return args.action === "read" ? { ...(result as object), stream_id: "spoof" } : result;
    });
    const corrupt = await f.start();
    expect(await f.settle(corrupt.result.transfer_id)).toMatchObject({ state: "failed" });
    expect(await fs.readdir(f.destination.root)).toEqual([]);
    f.dispatch.mockImplementation(async (owner, method, args) => {
      const result = await f.rawDispatch(owner, method, args);
      if (args.action === "commit") throw new Error("runner_gone after dispatch");
      return result;
    });
    const uncertain = await f.start();
    expect(await f.settle(uncertain.result.transfer_id)).toMatchObject({ state: "indeterminate" });
    expect(f.dispatch.mock.calls.filter(([, , args]) => args.action === "commit")).toHaveLength(1);
  });

  it("target revocation cancels pending approval without revoking unrelated origin transfers", async () => {
    const f = await fixture();
    const pending = await f.start(f.args, { ...f.caller, mode: "manual" });
    f.transfers.revokeDevice("alice", "windows");
    expect(await f.settle(pending.result.transfer_id)).toMatchObject({ state: "cancelled" });
    await expect(f.service.approve(String(pending.result.pending_call_id), "alice")).resolves.not.toMatchObject({ status: "succeeded" });
    expect(f.dispatch).not.toHaveBeenCalled();
    const tools = FILE_TRANSFER_MCP_TOOLS;
    expect(tools.map((tool) => tool.name)).toEqual(["octopus_copy_file", "octopus_get_file_transfer", "octopus_cancel_file_transfer"]);
    expect(tools[0].inputSchema.properties.expected_digest).toMatchObject({ pattern: "^(absent|sha256:[a-f0-9]{64})$" });
    expect(tools[0].inputSchema.additionalProperties).toBe(false);
  });
});
