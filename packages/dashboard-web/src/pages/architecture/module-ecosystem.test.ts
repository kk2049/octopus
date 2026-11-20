import { describe, expect, it } from "vitest";

import type { ArchModuleEcosystem } from "../ArchitecturePage.js";
import {
  backendModuleKey,
  contractModuleKey,
  ecosystemEdgeKey,
  frontendModuleKey,
  layoutModuleEcosystem,
} from "./module-ecosystem.js";

function ecosystem(): ArchModuleEcosystem {
  return {
    frontend: [
      {
        id: "demo.viewer/v1", title: "Viewer", version: "1.0.0", implementation: "@x/view#Viewer",
        packageId: "@x/view", packagePath: "packages/view", slots: ["primary"],
        ports: [{ id: "files/v1", packageId: "@x/files-contract" }], opens: ["file"],
        summary: "文件查看器。", preview: "document", configKeys: [],
        source: { path: "packages/view/src/manifests.ts", line: 10 },
      },
      {
        id: "demo.list/v1", title: "List", version: "1.0.0", implementation: "@x/view#List",
        packageId: "@x/view", packagePath: "packages/view", slots: ["navigation"],
        ports: [], opens: [], summary: "列表。", preview: "tree", configKeys: [],
        source: { path: "packages/view/src/manifests.ts", line: 20 },
      },
    ],
    contracts: [{
      id: "files/v1", packageId: "@x/files-contract", packagePath: "packages/files-contract",
      summary: "读取文件。", actions: [{ id: "read", summary: "读取" }],
      provision: "trusted-provider", source: { path: "packages/files-contract/src/index.ts", line: 1 },
    }],
    backend: [
      {
        id: "@x/api#filesProvider:files/v1", name: "filesProvider", summary: "文件后端。", packageId: "@x/api",
        path: "packages/api/provider.ts", files: 1, loc: 30, kind: "provider", contracts: ["files/v1"], actions: [],
        registered: true, dependencies: ["@x/cycle-a#a:a/v1"], source: { path: "packages/api/provider.ts", line: 1 },
      },
      {
        id: "@x/cycle-a#a:a/v1", name: "a", summary: "A。", packageId: "@x/cycle-a",
        path: "packages/cycle-a/provider.ts", files: 1, loc: 10, kind: "provider", contracts: [], actions: [],
        registered: true, dependencies: ["@x/cycle-b#b:b/v1"], source: { path: "packages/cycle-a/provider.ts", line: 1 },
      },
      {
        id: "@x/cycle-b#b:b/v1", name: "b", summary: "B。", packageId: "@x/cycle-b",
        path: "packages/cycle-b/provider.ts", files: 1, loc: 10, kind: "provider", contracts: [], actions: [],
        registered: true, dependencies: ["@x/cycle-a#a:a/v1"], source: { path: "packages/cycle-b/provider.ts", line: 1 },
      },
    ],
    dependencies: [
      { from: "contract:files/v1", to: "backend:@x/api#filesProvider:files/v1", kind: "provides", label: "可信实现" },
      { from: "backend:@x/api#filesProvider:files/v1", to: "backend:@x/cycle-a#a:a/v1", kind: "provider", label: "Provider 依赖" },
      { from: "backend:@x/cycle-a#a:a/v1", to: "backend:@x/cycle-b#b:b/v1", kind: "provider", label: "Provider 依赖" },
      { from: "backend:@x/cycle-b#b:b/v1", to: "backend:@x/cycle-a#a:a/v1", kind: "provider", label: "Provider 依赖" },
      { from: "frontend:@x/view:demo.viewer/v1", to: "contract:files/v1", kind: "requires", label: "files/v1" },
    ],
    issues: [],
  };
}

describe("module ecosystem topology", () => {
  it("keeps frontend manifests in one compact package column", () => {
    const layout = layoutModuleEcosystem(ecosystem());
    expect(layout.frontend).toHaveLength(1);
    expect(layout.frontend[0].modules.map((entry) => entry.module.title)).toEqual(["List", "Viewer"]);
    expect(layout.boxes.has(frontendModuleKey(ecosystem().frontend[0]))).toBe(true);
    expect(layout.boxes.has(contractModuleKey("files/v1"))).toBe(true);
  });

  it("uses longest-path ranks only for semantic Provider dependencies and compresses cycles", () => {
    const data = ecosystem();
    const layout = layoutModuleEcosystem(data);
    expect(layout.ranks.get(backendModuleKey("@x/cycle-a#a:a/v1")))
      .toBeGreaterThan(layout.ranks.get(backendModuleKey("@x/api#filesProvider:files/v1"))!);
    expect(layout.ranks.get(backendModuleKey("@x/cycle-a#a:a/v1")))
      .toBe(layout.ranks.get(backendModuleKey("@x/cycle-b#b:b/v1")));
    expect(layout.cyclicEdges.has(ecosystemEdgeKey(data.dependencies[2]))).toBe(true);
    expect(layout.cyclicEdges.has(ecosystemEdgeKey(data.dependencies[3]))).toBe(true);
  });

  it("is deterministic for identical facts", () => {
    const first = layoutModuleEcosystem(ecosystem());
    const second = layoutModuleEcosystem(ecosystem());
    expect(first.backend.map((entry) => [entry.key, entry.rank, entry.box])).toEqual(
      second.backend.map((entry) => [entry.key, entry.rank, entry.box]),
    );
  });
});
