# Research Program View

This package is the first-party shared Agentic App for one funded autonomous-
research project. One shared App instance is one authorization unit. The
trusted App shell owns instance membership and invitations. It may project a
bounded, viewer-filtered project directory containing only URL-safe lookup
refs, titles and lifecycle display state; the untrusted View never receives
members, roles, creators, credentials, per-tab instance handles, ambient filesystem access or capability grants. Project switching is the exact
`research.navigate_project` proposal: the Host must match the ref against its
current membership-filtered directory before top-level navigation, where the
new route re-authorizes and mints a fresh handle. The directory arrives in
bounded windows; while `workspace_navigation.truncated` is set the View offers
the parameterless, Host-owned `research.load_more_projects` proposal, and the
Host appends the next membership window and re-declares the navigation.

The App stores a bounded, explicitly published project mirror. The reviewed
`research-sessions/v1` profile additionally connects explicit source aliases to
the current human owner’s Runner sessions through the shared Session Resource
and operation controllers. Live output is per-viewer and never enters the shared
App event stream. Generic workspace reads remain unavailable. Human and MCP/agent callers use
the same declared action table. External agents must be bound through the
existing trusted Apps MCP surface; action parameters never carry owner,
membership, approval, or authority. Supported new registrations are Codex
first-party, Codex local Runner and Claude Opus. Research Program does not use
the generic DSH external-host picker and does not offer Fable.

The View is a hybrid modular-v1 workbench: the two resizable product rails and
compact toolbar stay bespoke, while the primary/secondary surface uses the
shared Dock coordinator. Membership, invitation and project-creation controls
stay in trusted chrome even though the display-only project picker is inside
the View.
Reuse the exact `agent.chat/v1` module from `SESSIONS_MODULES` and the exact
`FILE_VIEWER_MODULE`; the shared Sessions and Files providers own rendering and
interaction. Published source adapters supply indexed transcript windows and document
streams. A mapped session becomes writable only after a real authorized read;
sends, uploads, pauses and operation receipts use the same commands and execution
services as Sessions+. Unmapped, unavailable, viewer and archived histories stay
read-only, with an explicit connection failure and the published history retained. The secretary remains the real App inbox endpoint.
A file mention may only open a document already present in the current
projection; it must never become a filesystem read or an invented ref.

The internal Agent directory contains explicit `lead_agent` /
`lead_agent_history` registrations and individually curated historical sources
accepted by `research_bind_source`. Curation is not leadership: only
`set_lead_agent` changes the current leader. Never infer either from workspace
paths, process lists, all projected sessions or message counts. Hidden bindings
stay out of navigation; their immutable history remains retained.

The document directory includes every document explicitly accepted through
`publish_document` or `research_bind_source`; these actions are its curation boundary. `set_lead_document`
chooses the default and records history, but is not required merely to keep an
already-published project document discoverable. Never fill this directory from
a filesystem or workspace listing.

Keep proposal state separate from authoritative projection state. Preserve a
the workspace's resource-keyed tabs across unrelated projection updates, show
pending/refusal/closed-channel states, preserve a refused chat draft, and remove
mutation controls for viewers and archived projects.

The research DAG, branch state machine, provenance and personal receipts live
in `app/research-*.ts`; the View proposes their declared actions. See
`doc/development/research-collaboration.md` for the contract. Immutable source
records remain infer/imported until an authenticated person explicitly responds
to that exact version. Learning, approval and browsing are separate events.
The native `secretary` receives the real App inbox and publishes briefings; it
cannot impersonate human-only learning/approval or start workspace experiments.

History is durable in the App stream. Projection bodies are bounded caches;
`research_read_history` pages the already-authorized stream through the declared
`history_cursor`, never through a path or caller-supplied stream. Keep complete
source text in append events and keep document/session metadata discoverable.
Research index capacity refusals must be explicit; never evict authoritative DAG
nodes to make a write appear successful.

Explicit source snapshots keep SHA-256 generations and an event-sequence/range
index in the projection. `research_publish_source` checks generation and next
offset; `research_read_source` reads only the already-authorized stream. Full
content stays in events. Incomplete versions are visibly unavailable, never
shown as complete history. `research_source_status` is a compact paged MCP
query, so maintenance still works when the full projection exceeds the MCP
answer cap. Owner agents can rename projects and repair frozen source bindings;
archive/reopen and human attestations keep their existing human-only gates.

Long native messages use bounded serialized fragments, with a separate inner
offset and a single message identity. The source reader assembles and checks
them before supplying the shared Sessions port. Epoch 2 requires old Views to
refresh; source identity and shared event streams do not change.

Report figures may be explicitly bound as document sources with
`encoding: png-base64` (default `text`). Encoding is part of a generation's
identity. The CLI validates PNG bytes and the 1 MiB source bound; the adapter
strictly decodes and checks the signature before supplying the existing
WorkspaceMediaPort and original-byte download. Markdown images resolve only
against bound source refs. Epoch 3 requires old text-only Views to refresh.

## Explicit provenance mapping (epoch 4)

`research_set_source_locations` replaces an Owner-maintained table using an exact
`expected_revision`. `roots` are published project roots; optional `aliases` map
old roots to index-relative prefixes. Each already-bound session records its real
`cwd` and, when needed, an explicit `document_base` for project-relative mentions.
Never put the project title in cwd, fabricate a directoryKey, infer a device from
a title, or resolve by a filename suffix. Mapping is provenance, not authority.

Optional `device/provider/session_id` locators are checked against the current
human owner’s actual Runner devices, current source membership and release
contract before each use. Only Owner browser actions connect or operate real
sessions; MCP agents maintain source mappings but cannot consume browser-only
execution. Source hiding, mapping changes, archive, role/credential/grant changes
and App closure tear down the affected live authority. AgentChat and FileViewer
share the published-index link resolver; it returns only already-published refs.
The shared SDK/Host debug picker is used by this App as by Sessions+.
