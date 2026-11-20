export const CHILD_RPC_VERSION = 1 as const;

export type RpcWireMessage =
  | { v: 1; t: "ready" }
  | { v: 1; t: "request"; id: number; method: string; params: unknown }
  | { v: 1; t: "response"; id: number; ok: true; result: unknown }
  | { v: 1; t: "response"; id: number; ok: false; error: string; code?: string }
  | { v: 1; t: "part"; id: number; data: string; last: boolean }
  | { v: 1; t: "stop" }
  | { v: 1; t: "stopped" };

export type RpcPart = Extract<RpcWireMessage, { t: "part" }>;
export type RpcCorrelated = Extract<RpcWireMessage, { t: "request" | "response" }>;

export function isWireMessage(value: unknown): value is RpcWireMessage {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.v === CHILD_RPC_VERSION && typeof row.t === "string";
}

/**
 * Room left for a part frame's fixed fields (`v`, `t`, a safe-integer `id`,
 * `last`). The actual envelope is about 65 bytes; the margin keeps the proof
 * that a part never exceeds the frame bound independent of key order.
 */
const PART_ENVELOPE_BYTES = 128;

/**
 * Frames for one request or response, each within `maxFrameBytes`.
 *
 * The frame bound is a window: it bounds one IPC write, never the size of the
 * value being carried. A message that fits is sent unchanged, so small traffic
 * is byte-identical to the original protocol. A larger one is cut into `part`
 * frames over its UTF-8 JSON encoding; base64 makes every part's size a pure
 * function of its byte count (4/3), so no input can push a part over the bound.
 * The sender writes a message's parts back-to-back and IPC preserves order; the
 * receiver still keys them by id so an aborted transfer cannot splice into the
 * next message.
 */
export function wireFrames(message: RpcCorrelated, maxFrameBytes: number): RpcWireMessage[] {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text, "utf8") <= maxFrameBytes) return [message];
  const step = Math.floor((maxFrameBytes - PART_ENVELOPE_BYTES) / 4) * 3;
  if (step < 3) throw new RangeError("child RPC frame bound is too small to carry a part");
  const body = Buffer.from(text, "utf8");
  const parts: RpcWireMessage[] = [];
  for (let offset = 0; offset < body.length; offset += step) {
    parts.push({
      v: CHILD_RPC_VERSION,
      t: "part",
      id: message.id,
      data: body.subarray(offset, offset + step).toString("base64"),
      last: offset + step >= body.length,
    });
  }
  return parts;
}

/**
 * Reassembles `part` frames into the message they carry.
 *
 * `accept` returns the decoded message when the last part arrives and null
 * before that. A completed message must be the request/response with the same
 * id; anything else is a protocol violation and throws rather than dispatching.
 */
export class PartAssembler {
  private readonly partial = new Map<number, Buffer[]>();

  accept(part: RpcPart): RpcCorrelated | null {
    if (!Number.isSafeInteger(part.id) || typeof part.data !== "string") {
      throw new TypeError("invalid child RPC part");
    }
    const chunks = this.partial.get(part.id) ?? [];
    chunks.push(Buffer.from(part.data, "base64"));
    if (!part.last) {
      this.partial.set(part.id, chunks);
      return null;
    }
    this.partial.delete(part.id);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (
      !isWireMessage(message)
      || (message.t !== "request" && message.t !== "response")
      || message.id !== part.id
    ) {
      throw new TypeError("child RPC parts did not carry the correlated message");
    }
    return message;
  }

  /** Forget an unfinished transfer, e.g. after its request timed out. */
  drop(id: number): void {
    this.partial.delete(id);
  }

  clear(): void {
    this.partial.clear();
  }
}
