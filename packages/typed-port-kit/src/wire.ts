/**
 * The transport constants a typed port shares with the trusted dispatcher.
 *
 * ── Why these numbers are here and not negotiable ──────────────────────────
 *
 * An Agent View has exactly one MessagePort, and a resource proposal travels on
 * it as `propose(action, params)` where `params` is a flat map of short strings.
 * The bounds below are the ones the trusted coordinator enforces
 * (`packages/bot/src/session-plus/app-service.ts`); they are restated here so a
 * contract can be *checked against them at declaration time* instead of
 * discovering at the first call that one of its actions cannot be proposed.
 *
 * Restating rather than importing is deliberate: this package must not depend on
 * the bot, and the coordinator must not depend on a contract kit. The pair is
 * kept honest by a test in this package that pins the exact numbers, so a change
 * on either side shows up as a failing assertion with the other side named in it.
 *
 * ── Why a flat string map at all ───────────────────────────────────────────
 *
 * Because the dispatcher has to bound a proposal *without knowing what any of its
 * parameters mean*. Eight short strings is something it can measure; an arbitrary
 * JSON graph is not. A contract that needs structure encodes it into one of those
 * strings and validates it with its own reader on arrival — which is why this kit
 * has a `json` field type whose wire form is bounded and whose MCP form is not.
 *
 * ── The one declared exception, and why it is not a hole ───────────────────
 *
 * 512 characters is the bound for a parameter *nobody declared anything about*.
 * It is also too small for a whole file body, which is what
 * `workspace-files/v1`'s `replace_text` carries — and P6a wrote that fact down
 * (`wireProblems`) rather than declaring a bound that would have truncated an
 * edit. The editor batch resolves it by letting the *contract* raise the bound
 * for ONE parameter of one action, up to `maxDeclaredValueLength`.
 *
 * Three properties keep that from becoming "the View decides how big a message
 * is":
 *
 *  · the raised bound comes from a declaration this bundle COMPILED IN. The
 *    trusted dispatcher resolves the contract from the App's binding plan — a
 *    document it holds — and then reads the bound out of its own copy of the
 *    declaration. Nothing the View sends selects a limit;
 *  · **at most one** parameter per action may be oversized. Two 384 KiB fields
 *    could not both fit under the transport's per-message ceiling, so an action
 *    declaring two is a wire problem at declaration time rather than a refusal
 *    at the first call;
 *  · the ceiling stays comfortably under `PORT_MESSAGE_BYTES` (512 KiB in
 *    `@claude-bot/web-trust/frame-protocol`), which the trusted shell measures on
 *    the whole serialised proposal. This kit does not import that constant — it
 *    must not depend on the browser half — but `wire.test.ts` pins the
 *    relationship, so raising one without the other fails there.
 *
 * ── Why the action prefix ──────────────────────────────────────────────────
 *
 * Typed-resource proposals do NOT go through an App's own declared action
 * surface: an App action is something the App's backend implements, while these
 * are served by a provider the *deployment* installed, selected through the
 * release's binding plan. Routing them by prefix — before manifest normalisation
 * — is what keeps those two vocabularies from having to be merged into one table
 * both halves must agree about.
 */

/** Bounds the trusted dispatcher applies to a resource proposal's params. */
export const WIRE_PARAM_LIMITS = Object.freeze({
  /** Distinct parameter names one proposal may carry. */
  maxKeys: 8,
  /** Characters one *undeclared* parameter value may carry. Still the default. */
  maxValueLength: 512,
  /**
   * Characters ONE declared parameter of one action may carry, when the
   * contract asks for more than `maxValueLength`.
   *
   * 384 KiB, chosen against the 512 KiB per-message ceiling rather than against
   * any particular contract: it leaves room for the seven other parameters, for
   * JSON escaping and for the envelope, so a proposal built inside this bound is
   * one the transport can actually carry.
   */
  maxDeclaredValueLength: 384 * 1024,
  /**
   * How many parameters of one action may exceed `maxValueLength`.
   *
   * One. Two would not fit in one message even at the ceiling, and an action
   * that cannot be proposed is worth saying at declaration time.
   */
  maxOversizedParams: 1,
  /** A parameter name. Compared, never parsed. */
  keyPattern: /^[a-z][a-z0-9_]{0,63}$/,
});

export function isWireParamKey(value: unknown): value is string {
  return typeof value === "string" && WIRE_PARAM_LIMITS.keyPattern.test(value);
}

/** Every typed-resource action id carries this prefix. */
export const RESOURCE_ACTION_PREFIX = "resource.";

/**
 * Parameter names the kit itself owns.
 *
 * `binding` is the App-local name from its `agent-resource-bindings/v1` plan. It
 * selects among what the plan already declared; it is NOT authority, and the
 * trusted dispatcher resolves it against its own copy of that document.
 *
 * `handle` and `seq` belong to `resource-stream/v1` and appear on every contract
 * that opens a stream, which is why they are declared once here rather than in
 * each contract that happens to stream something.
 */
export const RESERVED_PARAMS = Object.freeze({
  binding: "binding",
  handle: "handle",
  seq: "seq",
});

/** The two stream verbs, spelled the same way by every contract that streams. */
export const STREAM_PULL_ACTION = `${RESOURCE_ACTION_PREFIX}stream_pull`;
export const STREAM_CLOSE_ACTION = `${RESOURCE_ACTION_PREFIX}stream_close`;

/** Turn a contract's own action id into the id that crosses the wire. */
export function wireActionOf(action: string): string {
  return `${RESOURCE_ACTION_PREFIX}${action}`;
}
