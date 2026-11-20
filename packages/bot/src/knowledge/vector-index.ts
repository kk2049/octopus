import fs from "node:fs";
import path from "node:path";
import {
  CONTEXTUAL_RECORD_SCHEMA_DIGEST,
  CONTEXTUAL_RECORD_SCHEMA_VERSION,
  ContextualRecordError,
  buildContextualRecords,
  compareCanonicalText,
  encodeContextualRecordsJsonl,
  parseContextualRecordsJsonl,
  type ContextualRecord,
} from "./contextual-record.js";
import { GraphDb } from "./graph-db.js";
import {
  LocalE5EmbeddingProvider,
  MULTILINGUAL_E5_SMALL_BINDING,
  canonicalJson,
  sha256,
  type EmbeddingProvider,
  type RuntimeEmbeddingBinding,
} from "./model-binding.js";
import type { NodeStatus } from "./model.js";
import type {
  RetrievalFilters,
  SimilarityAttemptTrace,
  SimilarityHit,
  SimilarityIndex,
  SimilarityRequest,
  SimilaritySearchResult,
} from "./retrieval.js";

export const VECTOR_MANIFEST_FILENAME = "vector-manifest.json";
export const VECTOR_RECORDS_FILENAME = "vector-records.jsonl";
export const VECTOR_DATA_FILENAME = "vectors.f32le";
export const VECTOR_ARTIFACT_SCHEMA_VERSION = 1 as const;

const GIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface VectorArtifactManifest {
  schema_version: 1;
  artifact: "octopus-flat-vector";
  repo_sha: string;
  contextual_record_schema_version: 1;
  contextual_record_schema_digest: string;
  record_set_digest: string;
  binding: RuntimeEmbeddingBinding;
  record_count: number;
  dimensions: 384;
  dtype: "float32-le";
  normalization: "l2";
  distance: "cosine";
  files: {
    records: { name: "vector-records.jsonl"; bytes: number; sha256: string };
    vectors: { name: "vectors.f32le"; bytes: number; sha256: string };
  };
}

export type VectorArtifactErrorCode =
  | "manifest_invalid"
  | "checksum_mismatch"
  | "model_binding_mismatch"
  | "dimension_mismatch"
  | "stale_source_sha"
  | "privacy_denied"
  | "index_missing";

export class VectorArtifactError extends Error {
  constructor(readonly code: VectorArtifactErrorCode, message: string) {
    super(message);
    this.name = "VectorArtifactError";
  }
}

function fixedBindingMatches(binding: RuntimeEmbeddingBinding): boolean {
  const { model_manifest_sha256: _manifestDigest, ...fixed } = binding;
  return canonicalJson(fixed) === canonicalJson(MULTILINGUAL_E5_SMALL_BINDING) && SHA256.test(binding.model_manifest_sha256);
}

function validateRepoSha(repoSha: string): void {
  if (!GIT_SHA.test(repoSha)) throw new VectorArtifactError("stale_source_sha", "vector artifact requires an exact 40-character repository SHA");
}

function assertRecordRepositorySha(records: readonly ContextualRecord[], repoSha: string): void {
  for (const record of records) {
    if (record.repo_sha !== repoSha) {
      throw new VectorArtifactError("stale_source_sha", `contextual record ${record.id} repository baseline does not match requested repository SHA`);
    }
  }
}

function validateNormalized(vector: Float32Array, id: string): void {
  if (vector.length !== MULTILINGUAL_E5_SMALL_BINDING.dimensions) throw new VectorArtifactError("dimension_mismatch", `embedding dimension mismatch for ${id}`);
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new VectorArtifactError("dimension_mismatch", `non-finite embedding for ${id}`);
    squaredNorm += value * value;
  }
  if (Math.abs(Math.sqrt(squaredNorm) - 1) > 0.001) throw new VectorArtifactError("dimension_mismatch", `embedding is not L2 normalized for ${id}`);
}

function encodeVectors(vectors: readonly Float32Array[]): Buffer {
  const dimensions = MULTILINGUAL_E5_SMALL_BINDING.dimensions;
  const buffer = Buffer.allocUnsafe(vectors.length * dimensions * Float32Array.BYTES_PER_ELEMENT);
  let offset = 0;
  for (const vector of vectors) {
    for (let column = 0; column < dimensions; column += 1) {
      buffer.writeFloatLE(vector[column], offset);
      offset += Float32Array.BYTES_PER_ELEMENT;
    }
  }
  return buffer;
}

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const bytes = fs.writeSync(fd, buffer, offset, buffer.byteLength - offset);
    if (bytes <= 0) throw new VectorArtifactError("checksum_mismatch", "failed to write vector artifact bytes");
    offset += bytes;
  }
}

export interface BuildVectorArtifactOptions {
  outDir: string;
  repoSha: string;
  records: readonly ContextualRecord[];
  provider: EmbeddingProvider;
  signal?: AbortSignal;
  batchSize?: number;
}

/** Build deterministic record and contiguous little-endian Float32 artifacts. */
export async function buildVectorArtifact(options: BuildVectorArtifactOptions): Promise<VectorArtifactManifest> {
  validateRepoSha(options.repoSha);
  assertRecordRepositorySha(options.records, options.repoSha);
  if (!fixedBindingMatches(options.provider.binding)) throw new VectorArtifactError("model_binding_mismatch", "embedding provider does not match the fixed multilingual E5 binding");
  const records = parseContextualRecordsJsonl(encodeContextualRecordsJsonl([...options.records].sort((a, b) => compareCanonicalText(a.id, b.id))));
  const recordsJsonl = encodeContextualRecordsJsonl(records);
  const output = path.resolve(options.outDir);
  if (fs.existsSync(output)) throw new VectorArtifactError("manifest_invalid", `vector output already exists: ${output}`);
  const temporary = `${output}.tmp-${process.pid}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const recordsFile = path.join(temporary, VECTOR_RECORDS_FILENAME);
  const vectorsFile = path.join(temporary, VECTOR_DATA_FILENAME);
  fs.writeFileSync(recordsFile, recordsJsonl, { encoding: "utf8", mode: 0o600 });
  const vectorFd = fs.openSync(vectorsFile, "wx", 0o600);
  let closed = false;
  try {
    const requestedBatchSize = options.batchSize ?? 16;
    if (!Number.isSafeInteger(requestedBatchSize) || requestedBatchSize < 1 || requestedBatchSize > 32) throw new VectorArtifactError("manifest_invalid", "vector batch size must be an integer from 1 to 32");
    for (let offset = 0; offset < records.length; offset += requestedBatchSize) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("vector build aborted");
      const batch = records.slice(offset, offset + requestedBatchSize);
      const vectors = await options.provider.embedDocuments(batch.map((record) => record.text), options.signal);
      if (vectors.length !== batch.length) throw new VectorArtifactError("dimension_mismatch", "embedding provider returned the wrong row count");
      vectors.forEach((vector, index) => validateNormalized(vector, batch[index].id));
      writeAll(vectorFd, encodeVectors(vectors));
    }
    fs.fsyncSync(vectorFd);
    fs.closeSync(vectorFd);
    closed = true;
  } catch (error) {
    if (!closed) fs.closeSync(vectorFd);
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  try {
    const vectorBytes = fs.statSync(vectorsFile).size;
    const expectedBytes = records.length * MULTILINGUAL_E5_SMALL_BINDING.dimensions * Float32Array.BYTES_PER_ELEMENT;
    if (vectorBytes !== expectedBytes) throw new VectorArtifactError("dimension_mismatch", "vector artifact byte length does not match its record count");
    const manifest: VectorArtifactManifest = {
      schema_version: VECTOR_ARTIFACT_SCHEMA_VERSION,
      artifact: "octopus-flat-vector",
      repo_sha: options.repoSha,
      contextual_record_schema_version: CONTEXTUAL_RECORD_SCHEMA_VERSION,
      contextual_record_schema_digest: CONTEXTUAL_RECORD_SCHEMA_DIGEST,
      record_set_digest: sha256(recordsJsonl),
      binding: options.provider.binding,
      record_count: records.length,
      dimensions: MULTILINGUAL_E5_SMALL_BINDING.dimensions,
      dtype: "float32-le",
      normalization: "l2",
      distance: "cosine",
      files: {
        records: { name: VECTOR_RECORDS_FILENAME, bytes: Buffer.byteLength(recordsJsonl), sha256: sha256(recordsJsonl) },
        vectors: { name: VECTOR_DATA_FILENAME, bytes: vectorBytes, sha256: sha256(fs.readFileSync(vectorsFile)) },
      },
    };
    fs.writeFileSync(path.join(temporary, VECTOR_MANIFEST_FILENAME), `${canonicalJson(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, output);
    return manifest;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export interface BuildVectorArtifactFromInputOptions {
  input: string;
  modelDir: string;
  outDir: string;
  repoSha: string;
  signal?: AbortSignal;
}

function throwContextualRecordError(error: unknown): never {
  if (error instanceof ContextualRecordError) {
    throw new VectorArtifactError(error.code === "privacy_denied" ? "privacy_denied" : "manifest_invalid", error.message);
  }
  throw error;
}

export async function buildVectorArtifactFromInput(options: BuildVectorArtifactFromInputOptions): Promise<VectorArtifactManifest> {
  validateRepoSha(options.repoSha);
  let fd: number;
  try {
    fd = fs.openSync(options.input, "r");
  } catch {
    throw new VectorArtifactError("index_missing", `vector input not found: ${options.input}`);
  }
  const prefix = Buffer.alloc(16);
  try {
    fs.readSync(fd, prefix, 0, prefix.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  let records: ContextualRecord[];
  if (prefix.toString("utf8") === "SQLite format 3\0") {
    const graph = GraphDb.openReadonly(path.resolve(options.input));
    if (!graph) throw new VectorArtifactError("index_missing", `graph input not found: ${options.input}`);
    try {
      if (String(graph.meta().commit ?? "") !== options.repoSha) throw new VectorArtifactError("stale_source_sha", "graph input does not match the requested vector repository SHA");
      records = buildContextualRecords(graph).records;
    } catch (error) {
      throwContextualRecordError(error);
    } finally {
      graph.close();
    }
  } else {
    try {
      records = parseContextualRecordsJsonl(fs.readFileSync(options.input, "utf8"));
    } catch (error) {
      throwContextualRecordError(error);
    }
  }
  assertRecordRepositorySha(records, options.repoSha);
  const provider = new LocalE5EmbeddingProvider(options.modelDir);
  try {
    return await buildVectorArtifact({ outDir: options.outDir, repoSha: options.repoSha, records, provider, signal: options.signal });
  } finally {
    await provider.close();
  }
}

function exactObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VectorArtifactError("manifest_invalid", `${label} must be an object`);
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) throw new VectorArtifactError("manifest_invalid", `${label} fields do not match schema v1`);
  return object;
}

function parseManifest(source: string): VectorArtifactManifest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new VectorArtifactError("manifest_invalid", "vector manifest is not JSON");
  }
  const root = exactObject(value, [
    "schema_version", "artifact", "repo_sha", "contextual_record_schema_version",
    "contextual_record_schema_digest", "record_set_digest", "binding", "record_count",
    "dimensions", "dtype", "normalization", "distance", "files",
  ], "vector manifest");
  const manifest = root as unknown as Partial<VectorArtifactManifest>;
  if (`${canonicalJson(value)}\n` !== source || manifest.schema_version !== VECTOR_ARTIFACT_SCHEMA_VERSION || manifest.artifact !== "octopus-flat-vector") {
    throw new VectorArtifactError("manifest_invalid", "vector manifest is not canonical schema v1");
  }
  if (!manifest.binding || !fixedBindingMatches(manifest.binding) || manifest.dimensions !== 384 || manifest.dtype !== "float32-le" || manifest.normalization !== "l2" || manifest.distance !== "cosine") {
    throw new VectorArtifactError("model_binding_mismatch", "vector manifest embedding binding is unsupported");
  }
  if (!GIT_SHA.test(manifest.repo_sha ?? "") || manifest.contextual_record_schema_version !== CONTEXTUAL_RECORD_SCHEMA_VERSION || manifest.contextual_record_schema_digest !== CONTEXTUAL_RECORD_SCHEMA_DIGEST) {
    throw new VectorArtifactError("manifest_invalid", "vector manifest source/schema identity is invalid");
  }
  if (!Number.isSafeInteger(manifest.record_count) || (manifest.record_count ?? -1) < 0 || !SHA256.test(manifest.record_set_digest ?? "")) {
    throw new VectorArtifactError("manifest_invalid", "vector manifest record identity is invalid");
  }
  const files = exactObject(manifest.files, ["records", "vectors"], "vector manifest files");
  for (const key of ["records", "vectors"] as const) {
    const file = exactObject(files[key], ["name", "bytes", "sha256"], `vector manifest ${key} file`);
    const expectedName = key === "records" ? VECTOR_RECORDS_FILENAME : VECTOR_DATA_FILENAME;
    if (file.name !== expectedName || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
      throw new VectorArtifactError("manifest_invalid", `invalid vector manifest file entry: ${key}`);
    }
  }
  const expectedVectorBytes = Number(manifest.record_count) * MULTILINGUAL_E5_SMALL_BINDING.dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(expectedVectorBytes) || Number((manifest.files as VectorArtifactManifest["files"]).vectors.bytes) !== expectedVectorBytes) {
    throw new VectorArtifactError("dimension_mismatch", "vector manifest byte length does not match its record count");
  }
  return manifest as VectorArtifactManifest;
}

function lifecycleStatuses(filters: RetrievalFilters): ReadonlySet<NodeStatus> {
  switch (filters.lifecycle ?? "current") {
    case "current": return new Set(["active"]);
    case "history": return new Set(["superseded", "historical", "rejected"]);
    case "proposed": return new Set(["proposed"]);
    case "all": return new Set(["active", "proposed", "superseded", "historical", "rejected"]);
  }
}

function matchesFilters(record: ContextualRecord, filters: RetrievalFilters): boolean {
  if (filters.kinds?.length && !filters.kinds.includes(record.kind)) return false;
  if (!lifecycleStatuses(filters).has(record.status)) return false;
  if (filters.slots?.length && !filters.slots.includes(record.slot)) return false;
  const checks: Array<[readonly string[] | undefined, readonly string[]]> = [
    [filters.capabilities, [...(record.dimensions.capability ?? []), ...(record.dimensions.capabilities ?? [])]],
    [filters.providers, [...(record.dimensions.provider ?? []), ...(record.dimensions.providers ?? [])]],
    [filters.launchModes, [...(record.dimensions.launch_mode ?? []), ...(record.dimensions.launch_modes ?? []), ...(record.dimensions.mode ?? []), ...(record.dimensions.modes ?? [])]],
    [filters.states, [...(record.dimensions.state ?? []), ...(record.dimensions.states ?? [])]],
    [filters.actions, [...(record.dimensions.action ?? []), ...(record.dimensions.actions ?? [])]],
  ];
  return checks.every(([wanted, actual]) => !wanted?.length || actual.length === 0 || wanted.some((value) => actual.includes(value)));
}

interface HeapHit extends SimilarityHit {
  record: number;
}

function worse(a: HeapHit, b: HeapHit): boolean {
  return a.score < b.score || (a.score === b.score && a.id > b.id);
}

function siftUp(heap: HeapHit[], index: number): void {
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!worse(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function siftDown(heap: HeapHit[], index: number): void {
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && worse(heap[left], heap[worst])) worst = left;
    if (right < heap.length && worse(heap[right], heap[worst])) worst = right;
    if (worst === index) return;
    [heap[index], heap[worst]] = [heap[worst], heap[index]];
    index = worst;
  }
}

export interface OpenFlatVectorIndexOptions {
  directory: string;
  repoSha: string;
  provider: EmbeddingProvider;
}

export class FlatVectorIndex implements SimilarityIndex {
  readonly name = "vector-e5";
  readonly version: string;
  readonly manifest: VectorArtifactManifest;
  private constructor(
    manifest: VectorArtifactManifest,
    private readonly records: readonly ContextualRecord[],
    private readonly data: Buffer,
    private readonly provider: EmbeddingProvider,
  ) {
    this.manifest = manifest;
    this.version = `${manifest.schema_version}:${manifest.record_set_digest}`;
  }

  static open(options: OpenFlatVectorIndexOptions): FlatVectorIndex {
    const directory = fs.realpathSync(options.directory);
    const expectedFiles = [VECTOR_DATA_FILENAME, VECTOR_MANIFEST_FILENAME, VECTOR_RECORDS_FILENAME].sort();
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length !== expectedFiles.length || entries.some((entry, index) => entry.name !== expectedFiles[index] || !entry.isFile() || entry.isSymbolicLink())) {
      throw new VectorArtifactError("manifest_invalid", "vector directory must contain exactly the three regular artifact files");
    }
    const manifestFile = path.join(directory, VECTOR_MANIFEST_FILENAME);
    const manifest = parseManifest(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.repo_sha !== options.repoSha) throw new VectorArtifactError("stale_source_sha", `vector index ${manifest.repo_sha} does not match query repository ${options.repoSha}`);
    if (canonicalJson(manifest.binding) !== canonicalJson(options.provider.binding)) throw new VectorArtifactError("model_binding_mismatch", "query model does not match the vector build model manifest");
    const recordFile = path.join(directory, VECTOR_RECORDS_FILENAME);
    const vectorFile = path.join(directory, VECTOR_DATA_FILENAME);
    const recordData = fs.readFileSync(recordFile);
    const data = fs.readFileSync(vectorFile);
    for (const [buffer, identity] of [[recordData, manifest.files.records], [data, manifest.files.vectors]] as const) {
      if (buffer.byteLength !== identity.bytes || sha256(buffer) !== identity.sha256) throw new VectorArtifactError("checksum_mismatch", `vector artifact checksum mismatch: ${identity.name}`);
    }
    const recordsSource = recordData.toString("utf8");
    if (sha256(recordData) !== manifest.record_set_digest) throw new VectorArtifactError("checksum_mismatch", "contextual record-set digest mismatch");
    const records = parseContextualRecordsJsonl(recordsSource);
    assertRecordRepositorySha(records, manifest.repo_sha);
    if (records.length !== manifest.record_count) throw new VectorArtifactError("dimension_mismatch", "vector record count mismatch");
    const expectedBytes = records.length * manifest.dimensions * Float32Array.BYTES_PER_ELEMENT;
    if (data.byteLength !== expectedBytes) throw new VectorArtifactError("dimension_mismatch", "vector data byte length mismatch");
    return new FlatVectorIndex(manifest, records, data, options.provider);
  }

  async search(request: SimilarityRequest): Promise<SimilaritySearchResult> {
    const started = performance.now();
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("vector query aborted");
    const [query] = await this.provider.embedQueries([request.text], request.signal);
    validateNormalized(query, "query");
    const limit = Math.max(1, Math.min(request.limit, this.records.length));
    const heap: HeapHit[] = [];
    const dimensions = this.manifest.dimensions;
    for (let recordIndex = 0; recordIndex < this.records.length; recordIndex += 1) {
      if ((recordIndex & 1023) === 0 && request.signal?.aborted) throw request.signal.reason ?? new Error("vector query aborted");
      const record = this.records[recordIndex];
      if (!matchesFilters(record, request.filters)) continue;
      let score = 0;
      let offset = recordIndex * dimensions * Float32Array.BYTES_PER_ELEMENT;
      for (let column = 0; column < dimensions; column += 1) {
        score += query[column] * this.data.readFloatLE(offset);
        offset += Float32Array.BYTES_PER_ELEMENT;
      }
      const hit: HeapHit = { id: record.id, score, record: recordIndex };
      if (heap.length < limit) {
        heap.push(hit);
        siftUp(heap, heap.length - 1);
      } else if (worse(heap[0], hit)) {
        heap[0] = hit;
        siftDown(heap, 0);
      }
    }
    const hits = heap.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(({ id, score }) => ({ id, score }));
    const trace: SimilarityAttemptTrace = {
      index: this.name,
      version: this.version,
      kind: "vector",
      sourceGitSha: this.manifest.repo_sha,
      artifactSha256: this.manifest.files.vectors.sha256,
      recordCount: this.records.length,
      status: "ok",
      latencyMs: performance.now() - started,
      hits: hits.map((hit, rank) => ({ id: hit.id, rank: rank + 1, score: hit.score })),
      embedding: {
        provider: this.manifest.binding.provider,
        modelId: this.manifest.binding.model_id,
        immutableRevision: this.manifest.binding.immutable_revision,
        dimensions: this.manifest.binding.dimensions,
      },
    };
    return { hits, trace };
  }
}
