import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { discoverCodeIndexProjects } from "./projects.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octopus-code-projects-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "packages/api/src"), { recursive: true });
  fs.mkdirSync(path.join(root, "plugins/delegate/src"), { recursive: true });
  fs.mkdirSync(path.join(root, "tools/code-index"), { recursive: true });
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  fs.writeFileSync(path.join(root, "root-default-include.ts"), "export const mustNotBeIndexed = true;\n");
  fs.writeFileSync(path.join(root, "packages/api/package.json"), JSON.stringify({ name: "@fixture/api" }));
  fs.writeFileSync(path.join(root, "packages/api/tsconfig.json"), JSON.stringify({ include: ["src"] }));
  fs.writeFileSync(path.join(root, "packages/api/src/index.ts"), "export const api = true;\n");
  fs.writeFileSync(path.join(root, "plugins/delegate/package.json"), JSON.stringify({ name: "@fixture/delegate" }));
  fs.writeFileSync(path.join(root, "plugins/delegate/tsconfig.json"), JSON.stringify({ include: ["src"] }));
  fs.writeFileSync(path.join(root, "plugins/delegate/src/index.ts"), "export const delegate = true;\n");
  fs.writeFileSync(path.join(root, "tools/code-index/tsconfig.root.json"), JSON.stringify({ files: ["../../root-default-include.ts"] }));
  return root;
}

describe("code-index project discovery", () => {
  it("indexes explicit sorted projects without ever using the root default include", () => {
    const root = fixture();
    const projects = discoverCodeIndexProjects(root);

    expect(projects.map((project) => project.tsconfig)).toEqual([
      "packages/api/tsconfig.json",
      "plugins/delegate/tsconfig.json",
      "tools/code-index/tsconfig.root.json",
    ]);
    expect(projects.flatMap((project) => project.files).sort()).toEqual([
      "packages/api/src/index.ts",
      "plugins/delegate/src/index.ts",
      "root-default-include.ts",
    ]);
    expect(projects.some((project) => project.tsconfig === "tsconfig.json")).toBe(false);
  });

  it("fails before generation when explicit projects overlap", () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "packages/api/tsconfig.json"), JSON.stringify({ files: ["src/index.ts", "../../root-default-include.ts"] }));

    expect(() => discoverCodeIndexProjects(root)).toThrow(/duplicate project document root-default-include\.ts/);
  });

  it("requires every workspace to declare its real tsconfig", () => {
    const root = fixture();
    fs.rmSync(path.join(root, "plugins/delegate/tsconfig.json"));

    expect(() => discoverCodeIndexProjects(root)).toThrow(/missing plugins\/delegate\/tsconfig\.json/);
  });
});
