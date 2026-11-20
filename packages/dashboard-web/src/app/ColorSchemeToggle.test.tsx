import { useContext, useEffect } from "react";
import ConfigProvider from "antd/es/config-provider";
import antTheme from "antd/es/theme";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { applyLanguage } from "../i18n/language.js";
import { applyTheme } from "../styles/themes.js";
import { chooseColorScheme, initColorScheme } from "../styles/color-scheme.js";
import { DashboardUiProvider } from "../ui-kit/UiProvider.js";
import { StatusAndPreferences } from "./Shell.js";

let stop: () => void;
beforeEach(() => {
  window.localStorage.clear();
  applyLanguage("zh-CN");
  applyTheme("classic");
  stop = initColorScheme();
});
afterEach(() => { cleanup(); stop(); window.localStorage.clear(); });

describe("status and preferences colour switch", () => {
  it("switches both ways, persists, and leaves the mounted content and selection intact", () => {
    const mount = vi.fn();
    const unmount = vi.fn();
    function Content() {
      useEffect(() => { mount(); return unmount; }, []);
      const config = useContext(ConfigProvider.ConfigContext);
      return <>
        <output data-testid="ant-scheme">{config.theme?.algorithm === antTheme.darkAlgorithm ? "dark" : "light"}</output>
        <textarea aria-label="draft" defaultValue="unfinished draft" />
      </>;
    }
    render(<DashboardUiProvider>
      <StatusAndPreferences devEnabled={false} /><Content />
    </DashboardUiProvider>);
    fireEvent.click(screen.getByText("状态与偏好"));
    const input = screen.getByRole("textbox", { name: "draft" }) as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(2, 7);
    fireEvent.click(screen.getByRole("button", { name: "切换到深色模式" }));
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
    expect(window.localStorage.getItem("octopus-color-scheme-v1")).toBe("dark");
    expect(screen.getByTestId("ant-scheme")).toHaveTextContent("dark");
    fireEvent.click(screen.getByRole("button", { name: "切换到浅色模式" }));
    expect(document.documentElement.dataset.colorScheme).toBe("light");
    expect(screen.getByTestId("ant-scheme")).toHaveTextContent("light");
    expect(screen.getByRole("textbox", { name: "draft" })).toBe(input);
    expect(input.value).toBe("unfinished draft");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(unmount).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "跟随系统外观" }));
    expect(window.localStorage.getItem("octopus-color-scheme-v1")).toBeNull();
  });

  it("updates the button for external preference changes and the active language", () => {
    render(<StatusAndPreferences devEnabled={false} />);
    fireEvent.click(screen.getByText("状态与偏好"));
    act(() => { chooseColorScheme("dark"); applyLanguage("en"); });
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use system appearance" })).toBeInTheDocument();
  });
});
