/**
 * The deck model fits the channel it is edited over.
 *
 * ── Why this file exists here and not in either package ────────────────────
 *
 * `deck-model-contract` states its own bounds and does not know what a proposal
 * is; `agent-data-view` states the transport's and does not know what a deck is.
 * Neither can check the relationship, and the relationship is load-bearing:
 *
 *   · a text field the model accepts but the wire truncates would be a deck that
 *     READS and cannot be EDITED — the reader would accept a value no `set_text`
 *     could ever replace, and the editor would look broken for a reason nothing
 *     on screen explains;
 *   · a command with more keys than a proposal carries would be an edit that is
 *     silently dropped at the boundary.
 *
 * This package is the first thing that depends on both, so it is where the two
 * constants are compared. Two numbers that are equal by coincidence are two
 * numbers that will drift.
 */

import { describe, expect, it } from "vitest";
import { APP_DATA_LIMITS } from "@claude-bot/agent-data-view/port";
import {
  DECK_LIMITS,
  DECK_WIRE_KEYS,
  encodeDeckCommand,
  readDeckCommand,
  type WireDeckCommand,
} from "@claude-bot/deck-model-contract";

/** One of every command a View can build, with values at their bounds. */
const AT_THE_BOUND: readonly WireDeckCommand[] = [
  { op: "set_deck_title", value: "x".repeat(DECK_LIMITS.maxTextLength) },
  { op: "set_theme", value: "dark" },
  { op: "set_text", slide: "s".repeat(DECK_LIMITS.maxIdLength), field: "image.alt", value: "y".repeat(DECK_LIMITS.maxTextLength) },
  { op: "set_text", slide: "s1", field: "bullets", index: DECK_LIMITS.maxListItems - 1, value: "z".repeat(DECK_LIMITS.maxTextLength) },
  { op: "insert_item", slide: "s1", field: "right", index: DECK_LIMITS.maxListItems, value: "w".repeat(DECK_LIMITS.maxTextLength) },
  { op: "remove_item", slide: "s1", field: "left", index: 0 },
  { op: "insert_slide", slide: "s99", layout: "image-ref", index: DECK_LIMITS.maxSlides - 1 },
  { op: "move_slide", slide: "s1", index: DECK_LIMITS.maxSlides - 1 },
  { op: "remove_slide", slide: "s1" },
];

describe("deck-model/v1 against the app-data/v1 transport", () => {
  it("uses no more keys than a proposal carries", () => {
    expect(DECK_WIRE_KEYS.length).toBeLessThanOrEqual(APP_DATA_LIMITS.maxFields);
  });

  it("bounds its text at or below what a proposal value carries", () => {
    expect(DECK_LIMITS.maxTextLength).toBeLessThanOrEqual(APP_DATA_LIMITS.maxValueLength);
    // Ids and refs ride in the same values, so they are bounded too.
    expect(DECK_LIMITS.maxIdLength).toBeLessThanOrEqual(APP_DATA_LIMITS.maxValueLength);
    expect(DECK_LIMITS.maxRefLength).toBeLessThanOrEqual(APP_DATA_LIMITS.maxValueLength);
  });

  it("encodes a maximal command inside the transport's bounds, and reads it back", () => {
    for (const command of AT_THE_BOUND) {
      const params = encodeDeckCommand(command)!;
      expect(params, command.op).not.toBeNull();
      expect(Object.keys(params).length, command.op).toBeLessThanOrEqual(APP_DATA_LIMITS.maxFields);
      for (const [key, value] of Object.entries(params)) {
        expect(value.length, `${command.op}.${key}`).toBeLessThanOrEqual(APP_DATA_LIMITS.maxValueLength);
      }
      const read = readDeckCommand(params);
      expect(read.ok, `${command.op}: ${JSON.stringify(read)}`).toBe(true);
      expect((read as { ok: true; value: WireDeckCommand }).value).toEqual(command);
    }
  });

  it("keeps a whole slide outside one proposal value", () => {
    // The command grammar carries one bounded scalar per value and deliberately
    // has no chunking. A maximal `bullets` slide therefore cannot be smuggled in
    // as one JSON value when adding a client-side `restore_slide` command.
    const worstSlide = DECK_LIMITS.maxListItems * DECK_LIMITS.maxTextLength + 2 * DECK_LIMITS.maxTextLength;
    expect(worstSlide).toBeGreaterThan(APP_DATA_LIMITS.maxValueLength);
  });

  it("cannot carry a whole DECK either, which is why writes are commands", () => {
    // The other half of the same arithmetic, and the reason an App's event log
    // holds semantic commands rather than deck snapshots.
    const worstDeck = DECK_LIMITS.maxSlides * DECK_LIMITS.maxTextLength;
    expect(worstDeck).toBeGreaterThan(APP_DATA_LIMITS.maxFields * APP_DATA_LIMITS.maxValueLength);
  });
});
