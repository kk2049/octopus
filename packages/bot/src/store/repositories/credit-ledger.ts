import type Database from "better-sqlite3";

export const CREDIT_REASONS = ["ticket_earn", "session_spend", "admin_adjust"] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

export interface CreditEntryRow {
  id: number;
  username: string;
  delta: number;
  reason: CreditReason;
  ref_kind: string;
  ref_id: string;
  created_at: string;
}

export interface CreditBalanceRow {
  username: string;
  balance: number;
  updated_at: string;
}

export interface RecordCreditInput {
  username: string;
  delta: number;
  reason: CreditReason;
  refKind: string;
  refId: string;
  createdAt?: string;
}

export interface RecordCreditResult {
  applied: boolean;
  balance: number;
  entry: CreditEntryRow;
}

function bounded(value: string, label: string, max: number): string {
  const clean = String(value ?? "").trim();
  if (!clean || clean.length > max || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return clean;
}

/** Append-only source ledger plus its rebuildable, transactionally exact balance projection. */
export class CreditLedgerRepository {
  constructor(private readonly db: Database.Database) {}

  record(input: RecordCreditInput): RecordCreditResult {
    const username = bounded(input.username, "credit username", 256);
    const refKind = bounded(input.refKind, "credit ref kind", 80);
    const refId = bounded(input.refId, "credit ref id", 240);
    if (!CREDIT_REASONS.includes(input.reason)) throw new Error("unsupported credit reason");
    if (!Number.isSafeInteger(input.delta)) throw new Error("credit delta must be a safe integer");
    if (input.reason === "ticket_earn" && input.delta < 0) throw new Error("ticket earnings cannot be negative");
    if (input.reason === "session_spend" && input.delta > 0) throw new Error("session spending cannot be positive");
    const createdAt = input.createdAt ?? new Date().toISOString();

    return this.db.transaction(() => {
      const current = this.balance(username);
      const inserted = this.db.prepare(`
        INSERT INTO credit_entries (username, delta, reason, ref_kind, ref_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(reason, ref_kind, ref_id) DO NOTHING
      `).run(username, input.delta, input.reason, refKind, refId, createdAt);
      const applied = inserted.changes === 1;
      if (applied) {
        if (!Number.isSafeInteger(current + input.delta)) throw new Error("credit balance exceeds safe integer range");
        this.db.prepare(`
          INSERT INTO credit_balances (username, balance, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(username) DO UPDATE SET
            balance = credit_balances.balance + excluded.balance,
            updated_at = excluded.updated_at
        `).run(username, input.delta, createdAt);
      }
      const entry = this.db.prepare(`
        SELECT * FROM credit_entries
         WHERE reason = ? AND ref_kind = ? AND ref_id = ?
      `).get(input.reason, refKind, refId) as CreditEntryRow;
      // A global idempotency key may never be replayed into another account.
      if (entry.username !== username || entry.delta !== input.delta) {
        throw new Error("credit reference already belongs to a different accounting fact");
      }
      return { applied, balance: this.balance(username), entry };
    })();
  }

  balance(username: string): number {
    const clean = bounded(username, "credit username", 256);
    const row = this.db.prepare("SELECT balance FROM credit_balances WHERE username = ?")
      .get(clean) as { balance: number } | undefined;
    return row?.balance ?? 0;
  }

  list(username: string, limit = 20): CreditEntryRow[] {
    const clean = bounded(username, "credit username", 256);
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 20));
    return this.db.prepare(`
      SELECT * FROM credit_entries WHERE username = ? ORDER BY id DESC LIMIT ?
    `).all(clean, boundedLimit) as CreditEntryRow[];
  }

  /** Administrative repair primitive: erase only the derived cache and replay immutable entries. */
  rebuildBalances(at = new Date().toISOString()): number {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM credit_balances").run();
      this.db.prepare(`
        INSERT INTO credit_balances (username, balance, updated_at)
        SELECT username, SUM(delta), ? FROM credit_entries GROUP BY username
      `).run(at);
      return Number((this.db.prepare("SELECT COUNT(*) AS count FROM credit_balances").get() as { count: number }).count);
    })();
  }
}
