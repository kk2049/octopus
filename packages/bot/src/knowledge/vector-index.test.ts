import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeContextualRecordsJsonl, type ContextualRecord } from "./contextual-record.js";
import {
  MULTILINGUAL_E5_SMALL_BINDING,
  type EmbeddingProvider,
  type RuntimeEmbeddingBinding,
} from "./model-binding.js";
import {
  FlatVectorIndex,
  VECTOR_DATA_FILENAME,
  buildVectorArtifact,
  buildVectorArtifactFromInput,
} from "./vector-index.js";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const roots: string[] = [];

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly binding: RuntimeEmbeddingBinding;
  documentCalls = 0;
  constructor(manifestDigest = DIGEST) {
    this.binding = { ...MULTILINGUAL_E5_SMALL_BINDING, model_manifest_sha256: manifestDigest };
  }

  async embedDocuments(texts: readonly string[]): Promise<readonly Float32Array[]> {
    this.documentCalls += 1;
    return texts.map((text) => this.vector(text));
  }

  async embedQueries(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map((text) => this.vector(text));
  }

  private vector(text: string): Float32Array {
    const value = new Float32Array(MULTILINGUAL_E5_SMALL_BINDING.dimensions);
    if (text.includes("alpha")) value[0] = 1;
    else value[1] = 1;
    return value;
  }
}

function record(id: string, text: string, repoSha = SHA): ContextualRecord {
  return {
    schema_version: 1,
    repo_sha: repoSha,
    id,
    kind: "requirement",
    slot: "sources_requirements",
    status: "active",
    authority: "declared",
    certainty: "exact",
    source_ref: "architecture/knowledge/contracts/test.md",
    source_sha: SHA,
    text,
    dimensions: {},
    relations: [],
  };
}

function temporary(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octopus-vector-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("flat exact vector artifact", () => {
  it("writes deterministic Float32LE records and uses stable-id tie breaking for exact cosine top-k", async () => {
    const root = temporary();
    const directory = path.join(root, "vector");
    const provider = new FakeEmbeddingProvider();
    await buildVectorArtifact({
      outDir: directory,
      repoSha: SHA,
      records: [record("requirement:z", "alpha z"), record("requirement:a", "alpha a"), record("requirement:b", "beta")],
      provider,
    });
    const index = FlatVectorIndex.open({ directory, repoSha: SHA, provider });
    const result = await index.search({ text: "alpha", filters: { lifecycle: "current" }, limit: 2 });
    expect(result.hits.map((hit) => hit.id)).toEqual(["requirement:a", "requirement:z"]);
    expect(result.hits.map((hit) => hit.score)).toEqual([1, 1]);
    expect(fs.statSync(path.join(directory, VECTOR_DATA_FILENAME)).size).toBe(3 * 384 * 4);
  });

  it("refuses checksum corruption, stale repository SHA and a different staged model manifest", async () => {
    const root = temporary();
    const directory = path.join(root, "vector");
    const provider = new FakeEmbeddingProvider();
    await buildVectorArtifact({ outDir: directory, repoSha: SHA, records: [record("requirement:a", "alpha")], provider });
    expect(() => FlatVectorIndex.open({ directory, repoSha: "c".repeat(40), provider })).toThrow(/does not match query repository/);
    expect(() => FlatVectorIndex.open({ directory, repoSha: SHA, provider: new FakeEmbeddingProvider("d".repeat(64)) })).toThrow(/query model does not match/);
    const vectorFile = path.join(directory, VECTOR_DATA_FILENAME);
    const data = fs.readFileSync(vectorFile);
    data[0] ^= 0xff;
    fs.writeFileSync(vectorFile, data);
    expect(() => FlatVectorIndex.open({ directory, repoSha: SHA, provider })).toThrow(/checksum mismatch/);
  });

  it("refuses a provider with a mutable or mismatched model binding before writing bytes", async () => {
    const root = temporary();
    const provider = new FakeEmbeddingProvider();
    const mutable = provider.binding as { immutable_revision: string };
    mutable.immutable_revision = "main";
    await expect(buildVectorArtifact({ outDir: path.join(root, "vector"), repoSha: SHA, records: [record("requirement:a", "alpha")], provider })).rejects.toMatchObject({ code: "model_binding_mismatch" });
  });

  it("rejects mixed record SHAs before embedding or publishing direct and JSONL artifacts", async () => {
    const root = temporary();
    const current = record("requirement:current", "alpha current");
    const stale = record("requirement:stale", "alpha stale", "c".repeat(40));
    const provider = new FakeEmbeddingProvider();
    const directOutput = path.join(root, "direct-vector");

    await expect(buildVectorArtifact({
      outDir: directOutput,
      repoSha: SHA,
      records: [current, stale],
      provider,
    })).rejects.toMatchObject({ code: "stale_source_sha" });
    expect(provider.documentCalls).toBe(0);
    expect(fs.existsSync(directOutput)).toBe(false);

    const input = path.join(root, "records.jsonl");
    const jsonlOutput = path.join(root, "jsonl-vector");
    fs.writeFileSync(input, encodeContextualRecordsJsonl([current, stale]));
    await expect(buildVectorArtifactFromInput({
      input,
      modelDir: path.join(root, "missing-model"),
      outDir: jsonlOutput,
      repoSha: SHA,
    })).rejects.toMatchObject({ code: "stale_source_sha" });
    expect(fs.existsSync(jsonlOutput)).toBe(false);
  });
});
