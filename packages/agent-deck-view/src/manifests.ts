/**
 * The three deck manifests, as pure data.
 *
 * Separated from the components so that something with no DOM can read them: a
 * release builder emits the module lock and the binding plan as JSON assets from
 * a Node process that has no business importing React or a stylesheet.
 *
 * ── Why there is ONE action id in the config and not five ───────────────────
 *
 * An earlier draft gave each module an `insert_action`, a `move_action`, a
 * `remove_action` and a `set_action`. That is five strings an App author has to
 * get right, five the reviewer has to check, and five the backend has to declare
 * — to express a vocabulary that is not the App's in the first place. The edit
 * vocabulary belongs to `deck-model/v1`: `readDeckCommand` is what decides
 * whether a proposal is an edit, and it lives in the contract.
 *
 * So a deck App declares ONE action, and `command_action` names it. The App's
 * backend is then a passthrough — read the command, apply it, commit — which is
 * what "a simple App is pure data" has to mean if it is to mean anything.
 *
 * Leaving `command_action` unset is a READ-ONLY deck: the same modules, no
 * controls, no second implementation. That is the same shape `READ_ONLY_REFUSAL`
 * gives the data modules, expressed one layer up.
 *
 * ── Why `ports` names `app-data/v1` while no App binds it ───────────────────
 *
 * See `agent-data-view/src/port.ts`: it is a typed port the module needs,
 * satisfied by the App from its own channel rather than by a deployment's
 * provider catalog. A deck is App-owned durable state, not a user resource, so
 * there is no binding to declare and no provider to install.
 */

import type { AgentModuleManifest, ModuleConfigDeclaration } from "@claude-bot/agent-module-contract";
import { APP_DATA_CONTRACT } from "@claude-bot/agent-data-view/port";

const VERSION = "1.0.0";
const PACKAGE = "@claude-bot/agent-deck-view";

export const DECK_OUTLINE_MODULE_ID = "deck.outline/v1";
export const DECK_SLIDE_MODULE_ID = "deck.slide/v1";
export const DECK_TYPST_MODULE_ID = "deck.typst/v1";

/**
 * The deck, seen one slide at a time.
 *
 * **The `ref` names the DECK; `context.slide` says which slide.** That reads
 * backwards until you know why, and the why is a measured property of the layout
 * kernel (`layout-finding.test.ts`): a module that is not a connected surface
 * gets its declared composition instance rebound only while that instance holds
 * no resource. A ref per slide therefore lands the first slide in the configured
 * panel and every later one in an anonymous panel with `config: null` — no
 * `source`, no action, nothing to render.
 *
 * Addressing the deck and passing the slide as context is the shape the reducer
 * already documents ("the same document at another line is the same panel with a
 * replaced instruction"). It is also the honest model: a slide is a position in
 * a document, not a document.
 *
 * The cost, stated: two slides cannot be opened side by side. The binding
 * document's v1 cannot express a second connected instance either, so that limit
 * is the platform's.
 */
export const DECK_SLIDE_RESOURCE_KIND = "deck-slide";

/** The key `deck.outline/v1` puts the slide id under, and `deck.slide/v1` reads. */
export const DECK_SLIDE_CONTEXT_KEY = "slide";

/**
 * The generated Typst source.
 *
 * A resource kind rather than a mode flag, so "show me the Typst" opens a PANEL
 * and closing it closes a panel. That is the one opening mechanism this platform
 * has, and a second one inside a module would be a second layout system.
 */
export const DECK_TYPST_RESOURCE_KIND = "deck-typst";

export const DECK_OUTLINE_CONFIG: ModuleConfigDeclaration = Object.freeze({
  source: { type: "string", required: true, description: "投影里这份 deck 文档的路径，如 `deck`" },
  title: { type: "string", description: "面板标题" },
  command_action: { type: "string", description: "提交编辑命令的 App 动作 id；不填 = 只读大纲" },
  open_kind: { type: "string", description: "选中一页时打开的资源类型，默认 deck-slide" },
  open_view: { type: "string", description: "可选：指定由哪个模块打开（仍要匹配 composition 的 open 规则）" },
  export_kind: { type: "string", description: "「导出 Typst」打开的资源类型，默认 deck-typst；设为空则不显示按钮" },
  empty_text: { type: "string", description: "deck 还没有任何一页时显示的一句话" },
});

export const DECK_SLIDE_CONFIG: ModuleConfigDeclaration = Object.freeze({
  source: { type: "string", required: true, description: "投影里这份 deck 文档的路径" },
  title: { type: "string", description: "面板标题" },
  command_action: { type: "string", description: "提交编辑命令的 App 动作 id；不填 = 只读" },
  hint: { type: "string", description: "编辑区下方的一句提示" },
});

export const DECK_TYPST_CONFIG: ModuleConfigDeclaration = Object.freeze({
  source: { type: "string", required: true, description: "投影里这份 deck 文档的路径" },
  title: { type: "string", description: "面板标题" },
});

export const DECK_OUTLINE_MANIFEST: AgentModuleManifest = {
  id: DECK_OUTLINE_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#DeckOutline`,
  title: "幻灯片大纲",
  slots: ["navigation", "primary", "secondary"],
  ports: [APP_DATA_CONTRACT],
  // It opens nothing itself: it RAISES `open-resource/v1` and the composition
  // decides which module answers. Declaring `opens` here would be this module
  // claiming it can display a document it has no code for.
  opens: [],
  config: DECK_OUTLINE_CONFIG,
};

export const DECK_SLIDE_MANIFEST: AgentModuleManifest = {
  id: DECK_SLIDE_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#DeckSlide`,
  title: "幻灯片编辑",
  slots: ["primary", "secondary"],
  ports: [APP_DATA_CONTRACT],
  opens: [DECK_SLIDE_RESOURCE_KIND],
  config: DECK_SLIDE_CONFIG,
};

export const DECK_TYPST_MANIFEST: AgentModuleManifest = {
  id: DECK_TYPST_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#DeckTypst`,
  title: "Typst 源码",
  slots: ["secondary", "primary", "bottom"],
  ports: [APP_DATA_CONTRACT],
  opens: [DECK_TYPST_RESOURCE_KIND],
  config: DECK_TYPST_CONFIG,
};

export const DECK_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([
  DECK_OUTLINE_MANIFEST,
  DECK_SLIDE_MANIFEST,
  DECK_TYPST_MANIFEST,
]);
