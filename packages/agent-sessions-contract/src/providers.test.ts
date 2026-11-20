import { describe, expect, it } from "vitest";
import { SESSION_CLI_KINDS } from "./projection.js";
import { AGENT_EFFORT_LEVELS, AGENT_EFFORTS, isAgentEffort, publicModelChoices } from "./providers.js";

describe("shared provider effort ladders", () => {
  it("defines one closed ladder per CLI kind, inside the schema union", () => {
    expect(Object.keys(AGENT_EFFORTS).sort()).toEqual([...SESSION_CLI_KINDS].sort());
    for (const ladder of Object.values(AGENT_EFFORTS)) {
      for (const effort of ladder) expect(AGENT_EFFORT_LEVELS).toContain(effort);
    }
    expect(new Set(Object.values(AGENT_EFFORTS).flat())).toEqual(new Set(AGENT_EFFORT_LEVELS));
  });

  it("accepts only the chosen provider's own levels", () => {
    expect(isAgentEffort("claude", "max")).toBe(true);
    expect(isAgentEffort("codex", "xhigh")).toBe(true);
    expect(isAgentEffort("omp", "off")).toBe(true);
    expect(isAgentEffort("omp", "minimal")).toBe(true);
    expect(isAgentEffort("claude", "off")).toBe(false);
    expect(isAgentEffort("codex", "minimal")).toBe(false);
    expect(isAgentEffort("codex", "ultra")).toBe(false);
  });

  it("refuses unknown providers, inherited keys and non-strings", () => {
    expect(isAgentEffort("gemini", "high")).toBe(false);
    expect(isAgentEffort("constructor", "high")).toBe(false);
    expect(isAgentEffort("__proto__", "high")).toBe(false);
    expect(isAgentEffort(undefined, "high")).toBe(false);
    expect(isAgentEffort("claude", 3)).toBe(false);
  });

  it("is frozen so no consumer can widen another's ladder", () => {
    expect(Object.isFrozen(AGENT_EFFORTS)).toBe(true);
    expect(Object.isFrozen(AGENT_EFFORTS.omp)).toBe(true);
    expect(Object.isFrozen(AGENT_EFFORT_LEVELS)).toBe(true);
  });
});

describe("public model catalog", () => {
  const models = [{ value: "local-model", label: "Local" }];
  it("bounds and strips metadata before crossing the public projection", () => {
    expect(publicModelChoices([{...models[0],secret:"private"},models[0]])).toEqual(models);
    for (const bad of [[], Array(501).fill(models[0]), [{value:"bad model",label:"Bad"}], [{value:"ok",label:"bad\nlabel"}]]) {
      expect(publicModelChoices(bad)).toBeUndefined();
    }
  });
});
