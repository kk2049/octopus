import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewDiscussPane, NewTicketPane } from "./TicketComposer.js";
import type { Roster } from "./model.js";

const roster: Roster = {
  models: ["claude-opus-4-7", "codex-gpt-6-astra", "codex-gpt-5.6-sol", "omp-gpt-5.6-sol"],
  efforts: ["medium", "high", "xhigh", "max"],
  model_default: "codex-gpt-6-astra",
  effort_default: "xhigh",
  // Labels come only from the server catalog; the browser keeps no table.
  model_catalog: [
    { id: "claude-opus-4-7", label: "Opus 4.7", family: "claude" },
    { id: "claude-fable-5-1", label: "Fable 5.1", family: "claude" },
    { id: "codex-gpt-6-astra", label: "Codex · GPT-6 Astra", family: "codex" },
    { id: "codex-gpt-5.6-sol", label: "Codex · GPT 5.6-sol", family: "codex" },
    { id: "omp-gpt-5.6-sol", label: "omp · GPT 5.6-sol", family: "omp" },
  ],
  apps: [{ id: "session-plus", title: "会话+", refreshable: true, served: true }],
  requester_choices: [],
};

function expectHydratedPickers(): void {
  expect(screen.getByRole("combobox", { name: "模型" }).closest(".ant-select"))
    .toHaveTextContent("模型: Codex · GPT-6 Astra");
  expect(screen.getByRole("combobox", { name: "推理强度" }).closest(".ant-select"))
    .toHaveTextContent("推理强度: xhigh");
}

describe("ticket composer async roster hydration", () => {
  it("fills the ticket model and effort when options arrive after mount", async () => {
    const props = { onCancel: vi.fn(), onCreated: vi.fn(async () => {}) };
    const view = render(<NewTicketPane roster={undefined} {...props} />);

    expect(screen.getByRole("combobox", { name: "模型" }).closest(".ant-select"))
      .not.toHaveTextContent("模型:");
    view.rerender(<NewTicketPane roster={roster} {...props} />);

    await waitFor(expectHydratedPickers);
  });

  it("keeps an explicit model choice when the roster refreshes", async () => {
    const user = userEvent.setup();
    const props = { onCancel: vi.fn(), onCreated: vi.fn(async () => {}) };
    const view = render(<NewTicketPane roster={roster} {...props} />);
    const model = screen.getByRole("combobox", { name: "模型" });

    await user.click(model);
    await user.click(await screen.findByText("模型: Opus 4.7"));
    expect(model.closest(".ant-select")).toHaveTextContent("模型: Opus 4.7");

    view.rerender(
      <NewTicketPane
        roster={{ ...roster, models: [...roster.models!], efforts: [...roster.efforts!] }}
        {...props}
      />,
    );

    expect(model.closest(".ant-select")).toHaveTextContent("模型: Opus 4.7");
  });

  it("hydrates the discussion composer through the same controlled-value path", async () => {
    const props = { onCancel: vi.fn(), onCreated: vi.fn(async () => {}) };
    const view = render(<NewDiscussPane roster={undefined} {...props} />);
    view.rerender(<NewDiscussPane roster={roster} {...props} />);

    await waitFor(expectHydratedPickers);
  });

  it("offers max effort from the server roster", async () => {
    const user = userEvent.setup();
    render(<NewTicketPane roster={roster} onCancel={vi.fn()} onCreated={vi.fn(async () => {})} />);
    await user.click(screen.getByRole("combobox", { name: "推理强度" }));
    expect(await screen.findByText("推理强度: max")).toBeInTheDocument();
  });

  it("shows GPT-6 Astra with its user-facing label", async () => {
    const user = userEvent.setup();
    render(<NewTicketPane roster={{ ...roster, model_default: "claude-opus-4-7" }} onCancel={vi.fn()} onCreated={vi.fn(async () => {})} />);

    await user.click(screen.getByRole("combobox", { name: "模型" }));
    expect(await screen.findByText("模型: Codex · GPT-6 Astra")).toBeInTheDocument();
  });

  it("names a model the server catalog does not list by its id instead of hiding it", async () => {
    const user = userEvent.setup();
    render(<NewTicketPane
      roster={{ ...roster, models: [...roster.models!, "codex-gpt-9-preview"] }}
      onCancel={vi.fn()} onCreated={vi.fn(async () => {})} />);
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    expect(await screen.findByText("模型: codex-gpt-9-preview")).toBeInTheDocument();
  });
});

/**
 * Ticket #180. Filing a ticket is not chatting: the body is the whole brief the
 * agent gets, so a paragraph break must stay a paragraph break on every screen.
 */
describe("ticket composer keyboard and phone placeholders", () => {
  function stubViewport(compact: boolean): void {
    vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
      matches: compact && media === "(max-width: 720px)",
      media,
      onchange: null,
      addEventListener(): void {},
      removeEventListener(): void {},
      addListener(): void {},
      removeListener(): void {},
      dispatchEvent: () => false,
    })));
  }

  afterEach(() => vi.unstubAllGlobals());

  it("has no title field and does not file on plain Enter in a phone viewport", async () => {
    stubViewport(true);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<NewTicketPane roster={roster} onCancel={vi.fn()} onCreated={vi.fn(async () => {})} />);

    expect(screen.queryByLabelText("标题(一句话)")).toBeNull();
    const body = screen.getByLabelText("需求描述");
    expect(body).toHaveAttribute("placeholder", "背景与想要的效果…");

    fireEvent.change(body, { target: { value: "第一段" } });
    fireEvent.keyDown(body, { key: "Enter" });
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits the body without a user-authored title on the modifier gesture", async () => {
    stubViewport(false);
    const onCreated = vi.fn(async () => {});
    const requests: Array<RequestInit | undefined> = [];
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init);
      return new Response(
        JSON.stringify({ ticket: { id: 7 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<NewTicketPane roster={roster} onCancel={vi.fn()} onCreated={onCreated} />);

    const body = screen.getByLabelText("需求描述");
    expect(body.getAttribute("placeholder")).toContain("边界");
    fireEvent.change(body, { target: { value: "正文" } });
    fireEvent.keyDown(body, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(7));
    const request = requests[0]!;
    const payload = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("title");
    expect(payload).not.toHaveProperty("kind");
    expect(payload).not.toHaveProperty("app_id");
    expect(payload).toMatchObject({ body: "正文", model: "codex-gpt-6-astra", effort: "xhigh" });
  });

  it("asks only for the need and leaves App/full delivery classification to the agent", () => {
    render(<NewTicketPane roster={roster} onCancel={vi.fn()} onCreated={vi.fn(async () => {})} />);

    expect(screen.queryByText("工单类型")).toBeNull();
    expect(screen.queryByText("App 工单")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "App" })).toBeNull();
    expect(screen.getByText(/按最终改动判断无需上线、App 热发布或整机部署/)).toBeInTheDocument();
  });

  it("renders a Fable approval receipt without claiming a ticket already exists", async () => {
    const onCreated = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      approval_required: true,
      pending_call_id: "pc_fable",
      message: "Fable 工单已提交 lht 审批；批准后才会创建并启动。",
    }), { status: 202, headers: { "content-type": "application/json" } })));
    const withFable: Roster = {
      ...roster,
      models: ["claude-fable-5-1", ...roster.models!],
    };
    const user = userEvent.setup();
    render(<NewTicketPane roster={withFable} onCancel={vi.fn()} onCreated={onCreated} />);

    const body = screen.getByLabelText("需求描述");
    await user.type(body, "原始 Fable 输入");
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    await user.click(await screen.findByText("模型: Fable 5.1"));
    await user.click(screen.getByRole("button", { name: "提交工单" }));

    expect(await screen.findByRole("status")).toHaveTextContent("提交 lht 审批");
    expect(body).toHaveValue("");
    expect(onCreated).not.toHaveBeenCalled();
  });
});
