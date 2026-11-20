import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

import { describe, expect, it } from "vitest";

import { discoverWorkspacePackages } from "./paths.js";
import {
  buildModuleEcosystem,
  discoverBackendModules,
  discoverContracts,
  discoverFrontendModules,
} from "./module-ecosystem.js";

function write(root: string, name: string, contents: string): string {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

describe("automatic module ecosystem discovery", () => {
  it("reads typed frontend manifests and keeps port declaration provenance", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "architecture-modules-"));
    try {
      write(root, "packages/contracts/package.json", JSON.stringify({ name: "@fixture/contracts" }));
      const contract = write(root, "packages/contracts/src/index.ts", 'export const DEMO_CONTRACT = "demo/v1";\n');
      write(root, "packages/widgets/package.json", JSON.stringify({
        name: "@fixture/widgets",
        dependencies: { "@fixture/contracts": "workspace:*", react: "19" },
      }));
      const manifest = write(root, "packages/widgets/src/manifests.ts", [
        'import { DEMO_CONTRACT } from "../../contracts/src/index.js";',
        "interface AgentModuleManifest { id: string; title: string; version: string; implementation: string; slots: string[]; ports: string[]; opens: string[] }",
        'const VERSION = "1.2.3";',
        'const PACKAGE = "@fixture/widgets";',
        "export const DEMO_MANIFEST: AgentModuleManifest = {",
        '  id: "demo.widget/v1", title: "Demo", version: VERSION,',
        '  implementation: `${PACKAGE}#Demo`, slots: ["primary"],',
        '  ports: [DEMO_CONTRACT], opens: ["demo"],',
        "};",
        "function opaque(): AgentModuleManifest { throw new Error(); }",
        "export const OPAQUE_MANIFEST: AgentModuleManifest = opaque();",
      ].join("\n"));
      const rootNames = [contract, manifest].map((file) => path.resolve(file));
      const program = ts.createProgram({
        rootNames,
        options: {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          noEmit: true,
          noLib: true,
          skipLibCheck: true,
        },
      });
      const result = discoverFrontendModules({
        root,
        program,
        rootNames: new Set(rootNames),
        packages: discoverWorkspacePackages(root),
      });

      expect(result.modules).toEqual([
        expect.objectContaining({
          id: "demo.widget/v1",
          title: "Demo",
          version: "1.2.3",
          implementation: "@fixture/widgets#Demo",
          packageId: "@fixture/widgets",
          slots: ["primary"],
          ports: [{ id: "demo/v1", packageId: "@fixture/contracts" }],
          opens: ["demo"],
          summary: expect.stringContaining("Demo"),
          preview: "panel",
          configKeys: [],
        }),
      ]);
      expect(result.issues).toEqual([
        expect.objectContaining({ message: "AgentModuleManifest 不是可静态读取的对象字面量" }),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("links Views through typed contracts to trusted Providers without admitting infrastructure packages", () => {
    const ecosystem = buildModuleEcosystem({
      frontend: { modules: [{
        id: "demo.widget/v1", title: "Demo", version: "1.0.0", implementation: "@x/widgets#Demo",
        packageId: "@x/widgets", packagePath: "packages/widgets", slots: ["primary"],
        ports: [{ id: "demo/v1", packageId: "@x/demo-contract" }], opens: [],
        summary: "提供 Demo 视图。", preview: "panel", configKeys: [],
        source: { path: "packages/widgets/src/manifests.ts", line: 1 },
      }], issues: [] },
      contracts: { contracts: [{
        id: "demo/v1", packageId: "@x/demo-contract", packagePath: "packages/contracts",
        summary: "读取演示数据。", actions: [{ id: "read", summary: "读取数据", operation: "read_demo" }],
        source: { path: "packages/contracts/src/index.ts", line: 1 }, provision: "app-or-host",
      }], issues: [] },
      backend: { modules: [{
        id: "@x/service#demoProvider:demo/v1", name: "demoProvider", summary: "可信演示后端。",
        packageId: "@x/service", path: "packages/service/src/provider.ts", files: 1, loc: 30,
        kind: "provider", contracts: ["demo/v1"], actions: [], registered: true, dependencies: [],
        source: { path: "packages/service/src/provider.ts", line: 3 },
      }], issues: [] },
    });

    expect(ecosystem.contracts[0]).toMatchObject({ id: "demo/v1", provision: "trusted-provider" });
    expect(ecosystem.backend.map((entry) => [entry.name, entry.kind])).toEqual([["demoProvider", "provider"]]);
    expect(JSON.stringify(ecosystem)).not.toContain("capability-kernel");
    expect(ecosystem.dependencies).toEqual([
      { from: "contract:demo/v1", to: "backend:@x/service#demoProvider:demo/v1", kind: "provides", label: "可信实现" },
      { from: "frontend:@x/widgets:demo.widget/v1", to: "contract:demo/v1", kind: "requires", label: "demo/v1" },
    ]);
  });

  it("discovers contract Chinese summaries and production Provider registration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "architecture-providers-"));
    try {
      write(root, "packages/backend/package.json", JSON.stringify({ name: "@fixture/backend" }));
      const contract = write(root, "packages/backend/src/contract.ts", [
        'export const DEMO_CONTRACT = "demo/v1";',
        "export const DEMO_DECLARATION = declareContract({",
        "  contract: DEMO_CONTRACT, summary: \"读取一份演示数据。\", refusals: {},",
        "  actions: { read: { summary: \"读取数据\", operation: \"read_demo\", params: {} } },",
        "});",
      ].join("\n"));
      const provider = write(root, "packages/backend/src/provider.ts", [
        'import { DEMO_CONTRACT } from "./contract.js";',
        "interface ResourceProviderDefinition<T = unknown> { contract: string; actions: string[] }",
        "export function demoProvider(): ResourceProviderDefinition {",
        "  return { contract: DEMO_CONTRACT, actions: [] };",
        "}",
        "const catalog = { register(_value: unknown) {} };",
        "catalog.register(demoProvider());",
      ].join("\n"));
      const rootNames = [contract, provider].map((file) => path.resolve(file));
      const program = ts.createProgram({
        rootNames,
        options: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true, noLib: true },
      });
      const args = { root, program, rootNames: new Set(rootNames), packages: discoverWorkspacePackages(root) };
      expect(discoverContracts(args).contracts).toEqual([
        expect.objectContaining({
          id: "demo/v1", summary: "读取一份演示数据。",
          actions: [{ id: "read", summary: "读取数据", operation: "read_demo" }],
        }),
      ]);
      expect(discoverBackendModules(args).modules).toEqual([
        expect.objectContaining({ name: "demoProvider", contracts: ["demo/v1"], registered: true }),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
