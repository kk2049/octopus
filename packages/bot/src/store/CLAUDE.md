# Persistent store

The Store is the SQLite persistence boundary for users, sessions, grants,
operations, tickets, releases, and deployment state. The schema and current
column list live in `migrations.ts`; do not duplicate them in this instruction
file.

## Migration rules

- Append a new monotonic migration version. Never edit the meaning of a
  migration that may already have run in production.
- A migration is transactional and restart-safe. Schema version advances only
  after all statements for that version succeed.
- Add focused migration tests that open an older fixture, upgrade it, and prove
  both retained data and the new invariant.
- Do not use a foreign key when the referenced identity is intentionally
  outside this composition or has a different lifecycle; document that choice
  in the migration.

## Data and authority boundaries

- Stored grant intent, publisher trust, route capability bits, and live
  capability handles are different things. A database row does not itself
  grant runtime authority.
- Sessions+ split-session catalog rows are positive owner-scoped provenance,
  not scan permission by themselves. Dispatch must re-check any shared runtime
  permit, and the Runner must correlate the selected row with local placement
  evidence before reading a transcript.
- Preserve owner/account scoping in every query. Cross-user reads and writes
  use different authorization predicates before reaching the Store.
- Secrets and bearer values are stored only as documented hashes/handles. Do
  not add plaintext credentials to rows, logs, audit messages, or fixtures.
- Durable operation state must distinguish `unknown` from `failed`; the Store
  must not erase uncertainty created by an interrupted external side effect.
- Timestamps used for ordering or recovery are written at the state transition
  they describe, not inferred later from row ids.

## API and transaction rules

- Keep SQL and row mapping in the Store layer. Callers receive typed domain
  rows, not statement handles or SQLite-specific values.
- Multi-row state transitions that must be observed together use one explicit
  transaction. Do not rely on sequential autocommit statements.
- Close prepared statements/database handles on shutdown so the next process
  can acquire the writer lease.
- Lists have deterministic ordering and bounded limits. Pagination/filtering
  must not silently change which owner's rows are eligible.

## Focused verification

```bash
npx vitest run --project node --maxWorkers=1 packages/bot/src/store
```

For security rationale involving grants and operation recovery, also read
`doc/handover-security-migration.md` and `doc/tcb-reading-guide.md`.
