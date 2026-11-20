/**
 * A contract, declared once, as data.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * Today a typed port states its vocabulary four or five times: an actions object,
 * a params object, a per-method encoder, a refusal union, and — where an agent
 * can reach it — a hand-written JSON Schema. Those are five places to keep one
 * fact, and this repository already has the evidence about what happens: the one
 * existing contract-to-tool generator (`gatewayToolDescriptors` in
 * `packages/bot/src/feishu/catalog.ts`) drops `maxLength`, `min`, `max` and every
 * argument description on the way out, because the schema it emits is written by
 * hand from a declaration that has them.
 *
 * So the declaration is the source, and everything else is derived:
 *
 *   declaration ─┬─→ wire params  (bounded flat strings — `params.ts`)
 *                ├─→ MCP tools    (JSON Schema — `mcp.ts`)
 *                └─→ conformance  (which properties a port must satisfy)
 *
 * The two faces have DIFFERENT transport limits, and that is the interesting
 * part. A View proposal is eight strings of 512 characters; an MCP bridge runs
 * inside the trusted process and takes bounded structured JSON. A field may
 * therefore be legal on one face and not the other, and `wireProblems` says
 * which — loudly, at declaration time, rather than at the first call.
 *
 * ── Why actions are a record and not an array ──────────────────────────────
 *
 * So `A` is `keyof` it. An action id that only exists as a string is a typo
 * waiting to become a silently refused call; keyed this way, `call("send_txt")`
 * is a compile error. That is the same argument `agent-sessions/v1`'s
 * `SESSION_ACTIONS` makes for putting the strings in the contract package — this
 * just removes the second copy.
 *
 * ── What a declaration deliberately does NOT carry ─────────────────────────
 *
 * No effect (`read`/`write`/`execute`), no auto-allow, no risk level, no
 * predicate, no publisher. The capability kernel owns `effect` on its
 * `OperationSpec`, and a second declaration of it in a package that can enforce
 * nothing would be a claim rather than a fact — two sources for one thing is how
 * they drift. `operation` is different in kind and IS present: naming which
 * permission token an action spends lets a consumer SAY what a composition
 * requests without being able to grant it, which is the pattern
 * `WORKSPACE_FILES_OPERATIONS` and `SESSION_OPERATIONS` already established.
 *
 * ── Why construction throws ────────────────────────────────────────────────
 *
 * A declaration is data this bundle compiled in, not untrusted input. A duplicate
 * parameter name, an unanchored pattern, a `json` field with no bound: each is a
 * programming error, and each would otherwise become a branch that is wrong only
 * in the case nobody tested. `moduleLockOf()` is the precedent.
 */

import { isContractId } from "@claude-bot/agent-module-contract";
import type { RefusalVocabulary } from "./refusals.js";
import { WIRE_PARAM_LIMITS, isWireParamKey } from "./wire.js";

/**
 * What a parameter is.
 *
 * Four types, because four is what both faces can express without either one
 * having to invent a coercion. `json` is the escape hatch for structure, and its
 * two faces are deliberately different: the wire carries its bounded JSON
 * encoding, an MCP client sends the object itself.
 */
export type PortFieldType = "string" | "integer" | "boolean" | "json";

/**
 * A JSON Schema fragment, as data.
 *
 * Typed as an open record because this package is not a JSON Schema validator and
 * must not pretend to be one: it EMBEDS the fragment a contract author wrote into
 * the derived tool schema, and the contract's own reader is what actually
 * validates an arriving value. Building a validator here would be a second,
 * weaker implementation of every reader in this repository.
 */
export type JsonSchemaFragment = Readonly<Record<string, unknown>>;

export interface PortField {
  readonly type: PortFieldType;
  /** Written for a person and for an agent. Both faces carry it. */
  readonly description: string;
  /**
   * Absent means REQUIRED.
   *
   * The polarity matches `boundedStringAt` and every other reader in this family
   * (`{ optional: true }`) rather than JSON Schema's and the engine's
   * `required?: boolean`. Fail closed: a field somebody forgot to annotate is
   * demanded rather than quietly droppable.
   */
  readonly optional?: boolean;
  /** Characters, for `string`; characters of the JSON encoding, for `json`. */
  readonly maxLength?: number;
  /** Inclusive, for `integer`. */
  readonly minimum?: number;
  readonly maximum?: number;
  /** A closed set of legal `string` values. */
  readonly enum?: readonly string[];
  /**
   * An anchored, flagless pattern a `string` must match.
   *
   * Both properties are checked at declaration time so the same `source` can be
   * handed to JSON Schema's `pattern`, which is unanchored by default and has no
   * flags at all. A pattern that meant one thing here and another to an MCP
   * client would be worse than no pattern.
   */
  readonly pattern?: RegExp;
  /** The nested shape, for `json`. Embedded into the derived tool schema as-is. */
  readonly schema?: JsonSchemaFragment;
}

/** One action, as its author writes it. The id is the key it is filed under. */
export interface PortActionSpec {
  /** One line, for a person and for an agent. */
  readonly summary: string;
  readonly params: Readonly<Record<string, PortField>>;
  /**
   * The permission token this action spends, when there is one.
   *
   * Absent means it spends none — App-owned durable state, typically. Saying so
   * is what keeps a permission summary from claiming an operation nobody
   * requests (`pin_session` is the standing example).
   *
   * Two actions MAY name the same operation: `append` and `resume` are two
   * intentions under one persistent authorisation, and keeping the action ids
   * separate is what lets an approval card say which one a person asked for.
   */
  readonly operation?: string;
}

/** The same thing after normalisation, carrying the id it was filed under. */
export interface PortActionDeclaration<A extends string = string> extends PortActionSpec {
  readonly action: A;
}

export interface ContractDeclaration<C extends string = string, A extends string = string> {
  /** `notify/v1`. Compared, never parsed. */
  readonly contract: string;
  /** One line about what the whole port is for. Carried onto the MCP face. */
  readonly summary: string;
  /** In declaration order. */
  readonly actions: readonly PortActionDeclaration<A>[];
  readonly refusals: RefusalVocabulary<C>;
  readonly byAction: Readonly<Record<A, PortActionDeclaration<A>>>;
  /**
   * Why an action cannot travel the View wire, by action id.
   *
   * Empty for every action on a wire-serviceable contract. A contract that is
   * deliberately MCP-only is expressible; what is NOT possible is building a
   * remote adapter for one by accident — `createRemoteCall` refuses.
   */
  readonly wireProblems: Readonly<Record<A, readonly string[]>>;
  readonly actionIds: readonly A[];
  /** Permission tokens this contract can spend, deduplicated and sorted. */
  readonly operations: readonly string[];
}

/** Every typed port states which contract it implements. Compared, never parsed. */
export interface ContractBound<Id extends string> {
  readonly contract: Id;
}

/** An action verb. Same grammar as a wire param key, and for the same reason. */
const ACTION_ID = /^[a-z][a-z0-9_]{0,63}$/;

/** A permission token, as the kernel spells them. */
const OPERATION_ID = /^[a-z][a-z0-9_]{0,63}$/;

export interface DeclareContractInput<C extends string, A extends string> {
  readonly contract: string;
  readonly summary: string;
  readonly actions: Readonly<Record<A, PortActionSpec>>;
  readonly refusals: RefusalVocabulary<C>;
}

/**
 * Validate and freeze a contract declaration.
 *
 * Everything below is checked because something downstream would otherwise
 * silently do the wrong thing with it — each check's comment names what.
 */
export function declareContract<C extends string, A extends string>(
  input: DeclareContractInput<C, A>,
): ContractDeclaration<C, A> {
  if (!isContractId(input.contract)) {
    // The same grammar `agent-resource-bindings/v1` uses. A contract id a
    // binding plan cannot reference is a port nothing can be wired to.
    throw new Error(`contract id ${JSON.stringify(input.contract)} is not a valid contract identifier`);
  }
  if (typeof input.summary !== "string" || input.summary.length === 0) {
    throw new Error("a contract declaration needs a summary; it is what an agent reads");
  }

  const actionIds = Object.keys(input.actions) as A[];
  if (actionIds.length === 0) throw new Error("a contract declaration must declare at least one action");

  const byAction = Object.create(null) as Record<A, PortActionDeclaration<A>>;
  const wireProblems = Object.create(null) as Record<A, readonly string[]>;
  const operations = new Set<string>();
  const actions: PortActionDeclaration<A>[] = [];

  for (const id of actionIds) {
    if (!ACTION_ID.test(id)) throw new Error(`action id ${JSON.stringify(id)} is not a plain identifier`);
    const spec = input.actions[id];
    if (typeof spec.summary !== "string" || spec.summary.length === 0) {
      throw new Error(`action ${id} needs a summary; it is what an agent reads`);
    }
    if (spec.operation !== undefined) {
      if (!OPERATION_ID.test(spec.operation)) {
        throw new Error(`action ${id} names an operation that is not a plain identifier`);
      }
      operations.add(spec.operation);
    }
    wireProblems[id] = checkFields(id, spec);
    const declared: PortActionDeclaration<A> = Object.freeze({
      action: id,
      summary: spec.summary,
      params: Object.freeze({ ...spec.params }),
      ...(spec.operation === undefined ? {} : { operation: spec.operation }),
    });
    byAction[id] = declared;
    actions.push(declared);
  }

  return Object.freeze({
    contract: input.contract,
    summary: input.summary,
    actions: Object.freeze(actions),
    refusals: input.refusals,
    byAction: Object.freeze(byAction),
    wireProblems: Object.freeze(wireProblems),
    actionIds: Object.freeze(actionIds),
    operations: Object.freeze([...operations].sort()),
  });
}

/**
 * Check one action's fields, and report which of them the View wire cannot carry.
 *
 * The distinction matters: a malformed field is a programming error and throws;
 * a field that is well-formed but larger than 512 characters is a legitimate
 * MCP-only declaration, and only a problem for the remote adapter.
 */
function checkFields(action: string, spec: PortActionSpec): readonly string[] {
  const problems: string[] = [];
  const names = Object.keys(spec.params);
  let oversized = 0;

  for (const name of names) {
    const field = spec.params[name]!;
    if (!isWireParamKey(name)) {
      // A declaration error rather than a wire problem: a name of this shape is
      // not a name any face can carry, and it would fail an MCP client's own
      // property-name handling too.
      throw new Error(`${action}.${name} is not a plain identifier`);
    }
    if (typeof field.description !== "string" || field.description.length === 0) {
      throw new Error(`${action}.${name} needs a description; it is what an agent reads`);
    }
    checkFieldShape(action, name, field);

    const declared = wireLengthOf(field);
    if (declared === null) {
      problems.push(`${name} declares no bound, so its wire size is unbounded`);
      continue;
    }
    if (declared > WIRE_PARAM_LIMITS.maxValueLength) {
      oversized += 1;
      if (declared > WIRE_PARAM_LIMITS.maxDeclaredValueLength) {
        problems.push(
          `${name} allows ${declared} characters, over the wire's ceiling of ${WIRE_PARAM_LIMITS.maxDeclaredValueLength}`,
        );
      }
    }
  }

  if (oversized > WIRE_PARAM_LIMITS.maxOversizedParams) {
    // Each one alone fits; together they do not, and "together" is the only way
    // they are ever sent. Saying so here is the difference between a contract
    // that cannot be proposed and a call that is refused for a reason the caller
    // has no way to see.
    problems.push(
      `${oversized} parameters exceed ${WIRE_PARAM_LIMITS.maxValueLength} characters,`
        + ` and one proposal carries at most ${WIRE_PARAM_LIMITS.maxOversizedParams}`,
    );
  }
  if (names.length > WIRE_PARAM_LIMITS.maxKeys) {
    problems.push(`${names.length} parameters, over the wire's ${WIRE_PARAM_LIMITS.maxKeys}`);
  }
  return Object.freeze(problems);
}

/**
 * How many wire characters one declared parameter may carry.
 *
 * `null` means it cannot travel at all: no declared bound, or one over the
 * ceiling. This is the single definition BOTH halves read — the client encoder
 * in `params.ts` and the trusted dispatcher that decides how much of an arriving
 * value to keep — so "what may be sent" and "what will be accepted" cannot drift
 * into two numbers.
 *
 * A field declared at or under `maxValueLength` reports `maxValueLength` rather
 * than its own smaller bound: this answers "what may the WIRE carry", and the
 * field's own bound is enforced separately, with the contract's field path in
 * the diagnostic.
 */
export function wireValueLimit(field: PortField): number | null {
  const declared = wireLengthOf(field);
  if (declared === null) return null;
  if (declared <= WIRE_PARAM_LIMITS.maxValueLength) return WIRE_PARAM_LIMITS.maxValueLength;
  return declared > WIRE_PARAM_LIMITS.maxDeclaredValueLength ? null : declared;
}

function checkFieldShape(action: string, name: string, field: PortField): void {
  const at = `${action}.${name}`;
  if (field.enum !== undefined && field.type !== "string") throw new Error(`${at} enum is only valid on a string`);
  if (field.pattern !== undefined && field.type !== "string") throw new Error(`${at} pattern is only valid on a string`);
  if (field.schema !== undefined && field.type !== "json") throw new Error(`${at} schema is only valid on json`);

  switch (field.type) {
    case "string": {
      if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 1)) {
        throw new Error(`${at} maxLength must be a positive integer`);
      }
      if (field.enum !== undefined) {
        if (field.enum.length === 0) throw new Error(`${at} declares an empty enum`);
        if (new Set(field.enum).size !== field.enum.length) throw new Error(`${at} enum repeats a value`);
      }
      if (field.pattern !== undefined) {
        if (field.pattern.flags !== "") throw new Error(`${at} pattern must have no flags; JSON Schema has none`);
        const source = field.pattern.source;
        if (!source.startsWith("^") || !source.endsWith("$")) {
          throw new Error(`${at} pattern must be anchored; JSON Schema patterns are unanchored by default`);
        }
      }
      return;
    }
    case "integer": {
      if (field.minimum !== undefined && !Number.isInteger(field.minimum)) {
        throw new Error(`${at} minimum must be an integer`);
      }
      if (field.maximum !== undefined && !Number.isInteger(field.maximum)) {
        throw new Error(`${at} maximum must be an integer`);
      }
      if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) {
        throw new Error(`${at} minimum is greater than maximum`);
      }
      return;
    }
    case "boolean":
      return;
    case "json": {
      if (field.maxLength === undefined) {
        // A structured value with no bound on its encoding is the one field
        // shape that makes a proposal unmeasurable, so it is an error rather
        // than a wire problem a caller could choose to live with.
        throw new Error(`${at} is json and must declare a maxLength for its encoded form`);
      }
      if (!Number.isInteger(field.maxLength) || field.maxLength < 2) {
        throw new Error(`${at} maxLength must be an integer of at least 2`);
      }
      return;
    }
  }
}

/**
 * How many wire characters this field may occupy, or null when it is unbounded.
 *
 * A boolean is `"true"` or `"false"`; an integer's bound comes from its range,
 * and an integer with no range is unbounded because a caller can always pass a
 * larger one.
 */
function wireLengthOf(field: PortField): number | null {
  switch (field.type) {
    case "boolean":
      return 5;
    case "integer": {
      if (field.minimum === undefined || field.maximum === undefined) return null;
      return Math.max(String(field.minimum).length, String(field.maximum).length);
    }
    case "string": {
      if (field.enum !== undefined) return Math.max(...field.enum.map((value) => value.length));
      return field.maxLength ?? null;
    }
    case "json":
      return field.maxLength ?? null;
  }
}

/** Every action this contract can serve over the View wire. */
export function wireServiceableActions<C extends string, A extends string>(
  declaration: ContractDeclaration<C, A>,
): readonly A[] {
  return declaration.actionIds.filter((id) => (declaration.wireProblems[id] ?? []).length === 0);
}
