import { describe, expect, it } from "vitest";
import { evaluateCondition, evaluateConditionResult, validatePolicyProgram } from "./program.js";
import type { PolicyRule } from "./types.js";

describe("trusted authorization policy program", () => {
  const facts = {
    department: "finance",
    rank: 6,
    actor: "vp",
    target: "analyst",
    suspended: false,
  } as const;
  const hierarchies = {
    reports: [
      { ancestor: "ceo", descendant: "vp" },
      { ancestor: "vp", descendant: "manager" },
      { ancestor: "manager", descendant: "analyst" },
    ],
  } as const;

  it("evaluates all/any/not, eq/in/gte and transitive ancestor facts", () => {
    expect(evaluateCondition({
      op: "all",
      conditions: [
        { op: "eq", left: { fact: "department" }, right: { value: "finance" } },
        { op: "in", value: { fact: "department" }, set: ["legal", "finance"] },
        { op: "gte", left: { fact: "rank" }, right: { value: 5 } },
        { op: "not", condition: { op: "eq", left: { fact: "suspended" }, right: { value: true } } },
        {
          op: "ancestor",
          hierarchy: "reports",
          ancestor: { fact: "actor" },
          descendant: { fact: "target" },
        },
      ],
    }, facts, hierarchies)).toBe(true);

    expect(evaluateCondition({
      op: "any",
      conditions: [
        { op: "eq", left: { fact: "missing" }, right: { fact: "also_missing" } },
        { op: "gte", left: { fact: "department" }, right: { value: 1 } },
      ],
    }, facts, hierarchies)).toBe(false);
  });

  it("rejects duplicate rules and owner-authored mandatory rules", () => {
    const base = {
      id: "rule:one",
      title: "one",
      authority: { kind: "owner" as const, id: "alice" },
      effect: "allow" as const,
      match: {},
      explanation: "trusted rule",
    };
    expect(() => validatePolicyProgram([base, base])).toThrow(/duplicate/);
    expect(() => validatePolicyProgram([{ ...base, effect: "deny", mandatory: true }])).toThrow(/organization/);
    expect(() => validatePolicyProgram([{ ...base, effect: "deny" }])).toThrow(/reserved/);
    expect(() => validatePolicyProgram([{ ...base, effect: "block" }])).toThrow(/reserved/);
  });

  it("rejects ambiguous selectors, empty conditions, and unknown runtime AST values", () => {
    const base = {
      id: "rule:strict",
      title: "strict",
      authority: { kind: "organization" as const, id: "acme" },
      effect: "deny" as const,
      mandatory: true,
      match: { operations: ["delete"] },
      explanation: "trusted rule",
    };
    const unchecked = (value: unknown): readonly PolicyRule[] => [value as PolicyRule];

    expect(() => validatePolicyProgram(unchecked({ ...base, match: { operations: [] } }))).toThrow(/must not be empty/);
    expect(() => validatePolicyProgram(unchecked({ ...base, when: { op: "any", conditions: [] } }))).toThrow(/must not be empty/);
    expect(() => validatePolicyProgram(unchecked({
      ...base,
      when: { op: "in", value: { fact: "team" }, set: [] },
    }))).toThrow(/must not be empty/);
    expect(() => validatePolicyProgram(unchecked({ ...base, when: { op: "sometimes" } }))).toThrow(/unsupported/);
    expect(() => validatePolicyProgram(unchecked({ ...base, effect: "audit" }))).toThrow(/unsupported/);
    expect(() => validatePolicyProgram(unchecked({
      ...base,
      authority: { kind: "team", id: "acme" },
    }))).toThrow(/unsupported/);
    expect(() => validatePolicyProgram(unchecked({
      ...base,
      match: { subjectTypes: ["robot"] },
    }))).toThrow(/unsupported/);
  });

  it("keeps missing facts and hierarchies distinct from a false condition", () => {
    const condition = {
      op: "not" as const,
      condition: { op: "eq" as const, left: { fact: "suspended" }, right: { value: true as const } },
    };
    expect(evaluateConditionResult(condition, {})).toBe("unknown");
    expect(evaluateConditionResult(condition, { suspended: false })).toBe(true);
    expect(evaluateConditionResult({
      op: "ancestor",
      hierarchy: "reports",
      ancestor: { value: "manager" },
      descendant: { value: "alice" },
    })).toBe("unknown");
  });
});
