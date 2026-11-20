/**
 * A typed port over somebody else's transport, built from a declaration.
 *
 * ── Why this reuses the App's ONE channel ──────────────────────────────────
 *
 * An Agent View has exactly one MessagePort, transferred once by the trusted
 * shell after a handshake that compares the sender. A second port for resources
 * would mean a second handshake, a second generation to keep in step, a second
 * thing to close on teardown — and every one of those is a place where a stale
 * channel keeps answering. So a resource read is an ordinary
 * `propose(action, params)` on the channel that already exists.
 *
 * `ProposalTransport` is declared structurally rather than imported, so this
 * package keeps its promise of knowing nothing about React, the Host, or who is
 * logged in; the Agent View client satisfies it by shape.
 *
 * ── What this constructor is, and what it is not ───────────────────────────
 *
 * It is one function that turns "the declaration says this action takes these
 * fields" into "propose it, then run the arrival checks on the answer". It is NOT
 * a port: a port is named methods, and a port with a generic
 * `call(action, params)` is how a component ends up naming an operation the App
 * never meant to expose. A contract package writes its own interface, and its
 * methods are two lines each.
 *
 * ── Why it refuses to build for a wire-incompatible declaration ────────────
 *
 * A contract may legitimately declare a field larger than the 512 characters a
 * proposal can carry — the MCP face runs inside the trusted process and has no
 * such limit. What must not happen is a remote adapter being built for it
 * anyway, because then the incompatibility surfaces as a refusal at the first
 * call, from a caller with no way to know it was structural. So the constructor
 * throws at module load, naming the field and the number.
 */

import type { ContractResult } from "@claude-bot/resource-stream-contract";
import {
  echoMatches,
  portLifecycle,
  readProposalAnswer,
  type PortLifecycle,
  type ProposalAnswer,
} from "./arrival.js";
import type { ContractDeclaration } from "./declaration.js";
import { actionOf, encodeWireParams } from "./params.js";
import type { PortReply, PortRefusal } from "./reply.js";
import type { RefusalVocabulary } from "./refusals.js";
import { RESERVED_PARAMS, wireActionOf } from "./wire.js";

/** The one method a typed port needs from an App's transport. */
export interface ProposalTransport {
  propose(action: string, params?: Record<string, string>): Promise<ProposalAnswer>;
}

/**
 * The sentences a port says when something goes wrong below its own vocabulary.
 *
 * They belong to the contract, not to the kit: they are shown to a person, they
 * are in the product's language, and a generic English string in a Chinese
 * product is worse than no string. All four are required, so a new port cannot
 * acquire a placeholder by forgetting to write one.
 */
export interface RemoteMessages {
  /** The transport rejected, or was not there at all. */
  readonly noAnswer: string;
  /** The transport answered with something that is not an answer. */
  readonly malformedAnswer: string;
  /** A refusal arrived carrying no text of its own. */
  readonly refusedWithoutReason: string;
  /** This port has been destroyed. */
  readonly closed: string;
}

/** A field of the result that has to equal a parameter of the request. */
export interface EchoRule {
  /** Field of the decoded payload. */
  readonly field: string;
  /** Parameter of the request it must equal. */
  readonly param: string;
  /** What to say when it does not. */
  readonly message: string;
}

export interface RemoteCallRequest<T, A extends string> {
  readonly action: A;
  readonly params?: Readonly<Record<string, unknown>>;
  /** The contract's own strict reader for this action's payload. */
  readonly read: (value: unknown) => ContractResult<T>;
  /** What to say when the payload fails that reader. */
  readonly malformed: string;
  readonly echo?: readonly EchoRule[];
  /**
   * Release a value that arrived after `destroy()`.
   *
   * Only needed when the value owns something — a stream, a subscription. See
   * `PortLifecycle.guard`.
   */
  readonly discard?: (value: T) => void;
}

export interface RemoteCall<C extends string, A extends string> {
  readonly declaration: ContractDeclaration<C, A>;
  readonly binding: string;
  readonly lifecycle: PortLifecycle<C>;
  readonly refusals: RefusalVocabulary<C>;
  /** The refusal every method answers with once the port is destroyed. */
  closed<T>(): PortReply<T, C>;
  /** Propose one declared action and run the arrival checks on its answer. */
  call<T>(request: RemoteCallRequest<T, A>): Promise<PortReply<T, C>>;
  /**
   * The raw answer, for callers that own their own accounting.
   *
   * The stream verbs are the reason this exists: their frames are validated by
   * `resource-stream/v1`'s envelope reader and their sizes are re-measured,
   * neither of which this generic layer can do. Everything else uses `call`.
   * The binding parameter is supplied here too, so no caller has to remember it.
   */
  ask(action: string, params: Readonly<Record<string, string>>): Promise<ProposalAnswer>;
  /** End the port: every method refuses, everything tracked is released. */
  destroy(): void;
}

export interface RemoteCallOptions<C extends string, A extends string> {
  readonly declaration: ContractDeclaration<C, A>;
  readonly transport: ProposalTransport;
  /** The App-local binding name from its `agent-resource-bindings/v1` plan. */
  readonly binding: string;
  /**
   * Which of this contract's codes means "the request was malformed".
   *
   * Stated rather than assumed, because a contract that has no such code has
   * made a decision and should say so by naming its fallback here explicitly.
   */
  readonly invalidRequest: C;
  /** Which of this contract's codes means "this port has ended". */
  readonly closed: C;
  readonly messages: RemoteMessages;
}

export function createRemoteCall<C extends string, A extends string>(
  options: RemoteCallOptions<C, A>,
): RemoteCall<C, A> {
  const { declaration, transport, binding, messages } = options;
  const refusals = declaration.refusals;

  const blocked = declaration.actionIds
    .map((id) => ({ id, problems: declaration.wireProblems[id] ?? [] }))
    .filter((row) => row.problems.length > 0);
  if (blocked.length > 0) {
    throw new Error(
      `${declaration.contract} cannot be served over the View wire: ` +
        blocked.map((row) => `${row.id} (${row.problems.join("; ")})`).join(", "),
    );
  }
  for (const action of declaration.actions) {
    for (const reserved of Object.values(RESERVED_PARAMS)) {
      if (Object.prototype.hasOwnProperty.call(action.params, reserved)) {
        // `binding`, `handle` and `seq` are the kit's. A contract that declared
        // one would have its value silently replaced on the way out.
        throw new Error(`${declaration.contract}.${action.action} declares the reserved parameter ${reserved}`);
      }
    }
  }
  if (!refusals.has(options.invalidRequest)) {
    throw new Error(`${declaration.contract} has no refusal code ${JSON.stringify(options.invalidRequest)}`);
  }
  if (!refusals.has(options.closed)) {
    throw new Error(`${declaration.contract} has no refusal code ${JSON.stringify(options.closed)}`);
  }

  const closedRefusal = (): PortRefusal<C> => refusals.refuse(options.closed, messages.closed);
  const lifecycle = portLifecycle<C>(closedRefusal);

  const ask = async (action: string, params: Readonly<Record<string, string>>): Promise<ProposalAnswer> => {
    try {
      const answer = await transport.propose(action, { [RESERVED_PARAMS.binding]: binding, ...params });
      const read = readProposalAnswer(answer);
      if (!read) return { ok: false, code: refusals.fallback, result: null, message: messages.malformedAnswer };
      return read;
    } catch {
      // Deliberately not reported: a rejection is where a stack trace lives, and
      // a stack trace is the most reliable carrier of a canonical path across
      // this boundary.
      return { ok: false, code: refusals.fallback, result: null, message: messages.noAnswer };
    }
  };

  const call = async <T,>(request: RemoteCallRequest<T, A>): Promise<PortReply<T, C>> =>
    lifecycle.guard<T>(async () => {
      const declared = actionOf(declaration, request.action);
      if (!declared) {
        // Unreachable from a contract package, because `A` makes an undeclared
        // id a compile error. Answered rather than thrown all the same: a port
        // method that threw would break the one property every consumer of this
        // kit is written against.
        return refusals.refuse(options.invalidRequest, messages.malformedAnswer);
      }
      const encoded = encodeWireParams(declared, request.params ?? {});
      if (!encoded.ok) {
        // Refused HERE, before anything is sent, with the contract's own field
        // path in the diagnostic. The far side would refuse it too, but from a
        // caller's point of view "your body is 4000 characters" is a different
        // sentence from "the notification service said no".
        return refusals.refuse(options.invalidRequest, localProblem(encoded));
      }

      const answer = await ask(wireActionOf(request.action), encoded.value);
      if (!answer.ok) return refusals.fold(answer.code, answer.message, messages.refusedWithoutReason);

      const payload = request.read(answer.result);
      if (!payload.ok) return refusals.refuse(refusals.fallback, request.malformed);

      for (const rule of request.echo ?? []) {
        const expected = encoded.value[rule.param];
        // A missing parameter is as much a failure as a mismatch: an echo rule
        // against something that was never sent proves nothing, and reading it
        // as "no expectation" is how this check quietly stops running.
        if (expected === undefined || !echoMatches(payload.value, rule.field, expected)) {
          return refusals.refuse(refusals.fallback, rule.message);
        }
      }
      return { ok: true, value: payload.value };
    }, request.discard);

  return {
    declaration,
    binding,
    lifecycle,
    refusals,
    closed: <T,>(): PortReply<T, C> => closedRefusal(),
    call,
    ask,
    destroy: () => lifecycle.destroy(),
  };
}

/**
 * A local encoding failure, as one bounded sentence.
 *
 * The issues carry field paths a developer needs; a person reading a panel needs
 * one line. Both halves are bounded already, so this only has to join them —
 * and `portRefusal` bounds the result again on the way out.
 */
function localProblem(result: ContractResult<unknown>): string {
  if (result.ok) return "";
  return result.issues.map((issue) => (issue.at ? `${issue.at}: ${issue.message}` : issue.message)).join("; ");
}
