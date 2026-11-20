import { describe, expect, it } from "vitest";
import { resolveCapabilityBits } from "./capability-bits.js";

describe("resolveCapabilityBits", () => {
  it("resolves admin, configured deployer, and stored grant sources identically", () => {
    const admins = ["lht"];
    const deployers = ["dora"];
    const resolve = (username: string, granted: string[] = []) =>
      resolveCapabilityBits({ username, admins, granted, deployers });

    expect(resolve("lht")).toEqual({ admin: true, dev: true, deploy: true, contribute: true });
    expect(resolve("dora")).toEqual({ admin: false, dev: true, deploy: true, contribute: true });
    expect(resolve("dana", ["dev"])).toEqual({ admin: false, dev: true, deploy: false, contribute: true });
    expect(resolve("alice")).toEqual({ admin: false, dev: false, deploy: false, contribute: false });
  });

  it("keeps deploy implying dev one-directionally", () => {
    expect(resolveCapabilityBits({ username: "x", granted: ["deploy"] })).toEqual({
      admin: false,
      dev: true,
      deploy: true,
      contribute: true,
    });
  });

  it("contribute is the tier below dev and never implies it", () => {
    expect(resolveCapabilityBits({ username: "lilei", granted: ["contribute"] })).toEqual({
      admin: false,
      dev: false,
      deploy: false,
      contribute: true,
    });
  });
});
