import { createHash } from "node:crypto";
import fs, { constants as fsConstants } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

export const LOCAL_MODEL_MANIFEST_FILENAME = "model-manifest.json";
export const EMBEDDING_MODEL_SCHEMA_VERSION = 1 as const;

export interface EmbeddingBinding {
  readonly provider: "transformers.js";
  readonly runtime: "@huggingface/transformers@4.2.0";
  readonly model_id: "intfloat/multilingual-e5-small";
  readonly immutable_revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3";
  readonly weight_path: "onnx/model.onnx";
  readonly weight_sha256: "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665";
  readonly weight_bytes: 470268510;
  readonly license: "MIT";
  readonly dimensions: 384;
  readonly dtype: "float32";
  readonly pooling: "mean";
  readonly normalization: "l2";
  readonly distance: "cosine";
  readonly query_prefix: "query: ";
  readonly document_prefix: "passage: ";
  readonly max_tokens: 512;
}

export const MULTILINGUAL_E5_SMALL_BINDING: EmbeddingBinding = Object.freeze({
  provider: "transformers.js",
  runtime: "@huggingface/transformers@4.2.0",
  model_id: "intfloat/multilingual-e5-small",
  immutable_revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
  weight_path: "onnx/model.onnx",
  weight_sha256: "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665",
  weight_bytes: 470268510,
  license: "MIT",
  dimensions: 384,
  dtype: "float32",
  pooling: "mean",
  normalization: "l2",
  distance: "cosine",
  query_prefix: "query: ",
  document_prefix: "passage: ",
  max_tokens: 512,
});

export const PINNED_MODEL_FILES = [
  "config.json",
  "sentencepiece.bpe.model",
  "special_tokens_map.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/config.json",
  "onnx/model.onnx",
] as const;
const PINNED_MODEL_RESOLVE_BASES = [
  `https://huggingface.co/${MULTILINGUAL_E5_SMALL_BINDING.model_id}/resolve/${MULTILINGUAL_E5_SMALL_BINDING.immutable_revision}`,
  `https://hf-mirror.com/${MULTILINGUAL_E5_SMALL_BINDING.model_id}/resolve/${MULTILINGUAL_E5_SMALL_BINDING.immutable_revision}`,
] as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_RELATIVE_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;

export interface LocalModelFile {
  path: string;
  bytes: number;
  sha256: string;
}
export const PINNED_MODEL_IDENTITIES: Readonly<Record<(typeof PINNED_MODEL_FILES)[number], Omit<LocalModelFile, "path">>> = Object.freeze({
  "config.json": { bytes: 655, sha256: "69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959" },
  "sentencepiece.bpe.model": { bytes: 5_069_051, sha256: "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865" },
  "special_tokens_map.json": { bytes: 167, sha256: "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7" },
  "tokenizer.json": { bytes: 17_082_730, sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39" },
  "tokenizer_config.json": { bytes: 443, sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b" },
  "onnx/config.json": { bytes: 653, sha256: "bbb7c1333fc4b3e27fbc9cd5d2070aabcc1d4dfb99917c3633e772f97545a6b6" },
  "onnx/model.onnx": { bytes: 470_268_510, sha256: "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665" },
});

export interface LocalModelManifest {
  schema_version: 1;
  binding: EmbeddingBinding;
  files: LocalModelFile[];
}

export interface VerifiedLocalModel {
  directory: string;
  manifest: LocalModelManifest;
  manifest_sha256: string;
}

export type ModelBindingErrorCode =
  | "model_manifest_invalid"
  | "model_binding_mismatch"
  | "model_file_missing"
  | "model_file_unlisted"
  | "model_file_unsafe"
  | "model_checksum_mismatch"
  | "model_download_failed";

export class ModelBindingError extends Error {
  constructor(readonly code: ModelBindingErrorCode, message: string) {
    super(message);
    this.name = "ModelBindingError";
  }
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError("undefined is not canonical JSON");
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("value is not canonical JSON");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export const EMBEDDING_BINDING_DIGEST = sha256(canonicalJson(MULTILINGUAL_E5_SMALL_BINDING));

function sameBinding(value: unknown): value is EmbeddingBinding {
  return canonicalJson(value) === canonicalJson(MULTILINGUAL_E5_SMALL_BINDING);
}

function safeRelativeFile(value: string): boolean {
  return SAFE_RELATIVE_FILE.test(value) && !path.isAbsolute(value) && !value.includes("\\") && path.posix.normalize(value) === value;
}

function listFiles(root: string, directory = root): string[] {
  const output: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isSymbolicLink()) throw new ModelBindingError("model_file_unsafe", `model file must not be a symlink: ${relative}`);
    if (entry.isDirectory()) output.push(...listFiles(root, absolute));
    else if (entry.isFile()) output.push(relative);
    else throw new ModelBindingError("model_file_unsafe", `unsupported model directory entry: ${relative}`);
  }
  return output;
}

function parseManifest(raw: string): LocalModelManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ModelBindingError("model_manifest_invalid", "local embedding model manifest is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelBindingError("model_manifest_invalid", "local embedding model manifest must be an object");
  const candidate = value as Partial<LocalModelManifest>;
  if (candidate.schema_version !== EMBEDDING_MODEL_SCHEMA_VERSION || !sameBinding(candidate.binding) || !Array.isArray(candidate.files)) {
    throw new ModelBindingError("model_binding_mismatch", "local embedding model manifest does not match the fixed E5 binding");
  }
  if (`${canonicalJson(candidate)}\n` !== raw) throw new ModelBindingError("model_manifest_invalid", "local embedding model manifest is not canonical JSON");
  if (candidate.files.length !== PINNED_MODEL_FILES.length) throw new ModelBindingError("model_file_unlisted", "model manifest must contain exactly the pinned model files");
  const seen = new Set<string>();
  for (const [index, file] of candidate.files.entries()) {
    if (!file || typeof file.path !== "string" || !safeRelativeFile(file.path)) throw new ModelBindingError("model_manifest_invalid", "model manifest contains an unsafe file path");
    if (file.path !== PINNED_MODEL_FILES[index]) throw new ModelBindingError("model_file_unlisted", `unexpected model file: ${file.path}`);
    if (seen.has(file.path)) throw new ModelBindingError("model_manifest_invalid", `duplicate model file: ${file.path}`);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !SHA256.test(file.sha256)) throw new ModelBindingError("model_manifest_invalid", `invalid model file identity: ${file.path}`);
    const expected = PINNED_MODEL_IDENTITIES[file.path];
    if (file.bytes !== expected.bytes || file.sha256 !== expected.sha256) {
      throw new ModelBindingError("model_binding_mismatch", `model file does not match the fixed E5 revision: ${file.path}`);
    }
    seen.add(file.path);
  }
  return candidate as LocalModelManifest;
}

/**
 * Verify every staged byte before a worker can create an ONNX session. A file
 * whose pinned digest is in `verifiedDigests` (streamed and checked by the
 * caller, keyed by manifest path) is not hashed again on this thread.
 */
export function verifyLocalModelDirectory(directory: string, verifiedDigests?: ReadonlyMap<string, string>): VerifiedLocalModel {
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new ModelBindingError("model_file_unsafe", "model root must be a regular directory");
  const root = fs.realpathSync(directory);
  const manifestPath = path.join(root, LOCAL_MODEL_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) throw new ModelBindingError("model_file_missing", `missing ${LOCAL_MODEL_MANIFEST_FILENAME}`);
  const manifestRaw = fs.readFileSync(manifestPath, "utf8");
  const manifest = parseManifest(manifestRaw);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const actualFiles = listFiles(root).filter((file) => file !== LOCAL_MODEL_MANIFEST_FILENAME);
  for (const actual of actualFiles) if (!expected.has(actual)) throw new ModelBindingError("model_file_unlisted", `unlisted model file: ${actual}`);
  for (const file of manifest.files) {
    const absolute = path.join(root, ...file.path.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      throw new ModelBindingError("model_file_missing", `missing staged model file: ${file.path}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ModelBindingError("model_file_unsafe", `model entry is not a regular file: ${file.path}`);
    if (stat.size !== file.bytes) throw new ModelBindingError("model_checksum_mismatch", `model file size mismatch: ${file.path}`);
    if (verifiedDigests?.get(file.path) === file.sha256) continue;
    const digest = sha256File(absolute);
    if (digest !== file.sha256) throw new ModelBindingError("model_checksum_mismatch", `model file checksum mismatch: ${file.path}`);
  }
  return { directory: root, manifest, manifest_sha256: sha256(manifestRaw) };
}

export interface StagePinnedModelOptions {
  outDir: string;
  cacheDir?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/**
 * Val15 build-only staging. Every URL names the immutable revision and the
 * resulting closed directory is checksum-bound before Transformers.js sees it.
 */
async function fetchPinnedModelFile(
  relative: (typeof PINNED_MODEL_FILES)[number],
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let failure = "no transport attempted";
  for (const base of PINNED_MODEL_RESOLVE_BASES) {
    try {
      const response = await fetchImpl(`${base}/${relative}`, {
        redirect: "follow",
        signal,
        headers: { accept: "application/octet-stream" },
      });
      if (response.ok && response.body) return response;
      failure = `HTTP ${response.status}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  throw new ModelBindingError("model_download_failed", `pinned model file unavailable: ${relative} (${failure})`);
}

async function downloadPinnedLocalModel(
  output: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<VerifiedLocalModel> {
  const temporary = `${output}.tmp-${process.pid}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const files: LocalModelFile[] = [];
  let published = false;
  try {
    for (const relative of PINNED_MODEL_FILES) {
      if (signal?.aborted) throw signal.reason ?? new Error("model staging aborted");
      const response = await fetchPinnedModelFile(relative, signal, fetchImpl);
      const absolute = path.join(temporary, ...relative.split("/"));
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
      const hash = createHash("sha256");
      let bytes = 0;
      const checksum = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await streamPipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), checksum, fs.createWriteStream(absolute, { flags: "wx", mode: 0o600 }));
      const digest = hash.digest("hex");
      const expected = PINNED_MODEL_IDENTITIES[relative];
      if (bytes !== expected.bytes || digest !== expected.sha256) {
        throw new ModelBindingError("model_checksum_mismatch", `downloaded file does not match the fixed E5 revision: ${relative}`);
      }
      files.push({ path: relative, bytes, sha256: digest });
    }
    const manifest: LocalModelManifest = {
      schema_version: EMBEDDING_MODEL_SCHEMA_VERSION,
      binding: MULTILINGUAL_E5_SMALL_BINDING,
      files,
    };
    fs.writeFileSync(path.join(temporary, LOCAL_MODEL_MANIFEST_FILENAME), `${canonicalJson(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, output);
    published = true;
    return verifyLocalModelDirectory(output);
  } catch (error) {
    fs.rmSync(published ? output : temporary, { recursive: true, force: true });
    throw error;
  }
}

function cloneVerifiedLocalModel(sourceDirectory: string, output: string): VerifiedLocalModel {
  const source = verifyLocalModelDirectory(sourceDirectory);
  const temporary = `${output}.tmp-${process.pid}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  let published = false;
  try {
    for (const file of source.manifest.files) {
      const target = path.join(temporary, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(source.directory, ...file.path.split("/")), target, fsConstants.COPYFILE_FICLONE);
      fs.chmodSync(target, 0o600);
    }
    fs.copyFileSync(path.join(source.directory, LOCAL_MODEL_MANIFEST_FILENAME), path.join(temporary, LOCAL_MODEL_MANIFEST_FILENAME), fsConstants.COPYFILE_FICLONE);
    fs.chmodSync(path.join(temporary, LOCAL_MODEL_MANIFEST_FILENAME), 0o600);
    fs.renameSync(temporary, output);
    published = true;
    return verifyLocalModelDirectory(output);
  } catch (error) {
    fs.rmSync(published ? output : temporary, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Val15 build-only staging. Every transport is checksum-untrusted: all bytes
 * are fixed to the immutable revision before a cache or artifact is published.
 */
export async function stagePinnedLocalModel(options: StagePinnedModelOptions): Promise<VerifiedLocalModel> {
  const output = path.resolve(options.outDir);
  if (fs.existsSync(output)) throw new ModelBindingError("model_file_unlisted", `model output already exists: ${output}`);
  const cache = options.cacheDir?.trim() ? path.resolve(options.cacheDir) : undefined;
  if (!cache) return await downloadPinnedLocalModel(output, options.signal, options.fetch ?? fetch);
  if (cache === output) throw new ModelBindingError("model_file_unsafe", "model cache and output must be different directories");
  if (!fs.existsSync(cache)) await downloadPinnedLocalModel(cache, options.signal, options.fetch ?? fetch);
  return cloneVerifiedLocalModel(cache, output);
}

export interface RuntimeEmbeddingBinding extends EmbeddingBinding {
  readonly model_manifest_sha256: string;
}

export interface EmbeddingProvider {
  readonly binding: RuntimeEmbeddingBinding;
  embedDocuments(texts: readonly string[], signal?: AbortSignal): Promise<readonly Float32Array[]>;
  embedQueries(texts: readonly string[], signal?: AbortSignal): Promise<readonly Float32Array[]>;
  close?(): Promise<void> | void;
}

interface PendingRequest {
  rows: number;
  resolve(value: readonly Float32Array[]): void;
  reject(error: unknown): void;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  dimensions?: number;
  rows?: number;
  vectors?: ArrayBuffer;
  code?: string;
}

export function embeddingWorkerCandidates(moduleUrl: string): URL[] {
  return moduleUrl.endsWith(".ts")
    ? [new URL("../../dist/knowledge/embedding-worker.js", moduleUrl)]
    : [new URL("./knowledge/embedding-worker.js", moduleUrl), new URL("../knowledge/embedding-worker.js", moduleUrl)];
}


/** One bounded local worker owns the 470 MB model and serializes embedding batches. */
export class LocalE5EmbeddingProvider implements EmbeddingProvider {
  readonly binding: RuntimeEmbeddingBinding;
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(modelDirectory: string, options: { verifiedDigests?: ReadonlyMap<string, string> } = {}) {
    const verified = verifyLocalModelDirectory(modelDirectory, options.verifiedDigests);
    this.binding = Object.freeze({ ...MULTILINGUAL_E5_SMALL_BINDING, model_manifest_sha256: verified.manifest_sha256 });
    const source = embeddingWorkerCandidates(import.meta.url)
      .find((candidate) => fs.existsSync(fileURLToPath(candidate)));
    if (!source) throw new ModelBindingError("model_file_missing", "compiled embedding worker entry is unavailable; build @claude-bot/bot first");
    this.worker = new Worker(source, { workerData: { modelDirectory: verified.directory } });
    this.worker.on("message", (reply: WorkerReply) => this.onReply(reply));
    this.worker.on("error", (error) => this.rejectAll(error));
    this.worker.on("exit", (code) => {
      if (!this.closed) this.rejectAll(new ModelBindingError("model_binding_mismatch", `embedding worker exited with code ${code}`));
    });
  }

  embedDocuments(texts: readonly string[], signal?: AbortSignal): Promise<readonly Float32Array[]> {
    return this.enqueue("document", texts, signal);
  }

  embedQueries(texts: readonly string[], signal?: AbortSignal): Promise<readonly Float32Array[]> {
    return this.enqueue("query", texts, signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("embedding provider closed"));
    await this.worker.terminate();
  }

  private enqueue(kind: "query" | "document", texts: readonly string[], signal?: AbortSignal): Promise<readonly Float32Array[]> {
    if (this.closed) return Promise.reject(new Error("embedding provider is closed"));
    if (texts.length < 1 || texts.length > 32 || texts.some((text) => typeof text !== "string" || text.length > 16_384)) {
      return Promise.reject(new Error("embedding batch must contain 1-32 strings of at most 16384 characters"));
    }
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("embedding aborted"));
    const completion = this.tail.then(() => {
      if (signal?.aborted) throw signal.reason ?? new Error("embedding aborted");
      return this.dispatch(kind, texts);
    });
    this.tail = completion.catch(() => undefined);
    if (!signal) return completion;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("embedding aborted"));
      signal.addEventListener("abort", abort, { once: true });
      completion.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }

  private dispatch(kind: "query" | "document", texts: readonly string[]): Promise<readonly Float32Array[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { rows: texts.length, resolve, reject });
      try {
        this.worker.postMessage({ id, kind, texts: [...texts] });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private onReply(reply: WorkerReply): void {
    const request = this.pending.get(reply.id);
    if (!request) return;
    this.pending.delete(reply.id);
    if (!reply.ok || !(reply.vectors instanceof ArrayBuffer) || reply.dimensions !== MULTILINGUAL_E5_SMALL_BINDING.dimensions || reply.rows !== request.rows) {
      request.reject(new ModelBindingError("model_binding_mismatch", `embedding worker refused request: ${reply.code ?? "invalid_output"}`));
      return;
    }
    const all = new Float32Array(reply.vectors);
    if (all.length !== reply.rows * reply.dimensions) {
      request.reject(new ModelBindingError("model_binding_mismatch", "embedding worker returned a malformed tensor"));
      return;
    }
    const rows: Float32Array[] = [];
    for (let row = 0; row < reply.rows; row += 1) rows.push(all.subarray(row * reply.dimensions, (row + 1) * reply.dimensions));
    request.resolve(rows);
  }

  private rejectAll(error: unknown): void {
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
  }
}
