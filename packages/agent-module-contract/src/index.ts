/**
 * `@claude-bot/agent-module-contract` — the module ABI, as pure data.
 *
 * This package is what both halves of a module system agree on: the shape of a
 * module manifest, the lock that says what a bundle contains, the composition
 * that says how those modules are assembled, the five slots they may occupy, and
 * the one intent a module may raise about layout.
 *
 * It has no dependencies, and that is the point rather than an accident:
 *
 *  · **No React.** A composition is read by a release adapter in a Node process
 *    that will never render anything, and by a browser bundle that will. One
 *    definition, two consumers, no framework in between.
 *  · **No Host, no Bot, no transport.** Nothing here knows what a MessagePort
 *    is, what a capability is, or who is logged in. A module id is compared; a
 *    resource ref is carried; neither is ever resolved, joined onto a path or
 *    fetched.
 *  · **Nothing throws at a caller.** Every reader returns a result with bounded,
 *    field-addressed diagnostics, because both consumers must refuse without
 *    disturbing something that is already working.
 *
 * `moduleLockOf()` is the exception worth noting: it throws, because building a
 * lock out of manifests this bundle compiled in is a programming error when it
 * fails, not untrusted input.
 */

export {
  DOCUMENT_SLOTS,
  WORKSPACE_SLOTS,
  DEFAULT_OPEN_SLOT,
  isDocumentSlot,
  isWorkspaceSlot,
  sortSlots,
  type DocumentSlot,
  type WorkspaceSlot,
} from "./slots.js";

export {
  ID_PATTERNS,
  isContractId,
  isImplementation,
  isInstanceId,
  isModuleId,
  isResourceKind,
  isResourceRef,
  isVersion,
} from "./ids.js";

export {
  moduleAcceptsSlot,
  moduleOpensKind,
  normalizeModuleManifest,
  readModuleManifest,
  type AgentModuleManifest,
} from "./manifest.js";

export {
  MODULE_LOCK_SCHEMA,
  encodeModuleLock,
  lockHas,
  moduleLockOf,
  parseModuleLock,
  readModuleLock,
  type AgentModuleLock,
  type ModuleLockEntry,
} from "./lock.js";

export {
  COMPOSITION_SCHEMA,
  OPEN_MODES,
  encodeComposition,
  isOpenMode,
  linkComposition,
  parseComposition,
  readComposition,
  readModuleBundle,
  type AgentComposition,
  type CompositionInstance,
  type CompositionOpenRule,
  type LinkedComposition,
  type OpenMode,
} from "./composition.js";

export {
  RESOURCE_BINDINGS_SCHEMA,
  RESOURCE_BINDINGS_SCHEMA_V2,
  RESOURCE_BINDING_SCHEMAS,
  RESOURCE_TEMPLATE_MAX_INSTANCES,
  bindingContract,
  connectionFor,
  encodeResourceBindings,
  linkResourceBindings,
  parseResourceBindings,
  planTemplates,
  readResourceBindings,
  templateFor,
  type AgentResourceBindings,
  type AgentResourceBindingsV2,
  type LinkedResourceBindings,
  type ResourceBinding,
  type ResourceBindingPlan,
  type ResourceConnection,
  type ResourceTemplate,
} from "./bindings.js";

export {
  APP_PERMISSIONS_SCHEMA,
  encodeAppPermissions,
  parseAppPermissions,
  readAppPermissions,
  type AppPermissions,
} from "./permissions-doc.js";

export {
  OPEN_RESOURCE_INTENT,
  openResource,
  readOpenResourceIntent,
  readResourceLink,
  type OpenResourceIntent,
  type ResourceLink,
} from "./resource.js";

export {
  CONTRACT_LIMITS,
  type ContractIssue,
  type ContractIssueCode,
  type ContractResult,
} from "./validate.js";

export {
  CONFIG_KEY_PATTERN,
  CONFIG_LIMITS,
  type ConfigValueType,
  type InstanceConfig,
  type IntentContext,
  type ModuleConfigDeclaration,
  type ModuleConfigField,
} from "./config.js";
