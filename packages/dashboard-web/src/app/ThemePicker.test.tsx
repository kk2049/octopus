/**
 * The theme picker follows the theme store, not its own mount-time snapshot.
 *
 * Regression this pins (ticket #45 correction #1): the previous
 * `useState(currentTheme)` version would read once and never move. So if a
 * sibling tab picked `ink` (via a cross-tab `storage` event), the outer
 * shell's CSS updated, the iframe followed, and the `<select>` in this tab
 * stayed on `classic`. Now `useSyncExternalStore(subscribeTheme, ...)` reads
 * from the same store and re-renders when anyone else moves the theme.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { applyTheme } from "../styles/themes.js";
import { applyLanguage } from "../i18n/language.js";
import { ThemePicker } from "./Shell.js";

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  applyTheme("classic");
  applyLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  applyLanguage("zh-CN");
});

function mountPicker() {
  render(<ThemePicker />);
  return screen.getByRole("combobox", { name: "主题" }) as HTMLSelectElement;
}

describe("the theme picker follows the store", () => {
  it("changes value when applyTheme is called externally (same tab)", () => {
    const select = mountPicker();
    expect(select.value).toBe("classic");
    act(() => {
      applyTheme("aurora");
    });
    expect(select.value).toBe("aurora");
  });

  it("changes value when another tab dispatches a storage event", () => {
    const select = mountPicker();
    expect(select.value).toBe("classic");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "octopus-theme-v2",
        newValue: "ink",
      }));
    });
    expect(select.value).toBe("ink");
    // And the outer shell's own attribute moved with it, so this tab paints
    // ink at the same moment its `<select>` says ink — the two never
    // disagree, which is the whole point of the store.
    expect(document.documentElement.dataset.theme).toBe("ink");
  });

  it("localizes its accessible name and translatable option labels", () => {
    const select = mountPicker();
    act(() => applyLanguage("en"));
    expect(select).toHaveAccessibleName("Theme");
    expect(screen.getByRole("option", { name: "🎨 Classic" })).toBeInTheDocument();
  });
});
