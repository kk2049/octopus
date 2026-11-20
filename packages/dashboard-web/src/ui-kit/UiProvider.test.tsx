import { afterEach, describe, expect, it } from "vitest";
import enUS from "antd/es/locale/en_US";
import jaJP from "antd/es/locale/ja_JP";
import zhCN from "antd/es/locale/zh_CN";
import zhTW from "antd/es/locale/zh_TW";
import { dashboardAntLocale, dashboardAntTheme } from "./UiProvider.js";

describe("dashboardAntTheme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("projects the active dashboard variables into Ant semantic tokens", () => {
    document.documentElement.style.setProperty("--accent", "#123456");
    document.documentElement.style.setProperty("--card", "#faf7f0");
    document.documentElement.style.setProperty("--fg", "#242722");
    document.documentElement.style.setProperty("--radius-md", "13px");

    const config = dashboardAntTheme("ink", false);
    expect(config.token?.colorPrimary).toBe("#123456");
    expect(config.token?.colorBgContainer).toBe("#faf7f0");
    expect(config.token?.borderRadiusLG).toBe(13);
    expect(config.cssVar).toEqual({ key: "octopus-ink-light" });
    expect(config.components?.Select).toMatchObject({
      optionSelectedColor: "#242722",
      selectorBg: "#faf7f0",
    });
  });

  it("projects CSS-owned component geometry without a theme branch", () => {
    document.documentElement.style.setProperty("--control-height", "38px");
    document.documentElement.style.setProperty("--control-weight", "590");
    document.documentElement.style.setProperty("--card-padding", "20px");
    document.documentElement.style.setProperty("--card-header-height", "48px");
    document.documentElement.style.setProperty("--table-row-padding", "12px");
    document.documentElement.style.setProperty("--table-cell-padding", "14px");
    const apple = dashboardAntTheme("apple", false);
    expect(apple.token?.controlHeight).toBe(38);
    expect(apple.components?.Button).toMatchObject({ fontWeight: 590, controlHeight: 38 });
    expect(apple.components?.Card).toMatchObject({ bodyPadding: 20, headerHeight: 48 });
    expect(apple.components?.Table).toMatchObject({ cellPaddingBlockSM: 12, cellPaddingInlineSM: 14 });
  });
});

describe("dashboardAntLocale", () => {
  it("maps every supported Dashboard language to Ant's matching locale", () => {
    expect(dashboardAntLocale("zh-CN")).toBe(zhCN);
    expect(dashboardAntLocale("zh-TW")).toBe(zhTW);
    expect(dashboardAntLocale("nan-TW")).toBe(zhTW);
    expect(dashboardAntLocale("en")).toBe(enUS);
    expect(dashboardAntLocale("ja-JP")).toBe(jaJP);
  });
});
