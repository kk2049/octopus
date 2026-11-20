import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IntakeWorkflow } from "./IntakeWorkflow.js";

const item: any = { id: "expense-1", title: "铁路 · ¥120.00", subtitle: "alice", badge: "待复核", tone: "warn", status: "review", author: "alice", merchant: "铁路", amount: "¥120.00", date: "2026-08-12", description: "出差", extracted: { 商户: "铁路" }, attachment: { name: "ticket.pdf", type: "application/pdf", size: 20, data: "JVBERi0" }, history: [{ at: "now", title: "字段提取", detail: "完成", tone: "ok" }] };
const intake: any = { status: "ok", mode: "manager", canSubmit: false, completed: [], processing: [item], mine: [], stats: {} };

describe("IntakeWorkflow", () => {
  it("opens a record, structured PDF preview and compact agent history", () => {
    render(<IntakeWorkflow intake={intake} busy={false} notice={null} file={null} submitLabel="提交" onFile={vi.fn()} onSubmit={vi.fn()} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByRole("row"));
    fireEvent.click(screen.getByRole("button", { name: /ticket\.pdf/ }));
    expect(screen.getByRole("document")).toHaveTextContent("安全预览");
    fireEvent.click(screen.getByRole("button", { name: /Agent 历史/ }));
    expect(screen.getByText("字段提取")).toBeInTheDocument();
  });

  it("drops privileged dialog state when a new projection revokes the record", () => {
    const props = { busy: false, notice: null, file: null, submitLabel: "提交", onFile: vi.fn(), onSubmit: vi.fn(), onDecide: vi.fn() };
    const { rerender } = render(<IntakeWorkflow {...props} intake={intake} />);
    fireEvent.click(screen.getByRole("row"));
    fireEvent.click(screen.getByRole("button", { name: /ticket\.pdf/ }));
    expect(screen.getByRole("document")).toBeInTheDocument();
    rerender(<IntakeWorkflow {...props} intake={{ ...intake, mode: "submitter", processing: [], mine: [] }} />);
    expect(screen.queryByRole("document")).not.toBeInTheDocument();
    expect(screen.queryByText("ticket.pdf")).not.toBeInTheDocument();
  });
});
