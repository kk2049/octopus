/** Hosted App SSE response lifecycle at the raw ServerResponse seam. */

import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { RuntimeJson } from "@claude-bot/app-runtime";
import { PROJECTION_BASE_HEADER, PROJECTION_PATCH_EVENT, applyProjectionPatch } from "@claude-bot/dashboard-web/projection-delta";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceEvent, InstanceSubscription, SessionPlusPrincipal } from "../app-core/instance.js";
import type { PanelReply } from "./http.js";
import { actOnHostedApp, streamHostedApp, type HostedAppBinding } from "./routes/app-view.js";
import { sessionsPlusWorkload } from "./hosted-app-workload.test-support.js";

const PRINCIPAL: SessionPlusPrincipal = {
  owner: "alice",
  credential: "browser-1",
  session: true,
};

class FakeResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  readonly written: string[] = [];
  failHeartbeatAsync = false;
  writableLength = 0;
  private backpressureNext = false;

  write(chunk: string): boolean {
    this.written.push(chunk);
    if (this.failHeartbeatAsync && chunk === ": ping\n\n") {
      void Promise.resolve().then(() => this.emit("error", new Error("write after end")));
    }
    if (this.backpressureNext) {
      this.backpressureNext = false;
      this.writableLength = chunk.length;
      return false;
    }
    return true;
  }

  blockNextWrite(): void {
    this.backpressureNext = true;
  }

  drain(): void {
    this.writableLength = 0;
    this.emit("drain");
  }

  writeHead(): this {
    return this;
  }

  end(): this {
    if (this.writableEnded) return this;
    this.writableEnded = true;
    // Deliberately no `close`: a normal end reaches `finish` first, and the
    // heartbeat must already be gone during that gap.
    this.emit("finish");
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

function fakeReply(response: ServerResponse): PanelReply {
  return {
    raw: response,
    hijack() {},
  } as unknown as PanelReply;
}

function backend(initial: InstanceEvent & { type: "view" } = { type: "view", revision: 1, projection: { board: "start" } }) {
  let closes = 0;
  let next: ((event: InstanceEvent) => void) | null = null;
  return {
    closeCount: () => closes,
    emit: (event: InstanceEvent) => next?.(event),
    service: {
      subscribe(
        _handle: string,
        _principal: SessionPlusPrincipal,
        listener: (event: InstanceEvent) => void,
      ): InstanceSubscription {
        next = listener;
        return {
          initial,
          releaseAvailable: null,
          close() {
            closes += 1;
          },
        };
      },
    },
  };
}

function streams() {
  return {
    liveStreams: new Map<ServerResponse, { owner: string; credential: string }>(),
    eventStreams: new Set<ServerResponse>(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hosted App SSE response lifecycle", () => {
  it("cleans up on finish without waiting for close and never heartbeats an ended response", () => {
    const response = new FakeResponse();
    const coordinator = backend();
    const tracked = streams();

    streamHostedApp(tracked, fakeReply(response as unknown as ServerResponse), {
      principal: PRINCIPAL,
      handle: "handle-1",
      service: coordinator.service,
    });
    expect(vi.getTimerCount()).toBe(1);

    response.end();
    const afterEnd = response.written.length;
    vi.advanceTimersByTime(60_000);

    expect(response.written).toHaveLength(afterEnd);
    expect(vi.getTimerCount()).toBe(0);
    expect(coordinator.closeCount()).toBe(1);
    expect(tracked.eventStreams.size).toBe(0);
    expect(tracked.liveStreams.size).toBe(0);
  });

  it("handles an asynchronous response error and clears the heartbeat", async () => {
    const response = new FakeResponse();
    response.failHeartbeatAsync = true;
    const coordinator = backend();
    const tracked = streams();

    streamHostedApp(tracked, fakeReply(response as unknown as ServerResponse), {
      principal: PRINCIPAL,
      handle: "handle-2",
      service: coordinator.service,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    const afterError = response.written.length;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(response.written).toHaveLength(afterError);
    expect(vi.getTimerCount()).toBe(0);
    expect(coordinator.closeCount()).toBe(1);
    expect(tracked.eventStreams.size).toBe(0);
    expect(tracked.liveStreams.size).toBe(0);
  });

  it("keeps only the latest full projection while the socket is backpressured", () => {
    const response = new FakeResponse();
    response.blockNextWrite();
    const coordinator = backend();
    const tracked = streams();

    streamHostedApp(tracked, fakeReply(response as unknown as ServerResponse), {
      principal: PRINCIPAL,
      handle: "handle-slow",
      service: coordinator.service,
    });
    coordinator.emit({ type: "view", revision: 2, projection: { board: "stale" } });
    coordinator.emit({ type: "view", revision: 3, projection: { board: "latest" } });

    expect(response.written.join("")).not.toContain("stale");
    expect(response.written.join("")).not.toContain("latest");
    response.drain();
    // The newest frame then waits for its pacing slot (250 ms after a small frame).
    vi.advanceTimersByTime(250);
    expect(response.written.join("")).not.toContain("stale");
    expect(response.written.join("")).not.toContain('"revision":1');
    expect(response.written.join("")).toContain('"revision":3');
    expect(response.written.join("")).toContain("latest");
  });

  it("ends a stream instead of retaining an unbounded control backlog", () => {
    const response = new FakeResponse();
    response.blockNextWrite();
    const coordinator = backend();
    const tracked = streams();

    streamHostedApp(tracked, fakeReply(response as unknown as ServerResponse), {
      principal: PRINCIPAL,
      handle: "handle-overflow",
      service: coordinator.service,
    });
    for (let index = 0; index < 100; index += 1) {
      coordinator.emit({ type: "op", operation: { id: String(index) } });
    }

    expect(response.destroyed).toBe(true);
    expect(coordinator.closeCount()).toBe(1);
    expect(tracked.eventStreams.size).toBe(0);
    expect(tracked.liveStreams.size).toBe(0);
  });
});

/** Parsed `event`/`data` pairs, heartbeats and comments dropped. */
function frames(response: FakeResponse): Array<{ event: string; data: Record<string, unknown>; bytes: number }> {
  return response.written.filter((chunk) => chunk.startsWith("event: ")).map((chunk) => {
    const [head, body] = chunk.split("\n");
    return { event: head.slice(7), data: JSON.parse(body.slice(6)) as Record<string, unknown>, bytes: Buffer.byteLength(chunk) };
  });
}

/** A transcript-shaped projection of roughly `bytes` UTF-8 bytes. */
function largeProjection(bytes: number, tail: string): RuntimeJson {
  const messages = Array.from({ length: Math.ceil(bytes / 1024) }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 ? "assistant" : "user",
    text: `${"会话内容".repeat(80)} ${index}`.padEnd(700, "x"),
  }));
  return { sessions: [{ resource: "s-1", title: "long" }], transcript: { "s-1": { messages, tail } } };
}

function open(coordinator: ReturnType<typeof backend>, response: FakeResponse, delta = false): void {
  streamHostedApp(streams(), fakeReply(response as unknown as ServerResponse), {
    principal: PRINCIPAL,
    handle: "handle-paced",
    service: coordinator.service,
  }, { delta });
}

/** What a delta-capable host rebuilds from the stream, frame by frame. */
function replay(response: FakeResponse): Array<{ event: string; revision: number; projection: unknown; bytes: number }> {
  let base: { revision: number; projection: unknown } | null = null;
  return frames(response).filter((frame) => frame.event === "view" || frame.event === PROJECTION_PATCH_EVENT).map((frame) => {
    if (frame.event === "view") {
      base = { revision: frame.data.revision as number, projection: frame.data.projection };
    } else {
      expect(frame.data.base).toBe(base?.revision);
      const applied = applyProjectionPatch(base!.projection, frame.data.patch);
      expect(applied.ok).toBe(true);
      base = { revision: frame.data.revision as number, projection: (applied as { value: unknown }).value };
    }
    return { event: frame.event, revision: base.revision, projection: base.projection, bytes: frame.bytes };
  });
}

describe("hosted App view frame pacing", () => {
  it("never writes an emission whose projection equals the newest accepted one", () => {
    const response = new FakeResponse();
    const coordinator = backend({ type: "view", revision: 1, projection: { board: "start", moves: [1, 2] } });
    open(coordinator, response);

    for (let revision = 2; revision < 50; revision += 1) {
      coordinator.emit({ type: "view", revision, projection: { board: "start", moves: [1, 2] } });
    }
    vi.advanceTimersByTime(60_000);

    expect(frames(response).filter((frame) => frame.event === "view").map((frame) => frame.data.revision)).toEqual([1]);
  });

  it("still delivers a frame equal to an older write once a different one was accepted in between", () => {
    const response = new FakeResponse();
    const coordinator = backend();
    open(coordinator, response);

    // An act reply may already have shown this tab "moved"; the revert must arrive.
    coordinator.emit({ type: "view", revision: 2, projection: { board: "moved" } });
    coordinator.emit({ type: "view", revision: 3, projection: { board: "start" } });
    vi.advanceTimersByTime(250);

    const views = frames(response).filter((frame) => frame.event === "view");
    expect(views.map((frame) => [frame.data.revision, (frame.data.projection as { board: string }).board]))
      .toEqual([[1, "start"], [3, "start"]]);
  });

  it("paces by frame size and delivers only the newest frame on the trailing edge", () => {
    const response = new FakeResponse();
    const coordinator = backend({ type: "view", revision: 1, projection: largeProjection(512 * 1024, "t-1") });
    open(coordinator, response);
    const initialBytes = frames(response)[0].bytes;
    const slot = Math.ceil((initialBytes * 1000) / (256 * 1024));
    expect(slot).toBeGreaterThan(1_900);

    for (let revision = 2; revision <= 20; revision += 1) {
      coordinator.emit({ type: "view", revision, projection: largeProjection(512 * 1024, `t-${revision}`) });
      vi.advanceTimersByTime(50);
    }
    expect(frames(response)).toHaveLength(1);
    vi.advanceTimersByTime(slot - 19 * 50 - 2);
    expect(frames(response)).toHaveLength(1);
    vi.advanceTimersByTime(2);

    const views = frames(response).filter((frame) => frame.event === "view");
    expect(views.map((frame) => frame.data.revision)).toEqual([1, 20]);
    expect(vi.getTimerCount()).toBe(1); // only the heartbeat: nothing is left waiting
  });

  it("keeps a small-frame stream at no more than four frames a second", () => {
    const response = new FakeResponse();
    const coordinator = backend();
    open(coordinator, response);

    for (let tick = 1; tick <= 100; tick += 1) {
      coordinator.emit({ type: "view", revision: tick + 1, projection: { board: `move-${tick}` } });
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(250);

    const views = frames(response).filter((frame) => frame.event === "view");
    expect(views.length).toBeLessThanOrEqual(1 + Math.ceil(1_000 / 250) + 1);
    expect(views.at(-1)?.data.revision).toBe(101);
  });

  it("lets a wake pass a waiting frame, and pulls the frame ahead of an op or closed", () => {
    const response = new FakeResponse();
    const coordinator = backend();
    open(coordinator, response);

    coordinator.emit({ type: "view", revision: 2, projection: { board: "waiting" } });
    coordinator.emit({ type: "wake", binding: "files", ref: "root" });
    expect(frames(response).map((frame) => frame.event)).toEqual(["view", "wake"]);

    coordinator.emit({ type: "op", operation: { id: "op-1", status: "succeeded" } });
    expect(frames(response).map((frame) => frame.event)).toEqual(["view", "wake", "view", "op"]);
    expect(frames(response)[2].data.revision).toBe(2);

    coordinator.emit({ type: "view", revision: 3, projection: { board: "final" } });
    coordinator.emit({ type: "closed", reason: "instance_closed" });
    expect(frames(response).map((frame) => frame.event)).toEqual(["view", "wake", "view", "op", "view", "closed"]);
    expect(frames(response)[4].data.revision).toBe(3);
    expect(response.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the bytes of a busy 2 MB projection stream by the pacing budget", () => {
    const response = new FakeResponse();
    const big = largeProjection(2 * 1024 * 1024, "t-1") as Record<string, RuntimeJson>;
    const coordinator = backend({ type: "view", revision: 1, projection: big });
    open(coordinator, response);
    const initialBytes = frames(response)[0].bytes;

    // An agent streaming for one minute: twenty changed projections a second.
    for (let revision = 2; revision <= 1_201; revision += 1) {
      coordinator.emit({ type: "view", revision, projection: { ...big, tail: `t-${revision}` } });
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(10_000);

    const views = frames(response).filter((frame) => frame.event === "view");
    const total = views.reduce((sum, frame) => sum + frame.bytes, 0);
    // Unpaced, this minute would have written 1,201 frames (~2.5 GB).
    expect(views.length).toBeLessThanOrEqual(1 + Math.ceil(70_000 / ((initialBytes * 1000) / (256 * 1024))));
    expect(total).toBeLessThanOrEqual(initialBytes + 256 * 1024 * 70 + initialBytes);
    expect(views.at(-1)?.data.revision).toBe(1_201);
  });

  it("stops the pacing timer with the stream", () => {
    const response = new FakeResponse();
    const coordinator = backend();
    open(coordinator, response);

    coordinator.emit({ type: "view", revision: 2, projection: { board: "waiting" } });
    expect(vi.getTimerCount()).toBe(2);
    response.destroy();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(frames(response)).toHaveLength(1);
    expect(coordinator.closeCount()).toBe(1);
  });
});

describe("hosted App projection deltas", () => {
  it("keeps sending full frames to a client that did not ask for patches", () => {
    const response = new FakeResponse();
    const coordinator = backend();
    open(coordinator, response);

    coordinator.emit({ type: "view", revision: 2, projection: { board: "moved", moves: [1] } });
    vi.advanceTimersByTime(250);

    expect(frames(response).map((frame) => frame.event)).toEqual(["view", "view"]);
    expect(frames(response)[1].data).toEqual({ type: "view", revision: 2, projection: { board: "moved", moves: [1] } });
  });

  it("sends one full frame, then patches that rebuild every frame exactly", () => {
    const response = new FakeResponse();
    const coordinator = backend({ type: "view", revision: 1, projection: { board: "start", moves: [], players: { a: 1 } } });
    open(coordinator, response, true);

    const sent: RuntimeJson[] = [{ board: "start", moves: [], players: { a: 1 } }];
    for (let revision = 2; revision <= 12; revision += 1) {
      const projection = { board: revision % 3 ? "mid" : "end", moves: Array.from({ length: revision }, (_, index) => index), players: { b: revision, a: 1 } };
      coordinator.emit({ type: "view", revision, projection });
      sent.push(projection);
      vi.advanceTimersByTime(250);
    }

    const rebuilt = replay(response);
    expect(rebuilt.map((frame) => frame.event)).toEqual(["view", ...Array(11).fill(PROJECTION_PATCH_EVENT)]);
    expect(rebuilt.map((frame) => JSON.stringify(frame.projection))).toEqual(sent.map((projection) => JSON.stringify(projection)));
    expect(rebuilt.map((frame) => frame.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("delivers a revert as an empty patch under the newer revision", () => {
    const response = new FakeResponse();
    const coordinator = backend();
    open(coordinator, response, true);

    coordinator.emit({ type: "view", revision: 2, projection: { board: "moved" } });
    coordinator.emit({ type: "view", revision: 3, projection: { board: "start" } });
    vi.advanceTimersByTime(250);

    const patches = frames(response).filter((frame) => frame.event === PROJECTION_PATCH_EVENT);
    expect(patches.map((frame) => frame.data)).toEqual([{ revision: 3, base: 1, patch: [] }]);
  });

  it("cuts a busy multi-MB Sessions+ stream by orders of magnitude and rebuilds its final state", () => {
    const workload = sessionsPlusWorkload({ seconds: 60 });
    const initialBytes = Buffer.byteLength(JSON.stringify({ type: "view", revision: 1, projection: workload.initial }));
    expect(initialBytes).toBeGreaterThan(2 * 1024 * 1024);
    // Projections only grow here, so every emitted full frame is at least this big.
    const unpaced = initialBytes * (workload.emissions.length + 1);

    const response = new FakeResponse();
    const coordinator = backend({ type: "view", revision: 1, projection: workload.initial });
    open(coordinator, response, true);
    let now = 0;
    workload.emissions.forEach((emission, index) => {
      vi.advanceTimersByTime(emission.atMs - now);
      now = emission.atMs;
      coordinator.emit({ type: "view", revision: index + 2, projection: emission.projection });
    });
    vi.advanceTimersByTime(1_000);

    const rebuilt = replay(response);
    const last = workload.emissions.at(-1)!;
    expect(rebuilt.at(-1)?.revision).toBe(workload.emissions.length + 1);
    expect(JSON.stringify(rebuilt.at(-1)?.projection)).toBe(JSON.stringify(last.projection));
    const afterFirst = rebuilt.slice(1).reduce((sum, frame) => sum + frame.bytes, 0);
    expect(rebuilt.slice(1).every((frame) => frame.event === PROJECTION_PATCH_EVENT)).toBe(true);
    // A minute of agent work: ~270 full frames (> 750 MB) emitted; ~200 KB of patches written.
    expect(unpaced).toBeGreaterThan(750 * 1024 * 1024);
    expect(afterFirst).toBeLessThan(400 * 1024);
    expect(afterFirst * 1_000).toBeLessThan(unpaced);
    expect(rebuilt.length).toBeLessThanOrEqual(1 + 4 * 61);
  });
});

describe("hosted App act replies against the frame a tab holds", () => {
  const BEFORE = { pinned: [] as string[], sessions: [{ id: "a", preview: "x".repeat(4_000) }], transcript: { a: { messages: ["m1", "m2"] } } };
  const AFTER = { pinned: ["a"], sessions: BEFORE.sessions, transcript: { a: { messages: ["m1", "m2", "m3"] } } };

  function binding(handle: string, projection: unknown = AFTER): HostedAppBinding {
    return {
      kind: "declared",
      surface: { stableAppId: "demo" } as never,
      principal: PRINCIPAL,
      handle,
      service: {
        dispatch: async () => ({ ok: true, result: { done: true }, projection, revision: 7 }),
      } as never,
    };
  }

  async function act(handle: string, base?: string, projection?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    let status = 0;
    let body = "";
    const reply = {
      code(value: number) { status = value; return this; },
      type() { return this; },
      send(value: string) { body = value; return this; },
    };
    const req = { headers: base === undefined ? {} : { [PROJECTION_BASE_HEADER]: base }, body: { action: "pin", params: {} } };
    vi.useRealTimers();
    await actOnHostedApp(req as never, reply as never, binding(handle, projection));
    vi.useFakeTimers();
    return { status, body: JSON.parse(body) as Record<string, unknown> };
  }

  function openDelta(handle: string): { response: FakeResponse; stream: string } {
    const response = new FakeResponse();
    const coordinator = backend({ type: "view", revision: 3, projection: BEFORE });
    streamHostedApp(streams(), fakeReply(response as unknown as ServerResponse), { principal: PRINCIPAL, handle, service: coordinator.service }, { delta: true });
    return { response, stream: frames(response)[0].data.stream as string };
  }

  it("replies with a verified patch instead of the projection", async () => {
    const { stream } = openDelta("handle-act");
    expect(stream).toMatch(/^[0-9a-f]{16}$/);

    const { status, body } = await act("handle-act", `${stream}.3`);

    expect(status).toBe(200);
    expect(body).not.toHaveProperty("projection");
    expect(body).toMatchObject({ ok: true, result: { done: true }, revision: 7, projection_base: `${stream}.3` });
    const rebuilt = applyProjectionPatch(JSON.parse(JSON.stringify(BEFORE)), body.projection_patch);
    expect(rebuilt).toEqual({ ok: true, value: AFTER });
    expect(JSON.stringify(body).length).toBeLessThan(200);
  });

  it("keeps the full projection when the named frame is unknown, foreign or gone", async () => {
    const { response, stream } = openDelta("handle-own");
    for (const base of [undefined, "nonsense", `${stream}.2`, `${"0".repeat(16)}.3`]) {
      const { body } = await act("handle-own", base);
      expect(body.projection, String(base)).toEqual(AFTER);
      expect(body).not.toHaveProperty("projection_patch");
    }
    // Another instance cannot name this tab's frames.
    expect((await act("handle-other", `${stream}.3`)).body.projection).toEqual(AFTER);
    response.destroy();
    expect((await act("handle-own", `${stream}.3`)).body.projection).toEqual(AFTER);
  });

  it("names no frame on a full-frame stream", () => {
    const response = new FakeResponse();
    open(backend(), response);
    expect(frames(response)[0].data).not.toHaveProperty("stream");
  });
});
