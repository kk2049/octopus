/**
 * Every config key a module reads is a key its manifest declares, and vice versa.
 *
 * Both directions matter and they fail differently:
 *
 *  · **Read but not declared** — `linkComposition` refuses an undeclared key, so
 *    an App author who sets it gets a link-time failure they cannot act on, or
 *    (worse, where no registry is present) the module silently renders defaults.
 *  · **Declared but not read** — a key an App author can set that does nothing.
 *    That is a lie in a manifest, and manifests are release assets.
 *
 * `CONFIG_KEYS_READ` is maintained by hand, which is the honest version: the
 * alternative is deriving it from the source, and a derivation that got it wrong
 * would agree with itself.
 */

import { describe, expect, it } from "vitest";
import { CONFIG_LIMITS, readModuleManifest } from "@claude-bot/agent-module-contract";
import {
  DECK_MANIFESTS,
  DECK_OUTLINE_CONFIG,
  DECK_OUTLINE_MANIFEST,
  DECK_SLIDE_CONFIG,
  DECK_SLIDE_MANIFEST,
  DECK_TYPST_CONFIG,
  DECK_TYPST_MANIFEST,
} from "./manifests.js";
import { CONFIG_KEYS_READ } from "./modules.js";

const PAIRS = [
  ["outline", DECK_OUTLINE_MANIFEST, DECK_OUTLINE_CONFIG, CONFIG_KEYS_READ.outline],
  ["slide", DECK_SLIDE_MANIFEST, DECK_SLIDE_CONFIG, CONFIG_KEYS_READ.slide],
  ["typst", DECK_TYPST_MANIFEST, DECK_TYPST_CONFIG, CONFIG_KEYS_READ.typst],
] as const;

describe("config declarations", () => {
  it("declares exactly what each module reads", () => {
    for (const [name, , declaration, read] of PAIRS) {
      expect(Object.keys(declaration).sort(), `${name}: declared`).toEqual([...read].sort());
    }
  });

  it("attaches each declaration to its own manifest", () => {
    for (const [name, manifest, declaration] of PAIRS) {
      expect(manifest.config, name).toBe(declaration);
    }
  });

  it("marks `source` required everywhere, because nothing renders without it", () => {
    for (const [name, , declaration] of PAIRS) {
      expect(declaration.source, name).toMatchObject({ type: "string", required: true });
    }
  });

  it("leaves `command_action` optional, because that is what read-only means", () => {
    expect(DECK_OUTLINE_CONFIG.command_action?.required).toBeUndefined();
    expect(DECK_SLIDE_CONFIG.command_action?.required).toBeUndefined();
    // The Typst panel has no action at all: it is derived output, never a write.
    expect(DECK_TYPST_CONFIG.command_action).toBeUndefined();
  });

  it("stays inside the contract's own bounds", () => {
    for (const [name, , declaration] of PAIRS) {
      expect(Object.keys(declaration).length, name).toBeLessThanOrEqual(CONFIG_LIMITS.maxConfigFields);
      for (const [key, field] of Object.entries(declaration)) {
        expect(field.description ?? "", `${name}.${key}`).toHaveLength(
          Math.min((field.description ?? "").length, CONFIG_LIMITS.maxValueLength),
        );
      }
    }
  });

  it("ships three manifests the contract accepts", () => {
    expect(DECK_MANIFESTS).toHaveLength(3);
    for (const manifest of DECK_MANIFESTS) {
      const read = readModuleManifest(manifest);
      expect(read.ok, `${manifest.id}: ${JSON.stringify(read.ok ? null : read.issues)}`).toBe(true);
    }
  });

  it("gives every module a distinct id and implementation", () => {
    expect(new Set(DECK_MANIFESTS.map((manifest) => manifest.id)).size).toBe(3);
    expect(new Set(DECK_MANIFESTS.map((manifest) => manifest.implementation)).size).toBe(3);
  });
});
