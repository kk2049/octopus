import { describe, expect, it } from "vitest";

import {
  AUTO_WORKSPACE_MODULE_TAG,
  moduleForPath,
  normalizeRepoPath,
  withWorkspacePackageFallbacks,
} from "./paths.js";

describe("architecture path mapping", () => {
  it("normalizes platform separators", () => {
    expect(normalizeRepoPath(".\\packages\\bot//src/index.ts")).toBe("packages/bot/src/index.ts");
  });

  it("selects the most specific module prefix", () => {
    const modules = [
      { id: "bot", pathPrefixes: ["packages/bot/"], label: "", description: "", zone: "z", criticality: "normal" as const },
      { id: "dashboard", pathPrefixes: ["packages/bot/src/dashboard/"], label: "", description: "", zone: "z", criticality: "high" as const },
      { id: "authz", pathPrefixes: ["packages/bot/src/dashboard/authz.ts"], label: "", description: "", zone: "z", criticality: "critical" as const },
    ];
    expect(moduleForPath("packages/bot/src/dashboard/server.ts", modules)).toBe("dashboard");
    expect(moduleForPath("packages/bot/src/dashboard/authz.ts", modules)).toBe("authz");
    expect(moduleForPath("elsewhere.ts", modules)).toBe("unmapped");
  });

  it("turns only unclaimed workspace source into visible package fallbacks", () => {
    const explicit = [{
      id: "known",
      pathPrefixes: ["packages/known/"],
      label: "Known",
      description: "",
      zone: "trusted",
      criticality: "normal" as const,
    }];
    const modules = withWorkspacePackageFallbacks({
      definitions: explicit,
      packages: [
        { id: "@demo/known", name: "@demo/known", path: "packages/known", dependencies: [], devDependencies: [] },
        { id: "@demo/new-view", name: "@demo/new-view", path: "packages/new-view", dependencies: [], devDependencies: [] },
        { id: "@demo/empty", name: "@demo/empty", path: "packages/empty", dependencies: [], devDependencies: [] },
      ],
      sourceFiles: ["packages/known/src/index.ts", "packages/new-view/src/index.ts"],
    });

    expect(modules).toHaveLength(2);
    expect(moduleForPath("packages/known/src/index.ts", modules)).toBe("known");
    expect(moduleForPath("packages/new-view/src/index.ts", modules)).toBe("workspace-package:packages/new-view");
    expect(modules[1]).toMatchObject({
      label: "new-view",
      zone: "unmapped",
      tags: [AUTO_WORKSPACE_MODULE_TAG, "coverage-gap"],
    });
  });

  it("keeps specific explicit ownership above a generated package fallback", () => {
    const explicit = [{
      id: "special",
      pathPrefixes: ["packages/mixed/src/special/"],
      label: "Special",
      description: "",
      zone: "trusted",
      criticality: "high" as const,
    }];
    const modules = withWorkspacePackageFallbacks({
      definitions: explicit,
      packages: [{ id: "mixed", name: "mixed", path: "packages/mixed", dependencies: [], devDependencies: [] }],
      sourceFiles: ["packages/mixed/src/special/a.ts", "packages/mixed/src/other.ts"],
    });

    expect(moduleForPath("packages/mixed/src/special/a.ts", modules)).toBe("special");
    expect(moduleForPath("packages/mixed/src/other.ts", modules)).toBe("workspace-package:packages/mixed");
  });
});
