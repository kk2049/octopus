#!/usr/bin/env node
/**
 * Prepare the historical backfill: one dossier per ticket, grouped into
 * capability batches, plus a task brief per batch for the backfill agents.
 *
 *   tsx packages/bot/src/knowledge/backfill/export-dossiers.ts \
 *     --root . --bot-db <bot.db> --graph <graph.db> --out <dir> [--since 2026-08-01] [--batch-size 10]
 *
 * The output directory contains ticket bodies and messages and therefore
 * stays outside Git (scratch/data dir). Read-only against bot.db and Git.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { GraphDb } from "../graph-db.js";
import { KnowledgeRetriever } from "../retrieval.js";
import { readBotDb } from "../bot-db.js";

interface TicketRow {
  id: number;
  title: string;
  body: string;
  requester: string;
  kind: string;
  dev_status: string;
  created_at: string;
  landed_at: string | null;
  commit_sha: string | null;
  parent_ticket_id: number | null;
  spec: string | null;
  open_question: string | null;
}

interface MessageRow {
  id: number;
  author: string;
  via: string;
  body: string;
  created_at: string;
}

interface Dossier {
  ticket: TicketRow & { messages: MessageRow[] };
  commits: Array<{ sha: string; subject: string; files: string[] }>;
  deliveries: string[];
  cli_report: string | null;
  landing: unknown[];
  capabilities: Array<{ id: string; certainty: string; why: string[] }>;
  existing_statements: Array<{ id: string; kind: string; statement: string; source_ref: string; status: string }>;
}

function flags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) out.set(key, inline);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      out.set(key, argv[index + 1]);
      index += 1;
    } else out.set(key, "true");
  }
  return out;
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch {
    return "";
  }
}

const CI_TITLE = /^修复 GitLab CI 红灯/;

async function main(): Promise<void> {
  const opts = flags(process.argv.slice(2));
  const root = path.resolve(opts.get("root") ?? ".");
  const botDb = opts.get("bot-db");
  const graphFile = opts.get("graph");
  const out = opts.get("out");
  if (!botDb || !graphFile || !out) throw new Error("--bot-db, --graph and --out are required");
  const since = opts.get("since") ?? "2026-08-01";
  const batchSize = Number(opts.get("batch-size") ?? 10);
  const graph = GraphDb.openReadonly(path.resolve(graphFile));
  if (!graph) throw new Error(`graph not found: ${graphFile}`);
  const retriever = new KnowledgeRetriever(graph);
  const runtime = readBotDb(path.resolve(botDb));
  const db = new Database(path.resolve(botDb), { readonly: true, fileMustExist: true });
  fs.mkdirSync(path.join(out, "dossiers"), { recursive: true });
  fs.mkdirSync(path.join(out, "batches"), { recursive: true });

  const deliveryIndex = new Map<number, string[]>();
  for (const file of fs.readdirSync(path.join(root, "doc/deliveries")).filter((name) => name.endsWith(".md"))) {
    const text = fs.readFileSync(path.join(root, "doc/deliveries", file), "utf8");
    for (const match of text.matchAll(/(?:#|工单\s?#?)(\d{1,4})(?!\d)/g)) {
      const id = Number(match[1]);
      (deliveryIndex.get(id) ?? deliveryIndex.set(id, []).get(id))!.push(`doc/deliveries/${file}`);
    }
  }
  const cliReportByCommit = new Map<string, string>();
  for (const file of fs.readdirSync(path.join(root, "doc/cli-reports")).filter((name) => /^\d{4}-\d{2}-\d{2}-.*\.json$/.test(name))) {
    const sha = git(root, ["log", "--diff-filter=A", "-1", "--format=%H", "--", `doc/cli-reports/${file}`]);
    if (sha) cliReportByCommit.set(sha, `doc/cli-reports/${file}`);
  }

  const tickets = db.prepare(
    "SELECT id, title, body, requester, kind, dev_status, created_at, landed_at, commit_sha, parent_ticket_id, spec, open_question FROM dev_tickets WHERE created_at >= ? ORDER BY id",
  ).all(since) as TicketRow[];
  const messagesStmt = db.prepare("SELECT id, author, via, body, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY id");
  const dossiers: Dossier[] = [];
  let skippedCi = 0;
  for (const ticket of tickets) {
    if (CI_TITLE.test(ticket.title)) {
      skippedCi += 1;
      continue;
    }
    const messages = (messagesStmt.all(ticket.id) as MessageRow[]).filter((message) => message.via !== "pipeline" || /落地|取代|不做|决定|裁决|改为/.test(message.body));
    const commits: Dossier["commits"] = [];
    const seen = new Set<string>();
    const grep = git(root, ["log", "v4", "--format=%H%x09%s", `--grep=#${ticket.id}\\b`, "-n", "12"]);
    for (const line of grep.split("\n").filter(Boolean)) {
      const [sha, subject] = line.split("\t");
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      commits.push({ sha, subject: subject ?? "", files: git(root, ["show", "--name-only", "--format=", sha]).split("\n").filter(Boolean).slice(0, 40) });
    }
    if (ticket.commit_sha && !seen.has(ticket.commit_sha)) {
      const subject = git(root, ["show", "-s", "--format=%s", ticket.commit_sha]);
      if (subject) commits.unshift({ sha: ticket.commit_sha, subject, files: git(root, ["show", "--name-only", "--format=", ticket.commit_sha]).split("\n").filter(Boolean).slice(0, 40) });
    }
    const text = [ticket.title, ticket.body, ticket.spec ?? ""].join("\n");
    const explicitPaths = commits.flatMap((commit) => commit.files).slice(0, 30);
    const capabilities = (await retriever.classify({ text, explicitPaths })).map((match) => ({ id: match.id, certainty: match.certainty, why: match.why.slice(0, 3) }));
    const existing = new Map<string, Dossier["existing_statements"][number]>();
    for (const edge of graph.edgesTo(`ticket:${ticket.id}`, ["about"])) {
      const node = graph.node(edge.from_id);
      if (node && ["requirement", "decision", "non_goal", "risk", "principle"].includes(node.kind)) {
        existing.set(node.id, { id: node.id, kind: node.kind, statement: node.statement, source_ref: node.source_ref, status: node.status });
      }
    }
    const seedCapabilities = capabilities.filter((cap) => cap.certainty !== "ambiguous").map((cap) => cap.id);
    const expansion = retriever.expandFromCapabilities(seedCapabilities);
    for (const node of [...expansion.decisions, ...expansion.nonGoals, ...expansion.requirements].slice(0, 40)) {
      if (node.authority === "curated" || node.authority === "user" || node.authority === "package" || node.authority === "adr") {
        existing.set(node.id, { id: node.id, kind: node.kind, statement: node.statement, source_ref: node.source_ref, status: node.status });
      }
    }
    dossiers.push({
      ticket: { ...ticket, messages },
      commits,
      deliveries: [...new Set(deliveryIndex.get(ticket.id) ?? [])],
      cli_report: ticket.commit_sha ? cliReportByCommit.get(ticket.commit_sha) ?? null : null,
      landing: runtime.landings.filter((landing) => landing.ticket_id === ticket.id),
      capabilities,
      existing_statements: [...existing.values()].slice(0, 60),
    });
  }
  db.close();
  graph.close();

  for (const dossier of dossiers) {
    fs.writeFileSync(path.join(out, "dossiers", `${dossier.ticket.id}.json`), JSON.stringify(dossier, null, 2));
  }

  // Batches: primary capability (first non-ambiguous match), chunked.
  const groups = new Map<string, Dossier[]>();
  for (const dossier of dossiers) {
    const primary = dossier.capabilities.find((cap) => cap.certainty !== "ambiguous")?.id ?? dossier.capabilities[0]?.id ?? "unclassified";
    (groups.get(primary) ?? groups.set(primary, []).get(primary))!.push(dossier);
  }
  const manifest: Array<{ batch: string; capability: string; tickets: number[]; chars: number }> = [];
  let counter = 0;
  for (const [capability, members] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (let index = 0; index < members.length; index += batchSize) {
      counter += 1;
      const batch = `b${String(counter).padStart(2, "0")}`;
      const slice = members.slice(index, index + batchSize);
      const chars = slice.reduce((sum, dossier) => sum + dossier.ticket.body.length + dossier.ticket.messages.reduce((inner, message) => inner + message.body.length, 0), 0);
      fs.writeFileSync(path.join(out, "batches", `${batch}.json`), JSON.stringify({ batch, capability, tickets: slice }, null, 2));
      manifest.push({ batch, capability, tickets: slice.map((dossier) => dossier.ticket.id), chars });
    }
  }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ since, skippedCi, total: dossiers.length, batches: manifest }, null, 2));
  console.log(`dossiers: ${dossiers.length} tickets (skipped ${skippedCi} CI repair tickets), ${manifest.length} batches → ${out}`);
  for (const item of manifest) console.log(`  ${item.batch} ${item.capability} tickets=${item.tickets.length} chars=${item.chars}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
