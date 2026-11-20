# Octopus Runner

## Owner file links and terminal observations

`access_owner_files` supports `stat` (an absolute path) and `resolve` (a
server-bound session source/id plus a link). Ordinary relative links use the
session's metadata cwd; split sessions use the durable execution workspace on
the receiving device. Resolution reads only a bounded metadata prefix and stats
the target, without registering or enumerating workspace roots. The OS user is
the owner-read boundary. Shared callers retain the separate workspace operations
and their realpath containment checks. The service and Runner must both support
the new modes before activating the updated Sessions+ view.

Codex daemon observations provide turn state and native protocol capabilities.
An exact live hook process plus its tmux pane can additionally provide the
terminal badge, including on hosts without `ss`. This presentation evidence
does not grant terminal injection, takeover or interruption. A process exit,
PID replacement or session switch invalidates the hook association.

## Durable managed completion receipts

The Runner writes content-free managed turn completion receipts under
`SCAN_HOME/.octopus/managed-completions` before publishing them. Atomic replacement
and fsync preserve them across restart. After an authenticated site registration,
the newest 4,096 receipts that site has not acknowledged are replayed. The Head
acknowledges a receipt once every receiver handled it; markers are per site and
bounded to the replay window. Receivers still deduplicate exact turn IDs, since an
acknowledgement can be lost and older Runners ignore it. The Head's owner notice
is keyed by receipt identity and sent only within an hour of completion, so a
reconnect never repeats it. Older receipts remain on disk for local diagnosis. This journal contains turn
status/usage and identity, never prompts or provider credentials. A journal write
failure is logged and still permits best-effort live delivery; replay then cannot
be promised for that completion. Research v2 uses these receipts to distinguish
an accepted input from completed work.

## Ticket chat

Ticket agents use the ordinary managed session control plane. The deprecated
Head executor is closed to production calls; missing Runner configuration is
an explicit refusal. `get_session_operation` advertises `live_input:
"steer-only/v1"` for updated devices. `append_session` with `steer_only: true`
may append to the attached active turn but cannot resume an idle session or
launch a replacement controller. It retains the existing split execution relay.
The Head checks this capability before new turns, persists each input operation
and queries its original receipt after an uncertain response. Stop and continue
retain the ticket's session, workspace and unsent messages.

One resident process owns a machine's session registry, provider hosts,
workspaces and terminal leases. It may connect to multiple Octopus sites.
Each connection has its own token, peer RPC client, execution relay, DSH
tunnels, session projector and reconnect timers. Replies stay on the socket
that submitted their request. Local session changes feed all connected sites.

The existing installed `runner_url` remains site `primary`. Add another site
without reinstalling the Runner or replacing that connection:

```bash
octopus-runner sites updates none
octopus-runner sites add mirror --server https://192.0.2.10:444 --token-file /private/mirror-token
octopus-runner sites list
```

The daemon applies configuration changes within five seconds. Tokens live in
private files under `.octopus/runner/sites`; they are never printed by the CLI.
A snapshot mirror can accept the same device token only because its backend
contains the corresponding token record. Unrelated deployments must issue
their own credential. Removing a site disconnects it locally; revoke its token
at that site separately when access should end permanently.

`control_site` (default `primary`) owns ordinary local Agent MCP injection,
GUI policy and knowledge jobs. Secondary sites still use the shared managed
session plane and their own scoped execution relay. `update_site` names exactly
one source of Runner builds; `none` pins the current build during validation.
Both automatic updates and `octopus-runner update` respect that choice.
The process-wide `RUNNER_SELF_UPDATE=0` also disables automatic updates.

For a later cutover, after tasks are drained and backend state is reconciled:

```bash
octopus-runner sites control mirror
octopus-runner sites updates mirror
octopus-runner sites disable-primary
```

Keep the stable site ids for recovery records. Reverse the transition with
`sites enable-primary`, `sites control primary`, `sites updates primary`.
Changing control disconnects existing ordinary MCP leases; perform it while
tasks are stopped. This is not required merely to add a mirror connection.

Provider credentials, Codex homes and provider processes are not migrated by
these commands. A Runner binary update may restart Runner-owned provider
hosts and use the existing recovery journal; perform the initial upgrade only
after checking for active managed work. Detached CLI/TUI sessions are separate
processes. Never promise their process identity from a recovery journal alone.

Focused checks (build first for the real two-gateway process test):

```bash
pnpm --filter @claude-bot/runner build
pnpm exec vitest run --project node --maxWorkers=1 packages/runner/src/gateway-sites.test.ts packages/runner/src/gateway-sites.integration.test.ts packages/runner/src/managed-recovery.test.ts packages/runner/src/agent-control-plane.test.ts
```

Operational procedure: [mirror migration](../../doc/runbooks/mirror-migration.md).

First-party compute providers use the existing authenticated inventory and
capability grants. The gateway projects `providers` from each current report:
`workspace` requires shell and workspace-file support; `knowledge-index`
requires the exact `knowledge-index-jobs/v1` protocol and transfer limits.
Discovery is automatic and owner-scoped. It does not grant access, choose a
different machine, or turn ordinary workspace commands into durable jobs.

The resident re-probes installed backends every 60 seconds. One failed or
timed-out re-probe keeps that backend's previous facts (availability, version,
split capability) for the refresh; a second consecutive failure is reported, and
a missing or untrusted executable is reported at once. A transient slow
`codex --version` therefore no longer flips Codex `split_execution`, which hid
the source from `split_only` shared pools. The version is the first output line
that names one. The gateway validates each inventory segment on its own.

Codex availability first checks `login status`. If it fails, a bounded native
`account/read` probe on the same selected CLI and environment also accepts a
provider reporting `requiresOpenaiAuth: false`, or a recognized API-key/ChatGPT
account. Custom config/API providers therefore need no unrelated OpenAI login.
The probe sends `refreshToken: false`, starts no thread or model request, and
reports only availability; it never projects config, credentials or account
details. Invalid, unsupported or failed probes retain the authentication refusal.
This checks local launch prerequisites, not upstream key validity or quota.

Development workspaces advertise `workspace_development` separately from generic
workspace support. Linux Runners with machine operations, Git and `timeout`
available enable `workspace-development/v1` by default; set
`RUNNER_WORKSPACE_DEVELOPMENT=0` to opt out. Each authenticated site/repository
gets a source mirror under the chosen registered root, and each ticket gets a
persistent child worktree. The Runner never writes the Head watermark.
Synchronization preserves dirty files and unfinished Git operations; only a
clean, completed Git state can export an immutable candidate for Head checks.
The child inherits parent revocation and is visible only through the bound
site's workspace operations. Generic inventory lists registered parent roots.
See [the development workflow](../../doc/runbooks/development-workflow.md) for
submission, synchronization and recovery.

An execution-only Linux Runner can enable the fixed knowledge builder with
`RUNNER_EXECUTION_ONLY=1 RUNNER_KNOWLEDGE_INDEX=1`, machine operations enabled
and a writable `/work`. This opt-in exposes no model host, provider login,
local MCP or DSH. Knowledge jobs remain restricted to the control site.
`selfhosting.knowledge_index.runner` can bind its own owner/device/checkout;
omitting it preserves the existing CI target. Drain and reconcile existing
jobs before changing placement: a new device cannot recover another device's
durable job directory. Completed artifacts remain in the service's existing
verified generation store.

## Subscription usage and explicit account pools

The Runner reports its local Claude aggregate 5-hour/week usage and reset times
alongside Codex accounts in the existing authenticated inventory. The Dashboard
uses these device reports in Runner-ticket mode; it does not read Claude credentials
on the Head. Both providers retain independent measurements and failure states.
The Claude probe only reads the local OAuth access token, never refreshes it, and
sends only percentages, reset timestamps and availability to the Head. It honors
`CLAUDE_CREDENTIALS_PATH`, then `CLAUDE_CONFIG_DIR`, then the scan home's `.claude`.
Each read settles on the probe's own 8 s deadline even if `fetch` ignores its abort
signal. Gateway registration reuses the newest completed inventory instead of waiting
for a refresh in flight, so a hung probe can delay fresh facts but never take the
device offline.
Execution-only devices do not read provider credentials. Old Runner reports remain
valid; they need an upgrade before their Claude quota appears.

By default, Codex account homes are discovered at Runner startup. To select an
exact active pool while retaining retired logins and history locally, set
`RUNNER_CODEX_ACCOUNT_DISCOVERY=0` together with a nonempty
`RUNNER_CODEX_ACCOUNTS` JSON map. Only that map is used for new-session routing
and public account registration, including explicit slot IDs for every row.
The legacy `CODEX_HOME` and its split-session root may stay unchanged for existing
session recovery; neither is implicitly added to the active pool in this mode.
Update server-side shared-pool account slots to match the new advertised IDs.
A normal Runner restart applies the pool. Do not copy credentials between accounts,
repoint an existing split home to another login, or remove retired history.

## Session discovery and freshness

One device-owned `SessionObservationIndex` serves all site connections. Ordinary
list requests read cached metadata; they do not enumerate provider directories,
stat every historical transcript, parse old conversations, or discover processes.
Primary windows merge the live set with a cached history order: 200 chats, a
separate 100 automated runs (Codex `exec`, including harness forks recorded as
`vscode` with `originator: codex_exec`) and 300 declared children, so an `exec`
burst cannot evict the chats. The pushed roster projection carries that whole
window (at most 600 rows). An exact `ids` selector answers only those chats
from this catalog, for a trusted caller looking up kept chats outside the
window. Identity cursors seek an ordered metadata index. Explicit time filters
may examine historical metadata; newly discovered/opened history can rebuild
that order. Initial inventory and journal restore still scale with the number
of files.

Freshness is deliberate:

- Every proven live tmux CLI remains observed, including detached sessions and
  panes in copy mode. One two-second process/pane snapshot serves the device.
  Legacy Codex discovery proves the native root thread and live file inode.
  Native shared daemons instead expose loaded TUI root threads over their
  private account socket; only trusted ordinary transcript paths are admitted.
  A single loaded thread with one reciprocal kernel socket peer in tmux gets
  the tmux display attachment. Ambiguous fan-out keeps a daemon attachment.
  Neither daemon observation grants process signals, takeover or terminal input.
  Discovery never uses all history as candidates. Claude lifecycle hooks and
  OMP native breadcrumbs retain their identity protocols.
- Runner-managed attachments register native transcript paths directly, so new
  Codex sessions do not wait for historical directory reconciliation. Provider
  events retain the path after a short turn detaches and coalesce by native id,
  with a two-second recovery check. Unchanged transcripts use
  metadata only; changed logs share the incremental summary cursor.
- Opening/subscribing to a historical chat refreshes that exact identity.
  Native file-change notifications also refresh their exact ordinary log even
  without process visibility. Silent historical changes without notifications
  may remain stale; list requests still never scan or stat old logs.
  Closing the subscription releases its polling demand.
- A bounded cold header read reports no `activity`, completion, sort time or
  message count: they describe the end of the log, which such a read cannot
  see. Its `last_activity` is the file's mtime, which every append moves, not
  the last record the header happens to show.
- First discovery overlays existing Codex native names even on bounded cold
  headers. One bounded title-index read is shared per home/file version, so a
  large developer header before the first user message does not hide its name.
- Journal rows written before the `originator` rule are reclassified once in
  the background (eight per quantum) from their first record only; a complete
  summary keeps its counts and dates. The work reports `index_pending`.

Hooks admit new identities; native known-file notifications refresh only their
exact ordinary log. Codex root discovery retains canonical historical roots but
only probes live/configured roots during ordinary polling. The ordinary default
Codex home receives the same lightweight hooks as configured account homes.
Conventional `.codex-accounts/account-X` directory aliases are explicit local
read registrations, including migrated homes outside the scan home. Their
canonical session directory must remain inside that account, and private split
homes remain excluded. Removing/repointing an alias replaces its indexed root.
This does not add credential routing, cross-UID process discovery, daemon socket
access, or terminal control. Arbitrary outside-home process discoveries remain
excluded.

Custom root discovery requires an observable live process or registration;
there is no guarantee for a short-lived, hookless process in an unknown root.
Likewise a CLI with no native session/process proof cannot acquire terminal
authority from a guessed cwd or timestamp. Writes always revalidate process,
file and pane identity even when read-only observations are cached.

Startup/reconciliation advances one device-wide flight every 500 ms, at most
32 directory listings, eight exact changed-log reads and eight bounded new
headers per quantum, with a 20 ms soft
deadline between operations. At most 8,192 directory watchers are owned, without
evict/recreate churn. A rotating eight-directory check every two seconds covers
absent roots, changed directory identities, lost notifications and watcher
exhaustion. Recovery latency therefore grows with directory count; normal known
directory notifications and hooks are the prompt path. The coalesced native-change queue holds at most 500 paths; overflow drops the
oldest hint, while explicit opens and live observation retain their recovery
paths. Private split notifications alone never authorize parsing. Historical
file changes are not a sweep target. Empty logs retry; oversized first
records can still expose a minimal identity without whole-log parsing.

Private mode-0600 journals `.octopus/session-observation-v1.jsonl` and
`.octopus/session-observation-split-v1.jsonl` restore metadata across restarts.
They are disposable native-log projections, never authorization. Restore has a
128 MiB input limit; individual records are at most 64 KiB, and every 10,000
updates compact through one serialized writer. Missing/oversized/corrupt state
backfills in the background; `index_pending` identifies incomplete inventory.
The first deployment uses this cold path. Historical metadata occupies O(N)
memory; transcript buffers retain the separate sessions-package bounds.

The split index discovers names without parsing unselected private transcripts.
RPC catalog provenance is checked before selected reads. Managed attachments
may update their own private rows, but every projection still filters by its
authorized ids. An indexed path must pass current root/symlink proof on open;
ordinary observation excludes the private split corpus.

Live session projection follows each authorized subscribed native identity with
a 1.5-second metadata-only check. Hook, runtime and interaction changes name
one provider/session; roster reconciliation does not invalidate every body.
Unchanged metadata sends a small `transcript_checked` frame referencing the
last full content sequence. The Bot renews only that exact epoch/sequence,
without changing the content revision or waking views. Missing checks still
expire the watched cache after five seconds. Older Bots ignore the new frame
and retain their existing expiry/read fallback.

Every ten seconds the observer re-resolves trusted root/account identity.
Release, socket close and projector replacement stop the timer; callbacks
cannot reactivate a released generation. The 64-resource subscription bound
also bounds these observers. Body reads share the plugin's incremental source
cursor and fair chunk scheduler across connections. Repeated body invalidations
coalesce for 250 ms, including trailing work. Identical content sends only a
checked frame; subscribing again always forces a full frame.

Hook installation extracts a small private `hook-reporter.mjs` that imports
only Node builtins. A hook no longer loads the full Runner bundle. The helper
preserves reporter PID evidence, bounded IPC, native blocking Claude replies,
Codex Stop JSON and fail-open behavior. Automatic `RUNNER_AGENT_HOOKS=install`
refreshes existing marker-owned hooks on startup, writing (and backing up) a
file only when its content changes; manual installations require `hooks
install`, and `off` removes the marker-owned hooks and launcher at startup.
Stop, restart and self-update leave every integration installed; only
`octopus-runner uninstall` removes them, from every Codex account home. Codex may require trust review for the changed command. User
hooks remain intact; the legacy `hook report` entry remains compatible.

### Read-only observer devices

A Runner started with `RUNNER_ALLOW_MACHINE_OPS=0` lists and reads sessions and
answers snapshot anchors; sending, starting, forking, shell, files, relays and
GUI are refused in `core.ts` before any work. Its inventory then carries
`read_only: true`, and the Head shows its sessions read-only: cards have no
composer, fork or speakers.

To observe another Linux account's Codex sessions without touching that
account, run a second Runner as the observing user, with its own root:

- `HOME`, `RUNNER_SCAN_HOME` and `XDG_RUNTIME_DIR` point into a private
  directory (mode 700), so the token, sockets and instance lock never meet the
  main Runner's; `CODEX_HOME` is an empty directory there.
- `<root>/.codex-accounts/account-<x>` is a symlink to the observed `.codex`. An
  alias is a read registration (above): no hooks, no credential routing, and a
  Codex daemon socket owned by another UID is refused.
- `RUNNER_AGENT_HOOKS=manual` and `RUNNER_LOCAL_MCP=manual` write nothing into
  any agent home; also set `RUNNER_SELF_UPDATE=0`. Leave account discovery on:
  it only admits roots inside the private root, and turning it off requires an
  explicit `RUNNER_CODEX_ACCOUNTS`.
- Without hooks every observed log is read header-first, so the roster dates it
  by its file's mtime until it is opened (below).
- Use its own device name. The observed account must not be able to read the
  private root, and file permissions are what keep the observer from writing
  the observed home.

## External Codex input

Appends first resolve an exact provider/session identity through the resident
session observation index, using its current root/symlink checks and the launch
journal's ordinary/split corpus selection. Caller paths and account roots cannot
select a target. Unindexed/partial ids retain catalog lookup as a fallback.
This keeps old worker-home inventory out of the indexed input path.
Identity and cwd come from at most 1 MiB of complete header records, shared with
attachment destination resolution. Continuing a large session never reads its
entire transcript into a JavaScript string. An oversized first record fails
before input instead of guessing its metadata.

Managed appends may repeat the model/effort used to open the active attachment;
that is ordinary steering, not a configuration change. A different or unproven
selection still fails before dispatch. Durable receipts preserve those explicit
refusal codes as `failed`; transport loss remains `unknown` and is never replayed.

Each actual append dispatch emits one content-free `session_input_perf` JSON
line correlated by RPC and durable operation id. Monotonic timings separate
root refresh, indexed/catalog resolution, transcript read/parse, admission and
account lock waits, process discovery, queue RPCs, revalidation and helper close.
`total_ms` covers Runner dispatch, not Head acknowledgement, CLI consumption or
model response time. Queue `duration_ms` now measures helper admission/close
instead of a constant zero. Prompts, paths, transcript and errors are not logged.

A legacy independent Codex CLI receives appended prompts through its native local
queue. Runner uses the session scanner's exact `CODEX_HOME` and full thread UUID,
probes `thread/queue/list`, reads thread metadata, and rechecks the original CLI
process before one `thread/queue/add`. It never resumes a second writer. The
receipt reports `local_queued` with `queued_submission_id`; queue admission does
not prove the original CLI has consumed the input or completed a turn. A CLI
that exits after admission leaves the input queued until it resumes.
This queue starts a future turn; it cannot steer an active turn. The receipt
states that distinction instead of suggesting the current task will consume it.
The chat receipt stays visually pending until provider acceptance or input
observation; local queue admission does not claim only transcript sync remains.

Native shared-daemon TUIs reuse that daemon's initialized Unix WebSocket
connection for direct input. Socket owner/mode/inode, daemon process
identity and account, loaded root thread and transcript path are checked before
admission. An active thread uses a bounded latest-turn read and `turn/steer` with
that exact `expectedTurnId`, so input reaches the current turn at a native safe
boundary. An idle loaded thread uses `turn/start` on its existing writer, without
configuration overrides. The native acknowledgement records `provider_accepted`
and the returned turn id; acceptance is not proof of model consumption/completion.
This path does not spawn/resume a writer, change model/permissions,
answer approval prompts, or acquire the shared process for takeover. Unknown
input outcomes never replay or fall back to queue/tmux. A missing current turn,
pending approval, changed identity or explicit native refusal returns a failed
send, retaining its reason. An unhealthy daemon endpoint fails closed.
The thread's `originator` is attribution, not a client-ownership proof: the
daemon can persist its first observer's name even for a later real TUI. Input
uses the loaded user root, `canAcceptDirectInput` and exact native identity.

For legacy independent CLIs, only an explicit unsupported queue method on the
read-only probe enables tmux append. A shared daemon never uses that fallback.
Other setup failures and uncertain submissions never replay
through another transport. GUI follower IPC, cooperative remote TUIs, managed
app-server turns, model selection and Stop retain their existing boundaries.
Queue observers serialize startup within the same home; account roots remain
separate. Parent-owned children that refuse direct input must use their parent.

The desktop follower accepts state stream versions 11 and 13; its control
requests retain their independent versions. It projects only session/turn
identity, status and error from canonical history or legacy turns, requiring
continuous revisions. Unsupported versions during connection preparation fail
with `codex_gui_protocol_unsupported` and explicit not-sent evidence. The same
error after dispatch cannot imply that input was not sent; lost acknowledgements
remain unknown, and existing acceptance receipts survive later stream failure.
No protocol error enables CLI fallback or replay. See the
[v13 compatibility evidence](../../doc/worklogs/2026-11-15-codex-desktop-protocol.md)
for the exact upstream artifact, regression scope and pending Mac acceptance.

The complete continuation route and receipt matrix is recorded in
[the input-routing review](../../doc/deliveries/2026-09-28-session-input-routing.md).

## Session operation evidence

Split Codex execution resolves the selected registered account to its own
config-isolated app-server. Each account has a stable native state directory
beneath the private split corpus; the default account retains its existing
directory. A shared endpoint never receives a per-attachment `CODEX_HOME`
override. Recovery records retain the selected native home, and unknown account
roots refuse execution instead of switching credentials. Hosts start lazily and
share only within one account; resident shutdown terminates every owned host.

Host-authorized ticket/Sessions+ transcript reads include these account homes,
with specific nested roots resolved before the legacy default corpus. Ordinary
session discovery still excludes the entire private split corpus. User MCP,
plugin, skill and instruction configuration is not imported into account hosts.

A durable receipt is `unknown` only when the input, stop or release may already
have reached a transport. A refusal raised before the handoff (validation,
placement, expired execution credentials), an explicitly coded or tagged
not-sent refusal (busy session, duplicate terminal send, changed CLI) and a
provider's own rejection are `failed` with their reason; an uncoded one carries
`input_not_sent`.

`start_session` and `append_session` accept an optional durable `operation_id`.
The `session-operation/v1` receipt's top-level `state` remains the provider turn's
completion, including for ticket callers. Ordinary Sessions additionally request
`input_receipt: true`; an optional `input` object records terminal dispatch,
local queueing, provider acceptance or native input observation on the same row.
No operation id retains the legacy RPC result contract.

A per-provider-session admission latch orders distinct cold inputs until their
input transfer completes, then allows the next message to steer the same managed
session. It does not hold the session lock for the whole model turn. Completion
still owns the split MCP proxy and exec relay lifetimes.

The exec relay is a transparent proxy: each Codex environment connection maps
to its own upstream connection to the same `codex exec-server` process. When a
relay hop fails (for example a Head restart), Codex reconnects and resumes its
exec-server session; the runtime Runner then asks the execution Runner for
`codex_exec_reconnect`, which replaces the upstream connection and bumps a
generation so a superseded long-poll can neither steal nor deliver the new
connection's frames. An execution Runner without the method keeps the earlier
behaviour: the reconnect is refused and the environment ends.

Managed launches persist their exact native session id as `prepared` before
sending the first input. Receipts expose that id while acceptance is pending;
identity alone does not claim that the input was accepted. Codex `turn/start`
uses the managed lifecycle budget (the resident uses no wall-clock deadline),
and matching native start/completion notifications can acknowledge the original
send without a second dispatch. Thread setup remains separately bounded.
Stop during startup queues an interrupt for the eventual native turn; a failed
interrupt leaves that accepted turn observable and available for another Stop.
Transport loss remains unknown and never authorizes input replay.

The private launch journal atomically stores the managed exit and a bounded
copy of its reply (last 80,000 characters), duration and usage before notifying
the operation observer. `get_session_operation` can recover this exact result
after observer loss. Old records remain readable; credentials and prompts are
not added to the journal, and native transcript capture remains authoritative.

A launch RPC timeout never authorizes another launch. Detached launch output and
exit captures remain private and bounded; the resident observes the original
request for up to 30 minutes, and `get_session_operation` can reconcile those
captures after restart. Session identity comes only from that launch's native
output/journal, never a cwd, title, or a nearby session. Tmux remains an interactive
transport; a terminal write alone is not proof that the provider consumed input.

A Claude Code TUI is the exception that supplies its own proof: Claude records
every input it accepts in the session transcript. Before pasting, the Runner
marks the transcript's end; after Enter it reads only what Claude appended and
matches the prompt (ignoring whitespace and the `<pasted_content>` wrapper Claude
puts around long pastes). A human-origin `user` record (idle) or `queued_command`
attachment reports `input_observed`; a `queue-operation` enqueue (Claude busy)
reports `local_queued`; both carry evidence `transcript`. A pane redraw no longer
counts. Without a record within six seconds the receipt stays `unknown`, and the
Runner keeps reading the transcript for 30 minutes (while the Head still asks):
if the message turns up — for example after the owner presses Enter in the CLI —
it is recorded on the original receipt. Nothing is ever resent.
Claude's cross-session socket (`/tmp/cc-socks/*.sock`, used by SendMessage
between local sessions) is deliberately not used: Claude frames such input as a
message from another session rather than from its user, and holds it for
approval in sessions that bypass permissions.

Workspace association reads validate distinct cwd strings once per request
with at most four concurrent directory checks. Root/symlink liveness is still
checked anew on each request. Terminal availability overlaps the independent
roster/association read. Registered-root first paint remains coupled to that
complete association response; splitting it requires an explicit partial
association contract, rather than returning an empty complete join snapshot.

`session_anchor` names a Claude or Codex session's last completed turn (Claude:
the last main-chain `end_turn` assistant record's uuid; Codex: the last
`task_complete` turn id) and that record's timestamp, read backwards from the
end of the transcript. `fork_session` writes a new session holding the
conversation through such a turn — `anchor`, or the last completed turn —
with each CLI's own fork: the Agent SDK's `forkSession` for Claude, app-server
`thread/fork` with `lastTurnId` for Codex. It runs nothing and never touches the
source; the first message reaches the branch like any message to an idle
session. Both are dispatched by the Head's separate `session-branch` capability
Object; `fork_session` is a machine write.

`list_session_workspaces` with a `path` (absolute, `~/…`, or relative to the
named session's metadata cwd) answers one question instead of listing: which
navigable registered workspace holds that path after symlinks, and where inside
it (`placement: {workspace_id, relative_path}`, or `null` with `not_found`,
`outside`, `no_cwd` or `unavailable`). The absolute path is never returned; the
Head authorizes by workspace and reads through the confined workspace methods.
It follows the roster's machine-op gate, since it probes a path's existence.

## Automatic continuation and transcript authorship

“继续执行” can be Runner-generated input. After a restart, the managed recovery
journal identifies previously acknowledged active turns and the control plane
resumes them with this default prompt (or the session's configured Codex text).
A Claude recovery with recorded background tasks
instead includes an explicit `[Octopus 重启续接]` roster. Idle or explicitly
stopped turns are not revived, and an uncertain dispatch is not automatically
replayed. The Codex capacity policy below is another source of the literal prompt.

These continuations use the provider's ordinary user-input channel. Sessions+
renders transcript `role: user` as “你”; that label identifies the conversation
role, not proof that a human typed the text. Neither the role nor the wording
alone distinguishes recovery, capacity continuation, manual input or an
authorized agent's message. Opening a session or refreshing its roster is a
read action, not evidence of sending this prompt.

To investigate one occurrence, correlate its exact session/device and timestamp
with Runner recovery logs, the private `SCAN_HOME/.octopus/managed-recovery.json`
ledger and any original input-operation receipts. The ledger is mutable lifecycle
state, not a complete input audit; completed local entries can be removed.
Missing recovery state therefore does not prove manual authorship. Do not relabel
historical messages by matching “继续执行” alone. See the bounded evidence in
[ticket #834's investigation](../../doc/worklogs/2026-11-20-session-continuation-origin.md).

## Codex capacity continuation

Runner-owned Codex App Server turns (including development tickets and split
placement) share one bounded continuation policy. Only a terminal failed turn
with native `serverOverloaded` qualifies; old servers may use the exact selected
model-at-capacity message. Native `willRetry: true` remains Codex-owned.
Authentication, quota/rate-limit, transport uncertainty, GUI/TUI bridges,
parent-owned children and `/compact` are not retried by this policy.

The original operation stays pending while Runner waits 30/60/120/300/300/300
seconds, at most six continuations within a fixed 30-minute window. Each sends
only the session's configured continuation text (default “继续执行”) on the same attachment: no original task prompt replay, model/account fallback
or permission change. Stop and explicit manual continuation cancel the timer.
The public runtime publishes `waiting_capacity`, attempts and the next time;
ticket and session chats render these server-owned facts.

The existing private recovery journal stores the budget and original native
turn correlation, not prompts or credentials. A planned restart drains writes
without reporting a false completion. Acknowledged capacity waits resume with
the saved selection and fresh split scope; dispatch ambiguity becomes unknown.
The original durable operation receipt observes that exact recovery and its
bounded final outcome. Exhaustion follows the existing terminal completion /
ticket failure notification path; notification delivery remains best effort.
Old Runner versions do not implement this policy; rollout requires the Runner
bundle update as well as the Head/UI deployment. QQ CLI recovery is unchanged.

### Per-session Codex continuation text

In Sessions+, the owner can open **会话设置 → 自动续接消息**, read the current
setting, save exact text (1–4000 characters, not blank), or restore “继续执行”.
Saving configures the next automatic restart/capacity continuation; it does not
send input, take over a session, or change retry eligibility/budgets. Each actual
Codex automatic dispatch reads the latest confirmed setting. Other providers,
manual messages and transcript authorship labels are unchanged.

Runner stores these user preferences separately in
`SCAN_HOME/.octopus/codex-continuations.json` (0600, atomic replacement). Unlike
the prompt-free recovery journal, this file deliberately retains user-authored
continuation text after completion and Stop. Stable logical session identity
and provider lineage retain the preference through native ID changes; settings
do not propagate to other sessions. Missing settings use the default; a corrupt
file refuses reads/writes/automatic continuation instead of silently resetting.

The typed UI actions use the owner's existing `read_session` and `append_session`
Gates. The latter has an exclusive configuration mode: no ordinary prompt or
other control flag can be combined with it. Existing execute approval still
applies, and shared visitors/agents cannot use the human-only settings actions.
Writes compare the read revision; a concurrent stale save is refused. Offline
or unconfirmed saves are never automatically replayed. An older Runner's
transcript response is not accepted as a settings receipt. Updating trusted
service, Sessions+ View and Runner code is required before using this feature.

## Machine operations: bounded windows, not totals

`exec`, `read_file`, `write_file` and `list_dir` bound what one call carries,
never what a caller can reach. `exec` streams through `spawn`; output volume
never kills the command. A stream that outgrows its 100 KB inline window
returns its head and tail around an explicit marker (`truncated: true`,
`stdout_bytes`), and its complete bytes spill to
`SCAN_HOME/.octopus/runner/exec-output/<start>-<id>.<stream>.log` (`0600`),
returned as `stdout_path`/`stderr_path`. For disk safety a spill stops at
1 GiB per stream: the stream is still drained (never blocked or killed), its
tail still returned inline, and the marker plus `stdout_spill_truncated` /
`stderr_spill_truncated` say the file is a prefix. Spills are a hand-off to the next
read, pruned when a later run spills: older than a day, or beyond the newest
64, but never one younger than the longest possible exec. A failed spill is
named in the marker and no path is returned. `read_file` reads one
`offset`/`max_bytes` window from an fd and returns `size`, `next_offset` and
`eof`; a window never ends inside a UTF-8 character. `write_file` chunks with
`append: true` and echoes the resulting `size`; chunked writes are not atomic.
`list_dir` pages in name order with a keyset `cursor` (the previous page's last
name), so concurrent creation or removal cannot cause a skip or a repeat. The
Head refuses a non-zero `offset` or a `cursor` that an older Runner did not
echo, instead of returning its first page as a later one. The synchronous
`exec` timeout (300 s) remains a per-call bound; longer work runs detached and
is polled.

## File transfer and background service

Runner-to-Runner binary copies use a separate capability-gated MCP surface with
asynchronous progress and cancellation. Each endpoint binds an opaque stream to
its registered workspace and gateway site. Sequential 1 MiB chunks, decimal byte
counts and incremental SHA-256 impose no total file-size limit; completed writes
publish atomically with create-only or expected-digest replacement semantics.
See [file transfer](../../doc/runner-file-transfer.md).

Windows scheduled tasks use a locally compiled GUI host which starts PowerShell
with CreateNoWindow and owns the entire resident Job. This avoids Terminal
console delegation creating a visible window before PowerShell parses arguments.
Only an explicit `octopus-runner install` writes or registers the task. The
daemon never migrates it on start: on a remote machine the Runner is the only
channel, an elevated registration refuses the Limited token, and Task Scheduler
does not restart a killed action. An older wrapper keeps working because the
resident process itself writes no output.
`doctor` distinguishes login autostart from Linux boot autostart with linger.
See [service operations](../../doc/runbooks/runner-installation.md).

## Attachment destinations

`upload_session_file` accepts an optional opaque `workspace_id`. The receiving
Runner resolves that id in its own registry, creates a private random
`.octopus-attachment-*` directory there, and echoes the workspace id on every
chunk receipt. Multipart state binds session, gateway site and canonical
workspace; a target change refuses the next chunk. Execution-only devices require
this registered target. Callers cannot supply a destination path. Ordinary
same-device sessions associate through their local transcript metadata and
registry; old sessions with no registered workspace retain temporary uploads.
Split sessions without an explicit execution target fail rather than writing on
the model host.

Managed development mirrors keep the root-only `/.octopus-attachment-??????/`
rule in their private `info/exclude`. This covers the platform's six-character
attachment staging directories, so ordinary `git add .` and clean candidate
export omit them. Other untracked files still block export. Each new prepare or
sync operation installs the rule under the existing mirror lock, including on
older mirrors; status and replay of an existing request do not perform this
upgrade. No tracked ignore file or global Git configuration is changed.

## Standalone build inputs

The downloadable standalone bundles the sessions scan/parse entry points from
this checkout's TypeScript source. A direct Runner-only build must not embed a
previous plugin `dist` while recording the new dependency source fingerprint.
Library exports remain external and still require the normal workspace build.
`standalone-build.test.ts` runs the real standalone bundler configuration against
intentionally stale package exports, then executes its metadata fixture to prove
that current Codex native names survive packaging. Run this build regression on
the configured compute Runner, alongside the ordinary Runner build.

### Codex 注册与额度 inventory

Runner 启动时扫描本用户 `.codex-accounts/account-a` 到 `account-z` 中带 auth.json 的常规目录，
合并显式 RUNNER_CODEX_ACCOUNTS（显式 slot 优先），与路由器使用同一账号池。
默认 CODEX_HOME 与命名目录属于同一登录时只投影一个选择；本地账号/用户身份摘要不离开 Runner。
inventory 周期通过既有 Codex app-server 读取每个登录的限额：公开剩余百分比、窗口、reset、采样时间，
充值卡数量与上游已报告、仍可用卡片的最早到期时间（`creditExpiresAt`，ISO 字符串）也作为可选显示字段上报。
旧 CLI 未给明细、卡片永不过期或没有有效可用卡时省略到期字段；明细可能被上游截断，不按数量推算日期。
卡片 ID、说明和原始明细不离开 Runner。读取失败保留注册并标为未知，不伪造零额度。
目录新增后需要重启 Runner 才加入新建账号池。


## Automatic Codex titles

Fresh managed Codex threads generate a default native name after their first
accepted text input, in parallel with the user turn. Runner follows Codex TUI
0.154.0's title prompt, 960-byte input budget, 36-character output schema and
normalization. OpenAI ChatGPT accounts use gpt-5.6-luna with low effort when
the account's model catalog offers it; other cases keep the resolved thread
model/provider. No alternate account or direct provider API is used.

The request uses an ephemeral app-server thread with read-only permissions,
no execution environment, MCP, hooks, plugins, skills or built-in tools.
Configuration discovery must succeed before generation. Split execution omits
the executor cwd so the model host uses its own local default. Tool/approval
requests from the hidden thread are refused by the transport as well.

Generation has a 30-second total deadline and a five-second best-effort
unsubscribe budget. Main-turn results do not wait; attachment cleanup waits
within that budget so a quick answer does not kill its title request. Failures
keep the existing fallback and are never replayed. Before saving via
thread/name/set, Runner re-reads the native name and preserves an existing
name, as the TUI does. Sessions+ custom names still take precedence, and the
existing native-index observer refreshes default titles. Resumes, forks,
steering and historical inventory do not generate names.

Parity source: OpenAI Codex tag rust-v0.154.0,
tui/src/app/thread_title.rs and tui/src/temporary_structured_request.rs.
The upstream authors are OpenAI contributors; their authoring model is unknown.
Recheck those files when changing the pinned policy.


## Meeting transcription provider

`meeting-transcription-jobs/v1` is the fixed MOSS-Transcribe-Diarize provider.
It advertises explicit availability and a bounded reason in
`inventory.meeting_transcription_jobs`; the standard provider directory names
it `meeting-transcription`. Registration and readiness grant no authority.
Only the configured control site receives this provider. Machine operations
must be enabled and the device must run Linux.

The device owner configures the private mode-0600 file
`SCAN_HOME/.octopus/runner/meeting-transcription.json`. Head config only selects
an owner-authorized device; executable/model/output paths never arrive in an
RPC or App binding. Installation, the exact configuration fields, staged rollout,
job recovery and rollback are documented in
[the transcription runbook](../../doc/runbooks/meeting-transcription-runner.md).

Six closed operations begin/upload/start/status/read/cancel reuse the existing
authenticated Runner socket and a separate capability Object. Input is at most
64 MiB; sequential chunks are at most 256 KiB and compare offset plus SHA-256.
A stable job identity binds immutable title, length and whole recording digest.
Starting again observes the original durable job. It cannot replay an orphaned,
failed, cancelled or timed-out transcription. GPU work is single concurrency,
with a process lock and a persisted eight-hour absolute deadline, including
queue time. The worker permits at most three overlapping recovery segments.

Raw source runs and speaker mapping/seam evidence remain separate from the
merged export. The same strict `validateMossPacket` checks guard Runner success
and Head consumption. A process exit or `complete.json` alone is insufficient.
Unclosed output, token limits, unparsed utterances, invalid timestamps, long
uncovered tails or missing recovery proof retain `needs_review` and partial
artifacts. This is a machine completeness check, not human acoustic validation.
Anonymous labels do not establish personal identity.

Job manifests and launch intent use atomic replacement and fsync. Recovery
checks PID plus Linux start ticks; an unknown original launch becomes `orphaned`
after its bounded launch lease, without resending the recording. Published
artifacts have a fixed allowlist, per-file digest and 8 MiB bound, a 64 MiB total
bound, and bounded reads with exact identity/length/EOF echoes. At most 256 jobs
are retained; reaching that bound refuses admission until the administrator
archives completed private jobs. There is no automatic deletion or permanent
model-driven polling.

## Dynamic capabilities

Locally registered stdio MCP providers can publish tools without restarting the resident.
See [the capability registration guide](../../doc/runner-capabilities.md) for the private
manifest, CAS updates, discovery, permissions, deadlines and generation semantics.

## macOS GUI failure diagnostics

A native GUI operation failure ends the device-local lease and closes its stop
indicator. The source MCP also forgets the lease before best-effort remote close;
cleanup failure preserves the original diagnostic. Neither side retries input,
renews consent, or sends compensating mouse-up events after failure. Revocation
cannot undo events already posted. Exposure, local consent, TCC checks and the
fifteen-minute deadline remain required.

Pointer scripts explicitly import CoreGraphics, pass a plain CGPoint struct,
recognize bridged nil, and construct the bounded event sequence before the first
post. Scroll uses fixed-arity CGEventCreateScrollWheelEvent2 instead of a variadic
C call. At most 63 event references live in one short-lived osascript process;
process exit reclaims its address space. We deliberately avoid manual CFRelease
on opaque JXA wrappers between mouse-down and mouse-up, without assuming that
JXA and native C have identical ownership rules. No new native binary, compiler
or dependency is required on the target Mac.

Errors report a bounded, redacted stderr tail, exit code/signal, and pointer
stage/attempted/posted counts. Counts record function calls, not delivery
receipts. A timeout, abort, failed post or missing completion acknowledgement
has an unknown input outcome. Command/script/argv echoes are not diagnostics and
must not reach logs or MCP replies, especially for typed text.

Ticket #691 established two failure-path defects: execFile's script echo hid the
native error, and the MCP permission regex matched permission-check text inside
that echo. It did **not** establish the failing CoreGraphics/JXA call or whether
the first mouse-down reached the desktop. The original implementation was added
by Git author hongtaolyu in 0a2f481e792667a0f6e676a3b42f0c47f5d80419; its authoring
model is unknown. The incident Runner digest is stronger provenance than a
checkout SHA observed later.

The supplied 1920×1248 image and action imply a 1470×956 point display:
(1341,1196) maps to (1026.703125,916.1666666666666), without a second Retina
multiplier or a Y flip. Capture now obtains point dimensions from NSScreen's
primary screen (index zero), matching screencapture -m; mainScreen instead
tracks keyboard focus and can name a different display.

References: Apple's [JXA bridge notes](https://developer.apple.com/library/archive/releasenotes/InterapplicationCommunication/RN-JavaScriptForAutomation/Articles/OSX10-10.html)
cover imports, structs, variadics and nil;
[NSScreen screens](https://developer.apple.com/documentation/appkit/nsscreen/screens)
defines primary-screen ordering. The sibling macos-gui-automation tests execute
the shipped script against fake native functions and local-agent-bridge tests
cover MCP cleanup. These are Linux control-flow/argument tests, not proof of the
Apple Silicon ABI or TCC behavior. Native macOS 26.3 acceptance remains unverified;
no screen capture, input injection, consent request, Runner restart or deployment
was authorized for the repair. Future desktop acceptance requires fresh local
consent and must not delay the independent game-installation assistance.

## Local Codex model catalog

The account inventory also reads picker-visible `model/list` from each registered
account's local Codex app-server. It shares the bounded one-shot quota transport,
starts no conversation, and publishes only model IDs and display labels. Discovery
uses at most four seconds per account within the existing 16-second inventory
budget, at most five pages/500 rows and the transport's output limit. Failure,
unsupported RPCs or invalid catalogs omit the optional field; consumers retain
their static fallback. Each normal inventory refresh tries again without replaying
an Agent action. Execution-only Runners do not probe accounts.
