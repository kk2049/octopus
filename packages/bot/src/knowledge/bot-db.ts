import fs from "node:fs";
import Database from "better-sqlite3";
import type { LandingInput, TicketInput } from "./model.js";
import type { RuntimeInputs } from "./sources/landings.js";

interface LandingRow {
  id: number;
  ticket_id: number;
  from_sha: string;
  to_sha: string;
  landed_at: string | null;
  source: string;
  status: string;
  report_path: string | null;
  summary: string;
  changed_files: string;
  changed_modules: string;
  knowledge_json: string;
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Read-only adapter from `bot.db` rows to build inputs. The CLI uses it on a
 * copy or the live file (SQLite readers do not block the bot's writer); the
 * in-process builder receives the same shape from the Store instead.
 */
export function readBotDb(file: string): RuntimeInputs {
  if (!fs.existsSync(file)) throw new Error(`bot.db not found: ${file}`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    // A copied bot.db may predate v86; its tickets simply have no actor kind.
    const actorKind = tables.has("dev_tickets")
      && (db.prepare("PRAGMA table_info(dev_tickets)").all() as Array<{ name: string }>).some((column) => column.name === "actor_kind");
    const tickets: TicketInput[] = tables.has("dev_tickets")
      ? (db.prepare(
          `SELECT id, title, requester, model, kind, dev_status, created_at, landed_at, commit_sha, parent_ticket_id${actorKind ? ", actor_kind" : ""} FROM dev_tickets ORDER BY id`,
        ).all() as TicketInput[])
      : [];
    const landings: LandingInput[] = tables.has("ticket_landings")
      ? (db.prepare("SELECT * FROM ticket_landings WHERE status = 'landed' ORDER BY id").all() as LandingRow[]).map(toLandingInput)
      : [];
    return { tickets, landings };
  } finally {
    db.close();
  }
}

export function toLandingInput(row: LandingRow): LandingInput {
  let knowledge: LandingInput["knowledge"];
  try {
    const parsed = JSON.parse(row.knowledge_json) as Partial<LandingInput["knowledge"]>;
    knowledge = {
      summary: parsed.summary ?? row.summary,
      requirements: parsed.requirements ?? [],
      decisions: parsed.decisions ?? [],
      non_goals: parsed.non_goals ?? [],
      risks: parsed.risks ?? [],
      verification: parsed.verification ?? [],
      context_keys: parsed.context_keys ?? [],
      supersedes: parsed.supersedes ?? [],
      ...(parsed.specifications ? { specifications: parsed.specifications } : {}),
      ...(parsed.changes ? { changes: parsed.changes } : {}),
      ...(parsed.producer ? { producer: parsed.producer } : {}),
    };
  } catch {
    knowledge = { summary: row.summary, requirements: [], decisions: [], non_goals: [], risks: [], verification: [], context_keys: [], supersedes: [] };
  }
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    from_sha: row.from_sha,
    to_sha: row.to_sha,
    landed_at: row.landed_at,
    source: row.source,
    report_path: row.report_path,
    summary: row.summary,
    changed_files: parseList(row.changed_files),
    changed_modules: parseList(row.changed_modules),
    knowledge,
  };
}
