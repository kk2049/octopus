import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import ts from "typescript";

import { discoverWorkspacePackages } from "../analyzer/paths.js";
import { analyzeTypeScript } from "../analyzer/typescript.js";
import { assertRepoSha } from "./identity.js";
import {
  decodeAndNormalizeScip,
  type NormalizationCoverage,
  type TestInventoryEntry,
} from "./normalize.js";
import { discoverCodeIndexProjects, type CodeIndexProject } from "./projects.js";
import { CODE_INDEX_SCHEMA_VERSION } from "./schema.js";

const SCIP_TYPESCRIPT_VERSION = "0.4.0";
const SCIP_BINDING_VERSION = "0.9.0";
const PROTOBUF_VERSION = "2.11.0";
const BETTER_SQLITE3_VERSION = "11.10.0";
const VITEST_VERSION = "4.1.0";
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
const TEST_INVENTORY_SCHEMA_VERSION = 2;
const requireFromTool = createRequire(import.meta.url);

export interface BuildCodeIndexOptions {
  root: string;
  sha: string;
  outDir: string;
  signal?: AbortSignal;
}

export interface CodeIndexManifestFile {
  sha256: string;
  bytes: number;
}

export interface CodeIndexManifest {
  schemaVersion: 1;
  querySchemaVersion: number;
  repoSha: string;
  sourceTree: string;
  dirty: false;
  projects: Array<{
    packageName: string;
    root: string;
    tsconfig: string;
    documentCount: number;
  }>;
  toolchain: {
    node: string;
    platform: string;
    typescript: string;
    scipTypescript: string;
    scip: string;
    protobuf: string;
    betterSqlite3: string;
    vitest: string;
    integrities: Record<string, string>;
  };
  inputs: {
    lockfileSha256: string;
    workspaceSha256: string;
    projectSetSha256: string;
  };
  coverage: NormalizationCoverage;
  files: Record<"index.scip" | "code-index.sqlite" | "tests.json", CodeIndexManifestFile>;
  manifestDigest: string;
}

interface ProcessOutput {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
}

function sha256Bytes(value: Uint8Array | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(file: string): string {
  return sha256Bytes(fs.readFileSync(file));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  const primitive = JSON.stringify(value);
  if (primitive === undefined) throw new Error("canonical JSON does not support undefined");
  return primitive;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function assertCleanExactCheckout(root: string, sha: string): string {
  assertRepoSha(sha);
  const head = git(root, ["rev-parse", "HEAD"]);
  if (head !== sha) throw new Error(`checkout SHA ${head} does not match requested ${sha}`);
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("code index requires a clean checkout");
  }
  return git(root, ["rev-parse", "HEAD^{tree}"]);
}

function packageRoot(packageName: string): string {
  let cursor = path.dirname(fileURLToPath(import.meta.resolve(packageName)));
  for (;;) {
    const manifest = path.join(cursor, "package.json");
    if (fs.existsSync(manifest)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (parsed && typeof parsed === "object" && "name" in parsed && parsed.name === packageName) return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`cannot locate installed ${packageName} package manifest`);
    cursor = parent;
  }
}
function packageVersion(packageName: string): string {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(packageRoot(packageName), "package.json"), "utf8"));
  if (!parsed || typeof parsed !== "object" || !("version" in parsed) || typeof parsed.version !== "string") {
    throw new Error(`installed ${packageName} package manifest has no version`);
  }
  return parsed.version;
}

function lockfileIntegrity(lockfile: string, packageName: string, version: string): string {
  const escaped = `${packageName}@${version}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:'${escaped}'|${escaped}):\\n\\s+resolution: \\{integrity: ([^} ]+)`).exec(lockfile);
  if (!match) throw new Error(`lockfile is missing integrity for ${packageName}@${version}`);
  return match[1];
}

async function captureProcess(executable: string, args: string[], options: { cwd: string; signal?: AbortSignal }): Promise<ProcessOutput> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("code index build aborted");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    const append = (current: string, chunk: Buffer, truncated?: () => void): string => {
      const next = `${current}${chunk.toString("utf8")}`;
      if (next.length > MAX_OUTPUT_CHARS) truncated?.();
      return next.slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, () => { stdoutTruncated = true; }); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const abort = (): void => { child.kill("SIGTERM"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code, processSignal) => {
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? new Error("code index build aborted"));
      } else if (code !== 0) {
        reject(new Error(`${path.basename(executable)} exited ${code ?? processSignal}: ${stderr || stdout}`));
      } else {
        resolve({ stdout, stderr, stdoutTruncated });
      }
    });
  });
}

async function runScipTypescript(root: string, projects: readonly CodeIndexProject[], rawScip: string, signal?: AbortSignal): Promise<void> {
  const executable = requireFromTool.resolve("@sourcegraph/scip-typescript");
  const base = [
    "--max-old-space-size=16000",
    executable,
    "index",
    "--cwd",
    root,
    "--output",
    rawScip,
    "--max-file-byte-size",
    "1mb",
    "--no-progress-bar",
    ...projects.map((project) => project.tsconfig),
  ];
  try {
    await captureProcess(process.execPath, base, { cwd: root, signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/heap out of memory/i.test(message)) throw error;
    fs.rmSync(rawScip, { force: true });
    await captureProcess(process.execPath, [...base.slice(0, -projects.length), "--no-global-caches", ...projects.map((project) => project.tsconfig)], { cwd: root, signal });
  }
  if (!fs.existsSync(rawScip) || fs.statSync(rawScip).size === 0) throw new Error("scip-typescript did not produce index.scip");
}

function finalJsonArray(output: string): unknown {
  const trimmed = output.trimStart();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  const marker = output.lastIndexOf("\n[");
  if (marker < 0) throw new Error("Vitest test inventory has no final JSON array");
  return JSON.parse(output.slice(marker + 1));
}

export function parseVitestInventory(root: string, json: string): TestInventoryEntry[] {
  const parsed = finalJsonArray(json);
  if (!Array.isArray(parsed)) throw new Error("Vitest test inventory must be an array");
  const absoluteRoot = path.resolve(root);
  const rootPrefix = `${absoluteRoot}${path.sep}`;
  const inventoryByPath = new Map<string, {
    projects: Set<string>;
    tests: Map<string, TestInventoryEntry["tests"][number]>;
  }>();
  for (const value of parsed) {
    if (!value || typeof value !== "object"
      || !("file" in value) || typeof value.file !== "string"
      || !("name" in value) || typeof value.name !== "string" || !value.name
      || !("location" in value) || !value.location || typeof value.location !== "object"
      || !("line" in value.location) || typeof value.location.line !== "number"
      || !Number.isSafeInteger(value.location.line) || value.location.line < 1
      || !("column" in value.location) || typeof value.location.column !== "number"
      || !Number.isSafeInteger(value.location.column) || value.location.column < 0) {
      throw new Error("Vitest returned an invalid test inventory entry");
    }
    const absolute = path.resolve(value.file);
    if (!absolute.startsWith(rootPrefix)) throw new Error(`Vitest test file escapes repository: ${value.file}`);
    const relative = path.relative(absoluteRoot, absolute).replaceAll("\\", "/");
    const projectName = "projectName" in value && typeof value.projectName === "string" ? value.projectName : "node";
    const inventory = inventoryByPath.get(relative) ?? {
      projects: new Set<string>(),
      tests: new Map<string, TestInventoryEntry["tests"][number]>(),
    };
    inventory.projects.add(projectName);
    const test = { name: value.name, line: value.location.line, column: value.location.column };
    inventory.tests.set(JSON.stringify([test.name, test.line, test.column]), test);
    inventoryByPath.set(relative, inventory);
  }
  return [...inventoryByPath]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([testPath, inventory]) => ({
      path: testPath,
      projects: [...inventory.projects].sort(),
      tests: [...inventory.tests.values()].sort((left, right) =>
        left.name.localeCompare(right.name) || left.line - right.line || left.column - right.column),
    }));
}
export function selectIndexedTests(
  inventory: readonly TestInventoryEntry[],
  expectedFiles: readonly string[],
): TestInventoryEntry[] {
  const expected = new Set(expectedFiles);
  return inventory.filter((entry) => expected.has(entry.path));
}


async function listVitestTests(root: string, signal?: AbortSignal): Promise<TestInventoryEntry[]> {
  const vitest = path.join(packageRoot("vitest"), "vitest.mjs");
  const result = await captureProcess(process.execPath, [vitest, "list", "--json", "--includeTaskLocation"], { cwd: root, signal });
  if (result.stdoutTruncated) throw new Error(`Vitest test inventory exceeds ${MAX_OUTPUT_CHARS} characters`);
  return parseVitestInventory(root, result.stdout);
}

function fileManifest(file: string): CodeIndexManifestFile {
  return { sha256: sha256File(file), bytes: fs.statSync(file).size };
}

function validateReadonlyArtifact(sqlite: string, repoSha: string, expectedDocuments: number): void {
  const database = new Database(sqlite, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only = ON");
    const meta = database.prepare("SELECT value FROM meta WHERE key = 'repo_sha'").get();
    if (!meta || typeof meta !== "object" || !("value" in meta) || meta.value !== repoSha) {
      throw new Error("normalized code index has incorrect repository SHA");
    }
    const count = database.prepare("SELECT count(*) AS value FROM documents").get();
    if (!count || typeof count !== "object" || !("value" in count) || count.value !== expectedDocuments) {
      throw new Error("normalized code index has incomplete document coverage");
    }
    // Consumers verify these exact bytes by digest and rely on this check.
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`normalized code index failed integrity_check: ${String(integrity)}`);
  } finally {
    database.close();
  }
}

export async function buildCodeIndex(options: BuildCodeIndexOptions): Promise<CodeIndexManifest> {
  const root = path.resolve(options.root);
  const outDir = path.resolve(options.outDir);
  const sourceTree = assertCleanExactCheckout(root, options.sha);
  const projects = discoverCodeIndexProjects(root);
  const expectedFiles = projects.flatMap((project) => project.files);
  const oversize = expectedFiles.filter((file) => fs.statSync(path.join(root, file)).size > 1024 * 1024);
  if (oversize.length > 0) throw new Error(`SCIP 1mb limit would skip ${oversize.length} project files`);

  const installed = {
    scipTypescript: packageVersion("@sourcegraph/scip-typescript"),
    scip: packageVersion("@scip-code/scip"),
    protobuf: packageVersion("@bufbuild/protobuf"),
    betterSqlite3: packageVersion("better-sqlite3"),
    vitest: packageVersion("vitest"),
  };
  if (installed.scipTypescript !== SCIP_TYPESCRIPT_VERSION
    || installed.scip !== SCIP_BINDING_VERSION
    || installed.protobuf !== PROTOBUF_VERSION
    || installed.betterSqlite3 !== BETTER_SQLITE3_VERSION
    || installed.vitest !== VITEST_VERSION) {
    throw new Error(`unexpected code-index toolchain ${JSON.stringify(installed)}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const rawScip = path.join(outDir, "index.raw.scip");
  const indexScip = path.join(outDir, "index.scip");
  const sqlite = path.join(outDir, "code-index.sqlite");
  const testsFile = path.join(outDir, "tests.json");
  const manifestFile = path.join(outDir, "code-index-manifest.json");
  for (const file of [rawScip, indexScip, sqlite, testsFile, manifestFile]) fs.rmSync(file, { force: true });

  await runScipTypescript(root, projects, rawScip, options.signal);
  const tests = selectIndexedTests(await listVitestTests(root, options.signal), expectedFiles);
  const workspacePackages = discoverWorkspacePackages(root);
  const codeFacts = analyzeTypeScript({
    root,
    sourceRoots: [],
    repoSha: options.sha,
    rootNames: expectedFiles,
    skipModuleDiscovery: true,
    modules: [],
    packages: workspacePackages,
    git: new Map(),
  });
  const coverage = decodeAndNormalizeScip({
    root,
    repoSha: options.sha,
    rawScip,
    indexScip,
    sqlite,
    projects,
    tests,
    observatorySymbols: codeFacts.symbols,
    observatoryCalls: codeFacts.calls,
  });
  fs.rmSync(rawScip, { force: true });
  fs.chmodSync(indexScip, 0o600);
  fs.chmodSync(sqlite, 0o600);
  fs.writeFileSync(testsFile, `${canonicalJson({ schemaVersion: TEST_INVENTORY_SCHEMA_VERSION, repoSha: options.sha, tests })}\n`, { mode: 0o600 });
  validateReadonlyArtifact(sqlite, options.sha, coverage.expectedDocuments);

  const finalTree = assertCleanExactCheckout(root, options.sha);
  if (finalTree !== sourceTree) throw new Error("source tree changed during code-index build");
  const lockfile = fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  const projectSet = projects.map((project) => ({
    packageName: project.packageName,
    root: project.root,
    tsconfig: project.tsconfig,
    files: project.files,
    tsconfigSha256: sha256File(path.join(root, project.tsconfig)),
  }));
  const manifestBase = {
    schemaVersion: 1 as const,
    querySchemaVersion: CODE_INDEX_SCHEMA_VERSION,
    repoSha: options.sha,
    sourceTree,
    dirty: false as const,
    projects: projects.map((project) => ({
      packageName: project.packageName,
      root: project.root,
      tsconfig: project.tsconfig,
      documentCount: project.files.length,
    })),
    toolchain: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      typescript: ts.version,
      ...installed,
      integrities: {
        "@sourcegraph/scip-typescript": lockfileIntegrity(lockfile, "@sourcegraph/scip-typescript", SCIP_TYPESCRIPT_VERSION),
        "@scip-code/scip": lockfileIntegrity(lockfile, "@scip-code/scip", SCIP_BINDING_VERSION),
        "@bufbuild/protobuf": lockfileIntegrity(lockfile, "@bufbuild/protobuf", PROTOBUF_VERSION),
        "better-sqlite3": lockfileIntegrity(lockfile, "better-sqlite3", BETTER_SQLITE3_VERSION),
        vitest: lockfileIntegrity(lockfile, "vitest", VITEST_VERSION),
      },
    },
    inputs: {
      lockfileSha256: sha256Bytes(lockfile),
      workspaceSha256: sha256Bytes([
        fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"),
        fs.readFileSync(path.join(root, "package.json"), "utf8"),
      ].join("\n")),
      projectSetSha256: sha256Bytes(canonicalJson(projectSet)),
    },
    coverage,
    files: {
      "index.scip": fileManifest(indexScip),
      "code-index.sqlite": fileManifest(sqlite),
      "tests.json": fileManifest(testsFile),
    },
  };
  const manifest: CodeIndexManifest = { ...manifestBase, manifestDigest: sha256Bytes(canonicalJson(manifestBase)) };
  fs.writeFileSync(manifestFile, `${canonicalJson(manifest)}\n`, { mode: 0o600 });
  return manifest;
}
