# Sessions filesystem provider

The local MCP, Runner and trusted Bot share this package to discover and read
provider logs. Scan roots are trusted device-local inputs; RPC arguments cannot
choose a filesystem root. Every path uses the same native metadata parser.

## Recent primary-chat working set

The algorithms in this section remain the local MCP/default scanner contract.
The resident Runner now supplies its own shared device catalog and deliberately
refreshes only live/managed/opened sessions; see the
[Runner freshness contract](../../packages/runner/README.md#session-discovery-and-freshness).
Its list path does not enter `listRecentSessions` or the historical sweeps below.

An explicit primary_window on listRecentSessions selects at most 200 primary
chats plus separate allowances of 100 automated runs and 300 declared
children. A run is automated only when Codex says so natively: `source: exec`
or `originator: codex_exec`, which also covers the forks a harness makes with
`exec resume` (recorded as source `vscode`). App-server, TUI and
Octopus-managed chats stay primary. Parent relationships are not inferred
from cwd, titles or launcher names. Legacy listings and complete-history
cursors retain their raw-row semantics. A trusted caller may name exact
`source:id` pairs (`ids`, at most 64) to list chats a person kept that left
the recent window; the device answers only from its own catalog.

Runner supplies an optional, device-local foreground-priority callback outside
the RPC arguments. It sees the trusted inventory before truncation, so a live
tmux session can enter even the first cold window despite newer background
chats. Confirmed foreground rows lead within each quota; activity orders each
tier. Scoped catalogs filter unauthorized files before invoking the callback.
Runtime priority is recalculated on reads and never stored as durable evidence
when a caller uses this legacy scan entry point.

There are two levels:

- directory-cache.ts observes directory entries and bounded file-change hints.
  Directory versions use dev/inode/mtime/ctime. Native watchers accelerate
  detection; directory checks and five-minute re-listing cover missed events.
  Concurrent reads share one flight per directory, so overwrites cannot orphan
  native watchers outside the 4,096-entry cap. Eviction/reset close owned handles;
  a reset generation prevents an older read from installing a late watcher.
- recent-index.ts owns file fingerprints, lineage headers and retained
  summaries. Each pass checks up to 200 retained primaries per provider (then
  up to 100 automated runs per provider within the same 600-file allowance), plus
  four independent 200-file budgets: notifications, unseen files, the last
  48 hours, and a rotating sweep. Old/backdated files are never skipped by a
  time cutoff. Only changed versions need header parsing.

Foreground headers take precedence inside the existing 600 retained-file
checks (at most 500 foreground files); notifications, unseen, hot and fair
sweep budgets stay intact. The combined index pass still checks at most 1,400
files. The legacy foreground callback's Codex discovery compares live file-descriptor
inodes with inventory candidates; that metadata discovery cost scales with
inventory size, while whole-transcript summary IO remains bounded below.

Headers read at most 64 KiB. Child navigation does not read whole transcripts
or pretend a partial message count is complete. Root summaries have both a
200-file and 64 MiB pass budget with concurrency two. One oversized file may
exceed the byte budget so it can make progress; a single whole-log parse is
not constant-time. The cold UI can use native header facts during backfill.

A header supplies a message count only when it covers the complete file;
otherwise the count is absent. Explicit transcript reads still page the full
log. Codex children use their native task/name fields as titles because copied
parent prompts are not child identities. Conflicting native source/parent claims
stay unclassified. Header fingerprints include a parser version so existing
durable caches converge to corrected metadata within the same bounded sweep;
a re-read header also corrects a retained summary's exec mark at once, since
that mark comes from the first record only.

Every known file's fingerprint and compact metadata persist atomically with
mode 0600 in .octopus/session-roster-cache-v1.json. The latest 200 full primary
summaries per provider have a reserved place, and the latest 100 automated runs
a separate one. Compact older facts and child
lineage prevent restart from re-reading unchanged logs. Current directory
inventory validates every loaded path before it enters the working set.
The snapshot has a 64 MiB/100,000-row load bound; if compact facts exceed it,
the full primary reserve takes precedence and other facts backfill after restart.
A missing/corrupt cache rebuilds;
storage failures must not erase in-memory chats. Files remain authoritative.

This is an incremental index, not an mtime watermark. Retained-file checks and
the rotating sweep detect truncation, replacement and backdated modifications
by equality of dev/inode/ctime/mtime/size. Unknown files enter a FIFO queue.
Summary work reserves fair progress before serving the newest candidates.
There is no age-based eviction of primary chats.

Normal refresh costs directory checks, O(N log N) small in-memory index work,
and bounded file IO. It does not promise O(200) total CPU or instantaneous
detection of arbitrarily many new files. Initial inventory is O(N); missed
notifications converge through re-listing and fair sweeps. The 48-hour window
is a check priority, not a retention policy. Absence from the 200-row primary
window is not deletion; complete history remains independently paged.

## Codex list names

These overlays describe the default scanner. The resident Runner applies the
same native names on first discovery, including bounded cold headers, using a
shared bounded cache per home/index version. It refreshes live/opened rows;
existing cold cached names may remain stale until opening.

Recent, primary-window, selected and history lists overlay Codex's native
`session_index.jsonl` names from the discovered file's trusted CODEX_HOME,
matched by exact session id. The latest valid entry wins; empty or missing
names retain the existing provider/prompt fallback. App-owned custom titles
still take precedence. Naming never discovers sessions or changes ownership.

The overlay runs after cached transcript/index reads, so a rename is visible
on the next list read without appending to the transcript. Each relevant home
reads at most the newest 8 MiB of its optional name index, with concurrency
two; older names outside that budget fall back normally. Malformed records,
partial writes and unavailable indexes do not prevent listing. Names are
display text capped at 240 characters and are never written back.

## Rich transcript text

Codex can retain earlier conversation as `response_item` records when a local
session is rewound or forked, then append `event_msg` records for new input.
Flat, summary, search and rich readers keep both forms. Only adjacent prose
with identical role/text from opposite channels is a mirror: keep the first
copy and consume its counterpart once. Native turn boundaries reset this
matching; tools and reasoning remain independent. Unmatched or differing text
is retained conservatively, so a new event cannot erase item-only history.

Codex transcript metadata includes `turn_configuration`, the latest native
`turn_context` model/effort snapshot, for both flat and rich reads. Every context
replaces the pair; missing fields never inherit older turn values. Only bounded
public identifiers survive. No CLI commands or global configuration reads are
used: idle `/model` changes become observable when Codex records the next turn.

Claude's native `isCompactSummary: true` user records are injected continuation
context, so flat/rich readers and activity tracking exclude them just like
`isMeta` records. Raw logs stay intact. Unmarked user prose remains visible even
when it quotes the same compaction preamble; content heuristics do not hide it.

A prompt the person submits while Claude is working has no `type: "user"`
record: Claude writes `queue-operation` lines and, where a turn reads it, an
`attachment` of type `queued_command`. Both readers show a human-origin (or,
in older and SDK logs, origin-less) `queued_command` as a user message at that
position; background-task notifications and other agents' messages carry a
non-human origin and stay out. User text is shown without Claude's
`<pasted_content id=…>` wrapper (`unwrapPastedContent` in
`@claude-bot/agent-sessions-contract`, the same definition the Runner's input
receipt and the View's local echo use to compare prompts).

Rich transcript reads preserve complete user and assistant text blocks. A
per-text prefix cap loses the rest of a long reply permanently and makes later
growth appear unchanged to live tail readers.

The parser keeps every block complete. A PAGE caps thinking (4,000), tool input
(2,000; async questions 32,000) and tool output (4,000) characters, marking
`truncated` and `truncated_fields`; the private page store writes each over-cap
field whole beside its journal (keyed by message, block and field), so a late
tool result rewrites only the small page-form message and that one field.
`read_session` with `offset` + `block` + `field` returns one complete field in
256K-character windows (`next_char_offset`), through the same read authority.

Every read_session window (rich and flat) is bounded by count AND by 1 MiB of
serialized messages, well inside the capability kernel's 8 MiB per-call result
cap after device-local translation. `offset` keeps a window's first messages
(forward: next offset = offset + returned_messages); `before` or the default
tail keeps its last ones (backward: next before = offset). `byte_limited` marks
a window that stopped early. A single message larger than a page carries 16K
text previews, complete through block reads. Flat reads stream the log and hold
only the window.

Rich reads resolve native IDs through a three-second directory catalog keyed by
all trusted scan roots and provider. Only matching copies need file stats;
newest-copy and account-label rules remain the same. Lifecycle invalidation
drops that catalog as well as enumeration facts.

Device-private source cursors share decoded appends between flat summaries and
rich pages. Unchanged files require metadata only; changed files read appended
bytes plus bounded prefix/tail proofs. Incomplete UTF-8/JSON tails wait for
completion; complete records without a newline remain readable. Truncation,
replacement and ordinary non-append edits rebuild. Native logs are assumed
append-only: prefix/tail proofs cannot detect an arbitrary middle rewrite
that preserves both proofs while growing the file.

Summary-only reads retain metadata without copying the transcript. The first
rich read builds a disposable private disk index: an append journal, fixed-width
page offsets and hashed tool-call locators for late results. Only a cloned
requested page leaves it. Cold builds
cost disk writes; subsequent reads no longer retain or parse entire histories.
Node 20 builtins preserve the single-file Runner installation.

The cache separately retains 1,024 summary cursors and 64 rich cursors, so
background discovery cannot evict watched bodies. Each rich cursor retains at
most 128 messages / 2 MiB of serialized body accounting, with older pages and
tool locators on disk. This is not an absolute JS heap limit: current JSON
records, the preceding Codex prose record, incomplete lines, returned pages and unresolved activity-tool metadata
are additional. Disk copies are mode 0700/0600, rebuilt after eviction/restart,
and removed on eviction or normal exit. Abrupt process termination can leave
private temp files until the OS cleans its temporary directory.

A process-wide scheduler advances one 128 KiB source chunk at a time. Live
body demand gets at most three turns before waiting summary work gets one;
every chunk yields to socket IO. Up to 128 source flights/queued chunks are
accepted; overload fails for the existing read retry path. Same-source callers
share decoding and recheck metadata after a concurrent source advance. These
limits bound ordinary parsing work, not the size of a single native JSON record.

## Complete search

search_sessions covers every session a scan root holds, newest first. One call
does a bounded page (result limit and an 8-second budget, at least one file) and
returns `next_cursor` while candidates remain. A cursor is a device-independent
position (mtime, source:id), so every fan-out level forwards the same cursor and
merges with `mergeSearchPages`: only hits every child has searched past are
returned, and failed or pre-paging Runners are named in `incomplete_sources`.
A raw-byte prefilter skips files lacking any query word; candidates are parsed
as a record stream, so memory is bounded by one JSON record. Sessions written to
after the first page move ahead of the cursor (not a snapshot).

## Complete listing

list_recent_sessions without `cursor` stays a bounded recent-activity page
(limit 1-500). A string `cursor` walks every session in the stable `[source, id]`
order (`sessionListCursor`, defined once in `agent-sessions-contract`) that the
scan, Runner index, Gateway and Sessions+ catalog merges already page by; every
device receives the same cursor. The MCP answer carries `next_cursor` exactly
while rows remain (a recent page that is not complete starts the walk at
`SESSION_LIST_START_CURSOR`), and `sessionHistoryPage` ends a full page before
its last position group so a copy on a second device is never skipped. A page
with a failed device or a pre-paging Runner is refused, never advanced.

## Terminal Agent errors

Provider-declared terminal failures appear in the existing chat text projection
with the provider name, a stopped-turn label and up to 4,000 characters of the
native diagnostic. Codex legacy `error` events and terminal `task_complete` /
`turn_complete` / `turn_aborted` error fields, Claude API-error messages / failed
`result` records, and OMP assistant `stopReason: "error"` records feed the same
flat, summary and rich readers. Codex errors do not participate in prose
deduplication and cannot suppress item-only conversation history. OMP partial
output is preserved alongside its error. Terminal events clear outstanding activity tools;
a later user turn resumes the ordinary activity projection.

Codex's native `codex_error_info: "cyber_policy"` additionally supplies a
cybersecurity restriction explanation and the official help / Daybreak
application links. The TUI constructs this notice separately from the persisted
error message, so displaying the message alone can omit that guidance. We retain
the native diagnostic and add missing links after its length cap; we do not infer
Daybreak eligibility, enabled state or model support, or classify errors by text.
The reference is OpenAI's
[Codex TUI notice implementation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/tui/src/history_cell/notices.rs).

Retry diagnostics, explicit Codex retry flags, normal completion and manual
interruption do not become abnormal-stop notices. This is a read-only projection:
it does not retry work or infer a cause from silence, process disappearance or a
Runner disconnect. Errors absent from the native transcript cannot be recovered
by this parser. Existing session authorization, watching and paging still apply.

Codex format references: [terminal events and error semantics](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)
and [durable event policy](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/policy.rs).
Standalone errors are legacy compatibility; current native logs persist terminal
errors on end markers. Native input refusals that do not affect turn status are
excluded from standalone error notices.

## Verification

Run pnpm exec vitest run --project node --maxWorkers=1 plugins/sessions/src
and pnpm --filter @claude-bot/plugin-sessions build.
The recent-index tests cover child floods, restart, backdated import, file
replacement, byte budgets and cache containment.
