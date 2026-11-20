import fs from "node:fs";
import path from "node:path";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  IndexSchema,
  SymbolRole,
  type Index,
  type Occurrence,
  type SymbolInformation,
} from "@scip-code/scip";

import type { CallFact, SymbolFact } from "../shared/model.js";
import { normalizeRepoPath } from "../analyzer/paths.js";
import { formatScipSymbolLocator } from "./identity.js";
import { isDeclarationFile, type CodeIndexProject } from "./projects.js";
import { CODE_INDEX_SCHEMA_VERSION, createCodeIndexDatabase } from "./schema.js";

export interface TestInventoryCase {
  name: string;
  line: number;
  column: number;
}

export interface TestInventoryEntry {
  path: string;
  projects: readonly string[];
  tests: readonly TestInventoryCase[];
}

export interface NormalizationCoverage {
  expectedDocuments: number;
  indexedDocuments: number;
  duplicates: number;
  skipped: number;
  errors: number;
  tests: number;
  testReferences: number;
}

export interface NormalizeCodeIndexOptions {
  root: string;
  repoSha: string;
  rawScip: string;
  indexScip: string;
  sqlite: string;
  projects: readonly CodeIndexProject[];
  tests: readonly TestInventoryEntry[];
  observatorySymbols: readonly SymbolFact[];
  observatoryCalls: readonly CallFact[];
}

interface Range {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

interface SymbolRecord {
  id: string;
  scipSymbol: string;
  displayName: string;
  qualifiedName: string;
  kind: number;
  signature: string | null;
  documentPath: string;
  range: Range;
  information?: SymbolInformation;
}

function occurrenceRange(occurrence: Occurrence): Range {
  if (occurrence.typedRange.case === "singleLineRange") {
    const value = occurrence.typedRange.value;
    return {
      startLine: value.line,
      startCharacter: value.startCharacter,
      endLine: value.line,
      endCharacter: value.endCharacter,
    };
  }
  if (occurrence.typedRange.case === "multiLineRange") {
    const value = occurrence.typedRange.value;
    return {
      startLine: value.startLine,
      startCharacter: value.startCharacter,
      endLine: value.endLine,
      endCharacter: value.endCharacter,
    };
  }
  if (occurrence.range.length === 3) {
    return {
      startLine: occurrence.range[0],
      startCharacter: occurrence.range[1],
      endLine: occurrence.range[0],
      endCharacter: occurrence.range[2],
    };
  }
  if (occurrence.range.length === 4) {
    return {
      startLine: occurrence.range[0],
      startCharacter: occurrence.range[1],
      endLine: occurrence.range[2],
      endCharacter: occurrence.range[3],
    };
  }
  throw new Error(`SCIP occurrence has invalid range length ${occurrence.range.length}`);
}

function assertRange(range: Range, documentPath: string): void {
  if (range.startLine < 0 || range.startCharacter < 0 || range.endLine < range.startLine || range.endCharacter < 0
    || (range.endLine === range.startLine && range.endCharacter < range.startCharacter)) {
    throw new Error(`SCIP occurrence has invalid range in ${documentPath}`);
  }
}

function normalizeDocumentPath(value: string): string {
  const normalized = normalizeRepoPath(value).replace(/^\/+/, "");
  if (!normalized || path.isAbsolute(value) || normalized.split("/").includes("..")) {
    throw new Error(`SCIP document path escapes repository: ${value}`);
  }
  return normalized;
}

function unescapeDescriptor(value: string): string {
  return value.startsWith("`") && value.endsWith("`")
    ? value.slice(1, -1).replaceAll("``", "`")
    : value;
}

function descriptorNames(symbol: string): Array<{ name: string; suffix: string }> {
  if (symbol.startsWith("local ")) return [{ name: symbol.slice(6), suffix: "." }];
  let descriptorStart = -1;
  let separators = 0;
  for (let index = 0; index < symbol.length; index += 1) {
    if (symbol[index] !== " ") continue;
    if (symbol[index + 1] === " ") {
      index += 1;
      continue;
    }
    separators += 1;
    if (separators === 4) {
      descriptorStart = index + 1;
      break;
    }
  }
  if (descriptorStart < 0) return [];
  const output: Array<{ name: string; suffix: string }> = [];
  const pattern = /(`(?:``|[^`])+`|[A-Za-z0-9_$+\-]+)(\/|#|:|!|\([^)]*\)\.|\.)/g;
  for (const match of symbol.slice(descriptorStart).matchAll(pattern)) {
    output.push({ name: unescapeDescriptor(match[1]), suffix: match[2] });
  }
  const parameter = symbol.slice(descriptorStart).match(/\((`(?:``|[^`])+`|[A-Za-z0-9_$+\-]+)\)$/);
  if (parameter) output.push({ name: unescapeDescriptor(parameter[1]), suffix: "()" });
  const typeParameter = symbol.slice(descriptorStart).match(/\[(`(?:``|[^`])+`|[A-Za-z0-9_$+\-]+)\]$/);
  if (typeParameter) output.push({ name: unescapeDescriptor(typeParameter[1]), suffix: "[]" });
  return output;
}

function fallbackNames(symbol: string, information?: SymbolInformation): { displayName: string; qualifiedName: string } {
  const descriptors = descriptorNames(symbol);
  let fileDescriptor = -1;
  for (let index = 0; index < descriptors.length; index += 1) {
    if (/\\.(?:[cm]?[jt]sx?)$/.test(descriptors[index].name)) fileDescriptor = index;
  }
  const semantic = fileDescriptor >= 0
    ? descriptors.slice(fileDescriptor + 1)
    : descriptors.filter((descriptor) => descriptor.suffix !== "/");
  const displayName = information?.displayName || semantic.at(-1)?.name || descriptors.at(-1)?.name || symbol;
  return { displayName, qualifiedName: semantic.map((descriptor) => descriptor.name).join(".") || displayName };
}

function canonicalizeIndex(index: Index): void {
  if (!index.metadata) throw new Error("SCIP index is missing metadata");
  if (index.metadata.toolInfo?.name !== "scip-typescript" || index.metadata.toolInfo.version !== "0.4.0") {
    throw new Error(`unexpected SCIP generator ${index.metadata.toolInfo?.name ?? "missing"}@${index.metadata.toolInfo?.version ?? "missing"}`);
  }
  index.metadata.projectRoot = "file:///workspace";
  index.documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (const document of index.documents) {
    document.occurrences.sort((a, b) => {
      const left = occurrenceRange(a);
      const right = occurrenceRange(b);
      return left.startLine - right.startLine
        || left.startCharacter - right.startCharacter
        || left.endLine - right.endLine
        || left.endCharacter - right.endCharacter
        || a.symbol.localeCompare(b.symbol);
    });
    document.symbols.sort((a, b) => a.symbol.localeCompare(b.symbol));
    for (const symbol of document.symbols) symbol.relationships.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }
  index.externalSymbols.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function decodeAndNormalizeScip(options: NormalizeCodeIndexOptions): NormalizationCoverage {
  const index = fromBinary(IndexSchema, fs.readFileSync(options.rawScip));
  canonicalizeIndex(index);

  const expectedOwner = new Map<string, CodeIndexProject>();
  for (const project of options.projects) for (const file of project.files) expectedOwner.set(file, project);
  const documentsByPath = new Map<string, Index["documents"][number]>();
  let duplicates = 0;
  for (const document of index.documents) {
    const documentPath = normalizeDocumentPath(document.relativePath);
    document.relativePath = documentPath;
    if (documentsByPath.has(documentPath)) {
      duplicates += 1;
      continue;
    }
    if (!expectedOwner.has(documentPath)) {
      if (isDeclarationFile(documentPath)) continue;
      throw new Error(`SCIP indexed undeclared document ${documentPath}`);
    }
    documentsByPath.set(documentPath, document);
  }
  index.documents = [...documentsByPath.values()];
  const missing = [...expectedOwner.keys()].filter((file) => !documentsByPath.has(file));
  if (duplicates > 0 || missing.length > 0) {
    throw new Error(`incomplete SCIP index: ${duplicates} duplicate documents, ${missing.length} missing (${missing.slice(0, 8).join(", ")})`);
  }

  fs.writeFileSync(options.indexScip, toBinary(IndexSchema, index));

  const testByPath = new Map(options.tests.map((test) => [normalizeRepoPath(test.path), test]));
  const factsByPath = new Map<string, SymbolFact[]>();
  for (const fact of options.observatorySymbols) {
    const list = factsByPath.get(fact.source.path) ?? [];
    list.push(fact);
    factsByPath.set(fact.source.path, list);
  }

  const symbolByScip = new Map<string, SymbolRecord>();
  for (const [documentPath, document] of documentsByPath) {
    const informationBySymbol = new Map(document.symbols.map((information) => [information.symbol, information]));
    for (const occurrence of document.occurrences) {
      if (!occurrence.symbol || (occurrence.symbolRoles & SymbolRole.Definition) === 0) continue;
      if (symbolByScip.has(occurrence.symbol)) continue;
      const range = occurrenceRange(occurrence);
      assertRange(range, documentPath);
      const information = informationBySymbol.get(occurrence.symbol);
      const fallback = fallbackNames(occurrence.symbol, information);
      const candidates = (factsByPath.get(documentPath) ?? []).filter((fact) =>
        fact.source.line === range.startLine + 1
        && fact.qualifiedName === fallback.qualifiedName);
      const fact = candidates.length === 1 ? candidates[0] : undefined;
      const qualifiedName = fact?.qualifiedName ?? fallback.qualifiedName;
      const displayName = fact?.name ?? fallback.displayName;
      symbolByScip.set(occurrence.symbol, {
        id: formatScipSymbolLocator({ repoSha: options.repoSha, path: documentPath, qualifiedName }),
        scipSymbol: occurrence.symbol,
        displayName,
        qualifiedName,
        kind: information?.kind ?? 0,
        signature: information?.signatureDocumentation?.text || null,
        documentPath,
        range,
        information,
      });
    }
  }

  const duplicateLocator = new Map<string, string>();
  for (const symbol of symbolByScip.values()) {
    const previous = duplicateLocator.get(symbol.id);
    if (previous && previous !== symbol.scipSymbol) throw new Error(`duplicate SHA-bound symbol locator ${symbol.id}`);
    duplicateLocator.set(symbol.id, symbol.scipSymbol);
  }

  const database = createCodeIndexDatabase(options.sqlite);
  try {
    const projectId = new Map<string, number>();
    const documentId = new Map<string, number>();
    const insertProject = database.prepare("INSERT INTO projects(id, package_name, project_root, tsconfig_path, status, document_count) VALUES (?, ?, ?, ?, 'complete', ?)");
    const insertDocument = database.prepare("INSERT INTO documents(id, path, project_id, language, is_test, vitest_project) VALUES (?, ?, ?, ?, ?, ?)");
    const insertSymbol = database.prepare(`INSERT INTO symbols(
      id, scip_symbol, display_name, qualified_name, kind, signature,
      definition_document_id, definition_start_line, definition_start_character, definition_end_line, definition_end_character
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertOccurrence = database.prepare(`INSERT OR IGNORE INTO occurrences(
      document_id, scip_symbol, start_line, start_character, end_line, end_character, roles, is_definition
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertRelationship = database.prepare(`INSERT INTO relationships(
      from_symbol, to_symbol, is_reference, is_implementation, is_type_definition, is_definition
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(from_symbol, to_symbol) DO UPDATE SET
      is_reference = max(is_reference, excluded.is_reference),
      is_implementation = max(is_implementation, excluded.is_implementation),
      is_type_definition = max(is_type_definition, excluded.is_type_definition),
      is_definition = max(is_definition, excluded.is_definition)`);
    const insertSearch = database.prepare("INSERT INTO symbol_search(symbol_id, qualified_name, display_name, path) VALUES (?, ?, ?, ?)");
    const insertCall = database.prepare("INSERT INTO calls(from_symbol_id, to_symbol_id, document_id, line, count) VALUES (?, ?, ?, ?, ?)");
    const insertTestReference = database.prepare("INSERT OR IGNORE INTO test_references(test_document_id, target_symbol_id, line, relation) VALUES (?, ?, ?, 'static_reference')");

    database.transaction(() => {
      database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("schema_version", String(CODE_INDEX_SCHEMA_VERSION));
      database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("repo_sha", options.repoSha);
      options.projects.forEach((project, index_) => {
        const id = index_ + 1;
        const count = project.files.length;
        projectId.set(project.tsconfig, id);
        insertProject.run(id, project.packageName, project.root, project.tsconfig, count);
      });
      [...documentsByPath].sort(([left], [right]) => left.localeCompare(right)).forEach(([documentPath, document], index_) => {
        const owner = expectedOwner.get(documentPath);
        if (!owner) throw new Error(`missing project owner for ${documentPath}`);
        const id = index_ + 1;
        const test = testByPath.get(documentPath);
        documentId.set(documentPath, id);
        insertDocument.run(id, documentPath, projectId.get(owner.tsconfig), document.language || "typescript", test ? 1 : 0, test?.projects.join(",") ?? null);
      });
      [...symbolByScip.values()].sort((a, b) => a.id.localeCompare(b.id)).forEach((symbol) => {
        insertSymbol.run(
          symbol.id,
          symbol.scipSymbol,
          symbol.displayName,
          symbol.qualifiedName,
          symbol.kind,
          symbol.signature,
          documentId.get(symbol.documentPath),
          symbol.range.startLine,
          symbol.range.startCharacter,
          symbol.range.endLine,
          symbol.range.endCharacter,
        );
        insertSearch.run(symbol.id, symbol.qualifiedName, symbol.displayName, symbol.documentPath);
      });
      for (const [documentPath, document] of [...documentsByPath].sort(([left], [right]) => left.localeCompare(right))) {
        const id = documentId.get(documentPath);
        if (!id) throw new Error(`missing normalized document ${documentPath}`);
        for (const occurrence of document.occurrences) {
          if (!occurrence.symbol) continue;
          const range = occurrenceRange(occurrence);
          assertRange(range, documentPath);
          const definition = (occurrence.symbolRoles & SymbolRole.Definition) !== 0;
          insertOccurrence.run(id, occurrence.symbol, range.startLine, range.startCharacter, range.endLine, range.endCharacter, occurrence.symbolRoles, definition ? 1 : 0);
          const target = symbolByScip.get(occurrence.symbol);
          if (testByPath.has(documentPath) && target && !definition && target.documentPath !== documentPath) {
            insertTestReference.run(id, target.id, range.startLine);
          }
        }
        for (const information of document.symbols) {
          for (const relationship of information.relationships) {
            insertRelationship.run(
              information.symbol,
              relationship.symbol,
              relationship.isReference ? 1 : 0,
              relationship.isImplementation ? 1 : 0,
              relationship.isTypeDefinition ? 1 : 0,
              relationship.isDefinition ? 1 : 0,
            );
          }
        }
      }
      for (const call of options.observatoryCalls) {
        const from = duplicateLocator.get(call.from);
        const to = duplicateLocator.get(call.to);
        if (!from || !to) continue;
        const fromSymbol = symbolByScip.get(from);
        const toSymbol = symbolByScip.get(to);
        const sample = call.samples[0];
        const callerDocument = sample ? documentId.get(sample.path) : undefined;
        if (!fromSymbol || !toSymbol || !callerDocument || !sample) continue;
        insertCall.run(fromSymbol.id, toSymbol.id, callerDocument, sample.line - 1, call.count);
      }
    })();
    database.exec("ANALYZE; VACUUM;");

    const testReferenceCount = database.prepare("SELECT count(*) AS count FROM test_references").get();
    if (!testReferenceCount || typeof testReferenceCount !== "object" || !("count" in testReferenceCount) || typeof testReferenceCount.count !== "number") {
      throw new Error("failed to count static test references");
    }
    return {
      expectedDocuments: expectedOwner.size,
      indexedDocuments: documentsByPath.size,
      duplicates,
      skipped: 0,
      errors: 0,
      tests: options.tests.length,
      testReferences: testReferenceCount.count,
    };
  } finally {
    database.close();
  }
}
