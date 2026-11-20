import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recordStartupFailure, startupFailureDetail } from "./startup-failure.js";

it("retains only bounded diagnostics for the exact deployment across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "startup-failure-"));
  try {
    recordStartupFailure(dir, 265, "session-plus", { service: "state", phase: "recovery", code: "child_not_ready", elapsedMs: 60000 });
    expect(startupFailureDetail(dir, 265)).toContain("phase=recovery; elapsed=60000ms");
    expect(startupFailureDetail(dir, 266)).toBeNull();
    const file = join(dir, "deploy-startup-failure.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, JSON.stringify({ id: 265, app: "secret\ntext" }));
    expect(startupFailureDetail(dir, 265)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
