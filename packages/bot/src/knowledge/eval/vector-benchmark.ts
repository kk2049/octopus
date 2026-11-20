#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { LocalE5EmbeddingProvider } from "../model-binding.js";
import { FlatVectorIndex, VECTOR_MANIFEST_FILENAME } from "../vector-index.js";

interface BenchmarkReport {
  repo_sha: string;
  records: number;
  dimensions: number;
  iterations: number;
  top_k: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  queries_per_second: number;
  rss_delta_bytes: number;
}

function flags(argv: readonly string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const [key, inline] = argument.slice(2).split("=", 2);
    if (inline !== undefined) output.set(key, inline);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) output.set(key, argv[++index]);
    else output.set(key, "true");
  }
  return output;
}

function positiveInteger(raw: string | undefined, fallback: number, label: string, maximum: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  return value;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function manifestIdentity(file: string): { repoSha: string; records: number; dimensions: number } {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !("repo_sha" in parsed) || typeof parsed.repo_sha !== "string" || !/^[0-9a-f]{40}$/u.test(parsed.repo_sha)
    || !("record_count" in parsed) || typeof parsed.record_count !== "number" || !Number.isSafeInteger(parsed.record_count)
    || !("dimensions" in parsed) || typeof parsed.dimensions !== "number" || !Number.isSafeInteger(parsed.dimensions)) {
    throw new Error("vector manifest identity is invalid");
  }
  return { repoSha: parsed.repo_sha, records: parsed.record_count, dimensions: parsed.dimensions };
}

async function main(): Promise<void> {
  const options = flags(process.argv.slice(2));
  const vectorDirectory = options.get("vector");
  const modelDirectory = options.get("model");
  if (!vectorDirectory || !modelDirectory) throw new Error("--vector <artifact-dir> and --model <verified-model-dir> are required");
  const iterations = positiveInteger(options.get("iterations"), 50, "--iterations", 10_000);
  const topK = positiveInteger(options.get("top-k"), 10, "--top-k", 200);
  const identity = manifestIdentity(path.join(path.resolve(vectorDirectory), VECTOR_MANIFEST_FILENAME));
  const provider = new LocalE5EmbeddingProvider(path.resolve(modelDirectory));
  const index = FlatVectorIndex.open({ directory: path.resolve(vectorDirectory), repoSha: identity.repoSha, provider });
  const queries = (options.get("query") ?? [
    "external OMP tmux idle append provider parity",
    "外部 OMP 会话追加消息的权限和测试",
    "symbol to design obligation",
  ].join("|")).split("|").map((value) => value.trim()).filter(Boolean);
  const rssBefore = process.memoryUsage().rss;
  const latencies: number[] = [];
  try {
    await index.search({ text: queries[0], filters: { lifecycle: "current" }, limit: topK });
    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const queryStarted = performance.now();
      await index.search({ text: queries[iteration % queries.length], filters: { lifecycle: "current" }, limit: topK });
      latencies.push(performance.now() - queryStarted);
    }
    const elapsed = performance.now() - started;
    latencies.sort((a, b) => a - b);
    const report: BenchmarkReport = {
      repo_sha: identity.repoSha,
      records: identity.records,
      dimensions: identity.dimensions,
      iterations,
      top_k: topK,
      p50_ms: percentile(latencies, 0.5),
      p95_ms: percentile(latencies, 0.95),
      max_ms: latencies.at(-1) ?? 0,
      queries_per_second: iterations / (elapsed / 1000),
      rss_delta_bytes: process.memoryUsage().rss - rssBefore,
    };
    console.log(JSON.stringify(report, null, 2));
    if (options.get("json")) fs.writeFileSync(path.resolve(options.get("json")!), `${JSON.stringify(report, null, 2)}\n`);
    const maximumP95 = options.get("max-p95-ms") === undefined ? undefined : Number(options.get("max-p95-ms"));
    const maximumRssMb = options.get("max-rss-mb") === undefined ? undefined : Number(options.get("max-rss-mb"));
    if (maximumP95 !== undefined && (!Number.isFinite(maximumP95) || report.p95_ms > maximumP95)) process.exitCode = 1;
    if (maximumRssMb !== undefined && (!Number.isFinite(maximumRssMb) || report.rss_delta_bytes > maximumRssMb * 1024 * 1024)) process.exitCode = 1;
  } finally {
    await provider.close();
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
