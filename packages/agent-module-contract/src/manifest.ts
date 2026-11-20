/**
 * What a module declares about itself.
 *
 * A manifest is a build-time object, not a release asset: it is written next to
 * the component it describes and compiled into the bundle. The release asset is
 * the LOCK, which carries only the three fields that identify an implementation
 * (`id`, `version`, `implementation`) — and it is produced FROM these manifests
 * rather than typed a second time, so "the lock says what is actually in the
 * bundle" is a construction rather than a review item. In v1 the lock does not
 * carry a digest of `slots`/`ports`/`opens`; changing any of those is a semantic
 * implementation change and MUST bump `version` or `implementation`.
 *
 * The other fields are the module's own boundary statement:
 *
 *  · `slots` — where a composition may place it. A roster belongs in navigation;
 *    saying so here means a composition that puts it in `overlay` is refused at
 *    validation rather than discovered as an unusable layout.
 *  · `ports` — which typed contracts it needs bound. This is what makes "no
 *    module reaches for a host object" checkable: a module that needs data names
 *    a contract, and the App decides what satisfies it.
 *  · `opens` — the resource kinds it can display, which is what an open rule is
 *    allowed to route to it.
 */

import { readConfigDeclaration, sortedDeclaration, type ModuleConfigDeclaration } from "./config.js";
import { isContractId, isImplementation, isModuleId, isResourceKind, isVersion } from "./ids.js";
import { isWorkspaceSlot, sortSlots, type WorkspaceSlot } from "./slots.js";
import {
  CONTRACT_LIMITS,
  IssueBag,
  arrayAt,
  objectAt,
  refuseUnknownFields,
  stringAt,
  type ContractResult,
} from "./validate.js";

export interface AgentModuleManifest {
  /** Stable module id, e.g. `session.roster-tree/v1`. */
  id: string;
  /** Exact version of this implementation. */
  version: string;
  /** Opaque identity of the compiled thing. Compared, never resolved. */
  implementation: string;
  /** Human label for a panel header. Presentation only. */
  title: string;
  /** Slots a composition may place this module in. */
  slots: readonly WorkspaceSlot[];
  /** Typed port contracts this module needs bound. */
  ports: readonly string[];
  /** Resource kinds an open rule may route to this module. */
  opens: readonly string[];
  /**
   * What per-instance configuration this module accepts (decision 7). Flat and
   * typed so a composition carrying values can be checked at link time where a
   * registry is present; absent means "this module takes none", and a
   * composition that supplies some anyway is refused there.
   */
  config?: ModuleConfigDeclaration;
}

const MANIFEST_FIELDS = ["id", "version", "implementation", "title", "slots", "ports", "opens", "config"] as const;

/**
 * Read and normalise one manifest.
 *
 * Normalising means: arrays sorted and de-duplicated, fields emitted in one
 * fixed order. Two manifests that say the same thing therefore encode to the
 * same bytes, which is what lets a lock file be compared rather than diffed.
 */
export function readModuleManifest(value: unknown, at = "module"): ContractResult<AgentModuleManifest> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, MANIFEST_FIELDS, at);

  const id = stringAt(bag, row, "id", at);
  if (id !== null && !isModuleId(id)) bag.add("identifier", "id must look like `namespace.name/vN`", `${at}.id`);
  const version = stringAt(bag, row, "version", at);
  if (version !== null && !isVersion(version)) {
    bag.add("version", "version must be an exact MAJOR.MINOR.PATCH", `${at}.version`);
  }
  const implementation = stringAt(bag, row, "implementation", at);
  if (implementation !== null && !isImplementation(implementation)) {
    bag.add("identifier", "implementation has characters this build does not accept", `${at}.implementation`);
  }
  const title = stringAt(bag, row, "title", at);
  if (title !== null && !title.trim()) bag.add("empty", "title must not be blank", `${at}.title`);

  const slots = readSlots(bag, row, at);
  const ports = readNameList(bag, row, "ports", at, isContractId, "a contract id like `agent-sessions/v1`");
  const opens = readNameList(bag, row, "opens", at, isResourceKind, "a resource kind like `session`");
  const config = readConfigDeclaration(bag, row, "config", at);

  if (!bag.empty) return bag.fail();
  const manifest: AgentModuleManifest = {
    id: id!,
    version: version!,
    implementation: implementation!,
    title: title!,
    slots: slots!,
    ports: ports!,
    opens: opens!,
  };
  if (config !== undefined) manifest.config = config;
  return { ok: true, value: manifest };
}

function readSlots(bag: IssueBag, row: Record<string, unknown>, at: string): WorkspaceSlot[] | null {
  const raw = arrayAt(bag, row, "slots", at, 8);
  if (!raw) return null;
  const seen = new Set<WorkspaceSlot>();
  for (const entry of raw) {
    if (!isWorkspaceSlot(entry)) {
      bag.add("slot", "slots may only name the five workspace slots", `${at}.slots`);
      continue;
    }
    if (seen.has(entry)) bag.add("duplicate", `slot ${entry} is listed twice`, `${at}.slots`);
    seen.add(entry);
  }
  if (!seen.size) bag.add("empty", "a module must declare at least one slot", `${at}.slots`);
  return sortSlots([...seen]);
}

function readNameList(
  bag: IssueBag,
  row: Record<string, unknown>,
  key: string,
  at: string,
  accept: (value: string) => boolean,
  expectation: string,
): string[] | null {
  const raw = arrayAt(bag, row, key, at, CONTRACT_LIMITS.maxModules);
  if (!raw) return null;
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !accept(entry)) {
      bag.add("identifier", `${key} entries must each be ${expectation}`, `${at}.${key}`);
      continue;
    }
    if (seen.has(entry)) bag.add("duplicate", `${key} lists ${entry} twice`, `${at}.${key}`);
    seen.add(entry);
  }
  return [...seen].sort();
}

/** The canonical field order used everywhere this manifest is written out. */
export function normalizeModuleManifest(manifest: AgentModuleManifest): AgentModuleManifest {
  const normal: AgentModuleManifest = {
    id: manifest.id,
    version: manifest.version,
    implementation: manifest.implementation,
    title: manifest.title,
    slots: sortSlots(manifest.slots),
    ports: [...new Set(manifest.ports)].sort(),
    opens: [...new Set(manifest.opens)].sort(),
  };
  if (manifest.config !== undefined) normal.config = sortedDeclaration(manifest.config);
  return normal;
}

/** Does this module accept being placed in that slot? */
export function moduleAcceptsSlot(manifest: AgentModuleManifest, slot: WorkspaceSlot): boolean {
  return manifest.slots.includes(slot);
}

/** Can an open rule route this resource kind to this module? */
export function moduleOpensKind(manifest: AgentModuleManifest, kind: string): boolean {
  return manifest.opens.includes(kind);
}
