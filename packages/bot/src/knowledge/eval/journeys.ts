#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { SqliteCodeIndexResolver } from "../code-index.js";
import { GraphDb } from "../graph-db.js";
import { LocalE5EmbeddingProvider } from "../model-binding.js";
import { KnowledgeRetriever, SimilarityRegistry, LexicalIndex } from "../retrieval.js";
import { FlatVectorIndex } from "../vector-index.js";
import { evaluateJourneys, parseKnowledgeJourneys, journeyReport } from "./journey-evaluation.js";
export * from "./journey-evaluation.js";

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

async function main(): Promise<void> {
  const options = flags(process.argv.slice(2));
  const graphFile = options.get("graph");
  if (!graphFile) throw new Error("--graph <graph.db> is required");
  const graph = GraphDb.openReadonly(path.resolve(graphFile));
  if (!graph) throw new Error(`graph not found: ${graphFile}`);
  const repoSha = String(graph.meta().commit ?? "");
  if (!/^[0-9a-f]{40}$/u.test(repoSha)) throw new Error("graph has no exact repository SHA");
  const journeys = parseKnowledgeJourneys(fs.readFileSync(path.resolve(options.get("journeys") ?? "architecture/knowledge/journeys.md"), "utf8"));
  const codeIndex = options.get("code-index") ? new SqliteCodeIndexResolver(path.resolve(options.get("code-index")!)) : undefined;
  const provider = options.get("vector") && options.get("model") ? new LocalE5EmbeddingProvider(path.resolve(options.get("model")!)) : undefined;
  const indexes = new SimilarityRegistry([new LexicalIndex(graph)]);
  if (provider) indexes.register(FlatVectorIndex.open({ directory: path.resolve(options.get("vector")!), repoSha, provider }));
  try {
    const retriever = new KnowledgeRetriever(graph, indexes, codeIndex);
    const outcomes = await evaluateJourneys(retriever, journeys, repoSha, codeIndex);
    const report = journeyReport(graph, journeys, outcomes);
    for (const outcome of outcomes) console.log(`${outcome.passed ? "PASS" : "FAIL"} ${outcome.id} recall@10=${outcome.recall_at_10.toFixed(3)} nDCG@10=${outcome.ndcg_at_10.toFixed(3)} MRR=${outcome.reciprocal_rank.toFixed(3)} chars=${outcome.chars}${outcome.missing.length ? ` missing=${outcome.missing.join(";")}` : ""}`);
    console.log(`aggregate recall@10=${report.aggregate.recall_at_10.toFixed(3)} nDCG@10=${report.aggregate.ndcg_at_10.toFixed(3)} MRR=${report.aggregate.mrr.toFixed(3)} forbidden=${report.aggregate.forbidden_at_10} noise=${report.aggregate.judged_noise_at_10.toFixed(3)}`);
    console.log(`hard-gates=${report.hard_gates_passed ? "pass" : "fail"} aggregate=${report.aggregate_passed ? "pass" : "fail"}`);
    if (options.get("json")) fs.writeFileSync(path.resolve(options.get("json")!), `${JSON.stringify(report, null, 2)}\n`);
    if (!report.hard_gates_passed || !report.aggregate_passed) process.exitCode = 1;
  } finally {
    await provider?.close();
    codeIndex?.close();
    graph.close();
  }
}

const invokedDirectly = process.argv[1]
  ? fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))
  : false;
if (invokedDirectly) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
