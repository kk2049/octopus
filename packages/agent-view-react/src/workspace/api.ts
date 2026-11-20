/**
 * What a module may say to the coordinator, and nothing more.
 *
 * The small module operation set. `open` takes a validated `open-resource/v1` intent; `focus` and
 * `close` name a panel the coordinator itself created, so a module can only
 * address something it was already shown; `report` is how a module says "the
 * Host refused this read" without inventing a layout change. There is no
 * `move`, no `resize`, no `setSlot` and no DOM handle, because those are the
 * verbs that let two modules disagree about one panel.
 *
 * `open` returns a boolean rather than throwing: an intent that does not
 * validate is a bug in the module, and the honest reaction is to not change the
 * layout and let the caller decide whether to say anything. `back` is the
 * shell's narrow-screen drill-in control; it carries no resource or panel data.
 */

import type { IntentContext, OpenMode, OpenResourceIntent, ResourceLink, WorkspaceSlot } from "@claude-bot/agent-module-contract";
import type { LayoutReason, LayoutState } from "./layout.js";

export interface OpenOptions {
  view?: string;
  slot?: WorkspaceSlot;
  mode?: OpenMode;
  /** Opaque hints for the consumer ("line": "120"); replaces the panel's context on reuse. */
  context?: IntentContext;
}

export interface WorkspaceApi {
  /** Current layout, for a module that wants to know whether it is on top. */
  readonly state: LayoutState;
  /** Raise `open-resource/v1`. False when invalid or the declared binding cannot satisfy it. */
  open(resource: ResourceLink, options?: OpenOptions): boolean;
  /** The same thing as a pre-built value; syntax and layout preconditions are checked. */
  openIntent(intent: OpenResourceIntent): boolean;
  focus(panelId: string): void;
  /** Request close. A dirty panel stays mounted until discard/cancel resolves it. */
  close(panelId: string): void;
  /** Presentation/lifecycle fact only; it grants no write authority. */
  setDirty?(panelId: string, dirty: boolean): void;
  /** Resolve the coordinator-owned dirty-close prompt by discarding the draft. */
  discardAndClose?(panelId: string): void;
  /** Resolve the coordinator-owned dirty-close prompt without closing. */
  cancelClose?(panelId: string): void;
  /** Panel-local status: `""` clears it back to ready. */
  report(panelId: string, reason: LayoutReason, detail?: string): void;
  /** Leave a narrow-screen drill-in. No-op when there is nothing to leave. */
  back(): void;
}
