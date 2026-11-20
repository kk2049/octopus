import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLanguage,
  currentLanguage,
  DASHBOARD_LANGUAGES,
  initLanguage,
  subscribeLanguage,
} from "./language.js";

afterEach(() => {
  applyLanguage("zh-CN");
  window.localStorage.clear();
});

describe("the Dashboard language preference", () => {
  it("offers the five requested language choices", () => {
    expect(DASHBOARD_LANGUAGES).toEqual([
      { id: "zh-CN", label: "简体中文（大陆）" },
      { id: "zh-TW", label: "繁體中文（臺灣）" },
      { id: "nan-TW", label: "閩南語（臺灣）" },
      { id: "en", label: "English" },
      { id: "ja-JP", label: "日本語" },
    ]);
  });

  it("updates document metadata and persists an explicit choice", () => {
    applyLanguage("nan-TW");
    expect(currentLanguage()).toBe("nan-TW");
    expect(document.documentElement.lang).toBe("nan-TW");
    expect(window.localStorage.getItem("octopus-language-v1")).toBe("nan-TW");
  });

  it("restores a stored choice before the first render", () => {
    window.localStorage.setItem("octopus-language-v1", "ja-JP");
    initLanguage();
    expect(currentLanguage()).toBe("ja-JP");
    expect(document.documentElement.lang).toBe("ja-JP");
  });

  it("folds tampered values to the existing Simplified Chinese default", () => {
    applyLanguage("made-up");
    expect(currentLanguage()).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("adopts a valid cross-tab choice without echoing the storage write", () => {
    const listener = vi.fn();
    const off = subscribeLanguage(listener);
    const write = vi.spyOn(Storage.prototype, "setItem");
    window.dispatchEvent(new StorageEvent("storage", {
      key: "octopus-language-v1",
      newValue: "en",
    }));
    expect(currentLanguage()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
    off();
  });

  it("keeps the in-memory and document choices when storage is unavailable", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      applyLanguage("ja-JP");
      expect(currentLanguage()).toBe("ja-JP");
      expect(document.documentElement.lang).toBe("ja-JP");
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
