import { CapabilityService, SqliteCapabilityStore } from "@claude-bot/capability-kernel";
import { expect, it, vi } from "vitest";
import type { RunnerTransport } from "../runner/gateway.js";
import { RUNNER_OPERATIONS } from "../runner/capability.js";
import { FORK_SESSION, SESSION_ANCHOR, SESSION_BRANCH_OBJECT_PREFIX, SessionBranchCapabilities } from "./capability.js";

it("reads anchors and forks sessions on the owner's own device, as its own Object beside the Runner's", async () => {
  const store = new SqliteCapabilityStore(":memory:");
  const service = new CapabilityService({ store });
  const dispatch = vi.fn(async (_owner: string, operation: string) => operation === SESSION_ANCHOR ? { anchor: "a".repeat(8) } : { session_id: "s-new", anchor: "a".repeat(8) });
  const transport = { dispatch } as unknown as RunnerTransport;
  try {
    const caps = new SessionBranchCapabilities({ service, transport, userExists: (owner) => owner === "alice", hasDevice: () => true });
    const args = { device: "laptop", source: "claude", id: "11111111-2222-4333-8444-555555555555" };
    // The card's own grant: this one operation, silently, on this one device.
    const quiet = caps.open({ username: "alice", purpose: "飞书文档 · 分叉会话", device: "laptop", rights: [FORK_SESSION], autoAllow: [FORK_SESSION] })!;
    expect((await quiet.request(FORK_SESSION, { ...args, anchor: "a".repeat(8), title: "分叉" })).status).toBe("succeeded");
    expect(dispatch).toHaveBeenLastCalledWith("alice", "fork_session", { ...args, anchor: "a".repeat(8), title: "分叉" });
    expect((await quiet.request(SESSION_ANCHOR, args)).status).toBe("denied");
    expect((await quiet.request(FORK_SESSION, { ...args, device: "desk" })).status).toBe("denied");
    expect((await quiet.request(FORK_SESSION, { ...args, source: "omp" })).status).toBe("denied");
    // Without the silent term a fork is the owner's decision.
    const asked = caps.open({ username: "alice", purpose: "test", device: "laptop", rights: [FORK_SESSION] })!;
    expect((await asked.request(FORK_SESSION, args)).status).toBe("approval_required");
    expect(caps.open({ username: "mallory", purpose: "test", rights: [FORK_SESSION] })).toBeNull();
    caps.revokeDevice("alice", "laptop");
    expect((await quiet.request(FORK_SESSION, args)).status).toBe("denied");
    expect(dispatch).toHaveBeenCalledTimes(1);
    // The Runner account Object's table is untouched, so its version line is too.
    expect(RUNNER_OPERATIONS).not.toHaveProperty(FORK_SESSION);
    expect(RUNNER_OPERATIONS).not.toHaveProperty(SESSION_ANCHOR);
    expect(SESSION_BRANCH_OBJECT_PREFIX).toBe("session-branch-runner-v1");
  } finally { service.close(); }
});
