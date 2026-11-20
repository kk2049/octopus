import { definePreviewPlan } from "@claude-bot/agent-view-preview";
import { APP_DATA_CONTRACT, appDataAdapter } from "@claude-bot/agent-data-view";
import { project } from "../app/projection.js";
import { DAILY_BRIEF_MODULES } from "./modules.js";
import { DAILY_BRIEF_COMPOSITION } from "./plan.js";
import "./styles/app.css";

const projection = project([
  { type: "summary_requested", at: "2026-08-12T21:00:00Z", by: "user:alice", data: { id: "request-1", period: "2026-08-13", focus: "关键会议、冲突和需要提前准备的事项" } },
  { type: "summary_published", at: "2026-08-13T08:02:00Z", by: "agent:daily-brief/mcp@alice", data: {
    id: "summary-1", period: "2026-08-13", headline: "今天的注意力窗口集中在下午", request_id: "request-1",
    body: "## 今日节奏\n\n上午保留一段完整的深度工作时间。14:00 的产品复盘与 15:00 的合作方沟通相邻，建议在午饭前准备共同材料。\n\n## 需要行动\n\n- 11:30 前确认复盘数据\n- 为合作方沟通留出 15 分钟缓冲\n- 18:00 前完成两个未闭环任务",
    evidence: "- 飞书主日历：09:30 团队同步、14:00 产品复盘、15:00 合作方沟通\n- 任务列表：2 项今天到期\n- 未复制任何完整文档正文",
    coverage: "读取本人主日历当日事件与未完成任务；没有读取聊天记录或工作区文件。",
  } },
  { type: "summary_corrected", at: "2026-08-13T08:40:00Z", by: "user:alice", data: {
    id: "correction-1", summary_id: "summary-1", reason: "复盘改到了 15:30",
    body: "## 今日节奏\n\n上午保留一段完整的深度工作时间。产品复盘改到 15:30，与合作方沟通对调。\n\n## 需要行动\n\n- 11:30 前确认复盘数据\n- 为合作方沟通留出 15 分钟缓冲\n- 18:00 前完成两个未闭环任务",
  } },
  { type: "summary_requested", at: "2026-08-13T09:00:00Z", by: "user:alice", data: { id: "request-2", period: "本周", focus: "两个项目的 DDL 风险" } },
]);

export default definePreviewPlan({
  title: "日程总结",
  composition: DAILY_BRIEF_COMPOSITION,
  modules: DAILY_BRIEF_MODULES,
  providers: { [APP_DATA_CONTRACT]: appDataAdapter },
  projection,
  actions: {
    request_summary: (params) => ({ ok: true, message: `预览：已记录「${params.period ?? ""}」（没有真的写入）` }),
    correct_summary: { ok: true, message: "预览：已修正（没有真的写入）" },
    acknowledge_summary: { ok: true, message: "预览：已确认（没有真的写入）" },
  },
  presentation: "dock-documents",
  className: "daily-brief",
  dock: { surfaceClassName: { navigation: "brief-fixed-rail", bottom: "brief-fixed-actions", primary: "brief-document" } },
});
