#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_FILE_MAX_CHARS = 12_000;
const ROOT_FILE_MAX_LINES = 200;
const ALWAYS_ON_MAX_CHARS = 16_000;

const failures = [];
const warnings = [];

function charCount(text) {
  return [...text].length;
}

function lineCount(text) {
  return text === "" ? 0 : text.split(/\r?\n/).length;
}

async function textAt(relative) {
  return await readFile(path.join(root, relative), "utf8");
}

async function markdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdownFiles(absolute)));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(absolute);
  }
  return out.sort();
}

const alwaysOn = [];
for (const relative of ["AGENTS.md", "CLAUDE.md"]) {
  const text = await textAt(relative);
  const chars = charCount(text);
  const lines = lineCount(text);
  alwaysOn.push({ relative, chars });
  if (chars > ROOT_FILE_MAX_CHARS) {
    failures.push(`${relative}: ${chars} chars > ${ROOT_FILE_MAX_CHARS}`);
  }
  if (lines > ROOT_FILE_MAX_LINES) {
    failures.push(`${relative}: ${lines} lines > ${ROOT_FILE_MAX_LINES}`);
  }
}

const claude = await textAt("CLAUDE.md");
const imports = [...claude.matchAll(/^\s*@([^\s]+)\s*$/gm)].map((match) => match[1]);
for (const imported of imports) {
  if (imported !== "AGENTS.md") {
    failures.push(`CLAUDE.md: eager import @${imported} is not allowed; link it for on-demand reading`);
  }
}

const ruleRoot = path.join(root, ".claude", "rules");
for (const absolute of await markdownFiles(ruleRoot)) {
  const relative = path.relative(root, absolute);
  const text = await readFile(absolute, "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const hasPaths = frontmatter && /^paths:\s*(?:\r?$)/m.test(frontmatter[1]);
  if (!hasPaths) {
    alwaysOn.push({ relative, chars: charCount(text) });
    failures.push(`${relative}: missing paths frontmatter; unscoped rules load every session`);
  }
}

const totalAlwaysOn = alwaysOn.reduce((sum, file) => sum + file.chars, 0);
if (totalAlwaysOn > ALWAYS_ON_MAX_CHARS) {
  failures.push(`always-on instructions: ${totalAlwaysOn} chars > ${ALWAYS_ON_MAX_CHARS}`);
}

const packagesRoot = path.join(root, "packages");
for (const absolute of await markdownFiles(packagesRoot)) {
  if (path.basename(absolute) !== "CLAUDE.md") continue;
  const lines = lineCount(await readFile(absolute, "utf8"));
  if (lines > 200) {
    warnings.push(`${path.relative(root, absolute)}: ${lines} lines; migrate detail below 200 lines`);
  }
}

// ADR lifecycle frontmatter (doc/development/2026-08-20-knowledge-graph-redesign.md §5.1):
// decision and realization are separate axes; supersession must be mutual.
const ADR_DECISION = new Set(["proposed", "accepted", "rejected", "superseded"]);
const ADR_REALIZATION = new Set(["not_applicable", "planned", "partial", "implemented"]);
const adrDir = path.join(root, "doc", "adr");
const adrs = new Map();
for (const absolute of await markdownFiles(adrDir)) {
  const relative = path.relative(root, absolute);
  if (path.basename(absolute) === "README.md") continue;
  const text = await readFile(absolute, "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) {
    failures.push(`${relative}: missing ADR frontmatter (decision_status, realization_status, supersedes, superseded_by)`);
    continue;
  }
  const field = (name) => frontmatter[1].match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? null;
  const list = (name) => (field(name) ?? "[]").replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const decision = field("decision_status");
  const realization = field("realization_status");
  if (!decision || !ADR_DECISION.has(decision)) failures.push(`${relative}: decision_status must be one of ${[...ADR_DECISION].join("|")}`);
  if (!realization || !ADR_REALIZATION.has(realization)) failures.push(`${relative}: realization_status must be one of ${[...ADR_REALIZATION].join("|")}`);
  const number = /^doc\/adr\/(\d{4})-(?!\d{2}-\d{2}-)/.exec(relative)?.[1] ?? path.basename(relative, ".md");
  adrs.set(number, { relative, supersedes: list("supersedes"), superseded_by: list("superseded_by") });
}
for (const [number, adr] of adrs) {
  for (const other of adr.supersedes) {
    const target = adrs.get(other.padStart(4, "0")) ?? adrs.get(other);
    if (!target) failures.push(`${adr.relative}: supersedes unknown ADR ${other}`);
    else if (!target.superseded_by.some((value) => value.padStart(4, "0") === number.padStart(4, "0"))) failures.push(`${adr.relative}: supersedes ${other} but ${target.relative} does not list superseded_by ${number}`);
  }
}

// Curated knowledge inputs: capabilities reference real atlas ids; knowledge JSONL parses.
try {
  const atlas = JSON.parse(await textAt("architecture/atlas.json"));
  const capabilities = JSON.parse(await textAt("architecture/capabilities.json"));
  const moduleIds = new Set((atlas.modules ?? []).map((module) => module.id));
  const constraintIds = new Set((atlas.constraints ?? []).map((constraint) => constraint.id));
  const seen = new Set();
  for (const cap of capabilities.capabilities ?? []) {
    if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/.test(String(cap.id))) failures.push(`capabilities.json: invalid id ${cap.id}`);
    if (seen.has(cap.id)) failures.push(`capabilities.json: duplicate id ${cap.id}`);
    seen.add(cap.id);
    for (const module of cap.modules ?? []) if (!moduleIds.has(module)) failures.push(`capabilities.json: ${cap.id} names unknown module ${module}`);
    for (const constraint of cap.constraints ?? []) if (!constraintIds.has(constraint)) failures.push(`capabilities.json: ${cap.id} names unknown constraint ${constraint}`);
    for (const doc of cap.docs ?? []) {
      try {
        await readFile(path.join(root, doc), "utf8");
      } catch {
        failures.push(`capabilities.json: ${cap.id} doc ${doc} does not exist`);
      }
    }
  }
  const knowledgeDir = path.join(root, "architecture", "knowledge");
  const jsonl = [];
  for (const entry of await readdir(knowledgeDir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) jsonl.push(path.join(entry.parentPath ?? entry.path, entry.name));
  }
  for (const file of jsonl) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const record = JSON.parse(line);
        for (const cap of record.capabilities ?? []) if (!seen.has(cap)) failures.push(`${path.relative(root, file)}:${index + 1}: unknown capability ${cap}`);
        if (typeof record.statement === "string" && record.statement.length > 400) failures.push(`${path.relative(root, file)}:${index + 1}: statement longer than 400 chars`);
        if (typeof record.detail === "string" && record.detail.length > 400) failures.push(`${path.relative(root, file)}:${index + 1}: detail longer than 400 chars`);
      } catch {
        failures.push(`${path.relative(root, file)}:${index + 1}: invalid JSON line`);
      }
    });
  }
} catch (error) {
  failures.push(`knowledge inputs: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`agent docs: always-on ${totalAlwaysOn}/${ALWAYS_ON_MAX_CHARS} chars`);
for (const file of alwaysOn) console.log(`  ${file.relative}: ${file.chars}`);
for (const warning of warnings) console.warn(`warning: ${warning}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(`error: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("agent docs: ok");
}
