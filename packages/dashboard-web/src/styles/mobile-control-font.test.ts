import { afterEach, describe, expect, it, vi } from "vitest";
import { mobileControlFontSize, observeMobileControlFont } from "./mobile-control-font.js";

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("--mobile-control-font-size");
});

describe("mobile page zoom compensation", () => {
  it.each([
    [390, 390, true, 16], [520, 390, true, 21.34], [780, 390, true, 32],
    [1125, 844, true, 21.33], [195, 390, true, 16], [980, 390, true, 40.21],
    [520, 390, false, 16], [0, 390, true, 16], [520, 0, true, 16],
    [NaN, 390, true, 16], [390, Infinity, true, 16], [4000, 390, true, 64],
  ])("maps layout %s / window %s (touch %s) to %spx", (layout, width, touch, size) => {
    expect(mobileControlFontSize(layout, width, touch)).toBe(size);
  });

  it("updates on page zoom and rotation, ignores keyboard/pinch-only changes, and detaches", () => {
    const root = document.documentElement;
    const layout = vi.spyOn(root, "clientWidth", "get").mockReturnValue(520);
    const touch = Object.assign(new EventTarget(), { matches: true });
    const viewport = new EventTarget();
    const win = Object.assign(new EventTarget(), {
      document, outerWidth: 390, screen: { width: 390 }, visualViewport: viewport,
      matchMedia: () => touch,
    });
    const changed = vi.fn();
    const stop = observeMobileControlFont(win as unknown as Window, changed);
    expect(root.style.getPropertyValue("--mobile-control-font-size")).toBe("21.34px");
    viewport.dispatchEvent(new Event("resize"));
    expect(changed).toHaveBeenCalledTimes(1);
    layout.mockReturnValue(780);
    win.dispatchEvent(new Event("resize"));
    expect(changed).toHaveBeenLastCalledWith(32);
    win.outerWidth = 844;
    layout.mockReturnValue(844);
    win.dispatchEvent(new Event("orientationchange"));
    expect(changed).toHaveBeenLastCalledWith(16);
    stop();
    layout.mockReturnValue(1688);
    win.dispatchEvent(new Event("resize"));
    expect(changed).toHaveBeenCalledTimes(3);
    expect(root.style.getPropertyValue("--mobile-control-font-size")).toBe("");
  });
});
