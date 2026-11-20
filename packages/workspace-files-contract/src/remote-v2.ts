/**
 * `workspace-files/v2` over the same transport, the same verbs, the same wire.
 *
 * A thin dialect over `remote-core.ts`. What is NOT here is the interesting
 * part: no new action ids, no new parameters, no second channel and no version
 * negotiation. The trusted dispatcher already resolves a proposal's binding to a
 * contract using the App's released binding plan, so "which version am I
 * speaking" is decided by a document the View cannot edit — asking the View
 * would have made the answer a claim.
 */

import {
  readWorkspaceFilesDirectoryV2,
  readWorkspaceFilesRootsV2,
  WORKSPACE_FILES_CONTRACT_V2,
  type WorkspaceFilesDirectoryV2,
  type WorkspaceFilesRootsV2,
} from "./projection-v2.js";
import type { WorkspaceFilesPort, WorkspaceFilesReply, WorkspaceTextOpen } from "./port.js";
import type { ContractDeclaration } from "@claude-bot/typed-port-kit";
import {
  WORKSPACE_FILES_DECLARATION,
  type WorkspaceMutationReceipt,
  type WorkspaceReplaceTextInput,
} from "./write.js";
import {
  WORKSPACE_FILES_PROPOSAL_ACTIONS,
  createRemoteWorkspaceFilesCore,
  type ProposalTransport,
  type WorkspaceFilesDialect,
} from "./remote-core.js";
import { RESOURCE_RESOLVE_PATH_ACTION, type WorkspaceResolvedEntry } from "./resolve.js";
import type { WorkspaceFilesPortV3 } from "./remote-v3.js";
import type { WorkspaceFilesPortV4 } from "./remote-v4.js";

/**
 * What a v2 consumer holds.
 *
 * Deliberately its own interface rather than a widening of `WorkspaceFilesPort`:
 * a module written against v1 must not silently accept a v2 port and drop the
 * field it does not know about, and a module that wants either can say so with
 * a union. `contract` is a literal for the same reason it is one on v1.
 */
export interface WorkspaceFilesPortV2 {
  readonly contract: typeof WORKSPACE_FILES_CONTRACT_V2;
  refreshRoots(after?: string): Promise<WorkspaceFilesReply<WorkspaceFilesRootsV2>>;
  listDirectory(ref: string, after?: string): Promise<WorkspaceFilesReply<WorkspaceFilesDirectoryV2>>;
  /**
   * Resolve a descendant by child labels in one round trip (ticket #243).
   * Optional so a consumer written against the v1/v2 union checks presence —
   * exactly the `workspaceFilesCanWrite` pattern — and a composition that lacks
   * it keeps the per-level walk.
   */
  resolvePath?(
    ref: string,
    labels: readonly string[],
  ): Promise<WorkspaceFilesReply<WorkspaceResolvedEntry>>;
  openText(ref: string): Promise<WorkspaceFilesReply<WorkspaceTextOpen>>;
  replaceText(
    ref: string,
    input: WorkspaceReplaceTextInput,
  ): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>>;
}

export interface RemoteWorkspaceFilesV2 {
  readonly port: WorkspaceFilesPortV2;
  /** Close every stream this port opened and refuse everything after. Idempotent. */
  destroy(): void;
}

/** Every workspace-files port version a shared tree/editor consumer accepts. */
export type AnyWorkspaceFilesPort =
  | WorkspaceFilesPort
  | WorkspaceFilesPortV2
  | WorkspaceFilesPortV3
  | WorkspaceFilesPortV4;

/**
 * The v2 contract's wire declaration: v1's actions, params and refusals under
 * the v2 id — DERIVED, not copied, for the same reason the readers delegate.
 * A trusted coordinator that honours declared parameter bounds (the file body
 * of `replace_text` is the one over the default) reads this for a release
 * whose binding plan names v2, and must not fall back to the narrow default
 * merely because the id string moved.
 */
export const WORKSPACE_FILES_DECLARATION_V2: ContractDeclaration = Object.freeze({
  ...WORKSPACE_FILES_DECLARATION,
  contract: WORKSPACE_FILES_CONTRACT_V2,
});

/**
 * Every action a `workspace-files/v2` provider serves: v1's six, plus the one
 * resolve verb v2 grew (ticket #243). v1's set stays exactly six — an already
 * installed v1 release keeps seeing the surface it was built against — and the
 * trusted dispatcher registers each provider with its own version's set, so a
 * v1 binding proposing the resolve verb stops at the closed-set check.
 */
export const WORKSPACE_FILES_PROPOSAL_ACTIONS_V2: readonly string[] = Object.freeze([
  ...WORKSPACE_FILES_PROPOSAL_ACTIONS,
  RESOURCE_RESOLVE_PATH_ACTION,
]);

/** v2: the same answers, plus an optional opaque directory key on two of them. */
export const WORKSPACE_FILES_DIALECT_V2: WorkspaceFilesDialect<
  typeof WORKSPACE_FILES_CONTRACT_V2,
  WorkspaceFilesRootsV2,
  WorkspaceFilesDirectoryV2
> = Object.freeze({
  contract: WORKSPACE_FILES_CONTRACT_V2,
  // The wire half of the resolve verb. See `resolve.ts` for why this is the
  // one dimension a dialect may differ in beyond its two readers.
  resolves: true,
  readRoots: (value: unknown) => readWorkspaceFilesRootsV2(value),
  readDirectory: (value: unknown) => readWorkspaceFilesDirectoryV2(value),
});

/** Present a proposal transport as `workspace-files/v2`. */
export function createRemoteWorkspaceFilesPortV2(
  transport: ProposalTransport,
  binding: string,
): RemoteWorkspaceFilesV2 {
  return createRemoteWorkspaceFilesCore(transport, binding, WORKSPACE_FILES_DIALECT_V2);
}
