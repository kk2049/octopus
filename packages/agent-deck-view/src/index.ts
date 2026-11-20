/**
 * `@claude-bot/agent-deck-view` — the deck modules.
 *
 * ── What they are ──────────────────────────────────────────────────────────
 *
 * Three modules over one `deck-model/v1` document that an App keeps in its own
 * durable state: a film strip of real 16:9 thumbnails (what is in the deck and
 * in what order), a visual canvas that edits one slide in place, and the
 * generated Typst source.
 *
 * They hold `app-data/v1` — the App's own projection and action surface — so
 * they are wired exactly like the generic data modules and share ONE provider
 * with them. There is no deck port, no deck provider and no binding plan entry,
 * because a deck is not a user resource: it arrives over the single channel
 * every Agent View already has.
 *
 * ── The one rule this package exists to keep ───────────────────────────────
 *
 * §15.5: **the deck JSON is the editable truth and the Typst is derived.** So
 * `deck.typst/v1` renders text and offers to copy it, and there is nowhere in
 * this package to type Typst into. A second editable representation is the
 * shape that design forbids, and the way to keep it out is to not build the
 * control that would need it.
 *
 * ── What is absent ─────────────────────────────────────────────────────────
 *
 * No owner, scope, instance handle, capability or context. No transport — the
 * modules import the SDK's `/ui` and `/workspace` entries, never its root. No
 * literal action id: the only one is `config.command_action`, written by an App
 * author in a composition a reviewer read. No compiler, no PDF, no upload.
 */

import "./deck-view.css";

export {
  DECK_MANIFESTS,
  DECK_OUTLINE_CONFIG,
  DECK_OUTLINE_MANIFEST,
  DECK_OUTLINE_MODULE_ID,
  DECK_SLIDE_CONFIG,
  DECK_SLIDE_CONTEXT_KEY,
  DECK_SLIDE_MANIFEST,
  DECK_SLIDE_MODULE_ID,
  DECK_SLIDE_RESOURCE_KIND,
  DECK_TYPST_CONFIG,
  DECK_TYPST_MANIFEST,
  DECK_TYPST_MODULE_ID,
  DECK_TYPST_RESOURCE_KIND,
} from "./manifests.js";

export {
  CONFIG_KEYS_READ,
  DECK_MODULES,
  DECK_OUTLINE_MODULE,
  DECK_SLIDE_MODULE,
  DECK_TYPST_MODULE,
} from "./modules.js";

export { DeckOutline, type DeckOutlineProps, type OutlineRow } from "./components/DeckOutline.js";
export { SlideCanvas, type CanvasNotice, type SlideCanvasProps } from "./components/SlideCanvas.js";
export {
  SlideSurface,
  regionName,
  type SlideSurfaceProps,
  type SurfaceRegion,
  type SurfaceTextRenderer,
} from "./components/SlideSurface.js";
export { InlineText, NewItemText, type InlineTextProps, type NewItemTextProps } from "./components/InlineText.js";
export { TypstExport, type TypstExportProps } from "./components/TypstExport.js";
export { SourceNotice, type SourceNoticeProps } from "./components/SourceNotice.js";

export {
  nextSlideId,
  readDeckSource,
  type DeckSource,
  type DeckSourceStatus,
} from "./lib/deck-source.js";

export {
  appendItemCommands,
  listValue,
  removeItemCommands,
  replaceTextCommands,
  scalarValue,
  swapItemCommands,
} from "./lib/edits.js";

export { LAYOUT_LABELS, UNTITLED, fieldLabel } from "./lib/labels.js";
