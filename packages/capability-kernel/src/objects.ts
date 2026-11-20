/**
 * The Object registry: what a resource is, what may be asked of it, and the one
 * function allowed to touch it.
 *
 * Split out of the kernel because none of it is an authorization decision. A
 * bug in argument validation is a malformed call reaching an adapter that
 * already refuses malformed calls; a bug in `core.ts` is the wrong person
 * reaching the resource. Keeping them in one file made both look equally
 * dangerous, which is another way of saying neither looked dangerous.
 */

import type { CapabilityStore, ObjectIdentityRow } from "./store.js";
import {
  IndeterminateOutcome,
  type ArgSpec,
  type Effect,
  type ObjectDefinition,
  type ObjectId,
  type ObjectPolicy,
  type ObjectView,
  type Operation,
  type OperationSpec,
} from "./types.js";

/**
 * Retry-safety when the registry does not say. Reading does not change the
 * resource, so doing it twice is doing it once; modifying and executing are
 * assumed not to be, because that is the assumption whose mistakes are cheap.
 */
export function defaultRetrySafe(effect: Effect): boolean {
  return effect === "observe" || effect === "read";
}

/** Cap on a single request body reaching an Object adapter, in UTF-8 BYTES. */
const MAX_ARG_BYTES = 512 * 1024;
/** Cap on what an adapter may hand back. An unbounded result is a memory bug. */
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export class ObjectRegistry {
  private objects = new Map<ObjectId, ObjectDefinition<unknown>>();

  constructor(private store: CapabilityStore) {}

  /**
   * Register a fixed Object. Trusted control plane only, and ONCE per id.
   *
   * Two things this deliberately does not allow. An id may not be re-registered
   * with a different identity — "replace the Object behind a live capability"
   * is indistinguishable from "retarget everyone who holds it". And the
   * definition is deep-frozen, so the caller's object literal stops being
   * authority the moment it is handed over; otherwise whoever registered an
   * Object could later edit its policy, its operation table or its binding
   * through the reference they kept.
   */
  register<B>(def: ObjectDefinition<B>): ObjectId {
    if (!def.id) throw new Error("object id is required");
    if (this.objects.has(def.id)) throw new Error(`object ${def.id} is already registered`);
    const operations: Record<Operation, OperationSpec> = {};
    for (const [name, spec] of Object.entries(def.operations)) {
      if (!name || /[^a-z0-9_]/i.test(name)) throw new Error(`invalid operation name "${name}"`);
      if (!spec.args || typeof spec.args !== "object") throw new Error(`operation "${name}" needs an args schema`);
      if (!spec.effect) throw new Error(`operation "${name}" must declare an effect`);
      const args: Record<string, ArgSpec> = {};
      for (const [k, v] of Object.entries(spec.args)) args[k] = Object.freeze({ ...v }) as ArgSpec;
      // Resolve the retry-safety default HERE, so `specOf(...).retrySafe` is
      // total and nobody downstream re-derives it from the effect class at the
      // moment it matters — which is a restart, where getting it wrong means
      // either re-running an `exec` or throwing away a harmless read.
      operations[name] = Object.freeze({
        ...spec,
        retrySafe: spec.retrySafe ?? defaultRetrySafe(spec.effect),
        args: Object.freeze(args),
      }) as OperationSpec;
    }
    const frozen = Object.freeze({
      id: def.id,
      kind: def.kind,
      binding: def.binding,
      metadata: Object.freeze({ ...(def.metadata ?? {}) }),
      operations: Object.freeze(operations),
      policy: def.policy,
      adapter: def.adapter as ObjectDefinition<unknown>["adapter"],
    }) as ObjectDefinition<unknown>;

    // A restart re-registers Objects from code. The identity that persisted
    // must match, or live capabilities would silently point at something else
    // wearing the same id.
    const identity: ObjectIdentityRow = {
      id: def.id,
      kind: def.kind,
      metadata: { ...(def.metadata ?? {}) },
      operations: Object.keys(operations).sort(),
    };
    this.store.putObject(identity); // throws when the persisted identity differs
    this.objects.set(def.id, frozen);
    return def.id;
  }

  has(id: ObjectId): boolean {
    return this.objects.has(id);
  }

  /**
   * Replace an already-registered Object's fixed binding (e.g. a device set
   * changed). Keeps the same ObjectId so live capabilities stay valid, which
   * is correct because the binding is derived from the same trusted registry
   * the root was minted from. Kind, operations, policy and adapter are the
   * Object's identity and do not move.
   */
  rebind<B>(id: ObjectId, binding: B): void {
    const obj = this.objects.get(id);
    if (!obj) throw new Error(`unknown object ${id}`);
    this.objects.set(id, Object.freeze({ ...obj, binding }) as ObjectDefinition<unknown>);
  }

  operationsOf(id: ObjectId): ReadonlySet<Operation> {
    const obj = this.objects.get(id);
    return new Set(obj ? Object.keys(obj.operations) : []);
  }

  specOf(id: ObjectId, operation: Operation): OperationSpec | null {
    const obj = this.objects.get(id);
    if (!obj) return null;
    return Object.prototype.hasOwnProperty.call(obj.operations, operation) ? obj.operations[operation] : null;
  }

  policyOf(id: ObjectId): ObjectPolicy | null {
    return this.objects.get(id)?.policy ?? null;
  }

  viewOf(id: ObjectId): ObjectView | null {
    const obj = this.objects.get(id);
    return obj ? { id: obj.id, kind: obj.kind, metadata: obj.metadata ?? {} } : null;
  }

  /**
   * The only path to the real resource. The binding comes from the Object, so
   * no argument can re-address it.
   */
  async dispatch(id: ObjectId, operation: Operation, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    const obj = this.objects.get(id);
    if (!obj) throw new Error(`unknown object ${id}`);
    const result = await obj.adapter(obj.binding, operation, args);
    // Bound what comes back too: an adapter is trusted to be correct, not to be
    // small, and a resource that returns a gigabyte takes the process down.
    if (result !== undefined && utf8Bytes(JSON.stringify(result) ?? "") > MAX_RESULT_BYTES) {
      throw new Error("adapter result too large");
    }
    return result;
  }
}

export function argsTooLarge(value: Record<string, unknown>): boolean {
  return utf8Bytes(JSON.stringify(value)) > MAX_ARG_BYTES;
}

/**
 * Validate raw arguments against the closed schema: unknown key, wrong type,
 * missing required or out-of-range is a refusal, and the result is a fresh
 * object holding only declared keys.
 */
export function validateArgs(
  spec: OperationSpec,
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "args must be an object" };
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    // hasOwnProperty, not `in`: `in` walks the prototype chain, so "toString"
    // and "constructor" would look like declared arguments on any schema.
    if (!Object.prototype.hasOwnProperty.call(spec.args, key)) {
      return { ok: false, message: `unknown argument "${key}"` };
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, argSpec] of Object.entries(spec.args)) {
    const v = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
    if (v === undefined || v === null) {
      if (argSpec.required) return { ok: false, message: `missing required argument "${key}"` };
      continue;
    }
    const checked = checkArg(key, argSpec, v);
    if (!checked.ok) return checked;
    out[key] = checked.value;
  }
  return { ok: true, value: out };
}

function checkArg(
  key: string,
  spec: ArgSpec,
  v: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  switch (spec.type) {
    case "string": {
      if (typeof v !== "string") return { ok: false, message: `argument "${key}" must be a string` };
      // Bytes, not UTF-16 units: "章鱼章鱼" is 4 units and 12 bytes, and every
      // downstream limit (a path, a command line, a request body) is bytes.
      if (spec.maxLength !== undefined && utf8Bytes(v) > spec.maxLength) {
        return { ok: false, message: `argument "${key}" exceeds ${spec.maxLength} bytes` };
      }
      if (spec.enum && !spec.enum.includes(v)) {
        return { ok: false, message: `argument "${key}" must be one of: ${spec.enum.join(", ")}` };
      }
      return { ok: true, value: v };
    }
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { ok: false, message: `argument "${key}" must be a finite number` };
      }
      if (spec.integer && !Number.isInteger(v)) return { ok: false, message: `argument "${key}" must be an integer` };
      if (spec.min !== undefined && v < spec.min) return { ok: false, message: `argument "${key}" < ${spec.min}` };
      if (spec.max !== undefined && v > spec.max) return { ok: false, message: `argument "${key}" > ${spec.max}` };
      return { ok: true, value: v };
    }
    case "boolean": {
      if (typeof v !== "boolean") return { ok: false, message: `argument "${key}" must be a boolean` };
      return { ok: true, value: v };
    }
  }
}

export { IndeterminateOutcome };
