import { afterEach, describe, expect, it } from "vitest";
import type { GraphSnapshot } from "./graph-db.js";
import { GraphDb } from "./graph-db.js";
import type { KnowledgeEdge, KnowledgeNode } from "./model.js";
import {
  KnowledgeRetriever,
  SimilarityRegistry,
  matchExpression,
  type SimilarityIndex,
  type SimilarityRequest,
  type SimilaritySearchResult,
} from "./retrieval.js";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const graphs: GraphDb[] = [];

function node(id: string, kind: KnowledgeNode["kind"], statement: string, overrides: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id,
    kind,
    statement,
    status: "active",
    authority: "declared",
    source_ref: "architecture/knowledge/contracts/test.md",
    source_sha: SHA,
    method: "declared",
    certainty: "exact",
    ...overrides,
  };
}

function edge(from_id: string, relation: KnowledgeEdge["relation"], to_id: string): KnowledgeEdge {
  return { from_id, relation, to_id, method: "declared", certainty: "exact", source_ref: "architecture/knowledge/contracts/test.md", source_sha: SHA, observed_at: "2026-08-23T00:00:00.000Z" };
}

function graph(snapshot: Partial<GraphSnapshot> & Pick<GraphSnapshot, "nodes" | "edges">): GraphDb {
  const value = GraphDb.openInMemory();
  value.fill({
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    coverage: snapshot.coverage ?? [],
    conflicts: snapshot.conflicts ?? [],
    cells: snapshot.cells ?? [],
    observations: snapshot.observations ?? [],
    observationArtifacts: snapshot.observationArtifacts ?? [],
    meta: snapshot.meta ?? {
      schema_version: 2,
      commit: SHA,
      built_at: "2026-08-23T00:00:00.000Z",
      evaluation_as_of: "2026-08-23",
      tool_version: "2",
      input_fingerprint: DIGEST,
      projection_digest: DIGEST,
      node_count: snapshot.nodes.length,
      edge_count: snapshot.edges.length,
    },
  });
  graphs.push(value);
  return value;
}

class FixedIndex implements SimilarityIndex {
  readonly version = "1";
  constructor(readonly name: string, private readonly ids: readonly string[], private readonly fail = false, private readonly starts?: string[]) {}

  async search(_request: SimilarityRequest): Promise<SimilaritySearchResult> {
    this.starts?.push(this.name);
    await Promise.resolve();
    if (this.fail) throw Object.assign(new Error("offline"), { code: "provider_unavailable" });
    const hits = this.ids.map((id, index) => ({ id, score: 1 - index / 10 }));
    return {
      hits,
      trace: {
        index: this.name,
        version: this.version,
        kind: this.name.includes("vector") ? "vector" : "fts5_trigram",
        sourceGitSha: SHA,
        artifactSha256: DIGEST,
        recordCount: this.ids.length,
        status: "ok",
        latencyMs: 1,
        hits: hits.map((hit, index) => ({ id: hit.id, rank: index + 1, score: hit.score })),
      },
    };
  }
}

afterEach(() => {
  while (graphs.length) graphs.pop()!.close();
});

describe("typed knowledge retrieval", () => {
  it("runs optional indexes concurrently and keeps exact/lexical results when vector search fails", async () => {
    const contract = node("capability_contract:parity", "capability_contract", "Provider parity");
    const source = node("source:ticket:227", "source", "ticket_body ticket:227");
    const starts: string[] = [];
    const registry = new SimilarityRegistry([
      new FixedIndex("lexical", [contract.id], false, starts),
      new FixedIndex("vector-e5", [], true, starts),
    ]);
    const retriever = new KnowledgeRetriever(graph({ nodes: [contract, source], edges: [edge(contract.id, "supported_by", source.id)] }), registry);
    const result = await retriever.retrieve({ text: "provider parity", repoSha: SHA });
    expect(starts).toEqual(["lexical", "vector-e5"]);
    expect(result.ranked.map((candidate) => candidate.id)).toContain(contract.id);
    expect(result.unknown).toContainEqual({ code: "vector_unavailable", index: "vector-e5" });
    expect(result.trace.outcome.event).toBe("assembled");
    expect(result.chars).toBeLessThanOrEqual(7_000);
  });

  it("bounds a silent vector index and still assembles lexical evidence", async () => {
    const contract = node("capability_contract:bounded", "capability_contract", "Bounded retrieval");
    const hanging: SimilarityIndex = {
      name: "vector-e5",
      version: "1",
      search: async () => await new Promise<SimilaritySearchResult>(() => {}),
    };
    const registry = new SimilarityRegistry([
      new FixedIndex("lexical", [contract.id]),
      hanging,
    ], 10);
    const retriever = new KnowledgeRetriever(graph({ nodes: [contract], edges: [] }), registry);

    const result = await retriever.retrieve({ text: "bounded retrieval", repoSha: SHA });

    expect(result.ranked.map((candidate) => candidate.id)).toContain(contract.id);
    expect(result.unknown).toContainEqual({ code: "vector_unavailable", index: "vector-e5" });
    expect(result.trace.outcome.event).toBe("assembled");
    if (result.trace.outcome.event !== "assembled") throw new Error("retrieval did not assemble");
    expect(result.trace.outcome.plan.indexes.find((attempt) => attempt.index.id === "vector-e5"))
      .toMatchObject({ status: "rejected", error_code: "embed_timeout" });
  });

  it("expands only exact allowlisted relations for two hops and never treats inferred touches as proof", async () => {
    const contract = node("capability_contract:parity", "capability_contract", "Provider parity");
    const obligation = node("obligation:parity/full-stack", "obligation", "Implement every provider action");
    const source = node("source:ticket:227", "source", "ticket_body ticket:227");
    const unrelated = node("artifact:octopus/test/unrelated", "artifact", "unrelated.test.ts", { metadata: { kind: "test" } });
    const inferred = { ...edge(source.id, "touches", unrelated.id), certainty: "inferred" as const };
    const retriever = new KnowledgeRetriever(graph({
      nodes: [contract, obligation, source, unrelated],
      edges: [edge(contract.id, "defines", obligation.id), edge(obligation.id, "supported_by", source.id), inferred],
    }), new SimilarityRegistry([new FixedIndex("lexical", [contract.id])]));
    const result = await retriever.retrieve({ text: "provider parity", repoSha: SHA });
    expect(result.ranked.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([contract.id, obligation.id, source.id]));
    expect(result.ranked.map((candidate) => candidate.id)).not.toContain(unrelated.id);
  });

  it("applies a waiver only when provider, mode, state and action all match", async () => {
    const contract = node("capability_contract:parity", "capability_contract", "Provider parity");
    const scenario = node("scenario:parity/launch", "scenario", "Launch");
    const exception = node("exception:parity/omp-manual", "exception", "OMP manual is refused");
    const desired = node("desired_conformance:parity/omp-manual", "desired_conformance", "omp managed manual-profile launch: unsupported");
    const database = graph({
      nodes: [contract, scenario, exception, desired],
      edges: [edge(exception.id, "waives", desired.id)],
      cells: [{
        id: desired.id,
        contract_id: "capability_contract:parity",
        scenario_id: "scenario:parity/launch",
        provider: "omp",
        launch_mode: "managed",
        state: "manual-profile",
        action: "launch",
        desired: "unsupported",
        expected_ux: "refuse",
        trust_semantics: "no escalation",
        failure_semantics: "no process",
        exception_id: exception.id,
      }],
    });
    const registry = new SimilarityRegistry([new FixedIndex("lexical", [exception.id])]);
    const retriever = new KnowledgeRetriever(database, registry);
    const scoped = await retriever.retrieve({ text: "OMP manual launch", repoSha: SHA, filters: { providers: ["omp"], launchModes: ["managed"], states: ["manual-profile"], actions: ["launch"] } });
    const unscoped = await retriever.retrieve({ text: "OMP manual launch", repoSha: SHA, filters: { providers: ["omp"] } });
    const crossScope = await retriever.retrieve({ text: "OMP manual launch", repoSha: SHA, filters: { providers: ["codex"], launchModes: ["managed"], states: ["manual-profile"], actions: ["launch"] } });
    expect(scoped.slots.decisions_exceptions.map((candidate) => candidate.id)).toContain(exception.id);
    expect(unscoped.ranked.map((candidate) => candidate.id)).not.toContain(exception.id);
    expect(crossScope.ranked.map((candidate) => candidate.id)).not.toContain(exception.id);
  });

  it("rejects a dimensionless exception even when typed query dimensions and lexical evidence are present", async () => {
    const exception = node("exception:parity/dimensionless", "exception", "Dimensionless waiver");
    const retriever = new KnowledgeRetriever(
      graph({ nodes: [exception], edges: [] }),
      new SimilarityRegistry([new FixedIndex("lexical", [exception.id])]),
    );
    const result = await retriever.retrieve({
      text: "dimensionless waiver",
      repoSha: SHA,
      filters: {
        providers: ["omp"],
        launchModes: ["managed"],
        states: ["working"],
        actions: ["append"],
      },
    });
    expect(result.ranked.map((candidate) => candidate.id)).not.toContain(exception.id);
  });

  it("strips exact code/test evidence and emits code_index_stale on SHA mismatch", async () => {
    const obligation = node("obligation:parity/port", "obligation", "Use the provider-neutral operation port");
    const symbol = node("artifact:octopus/symbol/submit", "artifact", "operation-binding.ts#submit", { metadata: { kind: "symbol" } });
    const test = node("artifact:octopus/test/submit", "artifact", "operation-binding.test.ts#submit", { metadata: { kind: "test" } });
    const retriever = new KnowledgeRetriever(graph({ nodes: [obligation, symbol, test], edges: [edge(obligation.id, "realized_by", symbol.id), edge(obligation.id, "verified_by", test.id)] }), new SimilarityRegistry([new FixedIndex("lexical", [obligation.id, symbol.id, test.id])]));
    const result = await retriever.retrieve({
      text: "operation submit parity",
      symbol: { path: "operation-binding.ts", qualifiedName: "submit" },
      repoSha: SHA,
      codeIndexSha: "c".repeat(40),
    });
    expect(result.ranked.map((candidate) => candidate.id)).toContain(obligation.id);
    expect(result.ranked.map((candidate) => candidate.id)).not.toEqual(expect.arrayContaining([symbol.id, test.id]));
    expect(result.unknown.some((reason) => reason.code === "code_index_stale")).toBe(true);
  });

  it("keeps whole uppercase and hyphenated tokens while still capturing two-letter acronyms", () => {
    const expression = matchExpression("OMP AUTH-001 CI 会话生命周期")!;
    expect(expression).toContain('"omp"');
    expect(expression).toContain('"auth-001"');
    expect(expression).toContain('"ci"');
    expect(expression).not.toContain('"om"');
  });

  it("never promotes an alias classification to exact grounding, and an ambiguous alias stays below direct hits", async () => {
    const inferred = node("capability:tickets.agent-runtime", "capability", "Ticket agent runtime", { aliases: ["ticket runtime", "agent runtime"] });
    const ambiguous = node("capability:devpipe.landing", "capability", "Landing pipeline", { aliases: ["submit"] });
    const decision = node("decision:cur:b29:239:5", "decision", "OMP tickets accept mid-turn messages");
    const retriever = new KnowledgeRetriever(
      graph({ nodes: [inferred, ambiguous, decision], edges: [] }),
      new SimilarityRegistry([new FixedIndex("lexical", [decision.id])]),
    );
    const result = await retriever.retrieve({ text: "ticket runtime agent runtime submit mid-turn messages", repoSha: SHA });
    const classified = result.ranked.find((candidate) => candidate.id === inferred.id);
    expect(classified).toBeDefined();
    expect(classified!.grounding).not.toBe("exact");
    expect(result.ranked.findIndex((candidate) => candidate.id === decision.id))
      .toBeLessThan(result.ranked.findIndex((candidate) => candidate.id === ambiguous.id));
  });

  it("ranks an expanded neighbor below its direct origin and gives it no cloned index signals", async () => {
    const contract = node("capability_contract:parity", "capability_contract", "Provider parity");
    const obligation = node("obligation:parity/full-stack", "obligation", "Implement every provider action");
    const retriever = new KnowledgeRetriever(
      graph({ nodes: [contract, obligation], edges: [edge(contract.id, "defines", obligation.id)] }),
      new SimilarityRegistry([new FixedIndex("lexical", [contract.id])]),
    );
    const result = await retriever.retrieve({ text: "provider parity", repoSha: SHA });
    const ids = result.ranked.map((candidate) => candidate.id);
    expect(ids.indexOf(contract.id)).toBeLessThan(ids.indexOf(obligation.id));
    const expanded = result.ranked.find((candidate) => candidate.id === obligation.id)!;
    expect(expanded.grounding).toBe("expanded");
    expect(expanded.signals).toEqual([]);
  });

  it("treats an explicit ticket reference in the text as an exact seed", async () => {
    const ticket = node("ticket:328", "ticket", "MD/PDF preview annotations", { kind: "ticket" } as never);
    const source = node("source:ticket:328", "source", "ticket_body ticket:328");
    const noise = node("principle:mobile", "principle", "手机端布局原则");
    const retriever = new KnowledgeRetriever(
      graph({ nodes: [ticket, source, noise], edges: [] }),
      new SimilarityRegistry([new FixedIndex("lexical", [noise.id])]),
    );
    const result = await retriever.retrieve({ text: "复盘历史工单328 的 PDF 批注实现", repoSha: SHA });
    const ids = result.ranked.map((candidate) => candidate.id);
    expect(ids.slice(0, 2)).toEqual(expect.arrayContaining([source.id]));
    expect(ids).toContain("ticket:328");
  });

  it("reserves every available requested slot inside the graded top ten", async () => {
    const principles = Array.from({ length: 12 }, (_, index) =>
      node(`principle:p${String(index).padStart(2, "0")}`, "principle", `Principle ${index}`));
    const source = node("source:ticket:227", "source", "ticket_body ticket:227");
    const retriever = new KnowledgeRetriever(
      graph({ nodes: [...principles, source], edges: [] }),
      new SimilarityRegistry([new FixedIndex("lexical", [...principles.map((value) => value.id), source.id])]),
    );
    const result = await retriever.retrieve({ text: "principles", repoSha: SHA });
    const topTen = result.ranked.slice(0, 10).map((candidate) => candidate.id);
    expect(topTen).toContain(source.id);
  });
});

it("does not fill narrative slots with broad module neighbors for a concrete question, while preserving direct references",async()=>{
  const file=node("path:packages/chat/upload.ts","path","packages/chat/upload.ts");
  const module=node("module:chat","module","Chat",{metadata:{pathPrefixes:["packages/chat/"]}});
  const capability=node("capability:chat","capability","Chat feature");
  const unrelated=node("decision:navigation","decision","Sessions+ keeps navigation entries in one list.");
  const constraint=node("constraint:auth","constraint","Every file operation checks ownership.");
  const value=graph({nodes:[file,module,capability,unrelated,constraint],edges:[edge(capability.id,"spans",module.id),edge(unrelated.id,"about",capability.id),edge(capability.id,"constrained_by",constraint.id)]});
  const retriever=new KnowledgeRetriever(value,new SimilarityRegistry([]));
  const query={repoSha:SHA,paths:["packages/chat/upload.ts"],text:"attachment latency chunk timeout"};
  const broad=await retriever.retrieve({...query,text:""});
  expect(broad.ranked.map(c=>c.id)).toContain(unrelated.id);
  const result=await retriever.retrieve(query);
  expect(result.slots.decisions_exceptions.map(c=>c.id)).not.toContain(unrelated.id);
  expect(result.ranked.map(c=>c.id)).toContain(constraint.id);
  const explicit=await retriever.retrieve({...query,inputRef:unrelated.id});
  expect(explicit.ranked.map(c=>c.id)).toContain(unrelated.id);
  const lexical=new KnowledgeRetriever(value);
  const branded=await lexical.retrieve({...query,text:"Sessions+ attachment latency"});
  expect(branded.ranked.map(c=>c.id)).not.toContain(unrelated.id);
  const navigation=await lexical.retrieve({...query,text:"Sessions+ navigation entries"});
  expect(navigation.ranked.map(c=>c.id)).toContain(unrelated.id);
});
