import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLanguage } from "../../i18n/language.js";
import { renderPage } from "../../test-utils.js";
import { TicketSidebar, type TicketSidebarProps } from "./TicketSidebar.js";
import type { Ticket } from "./model.js";

const row = (id: number): Ticket => ({
  id, title: `TICKET-${id}`, requester: "alice", kind: "simple", dev_status: "open",
  deploy_status: "pending", model: "codex", effort: "high", updated_at: "2026-10-13T00:00:00Z",
});
function mount(openSearch = true, overrides: Partial<TicketSidebarProps> = {}) {
  const props: TicketSidebarProps = {
    roster: { tickets: [row(300)], counts: {}, viewer: { username: "alice" } },
    rosterPending: false, deploy: undefined, selected: 300, deployBusy: false,
    deploying: false, publishingApps: false, decidedIntent: null,
    onTriggerDeploy: vi.fn(), onPublishApps: vi.fn(), onConfirmDeploy: vi.fn(),
    onVerify: vi.fn(), onOpenComposer: vi.fn(), onOpenTicket: vi.fn(),
    ...overrides,
  };
  renderPage(<TicketSidebar {...props} />);
  if (openSearch) fireEvent.click(screen.getByText("搜索历史工单", { selector: "summary" }));
  return props;
}
const response = (id: number, has_more = false) => new Response(JSON.stringify({ tickets: [row(id)], has_more }));

describe("ticket sidebar titles", () => {
  it.each([
    { title: "lark-cli 导出的 PDF 可按页渲染成图片，替代不可用的幻灯片截图", slug: "lark-cli 导出的 P", expected: "lark-cli 导出的 P ..." },
    { title: "完整标题", slug: "完整标题", expected: "完整标题" },
    { title: "原始需求的完整标题", slug: "侧栏短名保留原文", expected: "侧栏短名保留原文" },
    { title: "没有短名的完整标题", slug: undefined, expected: "没有短名的完整标题" },
    { title: "空短名回退完整标题", slug: "", expected: "空短名回退完整标题" },
  ])("marks only shortened title prefixes: $expected", async ({ title, slug, expected }) => {
    const props = mount(false, { roster: { tickets: [{ ...row(801), title, slug }], counts: {} } });
    const label = screen.getByTitle(title);
    expect(label.textContent).toBe(`#801${expected}`);
    await userEvent.setup().click(label);
    expect(props.onOpenTicket).toHaveBeenCalledWith(801);
  });
});

describe("ticket sidebar history search", () => {
  afterEach(() => applyLanguage("zh-CN"));

  it("starts folded, hides unused panels, and preserves search drafts across folding and language changes", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    mount(false, { roster: { tickets: [row(300)], counts: {}, review_lane: true,
      viewer: { username: "alice", admin: true, dev: true },
      credit_account: { balance: 123, entries: [] } } });
    const search = screen.getByTestId("search-section");
    const deploy = screen.getByTestId("deploy-section");
    expect(search).not.toHaveAttribute("open");
    expect(deploy).not.toHaveAttribute("open");
    expect(screen.queryByTestId("credit-ledger")).not.toBeInTheDocument();
    expect(screen.queryByText("🧐 贡献者评审队列")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /TICKET-300/ })).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByText("搜索历史工单", { selector: "summary" }));
    await user.type(screen.getByRole("textbox", { name: "关键词" }), "保留筛选");
    await user.click(screen.getByText("搜索历史工单", { selector: "summary" }));
    expect(search).not.toHaveAttribute("open");
    await user.click(screen.getByText("搜索历史工单", { selector: "summary" }));
    act(() => applyLanguage("en"));
    expect(search).toHaveAttribute("open");
    expect(screen.getByRole("textbox", { name: "Keyword" })).toHaveValue("保留筛选");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens deployment controls without triggering an action and keeps errors inside the card", async () => {
    const props = mount(false, { roster: { tickets: [{ ...row(300), dev_status: "landed" }],
      counts: {}, viewer: { username: "alice" } }, deploy: { base_branch: "v4", stable_branch: "v4-stable",
      may_deploy: true, preparation: { sha: "a".repeat(40), state: "ready" } },
      deployError: "deployment refused" });
    expect(screen.getByText("deployment refused")).not.toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByText("部署", { selector: "summary" }));
    expect(screen.getByText("deployment refused")).toBeVisible();
    expect(props.onTriggerDeploy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /上线 v4/ }));
    expect(props.onTriggerDeploy).toHaveBeenCalledTimes(1);
  });

  it("translates search controls without losing the draft or issuing a search", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "关键词" }), { target: { value: "原文 draft" } });
    act(() => applyLanguage("en"));
    expect(screen.getByRole("textbox", { name: "Keyword" })).toHaveValue("原文 draft");
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("submits combined filters, pages old tickets, opens the result and clears filters", async () => {
    const urls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost"); urls.push(url);
      return response(url.searchParams.get("offset") === "50" ? 2 : 1, url.searchParams.get("offset") !== "50");
    }));
    const user = userEvent.setup();
    const props = mount();
    await user.type(screen.getByRole("textbox", { name: "关键词" }), "文件 搜索");
    await user.type(screen.getByRole("textbox", { name: "发起人" }), "alice");
    await user.click(screen.getByRole("combobox", { name: "开发状态" }));
    await user.click(screen.getByText("已合入", { selector: ".ant-select-item-option-content" }));
    expect(urls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "搜索" }));
    await user.click(await screen.findByRole("button", { name: /TICKET-1\b/ }));
    expect(props.onOpenTicket).toHaveBeenCalledWith(1);
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ q: "文件 搜索", requester: "alice", status: "landed", offset: "0", limit: "50" });
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("button", { name: /TICKET-2\b/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "上一页" }));
    expect(await screen.findByRole("button", { name: /TICKET-1\b/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("button", { name: /TICKET-300/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("textbox", { name: "关键词" })).toHaveValue("");
  });

  it("drops stale searches and clears old results while the draft changes", async () => {
    let finish!: (value: Response) => void;
    const old = new Promise<Response>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: string) => input.includes("q=old") ? old : Promise.resolve(response(2))));
    const user = userEvent.setup();
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "关键词" }), { target: { value: "old" } });
    await user.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.change(screen.getByRole("textbox", { name: "关键词" }), { target: { value: "new" } });
    expect(screen.getByText("筛选已更改，请点击搜索。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByRole("button", { name: /TICKET-2\b/ })).toBeInTheDocument();
    await act(async () => { finish(response(1)); await old; });
    expect(screen.queryByRole("button", { name: /TICKET-1\b/ })).not.toBeInTheDocument();
  });

  it("shows errors without retrying and lets the user search again or recover from an empty result", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "search unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tickets: [], has_more: false })));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByText("search unavailable")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByText("没有匹配的工单，请调整筛选。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /TICKET-300/ })).toBeInTheDocument());
  });
});
