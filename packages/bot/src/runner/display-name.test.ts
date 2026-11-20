import { expect, it } from "vitest";
import { normalizeRunnerDisplayName, runnerDisplayName, runnerDisplayNameKey } from "./display-name.js";
import { Store } from "../store/store.js";
it("normalizes bounded display text and scopes it to an owner without resolving identity", () => {
  const store = new Store(":memory:");
  try {
    for (const username of ["alice", "bob"]) store.saveUser({ username, uid: username === "alice" ? 1 : 2, home_dir: "/unused", created_at: "2026-09-15T00:00:00Z" });
    store.setSetting("alice", runnerDisplayNameKey("aws-workbench"), "aliyun");
    expect(runnerDisplayName(store, "alice", "aws-workbench")).toBe("aliyun");
    expect(runnerDisplayName(store, "bob", "aws-workbench")).toBeUndefined();
    expect(runnerDisplayName(store, "alice", "aliyun")).toBeUndefined();
    expect(normalizeRunnerDisplayName("  Ali\n Yun  ")).toBe("Ali Yun");
    expect(normalizeRunnerDisplayName("🙂".repeat(64))).toBe("🙂".repeat(64));
    for (const value of [" ", "x".repeat(65), "🙂".repeat(65), "nul\u0000name", 1]) expect(normalizeRunnerDisplayName(value)).toBeUndefined();
  } finally { store.close(); }
});
