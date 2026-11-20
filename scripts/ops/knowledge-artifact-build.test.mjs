import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots = [];
const builder = fileURLToPath(new URL("./knowledge-artifact-build.mjs", import.meta.url));
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function runBuild(failConformance) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-preflight-")); roots.push(root);
  const repo = path.join(root, "repo"), bin = path.join(root, "bin"), input = path.join(root, "input.json");
  const trace = path.join(root, "calls.jsonl"), out = path.join(root, "artifact");
  fs.mkdirSync(repo); fs.mkdirSync(bin); fs.writeFileSync(input, "{}\n");
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], { cwd: repo });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  // Preserve the real builder/checkout checks; only replace expensive child commands.
  fs.writeFileSync(path.join(bin, "pnpm"), `#!${process.execPath}\n` +
    'const fs = require("node:fs"); const args = process.argv.slice(2);\n' +
    'fs.appendFileSync(process.env.BUILD_TEST_TRACE, JSON.stringify(args) + "\\n");\n' +
    'process.exit(args.includes("vitest") ? (process.env.BUILD_TEST_FAIL === "1" && args.at(-1).includes("agent-control-plane") ? 1 : 0) : 42);\n', { mode: 0o700 });
  const result = spawnSync(process.execPath, [builder, "--root", repo, "--input", input, "--out", out, "--repo-sha", sha], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BUILD_TEST_TRACE: trace, BUILD_TEST_FAIL: failConformance ? "1" : "0" },
  });
  const calls = fs.readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { result, calls, remaining: fs.readdirSync(root).filter((name) => name.startsWith("artifact")) };
}
describe("knowledge artifact preflight", () => {
  it("collects all fixed conformance failures before any indexing or model work", () => {
    const { result, calls, remaining } = runBuild(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("1 fixed conformance test file(s) failed");
    expect(calls.map((args) => args.at(-1))).toEqual([
      "packages/bot/src/knowledge/contracts.test.ts", "packages/bot/src/session-plus/operation-binding.test.ts",
      "packages/runner/src/agent-control-plane.test.ts", "packages/runner/src/omp-rpc.test.ts",
    ]);
    expect(calls.every((args) => args.includes("vitest"))).toBe(true);
    expect(remaining).toEqual([]);
  });
  it("begins code indexing only after all four conformance files pass", () => {
    const { result, calls, remaining } = runBuild(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed with rc 42");
    expect(calls).toHaveLength(5);
    expect(calls.slice(0, 4).every((args) => args.includes("vitest"))).toBe(true);
    expect(calls[4]).toContain("packages/architecture-observatory/src/code-index/cli.ts");
    expect(remaining).toEqual([]);
  });
});
