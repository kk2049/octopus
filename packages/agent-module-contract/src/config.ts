/**
 * The two bounded value channels added by convergence-plan decision 7.
 *
 * ── Instance config ─────────────────────────────────────────────────────────
 *
 * A module declares WHAT it accepts (`config` on the manifest: flat, typed,
 * described), a composition supplies VALUES per instance. This is what lets one
 * generic list module become "收件箱" and "归档箱" as two instances of the same
 * implementation instead of two hand-carved modules. The declaration is flat on
 * purpose — nested config is a second schema language, and the manifest is a
 * build-time reviewable object, not a form engine.
 *
 * ── Intent context ──────────────────────────────────────────────────────────
 *
 * A bounded string map an open-resource intent may carry ("open this file AND
 * jump to line 120"). The platform transports it and NEVER interprets it: its
 * semantics belong to the resource kind's vocabulary, exactly like `ref`
 * belongs to whoever minted it. It is deliberately NOT part of panel reuse
 * identity — the same resource opened with a different context focuses the
 * same panel and replaces its context, because "the file at another line" is
 * the same document, not a second one. Before this existed, the only place to
 * smuggle a position was inside `ref`, which made consumers parse a string the
 * contract says is opaque; this channel exists to keep that promise honest.
 *
 * Bounds mirror the wire's proposal-params discipline (small count, short
 * printable values) so a context can always survive the transport that would
 * carry it onward.
 */

import { IssueBag } from "./validate.js";

/** Key grammar shared by config fields and context entries. */
export const CONFIG_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const CONFIG_LIMITS = Object.freeze({
  /** Fields one module may declare; entries one instance/context may carry. */
  maxConfigFields: 16,
  maxContextEntries: 8,
  /** Longest string value in either channel. */
  maxValueLength: 512,
});

export type ConfigValueType = "string" | "number" | "boolean";

const CONFIG_VALUE_TYPES: readonly string[] = ["string", "number", "boolean"];

export interface ModuleConfigField {
  type: ConfigValueType;
  /** Refused at link time when the instance omits it. Default false. */
  required?: boolean;
  /** For the reviewer reading the composition, and any future form. */
  description?: string;
}

export type ModuleConfigDeclaration = Readonly<Record<string, ModuleConfigField>>;

export type InstanceConfig = Readonly<Record<string, string | number | boolean>>;

export type IntentContext = Readonly<Record<string, string>>;

const FIELD_KEYS = ["type", "required", "description"] as const;

/**
 * Read a manifest's `config` declaration. Absent is the norm; an EMPTY object
 * is refused because "declares nothing" already has a spelling (omission), and
 * one meaning per representation is what keeps canonical encoding an equality.
 */
export function readConfigDeclaration(
  bag: IssueBag,
  row: Record<string, unknown>,
  key: string,
  at: string,
): ModuleConfigDeclaration | undefined {
  const raw = row[key];
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    bag.add("field_type", `${key} must be an object of field declarations`, `${at}.${key}`);
    return undefined;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length) {
    bag.add("empty", `${key} declares no fields — omit it instead`, `${at}.${key}`);
    return undefined;
  }
  if (entries.length > CONFIG_LIMITS.maxConfigFields) {
    bag.add("limit", `${key} declares more than ${CONFIG_LIMITS.maxConfigFields} fields`, `${at}.${key}`);
    return undefined;
  }
  const out: Record<string, ModuleConfigField> = {};
  for (const [name, value] of entries) {
    const fieldAt = `${at}.${key}.${name}`;
    if (!CONFIG_KEY_PATTERN.test(name)) {
      bag.add("identifier", "config field names must be short lower-case keys", fieldAt);
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      bag.add("field_type", "a config field must be an object like {type: \"string\"}", fieldAt);
      continue;
    }
    const field = value as Record<string, unknown>;
    for (const k of Object.keys(field)) {
      if (!(FIELD_KEYS as readonly string[]).includes(k)) {
        bag.add("unknown_field", `config field ${name} has unknown key ${k}`, fieldAt);
      }
    }
    if (typeof field.type !== "string" || !CONFIG_VALUE_TYPES.includes(field.type)) {
      bag.add("field_type", "config field type must be string, number or boolean", fieldAt);
      continue;
    }
    if (field.required !== undefined && typeof field.required !== "boolean") {
      bag.add("field_type", "config field required must be a boolean", fieldAt);
      continue;
    }
    if (field.description !== undefined) {
      if (typeof field.description !== "string" || field.description.length > CONFIG_LIMITS.maxValueLength) {
        bag.add("limit", "config field description must be a bounded string", fieldAt);
        continue;
      }
    }
    const normal: ModuleConfigField = { type: field.type as ConfigValueType };
    if (field.required === true) normal.required = true;
    if (typeof field.description === "string") normal.description = field.description;
    out[name] = normal;
  }
  return sortedDeclaration(out);
}

/** Canonical form: keys sorted, each field in {type, required?, description?} order. */
export function sortedDeclaration(declaration: ModuleConfigDeclaration): ModuleConfigDeclaration {
  const out: Record<string, ModuleConfigField> = {};
  for (const name of Object.keys(declaration).sort()) {
    const field = declaration[name]!;
    const normal: ModuleConfigField = { type: field.type };
    if (field.required === true) normal.required = true;
    if (field.description !== undefined) normal.description = field.description;
    out[name] = normal;
  }
  return out;
}

/** Read an instance's `config` values (shape only — declarations live elsewhere). */
export function readInstanceConfig(
  bag: IssueBag,
  row: Record<string, unknown>,
  key: string,
  at: string,
): InstanceConfig | undefined {
  const raw = row[key];
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    bag.add("field_type", `${key} must be an object of values`, `${at}.${key}`);
    return undefined;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length) {
    bag.add("empty", `${key} carries no values — omit it instead`, `${at}.${key}`);
    return undefined;
  }
  if (entries.length > CONFIG_LIMITS.maxConfigFields) {
    bag.add("limit", `${key} carries more than ${CONFIG_LIMITS.maxConfigFields} values`, `${at}.${key}`);
    return undefined;
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of entries) {
    const valueAt = `${at}.${key}.${name}`;
    if (!CONFIG_KEY_PATTERN.test(name)) {
      bag.add("identifier", "config keys must be short lower-case keys", valueAt);
      continue;
    }
    if (typeof value === "string") {
      if (value.length > CONFIG_LIMITS.maxValueLength) {
        bag.add("limit", `config value longer than ${CONFIG_LIMITS.maxValueLength} characters`, valueAt);
        continue;
      }
      out[name] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        bag.add("field_type", "config numbers must be finite", valueAt);
        continue;
      }
      out[name] = value;
    } else if (typeof value === "boolean") {
      out[name] = value;
    } else {
      bag.add("field_type", "config values must be string, number or boolean", valueAt);
    }
  }
  return sortedConfig(out);
}

export function sortedConfig(config: InstanceConfig): InstanceConfig {
  const out: Record<string, string | number | boolean> = {};
  for (const name of Object.keys(config).sort()) out[name] = config[name]!;
  return out;
}

/**
 * The link-time half: values against the module's own declaration. Runs only
 * where a registry is supplied (the browser and the pack path — the two
 * callers whose manifests ARE the bundle's), same rule as every other
 * manifest-backed check since the 2026-08-07 redirection.
 */
export function checkInstanceConfig(
  bag: IssueBag,
  config: InstanceConfig | undefined,
  declaration: ModuleConfigDeclaration | undefined,
  at: string,
): void {
  const decl = declaration ?? {};
  const values = config ?? {};
  for (const name of Object.keys(values)) {
    const field = decl[name];
    if (!field) {
      bag.add("unknown_field", `config key ${name} is not declared by the module`, `${at}.config.${name}`);
      continue;
    }
    if (typeof values[name] !== field.type) {
      bag.add("field_type", `config key ${name} must be a ${field.type}`, `${at}.config.${name}`);
    }
  }
  for (const [name, field] of Object.entries(decl)) {
    if (field.required === true && values[name] === undefined) {
      bag.add("missing_field", `config key ${name} is required by the module`, `${at}.config.${name}`);
    }
  }
}

/** Read an intent's `context` — an opaque, bounded string map. */
export function readIntentContext(
  bag: IssueBag,
  row: Record<string, unknown>,
  key: string,
  at: string,
): IntentContext | undefined {
  const raw = row[key];
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    bag.add("field_type", `${key} must be an object of string values`, `${at}.${key}`);
    return undefined;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length) {
    bag.add("empty", `${key} carries no entries — omit it instead`, `${at}.${key}`);
    return undefined;
  }
  if (entries.length > CONFIG_LIMITS.maxContextEntries) {
    bag.add("limit", `${key} carries more than ${CONFIG_LIMITS.maxContextEntries} entries`, `${at}.${key}`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    const valueAt = `${at}.${key}.${name}`;
    if (!CONFIG_KEY_PATTERN.test(name)) {
      bag.add("identifier", "context keys must be short lower-case keys", valueAt);
      continue;
    }
    if (typeof value !== "string" || value.length > CONFIG_LIMITS.maxValueLength) {
      bag.add("limit", `context values must be strings of at most ${CONFIG_LIMITS.maxValueLength} characters`, valueAt);
      continue;
    }
    out[name] = value;
  }
  return sortedContext(out);
}

function sortedContext(context: IntentContext): IntentContext {
  const out: Record<string, string> = {};
  for (const name of Object.keys(context).sort()) out[name] = context[name]!;
  return out;
}
