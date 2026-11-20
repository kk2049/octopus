import {
  COMPOSITION_SCHEMA, encodeComposition, encodeModuleLock, moduleLockOf,
  type AgentComposition, type AgentModuleManifest,
} from "@claude-bot/agent-module-contract";
import {
  DATA_ACTIONS_MODULE_ID, DATA_DETAIL_MODULE_ID, DATA_LIST_MODULE_ID, DATA_MANIFESTS, DATA_RECORD_RESOURCE_KIND,
} from "@claude-bot/agent-data-view/manifests";

export const DAILY_BRIEF_APP = "daily-brief";
export const DAILY_BRIEF_PUBLISHER = "octopus:first-party";
export const DAILY_BRIEF_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([...DATA_MANIFESTS]);
export const DAILY_BRIEF_MODULE_LOCK = moduleLockOf(DAILY_BRIEF_MANIFESTS);

/**
 * One record workbench, not three panes that do not know about each other.
 *
 * `primary` holds a SINGLE detail instance: the summary with its own evidence
 * and coverage as sections, its request→publish→correction→acknowledgement
 * thread, and a record menu whose forms lock the summary id in. (Two detail
 * instances in one slot was the layout's rebind hijack — the second click used
 * to grab the evidence pane.) `default_ref` shows the newest summary before
 * anything is clicked; per-record actions live on the record, so `bottom`
 * carries only the one action that creates work: 请求总结.
 */
export const DAILY_BRIEF_COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: DAILY_BRIEF_APP,
  instances: [
    { instance: "status", module: DATA_DETAIL_MODULE_ID, slot: "navigation", title: "概览", config: {
      source: "status_panel", title: "概览", variant: "stats",
    } },
    { instance: "history", module: DATA_LIST_MODULE_ID, slot: "navigation", title: "历史总结", config: {
      source: "briefs", title: "历史总结", id_key: "id", title_key: "title", subtitle_key: "subtitle",
      badge_key: "badge", tone_key: "tone", open_kind: DATA_RECORD_RESOURCE_KIND, default_ref: "latest_id",
      empty_text: "还没有总结。先在下方「请求总结」记一条。",
    } },
    { instance: "requests", module: DATA_LIST_MODULE_ID, slot: "navigation", title: "请求", config: {
      source: "requests", title: "总结请求", id_key: "id", title_key: "title", subtitle_key: "subtitle",
      badge_key: "badge", tone_key: "tone", notice: "requests_notice", empty_text: "没有待处理请求。",
    } },
    { instance: "summary", module: DATA_DETAIL_MODULE_ID, slot: "primary", title: "总结", config: {
      source: "briefs", id_key: "id", body_key: "body", fields: "brief_fields", sections: "brief_sections",
      thread_key: "thread", thread_title: "记录", menu: "brief_menu",
      allowed_actions: "acknowledge_summary,correct_summary", default_ref: "latest_id",
      empty_text: "还没有总结。请求一条，然后让你本机的 Agent 发布。",
    } },
    { instance: "actions", module: DATA_ACTIONS_MODULE_ID, slot: "bottom", title: "动作", config: {
      source: "action_menu", allowed_actions: "request_summary", title: "总结动作",
    } },
  ],
  open: [{ resource: DATA_RECORD_RESOURCE_KIND, module: DATA_DETAIL_MODULE_ID, slot: "primary", mode: "rebind" }],
};

export const DAILY_BRIEF_MODULE_ASSETS = Object.freeze([
  { name: "view/composition.json", source: encodeComposition(DAILY_BRIEF_COMPOSITION) },
  { name: "view/module-lock.json", source: encodeModuleLock(DAILY_BRIEF_MODULE_LOCK) },
]);
