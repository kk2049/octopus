import { describe, expect, it } from "vitest";
import { message, navigationLabel, themeLabel } from "./messages.js";

describe("Dashboard localized copy", () => {
  it("localizes the stable shell navigation by route id", () => {
    expect(navigationLabel("zh-TW", "page.sessionsPlus", "fallback")).toBe("📜 會話");
    expect(navigationLabel("nan-TW", "page.appOpen", "fallback")).toBe("🔬 自動研究");
    expect(navigationLabel("en", "page.permissions", "fallback")).toBe("🛡 Permission Center");
    expect(navigationLabel("ja-JP", "page.knowledge", "fallback")).toBe("📚 ナレッジ");
    expect(navigationLabel("en", "page.future", "Future page")).toBe("Future page");
  });

  it("interpolates bounded UI values without interpreting their contents", () => {
    expect(message("en", "common.refreshFailed", { time: "12:30", message: "<offline>" }))
      .toBe("Refresh failed. Showing data from 12:30: <offline>");
  });

  it("keeps Min Nan product copy independent from the Ant locale fallback", () => {
    expect(message("nan-TW", "common.loading")).toBe("咧載入…");
    expect(message("nan-TW", "shell.reportIssue")).toBe("回報這个頁面的問題");
  });

  it("localizes the two theme names that are not product names", () => {
    expect(themeLabel("en", "classic", "经典")).toBe("Classic");
    expect(themeLabel("zh-TW", "feishu", "飞书")).toBe("飛書");
    expect(themeLabel("ja-JP", "apple", "Apple")).toBe("Apple");
  });
});
