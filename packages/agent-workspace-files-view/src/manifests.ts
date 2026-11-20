/**
 * The two workspace-files manifests, as pure data.
 *
 * Separated from the components so that something with no DOM can read them: a
 * release builder has to emit the module lock and the binding plan as JSON
 * assets, and it runs in a Node process that has no business importing React or
 * a stylesheet.
 *
 * The split is also what makes the lock trustworthy. `modules.tsx` pairs each of
 * these with its component, and the registry derives the lock from the manifests
 * it was actually given — so the file a release ships and the objects that can
 * mount come from one statement, not two that happen to agree.
 */

import type { AgentModuleManifest, ModuleConfigDeclaration } from "@claude-bot/agent-module-contract";
import {
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_CONTRACT_V2,
  WORKSPACE_FILES_CONTRACT_V3,
  WORKSPACE_FILES_CONTRACT_V4,
  WORKSPACE_TEXT_RESOURCE_KIND,
  WORKSPACE_MEDIA_RESOURCE_KIND,
} from "@claude-bot/workspace-files-contract";

// Compatibility re-export: existing Apps imported the kind beside these
// manifests. Its ownership is the port ABI, so alternative consumers can now
// import it without depending on this particular Viewer implementation.
export {
  WORKSPACE_MEDIA_RESOURCE_KIND,
  WORKSPACE_TEXT_RESOURCE_KIND,
} from "@claude-bot/workspace-files-contract";

/** The version every workspace-files module in this package ships at. */
const VERSION = "1.1.0";
const PACKAGE = "@claude-bot/agent-workspace-files-view";

export const FILE_TREE_MODULE_ID = "workspace.file-tree/v1";
export const FILE_VIEWER_MODULE_ID = "workspace.file-viewer/v1";

/**
 * What a tree instance accepts from its composition (decision 7).
 *
 * One key, and it exists so this package never has to name an editor. A
 * composition that ships one points `edit_view` at its module id and every file
 * row grows a 编辑 button; a composition that ships none leaves it unset and the
 * button does not exist — as opposed to existing and refusing, which is the
 * shape this package avoids everywhere (an `other` entry has no ref, so it has
 * no control at all).
 *
 * A module id rather than a boolean, because "which view" is exactly the
 * decision an open rule makes, and the composition is where a reviewer reads it.
 * The default open — a plain click — is deliberately NOT affected: it goes to
 * whichever module the composition put first for `workspace-text`, which keeps
 * "opening a file" a read.
 */
export const FILE_TREE_CONFIG: ModuleConfigDeclaration = Object.freeze({
  edit_view: {
    type: "string",
    description: "点「编辑」时打开哪个模块的 id（留空则不显示编辑按钮）",
  },
});

/** Optional editor target for the viewer's Preview/Edit handoff. */
export const FILE_VIEWER_CONFIG: ModuleConfigDeclaration = Object.freeze({
  edit_view: {
    type: "string",
    description: "点「编辑」时打开哪个模块的 id（留空则不显示编辑按钮）",
  },
});

export const FILE_TREE_MANIFEST: AgentModuleManifest = {
  id: FILE_TREE_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#FileTree`,
  title: "工作区文件",
  slots: ["navigation"],
  // Every compatible file contract. v2 adds directory identity; v3 adds a
  // method the tree does not call.
  ports: [WORKSPACE_FILES_CONTRACT, WORKSPACE_FILES_CONTRACT_V2, WORKSPACE_FILES_CONTRACT_V3, WORKSPACE_FILES_CONTRACT_V4],
  config: FILE_TREE_CONFIG,
  // It opens nothing itself: it RAISES `open-resource/v1`, and the composition
  // decides which module answers. Declaring `opens` here would be this module
  // claiming it can display a document it has no code for.
  opens: [],
};

export const FILE_VIEWER_MANIFEST: AgentModuleManifest = {
  id: FILE_VIEWER_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#FileViewer`,
  title: "文件内容",
  slots: ["secondary", "primary"],
  ports: [WORKSPACE_FILES_CONTRACT, WORKSPACE_FILES_CONTRACT_V2, WORKSPACE_FILES_CONTRACT_V3, WORKSPACE_FILES_CONTRACT_V4],
  config: FILE_VIEWER_CONFIG,
  opens: [WORKSPACE_TEXT_RESOURCE_KIND, WORKSPACE_MEDIA_RESOURCE_KIND],
};

/** Every workspace-files manifest, in registration order. */
export const WORKSPACE_FILES_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([
  FILE_TREE_MANIFEST,
  FILE_VIEWER_MANIFEST,
]);
