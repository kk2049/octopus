import { isResourceRef, type IntentContext } from "@claude-bot/agent-module-contract";
import { isWorkspaceMediaLabel, workspaceResolveLabelsProblem } from "@claude-bot/workspace-files-contract";

export const WORKSPACE_ROOT_REF_CONTEXT = "workspace_root_ref";
export const WORKSPACE_FILE_LABELS_CONTEXT = "workspace_file_labels";
export const WORKSPACE_ANNOTATION_ROOT_CONTEXT = "workspace_annotation_root";

export interface ListedFileLocation {
  rootRef: string;
  labels: readonly string[];
  /**
   * Stable display/equality identity for App-owned annotations. Unlike
   * `rootRef`, this value survives a new resource scope after page reload.
   */
  annotationRoot?: string;
}

/** Transport only labels observed in trusted listings; neither value is a path. */
export function listedFileContext(location: ListedFileLocation | null): IntentContext | undefined {
  if (!location || workspaceResolveLabelsProblem(location.labels) !== null) return undefined;
  return {
    [WORKSPACE_ROOT_REF_CONTEXT]: location.rootRef,
    [WORKSPACE_FILE_LABELS_CONTEXT]: location.labels.join("/"),
    ...(location.annotationRoot ? { [WORKSPACE_ANNOTATION_ROOT_CONTEXT]: location.annotationRoot } : {}),
  };
}

export function readListedFileLocation(context: IntentContext | null): ListedFileLocation | null {
  const rootRef = context?.[WORKSPACE_ROOT_REF_CONTEXT];
  const encoded = context?.[WORKSPACE_FILE_LABELS_CONTEXT];
  const annotationRoot = context?.[WORKSPACE_ANNOTATION_ROOT_CONTEXT];
  const labels = encoded?.split("/") ?? [];
  return typeof rootRef === "string" && isResourceRef(rootRef) && workspaceResolveLabelsProblem(labels) === null
    ? {
        rootRef,
        labels,
        ...(typeof annotationRoot === "string" && annotationRoot ? { annotationRoot } : {}),
      }
    : null;
}

/** Resolve Markdown syntax against listing lineage, never against a guessed filesystem path. */
export function markdownRelativeLabels(location: ListedFileLocation | null, source: string): readonly string[] | null {
  if (!location || !source || source.startsWith("/") || source.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(source)) return null;
  const labels = location.labels.slice(0, -1);
  const address = source.split(/[?#]/, 1)[0] ?? "";
  for (const raw of address.split("/")) {
    let label: string;
    try { label = decodeURIComponent(raw); } catch { return null; }
    if (!label || label === ".") continue;
    if (label === "..") {
      if (!labels.length) return null;
      labels.pop();
    } else {
      labels.push(label);
    }
  }
  return workspaceResolveLabelsProblem(labels) === null ? labels : null;
}

export function markdownImageLabels(location: ListedFileLocation | null, source: string): readonly string[] | null {
  const labels = markdownRelativeLabels(location, source);
  const leaf = labels?.at(-1) ?? "";
  return labels && isWorkspaceMediaLabel(leaf) && !/\.pdf$/i.test(leaf) ? labels : null;
}
