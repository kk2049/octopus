/**
 * A property of the layout kernel that decides how these modules address a slide.
 *
 * ── What it is ─────────────────────────────────────────────────────────────
 *
 * `layoutReducer`'s `open` case rebinds a STANDING composition instance — one
 * whose `resourceRef` is still null — and otherwise mints an anonymous panel
 * with `config: null`. A module that is a CONNECTED surface (named in
 * `agent-resource-bindings/v1`) is exempt: it is always rebound, whatever it was
 * showing, because an anonymous panel would look wired and not be.
 *
 * A module on `app-data/v1` is not connected — that port comes from the App's
 * own channel, not from a deployment's provider catalog — so it gets neither
 * exemption. Consequence, asserted below:
 *
 *   **the FIRST open of a resource lands in the declared instance and keeps its
 *   config; the SECOND, for a different ref, mints a panel with no config at
 *   all.**
 *
 * For any module whose behaviour comes from `config` (which is every module the
 * P4 data layer and this package produce — that is what decision 7 is for), the
 * second open is a broken panel: no `source`, no action, nothing to render.
 *
 * ── What this package does about it ────────────────────────────────────────
 *
 * Not a workaround, and not a change to the kernel. It addresses the panel by
 * the thing the panel IS — the deck — and says which slide through
 * `IntentContext`, which the reducer refreshes on reuse for exactly this shape
 * ("the same document at another line"). One panel, stable identity, config
 * intact, and the reader gets focus-what-is-open instead of a growing stack.
 *
 * The cost is real and stated: two slides cannot be opened side by side. v1 of
 * the binding document cannot express a second connected instance either, so
 * that limitation is the platform's, not this package's.
 *
 * This file is here so the finding is executable. If the kernel ever grows a
 * "rebind the declared instance" rule for unconnected modules, the first test
 * fails and this package can go back to a ref per slide.
 */

import { describe, expect, it } from "vitest";
import { COMPOSITION_SCHEMA, openResource, type AgentComposition } from "@claude-bot/agent-module-contract";
import {
  createModuleRegistry,
  createWorkspacePlan,
  initialLayout,
  layoutReducer,
} from "@claude-bot/agent-view-react/workspace";
import { DECK_SLIDE_MODULE_ID, DECK_SLIDE_RESOURCE_KIND } from "./manifests.js";
import { DECK_MODULES } from "./modules.js";

const COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: "deck-demo",
  instances: [
    {
      instance: "editor",
      module: DECK_SLIDE_MODULE_ID,
      slot: "primary",
      config: { source: "deck", command_action: "deck_command" },
    },
  ],
  open: [{ resource: DECK_SLIDE_RESOURCE_KIND, module: DECK_SLIDE_MODULE_ID, slot: "primary", mode: "rebind" }],
};

function plan() {
  return createWorkspacePlan({ composition: COMPOSITION, registry: createModuleRegistry([...DECK_MODULES]) });
}

function intent(ref: string, context?: Record<string, string>) {
  const built = openResource({ kind: DECK_SLIDE_RESOURCE_KIND, ref, label: ref }, context ? { context } : {});
  if (!built.ok) throw new Error(`bad intent: ${JSON.stringify(built.issues)}`);
  return built.value;
}

describe("the kernel property these modules are designed around", () => {
  it("mode:'rebind' keeps the declared instance and its config on every open (kernel grew the rule, 2026-08-07)", () => {
    // HISTORY: this test originally asserted the OPPOSITE — the second open
    // minted an anonymous `config: null` panel, which made every slide after
    // the first unrenderable for a config-driven module. That was this file's
    // reason to exist: an executable finding. The kernel then grew exactly
    // the rule the header anticipated — as an OPT-IN open-rule mode
    // (`"rebind"`), because a blanket version broke the chat-stacking shape.
    // The deck's own addressing (ref = the deck, slide = IntentContext, next
    // test) remains the right shape regardless — one panel is the product
    // intent here, not a workaround anymore.
    const built = plan();
    const reduce = layoutReducer(built);
    const first = reduce(initialLayout(built), { type: "open", intent: intent("slide-a") });
    const firstPanel = first.panels.find((panel) => panel.resourceRef === "slide-a")!;
    expect(firstPanel.panelId).toBe("editor");
    expect(firstPanel.config).toEqual({ source: "deck", command_action: "deck_command" });

    const second = reduce(first, { type: "open", intent: intent("slide-b") });
    const secondPanel = second.panels.find((panel) => panel.resourceRef === "slide-b")!;
    expect(secondPanel.panelId).toBe("editor");
    expect(secondPanel.config).toEqual({ source: "deck", command_action: "deck_command" });
    expect(second.panels.filter((panel) => panel.moduleId === DECK_SLIDE_MODULE_ID)).toHaveLength(1);
  });

  it("keeps one panel, and its config, when the ref is the deck and the slide is context", () => {
    const built = plan();
    const reduce = layoutReducer(built);
    let state = reduce(initialLayout(built), { type: "open", intent: intent("deck", { slide: "slide-a" }) });
    state = reduce(state, { type: "open", intent: intent("deck", { slide: "slide-b" }) });
    const panels = state.panels.filter((panel) => panel.moduleId === DECK_SLIDE_MODULE_ID);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.panelId).toBe("editor");
    expect(panels[0]!.config).toEqual({ source: "deck", command_action: "deck_command" });
    // Context is refreshed on reuse — that is the reducer's own stated rule and
    // the whole reason this addressing works.
    expect(panels[0]!.context).toEqual({ slide: "slide-b" });
  });
});
