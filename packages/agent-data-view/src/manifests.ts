/**
 * The four data manifests, as pure data.
 *
 * Separated from the components so that something with no DOM can read them: a
 * release builder has to emit the module lock and the binding plan as JSON
 * assets, and it runs in a Node process that has no business importing React or
 * a stylesheet.
 *
 * ── What `config` buys, and why these modules exist at all ──────────────────
 *
 * Decision 7 gave a manifest a `config` declaration and a composition instance
 * a `config` value. These are the first modules written FOR that: one
 * implementation, two instances, two purposes. `收件箱` and `归档箱` are the
 * same `data.list/v1` pointed at two projection paths — not two modules, not one
 * module with a mode flag, and not a branch inside the component.
 *
 * So the declarations below are the module's whole vocabulary. Every key a
 * component reads is here; `config.test.ts` proves the two lists are the same
 * list, because a key the module reads and the manifest does not declare would
 * be silently dropped at link time and the panel would render defaults with no
 * explanation.
 *
 * ── Why `ports` names `app-data/v1` while no App binds it ───────────────────
 *
 * See `port.ts`: it is a typed port the module needs, satisfied by the App from
 * its own channel rather than by a deployment's provider catalog. A binding
 * document that declared it would be asking a deployment to install something no
 * catalog serves.
 */

import type { AgentModuleManifest, ModuleConfigDeclaration } from "@claude-bot/agent-module-contract";
import { APP_DATA_CONTRACT } from "./port.js";

/**
 * The version every data module in this package ships at.
 *
 * 1.1.0 (ticket #97): record menus with context injection, per-record sections
 * and threads, default_ref, list notices, the stats variant. Same interface
 * major — every 1.0 composition links unchanged.
 */
const VERSION = "1.1.0";
const PACKAGE = "@claude-bot/agent-data-view";

export const DATA_LIST_MODULE_ID = "data.list/v1";
export const DATA_DETAIL_MODULE_ID = "data.detail/v1";
export const DATA_FORM_MODULE_ID = "data.form/v1";
export const DATA_ACTIONS_MODULE_ID = "data.actions/v1";

/**
 * The kind a list raises by default, and the one a detail panel answers for.
 *
 * A resource kind is a vocabulary, not a type: `data-record` says "one row of
 * whatever collection the composition wired up". The opaque `ref` is the row's
 * id, and what it means belongs to the App that minted it — exactly the promise
 * every other `ref` in this platform makes.
 */
export const DATA_RECORD_RESOURCE_KIND = "data-record";

/**
 * The kind that opens a form as a panel rather than as a permanent surface.
 *
 * A deliberate use of the ONE opening mechanism rather than a second one: an
 * App that wants "＋ 新建" to reveal a form writes an open rule for this kind,
 * and closing the form is closing a panel instead of flipping a mode flag.
 */
export const DATA_FORM_RESOURCE_KIND = "data-form";

/**
 * What a list instance is told.
 *
 * `source` is a dotted path into the projection; the `*_key` fields say which
 * field of a row carries which role. `open_kind` is what turns a list into a
 * navigator: with it set, selecting a row raises `open-resource/v1` with the
 * row's id as the opaque ref, and the composition's open rules decide which
 * module answers. Without it, selection is local highlight and nothing else.
 */
export const DATA_LIST_CONFIG: ModuleConfigDeclaration = Object.freeze({
  source: { type: "string", required: true, description: "投影里这份集合的路径，如 `inbox` 或 `stats.recent`" },
  title: { type: "string", description: "列表标题" },
  id_key: { type: "string", description: "条目 id 字段名，默认 id" },
  title_key: { type: "string", description: "条目标题字段名，默认 title" },
  subtitle_key: { type: "string", description: "条目副标题字段名，默认 subtitle" },
  badge_key: { type: "string", description: "条目角标字段名，默认 badge" },
  tone_key: { type: "string", description: "条目色调字段名（ok/warn/error/info），默认 tone" },
  empty_text: { type: "string", description: "集合为空时显示的一句话" },
  limit: { type: "number", description: "每页渲染多少条（「显示更多」逐页展开），默认 200，最大 500" },
  open_kind: { type: "string", description: "选中条目时打开的资源类型；不填则只做本地高亮" },
  open_view: { type: "string", description: "可选：指定由哪个模块打开（仍要匹配 composition 的 open 规则）" },
  default_ref: { type: "string", description: "投影里初始高亮条目 id 的路径；读者点过之后以点击为准" },
  notice: { type: "string", description: "投影里 `{tone, text}` 横幅的路径；投影不给值就不显示" },
});

/**
 * What a detail instance is told.
 *
 * `id_key` decides the whole reading: set means `source` is a COLLECTION and the
 * panel shows the record its `resourceRef` names; unset means `source` IS the
 * record. One key, one meaning, no guessing at the shape.
 */
export const DATA_DETAIL_CONFIG: ModuleConfigDeclaration = Object.freeze({
  source: { type: "string", required: true, description: "投影里这条记录（或这份集合）的路径" },
  title: { type: "string", description: "面板标题；不填则用记录的标题字段" },
  id_key: { type: "string", description: "填了 = source 是集合、按打开的 ref 查找；不填 = source 就是这条记录" },
  title_key: { type: "string", description: "标题字段名，默认 title" },
  body_key: { type: "string", description: "正文字段名（按 Markdown 渲染），默认 body" },
  fields: { type: "string", description: "投影里字段名清单（数组或 {字段: 标签} 映射）的路径；不填则列出全部标量字段" },
  empty_text: { type: "string", description: "还没有选中记录时显示的一句话" },
  default_ref: { type: "string", description: "投影里默认记录 id 的路径；没有打开的 ref 时显示它而不是空面板" },
  sections: { type: "string", description: "投影里 {字段: 小节标题} 清单的路径；命名的记录字段按 Markdown 小节渲染在正文后" },
  thread_key: { type: "string", description: "记录里线程数组字段名（[{by,at,text,badge,tone}]），按时间线渲染" },
  thread_title: { type: "string", description: "线程小节标题，默认「动态」" },
  menu: { type: "string", description: "投影里记录级动作菜单的路径；条目可带 context_param 收下当前记录 id" },
  allowed_actions: { type: "string", description: "菜单可提议的动作 id，逗号分隔；与 menu 配套，是组合审阅过的允许集" },
  variant: { type: "string", description: "呈现变体：默认卡片；`stats` 把事实表渲染成统计格" },
});

/**
 * What a form instance is told.
 *
 * `action` is the App action this form proposes — the only place an action id
 * exists in this package, and it is data an App author wrote in a composition a
 * reviewer read. `fields` points at the action's parameter declaration in the
 * projection, so the form is GENERATED from the same statement the backend
 * validates against rather than hand-drawn beside it.
 */
export const DATA_FORM_CONFIG: ModuleConfigDeclaration = Object.freeze({
  action: { type: "string", required: true, description: "提交时提议的 App 动作 id" },
  fields: { type: "string", required: true, description: "投影里该动作参数声明的路径（engine 的 params 形状）" },
  title: { type: "string", description: "表单标题" },
  submit_label: { type: "string", description: "提交按钮文案，默认「提交」" },
  hint: { type: "string", description: "表单下方的一句提示" },
  reset_on_success: { type: "boolean", description: "提交成功后是否清空，默认清空" },
  context_param: { type: "string", description: "由打开上下文注入的参数名；该字段不再要求输入，渲染为锁定值" },
  context_value: { type: "string", description: "注入的参数值，与 context_param 配套；参数未在声明里时忽略" },
});

/**
 * A compact launcher for a reviewed set of App actions.
 *
 * Labels and form paths remain projection data so the same module works for
 * every App. The action ids do not: `allowed_actions` is part of the signed
 * composition, and the module intersects the projection with that list before
 * it can propose anything. A backend therefore cannot grow the View's action
 * surface merely by emitting one more row.
 */
export const DATA_ACTIONS_CONFIG: ModuleConfigDeclaration = Object.freeze({
  source: { type: "string", required: true, description: "投影里动作菜单声明的路径" },
  allowed_actions: { type: "string", required: true, description: "组合审阅过的动作 id，使用逗号分隔" },
  title: { type: "string", description: "动作条标题，默认「可用动作」" },
});

export const DATA_LIST_MANIFEST: AgentModuleManifest = {
  id: DATA_LIST_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#DataList`,
  title: "列表",
  slots: ["navigation", "primary", "secondary", "bottom"],
  ports: [APP_DATA_CONTRACT],
  // It opens nothing itself: it RAISES `open-resource/v1`, and the composition
  // decides which module answers. Declaring `opens` here would be this module
  // claiming it can display a document it has no code for.
  opens: [],
  config: DATA_LIST_CONFIG,
};

export const DATA_DETAIL_MANIFEST: AgentModuleManifest = {
  id: DATA_DETAIL_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#DataDetail`,
  title: "详情",
  // `bottom` too: a facts table of counts along the strip is the same widget as
  // a record pane, and refusing it there would push an App into writing a second
  // module for the same rendering.
  slots: ["primary", "secondary", "navigation", "bottom"],
  ports: [APP_DATA_CONTRACT],
  // A manifest cannot enumerate kinds it has never heard of, so this package
  // names one and an App routes to it. An App with its own kind vocabulary
  // writes an open rule to a module that declares that kind.
  opens: [DATA_RECORD_RESOURCE_KIND],
  config: DATA_DETAIL_CONFIG,
};

export const DATA_FORM_MANIFEST: AgentModuleManifest = {
  id: DATA_FORM_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#DataForm`,
  title: "表单",
  slots: ["secondary", "primary", "bottom", "navigation"],
  ports: [APP_DATA_CONTRACT],
  opens: [DATA_FORM_RESOURCE_KIND],
  config: DATA_FORM_CONFIG,
};

export const DATA_ACTIONS_MANIFEST: AgentModuleManifest = {
  id: DATA_ACTIONS_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#DataActions`,
  title: "动作条",
  slots: ["bottom", "navigation", "secondary", "primary"],
  ports: [APP_DATA_CONTRACT],
  opens: [],
  config: DATA_ACTIONS_CONFIG,
};

/** Every data manifest, in registration order. */
export const DATA_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([
  DATA_LIST_MANIFEST,
  DATA_DETAIL_MANIFEST,
  DATA_FORM_MANIFEST,
  DATA_ACTIONS_MANIFEST,
]);
