import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SendReceipt } from "@claude-bot/chat-ui-commons/transcript-ui";
import { applyLanguage, type DashboardLanguageId } from "../i18n/language.js";
import { uiText } from "../i18n/ui-text.js";
import { DASHBOARD_CHAT_CLASSES } from "../transcript/ChatTranscript.js";
import { PageErrorBoundary } from "./PageErrorBoundary.js";

afterEach(() => {
  act(() => applyLanguage("zh-CN"));
  vi.restoreAllMocks();
});

let explode = true;
function Fragile() {
  if (explode) throw new Error("render failed: " + "x".repeat(400));
  return <p>PAGE BODY</p>;
}

function Layout() {
  return <div><nav>TRUSTED NAV</nav><PageErrorBoundary><Fragile /></PageErrorBoundary></div>;
}

describe("PageErrorBoundary", () => {
  it("replaces only the failed screen with a bounded panel and keeps the shell", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    explode = true;
    render(<Layout />);
    expect(screen.getByText("TRUSTED NAV")).toBeVisible();
    const panel = screen.getByRole("alert");
    expect(panel).toHaveTextContent("这个页面出错了");
    expect(panel.querySelector("code")!.textContent!.length).toBeLessThanOrEqual(300);
    expect(screen.getByRole("button", { name: "刷新页面" })).toBeVisible();
  });

  it("remounts the screen only when the reader asks, and reloads the document on request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload });
    explode = true;
    const user = userEvent.setup();
    render(<Layout />);
    await user.click(screen.getByRole("button", { name: "刷新页面" }));
    expect(reload).toHaveBeenCalledOnce();
    explode = false;
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByText("PAGE BODY")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("follows the interface language", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    explode = true;
    render(<Layout />);
    act(() => applyLanguage("en"));
    expect(screen.getByRole("alert")).toHaveTextContent("This page failed to render");
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});

describe("the Codex queued receipt that once blanked non-Chinese ticket pages", () => {
  it.each<DashboardLanguageId>(["zh-CN", "zh-TW", "nan-TW", "en", "ja-JP"])("renders in %s", (language) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    act(() => applyLanguage(language));
    render(<SendReceipt classes={DASHBOARD_CHAT_CLASSES} text={uiText} entry={{
      prompt: "QUEUED", phase: "done",
      input: { phase: "local_queued", evidence: "local_queue", transport: "codex-queue", at: "2026-10-15T08:00:00Z" },
    }} />);
    expect(screen.getByText("QUEUED")).toBeVisible();
    expect(screen.getByText(uiText("已排队，将作为下一轮处理", {}, language))).toBeVisible();
    expect(warn).not.toHaveBeenCalled();
  });
});
