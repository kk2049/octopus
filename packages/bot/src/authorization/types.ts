/**
 * Canonical, explainable authorization intent.
 *
 * Nothing in this module is a capability. Persisted rows and policy-program
 * results become authority only after a trusted adapter derives a narrower
 * capability and the kernel Gate accepts the eventual call.
 */

export const DOMAIN_KINDS = ["personal", "organization", "workspace", "shared"] as const;
export type DomainKind = (typeof DOMAIN_KINDS)[number];

export const DOMAIN_AUTHORITY_KINDS = ["owner", "organization"] as const;
export type DomainAuthorityKind = (typeof DOMAIN_AUTHORITY_KINDS)[number];

export const HISTORY_POLICIES = ["all", "since_join"] as const;
export type HistoryPolicy = (typeof HISTORY_POLICIES)[number];

export interface AuthorityRef {
  kind: DomainAuthorityKind;
  id: string;
}

export interface AuthorizationDomain {
  id: string;
  kind: DomainKind;
  title: string;
  authority: AuthorityRef;
  /**
   * Display/planning metadata only. Consumers must implement a real sequence
   * boundary before claiming that `since_join` hides historical state.
   */
  historyPolicy: HistoryPolicy;
  createdAt: string;
  updatedAt: string;
}

export const RESOURCE_SENSITIVITIES = ["normal", "sensitive", "credential"] as const;
export type ResourceSensitivity = (typeof RESOURCE_SENSITIVITIES)[number];

/** A stable identifier in another subsystem, never a secret or a locator value. */
export interface OpaqueExternalRef {
  system: string;
  id: string;
}

export interface AuthorizationResource {
  id: string;
  /** Canonical hierarchical address. Permits still pin `id`, never this locator. */
  uri: string;
  owner: string;
  domainId: string;
  kind: string;
  title: string;
  sensitivity: ResourceSensitivity;
  externalRef: OpaqueExternalRef;
  createdAt: string;
  updatedAt: string;
}
export interface AuthorizationResourceAlias {
  id: string;
  owner: string;
  uri: string;
  targetUri: string;
  createdBy: string;
  createdAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
}


export const AUTHORIZATION_SUBJECT_TYPES = ["user", "app", "agent", "service"] as const;
export type AuthorizationSubjectType = (typeof AUTHORIZATION_SUBJECT_TYPES)[number];

export interface AuthorizationSubject {
  type: AuthorizationSubjectType;
  id: string;
}

export const PERMIT_MODES = ["ask", "allow"] as const;
export type PermitMode = (typeof PERMIT_MODES)[number];

export const PERMIT_SOURCES = ["user", "admin", "system-policy", "bootstrap", "migration"] as const;
export type PermitSource = (typeof PERMIT_SOURCES)[number];

export interface ExactPermit {
  id: string;
  subject: AuthorizationSubject;
  resourceId: string;
  operation: string;
  mode: PermitMode;
  authority: AuthorityRef;
  source: PermitSource;
  createdBy: string;
  createdAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
}

export const POLICY_EFFECTS = ["block", "deny", "ask", "allow"] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

export type PolicyScalar = string | number | boolean;
export type PolicyFactValue = PolicyScalar | readonly PolicyScalar[];
export type PolicyFacts = Readonly<Record<string, PolicyFactValue>>;

export interface HierarchyEdge {
  ancestor: string;
  descendant: string;
}

export type PolicyHierarchies = Readonly<Record<string, readonly HierarchyEdge[]>>;

export type PolicyValueRef = { fact: string } | { value: PolicyScalar };

export type PolicyCondition =
  | { op: "all"; conditions: readonly PolicyCondition[] }
  | { op: "any"; conditions: readonly PolicyCondition[] }
  | { op: "not"; condition: PolicyCondition }
  | { op: "eq"; left: PolicyValueRef; right: PolicyValueRef }
  | { op: "in"; value: PolicyValueRef; set: readonly PolicyScalar[] }
  | { op: "gte"; left: PolicyValueRef; right: PolicyValueRef }
  | {
      op: "ancestor";
      hierarchy: string;
      ancestor: PolicyValueRef;
      descendant: PolicyValueRef;
    };

export interface PolicyMatch {
  subjectTypes?: readonly AuthorizationSubjectType[];
  subjectIds?: readonly string[];
  resourceIds?: readonly string[];
  resourceKinds?: readonly string[];
  domainIds?: readonly string[];
  domainKinds?: readonly DomainKind[];
  operations?: readonly string[];
}

/**
 * Rules are immutable trusted constructor data. They are deliberately not a
 * browser-authored DSL and are never loaded from the authorization tables.
 */
export interface PolicyRule {
  id: string;
  title: string;
  authority: AuthorityRef;
  effect: PolicyEffect;
  /** deny/block are reserved for mandatory organization policy. */
  mandatory?: boolean;
  match: PolicyMatch;
  when?: PolicyCondition;
  explanation: string;
}

export interface AccessRequest {
  subject: AuthorizationSubject;
  resourceId: string;
  operation: string;
  facts?: PolicyFacts;
  hierarchies?: PolicyHierarchies;
}

export const TRANSFER_KINDS = ["snapshot", "live_view", "work_copy"] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

export interface FlowRequest extends Omit<AccessRequest, "operation"> {
  targetDomainId: string;
  transfer: TransferKind;
}

export interface AuthorizationChange {
  kind:
    | "domain-upserted"
    | "resource-upserted"
    | "resource-alias-put"
    | "resource-alias-revoked"
    | "permit-put"
    | "permit-revoked"
    | "defaults-updated";
  owner?: string;
  domainId?: string;
  resourceId?: string;
  subject?: AuthorizationSubject;
  operation?: string;
}

export const ACCESS_RESULTS = ["deny", "ask", "allow", "block"] as const;
export type AccessResult = (typeof ACCESS_RESULTS)[number];

export type DecisionStage = "validation" | "safety" | "baseline" | "rule" | "permit" | "default";

export interface DecisionStep {
  stage: DecisionStage;
  outcome: "matched" | "missed" | "applied";
  message: string;
  effect?: PolicyEffect;
  authority?: AuthorityRef;
  ruleId?: string;
  permitId?: string;
}

export interface AccessDecision {
  result: AccessResult;
  code: string;
  /** Makes it impossible for callers/UI to mistake this projection for a Gate. */
  enforcement: "intent-only";
  steps: readonly DecisionStep[];
}

export interface AppInstallDefaultProfile {
  version: 1;
  /** Fixed product defaults: reads/observation are convenient, not authority. */
  readMode: "allow";
  observeMode: "allow";
  writeMode: "deny" | "ask" | "allow";
  executeMode: "deny" | "ask" | "allow";
}

export interface StoredAppInstallDefaults {
  owner: string;
  profile: AppInstallDefaultProfile;
  source: "built-in" | "saved";
  updatedBy: string | null;
  updatedAt: string | null;
}
