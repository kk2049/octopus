import { describe, expect, it } from "vitest";
import { dependencyWait, recoveryAction, type RecoveryEvidence } from "./managed-execution.js";

const prepared: RecoveryEvidence = { desired: "running", resumeOwner: "head", coordinator: "head",
  authorized: true, dependencyAvailable: true, dispatch: "not_sent" };
describe("shared managed execution recovery contract", () => {
  it("requires positive unsent evidence and one recovery owner", () => {
    expect(recoveryAction(prepared)).toBe("dispatch_prepared");
    for (const dispatch of ["sent", "uncertain"] as const) expect(recoveryAction({ ...prepared, dispatch })).toBe("query_original");
    expect(recoveryAction({ ...prepared, resumeOwner: "runner" })).toBe("query_original");
    expect(recoveryAction({ ...prepared, resumeOwner: "runner", coordinator: "runner", dispatch: "acknowledged_interrupted" })).toBe("resume_acknowledged");
  });
  it("cannot turn availability into authority or take over observed children", () => {
    for (const desired of ["paused", "cancelled"] as const) expect(recoveryAction({ ...prepared, desired })).toBe("none");
    for (const resumeOwner of ["observed", "parent"] as const) expect(recoveryAction({ ...prepared, resumeOwner })).toBe("none");
    expect(recoveryAction({ ...prepared, authorized: false })).toBe("refuse");
    expect(recoveryAction({ ...prepared, dependencyAvailable: false })).toBe("wait");
  });
  it("makes the first minute and continued waiting share one boundary", () => {
    expect(dependencyWait(100, 100)).toEqual({ state: "reconnecting", delayMs: 5000 });
    expect(dependencyWait(100, 60_099)).toEqual({ state: "reconnecting", delayMs: 1 });
    expect(dependencyWait(100, 60_100)).toEqual({ state: "waiting_resource", delayMs: 30_000 });
  });
});
