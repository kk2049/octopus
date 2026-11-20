/**
 * `agent-module-lock/v1` — what is actually inside this bundle.
 *
 * ── Why a release asset and not a runtime request ───────────────────────────
 *
 * An Agent View is published as one document from an origin that serves no
 * second URL. So "load a module" can only ever mean "mount something the build
 * already compiled in" — there is no fetch, no dynamic import and no package
 * name to resolve. The lock is the written form of that fact: it enumerates the
 * modules the bundle contains, it travels as a named release asset covered by
 * the package digest, and a composition may only reference ids that appear in
 * it.
 *
 * Read the other way round, that is the security content: a composition cannot
 * name a module into existence, and a module cannot appear without changing the
 * release identity — because changing this file changes the asset bytes, which
 * changes `packageDigest`, which changes the hostname the frame is served from.
 *
 * ── What it deliberately is not ─────────────────────────────────────────────
 *
 * Not a dependency solver, not a range resolver, not a catalog. Versions are
 * exact and entries are already resolved; nothing here computes what to install,
 * because installation is a compile that already happened.
 */

import { isImplementation, isModuleId, isVersion } from "./ids.js";
import { normalizeModuleManifest, type AgentModuleManifest } from "./manifest.js";
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

export const MODULE_LOCK_SCHEMA = "agent-module-lock/v1";

export interface ModuleLockEntry {
  id: string;
  version: string;
  implementation: string;
}

export interface AgentModuleLock {
  schema: typeof MODULE_LOCK_SCHEMA;
  /** Sorted by id, ids unique. */
  modules: readonly ModuleLockEntry[];
}

const LOCK_FIELDS = ["schema", "modules"] as const;
const ENTRY_FIELDS = ["id", "version", "implementation"] as const;

/**
 * The lock this set of manifests describes.
 *
 * Derived rather than authored: a hand-written lock would be a second statement
 * of the same fact, and the interesting failure is exactly the one where the two
 * disagree.
 */
export function moduleLockOf(manifests: readonly AgentModuleManifest[]): AgentModuleLock {
  const rows = manifests.map(normalizeModuleManifest).map((manifest) => ({
    id: manifest.id,
    version: manifest.version,
    implementation: manifest.implementation,
  }));
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].id === rows[i - 1].id) throw new Error(`module lock would list ${rows[i].id} twice`);
  }
  return { schema: MODULE_LOCK_SCHEMA, modules: rows };
}

export function readModuleLock(value: unknown): ContractResult<AgentModuleLock> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, "lock");
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, LOCK_FIELDS, "lock");
  if (row.schema !== MODULE_LOCK_SCHEMA) {
    bag.add("schema", `lock.schema must be ${MODULE_LOCK_SCHEMA}`, "lock.schema");
  }
  const raw = arrayAt(bag, row, "modules", "lock", CONTRACT_LIMITS.maxModules);
  if (!raw) return bag.fail();
  if (!raw.length) bag.add("empty", "a module lock must list at least one module", "lock.modules");

  const modules: ModuleLockEntry[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const at = `lock.modules[${index}]`;
    const item = objectAt(bag, entry, at);
    if (!item) return;
    refuseUnknownFields(bag, item, ENTRY_FIELDS, at);
    const id = stringAt(bag, item, "id", at);
    if (id !== null && !isModuleId(id)) bag.add("identifier", "id must look like `namespace.name/vN`", `${at}.id`);
    const version = stringAt(bag, item, "version", at);
    if (version !== null && !isVersion(version)) {
      bag.add("version", "version must be an exact MAJOR.MINOR.PATCH", `${at}.version`);
    }
    const implementation = stringAt(bag, item, "implementation", at);
    if (implementation !== null && !isImplementation(implementation)) {
      bag.add("identifier", "implementation has characters this build does not accept", `${at}.implementation`);
    }
    if (id === null || version === null || implementation === null) return;
    if (seen.has(id)) {
      bag.add("duplicate", `module ${id} is locked twice`, at);
      return;
    }
    seen.add(id);
    modules.push({ id, version, implementation });
  });

  // Order is part of the canonical form, so a lock that is merely UNSORTED is
  // accepted and normalised — the refusals above are about content, and sorting
  // is not content.
  modules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { schema: MODULE_LOCK_SCHEMA, modules } };
}

export function parseModuleLock(text: string): ContractResult<AgentModuleLock> {
  return parseJsonDocument(text, "lock", readModuleLock);
}

export function encodeModuleLock(lock: AgentModuleLock): string {
  return encodeCanonical({
    schema: MODULE_LOCK_SCHEMA,
    modules: [...lock.modules]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((entry) => ({ id: entry.id, version: entry.version, implementation: entry.implementation })),
  });
}

export function lockHas(lock: AgentModuleLock, moduleId: string): boolean {
  return lock.modules.some((entry) => entry.id === moduleId);
}
