import { describe, expect, it } from "vitest";

import type { ConstraintResult, ReviewFinding } from "../shared/model.js";
import { hasBlockingCheckResult, waivedCheckLines } from "./cli.js";

const constraint = (status: ConstraintResult["status"]): ConstraintResult => ({
  id: status,
  title: status,
  description: "",
  concern: "modularity",
  severity: "high",
  status,
  summary: "",
  evidence: [],
  violations: [],
  waivedViolations: [],
});

describe("architecture check gate", () => {
  it("blocks failed and indeterminate machine results", () => {
    expect(hasBlockingCheckResult({ constraints: [constraint("fail")], findings: [] })).toBe(true);
    expect(hasBlockingCheckResult({ constraints: [constraint("unknown")], findings: [] })).toBe(true);
    expect(hasBlockingCheckResult({ constraints: [constraint("pass"), constraint("waived"), constraint("review")], findings: [] })).toBe(false);
  });

  it("blocks severe analyzer environment failures", () => {
    const finding: ReviewFinding = {
      id: "tool", title: "Analyzer", description: "broken resolver", severity: "high",
      moduleIds: [], signal: "tooling",
    };
    expect(hasBlockingCheckResult({ constraints: [], findings: [finding] })).toBe(true);
  });

  it("prints the exact active waiver witness and its expiry", () => {
    const waived = constraint("waived");
    waived.waivedViolations = [{
      witness: "path:a -> b",
      message: "a directly depends on b",
      path: ["a", "b"],
      waiver: {
        constraintId: waived.id,
        witness: "path:a -> b",
        reason: "migration",
        owner: "platform",
        created_at: "2026-08-01T00:00:00Z",
        expires_at: "2026-09-01T00:00:00Z",
      },
    }];
    expect(waivedCheckLines({ constraints: [waived] })).toEqual([
      "- waived [path:a -> b] owner=platform expires=2026-09-01T00:00:00Z: migration",
    ]);
  });
});
