import {
  artifactId,
  capabilityContractId,
  capabilityId,
  clipStatement,
  contractEntityId,
  sourceId,
} from "../ids.js";
import { parseFrontmatter } from "../markdown.js";
import {
  ARTIFACT_ROLES,
  CONTRACT_DESIRED,
  MAX_QUOTE_CHARS,
  MAX_STATEMENT_CHARS,
  NODE_STATUSES,
  type ArtifactRole,
  type ConformanceArtifact,
  type ConformanceObservation,
  type ContractCell,
  type ContractDesired,
  type KnowledgeEdge,
  type KnowledgeNode,
  type NodeKind,
  type NodeStatus,
  type Relation,
} from "../model.js";
import { loadCapabilities } from "./capabilities.js";
import { emptyOutput, mapLimit, type SourceContext, type SourceOutput } from "./context.js";

export const CONTRACTS_DIR = "architecture/knowledge/contracts/";
export const CONTRACT_SCHEMA = "octopus-capability-contract/v1";

const LOCAL_KEY = /^[a-z0-9][a-z0-9-]*$/;
const DIMENSION_VALUE = /^[a-z0-9][a-z0-9-]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REPO_PATH = /^(?:(?:packages|plugins|doc|scripts|architecture|ctl|tools|ops|\.claude|\.agents)\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)$/;
const CREDENTIAL = /(token|password|secret|密码|私钥)\s*[:=]\s*\S{6,}/i;
const EXISTING_ASSERTION_REF = /^(?:principle|requirement|decision|obligation):[A-Za-z0-9:._/-]+$/;
const SOURCE_TYPES = ["ticket_body", "ticket_message", "delivery", "cli_report", "adr", "package_doc", "rule", "landing", "commit"] as const;
const ARTIFACT_KINDS = ["file", "symbol", "test", "config", "schema"] as const;
const EXCEPTION_KINDS = ["waiver", "not_applicable"] as const;

export interface ContractArtifactSelector {
  key: string;
  kind: (typeof ARTIFACT_KINDS)[number];
  repo: "octopus";
  path: string;
  symbol?: string;
  test_name?: string;
}

export interface ContractCodeIndexArtifactSelector {
  kind: (typeof ARTIFACT_KINDS)[number];
  path: string;
  qualifiedName?: string;
  testName?: string;
  lastVerifiedSha: string;
}

export interface ContractResolvedArtifact {
  kind: (typeof ARTIFACT_KINDS)[number];
  path: string;
  qualifiedName?: string;
  testName?: string;
  line?: number;
}

/** Minimal structural seam; the full code-index query adapter must not be imported here. */
export interface ContractCodeIndexResolver {
  readonly gitSha: string;
  readonly manifestDigest: string;
  resolveArtifact(selector: ContractCodeIndexArtifactSelector): ContractResolvedArtifact | null;
}

interface LifecycleDef {
  status: NodeStatus;
  effective_from?: string;
  valid_to?: string;
  supersedes?: string[];
  reaffirms?: string[];
}

export interface ContractSourceDef {
  key: string;
  type: (typeof SOURCE_TYPES)[number];
  ref: string;
  message_id?: number;
  anchor?: string;
  revision?: string;
  quote?: string;
}

export interface ContractPrincipleDef extends LifecycleDef {
  key: string;
  statement: string;
  source_keys: string[];
}

export interface ContractObligationDef extends LifecycleDef {
  key: string;
  statement: string;
  strength: "must" | "should";
  principle_refs: string[];
  source_refs: string[];
}

export interface ContractScenarioDef extends LifecycleDef {
  key: string;
  actor: string;
  trigger: string;
  preconditions: string[];
  action: string;
  expected_outcome: string;
  failure_semantics: string;
  source_refs: string[];
}

export interface ContractExceptionDef extends LifecycleDef {
  key: string;
  kind: (typeof EXCEPTION_KINDS)[number];
  targets: string[];
  reason: string;
  owner: string;
  created_at: string;
  expires_at?: string;
  review_after?: string;
  source_refs: string[];
}

export interface ContractDesiredDef {
  key: string;
  scenario: string;
  provider: string | string[];
  launch_mode: string | string[];
  state: string | string[];
  action: string | string[];
  desired: ContractDesired;
  obligation_refs: string[];
  expected_ux: string;
  trust_semantics: string;
  failure_semantics: string;
  source_refs: string[];
  exception_ref?: string;
}

export interface ContractRealizationDef {
  target: string;
  artifact: string;
  role: ArtifactRole;
  source_refs: string[];
}

export interface CapabilityContractBlock {
  dimensions: {
    providers: string[];
    launch_modes: string[];
    states: string[];
    actions: string[];
  };
  sources: ContractSourceDef[];
  principles: ContractPrincipleDef[];
  obligations: ContractObligationDef[];
  scenarios: ContractScenarioDef[];
  exceptions: ContractExceptionDef[];
  desired: ContractDesiredDef[];
  artifacts: ContractArtifactSelector[];
  realizations: ContractRealizationDef[];
}

export interface ContractDocument {
  schema: typeof CONTRACT_SCHEMA;
  id: string;
  title: string;
  status: NodeStatus;
  capabilities: string[];
  effective_from?: string;
  valid_to?: string;
  supersedes: string[];
  reaffirms: string[];
  block: CapabilityContractBlock;
  sourceRef: string;
  sourceSha: string;
}

export interface ContractValidationContext {
  sourceRef: string;
  sourceSha: string;
  evaluationAsOf: string;
  capabilities: ReadonlySet<string>;
  existingPaths: ReadonlySet<string>;
}

export interface ContractProjection {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  cells: ContractCell[];
  observations: ConformanceObservation[];
  observationArtifacts: ConformanceArtifact[];
}

interface ExpandedDesired {
  definition: ContractDesiredDef;
  key: string;
  provider: string;
  launch_mode: string;
  state: string;
  action: string;
}

export function validateCapabilityContract(markdown: string, context: ContractValidationContext): ContractDocument {
  const errors: string[] = [];
  const { data, body } = parseFrontmatter(markdown);
  const frontmatterFields = new Set(["schema", "id", "title", "status", "capabilities", "effective_from", "valid_to", "supersedes", "reaffirms"]);
  for (const key of Object.keys(data)) if (!frontmatterFields.has(key)) errors.push(`frontmatter: unknown field ${key}`);

  const schema = readString(data.schema, "frontmatter.schema", errors);
  const id = readKey(data.id, "frontmatter.id", errors);
  const title = readBoundedText(data.title, "frontmatter.title", errors, 160);
  const status = readEnum(data.status, NODE_STATUSES, "frontmatter.status", errors);
  const capabilities = readStringArray(data.capabilities, "frontmatter.capabilities", errors, { nonEmpty: true, tokens: false });
  const effectiveFrom = readOptionalDate(data.effective_from, "frontmatter.effective_from", errors);
  const validTo = readOptionalDate(data.valid_to, "frontmatter.valid_to", errors);
  const supersedes = readStringArray(data.supersedes ?? [], "frontmatter.supersedes", errors, { nonEmpty: false, tokens: true });
  const reaffirms = readStringArray(data.reaffirms ?? [], "frontmatter.reaffirms", errors, { nonEmpty: false, tokens: true });
  if (schema !== CONTRACT_SCHEMA) errors.push(`frontmatter.schema must be ${CONTRACT_SCHEMA}`);
  for (const capability of capabilities) if (!context.capabilities.has(capability)) errors.push(`frontmatter.capabilities: unknown capability ${capability}`);
  validateLifecycle({ status, effective_from: effectiveFrom, valid_to: validTo }, "frontmatter", context.evaluationAsOf, errors);

  const blocks = [...body.matchAll(/^```octopus-contract[\t ]*\r?\n([\s\S]*?)^```[\t ]*$/gm)];
  if (blocks.length !== 1) errors.push(`expected exactly one fenced octopus-contract JSON block, found ${blocks.length}`);
  let parsed: unknown = null;
  if (blocks.length === 1) {
    try {
      parsed = JSON.parse(blocks[0][1]);
    } catch (error) {
      errors.push(`octopus-contract block is not strict JSON: ${String(error)}`);
    }
  }
  const block = validateBlock(parsed, context, errors);
  if (errors.length) throw new Error(`capability contract ${context.sourceRef} is invalid:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  return {
    schema: CONTRACT_SCHEMA,
    id,
    title,
    status,
    capabilities,
    effective_from: effectiveFrom,
    valid_to: validTo,
    supersedes,
    reaffirms,
    block,
    sourceRef: context.sourceRef,
    sourceSha: context.sourceSha,
  };
}

function validateBlock(value: unknown, context: ContractValidationContext, errors: string[]): CapabilityContractBlock {
  const root = readObject(value, "block", errors);
  expectClosed(root, ["dimensions", "sources", "principles", "obligations", "scenarios", "exceptions", "desired", "artifacts", "realizations"], "block", errors);
  const dimensionsObject = readObject(root.dimensions, "dimensions", errors);
  expectClosed(dimensionsObject, ["providers", "launch_modes", "states", "actions"], "dimensions", errors);
  const dimensions = {
    providers: readStringArray(dimensionsObject.providers, "dimensions.providers", errors, { nonEmpty: true, tokens: true }),
    launch_modes: readStringArray(dimensionsObject.launch_modes, "dimensions.launch_modes", errors, { nonEmpty: true, tokens: true }),
    states: readStringArray(dimensionsObject.states, "dimensions.states", errors, { nonEmpty: true, tokens: true }),
    actions: readStringArray(dimensionsObject.actions, "dimensions.actions", errors, { nonEmpty: true, tokens: true }),
  };

  const sources = readArray(root.sources, "sources", errors).map((item, index) => validateSource(item, `sources[${index}]`, errors));
  const principles = readArray(root.principles, "principles", errors).map((item, index) => validatePrinciple(item, `principles[${index}]`, context, errors));
  const obligations = readArray(root.obligations, "obligations", errors).map((item, index) => validateObligation(item, `obligations[${index}]`, context, errors));
  const scenarios = readArray(root.scenarios, "scenarios", errors).map((item, index) => validateScenario(item, `scenarios[${index}]`, context, errors));
  const exceptions = readArray(root.exceptions, "exceptions", errors).map((item, index) => validateException(item, `exceptions[${index}]`, context, errors));
  const desired = readArray(root.desired, "desired", errors).map((item, index) => validateDesired(item, `desired[${index}]`, errors));
  const artifacts = readArray(root.artifacts, "artifacts", errors).map((item, index) => validateArtifact(item, `artifacts[${index}]`, context, errors));
  const realizations = readArray(root.realizations, "realizations", errors).map((item, index) => validateRealization(item, `realizations[${index}]`, errors));

  checkUniqueKeys(sources, "sources", errors);
  checkUniqueKeys(principles, "principles", errors);
  checkUniqueKeys(obligations, "obligations", errors);
  checkUniqueKeys(scenarios, "scenarios", errors);
  checkUniqueKeys(exceptions, "exceptions", errors);
  checkUniqueKeys(desired, "desired", errors);
  checkUniqueKeys(artifacts, "artifacts", errors);
  checkUniqueSourceCoordinates(sources, errors);

  const sourceKeys = new Set(sources.map((item) => item.key));
  const principleKeys = new Set(principles.map((item) => item.key));
  const obligationKeys = new Set(obligations.map((item) => item.key));
  const scenarioKeys = new Set(scenarios.map((item) => item.key));
  const exceptionByKey = new Map(exceptions.map((item) => [item.key, item]));
  const desiredKeys = new Set(desired.map((item) => item.key));
  const artifactKeys = new Set(artifacts.map((item) => item.key));
  const expandedDesired = expandDesired(desired);

  for (const principle of principles) validateSourceRefs(principle.source_keys, sourceKeys, `principle ${principle.key}`, errors, false);
  for (const obligation of obligations) {
    for (const ref of obligation.principle_refs) if (!principleKeys.has(ref)) errors.push(`obligation ${obligation.key}: unknown principle ${ref}`);
    validateSourceRefs(obligation.source_refs, sourceKeys, `obligation ${obligation.key}`, errors, true);
    validateLineage(obligation, "obligation", obligationKeys, `obligation ${obligation.key}`, errors);
  }
  for (const scenario of scenarios) {
    validateSourceRefs(scenario.source_refs, sourceKeys, `scenario ${scenario.key}`, errors, true);
    validateLineage(scenario, "scenario", scenarioKeys, `scenario ${scenario.key}`, errors);
  }
  for (const principle of principles) {
    validateLineage(principle, "principle", principleKeys, `principle ${principle.key}`, errors);
    if (!obligations.some((obligation) => obligation.principle_refs.includes(principle.key))) errors.push(`principle ${principle.key}: no operational obligation`);
  }

  for (const exception of exceptions) {
    validateSourceRefs(exception.source_refs, sourceKeys, `exception ${exception.key}`, errors, true);
    validateLineage(exception, "exception", new Set(exceptions.map((item) => item.key)), `exception ${exception.key}`, errors);
    for (const target of exception.targets) {
      if (target.startsWith("obligation:")) {
        if (!obligationKeys.has(target.slice("obligation:".length))) errors.push(`exception ${exception.key}: unknown target ${target}`);
      } else if (target.startsWith("desired:")) {
        if (!desiredKeys.has(target.slice("desired:".length))) errors.push(`exception ${exception.key}: unknown target ${target}`);
      } else if (!target.startsWith("constraint:")) {
        errors.push(`exception ${exception.key}: invalid target ${target}`);
      }
    }
    if (exception.status === "active" && !resolvedExceptionCells(exception, expandedDesired).length) {
      errors.push(`exception ${exception.key}: active exceptions must resolve to at least one expanded desired-conformance cell with provider, launch_mode, state and action scope`);
    }
  }

  const tuples = new Set<string>();
  for (const cell of expandedDesired) {
    const definition = cell.definition;
    if (!scenarioKeys.has(definition.scenario)) errors.push(`desired ${definition.key}: unknown scenario ${definition.scenario}`);
    for (const ref of definition.obligation_refs) if (!obligationKeys.has(ref)) errors.push(`desired ${definition.key}: unknown obligation ${ref}`);
    validateSourceRefs(definition.source_refs, sourceKeys, `desired ${definition.key}`, errors, true);
    checkDimension(cell.provider, dimensions.providers, `desired ${definition.key}.provider`, errors);
    checkDimension(cell.launch_mode, dimensions.launch_modes, `desired ${definition.key}.launch_mode`, errors);
    checkDimension(cell.state, dimensions.states, `desired ${definition.key}.state`, errors);
    checkDimension(cell.action, dimensions.actions, `desired ${definition.key}.action`, errors);
    const tuple = [cell.provider, cell.launch_mode, cell.state, cell.action].join("\0");
    if (tuples.has(tuple)) errors.push(`desired ${definition.key}: duplicate provider/launch_mode/state/action tuple`);
    tuples.add(tuple);

    if (definition.desired === "required") {
      if (definition.exception_ref) errors.push(`desired ${definition.key}: required cells cannot name an exception`);
      continue;
    }
    if (!definition.exception_ref) {
      errors.push(`desired ${definition.key}: ${definition.desired} requires a scoped exception`);
      continue;
    }
    const exception = exceptionByKey.get(definition.exception_ref);
    if (!exception) {
      errors.push(`desired ${definition.key}: unknown exception ${definition.exception_ref}`);
      continue;
    }
    if (exception.status !== "active") errors.push(`desired ${definition.key}: exception ${exception.key} is not active`);
    if (exception.effective_from && exception.effective_from > context.evaluationAsOf) errors.push(`desired ${definition.key}: exception ${exception.key} is not yet effective`);
    if (!exception.targets.includes(`desired:${definition.key}`)) errors.push(`desired ${definition.key}: exception ${exception.key} is not scoped to this cell definition`);
    if (definition.desired === "not_applicable" && exception.kind !== "not_applicable") errors.push(`desired ${definition.key}: not_applicable requires a not_applicable exception`);
    if ((definition.desired === "degraded" || definition.desired === "unsupported") && exception.kind !== "waiver") errors.push(`desired ${definition.key}: ${definition.desired} requires a waiver`);
  }

  for (const realization of realizations) {
    if (!artifactKeys.has(realization.artifact)) errors.push(`realization ${realization.target}: unknown artifact ${realization.artifact}`);
    validateSourceRefs(realization.source_refs, sourceKeys, `realization ${realization.target}`, errors, true);
    const [kind, key] = splitTarget(realization.target);
    if (kind === "obligation" && !obligationKeys.has(key)) errors.push(`realization: unknown target ${realization.target}`);
    else if (kind === "scenario" && !scenarioKeys.has(key)) errors.push(`realization: unknown target ${realization.target}`);
    else if (kind === "desired" && !desiredKeys.has(key)) errors.push(`realization: unknown target ${realization.target}`);
    else if (!kind || !["obligation", "scenario", "desired"].includes(kind)) errors.push(`realization: invalid target ${realization.target}`);
  }

  validateLineageCycles(principles, "principle", errors);
  validateLineageCycles(obligations, "obligation", errors);
  validateLineageCycles(scenarios, "scenario", errors);
  validateLineageCycles(exceptions, "exception", errors);
  return { dimensions, sources, principles, obligations, scenarios, exceptions, desired, artifacts, realizations };
}

function validateSource(value: unknown, label: string, errors: string[]): ContractSourceDef {
  const object = readObject(value, label, errors);
  expectClosed(object, ["key", "type", "ref", "message_id", "anchor", "revision", "quote"], label, errors);
  const type = readEnum(object.type, SOURCE_TYPES, `${label}.type`, errors);
  const ref = readBoundedText(object.ref, `${label}.ref`, errors, 300);
  if (ref.startsWith("/") || ref.includes("../") || /^transcript:/i.test(ref)) errors.push(`${label}.ref must be a canonical public coordinate, not a private path or transcript`);
  const messageId = object.message_id === undefined ? undefined : readPositiveInteger(object.message_id, `${label}.message_id`, errors);
  if (type === "ticket_message" && messageId === undefined) errors.push(`${label}.message_id is required for ticket_message`);
  if (type !== "ticket_message" && messageId !== undefined) errors.push(`${label}.message_id is only valid for ticket_message`);
  const quote = object.quote === undefined ? undefined : readBoundedText(object.quote, `${label}.quote`, errors, MAX_QUOTE_CHARS);
  return {
    key: readKey(object.key, `${label}.key`, errors),
    type,
    ref,
    message_id: messageId,
    anchor: readOptionalString(object.anchor, `${label}.anchor`, errors, 160),
    revision: readOptionalString(object.revision, `${label}.revision`, errors, 160),
    quote,
  };
}

function validatePrinciple(value: unknown, label: string, context: ContractValidationContext, errors: string[]): ContractPrincipleDef {
  const object = readObject(value, label, errors);
  expectClosed(object, ["key", "statement", "source_keys", ...lifecycleFields], label, errors);
  return {
    key: readKey(object.key, `${label}.key`, errors),
    statement: readAtomicText(object.statement, `${label}.statement`, errors),
    source_keys: readStringArray(object.source_keys, `${label}.source_keys`, errors, { nonEmpty: true, tokens: true }),
    ...readLifecycle(object, label, context.evaluationAsOf, errors),
  };
}

function validateObligation(value: unknown, label: string, context: ContractValidationContext, errors: string[]): ContractObligationDef {
  const object = readObject(value, label, errors);
  expectClosed(object, ["key", "statement", "strength", "principle_refs", "source_refs", ...lifecycleFields], label, errors);
  return {
    key: readKey(object.key, `${label}.key`, errors),
    statement: readAtomicText(object.statement, `${label}.statement`, errors),
    strength: readEnum(object.strength, ["must", "should"] as const, `${label}.strength`, errors),
    principle_refs: readStringArray(object.principle_refs, `${label}.principle_refs`, errors, { nonEmpty: true, tokens: true }),
    source_refs: readStringArray(object.source_refs, `${label}.source_refs`, errors, { nonEmpty: true, tokens: false }),
    ...readLifecycle(object, label, context.evaluationAsOf, errors),
  };
}

function validateScenario(value: unknown, label: string, context: ContractValidationContext, errors: string[]): ContractScenarioDef {
  const object = readObject(value, label, errors);
  expectClosed(object, ["key", "actor", "trigger", "preconditions", "action", "expected_outcome", "failure_semantics", "source_refs", ...lifecycleFields], label, errors);
  return {
    key: readKey(object.key, `${label}.key`, errors),
    actor: readBoundedText(object.actor, `${label}.actor`, errors, 160),
    trigger: readAtomicText(object.trigger, `${label}.trigger`, errors),
    preconditions: readStringArray(object.preconditions, `${label}.preconditions`, errors, { nonEmpty: false, tokens: false }).map((item, index) => validateTextValue(item, `${label}.preconditions[${index}]`, errors)),
    action: readAtomicText(object.action, `${label}.action`, errors),
    expected_outcome: readAtomicText(object.expected_outcome, `${label}.expected_outcome`, errors),
    failure_semantics: readAtomicText(object.failure_semantics, `${label}.failure_semantics`, errors),
    source_refs: readStringArray(object.source_refs, `${label}.source_refs`, errors, { nonEmpty: true, tokens: false }),
    ...readLifecycle(object, label, context.evaluationAsOf, errors),
  };
}

function validateException(value: unknown, label: string, context: ContractValidationContext, errors: string[]): ContractExceptionDef {
  const object = readObject(value, label, errors);
  expectClosed(object, ["key", "kind", "targets", "reason", "owner", "created_at", "expires_at", "review_after", "source_refs", ...lifecycleFields], label, errors);
  const kind = readEnum(object.kind, EXCEPTION_KINDS, `${label}.kind`, errors);
  const expiresAt = readOptionalDate(object.expires_at, `${label}.expires_at`, errors);
  const reviewAfter = readOptionalDate(object.review_after, `${label}.review_after`, errors);
  if (kind === "waiver" && !expiresAt) errors.push(`${label}.expires_at is required for a waiver`);
  if (kind === "not_applicable" && !reviewAfter) errors.push(`${label}.review_after is required for not_applicable`);
  if (expiresAt && expiresAt < context.evaluationAsOf) errors.push(`${label} expired before evaluation_as_of ${context.evaluationAsOf}`);
  if (reviewAfter && reviewAfter < context.evaluationAsOf) errors.push(`${label} review_after is before evaluation_as_of ${context.evaluationAsOf}`);
  const createdAt = readDate(object.created_at, `${label}.created_at`, errors);
  if (createdAt > context.evaluationAsOf) errors.push(`${label}.created_at is after evaluation_as_of ${context.evaluationAsOf}`);
  return {
    key: readKey(object.key, `${label}.key`, errors),
    kind,
    targets: readStringArray(object.targets, `${label}.targets`, errors, { nonEmpty: true, tokens: false }),
    reason: readAtomicText(object.reason, `${label}.reason`, errors),
    owner: readBoundedText(object.owner, `${label}.owner`, errors, 120),
    created_at: createdAt,
    expires_at: expiresAt,
    review_after: reviewAfter,
    source_refs: readStringArray(object.source_refs, `${label}.source_refs`, errors, { nonEmpty: true, tokens: false }),
    ...readLifecycle(object, label, context.evaluationAsOf, errors),
  };
}

function validateDesired(value: unknown, label: string, errors: string[]): ContractDesiredDef {
  const object = readObject(value, label, errors);
  expectClosed(object, ["key", "scenario", "provider", "launch_mode", "state", "action", "desired", "obligation_refs", "expected_ux", "trust_semantics", "failure_semantics", "source_refs", "exception_ref"], label, errors);
  return {
    key: readKey(object.key, `${label}.key`, errors),
    scenario: readKey(object.scenario, `${label}.scenario`, errors),
    provider: readDimensionSelector(object.provider, `${label}.provider`, errors),
    launch_mode: readDimensionSelector(object.launch_mode, `${label}.launch_mode`, errors),
    state: readDimensionSelector(object.state, `${label}.state`, errors),
    action: readDimensionSelector(object.action, `${label}.action`, errors),
    desired: readEnum(object.desired, CONTRACT_DESIRED, `${label}.desired`, errors),
    obligation_refs: readStringArray(object.obligation_refs, `${label}.obligation_refs`, errors, { nonEmpty: true, tokens: true }),
    expected_ux: readAtomicText(object.expected_ux, `${label}.expected_ux`, errors),
    trust_semantics: readAtomicText(object.trust_semantics, `${label}.trust_semantics`, errors),
    failure_semantics: readAtomicText(object.failure_semantics, `${label}.failure_semantics`, errors),
    source_refs: readStringArray(object.source_refs, `${label}.source_refs`, errors, { nonEmpty: true, tokens: false }),
    exception_ref: object.exception_ref === undefined ? undefined : readKey(object.exception_ref, `${label}.exception_ref`, errors),
  };
}

function validateArtifact(value: unknown, label: string, context: ContractValidationContext, errors: string[]): ContractArtifactSelector {
  const object = readObject(value, label, errors);
  expectClosed(object, ["key", "kind", "repo", "path", "symbol", "test_name"], label, errors);
  const kind = readEnum(object.kind, ARTIFACT_KINDS, `${label}.kind`, errors);
  const repo = readEnum(object.repo, ["octopus"] as const, `${label}.repo`, errors);
  const path = readString(object.path, `${label}.path`, errors);
  if (!REPO_PATH.test(path)) errors.push(`${label}.path must be repository-relative`);
  if (!context.existingPaths.has(path)) errors.push(`${label}.path does not exist at the graph baseline: ${path}`);
  const symbol = readOptionalString(object.symbol, `${label}.symbol`, errors, 300);
  const testName = readOptionalString(object.test_name, `${label}.test_name`, errors, 300);
  if (kind === "symbol" && !symbol) errors.push(`${label}.symbol is required for symbol artifacts`);
  if (kind === "test" && !testName) errors.push(`${label}.test_name is required for test artifacts`);
  if (kind !== "symbol" && symbol) errors.push(`${label}.symbol is only valid for symbol artifacts`);
  if (kind !== "test" && testName) errors.push(`${label}.test_name is only valid for test artifacts`);
  return { key: readKey(object.key, `${label}.key`, errors), kind, repo, path, symbol, test_name: testName };
}

function validateRealization(value: unknown, label: string, errors: string[]): ContractRealizationDef {
  const object = readObject(value, label, errors);
  expectClosed(object, ["target", "artifact", "role", "source_refs"], label, errors);
  return {
    target: readString(object.target, `${label}.target`, errors),
    artifact: readKey(object.artifact, `${label}.artifact`, errors),
    role: readEnum(object.role, ARTIFACT_ROLES, `${label}.role`, errors),
    source_refs: readStringArray(object.source_refs, `${label}.source_refs`, errors, { nonEmpty: true, tokens: false }),
  };
}

export async function contractsSource(
  ctx: SourceContext,
  options: { codeIndex?: ContractCodeIndexResolver } = {},
): Promise<SourceOutput & ContractProjection> {
  const files = await ctx.list([`${CONTRACTS_DIR}*.md`]);
  if (!files.length) return { ...emptyOutput(), cells: [], observations: [], observationArtifacts: [] };
  const [{ doc }, existing] = await Promise.all([loadCapabilities(ctx), ctx.list([])]);
  const validation = {
    sourceSha: ctx.sha,
    evaluationAsOf: ctx.evaluationAsOf,
    capabilities: new Set(doc.capabilities.map((capability) => capability.id)),
    existingPaths: new Set(existing),
  };
  const documents = await mapLimit(files, 6, async (file) => validateCapabilityContract(await ctx.read(file), { ...validation, sourceRef: file }));
  const out: SourceOutput & ContractProjection = { ...emptyOutput(), cells: [], observations: [], observationArtifacts: [] };
  for (const document of documents.sort((a, b) => a.id.localeCompare(b.id))) {
    const projected = projectContract(document, ctx, options.codeIndex);
    out.nodes.push(...projected.nodes);
    out.edges.push(...projected.edges);
    out.cells.push(...projected.cells);
    out.observations.push(...projected.observations);
    out.observationArtifacts.push(...projected.observationArtifacts);
  }
  return out;
}

function projectContract(document: ContractDocument, ctx: SourceContext, codeIndex?: ContractCodeIndexResolver): ContractProjection {
  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];
  const cells: ContractCell[] = [];
  const observations: ConformanceObservation[] = [];
  const observationArtifacts: ConformanceArtifact[] = [];
  const contractId = capabilityContractId(document.id);
  const expandedDesired = expandDesired(document.block.desired);
  const edge = (from: string, relation: Relation, to: string): KnowledgeEdge => ({
    from_id: from,
    relation,
    to_id: to,
    method: "declared",
    certainty: "exact",
    source_ref: document.sourceRef,
    source_sha: document.sourceSha,
    observed_at: ctx.observedAt,
  });
  const node = (kind: NodeKind, id: string, statement: string, lifecycle: LifecycleDef, metadata: Record<string, unknown> = {}): KnowledgeNode => ({
    id,
    kind,
    statement: clipStatement(statement),
    status: lifecycle.status,
    authority: "declared",
    source_ref: document.sourceRef,
    source_sha: document.sourceSha,
    valid_from: lifecycle.effective_from,
    valid_to: lifecycle.valid_to,
    method: "declared",
    certainty: "exact",
    metadata,
  });
  const contractLifecycle = { status: document.status, effective_from: document.effective_from, valid_to: document.valid_to };
  nodes.push(node("capability_contract", contractId, document.title, contractLifecycle, {
    schema: document.schema,
    capabilities: [...document.capabilities].sort(),
    evaluation_as_of: ctx.evaluationAsOf,
  }));
  for (const capability of document.capabilities) edges.push(edge(contractId, "contract_for", capabilityId(capability)));
  for (const target of document.supersedes) edges.push(edge(contractId, "supersedes", capabilityContractId(target)));
  for (const target of document.reaffirms) edges.push(edge(contractId, "reaffirms", capabilityContractId(target)));

  const sourceNodeByKey = new Map<string, string>();
  for (const source of document.block.sources) {
    const id = sourceId(canonicalSourceCoordinate(source));
    sourceNodeByKey.set(source.key, id);
    nodes.push(node("source", id, `${source.type} ${source.ref}`, { status: "active" }, {
      type: source.type,
      ref: source.ref,
      message_id: source.message_id ?? null,
      anchor: source.anchor ?? null,
      revision: source.revision ?? null,
      quote: source.quote ?? null,
    }));
  }

  for (const principle of document.block.principles) {
    const id = contractEntityId("principle", document.id, principle.key);
    nodes.push(node("principle", id, principle.statement, principle, { contract: contractId, local_key: principle.key }));
    edges.push(edge(contractId, "defines", id));
    linkSources(edges, edge, id, principle.source_keys, sourceNodeByKey);
    linkLineage(edges, edge, id, "principle", document.id, principle);
  }
  for (const obligation of document.block.obligations) {
    const id = contractEntityId("obligation", document.id, obligation.key);
    nodes.push(node("obligation", id, obligation.statement, obligation, { contract: contractId, local_key: obligation.key, strength: obligation.strength }));
    edges.push(edge(contractId, "defines", id));
    for (const principle of obligation.principle_refs) edges.push(edge(id, "derives_from", contractEntityId("principle", document.id, principle)));
    linkSourcesAndAssertions(edges, edge, id, obligation.source_refs, sourceNodeByKey);
    linkLineage(edges, edge, id, "obligation", document.id, obligation);
  }
  for (const scenario of document.block.scenarios) {
    const id = contractEntityId("scenario", document.id, scenario.key);
    nodes.push(node("scenario", id, scenario.expected_outcome, scenario, {
      contract: contractId,
      local_key: scenario.key,
      preconditions: [...scenario.preconditions].sort(),
      trigger: scenario.trigger,
      action: scenario.action,
      failure_semantics: scenario.failure_semantics,
    }));
    edges.push(edge(contractId, "defines", id));
    linkSourcesAndAssertions(edges, edge, id, scenario.source_refs, sourceNodeByKey);
    linkLineage(edges, edge, id, "scenario", document.id, scenario);
  }
  for (const exception of document.block.exceptions) {
    const scopedCells = resolvedExceptionCells(exception, expandedDesired);
    const id = contractEntityId("exception", document.id, exception.key);
    nodes.push(node("exception", id, exception.reason, exception, {
      contract: contractId,
      local_key: exception.key,
      kind: exception.kind,
      owner: exception.owner,
      created_at: exception.created_at,
      expires_at: exception.expires_at ?? null,
      review_after: exception.review_after ?? null,
      targets: [...exception.targets].sort(),
      scoped_cell_ids: scopedCells.map((cell) => contractEntityId("desired_conformance", document.id, cell.key)),
      providers: [...new Set(scopedCells.map((cell) => cell.provider))].sort(),
      launch_modes: [...new Set(scopedCells.map((cell) => cell.launch_mode))].sort(),
      states: [...new Set(scopedCells.map((cell) => cell.state))].sort(),
      actions: [...new Set(scopedCells.map((cell) => cell.action))].sort(),
    }));
    linkSourcesAndAssertions(edges, edge, id, exception.source_refs, sourceNodeByKey);
    for (const target of exception.targets) {
      for (const targetId of projectionTargetIds(document.id, target, expandedDesired)) edges.push(edge(id, "waives", targetId));
    }
    linkLineage(edges, edge, id, "exception", document.id, exception);
  }

  const artifactByKey = new Map<string, { selector: ContractArtifactSelector; id: string; resolved: boolean }>();
  const freshIndex = codeIndex?.gitSha === ctx.sha;
  for (const selector of document.block.artifacts) {
    const id = artifactId(selector.repo, selector.kind, selector.key);
    const resolved = freshIndex
      ? codeIndex?.resolveArtifact({
          kind: selector.kind,
          path: selector.path,
          qualifiedName: selector.symbol,
          testName: selector.test_name,
          lastVerifiedSha: ctx.sha,
        }) != null
      : false;
    artifactByKey.set(selector.key, { selector, id, resolved });
    nodes.push(node("artifact", id, artifactStatement(selector), { status: "active" }, {
      ...selector,
      artifact_role: selector.kind === "test" ? "test" : selector.kind,
      qualified_name: selector.symbol ?? null,
      test_name: selector.test_name ?? null,
      baseline_sha: ctx.sha,
      code_index_sha: codeIndex?.gitSha ?? null,
      code_index_manifest: codeIndex?.manifestDigest ?? null,
      resolved,
    }));
  }

  const realizationByTarget = new Map<string, ContractRealizationDef[]>();
  for (const realization of document.block.realizations) {
    const list = realizationByTarget.get(realization.target) ?? [];
    list.push(realization);
    realizationByTarget.set(realization.target, list);
    const artifact = artifactByKey.get(realization.artifact);
    if (freshIndex && artifact?.resolved) {
      for (const targetId of projectionTargetIds(document.id, realization.target, expandedDesired)) {
        edges.push(edge(targetId, realization.role === "test" ? "verified_by" : "realized_by", artifact.id));
      }
    }
  }

  for (const expanded of expandedDesired) {
    const definition = expanded.definition;
    const desiredId = contractEntityId("desired_conformance", document.id, expanded.key);
    const scenarioId = contractEntityId("scenario", document.id, definition.scenario);
    const exceptionId = definition.exception_ref ? contractEntityId("exception", document.id, definition.exception_ref) : undefined;
    nodes.push(node("desired_conformance", desiredId, `${expanded.provider} ${expanded.launch_mode} ${expanded.state} ${expanded.action}: ${definition.desired}`, { status: "active" }, {
      contract: contractId,
      local_key: expanded.key,
      provider: expanded.provider,
      launch_mode: expanded.launch_mode,
      state: expanded.state,
      action: expanded.action,
      desired: definition.desired,
      definition_key: definition.key,
      expected_ux: definition.expected_ux,
      trust_semantics: definition.trust_semantics,
      failure_semantics: definition.failure_semantics,
    }));
    edges.push(edge(contractId, "defines", desiredId), edge(desiredId, "applies_to", scenarioId));
    for (const obligation of definition.obligation_refs) edges.push(edge(desiredId, "requires", contractEntityId("obligation", document.id, obligation)));
    linkSourcesAndAssertions(edges, edge, desiredId, definition.source_refs, sourceNodeByKey);
    const cell: ContractCell = {
      id: desiredId,
      contract_id: contractId,
      scenario_id: scenarioId,
      provider: expanded.provider,
      launch_mode: expanded.launch_mode,
      state: expanded.state,
      action: expanded.action,
      desired: definition.desired,
      expected_ux: definition.expected_ux,
      trust_semantics: definition.trust_semantics,
      failure_semantics: definition.failure_semantics,
      exception_id: exceptionId,
    };
    cells.push(cell);

    const observationId = contractEntityId("observed_conformance", document.id, expanded.key);
    const relevant = collectRealizations(realizationByTarget, definition, expanded.key);
    const resolved = relevant.filter((realization) => artifactByKey.get(realization.artifact)?.resolved);
    const observed = observationFor(cell, observationId, ctx.sha, codeIndex, relevant, resolved);
    observations.push(observed);
    nodes.push(node("observed_conformance", observationId, observed.reason, { status: "active" }, {
      contract: contractId,
      cell_id: desiredId,
      observed_status: observed.status,
      baseline_sha: observed.baseline_sha,
      code_index_sha: observed.code_index_sha ?? null,
      verified_sha: observed.verified_sha ?? null,
    }));
    edges.push(edge(observationId, "observes", desiredId));
    if (observed.status === "conformant") {
      for (const realization of resolved) {
        const artifact = artifactByKey.get(realization.artifact)!;
        observationArtifacts.push({ observation_id: observationId, artifact_id: artifact.id, role: realization.role });
        edges.push(edge(observationId, realization.role === "test" ? "verified_by" : "realized_by", artifact.id));
      }
    }
  }
  return {
    nodes: uniqueById(nodes),
    edges: uniqueEdges(edges),
    cells: cells.sort((a, b) => a.id.localeCompare(b.id)),
    observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
    observationArtifacts: uniqueObservationArtifacts(observationArtifacts),
  };
}

function observationFor(
  cell: ContractCell,
  id: string,
  baselineSha: string,
  codeIndex: ContractCodeIndexResolver | undefined,
  declared: readonly ContractRealizationDef[],
  resolved: readonly ContractRealizationDef[],
): ConformanceObservation {
  if (cell.desired !== "required") {
    return { id, cell_id: cell.id, baseline_sha: baselineSha, code_index_sha: codeIndex?.gitSha, status: "waived", reason: `Current scoped exception records ${cell.desired}.` };
  }
  if (!codeIndex) return { id, cell_id: cell.id, baseline_sha: baselineSha, status: "unverified", reason: "No matching code index was available; exact implementation and test evidence was withheld." };
  if (codeIndex.gitSha !== baselineSha) return { id, cell_id: cell.id, baseline_sha: baselineSha, code_index_sha: codeIndex.gitSha, status: "stale", reason: "Code-index SHA differs from the graph baseline; exact implementation and test evidence was withheld." };
  const actionEvidence = resolved.some((item) => item.role === "handler" || item.role === "adapter");
  const testEvidence = resolved.some((item) => item.role === "test");
  if (!declared.length) return { id, cell_id: cell.id, baseline_sha: baselineSha, code_index_sha: codeIndex.gitSha, status: "unverified", reason: "The required cell has no authored implementation or test realization." };
  if (!actionEvidence || !testEvidence || resolved.length !== declared.length) {
    return { id, cell_id: cell.id, baseline_sha: baselineSha, code_index_sha: codeIndex.gitSha, status: "nonconformant", reason: "The matching code index could not resolve every authored handler/adapter/test selector." };
  }
  return { id, cell_id: cell.id, baseline_sha: baselineSha, code_index_sha: codeIndex.gitSha, verified_sha: codeIndex.gitSha, status: "conformant", reason: "All authored action and test selectors resolved at the matching baseline SHA." };
}

function collectRealizations(
  byTarget: ReadonlyMap<string, ContractRealizationDef[]>,
  definition: ContractDesiredDef,
  expandedKey: string,
): ContractRealizationDef[] {
  const out = [
    ...(byTarget.get(`desired:${definition.key}`) ?? []),
    ...(byTarget.get(`desired:${expandedKey}`) ?? []),
    ...(byTarget.get(`scenario:${definition.scenario}`) ?? []),
  ];
  for (const obligation of definition.obligation_refs) out.push(...(byTarget.get(`obligation:${obligation}`) ?? []));
  const seen = new Set<string>();
  return out.filter((item) => {
    const key = `${item.artifact}\0${item.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function expandDesired(definitions: readonly ContractDesiredDef[]): ExpandedDesired[] {
  const out: ExpandedDesired[] = [];
  for (const definition of definitions) {
    const providers = asArray(definition.provider);
    const modes = asArray(definition.launch_mode);
    const states = asArray(definition.state);
    const actions = asArray(definition.action);
    const count = providers.length * modes.length * states.length * actions.length;
    for (const provider of providers) for (const launch_mode of modes) for (const state of states) for (const action of actions) {
      const key = count === 1 ? definition.key : `${definition.key}/${provider}/${launch_mode}/${state}/${action}`;
      out.push({ definition, key, provider, launch_mode, state, action });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function resolvedExceptionCells(exception: ContractExceptionDef, desired: readonly ExpandedDesired[]): ExpandedDesired[] {
  return desired.filter((cell) =>
    cell.definition.exception_ref === exception.key
    && exception.targets.includes(`desired:${cell.definition.key}`));
}

function canonicalSourceCoordinate(source: ContractSourceDef): string {
  const message = source.message_id === undefined ? "" : `/message:${source.message_id}`;
  const anchor = source.anchor ? `#${source.anchor}` : "";
  return `${source.ref}${message}${anchor}`;
}

function artifactStatement(selector: ContractArtifactSelector): string {
  if (selector.symbol) return `${selector.path}#${selector.symbol}`;
  if (selector.test_name) return `${selector.path}#${selector.test_name}`;
  return selector.path;
}

function projectionTargetIds(contract: string, target: string, desired: readonly ExpandedDesired[]): string[] {
  const [kind, key] = splitTarget(target);
  if (kind === "desired") {
    return desired
      .filter((item) => item.definition.key === key)
      .map((item) => contractEntityId("desired_conformance", contract, item.key));
  }
  return [projectionTargetId(contract, target)];
}

function projectionTargetId(contract: string, target: string): string {
  const [kind, key] = splitTarget(target);
  if (kind === "desired") return contractEntityId("desired_conformance", contract, key);
  if (kind === "constraint") return `constraint:${key}`;
  if (kind === "obligation" || kind === "scenario") return contractEntityId(kind, contract, key);
  throw new Error(`invalid contract projection target ${target}`);
}

function splitTarget(target: string): [string, string] {
  const separator = target.indexOf(":");
  return separator > 0 ? [target.slice(0, separator), target.slice(separator + 1)] : ["", target];
}

function linkSources(
  edges: KnowledgeEdge[],
  edge: (from: string, relation: Relation, to: string) => KnowledgeEdge,
  id: string,
  refs: readonly string[],
  sourceNodeByKey: ReadonlyMap<string, string>,
): void {
  for (const ref of refs) edges.push(edge(id, "supported_by", sourceNodeByKey.get(ref)!));
}

function linkSourcesAndAssertions(
  edges: KnowledgeEdge[],
  edge: (from: string, relation: Relation, to: string) => KnowledgeEdge,
  id: string,
  refs: readonly string[],
  sourceNodeByKey: ReadonlyMap<string, string>,
): void {
  for (const ref of refs) {
    const source = sourceNodeByKey.get(ref);
    if (source) edges.push(edge(id, "supported_by", source));
    else if (id.startsWith("obligation:")) edges.push(edge(id, "derives_from", ref));
  }
}

function linkLineage(
  edges: KnowledgeEdge[],
  edge: (from: string, relation: Relation, to: string) => KnowledgeEdge,
  id: string,
  kind: "principle" | "obligation" | "scenario" | "exception",
  contract: string,
  lifecycle: LifecycleDef,
): void {
  for (const target of lifecycle.supersedes ?? []) edges.push(edge(id, "supersedes", target.includes(":") ? target : contractEntityId(kind, contract, target)));
  for (const target of lifecycle.reaffirms ?? []) edges.push(edge(id, "reaffirms", target.includes(":") ? target : contractEntityId(kind, contract, target)));
}

function uniqueById(nodes: readonly KnowledgeNode[]): KnowledgeNode[] {
  const byId = new Map<string, KnowledgeNode>();
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function uniqueEdges(edges: readonly KnowledgeEdge[]): KnowledgeEdge[] {
  const byKey = new Map<string, KnowledgeEdge>();
  for (const edge of edges) {
    const key = `${edge.from_id}\0${edge.relation}\0${edge.to_id}`;
    if (!byKey.has(key)) byKey.set(key, edge);
  }
  return [...byKey.values()].sort((a, b) => `${a.from_id}\0${a.relation}\0${a.to_id}`.localeCompare(`${b.from_id}\0${b.relation}\0${b.to_id}`));
}

function uniqueObservationArtifacts(items: readonly ConformanceArtifact[]): ConformanceArtifact[] {
  const byKey = new Map<string, ConformanceArtifact>();
  for (const item of items) byKey.set(`${item.observation_id}\0${item.artifact_id}\0${item.role}`, item);
  return [...byKey.values()].sort((a, b) => `${a.observation_id}\0${a.artifact_id}\0${a.role}`.localeCompare(`${b.observation_id}\0${b.artifact_id}\0${b.role}`));
}

const lifecycleFields = ["status", "effective_from", "valid_to", "supersedes", "reaffirms"] as const;

function readLifecycle(object: Record<string, unknown>, label: string, evaluationAsOf: string, errors: string[]): LifecycleDef {
  const lifecycle = {
    status: readEnum(object.status, NODE_STATUSES, `${label}.status`, errors),
    effective_from: readOptionalDate(object.effective_from, `${label}.effective_from`, errors),
    valid_to: readOptionalDate(object.valid_to, `${label}.valid_to`, errors),
    supersedes: readStringArray(object.supersedes ?? [], `${label}.supersedes`, errors, { nonEmpty: false, tokens: false }),
    reaffirms: readStringArray(object.reaffirms ?? [], `${label}.reaffirms`, errors, { nonEmpty: false, tokens: false }),
  };
  validateLifecycle(lifecycle, label, evaluationAsOf, errors);
  return lifecycle;
}

function validateLifecycle(lifecycle: LifecycleDef, label: string, evaluationAsOf: string, errors: string[]): void {
  if (lifecycle.effective_from && lifecycle.valid_to && lifecycle.valid_to < lifecycle.effective_from) errors.push(`${label}.valid_to precedes effective_from`);
  if (lifecycle.status === "active" && lifecycle.effective_from && lifecycle.effective_from > evaluationAsOf) {
    errors.push(`${label} is active before effective_from ${lifecycle.effective_from}`);
  }
  if (lifecycle.status === "active" && lifecycle.valid_to && lifecycle.valid_to < evaluationAsOf) errors.push(`${label} is active after valid_to`);
  if (lifecycle.status === "superseded" && !(lifecycle.valid_to || lifecycle.supersedes?.length)) errors.push(`${label}: superseded lifecycle requires valid_to or supersedes lineage`);
  const overlap = new Set(lifecycle.supersedes ?? []);
  for (const ref of lifecycle.reaffirms ?? []) if (overlap.has(ref)) errors.push(`${label}: cannot both supersede and reaffirm ${ref}`);
}

function validateLineage(
  lifecycle: LifecycleDef,
  kind: string,
  localKeys: ReadonlySet<string>,
  label: string,
  errors: string[],
): void {
  for (const ref of [...(lifecycle.supersedes ?? []), ...(lifecycle.reaffirms ?? [])]) {
    if (!ref.includes(":")) {
      if (!localKeys.has(ref)) errors.push(`${label}: unknown lineage ref ${ref}`);
      continue;
    }
    if (!ref.startsWith(`${kind}:`)) errors.push(`${label}: cross-kind lineage ref ${ref}`);
  }
}

function validateLineageCycles(items: readonly (LifecycleDef & { key: string })[], label: string, errors: string[]): void {
  const supersedes = new Map(items.map((item) => [item.key, (item.supersedes ?? []).filter((ref) => !ref.includes(":"))]));
  const visit = (key: string, stack: Set<string>, done: Set<string>): void => {
    if (stack.has(key)) {
      errors.push(`${label} supersession cycle includes ${key}`);
      return;
    }
    if (done.has(key)) return;
    stack.add(key);
    for (const target of supersedes.get(key) ?? []) visit(target, stack, done);
    stack.delete(key);
    done.add(key);
  };
  const done = new Set<string>();
  for (const key of supersedes.keys()) visit(key, new Set(), done);
}

function validateSourceRefs(refs: readonly string[], sources: ReadonlySet<string>, label: string, errors: string[], allowAssertions: boolean): void {
  for (const ref of refs) {
    if (sources.has(ref)) continue;
    if (allowAssertions && EXISTING_ASSERTION_REF.test(ref)) continue;
    errors.push(`${label}: unknown source/assertion ref ${ref}`);
  }
}

function checkDimension(value: string, allowed: readonly string[], label: string, errors: string[]): void {
  if (!allowed.includes(value)) errors.push(`${label}: ${value} is outside the closed dimension`);
}

function checkUniqueKeys(items: readonly { key: string }[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) errors.push(`${label}: duplicate key ${item.key}`);
    seen.add(item.key);
  }
}

function checkUniqueSourceCoordinates(sources: readonly ContractSourceDef[], errors: string[]): void {
  const seen = new Map<string, string>();
  for (const source of sources) {
    const coordinate = canonicalSourceCoordinate(source);
    const previous = seen.get(coordinate);
    if (previous) errors.push(`sources: ${source.key} and ${previous} use the same canonical coordinate ${coordinate}`);
    else seen.set(coordinate, source.key);
  }
}

function readObject(value: unknown, label: string, errors: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return {};
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, label: string, errors: string[]): unknown[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  return value;
}

function expectClosed(object: Record<string, unknown>, allowed: readonly string[], label: string, errors: string[]): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(object)) if (!fields.has(key)) errors.push(`${label}: unknown field ${key}`);
  for (const key of allowed) if (!(key in object) && !optionalField(key)) errors.push(`${label}: missing field ${key}`);
}

function optionalField(key: string): boolean {
  return ["effective_from", "valid_to", "supersedes", "reaffirms", "message_id", "anchor", "revision", "quote", "expires_at", "review_after", "exception_ref", "symbol", "test_name"].includes(key);
}

function readString(value: unknown, label: string, errors: string[]): string {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} must be a non-empty string`);
    return "invalid";
  }
  if (CREDENTIAL.test(value)) errors.push(`${label} looks like a credential`);
  return value.trim();
}

function readOptionalString(value: unknown, label: string, errors: string[], maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return readBoundedText(value, label, errors, maximum);
}

function readBoundedText(value: unknown, label: string, errors: string[], maximum: number): string {
  const text = readString(value, label, errors);
  if (text.length > maximum) errors.push(`${label} exceeds ${maximum} characters`);
  if (/\r|\n/.test(text)) errors.push(`${label} must be a single line`);
  return text;
}

function readAtomicText(value: unknown, label: string, errors: string[]): string {
  return readBoundedText(value, label, errors, MAX_STATEMENT_CHARS);
}

function validateTextValue(value: string, label: string, errors: string[]): string {
  if (value.length > MAX_STATEMENT_CHARS) errors.push(`${label} exceeds ${MAX_STATEMENT_CHARS} characters`);
  if (CREDENTIAL.test(value)) errors.push(`${label} looks like a credential`);
  return value;
}

function readKey(value: unknown, label: string, errors: string[]): string {
  const key = readString(value, label, errors);
  if (!LOCAL_KEY.test(key)) errors.push(`${label} must be a kebab-case local key`);
  return key;
}

function readEnum<const T extends readonly string[]>(value: unknown, allowed: T, label: string, errors: string[]): T[number] {
  const item = readString(value, label, errors);
  if (!(allowed as readonly string[]).includes(item)) {
    errors.push(`${label} must be one of ${allowed.join("|")}`);
    return allowed[0];
  }
  return item as T[number];
}

function readDate(value: unknown, label: string, errors: string[]): string {
  const date = readString(value, label, errors);
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) errors.push(`${label} must be an ISO date`);
  return date;
}

function readOptionalDate(value: unknown, label: string, errors: string[]): string | undefined {
  return value === undefined ? undefined : readDate(value, label, errors);
}

function readPositiveInteger(value: unknown, label: string, errors: string[]): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    errors.push(`${label} must be a positive integer`);
    return 1;
  }
  return value as number;
}

function readStringArray(
  value: unknown,
  label: string,
  errors: string[],
  options: { nonEmpty: boolean; tokens: boolean },
): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  if (options.nonEmpty && !value.length) errors.push(`${label} must not be empty`);
  const out: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const text = readString(item, `${label}[${index}]`, errors);
    if (options.tokens && !DIMENSION_VALUE.test(text)) errors.push(`${label}[${index}] must be kebab-case`);
    if (seen.has(text)) errors.push(`${label}: duplicate value ${text}`);
    seen.add(text);
    out.push(text);
  });
  return out;
}

function readDimensionSelector(value: unknown, label: string, errors: string[]): string | string[] {
  if (Array.isArray(value)) return readStringArray(value, label, errors, { nonEmpty: true, tokens: true });
  const item = readString(value, label, errors);
  if (!DIMENSION_VALUE.test(item)) errors.push(`${label} must be kebab-case`);
  return item;
}

function asArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}
