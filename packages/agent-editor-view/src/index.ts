/**
 * `@claude-bot/agent-editor-view` — the reusable text editor module.
 *
 * ── What it is ─────────────────────────────────────────────────────────────
 *
 * One module, `workspace.editor/v1`: it opens `workspace-text` resources,
 * reads them through `workspace-files/v1`, and — when the composition's port and
 * the scope's authority both allow it — submits a whole-file compare-and-swap.
 * It is the first consumer of `open-resource/v1`'s intent context (`line`).
 *
 * ── The whole public surface ───────────────────────────────────────────────
 *
 * The module entry, the pure manifest, the presentational components, and the
 * two small readers. Every omission is deliberate:
 *
 *  · no provider of its own — it uses `WorkspaceFilesProvider` from
 *    `@claude-bot/agent-workspace-files-view`, because a second provider would
 *    mean a second roots enumeration and one enumeration is one approval card;
 *  · no client, no channel, no transport — the App owns the channel;
 *  · no owner, scope, instance handle or capability — the View is never told;
 *  · no action strings — those belong to the contract's own remote adapter.
 *
 * A consumer wires it in two lines: register `EDITOR_MODULES` alongside the
 * workspace-files modules, and point one composition open rule at
 * `EDITOR_MODULE_ID`.
 */

import "./editor.css";

export { EDITOR_MODULE, EDITOR_MODULES } from "./modules.js";

export {
  EDITOR_CONFIG,
  EDITOR_CONTEXT_LINE,
  EDITOR_MANIFEST,
  EDITOR_MANIFESTS,
  EDITOR_MODULE_ID,
  WORKSPACE_TEXT_RESOURCE_KIND,
} from "./manifests.js";

export { CodeSurface, type CodeSurfaceProps } from "./components/CodeSurface.js";
export { EditorPane, type EditorPaneProps } from "./components/EditorPane.js";

export { requestedLine } from "./lib/line.js";
export { IDLE_SAVE, SAVING, canSave, saveStateFrom, type SaveState, type SaveStatus } from "./lib/save.js";
