/**
 * The declaration's fields, as the flat strings the View wire carries.
 *
 * ── Why encoding is a checked step and not a `String()` ────────────────────
 *
 * The existing ports build their params by hand: `String(ref ?? "")`,
 * `String(this.seq)`, `[RESOURCE_PARAMS.ref]: asked`. That works and it is short,
 * but it means the bound the contract declared and the bound the wire enforces
 * are checked in two different places — the reader on arrival, and the
 * dispatcher's own limit — and NEITHER of them is checked before the proposal is
 * sent. A caller that hands a 4000-character body to a 512-character field
 * currently learns about it from a refusal written by somebody else.
 *
 * So encoding refuses locally, with the contract's own field path in the
 * diagnostic, and it refuses for the same reasons the far side would.
 *
 * ── Three rules that are easy to get wrong ─────────────────────────────────
 *
 *  · **An unknown parameter is a refusal, not something to drop.** The same rule
 *    as `refuseUnknownFields`: a name this build does not know is either a newer
 *    schema or a typo that quietly turned something off. Dropping it sends a
 *    proposal that means something different from what the caller wrote.
 *  · **An absent optional parameter is omitted, not sent empty.** The wire has
 *    an eight-key budget, and `""` is a value — a far side that distinguishes
 *    "no offset" from "offset 0" would be given the wrong answer.
 *  · **A number is not coerced from a string and a string is not coerced from a
 *    number.** Coercion is the one thing the panel's own schema layer explicitly
 *    turned off (`coerceTypes: false`), for the reason stated there: a schema
 *    that rewrites the request has not validated the request.
 */

import {
  IssueBag,
  type ContractResult,
} from "@claude-bot/resource-stream-contract";
import {
  wireValueLimit,
  type ContractDeclaration,
  type PortActionDeclaration,
  type PortField,
} from "./declaration.js";
import { WIRE_PARAM_LIMITS } from "./wire.js";

/**
 * Canonical JSON: the object as its normaliser built it, compact.
 *
 * There is no key sorting because there is no key freedom — a contract's
 * normaliser constructs its result in one fixed field order, so `JSON.stringify`
 * reproduces it. That is what makes `encode(read(x)) === x` an equality a test
 * can assert rather than a claim about a sorting function.
 *
 * Returns null rather than throwing for a value JSON cannot represent (a cycle,
 * a BigInt): this is on the path where a consumer's own object arrives, and a
 * thrown `TypeError` there would be an exception a component must catch.
 */
export function canonicalJson(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

/** Encode one action's typed arguments as the flat map a proposal carries. */
export function encodeWireParams(
  action: PortActionDeclaration,
  values: Readonly<Record<string, unknown>>,
): ContractResult<Record<string, string>> {
  const bag = new IssueBag();
  const at = action.action;
  const out: Record<string, string> = {};

  for (const name of Object.keys(values)) {
    if (!Object.prototype.hasOwnProperty.call(action.params, name)) {
      bag.add("unknown_field", `unknown parameter ${name}`, at);
    }
  }

  for (const [name, field] of Object.entries(action.params)) {
    const raw = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
    if (raw === undefined || raw === null) {
      if (!field.optional) bag.add("missing_field", `missing ${name}`, at);
      continue;
    }
    const encoded = encodeField(bag, `${at}.${name}`, name, field, raw);
    if (encoded !== null) out[name] = encoded;
  }

  if (Object.keys(out).length > WIRE_PARAM_LIMITS.maxKeys) {
    bag.add("limit", `more than ${WIRE_PARAM_LIMITS.maxKeys} parameters`, at);
  }
  if (!bag.empty) return bag.fail();
  return { ok: true, value: out };
}

function encodeField(
  bag: IssueBag,
  at: string,
  name: string,
  field: PortField,
  raw: unknown,
): string | null {
  switch (field.type) {
    case "string": {
      if (typeof raw !== "string") {
        bag.add("field_type", `${name} must be a string`, at);
        return null;
      }
      if (field.enum !== undefined && !field.enum.includes(raw)) {
        bag.add("schema", `${name} must be one of ${field.enum.join(", ")}`, at);
        return null;
      }
      if (field.maxLength !== undefined && raw.length > field.maxLength) {
        bag.add("limit", `${name} is longer than ${field.maxLength} characters`, at);
        return null;
      }
      if (field.pattern !== undefined && !field.pattern.test(raw)) {
        bag.add("identifier", `${name} does not match its declared form`, at);
        return null;
      }
      return bounded(bag, at, name, field, raw);
    }
    case "integer": {
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        bag.add("field_type", `${name} must be an integer`, at);
        return null;
      }
      if (field.minimum !== undefined && raw < field.minimum) {
        bag.add("limit", `${name} is below ${field.minimum}`, at);
        return null;
      }
      if (field.maximum !== undefined && raw > field.maximum) {
        bag.add("limit", `${name} is above ${field.maximum}`, at);
        return null;
      }
      return bounded(bag, at, name, field, String(raw));
    }
    case "boolean": {
      if (typeof raw !== "boolean") {
        bag.add("field_type", `${name} must be a boolean`, at);
        return null;
      }
      return raw ? "true" : "false";
    }
    case "json": {
      const text = canonicalJson(raw);
      if (text === null) {
        bag.add("field_type", `${name} is not representable as JSON`, at);
        return null;
      }
      // Measured on the ENCODED form: escaping is what makes a card of legal
      // strings exceed a limit its fields individually respect, and truncating
      // it would produce a document that parses into something else.
      if (field.maxLength !== undefined && text.length > field.maxLength) {
        bag.add("limit", `${name} encodes to more than ${field.maxLength} characters`, at);
        return null;
      }
      return bounded(bag, at, name, field, text);
    }
  }
}

/**
 * The wire's own bound, as opposed to the field's.
 *
 * `wireValueLimit` is what the trusted dispatcher reads too, so a value this
 * function accepts is one that side will keep whole. A field with no declared
 * bound reaches here only from a declaration `createRemoteCall` already refused
 * to build for, and it is still bounded rather than sent.
 */
function bounded(bag: IssueBag, at: string, name: string, field: PortField, text: string): string | null {
  const limit = wireValueLimit(field) ?? WIRE_PARAM_LIMITS.maxValueLength;
  if (text.length > limit) {
    bag.add("limit", `${name} is longer than the wire's ${limit} characters`, at);
    return null;
  }
  return text;
}

/**
 * The other direction, for whoever serves the action.
 *
 * A trusted dispatcher receives the same flat strings and has to turn them back
 * into the declared types before handing them to a provider. Doing it from the
 * same declaration is what keeps "what the client may send" and "what the server
 * will accept" from being two lists that drift; the alternative is the shape this
 * repository has already been bitten by, where one side bounds a field and the
 * other does not.
 *
 * Note it is NOT the inverse of `encodeWireParams` for `json`: a decoded json
 * field is `unknown` and the contract's own reader has to validate it. This layer
 * knows that a value arrived and that it parsed; it does not know what it means.
 */
export function decodeWireParams(
  action: PortActionDeclaration,
  params: Readonly<Record<string, unknown>>,
): ContractResult<Record<string, unknown>> {
  const bag = new IssueBag();
  const at = action.action;
  const out: Record<string, unknown> = {};

  for (const name of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(action.params, name)) {
      bag.add("unknown_field", `unknown parameter ${name}`, at);
    }
  }

  for (const [name, field] of Object.entries(action.params)) {
    const raw = Object.prototype.hasOwnProperty.call(params, name) ? params[name] : undefined;
    if (raw === undefined) {
      if (!field.optional) bag.add("missing_field", `missing ${name}`, at);
      continue;
    }
    if (typeof raw !== "string") {
      bag.add("field_type", `${name} must arrive as a string`, `${at}.${name}`);
      continue;
    }
    // The SAME bound the sender encoded against — one function, so a field the
    // client is allowed to send is never one this side silently drops.
    const limit = wireValueLimit(field) ?? WIRE_PARAM_LIMITS.maxValueLength;
    if (raw.length > limit) {
      bag.add("limit", `${name} is longer than the wire's ${limit} characters`, `${at}.${name}`);
      continue;
    }
    const value = decodeField(bag, `${at}.${name}`, name, field, raw);
    if (value !== undefined) out[name] = value;
  }

  if (!bag.empty) return bag.fail();
  return { ok: true, value: out };
}

function decodeField(
  bag: IssueBag,
  at: string,
  name: string,
  field: PortField,
  raw: string,
): unknown {
  switch (field.type) {
    case "string": {
      if (field.enum !== undefined && !field.enum.includes(raw)) {
        bag.add("schema", `${name} must be one of ${field.enum.join(", ")}`, at);
        return undefined;
      }
      if (field.maxLength !== undefined && raw.length > field.maxLength) {
        bag.add("limit", `${name} is longer than ${field.maxLength} characters`, at);
        return undefined;
      }
      if (field.pattern !== undefined && !field.pattern.test(raw)) {
        bag.add("identifier", `${name} does not match its declared form`, at);
        return undefined;
      }
      return raw;
    }
    case "integer": {
      // Strict: `parseInt` would accept "12abc" and `Number` would accept
      // " 12 ", "0x0c" and "1e3". A wire value that is nearly a number is a
      // caller that meant something else.
      //
      // `-0` is refused along with them, so that encode and decode are a
      // bijection: `String(-0)` is `"0"`, so a `-0` on the wire is a second
      // spelling this side never produces, and a second spelling is what makes
      // "the same request twice" fail to look the same.
      if (!/^(0|-?[1-9][0-9]{0,14})$/.test(raw)) {
        bag.add("field_type", `${name} must be an integer`, at);
        return undefined;
      }
      const value = Number(raw);
      if (field.minimum !== undefined && value < field.minimum) {
        bag.add("limit", `${name} is below ${field.minimum}`, at);
        return undefined;
      }
      if (field.maximum !== undefined && value > field.maximum) {
        bag.add("limit", `${name} is above ${field.maximum}`, at);
        return undefined;
      }
      return value;
    }
    case "boolean": {
      if (raw !== "true" && raw !== "false") {
        bag.add("field_type", `${name} must be true or false`, at);
        return undefined;
      }
      return raw === "true";
    }
    case "json": {
      if (field.maxLength !== undefined && raw.length > field.maxLength) {
        bag.add("limit", `${name} encodes to more than ${field.maxLength} characters`, at);
        return undefined;
      }
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        // `schema` rather than a `json` code: the issue vocabulary this family
        // shares (`resource-stream-contract/src/issues.ts`) does not have one,
        // and widening another package's exported union from here would be a
        // decision belonging to that package.
        bag.add("schema", `${name} is not parseable as JSON`, at);
        return undefined;
      }
    }
  }
}

/**
 * Look one action up.
 *
 * Returns null rather than throwing even though `A` makes an undeclared id a
 * compile error: this is also the lookup a trusted dispatcher performs on an id
 * that arrived over a wire, where the type says nothing.
 */
export function actionOf<C extends string, A extends string>(
  declaration: ContractDeclaration<C, A>,
  action: string,
): PortActionDeclaration<A> | null {
  return Object.prototype.hasOwnProperty.call(declaration.byAction, action)
    ? declaration.byAction[action as A]
    : null;
}
