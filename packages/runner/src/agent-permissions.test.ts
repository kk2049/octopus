import { describe, expect, it } from "vitest";
import {
  agentEffort,
  agentModel,
  agentPermissionProfile,
  claudePermissionOptions,
} from "./agent-permissions.js";

describe("shared Agent permission profiles", () => {
  it("defaults every entry point to full access while an explicit manual choice wins", () => {
    for (const provider of ["claude", "codex", "omp"] as const) {
      expect(agentPermissionProfile(provider, undefined)).toBe("full_access");
      expect(agentPermissionProfile(provider, "")).toBe("full_access");
      expect(agentPermissionProfile(provider, "manual")).toBe("manual");
    }
  });

  it("maps Claude full access and manual approval to distinct SDK options", () => {
    expect(claudePermissionOptions("full_access")).toEqual({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    expect(claudePermissionOptions("manual")).toEqual({ permissionMode: "default" });
  });

  it("rejects values outside the closed vocabulary", () => {
    expect(() => agentPermissionProfile("claude", "root")).toThrow(/权限档位无效/);
  });

  it("shares one provider-specific effort vocabulary across launch and resume", () => {
    expect(agentEffort("claude", "max", "append_session")).toBe("max");
    expect(agentEffort("codex", "max", "append_session")).toBe("max");
    expect(agentEffort("omp", "off", "append_session")).toBe("off");
    expect(() => agentEffort("codex", "ultra", "append_session")).toThrow(/append_session codex effort 无效/);
  });

  it("shares one bounded model syntax across launch and resume", () => {
    expect(agentModel("gpt-5.6-terra", "append_session")).toBe("gpt-5.6-terra");
    expect(agentModel("", "append_session")).toBe("");
    expect(() => agentModel("not a model", "append_session")).toThrow(/append_session model 无效/);
  });
});
