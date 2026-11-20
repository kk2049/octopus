/**
 * The two workspace-files modules: a manifest and a mount for each.
 *
 * ── What lives here rather than in the components ───────────────────────────
 *
 * The per-instance state, and nothing else. Expansion, the directory cache, the
 * selection and the reload counter belong to ONE mounted tree — a second tree
 * beside it is a second reader's view of the same workspace, not a shared one —
 * so they are `useState` here and props there. That is also what lets a harness
 * render `FileTree` from a fixture with no port at all.
 *
 * ── The one thing a module says to the layout ───────────────────────────────
 *
 * `workspace.open(link)`. It does not choose a slot, does not look for a viewer
 * panel and does not touch the DOM. Clicking the same file twice is a `reuse`
 * intent, which the coordinator answers by focusing the panel that is already
 * showing it — which is why the tree does not have to know whether one exists.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 *
 * No wire action strings, no channel primitives, no protocol constants, no
 * transport. These modules import `@claude-bot/agent-view-react/ui` and
 * `/workspace` — presentation and layout — plus the contract. The App is the
 * thing that has a channel; a module has a port.
 */

import { useCallback, useEffect, useState } from "react";
import { AvButton } from "@claude-bot/agent-view-react/ui";
import type { ResourceLink } from "@claude-bot/agent-module-contract";
import {
  WORKSPACE_MEDIA_RESOURCE_KIND,
  WORKSPACE_TEXT_RESOURCE_KIND,
  isWorkspaceMediaLabel,
} from "@claude-bot/workspace-files-contract";
import {
  listedFileContext,
  readListedFileLocation,
  useWorkspaceMedia,
  type ListedFileLocation,
} from "@claude-bot/agent-file-preview";
import type { ModuleProps, ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import { FileTree } from "./components/FileTree.js";
import { MediaViewer } from "./components/MediaViewer.js";
import { FileViewer } from "./components/FileViewer.js";
import { useWorkspaceFiles } from "./context.js";
import { useWorkspaceDirectories } from "./lib/directories.js";
import { annotationFileKey } from "./lib/annotations.js";
import { visibleRows } from "./lib/tree.js";
import { useWorkspaceText } from "./lib/text.js";
import { useWorkspaceDownload } from "./lib/download.js";
import { FILE_TREE_MANIFEST, FILE_VIEWER_MANIFEST } from "./manifests.js";

/** First instance keeps the plain DOM hooks; a later copy gets a namespace. */
function useDomIdScope({ panel, workspace }: ModuleProps): string | undefined {
  const [scope] = useState(() => {
    const first = workspace.state.panels.find((candidate) => candidate.moduleId === panel.moduleId);
    return first?.panelId === panel.panelId ? undefined : panel.panelId;
  });
  return scope;
}

function FileTreeModule({ panel, workspace }: ModuleProps) {
  const files = useWorkspaceFiles();
  const domIdScope = useDomIdScope({ panel, workspace });
  const { port } = files;
  // The lazy directory book — one listing per ref, issued from event handlers,
  // scoped to this instance and this port. Shared as a HOOK (not as provider
  // state) so a second surface gets the same rules over its own state.
  const directories = useWorkspaceDirectories(port, files.refreshVersion);

  // Enumeration belongs to the FileTree, not to the shared provider. A
  // FileViewer mounted by itself therefore makes no roots call. Two trees under
  // one provider either observe ready roots or join the provider's single
  // in-flight request.
  useEffect(() => {
    if (files.roots.status === "idle") files.refreshRoots();
  }, [files.refreshRoots, files.roots.status]);

  const openFile = useCallback(
    (link: ResourceLink, location?: ListedFileLocation) => {
      if (workspace.open(link, { context: listedFileContext(location ?? null) })) directories.select(link.ref);
    },
    [directories.select, workspace],
  );

  /**
   * The composition's editing module, or nothing.
   *
   * Read from this instance's config, so the tree names no editor and gains no
   * dependency on one. `open()` answers false for a `view` hint the composition
   * did not declare an open rule for — a refusal this module deliberately does
   * not paper over, because inventing a fallback route would be it deciding what
   * the composition declined to.
   */
  const editView = typeof panel.config?.edit_view === "string" ? panel.config.edit_view : "";
  const editFile = useCallback(
    (link: ResourceLink, location?: ListedFileLocation) => {
      if (workspace.open(link, { view: editView, context: listedFileContext(location ?? null) })) directories.select(link.ref);
    },
    [directories.select, editView, workspace],
  );

  /**
   * Re-enumerate the workspaces and re-list what is open, WITHOUT collapsing.
   *
   * The tree is listed once per directory on first open, so a folder created
   * outside the browser stays invisible until something invalidates the cache.
   * That used to be `reset()`, which threw away the reader's expansion as well
   * — refreshing to see a new folder shut the tree you were looking at
   * (ticket #350).
   */
  const refresh = useCallback(() => {
    files.refreshRoots();
  }, [files.refreshRoots]);

  /**
   * Dot-prefixed entries, hidden by default (ticket #350).
   *
   * Display state of THIS instance, like expansion: it changes which rows are
   * drawn, never which port is called or what a listing said.
   */
  const [hideDotEntries, setHideDotEntries] = useState(true);

  return (
    <FileTree
      rows={visibleRows(files.roots.value, directories.cache, directories.expanded, { hideDotEntries })}
      rootsStatus={files.roots.status}
      rootsMessage={files.roots.message}
      rootsTruncated={files.roots.value?.truncated ?? false}
      rootsMore={{
        loading: files.roots.more?.status === "loading",
        refusal: files.roots.more?.status === "refused" ? files.roots.more.message : "",
      }}
      {...(files.loadMoreRoots ? { onLoadMoreRoots: files.loadMoreRoots } : {})}
      onLoadMore={directories.loadMore}
      selected={directories.selected}
      domIdScope={domIdScope}
      hideDotEntries={hideDotEntries}
      onToggleHidden={(hidden) => setHideDotEntries(!hidden)}
      onRefresh={refresh}
      onToggle={directories.toggle}
      onOpenFile={openFile}
      {...(editView ? { onEditFile: editFile } : {})}
    />
  );
}

function FileViewerModule({ panel, workspace }: ModuleProps) {
  const files = useWorkspaceFiles();
  const domIdScope = useDomIdScope({ panel, workspace });
  const [reload, setReload] = useState(0);
  // The ref whose view budget the person lifted; another file starts budgeted.
  const [unbudgeted, setUnbudgeted] = useState<string | null>(null);
  const loadAll = unbudgeted !== null && unbudgeted === panel.resourceRef;
  const mediaResource = panel.resourceKind === WORKSPACE_MEDIA_RESOURCE_KIND;
  const text = useWorkspaceText(
    files.port,
    mediaResource ? null : panel.resourceRef,
    reload,
    loadAll ? Number.POSITIVE_INFINITY : undefined,
  );
  const media = useWorkspaceMedia(
    files.port,
    mediaResource ? panel.resourceRef : null,
    reload,
    loadAll ? Number.POSITIVE_INFINITY : undefined,
  );
  const download = useWorkspaceDownload(files.port, panel.resourceRef);
  const markdownLocation = readListedFileLocation(panel.context);
  const editView = typeof panel.config?.edit_view === "string" ? panel.config.edit_view : "";
  const edit = useCallback(() => {
    if (!editView || !panel.resourceRef || mediaResource) return;
    const opened = workspace.open({
      kind: WORKSPACE_TEXT_RESOURCE_KIND,
      ref: panel.resourceRef,
      label: panel.label,
    }, { view: editView, ...(panel.context ? { context: panel.context } : {}) });
    // Preview and edit are two views of one document, not two documents. Keep
    // the accepted destination and retire this clean read-only panel in the
    // same click so Dock sees one tab after the handoff.
    if (opened) workspace.close(panel.panelId);
  }, [editView, mediaResource, panel.context, panel.label, panel.panelId, panel.resourceRef, workspace]);
  // The annotation root is stable across browser instances; the root ref is
  // deliberately absent because a fresh App scope mints a fresh ref. Absence
  // of stable listing identity means we do not offer annotations for that
  // panel — the composition is honest about it.
  const fileKey = markdownLocation ? annotationFileKey(markdownLocation) : "";
  const annotations = files.annotations;
  const navigation = files.navigation;
  const reveal = navigation?.current?.resource === panel.resourceRef ? navigation.current : null;
  const revealLabel = "在文件索引中定位此文件";
  const shared = {
    revealAction: navigation && panel.resourceRef ? (
      <AvButton
        aria-label={revealLabel}
        title={markdownLocation ? revealLabel : "缺少文件的目录定位信息，请从文件索引或聊天链接重新打开。"}
        disabled={!markdownLocation || reveal?.phase === "pending"}
        onClick={() => { if (markdownLocation) navigation.reveal(panel.resourceRef!, markdownLocation); }}
      >
        <span aria-hidden="true">⌖</span>
        <span className="av-document-action-word">{reveal?.phase === "pending" ? "定位中…" : "定位文件"}</span>
      </AvButton>
    ) : null,
    revealNotice: reveal ? <div role="status">{reveal.message}</div> : null,
    label: panel.label,
    domIdScope,
    onReload: () => setReload((value) => value + 1),
    ...(panel.resourceRef ? { onLoadAll: () => setUnbudgeted(panel.resourceRef) } : {}),
    download,
    onDownload: download.start,
    ...(panel.resourceRef ? { onClose: () => workspace.close(panel.panelId) } : {}),
  };
  return mediaResource
    ? (
        <MediaViewer
          {...media}
          {...shared}
          {...(annotations && fileKey ? { annotations, fileKey } : {})}
        />
      )
    : (
        <FileViewer
          {...(files.links ? { links: files.links } : {})}
          document={text.document}
          text={text.text}
          status={text.status}
          streaming={text.streaming}
          message={text.message}
          code={text.code}
          {...(editView && panel.resourceRef ? { onEdit: edit } : {})}
          port={files.port}
          markdownLocation={markdownLocation}
          onOpenFile={(ref, label, location) => workspace.open({ kind: isWorkspaceMediaLabel(label) ? WORKSPACE_MEDIA_RESOURCE_KIND : WORKSPACE_TEXT_RESOURCE_KIND, ref, label }, { context: listedFileContext(location) })}
          {...(annotations && fileKey ? { annotations, fileKey } : {})}
          {...shared}
        />
      );
}

/**
 * Both modules, ready to be registered.
 *
 * An App picks from this list rather than assembling entries itself: a manifest
 * and its component belong together, and a composition that could pair a
 * manifest with a different implementation would make the lock a claim rather
 * than a fact.
 */
export const FILE_TREE_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: FILE_TREE_MANIFEST,
  component: FileTreeModule,
});

export const FILE_VIEWER_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: FILE_VIEWER_MANIFEST,
  component: FileViewerModule,
});

export const WORKSPACE_FILES_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([
  FILE_TREE_MODULE,
  FILE_VIEWER_MODULE,
]);
