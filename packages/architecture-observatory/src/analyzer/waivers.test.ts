import { describe, expect, it } from "vitest";

import type { ArchitectureWaiver, ConstraintResult } from "../shared/model.js";
import { applyWaivers, validateWaivers } from "./waivers.js";

const failing = (): ConstraintResult => ({
  id: "BOUNDARY",
  title: "Boundary",
  description: "",
  concern: "trust",
  severity: "critical",
  status: "fail",
  summary: "发现 1 条禁止依赖路径",
  evidence: [],
  violations: [{
    witness: "path:view -> trusted-ui",
    message: "view 直接依赖 trusted-ui",
    path: ["view", "trusted-ui"],
  }],
  waivedViolations: [],
});

const waiver = (expires_at: string, witness = "path:view -> trusted-ui"): ArchitectureWaiver => ({
  constraintId: "BOUNDARY",
  witness,
  reason: "Known migration debt",
  owner: "architecture-owner",
  created_at: "2026-08-01T00:00:00Z",
  expires_at,
});

describe("architecture constraint waivers", () => {
  it("downgrades only an exact, unexpired failing witness", () => {
    const result = applyWaivers({
      constraints: [failing()],
      waivers: [waiver("2026-09-01T00:00:00Z")],
      now: new Date("2026-08-15T00:00:00Z"),
    });
    expect(result.constraints[0]).toMatchObject({ status: "waived", violations: [] });
    expect(result.constraints[0].waivedViolations[0]).toMatchObject({
      witness: "path:view -> trusted-ui",
      waiver: { owner: "architecture-owner" },
    });
    expect(result.findings).toEqual([]);
  });

  it("restores an expired witness to fail and emits a cleanup finding", () => {
    const result = applyWaivers({
      constraints: [failing()],
      waivers: [waiver("2026-08-10T00:00:00Z")],
      now: new Date("2026-08-15T00:00:00Z"),
    });
    expect(result.constraints[0].status).toBe("fail");
    expect(result.constraints[0].violations).toHaveLength(1);
    expect(result.findings).toEqual([expect.objectContaining({ signal: "waiver", title: expect.stringMatching(/已过期/) })]);
  });

  it("reports an active waiver that no longer matches a failing witness", () => {
    const result = applyWaivers({
      constraints: [failing()],
      waivers: [waiver("2026-09-01T00:00:00Z", "path:view -> removed-module")],
      now: new Date("2026-08-15T00:00:00Z"),
    });
    expect(result.constraints[0].status).toBe("fail");
    expect(result.findings).toEqual([expect.objectContaining({ signal: "waiver", title: expect.stringMatching(/Stale waiver/) })]);
  });

  it("validates required metadata, timestamps, unknown fields and duplicates", () => {
    const valid = { version: 1, waivers: [waiver("2026-09-01T00:00:00Z")] };
    expect(validateWaivers(valid).waivers).toHaveLength(1);
    expect(() => validateWaivers({ version: 1, waivers: [{ ...valid.waivers[0], expires_at: undefined }] })).toThrow(/expires_at/);
    expect(() => validateWaivers({ version: 1, waivers: [{ ...valid.waivers[0], expires_at: "2026-07-01T00:00:00Z" }] })).toThrow(/after created_at/);
    expect(() => validateWaivers({ version: 1, waivers: [{ ...valid.waivers[0], constraintId: "not valid" }] })).toThrow(/invalid identifier/);
    expect(() => validateWaivers({ version: 1, waivers: [{ ...valid.waivers[0], forever: true }] })).toThrow(/unknown field/);
    expect(() => validateWaivers({ version: 1, waivers: [valid.waivers[0], valid.waivers[0]] })).toThrow(/duplicate waiver/);
  });
});
