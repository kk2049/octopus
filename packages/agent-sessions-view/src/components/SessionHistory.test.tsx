import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionHistory } from "./SessionHistory.js";
import type { SessionsProjection } from "@claude-bot/agent-sessions-contract";

const page: NonNullable<SessionsProjection["sessionHistory"]> = {
  device: "laptop", source: "all", cursor: "", nextCursor: "opaque-next", hasMore: true, totalFound: 1500,
  sessions: [
    { resourceId: "root", sessionId: "root", deviceId: "laptop", cliKind: "codex", title: "User headless task", executionMode: "exec" },
    { resourceId: "child", sessionId: "child", deviceId: "laptop", cliKind: "codex", title: "Child worker", parentResourceId: "root" },
  ],
};
const props = () => ({ devices: ["laptop", "other"], selected: null, pinned: [], onBrowse: vi.fn(async () => ({ ok: true, message: "" })), onSelect: vi.fn() });

describe("full session history", () => {
  it("opens history under the initiating App surface so its list keeps module styles", async () => {
    const handlers = props();
    render(<section data-app-surface="session-plus" data-testid="app">
      <SessionHistory {...handlers} result={page} />
    </section>);
    fireEvent.click(screen.getByRole("button", { name: "全部会话" }));
    const dialog = await screen.findByRole("dialog", { name: "浏览全部会话" });
    expect(dialog.closest("[data-app-surface]")).toBe(screen.getByTestId("app"));
    await waitFor(() => expect(screen.getByText("User headless task")).toBeInTheDocument());
    fireEvent.click(screen.getByText("User headless task"));
    expect(handlers.onSelect).toHaveBeenCalledWith("root");
  });

  it("keeps named, pinned and orphan chats directly accessible on a history page", async () => {
    const handlers = { ...props(), pinned: ["pinned"] };
    render(<SessionHistory {...handlers} customTitles={{ child: "Town 4" }} result={{ ...page, sessions: [
      ...page.sessions,
      { ...page.sessions[1], resourceId: "pinned", title: "Pinned worker" },
      { ...page.sessions[1], resourceId: "orphan", title: "Orphan worker", parentResourceId: "not-on-page" },
    ] }} />);
    fireEvent.click(screen.getByRole("button", { name: "全部会话" }));
    await waitFor(() => expect(screen.getByText("Town 4")).toBeInTheDocument());
    expect(screen.getByText("Pinned worker")).toBeInTheDocument();
    expect(screen.getByText("Orphan worker")).toBeInTheDocument();
    expect(screen.queryByText("父会话暂未列出")).not.toBeInTheDocument();
    expect(screen.getAllByText(/条数未统计/).length).toBe(4);
    expect(screen.queryByText(/ · 0 条 · /)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Town 4"));
    expect(handlers.onSelect).toHaveBeenCalledWith("child");
  });

  it("loads only after an explicit click, preserves headless roots and pages with the exact opaque cursor", async () => {
    const handlers = props();
    const view = render(<SessionHistory {...handlers} result={undefined} />);
    expect(handlers.onBrowse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "全部会话" }));
    await waitFor(() => expect(handlers.onBrowse).toHaveBeenCalledWith({ device: "laptop", source: "all", cursor: "" }));
    view.rerender(<SessionHistory {...handlers} result={page} />);
    expect(screen.getByText("User headless task")).toBeInTheDocument();
    expect(screen.queryByText("Child worker")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "显示子 Agent" }));
    expect(screen.getByText("Child worker")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(handlers.onBrowse).toHaveBeenLastCalledWith({ device: "laptop", source: "all", cursor: "opaque-next" }));
    expect(screen.queryByText("User headless task")).not.toBeInTheDocument();
    view.rerender(<SessionHistory {...handlers} result={{ ...page, cursor: "opaque-next", hasMore: false, sessions: [{ ...page.sessions[0], resourceId: "old", title: "Older chat" }] }} />);
    fireEvent.click(screen.getByText("Older chat"));
    expect(handlers.onSelect).toHaveBeenCalledWith("old");
  });

  it("clears old device results immediately and never retries a refusal", async () => {
    const handlers = props();
    const view = render(<SessionHistory {...handlers} result={page} />);
    fireEvent.click(screen.getByRole("button", { name: "全部会话" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "会话设备" })).not.toBeDisabled());
    fireEvent.change(screen.getByRole("combobox", { name: "会话设备" }), { target: { value: "other" } });
    expect(screen.queryByText("User headless task")).not.toBeInTheDocument();
    handlers.onBrowse.mockResolvedValue({ ok: false, message: "需要本人批准" });
    view.rerender(<SessionHistory {...handlers} result={page} />);
    fireEvent.click(screen.getByRole("button", { name: "从头浏览" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("需要本人批准"));
    expect(handlers.onBrowse).toHaveBeenCalledTimes(2);
  });
});

it("shows a history device label without changing the selected browse target", async () => {
  const handlers = props();
  render(<SessionHistory {...handlers} deviceLabels={{ laptop: "aliyun" }} result={page} />);
  fireEvent.click(screen.getByRole("button", { name: "全部会话" }));
  const option = screen.getByRole("option", { name: "aliyun" }) as HTMLOptionElement;
  expect(option.value).toBe("laptop");
  await waitFor(() => expect(handlers.onBrowse).toHaveBeenCalledWith({ device: "laptop", source: "all", cursor: "" }));
});
