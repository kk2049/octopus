/**
 * @claude-bot/app-registry — immutable Agentic App releases and one active pointer.
 *
 * Framework-neutral by construction: no React, no Dashboard, no Session Plus,
 * no HTTP and no database driver. The later Runtime Host and permission tasks
 * import `AppReleaseDescriptor` from here as the canonical contract.
 */

export {
  DEFAULT_LIMITS,
  DESCRIPTOR_FIELD_COVERAGE,
  EXECUTION_PROFILES,
  PACKAGE_LABEL_HEX,
  RELEASE_SCHEMA_VERSION,
  SOURCE_ATTESTATION_KINDS,
  assetNameProblem,
  computeGroupDigest,
  computePackageDigest,
  computeRecipeDigest,
  describeRelease,
  isForeignDigest,
  isSha256Hex,
  packageHostLabel,
  sha256Of,
  utf8Bytes,
  validateDescriptor,
  verifyPayload,
  type AppReleaseDescriptor,
  type ExecutionProfile,
  type PackageDigestInput,
  type RegistryIssue,
  type RegistryIssueCode,
  type RegistryLimits,
  type ReleaseAsset,
  type ReleaseBuildInput,
  type ReleaseComposition,
  type ReleaseEvidence,
  type ReleaseSpec,
  type SourceAttestation,
  type SourceAttestationKind,
  type Validated,
} from "./descriptor.js";

export type {
  ActivateOutcome,
  ActivateRequest,
  ActivationRow,
  ContentCheck,
  InstallProvenance,
  ReleaseCatalogRepository,
  ReleaseContentStore,
  ReleaseFilter,
  ReleaseRow,
  RemoveOutcome,
  StoredAsset,
  StoredAssetIdentity,
} from "./ports.js";

export {
  FileReleaseContentStore,
  assertSafeRoot,
  type ContentFaultPoint,
  type FileReleaseContentStoreOptions,
} from "./content-store.js";

export { MemoryReleaseCatalog } from "./memory-catalog.js";

export {
  AppReleaseRegistry,
  type ActiveRelease,
  type ActivateResult,
  type AppReleaseRegistryOptions,
  type DeactivateResult,
  type InspectResult,
  type InstallRequest,
  type InstallResult,
  type InstalledRelease,
  type ReconcileReport,
  type RegistryEvent,
  type RegistryListener,
  type ResolveResult,
  type UninstallResult,
} from "./registry.js";
