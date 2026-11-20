import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { KnowledgeGraphServiceOpts, ChildBuildResult } from "./knowledge-graph-service.js";
import type { WorkspaceProvider } from "./workspace-provider.js";
import { git, gitOrThrow } from "./worktree.js";
import { shellQuote } from "./runner-machine-sync.js";
import { createLogger } from "../logger.js";
import { GraphDb } from "../knowledge/graph-db.js";
import type { KnowledgeDeployProjection } from "./knowledge-deploy.js";
const log = createLogger("knowledge-graph-runner");
interface GraphFile { name: string; bytes: number; sha256: string; compressedBytes: number; compressedSha256: string }

/** Scratch directories under `worktreesDir` that a build in this process is still using. */
const scratchInUse = new Set<string>();
/** Names this module gives its scratch directories; a match not in use is a leftover. */
export const KNOWLEDGE_SCRATCH = /^_(?:graph-[0-9a-f]{40}(?:-[0-9a-f]{8})?|deploy-review-[A-Za-z0-9]{6})$/;
export function knowledgeScratchInUse(dir: string): boolean { return scratchInUse.has(path.resolve(dir)); }

export function runnerKnowledgeDeployProjection(opts: { provider: WorkspaceProvider; worktreesDir: string; signal: AbortSignal }): KnowledgeDeployProjection {
  const build = runnerKnowledgeGraphBuilder(opts);
  return async ({ repoDir, ref, runtime }) => {
    await fs.mkdir(opts.worktreesDir, { recursive: true });
    const dir = path.resolve(await fs.mkdtemp(path.join(opts.worktreesDir, "_deploy-review-")));
    scratchInUse.add(dir);
    const inputs = path.join(dir, "runtime.json"), outFile = path.join(dir, "graph.db");
    try {
      await fs.writeFile(inputs, JSON.stringify(runtime), { mode: 0o600 });
      const result = await build({ repoDir, ref, inputs, options: { outFile, contextFile: path.join(dir, "context.json") } });
      const graph = GraphDb.openReadonly(outFile);
      if (!graph) throw new Error("remote deployment knowledge graph cannot be opened");
      try {
        if (graph.meta().commit !== result.sha || !isDeepStrictEqual(graph.runtimeInputs(), runtime)) throw new Error("remote deployment knowledge input mismatch");
        return { nodes: graph.allNodes(), conflicts: graph.conflicts() };
      } finally { graph.close(); }
    } finally { await fs.rm(dir, { recursive: true, force: true }); scratchInUse.delete(dir); }
  };
}

export function runnerKnowledgeGraphBuilder(opts: { provider: WorkspaceProvider; worktreesDir: string; signal: AbortSignal }): NonNullable<KnowledgeGraphServiceOpts["remoteBuild"]> {
  return async ({ repoDir, ref, inputs, options }) => {
    const sha = await gitOrThrow(repoDir, ["rev-parse", `${ref}^{commit}`]);
    const digest = createHash("sha256"); for await (const b of createReadStream(inputs)) digest.update(b);
    // The previous release may predate this helper; bind the trusted controller's helper as a small side input.
    const helper = fileURLToPath(new URL("../../../../scripts/ops/knowledge-graph-build.mjs", import.meta.url));
    digest.update(await fs.readFile(helper));
    const identity = digest.update(JSON.stringify([Boolean(options.codeIndexDir), options.evaluationAsOf ?? ""])).digest("hex");
    const key = `knowledge-graph:${sha}:${identity}`;
    // The provider only bundles Git objects from HEAD, so the source needs no
    // checkout. One per build and removed once the task has its input: a
    // shared, checked-out `_graph-<sha>` per commit used to stay forever.
    const sourceDir = path.resolve(opts.worktreesDir, `_graph-${sha}-${randomBytes(4).toString("hex")}`);
    const task = { key, workspaceKey: "knowledge-graph", sha, sourceDir, files: [{ name: "runtime.json", file: inputs }, { name: "graph-build.mjs", file: helper }],
      command: `node "$OCTOPUS_JOB_INPUT_DIR/graph-build.mjs" ${sha} ${options.codeIndexDir ? "code" : "graph"} ${shellQuote(options.evaluationAsOf ?? "")}`,
      timeoutMs: 900000 };
    const started = Date.now();
    log.info({ sha, key, device: opts.provider.target.device }, "knowledge graph rebuild requested on Runner");
    let status;
    scratchInUse.add(sourceDir);
    try {
      await fs.mkdir(opts.worktreesDir, { recursive: true });
      await gitOrThrow(repoDir, ["worktree", "add", "--detach", "--no-checkout", sourceDir, sha]);
      do {
        status = await opts.provider.wait(task, opts.signal);
        if (status.state !== "not_started" || status.error !== "workspace_busy") break;
        if (Date.now() - started > 300000) break;
        await delay(5000, undefined, { signal: opts.signal });
      } while (!opts.signal.aborted);
    } finally {
      if (!(await git(repoDir, ["worktree", "remove", "--force", sourceDir])).ok) await fs.rm(sourceDir, { recursive: true, force: true });
      scratchInUse.delete(sourceDir);
    }
    if (status.state !== "succeeded") throw new Error(`knowledge graph Runner ${status.state}: ${status.error ?? status.exit_code}`);
    const raw = await opts.provider.artifact(key, "graph-result.json", 0, 65536, opts.signal);
    if (!raw.eof) throw new Error("knowledge graph manifest exceeds limit");
    const result = JSON.parse(raw.data.toString("utf8")) as { version: number; sha: string; result: ChildBuildResult; files: GraphFile[] };
    if (result.version !== 1 || result.sha !== sha || result.result?.sha !== sha || result.files?.length !== 2
      || new Set(result.files.map(f => f.name)).size !== 2) throw new Error("knowledge graph source manifest mismatch");
    for (const file of result.files) {
      if (!["graph.db", "context.json"].includes(file.name) || ![file.sha256, file.compressedSha256].every(h => /^[0-9a-f]{64}$/.test(h))
        || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 128 * 1024 * 1024
        || !Number.isSafeInteger(file.compressedBytes) || file.compressedBytes < 1 || file.compressedBytes > 32 * 1024 * 1024) throw new Error("invalid knowledge graph artifact size/digest");
      const destination = file.name === "graph.db" ? options.outFile : options.contextFile;
      const compressed = `${destination}.gz.partial`; await fs.mkdir(path.dirname(destination), { recursive: true });
      const h = await fs.open(compressed, "w", 0o600), digest = createHash("sha256"); let offset = 0;
      try {
        while (offset < file.compressedBytes) {
          opts.signal.throwIfAborted();
          const part = await opts.provider.artifact(key, `${file.name}.gz`, offset, Math.min(1048576, file.compressedBytes - offset), opts.signal);
          if (part.total !== file.compressedBytes || !part.data.length) throw new Error("knowledge graph transfer changed");
          digest.update(part.data); await h.writeFile(part.data); offset += part.data.length;
        }
      } finally { await h.close(); }
      try {
        if (digest.digest("hex") !== file.compressedSha256) throw new Error("knowledge graph compressed digest mismatch");
        let bytes = 0; const unpackedDigest = createHash("sha256");
        await pipeline(createReadStream(compressed), createGunzip(), new Transform({ transform(chunk: Buffer, _encoding, cb) {
          bytes += chunk.length; if (bytes > file.bytes) { cb(new Error("knowledge graph expansion exceeds declared size")); return; }
          unpackedDigest.update(chunk); cb(null, chunk);
        } }), createWriteStream(destination, { mode: 0o600 }), { signal: opts.signal });
        if (bytes !== file.bytes || unpackedDigest.digest("hex") !== file.sha256) throw new Error("knowledge graph file digest mismatch");
      } finally { await fs.rm(compressed, { force: true }); }
    }
    log.info({ sha, device: opts.provider.target.device, ms: Date.now() - started }, "knowledge graph received from Runner");
    return result.result;
  };
}
