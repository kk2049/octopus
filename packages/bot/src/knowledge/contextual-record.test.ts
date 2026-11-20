import { afterEach, describe, expect, it } from "vitest";
import {
  buildContextualRecords,
  encodeContextualRecordsJsonl,
  parseContextualRecordsJsonl,
  encodeContextualRecordInput,
  parseContextualRecordInput,
  replaceContextualRecords,
} from "./contextual-record.js";
import { GraphDb } from "./graph-db.js";
import type { KnowledgeEdge, KnowledgeNode } from "./model.js";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const graphs: GraphDb[] = [];

function node(id: string, statement: string, overrides: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id,
    kind: "requirement",
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

function graph(nodes: KnowledgeNode[], edges: KnowledgeEdge[] = []): GraphDb {
  const value = GraphDb.openInMemory();
  value.fill({
    nodes,
    edges,
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
      edge_count: edges.length,
    },
  });
  graphs.push(value);
  return value;
}

afterEach(() => {
  while (graphs.length) graphs.pop()!.close();
});

describe("privacy-filtered contextual records", () => {
  it("prefixes the extracted section heading so a rule bullet embeds with its context", () => {
    const principle = node("principle:rule", "Dependencies point toward contracts, never toward a composition root.", {
      kind: "principle",
      authority: "path_rule",
      source_ref: ".claude/rules/agentic-app.md#agentic-apps:17",
      metadata: { heading: "Agentic Apps and untrusted Views" },
    });
    const build = buildContextualRecords(graph([principle]));
    const record = build.records.find((row) => row.id === principle.id)!;
    expect(record.text).toContain("principle: Agentic Apps and untrusted Views — Dependencies point toward contracts");
  });

  it("keeps both context renderers byte-identical so the artifact protocol digests agree", () => {
    const principle = node("principle:rule", "Landing does not itself deploy.", {
      kind: "principle",
      authority: "path_rule",
      source_ref: ".claude/rules/devpipe-and-ops.md#dev-pipeline:30",
      metadata: { heading: "Dev pipeline, Git, and operations" },
    });
    const governed = node("path:.gitlab-ci.yml", ".gitlab-ci.yml", { kind: "path", authority: "derived" });
    const edge: KnowledgeEdge = {
      from_id: principle.id,
      relation: "governs",
      to_id: governed.id,
      method: "declared",
      certainty: "exact",
      source_ref: ".claude/rules/devpipe-and-ops.md",
      source_sha: SHA,
      observed_at: "2026-08-24T00:00:00.000Z",
    };
    const built = buildContextualRecords(graph([principle, governed], [edge])).records;
    const replayed = replaceContextualRecords(built, []);
    expect(encodeContextualRecordsJsonl(replayed)).toBe(encodeContextualRecordsJsonl(built));
    const pathRecord = built.find((row) => row.id === governed.id)!;
    expect(pathRecord.text).toContain("inverse:governs principle: Dev pipeline, Git, and operations — Landing does not itself deploy.");
  });

  it("keeps outgoing, inverse and self relations without admitting fuzzy or unrelated edges", () => {
    const a = node("requirement:a", "alpha");
    const b = node("requirement:b", "beta");
    const c = node("requirement:c", "gamma");
    const edge = (from_id: string, to_id: string, certainty: KnowledgeEdge["certainty"] = "exact"): KnowledgeEdge => ({
      from_id, to_id, relation: "governs", certainty, method: "declared",
      source_ref: a.source_ref, source_sha: SHA, observed_at: "2026-08-23T00:00:00.000Z",
    });
    const records = buildContextualRecords(graph([a, b, c], [
      edge(a.id, a.id), edge(a.id, b.id), edge(b.id, a.id), edge(c.id, a.id, "inferred"),
    ])).records;
    expect(records.find((record) => record.id === a.id)!.relations).toEqual([
      { relation: "governs", target_id: a.id },
      { relation: "governs", target_id: b.id },
      { relation: "inverse:governs", target_id: b.id },
    ]);
    expect(records.find((record) => record.id === c.id)!.relations).toEqual([]);
  });

  it("leaves a node whose id cannot be a record identity out of the set, with every edge to it", () => {
    const landing = node("landing:cli:abc", "Retire the legacy root.", { kind: "landing", authority: "derived" });
    const removed = node("path:doc/feishu-bot/建群.png", "doc/feishu-bot/建群.png", { kind: "path", authority: "derived" });
    const kept = node("path:doc/a.md", "doc/a.md", { kind: "path", authority: "derived" });
    const touches = (to_id: string): KnowledgeEdge => ({ from_id: landing.id, relation: "governs", to_id, method: "git", certainty: "exact",
      source_ref: "doc/cli-reports/2026-10-15-x.json", source_sha: SHA, observed_at: "2026-10-15T00:00:00.000Z" });
    const build = buildContextualRecords(graph([landing, removed, kept], [touches(removed.id), touches(kept.id)]));
    expect(build.records.map((record) => record.id).sort()).toEqual([landing.id, kept.id].sort());
    expect(build.excluded).toContainEqual({ id: removed.id, reason: "unsafe_identity" });
    expect(build.records.find((record) => record.id === landing.id)!.relations).toEqual([{ relation: "governs", target_id: kept.id }]);
    // The receiving side renders the same bytes from the records alone.
    expect(encodeContextualRecordsJsonl(replaceContextualRecords(build.records, []))).toBe(encodeContextualRecordsJsonl(build.records));
  });

  it("copies only allowlisted typed dimensions and never arbitrary metadata", () => {
    const database = graph([node("requirement:safe", "Provider actions remain neutral.", {
      metadata: { providers: ["omp"], credential: "must-not-cross", arbitrary_private_note: "must-not-cross" },
    })]);
    const build = buildContextualRecords(database);
    expect(build.records).toHaveLength(1);
    expect(build.records[0].dimensions.providers).toEqual(["omp"]);
    expect(JSON.stringify(build.records[0])).not.toContain("must-not-cross");
    expect(parseContextualRecordsJsonl(encodeContextualRecordsJsonl(build.records))).toEqual(build.records);
  });

  it("fails the build rather than embedding private paths, secret-shaped text or raw transcript nodes", () => {
    expect(() => buildContextualRecords(graph([node("requirement:path", "safe", { source_ref: "/home/alice/private.md" })]))).toThrow(/private source coordinate/);
    expect(() => buildContextualRecords(graph([node("requirement:secret", "api_key = abc123")]))).toThrow(/secret-shaped/);
    expect(() => buildContextualRecords(graph([node("requirement:transcript", "safe", { source_ref: "transcript:session-1" })]))).toThrow(/private source coordinate/);
  });

  it.each([
    "packages/dashboard-web/src/transcript/SessionChat.tsx",
    "packages/example/src/credential/rotate.ts",
  ])("round-trips repository artifact and path coordinates containing reserved directory names: %s", (file) => {
    const records = buildContextualRecords(graph([
      node(`artifact:knowledge/realized_by/${file}`, file, { kind: "artifact", source_ref: file, metadata: { artifact_role: "handler", path: file } }),
      node(`path:${file}`, file, { kind: "path", source_ref: file }),
    ])).records;
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.source_ref === file)).toBe(true);
    expect(parseContextualRecordsJsonl(encodeContextualRecordsJsonl(records))).toEqual(records);
  });

  it.each([
    "transcript:session-1", "transcript/session-1", "transcript#session-1",
    "credential:key-1", "credential/key-1", "credential#key-1",
    "source:transcript:session-1", "source:credential/key-1", "TRANSCRIPT:session-1",
    "/home/alice/private.md", "C:\\Users\\alice\\private.md", "~/private.md",
  ])("rejects private coordinates during both export and import: %s", (source_ref) => {
    expect(() => buildContextualRecords(graph([node("requirement:private", "safe", { source_ref })])))
      .toThrow(/private source coordinate/);
    const records = buildContextualRecords(graph([node("requirement:safe", "safe")])).records;
    const jsonl = encodeContextualRecordsJsonl(records);
    const value = JSON.parse(jsonl.trim());
    value.source_ref = source_ref;
    expect(() => parseContextualRecordsJsonl(JSON.stringify(value) + "\n"))
      .toThrow(/invalid contextual record identity/);
  });

  it("still rejects privacy labels and secret-shaped text on repository source coordinates", () => {
    const source_ref = "packages/dashboard-web/src/transcript/SessionChat.tsx";
    expect(() => buildContextualRecords(graph([node("artifact:private", "safe", {
      kind: "artifact", source_ref, metadata: { privacy: "transcript" },
    })]))).toThrow(/is marked transcript/);
    expect(() => buildContextualRecords(graph([node("artifact:secret", "api_key = abc123", {
      kind: "artifact", source_ref,
    })]))).toThrow(/secret-shaped/);
  });

  it("refuses non-canonical, unordered or schema-expanded JSONL", () => {
    const build = buildContextualRecords(graph([node("requirement:a", "alpha"), node("requirement:b", "beta")]));
    const canonical = encodeContextualRecordsJsonl(build.records);
    expect(() => parseContextualRecordsJsonl(canonical.split("\n").filter(Boolean).reverse().join("\n"))).toThrow(/ascending ids/);
    expect(() => parseContextualRecordsJsonl(canonical.replace("{", "{\"unexpected\":true,"))).toThrow(/contextual record/);
  });

  it("preserves canonical input bytes and digest while rejecting reordered, duplicate and altered records", () => {
    const build = buildContextualRecords(graph([node("requirement:a", "alpha"), node("requirement:b", "beta")]));
    const source = encodeContextualRecordInput(SHA, "2026-09-27", build.records);
    const input = parseContextualRecordInput(source);
    expect(input.record_set_digest).toBe(build.digest);
    expect(input.records).toEqual(build.records);
    expect(encodeContextualRecordInput(SHA, "2026-09-27", [...build.records].reverse())).toBe(source);
    expect(() => encodeContextualRecordInput(SHA, "2026-09-27", [build.records[0], build.records[0]])).toThrow(/ascending/);
    expect(() => parseContextualRecordInput(source.replace('alpha', 'tampered'))).toThrow(/digest-bound/);
    expect(() => parseContextualRecordInput(source.replace('"record_count":2', '"record_count":3'))).toThrow(/digest-bound/);
    expect(() => parseContextualRecordInput(JSON.stringify(input, null, 2) + "\n")).toThrow(/canonical/);
  });

  it("restores cross-source context after contract-only code projection", () => {
    const external = node("decision:provider-neutral", "Provider operations use one neutral port.", { kind: "decision" });
    const obligation = node("obligation:test/provider-neutral", "Adapters implement the neutral port.", { kind: "obligation" });
    const edge: KnowledgeEdge = {
      from_id: obligation.id,
      relation: "derives_from",
      to_id: external.id,
      method: "declared",
      certainty: "exact",
      source_ref: obligation.source_ref,
      source_sha: SHA,
      observed_at: "2026-08-23T00:00:00.000Z",
    };
    const full = buildContextualRecords(graph([external, obligation], [edge])).records;
    const contractOnly = buildContextualRecords(graph([obligation], [edge])).records;
    expect(contractOnly[0].relations).toEqual([{ relation: "derives_from", target_id: external.id }]);
    expect(contractOnly[0].text).not.toContain(external.statement);
    expect(replaceContextualRecords(full, contractOnly)).toEqual(full);
  });
});
