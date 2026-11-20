import { describe, it, expect } from "vitest";
import { IndeterminateOutcome } from "@claude-bot/capability-kernel";
import { dispatchToRunner } from "./dispatch.js";
import type { RunnerTransport } from "./gateway.js";
import { ResourceUnavailableError, parseUnavailable } from "../resources/recovery.js";

function transportThat(error: Error & { code?: string }): RunnerTransport {
  return {
    dispatch: async () => { throw error; },
    listDevices: () => [],
    isOnline: () => false,
    ping: async () => null,
    disconnect: () => false,
    openDshTunnel: async () => { throw new Error("unused"); },
  };
}

describe("dispatchToRunner", () => {
  it("turns an offline device into a ResourceUnavailableError that names the resource", async () => {
    const err = Object.assign(new Error("设备 laptop 不在线或不属于你。当前在线: (无)"), { code: "runner_offline" });
    const binding = { owner: "alice", transport: transportThat(err) };
    const caught = await dispatchToRunner(binding, "exec", { device: "laptop", command: "true" }, { indeterminateOnLinkLoss: true })
      .then(() => null, (e: unknown) => e);
    expect(caught).toBeInstanceOf(ResourceUnavailableError);
    expect((caught as ResourceUnavailableError).resource).toBe("runner:alice/laptop");
    expect(parseUnavailable((caught as Error).message)?.resource).toBe("runner:alice/laptop");
  });

  it("uses `*` for the device when the operation named none", async () => {
    const err = Object.assign(new Error("用户 alice 当前没有在线的 Runner"), { code: "runner_offline" });
    const caught = await dispatchToRunner({ owner: "alice", transport: transportThat(err) }, "list_recent_sessions", {})
      .then(() => null, (e: unknown) => e);
    expect((caught as ResourceUnavailableError).resource).toBe("runner:alice/*");
  });

  it("still reports a lost link on an execute operation as indeterminate", async () => {
    const err = Object.assign(new Error("Runner 连接已断开"), { code: "runner_gone" });
    const caught = await dispatchToRunner({ owner: "alice", transport: transportThat(err) }, "exec", { device: "laptop" }, { indeterminateOnLinkLoss: true })
      .then(() => null, (e: unknown) => e);
    expect(caught).toBeInstanceOf(IndeterminateOutcome);
  });

  it.each(["runner_timeout", "runner_gone"])("keeps a failed read retryable through its resource marker (%s)", async (code) => {
    const err = Object.assign(new Error("link unavailable"), { code });
    const caught = await dispatchToRunner({ owner: "alice", transport: transportThat(err) }, "get_session_operation", { device: "laptop" })
      .then(() => null, (error: unknown) => error);
    expect(parseUnavailable(String(caught))?.resource).toBe("runner:alice/laptop");
  });

  it("passes every other error through unchanged", async () => {
    const err = new Error("runner error");
    const caught = await dispatchToRunner({ owner: "alice", transport: transportThat(err) }, "exec", { device: "laptop" })
      .then(() => null, (e: unknown) => e);
    expect(caught).toBe(err);
  });
});
