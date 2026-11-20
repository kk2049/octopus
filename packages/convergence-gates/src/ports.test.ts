import { describe, expect, it } from "vitest";

import { readAppRegistryDirectory, readAppRegistryMutationReceipt, readSessionHarnessLaunchIntent } from "./ports.js";

describe("G4/G5 readers", () => {
  it("accepts only an opaque launch intent and rejects a smuggled URL", () => {
    const base = {
      rid: "request_12345678",
      sessionRef: "session:12345678",
      intentRef: "launch:12345678",
      state: "ready",
    };
    expect(readSessionHarnessLaunchIntent(base).ok).toBe(true);
    expect(readSessionHarnessLaunchIntent({ ...base, url: "https://endpoint.invalid/?token=x" }).ok).toBe(false);
  });

  it("reads digest/count-only registry projections and rejects paths", () => {
    const base = {
      revision: 7,
      apps: [{
        appId: "session-plus",
        publisher: "platform",
        activeDigest: "a".repeat(64),
        releaseCount: 2,
        compatibility: "supported",
        runtimeHealth: "healthy",
      }],
      reconcile: { activeUnusable: 0, installedUnusable: 0, undescribable: 0, orphanContent: 1 },
    };
    expect(readAppRegistryDirectory(base).ok).toBe(true);
    expect(readAppRegistryDirectory({ ...base, contentRoot: "/srv/releases" }).ok).toBe(false);
  });

  it("makes rollback name an exact digest", () => {
    expect(readAppRegistryMutationReceipt({
      operation: "rollback",
      appId: "session-plus",
      packageDigest: "b".repeat(64),
      revision: 9,
      status: "applied",
    }).ok).toBe(true);
    expect(readAppRegistryMutationReceipt({
      operation: "rollback",
      appId: "session-plus",
      packageDigest: "previous",
      revision: 9,
      status: "applied",
    }).ok).toBe(false);
  });
});
