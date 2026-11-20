/**
 * The one-click aesthetic switch.
 *
 * A theme is a per-account preference over CSS custom properties. The server
 * places the current value in every page bootstrap; versioned `localStorage`
 * remains a best-effort cache for identities with no stored preference and for
 * temporary write failures. `classic` remains the absence of `data-theme`, so
 * the pre-theme rendering is always one explicit selection away and a broken
 * theme block still falls back to the root palette.
 *
 * Ownership: `theme-aurora.css` belongs to the Fable redesign, `theme-ink.css`
 * to the codex/gpt-5.6-sol redesign, `theme-feishu.css` and
 * `theme-deepseek.css` to the Fable product-skin batch, and `theme-apple.css`
 * to the HIG-informed global appearance batch. All are loaded
 * unconditionally (they are inert without their attribute); the ids here are
 * the contract they build to.
 *
 * ── State model, and why storage is not the source of truth ─────────────────
 *
 * The applied theme lives in a MODULE variable (`applied`), seeded from the
 * server bootstrap when present and otherwise from `localStorage`. Every local
 * choice goes through `applyTheme`;
 * current-schema storage events use the same internal transition without
 * writing the event back. Both paths:
 *
 *   1. resolves the new value against the closed `THEMES` set,
 *   2. updates the in-memory `applied` variable,
 *   3. writes the DOM attribute (or removes it for classic),
 *   4. tries to persist to the current `localStorage` schema (best effort),
 *   5. publishes to subscribers.
 *
 * Steps 3–5 are pure reads of step 2's result. So if `localStorage.setItem`
 * throws (private mode, quota exceeded, an extension replacing storage), the
 * DOM attribute, the value subscribers see, the value the iframe receives,
 * and every subsequent `currentTheme()` call still agree with each other.
 * Before this pattern, `currentTheme()` re-read storage, so a failed persist
 * meant the outer shell painted aurora while the iframe was told classic.
 *
 * ── Subscribers and cross-tab sync (ticket #45) ─────────────────────────────
 *
 * The outer shell also needs to push its theme choice down to the sandboxed
 * Agent View iframe (opaque origin, no shared DOM, no shared CSS variables).
 * That is done by having `SessionPlusPage` / `AppOpenPage` subscribe here and
 * forward changes over the Host->View MessagePort. A `storage` listener
 * installed on module load adopts current-schema writes without echoing them
 * back, so the iframe follows a theme picked in another tab. The key is
 * versioned: a tab still running an older bundle cannot fold a newly introduced
 * id to its default and write that downgrade over the newer tab's choice.
 *
 * There is deliberately no React context or global emitter object: a
 * `Set.add`/`Set.delete` covers the two production call sites (the two
 * Session Plus pages) and every test can drive them directly.
 */

import { APPEARANCE_CONTRACT, type AppearanceSpec } from "@claude-bot/web-trust/frame-protocol";
import {
  DASHBOARD_THEME_IDS,
  type DashboardThemeId,
} from "../contract.js";
import { bootstrap } from "../lib/bootstrap.js";
import { api } from "../lib/api.js";
import { observeMobileControlFont } from "./mobile-control-font.js";

/**
 * The Dashboard's local id type is closed over this build's picker choices.
 *
 * The Agent View wire deliberately keeps `theme` as a bounded string (see
 * `APPEARANCE_THEME_ID_PATTERN`), so an outer-shell-only theme added to
 * `THEMES` below does not require a coordinated bump of `web-trust`. The
 * outer shell's own closed set is `THEMES`; the View maintains its own
 * `SUPPORTED_VIEW_THEMES` in the runtime and folds anything else to classic.
 */
export type ThemeId = DashboardThemeId;

export interface ThemeChoice {
  id: ThemeId;
  label: string;
}

export {
  AGENT_VIEW_THEME_PROFILES,
  type AgentViewGeneratedToken,
  type AgentViewSchemeToken,
  type AgentViewThemeProfile,
  type AgentViewThemeToken,
} from "./theme-registry.js";

export const THEMES: readonly ThemeChoice[] = [
  { id: "classic", label: "经典" },
  { id: "aurora", label: "Aurora" },
  { id: "ink", label: "Ink" },
  { id: "feishu", label: "飞书" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "apple", label: "Apple" },
];

const STORAGE_KEY = "octopus-theme-v2";
const LEGACY_STORAGE_KEY = "octopus-theme";
const DEFAULT_THEME: ThemeId = "deepseek";
const THEME_IDS = new Set<string>(DASHBOARD_THEME_IDS);

function isKnownTheme(value: string): value is ThemeId {
  return THEME_IDS.has(value);
}

function readFromStorage(): ThemeId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    // Presence of a current-schema value is authoritative. A future bundle may
    // have written an id this bundle does not know; render the local default,
    // but do not consult or overwrite the legacy key underneath it.
    if (stored !== null) return isKnownTheme(stored) ? stored : DEFAULT_THEME;
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy && isKnownTheme(legacy)) return legacy;
  } catch {
    // Storage may be unavailable (private mode); the default is a theme too.
  }
  return DEFAULT_THEME;
}

/**
 * The in-memory truth. Seeded lazily from `localStorage` the first time
 * anyone reads it, then every subsequent read is O(1). `applyTheme` maintains
 * this variable BEFORE it touches the DOM or storage, so a storage failure
 * cannot desync the two.
 *
 * `null` = not yet seeded (in production this only holds until the first call
 * from `main.tsx`; tests read it many times before any `applyTheme`).
 */
let applied: ThemeId | null = null;

function ensureSeeded(): ThemeId {
  if (applied === null) applied = readFromStorage();
  return applied;
}

export function currentTheme(): ThemeId {
  return ensureSeeded();
}

/**
 * The View-facing snapshot of the outer shell's theme.
 *
 * Constructed from the closed `THEMES` set (via `applied`), so callers cannot
 * invent a value and no caller has to know the wire contract id. This is the
 * shape the MessagePort carries and the shape the View's defensive reader
 * validates.
 */
export function getAppearance(): AppearanceSpec {
  return { contract: APPEARANCE_CONTRACT, theme: currentTheme(),
    ...(controlFontSize > 16 ? { controlFontSize } : {}) };
}

let controlFontSize = 16;

/** Called once by the browser entry; the existing appearance subscribers also
 * carry page-zoom compensation, without reconstructing their App frame. */
export function initMobileControlFont(): () => void {
  const stop = observeMobileControlFont(window, (size) => {
    if (size === controlFontSize) return;
    controlFontSize = size;
    publish();
  });
  return () => {
    stop();
    controlFontSize = 16;
    publish();
  };
}

type ThemeListener = (appearance: AppearanceSpec) => void;

const listeners = new Set<ThemeListener>();

function publish(): void {
  const appearance = getAppearance();
  // A copy of the set so a listener that unsubscribes during dispatch does not
  // change the iteration underneath the loop.
  for (const listener of [...listeners]) {
    try {
      listener(appearance);
    } catch {
      // A subscriber that throws must not stop the others. The Host wrapper on
      // the receiving end already treats `updateAppearance` as best-effort; a
      // stale iframe (already destroyed) is the common case here.
    }
  }
}

/**
 * Subscribe to appearance changes.
 *
 * Signature is intentionally React-shaped: `subscribeTheme(listener)` returns
 * an unsubscribe function, so `useSyncExternalStore(subscribeTheme,
 * currentTheme, currentTheme)` is a legitimate one-liner and every consumer
 * (the outer shell picker, the iframe host forwarder) reads from the same
 * store. The listener is NOT called synchronously on subscription — callers
 * wanting the current value read `currentTheme()` / `getAppearance()`
 * explicitly.
 */
export function subscribeTheme(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setAppliedTheme(known: ThemeId, persist: boolean): void {
  // In-memory truth updates BEFORE the DOM and storage: everything below is a
  // pure read of this, so a persist failure never lets the outer shell paint
  // one theme while the iframe is told another.
  applied = known;
  if (known === "classic") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = known;
  if (persist) {
    try {
      window.localStorage.setItem(STORAGE_KEY, known);
    } catch {
      // Not persisting is fine; the attribute still applied for this document
      // AND the in-memory truth is set, so subscribers still see the new value.
    }
  }
  publish();
}

export function applyTheme(id: string): void {
  // Resolve first — an unknown or tampered local value must land on the safe
  // default rather than reach the DOM as an unrecognised attribute.
  setAppliedTheme(isKnownTheme(id) ? id : DEFAULT_THEME, true);
}

/**
 * Persist explicit choices in selection order.
 *
 * A quick Apple → Ink change must not leave Apple on the server because the
 * first request happened to finish last. One in-flight request plus a single
 * replaceable tail preserves user order without retrying a failed mutation.
 * The local transition happens first and is never rolled back by an unavailable
 * server; that is the localStorage fallback contract.
 */
let queuedServerTheme: ThemeId | null = null;
let serverWrite: Promise<void> | null = null;

async function flushServerTheme(): Promise<void> {
  while (queuedServerTheme !== null) {
    const theme = queuedServerTheme;
    queuedServerTheme = null;
    try {
      await api("/api/theme-preference", { method: "POST", json: { theme } });
    } catch {
      // One explicit mutation, no retry. The document and local cache already
      // agree; a later explicit choice may try the server again.
    }
  }
}

export function chooseTheme(id: string): Promise<void> {
  const known = isKnownTheme(id) ? id : DEFAULT_THEME;
  setAppliedTheme(known, true);
  if (!bootstrap.viewer.username) return Promise.resolve();
  queuedServerTheme = known;
  if (serverWrite === null) {
    serverWrite = flushServerTheme().finally(() => {
      serverWrite = null;
    });
  }
  return serverWrite;
}

/** Called before first render so the initial paint is already themed. */
export function initTheme(serverPreference?: string | null): void {
  if (typeof serverPreference === "string") {
    if (isKnownTheme(serverPreference)) {
      // The account value is authoritative and refreshes the local cache for
      // reload/offline fallback on this browser.
      setAppliedTheme(serverPreference, true);
      return;
    }
    // A newer server/bundle may know a theme this still-open bundle does not.
    // Paint a safe local default without overwriting either server or cache.
    setAppliedTheme(DEFAULT_THEME, false);
    return;
  }
  setAppliedTheme(currentTheme(), false);
}

/**
 * Cross-tab bridge: `applyTheme` in another current-version tab writes
 * `localStorage`, which fires a `storage` event here. The receiver updates its
 * DOM and subscribers WITHOUT persisting again; this prevents feedback loops.
 * Legacy-key events are ignored so an already-open older bundle cannot
 * downgrade a newly introduced theme it does not recognise.
 *
 * `window` is guarded because this module is import-time evaluated by every
 * jsdom test that touches `dashboard-web`, and one path (Node-only integration
 * tests) does not provide a `window`.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    // `null` means the other tab explicitly cleared the preference. Unknown
    // non-null ids belong to a future bundle: keep this document's current
    // appearance and, critically, do not echo a default back into storage.
    if (event.newValue === null) {
      setAppliedTheme(DEFAULT_THEME, false);
    } else if (isKnownTheme(event.newValue)) {
      setAppliedTheme(event.newValue, false);
    }
  });
}
