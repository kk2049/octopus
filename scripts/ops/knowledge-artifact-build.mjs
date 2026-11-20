#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateKnowledgeArtifact } from "./knowledge-artifact-evaluate.mjs";

const SHA = /^[0-9a-f]{40}$/;
const EXPECTED = [
  "code/code-index-manifest.json",
  "code/code-index.sqlite",
  "code/index.scip",
  "code/tests.json",
  "conformance-tests.json",
  "model/config.json",
  "model/model-manifest.json",
  "model/onnx/config.json",
  "model/onnx/model.onnx",
  "model/sentencepiece.bpe.model",
  "model/special_tokens_map.json",
  "model/tokenizer.json",
  "model/tokenizer_config.json",
  "vector/vector-manifest.json",
  "vector/vector-records.jsonl",
  "vector/vectors.f32le",
];
const CONFORMANCE = [
  "packages/bot/src/knowledge/contracts.test.ts",
  "packages/bot/src/session-plus/operation-binding.test.ts",
  "packages/runner/src/agent-control-plane.test.ts",
  "packages/runner/src/omp-rpc.test.ts",
];
const OUTPUT_CAPTURE_MAX = 1024 * 1024;

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root);
const input = path.resolve(args.input);
const out = path.resolve(args.out);
const repoSha = args.repoSha;
if (!SHA.test(repoSha)) fail("--repo-sha must be an exact 40-character lowercase SHA");
await exactCleanCheckout(root, repoSha);
const inputInfo = await stat(input);
if (!inputInfo.isFile() || inputInfo.size <= 0) fail("--input must be a non-empty regular contextual input file");
const inputBinding = { sha256: await sha256File(input), bytes: inputInfo.size };
await refuseExisting(out);
const partial = `${out}.partial-${process.pid}`;
const resolvedInput = `${partial}.resolved-records.jsonl`;
await rm(resolvedInput, { force: true });
await rm(partial, { recursive: true, force: true });
await mkdir(partial, { recursive: false, mode: 0o700 });

try {
  const conformance = [];
  for (const file of CONFORMANCE) {
    const result = await command(root, "pnpm", ["exec", "vitest", "run", "--project", "node", "--maxWorkers=1", file], { allowFailure: true });
    conformance.push({
      file,
      status: result.code === 0 ? "passed" : "failed",
      exit_code: result.code,
      stdout_sha256: result.stdoutSha256,
      stderr_sha256: result.stderrSha256,
      stdout_bytes: result.stdoutBytes,
      stderr_bytes: result.stderrBytes,
    });
  }
  const failed = conformance.filter((row) => row.status !== "passed").length;
  const conformanceDoc = {
    schema_version: 1,
    repo_sha: repoSha,
    files: conformance,
    aggregate: { passed: conformance.length - failed, failed },
  };
  await writeFile(path.join(partial, "conformance-tests.json"), `${canonicalJson(conformanceDoc)}\n`, { mode: 0o600 });
  if (failed) fail(`${failed} fixed conformance test file(s) failed`);


  await command(root, "pnpm", ["exec", "tsx", "packages/architecture-observatory/src/code-index/cli.ts", "build",
    "--root", root, "--repo-sha", repoSha, "--out", path.join(partial, "code")]);
  await command(root, "pnpm", ["exec", "tsx", "packages/bot/src/knowledge/cli.ts", "contract-resolve-records",
    "--root", root, "--input", input, "--code-index", path.join(partial, "code"), "--out", resolvedInput, "--repo-sha", repoSha]);
  await command(root, "pnpm", ["exec", "tsx", "packages/bot/src/knowledge/cli.ts", "model-stage", "--out", path.join(partial, "model")]);
  await command(root, "pnpm", ["exec", "tsx", "packages/bot/src/knowledge/cli.ts", "vector-build", "--input", resolvedInput,
    "--model", path.join(partial, "model"), "--out", path.join(partial, "vector"), "--repo-sha", repoSha]);
  await rm(resolvedInput, { force: true });


  await verifySubManifest(path.join(partial, "code/code-index-manifest.json"), repoSha, "code-index");
  await verifySubManifest(path.join(partial, "vector/vector-manifest.json"), repoSha, "vector");
  await verifyModelManifest(path.join(partial, "model/model-manifest.json"));
  const actualFiles = await recursiveFiles(partial);
  if (JSON.stringify(actualFiles) !== JSON.stringify([...EXPECTED].sort())) {
    fail("artifact output contains missing, extra, or non-regular members");
  }
  const files = [];
  for (const relative of EXPECTED) {
    assertRelative(relative);
    const file = path.join(partial, relative);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) fail(`artifact member is not a regular file: ${relative}`);
    files.push({ path: relative, bytes: info.size, sha256: await sha256File(file) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const codeManifestSource = await readFile(path.join(partial, "code/code-index-manifest.json"));
  const vectorManifestSource = await readFile(path.join(partial, "vector/vector-manifest.json"));
  const modelManifestSource = await readFile(path.join(partial, "model/model-manifest.json"));
  const code = JSON.parse(codeManifestSource);
  const vector = JSON.parse(vectorManifestSource);
  const model = JSON.parse(modelManifestSource);
  const fixedEmbeddingBinding = { ...(vector.binding ?? {}) };
  delete fixedEmbeddingBinding.model_manifest_sha256;
  const evaluations = await evaluateKnowledgeArtifact({ root, input, artifact: partial, repoSha, inputSha256: inputBinding.sha256, command });
  const manifest = {
    evaluations,
    schemaVersion: 1,
    kind: "octopus-knowledge-artifact",
    repoSha,
    input: inputBinding,
    bindings: {
      codeIndexManifestDigest: requiredDigest(code, "code index"),
      vectorManifestDigest: sha256(vectorManifestSource),
      modelManifestDigest: sha256(modelManifestSource),
      contextualRecordSchemaDigest: exactDigest(vector.contextual_record_schema_digest, "contextual record schema"),
      recordSetDigest: exactDigest(vector.record_set_digest, "resolved contextual record set"),
      embeddingBindingDigest: sha256(Buffer.from(canonicalJson(fixedEmbeddingBinding))),
    },
    conformance: { files: [...CONFORMANCE], passed: CONFORMANCE.length, failed: 0 },
    files,
  };
  const manifestDigest = sha256(Buffer.from(canonicalJson(manifest)));
  await writeFile(path.join(partial, "knowledge-artifact-manifest.json"), `${canonicalJson({ ...manifest, manifestDigest })}\n`, { mode: 0o600 });
  await rename(partial, out);
  process.stdout.write(`${canonicalJson({ ok: true, repoSha, input: inputBinding, manifestDigest, files: files.length })}\n`);
} catch (error) {
  await rm(partial, { recursive: true, force: true });
  await rm(resolvedInput, { force: true });
  throw error;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!value || !["--root", "--input", "--out", "--repo-sha"].includes(key)) fail(`unknown or incomplete argument: ${String(key)}`);
    if (key === "--root") result.root = value;
    if (key === "--input") result.input = value;
    if (key === "--out") result.out = value;
    if (key === "--repo-sha") result.repoSha = value;
  }
  if (!result.root || !result.input || !result.out || !result.repoSha) fail("required: --root --input --out --repo-sha");
  return result;
}

async function exactCleanCheckout(root, repoSha) {
  const head = await command(root, "git", ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.stdout.toString("utf8").trim() !== repoSha) fail("--root is not at --repo-sha");
  const dirty = await command(root, "git", ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (dirty.stdout.length) fail("--root has tracked or untracked changes; deterministic build refused");
}

async function refuseExisting(out) {
  try { await lstat(out); fail("--out already exists; refusing to mix artifact generations"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function verifySubManifest(file, repoSha, label) {
  const doc = JSON.parse(await readFile(file, "utf8"));
  const actual = doc.repoSha ?? doc.repo_sha;
  if (actual !== repoSha) fail(`${label} manifest is stale`);
  if (label === "code-index") requiredDigest(doc, `${label} manifest`);
}

async function verifyModelManifest(file) {
  const doc = JSON.parse(await readFile(file, "utf8"));
  const revision = doc.binding?.immutable_revision ?? doc.revision ?? doc.model_revision ?? doc.binding?.revision;
  const weight = doc.weightSha256 ?? doc.weight_sha256 ?? doc.binding?.weight_sha256;
  if (revision !== "614241f622f53c4eeff9890bdc4f31cfecc418b3" || weight !== "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665") {
    fail("model manifest is not bound to the approved immutable E5 fp32 weights");
  }
}

function requiredDigest(value, label) {
  if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) return value;
  if (!value || typeof value !== "object") fail(`${label} has no digest`);
  for (const key of ["manifestDigest", "manifest_digest", "digest", "sha256"]) {
    if (typeof value[key] === "string" && /^[0-9a-f]{64}$/.test(value[key])) return value[key];
  }
  fail(`${label} has no valid digest`);
}

function exactDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(`${label} has no valid digest`);
  return value;
}

function command(cwd, executable, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs) : null;
    const stdout = [], stderr = [];
    const stdoutHash = createHash("sha256"), stderrHash = createHash("sha256");
    let stdoutBytes = 0, stderrBytes = 0;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      stdoutHash.update(chunk);
      if (stdoutBytes <= OUTPUT_CAPTURE_MAX) stdout.push(Buffer.from(chunk));
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      stderrHash.update(chunk);
      if (stderrBytes <= OUTPUT_CAPTURE_MAX) stderr.push(Buffer.from(chunk));
      process.stderr.write(chunk);
    });
    child.once("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const result = {
        code: timedOut ? 124 : code ?? 128,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        stdoutBytes,
        stderrBytes,
        stdoutSha256: stdoutHash.digest("hex"),
        stderrSha256: stderrHash.digest("hex"),
      };
      if (!options.allowFailure && result.code !== 0) reject(Object.assign(new Error(`${executable} ${argv[0] ?? ""} failed with rc ${result.code}`), { code: result.code }));
      else resolve(result);
    });
  });
}

async function recursiveFiles(root, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`artifact output contains a symlink: ${child}`);
    if (entry.isDirectory()) result.push(...await recursiveFiles(root, child));
    else if (entry.isFile()) result.push(child);
    else fail(`artifact output contains a non-regular member: ${child}`);
  }
  return result.sort();
}

function assertRelative(file) {
  if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").some((part) => !part || part === "." || part === "..")) fail(`unsafe artifact path: ${file}`);
  if (!(file.startsWith("code/") || file.startsWith("vector/") || file.startsWith("model/") || file === "conformance-tests.json")) fail(`artifact outside allowlist: ${file}`);
}
async function sha256File(file) { const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function fail(message) { throw new Error(message); }
