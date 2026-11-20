import { definePreviewPlan } from "@claude-bot/agent-view-preview";
import { APP_DATA_CONTRACT, appDataAdapter } from "@claude-bot/agent-data-view";
import { project } from "../app/projection.js";
import { REPORT_SPACE_MODULES } from "./modules.js";
import { REPORT_SPACE_COMPOSITION } from "./plan.js";
import "./styles/app.css";

const projection = project([
  { type: "report_submitted", at: "2026-08-13T08:00:00Z", by: "agent:report-space/mcp@alice", data: {
    actor_user: "alice", id: "report-1", subject: "Agentic App 汇报链收敛", recipient: "产品与平台组", period: "本周",
    body: "## 结果\n\n个人总结和共享汇报都已迁移到声明式事件流。外部 Agent 通过 MCP 读资料、写结论，服务端不托管模型。\n\n## 下一步\n\n- 完成飞书本人授权\n- 给首批用户签发最小 token\n- 观察共享空间的实际信息密度",
    evidence: "- `app.yaml`：动作、角色和参数唯一声明\n- 提交历史：actor、action、参数摘要、代码指纹\n- 源文件 capability 未进入共享空间",
  } },
  { type: "report_seen", at: "2026-08-13T08:20:00Z", by: "user:bob", data: { actor_user: "bob", report_id: "report-1" } },
  { type: "report_commented", at: "2026-08-13T08:24:00Z", by: "user:bob", data: { actor_user: "bob", report_id: "report-1", body: "同意按最小 token 先开放给首批用户。" } },
  { type: "report_decided", at: "2026-08-13T08:30:00Z", by: "user:bob", data: { actor_user: "bob", report_id: "report-1", decision: "完成 OAuth 后上线首批空间" } },
  { type: "report_submitted", at: "2026-08-13T09:00:00Z", by: "user:carol", data: {
    actor_user: "carol", id: "report-2", subject: "运行观察：首周指标", recipient: "全体成员",
    body: "## 观察\n\n- 空间打开率高于预期\n- 讨论集中在结论区\n\n## 请求\n\n请大家补充各自的阻塞项。",
  } },
]);

export default definePreviewPlan({
  title: "共享汇报空间",
  composition: REPORT_SPACE_COMPOSITION,
  modules: REPORT_SPACE_MODULES,
  providers: { [APP_DATA_CONTRACT]: appDataAdapter },
  projection,
  actions: {
    submit_report: (params) => ({ ok: true, message: `预览：收到「${params.subject ?? ""}」（没有真的写入）` }),
    mark_seen: { ok: true, message: "预览：已标记（没有真的写入）" },
    comment_report: { ok: true, message: "预览：已发表（没有真的写入）" },
    record_decision: { ok: true, message: "预览：已记录（没有真的写入）" },
    close_report: { ok: true, message: "预览：已关闭（没有真的写入）" },
    retract_report: { ok: false, code: "denied", message: "预览：只有提交者本人可以撤回" },
  },
  presentation: "dock-documents",
  className: "report-space",
  dock: { surfaceClassName: { navigation: "report-fixed-rail", bottom: "report-fixed-actions", primary: "report-document" } },
});
