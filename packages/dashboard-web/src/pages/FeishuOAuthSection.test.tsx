import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderPage } from "../test-utils.js";
import { FeishuOAuthSection } from "./FeishuOAuthSection.js";

const PENDING = {
  available: true, state: "pending", userCode: "TEST-CODE",
  verificationUri: "https://accounts.feishu.cn/oauth/device?code=TEST-CODE",
  expiresAt: "2099-01-01T00:00:00Z",
};
const CONNECTED = { available: true, state: "connected" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function setup(start: () => Promise<Response>, initial: unknown = CONNECTED) {
  let status = initial;
  const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/start") ? start() : json(status));
  vi.stubGlobal("fetch", fetch);
  const popup = { opener: window, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  const view = renderPage(<FeishuOAuthSection owner="alice" />);
  return { ...view, fetch, popup, open, setStatus: (value: unknown) => { status = value; } };
}

afterEach(() => vi.restoreAllMocks());

describe("personal Feishu OAuth action", () => {
  it("reserves a detached tab immediately, sends one forced POST, then navigates to actual consent", async () => {
    let finish!: (value: Response) => void;
    const test = setup(() => new Promise((resolve) => { finish = resolve; }));
    const button = await screen.findByRole("button", { name: "重新授权" });
    fireEvent.click(button);
    expect(test.open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
    expect(test.popup.opener).toBeNull();
    expect(button).toBeDisabled();
    expect(screen.getByText("正在发起飞书授权…")).toBeVisible();
    fireEvent.click(button);
    await waitFor(() => expect(test.fetch).toHaveBeenCalledWith("/api/feishu/oauth/start", expect.objectContaining({
      method: "POST", body: JSON.stringify({ username: "alice", force: true }),
    })));
    expect(test.popup.location.replace).not.toHaveBeenCalled();
    finish(json(PENDING));
    await waitFor(() => expect(test.popup.location.replace).toHaveBeenCalledExactlyOnceWith(PENDING.verificationUri));
    expect(screen.getByRole("link", { name: "打开飞书授权页" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(test.fetch.mock.calls.filter(([url]) => String(url).endsWith("/start"))).toHaveLength(1);
  });

  it("offers an ordinary authorization link when the popup is blocked", async () => {
    const test = setup(async () => json(PENDING));
    test.open.mockReturnValue(null);
    await userEvent.click(await screen.findByRole("button", { name: "重新授权" }));
    expect(await screen.findByText("浏览器未能自动打开授权页，请点击下方链接继续。")).toBeVisible();
    expect(screen.getByRole("link", { name: "打开飞书授权页" })).toHaveAttribute("href", PENDING.verificationUri);
  });

  it("closes the blank tab and shows a failed start inside the card without replaying the POST", async () => {
    const test = setup(async () => json({ error: "飞书授权暂时无法启动，请稍后重试" }, 503));
    await userEvent.click(await screen.findByRole("button", { name: "重新授权" }));
    const card = screen.getByRole("region", { name: "飞书个人连接" });
    expect(await within(card).findByRole("alert")).toHaveTextContent("飞书授权暂时无法启动，请稍后重试");
    expect(test.popup.close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link", { name: "打开飞书授权页" })).toBeNull();
    expect(test.fetch.mock.calls.filter(([url]) => String(url).endsWith("/start"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "重新授权" })).toBeEnabled();
  });

  it("resumes a pending flow without another start and reports confirmation only from status", async () => {
    const test = setup(async () => json(PENDING), PENDING);
    expect(await screen.findByRole("link", { name: "打开飞书授权页" })).toBeVisible();
    expect(test.open).not.toHaveBeenCalled();
    expect(test.fetch.mock.calls.some(([url]) => String(url).endsWith("/start"))).toBe(false);
    test.setStatus(CONNECTED);
    await userEvent.click(screen.getByRole("button", { name: "检查授权状态" }));
    expect(await screen.findByText("● 已连接")).toBeVisible();
    expect(screen.queryByRole("link", { name: "打开飞书授权页" })).toBeNull();
  });

  it("leaves authorization failures visible and lets the user explicitly start again", async () => {
    const test = setup(async () => json(PENDING), PENDING);
    await screen.findByRole("link", { name: "打开飞书授权页" });
    test.setStatus({ available: true, state: "failed", error: "授权失败: access_denied" });
    await userEvent.click(screen.getByRole("button", { name: "检查授权状态" }));
    expect(await screen.findByText("○ 连接失败：授权失败: access_denied")).toBeVisible();
    expect(screen.queryByText("● 已连接")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "连接飞书" }));
    expect(await screen.findByRole("link", { name: "打开飞书授权页" })).toBeVisible();
  });

  it("ignores a late start response after the owner card has unmounted", async () => {
    let finish!: (value: Response) => void;
    const test = setup(() => new Promise((resolve) => { finish = resolve; }));
    await userEvent.click(await screen.findByRole("button", { name: "重新授权" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    test.unmount();
    finish(json(PENDING));
    await waitFor(() => expect(test.popup.close).toHaveBeenCalledOnce());
    expect(test.popup.location.replace).not.toHaveBeenCalled();
  });
});
