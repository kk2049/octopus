import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

const JOURNEY_METRICS = ["recall_at_10", "ndcg_at_10", "mrr", "forbidden_at_10", "judged_noise_at_10"];
const VECTOR_METRICS = ["records", "dimensions", "iterations", "top_k", "p50_ms", "p95_ms", "max_ms", "queries_per_second", "rss_delta_bytes"];

function metrics(source, names) {
  return Object.fromEntries(names.flatMap((key) =>
    typeof source[key] === "boolean" || (typeof source[key] === "number" && Number.isFinite(source[key]))
      ? [[key, source[key]]] : []));
}

/** Observations run only in the immutable remote build checkout, without the private runtime ledger. */
export async function evaluateKnowledgeArtifact({ root, input, artifact, repoSha, inputSha256, command }) {
  const source = await readFile(input);
  if (createHash("sha256").update(source).digest("hex") !== inputSha256) throw new Error("evaluation contextual input digest mismatch");
  const context = JSON.parse(source.toString("utf8"));
  if (context.repo_sha !== repoSha || !/^\d{4}-\d{2}-\d{2}$/.test(context.evaluation_as_of)) {
    throw new Error("evaluation contextual input identity is invalid");
  }
  const temp = await mkdtemp(path.join(path.dirname(artifact), ".knowledge-evaluation-"));
  const result = { schemaVersion: 1, repoSha, inputSha256, executor: os.hostname().slice(0, 100) };
  const graph = path.join(temp, "repository-graph.db");
  try {
    const journeyStart = new Date().toISOString();
    try {
      await command(root, process.execPath, ["--import", "tsx", "packages/bot/src/knowledge/cli.ts", "build",
        "--root", root, "--at", repoSha, "--out", graph, "--evaluation-as-of", context.evaluation_as_of,
        "--code-index", path.join(artifact, "code")], { timeoutMs: 600_000 });
      const reportFile = path.join(temp, "journeys.json");
      const outcome = await command(root, process.execPath, ["--import", "tsx", "packages/bot/src/knowledge/eval/journeys.ts",
        "--graph", graph, "--journeys", path.join(root, "architecture/knowledge/journeys.md"),
        "--code-index", path.join(artifact, "code"), "--json", reportFile], { allowFailure: true, timeoutMs: 600_000 });
      const report = JSON.parse(await readFile(reportFile, "utf8"));
      if (report.graph?.commit !== repoSha) throw new Error("journey report SHA mismatch");
      const passed = outcome.code === 0 && report.hard_gates_passed === true && report.aggregate_passed === true;
      const failures = (report.outcomes ?? []).filter((row) => row.passed === false)
        .slice(0, 8).map((row) => String(row.id).slice(0, 20));
      result.journeys = {
        scope: "repository", passed, exitCode: outcome.code, startedAt: journeyStart, finishedAt: new Date().toISOString(),
        ...(!passed ? { failureCode: ("journeys_failed:" + failures.join(",")).slice(0, 100) } : {}),
        metrics: { ...metrics(report.aggregate ?? {}, JOURNEY_METRICS),
          hard_gates_passed: report.hard_gates_passed === true, aggregate_passed: report.aggregate_passed === true },
      };
    } catch (error) {
      result.journeys = { scope: "repository", passed: false, exitCode: Number.isInteger(error?.code) ? error.code : 1, failureCode: "repository_journeys_error",
        startedAt: journeyStart, finishedAt: new Date().toISOString(), metrics: {} };
    }
    const vectorStart = new Date().toISOString();
    try {
      const reportFile = path.join(temp, "vector.json");
      const outcome = await command(root, process.execPath, ["--import", "tsx", "packages/bot/src/knowledge/eval/vector-benchmark.ts",
        "--vector", path.join(artifact, "vector"), "--model", path.join(artifact, "model"),
        "--iterations", "20", "--json", reportFile], { allowFailure: true, timeoutMs: 600_000 });
      const report = JSON.parse(await readFile(reportFile, "utf8"));
      if (report.repo_sha !== repoSha) throw new Error("vector report SHA mismatch");
      result.vectorBenchmark = { scope: "artifact", passed: outcome.code === 0, exitCode: outcome.code,
        startedAt: vectorStart, finishedAt: new Date().toISOString(),
        ...(outcome.code !== 0 ? { failureCode: "vector_benchmark_failed" } : {}),
        metrics: metrics(report, VECTOR_METRICS) };
    } catch (error) {
      result.vectorBenchmark = { scope: "artifact", passed: false, exitCode: Number.isInteger(error?.code) ? error.code : 1, failureCode: "vector_benchmark_error",
        startedAt: vectorStart, finishedAt: new Date().toISOString(), metrics: {} };
    }
    return result;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
