import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { hasFreeSpace } from "./disk.js";

describe("per-window disk guard", () => {
  it("admits a write that leaves the reserve and refuses one the volume cannot hold", () => {
    expect(hasFreeSpace(tmpdir(), 1)).toBe(true);
    expect(hasFreeSpace(tmpdir(), Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
