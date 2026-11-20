import { afterEach, describe, expect, it } from "vitest";
import { applyLanguage } from "../i18n/language.js";
import { dateLocale, formatAgo, formatElapsed, formatTime } from "./format.js";

afterEach(() => applyLanguage("zh-CN"));

describe("localized shared time formatting", () => {
  it("uses the selected UI language instead of the browser's system language", () => {
    const ago = new Date(Date.now() - 5 * 60_000).toISOString();
    applyLanguage("en");
    expect(formatAgo(ago)).toBe("5 min ago");
    expect(formatAgo(null)).toBe("Never");
    expect(formatElapsed(65_000)).toBe("1m 5s");
    expect(formatTime(ago)).toBe(new Date(ago).toLocaleString("en", { hour12: false }));
    applyLanguage("zh-TW");
    expect(formatAgo(ago)).toBe("5 分鐘前");
    applyLanguage("ja-JP");
    expect(formatAgo(ago)).toBe("5 分前");
    expect(formatAgo("invalid time")).toBe("");
    expect(formatTime("原始时间内容")).toBe("原始时间内容");
    expect(dateLocale("nan-TW")).toBe("zh-TW");
  });
});
