/**
 * `@claude-bot/agent-workspace-files-view` — the reusable read-only workspace
 * file modules.
 *
 * ── The whole public surface ────────────────────────────────────────────────
 *
 * A provider that takes a `WorkspaceFilesPort`, a hook to read it, two module
 * entries, two presentational components, and the pure manifests. That is the
 * list, and every omission is deliberate:
 *
 *  · no client, no channel, no transport — the App owns the channel;
 *  · no owner, scope, instance handle or capability — the View is never told;
 *  · no action strings — those belong to the contract's own remote adapter.
 *
 * A consumer wires it in three lines: create a port, wrap the tree in
 * `<WorkspaceFilesProvider port={…}>`, and register `WORKSPACE_FILES_MODULES`.
 */

import "./workspace-files.css";

export {
  WorkspaceFilesProvider,
  useOptionalWorkspaceFiles,
  useWorkspaceFiles,
  type RootsState,
  type WorkspaceFilesController,
  type WorkspaceFilesProviderProps,
} from "./context.js";

export { useWorkspaceDirectories, type WorkspaceDirectories } from "./lib/directories.js";

export { FILE_TREE_MODULE, FILE_VIEWER_MODULE, WORKSPACE_FILES_MODULES } from "./modules.js";

export {
  FileTree,
  FileTreeChevron,
  FileTreeGlyph,
  FileTreeRow,
  type FileTreeProps,
  HiddenEntriesToggle,
  MoreRoots,
  type FileTreeRowProps,
} from "./components/FileTree.js";
export { FileViewer, type FileViewerProps } from "./components/FileViewer.js";

export {
  FILE_TREE_CONFIG,
  FILE_TREE_MANIFEST,
  FILE_TREE_MODULE_ID,
  FILE_VIEWER_MANIFEST,
  FILE_VIEWER_MODULE_ID,
  WORKSPACE_FILES_MANIFESTS,
  WORKSPACE_TEXT_RESOURCE_KIND,
} from "./manifests.js";

export {
  displaySize,
  isHiddenLabel,
  visibleRows,
  type DirectoryCache,
  type DirectoryState,
  type ExpandedDirectories,
  type TreeRow,
  type VisibleRowsOptions,
} from "./lib/tree.js";
export { useWorkspaceText, type TextState } from "./lib/text.js";
export { useWorkspaceDownload } from "./lib/download.js";
export { annotationRootsByRef } from "./lib/annotations.js";

// The unified session/file navigator renders this package's file rows but owns
// the open callback. Re-export the listing-lineage bridge so that composition
// preserves exactly what the row observed without importing preview internals.
export {
  listedFileContext,
  type ListedFileLocation,
} from "@claude-bot/agent-file-preview";
