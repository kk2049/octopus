/**
 * Guest terminal stream (`guest-terminal/v1`, 2026-11-13).
 *
 * A guest client's agent (Claude Code or Codex) runs on the owner's host, in
 * a sandbox, inside tmux. The guest's console window and that terminal are
 * joined by one gateway tunnel, which is a plain byte stream. This module
 * frames it:
 *
 *   [kind u8][length u32 BE][payload]
 *   kind 1 DATA     terminal bytes (keys up, screen output down)
 *   kind 2 CONTROL  [json length u32 BE][json][attachment bytes]
 *
 * Control messages:
 *   console -> host  {t:"hello", v, agent, cols, rows}   first frame
 *                    {t:"resize", cols, rows}
 *                    {t:"result", id, ok, value | error}  (+ file bytes)
 *   host -> console  {t:"call", id, op, args}             (+ file bytes)
 *                    {t:"exit", text}
 *
 * Calls run on the guest's own PC, so the agent can work there too: only
 * while the guest has the console open, and only on the PC whose console
 * opened this stream.
 */
import type { WebSocket } from "ws";

export const GUEST_TERMINAL_VERSION = 1;
export const GUEST_AGENTS = ["claude", "codex"] as const;
export type GuestAgent = typeof GUEST_AGENTS[number];

/** One file crosses as one frame. */
export const MAX_GUEST_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_BYTES = MAX_GUEST_FILE_BYTES + 1024 * 1024;
const DATA = 1;
const CONTROL = 2;

export type TerminalFrame =
  | { kind: "data"; bytes: Buffer }
  | { kind: "control"; message: Record<string, unknown>; attachment: Buffer };

export function dataFrame(bytes: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(DATA, 0);
  head.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([head, bytes]);
}

export function controlFrame(message: Record<string, unknown>, attachment?: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(9);
  head.writeUInt8(CONTROL, 0);
  head.writeUInt32BE(4 + json.length + (attachment?.length ?? 0), 1);
  head.writeUInt32BE(json.length, 5);
  return Buffer.concat(attachment ? [head, json, attachment] : [head, json]);
}

/** Incremental decoder; throws on a malformed or oversized frame (the caller drops the stream). */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(chunk: Buffer): TerminalFrame[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const frames: TerminalFrame[] = [];
    for (;;) {
      if (this.buffered < 5) break;
      const head = this.peek(5);
      const kind = head.readUInt8(0);
      const size = head.readUInt32BE(1);
      if ((kind !== DATA && kind !== CONTROL) || size > MAX_FRAME_BYTES) throw new Error("invalid terminal frame");
      if (this.buffered < 5 + size) break;
      const payload = this.take(5 + size).subarray(5);
      if (kind === DATA) {
        frames.push({ kind: "data", bytes: payload });
        continue;
      }
      if (payload.length < 4) throw new Error("invalid control frame");
      const jsonSize = payload.readUInt32BE(0);
      if (jsonSize > payload.length - 4 || jsonSize > 1024 * 1024) throw new Error("invalid control frame");
      const message = JSON.parse(payload.subarray(4, 4 + jsonSize).toString("utf8")) as unknown;
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid control message");
      frames.push({ kind: "control", message: message as Record<string, unknown>, attachment: payload.subarray(4 + jsonSize) });
    }
    return frames;
  }

  private peek(size: number): Buffer {
    if (this.chunks[0]!.length < size) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0]!.subarray(0, size);
  }

  private take(size: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const rest = all.subarray(size);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return all.subarray(0, size);
  }
}

export function isGuestAgent(value: unknown): value is GuestAgent {
  return (GUEST_AGENTS as readonly unknown[]).includes(value);
}

/** Terminal sizes as both ends accept them. */
export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const clamp = (value: unknown, fallback: number) => {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number >= 1 ? Math.min(number, 1000) : fallback;
  };
  return { cols: clamp(cols, 120), rows: clamp(rows, 30) };
}

/**
 * The gateway pings joined tunnels every sweep. A socket that hears nothing
 * at all for this long is half-open: drop it so the console reconnects.
 */
export function watchSilence(socket: WebSocket, silentMs = 150_000): void {
  let last = Date.now();
  const touch = (): void => { last = Date.now(); };
  socket.on("ping", touch);
  socket.on("message", touch);
  socket.on("pong", touch);
  const timer = setInterval(() => {
    if (Date.now() - last > silentMs) socket.terminate();
  }, 30_000);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
}
