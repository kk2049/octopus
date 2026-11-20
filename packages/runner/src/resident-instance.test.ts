import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimRunnerInstance } from "./resident-instance.js";

describe("resident single instance", () => {
  it("rejects a duplicate without replacing the live owner, and releases for update handover", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-instance-"));
    const first = await claimRunnerInstance(home);
    try {
      await expect(claimRunnerInstance(home)).rejects.toThrow(/another Runner/);
      await first.close();
      const next = await claimRunnerInstance(home);
      await expect(claimRunnerInstance(home)).rejects.toThrow(/another Runner/);
      await next.close();
    } finally { await first.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("does not delete a non-socket file to obtain a lock", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-instance-file-"));
    mkdirSync(join(home, ".octopus", "runner"), { recursive: true });
    writeFileSync(join(home, ".octopus", "runner", "resident.sock"), "preserve");
    try { await expect(claimRunnerInstance(home)).rejects.toThrow(/non-socket/); }
    finally { rmSync(home, { recursive: true, force: true }); }
  });
});
