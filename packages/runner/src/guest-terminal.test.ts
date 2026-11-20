import { describe, expect, it } from "vitest";
import { controlFrame, dataFrame, FrameDecoder, terminalSize } from "./guest-terminal.js";

describe("guest terminal framing", () => {
  it("decodes data and control frames across arbitrary chunk boundaries", () => {
    const file = Buffer.alloc(200_000, 7);
    const stream = Buffer.concat([
      dataFrame(Buffer.from("\x1b[2Jhello")),
      controlFrame({ t: "resize", cols: 90, rows: 20 }),
      controlFrame({ t: "result", id: 1, ok: true, value: { path: "C:\\a.txt" } }, file),
      dataFrame(Buffer.alloc(0)),
    ]);
    for (const step of [1, 3, 7, 4096, stream.length]) {
      const decoder = new FrameDecoder();
      const frames = [];
      for (let offset = 0; offset < stream.length; offset += step) frames.push(...decoder.push(stream.subarray(offset, offset + step)));
      expect(frames.map((frame) => frame.kind)).toEqual(["data", "control", "control", "data"]);
      expect(frames[0]).toMatchObject({ kind: "data", bytes: Buffer.from("\x1b[2Jhello") });
      expect(frames[1]).toMatchObject({ kind: "control", message: { t: "resize", cols: 90, rows: 20 } });
      const result = frames[2] as { message: Record<string, unknown>; attachment: Buffer };
      expect(result.message).toEqual({ t: "result", id: 1, ok: true, value: { path: "C:\\a.txt" } });
      expect(result.attachment.equals(file)).toBe(true);
    }
  });

  it("rejects unknown kinds, oversized frames and non-object control messages", () => {
    expect(() => new FrameDecoder().push(Buffer.from([9, 0, 0, 0, 0]))).toThrow();
    const huge = Buffer.alloc(5);
    huge.writeUInt8(1, 0);
    huge.writeUInt32BE(0xffff_ffff, 1);
    expect(() => new FrameDecoder().push(huge)).toThrow();
    const json = Buffer.from("[1,2]");
    const head = Buffer.alloc(9);
    head.writeUInt8(2, 0);
    head.writeUInt32BE(4 + json.length, 1);
    head.writeUInt32BE(json.length, 5);
    expect(() => new FrameDecoder().push(Buffer.concat([head, json]))).toThrow();
  });

  it("clamps terminal sizes", () => {
    expect(terminalSize(100, 30)).toEqual({ cols: 100, rows: 30 });
    expect(terminalSize("x", -1)).toEqual({ cols: 120, rows: 30 });
    expect(terminalSize(5000, 0.5)).toEqual({ cols: 1000, rows: 30 });
  });
});
