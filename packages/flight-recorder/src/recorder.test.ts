import { describe, expect, it } from "vitest";
import { FLIGHT_EXPORT_VERSION, createFlightRecorder } from "./recorder.js";

describe("flight recorder", () => {
  it("keeps events oldest-first and evicts beyond capacity in O(1)", () => {
    const recorder = createFlightRecorder({ capacity: 16, now: () => 5 });
    for (let i = 0; i < 20; i += 1) {
      recorder.record({ source: "ui", kind: "ui.state", key: `k${i}`, delta: { on: true } });
    }
    const events = recorder.events();
    expect(recorder.size()).toBe(16);
    expect(events).toHaveLength(16);
    expect(events[0].key).toBe("k4");
    expect(events[15].key).toBe("k19");
  });

  it("stamps the injected clock and keeps an explicit finite ts", () => {
    let tick = 100;
    const recorder = createFlightRecorder({ now: () => tick });
    recorder.record({ source: "wire", kind: "wire.wake", key: "sessions", delta: {} });
    tick = 200;
    recorder.record({ source: "wire", kind: "wire.wake", key: "sessions", delta: {}, ts: 150 });
    recorder.record({ source: "wire", kind: "wire.wake", key: "sessions", delta: {}, ts: Number.NaN });
    const [first, second, third] = recorder.events();
    expect(first.ts).toBe(100);
    expect(second.ts).toBe(150);
    expect(third.ts).toBe(200);
  });

  it("bounds every field at admission: truncation, entry cap, primitives only", () => {
    const recorder = createFlightRecorder({ maxStringLength: 8, maxDeltaEntries: 2 });
    recorder.record({
      source: "user",
      kind: "user.propose.long-kind-name",
      key: "a-very-long-semantic-key",
      rid: "rid-1234567890",
      delta: {
        text: "0123456789ABCDEF",
        n: 42,
        // Non-primitives are dropped, not stringified: an object graph in a
        // delta is the payload this recorder exists to refuse.
        object: { smuggled: "payload" } as unknown as string,
        overflow: true,
      },
    });
    const [event] = recorder.events();
    expect(event.kind).toBe("user.pro");
    expect(event.key).toBe("a-very-l");
    expect(event.rid).toBe("rid-1234");
    expect(event.delta).toEqual({ text: "01234567", n: 42 });
  });

  it("exports a versioned JSON envelope that round-trips", () => {
    const recorder = createFlightRecorder({ now: () => 7 });
    recorder.record({ source: "frame", kind: "frame.projection", key: "sessions+", delta: { sessions: 3 } });
    const parsed = JSON.parse(recorder.export());
    expect(parsed.version).toBe(FLIGHT_EXPORT_VERSION);
    expect(parsed.exportedAt).toBe(7);
    expect(parsed.events).toEqual([
      { ts: 7, source: "frame", kind: "frame.projection", key: "sessions+", delta: { sessions: 3 } },
    ]);
  });

  it("clear drops the window without breaking later recording", () => {
    const recorder = createFlightRecorder({ capacity: 16 });
    recorder.record({ source: "ui", kind: "ui.state", key: "absent", delta: { on: true } });
    recorder.clear();
    expect(recorder.size()).toBe(0);
    expect(recorder.events()).toEqual([]);
    recorder.record({ source: "ui", kind: "ui.state", key: "absent", delta: { on: false } });
    expect(recorder.events()).toHaveLength(1);
  });
});
