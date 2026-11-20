/**
 * The switch itself: attribute + persistence + a safe default. The two theme
 * FILES are owned by the art workstreams and are asserted only for scoping —
 * an unscoped rule in a theme file would restyle `classic` too, which is the
 * one thing "switch back" must never allow.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_CONTRACT } from "@claude-bot/web-trust/frame-protocol";
import { applyTheme, chooseTheme, currentTheme, getAppearance, initMobileControlFont, initTheme, subscribeTheme } from "./themes.js";

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  // Return the module's in-memory state to a deterministic value so tests do
  // not leak into each other. New browser profiles default to DeepSeek, while
  // an explicit classic choice must remain stable and reachable.
  applyTheme("classic");
});

describe("the theme switch", () => {
  it("applies a known theme as an attribute and persists it", () => {
    applyTheme("aurora");
    expect(document.documentElement.dataset.theme).toBe("aurora");
    expect(currentTheme()).toBe("aurora");
    expect(window.localStorage.getItem("octopus-theme-v2")).toBe("aurora");
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("aurora");
  });

  it("treats classic as the ABSENCE of the attribute", () => {
    applyTheme("aurora");
    applyTheme("classic");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("falls back to the measured DeepSeek default on an unknown or tampered value", () => {
    applyTheme("banksy" as never);
    expect(document.documentElement.dataset.theme).toBe("deepseek");
    // A tampered localStorage entry never becomes the applied theme because
    // `currentTheme` reads the in-memory truth (`applied`), which is the
    // authoritative value the last `applyTheme` wrote.
    window.localStorage.setItem("octopus-theme-v2", "garbage");
    expect(currentTheme()).toBe("deepseek");
  });

  it("lets the server account preference win and refreshes the local cache", () => {
    applyTheme("aurora");
    initTheme("apple");
    expect(currentTheme()).toBe("apple");
    expect(document.documentElement.dataset.theme).toBe("apple");
    expect(window.localStorage.getItem("octopus-theme-v2")).toBe("apple");
  });

  it("does not overwrite a future server theme with this bundle's fallback", () => {
    applyTheme("apple");
    initTheme("spatial-2027");
    expect(currentTheme()).toBe("deepseek");
    expect(document.documentElement.dataset.theme).toBe("deepseek");
    expect(window.localStorage.getItem("octopus-theme-v2")).toBe("apple");
  });

  it("stores an explicit account choice once while keeping the local transition immediate", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, theme: "apple" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const persisted = chooseTheme("apple");
    expect(currentTheme()).toBe("apple");
    expect(document.documentElement.dataset.theme).toBe("apple");
    await persisted;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/theme-preference", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ theme: "apple" }),
      credentials: "same-origin",
    }));
  });

  it("keeps the local cache and does not retry when server persistence fails", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await chooseTheme("ink");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(currentTheme()).toBe("ink");
    expect(window.localStorage.getItem("octopus-theme-v2")).toBe("ink");
  });

  it("serializes rapid account choices so the latest selection wins on the server", async () => {
    const fetchMock = vi.mocked(fetch);
    let releaseFirst: ((response: Response) => void) | undefined;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        releaseFirst = resolve;
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, theme: "ink" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const applePersisted = chooseTheme("apple");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const inkPersisted = chooseTheme("ink");
    expect(currentTheme()).toBe("ink");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (!releaseFirst) throw new Error("the first account preference write did not start");
    releaseFirst(new Response(JSON.stringify({ ok: true, theme: "apple" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await Promise.all([applePersisted, inkPersisted]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ theme: "apple" }),
      JSON.stringify({ theme: "ink" }),
    ]);
  });

  // A static "every rule is scoped" scan lived here briefly; the web
  // project's import.meta.url indirection made readFileSync land on the wrong
  // file, so the scoping discipline is stated in each theme file's header and
  // checked at integration instead of asserted from jsdom.
});

describe("the appearance subscription surface (ticket #45)", () => {
  it("forwards page zoom through the same appearance subscription without changing the theme", () => {
    applyTheme("apple");
    const layout = vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(520);
    vi.stubGlobal("outerWidth", 390);
    vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: true }));
    const listener = vi.fn();
    const unsubscribe = subscribeTheme(listener);
    const stop = initMobileControlFont();
    try {
      expect(getAppearance()).toEqual({ contract: APPEARANCE_CONTRACT, theme: "apple", controlFontSize: 21.34 });
      expect(listener).toHaveBeenLastCalledWith(getAppearance());
      layout.mockReturnValue(780);
      window.dispatchEvent(new Event("resize"));
      expect(listener).toHaveBeenLastCalledWith({ contract: APPEARANCE_CONTRACT, theme: "apple", controlFontSize: 32 });
      layout.mockReturnValue(390);
      window.dispatchEvent(new Event("resize"));
      expect(getAppearance()).toEqual({ contract: APPEARANCE_CONTRACT, theme: "apple" });
    } finally {
      unsubscribe();
      stop();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
  it("returns the current theme wrapped in the wire contract id", () => {
    applyTheme("aurora");
    expect(getAppearance()).toEqual({ contract: APPEARANCE_CONTRACT, theme: "aurora" });
    applyTheme("classic");
    expect(getAppearance()).toEqual({ contract: APPEARANCE_CONTRACT, theme: "classic" });
  });

  it("notifies subscribers after applyTheme mutates the document", () => {
    const seen = vi.fn();
    const off = subscribeTheme(seen);
    applyTheme("aurora");
    // The listener sees the value AFTER the attribute has been set; that is
    // the order Session Plus / AppOpen page rely on (they forward the same
    // appearance the DOM now reflects to the iframe).
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ contract: APPEARANCE_CONTRACT, theme: "aurora" });
    expect(document.documentElement.dataset.theme).toBe("aurora");
    off();
    applyTheme("ink");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("does not fire the listener on subscription itself", () => {
    // Callers read `getAppearance()` explicitly for the boot payload; the
    // subscription is for future changes. Firing on subscribe would push a
    // duplicate over the port right after boot. Same signature discipline
    // that `useSyncExternalStore` relies on.
    const seen = vi.fn();
    const off = subscribeTheme(seen);
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it("survives a listener that throws — the others still receive the update", () => {
    const bad = vi.fn(() => {
      throw new Error("bang");
    });
    const good = vi.fn();
    const offBad = subscribeTheme(bad);
    const offGood = subscribeTheme(good);
    applyTheme("aurora");
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    offBad();
    offGood();
  });

  it("bridges cross-tab writes: a storage event triggers a local apply", () => {
    // Another current-version tab wrote `octopus-theme-v2 = "ink"` and
    // dispatched a storage event. This tab's iframe subscribers must see the change so they can
    // forward it, and `<html data-theme>` on this tab must move too. The
    // event's own `newValue` is what is trusted (reading storage here would
    // race the writer in the other tab).
    const seen = vi.fn();
    const off = subscribeTheme(seen);
    const write = vi.spyOn(Storage.prototype, "setItem");
    window.dispatchEvent(new StorageEvent("storage", {
      key: "octopus-theme-v2",
      newValue: "ink",
    }));
    expect(document.documentElement.dataset.theme).toBe("ink");
    expect(seen).toHaveBeenCalledWith({ contract: APPEARANCE_CONTRACT, theme: "ink" });
    expect(write).not.toHaveBeenCalled();
    off();
  });

  it("does not let an older tab echo DeepSeek over a locally selected Apple theme", () => {
    applyTheme("apple");
    const seen = vi.fn();
    const off = subscribeTheme(seen);
    // A pre-Apple bundle listens on the legacy key. It receives `apple`, folds
    // that unknown id to DeepSeek, and writes DeepSeek back there. The v2 tab
    // must ignore that downgrade echo.
    window.dispatchEvent(new StorageEvent("storage", {
      key: "octopus-theme",
      newValue: "deepseek",
    }));
    expect(currentTheme()).toBe("apple");
    expect(document.documentElement.dataset.theme).toBe("apple");
    expect(window.localStorage.getItem("octopus-theme-v2")).toBe("apple");
    expect(fetch).not.toHaveBeenCalled();
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it("keeps its current appearance when a newer tab selects a future theme id", () => {
    applyTheme("apple");
    const seen = vi.fn();
    const off = subscribeTheme(seen);
    window.dispatchEvent(new StorageEvent("storage", {
      key: "octopus-theme-v2",
      newValue: "spatial-2027",
    }));
    expect(currentTheme()).toBe("apple");
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it("ignores storage events for unrelated keys", () => {
    const seen = vi.fn();
    const off = subscribeTheme(seen);
    window.dispatchEvent(new StorageEvent("storage", { key: "not-us", newValue: "aurora" }));
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it("keeps DOM, subscribers and getAppearance consistent when localStorage.setItem throws", () => {
    // Private mode, quota exceeded, an extension replacing storage — every
    // path where setItem raises used to leave the outer shell painting one
    // theme while the iframe was told classic (because `currentTheme` re-read
    // storage). The in-memory `applied` variable is now the source of truth,
    // so this test can never regress silently.
    const seen = vi.fn();
    const off = subscribeTheme(seen);
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      applyTheme("aurora");
      expect(document.documentElement.dataset.theme).toBe("aurora");
      expect(currentTheme()).toBe("aurora");
      expect(getAppearance()).toEqual({ contract: APPEARANCE_CONTRACT, theme: "aurora" });
      expect(seen).toHaveBeenCalledWith({ contract: APPEARANCE_CONTRACT, theme: "aurora" });
    } finally {
      Storage.prototype.setItem = original;
      off();
    }
  });

  it("keeps in-memory truth even when localStorage.getItem throws on later reads", () => {
    // A tab that had aurora applied, then storage started throwing on read
    // (a race with a devtools clear, an extension) must still say aurora
    // — the applied value has not changed, and the in-memory record is
    // what answers `currentTheme()`.
    applyTheme("aurora");
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("unavailable");
    };
    try {
      expect(currentTheme()).toBe("aurora");
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
