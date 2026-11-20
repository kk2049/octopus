import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import { RunnerCapabilities } from "./capability.js";
import { hashRunnerToken, type RunnerTransport } from "./gateway.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-start-cap-"));
  store = new Store(join(dir, "state.db"));
  store.saveUser({ username: "alice", uid: 9001, home_dir: "/unused", created_at: new Date().toISOString() });
  store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", new Date().toISOString());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function transport(dispatch: RunnerTransport["dispatch"]): RunnerTransport {
  return {
    dispatch,
    listDevices: () => [],
    isOnline: () => true,
    ping: async () => 1,
    disconnect: () => true,
    openDshTunnel: async () => { throw new Error("unexpected DSH tunnel"); },
  };
}

const startArgs = {
  device: "laptop",
  workspace_id: "ws_0123456789abcdef01234567",
  workspace_label: "Octopus",
  workspace_display: "~/lht/octopus",
  source: "claude",
  prompt: "完成收尾",
  client_request_id: "op_12345678",
};

describe("Runner start_session capability", () => {
  it("a child without execute auto-allow queues public workspace evidence and no canonical path", async () => {
    const secret = "/canonical/secret/worktree";
    const caps = new RunnerCapabilities(store, transport(async () => ({ ok: true })));
    const grant = caps.open({
      username: "alice",
      purpose: "session-plus",
      kind: "controller-run",
      rights: ["start_session"],
      autoAllow: [],
    })!;
    const queued = await grant.request("start_session", startArgs);
    expect(queued.status).toBe("approval_required");
    const card = caps.listPending("alice")[0];
    const text = card.details.join("\n");
    expect(text).toContain("Octopus");
    expect(text).toContain("~/lht/octopus");
    expect(text).toContain("claude");
    expect(text).toContain("完成收尾");
    expect(text).toContain("op_12345678");
    expect(text).toContain("不是沙箱");
    expect(text).toContain("以该设备上你的系统账号运行");
    expect(text).not.toContain(secret);
  });

  it("lets the owner's explicitly trusted surface start directly", async () => {
    const frames: Record<string, unknown>[] = [];
    const caps = new RunnerCapabilities(store, transport(async (_owner, operation, args) => {
      frames.push({ operation, ...args });
      return { ok: true, session_id: "s-new" };
    }));
    const grant = caps.open({
      username: "alice",
      purpose: "session-plus-human",
      kind: "controller-run",
      rights: ["start_session"],
      autoAllow: ["start_session"],
    })!;
    expect(await grant.request("start_session", startArgs)).toMatchObject({ status: "succeeded" });
    expect(frames).toHaveLength(1);
    expect(caps.listPending("alice")).toHaveLength(0);
  });

  for (const code of ["runner_timeout", "runner_gone"] as const) {
    it(`classifies ${code} after an execute frame as unknown`, async () => {
      const caps = new RunnerCapabilities(store, transport(async () => {
        throw Object.assign(new Error("transport lost"), { code });
      }));
      const grant = caps.open({
        username: "alice",
        purpose: "session-plus",
        kind: "controller-run",
        rights: ["start_session"],
        autoAllow: [],
      })!;
      const queued = await grant.request("start_session", startArgs);
      expect(queued.status).toBe("approval_required");
      if (queued.status !== "approval_required") return;
      const decided = await caps.approve(queued.pendingCallId, "alice");
      expect(decided.status).toBe("unknown");
    });
  }

  it("does not turn a read transport timeout into an indeterminate mutation", async () => {
    const caps = new RunnerCapabilities(store, transport(async () => {
      throw Object.assign(new Error("read timed out"), { code: "runner_timeout" });
    }));
    const grant = caps.open({
      username: "alice",
      purpose: "session-plus",
      kind: "controller-run",
      rights: ["list_session_workspaces"],
      autoAllow: ["list_session_workspaces"],
    })!;
    expect(await grant.request("list_session_workspaces", { device: "laptop" })).toMatchObject({ status: "failed" });
  });
});
