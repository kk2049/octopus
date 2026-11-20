import { defineCustomPreview } from "@claude-bot/agent-view-preview";
import { ExpenseWorkbench } from "../src/ExpenseWorkbench.js";

const review = {
  id: "expense-2026-0815-07",
  author: "lht",
  merchant: "华北铁路服务",
  amount: "¥620.50",
  date: "2026-08-12",
  description: "项目出差",
  status: "review",
  badge: "待复核",
  attachment: { name: "rail-receipt.pdf", type: "application/pdf", size: 42_880 },
  extracted: { 商户: "华北铁路服务", 金额: "¥620.50", 日期: "2026-08-12", 说明: "项目出差" },
  history: [
    { at: "2026-08-15T02:10:00Z", by: "lht", title: "已提交", detail: "材料进入处理流程" },
    { at: "2026-08-15T02:10:04Z", by: "expense-agent", title: "等待复核", detail: "申报值与提取值已分列" },
  ],
};

export default defineCustomPreview({
  kind: "custom",
  app: "expense-intake",
  title: "凭据流 · 财务复核",
  projection: { intake: { mode: "manager", can_submit: false, mine: [], processing: [review], completed: [] } },
  actions: { approve_expense: { ok: true }, reject_expense: { ok: true } },
  render: () => <ExpenseWorkbench />,
});
