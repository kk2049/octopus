/** `workspace-files/v4`: v3 preview plus bounded download for every regular file type. */

import {
  readWorkspaceFilesDirectoryV2,
  readWorkspaceFilesRootsV2,
  type WorkspaceFilesDirectoryV2,
  type WorkspaceFilesRootsV2,
} from "./projection-v2.js";
import {
  RESOURCE_DOWNLOAD_FILE_ACTION,
  createRemoteWorkspaceFilesCore,
  type WorkspaceFilesDialect,
  type ProposalTransport,
} from "./remote-core.js";
import {
  WORKSPACE_FILES_PROPOSAL_ACTIONS_V3,
  type WorkspaceFilesPortV3,
} from "./remote-v3.js";
import {
  WORKSPACE_FILES_CONTRACT_V4,
  WORKSPACE_FILES_DECLARATION_V4,
  type WorkspaceDownloadPort,
} from "./download.js";
import { RESOURCE_RESOLVE_FILE_LINK_ACTION, type WorkspaceFileLink, type WorkspaceResolvedFileLink } from "./file-link.js";
import type { WorkspaceFilesReply } from "./port.js";

export interface WorkspaceFilesPortV4 extends Omit<WorkspaceFilesPortV3, "contract">, WorkspaceDownloadPort {
  readonly contract: typeof WORKSPACE_FILES_CONTRACT_V4;
  resolveFileLink(input: WorkspaceFileLink): Promise<WorkspaceFilesReply<WorkspaceResolvedFileLink>>;
}

export const WORKSPACE_FILES_DIALECT_V4: WorkspaceFilesDialect<
  typeof WORKSPACE_FILES_CONTRACT_V4,
  WorkspaceFilesRootsV2,
  WorkspaceFilesDirectoryV2
> = Object.freeze({
  contract: WORKSPACE_FILES_CONTRACT_V4,
  resolves: true,
  media: true,
  download: true,
  fileLinks: true,
  readRoots: readWorkspaceFilesRootsV2,
  readDirectory: readWorkspaceFilesDirectoryV2,
});

export const WORKSPACE_FILES_PROPOSAL_ACTIONS_V4: readonly string[] = Object.freeze([
  ...WORKSPACE_FILES_PROPOSAL_ACTIONS_V3,
  RESOURCE_DOWNLOAD_FILE_ACTION,
  RESOURCE_RESOLVE_FILE_LINK_ACTION,
]);

export interface RemoteWorkspaceFilesV4 {
  readonly port: WorkspaceFilesPortV4;
  destroy(): void;
}

export function createRemoteWorkspaceFilesPortV4(
  transport: ProposalTransport,
  binding: string,
): RemoteWorkspaceFilesV4 {
  const core = createRemoteWorkspaceFilesCore(transport, binding, WORKSPACE_FILES_DIALECT_V4);
  return { port: core.port as WorkspaceFilesPortV4, destroy: core.destroy };
}

export { RESOURCE_DOWNLOAD_FILE_ACTION, WORKSPACE_FILES_DECLARATION_V4 };
