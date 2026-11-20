import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TicketExecutionOptions } from "../contract.js";
import { NewTicketPane } from "../pages/tickets/TicketComposer.js";
import { ticketModelSource } from "../pages/tickets/model.js";
import { DebugDock } from "../app/DebugDock.js";
import { bootstrap } from "../lib/bootstrap.js";
import { TicketExecutionFields, useTicketExecution } from "./TicketExecutionFields.js";

const options: TicketExecutionOptions = {
  sources: [
    { id: "ali", device: "aws-workbench", source: "codex", split_execution: true, label: "aws-env · codex", available: true },
    ...["codex", "codexa"].map((label) => ({ id: label, device: "aws-local", source: "codex" as const, split_execution: true, label: `AWS · ${label}`, available: true })),
    { id: "codexb", device: "aws-local", source: "codex" as const, split_execution: true, label: "AWS · long-…@example.com", available: true },
  ],
  workspaces: [
    { id: "remote", device: "gpu-box", codex_remote: true, label: "gpu-box · Project", available: true },
    { id: "local", device: "aws-workbench", codex_remote: true, label: "aws-env · Project", available: true },
  ], source_default: "ali", workspace_default: "remote",
};

it("keeps explicit choices across metadata refresh and owner changes", () => {
  const { result, rerender } = renderHook(({ value, owner }) => useTicketExecution(value, "codex", owner),
    { initialProps: { value: options, owner: "alice" } });
  expect(result.current.payload).toEqual({ agent_source: "ali", workspace: "remote" });
  act(() => { result.current.setSource("codexb"); result.current.setWorkspace("local"); });
  rerender({ value: { ...options, sources: [] }, owner: "alice" });
  expect(result.current.sourceId).toBe("codexb");
  expect(result.current.ready).toBe(false);
  rerender({ value: options, owner: "bob" });
  expect(result.current.sourceId).toBe("ali");
  rerender({ value: options, owner: "alice" });
  expect(result.current.payload).toEqual({ agent_source: "codexb", workspace: "local" });
});

it("takes the source family from the server catalog: omp is not Claude, the codex-runner lane is Codex", () => {
  const withClaude: TicketExecutionOptions = { ...options, sources: [...options.sources,
    { id: "claude-a", device: "aws-local", source: "claude", split_execution: true, label: "AWS · claude", available: true }] };
  const catalog = [
    { id: "omp-opus", label: "omp · Opus", family: "omp" as const },
    { id: "codex-runner-gpt-6-astra", label: "Codex · GPT-6 Astra", family: "codex-runner" as const },
    { id: "claude-opus-5-5", label: "Opus 5.5", family: "claude" as const },
  ];
  const omp = renderHook(() => useTicketExecution(withClaude, ticketModelSource(catalog, "omp-opus"), "alice"));
  expect(omp.result.current.sourceId).toBe("");
  expect(omp.result.current.ready).toBe(false);
  const claude = renderHook(() => useTicketExecution(withClaude, ticketModelSource(catalog, "claude-opus-5-5"), "alice"));
  expect(claude.result.current.sourceId).toBe("claude-a");
  const runner = renderHook(() => useTicketExecution(withClaude, ticketModelSource(catalog, "codex-runner-gpt-6-astra"), "alice"));
  expect(runner.result.current.sourceId).toBe("ali");
});

it("refuses an unsupported remote workspace without replacing its default", () => {
  const value = { ...options, workspaces: options.workspaces.map((w) => ({ ...w, codex_remote: false })) };
  const { result } = renderHook(() => useTicketExecution(value, "codex", "alice"));
  expect(result.current.workspaceId).toBe("remote");
  expect(result.current.ready).toBe(false);
  act(() => result.current.setWorkspace("local"));
  expect(result.current.ready).toBe(true);
});

describe.each(["ticket", "debug"] as const)("%s filing choices", (panel) => {
  it("submits four independent controls with the selected source and workspace", async () => {
    const owner = bootstrap.viewer.username ?? "alice";
    const roster = { models: ["codex-gpt-6-astra"], efforts: ["high", "xhigh", "max"], model_default: "codex-gpt-6-astra", effort_default: "xhigh",
      model_catalog: [{ id: "codex-gpt-6-astra", label: "Codex · GPT-6 Astra", family: "codex" as const }],
      requester_choices: [owner], execution_choices: { [owner]: options } };
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method === "POST") { posted.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ticket: { id: 571 } })); }
      return new Response(JSON.stringify(roster));
    }));
    const user = userEvent.setup();
    const view = render(panel === "ticket"
      ? <NewTicketPane roster={roster} onCancel={vi.fn()} onCreated={vi.fn(async () => {})} />
      : <DebugDock open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Agent 来源" }).closest(".ant-select")).toHaveTextContent("aws-env · codex"));
    expect(screen.getByRole("combobox", { name: "工作区选择" }).closest(".ant-select")).toHaveTextContent("gpu-box");
    await user.click(screen.getByRole("combobox", { name: "Agent 来源" }));
    await user.click(await screen.findByText("Agent 来源: AWS · long-…@example.com"));
    await user.click(screen.getByRole("combobox", { name: "工作区选择" }));
    await user.click(await screen.findByText("工作区选择: aws-env · Project"));
    fireEvent.change(view.container.querySelector("textarea")!, { target: { value: "Check independent placement" } });
    if (panel === "ticket") fireEvent.submit(view.container.querySelector("form")!);
    else fireEvent.click(view.container.querySelector("#debugDockSubmit")!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ model: "codex-gpt-6-astra", effort: "xhigh", agent_source: "codexb", workspace: "local" });
  });
});

it("keeps the chosen AWS default visible and explains why independent accounts are disabled", async () => {
  const legacy = { ...options, sources: options.sources.map((s) => s.id === "codexa"
    ? { ...s, available: false, reason: "account_registration_required" } : s) };
  function Fields() {
    const selection = useTicketExecution(legacy, "codex", "alice");
    return <TicketExecutionFields selection={selection} idPrefix="legacy" wrapLabels />;
  }
  render(<Fields />);
  const user = userEvent.setup();
  const source = screen.getByRole("combobox", { name: "Agent 来源" });
  await user.click(source);
  const unavailable = await screen.findByRole("option", { name: /AWS · codexa.*额度未知.*账号尚未登记/ });
  expect(unavailable.closest("[role=option]")).toHaveAttribute("aria-disabled", "true");
  await user.click(unavailable);
  expect(source.closest(".ant-select")).toHaveTextContent("aws-env · codex");
  await user.click(screen.getByText("Agent 来源: AWS · codex", { exact: true }));
  expect(source.closest(".ant-select")).toHaveTextContent("AWS · codex");
  await user.click(source);
  expect(screen.getByRole("option", { name: /Agent 来源: AWS · codex\s*额度未知/ })).toHaveAttribute("aria-selected", "true");
});

it.each([
  ["offline", "Runner 离线"],
  ["backend_unavailable", "Agent 后端不可用"],
  ["runner_upgrade_required", "需要更新 Runner"],
  ["unknown_reason", "尚未登记或需要更新 Runner"],
])("renders the server source refusal %s without making it selectable", async (reason, label) => {
  const value = { ...options, sources: [{ ...options.sources[0]!, available: false, reason }] };
  function Fields() {
    return <TicketExecutionFields selection={useTicketExecution(value, "codex", "alice")} idPrefix="reason" wrapLabels />;
  }
  render(<Fields />);
  const source = screen.getByRole("combobox", { name: "Agent 来源" });
  expect(source.closest(".ant-select")).toHaveTextContent(label);
  await userEvent.click(source);
  expect(screen.getByRole("option")).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("option")).toHaveTextContent(label);
});

it("shows the Runner's own diagnostic and offending path beside an unavailable backend", async () => {
  const value = { ...options, sources: [{ ...options.sources[0]!, available: false, reason: "backend_unavailable",
    diagnostic: { code: "unsafe_permissions", path: "/home/alice/.local/bin", rule: "group_writable" } }] };
  function Fields() {
    return <TicketExecutionFields selection={useTicketExecution(value, "codex", "alice")} idPrefix="diagnostic" wrapLabels />;
  }
  render(<Fields />);
  expect(screen.getByRole("combobox", { name: "Agent 来源" }).closest(".ant-select"))
    .toHaveTextContent("Agent 后端不可用 (unsafe_permissions · /home/alice/.local/bin · group_writable)");
});

it("shows both sampled windows beside the exact selectable account", async () => {
  const quota = { status: "available" as const, fetchedAt: new Date().toISOString(), windows: [
    { remainingPercent: 42, windowMinutes: 300, resetsAt: "2026-09-16T13:00:00Z" },
    { remainingPercent: 19, windowMinutes: 10080, resetsAt: "2026-09-20T13:00:00Z" },
  ] };
  const value = { ...options, sources: options.sources.map((row) => row.id === "codexb" ? { ...row, quota } : row) };
  function Fields() { return <TicketExecutionFields selection={useTicketExecution(value, "codex", "quota-user")} idPrefix="quota" wrapLabels />; }
  render(<Fields />);
  const source = screen.getByRole("combobox", { name: "Agent 来源" });
  await userEvent.click(source);
  const account = screen.getByRole("option", { name: /AWS · long-…@example.com/ });
  expect(account.querySelectorAll("svg")).toHaveLength(2);
  expect(account).toHaveTextContent("↻");
  await userEvent.click(account);
  expect(source.closest(".ant-select")).toHaveTextContent("AWS · long-…@example.com");
  expect(source.closest(".ant-select")?.querySelectorAll('svg[viewBox="0 0 22 22"]')).toHaveLength(2);
});
