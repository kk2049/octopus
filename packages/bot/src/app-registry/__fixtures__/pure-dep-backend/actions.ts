/**
 * Fixture: a declared-app backend written the way ADR 0007 P6 promises —
 * against a PURE npm dependency (`eventemitter3`, a real package this
 * repository already installs; the owning package's `package.json` declares
 * it) plus the app's own second file. The pack-time bundler must inline both
 * into one self-contained module the SES Compartment accepts; the runtime
 * still forbids every import.
 *
 * The `.js` specifier for a `.ts` neighbour is the repository's normal ESM/TS
 * convention; esbuild resolves it the same way tsc does.
 */

import { EventEmitter } from "eventemitter3";
import { ARROW_TEMPLATE, clampSeat, countDown } from "./rules.js";

interface ActionContext {
  now?: unknown;
}

export function take_seat(ctx: ActionContext, params: { seat?: unknown }) {
  // A deliberately dependency-shaped use: route the domain event through the
  // pure emitter so the bundled dep demonstrably EXECUTES inside the sandbox,
  // not merely parses.
  const bus = new EventEmitter();
  const taken: number[] = [];
  bus.on("taken", (seat: number) => {
    taken.push(seat);
  });
  bus.emit("taken", clampSeat(params?.seat));
  return {
    events: taken.map((seat) => ({
      type: "seat_taken",
      // The censor-bait exports EXECUTE here (not merely parse): the string
      // with " --> "/"<!--" and the `i-->0` loop must both survive the
      // evasive transform semantically intact all the way through real SES.
      data: { seat, note: ARROW_TEMPLATE, steps: countDown(seat) },
      at: String(ctx?.now ?? ""),
      by: "pure-dep-backend",
    })),
  };
}
