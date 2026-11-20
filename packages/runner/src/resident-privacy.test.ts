import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearLegacyRunnerLogs, isResidentInvocation } from "./resident-privacy.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "runner-privacy-")); roots.push(home);
  const logs = path.join(home, ".octopus", "runner", "logs");
  await mkdir(logs, { recursive: true });
  return { home, logs };
}

describe("resident log privacy", () => {
  it("keeps CLI and MCP protocol output separate from resident output", () => {
    for (const args of [[], ["daemon"], ["run", "--foreground"]]) expect(isResidentInvocation(args)).toBe(true);
    for (const args of [["mcp", "stdio"], ["hook", "report"], ["status"], ["logs", "--clear"]]) expect(isResidentInvocation(args)).toBe(false);
  });
  it("clears only fixed legacy log files, is idempotent, and preserves unrelated data", async () => {
    const { home, logs } = await fixture();
    await writeFile(path.join(logs, "runner.out.log"), "private command");
    await writeFile(path.join(logs, "stderr.log"), "private exception");
    await writeFile(path.join(logs, "recovery.json"), "keep receipt");
    await writeFile(path.join(home, "project.log"), "keep project");
    const result = await clearLegacyRunnerLogs(home);
    expect(result.failed).toEqual([]);
    expect(result.bytes).toBe(32);
    expect(await readFile(path.join(logs, "runner.out.log"), "utf8")).toBe("");
    expect(await readFile(path.join(logs, "recovery.json"), "utf8")).toBe("keep receipt");
    expect(await readFile(path.join(home, "project.log"), "utf8")).toBe("keep project");
    expect((await clearLegacyRunnerLogs(home)).bytes).toBe(0);
  });
  it.skipIf(process.platform === "win32")("refuses symlink and hardlink targets without erasing their content", async () => {
    const { home, logs } = await fixture();
    const target = path.join(home, "private-history"); await writeFile(target, "keep history");
    await symlink(target, path.join(logs, "runner.out.log"));
    await link(target, path.join(logs, "runner.err.log"));
    expect((await clearLegacyRunnerLogs(home)).failed).toHaveLength(2);
    expect(await readFile(target, "utf8")).toBe("keep history");
  });
  it.skipIf(process.platform === "win32")("refuses a redirected logs directory", async () => {
    const { home, logs } = await fixture();
    const elsewhere = path.join(home, "elsewhere"); await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, "runner.out.log"), "keep other data");
    await rm(logs, { recursive: true }); await symlink(elsewhere, logs);
    expect((await clearLegacyRunnerLogs(home)).failed).toEqual([logs]);
    expect(await readFile(path.join(elsewhere, "runner.out.log"), "utf8")).toBe("keep other data");
  });
});
