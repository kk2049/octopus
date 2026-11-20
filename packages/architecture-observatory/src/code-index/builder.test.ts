import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseVitestInventory, selectIndexedTests } from "./builder.js";

describe("Vitest code-index inventory", () => {
  it("retains exact test names and locations with deterministic file, project, and case ordering", () => {
    const root = path.resolve("/workspace/octopus");
    const firstFile = path.join(root, "packages/api/src/actions.test.ts");
    const secondFile = path.join(root, "packages/web/src/menu.test.ts");
    const inventory = parseVitestInventory(root, JSON.stringify([
      { file: secondFile, name: "menu > opens the selected entry", projectName: "browser", location: { line: 31, column: 4 } },
      { file: firstFile, name: "actions > preserves provider-neutral append", projectName: "node", location: { line: 17, column: 2 } },
      { file: firstFile, name: "actions > rejects an empty append", projectName: "node", location: { line: 9, column: 2 } },
      { file: firstFile, name: "actions > preserves provider-neutral append", projectName: "integration", location: { line: 17, column: 2 } },
    ]));

    expect(inventory).toEqual([
      {
        path: "packages/api/src/actions.test.ts",
        projects: ["integration", "node"],
        tests: [
          { name: "actions > preserves provider-neutral append", line: 17, column: 2 },
          { name: "actions > rejects an empty append", line: 9, column: 2 },
        ],
      },
      {
        path: "packages/web/src/menu.test.ts",
        projects: ["browser"],
        tests: [{ name: "menu > opens the selected entry", line: 31, column: 4 }],
      },
    ]);
  });

  it("accepts bounded collection diagnostics before Vitest's final JSON array", () => {
    const root = path.resolve("/workspace/octopus");
    const file = path.join(root, "packages/api/src/actions.test.ts");
    const output = `pack.test.ts: skipping — build the View first\n${JSON.stringify([
      { file, name: "actions > preserves append", projectName: "node", location: { line: 17, column: 2 } },
    ])}`;

    expect(parseVitestInventory(root, output)).toEqual([{
      path: "packages/api/src/actions.test.ts",
      projects: ["node"],
      tests: [{ name: "actions > preserves append", line: 17, column: 2 }],
    }]);
  });

  it("keeps only tests owned by the exact indexed TypeScript project set", () => {
    const inventory = [
      {
        path: "packages/api/src/actions.test.ts",
        projects: ["node"],
        tests: [{ name: "actions > preserves append", line: 17, column: 2 }],
      },
      {
        path: "packages/web/src/excluded.test.ts",
        projects: ["browser"],
        tests: [{ name: "excluded > runs through a separate compiler boundary", line: 9, column: 2 }],
      },
    ];

    expect(selectIndexedTests(inventory, ["packages/api/src/actions.test.ts", "packages/api/src/actions.ts"])).toEqual([
      inventory[0],
    ]);
  });

  it("rejects file-only Vitest output without case identity and location", () => {
    expect(() => parseVitestInventory("/workspace/octopus", JSON.stringify([
      { file: "/workspace/octopus/packages/api/src/actions.test.ts", projectName: "node" },
    ]))).toThrow(/invalid test inventory entry/);
  });
});
