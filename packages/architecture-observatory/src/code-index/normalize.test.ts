import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  DocumentSchema,
  IndexSchema,
  MetadataSchema,
  OccurrenceSchema,
  SymbolInformationSchema,
  SymbolRole,
  TextEncoding,
  ToolInfoSchema,
} from "@scip-code/scip";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { decodeAndNormalizeScip } from "./normalize.js";
import type { CodeIndexProject } from "./projects.js";

const SHA = "a".repeat(40);
const SYMBOL = "scip-typescript npm fixture 1.0.0 src/`api.ts`/append_session().";
const PARAMETER_SYMBOL = `${SYMBOL}(session)`;
const TYPE_PARAMETER_SYMBOL = `${SYMBOL}[T]`;
const NESTED_SYMBOL = `${SYMBOL}typeLiteral0:append_session.`;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeRawIndex(root: string): string {
  const file = path.join(root, "raw.scip");
  const information = create(SymbolInformationSchema, { symbol: SYMBOL, displayName: "append_session", kind: 0 });
  const definition = create(OccurrenceSchema, { range: [0, 16, 30], symbol: SYMBOL, symbolRoles: SymbolRole.Definition });
  const parameter = create(OccurrenceSchema, { range: [0, 31, 38], symbol: PARAMETER_SYMBOL, symbolRoles: SymbolRole.Definition });
  const typeParameter = create(OccurrenceSchema, { range: [0, 39, 40], symbol: TYPE_PARAMETER_SYMBOL, symbolRoles: SymbolRole.Definition });
  const nested = create(OccurrenceSchema, { range: [0, 41, 55], symbol: NESTED_SYMBOL, symbolRoles: SymbolRole.Definition });
  const reference = create(OccurrenceSchema, { range: [1, 2, 16], symbol: SYMBOL, symbolRoles: SymbolRole.ReadAccess });
  const index = create(IndexSchema, {
    metadata: create(MetadataSchema, {
      projectRoot: "file:///private/producer/path",
      textDocumentEncoding: TextEncoding.UTF8,
      toolInfo: create(ToolInfoSchema, { name: "scip-typescript", version: "0.4.0" }),
    }),
    documents: [
      create(DocumentSchema, { relativePath: "src/api.ts", language: "typescript", occurrences: [definition, parameter, typeParameter, nested], symbols: [information] }),
      create(DocumentSchema, { relativePath: "src/api.test.ts", language: "typescript", occurrences: [reference] }),
      create(DocumentSchema, { relativePath: "src/ambient.d.ts", language: "typescript" }),
    ],
  });
  fs.writeFileSync(file, toBinary(IndexSchema, index));
  return file;
}

function convert(root: string, rawScip: string, name: string) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  const project: CodeIndexProject = {
    packageName: "@fixture/api",
    root: ".",
    tsconfig: "tsconfig.json",
    files: ["src/api.test.ts", "src/api.ts"],
  };
  const coverage = decodeAndNormalizeScip({
    root,
    repoSha: SHA,
    rawScip,
    indexScip: path.join(directory, "index.scip"),
    sqlite: path.join(directory, "code-index.sqlite"),
    projects: [project],
    tests: [{
      path: "src/api.test.ts",
      projects: ["node"],
      tests: [{ name: "API > calls the exported API", line: 3, column: 2 }],
    }],
    observatorySymbols: [{
      id: "observatory-function",
      name: "append_session",
      qualifiedName: "append_session",
      kind: "function",
      moduleId: "fixture",
      fileId: "src/api.ts",
      source: { path: "src/api.ts", line: 1 },
      exported: true,
      loc: 1,
      complexity: 1,
      annotations: [],
    }],
    observatoryCalls: [],
  });
  return { directory, coverage };
}

describe("SCIP normalization", () => {
  it("produces deterministic normalized SCIP, SQLite, and static test facts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octopus-scip-normalize-"));
    temporaryDirectories.push(root);
    const raw = writeRawIndex(root);

    const first = convert(root, raw, "first");
    const second = convert(root, raw, "second");

    expect(first.coverage).toEqual({
      expectedDocuments: 2,
      indexedDocuments: 2,
      duplicates: 0,
      skipped: 0,
      errors: 0,
      tests: 1,
      testReferences: 1,
    });
    expect(sha256(path.join(first.directory, "index.scip"))).toBe(sha256(path.join(second.directory, "index.scip")));
    expect(sha256(path.join(first.directory, "code-index.sqlite"))).toBe(sha256(path.join(second.directory, "code-index.sqlite")));

    const database = new Database(path.join(first.directory, "code-index.sqlite"), { readonly: true, fileMustExist: true });
    const symbols = database.prepare("SELECT qualified_name, definition_start_line FROM symbols ORDER BY qualified_name").all() as Array<{ qualified_name: string; definition_start_line: number }>;
    const test = database.prepare("SELECT relation, line FROM test_references").get() as { relation: string; line: number };
    database.close();
    expect(symbols).toEqual([
      { qualified_name: "append_session", definition_start_line: 0 },
      { qualified_name: "append_session.T", definition_start_line: 0 },
      { qualified_name: "append_session.session", definition_start_line: 0 },
      { qualified_name: "append_session.typeLiteral0.append_session", definition_start_line: 0 },
    ]);
    expect(test).toEqual({ relation: "static_reference", line: 1 });
  });

  it("fails closed when a generated document is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octopus-scip-incomplete-"));
    temporaryDirectories.push(root);
    const raw = writeRawIndex(root);
    const project: CodeIndexProject = {
      packageName: "@fixture/api",
      root: ".",
      tsconfig: "tsconfig.json",
      files: ["src/api.test.ts", "src/api.ts", "src/missing.ts"],
    };

    expect(() => decodeAndNormalizeScip({
      root,
      repoSha: SHA,
      rawScip: raw,
      indexScip: path.join(root, "index.scip"),
      sqlite: path.join(root, "code-index.sqlite"),
      projects: [project],
      tests: [],
      observatorySymbols: [],
      observatoryCalls: [],
    })).toThrow(/incomplete SCIP index/);
  });
});
