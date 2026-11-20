import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import { UserManagerImpl } from "./manager.js";

describe("UserManager identity metadata", () => {
  let dataDir: string | undefined;
  let store: Store | undefined;

  afterEach(async () => {
    store?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("persists labels for arbitrary providers without changing identity keys", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "octopus-users-"));
    store = new Store(":memory:");
    const manager = new UserManagerImpl(store, dataDir);

    const alice = await manager.register("alice", {
      provider: "github",
      externalId: "123456",
      label: "alice-gh",
    });
    await manager.addIdentity("alice", {
      provider: "custom-provider",
      externalId: "stable-id",
      label: "Mutable Display Name",
    });

    expect(manager.resolve("github", "123456")).toBe(alice);
    expect(manager.resolve("custom-provider", "stable-id")).toBe(alice);
    expect(store.getIdentitiesByUser("alice")).toEqual([
      expect.objectContaining({ provider: "github", external_id: "123456", label: "alice-gh" }),
      expect.objectContaining({
        provider: "custom-provider",
        external_id: "stable-id",
        label: "Mutable Display Name",
      }),
    ]);

    const restored = new UserManagerImpl(store, dataDir);
    await restored.restore();
    expect(restored.resolve("github", "123456")?.username).toBe("alice");
    expect(restored.resolve("custom-provider", "stable-id")?.username).toBe("alice");

    expect(restored.removeIdentity("alice", "github", "123456")).toBe(true);
    expect(restored.resolve("github", "123456")).toBeUndefined();
    expect(store.resolveIdentity("github", "123456")).toBeUndefined();
    expect(restored.resolve("custom-provider", "stable-id")?.username).toBe("alice");
  });
});
