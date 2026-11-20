import { CapabilityService, SqliteCapabilityStore } from "@claude-bot/capability-kernel";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceJobCapabilities, WORKSPACE_JOB_OPERATIONS, WORKSPACE_JOB_OBJECT_PREFIX } from "./workspace-job-capability.js";
import { RUNNER_OPERATIONS } from "../runner/capability.js";
import type { RunnerTransport } from "../runner/gateway.js";
const services: CapabilityService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
it("binds owner/device/workspace outside arguments and revokes existing rights", async () => {
  const service = new CapabilityService(); services.push(service); const frames: unknown[] = [];
  let registered = true;
  const transport: RunnerTransport = { dispatch: async (owner, method, args) => { frames.push({ owner, method, args }); return { state: "accepted" }; },
    listDevices: () => [], isOnline: () => true, ping: async () => 1, disconnect: () => true, openDshTunnel: async () => { throw new Error("unused"); } };
  const workspaceId = `ws_${"1".repeat(24)}`;
  const plane = new WorkspaceJobCapabilities({ service, transport, owner: "alice", device: "ci", workspaceId,
    userExists: (name) => name === "alice", hasDevice: (owner, device) => registered && owner === "alice" && device === "ci" });
  plane.resetAuthority(); const grant = plane.open()!;
  const args = { job_id: "task", workspace_key: "ticket-1", repo_sha: "a".repeat(40), command: `# ${"章鱼".repeat(10_000)}\npnpm test`, timeout_ms: 1000 };
  await grant.call("workspace_job_start", args);
  expect(frames).toEqual([{ owner: "alice", method: "workspace_job_start", args: { ...args, device: "ci", workspace_id: workspaceId } }]);
  await expect(grant.request("workspace_job_start", { ...args, device: "other", workspace_id: `ws_${"2".repeat(24)}` })).resolves.toMatchObject({ status: "denied" });
  expect(frames).toHaveLength(1);
  await expect(grant.request("workspace_job_start", { ...args, command: "x".repeat(512 * 1024) })).resolves.toMatchObject({ status: "denied" });
  expect(frames).toHaveLength(1);
  registered = false;
  expect(plane.open()).toBeNull();
  await expect(grant.request("workspace_job_status", { job_id: "task" })).resolves.toMatchObject({ status: "denied" });
  for (const name of Object.keys(WORKSPACE_JOB_OPERATIONS)) expect(RUNNER_OPERATIONS).not.toHaveProperty(name);
});

it.each(["v1", "v2"])("upgrades beside the persisted %s operation table without rewriting its identity", async (version) => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-cap-upgrade-")), file = join(dir, "cap.db");
  const oldId = `workspace-job-provider-${version}:alice`;
  const oldOperations = Object.keys(WORKSPACE_JOB_OPERATIONS).filter(name => version !== "v1" || name !== "workspace_job_artifact");
  const legacy = new SqliteCapabilityStore(file);
  legacy.putObject({ id: oldId, kind: "workspace-job-provider", metadata: { owner: "alice" }, operations: oldOperations });
  legacy.close();
  const repo = new SqliteCapabilityStore(file), service = new CapabilityService({ store: repo });
  const prior = repo.getObject(oldId);
  const frames: unknown[] = [];
  const transport: RunnerTransport = { dispatch: async (owner, method, args) => { frames.push({ owner, method, args }); return { eof: true }; },
    listDevices: () => [], isOnline: () => true, ping: async () => 1, disconnect: () => true, openDshTunnel: async () => { throw new Error("unused"); } };
  try {
    const plane = new WorkspaceJobCapabilities({ service, transport, owner: "alice", device: "ci", workspaceId: `ws_${"1".repeat(24)}`,
      userExists: () => true, hasDevice: () => true });
    expect(() => plane.resetAuthority()).not.toThrow();
    expect(WORKSPACE_JOB_OBJECT_PREFIX).toBe("workspace-job-provider-v3");
    expect(repo.getObject(oldId)).toEqual(prior);
    expect(repo.getObject(`${WORKSPACE_JOB_OBJECT_PREFIX}:alice`)).not.toBeNull();
    await plane.open()!.call("workspace_job_artifact", { job_id: "task", name: "release.json", offset: 0, length: 1024 });
    expect(frames).toEqual([expect.objectContaining({ method: "workspace_job_artifact", args: expect.objectContaining({ device: "ci", workspace_id: `ws_${"1".repeat(24)}` }) })]);
  } finally { service.close(); repo.close(); rmSync(dir, { recursive: true, force: true }); }
});
