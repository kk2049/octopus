# Development knowledge graph (`packages/bot/src/knowledge`)

Rebuildable derived layer over the repository's authoritative knowledge
sources. Design and rationale: `doc/development/2026-08-20-knowledge-graph-redesign.md`.

## What it is and is not

- `graph.db` under `<dataDir>/knowledge/` is a projection. Delete it and
  `buildGraph` recreates it from Git at any commit plus `ticket_landings`.
  Nothing may exist only here; if a fact has no authoritative home, write it
  to `architecture/knowledge/curated/*.jsonl` (reviewed in Git) — never into
  the database by hand.
- Authoritative inputs, read-only: `AGENTS.md`, `.claude/rules`, package
  docs, `doc/adr`, `doc/deliveries`, `doc/cli-reports`, `architecture/atlas.json`,
  `architecture/capabilities.json`, `architecture/knowledge/*` (including
  reviewed capability contracts), and the `ticket_landings` ledger (via an
  adapter; this module never opens the live Store with write intent).
- Statements are ≤ 400 characters and pointers. No ticket bodies, messages,
  transcripts or credentials are stored; `validateCuratedRecord` rejects a
  quote longer than 120 characters.

## Module boundaries

- This module must not import `devpipe`; devpipe imports it. Git access is the
  local `git.ts` wrapper; `moduleForPath` is a deliberate copy of the
  Observatory's longest-prefix rule (the Observatory is a separate package
  consumed by child process).
- `sources/*` each read one authority and emit nodes/edges with `method` and
  `certainty`. `build.ts` merges ids, folds only global statement kinds,
  applies `supersedes`, rejects invalid contract domains, drops unrelated
  dangling legacy edges, runs `conflicts.ts` and measures coverage. Contracts
  use local-key identity and project normalized matrix/observation rows.
- `retrieval.ts` is the only query surface: typed capability/contract
  classification, path-anchored expansion over an allow-list of exact edges,
  lexical FTS, pinned local vector similarity, exact-SHA code evidence and
  deterministic reranking. `context-pack.ts` assembles the same eight bounded
  slots for ticket startup, path refinement and CLI callers, always with an
  explicit unknown/conflict/staleness section. Every statement line ends with
  `⟨id⟩`, the only thing `context_keys` / `supersedes` accept.
- Rule globs anchor to the directories they actually match
  (`sources/rules.ts#anchorPrefixes`): `packages/agent-*/**/*` becomes one
  anchor per matching package, never `packages/`. The static prefix once made
  the App and resource-binding rules govern every dashboard diff.
- `submitDigest` is what a submit is told about touched knowledge: only
  standing non-goals the submitted requirements overlap lexically, excluding
  the ticket's own earlier landings. Constraints are enforced by their
  evidence tests and principles are on demand; neither is a checklist the
  agent echoes back (the first version listed 130+ ids per submit).
- The devpipe owner (`devpipe/knowledge-graph-service.ts`) rebuilds the graph
  in a child process running this module's CLI. It also exports only canonical
  privacy-filtered contextual records. `devpipe/knowledge-artifact-service.ts`
  sends that immutable exact-SHA input through the authenticated Runner,
  validates the returned code/model/vector/conformance manifests and record-set
  digest, rebuilds the graph with the matching code index, then atomically
  activates local read-only handles. Query serving never depends on val15 being
  online. `cli.ts context` remains the off-ticket human/CLI twin.

## Invariants to keep

- Build is deterministic for identical inputs; `build.test.ts` asserts a
  rebuild is equal node-for-node and edge-for-edge.
- Curated ids are `cur:<batch>:<ticket>:<n>`; landing statement ids reproduce
  the 2026-08-19 `knowledge_records` keys so `supersedes` keeps resolving.
- Always-on principles are in the graph but excluded from packs.
- A missing pattern test or stale path is a coverage/conflict entry, never a
  landing refusal.
- `graph.db` schema v2 is disposable. Readers return no graph for v1 so the
  owner rebuilds; there is no in-place migration.
- Exact contract artifact evidence is admitted only from a code index whose
  Git SHA matches the graph baseline. Missing indexes are `unverified`; SHA
  mismatches are `stale`.
- Landing/CLI statements never inherit every changed path/module, and delivery
  negatives never inherit every key file. Keep landing/doc `touches` and use
  authored `realized_by` / `verified_by` bridges for exact semantics.
- Remote builders never receive `graph.db`, bot databases, ticket bodies,
  transcripts, credentials or private absolute paths. Contextual input,
  code/vector manifests, and the activated graph all bind the same exact
  repository SHA and canonical record-set digest; mismatch is fail-closed.
- Vector identity is pinned by model id, immutable revision, ONNX SHA,
  dimensions, dtype, normalization and distance. No network model fallback is
  permitted during query or artifact activation.

## Human-facing projection

`packages/bot/src/dashboard/knowledge.ts` (`/knowledge`) reads the same
`graph.db` read-only and adds the review ledger (`knowledge_reviews`) for
conflict candidates and ambiguous records. It is a projection: it groups and
counts and never writes the graph. Explicit authenticated administrator design
approval records an immutable, fingerprint-bound deployment receipt; it does not
change a statement or upgrade its evidence. New human evidence in Git must be
verified against the original source by both landing doors. Three evidence tiers
and required investigation fields are defined in architecture/knowledge/README.md.
Landings may add optional `specifications` entries (#522: record only; none or
a subset never refuses): original provenance, computed strength and exact
implementation/test files. `specifications.ts` projects those authored bridges
from the immutable ledger;
legacy payloads retain their original weaker attribution. Both ticket and CLI
admission share `devpipe/knowledge-specifications.ts`; no vector builder is
needed to validate evidence or candidate-tree file existence.

## Focused verification

```bash
pnpm exec vitest run packages/bot/src/knowledge packages/bot/src/devpipe/knowledge-graph-service.test.ts packages/bot/src/devpipe/knowledge-artifact-service.test.ts
pnpm knowledge:validate
pnpm knowledge:build -- --out /tmp/graph.db && pnpm knowledge:report -- --graph /tmp/graph.db
```
