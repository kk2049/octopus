import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const ARTIFACT_FILES = ["index.scip", "code-index.sqlite", "tests.json"] as const;
const REQUIRED_TABLES = [
  "calls",
  "documents",
  "meta",
  "occurrences",
  "projects",
  "relationships",
  "symbol_search",
  "symbols",
  "test_references",
] as const;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TEST_INVENTORY_SCHEMA_VERSION = 2;

export interface ArtifactSelector {
  kind: "file" | "symbol" | "test" | "config" | "schema";
  path: string;
  qualifiedName?: string;
  testName?: string;
  lastVerifiedSha: string;
}

export interface ResolvedArtifact {
  kind: "file" | "symbol" | "test" | "config" | "schema";
  path: string;
  line: number;
  qualifiedName?: string;
  testName?: string;
}

export interface CodeLocation {
  path: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

export interface CodeSymbol {
  id: string;
  scipSymbol: string;
  displayName: string;
  qualifiedName: string;
  kind: number;
  signature: string | null;
  definition: CodeLocation;
}

export interface CodeOccurrence extends CodeLocation {
  scipSymbol: string;
  roles: number;
  isDefinition: boolean;
  symbol?: CodeSymbol;
}

export interface CodeCall {
  from: CodeSymbol;
  to: CodeSymbol;
  location: CodeLocation;
  count: number;
}

export interface StaticTestReference {
  path: string;
  line: number;
  projects: readonly string[];
  relation: "static_reference";
  target: CodeSymbol;
}

export interface CodeSymbolSelector {
  path?: string;
  qualifiedName: string;
}

export type CodeResult<T> =
  | { status: "ok"; repoSha: string; items: readonly T[] }
  | { status: "stale_code_index"; requestedSha: string; indexedSha: string; items: readonly [] };

interface CodeIndexManifestFile {
  sha256: string;
  bytes: number;
}

interface CodeIndexManifest {
  schemaVersion: number;
  querySchemaVersion: number;
  repoSha: string;
  dirty: false;
  coverage: {
    expectedDocuments: number;
    indexedDocuments: number;
    duplicates: number;
    skipped: number;
    errors: number;
    tests: number;
    testReferences: number;
  };
  files: Record<(typeof ARTIFACT_FILES)[number], CodeIndexManifestFile>;
  manifestDigest: string;
  [key: string]: unknown;
}

interface SymbolRow {
  id: string;
  scip_symbol: string;
  display_name: string;
  qualified_name: string;
  kind: number;
  signature: string | null;
  path: string;
  definition_start_line: number;
  definition_start_character: number;
  definition_end_line: number;
  definition_end_character: number;
}

interface OccurrenceRow {
  path: string;
  scip_symbol: string;
  start_line: number;
  start_character: number;
  end_line: number;
  end_character: number;
  roles: number;
  is_definition: number;
  id: string | null;
  display_name: string | null;
  qualified_name: string | null;
  kind: number | null;
  signature: string | null;
  definition_path: string | null;
  definition_start_line: number | null;
  definition_start_character: number | null;
  definition_end_line: number | null;
  definition_end_character: number | null;
}

interface CallRow {
  from_id: string;
  from_scip: string;
  from_display: string;
  from_qualified: string;
  from_kind: number;
  from_signature: string | null;
  from_path: string;
  from_line: number;
  from_character: number;
  from_end_line: number;
  from_end_character: number;
  to_id: string;
  to_scip: string;
  to_display: string;
  to_qualified: string;
  to_kind: number;
  to_signature: string | null;
  to_path: string;
  to_line: number;
  to_character: number;
  to_end_line: number;
  to_end_character: number;
  call_path: string;
  call_line: number;
  count: number;
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

function sha256(value: Uint8Array | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isManifestFile(value: unknown): value is CodeIndexManifestFile {
  return Boolean(value && typeof value === "object"
    && "sha256" in value && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256)
    && "bytes" in value && typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes >= 0);
}

function parseManifest(file: string): CodeIndexManifest {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object"
    || !("schemaVersion" in parsed) || parsed.schemaVersion !== 1
    || !("querySchemaVersion" in parsed) || parsed.querySchemaVersion !== 1
    || !("repoSha" in parsed) || typeof parsed.repoSha !== "string" || !SHA_PATTERN.test(parsed.repoSha)
    || !("dirty" in parsed) || parsed.dirty !== false
    || !("manifestDigest" in parsed) || typeof parsed.manifestDigest !== "string" || !/^[0-9a-f]{64}$/.test(parsed.manifestDigest)
    || !("coverage" in parsed) || !parsed.coverage || typeof parsed.coverage !== "object"
    || !("files" in parsed) || !parsed.files || typeof parsed.files !== "object") {
    throw new Error("invalid code-index-manifest.json");
  }
  const files = parsed.files as Record<string, unknown>;
  const coverage = parsed.coverage as Record<string, unknown>;
  for (const name of ARTIFACT_FILES) {
    if (!(name in files) || !isManifestFile(files[name])) throw new Error(`manifest is missing ${name}`);
  }
  const requiredCoverage = ["expectedDocuments", "indexedDocuments", "duplicates", "skipped", "errors", "tests", "testReferences"] as const;
  for (const name of requiredCoverage) {
    if (!(name in coverage) || typeof coverage[name] !== "number" || !Number.isSafeInteger(coverage[name])) {
      throw new Error(`manifest has invalid coverage.${name}`);
    }
  }
  if (coverage.expectedDocuments !== coverage.indexedDocuments
    || coverage.duplicates !== 0 || coverage.skipped !== 0 || coverage.errors !== 0) {
    throw new Error("incomplete code index is not queryable");
  }
  const manifest = parsed as CodeIndexManifest;
  const { manifestDigest, ...unsigned } = manifest;
  if (sha256(canonicalJson(unsigned)) !== manifestDigest) throw new Error("code-index manifest digest mismatch");
  return manifest;
}

function safeArtifactFile(directory: string, name: (typeof ARTIFACT_FILES)[number]): string {
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`code-index artifact ${name} is not a regular file`);
  const realDirectory = fs.realpathSync(directory);
  const realFile = fs.realpathSync(file);
  if (!realFile.startsWith(`${realDirectory}${path.sep}`)) throw new Error(`code-index artifact ${name} escapes its directory`);
  return file;
}
interface TestInventoryLocation {
  line: number;
  column: number;
}

function validateTestInventory(bytes: Uint8Array, repoSha: string, expectedCount: number): Map<string, ReadonlyMap<string, TestInventoryLocation>> {
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || !("schemaVersion" in parsed) || parsed.schemaVersion !== TEST_INVENTORY_SCHEMA_VERSION
    || !("repoSha" in parsed) || parsed.repoSha !== repoSha
    || !("tests" in parsed) || !Array.isArray(parsed.tests) || parsed.tests.length !== expectedCount) {
    throw new Error("invalid tests.json inventory");
  }
  const inventory = new Map<string, ReadonlyMap<string, TestInventoryLocation>>();
  for (const test of parsed.tests) {
    if (!test || typeof test !== "object" || !("path" in test) || typeof test.path !== "string"
      || !("projects" in test) || !Array.isArray(test.projects) || !test.projects.every((project: unknown) => typeof project === "string")
      || !("tests" in test) || !Array.isArray(test.tests) || test.tests.length === 0) {
      throw new Error("invalid tests.json entry");
    }
    const testPath = normalizePath(test.path);
    if (inventory.has(testPath)) throw new Error(`duplicate tests.json path ${testPath}`);
    const cases = new Map<string, TestInventoryLocation>();
    for (const testCase of test.tests) {
      if (!testCase || typeof testCase !== "object"
        || !("name" in testCase) || typeof testCase.name !== "string" || !testCase.name
        || !("line" in testCase) || typeof testCase.line !== "number" || !Number.isSafeInteger(testCase.line) || testCase.line < 1
        || !("column" in testCase) || typeof testCase.column !== "number" || !Number.isSafeInteger(testCase.column) || testCase.column < 0) {
        throw new Error("invalid tests.json test case");
      }
      const previous = cases.get(testCase.name);
      if (!previous || testCase.line < previous.line || (testCase.line === previous.line && testCase.column < previous.column)) {
        cases.set(testCase.name, { line: testCase.line, column: testCase.column });
      }
    }
    inventory.set(testPath, cases);
  }
  return inventory;
}


function normalizePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  if (!normalized || path.isAbsolute(value) || normalized.split("/").includes("..")) throw new Error(`invalid code-index path ${value}`);
  return normalized;
}

function clampLimit(value: number | undefined, fallback: number, maximum = 500): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("code-index limit must be a positive integer");
  return Math.min(value, maximum);
}

function symbolFromRow(row: SymbolRow): CodeSymbol {
  return {
    id: row.id,
    scipSymbol: row.scip_symbol,
    displayName: row.display_name,
    qualifiedName: row.qualified_name,
    kind: row.kind,
    signature: row.signature,
    definition: {
      path: row.path,
      line: row.definition_start_line + 1,
      character: row.definition_start_character + 1,
      endLine: row.definition_end_line + 1,
      endCharacter: row.definition_end_character + 1,
    },
  };
}

const SYMBOL_SELECT = `SELECT
  s.id, s.scip_symbol, s.display_name, s.qualified_name, s.kind, s.signature,
  d.path, s.definition_start_line, s.definition_start_character,
  s.definition_end_line, s.definition_end_character
FROM symbols s
JOIN documents d ON d.id = s.definition_document_id`;

export interface CodeIndexResolver {
  readonly gitSha: string;
  readonly manifestDigest: string;
  resolveArtifact(selector: ArtifactSelector): ResolvedArtifact | null;
  resolvePosition(request: { repoSha: string; path: string; line: number; character: number }): CodeResult<CodeOccurrence>;
  searchSymbols(request: { repoSha: string; query: string; limit?: number }): CodeResult<CodeSymbol>;
  definitions(request: { repoSha: string; symbol: CodeSymbolSelector; limit?: number }): CodeResult<CodeSymbol>;
  references(request: { repoSha: string; symbol: CodeSymbolSelector; limit?: number }): CodeResult<CodeOccurrence>;
  implementations(request: { repoSha: string; symbol: CodeSymbolSelector; limit?: number }): CodeResult<CodeSymbol>;
  testsForSymbol(request: { repoSha: string; symbol: CodeSymbolSelector; limit?: number }): CodeResult<StaticTestReference>;
  calls(request: { repoSha: string; symbol: CodeSymbolSelector; direction?: "incoming" | "outgoing" | "both"; limit?: number }): CodeResult<CodeCall>;
}

export interface OpenCodeIndexOptions {
  /**
   * Digests the caller has already streamed and verified, by file name in this
   * directory. A file whose manifest digest matches is not read again here, and
   * a matching SQLite file skips integrity_check: the producer ran it before
   * publishing exactly these bytes. Re-reading ~600 MB synchronously froze the
   * Head's event loop for minutes on every knowledge activation.
   */
  verifiedDigests?: ReadonlyMap<string, string>;
}

export class SqliteCodeIndexResolver implements CodeIndexResolver {
  readonly gitSha: string;
  readonly manifestDigest: string;
  readonly #database: Database.Database;
  readonly #testInventory: ReadonlyMap<string, ReadonlyMap<string, TestInventoryLocation>>;

  constructor(artifactDirectory: string, options: OpenCodeIndexOptions = {}) {
    const directory = path.resolve(artifactDirectory);
    const manifestPath = path.join(directory, "code-index-manifest.json");
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("code-index manifest is not a regular file");
    const manifest = parseManifest(manifestPath);
    let testsBytes: Buffer | undefined;
    const verified = (name: (typeof ARTIFACT_FILES)[number]) => options.verifiedDigests?.get(name) === manifest.files[name].sha256;
    for (const name of ARTIFACT_FILES) {
      const file = safeArtifactFile(directory, name);
      const expected = manifest.files[name];
      if (name !== "tests.json" && verified(name)) {
        if (fs.statSync(file).size !== expected.bytes) throw new Error(`code-index artifact digest mismatch: ${name}`);
        continue;
      }
      const bytes = fs.readFileSync(file);
      if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error(`code-index artifact digest mismatch: ${name}`);
      if (name === "tests.json") testsBytes = bytes;
    }
    if (!testsBytes) throw new Error("code-index tests.json is missing");
    const testInventory = validateTestInventory(testsBytes, manifest.repoSha, manifest.coverage.tests);

    this.#database = new Database(path.join(directory, "code-index.sqlite"), { readonly: true, fileMustExist: true });
    try {
      this.#database.pragma("query_only = ON");
      const tableRows = this.#database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>;
      const tables = new Set(tableRows.map((row) => row.name));
      for (const table of REQUIRED_TABLES) if (!tables.has(table)) throw new Error(`code index is missing ${table}`);
      const metaRows = this.#database.prepare("SELECT key, value FROM meta WHERE key IN ('schema_version', 'repo_sha')").all() as Array<{ key: string; value: string }>;
      const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
      if (meta.schema_version !== String(manifest.querySchemaVersion) || meta.repo_sha !== manifest.repoSha) {
        throw new Error("code-index SQLite identity does not match manifest");
      }
      if (!verified("code-index.sqlite")) {
        const integrity = this.#database.pragma("integrity_check", { simple: true });
        if (integrity !== "ok") throw new Error(`code-index SQLite integrity check failed: ${String(integrity)}`);
      }
      const coverageRow = this.#database.prepare(`SELECT
        (SELECT count(*) FROM documents) AS documents,
        (SELECT count(*) FROM documents WHERE is_test = 1) AS tests,
        (SELECT count(*) FROM test_references) AS test_references`).get() as {
          documents: number;
          tests: number;
          test_references: number;
        };
      const indexedTestPaths = (this.#database.prepare("SELECT path FROM documents WHERE is_test = 1 ORDER BY path").all() as Array<{ path: string }>).map((row) => row.path);
      if (indexedTestPaths.length !== testInventory.size || indexedTestPaths.some((testPath) => !testInventory.has(testPath))) {
        throw new Error("code-index test inventory does not match SQLite");
      }
      if (coverageRow.documents !== manifest.coverage.indexedDocuments
        || coverageRow.tests !== manifest.coverage.tests
        || coverageRow.test_references !== manifest.coverage.testReferences) {
        throw new Error("code-index SQLite coverage does not match manifest");
      }
    } catch (error) {
      this.#database.close();
      throw error;
    }
    this.gitSha = manifest.repoSha;
    this.manifestDigest = manifest.manifestDigest;
    this.#testInventory = testInventory;
  }

  close(): void {
    this.#database.close();
  }

  #stale<T>(repoSha: string): CodeResult<T> | null {
    return repoSha === this.gitSha
      ? null
      : { status: "stale_code_index", requestedSha: repoSha, indexedSha: this.gitSha, items: [] };
  }

  #symbols(selector: CodeSymbolSelector, limit = 100): SymbolRow[] {
    const qualifiedName = selector.qualifiedName.trim();
    if (!qualifiedName) throw new Error("qualifiedName must not be empty");
    if (selector.path) {
      return this.#database.prepare(`${SYMBOL_SELECT} WHERE s.qualified_name = ? AND d.path = ? ORDER BY s.id LIMIT ?`)
        .all(qualifiedName, normalizePath(selector.path), limit) as SymbolRow[];
    }
    return this.#database.prepare(`${SYMBOL_SELECT} WHERE s.qualified_name = ? ORDER BY d.path, s.id LIMIT ?`)
      .all(qualifiedName, limit) as SymbolRow[];
  }

  resolveArtifact(selector: ArtifactSelector): ResolvedArtifact | null {
    if (selector.lastVerifiedSha !== this.gitSha || !SHA_PATTERN.test(selector.lastVerifiedSha)) return null;
    const artifactPath = normalizePath(selector.path);
    if (selector.kind === "test") {
      if (typeof selector.testName !== "string" || !selector.testName.trim()) return null;
      const inventory = this.#testInventory.get(artifactPath);
      const exact = inventory?.get(selector.testName);
      const suffixMatches = exact
        ? []
        : [...(inventory?.entries() ?? [])].filter(([name]) => name.endsWith(` > ${selector.testName}`));
      const match = exact ? [selector.testName, exact] as const : suffixMatches.length === 1 ? suffixMatches[0] : null;
      if (!match) return null;
      const row = this.#database.prepare("SELECT path FROM documents WHERE path = ? AND is_test = 1").get(artifactPath) as { path: string } | undefined;
      return row ? { kind: "test", path: row.path, line: match[1].line, testName: match[0] } : null;
    }
    if (selector.kind === "file") {
      const row = this.#database.prepare("SELECT path FROM documents WHERE path = ?").get(artifactPath) as { path: string } | undefined;
      return row ? { kind: "file", path: row.path, line: 1 } : null;
    }
    if (selector.kind !== "symbol") return null;
    if (!selector.qualifiedName) return null;
    const row = this.#symbols({ path: artifactPath, qualifiedName: selector.qualifiedName }, 2);
    if (row.length !== 1) return null;
    return { kind: "symbol", path: row[0].path, line: row[0].definition_start_line + 1, qualifiedName: row[0].qualified_name };
  }

  resolvePosition(request: { repoSha: string; path: string; line: number; character: number }): CodeResult<CodeOccurrence> {
    const stale = this.#stale<CodeOccurrence>(request.repoSha);
    if (stale) return stale;
    if (!Number.isSafeInteger(request.line) || !Number.isSafeInteger(request.character) || request.line < 1 || request.character < 1) {
      throw new Error("code-index positions are 1-based positive integers");
    }
    const rows = this.#database.prepare(`SELECT
      d.path, o.scip_symbol, o.start_line, o.start_character, o.end_line, o.end_character, o.roles, o.is_definition,
      s.id, s.display_name, s.qualified_name, s.kind, s.signature,
      dd.path AS definition_path, s.definition_start_line, s.definition_start_character,
      s.definition_end_line, s.definition_end_character
    FROM documents d
    JOIN occurrences o ON o.document_id = d.id
    LEFT JOIN symbols s ON s.scip_symbol = o.scip_symbol
    LEFT JOIN documents dd ON dd.id = s.definition_document_id
    WHERE d.path = ?
      AND (o.start_line < ? OR (o.start_line = ? AND o.start_character <= ?))
      AND (o.end_line > ? OR (o.end_line = ? AND o.end_character > ?))
    ORDER BY o.is_definition DESC, (o.end_line - o.start_line), (o.end_character - o.start_character), o.scip_symbol
    LIMIT 20`).all(
      normalizePath(request.path),
      request.line - 1,
      request.line - 1,
      request.character - 1,
      request.line - 1,
      request.line - 1,
      request.character - 1,
    ) as OccurrenceRow[];
    return { status: "ok", repoSha: this.gitSha, items: rows.map((row) => this.#occurrence(row)) };
  }

  searchSymbols(request: { repoSha: string; query: string; limit?: number }): CodeResult<CodeSymbol> {
    const stale = this.#stale<CodeSymbol>(request.repoSha);
    if (stale) return stale;
    const tokens = request.query.match(/[\p{L}\p{N}_$.-]+/gu) ?? [];
    if (tokens.length === 0) return { status: "ok", repoSha: this.gitSha, items: [] };
    const expression = tokens.slice(0, 12).map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
    const rows = this.#database.prepare(`${SYMBOL_SELECT}
      JOIN symbol_search ON symbol_search.symbol_id = s.id
      WHERE symbol_search MATCH ?
      ORDER BY bm25(symbol_search), s.id LIMIT ?`)
      .all(expression, clampLimit(request.limit, 50)) as SymbolRow[];
    return { status: "ok", repoSha: this.gitSha, items: rows.map(symbolFromRow) };
  }

  definitions(request: { repoSha: string; symbol: CodeSymbolSelector; limit?: number }): CodeResult<CodeSymbol> {
    const stale = this.#stale<CodeSymbol>(request.repoSha);
    if (stale) return stale;
    const rows = this.#symbols(request.symbol, clampLimit(request.limit, 100));
    return { status: "ok", repoSha: this.gitSha, items: rows.map(symbolFromRow) };
  }

  references(request: { repoSha: string; symbol: CodeSymbolSelector; limit?: number }): CodeResult<CodeOccurrence> {
    const stale = this.#stale<CodeOccurrence>(request.repoSha);
    if (stale) return stale;
    const selected = this.#symbols(request.symbol);
    if (selected.length === 0) return { status: "ok", repoSha: this.gitSha, items: [] };
    const related = this.#relatedScipSymbols(selected.map((symbol) => symbol.scip_symbol), "is_reference");
    const placeholders = related.map(() => "?").join(",");
    const rows = this.#database.prepare(`SELECT
      d.path, o.scip_symbol, o.start_line, o.start_character, o.end_line, o.end_character, o.roles, o.is_definition,
      s.id, s.display_name, s.qualified_name, s.kind, s.signature,
      dd.path AS definition_path, s.definition_start_line, s.definition_start_character,
      s.definition_end_line, s.definition_end_character
    FROM occurrences o
    JOIN documents d ON d.id = o.document_id
    LEFT JOIN symbols s ON s.scip_symbol = o.scip_symbol
    LEFT JOIN documents dd ON dd.id = s.definition_document_id
    WHERE o.scip_symbol IN (${placeholders}) AND o.is_definition = 0
    ORDER BY d.path, o.start_line, o.start_character, o.scip_symbol LIMIT ?`)
      .all(...related, clampLimit(request.limit, 200)) as OccurrenceRow[];
    return { status: "ok", repoSha: this.gitSha, items: rows.map((row) => this.#occurrence(row)) };
  }

  implementations(request: { repoSha: string; symbol: CodeSymbolSelector; limit?: number }): CodeResult<CodeSymbol> {
    const stale = this.#stale<CodeSymbol>(request.repoSha);
    if (stale) return stale;
    const selected = this.#symbols(request.symbol);
    if (selected.length === 0) return { status: "ok", repoSha: this.gitSha, items: [] };
    const scip = selected.map((symbol) => symbol.scip_symbol);
    const placeholders = scip.map(() => "?").join(",");
    const rows = this.#database.prepare(`${SYMBOL_SELECT}
      JOIN relationships r ON r.from_symbol = s.scip_symbol
      WHERE r.to_symbol IN (${placeholders}) AND r.is_implementation = 1
      ORDER BY d.path, s.id LIMIT ?`)
      .all(...scip, clampLimit(request.limit, 100)) as SymbolRow[];
    return { status: "ok", repoSha: this.gitSha, items: rows.map(symbolFromRow) };
  }

  testsForSymbol(request: { repoSha: string; symbol: CodeSymbolSelector; limit?: number }): CodeResult<StaticTestReference> {
    const stale = this.#stale<StaticTestReference>(request.repoSha);
    if (stale) return stale;
    const selected = this.#symbols(request.symbol);
    if (selected.length === 0) return { status: "ok", repoSha: this.gitSha, items: [] };
    const ids = selected.map((symbol) => symbol.id);
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.#database.prepare(`SELECT
      d.path, d.vitest_project, tr.line, tr.relation,
      s.id, s.scip_symbol, s.display_name, s.qualified_name, s.kind, s.signature,
      dd.path AS definition_path, s.definition_start_line, s.definition_start_character,
      s.definition_end_line, s.definition_end_character
    FROM test_references tr
    JOIN documents d ON d.id = tr.test_document_id
    JOIN symbols s ON s.id = tr.target_symbol_id
    JOIN documents dd ON dd.id = s.definition_document_id
    WHERE tr.target_symbol_id IN (${placeholders})
    ORDER BY d.path, tr.line, s.id LIMIT ?`)
      .all(...ids, clampLimit(request.limit, 100)) as Array<{
        path: string; vitest_project: string | null; line: number; relation: "static_reference";
        id: string; scip_symbol: string; display_name: string; qualified_name: string; kind: number; signature: string | null;
        definition_path: string; definition_start_line: number; definition_start_character: number;
        definition_end_line: number; definition_end_character: number;
      }>;
    return {
      status: "ok",
      repoSha: this.gitSha,
      items: rows.map((row) => ({
        path: row.path,
        line: row.line + 1,
        projects: row.vitest_project ? row.vitest_project.split(",") : [],
        relation: row.relation,
        target: symbolFromRow({ ...row, path: row.definition_path }),
      })),
    };
  }

  calls(request: { repoSha: string; symbol: CodeSymbolSelector; direction?: "incoming" | "outgoing" | "both"; limit?: number }): CodeResult<CodeCall> {
    const stale = this.#stale<CodeCall>(request.repoSha);
    if (stale) return stale;
    const selected = this.#symbols(request.symbol);
    if (selected.length === 0) return { status: "ok", repoSha: this.gitSha, items: [] };
    const ids = selected.map((symbol) => symbol.id);
    const placeholders = ids.map(() => "?").join(",");
    const direction = request.direction ?? "both";
    const predicate = direction === "incoming"
      ? `c.to_symbol_id IN (${placeholders})`
      : direction === "outgoing"
        ? `c.from_symbol_id IN (${placeholders})`
        : `(c.from_symbol_id IN (${placeholders}) OR c.to_symbol_id IN (${placeholders}))`;
    const parameters = direction === "both" ? [...ids, ...ids] : ids;
    const rows = this.#database.prepare(`SELECT
      f.id AS from_id, f.scip_symbol AS from_scip, f.display_name AS from_display,
      f.qualified_name AS from_qualified, f.kind AS from_kind, f.signature AS from_signature,
      fd.path AS from_path, f.definition_start_line AS from_line, f.definition_start_character AS from_character,
      f.definition_end_line AS from_end_line, f.definition_end_character AS from_end_character,
      t.id AS to_id, t.scip_symbol AS to_scip, t.display_name AS to_display,
      t.qualified_name AS to_qualified, t.kind AS to_kind, t.signature AS to_signature,
      td.path AS to_path, t.definition_start_line AS to_line, t.definition_start_character AS to_character,
      t.definition_end_line AS to_end_line, t.definition_end_character AS to_end_character,
      cd.path AS call_path, c.line AS call_line, c.count
    FROM calls c
    JOIN symbols f ON f.id = c.from_symbol_id
    JOIN documents fd ON fd.id = f.definition_document_id
    JOIN symbols t ON t.id = c.to_symbol_id
    JOIN documents td ON td.id = t.definition_document_id
    JOIN documents cd ON cd.id = c.document_id
    WHERE ${predicate}
    ORDER BY cd.path, c.line, f.id, t.id LIMIT ?`)
      .all(...parameters, clampLimit(request.limit, 100)) as CallRow[];
    return { status: "ok", repoSha: this.gitSha, items: rows.map((row) => this.#call(row)) };
  }

  #relatedScipSymbols(symbols: string[], flag: "is_reference"): string[] {
    const output = new Set(symbols);
    const placeholders = symbols.map(() => "?").join(",");
    const rows = this.#database.prepare(`SELECT from_symbol, to_symbol FROM relationships
      WHERE ${flag} = 1 AND (from_symbol IN (${placeholders}) OR to_symbol IN (${placeholders}))`)
      .all(...symbols, ...symbols) as Array<{ from_symbol: string; to_symbol: string }>;
    for (const row of rows) {
      output.add(row.from_symbol);
      output.add(row.to_symbol);
    }
    return [...output].sort();
  }

  #occurrence(row: OccurrenceRow): CodeOccurrence {
    const occurrence: CodeOccurrence = {
      path: row.path,
      line: row.start_line + 1,
      character: row.start_character + 1,
      endLine: row.end_line + 1,
      endCharacter: row.end_character + 1,
      scipSymbol: row.scip_symbol,
      roles: row.roles,
      isDefinition: row.is_definition === 1,
    };
    if (row.id && row.display_name && row.qualified_name && row.kind !== null && row.definition_path
      && row.definition_start_line !== null && row.definition_start_character !== null
      && row.definition_end_line !== null && row.definition_end_character !== null) {
      occurrence.symbol = symbolFromRow({
        id: row.id,
        scip_symbol: row.scip_symbol,
        display_name: row.display_name,
        qualified_name: row.qualified_name,
        kind: row.kind,
        signature: row.signature,
        path: row.definition_path,
        definition_start_line: row.definition_start_line,
        definition_start_character: row.definition_start_character,
        definition_end_line: row.definition_end_line,
        definition_end_character: row.definition_end_character,
      });
    }
    return occurrence;
  }

  #call(row: CallRow): CodeCall {
    return {
      from: symbolFromRow({
        id: row.from_id, scip_symbol: row.from_scip, display_name: row.from_display,
        qualified_name: row.from_qualified, kind: row.from_kind, signature: row.from_signature,
        path: row.from_path, definition_start_line: row.from_line, definition_start_character: row.from_character,
        definition_end_line: row.from_end_line, definition_end_character: row.from_end_character,
      }),
      to: symbolFromRow({
        id: row.to_id, scip_symbol: row.to_scip, display_name: row.to_display,
        qualified_name: row.to_qualified, kind: row.to_kind, signature: row.to_signature,
        path: row.to_path, definition_start_line: row.to_line, definition_start_character: row.to_character,
        definition_end_line: row.to_end_line, definition_end_character: row.to_end_character,
      }),
      location: {
        path: row.call_path,
        line: row.call_line + 1,
        character: 1,
        endLine: row.call_line + 1,
        endCharacter: 1,
      },
      count: row.count,
    };
  }
}

export function openCodeIndex(artifactDirectory: string, options: OpenCodeIndexOptions = {}): SqliteCodeIndexResolver {
  return new SqliteCodeIndexResolver(artifactDirectory, options);
}
