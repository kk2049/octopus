/**
 * The declaration and the reader are the same list.
 *
 * A config key a module reads but the manifest does not declare is the quietest
 * failure this package can have: the composition that supplies it is REFUSED at
 * link time (`checkInstanceConfig` rejects an undeclared key), so the App
 * author sees "unknown key" for something the module would have honoured. The
 * reverse — declared and never read — is a key that validates, links, activates
 * and does nothing at all.
 *
 * Neither is visible in a rendering test, so it is asserted directly.
 */

import { describe, expect, it } from "vitest";
import { readModuleManifest, CONFIG_LIMITS } from "@claude-bot/agent-module-contract";
import {
  DATA_ACTIONS_CONFIG,
  DATA_ACTIONS_MANIFEST,
  DATA_DETAIL_CONFIG,
  DATA_DETAIL_MANIFEST,
  DATA_FORM_CONFIG,
  DATA_FORM_MANIFEST,
  DATA_LIST_CONFIG,
  DATA_LIST_MANIFEST,
  DATA_MANIFESTS,
} from "./manifests.js";
import { CONFIG_KEYS_READ } from "./modules.js";

describe("the config declarations", () => {
  it("declare exactly the keys the modules read", () => {
    expect(Object.keys(DATA_LIST_CONFIG).sort()).toEqual([...CONFIG_KEYS_READ.list].sort());
    expect(Object.keys(DATA_DETAIL_CONFIG).sort()).toEqual([...CONFIG_KEYS_READ.detail].sort());
    expect(Object.keys(DATA_FORM_CONFIG).sort()).toEqual([...CONFIG_KEYS_READ.form].sort());
    expect(Object.keys(DATA_ACTIONS_CONFIG).sort()).toEqual([...CONFIG_KEYS_READ.actions].sort());
  });

  it("fit inside the ABI's bounds", () => {
    for (const manifest of DATA_MANIFESTS) {
      expect(Object.keys(manifest.config ?? {}).length).toBeLessThanOrEqual(CONFIG_LIMITS.maxConfigFields);
    }
  });

  it("describe every key, because a composition author reads them and nothing else", () => {
    for (const manifest of DATA_MANIFESTS) {
      for (const [key, field] of Object.entries(manifest.config ?? {})) {
        expect(field.description, `${manifest.id}.${key}`).toBeTruthy();
      }
    }
  });

  it("mark only the keys a module cannot work without as required", () => {
    const required = (declaration: Record<string, { required?: boolean }>): string[] =>
      Object.keys(declaration).filter((key) => declaration[key]!.required === true);
    expect(required(DATA_LIST_CONFIG)).toEqual(["source"]);
    expect(required(DATA_DETAIL_CONFIG)).toEqual(["source"]);
    expect(required(DATA_FORM_CONFIG).sort()).toEqual(["action", "fields"]);
    expect(required(DATA_ACTIONS_CONFIG).sort()).toEqual(["allowed_actions", "source"]);
  });
});

describe("the manifests", () => {
  it("all read as valid module manifests", () => {
    for (const manifest of DATA_MANIFESTS) {
      const read = readModuleManifest(manifest);
      expect(read.ok, `${manifest.id}: ${read.ok ? "" : JSON.stringify(read.issues)}`).toBe(true);
    }
  });

  it("declare the app-data port and no resource contract", () => {
    for (const manifest of DATA_MANIFESTS) {
      expect(manifest.ports).toEqual(["app-data/v1"]);
    }
  });

  it("place every module in at least one slot it could plausibly serve", () => {
    expect(DATA_LIST_MANIFEST.slots).toContain("navigation");
    expect(DATA_DETAIL_MANIFEST.slots).toContain("primary");
    expect(DATA_FORM_MANIFEST.slots).toContain("secondary");
    expect(DATA_ACTIONS_MANIFEST.slots).toContain("bottom");
  });
});
