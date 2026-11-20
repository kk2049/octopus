import { COMPOSITION_SCHEMA, encodeComposition, encodeModuleLock, moduleLockOf, type AgentComposition, type AgentModuleManifest } from "@claude-bot/agent-module-contract";
import { DATA_ACTIONS_MODULE_ID, DATA_DETAIL_MODULE_ID, DATA_LIST_MODULE_ID, DATA_MANIFESTS, DATA_RECORD_RESOURCE_KIND } from "@claude-bot/agent-data-view/manifests";

export const REPORT_SPACE_APP = "report-space";
export const REPORT_SPACE_PUBLISHER = "octopus:first-party";
export const REPORT_SPACE_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([...DATA_MANIFESTS]);
export const REPORT_SPACE_MODULE_LOCK = moduleLockOf(REPORT_SPACE_MANIFESTS);

/**
 * One record workbench (see daily-brief's plan for the rationale): `primary`
 * holds a single report detail with its evidence section, its full
 * submission→seen→discussion→decision thread, and a record menu that locks the
 * report id into every per-report form. `bottom` carries only 发起汇报.
 */
export const REPORT_SPACE_COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA, app: REPORT_SPACE_APP,
  instances: [
    { instance: "room", module: DATA_DETAIL_MODULE_ID, slot: "navigation", title: "空间", config: {
      source: "room_panel", title: "空间概览", variant: "stats",
    } },
    { instance: "reports", module: DATA_LIST_MODULE_ID, slot: "navigation", title: "汇报", config: {
      source: "reports", title: "汇报", id_key: "id", title_key: "title", subtitle_key: "subtitle",
      badge_key: "badge", tone_key: "tone", open_kind: DATA_RECORD_RESOURCE_KIND, default_ref: "latest_id",
      notice: "reports_notice", empty_text: "这个空间还没有汇报。",
    } },
    { instance: "feed", module: DATA_LIST_MODULE_ID, slot: "navigation", title: "动态", config: {
      source: "feed", title: "最近动态", id_key: "id", title_key: "title", subtitle_key: "subtitle",
      tone_key: "tone", limit: 100, empty_text: "还没有动态。",
    } },
    { instance: "report", module: DATA_DETAIL_MODULE_ID, slot: "primary", title: "汇报", config: {
      source: "reports", id_key: "id", body_key: "body", fields: "report_fields", sections: "report_sections",
      thread_key: "thread", thread_title: "讨论与流转", menu: "report_menu",
      allowed_actions: "mark_seen,comment_report,record_decision,close_report,retract_report",
      default_ref: "latest_id", empty_text: "这个空间还没有汇报。用下方「发起汇报」提交第一份。",
    } },
    { instance: "actions", module: DATA_ACTIONS_MODULE_ID, slot: "bottom", title: "动作", config: {
      source: "action_menu", allowed_actions: "submit_report", title: "汇报动作",
    } },
  ],
  open: [{ resource: DATA_RECORD_RESOURCE_KIND, module: DATA_DETAIL_MODULE_ID, slot: "primary", mode: "rebind" }],
};

export const REPORT_SPACE_MODULE_ASSETS = Object.freeze([
  { name: "view/composition.json", source: encodeComposition(REPORT_SPACE_COMPOSITION) },
  { name: "view/module-lock.json", source: encodeModuleLock(REPORT_SPACE_MODULE_LOCK) },
]);
