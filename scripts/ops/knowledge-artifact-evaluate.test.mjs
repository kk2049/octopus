import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateKnowledgeArtifact } from "./knowledge-artifact-evaluate.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-build-evaluation-")); roots.push(root);
  const input = path.join(root, "input.json"), artifact = path.join(root, "artifact");
  fs.mkdirSync(artifact);
  fs.writeFileSync(input, JSON.stringify({ repo_sha: "a".repeat(40), evaluation_as_of: "2026-09-13" }));
  return { root, input, artifact, repoSha: "a".repeat(40), inputSha256: createHash("sha256").update(fs.readFileSync(input)).digest("hex") };
}
describe("remote knowledge artifact observations", () => {
  it("evaluates only repository inputs and preserves failed journeys without hiding the vector result", async () => {
    const options = fixture(), calls = [];
    const result = await evaluateKnowledgeArtifact({ ...options, command: async (_root, _node, args, config) => {
      calls.push({ args, config });
      const out = args.indexOf("--json");
      if (out !== -1) fs.writeFileSync(args[out + 1], JSON.stringify(args.some((arg) => arg.includes("journeys.ts"))
        ? { graph: { commit: options.repoSha }, aggregate: { recall_at_10: 0.5 }, hard_gates_passed: false, aggregate_passed: false, outcomes: [{ id: "J001", passed: false }] }
        : { repo_sha: options.repoSha, records: 42, p95_ms: 10 }));
      return { code: args.some((arg) => arg.includes("journeys.ts")) ? 1 : 0 };
    } });
    expect(result.journeys).toMatchObject({ scope: "repository", passed: false, exitCode: 1, failureCode: "journeys_failed:J001" });
    expect(result.vectorBenchmark).toMatchObject({ scope: "artifact", passed: true, metrics: { records: 42, p95_ms: 10 } });
    expect(result.repoSha).toBe(options.repoSha); expect(result.inputSha256).toBe(options.inputSha256);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.config.timeoutMs === 600_000)).toBe(true);
    expect(calls[0].args).toContain(options.repoSha);
    expect(calls.flatMap((call) => call.args)).not.toContain("--runtime");
    expect(calls.flatMap((call) => call.args)).not.toContain("--bot-db");
    expect(fs.readdirSync(options.root).some((name) => name.startsWith(".knowledge-evaluation-"))).toBe(false);
  });
  it("still evaluates vectors if the repository graph cannot be built", async () => {
    const options = fixture(); let calls = 0;
    const result = await evaluateKnowledgeArtifact({ ...options, command: async (_root, _node, args) => {
      if (++calls === 1) throw new Error("graph failed");
      fs.writeFileSync(args[args.indexOf("--json") + 1], JSON.stringify({ repo_sha: options.repoSha, records: 42 }));
      return { code: 0 };
    } });
    expect(result.journeys).toMatchObject({ passed: false, failureCode: "repository_journeys_error" });
    expect(result.vectorBenchmark.passed).toBe(true); expect(calls).toBe(2);
  });
  it("rejects mismatched contextual identity before launching evaluation", async () => {
    const options = fixture(); let calls = 0;
    await expect(evaluateKnowledgeArtifact({ ...options, repoSha: "c".repeat(40), command: async () => { calls++; } })).rejects.toThrow("identity");
    expect(calls).toBe(0);
    expect(fs.readdirSync(options.root).some((name) => name.startsWith(".knowledge-evaluation-"))).toBe(false);
  });
});
