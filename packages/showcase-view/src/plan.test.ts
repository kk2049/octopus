/**
 * The two release assets this App ships, checked against the objects the
 * browser actually assembles from.
 *
 * ── What is worth checking here, and what is not ────────────────────────────
 *
 * Not that the encoder works — `agent-module-contract` owns that. What is worth
 * checking is the JOIN between two things this package states separately: the
 * manifests `plan.ts` derives its lock from, and the components `modules.ts`
 * registers. `linkComposition` with a registry enforces the agreement in BOTH
 * directions (a lock entry with no manifest, and a manifest absent from the
 * lock), which is exactly the mistake a second App makes when it adds a module
 * to one list and not the other.
 *
 * And the release inventory, because "which assets does this release have" is
 * not a stylistic question: the adapter that installs it compares the inventory
 * against three closed sets, and a declared App is refused outright for
 * carrying the tenth.
 */

import { describe, expect, it } from "vitest";
import {
  encodeComposition,
  encodeModuleLock,
  linkComposition,
  parseComposition,
  parseModuleLock,
  readModuleBundle,
} from "@claude-bot/agent-module-contract";
import { createModuleRegistry, createWorkspacePlan } from "@claude-bot/agent-view-react/workspace";
import { DECK_TYPST_MODULE_ID, DECK_TYPST_RESOURCE_KIND } from "@claude-bot/agent-deck-view/manifests";
import { DATA_LIST_MODULE_ID } from "@claude-bot/agent-data-view/manifests";
import {
  COMPOSITION_ASSET,
  MODULE_LOCK_ASSET,
  SHOWCASE_APP,
  SHOWCASE_COMPOSITION,
  SHOWCASE_COMPOSITION_JSON,
  SHOWCASE_MANIFESTS,
  SHOWCASE_MODULE_ASSETS,
  SHOWCASE_MODULE_LOCK,
  SHOWCASE_MODULE_LOCK_JSON,
} from "./plan.js";
import { SHOWCASE_MODULES } from "./modules.js";

const registry = createModuleRegistry([...SHOWCASE_MODULES]);

describe("the release plan this App ships", () => {
  it("round-trips both documents byte for byte, together", () => {
    // `readModuleBundle` is the entry point the release adapter uses, and it
    // reads the PAIR: "only one of them is present" is a refusal rather than a
    // partial success, because a composition without its lock is a plan whose
    // module list nobody checked.
    const bundle = readModuleBundle({
      lockText: SHOWCASE_MODULE_LOCK_JSON,
      compositionText: SHOWCASE_COMPOSITION_JSON,
    });
    expect(bundle.ok).toBe(true);
    if (!bundle.ok) return;
    expect(encodeModuleLock(bundle.value.lock)).toBe(SHOWCASE_MODULE_LOCK_JSON);
    expect(encodeComposition(bundle.value.composition)).toBe(SHOWCASE_COMPOSITION_JSON);
    expect(bundle.value.composition.app).toBe(SHOWCASE_APP);
  });

  it("derives its lock from the manifests, and those are the modules it registers", () => {
    // Both directions. `linkComposition` with a registry refuses a lock entry
    // that has no manifest AND a manifest that is absent from the lock, so this
    // one call is the join between `plan.ts` and `modules.ts`.
    const composition = parseComposition(SHOWCASE_COMPOSITION_JSON);
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    const linked = linkComposition(composition.value, registry.lock(), registry.manifests());
    expect(linked.ok ? [] : linked.issues).toEqual([]);
    expect(SHOWCASE_MODULE_LOCK.modules.map((row) => row.id).sort()).toEqual(
      SHOWCASE_MANIFESTS.map((manifest) => manifest.id).sort(),
    );
    expect(SHOWCASE_MODULES).toHaveLength(SHOWCASE_MANIFESTS.length);
  });

  it("builds a workspace plan, and every instance and open rule resolves", () => {
    const plan = createWorkspacePlan({ composition: SHOWCASE_COMPOSITION, registry });
    // No binding document, so nothing is a connected surface. That is the
    // structural form of "a declared App binds no user resources".
    expect(plan.connectedInstances.size).toBe(0);
    for (const instance of SHOWCASE_COMPOSITION.instances) {
      const entry = plan.registry.get(instance.module);
      expect(entry, `${instance.instance} names an unregistered module`).toBeDefined();
      expect(entry!.manifest.slots).toContain(instance.slot);
    }
    for (const rule of SHOWCASE_COMPOSITION.open) {
      const entry = plan.registry.get(rule.module);
      expect(entry, `${rule.resource} routes to an unregistered module`).toBeDefined();
      expect(entry!.manifest.opens).toContain(rule.resource);
      expect(entry!.manifest.slots).toContain(rule.slot);
    }
  });

  it("gives every routed module a declared instance in the slot its rule names", () => {
    // The reason is measured, not stylistic: `layoutReducer` only rebinds a
    // DECLARED instance of the same module in the same slot, and otherwise mints
    // an anonymous panel with `config: null`. Every module here is
    // config-driven, so an anonymous panel is an empty one — which is what
    // `agent-deck-view/src/layout-finding.test.ts` measured. `mode: "rebind"`
    // is the kernel's opt-in answer, and it needs a target.
    for (const rule of SHOWCASE_COMPOSITION.open) {
      expect(rule.mode, `${rule.resource} would stack instead of rebinding`).toBe("rebind");
      const declared = SHOWCASE_COMPOSITION.instances.filter(
        (row) => row.module === rule.module && row.slot === rule.slot,
      );
      expect(declared.length, `${rule.resource} has no declared surface to rebind`).toBeGreaterThan(0);
    }
    // The one that is easy to get wrong: `deck.typst/v1` is routed into
    // `bottom` rather than `secondary` precisely BECAUSE `secondary` already
    // holds the slide editor and v1 allows one standing instance per document
    // slot. Without a home, 「导出 Typst」 opens a panel with no `source`.
    const typst = SHOWCASE_COMPOSITION.instances.find((row) => row.module === DECK_TYPST_MODULE_ID);
    expect(typst?.slot).toBe("bottom");
    expect(typst?.config).toEqual({ source: "deck", title: "Typst 源码" });
    expect(
      SHOWCASE_COMPOSITION.open.find((rule) => rule.resource === DECK_TYPST_RESOURCE_KIND)?.slot,
    ).toBe("bottom");
  });

  it("turns ONE list module into two instances by config alone", () => {
    const lists = SHOWCASE_COMPOSITION.instances.filter((row) => row.module === DATA_LIST_MODULE_ID);
    expect(lists.map((row) => row.instance)).toEqual(["inbox", "archive"]);
    expect(lists[0]!.config?.source).toBe("inbox");
    expect(lists[1]!.config?.source).toBe("archive");
  });

  it("ships exactly the two module assets, and no resource-binding document", () => {
    // MANDATORY, not tidy. `packages/bot/src/app-registry/declared-adapter.ts`
    // refuses the ten-asset `modular-v2` shape outright
    // (`resource_bindings_not_allowed`): which typed ports exist, which provider
    // serves one and which contract a Gate honours are platform decisions a
    // reviewer merged and a deployer deployed, so a declared App that could name
    // a binding would be data naming an implementation. Adding
    // `view/resource-bindings.json` here makes this release uninstallable.
    expect(SHOWCASE_MODULE_ASSETS.map((row) => row.name)).toEqual([COMPOSITION_ASSET, MODULE_LOCK_ASSET]);
    expect(SHOWCASE_MODULE_ASSETS.map((row) => row.name)).not.toContain("view/resource-bindings.json");
    expect(SHOWCASE_MODULE_ASSETS.map((row) => row.source)).toEqual([
      SHOWCASE_COMPOSITION_JSON,
      SHOWCASE_MODULE_LOCK_JSON,
    ]);
    // And the bytes really are what a reader would parse back.
    expect(parseModuleLock(SHOWCASE_MODULE_LOCK_JSON).ok).toBe(true);
  });

  it("names no implementation anywhere in either document", () => {
    // A composition that could name an implementation would be a composition
    // that could install one. `implementation` in the LOCK is a build-time
    // symbol reference, not a locator, so the check is on the composition.
    for (const forbidden of ["http", "node_modules", "packages/", "import", "@claude-bot", "device", "owner"]) {
      expect(SHOWCASE_COMPOSITION_JSON).not.toContain(forbidden);
    }
  });
});
