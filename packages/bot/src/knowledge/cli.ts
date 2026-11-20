#!/usr/bin/env node
/**
 * Knowledge graph CLI.
 *
 *   tsx packages/bot/src/knowledge/cli.ts build --root . --out <dataDir>/knowledge/graph.db [--bot-db <bot.db>|--runtime <inputs.json>] [--at <ref>|WORKTREE] [--json]
 *   tsx packages/bot/src/knowledge/cli.ts context --root . <paths...> [--question "..."] [--graph <graph.db>] [--bot-db <bot.db>]
 *   tsx packages/bot/src/knowledge/cli.ts validate-curated --root . [--evidence <dossier-dir>] [files…]
 *   tsx packages/bot/src/knowledge/cli.ts report --graph <graph.db>
 *   tsx packages/bot/src/knowledge/cli.ts query --graph <graph.db> --paths a,b [--question "…"]
 *   tsx packages/bot/src/knowledge/cli.ts classify --graph <graph.db> --text "…"
 *   tsx packages/bot/src/knowledge/cli.ts pack --graph <graph.db> --bot-db <bot.db> --ticket <id>
 *   tsx packages/bot/src/knowledge/cli.ts model-stage --out <stage>/model
 *   tsx packages/bot/src/knowledge/cli.ts vector-build --input <graph.db|records.jsonl> --model <stage>/model --out <stage>/vector --repo-sha <40hex>
 *
 * `build`, `model-stage`, and `vector-build` write only their explicit output.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { readBotDb } from "./bot-db.js";
import { openCodeIndex } from "./code-index.js";
import {
  buildContextualRecords,
  encodeContextualRecordInput,
  encodeContextualRecordsJsonl,
  parseContextualRecordInput,
  replaceContextualRecords,
  type ContextualRecord,
} from "./contextual-record.js";
import { buildGraph, type BuildResult } from "./build.js";
import type { RuntimeInputs } from "./sources/landings.js";
import { buildPathContext, buildStartupPack } from "./context-pack.js";
import { gitRunner, resolveSha } from "./git.js";
import { GraphDb } from "./graph-db.js";
import { canonicalJson, stagePinnedLocalModel } from "./model-binding.js";
import { KnowledgeRetriever } from "./retrieval.js";
import {
  createRetrievalTraceEnvelope,
  hashRetrievalQuery,
  RetrievalTraceCollector,
  traceEvent,
  traceOutcomeEvent,
  validateRetrievalTraceReceipt,
  type RetrievalTrace,
  type RetrievalTraceId,
  type RetrievalTraceReceiptV1,
} from "./retrieval-trace.js";
import { loadCapabilities } from "./sources/capabilities.js";
import { contractsSource, type ContractProjection } from "./sources/contracts.js";
import { WORKTREE_REF, createSourceContext } from "./sources/context.js";
import { CURATED_DIR, parseCuratedJsonl } from "./sources/curated.js";
import { buildVectorArtifactFromInput } from "./vector-index.js";

function parseArgs(argv: string[]): { command: string; flags: Map<string, string>; rest: string[] } {
  const [command = "help", ...tail] = argv;
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    const arg = tail[index];
    if (arg === "--") continue; // pnpm passes the separator through
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) flags.set(key, inline);
      else {
        const next = tail[index + 1];
        if (next === undefined || next.startsWith("--")) flags.set(key, "true");
        else {
          flags.set(key, next);
          index += 1;
        }
      }
    } else rest.push(arg);
  }
  return { command, flags, rest };
}

function openGraph(flags: Map<string, string>): GraphDb {
  const file = flags.get("graph");
  if (!file) throw new Error("--graph <graph.db> is required");
  const graph = GraphDb.openReadonly(path.resolve(file));
  if (!graph) throw new Error(`graph not found: ${file}`);
  return graph;
}
const CLI_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface CliRetrievalReceiptReference {
  id: RetrievalTraceId;
  receipt_sha256: string;
  file: string;
}
interface CliTraceContext {
  collector: RetrievalTraceCollector;
  repoSha: string;
  codeIndexSha?: string;
  spoolDir: string;
}


async function cliTraceContext(
  root: string,
  graph: GraphDb,
  query: string,
): Promise<CliTraceContext> {
  const git = gitRunner(root);
  const common = await git(["rev-parse", "--git-common-dir"]);
  const commonDir = path.isAbsolute(common) ? common : path.resolve(root, common);
  const spoolDir = path.join(commonDir, "octopus", "knowledge-retrieval");
  fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  const spoolStat = fs.lstatSync(spoolDir);
  if (!spoolStat.isDirectory() || spoolStat.isSymbolicLink()) throw new Error("retrieval receipt spool must be a private directory");
  const commonReal = fs.realpathSync(commonDir);
  const spoolReal = fs.realpathSync(spoolDir);
  if (!spoolReal.startsWith(`${commonReal}${path.sep}`)) throw new Error("retrieval receipt spool escaped the Git common directory");
  fs.chmodSync(spoolDir, 0o700);
  const hmacFile = path.join(spoolDir, ".hmac-key");
  if (!fs.existsSync(hmacFile)) {
    const temporary = `${hmacFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
    try {
      fs.renameSync(temporary, hmacFile);
    } catch (err) {
      fs.rmSync(temporary, { force: true });
      if (!fs.existsSync(hmacFile)) throw err;
    }
  }
  const hmacStat = fs.lstatSync(hmacFile);
  if (!hmacStat.isFile() || hmacStat.isSymbolicLink()) throw new Error("retrieval receipt HMAC key must be a regular file");
  fs.chmodSync(hmacFile, 0o600);
  const encodedKey = fs.readFileSync(hmacFile, "utf8").trim();
  if (!/^[0-9a-f]{64}$/u.test(encodedKey)) throw new Error("invalid retrieval receipt HMAC key");
  const hmacKey = Buffer.from(encodedKey, "hex");
  const meta = graph.meta();
  const repoSha = await resolveSha(git, "HEAD");
  const graphFingerprint = typeof meta.input_fingerprint === "string" && /^[0-9a-f]{64}$/u.test(meta.input_fingerprint)
    ? meta.input_fingerprint
    : "0".repeat(64);
  let codeIndexSha: string | undefined;
  if ("code_index_sha" in meta && typeof meta.code_index_sha === "string" && /^[0-9a-f]{40}$/u.test(meta.code_index_sha)) {
    codeIndexSha = meta.code_index_sha;
  }
  const subject = `cli-scope:${hashRetrievalQuery(commonDir, hmacKey).slice(0, 24)}` as const;
  const envelope = createRetrievalTraceEnvelope({
    lane: "cli",
    purpose: "path_refinement",
    subject_ref: subject,
    query,
    repo_sha: repoSha,
    ...(meta.commit === WORKTREE_REF ? { worktree_input_fingerprint: graphFingerprint } : {}),
    graph_input_fingerprint: graphFingerprint,
    ...(codeIndexSha ? { code_index_sha: codeIndexSha } : {}),
  }, hmacKey);
  return { collector: new RetrievalTraceCollector(envelope), repoSha, ...(codeIndexSha ? { codeIndexSha } : {}), spoolDir };
}

export function spoolRetrievalReceipt(spoolDir: string, trace: RetrievalTrace): CliRetrievalReceiptReference {
  const delivery = trace.outcome.event === "assembled"
    ? traceEvent(trace.envelope.trace_id, "delivery:cli_stdout", { event: "delivered", payload: { channel: "cli_stdout" } })
    : traceEvent(trace.envelope.trace_id, "delivery:cli_stdout", {
        event: "delivered_error",
        payload: {
          stage: "delivery",
          code: trace.outcome.event === "error" ? trace.outcome.code : trace.outcome.plan.unknown[0]?.code ?? "no_grounded_answer",
        },
      });
  const receipt: RetrievalTraceReceiptV1 = validateRetrievalTraceReceipt({
    schema_version: 1,
    envelope: trace.envelope,
    events: [
      traceEvent(trace.envelope.trace_id, "started", { event: "started", payload: {} }, trace.envelope.started_at),
      traceOutcomeEvent(trace),
      delivery,
    ],
  });
  const content = `${JSON.stringify(receipt)}\n`;
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  const file = path.join(spoolDir, `${trace.envelope.trace_id}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return { id: trace.envelope.trace_id, receipt_sha256: digest, file };
}

function pruneCliReceiptSpool(spoolDir: string, now = Date.now()): void {
  for (const entry of fs.readdirSync(spoolDir, { withFileTypes: true })) {
    if (!entry.isFile() || (!/^kr_[0-9a-f]{32}\.json(?:\.\d+\.tmp)?$/u.test(entry.name) && !/^\.hmac-key\.\d+\.tmp$/u.test(entry.name))) continue;
    const file = path.join(spoolDir, entry.name);
    if (now - fs.statSync(file).mtimeMs > CLI_RECEIPT_TTL_MS) fs.rmSync(file, { force: true });
  }
}


async function main(): Promise<void> {
  const { command, flags, rest } = parseArgs(process.argv.slice(2));
  const root = path.resolve(flags.get("root") ?? ".");
  switch (command) {
    case "build": {
      const out = flags.get("out");
      if (!out) throw new Error("--out <graph.db> is required");
      const botDb = flags.get("bot-db");
      const runtimeFile = flags.get("runtime");
      const runtime = runtimeFile
        ? (JSON.parse(fs.readFileSync(path.resolve(runtimeFile), "utf8")) as RuntimeInputs)
        : botDb ? readBotDb(path.resolve(botDb)) : null;
      const started = Date.now();
      const codeIndexDir = flags.get("code-index");
      const codeIndex = codeIndexDir ? openCodeIndex(path.resolve(codeIndexDir)) : undefined;
      let result: BuildResult;
      try {
        result = await buildGraph({
          repoDir: root,
          ref: flags.get("at") ?? "HEAD",
          out: path.resolve(out),
          runtime,
          ...(flags.get("evaluation-as-of") ? { evaluationAsOf: flags.get("evaluation-as-of") } : {}),
          ...(codeIndex ? { codeIndex } : {}),
        });
      } finally {
        codeIndex?.close();
      }
      const contextOut = flags.get("context-out");
      let contextIdentity: { sha256: string; bytes: number; record_set_digest: string } | undefined;
      if (contextOut) {
        const graph = GraphDb.openInMemory();
        let source: string;
        try {
          graph.fill(result.snapshot);
          source = encodeContextualRecordInput(
            result.sha,
            result.snapshot.meta.evaluation_as_of,
            buildContextualRecords(graph).records,
          );
        } finally {
          graph.close();
        }
        const target = path.resolve(contextOut);
        const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, target);
        fs.chmodSync(target, 0o400);
        const parsed = parseContextualRecordInput(source);
        contextIdentity = {
          sha256: createHash("sha256").update(source, "utf8").digest("hex"),
          bytes: Buffer.byteLength(source, "utf8"),
          record_set_digest: parsed.record_set_digest,
        };
      }
      if (flags.get("json") === "true") {
        // One line the KnowledgeGraphService child-process build can parse.
        console.log(JSON.stringify({
          sha: result.sha,
          file: result.file,
          nodes: result.snapshot.nodes.length,
          edges: result.snapshot.edges.length,
          conflicts: result.snapshot.conflicts.length,
          warnings: result.warnings,
          ...(contextIdentity ? { context: contextIdentity } : {}),
        }));
        return;
      }
      const counts = countByKind(result.snapshot.nodes.map((node) => node.kind));
      console.log(`knowledge graph: ${result.sha.slice(0, 12)} → ${result.file} (${Date.now() - started} ms)`);
      console.log(`  nodes ${result.snapshot.nodes.length} edges ${result.snapshot.edges.length} conflicts ${result.snapshot.conflicts.length}`);
      console.log(`  ${Object.entries(counts).map(([kind, n]) => `${kind}=${n}`).join(" ")}`);
      for (const warning of result.warnings.slice(0, 20)) console.warn(`  warning: ${warning}`);
      if (result.warnings.length > 20) console.warn(`  … ${result.warnings.length - 20} more warnings`);
      return;
    }
    case "validate-curated": {
      const git = gitRunner(root);
      const at = flags.get("at") ?? WORKTREE_REF;
      const sha = at === WORKTREE_REF ? WORKTREE_REF : await resolveSha(git, at);
      const ctx = await createSourceContext({
        repoDir: root,
        sha,
        git,
        observedAt: new Date(0).toISOString(),
        evaluationAsOf: new Date().toISOString().slice(0, 10),
      });
      const { doc, errors: capabilityErrors } = await loadCapabilities(ctx);
      if (capabilityErrors.length) {
        for (const error of capabilityErrors) console.error(`capabilities: ${error}`);
        process.exitCode = 1;
        return;
      }
      const existingPaths = new Set(await ctx.list([]));
      const evidenceDir = flags.get("evidence");
      const validation = {
        capabilities: new Set(doc.capabilities.map((cap) => cap.id)),
        modules: new Set(ctx.modules.map((module) => module.id)),
        existingPaths,
        ...(evidenceDir ? { evidence: evidenceLookup(path.resolve(evidenceDir), root) } : {}),
      };
      const files = rest.length
        ? rest
        : fs.existsSync(path.join(root, CURATED_DIR))
          ? fs.readdirSync(path.join(root, CURATED_DIR)).filter((name) => name.endsWith(".jsonl")).map((name) => `${CURATED_DIR}${name}`)
          : [];
      let failures = 0;
      let total = 0;
      for (const file of files) {
        const absolute = path.isAbsolute(file) ? file : path.join(root, file);
        const parsed = parseCuratedJsonl(path.relative(root, absolute), fs.readFileSync(absolute, "utf8"), validation);
        total += parsed.records.length;
        failures += parsed.errors.length;
        for (const error of parsed.errors) console.error(error);
        console.log(`${parsed.file}: ${parsed.records.length} valid record(s), ${parsed.errors.length} error(s)`);
      }
      try {
        const contracts = await contractsSource(ctx);
        console.log(`validate-contracts: ${contracts.nodes.filter((node) => node.kind === "capability_contract").length} contract(s), ${contracts.cells.length} cell(s)`);
      } catch (error) {
        failures += 1;
        console.error(String(error));
      }
      console.log(`validate-curated: ${files.length} file(s), ${total} record(s), ${failures} error(s)`);
      if (failures) process.exitCode = 1;
      return;
    }
    case "model-stage": {
      const out = flags.get("out");
      if (!out) throw new Error("--out <stage>/model is required");
      const modelCache = process.env.OCTOPUS_KNOWLEDGE_MODEL_DIR?.trim();
      const verified = await stagePinnedLocalModel({
        outDir: path.resolve(out),
        ...(modelCache ? { cacheDir: path.resolve(modelCache) } : {}),
      });
      console.log(canonicalJson({
        manifest_sha256: verified.manifest_sha256,
        files: verified.manifest.files,
      }));
      return;
    }
    case "vector-build": {
      const input = flags.get("input");
      const model = flags.get("model");
      const out = flags.get("out");
      const repoSha = flags.get("repo-sha");
      if (!input || !model || !out || !repoSha) {
        throw new Error("--input <graph.db|records.jsonl> --model <verified-model-dir> --out <stage>/vector --repo-sha <40hex> are required");
      }
      const manifest = await buildVectorArtifactFromInput({
        input: path.resolve(input),
        modelDir: path.resolve(model),
        outDir: path.resolve(out),
        repoSha,
      });
      console.log(canonicalJson(manifest));
      return;
    }
    case "contract-resolve-records": {
      const input = flags.get("input");
      const codeIndexDir = flags.get("code-index");
      const out = flags.get("out");
      const repoSha = flags.get("repo-sha");
      if (!input || !codeIndexDir || !out || !repoSha) {
        throw new Error("--input <contextual-input.json> --code-index <code-dir> --out <records.jsonl> --repo-sha <40hex> are required");
      }
      const base = parseContextualRecordInput(fs.readFileSync(path.resolve(input), "utf8"));
      if (base.repo_sha !== repoSha) throw new Error("contextual input repository SHA mismatch");
      const git = gitRunner(root);
      const ctx = await createSourceContext({
        repoDir: root,
        sha: repoSha,
        git,
        observedAt: new Date(0).toISOString(),
        evaluationAsOf: base.evaluation_as_of,
      });
      const codeIndex = openCodeIndex(path.resolve(codeIndexDir));
      let projected: Awaited<ReturnType<typeof contractsSource>>;
      try {
        if (codeIndex.gitSha !== repoSha) throw new Error("contract resolver code index SHA mismatch");
        projected = await contractsSource(ctx, { codeIndex });
      } finally {
        codeIndex.close();
      }
      const contractGraph = GraphDb.openInMemory();
      let replacements: ContextualRecord[];
      try {
        contractGraph.fill({
          nodes: projected.nodes,
          edges: projected.edges,
          coverage: projected.coverage,
          conflicts: [],
          cells: projected.cells,
          observations: projected.observations,
          observationArtifacts: projected.observationArtifacts,
          meta: {
            schema_version: 2,
            commit: repoSha,
            built_at: new Date(0).toISOString(),
            evaluation_as_of: base.evaluation_as_of,
            tool_version: "contract-record-projection-v1",
            input_fingerprint: "0".repeat(64),
            projection_digest: "0".repeat(64),
            code_index_sha: repoSha,
            node_count: projected.nodes.length,
            edge_count: projected.edges.length,
          },
        });
        replacements = buildContextualRecords(contractGraph).records;
      } finally {
        contractGraph.close();
      }
      const records = replaceContextualRecords(base.records, replacements);
      const source = encodeContextualRecordsJsonl(records);
      const target = path.resolve(out);
      if (fs.existsSync(target)) throw new Error("resolved contextual output already exists");
      fs.writeFileSync(target, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
      console.log(canonicalJson({ repo_sha: repoSha, record_set_digest: createHash("sha256").update(source).digest("hex"), records: records.length }));
      return;
    }
    case "report": {
      const graph = openGraph(flags);
      try {
        const meta = graph.meta();
        const counts = graph.counts();
        console.log(`graph ${String(meta.commit).slice(0, 12)} built ${String(meta.built_at)} nodes=${counts.nodes} edges=${counts.edges}`);
        console.log(`  ${Object.entries(counts.byKind).map(([kind, n]) => `${kind}=${n}`).join(" ")}`);
        const conflicts = graph.conflicts();
        console.log(`conflicts: ${conflicts.length}`);
        for (const item of conflicts.slice(0, Number(flags.get("limit") ?? 50))) console.log(`  [${item.severity}] ${item.rule}: ${item.why}`);
        const coverage = graph.coverage();
        const gaps = coverage.filter((row) => row.value === 0 && row.note);
        console.log(`coverage gaps: ${gaps.length}`);
        for (const row of gaps.slice(0, Number(flags.get("limit") ?? 50))) console.log(`  ${row.scope_kind} ${row.scope_id}: ${row.note}`);
        const byCapability = coverage.filter((row) => row.scope_kind === "capability");
        const capabilities = new Map<string, Record<string, number>>();
        for (const row of byCapability) (capabilities.get(row.scope_id) ?? capabilities.set(row.scope_id, {}).get(row.scope_id))![row.measure] = row.value;
        console.log("capabilities:");
        for (const [id, measures] of [...capabilities.entries()].sort()) {
          console.log(`  ${id.replace(/^capability:/, "")}: ${Object.entries(measures).map(([k, v]) => `${k}=${v}`).join(" ")}`);
        }
      } finally {
        graph.close();
      }
      return;
    }
    case "query": {
      const graph = openGraph(flags);
      try {
        const paths = (flags.get("paths") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
        if (!paths.length) throw new Error("--paths a,b is required");
        const result = await buildPathContext(new KnowledgeRetriever(graph), paths, flags.get("question"));
        console.log(result.text);
        console.log(`\n(${result.chars} chars, ${result.included.length} records)`);
      } finally {
        graph.close();
      }
      return;
    }
    case "context": {
      // The off-ticket twin of `devpipe_context`: the reading list for the paths
      // you are about to change. Without a prebuilt graph it builds an exact
      // committed-HEAD projection (≈10–20 s). Retrieval deliberately rejects
      // the WORKTREE pseudo-ref because it cannot provide an exact Git SHA.
      const paths = rest.map((item) => item.replace(/^\.\//, "")).filter(Boolean);
      if (!paths.length) throw new Error("usage: context <paths...> [--question ...] [--graph graph.db] [--bot-db bot.db]");
      const graphFile = flags.get("graph") ?? process.env.OCTOPUS_KNOWLEDGE_GRAPH;
      const botDb = flags.get("bot-db") ?? process.env.OCTOPUS_BOT_DB;
      let temp: string | null = null;
      let graph: GraphDb | null;
      if (graphFile) {
        graph = GraphDb.openReadonly(path.resolve(graphFile));
        if (!graph) throw new Error(`graph not found: ${graphFile}`);
      } else {
        if (process.env.OCTOPUS_COMPUTE_ROLE === "control") {
          throw new Error("Control node requires --graph or OCTOPUS_KNOWLEDGE_GRAPH; run graph builds on the registered provider");
        }
        temp = path.join(os.tmpdir(), `knowledge-context-${process.pid}.db`);
        console.error("(no --graph / OCTOPUS_KNOWLEDGE_GRAPH: building an exact graph from committed HEAD first, ~10–20 s)");
        await buildGraph({ repoDir: root, ref: "HEAD", out: temp, runtime: botDb ? readBotDb(path.resolve(botDb)) : null });
        graph = GraphDb.openReadonly(temp);
        if (!graph) throw new Error("could not open the freshly built graph");
      }
      try {
        const question = flags.get("question");
        let traceContext: CliTraceContext | null = null;
        try {
          traceContext = await cliTraceContext(root, graph, [question ?? "", ...paths].join("\n"));
          pruneCliReceiptSpool(traceContext.spoolDir);
        } catch (error) {
          console.warn(`retrieval receipt unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        const result = await buildPathContext(
          new KnowledgeRetriever(graph),
          paths,
          question,
          traceContext
            ? {
                repoSha: traceContext.repoSha,
                codeIndexSha: traceContext.codeIndexSha,
                inputRef: traceContext.collector.envelope.subject_ref,
                trace: traceContext.collector,
              }
            : undefined,
        );
        console.log(result.text);
        console.log(`\n(${result.chars} chars, ${result.included.length} records; cite exact ⟨id⟩ values in the v3 CLI report retrieval.context_keys)`);
        if (traceContext) {
          try {
            const receipt = spoolRetrievalReceipt(traceContext.spoolDir, result.trace);
            console.log(JSON.stringify({ trace_id: receipt.id, receipt_sha256: receipt.receipt_sha256 }));
          } catch (error) {
            console.warn(`retrieval receipt unavailable: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } finally {
        graph.close();
        if (temp) fs.rmSync(temp, { force: true });
      }
      return;
    }
    case "classify": {
      const graph = openGraph(flags);
      try {
        const text = flags.get("text") ?? "";
        const matches = await new KnowledgeRetriever(graph).classify({ text });
        for (const match of matches) console.log(`${match.id} [${match.certainty}] score=${match.score.toFixed(1)} ${match.why.join("; ")}`);
        if (!matches.length) console.log("(no capability matched)");
      } finally {
        graph.close();
      }
      return;
    }
    case "pack": {
      const graph = openGraph(flags);
      const botDb = flags.get("bot-db");
      const ticket = Number(flags.get("ticket"));
      if (!botDb || !Number.isInteger(ticket)) throw new Error("--bot-db and --ticket are required");
      const db = new Database(path.resolve(botDb), { readonly: true, fileMustExist: true });
      try {
        const row = db.prepare("SELECT title, body, spec, ci_roster FROM dev_tickets WHERE id = ?").get(ticket) as
          | { title: string; body: string; spec: string | null; ci_roster: string | null }
          | undefined;
        if (!row) throw new Error(`ticket ${ticket} not found`);
        let roster: string[] = [];
        try {
          roster = row.ci_roster ? (JSON.parse(row.ci_roster) as string[]) : [];
        } catch {
          roster = [];
        }
        const result = await buildStartupPack(new KnowledgeRetriever(graph), { title: row.title, body: row.body, spec: row.spec, ciRoster: roster }, {
          budget: Number(flags.get("budget") ?? 6_000),
        });
        console.log(result.text);
        console.log(`\n(${result.chars} chars, ${result.included.length} records; capabilities: ${result.capabilities.map((m) => `${m.id}/${m.certainty}`).join(", ") || "none"})`);
      } finally {
        db.close();
        graph.close();
      }
      return;
    }
    default:
      console.log("commands: build | model-stage | vector-build | validate-curated | report | context | query | classify | pack (see file header)");
  }
}

/**
 * Cited-source text for `validate-curated --evidence <dossier-dir>`: ticket
 * bodies and messages come from the exported dossiers (outside Git), file
 * sources from the working tree. Returns null when the text is unavailable.
 */
function evidenceLookup(dossierDir: string, root: string): (record: { ticket?: number; source: { type: string; message_id?: number; path?: string } }) => string | null {
  const cache = new Map<number, { body: string; messages: Map<number, string> } | null>();
  const dossier = (ticket: number) => {
    if (!cache.has(ticket)) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dossierDir, "dossiers", `${ticket}.json`), "utf8")) as {
          ticket: { body: string; messages: Array<{ id: number; body: string }> };
        };
        cache.set(ticket, { body: raw.ticket.body, messages: new Map(raw.ticket.messages.map((message) => [message.id, message.body])) });
      } catch {
        cache.set(ticket, null);
      }
    }
    return cache.get(ticket) ?? null;
  };
  return (record) => {
    const { source } = record;
    if (source.type === "ticket_body") return record.ticket ? dossier(record.ticket)?.body ?? null : null;
    if (source.type === "ticket_message") {
      const found = record.ticket ? dossier(record.ticket) : null;
      return found && source.message_id != null ? found.messages.get(source.message_id) ?? null : null;
    }
    if (source.path) {
      try {
        return fs.readFileSync(path.join(root, source.path), "utf8");
      } catch {
        return null;
      }
    }
    return null;
  };
}

function countByKind(kinds: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of kinds) out[kind] = (out[kind] ?? 0) + 1;
  return out;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
