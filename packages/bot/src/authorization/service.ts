import { randomUUID } from "node:crypto";
import {
  isResourceUriPrefix,
  parseResourceUri,
  resourceUri,
  rewriteResourceUri,
} from "./namespace.js";
import { conditionReferencesFact, evaluateRule, validatePolicyProgram, type EvaluatedRule } from "./program.js";
import type { AuthorizationRepository, PermitQuery } from "./repository.js";
import {
  AUTHORIZATION_SUBJECT_TYPES,
  DOMAIN_AUTHORITY_KINDS,
  DOMAIN_KINDS,
  HISTORY_POLICIES,
  PERMIT_MODES,
  PERMIT_SOURCES,
  RESOURCE_SENSITIVITIES,
  TRANSFER_KINDS,
  type AccessDecision,
  type AccessRequest,
  type AppInstallDefaultProfile,
  type AuthorityRef,
  type AuthorizationChange,
  type AuthorizationDomain,
  type AuthorizationResource,
  type AuthorizationResourceAlias,
  type AuthorizationSubject,
  type DecisionStep,
  type ExactPermit,
  type FlowRequest,
  type PermitMode,
  type PolicyEffect,
  type PolicyRule,
  type StoredAppInstallDefaults,
} from "./types.js";

const DEFAULT_APP_INSTALL_PROFILE: AppInstallDefaultProfile = Object.freeze({
  version: 1,
  readMode: "allow",
  observeMode: "allow",
  writeMode: "ask",
  executeMode: "ask",
});

export interface AuthorizationServiceOptions {
  repository: AuthorizationRepository;
  /** Immutable rules composed by trusted platform code, never browser input. */
  rules?: readonly PolicyRule[];
  now?: () => number;
  newId?: () => string;
}

export interface UpsertDomainInput {
  id: string;
  kind: AuthorizationDomain["kind"];
  title: string;
  authority: AuthorityRef;
  historyPolicy: AuthorizationDomain["historyPolicy"];
}

export interface UpsertResourceInput {
  id: string;
  uri: string;
  owner: string;
  domainId: string;
  kind: string;
  title: string;
  sensitivity: AuthorizationResource["sensitivity"];
  externalRef: AuthorizationResource["externalRef"];
}
export interface PutResourceAliasInput {
  owner: string;
  uri: string;
  targetUri: string;
  createdBy: string;
}

export interface RevokeResourceAliasInput {
  owner: string;
  uri: string;
  revokedBy: string;
}


export interface PutPermitInput {
  subject: AuthorizationSubject;
  resourceId: string;
  operation: string;
  mode: PermitMode;
  authority: AuthorityRef;
  source: ExactPermit["source"];
  createdBy: string;
}

export interface RevokePermitInput {
  subject: AuthorizationSubject;
  resourceId: string;
  operation: string;
  authority: AuthorityRef;
  revokedBy: string;
}

interface EvaluatedIntent {
  result: AccessDecision["result"];
  code: string;
  steps: DecisionStep[];
  explicit: boolean;
}

function iso(now: () => number): string {
  return new Date(now()).toISOString();
}

function required(value: string, label: string, max = 512): string {
  if (value !== value.trim() || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a trimmed non-empty string up to ${max} characters`);
  }
  return value;
}

function identifier(value: string, label: string): string {
  required(value, label, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)) {
    throw new Error(`${label} must be an opaque identifier, not a path or URL`);
  }
  return value;
}

function externalId(value: string): string {
  required(value, "externalRef.id", 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._~:@-]*$/.test(value) || /^(?:sk-|rt_|mcp_|bearer)/i.test(value)) {
    throw new Error("externalRef.id must be an opaque identifier, never a secret, path, or URL");
  }
  return value;
}

function migratedLegacyResourceUri(system: string, id: string): string {
  const chunks = (value: string) =>
    Buffer.from(value, "utf8").toString("hex").match(/.{1,256}/g)!;
  return resourceUri("object", "legacy", "s", ...chunks(system), "i", ...chunks(id));
}

function sameAuthority(left: AuthorityRef, right: AuthorityRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function strongest(effects: readonly ("ask" | "allow")[]): "ask" | "allow" | undefined {
  if (effects.includes("allow")) return "allow";
  if (effects.includes("ask")) return "ask";
  return undefined;
}

function authorityApplies(
  authority: AuthorityRef,
  resource: AuthorizationResource,
  domain: AuthorizationDomain,
): boolean {
  if (authority.kind === "owner") return authority.id === resource.owner;
  return domain.authority.kind === "organization" && sameAuthority(authority, domain.authority);
}

/**
 * Durable authorization intent plus a small trusted policy program.
 *
 * `decide*` intentionally returns `enforcement: "intent-only"`: consumers
 * still have to derive a capability no broader than this result and dispatch
 * through the capability kernel Gate.
 */
export class AuthorizationService {
  private readonly repository: AuthorizationRepository;
  private readonly rules: readonly PolicyRule[];
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly listeners = new Set<(event: AuthorizationChange) => void>();

  constructor(options: AuthorizationServiceOptions) {
    validatePolicyProgram(options.rules ?? []);
    this.repository = options.repository;
    this.rules = Object.freeze([...(options.rules ?? [])]);
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `ap:${randomUUID()}`);
  }

  onChanged(listener: (event: AuthorizationChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }

  private notify(event: AuthorizationChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // The durable row is already safe. One cleanup consumer must not stop
        // the remaining consumers from tearing down their live contexts.
      }
    }
  }
  private rewriteAliases(
    value: string,
    overlay?: Pick<AuthorizationResourceAlias, "uri" | "targetUri">,
  ): string {
    let current = parseResourceUri(value).uri;
    const used = new Set<string>();
    for (let hop = 0; hop < 32; hop += 1) {
      const stored = this.repository.findActiveAliasFor(current);
      const overlaid = overlay && isResourceUriPrefix(overlay.uri, current) ? overlay : undefined;
      let edge: Pick<AuthorizationResourceAlias, "uri" | "targetUri"> | undefined = stored;
      if (overlaid && (!edge || overlaid.uri.length >= edge.uri.length)) edge = overlaid;
      if (!edge) return current;
      if (used.has(edge.uri)) throw new Error(`resource alias cycle through ${edge.uri}`);
      used.add(edge.uri);
      current = rewriteResourceUri(current, edge.uri, edge.targetUri);
    }
    throw new Error("resource alias chain exceeds 32 redirects");
  }

  private resourceFor(ref: string): AuthorizationResource | undefined {
    if (!String(ref ?? "").includes("://")) return this.repository.getResource(ref);
    const uri = parseResourceUri(ref, "resource reference").uri;
    const direct = this.repository.getResourceByUri(uri);
    if (direct) return direct;
    return this.repository.getResourceByUri(this.rewriteAliases(uri));
  }


  upsertDomain(input: UpsertDomainInput): AuthorizationDomain {
    identifier(input.id, "domain.id");
    if (input.id.startsWith("studio:")) throw new Error("domain.id uses the reserved Studio projection namespace");
    if (!DOMAIN_KINDS.includes(input.kind)) throw new Error(`unsupported domain kind: ${input.kind}`);
    required(input.title, "domain.title", 200);
    if (!DOMAIN_AUTHORITY_KINDS.includes(input.authority.kind)) {
      throw new Error(`unsupported domain authority: ${input.authority.kind}`);
    }
    identifier(input.authority.id, "domain.authority.id");
    if (!HISTORY_POLICIES.includes(input.historyPolicy)) {
      throw new Error(`unsupported history policy: ${input.historyPolicy}`);
    }
    if (input.kind === "personal" && input.authority.kind !== "owner") {
      throw new Error("personal domains must be governed by their owner");
    }
    if (input.kind === "organization" && input.authority.kind !== "organization") {
      throw new Error("organization domains must be governed by an organization");
    }
    const previous = this.repository.getDomain(input.id);
    if (previous && (!sameAuthority(previous.authority, input.authority) || previous.kind !== input.kind)) {
      throw new Error("a registered domain's kind and authority are immutable");
    }
    const at = iso(this.now);
    const domain = this.repository.upsertDomain({
      ...input,
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    });
    this.notify({
      kind: "domain-upserted",
      owner: domain.authority.kind === "owner" ? domain.authority.id : undefined,
      domainId: domain.id,
    });
    return domain;
  }

  listDomains(limit?: number): AuthorizationDomain[] {
    return this.repository.listDomains(limit);
  }

  getDomain(id: string): AuthorizationDomain | undefined {
    return this.repository.getDomain(id);
  }

  upsertResource(input: UpsertResourceInput): AuthorizationResource {
    const uri = parseResourceUri(input.uri, "resource.uri").uri;
    identifier(input.id, "resource.id");
    if (input.id.startsWith("studio:")) throw new Error("resource.id uses the reserved Studio projection namespace");
    identifier(input.owner, "resource.owner");
    identifier(input.domainId, "resource.domainId");
    required(input.kind, "resource.kind", 100);
    required(input.title, "resource.title", 200);
    if (!RESOURCE_SENSITIVITIES.includes(input.sensitivity)) {
      throw new Error(`unsupported resource sensitivity: ${input.sensitivity}`);
    }
    identifier(input.externalRef.system, "externalRef.system");
    externalId(input.externalRef.id);
    const domain = this.repository.getDomain(input.domainId);
    if (!domain) throw new Error(`unknown authorization domain: ${input.domainId}`);
    if (domain.authority.kind === "owner" && domain.authority.id !== input.owner) {
      throw new Error("a resource in an owner-governed domain must have that same owner");
    }
    const previous = this.repository.getResource(input.id);
    const adoptingLegacyUri = previous !== undefined
      && previous.uri !== uri
      && previous.uri === migratedLegacyResourceUri(
        previous.externalRef.system,
        previous.externalRef.id,
      );
    if (previous && (
      (previous.uri !== uri && !adoptingLegacyUri)
      || previous.owner !== input.owner
      || previous.domainId !== input.domainId
      || previous.kind !== input.kind
      || previous.externalRef.system !== input.externalRef.system
      || previous.externalRef.id !== input.externalRef.id
    )) {
      throw new Error("a registered resource's URI, owner, domain, kind, and external reference are immutable");
    }
    const sensitivityRank = { normal: 0, sensitive: 1, credential: 2 } as const;
    if (previous && sensitivityRank[input.sensitivity] < sensitivityRank[previous.sensitivity]) {
      throw new Error("resource sensitivity may be raised but never lowered");
    }
    const other = this.repository.getResourceByExternalRef(input.externalRef.system, input.externalRef.id);
    if (other && other.id !== input.id) throw new Error("external reference is already registered to another resource");
    const addressed = this.repository.getResourceByUri(uri);
    if (addressed && addressed.id !== input.id) throw new Error("resource URI is already registered to another resource");
    const overlappingAlias = this.repository.findActiveAliasOverlap(uri);
    if (overlappingAlias) throw new Error(`resource URI overlaps active alias ${overlappingAlias.uri}`);
    const at = iso(this.now);
    if (previous && adoptingLegacyUri) {
      this.repository.adoptResourceUri(input.id, previous.uri, uri, at);
    }
    const resource = this.repository.upsertResource({
      ...input,
      uri,
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    });
    this.notify({ kind: "resource-upserted", owner: resource.owner, domainId: resource.domainId, resourceId: resource.id });
    return resource;
  }

  listResources(options: { owner?: string; domainId?: string; limit?: number } = {}): AuthorizationResource[] {
    return this.repository.listResources(options);
  }

  getResource(ref: string): AuthorizationResource | undefined {
    return this.resourceFor(ref);
  }

  putResourceAlias(input: PutResourceAliasInput): AuthorizationResourceAlias {
    identifier(input.owner, "resource alias owner");
    required(input.createdBy, "resource alias createdBy", 256);
    const uri = parseResourceUri(input.uri, "resource alias URI").uri;
    const targetUri = parseResourceUri(input.targetUri, "resource alias target").uri;
    const existing = this.repository.getActiveAlias(uri);
    if (existing && existing.owner !== input.owner) throw new Error("resource alias belongs to another owner");
    const overlappingAlias = this.repository.findActiveAliasOverlap(uri, uri);
    if (overlappingAlias) throw new Error(`resource alias overlaps active alias ${overlappingAlias.uri}`);
    if (this.repository.resourceOwnersAtOrBelow(uri).length > 0) {
      throw new Error("resource alias may not shadow a canonical resource subtree");
    }
    const resolvedTarget = this.rewriteAliases(targetUri, { uri, targetUri });
    const targetOwners = this.repository.resourceOwnersAtOrBelow(resolvedTarget);
    if (targetOwners.length === 0) throw new Error("resource alias target is not a registered resource subtree");
    if (targetOwners.length !== 1 || targetOwners[0] !== input.owner) {
      throw new Error("resource alias and target subtree must have the same owner");
    }
    const alias = this.repository.putAlias({
      id: `aa:${randomUUID()}`,
      owner: input.owner,
      uri,
      targetUri,
      createdBy: input.createdBy,
      createdAt: iso(this.now),
      revokedBy: null,
      revokedAt: null,
    });
    this.notify({ kind: "resource-alias-put", owner: alias.owner });
    return alias;
  }

  revokeResourceAlias(input: RevokeResourceAliasInput): AuthorizationResourceAlias | undefined {
    identifier(input.owner, "resource alias owner");
    required(input.revokedBy, "resource alias revokedBy", 256);
    const uri = parseResourceUri(input.uri, "resource alias URI").uri;
    const revoked = this.repository.revokeAlias(input.owner, uri, input.revokedBy, iso(this.now));
    if (revoked) this.notify({ kind: "resource-alias-revoked", owner: revoked.owner });
    return revoked;
  }

  listResourceAliases(options: {
    owner?: string;
    includeRevoked?: boolean;
    limit?: number;
  } = {}): AuthorizationResourceAlias[] {
    return this.repository.listAliases(options);
  }


  /**
   * Trusted-program inventory for one registered resource. Subject, operation,
   * facts, and hierarchy conditions are intentionally left unevaluated: this
   * supports an honest Studio policy row without pretending a runtime actor was
   * supplied. It is not an authorization decision.
   */
  listRulesForResource(resourceId: string): readonly PolicyRule[] {
    const resource = this.resourceFor(resourceId);
    if (!resource) return [];
    const domain = this.repository.getDomain(resource.domainId);
    if (!domain) return [];
    const selected = <T>(values: readonly T[] | undefined, value: T): boolean =>
      values === undefined || values.includes(value);
    return this.rules.filter((rule) =>
      authorityApplies(rule.authority, resource, domain)
      && selected(rule.match.resourceIds, resource.id)
      && selected(rule.match.resourceKinds, resource.kind)
      && selected(rule.match.domainIds, domain.id)
      && selected(rule.match.domainKinds, domain.kind));
  }

  private validatePermitAuthority(authority: AuthorityRef, resource: AuthorizationResource): AuthorizationDomain {
    const domain = this.repository.getDomain(resource.domainId);
    if (!domain) throw new Error(`resource ${resource.id} refers to an unknown domain`);
    if (authority.kind === "owner") {
      if (authority.id !== resource.owner) throw new Error("owner permits must be issued by the resource owner");
    } else if (domain.authority.kind !== "organization" || !sameAuthority(authority, domain.authority)) {
      throw new Error("organization permits must come from the resource domain's authority");
    }
    return domain;
  }

  putPermit(input: PutPermitInput): ExactPermit {
    if (!AUTHORIZATION_SUBJECT_TYPES.includes(input.subject.type)) {
      throw new Error(`unsupported subject type: ${input.subject.type}`);
    }
    identifier(input.subject.id, "permit.subject.id");
    required(input.operation, "permit.operation", 160);
    if (!PERMIT_MODES.includes(input.mode)) throw new Error(`unsupported permit mode: ${input.mode}`);
    if (!PERMIT_SOURCES.includes(input.source)) throw new Error(`unsupported permit source: ${input.source}`);
    identifier(input.authority.id, "permit.authority.id");
    required(input.createdBy, "permit.createdBy", 256);
    const resource = this.resourceFor(input.resourceId);
    if (!resource) throw new Error(`unknown authorization resource: ${input.resourceId}`);
    this.validatePermitAuthority(input.authority, resource);
    const permit = this.repository.putPermit({
      id: this.newId(),
      ...input,
      resourceId: resource.id,
      createdAt: iso(this.now),
      revokedBy: null,
      revokedAt: null,
    });
    this.notify({
      kind: "permit-put",
      owner: resource.owner,
      domainId: resource.domainId,
      resourceId: resource.id,
      subject: permit.subject,
      operation: permit.operation,
    });
    return permit;
  }

  revokePermit(input: RevokePermitInput): ExactPermit | undefined {
    required(input.revokedBy, "permit.revokedBy", 256);
    const resource = this.resourceFor(input.resourceId);
    if (!resource) throw new Error(`unknown authorization resource: ${input.resourceId}`);
    this.validatePermitAuthority(input.authority, resource);
    // Repository marks the row first. Only then do live consumers hear about
    // the revocation and destroy capability Contexts derived from the old row.
    const revoked = this.repository.revokePermit(
      { ...input, resourceId: resource.id },
      input.revokedBy,
      iso(this.now),
    );
    if (revoked) {
      this.notify({
        kind: "permit-revoked",
        owner: resource.owner,
        domainId: resource.domainId,
        resourceId: resource.id,
        subject: revoked.subject,
        operation: revoked.operation,
      });
    }
    return revoked;
  }

  listPermits(query: PermitQuery = {}): ExactPermit[] {
    if (!query.resourceId) return this.repository.listPermits(query);
    const resource = this.resourceFor(query.resourceId);
    if (!resource) return [];
    return this.repository.listPermits({ ...query, resourceId: resource.id });
  }

  getAppInstallDefaults(owner: string): StoredAppInstallDefaults {
    identifier(owner, "defaults.owner");
    const saved = this.repository.getAppInstallDefaults(owner);
    if (saved) {
      const profile = saved.profile;
      if (profile.version !== 1 || profile.readMode !== "allow" || profile.observeMode !== "allow"
        || !["deny", "ask", "allow"].includes(profile.writeMode)
        || !["deny", "ask", "allow"].includes(profile.executeMode)) {
        throw new Error(`invalid stored App install defaults for ${owner}`);
      }
      return saved;
    }
    return {
      owner,
      profile: DEFAULT_APP_INSTALL_PROFILE,
      source: "built-in",
      updatedBy: null,
      updatedAt: null,
    };
  }

  setAppInstallDefaults(
    owner: string,
    input: Pick<AppInstallDefaultProfile, "writeMode" | "executeMode">
      & Partial<Pick<AppInstallDefaultProfile, "version" | "readMode" | "observeMode">>,
    updatedBy: string,
  ): StoredAppInstallDefaults {
    identifier(owner, "defaults.owner");
    required(updatedBy, "defaults.updatedBy", 256);
    const valid = ["deny", "ask", "allow"];
    if (!valid.includes(input.writeMode) || !valid.includes(input.executeMode)) {
      throw new Error("App install write/execute defaults must be deny, ask, or allow");
    }
    if ((input.version !== undefined && input.version !== 1)
      || (input.readMode !== undefined && input.readMode !== "allow")
      || (input.observeMode !== undefined && input.observeMode !== "allow")) {
      throw new Error("App install default profile v1 fixes read and observe to allow");
    }
    const defaults = this.repository.setAppInstallDefaults(
      owner,
      { ...DEFAULT_APP_INSTALL_PROFILE, writeMode: input.writeMode, executeMode: input.executeMode },
      updatedBy,
      iso(this.now),
    );
    this.notify({ kind: "defaults-updated", owner });
    return defaults;
  }

  private applicableRules(
    request: AccessRequest,
    resource: AuthorizationResource,
    domain: AuthorizationDomain,
  ): EvaluatedRule[] {
    return this.rules.map((rule) => {
      if (!authorityApplies(rule.authority, resource, domain)) {
        return { rule, matched: false, reason: "selector_mismatch" };
      }
      return evaluateRule(rule, { request, resource, domain });
    });
  }

  private evaluateIntent(
    request: AccessRequest,
    resource: AuthorizationResource,
    domain: AuthorizationDomain,
    ownerBaseline: boolean,
  ): EvaluatedIntent {
    const steps: DecisionStep[] = [];
    const evaluatedRules = this.applicableRules(request, resource, domain);
    for (const result of evaluatedRules) {
      const mandatoryUnknown = result.reason === "condition_unknown" && result.rule.mandatory;
      steps.push({
        stage: "rule",
        outcome: result.matched ? "matched" : mandatoryUnknown ? "applied" : "missed",
        message: result.matched
          ? result.rule.explanation
          : mandatoryUnknown
            ? `${result.rule.title}: required policy facts/hierarchy are missing; failing closed`
            : `${result.rule.title}: ${result.reason}`,
        effect: result.rule.effect,
        authority: result.rule.authority,
        ruleId: result.rule.id,
      });
    }
    const unknownMandatory = evaluatedRules.find((result) =>
      result.reason === "condition_unknown" && result.rule.mandatory);
    if (unknownMandatory) {
      return {
        result: unknownMandatory.rule.effect === "block" ? "block" : "deny",
        code: "mandatory_policy_context_missing",
        steps,
        explicit: true,
      };
    }
    const matchedRules = evaluatedRules.filter((result) => result.matched).map((result) => result.rule);
    const hardBlock = matchedRules.find((rule) => rule.effect === "block");
    if (hardBlock) return { result: "block", code: "policy_block", steps, explicit: true };
    const mandatoryDeny = matchedRules.find((rule) => rule.mandatory && rule.effect === "deny");
    if (mandatoryDeny) return { result: "deny", code: "mandatory_organization_deny", steps, explicit: true };

    const permits = this.repository.listPermits({
      resourceId: resource.id,
      subject: request.subject,
      operation: request.operation,
    }).filter((permit) => authorityApplies(permit.authority, resource, domain));
    for (const permit of permits) {
      steps.push({
        stage: "permit",
        outcome: "matched",
        message: `${permit.authority.kind} authority recorded an exact ${permit.mode} permit`,
        effect: permit.mode,
        authority: permit.authority,
        permitId: permit.id,
      });
    }

    const ruleGrant = strongest(matchedRules
      .map((rule) => rule.effect)
      .filter((effect): effect is "ask" | "allow" => effect === "ask" || effect === "allow"));
    const permitGrant = strongest(permits.map((permit) => permit.mode));

    // An App/agent's exact permit is its install ceiling. A broad company rule
    // can never turn the owner's missing/ASK ceiling into silent App authority.
    if (request.subject.type === "app" || request.subject.type === "agent") {
      if (!permitGrant) {
        steps.push({
          stage: "default",
          outcome: "applied",
          message: "App/agent has no exact install permit; profile defaults are draft-only",
        });
        return { result: "deny", code: "install_permit_missing", steps, explicit: false };
      }
      const result = permitGrant === "ask" ? "ask" : ruleGrant === "ask" ? "ask" : "allow";
      return { result, code: result === "allow" ? "exact_permit_allow" : "approval_required", steps, explicit: true };
    }

    const grants: Array<"ask" | "allow"> = [];
    if (ruleGrant) grants.push(ruleGrant);
    if (permitGrant) grants.push(permitGrant);
    if (ownerBaseline && request.subject.type === "user" && request.subject.id === resource.owner) {
      grants.push("allow");
      steps.push({ stage: "baseline", outcome: "applied", message: "resource owner is accessing their own resource" });
    }
    const result = strongest(grants);
    if (result) {
      return {
        result,
        code: result === "allow" ? "authority_allow" : "approval_required",
        steps,
        explicit: Boolean(ruleGrant || permitGrant),
      };
    }
    steps.push({ stage: "default", outcome: "applied", message: "no matching authority; absence is deny" });
    return { result: "deny", code: "no_matching_authority", steps, explicit: false };
  }

  private evaluateTargetMandatoryRules(
    request: AccessRequest,
    resource: AuthorizationResource,
    target: AuthorizationDomain,
  ): EvaluatedIntent | undefined {
    if (target.authority.kind !== "organization") return undefined;
    const evaluated = this.rules
      .filter((rule) => rule.mandatory && sameAuthority(rule.authority, target.authority))
      .map((rule) => evaluateRule(rule, { request, resource, domain: target }));
    const relevant = evaluated.filter((result) =>
      result.matched || result.reason === "condition_unknown");
    const steps: DecisionStep[] = relevant.map((result) => ({
      stage: "rule",
      outcome: result.matched ? "matched" : "applied",
      message: result.matched
        ? `target domain: ${result.rule.explanation}`
        : `target domain: ${result.rule.title} requires missing policy facts/hierarchy; failing closed`,
      effect: result.rule.effect,
      authority: result.rule.authority,
      ruleId: result.rule.id,
    }));
    const unknown = relevant.find((result) => result.reason === "condition_unknown");
    if (unknown) {
      return {
        result: unknown.rule.effect === "block" ? "block" : "deny",
        code: "target_domain_policy_context_missing",
        steps,
        explicit: true,
      };
    }
    const matched = relevant.filter((result) => result.matched);
    if (matched.some((result) => result.rule.effect === "block")) {
      return { result: "block", code: "target_domain_policy_block", steps, explicit: true };
    }
    if (matched.some((result) => result.rule.effect === "deny")) {
      return { result: "deny", code: "target_domain_mandatory_deny", steps, explicit: true };
    }
    return undefined;
  }

  decideAccess(request: AccessRequest): AccessDecision {
    required(request.operation, "access.operation", 160);
    let resource: AuthorizationResource | undefined;
    try {
      resource = this.resourceFor(request.resourceId);
    } catch {
      resource = undefined;
    }
    if (!resource) {
      return {
        result: "deny",
        code: "resource_not_registered",
        enforcement: "intent-only",
        steps: [{ stage: "validation", outcome: "applied", message: "resource is not registered" }],
      };
    }
    const domain = this.repository.getDomain(resource.domainId);
    if (!domain) {
      return {
        result: "deny",
        code: "domain_not_registered",
        enforcement: "intent-only",
        steps: [{ stage: "validation", outcome: "applied", message: "resource domain is not registered" }],
      };
    }
    const evaluated = this.evaluateIntent({ ...request, resourceId: resource.id }, resource, domain, true);
    return { result: evaluated.result, code: evaluated.code, enforcement: "intent-only", steps: evaluated.steps };
  }

  explain(request: AccessRequest): AccessDecision {
    return this.decideAccess(request);
  }

  decideFlow(request: FlowRequest): AccessDecision {
    if (!TRANSFER_KINDS.includes(request.transfer)) throw new Error(`unsupported transfer: ${request.transfer}`);
    let resource: AuthorizationResource | undefined;
    try {
      resource = this.resourceFor(request.resourceId);
    } catch {
      resource = undefined;
    }
    const target = this.repository.getDomain(request.targetDomainId);
    if (!resource || !target) {
      return {
        result: "deny",
        code: !resource ? "resource_not_registered" : "target_domain_not_registered",
        enforcement: "intent-only",
        steps: [{ stage: "validation", outcome: "applied", message: "flow endpoint is not registered" }],
      };
    }
    const source = this.repository.getDomain(resource.domainId);
    if (!source) {
      return {
        result: "deny",
        code: "domain_not_registered",
        enforcement: "intent-only",
        steps: [{ stage: "validation", outcome: "applied", message: "source domain is not registered" }],
      };
    }
    if (resource.sensitivity === "credential" && target.kind !== "personal") {
      return {
        result: "block",
        code: "credential_non_personal_block",
        enforcement: "intent-only",
        steps: [{
          stage: "safety",
          outcome: "applied",
          effect: "block",
          message: "credential resources cannot flow into a non-personal domain",
        }],
      };
    }
    if (resource.sensitivity === "credential" && source.id !== target.id) {
      return {
        result: "block",
        code: "credential_cross_personal_block",
        enforcement: "intent-only",
        steps: [{
          stage: "safety",
          outcome: "applied",
          effect: "block",
          message: "credential resources cannot leave their source personal domain",
        }],
      };
    }

    const accessRequest: AccessRequest = {
      subject: request.subject,
      resourceId: resource.id,
      operation: `transfer:${request.transfer}`,
      facts: {
        ...(request.facts ?? {}),
        "flow.target_domain_id": target.id,
        "flow.target_domain_kind": target.kind,
        "flow.transfer": request.transfer,
      },
      hierarchies: request.hierarchies,
    };
    const evaluated = this.evaluateIntent(accessRequest, resource, source, false);
    const installCeilingMissing = (request.subject.type === "app" || request.subject.type === "agent")
      && evaluated.code === "install_permit_missing";
    if (evaluated.result === "block"
      || evaluated.code === "mandatory_organization_deny"
      || evaluated.code === "mandatory_policy_context_missing"
      || installCeilingMissing) {
      return { result: evaluated.result, code: evaluated.code, enforcement: "intent-only", steps: evaluated.steps };
    }
    const targetMandatory = this.evaluateTargetMandatoryRules(accessRequest, resource, target);
    if (targetMandatory) {
      return {
        result: targetMandatory.result,
        code: targetMandatory.code,
        enforcement: "intent-only",
        steps: [...evaluated.steps, ...targetMandatory.steps],
      };
    }
    if (source.id === target.id) {
      if (evaluated.explicit && (evaluated.result === "allow" || evaluated.result === "ask")) {
        return { result: evaluated.result, code: evaluated.code, enforcement: "intent-only", steps: evaluated.steps };
      }
      return {
        result: "allow",
        code: "same_domain_flow",
        enforcement: "intent-only",
        steps: [...evaluated.steps, {
          stage: "baseline",
          outcome: "applied",
          effect: "allow",
          message: "source and target are the same security domain",
        }],
      };
    }
    // v1 exact permits do not carry a target audience. Across domains they
    // can impose ASK, but cannot create silent authority for an arbitrary
    // target. Only a trusted rule evaluated with flow.target_domain_* facts
    // can produce a cross-domain AUTO decision.
    const targetBoundRuleIds = new Set(this.rules
      .filter((rule) => rule.when && conditionReferencesFact(rule.when, "flow.target_domain_id"))
      .map((rule) => rule.id));
    const matchedRuleGrant = strongest(evaluated.steps
      .filter((step) => step.stage === "rule" && step.outcome === "matched"
        && step.ruleId !== undefined && targetBoundRuleIds.has(step.ruleId))
      .map((step) => step.effect)
      .filter((effect): effect is "ask" | "allow" => effect === "ask" || effect === "allow"));
    if (matchedRuleGrant) {
      const result = request.subject.type === "app" || request.subject.type === "agent"
        ? evaluated.result
        : matchedRuleGrant;
      if (result === "allow" || result === "ask") {
        return {
          result,
          code: result === "allow" ? "authority_allow" : "approval_required",
          enforcement: "intent-only",
          steps: evaluated.steps,
        };
      }
    }
    if (evaluated.explicit && evaluated.result === "ask") {
      return { result: "ask", code: "approval_required", enforcement: "intent-only", steps: evaluated.steps };
    }
    if (source.kind === "personal" && (target.kind === "shared" || target.kind === "organization")) {
      return {
        result: "ask",
        code: "private_to_shared_approval",
        enforcement: "intent-only",
        steps: [...evaluated.steps, {
          stage: "default",
          outcome: "applied",
          effect: "ask",
          message: `${request.transfer} publishes private data into a wider domain`,
        }],
      };
    }
    return {
      result: "deny",
      code: "cross_domain_not_permitted",
      enforcement: "intent-only",
      steps: [...evaluated.steps, {
        stage: "default",
        outcome: "applied",
        effect: "deny",
        message: "cross-domain transfer has no matching explicit policy",
      }],
    };
  }
}

export type { PolicyEffect };
