import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeDependencies, buildDependencyFacts } from "./dependencies.js";

describe("dependency aggregation", () => {
  it("keeps runtime and type-only dependencies separate", () => {
    const files = [
      { id: "packages/a/src/a.ts", path: "packages/a/src/a.ts", moduleId: "a", packageId: "a", isTest: false, loc: 1, codeLoc: 1, git: { touches: 0, additions: 0, deletions: 0 }, declarationCount: 0, complexity: 0 },
      { id: "packages/b/src/b.ts", path: "packages/b/src/b.ts", moduleId: "b", packageId: "b", isTest: false, loc: 1, codeLoc: 1, git: { touches: 0, additions: 0, deletions: 0 }, declarationCount: 0, complexity: 0 },
    ];
    const result = buildDependencyFacts({
      root: "/repo",
      files,
      imports: [],
      modules: [
        { id: "a", label: "A", description: "", zone: "z", criticality: "normal", pathPrefixes: ["packages/a/"] },
        { id: "b", label: "B", description: "", zone: "z", criticality: "normal", pathPrefixes: ["packages/b/"] },
      ],
      packages: [],
      result: {
        modules: [{
          source: "packages/a/src/a.ts",
          valid: true,
          dependents: [],
          dependencies: [
            { module: "../../b/src/b.js", resolved: "packages/b/src/b.ts", circular: false, coreModule: false, couldNotResolve: false, dependencyTypes: ["local"], dynamic: false, exoticallyRequired: false, followable: true, mimeType: "", moduleSystem: "es6", protocol: "file:", valid: true, instability: 0 },
            { module: "../../b/src/b.js", resolved: "packages/b/src/b.ts", circular: false, coreModule: false, couldNotResolve: false, dependencyTypes: ["local"], dynamic: false, exoticallyRequired: false, followable: true, mimeType: "", moduleSystem: "es6", protocol: "file:", valid: true, instability: 0, typeOnly: true },
          ],
        }],
        summary: { error: 0, warn: 0, info: 0, ignore: 0, totalCruised: 2, violations: [], optionsUsed: {}, environment: { version: "", nodeVersionSupported: "", nodeVersionFound: "", osVersionFound: "", transpilersFound: [], extensionsFound: [] } },
      },
    });
    expect(result.moduleDependencies[0]).toMatchObject({ from: "a", to: "b", runtimeCount: 1, typeOnlyCount: 1, testCount: 0 });
  });

  it("keeps test imports out of production architecture edges", () => {
    const files = [
      { id: "packages/a/src/a.test.ts", path: "packages/a/src/a.test.ts", moduleId: "a", packageId: "a", isTest: true, loc: 1, codeLoc: 1, git: { touches: 0, additions: 0, deletions: 0 }, declarationCount: 0, complexity: 0 },
      { id: "packages/b/src/b.ts", path: "packages/b/src/b.ts", moduleId: "b", packageId: "b", isTest: false, loc: 1, codeLoc: 1, git: { touches: 0, additions: 0, deletions: 0 }, declarationCount: 0, complexity: 0 },
    ];
    const result = buildDependencyFacts({
      root: "/repo",
      files,
      imports: [],
      modules: [
        { id: "a", label: "A", description: "", zone: "z", criticality: "normal", pathPrefixes: ["packages/a/"] },
        { id: "b", label: "B", description: "", zone: "z", criticality: "normal", pathPrefixes: ["packages/b/"] },
      ],
      packages: [],
      result: {
        modules: [{ source: "packages/a/src/a.test.ts", valid: true, dependents: [], dependencies: [
          { module: "../../b/src/b.js", resolved: "packages/b/src/b.ts", circular: true, coreModule: false, couldNotResolve: false, dependencyTypes: ["local"], dynamic: false, exoticallyRequired: false, followable: true, mimeType: "", moduleSystem: "es6", protocol: "file:", valid: true, instability: 0 },
        ] }],
        summary: { error: 0, warn: 0, info: 0, ignore: 0, totalCruised: 2, violations: [], optionsUsed: {}, environment: { version: "", nodeVersionSupported: "", nodeVersionFound: "", osVersionFound: "", transpilersFound: [], extensionsFound: [] } },
      },
    });
    expect(result.moduleDependencies[0]).toMatchObject({ runtimeCount: 0, typeOnlyCount: 0, testCount: 1, circular: false });
  });

  it("preserves external package evidence without traversing package sources", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "architecture-dependencies-"));
    try {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      }));
      fs.writeFileSync(path.join(root, "src/index.ts"), 'import { readFileSync } from "node:fs";\nvoid readFileSync;\n');

      const result = await analyzeDependencies({
        root,
        sourceRoots: ["src"],
        files: [{
          id: "src/index.ts",
          path: "src/index.ts",
          moduleId: "app",
          isTest: false,
          loc: 2,
          codeLoc: 2,
          git: { touches: 0, additions: 0, deletions: 0 },
          declarationCount: 0,
          complexity: 0,
        }],
        imports: [{ sourcePath: "src/index.ts", specifier: "node:fs", line: 1, typeOnly: false, dynamic: false }],
        modules: [{ id: "app", label: "App", description: "", zone: "z", criticality: "normal", pathPrefixes: ["src/"] }],
        packages: [],
      });

      expect(result.externalDependencies).toEqual([
        expect.objectContaining({ from: "app", package: "node:fs", count: 1, builtin: true }),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps workspace package edges stable when exports resolve into dist", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "architecture-workspace-dependencies-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.mkdirSync(path.join(root, "packages/b/src"), { recursive: true });
      fs.mkdirSync(path.join(root, "node_modules/@fixture/b/dist"), { recursive: true });
      fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      }));
      fs.writeFileSync(path.join(root, "src/index.ts"), 'import { value } from "@fixture/b";\nvoid value;\n');
      fs.writeFileSync(path.join(root, "packages/b/src/aaa.ts"), "export const unrelated = true;\n");
      fs.writeFileSync(path.join(root, "packages/b/src/index.ts"), "export const value = 1;\n");
      fs.writeFileSync(path.join(root, "node_modules/@fixture/b/package.json"), JSON.stringify({
        name: "@fixture/b",
        type: "module",
        exports: "./dist/index.js",
      }));
      fs.writeFileSync(path.join(root, "node_modules/@fixture/b/dist/index.js"), "export const value = 1;\n");

      const files = [
        {
          id: "src/index.ts", path: "src/index.ts", moduleId: "a", isTest: false, loc: 2, codeLoc: 2,
          git: { touches: 0, additions: 0, deletions: 0 }, declarationCount: 0, complexity: 0,
        },
        {
          id: "packages/b/src/aaa.ts", path: "packages/b/src/aaa.ts", moduleId: "b", packageId: "@fixture/b",
          isTest: false, loc: 1, codeLoc: 1, git: { touches: 0, additions: 0, deletions: 0 }, declarationCount: 0, complexity: 0,
        },
        {
          id: "packages/b/src/index.ts", path: "packages/b/src/index.ts", moduleId: "b", packageId: "@fixture/b",
          isTest: false, loc: 1, codeLoc: 1, git: { touches: 0, additions: 0, deletions: 0 }, declarationCount: 0, complexity: 0,
        },
      ];
      const result = await analyzeDependencies({
        root,
        sourceRoots: ["src", "packages"],
        files,
        imports: [{ sourcePath: "src/index.ts", specifier: "@fixture/b", line: 1, typeOnly: false, dynamic: false }],
        modules: [
          { id: "a", label: "A", description: "", zone: "z", criticality: "normal", pathPrefixes: ["src/"] },
          { id: "b", label: "B", description: "", zone: "z", criticality: "normal", pathPrefixes: ["packages/b/"] },
        ],
        packages: [{ id: "@fixture/b", name: "@fixture/b", path: "packages/b", dependencies: [], devDependencies: [] }],
      });

      expect(result.moduleDependencies).toEqual([
        expect.objectContaining({ from: "a", to: "b", runtimeCount: 1 }),
      ]);
      expect(result.fileEdges).toEqual([
        expect.objectContaining({ from: "src/index.ts", to: "packages/b/src/index.ts" }),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
