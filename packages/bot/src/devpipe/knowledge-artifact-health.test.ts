import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../knowledge/code-index.js", () => ({
  openCodeIndex: () => ({
    gitSha: "1".repeat(40),
    searchSymbols: () => ({ status: "ok", items: [] }),
    close: () => undefined,
  }),
}));

vi.mock("../knowledge/model-binding.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../knowledge/model-binding.js")>();
  return {
    ...original,
    verifyLocalModelDirectory: () => ({ manifest_sha256: "d".repeat(64) }),
  };
});

import { CONTEXTUAL_RECORD_SCHEMA_DIGEST } from "../knowledge/contextual-record.js";
import {
  MULTILINGUAL_E5_SMALL_BINDING,
  canonicalJson,
} from "../knowledge/model-binding.js";
import { BundleHandoff } from "./bundle-handoff.js";
import { WorkspaceProviderUnavailable } from "./workspace-provider.js";
import {
  KnowledgeArtifactService,
  knowledgeArtifactJobKey,
  type KnowledgeArtifactRemote,
  type RemoteKnowledgeStatus,
} from "./knowledge-artifact-service.js";

const SHA = "1".repeat(40);
const MODEL_DIGEST = "d".repeat(64);
const RECORD_SET_DIGEST = digest(Buffer.from("record set"));
const roots: string[] = [];
const services: KnowledgeArtifactService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const root of roots.splice(0)) {
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("knowledge artifact activation health", () => {
  it.each([false, true])("activates verified artifacts across a projection provider outage and restart: %s", async (disconnect) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-artifact-health-"));
    roots.push(root);
    const graphFile = path.join(root, "graph.db");
    fs.writeFileSync(graphFile, "privacy-filtered graph");
    const graphBytes = fs.readFileSync(graphFile);
    const inputSha = digest(graphBytes);
    const files = artifactFiles(inputSha, graphBytes.length);
    const key = knowledgeArtifactJobKey(SHA, inputSha);
    const remoteFiles = Object.entries(files).map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: digest(bytes) }));
    const remote: KnowledgeArtifactRemote = {
      protocolAvailable: () => true,
      syncSource: async () => undefined,
      start: vi.fn(async () => remoteStatus(key, remoteFiles)),
      status: vi.fn(async () => remoteStatus(key, remoteFiles)),
      cancel: async () => remoteStatus(key, remoteFiles),
      read: async (jobKey, file, offset, length) => {
        const source = files[file]!;
        const data = source.subarray(offset, offset + length);
        return {
          job_key: jobKey,
          file,
          offset,
          bytes: data.length,
          data: data.toString("base64"),
          eof: offset + data.length === source.length,
          sha256: digest(source),
        };
      },
    };
    let active = false;
    const activateArtifacts = vi.fn(() => { active = true; });
    const evaluateArtifact = vi.fn(async (name: "journeys" | "vectorBenchmark") => {
      if (name === "journeys") throw new Error("journey thresholds missed");
      return { passed: true, metrics: { p95_ms: 9.5, records: 42 } };
    });
    let unavailable = disconnect;
    const options = {
      graph: {
        file: graphFile,
        artifactInput: async () => ({
          file: graphFile,
          repoSha: SHA,
          sha256: inputSha,
          bytes: graphBytes.length,
          recordSetSha256: RECORD_SET_DIGEST,
          evaluationAsOf: "2026-08-30",
        }),
        prepareArtifacts: async () => {
          if (unavailable) throw new WorkspaceProviderUnavailable("workspace provider CI unavailable before dispatch");
          const projectionGraph = path.join(root, "projection.db");
          const projectionContext = path.join(root, "projection.json");
          fs.writeFileSync(projectionGraph, "projected graph");
          fs.writeFileSync(projectionContext, "projected context");
          return {
            graphFile: projectionGraph,
            contextFile: projectionContext,
            input: {
              file: projectionContext,
              repoSha: SHA,
              sha256: inputSha,
              bytes: graphBytes.length,
              recordSetSha256: RECORD_SET_DIGEST,
              evaluationAsOf: "2026-08-30",
            },
          };
        },
        activateArtifacts,
        artifactsActive: () => active,
        commit: () => SHA,
      },
      remote,
      bundles: new BundleHandoff(),
      publicUrl: "https://bot.example",
      dir: path.join(root, "artifacts"),
      repoRoot: root,
      desiredShas: async () => [SHA],
      baselineStatus: async () => ({ baselineRef: "v4", baselineSha: "2".repeat(40), commitsBehind: 3 }),
      evaluateArtifact,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
      reconcileMs: 60_000,
    } satisfies ConstructorParameters<typeof KnowledgeArtifactService>[0];
    let service = new KnowledgeArtifactService(options);
    services.push(service);

    await service.start();
    if (disconnect) {
      expect(service.status().job).toMatchObject({ jobKey: key, phase: "pulling", retryCount: 0 });
      expect(service.status().job?.failureCode).toBeUndefined();
      expect(activateArtifacts).not.toHaveBeenCalled();
      expect(fs.existsSync(service.activeFile)).toBe(false);
      await service.stop();
      unavailable = false;
      service = new KnowledgeArtifactService(options);
      services.push(service);
      await service.start();
      expect(remote.status).toHaveBeenLastCalledWith(key);
    }
    expect(remote.start).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(evaluateArtifact.mock.calls.map(([name]) => name)).toEqual(["journeys", "vectorBenchmark"]);
      expect(service.health().active?.evaluations.vectorBenchmark.state).toBe("passed");
    });

    const health = service.health();
    expect(activateArtifacts).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(service.activeFile)).toBe(true);
    expect(health).toMatchObject({
      configured: true,
      status: "degraded",
      vectorSearchOnline: true,
      active: {
        repoSha: SHA,
        commitsBehind: 3,
        evaluations: {
          journeys: { state: "failed", failureCode: "journeys_error" },
          vectorBenchmark: { state: "passed", metrics: { p95_ms: 9.5, records: 42 } },
        },
      },
    });
    expect(health.recentActivations).toHaveLength(1);
    expect(JSON.stringify(health)).not.toContain(root);
    expect(JSON.stringify(health)).not.toMatch(/jobKey|generation/u);
  });
});

function artifactFiles(inputSha: string, inputBytes: number): Record<string, Buffer> {
  const leaf: Record<string, Buffer> = {
    "code/code-index.sqlite": Buffer.from("code index"),
    "model/model-manifest.json": Buffer.from("model manifest"),
    "vector/vector-manifest.json": Buffer.from(`${JSON.stringify({
      repo_sha: SHA,
      contextual_record_schema_digest: CONTEXTUAL_RECORD_SCHEMA_DIGEST,
      record_set_digest: RECORD_SET_DIGEST,
      binding: { ...MULTILINGUAL_E5_SMALL_BINDING, model_manifest_sha256: MODEL_DIGEST },
    })}\n`),
    "conformance-tests.json": Buffer.from(`${JSON.stringify({
      repo_sha: SHA,
      aggregate: { passed: 4, failed: 0 },
    })}\n`),
  };
  const declared = Object.entries(leaf).map(([file, bytes]) => ({ path: file, bytes: bytes.length, sha256: digest(bytes) }));
  const unsigned = {
    schemaVersion: 1,
    kind: "octopus-knowledge-artifact",
    repoSha: SHA,
    input: { sha256: inputSha, bytes: inputBytes },
    bindings: { recordSetDigest: RECORD_SET_DIGEST },
    files: declared,
  };
  leaf["knowledge-artifact-manifest.json"] = Buffer.from(`${canonicalJson({
    ...unsigned,
    manifestDigest: digest(Buffer.from(canonicalJson(unsigned))),
  })}\n`);
  return leaf;
}

function remoteStatus(jobKey: string, files: RemoteKnowledgeStatus["files"]): RemoteKnowledgeStatus {
  return { job_key: jobKey, repo_sha: SHA, state: "upload_pending", files };
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  const info = fs.lstatSync(root);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) makeWritable(path.join(root, name));
  } else {
    fs.chmodSync(root, 0o600);
  }
}
