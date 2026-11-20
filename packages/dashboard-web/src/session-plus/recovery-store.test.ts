import { describe, expect, it } from "vitest";
import { VIEW_RECOVERY_BYTES } from "@claude-bot/web-trust/frame-protocol";
import { createSessionPlusRecoveryStore } from "./recovery-store.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("Sessions+ browser recovery store", () => {
  it("keeps one browser checkpoint partitioned by account and App", () => {
    const storage = memoryStorage();
    const alice = createSessionPlusRecoveryStore({ storage, account: "alice", app: "session-plus" });
    const bob = createSessionPlusRecoveryStore({ storage, account: "bob", app: "session-plus" });
    alice.write("alice-checkpoint");
    bob.write("bob-checkpoint");
    expect(alice.read()).toBe("alice-checkpoint");
    expect(bob.read()).toBe("bob-checkpoint");
    expect([...storage.values.keys()]).toHaveLength(2);
  });

  it("disables account-shaped recovery for a shared-token viewer", () => {
    const storage = memoryStorage();
    const store = createSessionPlusRecoveryStore({ storage, account: null, app: "session-plus" });
    store.write("checkpoint");
    expect(store.read()).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  it("drops oversized values and degrades when browser storage throws", () => {
    const storage = memoryStorage();
    const store = createSessionPlusRecoveryStore({ storage, account: "alice", app: "session-plus" });
    store.write("x".repeat(VIEW_RECOVERY_BYTES + 1));
    expect(store.read()).toBeNull();

    const broken = createSessionPlusRecoveryStore({
      storage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } },
      account: "alice",
      app: "session-plus",
    });
    expect(() => broken.write("checkpoint")).not.toThrow();
    expect(broken.read()).toBeNull();
  });
});

it("reads the last browser checkpoint in a new store and uses old tab state only as a fallback", () => {
  const storage = memoryStorage();
  const legacyStorage = memoryStorage();
  const legacy = createSessionPlusRecoveryStore({ storage: legacyStorage, account: "alice", app: "session-plus" });
  legacy.write("legacy");
  const first = createSessionPlusRecoveryStore({ storage: () => storage, legacyStorage, account: "alice", app: "session-plus" });
  expect(first.read()).toBe("legacy");
  first.write("current");
  const reopened = createSessionPlusRecoveryStore({ storage, legacyStorage, account: "alice", app: "session-plus" });
  expect(reopened.read()).toBe("current");
  const blocked = createSessionPlusRecoveryStore({ storage: () => { throw new Error("private mode"); }, account: "alice", app: "session-plus" });
  expect(blocked.read()).toBeNull();
  expect(() => blocked.write("nope")).not.toThrow();
});
