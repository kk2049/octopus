/**
 * Getting a deck out of a projection, and saying what happened when there isn't one.
 *
 * Three answers, not two. "There is no deck at that path" and "there is
 * something at that path and it is not a deck" are different mistakes by
 * different people — the first is a composition pointing at the wrong key, the
 * second is a backend projecting the wrong shape — and a panel that renders
 * "empty" for both makes the wrong one impossible to find.
 */

import { selectPath } from "@claude-bot/agent-data-view";
import { readDeck, type ContractIssue, type DeckDocument } from "@claude-bot/deck-model-contract";

export type DeckSourceStatus = "ok" | "missing" | "invalid";

export interface DeckSource {
  status: DeckSourceStatus;
  deck: DeckDocument | null;
  /** Bounded, field-named diagnostics when `status` is `invalid`. */
  issues: readonly ContractIssue[];
}

const NONE: readonly ContractIssue[] = Object.freeze([]);

/**
 * Read the deck a composition instance points at.
 *
 * `selectPath` is `agent-data-view`'s, not a second dotted-path evaluator: an
 * App wires these modules and the data modules at the same projection with the
 * same kind of path, and two implementations of "what does `a.b` mean" is the
 * sort of difference nobody notices until one of them supports arrays.
 */
export function readDeckSource(projection: unknown, path: string): DeckSource {
  const value = selectPath(projection as Record<string, unknown> | null, path);
  if (value === undefined || value === null) return { status: "missing", deck: null, issues: NONE };
  const read = readDeck(value);
  if (!read.ok) return { status: "invalid", deck: null, issues: read.issues };
  return { status: "ok", deck: read.value, issues: NONE };
}

/**
 * The next unused `sN` id for a new slide.
 *
 * Derived from the deck rather than random, on purpose. A retry of an
 * `insert_slide` that already landed proposes the SAME id, and the contract
 * refuses a duplicate — so a double click is one slide and a loud refusal
 * rather than two slides nobody asked for. Randomness would have made the retry
 * a second slide, which is the failure this repository already fixed once for
 * session launches.
 */
export function nextSlideId(deck: DeckDocument): string {
  const taken = new Set(deck.slides.map((slide) => slide.id));
  for (let n = 1; n <= taken.size + 1; n += 1) {
    const candidate = `s${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  /* c8 ignore next -- the loop above runs size+1 times over size ids */
  return `s${taken.size + 1}`;
}
