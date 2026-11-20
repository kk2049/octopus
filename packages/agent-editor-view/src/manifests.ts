/**
 * The editor manifest, as pure data.
 *
 * Separated from the component so that something with no DOM can read it: a
 * release builder emits the module lock and the binding plan as JSON assets from
 * a Node process that has no business importing React, CodeMirror or a
 * stylesheet.
 *
 * ── Why this is a second module and not a mode of the viewer ────────────────
 *
 * `workspace.file-viewer/v1` and `workspace.editor/v1` open the same resource
 * kind and speak the same port, so a "mode" flag was the obvious alternative. It
 * is the wrong shape for one reason that outweighs the duplication: a
 * composition's open rules are how a deployment decides what a click DOES, and a
 * mode inside one module would move that decision into the module's own state,
 * where nothing a reviewer reads can see it. As two modules, "double-clicking a
 * file opens a read-only pane" and "the 编辑 button opens a writable one" are two
 * lines of `composition.json` — covered by the package digest, like everything
 * else about how an App is assembled.
 *
 * It also keeps the default honest: the viewer stays `rules[0]` for
 * `workspace-text`, so opening a file is still a read. Reaching the editor takes
 * an explicit `view` hint.
 */

import type { AgentModuleManifest, ModuleConfigDeclaration } from "@claude-bot/agent-module-contract";
import {
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_CONTRACT_V2,
  WORKSPACE_FILES_CONTRACT_V3,
  WORKSPACE_FILES_CONTRACT_V4,
  WORKSPACE_TEXT_RESOURCE_KIND,
} from "@claude-bot/workspace-files-contract";

/** Re-exported so a composition can name the kind this module opens. */
export { WORKSPACE_TEXT_RESOURCE_KIND } from "@claude-bot/workspace-files-contract";

const VERSION = "1.2.0";
const PACKAGE = "@claude-bot/agent-editor-view";

export const EDITOR_MODULE_ID = "workspace.editor/v1";

/**
 * The intent-context key this module consumes: which line to put the caret on.
 *
 * `open-resource/v1`'s `context` is transported and never interpreted by the
 * platform (convergence-plan decision 7), so its meaning belongs to the resource
 * kind's vocabulary. This constant is that meaning written down once, for the
 * producer (a file tree, a search result, a stack trace) and the consumer (this
 * module) to share instead of agreeing by accident on a string literal.
 *
 * A value that is not a positive integer is ignored rather than refused: a
 * context is a hint, and a panel that refused to open because a hint was
 * malformed would be worse than one that opens at the top.
 */
export const EDITOR_CONTEXT_LINE = "line";

/** Optional read-only target for the editor's Edit/Browse handoff. */
export const EDITOR_CONFIG: ModuleConfigDeclaration = Object.freeze({
  browse_view: {
    type: "string",
    description: "点「浏览」时打开哪个只读模块的 id（留空则不显示浏览按钮）",
  },
});

export const EDITOR_MANIFEST: AgentModuleManifest = {
  id: EDITOR_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#Editor`,
  title: "编辑器",
  // The three DOCUMENT slots, in the order a composition author should consider
  // them. Never a flow slot: `navigation` and `bottom` paint every standing
  // widget at once, and an editor that shared a column with a file tree would be
  // a text pane a few lines tall.
  //
  // `overlay` is not decoration either — it is the slot a composition reaches
  // for when `secondary` already holds the reading pane, which is exactly what
  // Session Plus does. A document slot shows one panel at a time and rebinds it,
  // so the editor stays one named, wired instance rather than a stack.
  slots: ["secondary", "overlay", "primary"],
  // v3 retains the same text read/write methods; its media method is irrelevant
  // to this module.
  ports: [
    WORKSPACE_FILES_CONTRACT,
    WORKSPACE_FILES_CONTRACT_V2,
    WORKSPACE_FILES_CONTRACT_V3,
    WORKSPACE_FILES_CONTRACT_V4,
  ],
  config: EDITOR_CONFIG,
  opens: [WORKSPACE_TEXT_RESOURCE_KIND],
};

/** Every manifest in this package, in registration order. */
export const EDITOR_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([EDITOR_MANIFEST]);
