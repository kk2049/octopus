import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentInteraction } from "@claude-bot/agent-sessions-contract";
import { AgentInteractionCard } from "./AgentInteractionCard.js";

const question: AgentInteraction = {
  id: "ai_acceptance",
  provider: "claude",
  kind: "question",
  title: "Claude Code 需要你的回答",
  tool: "AskUserQuestion",
  questions: [{
    id: "acceptance",
    header: "验收结果",
    prompt: "新版 Agent adaptor 的网页提问闭环是否验收通过？",
    options: [
      { label: "通过", description: "网页卡片正常出现，交互闭环完整" },
      { label: "不通过", description: "卡片没有出现，或交互异常" },
    ],
    multiple: false,
    allow_other: false,
    secret: false,
  }],
  created_at: "2026-08-12T03:00:00Z",
  expires_at: "2026-08-12T03:10:00Z",
  capabilities: { respond: true, allow: true, deny: true },
};

describe("AgentInteractionCard", () => {
  it("submits the selected answer in the provider-neutral envelope", async () => {
    const onRespond = vi.fn(async () => {});
    render(<AgentInteractionCard interaction={question} onRespond={onRespond} />);
    expect(screen.getByText("AskUserQuestion")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/通过网页卡片正常出现/));
    await userEvent.click(screen.getByRole("button", { name: "提交回答并继续" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith({
      decision: "allow",
      answers: { acceptance: ["通过"] },
    }));
    expect(screen.getByText("已提交：通过")).toBeInTheDocument();
    expect(document.querySelector('[data-agent-interaction-state="resolved"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "提交回答并继续" })).not.toBeInTheDocument();
    expect(screen.queryByText("新版 Agent adaptor 的网页提问闭环是否验收通过？")).not.toBeInTheDocument();
  });

  it("requires an answer before allowing a question", async () => {
    const onRespond = vi.fn(async () => {});
    render(<AgentInteractionCard interaction={question} onRespond={onRespond} />);
    await userEvent.click(screen.getByRole("button", { name: "提交回答并继续" }));
    expect(screen.getByRole("alert")).toHaveTextContent("验收结果");
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("can deny a permission request without inventing question answers", async () => {
    const onRespond = vi.fn(async () => {});
    render(<AgentInteractionCard interaction={{
      ...question,
      id: "ai_permission",
      provider: "codex",
      kind: "permission",
      title: "Codex 请求执行命令",
      questions: [],
    }} onRespond={onRespond} />);
    await userEvent.type(screen.getByLabelText("拒绝原因（可选）"), "这次不执行");
    await userEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith({
      decision: "deny",
      answers: {},
      message: "这次不执行",
    }));
  });

  it("does not retain or echo a secret answer in the compact receipt", async () => {
    const onRespond = vi.fn(async () => {});
    render(<AgentInteractionCard interaction={{
      ...question,
      id: "ai_secret",
      questions: [{
        id: "token",
        header: "令牌",
        prompt: "输入一次性令牌",
        options: [],
        multiple: false,
        allow_other: true,
        secret: true,
      }],
    }} onRespond={onRespond} />);
    await userEvent.type(screen.getByLabelText("回答"), "secret-123");
    await userEvent.click(screen.getByRole("button", { name: "提交回答并继续" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith({
      decision: "allow",
      answers: { token: ["secret-123"] },
    }));
    expect(screen.getByText("已提交：敏感回答")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("secret-123")).not.toBeInTheDocument();
  });

  it("renders a persisted resolved projection as a compact receipt after reload", () => {
    render(<AgentInteractionCard interaction={{
      ...question,
      status: "resolved",
      resolved_at: "2026-08-12T03:02:00Z",
      resolution: { decision: "allow", summary: "已提交：通过" },
      capabilities: { respond: false, allow: false, deny: false },
    }} onRespond={vi.fn(async () => {})} />);
    expect(screen.getByText("已提交：通过")).toBeInTheDocument();
    expect(screen.getByText("已处理")).toBeInTheDocument();
    expect(screen.queryByText(question.questions![0]!.prompt!)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
