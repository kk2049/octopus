/**
 * What this release assembles, as data — and as the two JSON assets that ship
 * with it.
 *
 * ── Why the plan is a release asset ─────────────────────────────────────────
 *
 * `view/module-lock.json` says what is inside the bundle and
 * `view/composition.json` how those modules are wired. Both travel in the
 * release inventory, so both are covered by the package digest — the property
 * that makes them evidence rather than configuration: changing either changes
 * the release identity, and therefore the hostname the frame is served from.
 *
 * They are produced from the SAME objects the browser assembles from, by the
 * contract package's canonical encoder. That is the whole reason this module is
 * dependency-light (no React, no CSS, no DOM): a Node release builder imports it
 * to emit the bytes, and the browser imports it to build the plan. Two
 * hand-written documents would be two claims that happen to agree today. For the
 * same reason the module OBJECTS (manifest + component) live in `modules.ts`:
 * importing those here would drag React into a packer.
 *
 * ── Why there is no `view/resource-bindings.json` ───────────────────────────
 *
 * This is a **declared App** — one whose whole existence is a row in
 * `app_declarations`, installed and activated with no trusted-code change. A
 * declared App may not bind user resources, and that is enforced rather than
 * discouraged: `packages/bot/src/app-registry/declared-adapter.ts` refuses the
 * ten-asset `modular-v2` shape outright (`resource_bindings_not_allowed`),
 * because which typed ports exist, which provider serves one and which contract
 * a Gate honours are decisions belonging to platform code that a reviewer merged
 * and a deployer deployed. A declared App that could name a binding would be
 * data naming an implementation, and the binding layer's first rule is that a
 * plan names a NEED, never an implementation. Its permission contract is
 * therefore EMPTY, and its descriptor has to say so.
 *
 * So this release is the NINE-asset `modular-v1` shape: four backend assets,
 * three View assets, and the two documents below.
 *
 * This costs the App nothing, because the one port its modules need is not a
 * resource binding in the first place. All six declare `ports: ["app-data/v1"]`
 * — the App's OWN projection and action surface — and that is satisfied by the
 * App from the single channel every Agent View already has, not by a
 * deployment's provider catalog (see `agent-data-view/src/port.ts`). Declaring
 * it as a binding would ask a deployment to install a provider for something no
 * catalog serves. A showcase App needs no binding document at all, which is
 * exactly why it can be a showcase.
 *
 * ── The composition, in one paragraph ───────────────────────────────────────
 *
 * A notes-and-slides demo. The rail holds three surfaces: 收件箱 and 归档箱,
 * which are the SAME module pointed at two projection paths, and the deck's
 * film strip of real thumbnails. `primary` is the 16:9 slide canvas — the
 * visual editor is the centre of this composition, the way a slides product
 * centres its page — `secondary` reads one note, and the strip along the
 * bottom carries the compose form and the generated Typst. Four open rules
 * route the four resource kinds, and the ORDER of the rules for one kind is
 * the routing policy (`resolveOpen` takes `rules[0]` when an intent names no
 * view) — here each kind has exactly one, so the ordering is only a reading aid.
 *
 * ── Why every routed module has a DECLARED instance, and `mode: "rebind"` ───
 *
 * Measured, not styled. `layoutReducer` rebinds a standing composition instance
 * only while its `resourceRef` is still null, and otherwise mints an ANONYMOUS
 * panel with `config: null`. For a module whose whole behaviour comes from
 * config — which is every module in this release, that being the point of
 * instance config — an anonymous panel is a broken panel: no `source`, no
 * action, nothing to render. `agent-deck-view/src/layout-finding.test.ts` is
 * that finding written down, and `mode: "rebind"` (2026-08-07) is the kernel's
 * opt-in answer: a declared surface of the target module is THE panel for that
 * kind, bound or not.
 *
 * Hence the two shapes below that a reader might otherwise find surprising:
 *
 *  · every open rule carries `mode: "rebind"`, and
 *  · `deck.typst/v1` has a standing `typst` instance in `bottom` rather than
 *    only an open rule into a document slot. `rebind` needs a declared instance
 *    of the same module in the same slot to rebind; `primary` holds the slide
 *    canvas, `secondary` the note detail, and `createWorkspacePlan` allows
 *    exactly one standing instance per document slot, so `bottom` — which
 *    `deck.typst/v1` accepts and which is a flow region — is where that
 *    instance can exist. Without it, 「导出 Typst」 would open a panel that
 *    renders "这个组合指向的 deck 读不出来".
 */

import {
  COMPOSITION_SCHEMA,
  encodeComposition,
  encodeModuleLock,
  moduleLockOf,
  type AgentComposition,
  type AgentModuleLock,
  type AgentModuleManifest,
} from "@claude-bot/agent-module-contract";
import {
  DATA_DETAIL_MODULE_ID,
  DATA_FORM_MODULE_ID,
  DATA_FORM_RESOURCE_KIND,
  DATA_LIST_MODULE_ID,
  DATA_MANIFESTS,
  DATA_RECORD_RESOURCE_KIND,
} from "@claude-bot/agent-data-view/manifests";
import {
  DECK_MANIFESTS,
  DECK_OUTLINE_MODULE_ID,
  DECK_SLIDE_MODULE_ID,
  DECK_SLIDE_RESOURCE_KIND,
  DECK_TYPST_MODULE_ID,
  DECK_TYPST_RESOURCE_KIND,
} from "@claude-bot/agent-deck-view/manifests";

/** The stable app id this plan belongs to. */
export const SHOWCASE_APP = "showcase";

/** Who vouches for these bytes. Compared, never resolved. */
export const SHOWCASE_PUBLISHER = "octopus:demo";

/**
 * Release asset names.
 *
 * The platform's fixed names for the two module-plan documents, re-declared
 * here rather than imported from another App's package: an App that imported
 * `@claude-bot/session-plus-view/plan` to learn what its own assets are called
 * would make every second App depend on the first. They are exact strings the
 * release adapter COMPARES — it never joins them onto a root — so restating
 * them is a restatement of a constant, not a second source of truth about a
 * path.
 */
export const MODULE_LOCK_ASSET = "view/module-lock.json";
export const COMPOSITION_ASSET = "view/composition.json";

/**
 * The two action ids this App declares, and the only ones anywhere in the
 * browser half.
 *
 * They live in this file because a composition is the one place a module learns
 * an action id: `data.form/v1` proposes `config.action`, the deck modules
 * propose `config.command_action`, and neither package contains a literal. The
 * same two strings are the `actions:` keys of `app/app.yaml`.
 */
const ADD_NOTE_ACTION = "add_note";
const DECK_COMMAND_ACTION = "deck_command";

/**
 * Every module this release can mount, as pure data. The lock below is DERIVED
 * from it, so it cannot claim a module the bundle does not contain.
 *
 * `modules.ts` holds the matching registry entries; `plan.test.ts` proves the
 * two lists are the same list, in both directions.
 */
export const SHOWCASE_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([
  ...DATA_MANIFESTS,
  ...DECK_MANIFESTS,
]);

/** Derived from the manifests, so it cannot claim a module that is not there. */
export const SHOWCASE_MODULE_LOCK: AgentModuleLock = moduleLockOf(SHOWCASE_MANIFESTS);

export const SHOWCASE_COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: SHOWCASE_APP,
  instances: [
    {
      instance: "inbox",
      module: DATA_LIST_MODULE_ID,
      slot: "navigation",
      title: "收件箱",
      config: {
        source: "inbox",
        title: "收件箱",
        empty_text: "收件箱是空的。",
        open_kind: DATA_RECORD_RESOURCE_KIND,
      },
    },
    {
      // The same implementation as `inbox`, a different projection path, a
      // different purpose. THIS is what instance config is for: 收件箱 and
      // 归档箱 are not two modules, not one module with a mode flag, and not a
      // branch inside a component — they are two rows of this document.
      instance: "archive",
      module: DATA_LIST_MODULE_ID,
      slot: "navigation",
      title: "归档箱",
      config: {
        source: "archive",
        title: "归档箱",
        empty_text: "还没有归档过任何东西。",
        open_kind: DATA_RECORD_RESOURCE_KIND,
      },
    },
    {
      instance: "outline",
      module: DECK_OUTLINE_MODULE_ID,
      slot: "navigation",
      title: "幻灯片",
      // ONE action id, not five: the edit vocabulary belongs to `deck-model/v1`
      // and the App's handler is a passthrough. `export_kind` is what makes the
      // 导出 button exist at all.
      config: {
        source: "deck",
        title: "幻灯片",
        command_action: DECK_COMMAND_ACTION,
        export_kind: DECK_TYPST_RESOURCE_KIND,
        empty_text: "这份 deck 还没有任何一页；用下面的按钮加一页。",
      },
    },
    {
      // The 16:9 canvas holds `primary`: this composition's centre is the deck,
      // the way a slides product centres its page. Editing is in place — a
      // gesture is a command — so the hint says the commit model, not a save
      // ceremony.
      instance: "slide",
      module: DECK_SLIDE_MODULE_ID,
      slot: "primary",
      config: {
        source: "deck",
        title: "幻灯画布",
        command_action: DECK_COMMAND_ACTION,
        hint: "点击画布上的文字就地编辑；回车或失焦即提交一条 deck-model/v1 命令。",
      },
    },
    {
      instance: "note",
      module: DATA_DETAIL_MODULE_ID,
      slot: "secondary",
      // `id_key` set means `source` is a COLLECTION and this panel shows the
      // record its `resourceRef` names. Unset would mean `source` IS the record.
      config: {
        source: "byId",
        id_key: "id",
        fields: "detailFields",
        empty_text: "从左边选一条看看。",
      },
    },
    {
      instance: "compose",
      module: DATA_FORM_MODULE_ID,
      slot: "bottom",
      // The form is GENERATED from `addNoteParams` — the same declaration the
      // backend's handler validates against — rather than hand-drawn beside it.
      config: {
        action: ADD_NOTE_ACTION,
        fields: "addNoteParams",
        title: "写一条",
        submit_label: "记下来",
      },
    },
    {
      // A standing instance so `mode: "rebind"` has a declared surface to rebind.
      // See the header: without it the 导出 button mints a `config: null` twin.
      instance: "typst",
      module: DECK_TYPST_MODULE_ID,
      slot: "bottom",
      config: { source: "deck", title: "Typst 源码" },
    },
  ],
  open: [
    { resource: DATA_RECORD_RESOURCE_KIND, module: DATA_DETAIL_MODULE_ID, slot: "secondary", mode: "rebind" },
    // The ref names the DECK and the slide rides in `context` — that reads
    // backwards until you know why, and the why is in `DECK_SLIDE_RESOURCE_KIND`.
    { resource: DECK_SLIDE_RESOURCE_KIND, module: DECK_SLIDE_MODULE_ID, slot: "primary", mode: "rebind" },
    { resource: DECK_TYPST_RESOURCE_KIND, module: DECK_TYPST_MODULE_ID, slot: "bottom", mode: "rebind" },
    // Nothing in THIS composition raises `data-form` (both lists open
    // `data-record`), so the rule is declarative: it is what an App would add to
    // make a 「＋ 新建」 reveal the form as a panel, so that closing it is
    // closing a panel rather than flipping a mode flag. Kept because a showcase
    // that only demonstrates the mechanisms it happens to use is a worse
    // showcase, and because a rule that routes nowhere costs one row.
    { resource: DATA_FORM_RESOURCE_KIND, module: DATA_FORM_MODULE_ID, slot: "bottom", mode: "rebind" },
  ],
};

/** The exact bytes of `view/module-lock.json`. */
export const SHOWCASE_MODULE_LOCK_JSON = encodeModuleLock(SHOWCASE_MODULE_LOCK);

/** The exact bytes of `view/composition.json`. */
export const SHOWCASE_COMPOSITION_JSON = encodeComposition(SHOWCASE_COMPOSITION);

/**
 * The two, in the order the release inventory declares them.
 *
 * Two and not three: there is no `view/resource-bindings.json`, and there must
 * not be — see the header.
 */
export const SHOWCASE_MODULE_ASSETS: ReadonlyArray<{ name: string; source: string }> = Object.freeze([
  { name: COMPOSITION_ASSET, source: SHOWCASE_COMPOSITION_JSON },
  { name: MODULE_LOCK_ASSET, source: SHOWCASE_MODULE_LOCK_JSON },
]);
