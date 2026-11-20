import { applyLanguage, DASHBOARD_LANGUAGES } from "../i18n/language.js";
import { useMessages } from "../i18n/react.js";

export function LanguagePicker({ className }: { className?: string }) {
  const { language, t } = useMessages();
  return (
    <select
      aria-label={t("language.label")}
      className={className}
      value={language}
      onChange={(event) => applyLanguage(event.target.value)}
    >
      {DASHBOARD_LANGUAGES.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}
