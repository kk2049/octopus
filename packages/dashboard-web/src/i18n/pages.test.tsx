import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap } from "../lib/bootstrap.js";
import { renderPage, stubApi } from "../test-utils.js";
import { OverviewPage } from "../pages/OverviewPage.js";
import { LauncherPage } from "../pages/LauncherPage.js";
import { StatementList } from "../pages/knowledge/StatementList.js";
import { applyLanguage, type DashboardLanguageId } from "./language.js";
import { uiText } from "./ui-text.js";

beforeEach(() => {
  applyLanguage("zh-CN");
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false, media, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  }));
  Object.assign(bootstrap, {
    viewer: { username: "alice", session: true, admin: false, dev: false, deploy: false },
    pageProps: { hostIsGuess: false, tutorialHost: "bot.test" },
  });
});
afterEach(() => act(() => applyLanguage("zh-CN")));

function overviewApi() {
  return stubApi({
    "/api/overview": {
      generated_at: "2026-09-01T10:00:00.000Z", gateway_enabled: true, runner_ws_port: 8888,
      users: [{
        username: "alice", display_name: "保存", last_round_at: new Date(Date.now() - 5 * 60_000).toISOString(), rounds_7d: 2,
        runners: [{
          device: "原文设备", online: true, local_agent_bridge_mode: "disabled", default_agent_injection: false,
          gui_automation_enabled: false, inventory: { dsh: { available: true } },
        }],
      }],
    },
    "/api/check": { online: false, error: "工具错误原文：检查中…" },
    "/api/runner-token": { install_cmd: "echo '命令原文：保存'", expires_at: "2026-09-01T10:10:00.000Z" },
  });
}

describe("language changes throughout page bodies", () => {
  it.each<DashboardLanguageId>(["zh-CN", "zh-TW", "nan-TW", "en", "ja-JP"])(
    "renders Overview tables, onboarding and modal copy in %s",
    async (language) => {
      applyLanguage(language);
      overviewApi();
      const user = userEvent.setup();
      renderPage(<OverviewPage />);
      expect(await screen.findByRole("heading", { name: uiText("🐙 octopus · 总览") })).toBeVisible();
      expect(await screen.findByRole("columnheader", { name: uiText("章鱼端点(octopus endpoint)") })).toBeVisible();
      expect(screen.getByRole("heading", { name: uiText("接入章鱼端点") })).toBeVisible();
      expect(screen.getByRole("button", { name: uiText("🩺 检查全部端点") })).toBeVisible();
      expect(screen.getByText("保存")).toBeVisible();
      await user.click(screen.getByRole("button", { name: uiText("签发") }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent(uiText("为用户 {v0} 的设备「{v1}」签发一次性安装凭据？同名设备的旧令牌会在新凭据完成兑换时作废。", { v0: "alice", v1: "laptop" }));
    },
  );

  it("updates mounted forms, validation notices and open modals without resetting input or replaying requests", async () => {
    const { calls } = overviewApi();
    const user = userEvent.setup();
    const { container } = renderPage(<OverviewPage />);
    await screen.findByText("保存");
    const device = screen.getByLabelText("设备名", { selector: "input#mint-device" });
    await user.type(device, "我的设备");
    await user.click(screen.getByRole("button", { name: "检查注册" }));
    expect(screen.getByText("请填用户名和设备名")).toBeVisible();
    const before = calls.length;
    act(() => applyLanguage("en"));
    expect(screen.getByText("Enter a username and device name")).toBeVisible();
    expect(screen.getByRole("button", { name: "🩺 Check all endpoints" })).toBeVisible();
    expect(screen.getByLabelText("Device name", { selector: "input#mint-device" })).toBe(device);
    expect(device).toHaveValue("我的设备");
    expect(container.textContent).not.toMatch(/总览|未接入|检查全部|签发|分钟前/);
    expect(calls).toHaveLength(before);
    await user.click(screen.getByRole("button", { name: "Issue" }));
    const dialog = await screen.findByRole("dialog");
    act(() => applyLanguage("ja-JP"));
    expect(dialog).toHaveTextContent("我的设备");
    expect(within(dialog).getByRole("button", { name: "発行" })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "発行" }));
    expect(await screen.findByText("echo '命令原文：保存'")).toBeVisible();
    act(() => applyLanguage("en"));
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/工具错误原文：检查中…/)).toBeVisible();
  });

  it("updates other pages and catalog-backed status labels while retaining content that matches UI phrases", async () => {
    const { calls } = stubApi({ "/api/apps/launcher": {
      apps: [{ app: "sample", title: "保存", publisher: "发布者原名", available: true }],
    } });
    renderPage(<LauncherPage />);
    await screen.findByText("发布者原名");
    act(() => applyLanguage("en"));
    expect(screen.getByRole("heading", { name: "🎲 Apps" })).toBeVisible();
    expect(screen.getByText("Open →")).toBeVisible();
    expect(screen.getByText("保存")).toBeVisible();
    expect(calls).toHaveLength(1);
  });

  it("translates knowledge filters and statuses without translating statements or source material", async () => {
    renderPage(<StatementList items={[{
      id: "requirement:r1", kind: "requirement", statement: "保存", status: "active", authority: "user",
      certainty: "exact", source_ref: "ticket:509", source_sha: "abc", detail: {},
    }]} />);
    act(() => applyLanguage("en"));
    await waitFor(() => expect(screen.getByText("保存")).toBeVisible());
    expect(screen.getAllByText("Requirements").length).toBeGreaterThan(0);
    expect(screen.queryByText("需求")).not.toBeInTheDocument();
  });
});
