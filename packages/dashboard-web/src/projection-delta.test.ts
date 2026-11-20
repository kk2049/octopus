import { describe, expect, it } from "vitest";
import {
  applyProjectionPatch,
  diffProjection,
  readProjectionPatchFrame,
  sameProjectionJson,
  type ProjectionPatchOp,
} from "./projection-delta.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** What a browser holds: the JSON text of the server's value, parsed. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Diff on the server's objects, apply to the receiver's parsed copy, compare JSON text. */
function roundTrip(previous: unknown, next: unknown): { ops: ProjectionPatchOp[]; bytes: number } {
  const ops = diffProjection(previous, next);
  const serverSide = applyProjectionPatch(deepFreeze(previous), ops);
  expect(serverSide.ok).toBe(true);
  expect(JSON.stringify(serverSide.ok ? serverSide.value : null)).toBe(JSON.stringify(next));
  const received = deepFreeze(wire(previous));
  const clientSide = applyProjectionPatch(received, wire(ops));
  expect(clientSide.ok).toBe(true);
  expect(JSON.stringify(clientSide.ok ? clientSide.value : null)).toBe(JSON.stringify(next));
  return { ops, bytes: JSON.stringify(ops).length };
}

describe("projection delta codec", () => {
  it("is empty for equal projections, shared or rebuilt", () => {
    const projection = { sessions: [{ id: "a", title: "x" }], transcript: { a: { messages: [1, 2, 3] } } };
    expect(diffProjection(projection, projection)).toEqual([]);
    expect(diffProjection(projection, wire(projection))).toEqual([]);
    expect(sameProjectionJson(projection, wire(projection))).toBe(true);
  });

  it("sets, adds and removes object members and keeps engine key order", () => {
    roundTrip({ a: 1, b: { c: 2 }, d: "x" }, { a: 1, b: { c: 3 }, e: true });
    roundTrip({ a: 1 }, { z: 0, a: 1 }); // a new key ahead of an old one needs a reorder
    roundTrip({ a: 1, b: 2, c: 3 }, { c: 3, a: 1, b: 2 });
    roundTrip({ x: 1, 10: "ten", 2: "two" }, { 2: "two", y: 2, 1: "one", x: 1 });
    roundTrip({ a: 1, gone: undefined }, { a: 1, gone: 2 });
    roundTrip({ a: 1, b: 2 }, { a: 1, b: undefined });
  });

  it("moves a touched transcript to the end of its LRU map", () => {
    const window = (id: string) => ({ messages: [{ id, text: id.repeat(100) }], offset: 0 });
    const before = { transcript: { a: window("a"), b: window("b"), c: window("c") } };
    const after = { transcript: { a: before.transcript.a, c: before.transcript.c, b: { ...before.transcript.b, offset: 1 } } };
    const { ops, bytes } = roundTrip(before, after);
    expect(ops.some((op) => op[0] === "k")).toBe(true);
    expect(bytes).toBeLessThan(120);
  });

  it("appends to and edits the tail of a transcript window in place", () => {
    const messages = Array.from({ length: 300 }, (_, index) => ({ role: "assistant", text: `message ${index} `.repeat(40), blocks: [{ type: "tool", input: index }] }));
    const before = { transcript: { s: { messages, totalMessages: 300 } } };
    const grown = wire(before);
    grown.transcript.s.messages[299].blocks[0] = { type: "tool", input: 299, output: "done" } as never;
    grown.transcript.s.messages.push({ role: "user", text: "next", blocks: [] });
    grown.transcript.s.totalMessages = 301;
    const { bytes } = roundTrip(before, grown);
    expect(bytes).toBeLessThan(300);
  });

  it("handles prepends, capped prepends, removals and reorders in arrays", () => {
    const row = (id: number) => ({ id: `op-${id}`, status: "succeeded", operation: "append_session", detail: `detail ${id}`.repeat(10) });
    const capped = Array.from({ length: 100 }, (_, index) => row(index));
    const prepended = [row(1000), ...capped.slice(0, 99)];
    expect(roundTrip({ operations: capped }, { operations: prepended }).bytes).toBeLessThan(400);
    expect(roundTrip({ operations: capped.slice(0, 50) }, { operations: [row(1000), ...capped.slice(0, 50)] }).bytes).toBeLessThan(400);
    expect(roundTrip({ operations: capped }, { operations: capped.filter((_, index) => index !== 40) }).bytes).toBeLessThan(80);
    roundTrip({ list: [1, 2, 3, 4, 5] }, { list: [5, 4, 3, 2, 1] });
    roundTrip({ list: [1, 2, 3] }, { list: [] });
    roundTrip({ list: [] }, { list: [1, 2, 3] });
    roundTrip({ list: [1, [2, [3]]] }, { list: [1, [2, [3, 4]], 5] });
    roundTrip({ list: [1, undefined, 3] }, { list: [1, null, 3, undefined] });
  });

  it("replaces a reordered roster row whole instead of editing every member", () => {
    const session = (id: number) => ({ resourceId: `r-${id}`, title: `title ${id}`, preview: `preview ${id} `.repeat(30), status: "idle", sortActivity: `2026-10-15T00:00:0${id}Z` });
    const before = { sessions: [0, 1, 2, 3, 4, 5].map(session) };
    const after = { sessions: [5, 0, 1, 2, 3, 4].map(session) };
    after.sessions[0].status = "running";
    const { ops } = roundTrip(before, after);
    expect(ops.length).toBeLessThan(4);
  });

  it("replaces values of a different kind and the root", () => {
    roundTrip({ a: [1, 2] }, { a: { 0: 1 } });
    roundTrip({ a: "x" }, { a: null });
    roundTrip([1, 2], { root: true });
    roundTrip({ a: 1 }, "text");
    roundTrip(null, { a: 1 });
  });

  it("round-trips randomized projections and never mutates the base", () => {
    let seed = 0x5eed;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
    const keys = ["a", "b", "c", "id", "text", "0", "7", "messages", "__proto__", "constructor", "toString"];
    const value = (depth: number): unknown => {
      const roll = random();
      if (depth > 3 || roll < 0.35) return pick([0, 1, -1, 2.5, "", "x", "长文本", true, false, null]);
      if (roll < 0.65) return Array.from({ length: Math.floor(random() * 6) }, () => value(depth + 1));
      const object: Record<string, unknown> = {};
      for (let index = Math.floor(random() * 5); index > 0; index -= 1) {
        Object.defineProperty(object, pick(keys), { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return object;
    };
    const mutate = (input: unknown, depth: number): unknown => {
      if (random() < 0.15) return value(depth);
      if (Array.isArray(input)) {
        const copy = input.map((entry) => (random() < 0.3 ? mutate(entry, depth + 1) : entry));
        const roll = random();
        if (roll < 0.2) copy.unshift(value(depth + 1));
        else if (roll < 0.4) copy.push(value(depth + 1));
        else if (roll < 0.55 && copy.length) copy.splice(Math.floor(random() * copy.length), 1);
        else if (roll < 0.65) copy.reverse();
        return copy;
      }
      if (input && typeof input === "object") {
        const entries = Object.entries(input).filter(() => random() > 0.15)
          .map(([key, entry]) => [key, random() < 0.4 ? mutate(entry, depth + 1) : entry] as const);
        if (random() < 0.3) entries.reverse();
        if (random() < 0.3) entries.push([pick(keys), value(depth + 1)]);
        const object: Record<string, unknown> = {};
        for (const [key, entry] of entries) {
          Object.defineProperty(object, key, { value: entry, enumerable: true, writable: true, configurable: true });
        }
        return object;
      }
      return random() < 0.5 ? input : value(depth);
    };
    for (let round = 0; round < 1_500; round += 1) {
      const previous = value(0);
      let current = previous;
      for (let step = 0; step < 3; step += 1) {
        const next = mutate(current, 0);
        roundTrip(current, next);
        current = next;
      }
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses a patch that does not address its base exactly, without touching it", () => {
    const base = deepFreeze({ a: { b: [1, 2, 3] }, c: "x" });
    const refused: unknown[] = [
      "not a list",
      [["=", ["missing", "deeper"], 1]],
      [["=", ["a", "b", 3], 4]],
      [["=", ["a", "b", "0"], 4]],
      [["=", ["a", 0], 4]],
      [["-", ["a", "nope"]]],
      [["-", ["a", "b", 0]]],
      [["-", []]],
      [["~", ["a", "b"], 2, 1, []]],
      [["~", ["a", "b"], 0, 4, []]],
      [["~", ["a"], 0, 0, []]],
      [["k", ["a"], ["c"]]],
      [["k", [], ["a"]]],
      [["k", [], ["a", "a"]]],
      [["?", ["a"], 1]],
      [["=", "a", 1]],
      [["=", ["c", "length"], 1]],
      [["=", ["__proto__", "polluted"], true]],
      [["=", ["constructor", "prototype", "polluted"], true]],
    ];
    for (const patch of refused) {
      expect(applyProjectionPatch(base, patch).ok, JSON.stringify(patch)).toBe(false);
    }
    expect(base).toEqual({ a: { b: [1, 2, 3] }, c: "x" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps an own __proto__ member a plain member", () => {
    const base = JSON.parse('{"__proto__":{"x":1},"y":2}') as Record<string, unknown>;
    const result = applyProjectionPatch(base, [["=", ["__proto__", "x"], 5], ["=", ["__proto__", "polluted"], true]]);
    expect(result.ok).toBe(true);
    const value = (result as { value: Record<string, unknown> }).value;
    expect(JSON.stringify(value)).toBe('{"__proto__":{"x":5,"polluted":true},"y":2}');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("shares untouched subtrees with the base", () => {
    const base = deepFreeze({ big: { rows: [1, 2, 3] }, small: { n: 1 } });
    const result = applyProjectionPatch(base, [["=", ["small", "n"], 2]]);
    expect(result.ok).toBe(true);
    const value = (result as { value: typeof base }).value;
    expect(value.big).toBe(base.big);
    expect(value.small).not.toBe(base.small);
  });

  it("reads only well-formed patch frames", () => {
    expect(readProjectionPatchFrame({ revision: 4, base: 3, patch: [] })).toEqual({ revision: 4, base: 3, patch: [] });
    expect(readProjectionPatchFrame({ revision: 4, base: 3 })).toBeNull();
    expect(readProjectionPatchFrame({ revision: "4", base: 3, patch: [] })).toBeNull();
    expect(readProjectionPatchFrame({ revision: 4, base: -1, patch: [] })).toBeNull();
    expect(readProjectionPatchFrame([])).toBeNull();
  });
});
