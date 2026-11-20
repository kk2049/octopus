import { useBrowserDownload } from "@claude-bot/agent-view-react/ui";
import {
  collectWorkspaceDownload,
  type AnyWorkspaceFilesPort,
  type WorkspaceDownloadDocument,
} from "@claude-bot/workspace-files-contract";

/** One explicit click prepares and starts one browser download of any size. Never retries. */
export function useWorkspaceDownload(port: AnyWorkspaceFilesPort, ref: string | null) {
  return useBrowserDownload<WorkspaceDownloadDocument>(port, ref, (isCurrent, onProgress, onChunk) =>
    collectWorkspaceDownload(port, ref ?? "", onChunk, isCurrent, onProgress));
}
