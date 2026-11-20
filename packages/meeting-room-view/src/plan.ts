import {
  COMPOSITION_SCHEMA, encodeComposition, encodeModuleLock, moduleLockOf,
  type AgentComposition, type AgentModuleLock, type AgentModuleManifest,
} from "@claude-bot/agent-module-contract";
import { DATA_DETAIL_MODULE_ID, DATA_LIST_MODULE_ID, DATA_MANIFESTS } from "@claude-bot/agent-data-view/manifests";
import { SCHEDULE_BOOKING_MODULE_ID, SCHEDULE_MANIFESTS } from "@claude-bot/agent-schedule-view/manifests";

export const MEETING_ROOM_APP = "meeting-room";
export const MEETING_ROOM_PUBLISHER = "octopus:first-party";
export const MODULE_LOCK_ASSET = "view/module-lock.json";
export const COMPOSITION_ASSET = "view/composition.json";

export const MEETING_ROOM_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([...DATA_MANIFESTS, ...SCHEDULE_MANIFESTS]);
export const MEETING_ROOM_MODULE_LOCK: AgentModuleLock = moduleLockOf(MEETING_ROOM_MANIFESTS);
export const MEETING_ROOM_COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: MEETING_ROOM_APP,
  instances: [
    { instance: "status", module: DATA_DETAIL_MODULE_ID, slot: "navigation", title: "预订规则",
      config: { source: "status_panel", empty_text: "会议室正在初始化。" } },
    { instance: "calendar", module: SCHEDULE_BOOKING_MODULE_ID, slot: "primary", title: "会议室日历",
      config: { source: "schedule", action: "book_room", purpose_label: "用途", submit_label: "确认预约" } },
    { instance: "recent", module: DATA_LIST_MODULE_ID, slot: "secondary", title: "最近预约",
      config: { source: "recent", id_key: "id", title_key: "purpose", subtitle_key: "subtitle", empty_text: "还没有预约。", limit: 50 } },
  ],
  open: [],
};
export const MEETING_ROOM_MODULE_ASSETS = Object.freeze([
  { name: COMPOSITION_ASSET, source: encodeComposition(MEETING_ROOM_COMPOSITION) },
  { name: MODULE_LOCK_ASSET, source: encodeModuleLock(MEETING_ROOM_MODULE_LOCK) },
]);
