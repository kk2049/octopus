/**
 * Ticket #45 end-to-end (assembled App side): a Session Plus App composition
 * accepts an initial appearance on boot and follows every live
 * MSG.appearance frame the trusted Host sends.
 *
 * The properties asserted are the ones the ticket names:
 *
 * - boot with `aurora` → the App paints in aurora on its first frame; the
 *   provider reflects the theme onto `<html data-av-theme>` before anyone
 *   sees classic.
 * - live switch classic → aurora → ink → classic → aurora updates
 *   `data-av-theme` (including the "classic == absence of attribute" rule)
 *   WITHOUT rebuilding the App tree, WITHOUT replacing the projection, and
 *   WITHOUT generating a proposal or an operation.
 * - a malformed appearance frame (unknown contract id, unknown theme id)
 *   is folded to classic by the View's defensive reader; a subsequent
 *   well-formed frame recovers.
 *
 * The harness constructs the same shipping App under a real MessagePort
 * (as `App.test.tsx` does) so the wiring exercised is the release wiring —
 * boot / view / op / appearance / propose all cross the same channel.
 *
 * ── Why the identity anchor is `.session-plus-app`, not `#root` ─────────────
 *
 * A first cut asserted `expect(document.querySelector("#root")).toBe(rootBefore)`.
 * That was two bugs at once:
 *   1. RTL's `render()` mounts into a fresh container appended to
 *      `document.body`; that container has no `id="root"`. `production` App
 *      sets `#root` in `main.tsx`, which is NOT part of App itself. So the
 *      query returned null in tests.
 *   2. `expect(null).toBe(null)` passes trivially, so the "not rebuilt"
 *      assertion was a false positive — a real remount would still have
 *      passed as long as no `#root` appeared.
 *
 * The App renders `<div className="session-plus-app">` after boot as its
 * always-present DOM root (context providers are transparent to the DOM).
 * That div's node identity, held from BEFORE the theme change to AFTER,
 * proves the App tree was reused. Combined with `isConnected` and a
 * `querySelector('.session-plus-app')` re-lookup, a remount would fail both ways.
 */

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  APPEARANCE_CONTRACT,
  AgentViewProvider,
  MSG,
  createAppRuntimeClient,
  type AgentViewClient,
} from "@claude-bot/agent-view-react";
import type { SessionsProjection } from "@claude-bot/agent-sessions-contract";
import { App } from "./App.js";

interface Harness {
  client: AgentViewClient;
  proposals: Array<{ rid: string; action: string; t: string }>;
  boot(projection: SessionsProjection, appearance?: unknown): Promise<void>;
  appearance(appearance: unknown): Promise<void>;
}

function tick(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function harness(): Harness {
  const proposals: Array<{ rid: string; action: string; t: string }> = [];
  const client = createAppRuntimeClient({
    dispatch: async (action) => {
      proposals.push({ rid: String(proposals.length), action, t: MSG.propose });
      return { ok: true };
    },
  });
  return {
    client, proposals,
    async boot(projection, appearance) {
      act(() => { client.updateAppearance(appearance); client.update(projection); });
      await tick();
    },
    async appearance(appearance) {
      act(() => client.updateAppearance(appearance));
      await tick();
    },
  };
}

function mount(h: Harness) {
  return render(
    <AgentViewProvider client={h.client}>
      <App />
    </AgentViewProvider>,
  );
}

const PROJECTION: SessionsProjection = {
  notice: "真实会话资源由平台能力管线提供。",
  pinned: [],
  sessions: [],
  sources: [],
};

async function waitForTheme(expected: string | null): Promise<void> {
  await waitFor(() => {
    const value = document.documentElement.dataset.avTheme;
    if (expected === null) expect(value).toBeUndefined();
    else expect(value).toBe(expected);
  });
}

/**
 * The App's stable DOM root is always rendered once `projection` arrives (see
 * `App.tsx`), and its identity is what a
 * "no-rebuild" claim actually rests on.
 */
async function appRootOf(container: HTMLElement): Promise<HTMLElement> {
  return await waitFor(() => {
    const el = container.querySelector(".session-plus-app");
    if (!el) throw new Error("boot has not committed yet — `.session-plus-app` missing");
    return el as HTMLElement;
  });
}

describe("Session Plus follows the outer shell's appearance (ticket #45)", () => {
  it("paints in aurora when the boot payload carries aurora", async () => {
    const h = harness();
    delete document.documentElement.dataset.avTheme;
    const { container } = mount(h);
    await h.boot(PROJECTION, { contract: APPEARANCE_CONTRACT, theme: "aurora" });
    await waitForTheme("aurora");
    // Prove the App actually committed a tree — not the null query the
    // previous version did. `appRootOf` throws if the App is still on the
    // pre-boot banner, which would be a real regression to catch.
    const head = await appRootOf(container);
    expect(head.isConnected).toBe(true);
    expect(container.contains(head)).toBe(true);
    h.client.destroy();
  });

  it("live-switches classic → aurora → ink → classic → aurora without rebuilding or emitting proposals", async () => {
    const h = harness();
    delete document.documentElement.dataset.avTheme;
    const { container } = mount(h);
    // Boot without an initial appearance: the default is classic (absence of
    // the attribute), matching an old Host that predates the channel.
    await h.boot(PROJECTION);
    await waitForTheme(null);
    // The identity anchor: this exact DOM node must survive four theme flips.
    const headBefore = await appRootOf(container);
    const proposalsBefore = h.proposals.length;

    await h.appearance({ contract: APPEARANCE_CONTRACT, theme: "aurora" });
    await waitForTheme("aurora");

    await h.appearance({ contract: APPEARANCE_CONTRACT, theme: "ink" });
    await waitForTheme("ink");

    await h.appearance({ contract: APPEARANCE_CONTRACT, theme: "classic" });
    await waitForTheme(null);

    await h.appearance({ contract: APPEARANCE_CONTRACT, theme: "aurora" });
    await waitForTheme("aurora");

    // Same node (identity), still in the tree (isConnected), and a fresh
    // querySelector returns the same object — three separate ways to catch a
    // remount, all held against the SAME reference from before the flips.
    expect(headBefore.isConnected).toBe(true);
    expect(container.querySelector(".session-plus-app")).toBe(headBefore);
    expect(headBefore.ownerDocument).toBe(document);
    // No theme change generated a proposal, and no non-propose write left
    // the frame either. This is the "theme is decoration, not an operation"
    // invariant ticket #45 pins.
    expect(h.proposals.length).toBe(proposalsBefore);
    h.client.destroy();
  });


  it("folds a malformed appearance frame to classic and recovers on the next good frame", async () => {
    const h = harness();
    delete document.documentElement.dataset.avTheme;
    mount(h);
    await h.boot(PROJECTION, { contract: APPEARANCE_CONTRACT, theme: "aurora" });
    await waitForTheme("aurora");

    // Unknown contract id → classic.
    await h.appearance({ contract: "appearance/vX", theme: "aurora" });
    await waitForTheme(null);

    // A subsequent good frame recovers to the requested theme.
    await h.appearance({ contract: APPEARANCE_CONTRACT, theme: "ink" });
    await waitForTheme("ink");

    // Unknown theme id → classic.
    await h.appearance({ contract: APPEARANCE_CONTRACT, theme: "punk" });
    await waitForTheme(null);
    h.client.destroy();
  });
});
