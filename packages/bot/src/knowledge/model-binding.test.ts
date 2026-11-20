import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalJson,
  embeddingWorkerCandidates,
  EMBEDDING_MODEL_SCHEMA_VERSION,
  LOCAL_MODEL_MANIFEST_FILENAME,
  MULTILINGUAL_E5_SMALL_BINDING,
  PINNED_MODEL_FILES,
  PINNED_MODEL_IDENTITIES,
  stagePinnedLocalModel,
  verifyLocalModelDirectory,
} from "./model-binding.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octopus-model-stage-"));
  temporaryDirectories.push(root);
  return root;
}


describe("staged model verification", () => {
  it("skips re-hashing only files whose pinned digest the caller already verified", () => {
    const root = path.join(temporaryRoot(), "model");
    const files = PINNED_MODEL_FILES.map((file) => ({ path: file, ...PINNED_MODEL_IDENTITIES[file] }));
    for (const file of files) {
      const absolute = path.join(root, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, "");
      fs.truncateSync(absolute, file.bytes); // pinned size, wrong (sparse) bytes
    }
    const manifest = { schema_version: EMBEDDING_MODEL_SCHEMA_VERSION, binding: MULTILINGUAL_E5_SMALL_BINDING, files };
    fs.writeFileSync(path.join(root, LOCAL_MODEL_MANIFEST_FILENAME), `${canonicalJson(manifest)}\n`);
    const streamed = new Map(files.map((file) => [file.path, file.sha256]));

    expect(() => verifyLocalModelDirectory(root)).toThrow(expect.objectContaining({ code: "model_checksum_mismatch" }));
    const wrong = new Map(streamed).set("config.json", "0".repeat(64));
    expect(() => verifyLocalModelDirectory(root, wrong)).toThrow(expect.objectContaining({ code: "model_checksum_mismatch" }));
    expect(verifyLocalModelDirectory(root, streamed).manifest.files).toHaveLength(files.length);
  });
});

describe("pinned model staging", () => {
  it("resolves source execution to the compiled embedding worker", () => {
    const candidates = embeddingWorkerCandidates("file:///repo/packages/bot/src/knowledge/model-binding.ts");
    expect(candidates.map((candidate) => fileURLToPath(candidate))).toEqual([
      "/repo/packages/bot/dist/knowledge/embedding-worker.js",
    ]);
  });

  it("falls back to the checksum-untrusted mirror and rejects altered bytes", async () => {
    const root = temporaryRoot();
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      if (requests.length === 1) throw new TypeError("fetch failed");
      return new Response("altered", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(stagePinnedLocalModel({ outDir: path.join(root, "model"), fetch: fetchImpl })).rejects.toMatchObject({
      code: "model_checksum_mismatch",
    });
    expect(requests.map((request) => new URL(request).host)).toEqual(["huggingface.co", "hf-mirror.com"]);
    expect(fs.existsSync(path.join(root, "model"))).toBe(false);
  });

  it("fails closed on an invalid persistent cache without downloading replacement bytes", async () => {
    const root = temporaryRoot();
    const cache = path.join(root, "cache");
    fs.mkdirSync(cache);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(stagePinnedLocalModel({
      outDir: path.join(root, "model"),
      cacheDir: cache,
      fetch: fetchImpl,
    })).rejects.toMatchObject({ code: "model_file_missing" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
