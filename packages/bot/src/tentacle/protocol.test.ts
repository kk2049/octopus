import { describe, expect, it } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { Store } from "../store/store.js";
import { TentacleCapabilities } from "./capability.js";
import { cropProjection } from "./protocol.js";

const TOOL = {
  name: "bash",
  description: "run a command after local approval",
  parameters: {
    type: "object",
    properties: { command: { type: "string", maxLength: 2000 } },
    required: ["command"],
    additionalProperties: false,
  },
};

describe("tentacle capability Object definitions", () => {
  it("pins schema identity and casts a changed schema as a new Object", () => {
    const store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: "2026-08-14T00:00:00Z" });
    store.saveRunnerToken("rt-hash", "alice", "dsh:alpha", "2026-08-14T00:00:00Z");
    const service = new CapabilityService();
    const capabilities = new TentacleCapabilities(store, service, {} as never);
    try {
      const first = capabilities.castTool("alice", "dsh:alpha", TOOL);
      expect(capabilities.castTool("alice", "dsh:alpha", { ...TOOL })).toMatchObject({ object_id: first.object_id });
      const changed = capabilities.castTool("alice", "dsh:alpha", {
        ...TOOL,
        parameters: { ...TOOL.parameters, properties: { command: { type: "string", maxLength: 100 } } },
      });
      expect(changed.object_id).not.toBe(first.object_id);
      expect(() => capabilities.castTool("alice", "dsh:alpha", {
        ...TOOL,
        parameters: { type: "object", properties: { argv: { type: "array" } }, additionalProperties: false },
      })).toThrow(/not supported/);
    } finally {
      service.close();
      store.close();
    }
  });

  it("restores pinned Object definitions after the bot capability service restarts", () => {
    const store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: "2026-08-14T00:00:00Z" });
    store.saveRunnerToken("rt-hash", "alice", "dsh:alpha", "2026-08-14T00:00:00Z");
    const firstKernel = new CapabilityService();
    const object = new TentacleCapabilities(store, firstKernel, {} as never)
      .castTool("alice", "dsh:alpha", TOOL);
    firstKernel.close();
    const restartedKernel = new CapabilityService();
    try {
      const restored = new TentacleCapabilities(store, restartedKernel, {} as never);
      expect(restored.get(object.object_id)).toMatchObject({ schema_digest: object.schema_digest });
      expect(restartedKernel.hasObject(object.object_id)).toBe(true);
    } finally {
      restartedKernel.close();
      store.close();
    }
  });

  it("emits only viewer-safe event classes and removes private fields recursively", () => {
    expect(cropProjection("session-1", {
      op: "projection.event",
      args: {
        sourceSessionId: "session-1",
        event: {
          type: "assistant/message",
          seq: 7,
          time: 42,
          data: { text: "done", token: "secret", nested: { cwd: "/private", path: "/tmp/x", keep: true } },
        },
      },
    })).toEqual({
      op: "projection.event",
      args: {
        sourceSessionId: "session-1",
        event: { type: "assistant/message", seq: 7, time: 42, data: { text: "done", nested: { keep: true } } },
      },
    });
    expect(cropProjection("session-1", {
      op: "projection.event",
      args: { sourceSessionId: "session-1", event: { type: "approval/request", seq: 8, data: {} } },
    })).toBeNull();
  });
});
