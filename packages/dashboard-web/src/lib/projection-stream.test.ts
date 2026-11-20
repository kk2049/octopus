import { describe, expect, it } from "vitest";
import { PROJECTION_BASE_HEADER, PROJECTION_DELTA_HEADER, PROJECTION_PATCH_EVENT } from "../projection-delta.js";
import { createProjectionStream } from "./projection-stream.js";

describe("projection stream decoder", () => {
  it("asks for patches and rebuilds each frame on the previous one", () => {
    const stream = createProjectionStream();
    expect(stream.headers()).toEqual({ [PROJECTION_DELTA_HEADER]: "1" });

    const base = { pinned: [], sessions: [{ id: "a" }] };
    expect(stream.read("view", { type: "view", revision: 5, projection: base })).toEqual({ projection: base, revision: 5 });
    const next = stream.read(PROJECTION_PATCH_EVENT, { revision: 6, base: 5, patch: [["=", ["pinned"], ["a"]]] });
    expect(next).toEqual({ projection: { pinned: ["a"], sessions: [{ id: "a" }] }, revision: 6 });
    expect((next?.projection as typeof base).sessions).toBe(base.sessions);
    expect(base.pinned).toEqual([]);
    expect(stream.read(PROJECTION_PATCH_EVENT, { revision: 7, base: 6, patch: [] })).toEqual({ projection: next?.projection, revision: 7 });
  });

  it("ignores events that carry no projection", () => {
    const stream = createProjectionStream();
    expect(stream.read("op", { operation: { id: "x" } })).toBeUndefined();
    expect(stream.read("wake", { binding: "b", ref: "r" })).toBeUndefined();
    expect(stream.read("view", { revision: 1 })).toBeUndefined();
  });

  it("refuses a patch for another frame and stops asking after repeated resyncs", () => {
    const stream = createProjectionStream();
    expect(stream.read(PROJECTION_PATCH_EVENT, { revision: 2, base: 1, patch: [] })).toBeNull();
    stream.read("view", { revision: 3, projection: { a: 1 } });
    expect(stream.read(PROJECTION_PATCH_EVENT, { revision: 5, base: 4, patch: [] })).toBeNull();
    // The failed patch dropped the base: nothing applies until the next full frame.
    expect(stream.read(PROJECTION_PATCH_EVENT, { revision: 6, base: 3, patch: [] })).toBeNull();
    expect(stream.headers()).toEqual({});
    stream.read("view", { revision: 7, projection: { a: 2 } });
    expect(stream.read(PROJECTION_PATCH_EVENT, { revision: 8, base: 7, patch: [["=", ["missing", "x"], 1]] })).toBeNull();
  });

  it("patches an act reply against the frame held when the request was sent", () => {
    const stream = createProjectionStream();
    expect(stream.act().headers).toEqual({});
    const id = "0123456789abcdef";
    stream.read("view", { revision: 4, projection: { pinned: [], rows: [1] }, stream: id });
    const held = stream.act();
    expect(held.headers).toEqual({ [PROJECTION_BASE_HEADER]: `${id}.4` });
    // The stream moves on while the request is in flight.
    stream.read(PROJECTION_PATCH_EVENT, { revision: 5, base: 4, patch: [["=", ["rows"], [1, 2]]] });

    expect(held.rebuild({ ok: true, result: null, revision: 6, projection_base: `${id}.4`, projection_patch: [["=", ["pinned"], ["a"]]] }))
      .toEqual({ ok: true, result: null, revision: 6, projection: { pinned: ["a"], rows: [1] } });
    expect(held.rebuild({ ok: true, revision: 6, projection: { full: true } })).toEqual({ ok: true, revision: 6, projection: { full: true } });
    expect(stream.act().headers).toEqual({ [PROJECTION_BASE_HEADER]: `${id}.5` });
  });

  it("drops a reply projection it cannot rebuild exactly instead of guessing", () => {
    const stream = createProjectionStream();
    stream.read("view", { revision: 4, projection: { pinned: [] }, stream: "0123456789abcdef" });
    const held = stream.act();
    expect(held.rebuild({ ok: true, revision: 6, projection_base: "fedcba9876543210.4", projection_patch: [] })).toEqual({ ok: true, revision: 6 });
    expect(held.rebuild({ ok: true, revision: 6, projection_base: "0123456789abcdef.4", projection_patch: [["-", ["missing"]]] })).toEqual({ ok: true, revision: 6 });
    // A frame without a valid stream id is never offered as a base.
    stream.read("view", { revision: 7, projection: {}, stream: "../../etc" });
    expect(stream.act().headers).toEqual({});
  });
});
