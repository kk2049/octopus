import type { ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import { DATA_MODULES } from "@claude-bot/agent-data-view";
import { DECK_MODULES } from "@claude-bot/agent-deck-view";

export const PPT_STUDIO_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([
  ...DATA_MODULES,
  ...DECK_MODULES,
]);
