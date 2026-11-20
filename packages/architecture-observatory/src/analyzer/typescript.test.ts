import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { codeLineCount, discoverSourceFiles } from "./typescript.js";

describe("TypeScript source facts", () => {
  it("counts executable lines without comments or blank lines", () => {
    expect(codeLineCount([
      "/** prose */",
      "const one = 1; // trailing",
      "",
      "/* block",
      " * prose",
      " */",
      "const two = 2;",
    ].join("\n"))).toBe(2);
  });

  it("does not ingest nested build and generated output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "architecture-sources-"));
    try {
      for (const directory of ["packages/app/src", "packages/app/dist", "packages/app/.generated", "packages/app/node_modules/pkg"]) {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
      }
      fs.writeFileSync(path.join(root, "packages/app/src/index.ts"), "export const source = true;\n");
      fs.writeFileSync(path.join(root, "packages/app/dist/bundle.js"), "export const built = true;\n");
      fs.writeFileSync(path.join(root, "packages/app/.generated/fact.ts"), "export const generated = true;\n");
      fs.writeFileSync(path.join(root, "packages/app/node_modules/pkg/index.js"), "export const dependency = true;\n");
      expect(discoverSourceFiles(root, ["packages"]).map((file) => path.relative(root, file))).toEqual(["packages/app/src/index.ts"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
