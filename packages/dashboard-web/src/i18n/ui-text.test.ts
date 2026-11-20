import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLanguage } from "./language.js";
import { UI_COPY } from "./ui-copy.js";
import { localizedLabels, uiMessage, uiText, uiValue, type UiTextKey } from "./ui-text.js";

afterEach(() => applyLanguage("zh-CN"));

describe("Dashboard page copy", () => {
  it("provides every translation and preserves the exact interpolation fields", () => {
    const fields = (text: string) => [...text.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
    for (const [source, translations] of Object.entries(UI_COPY)) {
      expect(translations, source).toHaveLength(3);
      for (const translation of translations) {
        expect(translation.length, source).toBeGreaterThan(0);
        expect(fields(translation), source).toEqual(fields(source));
      }
      expect(translations[0], source).not.toMatch(/\p{Script=Han}/u);
    }
  });

  it("keeps stored notices reactive and leaves raw content untouched even when it matches a key", () => {
    const notice = uiMessage("失败：{v0}", { v0: "保存 <script>{v0}</script>" });
    expect(uiValue(notice, "en")).toBe("Failed: 保存 <script>{v0}</script>");
    expect(uiValue(notice, "ja-JP")).toBe("失敗：保存 <script>{v0}</script>");
    expect(uiValue("保存", "en")).toBe("保存");
    expect(uiValue(uiMessage("已开号 {v0}{v1}", {
      v0: "用户原名", v1: uiMessage(" · 显示名 {v0}", { v0: "中文名称" }),
    }), "en")).toBe("Created account 用户原名 · Display name 中文名称");
  });

  it("shows the source text and warns once for a key the table lacks, instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // What a shared component's untyped `text` callback can hand over.
      const missing = "不在目录里的文案 {v0}" as UiTextKey;
      expect(uiText(missing, { v0: "1" }, "en")).toBe("不在目录里的文案 1");
      expect(uiText(missing, { v0: "2" }, "ja-JP")).toBe("不在目录里的文案 2");
      expect(uiText(missing, { v0: "3" }, "nan-TW")).toBe("不在目录里的文案 3");
      expect(uiText(missing, { v0: "4" }, "zh-CN")).toBe("不在目录里的文案 4");
      expect(uiText("toString" as UiTextKey, {}, "en")).toBe("toString");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("caches label tables by language without freezing the import-time language", () => {
    const labels = localizedLabels(() => ({ save: uiText("保存") }));
    const chinese = labels();
    applyLanguage("en");
    const english = labels();
    expect(english.save).toBe("Save");
    expect(labels()).toBe(english);
    applyLanguage("zh-CN");
    expect(labels()).toBe(chinese);
    applyLanguage("nan-TW");
    expect(labels().save).toBe(uiText("保存", {}, "zh-TW"));
  });
});
