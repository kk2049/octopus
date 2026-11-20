import fs from "node:fs";
import Database from "better-sqlite3";

export const CODE_INDEX_SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA page_size = 4096;
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
PRAGMA foreign_keys = ON;

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  package_name TEXT NOT NULL UNIQUE,
  project_root TEXT NOT NULL,
  tsconfig_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status = 'complete'),
  document_count INTEGER NOT NULL CHECK (document_count >= 0)
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  language TEXT NOT NULL,
  is_test INTEGER NOT NULL CHECK (is_test IN (0, 1)),
  vitest_project TEXT
);

CREATE TABLE symbols (
  id TEXT PRIMARY KEY,
  scip_symbol TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind INTEGER NOT NULL,
  signature TEXT,
  definition_document_id INTEGER REFERENCES documents(id),
  definition_start_line INTEGER,
  definition_start_character INTEGER,
  definition_end_line INTEGER,
  definition_end_character INTEGER
) WITHOUT ROWID;

CREATE TABLE occurrences (
  document_id INTEGER NOT NULL REFERENCES documents(id),
  scip_symbol TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_character INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_character INTEGER NOT NULL,
  roles INTEGER NOT NULL,
  is_definition INTEGER NOT NULL CHECK (is_definition IN (0, 1)),
  PRIMARY KEY (document_id, start_line, start_character, end_line, end_character, scip_symbol)
) WITHOUT ROWID;

CREATE TABLE relationships (
  from_symbol TEXT NOT NULL,
  to_symbol TEXT NOT NULL,
  is_reference INTEGER NOT NULL CHECK (is_reference IN (0, 1)),
  is_implementation INTEGER NOT NULL CHECK (is_implementation IN (0, 1)),
  is_type_definition INTEGER NOT NULL CHECK (is_type_definition IN (0, 1)),
  is_definition INTEGER NOT NULL CHECK (is_definition IN (0, 1)),
  PRIMARY KEY (from_symbol, to_symbol)
) WITHOUT ROWID;

CREATE TABLE calls (
  from_symbol_id TEXT NOT NULL REFERENCES symbols(id),
  to_symbol_id TEXT NOT NULL REFERENCES symbols(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  line INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (from_symbol_id, to_symbol_id, document_id, line)
) WITHOUT ROWID;

CREATE TABLE test_references (
  test_document_id INTEGER NOT NULL REFERENCES documents(id),
  target_symbol_id TEXT NOT NULL REFERENCES symbols(id),
  line INTEGER NOT NULL,
  relation TEXT NOT NULL CHECK (relation = 'static_reference'),
  PRIMARY KEY (test_document_id, target_symbol_id, line)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE symbol_search USING fts5(
  symbol_id UNINDEXED,
  qualified_name,
  display_name,
  path,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE INDEX occurrences_symbol_definition_document
  ON occurrences(scip_symbol, is_definition, document_id);
CREATE INDEX occurrences_position
  ON occurrences(document_id, start_line, start_character, end_line, end_character);
CREATE INDEX relationships_target_implementation
  ON relationships(to_symbol, is_implementation);
CREATE INDEX calls_target ON calls(to_symbol_id);
CREATE INDEX test_references_target ON test_references(target_symbol_id);
`;

export function createCodeIndexDatabase(file: string): Database.Database {
  fs.rmSync(file, { force: true });
  const database = new Database(file);
  database.exec(SCHEMA);
  return database;
}
