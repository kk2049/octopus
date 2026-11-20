/**
 * The trusted resource-binding seam.
 *
 * An App declares which typed ports it needs (`agent-resource-bindings/v1`); a
 * deployment registers which providers satisfy them and seals the catalog; the
 * trusted shell calls `openInstance()` once per App instance and holds a narrow
 * handle. The catalog opens one provider scope per (owner, publisher, app,
 * instance, binding) on first use and closes everything when the handle, the
 * instance, the owner's authority or the process ends.
 *
 * WIRED INTO PRODUCTION since the read-only workspace browser: the dashboard's
 * trusted composition registers the `workspace-files/v1` provider and seals the
 * catalog, and a Session Plus release whose inventory carries an
 * `agent-resource-bindings/v1` plan gets one handle per App instance. Releases
 * without a plan reach nothing here, which is why the rollback targets keep
 * working unchanged.
 */

export {
  RESOURCE_REFUSALS,
  resourceRefusal,
  type ResourceAnswer,
  type ResourceProposal,
  type ResourceProviderContext,
  type ResourceProviderDefinition,
  type ResourceRefusalCode,
  type ResourceScopeIdentity,
} from "./types.js";

export { AgentResourceCatalog, type AgentResourceInstance } from "./catalog.js";

export {
  workspaceFilesProvider,
  workspaceFilesProviderV2,
  workspaceFilesProviderV3,
  workspaceFilesProviderV4,
  type WorkspaceFilesProviderOptions,
  type WorkspaceFilesProviderV2Options,
  type WorkspaceFilesScopeGrant,
} from "./workspace-files-provider.js";

export {
  NOTIFY_PROPOSAL_ACTIONS,
  notifyProvider,
  type NotifyProviderOptions,
} from "./notify-provider.js";

export {
  RESOURCE_PARAM_COUNT,
  RESOURCE_PARAM_DEFAULT_MAX,
  resourceParamLimits,
} from "./wire-limits.js";
