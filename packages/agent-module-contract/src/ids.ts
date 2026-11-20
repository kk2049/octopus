/**
 * The identifier grammars, in one place.
 *
 * Each one is narrow because each one is used as a KEY: a module id keys a
 * static registry, an instance id keys a React subtree (and therefore a
 * reader's unsaved draft), a contract id keys a port. None of them is ever
 * joined onto a path, opened as a URL, or resolved as a package name — that is
 * the property the whole module system rests on, and a permissive grammar is how
 * it would quietly stop being true.
 */

/** `namespace.name/vN` — e.g. `session.roster-tree/v1`. */
const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*\/v[1-9][0-9]*$/;

/** Exact `MAJOR.MINOR.PATCH`. A range would make a lock file not a lock. */
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * The implementation identity a registry entry is looked up by.
 *
 * Deliberately opaque: it names the compiled thing inside this bundle, and the
 * only operation performed on it is equality. It is NOT a specifier — nothing
 * imports it, resolves it or fetches it.
 */
const IMPLEMENTATION = /^[A-Za-z0-9@][A-Za-z0-9@/._:#-]{0,119}$/;

/** `panel-ish` — a stable key for one mounted module instance. */
const INSTANCE_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** A resource kind, e.g. `session`. Not a media type and not a path. */
const RESOURCE_KIND = /^[a-z][a-z0-9-]{0,39}$/;

/** `agent-sessions/v1` — a port contract this module needs bound. */
const CONTRACT_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*\/v[1-9][0-9]*$/;

/**
 * An opaque resource reference minted by the trusted side.
 *
 * Bounded and printable, and that is all this layer may assume: its meaning
 * belongs to whoever issued it. A View that could construct one that resolves to
 * something else is the failure this shape exists to keep impossible, so nothing
 * here parses it.
 */
const RESOURCE_REF = /^[ -~]{1,200}$/;

export const ID_PATTERNS = Object.freeze({
  moduleId: MODULE_ID,
  version: VERSION,
  implementation: IMPLEMENTATION,
  instanceId: INSTANCE_ID,
  resourceKind: RESOURCE_KIND,
  contractId: CONTRACT_ID,
  resourceRef: RESOURCE_REF,
});

export function isModuleId(value: string): boolean {
  return MODULE_ID.test(value);
}

export function isVersion(value: string): boolean {
  return VERSION.test(value);
}

export function isImplementation(value: string): boolean {
  return IMPLEMENTATION.test(value);
}

export function isInstanceId(value: string): boolean {
  return INSTANCE_ID.test(value);
}

export function isResourceKind(value: string): boolean {
  return RESOURCE_KIND.test(value);
}

export function isContractId(value: string): boolean {
  return CONTRACT_ID.test(value);
}

export function isResourceRef(value: string): boolean {
  return RESOURCE_REF.test(value);
}
