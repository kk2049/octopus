import { useCallback, useSyncExternalStore } from "react";
import {
  currentLanguage,
  subscribeLanguage,
  type DashboardLanguageId,
} from "./language.js";
import { message, type MessageKey, type MessageValues } from "./messages.js";

export function useDashboardLanguage(): DashboardLanguageId {
  return useSyncExternalStore(subscribeLanguage, currentLanguage, currentLanguage);
}

export function useMessages(): {
  language: DashboardLanguageId;
  t: (key: MessageKey, values?: MessageValues) => string;
} {
  const language = useDashboardLanguage();
  const t = useCallback(
    (key: MessageKey, values?: MessageValues) => message(language, key, values),
    [language],
  );
  return { language, t };
}
