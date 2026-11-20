import { describe, expect, it } from "vitest";
import { linkComposition } from "@claude-bot/agent-module-contract";
import { createModuleRegistry, createWorkspacePlan } from "@claude-bot/agent-view-react/workspace";
import { PPT_STUDIO_COMPOSITION, PPT_STUDIO_MODULE_ASSETS } from "./plan.js";
import { PPT_STUDIO_MODULES } from "./modules.js";

describe("PPT Studio release plan", () => {
  it("links every compiled module and requests no user resource binding", () => {
    const registry = createModuleRegistry([...PPT_STUDIO_MODULES]);
    const linked = linkComposition(PPT_STUDIO_COMPOSITION, registry.lock(), registry.manifests());
    expect(linked.ok ? [] : linked.issues).toEqual([]);
    expect(createWorkspacePlan({ composition: PPT_STUDIO_COMPOSITION, registry }).connectedInstances.size).toBe(0);
    expect(PPT_STUDIO_MODULE_ASSETS.map((asset) => asset.name)).not.toContain("view/resource-bindings.json");
  });

  it("routes the editor and derived Typst view through declared rebind surfaces", () => {
    for (const rule of PPT_STUDIO_COMPOSITION.open) {
      expect(rule.mode).toBe("rebind");
      expect(PPT_STUDIO_COMPOSITION.instances.some(
        (row) => row.module === rule.module && row.slot === rule.slot,
      )).toBe(true);
    }
  });
});
