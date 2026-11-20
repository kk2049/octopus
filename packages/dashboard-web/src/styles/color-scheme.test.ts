import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseColorScheme, currentColorScheme, currentColorSchemePreference,
  initColorScheme, subscribeColorScheme,
} from "./color-scheme.js";

let systemDark = false;
let change: (() => void) | undefined;
let stop: (() => void) | undefined;
const key = "octopus-color-scheme-v1";

beforeEach(() => {
  window.localStorage.clear();
  systemDark = false;
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return systemDark; },
    addEventListener: (_: string, listener: () => void) => { change = listener; },
    removeEventListener: () => { change = undefined; },
  })));
});
afterEach(() => {
  stop?.();
  window.localStorage.clear();
  delete document.documentElement.dataset.colorScheme;
  vi.unstubAllGlobals();
});

const switchSystem = (dark: boolean) => { systemDark = dark; change?.(); };

describe("document colour scheme", () => {
  it("follows OS changes until explicitly selected and resumes on reset", () => {
    stop = initColorScheme();
    expect(currentColorScheme()).toBe("light");
    switchSystem(true);
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
    chooseColorScheme("light");
    switchSystem(false);
    switchSystem(true);
    expect(currentColorScheme()).toBe("light");
    expect(document.documentElement.dataset.colorScheme).toBe("light");
    chooseColorScheme("system");
    expect(currentColorScheme()).toBe("dark");
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("restores a saved choice before the first render, independently of the OS", () => {
    window.localStorage.setItem(key, "dark");
    stop = initColorScheme();
    expect(currentColorSchemePreference()).toBe("dark");
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
  });

  it("publishes only after the DOM and storage have the explicit choice", () => {
    stop = initColorScheme();
    const listener = vi.fn(() => {
      expect(currentColorScheme()).toBe("dark");
      expect(document.documentElement.dataset.colorScheme).toBe("dark");
      expect(window.localStorage.getItem(key)).toBe("dark");
    });
    const unsubscribe = subscribeColorScheme(listener);
    chooseColorScheme("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    chooseColorScheme("light");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the choice usable when browser storage is blocked", () => {
    stop = initColorScheme();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    chooseColorScheme("dark");
    expect(currentColorScheme()).toBe("dark");
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
  });

  it("adopts sibling-tab choices and clears without echoing a write", () => {
    stop = initColorScheme();
    const write = vi.spyOn(Storage.prototype, "setItem");
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "dark" }));
    expect(currentColorScheme()).toBe("dark");
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "future-mode" }));
    expect(currentColorScheme()).toBe("dark");
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(currentColorSchemePreference()).toBe("system");
    expect(currentColorScheme()).toBe("light");
    expect(write).not.toHaveBeenCalled();
  });

  it("ignores another storage area and removes OS/storage listeners on teardown", () => {
    stop = initColorScheme();
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "dark", storageArea: window.sessionStorage }));
    expect(currentColorScheme()).toBe("light");
    stop();
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "dark" }));
    switchSystem(true);
    expect(document.documentElement.dataset.colorScheme).toBe("light");
  });

  it("falls back to system for invalid or unreadable storage", () => {
    window.localStorage.setItem(key, "invalid");
    stop = initColorScheme();
    expect(currentColorSchemePreference()).toBe("system");
    stop();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    systemDark = true;
    stop = initColorScheme();
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
  });
});
