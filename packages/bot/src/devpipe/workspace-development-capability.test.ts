import { CapabilityService } from "@claude-bot/capability-kernel";
import { afterEach, expect, it } from "vitest";
import { WorkspaceDevelopmentCapabilities, WORKSPACE_DEVELOPMENT_OPERATIONS } from "./workspace-development-capability.js";
import { RUNNER_OPERATIONS } from "../runner/capability.js";
import type { RunnerTransport } from "../runner/gateway.js";

const services: CapabilityService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
it("uses an independent closed Object and rechecks the trusted original parent on every call", async () => {
  const service = new CapabilityService(); services.push(service);
  const frames: unknown[] = []; let allowed = true;
  const workspaceId = "ws_" + "a".repeat(24);
  const transport: RunnerTransport = {
    dispatch: async (owner, method, args) => { frames.push({ owner, method, args }); return { accepted: true }; },
    listDevices: () => [], isOnline: () => true, ping: async () => 1, disconnect: () => true,
    openDshTunnel: async () => { throw new Error("unused"); },
  };
  const cap = new WorkspaceDevelopmentCapabilities({ service, transport, owner: "alice", device: "compute", workspaceId, authorized: () => allowed });
  const args = { workspace_id: workspaceId, repository_id: "octopus", development_id: "ticket-one", ticket_id: 1,
    request_id: "prepare-one", base_sha: "b".repeat(40), input: { url: "https://head.example.test/api/contrib/bundle/test", sha256: "c".repeat(64), bytes: 100 } };
  await cap.call("workspace_development_prepare", args);
  expect(frames).toEqual([{ owner: "alice", method: "workspace_development_prepare", args: { ...args, device: "compute" } }]);
  await expect(cap.call("workspace_development_prepare", { ...args, workspace_id: "ws_" + "d".repeat(24) })).rejects.toThrow("parent workspace mismatch");
  await expect(cap.call("workspace_development_prepare", { ...args, device: "other" })).rejects.toThrow();
  allowed = false;
  await expect(cap.call("workspace_development_prepare", args)).rejects.toThrow("authorization was revoked");
  expect(frames).toHaveLength(1);
  for (const method of Object.keys(WORKSPACE_DEVELOPMENT_OPERATIONS)) expect(RUNNER_OPERATIONS).not.toHaveProperty(method);
});
