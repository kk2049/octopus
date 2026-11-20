import { createHash } from "node:crypto";
import type { JsonValue } from "./types.js";

/** Stable JSON with a deliberately closed value domain. */
export function canonicalJson(value: JsonValue): string {
  return encode(value);
}

function encode(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("state JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(value[key]!)}`).join(",")}}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Plain JSON data nested at most 32 levels (`encode` recurses). No element
 * count bound: an event is bounded by its 64 KiB encoding and a snapshot by
 * the projection that produced it; a count would only be a second, arbitrary
 * cliff on a list that is otherwise valid.
 */
export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.entries(value as Record<string, unknown>)
    .every(([key, entry]) => key !== "__proto__" && isJsonValue(entry, depth + 1));
}
