/**
 * The checks a typed port re-does when an answer arrives.
 *
 * ── Why an answer is validated again at all ────────────────────────────────
 *
 * Because "the other side is our own code" stops being true one release later,
 * and because a transport is a place where a value can be edited. These are the
 * seven classes `@claude-bot/workspace-files-contract`'s remote client arrived at
 * the hard way; each one is here as a named function so the REASON is written
 * once instead of being re-derived — or forgotten — by the next port.
 *
 *   1. The answer is an answer at all           `readProposalAnswer`
 *   2. A refusal folds into the closed set      `RefusalVocabulary.fold`
 *   3. The payload passes its own reader        (the contract's, via `remote.ts`)
 *   4. The answer is for the question asked     `echoMatches`
 *   5. Two halves of one answer corroborate     `corroborate`
 *   6. A size is measured, never believed       `stream.ts`
 *   7. The port was not destroyed mid-flight    `portLifecycle`
 *
 * They are small functions rather than a framework on purpose: a port composes
 * the ones it needs, and a reviewer can see which ones it did not.
 *
 * ── The one that is easiest to omit ────────────────────────────────────────
 *
 * Number 4. A reader cannot catch it, because the wrong answer is a perfectly
 * valid answer for somewhere else: a directory listing for `/b` passes every
 * check a listing for `/a` would, and a consumer that keys its tree on the echoed
 * ref silently reparents a subtree. Nothing but comparing against what was asked
 * finds it.
 *
 * ── The one that is easiest to get subtly wrong ────────────────────────────
 *
 * Number 7. Checking `destroyed` before the await is not enough — the interesting
 * case is a call that was ALREADY in flight when a panel unmounted, which is
 * exactly the one that would otherwise deliver data into a torn-down component.
 * And if the in-flight call produced something that owns a resource (a stream),
 * returning "gone" without closing it leaks. `PortLifecycle.guard` takes a
 * `discard` callback for that reason; a `finally` block cannot know what to do
 * with a value it does not have.
 */

import { boundedMessage, portRefusal, type PortReply, type PortRefusal } from "./reply.js";

/**
 * The Host's answer to one proposal, as an Agent View client publishes it.
 *
 * Structural rather than imported: this package does not depend on the browser
 * runtime, and a transport that is not that runtime (a test, a Node consumer,
 * an MCP bridge) satisfies the same shape.
 */
export interface ProposalAnswer {
  ok: boolean;
  code?: string;
  result?: unknown;
  /** Bounded refusal text the Host wrote, or "" when it accepted. */
  message: string;
}

/**
 * Check 1: is this an answer?
 *
 * Returns null for anything that is not one, so the caller folds it with its own
 * vocabulary instead of this function inventing a code it cannot know.
 *
 * A `message` that is not a string is as much a broken envelope as a missing
 * `ok`: every consumer renders it, and `undefined` reaching a person is a blank
 * box where an explanation should be.
 */
export function readProposalAnswer(value: unknown): ProposalAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.ok !== "boolean") return null;
  if (typeof row.message !== "string") return null;
  if (row.code !== undefined && typeof row.code !== "string") return null;
  return { ok: row.ok, code: row.code as string | undefined, result: row.result, message: row.message };
}

/**
 * Check 4: the answer must be the answer to the question asked.
 *
 * Compared as strings and nothing else — an echoed field is a value the far side
 * repeated back, and parsing it would be inventing a meaning for it.
 */
export function echoMatches(payload: unknown, field: string, expected: string): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" && value === expected;
}

/** One pair of facts that arrived together and therefore have to agree. */
export interface Corroboration {
  /** What the pair is about, for the diagnostic. */
  readonly what: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/**
 * Check 5: two halves of one answer must corroborate each other.
 *
 * Each half survives its own reader on its own; the interesting failure is the
 * one where a header describes a 40-byte file and the stream handed over
 * alongside it is something else. There is one bound worth naming: a declared
 * total is the ONLY thing that can catch a transport ending a stream early —
 * send one chunk, then an `end` frame consistent with what was sent, and nothing
 * else can tell that from a complete short file.
 *
 * Returns the first disagreement, or null. First rather than all: this is on a
 * refusal path where the consumer shows one sentence.
 */
export function corroborate(pairs: readonly Corroboration[]): string | null {
  for (const pair of pairs) {
    if (!Object.is(pair.expected, pair.actual)) return pair.what;
  }
  return null;
}

/**
 * Check 7, plus the teardown it implies.
 *
 * A port hands out things that own resources — a stream holds a handle on the
 * far side — and a composition root that unmounts a panel has to end all of them
 * at once. Both halves live here because they are the same fact seen from two
 * sides: after `destroy()`, this port neither answers nor holds anything.
 *
 * `destroy()` belongs to the App, never to a module: a module that could end its
 * own transport is a module that could end a sibling's.
 */
export interface PortLifecycle<C extends string> {
  readonly destroyed: boolean;
  /**
   * Run one call, refusing if the port was destroyed before it started or while
   * it was in flight.
   *
   * `discard` is called with an accepted value that arrived too late, so a
   * resource it owns is released rather than dropped on the floor.
   */
  guard<T>(work: () => Promise<PortReply<T, C>>, discard?: (value: T) => void): Promise<PortReply<T, C>>;
  /** Register something to release on destroy. Returns its own de-registration. */
  track(release: () => void): () => void;
  /** Idempotent. Releases everything tracked, in registration order. */
  destroy(): void;
}

export function portLifecycle<C extends string>(gone: () => PortRefusal<C>): PortLifecycle<C> {
  let destroyed = false;
  const live = new Set<() => void>();

  return {
    get destroyed() {
      return destroyed;
    },
    async guard<T>(work: () => Promise<PortReply<T, C>>, discard?: (value: T) => void): Promise<PortReply<T, C>> {
      if (destroyed) return gone();
      const reply = await work();
      if (!destroyed) return reply;
      // Checked again AFTER the await. A call already in flight when a panel
      // unmounted is exactly the one that would otherwise deliver into it.
      if (reply.ok && discard) {
        try {
          discard(reply.value);
        } catch {
          // Releasing is best effort by definition: there is nobody left to
          // tell, and a throwing release must not become the caller's problem.
        }
      }
      return gone();
    },
    track(release: () => void): () => void {
      if (destroyed) {
        // Registering against an already-dead lifecycle would otherwise leak
        // silently: nothing will ever call it.
        try {
          release();
        } catch {
          /* see above */
        }
        return () => undefined;
      }
      live.add(release);
      return () => live.delete(release);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const release of [...live]) {
        try {
          release();
        } catch {
          /* see above */
        }
      }
      live.clear();
    },
  };
}

/**
 * Fold a transport-level failure into a bounded refusal.
 *
 * `propose()` is declared to resolve, but a port is the CONSUMER of somebody
 * else's implementation of it, and every method of a typed port promises to
 * resolve. A rejection is also where a stack trace lives, which is the one thing
 * on this path that reliably carries a canonical path across the boundary — so
 * the error is dropped rather than reported.
 */
export function transportFailure<C extends string>(code: C, message: string): PortRefusal<C> {
  return portRefusal(code, message);
}

/** Bounded text for a diagnostic that came from somewhere else. Re-exported for ports. */
export { boundedMessage };
