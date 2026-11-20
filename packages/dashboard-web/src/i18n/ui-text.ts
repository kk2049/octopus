import { currentLanguage, type DashboardLanguageId } from "./language.js";
import { interpolateMessage, type MessageValues } from "./messages.js";
import { UI_COPY } from "./ui-copy.js";

export type UiTextKey = keyof typeof UI_COPY;

export interface UiMessage {
  readonly key: UiTextKey;
  readonly values: Readonly<Record<string, string | number | UiMessage>>;
}
export type UiTextValue = string | UiMessage;

/** Keep authored notices in state as messages, so a later language switch updates them. */
export function uiMessage(key: UiTextKey, values: UiMessage["values"] = {}): UiMessage {
  return { key, values };
}

export function uiValue(value: UiTextValue | null | undefined, language = currentLanguage()): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return uiText(value.key, Object.fromEntries(Object.entries(value.values).map(([key, item]) => [
    key, typeof item === "object" ? uiValue(item, language) : item,
  ])), language);
}

/** Static label tables are cached separately for each of the five supported languages. */
export function localizedLabels<T>(build: () => T): () => T {
  const cache = new Map<DashboardLanguageId, T>();
  return () => {
    const language = currentLanguage();
    if (!cache.has(language)) cache.set(language, build());
    return cache.get(language)!;
  };
}

/** The catalog read by string, so a lookup does not build a union of every tuple. */
const TRANSLATIONS: Readonly<Record<string, readonly string[]>> = UI_COPY;
const reportedMissing = new Set<string>();

/**
 * Explicit, source-keyed UI copy. Only authored literals belong here; names,
 * messages, commands, documents and tool results are interpolation values.
 * Read the current language at use time so module-level helpers and event
 * handlers agree with the components subscribing through useDashboardLanguage.
 *
 * A key missing from the table (a shared component handed `uiText` as a plain
 * `(text: string) => string` callback escapes the key type) shows its source
 * text and warns once. Rendering must not throw: a throw here unmounts the
 * page. `i18n/ui-copy-usage.test.ts` is what keeps the table complete.
 */
export function uiText(
  key: UiTextKey,
  values: MessageValues = {},
  language: DashboardLanguageId = currentLanguage(),
): string {
  if (language === "zh-CN") return interpolateMessage(key, values);
  const copy = Object.prototype.hasOwnProperty.call(UI_COPY, key) ? TRANSLATIONS[key] : undefined;
  const template = language === "en" ? copy?.[0]
    : language === "ja-JP" ? copy?.[1]
    : copy?.[2]; // Min Nan retains the existing Traditional Chinese fallback.
  if (template === undefined) {
    if (!reportedMissing.has(key)) {
      reportedMissing.add(key);
      console.warn(`[i18n] UI copy has no ${language} text for ${JSON.stringify(key)}; showing the source text.`);
    }
    return interpolateMessage(key, values);
  }
  return interpolateMessage(template, values);
}
