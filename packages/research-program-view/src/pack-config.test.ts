import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import RESEARCH_PROGRAM_PACK from "./pack.js";
import { RESEARCH_PROGRAM_COMPOSITION, RESEARCH_PROGRAM_MANIFESTS } from "./plan.js";

describe("research program pack profile", () => {
  it("ships the Agent and document workbench as a complete modular-v1 pair", () => {
    expect(RESEARCH_PROGRAM_PACK.manifests).toEqual(RESEARCH_PROGRAM_MANIFESTS);
    expect(RESEARCH_PROGRAM_PACK.moduleAssets.map((asset) => asset.name).sort()).toEqual([
      "view/composition.json",
      "view/module-lock.json",
    ]);
    expect(RESEARCH_PROGRAM_COMPOSITION.instances).toMatchObject([
      { instance: "agent", slot: "primary" },
      { instance: "document", slot: "secondary" },
    ]);
  });

  it("reserves the only owner seat for each project's creator", () => {
    const manifest = readFileSync(resolve(RESEARCH_PROGRAM_PACK.appDir, "app.yaml"), "utf8");
    expect(manifest).toMatch(/^  owner: \{max: 1\}$/m);
  });
});
