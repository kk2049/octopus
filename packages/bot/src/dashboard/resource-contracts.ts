import { CRDT_DOC_CONTRACT, CRDT_DOC_CONTRACT_V2 } from "@claude-bot/crdt-doc-contract";
import { NOTIFY_CONTRACT } from "@claude-bot/notify-contract";
import {
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_CONTRACT_V2,
  WORKSPACE_FILES_CONTRACT_V3,
  WORKSPACE_FILES_CONTRACT_V4,
} from "@claude-bot/workspace-files-contract";

/**
 * The typed-port contracts a panel can install for a hosted App.
 * Availability of authority is still decided independently per scope.
 *
 * This runtime declaration stays in the dashboard module. The process-level
 * injection ports are type-only, so transport never gains a value dependency
 * back into the composition root merely to publish this compatibility list.
 */
export const PANEL_RESOURCE_CONTRACTS: readonly string[] = Object.freeze([
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_CONTRACT_V2,
  WORKSPACE_FILES_CONTRACT_V3,
  WORKSPACE_FILES_CONTRACT_V4,
  NOTIFY_CONTRACT,
  CRDT_DOC_CONTRACT,
  CRDT_DOC_CONTRACT_V2,
]);
