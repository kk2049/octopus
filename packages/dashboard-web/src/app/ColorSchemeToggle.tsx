import { useSyncExternalStore } from "react";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
import { UiButton } from "../ui-kit/primitives.js";
import {
  chooseColorScheme, currentColorScheme, currentColorSchemePreference, subscribeColorScheme,
} from "../styles/color-scheme.js";

export function ColorSchemeToggle() {
  useDashboardLanguage();
  const scheme = useSyncExternalStore(subscribeColorScheme, currentColorScheme, currentColorScheme);
  const preference = useSyncExternalStore(subscribeColorScheme, currentColorSchemePreference, currentColorSchemePreference);
  return (
    <>
      <UiButton onClick={() => chooseColorScheme(scheme === "dark" ? "light" : "dark")}>
        {scheme === "dark" ? uiText("切换到浅色模式") : uiText("切换到深色模式")}
      </UiButton>
      {preference !== "system" ? (
        <UiButton onClick={() => chooseColorScheme("system")}>{uiText("跟随系统外观")}</UiButton>
      ) : null}
    </>
  );
}
