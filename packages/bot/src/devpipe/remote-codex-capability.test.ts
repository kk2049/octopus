import { CapabilityService } from "@claude-bot/capability-kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { RUNNER_OPERATIONS } from "../runner/capability.js";
import type { RunnerTransport } from "../runner/gateway.js";
import {
  REMOTE_CODEX_OBJECT_PREFIX,
  REMOTE_CODEX_OPERATIONS,
  RemoteCodexCapabilities,
} from "./remote-codex-capability.js";

describe("RemoteCodexCapabilities", () => {
  let service: CapabilityService;
  let frames: Array<{ owner: string; method: string; args: Record<string, unknown> }>;
  let plane: RemoteCodexCapabilities;

  beforeEach(() => {
    service = new CapabilityService();
    frames = [];
    const transport: RunnerTransport = {
      dispatch: async (owner, method, args) => { frames.push({ owner, method, args }); return { tunnel_id: "t-1" }; },
      listDevices: () => [], isOnline: () => true, ping: async () => 1, disconnect: () => true,
      openDshTunnel: async () => { throw new Error("not used"); },
    };
    plane = new RemoteCodexCapabilities({
      service,
      transport,
      userExists: (name) => name === "lilei",
      hasDevice: (name) => name === "lilei",
    });
  });
  afterEach(() => service.close());

  it("is a separate versioned Object and does not widen runner-account-v9", () => {
    expect(REMOTE_CODEX_OBJECT_PREFIX).toBe("devpipe-remote-codex-v2");
    expect(Object.keys(REMOTE_CODEX_OPERATIONS).sort()).toEqual([
      "codex_agent_close", "codex_agent_open", "codex_agent_read", "codex_agent_read_session", "codex_agent_write",
    ]);
    for (const operation of Object.keys(REMOTE_CODEX_OPERATIONS)) {
      expect(RUNNER_OPERATIONS).not.toHaveProperty(operation);
    }
  });

  it("keeps the narrow transcript verb dedicated through the Runner boundary", async () => {
    const grant = plane.open("lilei", "dev-ticket/371/transcript")!;
    await grant.call("codex_agent_read_session", {
      device: "macbookpro",
      id: "01a037a9-c693-7000-b0a8-882278f43996",
      max_messages: 200,
      offset: 4,
    });
    expect(frames).toEqual([{
      owner: "lilei",
      method: "codex_agent_read_session",
      args: {
        device: "macbookpro",
        id: "01a037a9-c693-7000-b0a8-882278f43996",
        max_messages: 200,
        offset: 4,
      },
    }]);

    // The service face cannot be widened into another CLI namespace or a
    // device path even though Runner's general read_session supports both.
    await expect(grant.request("codex_agent_read_session", {
      device: "macbookpro",
      id: "01a037a9-c693-7000-b0a8-882278f43996",
      source: "claude",
    })).resolves.toMatchObject({ status: "denied" });
    await expect(grant.request("codex_agent_read_session", {
      device: "macbookpro",
      path: "/tmp/other.jsonl",
    })).resolves.toMatchObject({ status: "denied" });
    expect(frames).toHaveLength(1);
    grant.close();
  });

  it("dispatches relay operations under the fixed owner and declared args only", async () => {
    const grant = plane.open("lilei", "dev-ticket/358");
    expect(grant).not.toBeNull();
    await expect(grant!.call("codex_agent_open", {
      device: "macbookpro",
      relay_protocol: MACHINE_LIMITS.codexAgentRelayProtocol,
    }))
      .resolves.toEqual({ tunnel_id: "t-1" });
    expect(frames).toEqual([{
      owner: "lilei",
      method: "codex_agent_open",
      args: {
        device: "macbookpro",
        relay_protocol: MACHINE_LIMITS.codexAgentRelayProtocol,
      },
    }]);
    // The Gate refuses undeclared coordinates and malformed channels outright.
    await expect(grant!.request("codex_agent_open", { device: "macbookpro", command: "sh" }))
      .resolves.toMatchObject({ status: "denied" });
    await expect(grant!.request("codex_agent_write", {
      device: "macbookpro", tunnel_id: "t-1", channel: "loopback", data: "AA==",
    })).resolves.toMatchObject({ status: "denied" });
    expect(frames).toHaveLength(1);
    grant!.close();
  });

  it("admits bounded relay chunks without widening the capability Object", async () => {
    const grant = plane.open("lilei", "dev-ticket/477")!;
    const data = Buffer.alloc(MACHINE_LIMITS.codexAgentRelayChunkBytes, 0x61).toString("base64");
    await expect(grant.call("codex_agent_write", {
      device: "macbookpro",
      tunnel_id: "t-1",
      channel: "env",
      data,
      binary: true,
      frame_id: "frame-1",
      chunk_index: 0,
      chunk_count: 2,
    })).resolves.toEqual({ tunnel_id: "t-1" });
    expect(frames.at(-1)?.args).toMatchObject({
      frame_id: "frame-1",
      chunk_index: 0,
      chunk_count: 2,
    });

    await expect(grant.request("codex_agent_write", {
      device: "macbookpro",
      tunnel_id: "t-1",
      channel: "env",
      data: Buffer.alloc(MACHINE_LIMITS.codexAgentRelayChunkBytes + 3, 0x61).toString("base64"),
    })).resolves.toMatchObject({ status: "denied" });
    expect(frames).toHaveLength(1);
    grant.close();
  });

  it("fails closed for accounts without a registered device", () => {
    expect(plane.open("stranger", "dev-ticket/1")).toBeNull();
  });

  it("revocation kills a live grant's next call", async () => {
    const grant = plane.open("lilei", "dev-ticket/358")!;
    plane.revokeAccount("lilei");
    await expect(grant.request("codex_agent_read", { device: "macbookpro", tunnel_id: "t-1" }))
      .resolves.toMatchObject({ status: "denied" });
    expect(frames).toHaveLength(0);
  });
});
