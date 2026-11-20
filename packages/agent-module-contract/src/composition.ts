/**
 * `agent-composition/v1` — the static assembly plan.
 *
 * It says two things and nothing else: which module instances exist at startup
 * and in which slot, and which module may be opened for which resource kind.
 * There are no conditions, no expressions and no computed values — a composition
 * is data a reviewer reads top to bottom, not a program.
 *
 * ── The rules that make it a plan rather than a request ─────────────────────
 *
 *  · **Every `module` must be in the lock.** A composition cannot name a module
 *    into existence; it can only wire up implementations the build already
 *    compiled in.
 *  · **Every `instance` is unique.** An instance id keys a React subtree, which
 *    means it keys a reader's unsaved draft and scroll position. Two panels
 *    sharing one would silently swap someone's half-typed message.
 *  · **A slot must be one the module accepts** — checked when a registry is
 *    available, since only the registry holds manifests. Without one, the shape
 *    is still validated; the placement check simply has not been performed yet,
 *    and `linkComposition` is the function that says so.
 */

import { checkInstanceConfig, readInstanceConfig, sortedConfig, type InstanceConfig } from "./config.js";
import { isInstanceId, isModuleId, isResourceKind } from "./ids.js";
import { lockHas, parseModuleLock, type AgentModuleLock } from "./lock.js";
import { moduleAcceptsSlot, moduleOpensKind, type AgentModuleManifest } from "./manifest.js";
import { isWorkspaceSlot, type WorkspaceSlot } from "./slots.js";
import {
  CONTRACT_LIMITS,
  IssueBag,
  arrayAt,
  encodeCanonical,
  objectAt,
  parseJsonDocument,
  refuseUnknownFields,
  stringAt,
  type ContractResult,
} from "./validate.js";

export const COMPOSITION_SCHEMA = "agent-composition/v1";

/**
 * How an open intent relates to panels already on screen.
 *
 * `reuse`  — focus the panel already showing this exact resource, otherwise
 *            bind an unbound declared surface, otherwise mint. The stacking
 *            shape: chat keeps one panel per session so drafts survive.
 * `new`    — always mint a second panel (refused for connected surfaces,
 *            which v1's binding document cannot express twice).
 * `rebind` — a declared surface of the target module is THE panel for this
 *            kind, bound or not: reopening a different ref replaces its
 *            content in place, keeping the instance's `config`. The
 *            single-surface shape configured modules need (2026-08-07, found
 *            by the deck pressure test: without it, every open after the
 *            first minted a config-less twin). Old builds refuse documents
 *            carrying it — fail closed, the right direction.
 */
export const OPEN_MODES = ["reuse", "new", "rebind"] as const;
export type OpenMode = (typeof OPEN_MODES)[number];

export function isOpenMode(value: unknown): value is OpenMode {
  return typeof value === "string" && (OPEN_MODES as readonly string[]).includes(value);
}

/** One module instance the workspace starts with. */
export interface CompositionInstance {
  instance: string;
  module: string;
  slot: WorkspaceSlot;
  /** Overrides the module manifest's own title for this instance. */
  title?: string;
  /**
   * Values for the module's declared `config` fields (decision 7): what turns
   * one generic module into two differently-purposed instances. Shape-checked
   * here; checked AGAINST the declaration wherever a registry is supplied
   * (the browser and the pack path).
   */
  config?: InstanceConfig;
}

/** Which module may display which resource kind, and where. */
export interface CompositionOpenRule {
  resource: string;
  module: string;
  slot: WorkspaceSlot;
  /** The composition's default for this kind; an intent may still say `new`. */
  mode?: OpenMode;
}

export interface AgentComposition {
  schema: typeof COMPOSITION_SCHEMA;
  /** The stable app id this plan belongs to. Compared, never resolved. */
  app: string;
  instances: readonly CompositionInstance[];
  open: readonly CompositionOpenRule[];
}

const COMPOSITION_FIELDS = ["schema", "app", "instances", "open"] as const;
const INSTANCE_FIELDS = ["instance", "module", "slot", "title", "config"] as const;
const RULE_FIELDS = ["resource", "module", "slot", "mode"] as const;

export function readComposition(value: unknown): ContractResult<AgentComposition> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, "composition");
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, COMPOSITION_FIELDS, "composition");
  if (row.schema !== COMPOSITION_SCHEMA) {
    bag.add("schema", `composition.schema must be ${COMPOSITION_SCHEMA}`, "composition.schema");
  }
  const app = stringAt(bag, row, "app", "composition");
  if (app !== null && !app.trim()) bag.add("empty", "app must not be blank", "composition.app");

  const rawInstances = arrayAt(bag, row, "instances", "composition", CONTRACT_LIMITS.maxInstances);
  const rawOpen = arrayAt(bag, row, "open", "composition", CONTRACT_LIMITS.maxOpenRules);
  if (!rawInstances || !rawOpen) return bag.fail();
  if (!rawInstances.length) bag.add("empty", "a composition must declare at least one instance", "composition.instances");

  const instances: CompositionInstance[] = [];
  const seenInstances = new Set<string>();
  rawInstances.forEach((entry, index) => {
    const at = `composition.instances[${index}]`;
    const item = objectAt(bag, entry, at);
    if (!item) return;
    refuseUnknownFields(bag, item, INSTANCE_FIELDS, at);
    const instance = stringAt(bag, item, "instance", at);
    if (instance !== null && !isInstanceId(instance)) {
      bag.add("identifier", "instance must be a short lower-case key", `${at}.instance`);
    }
    const module = stringAt(bag, item, "module", at);
    if (module !== null && !isModuleId(module)) {
      bag.add("identifier", "module must look like `namespace.name/vN`", `${at}.module`);
    }
    const slot = item.slot;
    if (!isWorkspaceSlot(slot)) bag.add("slot", "slot must be one of the five workspace slots", `${at}.slot`);
    const title = stringAt(bag, item, "title", at, { optional: true });
    const config = readInstanceConfig(bag, item, "config", at);
    if (instance === null || module === null || !isWorkspaceSlot(slot)) return;
    if (seenInstances.has(instance)) {
      bag.add("duplicate", `instance ${instance} is declared twice`, at);
      return;
    }
    seenInstances.add(instance);
    const row2: CompositionInstance = { instance, module, slot };
    if (title !== null) row2.title = title;
    if (config !== undefined) row2.config = config;
    instances.push(row2);
  });

  const open: CompositionOpenRule[] = [];
  const seenRules = new Set<string>();
  rawOpen.forEach((entry, index) => {
    const at = `composition.open[${index}]`;
    const item = objectAt(bag, entry, at);
    if (!item) return;
    refuseUnknownFields(bag, item, RULE_FIELDS, at);
    const resource = stringAt(bag, item, "resource", at);
    if (resource !== null && !isResourceKind(resource)) {
      bag.add("identifier", "resource must be a resource kind like `session`", `${at}.resource`);
    }
    const module = stringAt(bag, item, "module", at);
    if (module !== null && !isModuleId(module)) {
      bag.add("identifier", "module must look like `namespace.name/vN`", `${at}.module`);
    }
    const slot = item.slot;
    if (!isWorkspaceSlot(slot)) bag.add("slot", "slot must be one of the five workspace slots", `${at}.slot`);
    let mode: OpenMode | undefined;
    if (item.mode !== undefined) {
      if (!isOpenMode(item.mode)) {
        bag.add("open_mode", `mode must be one of ${OPEN_MODES.join(", ")}`, `${at}.mode`);
      } else {
        mode = item.mode;
      }
    }
    if (resource === null || module === null || !isWorkspaceSlot(slot)) return;
    // A kind may have several viewers, but not two rules for the same PAIR:
    // that is two different answers to "where does this open", and picking one
    // would be arbitrary.
    const key = `${resource}\0${module}`;
    if (seenRules.has(key)) {
      bag.add("duplicate", `resource ${resource} is routed to ${module} twice`, at);
      return;
    }
    seenRules.add(key);
    open.push(mode === undefined ? { resource, module, slot } : { resource, module, slot, mode });
  });

  if (!bag.empty) return bag.fail();
  return { ok: true, value: { schema: COMPOSITION_SCHEMA, app: app!, instances, open } };
}

export function parseComposition(text: string): ContractResult<AgentComposition> {
  return parseJsonDocument(text, "composition", readComposition);
}

export function encodeComposition(composition: AgentComposition): string {
  return encodeCanonical({
    schema: COMPOSITION_SCHEMA,
    app: composition.app,
    instances: composition.instances.map((row) => {
      const out: Record<string, unknown> = { instance: row.instance, module: row.module, slot: row.slot };
      if (row.title !== undefined) out.title = row.title;
      if (row.config !== undefined) out.config = sortedConfig(row.config);
      return out;
    }),
    open: composition.open.map((row) =>
      row.mode === undefined
        ? { resource: row.resource, module: row.module, slot: row.slot }
        : { resource: row.resource, module: row.module, slot: row.slot, mode: row.mode },
    ),
  });
}

export interface LinkedComposition {
  lock: AgentModuleLock;
  composition: AgentComposition;
}

/**
 * The cross-document check: a composition read on its own is only well-formed;
 * a composition read against its lock is *assembleable*.
 *
 * `manifests` is optional because the two documents travel together while the
 * registry does not — a caller may hold the JSON and no components. When it IS
 * supplied, the placement and routing declarations in each manifest are
 * enforced too, which is the check that makes a manifest's `slots`/`opens`
 * fields mean something.
 *
 * And when it is supplied, a module MISSING from it is a refusal rather than a
 * skipped check — the same rule `linkResourceBindings` follows, and for the same
 * reason. Supplying a registry is a caller saying "these are the modules that
 * exist"; quietly passing a composition that names one which does not is the
 * worst of the three possible outcomes, because it reads as a pass. That is
 * exactly how a release could have declared a slot or an open policy no manifest
 * allows and still activated.
 */
export function linkComposition(
  composition: AgentComposition,
  lock: AgentModuleLock,
  manifests?: ReadonlyMap<string, AgentModuleManifest>,
): ContractResult<LinkedComposition> {
  const bag = new IssueBag();
  if (manifests) {
    // A supplied registry is the implementation inventory for this build, so
    // the lock must be its exact identity — not merely a set of matching ids.
    // This prevents reinterpretation when version/implementation changed and
    // prevents a lock claiming code the bundle did not compile. v1 does NOT
    // hash the manifest's slots/ports/opens: changing their semantics therefore
    // requires bumping version or implementation, and a multi-version manifest
    // catalog remains future work rather than a guarantee made here.
    lock.modules.forEach((entry, index) => {
      const manifest = manifests.get(entry.id);
      const at = `lock.modules[${index}]`;
      if (!manifest) {
        bag.add("unknown_module", `${entry.id} has no manifest in the supplied registry`, at);
        return;
      }
      if (entry.version !== manifest.version || entry.implementation !== manifest.implementation) {
        bag.add(
          "module_identity",
          `${entry.id} does not match the supplied manifest's version and implementation`,
          at,
        );
      }
    });
    for (const [moduleId] of manifests) {
      if (!lockHas(lock, moduleId)) {
        bag.add("unknown_module", `${moduleId} is in the supplied registry but absent from the module lock`, "lock.modules");
      }
    }
  }
  composition.instances.forEach((row, index) => {
    const at = `composition.instances[${index}]`;
    if (!lockHas(lock, row.module)) {
      bag.add("unknown_module", `${row.module} is not in the module lock`, at);
      return;
    }
    if (!manifests) return;
    const manifest = manifests.get(row.module);
    if (!manifest) {
      bag.add("unknown_module", `${row.module} has no manifest in the supplied registry`, at);
      return;
    }
    if (!moduleAcceptsSlot(manifest, row.slot)) {
      bag.add("slot", `${row.module} does not accept the ${row.slot} slot`, `${at}.slot`);
    }
    // Values against the module's own declaration — unknown keys, wrong types
    // and missing required fields are all refusals here, where the manifests
    // are the bundle's own (the browser and the pack path).
    checkInstanceConfig(bag, row.config, manifest.config, at);
  });
  composition.open.forEach((row, index) => {
    const at = `composition.open[${index}]`;
    if (!lockHas(lock, row.module)) {
      bag.add("unknown_module", `${row.module} is not in the module lock`, at);
      return;
    }
    if (!manifests) return;
    const manifest = manifests.get(row.module);
    if (!manifest) {
      bag.add("unknown_module", `${row.module} has no manifest in the supplied registry`, at);
      return;
    }
    if (!moduleAcceptsSlot(manifest, row.slot)) {
      bag.add("slot", `${row.module} does not accept the ${row.slot} slot`, `${at}.slot`);
    }
    if (!moduleOpensKind(manifest, row.resource)) {
      bag.add("identifier", `${row.module} does not declare that it opens ${row.resource}`, `${at}.resource`);
    }
  });
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { lock, composition } };
}

/**
 * Read both release assets together.
 *
 * One entry point rather than two, because "only one of them is present" is a
 * refusal and not a partial success — the pair is the plan.
 */
export function readModuleBundle(input: { lockText: string; compositionText: string }): ContractResult<LinkedComposition> {
  const lock = parseModuleLock(input.lockText);
  if (!lock.ok) return lock;
  const composition = parseComposition(input.compositionText);
  if (!composition.ok) return composition;
  return linkComposition(composition.value, lock.value);
}
