/** The child half of the same tiny protocol. The IPC descriptor is inherited. */

import {
  CHILD_RPC_VERSION,
  isWireMessage,
  PartAssembler,
  wireFrames,
  type RpcCorrelated,
  type RpcWireMessage,
} from "./protocol.js";

export interface RpcServerOptions {
  handle: (method: string, params: unknown) => Promise<unknown> | unknown;
  close?: () => Promise<void> | void;
  maxConcurrent?: number;
  /**
   * Ceiling on one frame sent to the parent. A larger response travels as
   * several `part` frames; this bounds each write, not the response.
   */
  maxMessageBytes?: number;
}

export function serveChildRpc(options: RpcServerOptions): void {
  let closing = false;
  let active = 0;
  const maxConcurrent = options.maxConcurrent ?? 32;
  const maxMessageBytes = options.maxMessageBytes ?? 2 * 1024 * 1024;
  const parts = new PartAssembler();
  const send = (message: RpcWireMessage): boolean => {
    try {
      if (!process.connected || !process.send) return false;
      const frames = message.t === "request" || message.t === "response"
        ? wireFrames(message, maxMessageBytes)
        : [message];
      for (const frame of frames) process.send(frame, () => {});
      return true;
    } catch {
      return false;
    }
  };

  process.on("message", (frame: unknown) => {
    if (!isWireMessage(frame)) return;
    let message: RpcWireMessage | RpcCorrelated | null = frame;
    if (frame.t === "part") {
      try {
        message = parts.accept(frame);
      } catch {
        // The parent is the only writer on this descriptor; a broken transfer
        // is answered like any other refused request, never dispatched.
        send({ v: CHILD_RPC_VERSION, t: "response", id: frame.id, ok: false,
          error: "child RPC request parts were malformed", code: "child_protocol_error" });
        return;
      }
      if (!message) return;
    }
    if (message.t === "stop") {
      if (closing) return;
      closing = true;
      void Promise.resolve(options.close?.()).finally(() => {
        send({ v: CHILD_RPC_VERSION, t: "stopped" });
        process.disconnect?.();
      });
      return;
    }
    if (closing || message.t !== "request") return;
    if (active >= maxConcurrent) {
      send({
        v: CHILD_RPC_VERSION,
        t: "response",
        id: message.id,
        ok: false,
        error: "child service is saturated",
        code: "child_saturated",
      });
      return;
    }
    active += 1;
    const id = message.id;
    const succeeded = (result: unknown): void => {
      if (send({ v: CHILD_RPC_VERSION, t: "response", id, ok: true, result })) return;
      send({ v: CHILD_RPC_VERSION, t: "response", id, ok: false,
        error: "child service response cannot be encoded", code: "child_response_unencodable" });
    };
    const failed = (error: unknown): void => {
      const row = error as { message?: unknown; code?: unknown } | null;
      send({ v: CHILD_RPC_VERSION, t: "response", id, ok: false,
        error: String(row?.message ?? error).slice(0, 4096),
        code: typeof row?.code === "string" ? row.code : undefined });
    };
    // IPC can emit several messages in one tick. Complete synchronous handlers
    // here: deferring them to a microtask makes a serial service reject the rest
    // of that batch even though no handler is actually running concurrently.
    // Only an asynchronous handler holds a slot beyond this listener.
    try {
      const result = options.handle(message.method, message.params);
      if (result != null && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).then(succeeded, failed).finally(() => { active -= 1; });
        return;
      }
      succeeded(result);
    } catch (error) {
      failed(error);
    }
    active -= 1;
  });

  process.on("disconnect", () => {
    if (!closing) void Promise.resolve(options.close?.()).finally(() => process.exit(0));
  });
  send({ v: CHILD_RPC_VERSION, t: "ready" });
}
