/**
 * A closed set of refusal codes, declared once and enforced everywhere.
 *
 * ── What a closed set buys ─────────────────────────────────────────────────
 *
 * A consumer has to *decide* something. Retrying is wrong for all of them (these
 * contracts never retry), but "the file is bigger than this viewer can open",
 * "somebody has to approve that first" and "your permission was revoked" are
 * three different sentences and two of them tell a person what to do next. A
 * `code: string` makes that decision a guess; a union makes it a switch the
 * compiler checks.
 *
 * ── Why folding is a first-class operation, not an afterthought ────────────
 *
 * Both halves of a typed port are versioned independently. A Host one release
 * newer can answer with a code this build has never heard of. There are exactly
 * three things a consumer can do with it: render it as if it meant something
 * (a lie), throw (a stack trace across a trust boundary), or fold it into the
 * one code that means "this build cannot interpret what happened".
 *
 * The third is the only honest one, so `coerce()` is not a helper a port may
 * forget to call — the remote adapter in this kit routes every wire code through
 * it, and the vocabulary is where the fold target is declared. That also makes
 * the fold target reviewable: it is one field in one declaration, not a `??`
 * buried in a mapping function.
 *
 * ── Why construction throws ────────────────────────────────────────────────
 *
 * A duplicated code, a fallback outside its own set, or a code that is not a
 * plain identifier are all programming errors in a declaration this bundle
 * compiled in. They are not untrusted input, and the established rule in this
 * repository is that the one place allowed to throw is the one that derives a
 * declaration from the build's own sources (`moduleLockOf()` is the precedent).
 * Failing at module load is what keeps a typo from becoming a refusal branch
 * nobody exercises until it matters.
 */

import { portRefusal, type PortRefusal } from "./reply.js";

/**
 * A refusal code as it crosses a wire.
 *
 * Narrow on purpose: a code is compared, logged and switched on. It is never
 * joined onto a path, shown to a person as prose, or parsed. Allowing punctuation
 * would let a code carry structure, and structure invites parsing.
 */
const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function isRefusalCode(value: unknown): value is string {
  return typeof value === "string" && REFUSAL_CODE.test(value);
}

export interface RefusalVocabulary<C extends string> {
  /** Every code, in declaration order. Frozen. */
  readonly codes: readonly C[];
  /** Where a code this build does not recognise folds to. */
  readonly fallback: C;
  /** Refusal text bound, so one vocabulary can be stricter than the default. */
  readonly maxMessageLength: number;
  has(value: unknown): value is C;
  /** Fold anything at all into this closed set. Never throws. */
  coerce(value: unknown): C;
  /** Build a refusal from a code this build already knows. */
  refuse(code: C, message: string): PortRefusal<C>;
  /**
   * Build a refusal from a code that arrived from somewhere else.
   *
   * `fallbackMessage` is used when the other side sent no text; a refusal with
   * an empty message reaches a person as a blank box.
   */
  fold(code: unknown, message: unknown, fallbackMessage: string): PortRefusal<C>;
}

export interface RefusalVocabularyOptions<C extends string> {
  /** Where an unrecognised code folds to. Must be one of `codes`. */
  readonly fallback: C;
  readonly maxMessageLength?: number;
}

/**
 * Declare a contract's closed refusal set.
 *
 * `const C extends string` rather than `string`: passing an array literal gives
 * the caller the literal union without a second `as const` type alias to keep in
 * step with the runtime list.
 */
export function refusalVocabulary<const C extends string>(
  codes: readonly C[],
  options: RefusalVocabularyOptions<C>,
): RefusalVocabulary<C> {
  if (codes.length === 0) throw new Error("a refusal vocabulary must declare at least one code");
  const seen = new Set<string>();
  for (const code of codes) {
    if (!isRefusalCode(code)) throw new Error(`refusal code ${JSON.stringify(code)} is not a plain identifier`);
    if (seen.has(code)) throw new Error(`refusal code ${JSON.stringify(code)} is declared twice`);
    seen.add(code);
  }
  if (!seen.has(options.fallback)) {
    throw new Error(`fallback ${JSON.stringify(options.fallback)} is not one of the declared codes`);
  }
  const maxMessageLength = options.maxMessageLength ?? 200;
  if (!Number.isInteger(maxMessageLength) || maxMessageLength < 1) {
    throw new Error("maxMessageLength must be a positive integer");
  }

  const frozen = Object.freeze([...codes]);
  const has = (value: unknown): value is C => typeof value === "string" && seen.has(value);
  const coerce = (value: unknown): C => (has(value) ? value : options.fallback);

  return Object.freeze({
    codes: frozen,
    fallback: options.fallback,
    maxMessageLength,
    has,
    coerce,
    refuse: (code: C, message: string) => portRefusal(code, message, maxMessageLength),
    fold: (code: unknown, message: unknown, fallbackMessage: string) =>
      portRefusal(
        coerce(code),
        typeof message === "string" && message.length > 0 ? message : fallbackMessage,
        maxMessageLength,
      ),
  });
}

/**
 * Translate one vocabulary's codes into another's.
 *
 * The worked example is a resource port whose domain refusals have to be carried
 * on a `resource-stream/v1` terminal: `approval_required` and `no_authority` are
 * both `denied` to a stream, `scope_closed` is `expired`, and a malformed request
 * is `protocol`. Written inline that is a chain of `if`s whose default branch is
 * easy to get wrong; written here, the target codes are checked against the
 * target vocabulary at module load, so a typo'd destination fails immediately
 * rather than on the one refusal that exercises it.
 *
 * `table` is keyed by plain string rather than by the source union, because the
 * input is a wire code and the whole point is that it may not be in any union
 * this build knows.
 */
export function foldRefusalInto<B extends string>(
  to: RefusalVocabulary<B>,
  table: Readonly<Record<string, B>>,
): (code: unknown, message: unknown, fallbackMessage: string) => PortRefusal<B> {
  for (const [from, target] of Object.entries(table)) {
    if (!isRefusalCode(from)) throw new Error(`refusal mapping key ${JSON.stringify(from)} is not a plain identifier`);
    if (!to.has(target)) throw new Error(`refusal mapping for ${from} targets unknown code ${JSON.stringify(target)}`);
  }
  const mapping = Object.freeze({ ...table });
  return (code, message, fallbackMessage) => {
    const mapped =
      typeof code === "string" && Object.prototype.hasOwnProperty.call(mapping, code) ? mapping[code] : undefined;
    // A code the table does not name still gets the destination's own fold, so
    // "unmapped" and "unknown" reach the same honest answer by the same path.
    return to.fold(mapped ?? code, message, fallbackMessage);
  };
}
