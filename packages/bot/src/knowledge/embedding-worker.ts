import { parentPort, workerData } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";
import { MULTILINGUAL_E5_SMALL_BINDING, verifyLocalModelDirectory } from "./model-binding.js";

interface WorkerInput {
  id: number;
  kind: "query" | "document";
  texts: string[];
}

function isWorkerInput(value: unknown): value is WorkerInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<WorkerInput>;
  return Number.isSafeInteger(input.id)
    && (input.kind === "query" || input.kind === "document")
    && Array.isArray(input.texts)
    && input.texts.length >= 1
    && input.texts.length <= 32
    && input.texts.every((text) => typeof text === "string" && text.length <= 16_384);
}

interface TensorLike {
  data: Float32Array | number[];
  dims: number[];
}

const port = parentPort;
if (!port) throw new Error("embedding worker requires a parent port");
if (!workerData || typeof workerData !== "object" || Array.isArray(workerData) || !("modelDirectory" in workerData) || typeof workerData.modelDirectory !== "string") {
  throw new Error("embedding worker requires a verified local model directory");
}
const verified = verifyLocalModelDirectory(workerData.modelDirectory);

env.allowRemoteModels = false;
env.allowLocalModels = true;
// Transformers.js's feature-extraction return type is wider than the tensor shape this worker accepts below.
const createPipeline = pipeline as unknown as (
  task: "feature-extraction",
  model: string,
  options: Record<string, unknown>,
) => Promise<(texts: string[], options: Record<string, unknown>) => Promise<TensorLike>>;
const extractorPromise = createPipeline("feature-extraction", verified.directory, {
  dtype: "fp32",
  subfolder: "onnx",
  local_files_only: true,
});

port.on("message", async (input: unknown) => {
  try {
    if (!isWorkerInput(input)) {
      port.postMessage({ id: -1, ok: false, code: "invalid_request" });
      return;
    }
    const prefix = input.kind === "query" ? MULTILINGUAL_E5_SMALL_BINDING.query_prefix : MULTILINGUAL_E5_SMALL_BINDING.document_prefix;
    const texts = input.texts.map((text) => `${prefix}${text.normalize("NFKC").replace(/\s+/gu, " ").trim()}`);
    const extractor = await extractorPromise;
    const output = await extractor(texts, {
      pooling: MULTILINGUAL_E5_SMALL_BINDING.pooling,
      normalize: true,
      truncation: true,
      max_length: MULTILINGUAL_E5_SMALL_BINDING.max_tokens,
      padding: true,
    });
    if (!Array.isArray(output.dims) || output.dims.length !== 2 || output.dims[0] !== texts.length || output.dims[1] !== MULTILINGUAL_E5_SMALL_BINDING.dimensions) {
      port.postMessage({ id: input.id, ok: false, code: "dimension_mismatch" });
      return;
    }
    const vectors = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
    if (vectors.length !== texts.length * MULTILINGUAL_E5_SMALL_BINDING.dimensions) {
      port.postMessage({ id: input.id, ok: false, code: "dimension_mismatch" });
      return;
    }
    for (let row = 0; row < texts.length; row += 1) {
      let squaredNorm = 0;
      const start = row * MULTILINGUAL_E5_SMALL_BINDING.dimensions;
      for (let column = 0; column < MULTILINGUAL_E5_SMALL_BINDING.dimensions; column += 1) {
        const value = vectors[start + column];
        if (!Number.isFinite(value)) throw new Error("non-finite embedding");
        squaredNorm += value * value;
      }
      if (Math.abs(Math.sqrt(squaredNorm) - 1) > 0.001) throw new Error("embedding is not L2 normalized");
    }
    const transferBuffer: ArrayBuffer = vectors.buffer instanceof ArrayBuffer
      && vectors.byteOffset === 0
      && vectors.byteLength === vectors.buffer.byteLength
      ? vectors.buffer
      : new Float32Array(vectors).buffer;
    port.postMessage({
      id: input.id,
      ok: true,
      dimensions: MULTILINGUAL_E5_SMALL_BINDING.dimensions,
      rows: texts.length,
      vectors: transferBuffer,
    }, [transferBuffer]);
  } catch (error) {
    port.postMessage({ id: isWorkerInput(input) ? input.id : -1, ok: false, code: error instanceof Error ? error.name : "embedding_failed" });
  }
});
