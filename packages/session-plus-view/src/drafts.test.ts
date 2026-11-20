import { describe, expect, it, vi } from "vitest";
import type { AgentViewClient } from "@claude-bot/agent-view-react";
import { NEW_SESSION_PROMPT_DRAFT_RESOURCE } from "@claude-bot/agent-sessions-view";
import { createAsyncQuestionPersistence, createSessionComposerDraftPersistence } from "./drafts.js";

describe("Session Plus draft adapter", () => {
  it("keeps ignored question preferences separate from chat drafts and subscribes by session", () => {
    const get = vi.fn(() => ({ text: '["call-1"]', updatedAt: 1 }));
    const set = vi.fn();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const client = { drafts: { get, set, subscribe } } as unknown as AgentViewClient;
    const preferences = createAsyncQuestionPersistence(client);
    expect(preferences.get("session-a").text).toBe('["call-1"]');
    preferences.set("session-b", '["call-2"]');
    const listener = vi.fn();
    expect(preferences.subscribe("session-a", listener)).toBe(unsubscribe);
    expect(get).toHaveBeenCalledWith("session-async-ignored:session-a");
    expect(set).toHaveBeenCalledWith("session-async-ignored:session-b", '["call-2"]');
    expect(subscribe).toHaveBeenCalledWith("session-async-ignored:session-a", listener);
  });
  it("separates the new-Agent prompt from opaque session chat keys", () => {
    const get = vi.fn(() => ({ text: "", updatedAt: 0 }));
    const set = vi.fn();
    const subscribe = vi.fn(() => () => {});
    const client = {
      drafts: { get, set, subscribe },
    } as unknown as AgentViewClient;
    const drafts = createSessionComposerDraftPersistence(client);

    drafts.get(NEW_SESSION_PROMPT_DRAFT_RESOURCE);
    drafts.set("opaque-session", "继续写");

    expect(get).toHaveBeenCalledWith("session-new:prompt");
    expect(set).toHaveBeenCalledWith("session-chat:opaque-session", "继续写");
  });
});
