/**
 * Canonical argument encoding + hashing.
 *
 * A PendingCall must bind the EXACT arguments that were checked, so the hash
 * has to be injective enough that two different argument sets cannot collide
 * through the encoder. Two concrete hazards handled here:
 *
 *  - `__proto__` as a key: assigning it on a plain object mutates the
 *    prototype instead of creating an own property, so the key silently
 *    vanishes from JSON.stringify. We reject it outright.
 *  - key order: object key order is insertion order in JS, so `{a,b}` and
 *    `{b,a}` would hash differently. We sort.
 */

import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalize);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(src).sort()) {
    if (key === "__proto__") throw new Error('argument key "__proto__" is not allowed');
    Object.defineProperty(out, key, { value: normalize(src[key]), enumerable: true });
  }
  // Object.create(null) has no prototype; JSON.stringify handles it fine and
  // the sorted own enumerable properties are what gets serialized.
  return out;
}

export function hashArgs(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}
