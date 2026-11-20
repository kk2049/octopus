import { annotationRootsByRef, listedFileContext } from "@claude-bot/agent-workspace-files-view";
import type { AnyWorkspaceFilesPort, WorkspaceFilesRoots } from "@claude-bot/workspace-files-contract";
import type { RecoveryDocument, ResolvedRecoveryDocument } from "./recovery.js";

/** One current-scope resolution per visible file, never an old opaque ref or a guessed filesystem path. */
export async function resolveRecoveryFiles(
  documents: readonly RecoveryDocument[],
  roots: WorkspaceFilesRoots | null,
  port: AnyWorkspaceFilesPort,
  isCurrent: () => boolean = () => true,
  onResolved?: (document: ResolvedRecoveryDocument) => void,
): Promise<readonly ResolvedRecoveryDocument[]> {
  const identities = roots && !roots.truncated ? annotationRootsByRef(roots.roots) : new Map<string, string>();
  const resolved: ResolvedRecoveryDocument[] = [];
  for (const document of documents) {
    if (!isCurrent()) break;
    if (!document.file) { resolved.push(document); continue; }
    const file = document.file;
    const rootRef = [...identities].find(([, key]) => key === file.root)?.[0];
    if (!rootRef || !port.resolvePath) continue;
    try {
      const result = await port.resolvePath(rootRef, file.labels);
      if (!isCurrent()) break;
      if (!result.ok || result.value.kind !== "file" || !result.value.ref) continue;
      const restored = { ...document, ref: result.value.ref, label: result.value.label,
        context: listedFileContext({ rootRef, labels: file.labels, annotationRoot: file.root }) };
      resolved.push(restored);
      onResolved?.(restored);
    } catch { /* Best effort: a missing/offline/refused file never blocks the other windows. */ }
  }
  return resolved;
}
