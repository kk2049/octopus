/**
 * `open-resource/v1` — the only thing a module may say about layout.
 *
 * ── Why an intent and not a URL ─────────────────────────────────────────────
 *
 * A path in agent prose is not authority to open a file. The trusted side mints
 * a `ResourceLink` for things it has decided are disclosable; a module renders
 * that link as a button; clicking it produces one of these intents. Nothing on
 * this path parses a canonical path, fetches anything, or lets a string choose a
 * provider — `suggestedView` is a hint the coordinator checks against the
 * composition's open rules, and a rule that does not exist is a refusal rather
 * than a lookup.
 *
 * ── Why modules may not touch layout directly ───────────────────────────────
 *
 * Because the alternative is two modules moving the same panel. An intent is a
 * request the LayoutCoordinator answers; `focus` and `close` name a panel the
 * coordinator itself created, so a module can only ever address something it was
 * already shown.
 */

import { readIntentContext, type IntentContext } from "./config.js";
import { isModuleId, isResourceKind, isResourceRef } from "./ids.js";
import { isOpenMode, type OpenMode } from "./composition.js";
import { isWorkspaceSlot, type WorkspaceSlot } from "./slots.js";
import {
  IssueBag,
  objectAt,
  refuseUnknownFields,
  stringAt,
  type ContractResult,
} from "./validate.js";

export const OPEN_RESOURCE_INTENT = "open-resource/v1";

/**
 * A thing the trusted side decided may be opened.
 *
 * `ref` is opaque here on purpose: its meaning belongs to whoever issued it, and
 * this layer only ever compares it (for reuse) and hands it back.
 */
export interface ResourceLink {
  kind: string;
  ref: string;
  /** Presentation only. */
  label: string;
  mediaType?: string;
  /** A hint. The composition's open rules decide, not this field. */
  suggestedView?: string;
}

export interface OpenResourceIntent {
  intent: typeof OPEN_RESOURCE_INTENT;
  resource: ResourceLink;
  /** Narrow the choice to one locked module; must still match a rule. */
  view?: string;
  /** Override the rule's slot. Must be one of the five. */
  slot?: WorkspaceSlot;
  /** `reuse` unless stated; `new` is how a second instance is asked for. */
  mode?: OpenMode;
  /**
   * Opaque, bounded hints for the consumer ("jump to line 120"). The platform
   * transports and never interprets it; semantics belong to the resource
   * kind's vocabulary. NOT part of reuse identity: reopening the same resource
   * with a different context focuses the same panel and replaces its context.
   */
  context?: IntentContext;
}

const LINK_FIELDS = ["kind", "ref", "label", "mediaType", "suggestedView"] as const;
const INTENT_FIELDS = ["intent", "resource", "view", "slot", "mode", "context"] as const;

export function readResourceLink(value: unknown, at = "resource"): ContractResult<ResourceLink> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, LINK_FIELDS, at);
  const kind = stringAt(bag, row, "kind", at);
  if (kind !== null && !isResourceKind(kind)) {
    bag.add("identifier", "kind must be a resource kind like `session`", `${at}.kind`);
  }
  const ref = stringAt(bag, row, "ref", at);
  if (ref !== null && !isResourceRef(ref)) {
    bag.add("identifier", "ref must be a bounded printable reference", `${at}.ref`);
  }
  const label = stringAt(bag, row, "label", at);
  const mediaType = stringAt(bag, row, "mediaType", at, { optional: true });
  const suggestedView = stringAt(bag, row, "suggestedView", at, { optional: true });
  if (suggestedView !== null && !isModuleId(suggestedView)) {
    bag.add("identifier", "suggestedView must be a module id", `${at}.suggestedView`);
  }
  if (!bag.empty) return bag.fail();
  const link: ResourceLink = { kind: kind!, ref: ref!, label: label! };
  if (mediaType !== null) link.mediaType = mediaType;
  if (suggestedView !== null) link.suggestedView = suggestedView;
  return { ok: true, value: link };
}

export function readOpenResourceIntent(value: unknown): ContractResult<OpenResourceIntent> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, "intent");
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, INTENT_FIELDS, "intent");
  if (row.intent !== OPEN_RESOURCE_INTENT) {
    bag.add("schema", `intent must be ${OPEN_RESOURCE_INTENT}`, "intent.intent");
  }
  const link = readResourceLink(row.resource, "intent.resource");
  if (!link.ok) return { ok: false, issues: [...bag.drain(), ...link.issues] };
  const view = stringAt(bag, row, "view", "intent", { optional: true });
  if (view !== null && !isModuleId(view)) bag.add("identifier", "view must be a module id", "intent.view");
  let slot: WorkspaceSlot | undefined;
  if (row.slot !== undefined) {
    if (!isWorkspaceSlot(row.slot)) bag.add("slot", "slot must be one of the five workspace slots", "intent.slot");
    else slot = row.slot;
  }
  let mode: OpenMode | undefined;
  if (row.mode !== undefined) {
    if (!isOpenMode(row.mode)) bag.add("open_mode", "mode must be `reuse`, `new` or `rebind`", "intent.mode");
    else mode = row.mode;
  }
  const context = readIntentContext(bag, row, "context", "intent");
  if (!bag.empty) return bag.fail();
  const intent: OpenResourceIntent = { intent: OPEN_RESOURCE_INTENT, resource: link.value };
  if (view !== null) intent.view = view;
  if (slot !== undefined) intent.slot = slot;
  if (mode !== undefined) intent.mode = mode;
  if (context !== undefined) intent.context = context;
  return { ok: true, value: intent };
}

/**
 * Build one intent from inside a module.
 *
 * It goes through the same reader as anything that arrives from elsewhere: a
 * module is publisher code, so "we built it ourselves" is not a reason to trust
 * its shape.
 */
export function openResource(
  resource: ResourceLink,
  options: { view?: string; slot?: WorkspaceSlot; mode?: OpenMode; context?: IntentContext } = {},
): ContractResult<OpenResourceIntent> {
  const draft: Record<string, unknown> = { intent: OPEN_RESOURCE_INTENT, resource };
  if (options.view !== undefined) draft.view = options.view;
  if (options.slot !== undefined) draft.slot = options.slot;
  if (options.mode !== undefined) draft.mode = options.mode;
  if (options.context !== undefined) draft.context = options.context;
  return readOpenResourceIntent(draft);
}
