import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createComposerDraftStore,
  type ComposerDraftPersistence,
  type ComposerDraftRecord,
} from "./composer-drafts.js";

describe("composer draft store", () => {
  afterEach(() => vi.useRealTimers());

  it("notifies only the changed session and drops the oldest retained draft", () => {
    const store = createComposerDraftStore(2);
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe("first", first);
    store.subscribe("second", second);

    store.set("first", "one");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    store.set("second", "two");
    store.set("third", "three");
    expect(store.get("first")).toBe("");
    expect(store.get("second")).toBe("two");
    expect(store.get("third")).toBe("three");
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("restores refused text only while that session is empty", () => {
    const store = createComposerDraftStore(2);
    store.set("first", "new words");
    store.setIfEmpty("first", "refused words");
    expect(store.get("first")).toBe("new words");

    store.set("first", "");
    store.setIfEmpty("first", "refused words");
    expect(store.get("first")).toBe("refused words");
  });

  it("hydrates by resource, debounces text, and tombstones send immediately", () => {
    vi.useFakeTimers();
    let at = 1_000;
    const values = new Map<string, ComposerDraftRecord>([
      ["first", { text: "刷新前的草稿", updatedAt: 900 }],
    ]);
    const listeners = new Map<string, Set<(record: ComposerDraftRecord) => void>>();
    const persistence: ComposerDraftPersistence = {
      get: (key) => values.get(key) ?? { text: "", updatedAt: 0 },
      set: (key, text) => {
        const value = { text, updatedAt: ++at };
        values.set(key, value);
        for (const listener of listeners.get(key) ?? []) listener(value);
      },
      subscribe: (key, listener) => {
        const set = listeners.get(key) ?? new Set();
        set.add(listener);
        listeners.set(key, set);
        return () => { set.delete(listener); };
      },
    };
    const store = createComposerDraftStore(2, persistence);
    const changed = vi.fn();
    const off = store.subscribe("first", changed);
    expect(store.get("first")).toBe("刷新前的草稿");

    store.set("first", "继续写");
    expect(values.get("first")?.text).toBe("刷新前的草稿");
    vi.advanceTimersByTime(900);
    expect(values.get("first")?.text).toBe("继续写");

    store.set("first", "");
    expect(values.get("first")?.text).toBe("");
    off();
    store.destroy();
  });

  it("tombstones a launch before submission and restores only the matching unchanged text", () => {
    vi.useFakeTimers();
    let at = 1_000;
    const values = new Map<string, ComposerDraftRecord>();
    const listeners = new Map<string, Set<(record: ComposerDraftRecord) => void>>();
    const persistence: ComposerDraftPersistence = {
      get: (key) => values.get(key) ?? { text: "", updatedAt: 0 },
      set: (key, text) => {
        const value = { text, updatedAt: ++at };
        values.set(key, value);
        for (const listener of listeners.get(key) ?? []) listener(value);
      },
      subscribe: (key, listener) => {
        const set = listeners.get(key) ?? new Set();
        set.add(listener);
        listeners.set(key, set);
        return () => { set.delete(listener); };
      },
    };
    const store = createComposerDraftStore(2, persistence);
    store.subscribe("launch", () => {});
    store.set("launch", "启动一个长任务");
    vi.advanceTimersByTime(900);

    const submission = store.beginSubmission("launch");
    expect(values.get("launch")?.text).toBe("");
    expect(store.get("launch")).toBe("启动一个长任务");

    store.restoreSubmission(submission);
    expect(values.get("launch")?.text).toBe("启动一个长任务");

    const next = store.beginSubmission("launch");
    store.set("launch", "下一条任务");
    for (const listener of listeners.get("launch") ?? []) {
      listener({ text: "", updatedAt: ++at });
    }
    expect(store.get("launch")).toBe("下一条任务");
    store.completeSubmission(next);
    expect(store.get("launch")).toBe("下一条任务");
    store.destroy();
  });

  it("does not let a delayed chat-clear echo erase the next message", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let at = 1_000;
    const values = new Map<string, ComposerDraftRecord>();
    const listeners = new Map<string, Set<(record: ComposerDraftRecord) => void>>();
    const persistence: ComposerDraftPersistence = {
      get: (key) => values.get(key) ?? { text: "", updatedAt: 0 },
      // Model the real MessagePort bridge: writes return before the Host echo.
      set: (key, text) => { values.set(key, { text, updatedAt: ++at }); },
      subscribe: (key, listener) => {
        const set = listeners.get(key) ?? new Set();
        set.add(listener);
        listeners.set(key, set);
        return () => { set.delete(listener); };
      },
    };
    const store = createComposerDraftStore(2, persistence);
    store.subscribe("chat", () => {});
    store.set("chat", "已经发送");
    vi.advanceTimersByTime(900);

    store.set("chat", "");
    store.set("chat", "正在写下一条");
    for (const listener of listeners.get("chat") ?? []) {
      listener({ text: "", updatedAt: 9_999 });
    }

    expect(store.get("chat")).toBe("正在写下一条");
    store.destroy();
  });

  it("keeps an ambiguous retry visible without reviving it on pagehide", () => {
    vi.useFakeTimers();
    let at = 1_000;
    const values = new Map<string, ComposerDraftRecord>();
    const persistence: ComposerDraftPersistence = {
      get: (key) => values.get(key) ?? { text: "", updatedAt: 0 },
      set: (key, text) => { values.set(key, { text, updatedAt: ++at }); },
      subscribe: () => () => {},
    };
    const store = createComposerDraftStore(2, persistence);
    store.set("chat", "可能已经送达");
    vi.advanceTimersByTime(900);
    store.set("chat", "");

    store.setIfEmpty("chat", "可能已经送达", { persist: false });
    expect(store.get("chat")).toBe("可能已经送达");
    store.destroy();

    expect(values.get("chat")?.text).toBe("");
  });
});
