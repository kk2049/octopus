# 自动科研 v2

Independent shared App at `/apps/research-v2/open`, mounted in the Dashboard ESM
host with its shared React runtime, Sessions transcript and file previews. All
reads and actions use the existing App action channel; node plugins do not own
sockets or credentials.

The left research navigation groups project scopes, known active Agents, files,
and meeting minutes with their sources. Each section and the full desktop rail
can collapse; those choices are private to the viewer and project. Below 1120px,
navigation uses a dismissible drawer without overwriting desktop preferences.
Detail opening and rendering share the same viewport-bounded zoom tier. Ctrl/Command K searches the existing metadata across
collapsed sections; results can open content or locate the original graph node.
Rows are revealed in bounded batches. Existing Agents without an observed run
remain available under other Agents, and unknown status never counts as active.
Navigation does not prefetch transcripts or resource bodies. One shared workflow
metadata read supplies counters and the workflow panel; the heavy panel mounts
only after first use and remains mounted thereafter to preserve drafts.

There is one editable free canvas. “横向排列” and “紧凑排列” are explicit
shared-coordinate commands for the currently expanded nodes, not view modes.
“框选节点” or Shift-drag on empty canvas selects a group; dragging a selected
card header moves exactly those visible selected nodes, preserving their offsets.
The fitted canvas leaves room below the actual wrapped toolbar.
Dragging a content-card title moves it; its bottom-right handle resizes the preview
without changing font size. Manual drag/resize preserves the card dimensions. Explicit layout commands
clear historical pins in their chosen scope and preserve saved dimensions. Opening/expanding/collapsing a branch never arranges or writes geometry.

`contains` and `decomposes` project into `data.members` for any parent. A spanning
tree displays a multiply referenced resource once while retaining every semantic
relationship. Cyclic legacy `contains` data stays bounded; new `decomposes` cycles
are rejected after merging. GOAL, TARGET and motivation are presentation roles in
resource metadata, with ordinary fixed refs in YAML. See
[organization conventions](../../doc/development/research-canvas-organization.md).

Public x/y/width/height/pinned values live in the layout CRDT. Scope, camera,
expanded branches, detail windows and drafts remain private. One bounded geometry
function drives rendering, edge endpoints, fitting, auto layout, diagnostics and
structural SVG. Old `researchLayout` links are accepted but use these same saved
coordinates. `researchScope=<node-id>` opens a focused branch and `researchNode=<node-id>`
opens the original node. The URL retains the host instance binding and carries
the project ID; pushState/popstate restores scope and node with browser navigation. Read-only inspection
never invents an alternate layout. Each scope remembers its camera during
navigation; initial fit waits for layout and narrow screens retain readable text.

Layout gestures commit to a private, durable pending-operation queue immediately.
The next drag/resize never waits for HTTP, including a newly acknowledged card
whose position has not appeared in the layout read yet. Saving status shows the
queued changes without disabling gestures. Receipts retire only their own operation;
monotonic Head sequence numbers reject stale reads and receipts, with later local
operations rendered over the trusted snapshot. Unknown failures retain the same
request for explicit retry; an explicit discard restores the trusted snapshot.
`layout_patch` merges position, size and pin fields independently without a board
lease. `layout_arrange` skips nodes changed after its baseline. Legacy fenced
`layout_move` / `layout_auto` / lease actions remain compatible.
Generic previews render source context, Markdown, images and adapter rows inside
the available card area; groups show direct-child counts by disjoint types.
The existing resource version still controls preview refreshes.

Single-click an Agent card to open its existing chat; a prominent robot icon and
“继续聊天” footer action make this entry visible. Opening never sends a message.
Single-click a content card to edit title, summary and body in the exact same footprint.
The header grip moves it; dragging never activates editing. Compatible content
card kinds are presentation metadata and retain the immutable resource ref/body.
Agent/file/plugin resources keep their resource identity. Their explicit summary
edit action edits the card description; Agent clicks open chat directly.
Preview icons separately expand children, open full contents/a group, copy a stable node reference, inspect one-hop neighbors or show secondary operations. Double-click has no card navigation action.
Drafts survive data pushes and private editor closure. Open full contents explicitly
to use the existing larger detail. The detail
keeps a canvas-world anchor while the camera pans or zooms; fixed size tiers keep
its DOM text readable. Detail components remain mounted but hidden when their
scope is not visible, preserving drafts and scroll. Cards and detail text remain
selectable. Closing a detail never stops background work. Session file references
open private file windows; listener and manual conversations remain separate.
The manual conversation ID comes from the authorized resource history, not the
graph card ID. Existing manual selections migrate while listener selections and
private drafts survive history refreshes. Native reads are single-flight: data wakes
queue one refresh without discarding an in-flight transcript. Identity changes
still discard old responses; refusals require an explicit retry. Runtime state
is shown independently of research acceptance. Agent windows default to the native
transcript, current status and composer. Session selection, refresh, attachment,
resource identity, run receipts and node settings live under the single “⋯”
disclosure; opening it does not remount the chat or reset drafts and scroll.
Action errors remain visible outside that disclosure. An empty composer disables
Send without implying that authorization was refused.

Task labels use optional `data.meta.workKind` and `data.meta.status`. The detail
separately presents `claimedProgress`, `progressSource`, `sourceAt` and
`acceptanceStatus`; a historical phase or an author's claim is never interpreted
as verified completion. The generic node renderers continue to support unknown
plugins, versioned files, reviews, projection adapters, timers and Agent sessions.

Initial canvas reads request bounded active-only pages; later changes still carry
tombstones. Geometry wakes refresh only layout; data wakes refresh graph metadata,
workflow and visited text/native resources. New children and parent membership
commit in one request. Creation/deletion receipts overlay the current frame until
a later authoritative read observes them. Unknown deletion results persist their
original request across reload; failed display refreshes never repeat a confirmed
write. Active-only full reads can retire an absent deleted node after reload.

The client reads composed nodes with fixed refs and causal graph snapshots.
The collaboration controller retains ordinary file drafts and their retry IDs;
layout uses asynchronous field operations through the existing authorized action transport. Text is a
real file, outside the graph CRDT. Only graph structure and public coordinates
enter that CRDT. Scope, camera, windows and drafts remain viewer/project state. Backend authorization is
still checked on every action. Action metadata is generated from
research-canvas-contract by `pnpm manifest`.

On phones (including touch-screen landscape), tapping a card opens its full,
viewport-bounded detail. Explicit summary/body edits open that same detail's editor.
Single-finger gestures browse the canvas; select mode enables card moves and ports.
Two fingers pan/zoom without committing a pending shared drag. The +/− buttons zoom
around the visible canvas centre. Navigation, form controls and detail actions have
touch-sized targets; text inputs use a 16px font. The visible viewport, host chrome
and safe-area insets bound details, dialogs and workbenches as the keyboard opens.
Only the front phone detail is shown. Minimized, covered and out-of-scope details
remain mounted, preserving drafts and scroll; opening material hides its covering
workbench without unmounting that workbench. Desktop keeps its anchored windows.

Run the synthetic preview with `pnpm run app:preview
packages/research-canvas-view/examples/research-v2.preview.tsx --port 5191` on a
test device. `?native=1` exercises Sessions+ transcript/file windows without
external accounts. Fixtures never enter the release package. Run targeted Vitest
coverage with `pnpm exec vitest run --project research-canvas-view --maxWorkers=1`;
`hierarchy.test.ts` covers membership, cycles, scope relations and fit, and
`App.test.tsx` covers navigation, deep links, frames, hidden drafts and viewers.
Run `pnpm --filter @claude-bot/research-canvas-view manifest`, `typecheck`, `build`,
then `pnpm app:pack:research-v2` for the release package. All builds, checks and
browser work run on a compute device, not the Head service container.

## YAML 与资源

外部 agent 的 file-edit 工作流见
[科研 Agent 接口](../../doc/development/research-canvas-agents.md)。
UI 的标签/边编辑沿用读取时的 snapshot；字段竞争显示最终合并值。
删除卡片仅摘除图成员。资源正文、Agent 会话和 adapter 数据保持独立版本。
工作区 file ref 的详情支持刷新和文本保存，直接写回绑定工作区文件。
data-graph-revision / data-layout-revision 标记可见页面状态，供实际截图工具记录。

## Meeting recordings

Audio cards expose a direct upload button and an upload progress/pause control.
One viewer/project/node controller keeps the same upload alive across card and
detail views. Uploading never starts transcription. Explicit transcription uses
`summary: { kind: "none" }` by default; a selected existing Agent or authorized
Codex source may continue into Chinese minutes and pending task suggestions.
Complete transcripts can be summarized separately without rerunning recognition.
Audio bytes are loaded only by the player's explicit load button. Metadata and
source status are separate reads, and older source results cannot authorize
processing or task dispatch for a newer recording.

Private upload metadata, source choices and uncertain processing requests survive
refresh. Retrying keeps the original request and parameters; only an explicit
server `not_started` receipt releases the processing request for a new selection; browsers ask the user
to reselect the same file when its bytes are no longer in memory. Pausing stops
subsequent upload chunks; an already dispatched commit is reconciled, not cancelled.
Generated tasks remain pending review. The selected summary Agent is an editable
assignment default; no task is selected or run until final explicit dispatch.

Focused lifecycle coverage is in `audio-upload.test.ts`, `AudioCardPreview.test.tsx`,
`windows/AudioWindow.test.tsx` and `CandidateReview.test.tsx`.

## Discussion capture

A bound group can freeze a selected inclusive message interval into an immutable
raw record plus an editable, source-linked minutes draft. Retry retains the exact
request and parameters after uncertain failure. The backend enforces pagination
bounds and stable message IDs; creating minutes never sends a message or starts
work. Focused tests cover partial failure/replay, source-version previews and
private expansion in addition to existing draft and lifecycle checks.

## Hierarchy, references and selection

`contains`/`decomposes` express membership; `references` is an ordinary semantic
edge to an existing node, never a new resource or body copy. Pasting a valid node
URL into a focused scope offers common-parent ownership by default, or keeping
the original owner. A fresh structured `graph_read.graph` snapshot is edited and
submitted atomically via the existing `graph_apply`; its JSON encoding is valid
YAML. The former and new scopes retain explicit references. No common containing
scope means the project root.

Focused views include live one-hop semantic neighbors. Dashed reference cards
reuse the exact node and document controller. Their positions initialize near the
scope, then stay fixed in viewer/project/scope-local storage. Dragging a reference
changes only that personal view position, including for viewers; it never submits
a public layout or ownership change. Resizing remains on the original card. Removing a
reference removes that scope's `references` edge (or hides an implicit one-hop
preview). Deleting a graph node has a separate confirmation and affects every
scope while preserving the underlying resources.

Selection mode supports box selection and Shift/Ctrl/Meta multiple selection.
Dragging a selected header moves only the explicitly selected, displayed cards;
leaving selection mode clears the group and collapsed descendants never join a drag.
Owned-card positions use one queued `layout_patch`; reference-card positions remain
private. Undo restores the shared layout members. Full expansion explicitly arranges every descendant.
Scoped arrangement reserves all saved cards outside its scope so a later expand
cannot reveal a collision that the arranger introduced.

Round connection handles route from the selected side. Source/target ports are
persisted in `LayoutSnapshot.edgePorts`, outside business YAML, with the same
sequence, journal and receipt semantics as positions. Old snapshots without
ports remain readable. The summary and body share no write field or save action;
clicking the summary focuses its growing textarea and never focuses the body.

New-card creation reads a fresh graph snapshot after `node_add` before attaching the
new endpoint to its parent; an older parent snapshot cannot authorize that endpoint.
The creation form checkpoints the node ID and exact creation/attachment requests in
viewer/project-local storage. Unknown replies retry the original request; a known
node never gets created again to repair its attachment. Closing/reopening the form
or refreshing preserves this recovery state. Display refresh runs after confirmed
writes and cannot replay them.

Business relationship paths and labels select one real edge, with a wide hit
area and a blue selection. Its visible delete button and unmodified Backspace /
Delete archive only that selected edge; input fields, editors, modal dialogs,
IME composition and key repeat never trigger deletion. Blank canvas, Escape,
node selection and scope navigation clear the edge selection. Viewers can inspect
edges but cannot delete them. Each deletion checkpoints the original request,
edge version and graph snapshot in viewer/project storage. Unknown outcomes need
an explicit replay of that same request; a confirmed write only refreshes reads.

Folders may declare `data.meta.mainline` as a JSON string encoding at least two
distinct, existing direct member IDs, matching the scalar resource metadata
contract. Array projections are also readable. The default relationship view keeps its `contains` line to the first
step and hides its other direct membership lines. All semantic lines remain, and
adjacent `下一步` lines are emphasized. “全部关系” reveals every membership edge for
inspection and deletion. Invalid or absent mainlines keep ordinary rendering;
this view choice never changes the shared graph or its saved coordinates.
## Mobile regression checks

`viewport.test.ts` and the phone cases in `App.test.tsx` cover viewport bounds,
zoom anchors, multi-pointer cancellation and draft ownership. The optional
`packages/bot/src/research-canvas/open.test.ts` real-HTTP fixture runs the packaged
App with `RESEARCH_TEST_MOBILE_ONLY=1` and `RESEARCH_TEST_BROWSER=<Chromium path>`.
Set `RESEARCH_TEST_WEBKIT=<WebKit executable>` to run the same six-size matrix with
WebKit; set `RESEARCH_TEST_ARTIFACTS=<absolute directory>` to retain screenshots and
the JSON verdict. Run browsers on the compute device. This suite uses temporary
authorized projects and never needs production data or user credential rotation.
