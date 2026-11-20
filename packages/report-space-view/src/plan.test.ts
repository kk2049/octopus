import { describe, expect, it } from "vitest";
import { createModuleRegistry, createWorkspacePlan } from "@claude-bot/agent-view-react/workspace";
import { REPORT_SPACE_COMPOSITION, REPORT_SPACE_MODULE_ASSETS } from "./plan.js";
import { REPORT_SPACE_MODULES } from "./modules.js";
import { project } from "../app/projection.js";

/** Config keys whose value names a projection path. `thread_key` names a record field. */
const PATH_KEYS = ["source", "fields", "sections", "menu", "notice", "default_ref"] as const;

describe("report space release plan", () => {
  it("is a resource-free declared App assembled only from generic modules", () => {
    const plan = createWorkspacePlan({ composition: REPORT_SPACE_COMPOSITION, registry: createModuleRegistry([...REPORT_SPACE_MODULES]) });
    expect(plan.connectedInstances.size).toBe(0);
    expect(REPORT_SPACE_MODULE_ASSETS).toHaveLength(2);
  });

  it("binds paths that exist in an empty projection", () => {
    const view = project([]) as Record<string, unknown>;
    for (const row of REPORT_SPACE_COMPOSITION.instances) {
      for (const key of PATH_KEYS) {
        const value = row.config?.[key];
        if (typeof value === "string") expect(view[value], `${row.instance}.${key}`).toBeDefined();
      }
    }
  });

  it("keeps every projected menu inside its instance's allowlist, forms resolvable, context params declared", () => {
    const view = project([]) as Record<string, any>;
    for (const row of REPORT_SPACE_COMPOSITION.instances) {
      const menuPath = typeof row.config?.["menu"] === "string" ? (row.config["menu"] as string)
        : row.module === "data.actions/v1" ? (row.config?.["source"] as string) : null;
      if (!menuPath) continue;
      const allowed = new Set(String(row.config?.["allowed_actions"] ?? "").split(","));
      const entries = view[menuPath] as Array<Record<string, string>>;
      expect(Array.isArray(entries), `${row.instance}: ${menuPath}`).toBe(true);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(allowed.has(entry.action), `${row.instance} allows ${entry.action}`).toBe(true);
        const declaration = view[entry.fields] as Record<string, unknown>;
        expect(declaration, `${entry.action} fields ${entry.fields}`).toBeDefined();
        if (entry.context_param) {
          expect(declaration, `${entry.action} declares ${entry.context_param}`).toHaveProperty(entry.context_param);
        }
      }
    }
  });
});
