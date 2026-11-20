import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "./store.js";

describe("Store Runner device policy", () => {
  it("defaults closed, survives credential rotation, and dies with the device", () => {
    const store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: "2026-08-25T00:00:00.000Z" });
    store.saveRunnerToken("hash-one", "alice", "laptop", "2026-08-25T00:00:00.000Z");
    expect(store.getRunnerDevicePolicy("alice", "laptop")).toBeUndefined();
    expect(store.setRunnerDefaultAgentInjection(
      "alice",
      "laptop",
      true,
      "2026-08-25T00:00:30.000Z",
      "alice",
    )).toBe(true);
    expect(store.setRunnerLocalAgentBridgeMode(
      "alice",
      "laptop",
      "full_access",
      "2026-08-25T00:01:00.000Z",
      "alice",
    )).toBe(true);
    expect(store.setRunnerGuiAutomationEnabled(
      "alice",
      "laptop",
      true,
      "2026-08-25T00:01:30.000Z",
      "alice",
    )).toBe(true);
    store.saveRunnerToken("hash-two", "alice", "laptop", "2026-08-25T00:02:00.000Z");
    expect(store.getRunnerTokenByHash("hash-one")).toBeUndefined();
    expect(store.getRunnerDevicePolicy("alice", "laptop")).toMatchObject({
      local_agent_bridge_mode: "full_access",
      default_agent_injection: 1,
      gui_automation_enabled: 1,
    });
    expect(store.deleteRunnerToken("alice", "laptop")).toBe(true);
    expect(store.getRunnerDevicePolicy("alice", "laptop")).toBeUndefined();
    expect(store.setRunnerLocalAgentBridgeMode(
      "alice",
      "missing",
      "manual",
      "2026-08-25T00:03:00.000Z",
      "alice",
    )).toBe(false);
    expect(store.setRunnerDefaultAgentInjection(
      "alice",
      "missing",
      true,
      "2026-08-25T00:03:00.000Z",
      "alice",
    )).toBe(false);
    expect(store.setRunnerGuiAutomationEnabled(
      "alice",
      "missing",
      true,
      "2026-08-25T00:03:00.000Z",
      "alice",
    )).toBe(false);
    store.close();
  });
});

describe("Store cross-user ACL rows", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("cross_user_acl upsert + get + list", () => {
    store.saveUser({
      username: "alice",
      uid: 3001,
      home_dir: "/tmp/users/alice",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    store.saveUser({
      username: "bob",
      uid: 3002,
      home_dir: "/tmp/users/bob",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    store.upsertCrossUserAcl({
      asker_username: "alice",
      target_username: "bob",
      allowed_tools: JSON.stringify(["history", "files"]),
      require_approval: 1,
      created_at: "2026-01-02T00:00:00.000Z",
    });

    const row = store.getCrossUserAcl("alice", "bob");
    expect(row).toBeDefined();
    expect(row!.allowed_tools).toBe(JSON.stringify(["history", "files"]));
    expect(row!.require_approval).toBe(1);

    const list = store.listCrossUserAclByAsker("alice");
    expect(list).toHaveLength(1);
    expect(list[0].target_username).toBe("bob");

    const ownerView = store.listCrossUserAclByTarget("bob");
    expect(ownerView).toHaveLength(1);
    expect(ownerView[0].asker_username).toBe("alice");
    expect(store.listCrossUserAclByTarget("alice")).toEqual([]);
  });
});
