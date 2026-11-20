import { isResourceRef } from "@claude-bot/agent-module-contract";
import { readWorkspaceResolvedEntry, type WorkspaceResolvedEntry } from "./resolve.js";
import { readWorkspaceFilesRoots, type WorkspaceFilesRoot } from "./projection.js";
import { WORKSPACE_FILES_DECLARATION_V4 } from "./download.js";

/** A link is data; the provider binds its session/file reference to a device. */
export const RESOURCE_RESOLVE_FILE_LINK_ACTION = `resource.${WORKSPACE_FILES_DECLARATION_V4.byAction.resolve_file_link.action}`;
export interface WorkspaceFileLink {
  href: string;
  sessionRef?: string;
  fileRef?: string;
}
export interface WorkspaceResolvedFileLink {
  source: string;
  href: string;
  entry: WorkspaceResolvedEntry;
  root: WorkspaceFilesRoot;
}
export function workspaceFileLinkProblem(input: WorkspaceFileLink): string | null {
  const refs = [input.sessionRef, input.fileRef].filter((ref) => ref !== undefined);
  if (refs.length !== 1 || !isResourceRef(refs[0])) return "文件链接需要一个有效的会话或文件引用。";
  if (typeof input.href !== "string" || !input.href || input.href.length > 400
    || /[\u0000\r\n\\]/.test(input.href) || /^[a-z][a-z0-9+.-]*:/i.test(input.href)
    || input.href.startsWith("//")) return "这个文件链接不是有效的本机路径。";
  return null;
}
export function readWorkspaceResolvedFileLink(value: unknown): WorkspaceResolvedFileLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["source", "href", "entry", "root"].includes(key))) return null;
  if (typeof row.source !== "string" || typeof row.href !== "string"
    || workspaceFileLinkProblem({ sessionRef: row.source, href: row.href })) return null;
  const entry = readWorkspaceResolvedEntry(row.entry);
  const roots = readWorkspaceFilesRoots({ roots: [row.root], truncated: false });
  return entry.ok && roots.ok && roots.value.roots[0]?.ref === entry.value.base
    ? { source: row.source, href: row.href, entry: entry.value, root: roots.value.roots[0] } : null;
}
