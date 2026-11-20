import { describe, expect, it, vi } from "vitest";
import {
  COMPACT_CHAT_MEDIA_QUERY,
  handleChatComposerKeyDown,
  handleModifierSubmitKeyDown,
  isCompactChatViewport,
  shouldSubmitChatKey,
  type ChatComposerKeyEvent,
} from "./composer.js";

function keyEvent(overrides: Partial<ChatComposerKeyEvent> = {}): ChatComposerKeyEvent {
  return {
    key: "Enter",
    preventDefault: vi.fn(),
    ...overrides,
  };
}

function viewport(matches: boolean) {
  return {
    matchMedia: vi.fn((query: string) => ({ matches: query === COMPACT_CHAT_MEDIA_QUERY && matches })),
  };
}

describe("responsive chat composer keyboard policy", () => {
  it("sends plain Enter only in a compact viewport", () => {
    const submit = vi.fn();
    const compactEvent = keyEvent();

    expect(handleChatComposerKeyDown(compactEvent, submit, viewport(true))).toBe(true);
    expect(compactEvent.preventDefault).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();

    const desktopEvent = keyEvent();
    expect(handleChatComposerKeyDown(desktopEvent, submit, viewport(false))).toBe(false);
    expect(desktopEvent.preventDefault).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("keeps Ctrl/Command+Enter as the wide-screen submit gestures", () => {
    expect(shouldSubmitChatKey(keyEvent({ ctrlKey: true }), false)).toBe(true);
    expect(shouldSubmitChatKey(keyEvent({ metaKey: true }), false)).toBe(true);
  });

  it("keeps Enter a newline for brief composers even in a compact viewport", () => {
    // A real phone viewport, globally: the modifier-only policy must reach the
    // same verdict as it would on a desk, so it must not consult matchMedia.
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    try {
      expect(isCompactChatViewport()).toBe(true);
      const submit = vi.fn();
      const compactEnter = keyEvent();

      expect(handleModifierSubmitKeyDown(compactEnter, submit)).toBe(false);
      expect(compactEnter.preventDefault).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();

      const withModifier = keyEvent({ metaKey: true });
      expect(handleModifierSubmitKeyDown(withModifier, submit)).toBe(true);
      expect(withModifier.preventDefault).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never submits IME confirmation, WebKit keyCode 229, repeats, or other keys", () => {
    expect(shouldSubmitChatKey(keyEvent({ isComposing: true }), true)).toBe(false);
    expect(shouldSubmitChatKey(keyEvent({ nativeEvent: { isComposing: true } }), true)).toBe(false);
    expect(shouldSubmitChatKey(keyEvent({ keyCode: 229 }), true)).toBe(false);
    expect(shouldSubmitChatKey(keyEvent({ nativeEvent: { keyCode: 229 } }), true)).toBe(false);
    expect(shouldSubmitChatKey(keyEvent({ repeat: true }), true)).toBe(false);
    expect(shouldSubmitChatKey(keyEvent({ key: "Escape" }), true)).toBe(false);
  });
});
