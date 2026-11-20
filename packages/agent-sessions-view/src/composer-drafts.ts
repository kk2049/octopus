/**
 * Resource-local composer drafts without controller-wide React invalidation.
 *
 * The optional persistence adapter remains a display-state seam, not a port or
 * an authority: Session Plus supplies a browser-local Host bridge, while the
 * read-only harness supplies nothing and keeps the original in-memory
 * behaviour. Writes are delayed but forced at least every few seconds; empty
 * text is immediate so send/delete can never be undone by an older timer.
 */

const SAVE_AFTER_MS = 900;
const SAVE_AT_LEAST_EVERY_MS = 3_000;

/** Reserved display-state key; provider resource ids never use this namespace. */
export const NEW_SESSION_PROMPT_DRAFT_RESOURCE = "@new-session/prompt";

export interface ComposerDraftRecord {
  readonly text: string;
  readonly updatedAt: number;
}

export interface ComposerDraftPersistence {
  get(resource: string): ComposerDraftRecord;
  set(resource: string, text: string): void;
  subscribe(resource: string, listener: (record: ComposerDraftRecord) => void): () => void;
}

export interface ComposerDraftSubmission {
  readonly resource: string;
  readonly text: string;
  readonly version: number;
}

export interface ComposerDraftStore {
  get(resource: string | null): string;
  set(resource: string | null, text: string): void;
  setIfEmpty(resource: string, text: string, options?: { persist?: boolean }): void;
  subscribe(resource: string | null, listener: () => void): () => void;
  beginSubmission(resource: string): ComposerDraftSubmission;
  completeSubmission(submission: ComposerDraftSubmission): void;
  restoreSubmission(submission: ComposerDraftSubmission): void;
  destroy(): void;
}

interface DraftMeta {
  updatedAt: number;
  lastEditAt: number;
  dirtySince: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  offPersistence: (() => void) | null;
  version: number;
  suppressedVersion: number | null;
  suppressPersistenceEvent: boolean;
  pendingTombstone: boolean;
}

export function createComposerDraftStore(
  limit: number,
  persistence?: ComposerDraftPersistence,
): ComposerDraftStore {
  const capacity = Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
  const values = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  const meta = new Map<string, DraftMeta>();

  const ensureMeta = (resource: string): DraftMeta => {
    const existing = meta.get(resource);
    if (existing) return existing;
    const record = persistence?.get(resource) ?? { text: "", updatedAt: 0 };
    if (record.text) values.set(resource, record.text);
    const created: DraftMeta = {
      updatedAt: record.updatedAt,
      lastEditAt: record.updatedAt,
      dirtySince: null,
      timer: null,
      offPersistence: null,
      version: 0,
      suppressedVersion: null,
      suppressPersistenceEvent: false,
      pendingTombstone: false,
    };
    meta.set(resource, created);
    return created;
  };

  const notify = (resource: string): void => {
    for (const listener of [...(listeners.get(resource) ?? [])]) listener();
  };

  const cancelTimer = (state: DraftMeta): void => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  };

  const persist = (resource: string, state: DraftMeta, force = false): void => {
    cancelTimer(state);
    if (!force && state.suppressedVersion === state.version) return;
    state.dirtySince = null;
    state.suppressPersistenceEvent = true;
    persistence?.set(resource, values.get(resource) ?? "");
    state.suppressPersistenceEvent = false;
  };

  const schedule = (resource: string, state: DraftMeta): void => {
    if (!persistence) return;
    cancelTimer(state);
    const now = Date.now();
    const dirtySince = state.dirtySince ?? now;
    state.dirtySince = dirtySince;
    const delay = Math.max(0, Math.min(SAVE_AFTER_MS, dirtySince + SAVE_AT_LEAST_EVERY_MS - now));
    state.timer = setTimeout(() => persist(resource, state), delay);
  };

  const receive = (resource: string, record: ComposerDraftRecord): void => {
    const state = ensureMeta(resource);
    if (state.suppressPersistenceEvent) return;
    if (record.updatedAt < state.updatedAt) return;
    if (state.dirtySince !== null && record.updatedAt < state.lastEditAt) return;
    state.updatedAt = record.updatedAt;
    // A submission tombstone crosses an async Host bridge. If the person has
    // already typed the next prompt before that echo returns, the empty echo
    // is still the old command and may not erase the newer live text. Keep
    // ignoring it until the bridge echoes a non-empty write or completion
    // deliberately accepts the empty value.
    if (state.pendingTombstone && record.text === "") return;
    if (record.text) state.pendingTombstone = false;
    if (state.suppressedVersion === state.version) return;
    state.dirtySince = null;
    cancelTimer(state);
    const previous = values.get(resource) ?? "";
    if (previous === record.text) return;
    values.delete(resource);
    if (record.text) values.set(resource, record.text);
    state.version += 1;
    state.suppressedVersion = null;
    notify(resource);
  };

  const connect = (resource: string, state: DraftMeta): void => {
    if (!persistence || state.offPersistence) return;
    state.offPersistence = persistence.subscribe(resource, (record) => receive(resource, record));
    receive(resource, persistence.get(resource));
  };

  const evict = (keep: string): void => {
    while (values.size > capacity) {
      const oldest = values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      values.delete(oldest);
      const state = meta.get(oldest);
      if (state) {
        cancelTimer(state);
        state.offPersistence?.();
        meta.delete(oldest);
      }
      // Browser recovery follows the same advertised bound as the live store;
      // otherwise an evicted draft would immediately rehydrate and defeat it.
      persistence?.set(oldest, "");
      if (oldest !== keep) notify(oldest);
    }
  };

  const set = (resource: string | null, text: string): void => {
    if (!resource) return;
    const state = ensureMeta(resource);
    const previous = values.get(resource) ?? "";
    if (previous === text) return;

    values.delete(resource);
    if (text) values.set(resource, text);
    state.version += 1;
    state.suppressedVersion = null;
    // Persistence can be an asynchronous Host bridge. Treat every locally
    // authored empty value as a pending tombstone, not just beginSubmission():
    // the chat composer clears through set("") immediately after onSend, and
    // its Host echo may otherwise arrive after the person starts the next
    // message and erase that newer live text.
    if (!text) state.pendingTombstone = true;
    state.lastEditAt = Math.max(Date.now(), state.lastEditAt + 1);
    notify(resource);

    if (!text) persist(resource, state);
    else schedule(resource, state);
    evict(resource);
  };

  const onPageHide = (): void => {
    for (const [resource, state] of meta) {
      if (state.dirtySince !== null) persist(resource, state);
    }
  };
  if (persistence && typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);

  return {
    get: (resource) => {
      if (!resource) return "";
      ensureMeta(resource);
      return values.get(resource) ?? "";
    },
    set,
    setIfEmpty: (resource, text, options) => {
      if ((values.get(resource) ?? "") !== "") return;
      set(resource, text);
      if (options?.persist === false) {
        const state = ensureMeta(resource);
        cancelTimer(state);
        state.dirtySince = null;
        state.suppressedVersion = state.version;
      }
    },
    subscribe: (resource, listener) => {
      if (!resource) return () => {};
      const state = ensureMeta(resource);
      const setForResource = listeners.get(resource) ?? new Set<() => void>();
      setForResource.add(listener);
      listeners.set(resource, setForResource);
      connect(resource, state);
      return () => {
        setForResource.delete(listener);
        if (!setForResource.size) {
          listeners.delete(resource);
          state.offPersistence?.();
          state.offPersistence = null;
        }
      };
    },
    beginSubmission(resource) {
      const state = ensureMeta(resource);
      cancelTimer(state);
      state.dirtySince = null;
      state.suppressedVersion = state.version;
      state.pendingTombstone = true;
      state.suppressPersistenceEvent = true;
      persistence?.set(resource, "");
      state.suppressPersistenceEvent = false;
      return Object.freeze({
        resource,
        text: values.get(resource) ?? "",
        version: state.version,
      });
    },
    completeSubmission(submission) {
      const state = ensureMeta(submission.resource);
      if (state.version !== submission.version || (values.get(submission.resource) ?? "") !== submission.text) return;
      state.suppressedVersion = null;
      state.pendingTombstone = false;
      set(submission.resource, "");
    },
    restoreSubmission(submission) {
      const state = ensureMeta(submission.resource);
      if (state.version !== submission.version || (values.get(submission.resource) ?? "") !== submission.text) return;
      state.suppressedVersion = null;
      state.dirtySince = Date.now();
      persist(submission.resource, state, true);
    },
    destroy() {
      onPageHide();
      if (persistence && typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
      for (const state of meta.values()) {
        cancelTimer(state);
        state.offPersistence?.();
      }
      listeners.clear();
      meta.clear();
      values.clear();
    },
  };
}
