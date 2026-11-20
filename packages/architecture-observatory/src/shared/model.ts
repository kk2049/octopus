export const ATLAS_SCHEMA_VERSION = 1 as const;

export type Criticality = "critical" | "high" | "normal" | "supporting";
export type EvidenceGrade = "derived" | "executable" | "declared" | "runtime";
export type ConstraintStatus = "pass" | "fail" | "waived" | "review" | "unknown";
export type FlowPerspective = "control" | "authority" | "data" | "lifecycle";

export interface SourceLocation {
  path: string;
  line: number;
  endLine?: number;
  symbol?: string;
  excerpt?: string[];
}

export interface ArchitectureZone {
  id: string;
  label: string;
  description: string;
  color: string;
  trust: "external" | "untrusted" | "trusted" | "critical";
}

export interface ArchitectureModuleDefinition {
  id: string;
  label: string;
  description: string;
  zone: string;
  criticality: Criticality;
  pathPrefixes: string[];
  tags?: string[];
  docs?: string[];
}

export interface FlowSeedStep {
  id: string;
  label: string;
  description?: string;
  zone: string;
  module?: string;
  after?: string[];
  role?: string;
  condition?: string;
  outcome?: string;
  authority?: string;
  /** End of the declared flow scope, not necessarily process/function termination. */
  terminal?: boolean;
  source?: SourceLocation;
  anchorRequired?: boolean;
}

export interface FlowCoverageContract {
  mode: "critical-branches";
  /** Exact code path or security boundary claimed by this declared contract. */
  scope: string;
  /** Explicitly out-of-scope paths; omission here is never proof of whole-program completeness. */
  exclusions?: string[];
}

export interface FlowDefinition {
  id: string;
  title: string;
  description: string;
  perspective: FlowPerspective;
  coverage?: FlowCoverageContract;
  entrySteps?: FlowSeedStep[];
}

export interface EvidenceReference {
  grade: EvidenceGrade;
  label: string;
  description?: string;
  source?: SourceLocation;
  document?: string;
  command?: string;
}

export type ConstraintMechanism =
  | {
      kind: "forbid-dependency";
      from: string[];
      to: string[];
      transitive?: boolean;
      includeTypeOnly?: boolean;
    }
  | {
      kind: "forbid-external";
      from: string[];
      patterns: string[];
      entrypoints?: string[];
      includeTypeOnly?: boolean;
    }
  | {
      kind: "no-cycles";
      modules?: string[];
    }
  | {
      kind: "flow-complete";
      flow: string;
      requiredSteps: string[];
      requiredEdges?: Array<{ from: string; to: string }>;
      requiredTerminals?: string[];
    }
  | {
      kind: "tcb-budget";
      budgetFile: string;
    };

export interface ArchitectureConstraintDefinition {
  id: string;
  title: string;
  description: string;
  concern: "modularity" | "authority" | "trust" | "data" | "lifecycle" | "reliability" | "delivery";
  severity: "critical" | "high" | "medium" | "info";
  mechanism?: ConstraintMechanism;
  evidence?: EvidenceReference[];
}

export interface AtlasConfig {
  $schema?: string;
  system: {
    id: string;
    title: string;
    description: string;
    sourceUrlTemplate?: string;
  };
  zones: ArchitectureZone[];
  modules: ArchitectureModuleDefinition[];
  flows: FlowDefinition[];
  constraints: ArchitectureConstraintDefinition[];
  analysis?: {
    sourceRoots?: string[];
    exclude?: string[];
    gitHistoryCommits?: number;
  };
}

export interface ArchitectureWaiver {
  constraintId: string;
  /** Stable, human-readable identifier emitted beside the exact constraint witness. */
  witness: string;
  reason: string;
  owner: string;
  created_at: string;
  expires_at: string;
}

export interface ArchitectureWaiverFile {
  $schema?: string;
  version: 1;
  waivers: ArchitectureWaiver[];
}

export interface GitFileFact {
  touches: number;
  additions: number;
  deletions: number;
  lastChangedAt?: string;
}

export interface FileFact {
  id: string;
  path: string;
  moduleId: string;
  packageId?: string;
  isTest: boolean;
  loc: number;
  codeLoc: number;
  git: GitFileFact;
  declarationCount: number;
  complexity: number;
}

export interface ModuleFact extends ArchitectureModuleDefinition {
  files: number;
  loc: number;
  codeLoc: number;
  testFiles: number;
  symbols: number;
  complexity: number;
  gitTouches: number;
  runtimeFanIn: number;
  runtimeFanOut: number;
  typeOnlyFanIn: number;
  typeOnlyFanOut: number;
  /** @deprecated Runtime-only compatibility alias; use runtimeFanIn. */
  fanIn: number;
  /** @deprecated Runtime-only compatibility alias; use runtimeFanOut. */
  fanOut: number;
  unmapped?: boolean;
}

export interface PackageFact {
  id: string;
  name: string;
  path: string;
  files: number;
  loc: number;
  dependencies: string[];
  devDependencies: string[];
}

/** One reusable browser module declared through the Agent Module ABI. */
export interface FrontendModuleFact {
  /** Stable module identity from `AgentModuleManifest.id`. */
  id: string;
  title: string;
  version: string;
  implementation: string;
  packageId: string;
  packagePath: string;
  slots: string[];
  /** Typed ports, with their declaration package when static resolution found it. */
  ports: Array<{ id: string; packageId?: string }>;
  opens: string[];
  /** Short Chinese explanation derived from the manifest's own semantics. */
  summary: string;
  /** Semantic family used by the inspector's capability-free interactive demo; it never executes View code. */
  preview: "search" | "tree" | "chat" | "document" | "form" | "board" | "slides" | "detail" | "status" | "panel";
  /** Declarative per-instance knobs, when the manifest exposes them statically. */
  configKeys: string[];
  source: SourceLocation;
}

/** One typed compatibility seam consumed by Views and optionally served by a trusted Provider. */
export interface ModuleContractFact {
  id: string;
  packageId?: string;
  packagePath?: string;
  summary: string;
  actions: Array<{ id: string; summary: string; operation?: string }>;
  source?: SourceLocation;
  /** No catalog Provider means the port is App/Host-adapted or not wired yet. */
  provision: "trusted-provider" | "app-or-host";
}

/** A trusted ResourceProviderDefinition factory, not an arbitrary non-React package. */
export interface BackendModuleFact {
  id: string;
  name: string;
  summary: string;
  packageId: string;
  path: string;
  files: number;
  loc: number;
  kind: "provider";
  contracts: string[];
  actions: Array<{ id: string; summary: string; operation?: string }>;
  /** True when a non-test trusted composition root calls catalog.register(factory()). */
  registered: boolean;
  /** Provider-to-provider edges only; package imports deliberately do not count. */
  dependencies: string[];
  source: SourceLocation;
}

export interface ModuleEcosystemDependencyFact {
  /** `frontend:<package>:<module>` or `backend:<package>`. */
  from: string;
  /** Contract or Provider node, depending on the relation. */
  to: string;
  /** Semantic ecosystem relations; never raw package.json imports. */
  kind: "requires" | "provides" | "provider";
  label: string;
}

export interface ModuleEcosystemFact {
  frontend: FrontendModuleFact[];
  contracts: ModuleContractFact[];
  backend: BackendModuleFact[];
  dependencies: ModuleEcosystemDependencyFact[];
  /** Discovery gaps are visible instead of silently dropping a typed manifest. */
  issues: Array<{ message: string; source?: SourceLocation }>;
}

export interface DependencySample {
  source: SourceLocation;
  specifier: string;
  typeOnly: boolean;
  dynamic: boolean;
  test: boolean;
}

export interface DependencyFact {
  id: string;
  from: string;
  to: string;
  runtimeCount: number;
  typeOnlyCount: number;
  testCount: number;
  dynamicCount: number;
  circular: boolean;
  samples: DependencySample[];
}

export interface ExternalDependencyFact {
  id: string;
  from: string;
  package: string;
  count: number;
  typeOnlyCount: number;
  testCount: number;
  builtin: boolean;
  samples: DependencySample[];
}

export interface ArchitectureAnnotation {
  id: string;
  attributes: Record<string, string>;
  source: SourceLocation;
  symbolId?: string;
}

export interface SymbolFact {
  id: string;
  name: string;
  qualifiedName: string;
  kind: "function" | "method" | "class" | "variable" | "constructor";
  moduleId: string;
  fileId: string;
  source: SourceLocation;
  exported: boolean;
  loc: number;
  complexity: number;
  annotations: string[];
}

export interface CallFact {
  id: string;
  from: string;
  to: string;
  count: number;
  samples: SourceLocation[];
}

export interface FlowStepFact extends FlowSeedStep {
  annotationId?: string;
  source?: SourceLocation;
  enforces: string[];
}

export interface FlowFact extends FlowDefinition {
  steps: FlowStepFact[];
  missingAnchors: string[];
  duplicateAnchors: string[];
  missingPredecessors: Array<{ stepId: string; predecessorId: string }>;
  cycles: string[][];
  invalidAttributes: string[];
}

export interface ConstraintViolation {
  /** Copy this exact value into architecture/waivers.json to waive only this witness. */
  witness: string;
  message: string;
  path?: string[];
  source?: SourceLocation;
}

export interface WaivedConstraintViolation extends ConstraintViolation {
  waiver: ArchitectureWaiver;
}

export interface ConstraintResult extends ArchitectureConstraintDefinition {
  status: ConstraintStatus;
  summary: string;
  evidence: EvidenceReference[];
  violations: ConstraintViolation[];
  waivedViolations: WaivedConstraintViolation[];
}

export interface TcbFileFact {
  path: string;
  codeLoc: number;
  baseline?: number;
  critical: boolean;
  delta?: number;
}

export interface TcbFact {
  constraintId: string;
  budgetFile: string;
  entries: string[];
  files: TcbFileFact[];
  total: number;
  baseline: number;
  tolerance: number;
  delta: number;
  unregistered: string[];
  stale: string[];
}

export interface ReviewFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "info";
  title: string;
  description: string;
  moduleIds: string[];
  source?: SourceLocation;
  constraintId?: string;
  signal: "violation" | "cycle" | "hotspot" | "coverage" | "tooling" | "waiver";
}

export interface ArchitectureAtlas {
  schemaVersion: typeof ATLAS_SCHEMA_VERSION;
  meta: {
    systemId: string;
    title: string;
    description: string;
    generatedAt: string;
    inputFingerprint: string;
    commit: string;
    branch: string;
    dirty: boolean;
    root: string;
    sourceUrlTemplate?: string;
    analyzer: {
      dependencyCruiser: string;
      typescript: string;
    };
    limitations: string[];
  };
  zones: ArchitectureZone[];
  modules: ModuleFact[];
  packages: PackageFact[];
  moduleEcosystem: ModuleEcosystemFact;
  files: FileFact[];
  dependencies: DependencyFact[];
  externalDependencies: ExternalDependencyFact[];
  symbols: SymbolFact[];
  calls: CallFact[];
  annotations: ArchitectureAnnotation[];
  flows: FlowFact[];
  constraints: ConstraintResult[];
  tcbs: TcbFact[];
  findings: ReviewFinding[];
}
