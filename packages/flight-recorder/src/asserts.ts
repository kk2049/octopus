/**
 * Temporal asserts: pure predicates over a flight-event window
 * (design: doc/development/frontend-observability-design.md §4).
 *
 * An assert never fixes anything and never touches UI state — it turns a
 * window of semantic events into bounded violations that a monitor archives
 * and a person or agent investigates. Evaluation is pure and re-runnable: the
 * same window and clock always produce the same violations, which is what
 * lets an e2e gate, a production monitor and a later analysing agent agree.
 *
 * The vocabulary here is the machine form of `.claude/rules/frontend-stability.md`:
 * no-shrink and no-flap are the two that would have caught the #138 roster
 * flicker on day one.
 */

import type { FlightDelta, FlightEvent } from "./recorder.js";

export interface AssertViolation {
  assert: string;
  /** The semantic key the violation is about: collection, state or rid. */
  key: string;
  /** Timestamp of the event that completed the violation. */
  at: number;
  /** One bounded human sentence; never a payload. */
  summary: string;
  delta: FlightDelta;
}

export interface TemporalAssert {
  name: string;
  /** `now` is injected so pending-style asserts stay deterministic. */
  evaluate(events: readonly FlightEvent[], now: number): AssertViolation[];
}

/** Evaluate every assert over one window; order follows the assert list. */
export function evaluateAsserts(
  asserts: readonly TemporalAssert[],
  events: readonly FlightEvent[],
  now: number,
): AssertViolation[] {
  const out: AssertViolation[] = [];
  for (const assert of asserts) out.push(...assert.evaluate(events, now));
  return out;
}

/** A violation as a recordable event, so archives carry their own findings. */
export function violationEvent(violation: AssertViolation): Omit<FlightEvent, "ts"> & { ts: number } {
  return {
    ts: violation.at,
    source: "assert",
    kind: "assert.violation",
    key: violation.assert,
    delta: { ...violation.delta, key: violation.key, summary: violation.summary.slice(0, 120) },
  };
}

/** A frame event's settled/loading marker; missing means settled. */
function isSettledFrame(event: FlightEvent): boolean {
  return event.delta.resourceState !== "loading";
}

export interface NoShrinkOptions {
  /** The collection name inside `frame.projection` deltas, e.g. `sessions`. */
  collection: string;
  /** A settled frame below `previous × minRatio` is a violation. Default 0.5. */
  minRatio?: number;
  /**
   * Action keys whose `user.propose` within `exemptWindowMs` legitimises a
   * shrink — search and filters genuinely replace a list with a smaller one.
   */
  exemptActions?: readonly string[];
  exemptWindowMs?: number;
}

/**
 * A settled collection must not collapse between consecutive settled frames.
 *
 * Loading frames are progressive disclosure and are skipped entirely — the
 * host is allowed to build a frame up; it is not allowed to publish a settled
 * frame that silently loses half the rows the person was looking at.
 */
export function noShrink(options: NoShrinkOptions): TemporalAssert {
  const ratio = options.minRatio ?? 0.5;
  const exemptWindow = options.exemptWindowMs ?? 5_000;
  const exempt = new Set(options.exemptActions ?? []);
  return {
    name: `no-shrink:${options.collection}`,
    evaluate(events) {
      const violations: AssertViolation[] = [];
      let previous: { count: number; ts: number } | null = null;
      for (const event of events) {
        if (event.kind !== "frame.projection" || !isSettledFrame(event)) continue;
        const count = event.delta[options.collection];
        if (typeof count !== "number") continue;
        if (previous && count < previous.count * ratio) {
          const excused = exempt.size > 0 && events.some((candidate) =>
            candidate.kind === "user.propose"
            && exempt.has(candidate.key)
            && candidate.ts <= event.ts
            && event.ts - candidate.ts <= exemptWindow);
          if (!excused) {
            violations.push({
              assert: `no-shrink:${options.collection}`,
              key: options.collection,
              at: event.ts,
              summary: `settled ${options.collection} collapsed ${previous.count}→${count}`,
              delta: { collection: options.collection, previous: previous.count, next: count },
            });
          }
        }
        previous = { count, ts: event.ts };
      }
      return violations;
    },
  };
}

export interface NoFlapOptions {
  /** The `ui.state` key to watch, e.g. `absent`. */
  key: string;
  /** Flips tolerated inside the window. Default 3. */
  maxFlips?: number;
  windowMs?: number;
}

/**
 * An abnormal UI state may not oscillate. Each `ui.state` event whose `on`
 * differs from the previous one is a flip; more than `maxFlips` inside one
 * sliding window is the blink a person experiences as jitter.
 */
export function noFlap(options: NoFlapOptions): TemporalAssert {
  const maxFlips = options.maxFlips ?? 3;
  const windowMs = options.windowMs ?? 60_000;
  return {
    name: `no-flap:${options.key}`,
    evaluate(events) {
      const flips: number[] = [];
      let lastOn: boolean | null = null;
      const violations: AssertViolation[] = [];
      let reported = false;
      for (const event of events) {
        if (event.kind !== "ui.state" || event.key !== options.key) continue;
        const on = event.delta.on;
        if (typeof on !== "boolean") continue;
        if (lastOn !== null && on !== lastOn) {
          flips.push(event.ts);
          while (flips.length && event.ts - flips[0] > windowMs) flips.shift();
          if (flips.length > maxFlips && !reported) {
            // One violation per window walk: the finding is "it flaps", and a
            // hundred copies of it would bury the rest of the archive.
            reported = true;
            violations.push({
              assert: `no-flap:${options.key}`,
              key: options.key,
              at: event.ts,
              summary: `ui state ${options.key} flipped ${flips.length}× in ${windowMs}ms`,
              delta: { key: options.key, flips: flips.length, windowMs },
            });
          }
        }
        lastOn = on;
      }
      return violations;
    },
  };
}

export interface PendingSettlesOptions {
  /** How long a proposal may stay unanswered. */
  timeoutMs: number;
  /** Restrict to these action keys; empty means every `user.propose`. */
  actions?: readonly string[];
}

/**
 * Every proposal with a rid must be answered by SOME later event carrying the
 * same rid — a confirming frame, a refusal, an operation update — within the
 * timeout. The one still hanging past it is the spinner nobody will resolve.
 */
export function pendingSettles(options: PendingSettlesOptions): TemporalAssert {
  const actions = new Set(options.actions ?? []);
  return {
    name: "pending-settles",
    evaluate(events, now) {
      const violations: AssertViolation[] = [];
      for (let i = 0; i < events.length; i += 1) {
        const event = events[i];
        if (event.kind !== "user.propose" || !event.rid) continue;
        if (actions.size > 0 && !actions.has(event.key)) continue;
        if (now - event.ts <= options.timeoutMs) continue;
        const settled = events.some((candidate, index) =>
          index > i && candidate.rid === event.rid && candidate.kind !== "user.propose");
        if (!settled) {
          violations.push({
            assert: "pending-settles",
            key: event.rid,
            at: event.ts,
            summary: `proposal ${event.key} unanswered after ${options.timeoutMs}ms`,
            delta: { action: event.key, timeoutMs: options.timeoutMs },
          });
        }
      }
      return violations;
    },
  };
}

/**
 * Projection revisions must not go backwards: a regressed revision means a
 * stale frame overwrote a newer one, which every consumer downstream of the
 * sync layer is entitled to assume cannot happen.
 */
export function revisionMonotonic(): TemporalAssert {
  return {
    name: "revision-monotonic",
    evaluate(events) {
      const violations: AssertViolation[] = [];
      const lastByKey = new Map<string, number>();
      for (const event of events) {
        if (event.kind !== "frame.projection") continue;
        const revision = event.delta.revision;
        if (typeof revision !== "number") continue;
        const last = lastByKey.get(event.key);
        if (last !== undefined && revision < last) {
          violations.push({
            assert: "revision-monotonic",
            key: event.key,
            at: event.ts,
            summary: `revision regressed ${last}→${revision} on ${event.key}`,
            delta: { previous: last, next: revision },
          });
        }
        lastByKey.set(event.key, revision);
      }
      return violations;
    },
  };
}
