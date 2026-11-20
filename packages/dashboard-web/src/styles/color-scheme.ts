/** Browser-local appearance preference. DOM changes precede subscriber updates;
 * switching never reloads or reconstructs the mounted App or its resources. */
export type ColorScheme = "light" | "dark";
export type ColorSchemePreference = ColorScheme | "system";
const STORAGE_KEY = "octopus-color-scheme-v1";
let preference: ColorSchemePreference | undefined;
const listeners = new Set<() => void>();

function readPreference(): ColorSchemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch { /* Browser storage is optional. */ }
  return "system";
}

export function currentColorSchemePreference(): ColorSchemePreference {
  return preference ??= readPreference();
}

export function currentColorScheme(): ColorScheme {
  const chosen = currentColorSchemePreference();
  if (chosen !== "system") return chosen;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark" : "light";
}

export function subscribeColorScheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(): void {
  document.documentElement.dataset.colorScheme = currentColorScheme();
  for (const listener of [...listeners]) listener();
}

export function chooseColorScheme(chosen: ColorSchemePreference): void {
  preference = chosen;
  try {
    if (chosen === "system") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, chosen);
  } catch { /* The in-memory choice remains authoritative for this document. */ }
  publish();
}

/** Run before React mounts, alongside theme initialization. */
export function initColorScheme(): () => void {
  preference = readPreference();
  publish();
  const query = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    if (currentColorSchemePreference() === "system") publish();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    if (event.newValue !== null && event.newValue !== "light" && event.newValue !== "dark") return;
    preference = event.newValue ?? "system";
    publish();
  };
  query?.addEventListener("change", onSystemChange);
  window.addEventListener("storage", onStorage);
  return () => {
    query?.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorage);
  };
}
