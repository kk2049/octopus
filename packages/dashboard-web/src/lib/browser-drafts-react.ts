/** React ownership and submit lifecycle for the browser-only draft cache. */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  BROWSER_DRAFT_TEXT_MAX,
  browserDraftStore,
  type BrowserDraftRecord,
  type BrowserDraftStore,
} from "./browser-drafts.js";

const SAVE_AFTER_MS = 900;
const SAVE_AT_LEAST_EVERY_MS = 3_000;

export interface BrowserDraftSnapshot {
  readonly text: string;
  readonly version: number;
}

export interface BrowserDraftSubmission {
  readonly key: string;
  readonly text: string;
  readonly version: number;
}

export interface BrowserDraft {
  readonly text: string;
  set(text: string): void;
  clear(): void;
  /**
   * Remove the persisted copy before an uncertain mutation starts while
   * keeping the textarea visible. A refresh during the request therefore
   * cannot resurrect text the server may already have consumed.
   */
  beginSubmission(): BrowserDraftSubmission | null;
  completeSubmission(submission: BrowserDraftSubmission | null): void;
  /** Call only for an authoritative refusal known not to have committed. */
  restoreSubmission(submission: BrowserDraftSubmission | null): void;
}

interface Entry {
  snapshot: BrowserDraftSnapshot;
  persistedAt: number;
  lastEditAt: number;
  dirtySince: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  suppressedVersion: number | null;
  suppressStoreEvent: boolean;
  listeners: Set<() => void>;
  offStore: (() => void) | null;
}

const EMPTY_SNAPSHOT: BrowserDraftSnapshot = Object.freeze({ text: "", version: 0 });

export interface BrowserDraftCoordinator {
  snapshot(key: string): BrowserDraftSnapshot;
  subscribe(key: string, listener: () => void): () => void;
  set(key: string, text: string): void;
  clear(key: string): void;
  beginSubmission(key: string): BrowserDraftSubmission;
  completeSubmission(submission: BrowserDraftSubmission): void;
  restoreSubmission(submission: BrowserDraftSubmission): void;
  flush(): void;
  destroy(): void;
}

export function createBrowserDraftCoordinator(
  store: BrowserDraftStore,
  options: { saveAfterMs?: number; saveAtLeastEveryMs?: number; now?: () => number } = {},
): BrowserDraftCoordinator {
  const saveAfterMs = options.saveAfterMs ?? SAVE_AFTER_MS;
  const saveAtLeastEveryMs = options.saveAtLeastEveryMs ?? SAVE_AT_LEAST_EVERY_MS;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();

  const notify = (entry: Entry): void => {
    for (const listener of [...entry.listeners]) listener();
  };

  const ensure = (key: string): Entry => {
    const existing = entries.get(key);
    if (existing) return existing;
    const record = store.read(key);
    const entry: Entry = {
      snapshot: Object.freeze({ text: record.text, version: 0 }),
      persistedAt: record.updatedAt,
      lastEditAt: record.updatedAt,
      dirtySince: null,
      timer: null,
      suppressedVersion: null,
      suppressStoreEvent: false,
      listeners: new Set(),
      offStore: null,
    };
    entries.set(key, entry);
    return entry;
  };

  const cancelTimer = (entry: Entry): void => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  };

  const acceptStoreRecord = (key: string, record: BrowserDraftRecord): void => {
    const entry = ensure(key);
    if (entry.suppressStoreEvent) return;
    if (record.updatedAt < entry.persistedAt) return;
    if (entry.dirtySince !== null && record.updatedAt < entry.lastEditAt) return;
    entry.persistedAt = record.updatedAt;
    if (record.text === entry.snapshot.text) {
      entry.dirtySince = null;
      cancelTimer(entry);
      return;
    }
    cancelTimer(entry);
    entry.dirtySince = null;
    entry.suppressedVersion = null;
    entry.snapshot = Object.freeze({ text: record.text, version: entry.snapshot.version + 1 });
    notify(entry);
  };

  const connect = (key: string, entry: Entry): void => {
    if (entry.offStore) return;
    entry.offStore = store.subscribe(key, (record) => acceptStoreRecord(key, record));
    acceptStoreRecord(key, store.read(key));
  };

  const persist = (key: string, entry: Entry): void => {
    cancelTimer(entry);
    if (entry.suppressedVersion === entry.snapshot.version) return;
    entry.dirtySince = null;
    entry.suppressStoreEvent = true;
    const record = store.write(key, entry.snapshot.text.length <= BROWSER_DRAFT_TEXT_MAX ? entry.snapshot.text : "");
    entry.suppressStoreEvent = false;
    entry.persistedAt = record.updatedAt;
  };

  const schedule = (key: string, entry: Entry): void => {
    cancelTimer(entry);
    const dirtySince = entry.dirtySince ?? now();
    entry.dirtySince = dirtySince;
    const delay = Math.max(0, Math.min(saveAfterMs, dirtySince + saveAtLeastEveryMs - now()));
    entry.timer = setTimeout(() => persist(key, entry), delay);
  };

  const set = (key: string, text: string): void => {
    const entry = ensure(key);
    if (entry.snapshot.text === text) return;
    entry.snapshot = Object.freeze({ text, version: entry.snapshot.version + 1 });
    entry.lastEditAt = Math.max(now(), entry.lastEditAt + 1);
    entry.suppressedVersion = null;
    notify(entry);
    if (!text || text.length > BROWSER_DRAFT_TEXT_MAX) persist(key, entry);
    else schedule(key, entry);
  };

  const onPageHide = (): void => {
    for (const [key, entry] of entries) {
      if (entry.dirtySince !== null) persist(key, entry);
    }
  };
  if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);

  return {
    snapshot(key) {
      return key ? ensure(key).snapshot : EMPTY_SNAPSHOT;
    },
    subscribe(key, listener) {
      if (!key) return () => {};
      const entry = ensure(key);
      entry.listeners.add(listener);
      connect(key, entry);
      return () => {
        entry.listeners.delete(listener);
        if (!entry.listeners.size) {
          entry.offStore?.();
          entry.offStore = null;
        }
      };
    },
    set,
    clear(key) {
      set(key, "");
    },
    beginSubmission(key) {
      const entry = ensure(key);
      cancelTimer(entry);
      entry.dirtySince = null;
      entry.suppressedVersion = entry.snapshot.version;
      entry.suppressStoreEvent = true;
      const record = store.write(key, "");
      entry.suppressStoreEvent = false;
      entry.persistedAt = record.updatedAt;
      return Object.freeze({ key, text: entry.snapshot.text, version: entry.snapshot.version });
    },
    completeSubmission(submission) {
      const entry = ensure(submission.key);
      if (entry.snapshot.version !== submission.version || entry.snapshot.text !== submission.text) return;
      entry.suppressedVersion = null;
      set(submission.key, "");
    },
    restoreSubmission(submission) {
      const entry = ensure(submission.key);
      if (entry.snapshot.version !== submission.version || entry.snapshot.text !== submission.text) return;
      entry.suppressedVersion = null;
      entry.dirtySince = now();
      persist(submission.key, entry);
    },
    flush: onPageHide,
    destroy() {
      if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
      for (const entry of entries.values()) {
        cancelTimer(entry);
        entry.offStore?.();
      }
      entries.clear();
    },
  };
}

const coordinators = new Map<BrowserDraftStore, BrowserDraftCoordinator>();

function browserDraftCoordinator(scope: string): BrowserDraftCoordinator {
  const store = browserDraftStore(scope);
  const existing = coordinators.get(store);
  if (existing) return existing;
  const coordinator = createBrowserDraftCoordinator(store);
  coordinators.set(store, coordinator);
  return coordinator;
}

export function useBrowserDraft(key: string | null, scope = "dashboard"): BrowserDraft {
  const coordinator = useMemo(() => browserDraftCoordinator(scope), [scope]);
  const subscribe = useCallback((listener: () => void) => (
    key ? coordinator.subscribe(key, listener) : () => {}
  ), [coordinator, key]);
  const getSnapshot = useCallback(() => key ? coordinator.snapshot(key) : EMPTY_SNAPSHOT, [coordinator, key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(() => ({
    text: snapshot.text,
    set: (text: string) => { if (key) coordinator.set(key, text); },
    clear: () => { if (key) coordinator.clear(key); },
    beginSubmission: () => key ? coordinator.beginSubmission(key) : null,
    completeSubmission: (submission: BrowserDraftSubmission | null) => {
      if (submission) coordinator.completeSubmission(submission);
    },
    restoreSubmission: (submission: BrowserDraftSubmission | null) => {
      if (submission) coordinator.restoreSubmission(submission);
    },
  }), [coordinator, key, snapshot.text]);
}

export function resetBrowserDraftCoordinatorsForTests(): void {
  for (const coordinator of coordinators.values()) coordinator.destroy();
  coordinators.clear();
}
