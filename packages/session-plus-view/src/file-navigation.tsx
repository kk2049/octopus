/** Composition bridge: files and chat submit to the same index reveal controller. */
import { useCallback, useMemo } from "react";
import { useSessionNavigation } from "@claude-bot/agent-sessions-view";
import { WorkspaceFilesProvider, annotationRootsByRef, type WorkspaceFilesProviderProps, type ListedFileLocation } from "@claude-bot/agent-workspace-files-view";
import type { WorkspaceFilesPortV4 } from "@claude-bot/workspace-files-contract";
import type { PublishedFileLinks } from "@claude-bot/agent-file-preview";

/** Adapt the bound resource port to the existing chat/preview link opener. */
export function sessionFileLinks(port: WorkspaceFilesPortV4): PublishedFileLinks {
  return { resolve: async ({ href, sessionRef, fileRef }) => {
    const reply = await port.resolveFileLink({ href, ...(sessionRef ? { sessionRef } : { fileRef }) });
    if (!reply.ok) return reply;
    const entry = reply.value.entry;
    if (entry.kind !== "file") return { ok: false, message: "这个链接指向目录，请在文件导航中打开。" };
    return { ok: true, ref: entry.ref, label: entry.label,
      location: { rootRef: entry.base, labels: entry.path.split("/"),
        annotationRoot: annotationRootsByRef([reply.value.root]).get(entry.base) } };
  } };
}

export function SessionFilesProvider(props: WorkspaceFilesProviderProps) {
  const sessions = useSessionNavigation();
  const scope = useMemo(() => Symbol("file-navigation"), [props.port]);
  const reveal = useCallback((ref: string, location: ListedFileLocation) => {
    sessions.revealWorkspace(ref, { location, scope });
  }, [scope, sessions.revealWorkspace]);
  const current = sessions.workspaceReveal;
  return <WorkspaceFilesProvider {...props} navigation={{
    reveal, scope,
    current: current?.file?.scope === scope ? current : null,
  }} />;
}
