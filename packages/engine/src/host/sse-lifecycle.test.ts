import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { onRawSseEnd } from "./server.js";

describe("raw Host SSE lifecycle", () => {
  it("owns asynchronous response errors and tears down exactly once", () => {
    const response = new EventEmitter();
    const cleanup = vi.fn();

    const stop = onRawSseEnd(response as unknown as Parameters<typeof onRawSseEnd>[0], cleanup);

    // Node reports ERR_STREAM_WRITE_AFTER_END this way: the write returned,
    // then ServerResponse emitted `error` outside the caller's try/catch.
    expect(() => response.emit("error", new Error("write after end"))).not.toThrow();
    response.emit("finish");
    response.emit("close");
    stop();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
