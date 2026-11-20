/**
 * Persisted resource waiters (`resources/recovery.ts`): which agent scope is
 * waiting for which resource to come back. Survives a bot restart so a promise
 * made during an outage is kept even when the process that made it is gone.
 */
import type Database from "better-sqlite3";
import type { ResourceKey, ResourceWaiter, ResourceWaiterStore } from "../../resources/recovery.js";

export class ResourceWaitersRepository implements ResourceWaiterStore {
  constructor(private readonly db: Database.Database) {}

  upsert(scope: string, resource: ResourceKey, detail: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO resource_waiters (scope, resource, detail, count, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(scope, resource) DO UPDATE SET
           detail = excluded.detail,
           count = resource_waiters.count + 1,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(scope, resource, detail, at, at);
  }

  list(resource: ResourceKey): ResourceWaiter[] {
    return this.db.prepare("SELECT * FROM resource_waiters WHERE resource=? ORDER BY first_seen_at")
      .all(resource) as ResourceWaiter[];
  }

  acknowledge(waiter: ResourceWaiter): void {
    this.db.prepare(`DELETE FROM resource_waiters WHERE scope=? AND resource=?
      AND count=? AND first_seen_at=? AND last_seen_at=?`)
      .run(waiter.scope, waiter.resource, waiter.count, waiter.first_seen_at, waiter.last_seen_at);
  }

  take(resource: ResourceKey): ResourceWaiter[] {
    const rows = this.db
      .prepare(`SELECT scope, resource, detail, count, first_seen_at, last_seen_at FROM resource_waiters WHERE resource = ? ORDER BY first_seen_at`)
      .all(resource) as ResourceWaiter[];
    if (rows.length) this.db.prepare(`DELETE FROM resource_waiters WHERE resource = ?`).run(resource);
    return rows;
  }

  listByScope(scope: string): ResourceWaiter[] {
    return this.db
      .prepare(`SELECT scope, resource, detail, count, first_seen_at, last_seen_at FROM resource_waiters WHERE scope = ? ORDER BY first_seen_at`)
      .all(scope) as ResourceWaiter[];
  }

  deleteScope(scope: string): number {
    return this.db.prepare(`DELETE FROM resource_waiters WHERE scope = ?`).run(scope).changes;
  }
}
