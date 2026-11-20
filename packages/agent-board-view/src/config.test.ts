/**
 * The declaration and the reader are the same list — a key read but undeclared
 * is refused at link time for something the module would have honoured, and a
 * key declared but never read validates, links, and does nothing.
 */

import { describe, expect, it } from "vitest";
import { CONFIG_LIMITS, readModuleManifest } from "@claude-bot/agent-module-contract";
import { BOARD_GRID_CONFIG, BOARD_GRID_MANIFEST, BOARD_MANIFESTS } from "./manifests.js";
import { CONFIG_KEYS_READ } from "./modules.js";

describe("the board config declaration", () => {
  it("declares exactly the keys the module reads", () => {
    expect(Object.keys(BOARD_GRID_CONFIG).sort()).toEqual([...CONFIG_KEYS_READ.grid].sort());
  });

  it("fits inside the ABI's bounds and describes every key", () => {
    expect(Object.keys(BOARD_GRID_CONFIG).length).toBeLessThanOrEqual(CONFIG_LIMITS.maxConfigFields);
    for (const [key, field] of Object.entries(BOARD_GRID_CONFIG)) {
      expect(field.description, key).toBeTruthy();
    }
  });

  it("marks only the keys the module cannot work without as required", () => {
    const required = Object.keys(BOARD_GRID_CONFIG).filter((key) => BOARD_GRID_CONFIG[key]!.required === true);
    expect(required.sort()).toEqual(["action", "source"]);
  });
});

describe("the board manifest", () => {
  it("reads as a valid module manifest", () => {
    for (const manifest of BOARD_MANIFESTS) {
      const read = readModuleManifest(manifest);
      expect(read.ok, `${manifest.id}: ${read.ok ? "" : JSON.stringify(read.issues)}`).toBe(true);
    }
  });

  it("declares the app-data port, opens nothing, and can serve a primary slot", () => {
    expect(BOARD_GRID_MANIFEST.ports).toEqual(["app-data/v1"]);
    expect(BOARD_GRID_MANIFEST.opens).toEqual([]);
    expect(BOARD_GRID_MANIFEST.slots).toContain("primary");
  });
});
