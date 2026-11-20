/** Submission-operation SSE teardown without a real Fastify server. */

import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelReply, PanelRequest } from "./http.js";
import type { DashboardIdentity } from "./server.js";
import { streamOperations, type SessionRoutesContext } from "./routes/sessions.js";

class FakeResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  readonly written: string[] = [];

  write(chunk: string): boolean {
    this.written.push(chunk);
    if (chunk === ": ping\n\n") {
      void Promise.resolve().then(() => this.emit("error", new Error("write after end")));
    }
    return true;
  }

  writeHead(): this {
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("submission-operation SSE lifecycle", () => {
  it("absorbs an asynchronous heartbeat error and releases its subscription", async () => {
    const response = new FakeResponse();
    const unsubscribe = vi.fn();
    const tracked = {
      eventStreams: new Set<ServerResponse>(),
      liveStreams: new Map<ServerResponse, { owner: string; credential: string }>(),
    };
    const ctx = {
      ...tracked,
      operations: {
        list: () => [],
        subscribe: () => unsubscribe,
      },
    } as unknown as SessionRoutesContext;
    const reply = {
      raw: response as unknown as ServerResponse,
      hijack() {},
    } as unknown as PanelReply;
    const req = { raw: { url: "/api/sessions/operations/stream" } } as unknown as PanelRequest;
    const identity = { username: "alice", credential: "browser-1" } as DashboardIdentity;

    streamOperations(ctx, req, reply, identity);
    await vi.advanceTimersByTimeAsync(20_000);
    const afterError = response.written.length;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(response.written).toHaveLength(afterError);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(tracked.eventStreams.size).toBe(0);
    expect(tracked.liveStreams.size).toBe(0);
  });
});
