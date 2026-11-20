import type { AgentModuleManifest, ModuleConfigDeclaration } from "@claude-bot/agent-module-contract";
import { APP_DATA_CONTRACT } from "@claude-bot/agent-data-view/port";

export const SCHEDULE_BOOKING_MODULE_ID = "schedule.booking-grid/v1";

export const SCHEDULE_BOOKING_CONFIG: ModuleConfigDeclaration = Object.freeze({
  source: { type: "string", required: true, description: "投影里资源日历的路径" },
  action: { type: "string", required: true, description: "确认预约时提议的 App action" },
  purpose_label: { type: "string", description: "用途输入框标签" },
  submit_label: { type: "string", description: "确认按钮文案" },
  empty_text: { type: "string", description: "没有日期或资源时的说明" },
});

export const SCHEDULE_BOOKING_MANIFEST: AgentModuleManifest = {
  id: SCHEDULE_BOOKING_MODULE_ID,
  version: "1.0.0",
  implementation: "@claude-bot/agent-schedule-view#BookingGrid",
  title: "资源预约日历",
  slots: ["primary", "secondary"],
  ports: [APP_DATA_CONTRACT],
  opens: [],
  config: SCHEDULE_BOOKING_CONFIG,
};

export const SCHEDULE_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([SCHEDULE_BOOKING_MANIFEST]);
