/**
 * What this release assembles, depends on and asks for — as data, and as the
 * four JSON assets that ship with it.
 *
 * ── Why the plan is a release asset ─────────────────────────────────────────
 *
 * `view/module-lock.json` says what is inside the bundle, `view/composition.json`
 * how those modules are wired, `view/resource-bindings.json` which typed ports
 * the deployment must provide, and `view/permissions.json` which permission
 * contract the whole thing asks a person to agree to. All four travel in the
 * release inventory, so all four are covered by the package digest — the
 * property that makes them evidence rather than configuration: changing any of
 * them changes the release identity, and therefore the hostname the frame is
 * served from.
 *
 * They are produced from the SAME objects the browser assembles from, by the
 * contract package's canonical encoder. That is the whole reason this module is
 * dependency-light (no React, no CSS, no DOM): a Node release builder imports
 * it to emit the bytes, and the browser imports it to build the plan. Two
 * hand-written documents would be two claims that happen to agree today.
 *
 * The binding plan names a NEED, never an implementation — no provider package,
 * no URL, no device, no workspace id — because a manifest that could name an
 * implementation would be a manifest that could install one.
 *
 * ── The composition, in one paragraph ───────────────────────────────────────
 *
 * Five standing instances — the navigator (sessions, files and search
 * views behind one activity bar) in the navigation rail, the chat in `primary`, the file viewer in
 * `secondary`, the collaborative note beside it, and the editor in the document
 * group — and eight open
 * rules. The index replaced the separate roster tree and file tree: sessions
 * and workspace files are ONE per-directory index, joined by `directoryKey`
 * equality and never by label. The standing chat is first bound to the boot
 * selection; each different session then opens as another tab in the same
 * document group. The file viewer
 * and editor are wired through v2 prototype templates: their named instances
 * establish the connection/config family, and the coordinator may derive a
 * bounded set of honest connected panels from those prototypes.
 * The new-agent form has no standing instance at all, which is what makes
 * closing it a close rather than a mode flag.
 *
 * ── Why the editor now shares `secondary` ──────────────────────────────────
 *
 * `overlay` was an arithmetic workaround for a v1 connected surface and a
 * fixed two-column shell. The v2 template and workbench renderer remove both
 * constraints, so keeping the editor logically modal would preserve accidental
 * history as architecture. Viewer, editor and collaborative note now start in
 * one document group and may be rearranged by presentation-only docking.
 *
 * ── Why the viewer is the default view for a file ──────────────────────────
 *
 * `resolveOpen` takes `rules[0]` when an intent names no view, so the ORDER of
 * these rules is the routing policy. The viewer is first because opening means
 * inspecting before mutating, Markdown has a safe rendered default, and every
 * regular file must retain a download path. Its explicit Edit action hands the
 * same opaque ref to the separately mounted editor. The accepted handoff closes
 * the clean viewer so one document stays one tab; draft/dirty state then belongs
 * solely to that editor panel until the reader returns to browsing.
 */

import {
  APP_PERMISSIONS_SCHEMA,
  COMPOSITION_SCHEMA,
  RESOURCE_BINDINGS_SCHEMA_V2,
  encodeAppPermissions,
  encodeComposition,
  encodeModuleLock,
  encodeResourceBindings,
  moduleLockOf,
  type AgentComposition,
  type AgentModuleLock,
  type AgentModuleManifest,
  type AgentResourceBindingsV2,
  type AppPermissions,
} from "@claude-bot/agent-module-contract";
import {
  AGENT_CHAT_MODULE_ID,
  NEW_SESSION_MODULE_ID,
  REMOTE_TERMINAL_MODULE_ID,
  REMOTE_TERMINAL_RESOURCE_KIND,
  SESSIONS_MANIFESTS,
  SESSION_DIRECTORY_INDEX_MODULE_ID,
} from "@claude-bot/agent-sessions-view/manifests";
import {
  FILE_VIEWER_MODULE_ID,
  WORKSPACE_FILES_MANIFESTS,
  WORKSPACE_TEXT_RESOURCE_KIND,
} from "@claude-bot/agent-workspace-files-view/manifests";
import { EDITOR_MANIFESTS, EDITOR_MODULE_ID } from "@claude-bot/agent-editor-view/manifests";
import {
  CRDT_MANIFESTS,
  CRDT_NOTE_MODULE_ID,
  CRDT_NOTE_RESOURCE_KIND,
} from "@claude-bot/agent-crdt-view/manifests";
import {
  WORKSPACE_FILES_CONTRACT_V4,
  WORKSPACE_MEDIA_RESOURCE_KIND,
} from "@claude-bot/workspace-files-contract";
import { CRDT_DOC_CONTRACT_V2 } from "@claude-bot/crdt-doc-contract";
import {
  FEISHU_DOCUMENT_MODULE_ID,
  FEISHU_MANIFESTS,
} from "@claude-bot/agent-feishu-view/manifests";
import { FEISHU_DOCUMENT_RESOURCE_KIND } from "@claude-bot/agent-feishu-view/links";

/** The stable app id this plan belongs to. */
export const SESSION_PLUS_APP = "session-plus";

/** Release asset names. Exact strings; the adapter compares, never joins. */
export const MODULE_LOCK_ASSET = "view/module-lock.json";
export const COMPOSITION_ASSET = "view/composition.json";
export const RESOURCE_BINDINGS_ASSET = "view/resource-bindings.json";
export const PERMISSIONS_ASSET = "view/permissions.json";

/**
 * The permission contract this release asks for, as the release's own words.
 *
 * ── Why this string is written here and ALSO in the platform ───────────────
 *
 * The serving build keeps its own table of which release shape may declare
 * which contract (`SHAPE_CONTRACT`, in the Session Plus release adapter), and it
 * refuses a release whose document disagrees with it. That is two statements of
 * one fact ON PURPOSE, and it is not a second source of truth: the platform is
 * still the only thing that decides which contracts exist and what they mean,
 * and it is still the only thing that grants anything. What the duplication buys
 * is that a typo here — or a shape table edited without the release, or a
 * release edited without the shape table — is a loud refusal at `prepare()`
 * rather than a release that quietly asks for something else.
 *
 * The value is the current owner-local ask: sessions, workspace read/write,
 * CRDT, bounded media preview, one approved terminal lease, and the new
 * `upload_session_file` device-temporary write, regular downloads, and the
 * owner-local Runner absolute-path read. The last capability creates v6;
 * every historical contract and already-open instance retains its exact older
 * digest, so existing users must explicitly consent to this release.
 *
 * Ticket #181 removed the document RAIL from the navigation slot without
 * narrowing the ask. The document module remains reachable through resource
 * intents; permission changes continue to be explicit release decisions.
 */
export const SESSION_PLUS_CONTRACT_ID = "sessions-workspace-write-crdt-self-service/v7";

/** The App-local name of the workspace typed port this release depends on. */
export const WORKSPACE_BINDING = "workspace";

/** The App-local name of the collaborative-document port. */
export const DOCS_BINDING = "docs";

/**
 * Every module this release can mount, as pure data. The lock below is DERIVED
 * from it, and the Node release adapter validates an installed composition
 * against it — one answer to "which modules exist", not two that could disagree.
 */
export const SESSION_PLUS_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([
  ...SESSIONS_MANIFESTS,
  ...WORKSPACE_FILES_MANIFESTS,
  ...EDITOR_MANIFESTS,
  ...CRDT_MANIFESTS,
  ...FEISHU_MANIFESTS,
]);

/** Derived from the manifests, so it cannot claim a module that is not there. */
export const SESSION_PLUS_MODULE_LOCK: AgentModuleLock = moduleLockOf(SESSION_PLUS_MANIFESTS);

export const SESSION_PLUS_COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: SESSION_PLUS_APP,
  instances: [
    // Search is a view of the navigator below (2026-10-22): one rail, one
    // activity bar. `session.search/v1` remains in the module lock for other
    // compositions and rollback releases.
    // ONE unified index where the roster tree and the file tree used to stand:
    // sessions and workspace files are one per-directory index, joined by
    // `directoryKey` equality (never by label). Which module opens a file is
    // decided by the ordered open rules below, not by a private tree action.
    {
      instance: "index",
      module: SESSION_DIRECTORY_INDEX_MODULE_ID,
      slot: "navigation",
    },
    // NOTHING ELSE STANDS IN `navigation` (ticket #181). The rail is this App's
    // wayfinding for the two things it is about — sessions and workspace files —
    // and the document rail that used to sit under the file tree was the
    // collaborative-document plane demonstrating itself, not a surface this App
    // does any work through. A flow slot shares one column's height on the
    // desktop and one whole layer on a phone, so an unused rail is not free
    // decoration: it is height taken from the index on every viewport.
    { instance: "chat", module: AGENT_CHAT_MODULE_ID, slot: "primary" },
    // A STANDING viewer, not only an open rule: bindings wire NAMED instances,
    // so a viewer that existed only as an open rule's target could not say
    // which port it inherited.
    {
      instance: "file-viewer",
      module: FILE_VIEWER_MODULE_ID,
      slot: "secondary",
      config: { edit_view: EDITOR_MODULE_ID },
    },
    // The document surface stands BESIDE the viewer in the same document slot
    // — the arrangement the 2026-08-10 layout change exists for. Unbound it is
    // a dormant placeholder: `isDockDormantDocument` keeps an empty secondary
    // panel out of the tab strip while a primary surface exists, so with the
    // rail gone (ticket #181) it costs no chrome on either viewport. It stays
    // as the DECLARED surface for `crdt-note`, which is what keeps the `docs`
    // binding — and therefore this release's permission contract and every
    // user's existing consent — exactly what it was.
    { instance: "doc", module: CRDT_NOTE_MODULE_ID, slot: "secondary" },
    // A real document peer, not the modal workaround the v1 fixed shell needed.
    {
      instance: "editor",
      module: EDITOR_MODULE_ID,
      slot: "secondary",
      config: { browse_view: FILE_VIEWER_MODULE_ID },
    },
  ],
  open: [
    // The standing chat is bound first; different resources become sibling
    // tabs in the same Dock document group instead of replacing its resource.
    { resource: "session", module: AGENT_CHAT_MODULE_ID, slot: "primary" },
    // A physical-device row opens one resource-keyed terminal beside chats.
    // Repeating the click focuses that exact tab; the module still submits a
    // trusted projected workspace id to the existing terminal handshake.
    { resource: REMOTE_TERMINAL_RESOURCE_KIND, module: REMOTE_TERMINAL_MODULE_ID, slot: "primary" },
    { resource: "new-session", module: NEW_SESSION_MODULE_ID, slot: "primary" },
    // ORDER IS POLICY: a plain file click opens the read surface. Markdown is
    // rendered there by default; editing is an explicit handoff between
    // independently implemented views. The source retires only after the
    // destination accepts the open.
    { resource: WORKSPACE_TEXT_RESOURCE_KIND, module: FILE_VIEWER_MODULE_ID, slot: "secondary" },
    { resource: WORKSPACE_TEXT_RESOURCE_KIND, module: EDITOR_MODULE_ID, slot: "secondary" },
    { resource: WORKSPACE_MEDIA_RESOURCE_KIND, module: FILE_VIEWER_MODULE_ID, slot: "secondary" },
    // A collaborative document opens into the standing `doc` surface, which
    // is connected and therefore exclusive: every document rebinds that one
    // named panel rather than stacking anonymous twins.
    { resource: CRDT_NOTE_RESOURCE_KIND, module: CRDT_NOTE_MODULE_ID, slot: "secondary" },
    // A transcript link is a bounded resource intent, never a nested browser.
    // The dedicated module preserves View isolation while giving it normal
    // Dock focus/reuse/close semantics.
    { resource: FEISHU_DOCUMENT_RESOURCE_KIND, module: FEISHU_DOCUMENT_MODULE_ID, slot: "secondary" },
  ],
};

/**
 * What this release needs bound, and which instances get it.
 *
 * All three workspace surfaces are wired explicitly: the tree to enumerate and
 * walk, the viewer to read, the editor to read and write. A plan naming only
 * some would rely on React context to carry the rest — the implicit wiring this
 * document exists to replace — and the release adapter refuses exactly that.
 *
 * ONE binding for all three, not three: they read the same workspace through the
 * same contract, and a second binding name would be a second provider scope —
 * two ref vaults, two sets of streams, two grants to revoke.
 */
export const SESSION_PLUS_RESOURCE_BINDINGS: AgentResourceBindingsV2 = {
  schema: RESOURCE_BINDINGS_SCHEMA_V2,
  app: SESSION_PLUS_APP,
  // `workspace-files/v4` keeps v3's bounded media preview and adds an explicit
  // bounded download stream for every regular file type. Documents remain a
  // separate provider scope with their own ref vault and revocation boundary;
  // `crdt-doc/v2` carries a document of any size in bounded windows under the
  // same two tokens, so it needs no new permission contract.
  bindings: [
    { binding: WORKSPACE_BINDING, contract: WORKSPACE_FILES_CONTRACT_V4 },
    { binding: DOCS_BINDING, contract: CRDT_DOC_CONTRACT_V2 },
  ],
  connections: [
    { instance: "file-viewer", port: WORKSPACE_FILES_CONTRACT_V4, binding: WORKSPACE_BINDING },
    { instance: "index", port: WORKSPACE_FILES_CONTRACT_V4, binding: WORKSPACE_BINDING },
    { instance: "editor", port: WORKSPACE_FILES_CONTRACT_V4, binding: WORKSPACE_BINDING },
    { instance: "doc", port: CRDT_DOC_CONTRACT_V2, binding: DOCS_BINDING },
  ],
  // The prototype counts toward its ceiling. Eight is deliberately bounded to
  // the same conservative order as the resource-stream broker. At the ceiling
  // open fails without eviction or rebind, so a click cannot discard a draft,
  // scroll position, or independent read snapshot to make room for itself.
  templates: [
    { instance: "file-viewer", maxInstances: 8 },
    { instance: "editor", maxInstances: 8 },
  ],
};

/** What this release asks for, as data. */
export const SESSION_PLUS_PERMISSIONS: AppPermissions = {
  schema: APP_PERMISSIONS_SCHEMA,
  contract: SESSION_PLUS_CONTRACT_ID,
};

/** The exact bytes of `view/module-lock.json`. */
export const SESSION_PLUS_MODULE_LOCK_JSON = encodeModuleLock(SESSION_PLUS_MODULE_LOCK);

/** The exact bytes of `view/composition.json`. */
export const SESSION_PLUS_COMPOSITION_JSON = encodeComposition(SESSION_PLUS_COMPOSITION);

/** The exact bytes of `view/resource-bindings.json`. */
export const SESSION_PLUS_RESOURCE_BINDINGS_JSON = encodeResourceBindings(SESSION_PLUS_RESOURCE_BINDINGS);

/** The exact bytes of `view/permissions.json`. */
export const SESSION_PLUS_PERMISSIONS_JSON = encodeAppPermissions(SESSION_PLUS_PERMISSIONS);

/** The four, in the order the release inventory declares them. */
export const SESSION_PLUS_MODULE_ASSETS: ReadonlyArray<{ name: string; source: string }> = Object.freeze([
  { name: COMPOSITION_ASSET, source: SESSION_PLUS_COMPOSITION_JSON },
  { name: MODULE_LOCK_ASSET, source: SESSION_PLUS_MODULE_LOCK_JSON },
  { name: PERMISSIONS_ASSET, source: SESSION_PLUS_PERMISSIONS_JSON },
  { name: RESOURCE_BINDINGS_ASSET, source: SESSION_PLUS_RESOURCE_BINDINGS_JSON },
]);
