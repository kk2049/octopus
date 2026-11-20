import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toLandingInput } from "../knowledge/bot-db.js";
import {
  acknowledgementSet,
  buildPathContext,
  buildStartupPack,
  type AcknowledgementSet,
  type PackInput,
  type PackResult,
} from "../knowledge/context-pack.js";
import {
  buildContextualRecords,
  encodeContextualRecordInput,
  parseContextualRecordInput,
} from "../knowledge/contextual-record.js";
import { GraphDb } from "../knowledge/graph-db.js";
import type { TicketInput } from "../knowledge/model.js";
import type { RuntimeInputs } from "../knowledge/sources/landings.js";
import { KnowledgeRetriever, LexicalIndex, SimilarityRegistry } from "../knowledge/retrieval.js";
import { openCodeIndex, type SqliteCodeIndexResolver } from "../knowledge/code-index.js";
import { FlatVectorIndex } from "../knowledge/vector-index.js";
import { LocalE5EmbeddingProvider, sha256 } from "../knowledge/model-binding.js";
import {
  createRetrievalTraceEnvelope,
  RetrievalTraceCollector,
  type RetrievalDeliveryChannel,
  type RetrievalTrace,
  type RetrievalTraceId,
} from "../knowledge/retrieval-trace.js";
import { createLogger } from "../logger.js";
import type { Store } from "../store/store.js";
import { runChild } from "./child-output.js";
import { git, msg } from "./worktree.js";

import { replayKnowledgeRepairs } from "./knowledge-repairs.js";
import { repairFingerprint, REPAIR_PROBLEMS, type RepairProblem } from "../knowledge/repairs.js";

const log = createLogger("knowledge-graph");

const CLI = fileURLToPath(new URL("../knowledge/cli.ts", import.meta.url));
/** Where `tsx` resolves from: this source tree, not the repository being built (tests build fixture repos without node_modules). */
const SOURCE_ROOT = path.resolve(path.dirname(CLI), "../../../..");
const BUILD_TIMEOUT_MS = 10 * 60_000;
const BUILD_OUTPUT_TAIL_BYTES = 4 * 1024 * 1024;
const ORPHAN_TEMP_MIN_AGE_MS = BUILD_TIMEOUT_MS * 2;
const ORPHAN_TEMP_SCAN_LIMIT = 256;

export interface KnowledgeArtifactInput {
  file: string;
  repoSha: string;
  sha256: string;
  bytes: number;
  recordSetSha256: string;
  evaluationAsOf: string;
}

/** Digests the artifact service streamed and verified, keyed relative to each generation subdirectory. */
export interface VerifiedGenerationDigests {
  code: ReadonlyMap<string, string>;
  model: ReadonlyMap<string, string>;
}

export interface KnowledgeArtifactProjection {
  graphFile: string;
  contextFile: string;
  input: KnowledgeArtifactInput;
}
export interface ChildBuildResult {
  sha: string;
  nodes: number;
  edges: number;
  conflicts: number;
  warnings: string[];
  context: { sha256: string; bytes: number; record_set_digest: string };
}
export interface TicketRetrievalAuditContext {
  lane: "ticket";
  subject_ref: `ticket:${number}`;
  turn: number;
  parent_trace_id?: RetrievalTraceId;
}

export interface KnowledgeSubmitCheck {
  acknowledgement: AcknowledgementSet;
  trace: RetrievalTrace;
}


export interface KnowledgeGraphServiceOpts {
  store: Store;
  repoDir: string;
  baseBranch: string;
  /** `<dataDir>/knowledge`; the graph file is `graph.db` inside it. */
  dir: string;
  /** Build ref; defaults to `baseBranch`. Tests pass `WORKTREE`. */
  ref?: string;
  /** Injectable only for deterministic tests. Production keeps a mode-0600 key in `dir`. */
  retrievalHmacKey?: string | Uint8Array;
  remoteBuild?: (input: { repoDir: string; ref: string; inputs: string;
    options: { codeIndexDir?: string; evaluationAsOf?: string; outFile: string; contextFile: string } }) => Promise<ChildBuildResult>;
}

/**
 * Devpipe-side owner of the derived knowledge graph: rebuilds it when the
 * watermark or the landing ledger moved, keeps a read-only handle open, and
 * answers the three assembly questions (startup pack, path context,
 * submit-time acknowledgement). Never throws into the pipeline: a failed
 * build keeps the previous graph; no graph means `available()` is false and
 * callers fall back.
 */
export class KnowledgeGraphService {
  readonly file: string;
  readonly contextFile: string;
  private graph: GraphDb | null = null;
  private retriever: KnowledgeRetriever | null = null;
  private builtKey: string | null = null;
  private building: Promise<void> | null = null;
  private child: ChildProcess | null = null;
  private readonly retrievalHmacKey: Uint8Array;
  private codeIndex: SqliteCodeIndexResolver | null = null;
  private vectorProvider: LocalE5EmbeddingProvider | null = null;
  private vectorIndex: FlatVectorIndex | null = null;
  private activeArtifactGeneration: string | null = null;
  private repairTask: Promise<unknown> | null = null;
  private repairAgain = false;
  private artifactInputCache: KnowledgeArtifactInput | null = null;

  constructor(private readonly opts: KnowledgeGraphServiceOpts) {
    this.file = path.join(opts.dir, "graph.db");
    this.contextFile = path.join(opts.dir, "contextual-input.json");
    if (opts.retrievalHmacKey) this.retrievalHmacKey = Buffer.from(opts.retrievalHmacKey);
    else {
      try {
        this.retrievalHmacKey = this.loadOrCreateRetrievalHmacKey();
      } catch (err) {
        // Observability storage must never take the retrieval authority down.
        // An in-memory key preserves keyed hashing for this process while the
        // mode-0600 key file problem remains visible in logs.
        log.warn({ err: msg(err) }, "knowledge retrieval HMAC key is ephemeral");
        this.retrievalHmacKey = randomBytes(32);
      }
    }
    this.gcOrphanTemporaryFiles();
    this.reopen();
    const persistedRuntime = this.graph?.runtimeInputs();
    const persistedCommit = this.commit();
    if (persistedRuntime && persistedCommit) this.builtKey = this.buildKey(persistedCommit, persistedRuntime);
  }

  available(): boolean {
    return this.retriever != null;
  }

  commit(): string | null {
    return this.graph ? String(this.graph.meta().commit ?? "") || null : null;
  }
  artifactsActive(generationDir: string, repoSha: string): boolean {
    if (!this.activeArtifactGeneration || this.commit() !== repoSha) return false;
    try { return this.activeArtifactGeneration === fs.realpathSync(generationDir); }
    catch { return false; }
  }

  /** Immutable, privacy-filtered contextual records derived from the exact open graph. */
  async artifactInput(): Promise<KnowledgeArtifactInput | null> {
    const graph = this.graph;
    const repoSha = graph ? String(graph.meta().commit ?? "") : "";
    if (!graph || !/^[0-9a-f]{40}$/u.test(repoSha)) return null;
    if (this.artifactInputCache?.repoSha === repoSha) {
      try {
        const cached = fs.lstatSync(this.contextFile);
        if (cached.isFile() && !cached.isSymbolicLink() && cached.size === this.artifactInputCache.bytes) {
          const source = fs.readFileSync(this.contextFile, "utf8");
          if (sha256(source) === this.artifactInputCache.sha256) return { ...this.artifactInputCache };
        }
      } catch {
        // Recreate the transport cache from the authoritative graph below.
      }
    }
    const evaluationAsOf = String(graph.meta().evaluation_as_of ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(evaluationAsOf)) return null;
    const source = encodeContextualRecordInput(repoSha, evaluationAsOf, buildContextualRecords(graph).records);
    const temporary = `${this.contextFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, this.contextFile);
    fs.chmodSync(this.contextFile, 0o400);
    const input = parseContextualRecordInput(source);
    const artifact: KnowledgeArtifactInput = {
      file: this.contextFile,
      repoSha,
      sha256: sha256(source),
      bytes: Buffer.byteLength(source),
      recordSetSha256: input.record_set_digest,
      evaluationAsOf,
    };
    this.artifactInputCache = artifact;
    return { ...artifact };
  }

  /**
   * Install one verified private generation against the exact graph that
   * produced its contextual records. Construction happens before the current
   * resolver/provider are closed, so a refused generation cannot half-activate.
   */
  activateArtifacts(generationDir: string, repoSha: string, projection?: KnowledgeArtifactProjection, verified?: VerifiedGenerationDigests): void {
    const currentGraph = this.graph;
    if (!currentGraph || this.commit() !== repoSha) throw new Error("knowledge artifact SHA does not match the active graph");
    const nextGraph = projection ? GraphDb.openReadonly(projection.graphFile) : currentGraph;
    if (!nextGraph || String(nextGraph.meta().commit ?? "") !== repoSha) throw new Error("knowledge artifact projection is stale");
    const generation = fs.realpathSync(generationDir);
    const nextCode = openCodeIndex(path.join(generation, "code"), { verifiedDigests: verified?.code });
    let nextProvider: LocalE5EmbeddingProvider | null = null;
    const previousCode = this.codeIndex;
    const previousProvider = this.vectorProvider;
    let promoted = false;
    try {
      if (nextCode.gitSha !== repoSha || nextGraph.meta().code_index_sha !== repoSha) {
        throw new Error("code index SHA does not match the projected graph");
      }
      nextProvider = new LocalE5EmbeddingProvider(path.join(generation, "model"), { verifiedDigests: verified?.model });
      const vector = FlatVectorIndex.open({
        directory: path.join(generation, "vector"),
        repoSha,
        provider: nextProvider,
      });
      const similarity = new SimilarityRegistry([new LexicalIndex(nextGraph), vector]);
      const nextRetriever = new KnowledgeRetriever(nextGraph, similarity, nextCode);
      if (projection) {
        if (projection.input.repoSha !== repoSha) throw new Error("knowledge projection input SHA mismatch");
        this.artifactInputCache = null;
        // The contextual file is a repairable cache; graph.db is the single
        // authoritative activation point and is therefore renamed last.
        fs.renameSync(projection.contextFile, this.contextFile);
        fs.renameSync(projection.graphFile, this.file);
      }
      this.graph = nextGraph;
      this.codeIndex = nextCode;
      this.vectorProvider = nextProvider;
      this.vectorIndex = vector;
      this.retriever = nextRetriever;
      this.artifactInputCache = projection ? { ...projection.input, file: this.contextFile } : this.artifactInputCache;
      this.activeArtifactGeneration = generation;
      promoted = true;
      void this.replayRepairs().catch(error => log.warn({err:msg(error)},"knowledge repair replay failed"));
      try { previousCode?.close(); } catch (error) {
        log.warn({ err: msg(error) }, "previous knowledge code index close failed");
      }
      if (previousProvider) {
        void previousProvider.close().catch((error) => log.warn({ err: msg(error) }, "previous knowledge vector provider close failed"));
      }
      if (nextGraph !== currentGraph) {
        try { currentGraph.close(); } catch (error) {
          log.warn({ err: msg(error) }, "previous knowledge graph close failed");
        }
      }
    } catch (error) {
      if (!promoted) {
        nextCode.close();
        void nextProvider?.close();
        if (nextGraph !== currentGraph) nextGraph.close();
      }
      throw error;
    }
  }


  /** Rebuild if inputs changed; serialised; resolves to whether a build ran. */
  async refresh(): Promise<boolean> {
    if (this.building) {
      await this.building.catch(() => undefined);
      return false;
    }
    let sha: string | null = null;
    let runtime: RuntimeInputs;
    try {
      const ref = this.opts.ref ?? this.opts.baseBranch;
      const head = ref === "WORKTREE" ? "WORKTREE" : await git(this.opts.repoDir, ["rev-parse", ref]);
      sha = typeof head === "string" ? head : head.ok ? head.stdout.trim() : null;
      if (!sha) {
        log.warn({ ref }, "knowledge graph: cannot resolve build ref");
        return false;
      }
      runtime = this.runtimeInputs();
    } catch (err) {
      log.warn({ err: msg(err) }, "knowledge graph: cannot read build inputs");
      return false;
    }
    const key = this.buildKey(sha, runtime);
    if (key === this.builtKey) return false;
    const ref = this.opts.ref ?? this.opts.baseBranch;
    this.building = (async () => {
      const started = Date.now();
      this.gcOrphanTemporaryFiles();
      fs.mkdirSync(this.opts.dir, { recursive: true });
      const suffix = `${process.pid}.${randomBytes(6).toString("hex")}`;
      const inputs = path.join(this.opts.dir, `runtime-inputs.${suffix}.json`);
      const graphFile = `${this.file}.build-${suffix}`;
      const contextFile = `${this.contextFile}.build-${suffix}`;
      for (const file of [inputs, graphFile, contextFile]) fs.rmSync(file, { force: true });
      fs.writeFileSync(inputs, JSON.stringify(runtime), { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        const activeInput = this.activeArtifactGeneration && this.vectorIndex && this.codeIndex && this.vectorProvider
          ? await this.artifactInput()
          : null;
        const codeIndexDir = this.reusableCodeIndexDir(sha);
        const result = await this.buildInChild(ref, inputs, {
          outFile: graphFile,
          contextFile,
          ...(codeIndexDir ? { codeIndexDir } : {}),
        });
        const input = this.inputFromChild(result, contextFile);
        const candidate = GraphDb.openReadonly(graphFile);
        try {
          if (!candidate || JSON.stringify(candidate.runtimeInputs()) !== JSON.stringify(runtime)) {
            throw new Error("knowledge graph child omitted its runtime input snapshot");
          }
        } finally {
          candidate?.close();
        }
        const preserveArtifacts = Boolean(
          activeInput
          && activeInput.repoSha === input.repoSha
          && activeInput.recordSetSha256 === input.recordSetSha256,
        );
        fs.renameSync(contextFile, this.contextFile);
        fs.renameSync(graphFile, this.file);
        this.reopen(preserveArtifacts ? input : undefined);
        this.artifactInputCache = { ...input, file: this.contextFile };
        this.builtKey = key;
        log.info(
          { sha: result.sha.slice(0, 12), nodes: result.nodes, edges: result.edges, conflicts: result.conflicts, ms: Date.now() - started },
          "knowledge graph rebuilt",
        );
        for (const warning of result.warnings.slice(0, 5)) log.warn({ warning }, "knowledge graph build warning");
      } finally {
        for (const file of [inputs, graphFile, contextFile]) fs.rmSync(file, { force: true });
      }
    })();
    try {
      await this.building;
      return true;
    } catch (err) {
      log.warn({ err: msg(err) }, "knowledge graph build failed; keeping the previous graph");
      return false;
    } finally {
      this.building = null;
    }
  }

  async startupPack(input: PackInput, audit: TicketRetrievalAuditContext): Promise<PackResult | null> {
    const query = [input.title, input.body, input.spec ?? ""].filter(Boolean).join("\n");
    const tracked = await this.beginCollector("startup", query, audit);
    if (!this.retriever) {
      this.persistTrace(tracked.collector.fail("exact", "graph_unavailable"));
      return null;
    }
    try {
      const pack = await buildStartupPack(this.retriever, input, {
        repoSha: tracked.repoSha,
        codeIndexSha: tracked.codeIndexSha,
        inputRef: audit.subject_ref,
        trace: tracked.collector,
      });
      this.persistTrace(pack.trace);
      return pack;
    } catch {
      this.persistTrace(tracked.collector.fail("assemble", "pack_failed"));
      return null;
    }
  }

  async pathContext(paths: readonly string[], question: string | undefined, audit: TicketRetrievalAuditContext): Promise<PackResult | null> {
    const query = [question ?? "", ...paths].join("\n");
    const tracked = await this.beginCollector("path_refinement", query, {
      ...audit,
      parent_trace_id: audit.parent_trace_id ?? this.opts.store.knowledgeRetrieval.latestDeliveredTrace(audit.subject_ref) ?? undefined,
    });
    if (!this.retriever) {
      this.persistTrace(tracked.collector.fail("exact", "graph_unavailable"));
      return null;
    }
    try {
      const pack = await buildPathContext(this.retriever, paths, question, {
        repoSha: tracked.repoSha,
        codeIndexSha: tracked.codeIndexSha,
        inputRef: audit.subject_ref,
        trace: tracked.collector,
      });
      this.persistTrace(pack.trace);
      return pack;
    } catch {
      this.persistTrace(tracked.collector.fail("assemble", "pack_failed"));
      return null;
    }
  }

  async submitCheck(changedFiles: readonly string[], audit: TicketRetrievalAuditContext): Promise<KnowledgeSubmitCheck | null> {
    const acknowledgement = this.retriever ? acknowledgementSet(this.retriever, changedFiles) : null;
    const tracked = await this.beginCollector("submit_check", changedFiles.join("\n"), audit);
    if (!this.retriever || !acknowledgement) {
      this.persistTrace(tracked.collector.fail("exact", "graph_unavailable"));
      return null;
    }
    try {
      const pack = await buildPathContext(this.retriever, changedFiles, undefined, {
        repoSha: tracked.repoSha,
        codeIndexSha: tracked.codeIndexSha,
        inputRef: audit.subject_ref,
        trace: tracked.collector,
      });
      this.persistTrace(pack.trace);
      return { acknowledgement, trace: pack.trace };
    } catch {
      this.persistTrace(tracked.collector.fail("assemble", "pack_failed"));
      return null;
    }
  }
  acknowledgement(changedFiles: readonly string[]): AcknowledgementSet | null {
    if (!this.retriever) return null;
    return acknowledgementSet(this.retriever, changedFiles);
  }


  markDelivered(traceId: RetrievalTraceId, channel: RetrievalDeliveryChannel): void {
    try {
      this.opts.store.knowledgeRetrieval.markDelivered(traceId, channel);
    } catch (err) {
      log.warn({ traceId, err: msg(err) }, "knowledge retrieval telemetry delivery failed");
    }
  }

  markDeliveredError(traceId: RetrievalTraceId, channel: "ticket_prompt" | "mcp_response", code: "graph_unavailable" | "index_failed" | "pack_failed"): void {
    try {
      this.opts.store.knowledgeRetrieval.markDeliveredError(traceId, channel, code);
    } catch (err) {
      log.warn({ traceId, err: msg(err) }, "knowledge retrieval telemetry error delivery failed");
    }
  }

  markAbandoned(traceId: RetrievalTraceId, code: "graph_unavailable" | "index_failed" | "pack_failed"): void {
    try {
      this.opts.store.knowledgeRetrieval.markAbandoned(traceId, code);
    } catch (err) {
      log.warn({ traceId, err: msg(err) }, "knowledge retrieval telemetry abandonment failed");
    }
  }

  recordReportedUse(traceId: RetrievalTraceId, landingRef: string, contextKeys: readonly string[]): void {
    try {
      this.opts.store.knowledgeRetrieval.recordReportedUse(traceId, landingRef, contextKeys);
    } catch (err) {
      log.warn({ traceId, err: msg(err) }, "knowledge retrieval reported-use telemetry failed");
    }
  }
  recordFeedback(traceId: RetrievalTraceId, code: Parameters<Store["knowledgeRetrieval"]["recordFeedback"]>[1], slot?: Parameters<Store["knowledgeRetrieval"]["recordFeedback"]>[2], expectedRecordId?: string): void {
    try {
      this.opts.store.knowledgeRetrieval.recordFeedback(traceId, code, slot, expectedRecordId);
      // Only record-targeted feedback can identify a content candidate; missing slots without a target stay telemetry.
      const node = expectedRecordId ? this.graph?.node(expectedRecordId) : null;
      const trace = this.opts.store.knowledgeRetrieval.getTrace(traceId);
      if (node && trace && REPAIR_PROBLEMS.includes(code as RepairProblem) && trace.repo_sha === this.commit()) {
        this.opts.store.knowledgeRepairs.observe({record_id:node.id,fingerprint:repairFingerprint(node),problem:code as RepairProblem},
          {key:traceId,trace_id:traceId,graph_sha:this.commit()!,source:"retrieval_feedback"});
      }
    } catch (err) {
      log.warn({ traceId, err: msg(err) }, "knowledge retrieval feedback telemetry failed");
    }
  }


  replayRepairs(): Promise<unknown> {
    this.repairAgain = true;
    if (this.repairTask) return this.repairTask;
    this.repairTask = (async () => {
      let result: unknown = {observed:0,verified:0};
      do {
        this.repairAgain = false;
        const retriever = this.retriever, graph = this.graph, generation = this.activeArtifactGeneration, sha = this.commit();
        if (!retriever || !graph || !sha || !/^[0-9a-f]{40,64}$/u.test(sha)) break;
        for (const conflict of graph.conflicts().filter(c=>c.rule==="stale_anchor").slice(0,20)) {
          const node = graph.node(conflict.b_id ?? conflict.a_id);
          if (node) this.opts.store.knowledgeRepairs.observe({record_id:node.id,fingerprint:repairFingerprint(node),problem:"invalid_anchor"},
            {key:`anchor:${conflict.a_id}`.slice(0,200),graph_sha:sha,source:"graph stale_anchor"});
        }
        result = await replayKnowledgeRepairs({store:this.opts.store,repoDir:this.opts.repoDir,sha,generation:generation ? path.basename(generation) : null,retriever,
          codeIndex:this.codeIndex ?? undefined,isCurrent:()=>this.graph===graph && this.activeArtifactGeneration===generation});
      } while (this.repairAgain);
      return result;
    })().finally(()=>{this.repairTask=null;});
    return this.repairTask;
  }

  hasNode(id: string): boolean {
    return this.graph?.node(id) != null;
  }

  close(): void {
    this.child?.kill("SIGKILL");
    this.child = null;
    this.codeIndex?.close();
    this.codeIndex = null;
    void this.vectorProvider?.close();
    this.vectorProvider = null;
    this.vectorIndex = null;
    this.graph?.close();
    this.graph = null;
    this.retriever = null;
  }

  /**
   * Build, but do not activate, a code-aware graph candidate. Activation
   * opens every graph/code/vector component before replacing current handles.
   */
  async prepareArtifacts(codeIndexDir: string, repoSha: string): Promise<KnowledgeArtifactProjection> {
    if (this.building) await this.building;
    if (this.commit() !== repoSha) throw new Error("knowledge code projection SHA does not match the active graph");
    const evaluationAsOf = String(this.graph?.meta().evaluation_as_of ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(evaluationAsOf)) throw new Error("knowledge graph has no exact lifecycle evaluation date");
    const suffix = `${repoSha}.${process.pid}.${randomBytes(4).toString("hex")}`;
    const graphFile = `${this.file}.artifact-${suffix}`;
    const contextFile = `${this.contextFile}.artifact-${suffix}`;
    const inputs = path.join(this.opts.dir, `runtime-inputs.artifact-${suffix}.json`);
    for (const file of [graphFile, contextFile, inputs]) fs.rmSync(file, { force: true });
    const runtime = this.graph?.runtimeInputs();
    if (!runtime) throw new Error("knowledge graph has no trusted runtime input snapshot");
    fs.writeFileSync(inputs, JSON.stringify(runtime), { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      const result = await this.buildInChild(repoSha, inputs, { codeIndexDir, evaluationAsOf, outFile: graphFile, contextFile });
      const input = this.inputFromChild(result, contextFile);
      const candidate = GraphDb.openReadonly(graphFile);
      try {
        // Name the failing condition: an opaque refusal cost a full artifact
        // cycle to diagnose when this gate first fired in production.
        if (!candidate) throw new Error("knowledge code projection refused: candidate graph did not open");
        const meta = candidate.meta();
        if (meta.commit !== repoSha) {
          throw new Error(`knowledge code projection refused: commit ${String(meta.commit).slice(0, 12)} != ${repoSha.slice(0, 12)}`);
        }
        if (meta.code_index_sha !== repoSha) {
          throw new Error(`knowledge code projection refused: code_index_sha ${String(meta.code_index_sha ?? "absent").slice(0, 12)} != ${repoSha.slice(0, 12)}`);
        }
        const candidateRuntime = JSON.stringify(candidate.runtimeInputs());
        const expectedRuntime = JSON.stringify(runtime);
        if (candidateRuntime !== expectedRuntime) {
          throw new Error(`knowledge code projection refused: runtime inputs diverged (${sha256(candidateRuntime).slice(0, 12)}/${candidateRuntime.length}B != ${sha256(expectedRuntime).slice(0, 12)}/${expectedRuntime.length}B)`);
        }
      } finally {
        candidate?.close();
      }
      return { graphFile, contextFile, input };
    } catch (error) {
      fs.rmSync(graphFile, { force: true });
      fs.rmSync(contextFile, { force: true });
      throw error;
    } finally {
      fs.rmSync(inputs, { force: true });
    }
  }

  private inputFromChild(result: ChildBuildResult, contextFile: string): KnowledgeArtifactInput {
    const info = fs.lstatSync(contextFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== result.context.bytes) {
      throw new Error("knowledge graph child published invalid contextual input metadata");
    }
    const source = fs.readFileSync(contextFile, "utf8");
    const input = parseContextualRecordInput(source);
    if (
      result.sha !== input.repo_sha
      || sha256(source) !== result.context.sha256
      || input.record_set_digest !== result.context.record_set_digest
    ) {
      throw new Error("knowledge graph child contextual input identity mismatch");
    }
    return {
      file: contextFile,
      repoSha: result.sha,
      sha256: result.context.sha256,
      bytes: result.context.bytes,
      recordSetSha256: result.context.record_set_digest,
      evaluationAsOf: input.evaluation_as_of,
    };
  }
  /**
   * The build parses a few hundred documents and writes ~25k rows: 10–50 s of
   * CPU in production that, run in-process, stalled the bot's event loop for
   * 11 s per build in stretches of up to 1.3 s (measured 2026-08-21) — the
   * dashboard, Feishu and Runner keepalives all share that loop. The child
   * runs the same CLI a human runs, under the loader the bot itself runs
   * under (`--import tsx`, as the App backends do); runtime inputs travel as a
   * JSON file so the child never opens bot.db. The graph file is written
   * atomically by the CLI, so `reopen()` after exit sees a complete graph.
   */
  private async buildInChild(
    ref: string,
    inputs: string,
    options: { codeIndexDir?: string; evaluationAsOf?: string; outFile?: string; contextFile?: string } = {},
  ): Promise<ChildBuildResult> {
    if (this.opts.remoteBuild) return await this.opts.remoteBuild({ repoDir: this.opts.repoDir, ref, inputs,
      options: { ...options, outFile: options.outFile ?? this.file, contextFile: options.contextFile ?? this.contextFile } });
    if (process.env.OCTOPUS_COMPUTE_ROLE === "control") throw new Error("knowledge graph remote builder unavailable; local scan disabled");
    const args = [
      "--import", "tsx", CLI, "build",
      "--root", this.opts.repoDir,
      "--out", options.outFile ?? this.file,
      "--context-out", options.contextFile ?? this.contextFile,
      "--at", ref,
      "--runtime", inputs,
      ...(options.codeIndexDir ? ["--code-index", options.codeIndexDir] : []),
      ...(options.evaluationAsOf ? ["--evaluation-as-of", options.evaluationAsOf] : []),
      "--json",
    ];
    // Only the result line and an error's tail are read, so each stream keeps
    // a bounded tail; `execFile`'s 8 MiB maxBuffer used to kill a chatty build.
    const run = await runChild(process.execPath, args, {
      cwd: SOURCE_ROOT, timeoutMs: BUILD_TIMEOUT_MS, killSignal: "SIGKILL", env: process.env,
      tailBytes: BUILD_OUTPUT_TAIL_BYTES, onSpawn: (child) => { this.child = child; },
    });
    this.child = null;
    if (run.error) {
      const stderr = run.stderr.text();
      throw new Error(`${msg(run.error)}${stderr ? `: ${stderr.trim().slice(-800)}` : ""}`);
    }
    const line = run.stdout.text().trim().split("\n").filter(Boolean).at(-1) ?? "";
    try {
      return JSON.parse(line) as ChildBuildResult;
    } catch {
      throw new Error(`unparseable build output: ${line.slice(0, 200)}`);
    }
  }

  private reopen(preservedInput?: KnowledgeArtifactInput): void {
    const previousGraph = this.graph;
    const previousCode = this.codeIndex;
    const previousProvider = this.vectorProvider;
    const previousVector = this.vectorIndex;
    const previousGeneration = this.activeArtifactGeneration;
    let nextGraph: GraphDb | null = null;
    let preserved = false;
    try {
      nextGraph = fs.existsSync(this.file) ? GraphDb.openReadonly(this.file) : null;
      let nextRetriever = nextGraph ? new KnowledgeRetriever(nextGraph) : null;
      if (
        nextGraph
        && preservedInput
        && previousCode
        && previousProvider
        && previousVector
        && previousGeneration
        && String(nextGraph.meta().commit ?? "") === preservedInput.repoSha
        && previousCode.gitSha === preservedInput.repoSha
      ) {
        nextRetriever = new KnowledgeRetriever(
          nextGraph,
          new SimilarityRegistry([new LexicalIndex(nextGraph), previousVector]),
          previousCode,
        );
        preserved = true;
      }
      this.graph = nextGraph;
      this.retriever = nextRetriever;
      this.artifactInputCache = preservedInput ? { ...preservedInput, file: this.contextFile } : null;
      if (!preserved) {
        this.codeIndex = null;
        this.vectorProvider = null;
        this.vectorIndex = null;
        this.activeArtifactGeneration = null;
      }
      previousGraph?.close();
      void this.replayRepairs().catch(error => log.warn({err:msg(error)},"knowledge repair observation failed"));
    } catch (err) {
      nextGraph?.close();
      previousGraph?.close();
      this.graph = null;
      this.retriever = null;
      this.artifactInputCache = null;
      this.codeIndex = null;
      this.vectorProvider = null;
      this.vectorIndex = null;
      this.activeArtifactGeneration = null;
      preserved = false;
      log.warn({ err: msg(err), file: this.file }, "knowledge graph: cannot open");
    }
    if (!preserved) {
      try { previousCode?.close(); } catch (error) {
        log.warn({ err: msg(error) }, "previous knowledge code index close failed");
      }
      if (previousProvider) {
        void previousProvider.close().catch((error) => log.warn({ err: msg(error) }, "previous knowledge vector provider close failed"));
      }
    }
  }

  private buildKey(sha: string, runtime: RuntimeInputs): string {
    // Ticket rows are operational context and are excluded from the remote
    // contextual record set. A newly opened ticket must not invalidate an
    // exact-SHA artifact job that is already building.
    return `${sha}:${runtime.landings.length}:${runtime.landings.at(-1)?.id ?? 0}`;
  }

  private reusableCodeIndexDir(repoSha: string): string | null {
    if (!this.activeArtifactGeneration || this.codeIndex?.gitSha !== repoSha || !this.vectorIndex || !this.vectorProvider) return null;
    const directory = path.join(this.activeArtifactGeneration, "code");
    return fs.existsSync(path.join(directory, "code-index-manifest.json")) ? directory : null;
  }

  /** Direct-child, allow-listed, age-gated cleanup; never walks the repository. */
  private gcOrphanTemporaryFiles(now = Date.now()): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.opts.dir, { withFileTypes: true })
        .filter((entry) => /^(?:(?:graph\.db|contextual-input\.json)\.(?:build|artifact)-|runtime-inputs\.|contextual-input\.json\.\d+\.)/u.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, ORPHAN_TEMP_SCAN_LIMIT);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn({ err: msg(error) }, "knowledge graph temporary-file scan failed");
      return;
    }
    const orphan = /^(?:(?:graph\.db|contextual-input\.json)\.(?:build|artifact)-[A-Za-z0-9.-]+|runtime-inputs\.(?:artifact-)?[0-9a-f.]+\.json|contextual-input\.json\.\d+\.[0-9a-f]+\.tmp)$/u;
    for (const entry of entries) {
      if (!orphan.test(entry.name) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const file = path.join(this.opts.dir, entry.name);
      try {
        const info = fs.lstatSync(file);
        if (now - info.mtimeMs < ORPHAN_TEMP_MIN_AGE_MS) continue;
        fs.rmSync(file, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn({ err: msg(error), file }, "knowledge graph temporary-file cleanup failed");
      }
    }
  }

  private async beginCollector(
    purpose: "startup" | "path_refinement" | "submit_check",
    query: string,
    audit: TicketRetrievalAuditContext,
  ): Promise<{ collector: RetrievalTraceCollector; repoSha: string; codeIndexSha?: string }> {
    // The exact handle serving this query owns the metadata snapshot. Reading
    // `commit()` after retrieval could race a graph swap and bind the trace to
    // an artifact that did not produce its candidates.
    const meta = this.graph?.meta() ?? {};
    const commit = typeof meta.commit === "string" && /^[0-9a-f]{40}$/u.test(meta.commit) ? meta.commit : null;
    let repoSha: string;
    if (commit) {
      repoSha = commit;
    } else {
      const head = await git(this.opts.repoDir, ["rev-parse", "HEAD"]);
      repoSha = head.ok ? head.stdout.trim() : "";
    }
    if (!/^[0-9a-f]{40}$/u.test(repoSha)) throw new Error("knowledge retrieval cannot bind the repository SHA");
    const fingerprint = typeof meta.input_fingerprint === "string" && /^[0-9a-f]{64}$/u.test(meta.input_fingerprint)
      ? meta.input_fingerprint
      : "0".repeat(64);
    const codeIndexSha = this.codeIndex?.gitSha
      ?? ("code_index_sha" in meta && typeof meta.code_index_sha === "string" && /^[0-9a-f]{40}$/u.test(meta.code_index_sha)
        ? meta.code_index_sha
        : undefined);
    const envelope = createRetrievalTraceEnvelope({
      lane: audit.lane,
      purpose,
      subject_ref: audit.subject_ref,
      turn: audit.turn,
      ...(audit.parent_trace_id ? { parent_trace_id: audit.parent_trace_id } : {}),
      query,
      repo_sha: repoSha,
      ...(meta.commit === "WORKTREE" ? { worktree_input_fingerprint: fingerprint } : {}),
      graph_input_fingerprint: fingerprint,
      ...(codeIndexSha ? { code_index_sha: codeIndexSha } : {}),
    }, this.retrievalHmacKey);
    try {
      this.opts.store.knowledgeRetrieval.beginTrace(envelope);
    } catch (err) {
      log.warn({ traceId: envelope.trace_id, err: msg(err) }, "knowledge retrieval telemetry start failed");
    }
    return { collector: new RetrievalTraceCollector(envelope), repoSha, ...(codeIndexSha ? { codeIndexSha } : {}) };
  }

  private persistTrace(trace: RetrievalTrace): void {
    try {
      const repository = this.opts.store.knowledgeRetrieval;
      repository.beginTrace(trace.envelope);
      if (trace.outcome.event === "assembled") repository.appendAssembled(trace.envelope.trace_id, trace.outcome.plan);
      else if (trace.outcome.event === "miss") repository.appendMiss(trace.envelope.trace_id, trace.outcome.plan);
      else repository.appendError(trace.envelope.trace_id, trace.outcome.stage, trace.outcome.code);
    } catch (err) {
      log.warn({ traceId: trace.envelope.trace_id, err: msg(err) }, "knowledge retrieval telemetry result failed");
    }
  }

  private loadOrCreateRetrievalHmacKey(): Uint8Array {
    fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.opts.dir, ".retrieval-hmac-key");
    if (!fs.existsSync(file)) {
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
      try {
        fs.renameSync(temporary, file);
      } catch (err) {
        fs.rmSync(temporary, { force: true });
        if (!fs.existsSync(file)) throw err;
      }
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("retrieval HMAC key must be a regular file");
    fs.chmodSync(file, 0o600);
    const encoded = fs.readFileSync(file, "utf8").trim();
    if (!/^[0-9a-f]{64}$/u.test(encoded)) throw new Error("invalid retrieval HMAC key file");
    return Buffer.from(encoded, "hex");
  }

  private runtimeInputs(): RuntimeInputs {
    const landings = this.opts.store.knowledge.listLandedLandings().map(toLandingInput);
    const tickets: TicketInput[] = this.opts.store.devTickets.listDevTickets(100_000).map((row) => ({
      id: row.id,
      title: row.title,
      requester: row.requester,
      model: row.model,
      kind: row.kind,
      dev_status: row.dev_status,
      created_at: row.created_at,
      landed_at: row.landed_at,
      commit_sha: row.commit_sha,
      parent_ticket_id: row.parent_ticket_id,
      actor_kind: row.actor_kind ?? null,
    }));
    return { landings, tickets };
  }
}
