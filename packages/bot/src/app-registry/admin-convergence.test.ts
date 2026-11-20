import { describe, expect, it } from "vitest";
import { readAppRegistryDirectory } from "@claude-bot/convergence-gates";

import { convergenceRegistryProjection } from "./admin-convergence.js";
import type { AppRegistryDirectoryView } from "./admin-view.js";

describe("G5 registry projection equivalence adapter", () => {
  it("preserves digest/status/count truth while dropping build details", () => {
    const digest = "a".repeat(64);
    const source: AppRegistryDirectoryView = {
      apps: [{
        stableAppId: "session-plus",
        publisher: "platform",
        activeViewOrigin: "https://app-origin.invalid",
        activePackageDigest: digest,
        checkout: null,
        unavailable: null,
        runtime: { state: "ready", runtime: "running", statePid: 1, runtimePid: 2 },
        releases: [{
          packageDigest: digest,
          hostLabel: "private-host-label",
          stableAppId: "session-plus",
          publisher: "platform",
          executionProfile: "modular-v1",
          permissionContractDigest: "c".repeat(64),
          assets: [{ name: "secret/path.js", sha256: "d".repeat(64), bytes: 12 }],
          totalBytes: 12,
          composition: { view: ["secret/path.js"], backend: [] },
          source: { kind: "git", digest: "e".repeat(64), repository: "private", commit: "abc", subdir: "/local/path" },
          buildInput: { entry: "/local/path", toolchain: { builder: "x", format: "esm", lockfile: "/local/lock" }, lockfileHash: "f".repeat(64) },
          provenance: { kind: "platform-built", builder: "x", statement: "private", signatureVerification: "none" },
          installedBy: "admin",
          installedAt: "2026-08-15T00:00:00Z",
          removedBy: null,
          removedAt: null,
          active: true,
          supported: true,
        }],
      }],
      reconcile: { verification: "manifest", activeUnusable: [], installedUnusable: [], undescribable: [], orphanContent: 3 },
    };
    const projected = convergenceRegistryProjection(source, 4);
    expect(projected).toEqual({
      revision: 4,
      apps: [{ appId: "session-plus", publisher: "platform", activeDigest: digest, releaseCount: 1, compatibility: "supported", runtimeHealth: "healthy" }],
      reconcile: { activeUnusable: 0, installedUnusable: 0, undescribable: 0, orphanContent: 3 },
    });
    expect(readAppRegistryDirectory(projected).ok).toBe(true);
    const encoded = JSON.stringify(projected);
    expect(encoded).not.toContain("secret/path");
    expect(encoded).not.toContain("/local/path");
    expect(encoded).not.toContain("app-origin");
    expect(encoded).not.toContain("statePid");
  });
});
