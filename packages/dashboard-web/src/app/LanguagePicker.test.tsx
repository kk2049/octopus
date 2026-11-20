import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { applyLanguage } from "../i18n/language.js";
import { LanguagePicker } from "./LanguagePicker.js";

beforeEach(() => {
  window.localStorage.clear();
  applyLanguage("zh-CN");
});

afterEach(() => {
  applyLanguage("zh-CN");
  window.localStorage.clear();
});

describe("the Dashboard language picker", () => {
  it("shows the requested choices and switches the document immediately", () => {
    render(<LanguagePicker />);
    const select = screen.getByRole("combobox", { name: "语言" }) as HTMLSelectElement;
    expect(screen.getAllByRole("option").map((option) => ({
      value: (option as HTMLOptionElement).value,
      label: option.textContent,
    }))).toEqual([
      { value: "zh-CN", label: "简体中文（大陆）" },
      { value: "zh-TW", label: "繁體中文（臺灣）" },
      { value: "nan-TW", label: "閩南語（臺灣）" },
      { value: "en", label: "English" },
      { value: "ja-JP", label: "日本語" },
    ]);

    fireEvent.change(select, { target: { value: "en" } });
    expect(select.value).toBe("en");
    expect(select).toHaveAccessibleName("Language");
    expect(document.documentElement.lang).toBe("en");
  });

  it("follows a language selected in another tab", () => {
    render(<LanguagePicker />);
    const select = screen.getByRole("combobox", { name: "语言" }) as HTMLSelectElement;
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "octopus-language-v1",
        newValue: "zh-TW",
      }));
    });
    expect(select.value).toBe("zh-TW");
    expect(select).toHaveAccessibleName("語言");
  });
});
