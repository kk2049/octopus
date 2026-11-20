import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AtlasConfig } from "../shared/model.js";
import { inputFingerprint, reusableAtlas } from "./fingerprint.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("atlas input fingerprint", () => {
  it("changes with source content and only reuses an exact snapshot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "architecture-fingerprint-"));
    temporary.push(root);
    fs.mkdirSync(path.join(root, "packages", "sample"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", "sample", "package.json"), JSON.stringify({ name: "sample" }));
    fs.writeFileSync(path.join(root, "packages", "sample", "index.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true }));
    const config: AtlasConfig = {
      system: { id: "test", title: "Test", description: "Test" },
      zones: [{ id: "z", label: "Z", description: "", color: "#000", trust: "trusted" }],
      modules: [{ id: "sample", label: "Sample", description: "", zone: "z", criticality: "normal", pathPrefixes: ["packages/sample/"] }],
      flows: [], constraints: [], analysis: { sourceRoots: ["packages"] },
    };
    fs.writeFileSync(path.join(root, "atlas.json"), JSON.stringify(config));
    fs.mkdirSync(path.join(root, "architecture"));
    fs.writeFileSync(path.join(root, "architecture", "waivers.json"), JSON.stringify({ version: 1, waivers: [] }));
    const first = inputFingerprint(root, "atlas.json", config);
    fs.writeFileSync(path.join(root, "packages", "sample", "index.ts"), "export const value = 2;\n");
    const second = inputFingerprint(root, "atlas.json", config);
    expect(second).not.toBe(first);

    fs.writeFileSync(path.join(root, "architecture", "waivers.json"), JSON.stringify({ version: 1, waivers: [{ witness: "changed" }] }));
    expect(inputFingerprint(root, "atlas.json", config)).not.toBe(second);

    const out = path.join(root, "out.json");
    fs.writeFileSync(out, JSON.stringify({ meta: { inputFingerprint: second } }));
    expect(reusableAtlas(out, second)?.meta.inputFingerprint).toBe(second);
    expect(reusableAtlas(out, first)).toBeUndefined();
  });
});
