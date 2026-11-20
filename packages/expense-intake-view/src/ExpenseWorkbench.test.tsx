import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentViewProvider } from "@claude-bot/agent-view-react";
import { createFixtureAgentViewClient } from "@claude-bot/agent-view-preview";
import { ExpenseWorkbench } from "./ExpenseWorkbench.js";

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "expense-1", author: "alice", merchant: "铁路服务", amount_value: 6200, amount: "¥6200.00",
    date: "2026-08-12", description: "项目出差", status: "review", badge: "待复核", tone: "warn",
    attachment: { name: "receipt.pdf", type: "application/pdf", size: 512, data: "JVBERi0-RAW-MUST-NOT-RENDER" },
    extracted: { 商户: "铁路服务", 金额: "¥6200.00", 日期: "2026-08-12", 说明: "项目出差", 发票号码: "DEMO-待核验" },
    history: [{ at: "2026-08-13T10:00:00Z", by: "alice", title: "已提交", detail: "材料进入处理流程", tone: "info" }],
    ...overrides,
  };
}

function mount(projection: Record<string, unknown>, actions: NonNullable<Parameters<typeof createFixtureAgentViewClient>[0]>["actions"] = {}) {
  const fixture = createFixtureAgentViewClient({ projection, actions });
  render(<AgentViewProvider client={fixture.client}><ExpenseWorkbench /></AgentViewProvider>);
  return fixture;
}

describe("ExpenseWorkbench", () => {
  it("renders only the submitter privacy tree even if unrelated keys are present", () => {
    mount({ intake: { mode: "submitter", can_submit: true, mine: [{ ...record(), attachment: undefined, extracted: undefined, attachment_name: "mine.pdf", attachment_size: 128 }], processing: [record({ merchant: "他人秘密商户" })], completed: [record({ merchant: "另一人记录", status: "approved" })] } });
    expect(screen.getByText("铁路服务")).toBeInTheDocument();
    expect(screen.getByText(/mine.pdf/)).toBeInTheDocument();
    expect(screen.queryByText("他人秘密商户")).not.toBeInTheDocument();
    expect(screen.queryByText("另一人记录")).not.toBeInTheDocument();
    expect(screen.queryByText("DEMO-待核验")).not.toBeInTheDocument();
  });

  it("renders a manager safe text preview and removes actions from completed records", () => {
    const completed = record({ id: "expense-2", merchant: "已完成商户", status: "approved", badge: "已通过" });
    mount({ intake: { mode: "manager", can_submit: false, mine: [], processing: [record()], completed: [completed] } }, { approve_expense: { ok: true }, reject_expense: { ok: true } });
    expect(screen.getAllByText("DEMO-待核验").length).toBeGreaterThan(0);
    expect(screen.getByText(/receipt.pdf · application\/pdf · 512 bytes/)).toBeInTheDocument();
    expect(screen.queryByText(/JVBERi0-RAW/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /已完成商户/ }));
    expect(screen.getByText("该记录已完成")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /拒绝/ })).not.toBeInTheDocument();
  });

  it("sends the exact PDF envelope params and keeps form plus File after refusal", async () => {
    const fixture = mount({ intake: { mode: "submitter", can_submit: true, mine: [], processing: [], completed: [] } }, { submit_expense: { ok: false, code: "action_rejected", message: "凭据接收暂时繁忙" } });
    const file = new File(["%PDF-"], "receipt.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("选择 PDF 凭据"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("申报商户"), { target: { value: "铁路服务" } });
    fireEvent.change(screen.getByLabelText("申报金额"), { target: { value: "6200.50" } });
    fireEvent.change(screen.getByLabelText("发生日期"), { target: { value: "2026-08-12" } });
    fireEvent.change(screen.getByLabelText(/说明/), { target: { value: "项目出差" } });
    fireEvent.click(screen.getByRole("button", { name: "提交凭据" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("凭据接收暂时繁忙");
    await waitFor(() => expect(fixture.proposals).toHaveLength(1));
    const proposal = fixture.proposals[0];
    expect(proposal).toMatchObject({ action: "submit_expense", params: { merchant: "铁路服务", amount: "6200.50", expense_date: "2026-08-12", description: "项目出差" } });
    expect(JSON.parse(proposal!.params.receipt_pdf)).toEqual({ name: "receipt.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" });
    expect(screen.getByLabelText("申报商户")).toHaveValue("铁路服务");
    expect(screen.getByText("receipt.pdf")).toBeInTheDocument();
    expect(fixture.client.snapshot().proposals).toEqual([]);
  });
});
