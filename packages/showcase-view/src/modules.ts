/**
 * Every module implementation this release compiles in.
 *
 * Separate from `plan.ts` for one reason: a registry entry is a manifest plus a
 * COMPONENT, so this file imports React, and `plan.ts` is imported by a Node
 * release builder that has no business loading a renderer. The manifests are
 * pure data and live in the module packages, which is why the lock can be
 * derived without any of this.
 *
 * The list is assembled by concatenating each package's own export rather than
 * by naming six entries: a manifest and its component belong together, and a
 * composition that could pair a manifest with a different implementation would
 * make the module lock a claim rather than a fact.
 */

import type { ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import { DATA_MODULES } from "@claude-bot/agent-data-view";
import { DECK_MODULES } from "@claude-bot/agent-deck-view";

export const SHOWCASE_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([
  ...DATA_MODULES,
  ...DECK_MODULES,
]);
