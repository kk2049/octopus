/**
 * The refusal machinery both new contracts share.
 *
 * ── Why this is here and not imported ───────────────────────────────────────
 *
 * `@claude-bot/agent-module-contract` already owns an identical idea
 * (`src/validate.ts`), and reusing it would have been the first choice. It
 * deliberately does not export it: its public surface is the module ABI, and
 * `IssueBag` is machinery that ABI happens to be built out of. Widening a
 * release-asset package's exports is a decision that belongs to that package,
 * not to a consumer that wants a helper.
 *
 * So this file is the one copy the resource-stream and workspace-files contracts
 * BOTH use, rather than a copy per package. The shapes are structurally
 * compatible with the module contract's — `ContractIssue` here has a narrower
 * code union, so a result produced here is assignable to a consumer typed
 * against that one — which keeps a future merge a deletion rather than a
 * translation.
 *
 * Two properties, same as everywhere else in this repository:
 *
 *  · **Unknown fields are a refusal, not something to ignore.** A field this
 *    build does not understand is either a newer schema (which must not be
 *    interpreted optimistically) or a typo that quietly turned something off.
 *  · **Diagnostics are bounded and control characters are replaced**, because
 *    they end up in a log and eventually in front of a person.
 */

export type ContractIssueCode =
  | "not_an_object"
  | "unknown_field"
  | "missing_field"
  | "field_type"
  | "schema"
  | "identifier"
  | "limit";

export interface ContractIssue {
  code: ContractIssueCode;
  /** Bounded, control-character free, and never a whole document. */
  message: string;
  /** The field path the issue is about. */
  at?: string;
}

export type ContractResult<T> = { ok: true; value: T } | { ok: false; issues: ContractIssue[] };

const MESSAGE_MAX = 160;
const AT_MAX = 120;
const MAX_ISSUES = 24;

function clip(value: string, max: number): string {
  const safe = value.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD");
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}\u2026`;
}

/** Collects issues without letting a hostile document produce an unbounded report. */
export class IssueBag {
  private readonly rows: ContractIssue[] = [];
  private suppressed = 0;

  add(code: ContractIssueCode, message: string, at?: string): void {
    if (this.rows.length >= MAX_ISSUES) {
      this.suppressed += 1;
      return;
    }
    const row: ContractIssue = { code, message: clip(message, MESSAGE_MAX) };
    if (at !== undefined) row.at = clip(at, AT_MAX);
    this.rows.push(row);
  }

  get empty(): boolean {
    return this.rows.length === 0;
  }

  drain(): ContractIssue[] {
    if (this.suppressed === 0) return [...this.rows];
    return [...this.rows, { code: "limit", message: `${this.suppressed} further problems were not reported` }];
  }

  fail<T>(): ContractResult<T> {
    return { ok: false, issues: this.drain() };
  }
}

/** A plain JSON object, or a recorded refusal. Arrays are not objects here. */
export function objectAt(bag: IssueBag, value: unknown, at: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    bag.add("not_an_object", "expected a JSON object", at);
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Refuse any key this build does not know.
 *
 * `allowed` is written out at every call site rather than derived from a type,
 * because the type is erased and the check has to exist at runtime.
 */
export function refuseUnknownFields(
  bag: IssueBag,
  row: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void {
  for (const key of Object.keys(row)) {
    if (!allowed.includes(key)) bag.add("unknown_field", `unknown field ${clip(key, 40)}`, at);
  }
}

/**
 * A string field with its own bound.
 *
 * Every string on these two contracts has a different right answer — a media
 * type is 128 characters, a file label is 255 bytes, a text chunk is 256 KiB —
 * so the bound is a parameter rather than one global constant that would have to
 * be sized for the largest.
 */
export function boundedStringAt(
  bag: IssueBag,
  row: Record<string, unknown>,
  key: string,
  at: string,
  max: number,
  options: { optional?: boolean } = {},
): string | null {
  const value = row[key];
  if (value === undefined) {
    if (!options.optional) bag.add("missing_field", `missing ${key}`, at);
    return null;
  }
  if (typeof value !== "string") {
    bag.add("field_type", `${key} must be a string`, at);
    return null;
  }
  if (value.length > max) {
    bag.add("limit", `${key} is longer than ${max} characters`, at);
    return null;
  }
  return value;
}

/** An integer field with an inclusive floor (0 unless stated) and ceiling. */
export function boundedIntAt(
  bag: IssueBag,
  row: Record<string, unknown>,
  key: string,
  at: string,
  max: number,
  options: { optional?: boolean; min?: number } = {},
): number | null {
  const value = row[key];
  if (value === undefined) {
    if (!options.optional) bag.add("missing_field", `missing ${key}`, at);
    return null;
  }
  const min = options.min ?? 0;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    bag.add("field_type", `${key} must be an integer`, at);
    return null;
  }
  if (value < min || value > max) {
    bag.add("limit", `${key} must be between ${min} and ${max}`, at);
    return null;
  }
  return value;
}

/** A boolean field. Present and boolean, or a recorded refusal. */
export function booleanAt(
  bag: IssueBag,
  row: Record<string, unknown>,
  key: string,
  at: string,
  options: { optional?: boolean } = {},
): boolean | null {
  const value = row[key];
  if (value === undefined) {
    if (!options.optional) bag.add("missing_field", `missing ${key}`, at);
    return null;
  }
  if (typeof value !== "boolean") {
    bag.add("field_type", `${key} must be a boolean`, at);
    return null;
  }
  return value;
}
