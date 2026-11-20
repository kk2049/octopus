/**
 * Best-effort browser-only persistence for user-authored text drafts.
 *
 * The cache is deliberately narrower than an application store:
 *
 * - values are scoped by the authenticated viewer and a caller-owned surface;
 * - only text the person is still editing is accepted (no attachments,
 *   credentials, server replies, resource facts or authority-bearing refs);
 * - empty values are retained as tombstones, so an older delayed write cannot
 *   make a deliberately deleted or submitted draft reappear;
 * - entries expire and are capacity bounded;
 * - every storage operation is best effort. Private mode or a full quota may
 *   reduce recovery to this document's memory, but never breaks the composer;
 * - a write the quota refuses never leaves the OLDER draft behind to be
 *   restored on reload as if it were current. The entry becomes an "unsaved"
 *   marker: this document keeps the newest text in memory, a reload or another
 *   tab reads an empty draft, and other tabs are not pushed an empty text.
 */

import { bootstrap } from "./bootstrap.js";
import {
  BROWSER_DRAFT_KEY_MAX,
  BROWSER_DRAFT_TEXT_MAX,
} from "@claude-bot/web-trust/frame-protocol";

export { BROWSER_DRAFT_KEY_MAX, BROWSER_DRAFT_TEXT_MAX } from "@claude-bot/web-trust/frame-protocol";
export const BROWSER_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
export const BROWSER_DRAFT_CAPACITY = 48;

const RECORD_VERSION = 1;
const STORAGE_PREFIX = "octopus.browser-draft.v1";

export interface BrowserDraftRecord {
  readonly text: string;
  readonly updatedAt: number;
}

export interface BrowserDraftStore {
  read(key: string): BrowserDraftRecord;
  write(key: string, text: string): BrowserDraftRecord;
  subscribe(key: string, listener: (record: BrowserDraftRecord) => void): () => void;
  destroy(): void;
}

export interface BrowserDraftStoreOptions {
  namespace: string;
  storage?: Storage | null;
  eventTarget?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  now?: () => number;
  capacity?: number;
  ttlMs?: number;
}

interface StoredDraft {
  v: typeof RECORD_VERSION;
  text: string;
  updated_at: number;
  /**
   * The newest text at `updated_at` could not be stored (quota). Only the
   * document that wrote it holds that text; everyone else reads an empty
   * draft. An older reader sees a plain tombstone, which is also safe.
   */
  unsaved?: true;
}

const EMPTY_RECORD: BrowserDraftRecord = Object.freeze({ text: "", updatedAt: 0 });

function validKey(key: string): boolean {
  return Boolean(key) && key.length <= BROWSER_DRAFT_KEY_MAX;
}

function parseStored(raw: string | null, now: number, ttlMs: number): { record: BrowserDraftRecord; unsaved: boolean } {
  const empty = { record: EMPTY_RECORD, unsaved: false };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw) as Partial<StoredDraft>;
    if (value.v !== RECORD_VERSION || typeof value.text !== "string") return empty;
    if (typeof value.updated_at !== "number" || !Number.isSafeInteger(value.updated_at) || value.updated_at <= 0) {
      return empty;
    }
    if (now - value.updated_at > ttlMs || value.updated_at - now > 60_000) return empty;
    if (value.text.length > BROWSER_DRAFT_TEXT_MAX) return empty;
    const unsaved = value.unsaved === true;
    return {
      record: Object.freeze({ text: unsaved ? "" : value.text, updatedAt: value.updated_at }),
      unsaved,
    };
  } catch {
    return empty;
  }
}

function parseRecord(raw: string | null, now: number, ttlMs: number): BrowserDraftRecord {
  return parseStored(raw, now, ttlMs).record;
}

function stored(record: BrowserDraftRecord, unsaved = false): string {
  return JSON.stringify({
    v: RECORD_VERSION,
    text: unsaved ? "" : record.text,
    updated_at: record.updatedAt,
    ...(unsaved ? { unsaved: true as const } : {}),
  } satisfies StoredDraft);
}

function encoded(value: string): string {
  return encodeURIComponent(value).replaceAll(".", "%2E");
}

function localStorageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function createBrowserDraftStore(options: BrowserDraftStoreOptions): BrowserDraftStore {
  const now = options.now ?? (() => Date.now());
  const capacity = Number.isSafeInteger(options.capacity) && (options.capacity ?? 0) > 0
    ? options.capacity!
    : BROWSER_DRAFT_CAPACITY;
  const ttlMs = Number.isSafeInteger(options.ttlMs) && (options.ttlMs ?? 0) > 0
    ? options.ttlMs!
    : BROWSER_DRAFT_TTL_MS;
  const prefix = `${STORAGE_PREFIX}:${encoded(options.namespace)}:`;
  const storage = options.storage === undefined
    ? localStorageOrNull()
    : options.storage;
  const eventTarget = options.eventTarget === undefined
    ? (typeof window === "undefined" ? null : window)
    : options.eventTarget;
  const memory = new Map<string, BrowserDraftRecord>();
  const listeners = new Map<string, Set<(record: BrowserDraftRecord) => void>>();
  let lastTimestamp = 0;

  const storageKey = (key: string): string => `${prefix}${encoded(key)}`;

  const notify = (key: string, record: BrowserDraftRecord): void => {
    for (const listener of [...(listeners.get(key) ?? [])]) listener(record);
  };

  const read = (key: string): BrowserDraftRecord => {
    if (!validKey(key)) return EMPTY_RECORD;
    if (!storage) return memory.get(key) ?? EMPTY_RECORD;
    try {
      const { record, unsaved } = parseStored(storage.getItem(storageKey(key)), now(), ttlMs);
      const local = memory.get(key);
      // The text the quota refused lives only here; the marker stands for it.
      if (unsaved && local && local.updatedAt >= record.updatedAt) return local;
      if (record.updatedAt > 0) memory.set(key, record);
      else memory.delete(key);
      return record;
    } catch {
      return memory.get(key) ?? EMPTY_RECORD;
    }
  };

  const evict = (): void => {
    if (!storage) {
      const entries = [...memory.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      for (const [key, record] of entries.slice(capacity)) {
        memory.delete(key);
        notify(key, Object.freeze({ text: "", updatedAt: Math.max(now(), record.updatedAt + 1) }));
      }
      return;
    }
    try {
      const entries: Array<{ fullKey: string; key: string; record: BrowserDraftRecord }> = [];
      for (let index = 0; index < storage.length; index += 1) {
        const fullKey = storage.key(index);
        if (!fullKey?.startsWith(prefix)) continue;
        let key: string;
        try {
          key = decodeURIComponent(fullKey.slice(prefix.length));
        } catch {
          continue;
        }
        entries.push({ fullKey, key, record: parseRecord(storage.getItem(fullKey), now(), ttlMs) });
      }
      entries.sort((a, b) => b.record.updatedAt - a.record.updatedAt);
      for (const entry of entries.slice(capacity)) {
        storage.removeItem(entry.fullKey);
        memory.delete(entry.key);
        notify(entry.key, Object.freeze({ text: "", updatedAt: Math.max(now(), entry.record.updatedAt + 1) }));
      }
      for (const entry of entries.slice(0, capacity)) {
        if (entry.record.updatedAt > 0) continue;
        storage.removeItem(entry.fullKey);
        memory.delete(entry.key);
      }
    } catch {
      // A quota/security failure degrades to the bounded in-document map.
    }
  };

  const write = (key: string, text: string): BrowserDraftRecord => {
    if (!validKey(key)) return EMPTY_RECORD;
    const previous = read(key);
    const updatedAt = Math.max(now(), lastTimestamp + 1, previous.updatedAt + 1);
    lastTimestamp = updatedAt;
    // An oversized value is not truncated into a plausible but incomplete
    // instruction. Clearing the persisted copy is the fail-safe result; the
    // live textarea still keeps the complete in-memory value.
    const record = Object.freeze({
      text: text.length <= BROWSER_DRAFT_TEXT_MAX ? text : "",
      updatedAt,
    });
    memory.set(key, record);
    try {
      storage?.setItem(storageKey(key), stored(record));
    } catch {
      // Keep the in-document record; recovery across reload is best effort.
      // But the entry still holds an OLDER draft that a reload would restore
      // as current, so replace it with the unsaved marker (smaller than what
      // it replaces); failing even that, remove it.
      try {
        storage?.setItem(storageKey(key), stored(record, true));
      } catch {
        try {
          storage?.removeItem(storageKey(key));
        } catch {
          // Nothing left to try; the document's memory still holds the text.
        }
      }
    }
    notify(key, record);
    evict();
    return record;
  };

  const onStorage = (event: Event): void => {
    const change = event as StorageEvent;
    if (!change.key?.startsWith(prefix)) return;
    let key: string;
    try {
      key = decodeURIComponent(change.key.slice(prefix.length));
    } catch {
      return;
    }
    if (!validKey(key)) return;
    const { record: parsed, unsaved } = parseStored(change.newValue, now(), ttlMs);
    // Another document holds a newer text it could not store. Pushing an
    // empty draft into this document's editor would erase what it shows for
    // no gain; a reload of either reads the empty marker.
    if (unsaved) {
      memory.delete(key);
      return;
    }
    const record = parsed.updatedAt > 0
      ? parsed
      : Object.freeze({ text: "", updatedAt: Math.max(now(), (memory.get(key)?.updatedAt ?? 0) + 1) });
    memory.set(key, record);
    notify(key, record);
  };

  eventTarget?.addEventListener("storage", onStorage);

  return {
    read,
    write,
    subscribe(key, listener) {
      if (!validKey(key)) return () => {};
      const set = listeners.get(key) ?? new Set<(record: BrowserDraftRecord) => void>();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(key);
      };
    },
    destroy() {
      eventTarget?.removeEventListener("storage", onStorage);
      listeners.clear();
      memory.clear();
    },
  };
}

const sharedStores = new Map<string, BrowserDraftStore>();
const volatileViewer = `document-${Math.random().toString(36).slice(2)}`;

/** One store per viewer/surface for the life of this trusted document. */
export function browserDraftStore(scope: string): BrowserDraftStore {
  const viewer = String(bootstrap.viewer?.username ?? "").trim();
  const namespace = `${viewer || volatileViewer}:${scope}`;
  const existing = sharedStores.get(namespace);
  if (existing) return existing;
  const store = createBrowserDraftStore({
    namespace,
    // Never make an unauthenticated/unknown viewer's text visible after a
    // later account logs in on the same browser profile.
    storage: viewer ? localStorageOrNull() : null,
  });
  sharedStores.set(namespace, store);
  return store;
}

/** Test isolation; a production document naturally drops these on reload. */
export function resetBrowserDraftStoresForTests(): void {
  for (const store of sharedStores.values()) store.destroy();
  sharedStores.clear();
}
