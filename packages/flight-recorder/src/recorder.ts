/**
 * The frontend flight recorder: a bounded, business-agnostic semantic event
 * stream (design: doc/development/frontend-observability-design.md §3).
 *
 * What a record IS: a timestamped semantic fact — "the person proposed this
 * action", "a projection frame with these collection counts arrived", "this
 * abnormal UI state flipped on". What it is NOT: a payload log. Every field is
 * bounded HERE, at admission, because the emitters live in more than one trust
 * domain and a recorder that trusts its callers to truncate is a recorder that
 * eventually ships a transcript in a delta field.
 *
 * Dependency-free on purpose: the trusted dashboard host and the untrusted
 * Agent View runtime both import this package, and anything it pulled in would
 * be pulled into an App View bundle. It holds no authority, caches no
 * capability results, and never talks to a network — it is memory that a
 * surface may choose to export.
 */

/** Where an event was observed, not who is to blame for it. */
export type FlightSource = "user" | "frame" | "wire" | "ui" | "assert";

/** Bounded primitive facts about one event; never a payload. */
export type FlightDelta = Readonly<Record<string, string | number | boolean>>;

export interface FlightEvent {
  /** Milliseconds; the recorder's injected clock, one per trust domain. */
  ts: number;
  source: FlightSource;
  /** Closed vocabulary, e.g. `user.propose` / `frame.projection` / `ui.state`. */
  kind: string;
  /** Semantic key: an action id, a surface name, an abnormal-state name. */
  key: string;
  delta: FlightDelta;
  /** Correlation id (proposal rid / opId) aligning this stream with audits. */
  rid?: string;
}

export interface FlightRecorderOptions {
  /** Retained events; the oldest fall off. Default 4096. */
  capacity?: number;
  /** Ceiling for every string field and delta value. Default 120. */
  maxStringLength?: number;
  /** Delta entries admitted per event, in insertion order. Default 16. */
  maxDeltaEntries?: number;
  /** Injectable clock so tests and replay stay deterministic. */
  now?: () => number;
}

export interface FlightRecorder {
  /** Admit one event; every field is bounded on the way in. */
  record(event: Omit<FlightEvent, "ts"> & { ts?: number }): void;
  /** Oldest-first snapshot of the retained window. */
  events(): readonly FlightEvent[];
  /** The retained window as one JSON blob for archiving or a ticket. */
  export(): string;
  size(): number;
  clear(): void;
}

/** The export envelope version; bump only with a documented migration. */
export const FLIGHT_EXPORT_VERSION = 1;

const DEFAULT_CAPACITY = 4096;
const DEFAULT_MAX_STRING = 120;
const DEFAULT_MAX_DELTA_ENTRIES = 16;

export function createFlightRecorder(options: FlightRecorderOptions = {}): FlightRecorder {
  const capacity = boundedCapacity(options.capacity);
  const maxString = boundedPositive(options.maxStringLength, DEFAULT_MAX_STRING);
  const maxEntries = boundedPositive(options.maxDeltaEntries, DEFAULT_MAX_DELTA_ENTRIES);
  const now = options.now ?? Date.now;
  // A circular buffer rather than push/shift: the recorder runs on every frame
  // of a busy surface, and eviction must stay O(1) at any capacity.
  const ring: Array<FlightEvent | undefined> = new Array(capacity);
  let next = 0;
  let count = 0;

  const record = (event: Omit<FlightEvent, "ts"> & { ts?: number }): void => {
    const admitted: FlightEvent = {
      ts: typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : now(),
      source: event.source,
      kind: boundedString(event.kind, maxString),
      key: boundedString(event.key, maxString),
      delta: boundedDelta(event.delta, maxString, maxEntries),
      ...(event.rid ? { rid: boundedString(event.rid, maxString) } : {}),
    };
    ring[next] = admitted;
    next = (next + 1) % capacity;
    if (count < capacity) count += 1;
  };

  const events = (): readonly FlightEvent[] => {
    const out: FlightEvent[] = [];
    const start = count < capacity ? 0 : next;
    for (let i = 0; i < count; i += 1) {
      const event = ring[(start + i) % capacity];
      if (event) out.push(event);
    }
    return out;
  };

  return {
    record,
    events,
    export: () => JSON.stringify({
      version: FLIGHT_EXPORT_VERSION,
      exportedAt: now(),
      events: events(),
    }),
    size: () => count,
    clear: () => {
      ring.fill(undefined);
      next = 0;
      count = 0;
    },
  };
}

/**
 * Copy a delta into bounded primitives.
 *
 * Anything that is not a string/number/boolean is dropped rather than
 * serialised: an object graph in a delta is exactly the payload this recorder
 * exists to refuse, and stringifying it would smuggle it through the bound.
 */
function boundedDelta(
  delta: Readonly<Record<string, unknown>> | undefined,
  maxString: number,
  maxEntries: number,
): FlightDelta {
  const out: Record<string, string | number | boolean> = {};
  if (!delta) return out;
  let taken = 0;
  for (const [key, value] of Object.entries(delta)) {
    if (taken >= maxEntries) break;
    if (typeof value === "string") out[boundedString(key, maxString)] = boundedString(value, maxString);
    else if (typeof value === "number" && Number.isFinite(value)) out[boundedString(key, maxString)] = value;
    else if (typeof value === "boolean") out[boundedString(key, maxString)] = value;
    else continue;
    taken += 1;
  }
  return out;
}

function boundedString(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > max ? text.slice(0, max) : text;
}

function boundedCapacity(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value)) return DEFAULT_CAPACITY;
  return Math.min(65_536, Math.max(16, value));
}

function boundedPositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return fallback;
  return value;
}
