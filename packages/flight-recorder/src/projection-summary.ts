/**
 * The one summariser every projection-frame event shares.
 *
 * "Record the summary, not the content" (design §3) only holds if the summary
 * is computed by ONE tested function rather than re-invented at each emitter —
 * two hosts summarising differently would produce two timelines that mostly
 * agree, which is worse for an analysing agent than none. The caller names
 * which top-level keys are collections; this module never guesses and never
 * reads anything it was not pointed at.
 */

import type { FlightDelta } from "./recorder.js";

/** The semantic facts one frame contributes to the timeline. */
export interface ProjectionFrameFacts {
  /** Host-owned monotonic frame number, when the surface has one. */
  revision?: number;
  /** The frame's own settled/loading marker, verbatim (e.g. `resourceState`). */
  resourceState?: string;
  /** Row count per named collection; a missing key is absent, not zero. */
  collections: Readonly<Record<string, number>>;
}

/**
 * Read the named facts out of an untyped projection.
 *
 * Only keys in `collections` are touched, and only arrays count — an absent or
 * differently-shaped key is honestly absent in the facts, because "the frame
 * did not carry this collection" and "it carried zero rows" are different
 * statements to a shrink assert.
 */
export function projectionFacts(
  projection: unknown,
  options: {
    collections: readonly string[];
    revision?: number;
    /** Which top-level string field carries the settled/loading marker. */
    resourceStateKey?: string;
  },
): ProjectionFrameFacts {
  const record = asRecord(projection);
  const collections: Record<string, number> = {};
  for (const name of options.collections) {
    const value = record[name];
    if (Array.isArray(value)) collections[name] = value.length;
  }
  const stateKey = options.resourceStateKey ?? "resourceState";
  const state = record[stateKey];
  return {
    ...(options.revision === undefined ? {} : { revision: options.revision }),
    ...(typeof state === "string" ? { resourceState: state } : {}),
    collections,
  };
}

/**
 * The bounded delta for one `frame.projection` event.
 *
 * Emits each collection's count, plus `<name>.prev` only when a previous frame
 * carried the collection at a different size — so a no-change frame stays one
 * flat list of counts and a shrink is visible in a single event without the
 * analyser replaying history.
 */
export function summarizeProjectionFrame(
  previous: ProjectionFrameFacts | null,
  next: ProjectionFrameFacts,
): FlightDelta {
  const out: Record<string, string | number | boolean> = {};
  if (next.revision !== undefined) out.revision = next.revision;
  if (next.resourceState !== undefined) out.resourceState = next.resourceState;
  for (const [name, size] of Object.entries(next.collections)) {
    out[name] = size;
    const before = previous?.collections[name];
    if (before !== undefined && before !== size) out[`${name}.prev`] = before;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
