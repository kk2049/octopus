/** `workspace-files/v3`: v2 directory identity plus bounded image/PDF preview. */

import {
  readWorkspaceFilesDirectoryV2,
  readWorkspaceFilesRootsV2,
  type WorkspaceFilesDirectoryV2,
  type WorkspaceFilesRootsV2,
} from "./projection-v2.js";
import {
  RESOURCE_OPEN_MEDIA_ACTION,
  createRemoteWorkspaceFilesCore,
  type WorkspaceFilesDialect,
  type ProposalTransport,
} from "./remote-core.js";
import {
  WORKSPACE_FILES_PROPOSAL_ACTIONS_V2,
  type WorkspaceFilesPortV2,
} from "./remote-v2.js";
import {
  WORKSPACE_FILES_CONTRACT_V3,
  WORKSPACE_FILES_DECLARATION_V3,
  type WorkspaceMediaPort,
} from "./media.js";

export interface WorkspaceFilesPortV3 extends Omit<WorkspaceFilesPortV2, "contract">, WorkspaceMediaPort {
  readonly contract: typeof WORKSPACE_FILES_CONTRACT_V3;
}
export const WORKSPACE_FILES_DIALECT_V3: WorkspaceFilesDialect<
  typeof WORKSPACE_FILES_CONTRACT_V3,
  WorkspaceFilesRootsV2,
  WorkspaceFilesDirectoryV2
> = Object.freeze({
  contract: WORKSPACE_FILES_CONTRACT_V3,
  resolves: true,
  media: true,
  readRoots: readWorkspaceFilesRootsV2,
  readDirectory: readWorkspaceFilesDirectoryV2,
});

export const WORKSPACE_FILES_PROPOSAL_ACTIONS_V3: readonly string[] = Object.freeze([
  ...WORKSPACE_FILES_PROPOSAL_ACTIONS_V2,
  RESOURCE_OPEN_MEDIA_ACTION,
]);

export { RESOURCE_OPEN_MEDIA_ACTION };

export interface RemoteWorkspaceFilesV3 {
  readonly port: WorkspaceFilesPortV3;
  destroy(): void;
}

export function createRemoteWorkspaceFilesPortV3(
  transport: ProposalTransport,
  binding: string,
): RemoteWorkspaceFilesV3 {
  const core = createRemoteWorkspaceFilesCore(transport, binding, WORKSPACE_FILES_DIALECT_V3);
  return { port: core.port as WorkspaceFilesPortV3, destroy: core.destroy };
}

export { WORKSPACE_FILES_DECLARATION_V3 };
