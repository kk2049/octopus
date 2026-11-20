import { describe, expect, it } from "vitest";
import { readModuleManifest } from "@claude-bot/agent-module-contract";
import { CONFIG_KEYS_READ } from "./modules.js";
import { SCHEDULE_BOOKING_CONFIG, SCHEDULE_BOOKING_MANIFEST } from "./manifests.js";

describe("schedule module declaration", () => {
  it("declares exactly the config keys it reads and is valid", () => {
    expect(Object.keys(SCHEDULE_BOOKING_CONFIG).sort()).toEqual([...CONFIG_KEYS_READ.booking].sort());
    expect(readModuleManifest(SCHEDULE_BOOKING_MANIFEST).ok).toBe(true);
  });
});
