/**
 * "Given a port implementation, run the contract's own properties against it."
 *
 * ── Why a shared harness and not per-port assertions ───────────────────────
 *
 * Because the properties are the same every time, and the ones most likely to be
 * missing are the ones nobody thinks to write. Every port in this family promises
 * that *every method resolves* — that is the load-bearing claim behind "a refusal
 * is something to show a person, not an exception to catch" — and there is
 * currently no port whose test suite proves it for every method. A harness that
 * calls each declared action once, with the worst inputs the declaration permits,
 * proves it by construction.
 *
 * ── Why it returns findings instead of asserting ───────────────────────────
 *
 * This package has no test framework and must not acquire one: it is imported by
 * browser bundles and by a Node release adapter, and a `vitest` import in either
 * is a dependency neither should have. So the harness produces data and
 * `assertConformant` turns it into one thrown error with everything in it — which
 * also reads better than N separate failures when a port is simply not wired yet.
 *
 * ── What it cannot check, said plainly ─────────────────────────────────────
 *
 * It cannot check that a refusal is TRUE. A port that answers `unavailable` to
 * everything conforms perfectly. What it checks is that the port is answerable,
 * enumerable and bounded — the properties a consumer's code depends on. Whether
 * the answer is right is what the contract package's own tests are for, and it is
 * why `scriptedTransport` is here too: those tests need a transport that lies in
 * a specific way, and hand-rolling one per port is how two of them end up lying
 * slightly differently.
 */

import type { ProposalAnswer } from "./arrival.js";
import type { ContractBound, ContractDeclaration } from "./declaration.js";
import { encodeWireParams } from "./params.js";
import type { PortReply } from "./reply.js";
import type { ProposalTransport } from "./remote.js";

export interface ConformanceFinding {
  /** What was checked. Stable text, so a suppression list is possible. */
  readonly check: string;
  readonly ok: boolean;
  /** Bounded, only when `ok` is false. */
  readonly detail?: string;
}

export interface PortConformanceOptions<C extends string, A extends string> {
  readonly declaration: ContractDeclaration<C, A>;
  /** The port under test. Only its `contract` field is read directly. */
  readonly port: ContractBound<string>;
  /**
   * Call one declared action on the port under test.
   *
   * A function rather than a generic `port.call(...)`, because a typed port
   * deliberately has no such method — the point of the whole design is that a
   * consumer names operations by method. The adapter a test writes here is three
   * lines of switch and it is also the proof that every declared action has a
   * method at all.
   */
  invoke(action: A, params: Readonly<Record<string, unknown>>): Promise<PortReply<unknown, C>>;
  /**
   * A valid argument set per action.
   *
   * Absent for an action means "skip it and say so" rather than "pass": a
   * conformance report that silently omits half a contract is worse than one
   * that fails.
   */
  readonly samples: Readonly<Partial<Record<A, Readonly<Record<string, unknown>>>>>;
}

/**
 * Run the contract's properties against one port implementation.
 *
 * Never throws, including when the port does — a thrown method is the single
 * most important finding this harness produces, and a harness that propagated it
 * would report nothing else.
 */
export async function runPortConformance<C extends string, A extends string>(
  options: PortConformanceOptions<C, A>,
): Promise<readonly ConformanceFinding[]> {
  const { declaration, port, samples } = options;
  const findings: ConformanceFinding[] = [];
  const record = (check: string, ok: boolean, detail?: string): void => {
    findings.push(ok ? { check, ok } : { check, ok, detail: detail ?? "" });
  };

  record(
    "port states its contract",
    port.contract === declaration.contract,
    `port.contract is ${JSON.stringify(port.contract)}, declaration says ${JSON.stringify(declaration.contract)}`,
  );

  for (const action of declaration.actionIds) {
    const sample = samples[action];
    if (sample === undefined) {
      record(`${action}: has a sample`, false, "no sample was supplied, so this action was not exercised");
      continue;
    }

    // The sample must itself satisfy the declaration; a sample that does not is
    // a test that proves the port refuses malformed input, not that it works.
    const encoded = encodeWireParams(declaration.byAction[action], sample);
    record(
      `${action}: sample satisfies the declaration`,
      encoded.ok,
      encoded.ok ? "" : encoded.issues.map((issue) => `${issue.at ?? ""} ${issue.message}`).join("; "),
    );

    const reply = await settle(() => options.invoke(action, sample));
    if (!reply.resolved) {
      record(`${action}: resolves`, false, `the method threw or rejected: ${reply.detail}`);
      continue;
    }
    record(`${action}: resolves`, true);

    const value = reply.value;
    if (!isReply(value)) {
      record(`${action}: answers with a reply envelope`, false, `answered with ${describe(value)}`);
      continue;
    }
    record(`${action}: answers with a reply envelope`, true);

    if (value.ok === false) {
      record(
        `${action}: refusal code is in the closed set`,
        declaration.refusals.has(value.code),
        `code ${JSON.stringify(value.code)} is not one of ${declaration.refusals.codes.join(", ")}`,
      );
      const bounded =
        typeof value.message === "string"
          && value.message.length <= declaration.refusals.maxMessageLength
          && !/[\u0000-\u001f\u007f]/.test(value.message);
      record(
        `${action}: refusal message is bounded and printable`,
        bounded,
        `message is ${typeof value.message === "string" ? `${value.message.length} characters` : typeof value.message}`,
      );
    } else {
      record(`${action}: accepted reply carries a value key`, "value" in value, "an ok reply has no `value`");
    }
  }

  // A method that is handed nothing at all must still resolve. This is the case
  // a hand-written suite reliably skips, and it is the one a consumer reaches
  // first when a component's state has not loaded yet.
  for (const action of declaration.actionIds) {
    const reply = await settle(() => options.invoke(action, {}));
    record(`${action}: resolves for empty arguments`, reply.resolved, reply.resolved ? "" : reply.detail);
    if (reply.resolved && isReply(reply.value) && reply.value.ok === false) {
      record(
        `${action}: empty arguments refuse inside the closed set`,
        declaration.refusals.has(reply.value.code),
        `code ${JSON.stringify(reply.value.code)} is not one of ${declaration.refusals.codes.join(", ")}`,
      );
    }
  }

  return findings;
}

/** Turn a conformance report into one thrown error, or nothing. */
export function assertConformant(findings: readonly ConformanceFinding[]): void {
  const failed = findings.filter((finding) => !finding.ok);
  if (failed.length === 0) return;
  throw new Error(
    `${failed.length} of ${findings.length} conformance checks failed:\n` +
      failed.map((finding) => `  - ${finding.check}: ${finding.detail ?? ""}`).join("\n"),
  );
}

type Settled = { resolved: true; value: unknown } | { resolved: false; detail: string };

async function settle(work: () => Promise<unknown>): Promise<Settled> {
  try {
    return { resolved: true, value: await work() };
  } catch (error) {
    // The message is kept here and nowhere else: a conformance report is read by
    // a developer running a test, not shipped across a boundary.
    return { resolved: false, detail: error instanceof Error ? error.message : describe(error) };
  }
}

function isReply(value: unknown): value is { ok: boolean; code: string; message: string; value?: unknown } {
  return Boolean(value) && typeof value === "object" && typeof (value as { ok?: unknown }).ok === "boolean";
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

// ── a transport that lies, for the tests a contract package writes ──

export interface ScriptedTransport {
  readonly transport: ProposalTransport;
  /** Every proposal this transport was given, in order. */
  readonly calls: readonly { readonly action: string; readonly params: Readonly<Record<string, string>> }[];
}

/**
 * One scripted answer.
 *
 * `"reject"` is its own case rather than an answer, because "the transport threw"
 * is a different code path from "the transport said no" and it is the one that
 * carries a stack trace. Every port has to fold it, and no port's own test would
 * think to produce it without a helper that makes it one word.
 */
export type ScriptedAnswer =
  | ProposalAnswer
  | "reject"
  /** Anything at all — a string, null, an array — to exercise the envelope fold. */
  | { readonly malformed: unknown };

export type TransportScript = Readonly<
  Record<string, ScriptedAnswer | ((params: Readonly<Record<string, string>>, nth: number) => ScriptedAnswer)>
>;

/**
 * A transport whose answers are written down.
 *
 * An action the script does not name answers a bounded `unavailable`, because
 * that is what an unimplemented far side does; throwing would make every test
 * that forgot one action fail for the wrong reason.
 */
export function scriptedTransport(script: TransportScript): ScriptedTransport {
  const calls: { action: string; params: Readonly<Record<string, string>> }[] = [];
  const counts = new Map<string, number>();

  return {
    calls,
    transport: {
      async propose(action: string, params?: Record<string, string>): Promise<ProposalAnswer> {
        const given = Object.freeze({ ...(params ?? {}) });
        calls.push({ action, params: given });
        const nth = counts.get(action) ?? 0;
        counts.set(action, nth + 1);

        const entry = Object.prototype.hasOwnProperty.call(script, action) ? script[action] : undefined;
        if (entry === undefined) {
          return { ok: false, code: "unavailable", result: null, message: "scripted transport has no answer" };
        }
        const answer = typeof entry === "function" ? entry(given, nth) : entry;
        if (answer === "reject") throw new Error("scripted transport rejected");
        if (typeof answer === "object" && answer !== null && "malformed" in answer) {
          return (answer as { malformed: unknown }).malformed as ProposalAnswer;
        }
        return answer as ProposalAnswer;
      },
    },
  };
}

/** The common accepted answer, so a test writes one word instead of four fields. */
export function answers(result: unknown): ProposalAnswer {
  return { ok: true, result, message: "" };
}

/** The common refusal answer. */
export function refuses(code: string, message = "no"): ProposalAnswer {
  return { ok: false, code, result: null, message };
}
