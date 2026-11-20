# Research import

A local, explicit-manifest importer for the Research Program App. It reads only
listed sources, emits reviewable action batches and a private coverage receipt,
and validates them against the same domain handlers used by the App. It never
writes a live State database, grants membership, activates a release or invents
human approval. Source roles and dates remain imported claims.

One source project maps to one shared instance. Paths are permitted local input,
never View capabilities. Conversation ingestion excludes tool payloads and
internal reasoning, deduplicates provider event mirrors, and splits long visible
messages without dropping text. The unmodified source stays on disk; the receipt
binds its SHA-256 and lists exclusions, redactions and unavailable files.

`pnpm exec tsx ctl/research-import.ts --plan /private/plan.json --out /private/bundle`
prepares a bundle. `--apply --mcp-config /private/mcp.json` submits the bundle
through the official MCP SDK using an existing Apps token. Apply reads the
frozen actions bound by coverage.json, never the live source directory.
`--restage` revalidates that same frozen bundle with current handlers without
rereading source files; source or target changes require a new reviewed bundle. No retries after a
refusal; offsets and source digests allow an explicit resume after checking the
receipt. Run only after the new research release is active. An archived target
refuses ingestion; it is never silently reopened.

All frozen items are checked before contacting the first target. Checkpoints use
atomic private-file replacement. A transport error, `unknown` or `unavailable`
keeps the call pending: inspect the exact target log and reconcile the checkpoint
before resuming. Only explicit pre-commit refusals permit a corrected resume.
A missing instance can be created through the separately authorized
`app_shared_create`; bind its returned key into a new reviewed bundle. Project
reopening remains an explicit human action.
