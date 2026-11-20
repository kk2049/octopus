import {
  AUTHORIZATION_SUBJECT_TYPES,
  DOMAIN_AUTHORITY_KINDS,
  DOMAIN_KINDS,
  POLICY_EFFECTS,
  type AccessRequest,
  type AuthorizationDomain,
  type AuthorizationResource,
  type AuthorizationSubjectType,
  type DomainKind,
  type PolicyCondition,
  type PolicyFactValue,
  type PolicyHierarchies,
  type PolicyRule,
  type PolicyScalar,
  type PolicyValueRef,
} from "./types.js";

export interface PolicyEvaluationContext {
  request: AccessRequest;
  resource: AuthorizationResource;
  domain: AuthorizationDomain;
}

export interface EvaluatedRule {
  rule: PolicyRule;
  matched: boolean;
  reason: "selector_mismatch" | "condition_false" | "condition_unknown" | "matched";
}

export type PolicyConditionResult = true | false | "unknown";

function scalar(ref: PolicyValueRef, facts: Readonly<Record<string, PolicyFactValue>>): PolicyScalar | undefined {
  if ("value" in ref) return ref.value;
  const value = facts[ref.fact];
  return Array.isArray(value) ? undefined : value as PolicyScalar | undefined;
}

function reaches(
  hierarchies: PolicyHierarchies,
  hierarchy: string,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  const edges = hierarchies[hierarchy] ?? [];
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    const list = children.get(edge.ancestor) ?? [];
    list.push(edge.descendant);
    children.set(edge.ancestor, list);
  }
  const seen = new Set([ancestor]);
  const pending = [...(children.get(ancestor) ?? [])];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current === descendant) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(children.get(current) ?? []));
  }
  return false;
}

export function evaluateConditionResult(
  condition: PolicyCondition,
  facts: Readonly<Record<string, PolicyFactValue>> = {},
  hierarchies: PolicyHierarchies = {},
): PolicyConditionResult {
  switch (condition.op) {
    case "all": {
      const children = condition.conditions.map((child) => evaluateConditionResult(child, facts, hierarchies));
      return children.includes(false) ? false : children.includes("unknown") ? "unknown" : true;
    }
    case "any": {
      const children = condition.conditions.map((child) => evaluateConditionResult(child, facts, hierarchies));
      return children.includes(true) ? true : children.includes("unknown") ? "unknown" : false;
    }
    case "not": {
      const child = evaluateConditionResult(condition.condition, facts, hierarchies);
      return child === "unknown" ? "unknown" : !child;
    }
    case "eq": {
      const left = scalar(condition.left, facts);
      const right = scalar(condition.right, facts);
      return left === undefined || right === undefined ? "unknown" : left === right;
    }
    case "in": {
      const value = scalar(condition.value, facts);
      return value === undefined ? "unknown" : condition.set.includes(value);
    }
    case "gte": {
      const left = scalar(condition.left, facts);
      const right = scalar(condition.right, facts);
      return typeof left !== "number" || typeof right !== "number" ? "unknown" : left >= right;
    }
    case "ancestor": {
      const ancestor = scalar(condition.ancestor, facts);
      const descendant = scalar(condition.descendant, facts);
      if (typeof ancestor !== "string" || typeof descendant !== "string") return "unknown";
      if (ancestor === descendant) return true;
      if (!Object.prototype.hasOwnProperty.call(hierarchies, condition.hierarchy)) return "unknown";
      return reaches(hierarchies, condition.hierarchy, ancestor, descendant);
    }
  }
}

/** Compatibility boolean API; callers needing fail-closed diagnostics use the tri-state result. */
export function evaluateCondition(
  condition: PolicyCondition,
  facts: Readonly<Record<string, PolicyFactValue>> = {},
  hierarchies: PolicyHierarchies = {},
): boolean {
  return evaluateConditionResult(condition, facts, hierarchies) === true;
}

/** Structural proof used before a rule may silently authorize cross-domain flow. */
export function conditionReferencesFact(condition: PolicyCondition, fact: string): boolean {
  const refMatches = (ref: PolicyValueRef): boolean => "fact" in ref && ref.fact === fact;
  switch (condition.op) {
    case "all":
    case "any":
      return condition.conditions.some((child) => conditionReferencesFact(child, fact));
    case "not":
      return conditionReferencesFact(condition.condition, fact);
    case "eq":
    case "gte":
      return refMatches(condition.left) || refMatches(condition.right);
    case "in":
      return refMatches(condition.value);
    case "ancestor":
      return refMatches(condition.ancestor) || refMatches(condition.descendant);
  }
}

function includes<T>(candidates: readonly T[] | undefined, value: T): boolean {
  return candidates === undefined || candidates.includes(value);
}

export function evaluateRule(rule: PolicyRule, context: PolicyEvaluationContext): EvaluatedRule {
  const { request, resource, domain } = context;
  const selectorMatched = includes(rule.match.subjectTypes, request.subject.type)
    && includes(rule.match.subjectIds, request.subject.id)
    && includes(rule.match.resourceIds, resource.id)
    && includes(rule.match.resourceKinds, resource.kind)
    && includes(rule.match.domainIds, domain.id)
    && includes(rule.match.domainKinds, domain.kind)
    && includes(rule.match.operations, request.operation);
  if (!selectorMatched) return { rule, matched: false, reason: "selector_mismatch" };
  if (rule.when) {
    const condition = evaluateConditionResult(rule.when, request.facts, request.hierarchies);
    if (condition === "unknown") return { rule, matched: false, reason: "condition_unknown" };
    if (!condition) return { rule, matched: false, reason: "condition_false" };
  }
  return { rule, matched: true, reason: "matched" };
}

const POLICY_LIMITS = Object.freeze({ rules: 256, selectorValues: 256, conditionNodes: 256, conditionDepth: 12 });

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a trimmed non-empty string`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} has an unsupported value`);
  }
  return value as T;
}

function scalarValue(value: unknown, label: string): void {
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  throw new Error(`${label} must be a finite scalar`);
}

function validateValueRef(value: unknown, label: string): void {
  record(value, label);
  const keys = Object.keys(value);
  if (keys.length !== 1 || (keys[0] !== "fact" && keys[0] !== "value")) {
    throw new Error(`${label} must contain exactly one fact or value`);
  }
  if (keys[0] === "fact") textValue(value.fact, `${label}.fact`);
  else scalarValue(value.value, `${label}.value`);
}

function validateCondition(
  value: unknown,
  label: string,
  depth: number,
  state: { nodes: number },
): void {
  if (depth > POLICY_LIMITS.conditionDepth) throw new Error(`${label} nesting exceeds 12`);
  state.nodes += 1;
  if (state.nodes > POLICY_LIMITS.conditionNodes) throw new Error(`${label} exceeds 256 nodes`);
  record(value, label);
  const op = enumValue(value.op, ["all", "any", "not", "eq", "in", "gte", "ancestor"] as const, `${label}.op`);
  switch (op) {
    case "all":
    case "any": {
      if (!Array.isArray(value.conditions) || value.conditions.length === 0) {
        throw new Error(`${label}.${op} conditions must not be empty`);
      }
      if (value.conditions.length > POLICY_LIMITS.conditionNodes) {
        throw new Error(`${label}.${op} has too many conditions`);
      }
      value.conditions.forEach((child, index) => validateCondition(child, `${label}.${op}[${index}]`, depth + 1, state));
      return;
    }
    case "not":
      validateCondition(value.condition, `${label}.not`, depth + 1, state);
      return;
    case "eq":
    case "gte":
      validateValueRef(value.left, `${label}.${op}.left`);
      validateValueRef(value.right, `${label}.${op}.right`);
      return;
    case "in":
      validateValueRef(value.value, `${label}.in.value`);
      if (!Array.isArray(value.set) || value.set.length === 0) {
        throw new Error(`${label}.in set must not be empty`);
      }
      if (value.set.length > POLICY_LIMITS.selectorValues) throw new Error(`${label}.in set is too large`);
      value.set.forEach((item, index) => scalarValue(item, `${label}.in.set[${index}]`));
      return;
    case "ancestor":
      textValue(value.hierarchy, `${label}.ancestor.hierarchy`);
      validateValueRef(value.ancestor, `${label}.ancestor.ancestor`);
      validateValueRef(value.descendant, `${label}.ancestor.descendant`);
  }
}

function validateSelector<T extends string>(
  match: Record<string, unknown>,
  key: string,
  allowed?: readonly T[],
): void {
  const value = match[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`policy match.${key} must not be empty`);
  if (value.length > POLICY_LIMITS.selectorValues) throw new Error(`policy match.${key} is too large`);
  for (const [index, item] of value.entries()) {
    if (allowed) enumValue(item, allowed, `policy match.${key}[${index}]`);
    else textValue(item, `policy match.${key}[${index}]`);
  }
}

export function validatePolicyProgram(rules: readonly PolicyRule[]): void {
  if (!Array.isArray(rules)) throw new Error("policy program must be an array");
  if (rules.length > POLICY_LIMITS.rules) throw new Error("policy program exceeds 256 rules");
  const ids = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    record(rule, `policy rule[${index}]`);
    const id = textValue(rule.id, `policy rule[${index}].id`);
    textValue(rule.title, `policy rule ${id}.title`);
    textValue(rule.explanation, `policy rule ${id}.explanation`);
    if (ids.has(id)) throw new Error(`duplicate policy rule id: ${id}`);
    ids.add(id);
    record(rule.authority, `policy rule ${id}.authority`);
    enumValue(rule.authority.kind, DOMAIN_AUTHORITY_KINDS, `policy rule ${id}.authority.kind`);
    textValue(rule.authority.id, `policy rule ${id}.authority.id`);
    enumValue(rule.effect, POLICY_EFFECTS, `policy rule ${id}.effect`);
    if (rule.mandatory !== undefined && typeof rule.mandatory !== "boolean") {
      throw new Error(`policy rule ${id}.mandatory must be boolean`);
    }
    record(rule.match, `policy rule ${id}.match`);
    const selectorKeys = new Set([
      "subjectTypes", "subjectIds", "resourceIds", "resourceKinds", "domainIds", "domainKinds", "operations",
    ]);
    const unknownSelector = Object.keys(rule.match).find((key) => !selectorKeys.has(key));
    if (unknownSelector) throw new Error(`policy rule ${id}.match has unknown selector ${unknownSelector}`);
    validateSelector<AuthorizationSubjectType>(rule.match, "subjectTypes", AUTHORIZATION_SUBJECT_TYPES);
    validateSelector(rule.match, "subjectIds");
    validateSelector(rule.match, "resourceIds");
    validateSelector(rule.match, "resourceKinds");
    validateSelector(rule.match, "domainIds");
    validateSelector<DomainKind>(rule.match, "domainKinds", DOMAIN_KINDS);
    validateSelector(rule.match, "operations");
    if (rule.mandatory && rule.authority.kind !== "organization") {
      throw new Error(`policy rule ${id}: only organization rules may be mandatory`);
    }
    if (rule.mandatory && rule.effect !== "deny" && rule.effect !== "block") {
      throw new Error(`policy rule ${id}: mandatory rules must deny or block`);
    }
    if (rule.effect === "deny" && (!rule.mandatory || rule.authority.kind !== "organization")) {
      throw new Error(`policy rule ${id}: deny is reserved for mandatory organization rules`);
    }
    if (rule.effect === "block" && (!rule.mandatory || rule.authority.kind !== "organization")) {
      throw new Error(`policy rule ${id}: block is reserved for mandatory organization rules`);
    }
    if (rule.when !== undefined) validateCondition(rule.when, `policy rule ${id}.when`, 1, { nodes: 0 });
  }
}
