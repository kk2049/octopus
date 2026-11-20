import { CapabilityService } from "@claude-bot/capability-kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUNNER_OPERATIONS } from "../runner/capability.js";
import type { RunnerTransport } from "../runner/gateway.js";
import {
  KNOWLEDGE_INDEX_OBJECT_PREFIX,
  KNOWLEDGE_INDEX_OPERATIONS,
  KnowledgeIndexCapabilities,
} from "./capability.js";

const KEY = "1".repeat(64);
const SHA = "2".repeat(40);
const INPUT_SHA = "3".repeat(64);
const URL = `https://bot.example/api/contrib/bundle/bt_${"4".repeat(48)}`;

describe("KnowledgeIndexCapabilities", () => {
  let service: CapabilityService;
  let frames: Array<{ owner: string; method: string; args: Record<string, unknown> }>;
  let plane: KnowledgeIndexCapabilities;

  beforeEach(() => {
    service = new CapabilityService();
    frames = [];
    const transport: RunnerTransport = {
      dispatch: async (owner, method, args) => { frames.push({ owner, method, args }); return { state: "running" }; },
      listDevices: () => [], isOnline: () => true, ping: async () => 1, disconnect: () => true,
      openDshTunnel: async () => { throw new Error("not used"); },
    };
    plane = new KnowledgeIndexCapabilities({
      service, transport, owner: "alice", device: "val15", userExists: (name) => name === "alice",
      hasDevice: (name, device) => name === "alice" && device === "val15",
    });
    plane.resetAuthority();
  });
  afterEach(() => service.close());

  it("is a separate versioned Object and does not widen runner-account-v9", () => {
    expect(KNOWLEDGE_INDEX_OBJECT_PREFIX).toBe("knowledge-index-builder-v1");
    expect(Object.keys(KNOWLEDGE_INDEX_OPERATIONS).sort()).toEqual([
      "knowledge_index_cancel", "knowledge_index_read", "knowledge_index_start", "knowledge_index_status",
    ]);
    for (const operation of Object.keys(KNOWLEDGE_INDEX_OPERATIONS)) expect(RUNNER_OPERATIONS).not.toHaveProperty(operation);
  });

  it("injects the trusted device and fixed nested input after the kernel rejects undeclared coordinates", async () => {
    const grant = plane.open();
    expect(grant).not.toBeNull();
    await expect(grant!.call("knowledge_index_start", {
      job_key: KEY, repo_sha: SHA, input_url: URL, input_sha256: INPUT_SHA, input_bytes: 42,
    })).resolves.toEqual({ state: "running" });
    expect(frames).toEqual([{
      owner: "alice",
      method: "knowledge_index_start",
      args: { device: "val15", job_key: KEY, repo_sha: SHA, input: { url: URL, sha256: INPUT_SHA, bytes: 42 } },
    }]);
    await expect(grant!.request("knowledge_index_start", {
      job_key: KEY, repo_sha: SHA, input_url: URL, input_sha256: INPUT_SHA, input_bytes: 42,
      device: "other", command: "sh", path: "/etc/shadow",
    })).resolves.toMatchObject({ status: "denied" });
    expect(frames).toHaveLength(1);
    grant!.close();
  });

  it("never creates approval cards and revocation removes the internal service grant", async () => {
    const grant = plane.open()!;
    plane.revoke();
    await expect(grant.request("knowledge_index_status", { job_key: KEY })).resolves.toMatchObject({ status: "denied" });
    expect(frames).toHaveLength(0);
  });
});
