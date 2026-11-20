import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserDraftStore,
  resetBrowserDraftStoresForTests,
} from "./browser-drafts.js";
import {
  createBrowserDraftCoordinator,
  resetBrowserDraftCoordinatorsForTests,
} from "./browser-drafts-react.js";

describe("browser draft cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetBrowserDraftCoordinatorsForTests();
    resetBrowserDraftStoresForTests();
  });

  afterEach(() => {
    resetBrowserDraftCoordinatorsForTests();
    resetBrowserDraftStoresForTests();
    vi.useRealTimers();
  });

  it("debounces ordinary edits but persists a deliberate empty value immediately", () => {
    let at = 1_000;
    const store = createBrowserDraftStore({ namespace: "alice:test", now: () => at });
    const drafts = createBrowserDraftCoordinator(store, { now: () => at, saveAfterMs: 900 });

    drafts.set("ticket:44", "写到一半");
    expect(store.read("ticket:44").text).toBe("");
    vi.advanceTimersByTime(900);
    expect(store.read("ticket:44").text).toBe("写到一半");

    at += 1_000;
    drafts.set("ticket:44", "");
    expect(store.read("ticket:44").text).toBe("");
  });

  it("keeps semantic keys isolated", () => {
    const store = createBrowserDraftStore({ namespace: "alice:test" });
    const drafts = createBrowserDraftCoordinator(store, { saveAfterMs: 1 });
    drafts.set("ticket:44", "给 44");
    drafts.set("ticket:45", "给 45");
    vi.runAllTimers();

    expect(store.read("ticket:44").text).toBe("给 44");
    expect(store.read("ticket:45").text).toBe("给 45");
  });

  it("evicts the oldest semantic entry at the configured capacity", () => {
    let at = 1_000;
    const store = createBrowserDraftStore({ namespace: "alice:bounded", capacity: 2, now: () => ++at });

    store.write("first", "一");
    store.write("second", "二");
    store.write("third", "三");

    expect(store.read("first").text).toBe("");
    expect(store.read("second").text).toBe("二");
    expect(store.read("third").text).toBe("三");
  });

  it("never restores an older draft as current after the quota refused a newer one", () => {
    let at = 1_000;
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      // A full quota: anything longer than 200 characters is refused.
      setItem: (key: string, value: string) => {
        if (value.length > 200) throw new DOMException("quota", "QuotaExceededError");
        backing.set(key, value);
      },
      removeItem: (key: string) => { backing.delete(key); },
      key: (index: number) => [...backing.keys()][index] ?? null,
      get length() { return backing.size; },
      clear: () => backing.clear(),
    } as Storage;
    const listeners: Array<(event: Event) => void> = [];
    const otherTab = {
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.push(listener as (event: Event) => void),
      removeEventListener: () => {},
    } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
    const store = createBrowserDraftStore({ namespace: "alice:quota", storage, now: () => ++at });
    const other = createBrowserDraftStore({ namespace: "alice:quota", storage, now: () => ++at, eventTarget: otherTab });
    const seenByOther: string[] = [];
    other.subscribe("chat:one", (record) => seenByOther.push(record.text));

    store.write("chat:one", "旧草稿");
    const fullKey = [...backing.keys()][0]!;
    const newer = "新".repeat(500);
    store.write("chat:one", newer);
    // Deliver the resulting change to the other tab the way a browser would.
    for (const listener of listeners) {
      listener(Object.assign(new Event("storage"), { key: fullKey, newValue: backing.get(fullKey) ?? null }));
    }

    // This document still edits the newest text.
    expect(store.read("chat:one").text).toBe(newer);
    // A reload (a fresh store over the same storage) never sees the old draft.
    const reloaded = createBrowserDraftStore({ namespace: "alice:quota", storage, now: () => ++at });
    expect(reloaded.read("chat:one").text).toBe("");
    // The other tab is not pushed an empty draft into its editor.
    expect(seenByOther).toEqual([]);
    // A later write that fits replaces the marker as usual.
    store.write("chat:one", "短");
    expect(createBrowserDraftStore({ namespace: "alice:quota", storage, now: () => ++at }).read("chat:one").text).toBe("短");
  });

  it("keeps the current document usable when browser storage is unavailable", () => {
    const store = createBrowserDraftStore({ namespace: "anonymous:test", storage: null });

    store.write("ticket:44", "只保留在当前页");

    expect(store.read("ticket:44").text).toBe("只保留在当前页");
  });

  it("writes a tombstone before submit and never flushes the uncertain text on pagehide", () => {
    const store = createBrowserDraftStore({ namespace: "alice:test" });
    const drafts = createBrowserDraftCoordinator(store, { saveAfterMs: 1 });
    drafts.set("chat:one", "可能已经发送");
    vi.runAllTimers();
    const submission = drafts.beginSubmission("chat:one");

    expect(store.read("chat:one").text).toBe("");
    drafts.flush();
    expect(store.read("chat:one").text).toBe("");

    drafts.restoreSubmission(submission);
    expect(store.read("chat:one").text).toBe("可能已经发送");
  });

  it("does not let an old completion clear text typed while the request was in flight", () => {
    const store = createBrowserDraftStore({ namespace: "alice:test" });
    const drafts = createBrowserDraftCoordinator(store, { saveAfterMs: 1 });
    drafts.set("chat:one", "第一条");
    const submission = drafts.beginSubmission("chat:one");
    drafts.set("chat:one", "第二条");
    drafts.completeSubmission(submission);
    vi.runAllTimers();

    expect(drafts.snapshot("chat:one").text).toBe("第二条");
    expect(store.read("chat:one").text).toBe("第二条");
  });
});
