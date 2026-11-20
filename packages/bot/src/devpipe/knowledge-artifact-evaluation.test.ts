import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../knowledge/model-binding.js";
import { readArtifactEvaluation } from "./knowledge-artifact-service.js";

const roots: string[] = [];
const sha = "a".repeat(40), inputSha = "b".repeat(64);
const at = "2026-09-13T00:00:00.000Z";
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function manifest(evaluations?: unknown) {
  const generation = fs.mkdtempSync(path.join(os.tmpdir(), "remote-knowledge-evaluation-"));
  roots.push(generation);
  const unsigned = { schemaVersion: 1, repoSha: sha, input: { sha256: inputSha }, ...(evaluations === undefined ? {} : { evaluations }) };
  const digest = createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
  const file = path.join(generation, "knowledge-artifact-manifest.json");
  fs.writeFileSync(file, JSON.stringify({ ...unsigned, manifestDigest: digest }));
  return { generation, repoSha: sha, inputSha256: inputSha, manifestDigest: digest, file };
}
function observations() {
  return { schemaVersion: 1, repoSha: sha, inputSha256: inputSha, executor: "dedicated-4090",
    journeys: { scope: "repository", passed: false, exitCode: 1, failureCode: "journeys_failed:J001",
      startedAt: at, finishedAt: at, metrics: { recall_at_10: 0.5, private_path: "/private/ledger" } },
    vectorBenchmark: { scope: "artifact", passed: true, exitCode: 0, startedAt: at, finishedAt: at, metrics: { p95_ms: 10 } } };
}
describe("verified remote artifact observations", () => {
  it("preserves failed repository evaluation separately from full artifact benchmark", async () => {
    const active = manifest(observations());
    expect(await readArtifactEvaluation(active, "journeys")).toEqual({
      passed: false, failureCode: "journeys_failed:J001", scope: "repository", executor: "dedicated-4090",
      startedAt: at, finishedAt: at, metrics: { recall_at_10: 0.5 },
    });
    expect(await readArtifactEvaluation(active, "vectorBenchmark")).toMatchObject({ passed: true, scope: "artifact", metrics: { p95_ms: 10 } });
  });
  it("keeps legacy artifacts queryable while reporting absent evaluation without a local fallback", async () => {
    expect(await readArtifactEvaluation(manifest(), "journeys")).toEqual({
      passed: false, unavailable: true, failureCode: "remote_evaluation_unavailable",
    });
  });
  it("rejects a changed checksum, input identity and repository SHA", async () => {
    const active = manifest(observations());
    await expect(readArtifactEvaluation({ ...active, repoSha: "c".repeat(40) }, "journeys")).rejects.toThrow("identity mismatch");
    await expect(readArtifactEvaluation({ ...active, inputSha256: "c".repeat(64) }, "journeys")).rejects.toThrow("identity mismatch");
    const parsed = JSON.parse(fs.readFileSync(active.file, "utf8")); parsed.evaluations.journeys.passed = true;
    fs.writeFileSync(active.file, JSON.stringify(parsed));
    await expect(readArtifactEvaluation(active, "journeys")).rejects.toThrow("identity mismatch");
  });
  it("rejects contradictory success, wrong scope and private executor paths", async () => {
    for (const edit of [
      (value: ReturnType<typeof observations>) => { value.journeys.passed = true; },
      (value: ReturnType<typeof observations>) => { value.journeys.scope = "runtime"; },
      (value: ReturnType<typeof observations>) => { value.executor = "/private/home"; },
    ]) {
      const value = observations(); edit(value);
      await expect(readArtifactEvaluation(manifest(value), "journeys")).rejects.toThrow("invalid remote");
    }
  });
});
