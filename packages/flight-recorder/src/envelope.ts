/**
 * Intent envelopes: the declared temporal shape of one user-visible feature
 * (design §6 — the standing development rule).
 *
 * A feature's package exports envelopes as plain data: "after THIS action,
 * THESE events must appear within T, and THESE must not". The same
 * declaration drives the e2e gate, the production monitor and a later
 * analysing agent, which is the point — the button's meaning is written down
 * once, next to the module that renders the button.
 */

import type { FlightEvent, FlightSource } from "./recorder.js";
import type { AssertViolation, TemporalAssert } from "./asserts.js";

/** Matches an event by kind, optionally narrowed by source/key. */
export interface EnvelopeMatch {
  kind: string;
  source?: FlightSource;
  key?: string;
}

export interface IntentEnvelope {
  /** The `user.propose` action key that opens this envelope. */
  action: string;
  /** The budget for every `expect` entry, measured from the action. */
  withinMs: number;
  /** Each must appear at least once inside the budget. */
  expect: readonly EnvelopeMatch[];
  /** None may appear inside the budget. */
  forbid?: readonly EnvelopeMatch[];
}

function matches(event: FlightEvent, match: EnvelopeMatch): boolean {
  if (event.kind !== match.kind) return false;
  if (match.source !== undefined && event.source !== match.source) return false;
  if (match.key !== undefined && event.key !== match.key) return false;
  return true;
}

/**
 * Compile one envelope into a temporal assert.
 *
 * An envelope is only judged once its budget has fully elapsed (`now` past
 * `action.ts + withinMs`): judging a half-open window would report "missing"
 * for an event that is still allowed to arrive.
 */
export function envelopeAssert(envelope: IntentEnvelope): TemporalAssert {
  const name = `intent:${envelope.action}`;
  return {
    name,
    evaluate(events, now) {
      const violations: AssertViolation[] = [];
      for (let i = 0; i < events.length; i += 1) {
        const opener = events[i];
        if (opener.kind !== "user.propose" || opener.key !== envelope.action) continue;
        const deadline = opener.ts + envelope.withinMs;
        if (now <= deadline) continue;
        const window = events.filter((event) => event.ts >= opener.ts && event.ts <= deadline);
        for (const expected of envelope.expect) {
          if (window.some((event) => matches(event, expected))) continue;
          violations.push({
            assert: name,
            key: envelope.action,
            at: opener.ts,
            summary: `expected ${expected.kind}${expected.key ? `:${expected.key}` : ""} within ${envelope.withinMs}ms of ${envelope.action}`,
            delta: { action: envelope.action, missing: expected.kind, withinMs: envelope.withinMs },
          });
        }
        for (const forbidden of envelope.forbid ?? []) {
          const hit = window.find((event) => event.ts > opener.ts && matches(event, forbidden));
          if (!hit) continue;
          violations.push({
            assert: name,
            key: envelope.action,
            at: hit.ts,
            summary: `forbidden ${forbidden.kind}${forbidden.key ? `:${forbidden.key}` : ""} within ${envelope.withinMs}ms of ${envelope.action}`,
            delta: { action: envelope.action, forbidden: forbidden.kind, withinMs: envelope.withinMs },
          });
        }
      }
      return violations;
    },
  };
}
