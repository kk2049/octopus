/**
 * The reader's browser-local Dashboard language choice.
 *
 * Language is presentation state, not identity or authorization. The choice is
 * therefore applied immediately in this document and cached in versioned
 * `localStorage`, with a storage-event bridge so open tabs stay in agreement.
 * A missing or damaged value preserves the product's existing Simplified
 * Chinese default.
 */

export const DASHBOARD_LANGUAGES = [
  { id: "zh-CN", label: "简体中文（大陆）" },
  { id: "zh-TW", label: "繁體中文（臺灣）" },
  { id: "nan-TW", label: "閩南語（臺灣）" },
  { id: "en", label: "English" },
  { id: "ja-JP", label: "日本語" },
] as const;

export type DashboardLanguageId = (typeof DASHBOARD_LANGUAGES)[number]["id"];

const STORAGE_KEY = "octopus-language-v1";
const DEFAULT_LANGUAGE: DashboardLanguageId = "zh-CN";
const LANGUAGE_IDS = new Set<string>(DASHBOARD_LANGUAGES.map(({ id }) => id));

function isKnownLanguage(value: string): value is DashboardLanguageId {
  return LANGUAGE_IDS.has(value);
}

function readFromStorage(): DashboardLanguageId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null && isKnownLanguage(stored)) return stored;
  } catch {
    // Private browsing, quota policy and extensions may make storage fail.
  }
  return DEFAULT_LANGUAGE;
}

let applied: DashboardLanguageId | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One stale subscriber must not prevent the other mounted roots updating.
    }
  }
}

function setAppliedLanguage(language: DashboardLanguageId, persist: boolean): void {
  applied = language;
  document.documentElement.lang = language;
  if (persist) {
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // The document and in-memory snapshot still agree when storage is absent.
    }
  }
  publish();
}

export function currentLanguage(): DashboardLanguageId {
  if (applied === null) applied = readFromStorage();
  return applied;
}

export function applyLanguage(value: string): void {
  setAppliedLanguage(isKnownLanguage(value) ? value : DEFAULT_LANGUAGE, true);
}

/** Called before the first React render so Ant and the document agree. */
export function initLanguage(): void {
  setAppliedLanguage(readFromStorage(), false);
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    if (event.newValue === null) {
      setAppliedLanguage(DEFAULT_LANGUAGE, false);
    } else if (isKnownLanguage(event.newValue)) {
      // Adopt the event payload without echoing it back into storage.
      setAppliedLanguage(event.newValue, false);
    }
  });
}
