/**
 * Fixture: an import-free projection. This file must take the bundler's
 * VERBATIM pass-through path — byte-identical to what a raw `readFileSync`
 * pack produced before bundling existed.
 */

interface SeatEvent {
  type: string;
  data?: { seat?: unknown };
}

export function project(events: ReadonlyArray<SeatEvent>) {
  return projectIncremental({ seats: [] }, events);
}

export function projectIncremental(snapshot: { seats?: unknown }, events: ReadonlyArray<SeatEvent>) {
  const seats: number[] = Array.isArray(snapshot?.seats)
    ? snapshot.seats.filter((seat): seat is number => typeof seat === "number")
    : [];
  for (const event of events) {
    if (event.type === "seat_taken" && typeof event.data?.seat === "number") seats.push(event.data.seat);
  }
  return { seats };
}
