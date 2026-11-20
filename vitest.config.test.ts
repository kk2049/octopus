import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json")));
const root = fileURLToPath(new URL(".", import.meta.url));
const browserSpec = "packages/bot/src/session-plus/browser.e2e.test.ts";
const ordinarySpec = "packages/bot/src/config.test.ts";

async function selectedFiles(extra: string[] = []): Promise<string[]> {
  // List the actual project configuration without starting either test suite.
  const result = await exec(process.execPath, [
    cli, "list", "--filesOnly", "--project", "node", ...extra, browserSpec, ordinarySpec,
  ], { cwd: root, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.split("\n").filter((line) => line.startsWith("[node] "));
}

describe("root Node project CLI exclusions", () => {
  it("keeps browser coverage in ordinary CI and honors only explicit exclusions", { timeout: 60_000 }, async () => {
    expect(await selectedFiles()).toEqual(expect.arrayContaining([
      `[node] ${browserSpec}`, `[node] ${ordinarySpec}`,
    ]));
    expect(await selectedFiles(["--exclude", browserSpec])).toEqual([`[node] ${ordinarySpec}`]);
    expect(await selectedFiles([`--exclude=${ordinarySpec}`])).toEqual([`[node] ${browserSpec}`]);
  });
});
