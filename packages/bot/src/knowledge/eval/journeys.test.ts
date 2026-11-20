import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeIndexResolver } from "../code-index.js";
import { GraphDb } from "../graph-db.js";
import type { KnowledgeNode } from "../model.js";
import { KnowledgeRetriever, LexicalIndex, SimilarityRegistry } from "../retrieval.js";
import { evaluateJourneys, parseKnowledgeJourneys, type JourneyDocument } from "./journeys.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "c".repeat(40);
const DIGEST = "b".repeat(64);
const graphs: GraphDb[] = [];

function graph(nodes: KnowledgeNode[]): GraphDb {
  const value = GraphDb.openInMemory();
  value.fill({
    nodes,
    edges: [],
    coverage: [],
    conflicts: [],
    cells: [],
    observations: [],
    observationArtifacts: [],
    meta: {
      schema_version: 2,
      commit: SHA,
      built_at: "2026-08-23T00:00:00.000Z",
      evaluation_as_of: "2026-08-23",
      tool_version: "2",
      input_fingerprint: DIGEST,
      projection_digest: DIGEST,
      node_count: nodes.length,
      edge_count: 0,
    },
  });
  graphs.push(value);
  return value;
}

function codeIndex(gitSha: string, stale = false): CodeIndexResolver {
  const result = () => stale
    ? { status: "stale_code_index" as const, requestedSha: SHA, indexedSha: gitSha, items: [] as const }
    : { status: "ok" as const, repoSha: SHA, items: [] as const };
  return {
    gitSha,
    manifestDigest: DIGEST,
    resolveArtifact: () => null,
    resolvePosition: result,
    searchSymbols: result,
    definitions: result,
    references: result,
    implementations: result,
    testsForSymbol: result,
    calls: result,
  };
}

function journey(step: JourneyDocument["journeys"][number]["steps"][number]): JourneyDocument {
  return {
    schema_version: 1,
    targets: { recall_at_10: 0, ndcg_at_10: 0, mrr: 0, forbidden_at_10: 0, judged_noise_at_10: 1 },
    journeys: [{
      id: "J001",
      class: "code",
      title: "matching code index",
      hard_gate: true,
      steps: [step],
    }],
  };
}

afterEach(() => {
  while (graphs.length) graphs.pop()!.close();
});

describe("Markdown knowledge journeys", () => {
  it("parses the single authoritative fenced JSON block with contiguous J001-J030 and six hard gates", () => {
    const document = parseKnowledgeJourneys(fs.readFileSync("architecture/knowledge/journeys.md", "utf8"));
    expect(document.journeys).toHaveLength(30);
    expect(document.journeys.slice(24).map((journey) => journey.id)).toEqual(["J025", "J026", "J027", "J028", "J029", "J030"]);
    expect(document.journeys.filter((journey) => journey.hard_gate)).toHaveLength(6);
    expect(document.journeys.find((journey) => journey.id === "J030")?.steps).toHaveLength(2);
  });

  it("rejects missing, duplicate or non-JSON journey authorities", () => {
    expect(() => parseKnowledgeJourneys("# no block\n")).toThrow(/exactly one/);
    const source = fs.readFileSync("architecture/knowledge/journeys.md", "utf8");
    const block = source.match(/```octopus-journeys[\s\S]*?```/u)?.[0] ?? "";
    expect(() => parseKnowledgeJourneys(`${source}\n${block}`)).toThrow(/exactly one/);
    expect(() => parseKnowledgeJourneys("```octopus-journeys\n{not json}\n```\n")).toThrow(/strict JSON/);
  });

  it("does not count a graph-resident record that the query path did not retrieve", async () => {
    const resident: KnowledgeNode = {
      id: "decision:resident",
      kind: "decision",
      statement: "This node exists but is not retrieved.",
      status: "active",
      authority: "declared",
      source_ref: "architecture/knowledge/contracts/test.md",
      source_sha: SHA,
      method: "declared",
      certainty: "exact",
    };
    const retriever = new KnowledgeRetriever(graph([resident]), new SimilarityRegistry([]));
    const document: JourneyDocument = {
      schema_version: 1,
      targets: { recall_at_10: 0, ndcg_at_10: 0, mrr: 0, forbidden_at_10: 0, judged_noise_at_10: 1 },
      journeys: [{
        id: "J001",
        class: "decision",
        title: "resident is not enough",
        hard_gate: false,
        steps: [{
          id: "J001.1",
          query: { text: "unrelated", code_index: "none" },
          qrels: [{ match: "record_id", value: resident.id, relevance: 3, max_rank: 10 }],
          forbidden: [],
          expected_unknown: ["no_grounded_answer"],
          no_answer: false,
          max_chars: 7_000,
        }],
      }],
    };
    const [outcome] = await evaluateJourneys(retriever, document, SHA);
    expect(outcome.recall_at_10).toBe(0);
    expect(outcome.missing).toContain(`record_id:${resident.id}`);
  });

  it("hard-fails matching-index steps without a live resolver at the graph SHA", async () => {
    const resident: KnowledgeNode = {
      id: "decision:indexed-artifact",
      kind: "decision",
      statement: "The indexed artifact is projected into the graph.",
      status: "active",
      authority: "declared",
      source_ref: "architecture/knowledge/contracts/test.md",
      source_sha: SHA,
      method: "declared",
      certainty: "exact",
    };
    const value = graph([resident]);
    const document = journey({
      id: "J001.1",
      query: { text: resident.statement, code_index: "matching" },
      qrels: [{ match: "record_id", value: resident.id, relevance: 3, max_rank: 10 }],
      forbidden: [],
      expected_unknown: [],
      no_answer: false,
      max_chars: 7_000,
    });

    const [graphOnly] = await evaluateJourneys(new KnowledgeRetriever(value), document, SHA);
    expect(graphOnly.recall_at_10).toBe(1);
    expect(graphOnly.passed).toBe(false);
    expect(graphOnly.missing).toContain("code_index:matching resolver unavailable");

    const stale = codeIndex(OTHER_SHA);
    const [wrongSha] = await evaluateJourneys(new KnowledgeRetriever(value, undefined, stale), document, SHA, stale);
    expect(wrongSha.passed).toBe(false);
    expect(wrongSha.missing).toContain(`code_index:matching SHA ${OTHER_SHA}!=${SHA}`);

    const matching = codeIndex(SHA);
    const [exactSha] = await evaluateJourneys(new KnowledgeRetriever(value, undefined, matching), document, SHA, matching);
    expect(exactSha.passed).toBe(true);
  });

  it("rejects an unlisted stale-index unknown in matching mode", async () => {
    const stale = codeIndex(SHA, true);
    const document = journey({
      id: "J001.1",
      query: {
        text: "Find the indexed symbol.",
        symbol: { path: "packages/a.ts", qualified_name: "A.run" },
        code_index: "matching",
      },
      qrels: [],
      forbidden: [],
      expected_unknown: [],
      no_answer: false,
      max_chars: 7_000,
    });
    const [outcome] = await evaluateJourneys(new KnowledgeRetriever(graph([]), undefined, stale), document, SHA, stale);
    expect(outcome.passed).toBe(false);
    expect(outcome.missing).toContain("unexpected_unknown:code_index_stale");
  });

  it("grades each qrel once at its first retrieved rank and keeps nDCG within [0, 1]", async () => {
    const twin = (id: string): KnowledgeNode => ({
      id,
      kind: "decision",
      statement: "shared marker appears in both records",
      status: "active",
      authority: "declared",
      source_ref: "architecture/knowledge/contracts/test.md",
      source_sha: SHA,
      method: "declared",
      certainty: "exact",
    });
    const value = graph([twin("decision:first"), twin("decision:second")]);
    const retriever = new KnowledgeRetriever(value, new SimilarityRegistry([new LexicalIndex(value)]));
    const document = journey({
      id: "J001.1",
      query: { text: "shared marker appears", code_index: "none" },
      qrels: [{ match: "text_contains", value: "shared marker", relevance: 3, max_rank: 10 }],
      forbidden: [],
      expected_unknown: [],
      no_answer: false,
      max_chars: 7_000,
    });
    const [outcome] = await evaluateJourneys(retriever, document, SHA);
    expect(outcome.recall_at_10).toBe(1);
    expect(outcome.ndcg_at_10).toBe(1);
  });
});
