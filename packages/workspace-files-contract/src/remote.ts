/**
 * `workspace-files/v1` over somebody else's transport.
 *
 * The implementation lives in `remote-core.ts`, which both contract versions
 * share; this file names v1's dialect and nothing else. Its public surface is
 * unchanged and deliberately so: `createRemoteWorkspaceFilesPort(transport,
 * binding)` takes the two arguments it always took. A third, optional, version
 * parameter would have been cheaper to write and would have made every existing
 * call site a call site that could have asked for a different contract — and
 * "which contract is this port speaking" is exactly the question a binding plan
 * is supposed to answer, on the trusted side, where a View cannot edit it.
 *
 * Everything here that is not a re-export is the v1 dialect: the contract id and
 * the two readers that refuse the field v2 added.
 */

import {
  WORKSPACE_FILES_CONTRACT,
} from "./limits.js";
import {
  readWorkspaceFilesDirectory,
  readWorkspaceFilesRoots,
  type WorkspaceFilesDirectory,
  type WorkspaceFilesRoots,
} from "./projection.js";
import type { WorkspaceFilesPort } from "./port.js";
import {
  createRemoteWorkspaceFilesCore,
  type ProposalTransport,
  type WorkspaceFilesDialect,
} from "./remote-core.js";

export {
  RESOURCE_ACTIONS,
  RESOURCE_PARAMS,
  WORKSPACE_FILES_PROPOSAL_ACTIONS,
  createRemoteWorkspaceFilesCore,
  readWorkspaceTextOpenPayload,
  type ProposalAnswer,
  type ProposalTransport,
  type WorkspaceFilesCorePort,
  type WorkspaceFilesDialect,
  type WorkspaceTextOpenPayload,
} from "./remote-core.js";

/**
 * A port and the handle that ends it.
 *
 * The port is what a module holds — four named methods, and nothing that says
 * where the data comes from. `destroy()` belongs to the App: it is composition,
 * and a module that could end its own transport would be a module that could end
 * a sibling's.
 */
export interface RemoteWorkspaceFiles {
  readonly port: WorkspaceFilesPort;
  /**
   * Close every stream this port opened and refuse everything afterwards.
   * Idempotent. The trusted side does the same thing from its own side when the
   * instance ends, the grant is revoked or the device set changes; this is the
   * consumer half, for an App unmounting a panel.
   */
  destroy(): void;
}

/** v1: no `directoryKey` anywhere, and a listing carrying one is refused. */
export const WORKSPACE_FILES_DIALECT_V1: WorkspaceFilesDialect<
  typeof WORKSPACE_FILES_CONTRACT,
  WorkspaceFilesRoots,
  WorkspaceFilesDirectory
> = Object.freeze({
  contract: WORKSPACE_FILES_CONTRACT,
  readRoots: (value: unknown) => readWorkspaceFilesRoots(value),
  readDirectory: (value: unknown) => readWorkspaceFilesDirectory(value),
});

/**
 * Present a proposal transport as `workspace-files/v1`.
 *
 * `binding` is the App-local name from its `agent-resource-bindings/v1` plan. It
 * selects among what the plan already declared; it is not authority, and the
 * trusted dispatcher resolves it against its own copy of that document.
 */
export function createRemoteWorkspaceFilesPort(
  transport: ProposalTransport,
  binding: string,
): RemoteWorkspaceFiles {
  return createRemoteWorkspaceFilesCore(transport, binding, WORKSPACE_FILES_DIALECT_V1);
}
