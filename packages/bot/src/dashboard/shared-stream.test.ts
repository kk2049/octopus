/** The raw-response safety floor shared by every hijacked Dashboard stream. */

import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { PanelReply } from "./http.js";
import { hijack, onRawResponseEnd } from "./routes/shared.js";

class FakeResponse extends EventEmitter {
  destroyed = false;

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

describe("hijacked raw response lifecycle", () => {
  it("installs the fail-closed error listener before Fastify transfers ownership", () => {
    const response = new FakeResponse();
    const reply = {
      raw: response as unknown as ServerResponse,
      hijack() {
        // This is the earliest failure possible: the transfer itself exposes a
        // queued socket error before the route can install its own cleanup.
        response.emit("error", new Error("socket failed"));
      },
    } as unknown as PanelReply;

    expect(() => hijack(reply)).not.toThrow();
    expect(response.destroyed).toBe(true);
  });

  it("runs route cleanup once across error, finish, and close", () => {
    const response = new FakeResponse();
    const cleanup = vi.fn();
    onRawResponseEnd(response as unknown as ServerResponse, cleanup);

    response.emit("error", new Error("write failed"));
    response.emit("finish");
    response.emit("close");

    expect(cleanup).toHaveBeenCalledOnce();
  });
});
