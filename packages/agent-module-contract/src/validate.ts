/**
 * The shared refusal machinery.
 *
 * Every reader in this package answers with a result rather than an exception,
 * for one reason: the consumers are a release adapter that must refuse a
 * candidate *without* disturbing a running deployment, and a browser bundle that
 * must degrade one panel instead of the document. Both need to say WHICH field
 * was wrong; neither can afford a thrown string.
 *
 * Two properties are worth stating because they are choices:
 *
 *  · **Unknown fields are a refusal, not something to ignore.** These documents
 *    are release assets covered by the package digest. A field this build does
 *    not understand is either a newer schema (which must not be interpreted
 *    optimistically) or a typo that silently disabled something. Both deserve
 *    the same loud answer.
 *  · **Diagnostics are bounded and control characters are replaced.** A
 *    composition is publisher-supplied text that ends up in a log and eventually
 *    on a page.
 */

export type ContractIssueCode =
  | "not_an_object"
  | "unknown_field"
  | "missing_field"
  | "field_type"
  | "schema"
  | "identifier"
  | "version"
  | "slot"
  | "open_mode"
  | "duplicate"
  | "unknown_module"
  | "module_identity"
  | "unconnected"
  | "empty"
  | "limit"
  | "json";

export interface ContractIssue {
  code: ContractIssueCode;
  /** Bounded and control-character free. Never echoes a whole document. */
  message: string;
  /** The field path or identifier the issue is about. */
  at?: string;
}

export type ContractResult<T> = { ok: true; value: T } | { ok: false; issues: ContractIssue[] };

/** Bounds every hostile input could otherwise choose. */
export const CONTRACT_LIMITS = Object.freeze({
  maxModules: 64,
  maxInstances: 64,
  maxOpenRules: 64,
  maxStringLength: 200,
  maxIssues: 24,
});

const MESSAGE_MAX = 160;
const AT_MAX = 120;

function clip(value: string, max: number): string {
  const safe = value.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD");
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}\u2026`;
}

/** Collects issues without letting a hostile document produce an unbounded report. */
export class IssueBag {
  private readonly rows: ContractIssue[] = [];
  private suppressed = 0;

  add(code: ContractIssueCode, message: string, at?: string): void {
    if (this.rows.length >= CONTRACT_LIMITS.maxIssues) {
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

export function stringAt(
  bag: IssueBag,
  row: Record<string, unknown>,
  key: string,
  at: string,
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
  if (value.length > CONTRACT_LIMITS.maxStringLength) {
    bag.add("limit", `${key} is longer than ${CONTRACT_LIMITS.maxStringLength} characters`, at);
    return null;
  }
  return value;
}

/**
 * A whole number inside a closed range, or a recorded refusal.
 *
 * Three refusals rather than one, because they mean different things to whoever
 * wrote the document: the key is absent, the value is not a whole number at all
 * (`"12"`, `1.5`, `NaN`), or it is a number this build will not honour. Bounds
 * are required arguments — there is no "unbounded integer" in a release asset,
 * because every number here eventually becomes a count of something a process
 * has to hold.
 */
export function integerAt(
  bag: IssueBag,
  row: Record<string, unknown>,
  key: string,
  at: string,
  bounds: { min: number; max: number },
): number | null {
  const value = row[key];
  if (value === undefined) {
    bag.add("missing_field", `missing ${key}`, at);
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    bag.add("field_type", `${key} must be a whole number`, at);
    return null;
  }
  if (value < bounds.min || value > bounds.max) {
    bag.add("limit", `${key} must be between ${bounds.min} and ${bounds.max}`, at);
    return null;
  }
  return value;
}

export function arrayAt(
  bag: IssueBag,
  row: Record<string, unknown>,
  key: string,
  at: string,
  max: number,
): unknown[] | null {
  const value = row[key];
  if (value === undefined) {
    bag.add("missing_field", `missing ${key}`, at);
    return null;
  }
  if (!Array.isArray(value)) {
    bag.add("field_type", `${key} must be an array`, at);
    return null;
  }
  if (value.length > max) {
    bag.add("limit", `${key} has more than ${max} entries`, at);
    return null;
  }
  return value;
}

/** Parse bytes that arrived from somewhere, without throwing at the caller. */
export function parseJsonDocument<T>(text: string, at: string, read: (value: unknown) => ContractResult<T>): ContractResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    const bag = new IssueBag();
    bag.add("json", "not parseable as JSON", at);
    return bag.fail();
  }
  return read(parsed);
}

/**
 * Canonical serialisation: the object as this package built it, two-space
 * indented, newline-terminated.
 *
 * There is no key sorting because there is no key freedom — every normaliser in
 * this package constructs its result in one fixed field order, so
 * `JSON.stringify` reproduces it. That is what makes "encode(parse(x)) === x"
 * an equality a test can assert rather than a claim about a sorting function.
 */
export function encodeCanonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
