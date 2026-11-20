import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sha256 } from "./sha256.js";

const reference = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
describe("incremental SHA-256", () => {
  it("matches the standard vectors and every padding boundary", () => {
    expect(new Sha256().hex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(new Sha256().update(new TextEncoder().encode("abc")).hex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (let length = 0; length <= 200; length++) {
      const bytes = randomBytes(length);
      expect(new Sha256().update(bytes).hex()).toBe(reference(bytes));
    }
  });
  it("gives the one-shot digest however the input is split into updates", () => {
    const bytes = randomBytes(300_001);
    for (const step of [1, 3, 63, 64, 65, 4096, 100_000]) {
      const hash = new Sha256();
      for (let offset = 0; offset < bytes.length; offset += step) hash.update(bytes.subarray(offset, offset + step));
      expect(hash.hex()).toBe(reference(bytes));
    }
  });
});
