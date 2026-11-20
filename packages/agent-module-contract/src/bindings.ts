/**
 * `agent-resource-bindings` — which typed ports an App needs, which module
 * instance is wired to which, and (v2) which of those wired instances may be
 * duplicated into a family of runtime panels.
 *
 * ── Why a third document rather than fields on the composition ──────────────
 *
 * `agent-composition/v1` answers "what is mounted, and where". This answers "and
 * what is it plugged into". Keeping them apart is not filing: the composition's
 * field set is closed and covered by a package digest, and a release adapter
 * that accepted an unknown key there would be accepting a newer schema it cannot
 * interpret. Adding a document is a change a reviewer sees; widening one is a
 * change that looks like nothing.
 *
 * It also keeps their lifetimes honest. A layout can be re-arranged without
 * touching what the App depends on, and a dependency can be added without
 * anything moving on screen.
 *
 * ── What a plan is NOT allowed to contain ──────────────────────────────────
 *
 * A provider package name, a Node import, a URL, an owner, a device, a workspace
 * id, a Context, a grant, a token, a launch command, or a version range. It
 * declares a NEED and a WIRE and nothing else; the trusted deployment decides
 * what satisfies the need, in a static catalog it registered itself. That is the
 * Backstage rule — the backend instance wires services, plugins declare
 * dependencies — and the reason for it is the same: a manifest that could name
 * an implementation would be a manifest that could install one.
 *
 *   {
 *     "schema": "agent-resource-bindings/v1",
 *     "app": "super-workspace",
 *     "bindings":    [{ "binding": "workspace", "contract": "workspace-files/v1" }],
 *     "connections": [{ "instance": "files", "port": "workspace-files/v1",
 *                       "binding": "workspace" }]
 *   }
 *
 * ── Why `port` and `contract` are both written out ─────────────────────────
 *
 * A connection states the port a MODULE declared (its manifest's `ports` entry)
 * and the binding it is wired to; the binding states the contract the App asked
 * the deployment for. They are almost always the same string, and the linker
 * refuses when they are not. Deriving one from the other would remove the only
 * place the disagreement can be seen — a module wired to a binding that provides
 * something else is exactly the mistake this document exists to catch.
 *
 * ── v2: `templates`, and what it deliberately is not ───────────────────────
 *
 *   { …, "templates": [{ "instance": "file-viewer", "maxInstances": 12 }] }
 *
 * v1 wires composition INSTANCES, by name. A runtime panel minted beside one is
 * anonymous — absent from the document that decides what is connected — and yet,
 * because the App's provider sits above the whole workspace, it would render as
 * though it had a port. So v1's layout kernel refuses `mode: "new"` on a
 * connected surface, and a workspace can hold exactly one open file.
 *
 * A template is the missing sentence: *panels derived from this declared
 * instance inherit its module `config` and its whole connection family, up to a
 * stated ceiling.* That is all it says. It carries no provider, owner, app,
 * scope, URL, path, permission or code — the same closed list as above, enforced
 * the same way, by a two-field record and a refusal for every other key.
 *
 * It is not a widening of authority either. A derived panel inherits an existing
 * binding NAME, and a provider scope is keyed by `[owner, app, appInstance,
 * binding]` on the trusted side — so twelve file tabs remain one scope, one ref
 * vault, one grant to revoke. `templates` changes what a layout may show, never
 * what an App may reach; the permission contract is untouched by design.
 *
 * `maxInstances` counts EVERY live panel of that family, the declared standing
 * instance included, because that is the number a reader can compare against
 * "how many tabs can this open". The ceiling is bounded by this build
 * (`RESOURCE_TEMPLATE_MAX_INSTANCES`), because an unbounded count in a release
 * asset is a count some process has to hold.
 *
 * ── Why v2 is a second schema and not a v1 field ───────────────────────────
 *
 * Same reason as the whole document: an unknown key in v1 is a refusal, so a
 * build that predates templates cannot silently accept — and must not silently
 * accept — a plan whose extra panels it will never produce. The v1 reader,
 * encoder and canonical bytes below are therefore untouched; historical releases
 * are read by code that did not change.
 */

import { isContractId, isInstanceId } from "./ids.js";
import type { AgentComposition } from "./composition.js";
import type { AgentModuleManifest } from "./manifest.js";
import { isDocumentSlot, type WorkspaceSlot } from "./slots.js";
import {
  CONTRACT_LIMITS,
  IssueBag,
  arrayAt,
  encodeCanonical,
  integerAt,
  objectAt,
  parseJsonDocument,
  refuseUnknownFields,
  stringAt,
  type ContractResult,
} from "./validate.js";

export const RESOURCE_BINDINGS_SCHEMA = "agent-resource-bindings/v1";
export const RESOURCE_BINDINGS_SCHEMA_V2 = "agent-resource-bindings/v2";

/** Every schema this build reads. Compared; never parsed for a version number. */
export const RESOURCE_BINDING_SCHEMAS = Object.freeze([
  RESOURCE_BINDINGS_SCHEMA,
  RESOURCE_BINDINGS_SCHEMA_V2,
] as const);

/**
 * The largest family a template may declare.
 *
 * Sixteen because each member is a mounted module with live effects and a claim
 * on a typed port, and because a ceiling a reviewer cannot picture is not a
 * ceiling. A release wanting more is a design conversation, not a bigger number.
 */
export const RESOURCE_TEMPLATE_MAX_INSTANCES = 16;

/** One typed port this App asks its deployment to provide. */
export interface ResourceBinding {
  /** The App-local name a connection refers to. Compared, never resolved. */
  binding: string;
  /** The contract id, e.g. `workspace-files/v1`. */
  contract: string;
}

/** One module instance, wired to one binding. */
export interface ResourceConnection {
  /** A `composition.instances[].instance`. */
  instance: string;
  /** A `manifest.ports[]` entry of the module that instance mounts. */
  port: string;
  /** A `bindings[].binding`. */
  binding: string;
}

/** One connected instance that runtime panels may be derived from. */
export interface ResourceTemplate {
  /** A connected `composition.instances[].instance`. The prototype. */
  instance: string;
  /** Total live panels of this family, prototype included. 1‥16. */
  maxInstances: number;
}

export interface AgentResourceBindings {
  schema: typeof RESOURCE_BINDINGS_SCHEMA;
  /** The stable app id this plan belongs to. Compared, never resolved. */
  app: string;
  /** Sorted by binding name, names unique. */
  bindings: readonly ResourceBinding[];
  /** Sorted by (instance, port), pairs unique. */
  connections: readonly ResourceConnection[];
}

export interface AgentResourceBindingsV2 {
  schema: typeof RESOURCE_BINDINGS_SCHEMA_V2;
  app: string;
  bindings: readonly ResourceBinding[];
  connections: readonly ResourceConnection[];
  /** Sorted by instance, instances unique, never empty. */
  templates: readonly ResourceTemplate[];
}

/** Either schema. The type every consumer of an installed release should hold. */
export type ResourceBindingPlan = AgentResourceBindings | AgentResourceBindingsV2;

const PLAN_FIELDS = ["schema", "app", "bindings", "connections"] as const;
const PLAN_FIELDS_V2 = [...PLAN_FIELDS, "templates"] as const;
const BINDING_FIELDS = ["binding", "contract"] as const;
const CONNECTION_FIELDS = ["instance", "port", "binding"] as const;
const TEMPLATE_FIELDS = ["instance", "maxInstances"] as const;

const NO_TEMPLATES: readonly ResourceTemplate[] = Object.freeze([]);

/**
 * A binding name. The same grammar as an instance id, because it is used the
 * same way — as a short key inside one App — and a second grammar would be a
 * second thing to get wrong.
 */
function isBindingName(value: string): boolean {
  return isInstanceId(value);
}

/**
 * Read either schema, decided by the document's own `schema` field.
 *
 * The dispatch is a lookup, not a version comparison: `agent-resource-bindings/v3`
 * is not "newer", it is a document this build cannot interpret, and it lands in
 * the v1 branch which refuses it by name. That refusal is deliberately the one
 * v1 always produced — the wording is part of a frozen outcome, and either way
 * the answer is no.
 */
export function readResourceBindings(value: unknown): ContractResult<ResourceBindingPlan> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, "bindings");
  if (!row) return bag.fail();
  return row.schema === RESOURCE_BINDINGS_SCHEMA_V2 ? readV2(row) : readV1(row);
}

/** The fields both schemas share, read in one fixed order. */
function readPlanCore(
  bag: IssueBag,
  row: Record<string, unknown>,
  expected: string,
  fields: readonly string[],
): { app: string | null; rawBindings: unknown[] | null; rawConnections: unknown[] | null } {
  refuseUnknownFields(bag, row, fields, "bindings");
  if (row.schema !== expected) {
    bag.add("schema", `bindings.schema must be ${expected}`, "bindings.schema");
  }
  const app = stringAt(bag, row, "app", "bindings");
  if (app !== null && !app.trim()) bag.add("empty", "app must not be blank", "bindings.app");
  const rawBindings = arrayAt(bag, row, "bindings", "bindings", CONTRACT_LIMITS.maxInstances);
  const rawConnections = arrayAt(bag, row, "connections", "bindings", CONTRACT_LIMITS.maxInstances);
  return { app, rawBindings, rawConnections };
}

interface Wiring {
  bindings: ResourceBinding[];
  connections: ResourceConnection[];
  /** Instances this plan wires to at least one port. */
  connected: Set<string>;
}

function readWiring(bag: IssueBag, rawBindings: unknown[], rawConnections: unknown[]): Wiring {
  const bindings: ResourceBinding[] = [];
  const seenBindings = new Map<string, string>();
  rawBindings.forEach((entry, index) => {
    const at = `bindings.bindings[${index}]`;
    const item = objectAt(bag, entry, at);
    if (!item) return;
    refuseUnknownFields(bag, item, BINDING_FIELDS, at);
    const binding = stringAt(bag, item, "binding", at);
    if (binding !== null && !isBindingName(binding)) {
      bag.add("identifier", "binding must be a short lower-case key", `${at}.binding`);
    }
    const contract = stringAt(bag, item, "contract", at);
    if (contract !== null && !isContractId(contract)) {
      bag.add("identifier", "contract must look like `workspace-files/v1`", `${at}.contract`);
    }
    if (binding === null || contract === null || !isBindingName(binding) || !isContractId(contract)) return;
    if (seenBindings.has(binding)) {
      // Two answers to "what does `workspace` provide" is not something to pick
      // a winner in: whichever one a linker happened to read would decide which
      // provider a module was handed.
      bag.add("duplicate", `binding ${binding} is declared twice`, at);
      return;
    }
    seenBindings.set(binding, contract);
    bindings.push({ binding, contract });
  });

  const connections: ResourceConnection[] = [];
  const connected = new Set<string>();
  const seenConnections = new Set<string>();
  rawConnections.forEach((entry, index) => {
    const at = `bindings.connections[${index}]`;
    const item = objectAt(bag, entry, at);
    if (!item) return;
    refuseUnknownFields(bag, item, CONNECTION_FIELDS, at);
    const instance = stringAt(bag, item, "instance", at);
    if (instance !== null && !isInstanceId(instance)) {
      bag.add("identifier", "instance must be a short lower-case key", `${at}.instance`);
    }
    const port = stringAt(bag, item, "port", at);
    if (port !== null && !isContractId(port)) {
      bag.add("identifier", "port must look like `workspace-files/v1`", `${at}.port`);
    }
    const binding = stringAt(bag, item, "binding", at);
    if (binding !== null && !isBindingName(binding)) {
      bag.add("identifier", "binding must be a short lower-case key", `${at}.binding`);
    }
    if (instance === null || port === null || binding === null) return;
    if (!isInstanceId(instance) || !isContractId(port) || !isBindingName(binding)) return;
    // Dangling and mismatched references are refused HERE, without a lock or a
    // registry, because they are internal to this document.
    const declared = seenBindings.get(binding);
    if (declared === undefined) {
      bag.add("unknown_module", `connection names binding ${binding}, which is not declared`, at);
      return;
    }
    if (declared !== port) {
      bag.add("schema", `binding ${binding} provides ${declared}, not ${port}`, `${at}.port`);
      return;
    }
    // One instance may hold several ports; it may not hold the same port twice.
    const key = `${instance}\0${port}`;
    if (seenConnections.has(key)) {
      bag.add("duplicate", `instance ${instance} is wired to ${port} twice`, at);
      return;
    }
    seenConnections.add(key);
    connected.add(instance);
    connections.push({ instance, port, binding });
  });

  return { bindings, connections, connected };
}

function readV1(row: Record<string, unknown>): ContractResult<AgentResourceBindings> {
  const bag = new IssueBag();
  const core = readPlanCore(bag, row, RESOURCE_BINDINGS_SCHEMA, PLAN_FIELDS);
  if (!core.rawBindings || !core.rawConnections) return bag.fail();
  const wiring = readWiring(bag, core.rawBindings, core.rawConnections);
  if (!bag.empty) return bag.fail();
  return {
    ok: true,
    value: {
      schema: RESOURCE_BINDINGS_SCHEMA,
      app: core.app!,
      bindings: sortBindings(wiring.bindings),
      connections: sortConnections(wiring.connections),
    },
  };
}

function readV2(row: Record<string, unknown>): ContractResult<AgentResourceBindingsV2> {
  const bag = new IssueBag();
  const core = readPlanCore(bag, row, RESOURCE_BINDINGS_SCHEMA_V2, PLAN_FIELDS_V2);
  const rawTemplates = arrayAt(bag, row, "templates", "bindings", CONTRACT_LIMITS.maxInstances);
  if (!core.rawBindings || !core.rawConnections || !rawTemplates) return bag.fail();
  const wiring = readWiring(bag, core.rawBindings, core.rawConnections);
  const templates = readTemplates(bag, rawTemplates, wiring.connected);
  if (!bag.empty) return bag.fail();
  return {
    ok: true,
    value: {
      schema: RESOURCE_BINDINGS_SCHEMA_V2,
      app: core.app!,
      bindings: sortBindings(wiring.bindings),
      connections: sortConnections(wiring.connections),
      templates: sortTemplates(templates),
    },
  };
}

function readTemplates(
  bag: IssueBag,
  raw: unknown[],
  connected: ReadonlySet<string>,
): ResourceTemplate[] {
  if (!raw.length) {
    // A v2 plan with no template says exactly what a v1 plan says. Two byte
    // representations of one plan is the thing canonical encoding exists to
    // prevent, so the empty case is spelled `agent-resource-bindings/v1`.
    bag.add("empty", "templates must not be empty; a plan with no template is a v1 plan", "bindings.templates");
    return [];
  }
  const rows: ResourceTemplate[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const at = `bindings.templates[${index}]`;
    const item = objectAt(bag, entry, at);
    if (!item) return;
    refuseUnknownFields(bag, item, TEMPLATE_FIELDS, at);
    const instance = stringAt(bag, item, "instance", at);
    if (instance !== null && !isInstanceId(instance)) {
      bag.add("identifier", "instance must be a short lower-case key", `${at}.instance`);
    }
    const maxInstances = integerAt(bag, item, "maxInstances", at, {
      min: 1,
      max: RESOURCE_TEMPLATE_MAX_INSTANCES,
    });
    if (instance === null || maxInstances === null || !isInstanceId(instance)) return;
    if (seen.has(instance)) {
      // Two ceilings for one family is two answers to "may a thirteenth panel
      // open", and a resolver holding both would pick by array order.
      bag.add("duplicate", `instance ${instance} has two templates`, at);
      return;
    }
    // A prototype inherits its own connections. An instance this plan wires to
    // nothing would inherit nothing, so the row would be a promise of an
    // inheritance that does not exist.
    if (!connected.has(instance)) {
      bag.add("unconnected", `template names ${instance}, which this plan connects to no binding`, at);
      return;
    }
    seen.add(instance);
    rows.push({ instance, maxInstances });
  });
  return rows;
}

export function parseResourceBindings(text: string): ContractResult<ResourceBindingPlan> {
  return parseJsonDocument(text, "bindings", readResourceBindings);
}

export function encodeResourceBindings(plan: ResourceBindingPlan): string {
  const base = {
    schema: plan.schema,
    app: plan.app,
    bindings: sortBindings(plan.bindings).map((row) => ({ binding: row.binding, contract: row.contract })),
    connections: sortConnections(plan.connections).map((row) => ({
      instance: row.instance,
      port: row.port,
      binding: row.binding,
    })),
  };
  if (plan.schema === RESOURCE_BINDINGS_SCHEMA) return encodeCanonical(base);
  return encodeCanonical({
    ...base,
    templates: sortTemplates(plan.templates).map((row) => ({
      instance: row.instance,
      maxInstances: row.maxInstances,
    })),
  });
}

function sortBindings(rows: readonly ResourceBinding[]): ResourceBinding[] {
  return [...rows].sort((a, b) => (a.binding < b.binding ? -1 : a.binding > b.binding ? 1 : 0));
}

function sortConnections(rows: readonly ResourceConnection[]): ResourceConnection[] {
  return [...rows].sort((a, b) => {
    if (a.instance !== b.instance) return a.instance < b.instance ? -1 : 1;
    return a.port < b.port ? -1 : a.port > b.port ? 1 : 0;
  });
}

function sortTemplates(rows: readonly ResourceTemplate[]): ResourceTemplate[] {
  return [...rows].sort((a, b) => (a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : 0));
}

/** The contract a binding provides, or undefined. Never a fallback. */
export function bindingContract(plan: ResourceBindingPlan, binding: string): string | undefined {
  return plan.bindings.find((row) => row.binding === binding)?.contract;
}

/** Which binding this instance's named port is wired to, if any. */
export function connectionFor(
  plan: ResourceBindingPlan,
  instance: string,
  port: string,
): ResourceConnection | undefined {
  return plan.connections.find((row) => row.instance === instance && row.port === port);
}

/**
 * This plan's templates — empty for v1.
 *
 * Exists so a consumer asks "may this surface be duplicated" instead of "which
 * schema is this", which is the branch that goes stale when a v3 arrives.
 */
export function planTemplates(plan: ResourceBindingPlan): readonly ResourceTemplate[] {
  return plan.schema === RESOURCE_BINDINGS_SCHEMA_V2 ? plan.templates : NO_TEMPLATES;
}

/** The template naming this instance as its prototype, if there is one. */
export function templateFor(plan: ResourceBindingPlan, instance: string): ResourceTemplate | undefined {
  return planTemplates(plan).find((row) => row.instance === instance);
}

export interface LinkedResourceBindings {
  composition: AgentComposition;
  plan: ResourceBindingPlan;
}

/**
 * The cross-document check: a plan read on its own is only well-formed; a plan
 * read against its composition is *connectable*.
 *
 * `manifests` is optional for the same reason `linkComposition`'s is — the
 * documents travel together as release assets while the registry does not. When
 * it IS supplied, the module's own `ports` declaration is enforced, which is
 * what makes that field mean something: an App cannot hand a typed port to a
 * module that never said it wanted one.
 *
 * And when it is supplied, a module that is MISSING from it is a refusal rather
 * than a skipped check. Supplying a registry is a caller saying "these are the
 * modules that exist"; a connection to one that is not there would otherwise be
 * validated by a check that silently did not run, which is the worst of the
 * three possible outcomes — it reads as a pass.
 *
 * ── The two schemas branch, and they do not share their open-surface rule ───
 *
 * v1's rule is "an openable module consuming a declared contract has EXACTLY ONE
 * connected standing instance", because v1 has no way to name a second one. v2's
 * template rules are about routes a template claims. Running either set against
 * the other schema would be a fabrication in one direction and a silent
 * loosening in the other, so the branch is explicit and v1's function is the one
 * that was already here, unmodified.
 */
export function linkResourceBindings(
  plan: ResourceBindingPlan,
  composition: AgentComposition,
  manifests?: ReadonlyMap<string, AgentModuleManifest>,
): ContractResult<LinkedResourceBindings> {
  const bag = new IssueBag();
  if (plan.app !== composition.app) {
    // Two documents about two different Apps is not a partial success. It is
    // the assembly step being handed somebody else's wiring.
    bag.add("schema", `plan is for app ${plan.app}, composition is for ${composition.app}`, "bindings.app");
    return bag.fail();
  }
  const instances = new Map(composition.instances.map((row) => [row.instance, row.module]));
  if (manifests) {
    // Completeness checks below need the declaration for every module that can
    // mount, not only for rows that happened to receive a connection. A partial
    // registry could otherwise make an unwired consumer invisible to the
    // linker, which is worse than not supplying a registry at all.
    const referenced = new Set([
      ...composition.instances.map((row) => row.module),
      ...composition.open.map((row) => row.module),
    ]);
    for (const moduleId of referenced) {
      if (!manifests.has(moduleId)) {
        bag.add("unknown_module", `${moduleId} has no manifest in the supplied registry`, "bindings");
      }
    }
  }
  plan.connections.forEach((row, index) => {
    const at = `bindings.connections[${index}]`;
    const moduleId = instances.get(row.instance);
    if (moduleId === undefined) {
      bag.add("unknown_module", `${row.instance} is not an instance in this composition`, at);
      return;
    }
    if (!manifests) return;
    const manifest = manifests.get(moduleId);
    if (!manifest) {
      bag.add("unknown_module", `${moduleId} has no manifest in the supplied registry`, at);
      return;
    }
    if (!manifest.ports.includes(row.port)) {
      bag.add("identifier", `${moduleId} does not declare the ${row.port} port`, `${at}.port`);
    }
  });
  if (manifests) {
    const declaredContracts = new Set(plan.bindings.map((row) => row.contract));

    // A manifest port is a required dependency. Once this App declares a
    // binding for that contract, every standing instance that consumes it must
    // name the wire explicitly; a global React Provider is not permission to
    // omit the connection from the assembly document.
    //
    // This is also what makes "a template prototype inherits its whole
    // CONNECTION FAMILY" a well-defined sentence: the family is guaranteed
    // complete for every instance, so a multi-port prototype cannot hand its
    // derived panels a half-wired inheritance.
    for (const instance of composition.instances) {
      const manifest = manifests.get(instance.module);
      if (!manifest) continue;
      for (const port of manifest.ports) {
        if (!declaredContracts.has(port)) continue;
        if (!connectionFor(plan, instance.instance, port)) {
          bag.add(
            "unconnected",
            `${instance.instance} needs ${port} but has no resource connection`,
            "bindings.connections",
          );
        }
      }
    }

    if (plan.schema === RESOURCE_BINDINGS_SCHEMA) {
      linkV1OpenSurfaces(bag, plan, composition, manifests, declaredContracts);
    } else {
      linkV2OpenSurfaces(bag, plan, composition, manifests, declaredContracts);
    }
  }
  // Template shape and route ownership need no registry: a template names an
  // instance, and every port it claims is written in this document's own
  // connections. So the install path — which deliberately supplies no manifests
  // — refuses a dangling, mis-slotted or ambiguous template too.
  if (plan.schema === RESOURCE_BINDINGS_SCHEMA_V2) {
    linkTemplates(bag, plan, composition);
    linkTemplateRoutes(bag, plan, composition);
  }
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { composition, plan } };
}

/**
 * v1 connections name standing instances; they have no template from which to
 * wire an anonymous runtime panel. An openable module that consumes a declared
 * resource contract therefore needs exactly one connected standing instance.
 * Zero would let a globally-provided port leak into an undeclared panel; two
 * would leave the coordinator unable to choose honestly.
 */
function linkV1OpenSurfaces(
  bag: IssueBag,
  plan: AgentResourceBindings,
  composition: AgentComposition,
  manifests: ReadonlyMap<string, AgentModuleManifest>,
  declaredContracts: ReadonlySet<string>,
): void {
  for (const rule of composition.open) {
    const manifest = manifests.get(rule.module);
    if (!manifest) continue;
    for (const port of manifest.ports) {
      if (!declaredContracts.has(port)) continue;
      const surfaces = composition.instances.filter(
        (instance) =>
          instance.module === rule.module
          && connectionFor(plan, instance.instance, port) !== undefined,
      );
      if (surfaces.length !== 1) {
        bag.add(
          "unconnected",
          `${rule.module} opens resources through ${port} but v1 needs exactly one connected standing instance`,
          "composition.open",
        );
      }
    }
  }
}

/**
 * The same question for v2, with one route excused: the one a template owns.
 *
 * Everything else is v1's rule verbatim, including its module-scoped counting.
 * v2 adds rules ABOUT templates; it deliberately loosens nothing for a route
 * that has none, so converting a plan to v2 without adding a template cannot
 * make a previously refused wiring pass.
 */
function linkV2OpenSurfaces(
  bag: IssueBag,
  plan: AgentResourceBindingsV2,
  composition: AgentComposition,
  manifests: ReadonlyMap<string, AgentModuleManifest>,
  declaredContracts: ReadonlySet<string>,
): void {
  const templated = new Set(plan.templates.map((row) => row.instance));
  for (const rule of composition.open) {
    const manifest = manifests.get(rule.module);
    if (!manifest) continue;
    for (const port of manifest.ports) {
      if (!declaredContracts.has(port)) continue;
      const surfaces = composition.instances.filter(
        (instance) =>
          instance.module === rule.module
          && connectionFor(plan, instance.instance, port) !== undefined,
      );
      const owned = surfaces.some(
        (instance) => templated.has(instance.instance) && instance.slot === rule.slot,
      );
      if (owned) continue;
      if (surfaces.length !== 1) {
        bag.add(
          "unconnected",
          `${rule.module} opens ${port} in ${rule.slot} with no template, so that route needs exactly one connected standing instance`,
          "composition.open",
        );
      }
    }
  }
}

/**
 * Is this prototype a surface a resource can actually be opened into?
 *
 * A template promises derived panels. A prototype nothing opens into would never
 * derive one, and a prototype in a flow slot would derive one with nowhere to
 * go — `navigation` and `bottom` hold strips of widgets, not documents.
 *
 * The slot agreement is the load-bearing one. A later resolver is handed a
 * module and a slot (that is what an open rule is); if the prototype sits
 * somewhere the module is never opened into, no route would ever reach it and
 * the ceiling would describe a family that cannot exist.
 */
function linkTemplates(
  bag: IssueBag,
  plan: AgentResourceBindingsV2,
  composition: AgentComposition,
): void {
  const instances = new Map(composition.instances.map((row) => [row.instance, row]));
  const openSlots = new Map<string, Set<WorkspaceSlot>>();
  for (const rule of composition.open) {
    const slots = openSlots.get(rule.module) ?? new Set<WorkspaceSlot>();
    slots.add(rule.slot);
    openSlots.set(rule.module, slots);
  }
  plan.templates.forEach((row, index) => {
    const at = `bindings.templates[${index}]`;
    const instance = instances.get(row.instance);
    if (!instance) {
      bag.add("unknown_module", `${row.instance} is not an instance in this composition`, at);
      return;
    }
    if (!isDocumentSlot(instance.slot)) {
      bag.add("slot", `${row.instance} sits in ${instance.slot}, which holds widgets rather than documents`, at);
      return;
    }
    const slots = openSlots.get(instance.module);
    if (!slots) {
      bag.add(
        "unconnected",
        `${instance.module} is not an open target, so nothing would ever derive from ${row.instance}`,
        at,
      );
      return;
    }
    if (!slots.has(instance.slot)) {
      bag.add(
        "slot",
        `${row.instance} sits in ${instance.slot}, but ${instance.module} is only opened into ${[...slots].sort().join(", ")}`,
        at,
      );
    }
  });
}

/**
 * One owner per route, where a route is `(module, open slot, port)`.
 *
 * That triple is everything a later resolver holds when a resource is opened, so
 * it is exactly the granularity at which "which panel family does this belong
 * to" must have one answer. Two templates on one route, or a template beside a
 * connected direct surface on one route, would leave the choice to array order
 * or to an implicit precedence — and whichever it picked would decide which
 * instance's `config` and connections the new panel inherited.
 *
 * Refused here rather than deferred to the layout, because a release is where
 * the ambiguity is authored and prepare-time is where it can still be a refusal
 * instead of a surprise.
 */
function linkTemplateRoutes(
  bag: IssueBag,
  plan: AgentResourceBindingsV2,
  composition: AgentComposition,
): void {
  const instances = new Map(composition.instances.map((row) => [row.instance, row]));
  const templated = new Set(plan.templates.map((row) => row.instance));
  const routes = new Map<string, { templates: string[]; direct: string[] }>();
  for (const rule of composition.open) {
    for (const connection of plan.connections) {
      const instance = instances.get(connection.instance);
      if (!instance || instance.module !== rule.module || instance.slot !== rule.slot) continue;
      const key = `${rule.module}\0${rule.slot}\0${connection.port}`;
      const route = routes.get(key) ?? { templates: [], direct: [] };
      const claimants = templated.has(connection.instance) ? route.templates : route.direct;
      if (!claimants.includes(connection.instance)) claimants.push(connection.instance);
      routes.set(key, route);
    }
  }
  for (const [key, route] of routes) {
    if (!route.templates.length) continue;
    const [moduleId, slot, port] = key.split("\0");
    if (route.templates.length > 1) {
      bag.add(
        "duplicate",
        `${moduleId} opens ${port} in ${slot} through ${route.templates.length} templates (${route.templates.join(", ")})`,
        "bindings.templates",
      );
      continue;
    }
    if (route.direct.length) {
      bag.add(
        "duplicate",
        `${moduleId} opens ${port} in ${slot} through template ${route.templates[0]} and also through ${route.direct.join(", ")}`,
        "bindings.templates",
      );
    }
  }
}
