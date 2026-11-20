import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openCodeIndex } from "./code-index.js";

const SHA = "b".repeat(40);
const ACTION_ID = `scip:${SHA}:src%2Factions.ts#append_session`;
const HANDLER_ID = `scip:${SHA}:src%2Fhandler.ts#handleAppend`;
const ACTION_SCIP = "scip-typescript npm fixture 1.0.0 src/actions.ts/append_session().";
const HANDLER_SCIP = "scip-typescript npm fixture 1.0.0 src/handler.ts/handleAppend().";
const TEST_NAME = "actions > preserves provider-neutral append";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function sha256(value: Uint8Array | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
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
function createFixtureDatabase(file: string): Database.Database {
  const database = new Database(file);
  database.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects(id INTEGER PRIMARY KEY, package_name TEXT, project_root TEXT, tsconfig_path TEXT, status TEXT, document_count INTEGER);
    CREATE TABLE documents(id INTEGER PRIMARY KEY, path TEXT UNIQUE, project_id INTEGER, language TEXT, is_test INTEGER, vitest_project TEXT);
    CREATE TABLE symbols(
      id TEXT PRIMARY KEY, scip_symbol TEXT UNIQUE, display_name TEXT, qualified_name TEXT, kind INTEGER, signature TEXT,
      definition_document_id INTEGER, definition_start_line INTEGER, definition_start_character INTEGER,
      definition_end_line INTEGER, definition_end_character INTEGER
    );
    CREATE TABLE occurrences(
      document_id INTEGER, scip_symbol TEXT, start_line INTEGER, start_character INTEGER,
      end_line INTEGER, end_character INTEGER, roles INTEGER, is_definition INTEGER
    );
    CREATE TABLE relationships(
      from_symbol TEXT, to_symbol TEXT, is_reference INTEGER, is_implementation INTEGER,
      is_type_definition INTEGER, is_definition INTEGER
    );
    CREATE TABLE calls(from_symbol_id TEXT, to_symbol_id TEXT, document_id INTEGER, line INTEGER, count INTEGER);
    CREATE TABLE test_references(test_document_id INTEGER, target_symbol_id TEXT, line INTEGER, relation TEXT);
    CREATE VIRTUAL TABLE symbol_search USING fts5(symbol_id UNINDEXED, qualified_name, display_name, path);
  `);
  return database;
}


function writeManifest(directory: string, coverage = {
  expectedDocuments: 3,
  indexedDocuments: 3,
  duplicates: 0,
  skipped: 0,
  errors: 0,
  tests: 1,
  testReferences: 1,
}): void {
  const files = Object.fromEntries(["index.scip", "code-index.sqlite", "tests.json"].map((name) => {
    const bytes = fs.readFileSync(path.join(directory, name));
    return [name, { sha256: sha256(bytes), bytes: bytes.byteLength }];
  }));
  const base = { schemaVersion: 1, querySchemaVersion: 1, repoSha: SHA, dirty: false, coverage, files };
  fs.writeFileSync(path.join(directory, "code-index-manifest.json"), `${canonicalJson({ ...base, manifestDigest: sha256(canonicalJson(base)) })}\n`);
}

function fixture(testNames: readonly string[] = [TEST_NAME]): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "octopus-code-query-"));
  temporaryDirectories.push(directory);
  fs.writeFileSync(path.join(directory, "index.scip"), "normalized-scip-fixture");
  fs.writeFileSync(path.join(directory, "tests.json"), `${canonicalJson({
    schemaVersion: 2,
    repoSha: SHA,
    tests: [{
      path: "src/actions.test.ts",
      projects: ["node"],
      tests: testNames.map((name, index) => ({ name, line: 9 + index, column: 4 })),
    }],
  })}\n`);
  const database = createFixtureDatabase(path.join(directory, "code-index.sqlite"));
  database.transaction(() => {
    database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("schema_version", "1");
    database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("repo_sha", SHA);
    database.prepare("INSERT INTO projects(id, package_name, project_root, tsconfig_path, status, document_count) VALUES (1, '@fixture/api', '.', 'tsconfig.json', 'complete', 3)").run();
    database.prepare("INSERT INTO documents(id, path, project_id, language, is_test, vitest_project) VALUES (1, 'src/actions.ts', 1, 'typescript', 0, NULL)").run();
    database.prepare("INSERT INTO documents(id, path, project_id, language, is_test, vitest_project) VALUES (2, 'src/handler.ts', 1, 'typescript', 0, NULL)").run();
    database.prepare("INSERT INTO documents(id, path, project_id, language, is_test, vitest_project) VALUES (3, 'src/actions.test.ts', 1, 'typescript', 1, 'node')").run();
    const insertSymbol = database.prepare(`INSERT INTO symbols(
      id, scip_symbol, display_name, qualified_name, kind, signature,
      definition_document_id, definition_start_line, definition_start_character, definition_end_line, definition_end_character
    ) VALUES (?, ?, ?, ?, 17, ?, ?, ?, ?, ?, ?)`);
    insertSymbol.run(ACTION_ID, ACTION_SCIP, "append_session", "append_session", "append_session(input)", 1, 4, 16, 4, 30);
    insertSymbol.run(HANDLER_ID, HANDLER_SCIP, "handleAppend", "handleAppend", "handleAppend()", 2, 2, 9, 2, 21);
    database.prepare("INSERT INTO occurrences VALUES (1, ?, 4, 16, 4, 30, 1, 1)").run(ACTION_SCIP);
    database.prepare("INSERT INTO occurrences VALUES (2, ?, 3, 2, 3, 16, 8, 0)").run(ACTION_SCIP);
    database.prepare("INSERT INTO occurrences VALUES (3, ?, 8, 4, 8, 18, 40, 0)").run(ACTION_SCIP);
    database.prepare("INSERT INTO relationships VALUES (?, ?, 1, 1, 0, 0)").run(HANDLER_SCIP, ACTION_SCIP);
    database.prepare("INSERT INTO calls VALUES (?, ?, 2, 3, 1)").run(HANDLER_ID, ACTION_ID);
    database.prepare("INSERT INTO test_references VALUES (3, ?, 8, 'static_reference')").run(ACTION_ID);
    database.prepare("INSERT INTO symbol_search VALUES (?, 'append_session', 'append_session', 'src/actions.ts')").run(ACTION_ID);
    database.prepare("INSERT INTO symbol_search VALUES (?, 'handleAppend', 'handleAppend', 'src/handler.ts')").run(HANDLER_ID);
  })();
  database.exec("ANALYZE; VACUUM;");
  database.close();
  writeManifest(directory);
  return directory;
}

describe("read-only code-index resolver", () => {
  it("resolves provider-neutral actions, definitions, references, calls, implementations, and static tests at the matching SHA", () => {
    const directory = fixture();
    fs.chmodSync(path.join(directory, "code-index.sqlite"), 0o444);
    const resolver = openCodeIndex(directory);
    try {
      const search = resolver.searchSymbols({ repoSha: SHA, query: "append_session" });
      const definitions = resolver.definitions({ repoSha: SHA, symbol: { path: "src/actions.ts", qualifiedName: "append_session" } });
      const references = resolver.references({ repoSha: SHA, symbol: { qualifiedName: "append_session" } });
      const implementations = resolver.implementations({ repoSha: SHA, symbol: { qualifiedName: "append_session" } });
      const calls = resolver.calls({ repoSha: SHA, symbol: { qualifiedName: "handleAppend" }, direction: "outgoing" });
      const tests = resolver.testsForSymbol({ repoSha: SHA, symbol: { qualifiedName: "append_session" } });

      expect(search.status === "ok" ? search.items.map((symbol) => symbol.qualifiedName) : []).toEqual(["append_session"]);
      expect(definitions.status === "ok" ? definitions.items[0]?.definition.path : null).toBe("src/actions.ts");
      expect(references.status === "ok" ? references.items.map((reference) => reference.path) : []).toEqual(["src/actions.test.ts", "src/handler.ts"]);
      expect(implementations.status === "ok" ? implementations.items.map((symbol) => symbol.qualifiedName) : []).toEqual(["handleAppend"]);
      expect(calls.status === "ok" ? calls.items[0]?.to.qualifiedName : null).toBe("append_session");
      expect(tests.status === "ok" ? tests.items[0]?.relation : null).toBe("static_reference");
      expect(resolver.resolveArtifact({ kind: "symbol", path: "src/actions.ts", qualifiedName: "append_session", lastVerifiedSha: SHA })).toEqual({
        kind: "symbol",
        path: "src/actions.ts",
        line: 5,
        qualifiedName: "append_session",
      });
      expect(resolver.resolveArtifact({
        kind: "test",
        path: "src/actions.test.ts",
        testName: TEST_NAME,
        lastVerifiedSha: SHA,
      })).toEqual({
        kind: "test",
        path: "src/actions.test.ts",
        line: 9,
        testName: TEST_NAME,
      });
      expect(resolver.resolveArtifact({
        kind: "test",
        path: "src/actions.test.ts",
        testName: "preserves provider-neutral append",
        lastVerifiedSha: SHA,
      })).toEqual({
        kind: "test",
        path: "src/actions.test.ts",
        line: 9,
        testName: TEST_NAME,
      });
      expect(resolver.resolveArtifact({
        kind: "test",
        path: "src/actions.test.ts",
        testName: "actions > preserve provider-neutral append",
        lastVerifiedSha: SHA,
      })).toBeNull();
    } finally {
      resolver.close();
    }
  });

  it("rejects an ambiguous test leaf name within one file", () => {
    const resolver = openCodeIndex(fixture([
      "actions > preserves provider-neutral append",
      "fallback actions > preserves provider-neutral append",
    ]));
    try {
      expect(resolver.resolveArtifact({
        kind: "test",
        path: "src/actions.test.ts",
        testName: "preserves provider-neutral append",
        lastVerifiedSha: SHA,
      })).toBeNull();
    } finally {
      resolver.close();
    }
  });

  it("returns a typed stale result without fuzzy navigation", () => {
    const resolver = openCodeIndex(fixture());
    try {
      const stale = resolver.definitions({ repoSha: "c".repeat(40), symbol: { qualifiedName: "append_session" } });
      expect(stale).toEqual({ status: "stale_code_index", requestedSha: "c".repeat(40), indexedSha: SHA, items: [] });
      expect(resolver.resolveArtifact({ kind: "symbol", path: "src/actions.ts", qualifiedName: "append_session", lastVerifiedSha: "c".repeat(40) })).toBeNull();
    } finally {
      resolver.close();
    }
  });

  it("trusts digests its caller already streamed instead of re-reading the artifact files", () => {
    const directory = fixture();
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "code-index-manifest.json"), "utf8")) as {
      files: Record<string, { sha256: string }>;
    };
    const streamed = new Map(["index.scip", "code-index.sqlite"].map((name) => [name, manifest.files[name]!.sha256]));
    // Same size, different bytes: only a re-read could notice.
    const scip = path.join(directory, "index.scip");
    const bytes = fs.readFileSync(scip);
    bytes[0] = bytes[0]! ^ 0xff;
    fs.writeFileSync(scip, bytes);
    expect(() => openCodeIndex(directory)).toThrow(/digest mismatch/);
    expect(() => openCodeIndex(directory, { verifiedDigests: new Map([["index.scip", "0".repeat(64)]]) })).toThrow(/digest mismatch/);
    const resolver = openCodeIndex(directory, { verifiedDigests: streamed });
    try {
      expect(resolver.gitSha).toBe(SHA);
    } finally {
      resolver.close();
    }
    fs.appendFileSync(scip, "x");
    expect(() => openCodeIndex(directory, { verifiedDigests: streamed })).toThrow(/digest mismatch/);
  });

  it("rejects corrupted and incomplete artifacts before opening SQLite", () => {
    const corrupted = fixture();
    fs.appendFileSync(path.join(corrupted, "index.scip"), "corruption");
    expect(() => openCodeIndex(corrupted)).toThrow(/digest mismatch/);

    const incomplete = fixture();
    writeManifest(incomplete, {
      expectedDocuments: 3,
      indexedDocuments: 3,
      duplicates: 0,
      skipped: 1,
      errors: 0,
      tests: 1,
      testReferences: 1,
    });
    expect(() => openCodeIndex(incomplete)).toThrow(/incomplete code index/);
  });
});
