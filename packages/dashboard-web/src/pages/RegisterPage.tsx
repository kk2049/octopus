import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import type { RegisterPageProps } from "../contract.js";
import { request } from "../lib/api.js";
import { UiButton, UiCard, UiForm, UiFormItem, UiInput } from "../ui-kit/primitives.js";
import { LanguagePicker } from "../app/LanguagePicker.js";
import { useMessages } from "../i18n/react.js";
import styles from "./LoginPage.module.css";

interface RegisterForm {
  username: string;
}

export function RegisterPage(props: RegisterPageProps) {
  const { t } = useMessages();
  const { control, handleSubmit, setFocus } = useForm<RegisterForm>({ defaultValues: { username: "" } });
  const [error, setError] = useState(props.error ? `✖ ${props.error}` : "");
  const [busy, setBusy] = useState(false);

  const onSubmit = handleSubmit(async ({ username }) => {
    const value = username.trim();
    if (!value) {
      setError(`✖ ${t("register.required")}`);
      setFocus("username");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await request("/auth/register", { method: "POST", json: { username: value } });
      if (res.redirected) {
        location.replace(res.url);
        return;
      }
      if (res.ok) {
        location.replace("/");
        return;
      }
      const body = await res.json().catch(() => ({})) as { error?: unknown };
      setError(`✖ ${typeof body.error === "string" ? body.error : t("register.failed")}`);
    } catch {
      setError(`✖ ${t("register.networkError")}`);
    } finally {
      setBusy(false);
    }
  });

  return (
    <div className={styles.wrap}>
      <UiCard className={styles.box}>
        <h1>{t("register.title")}</h1>
        <LanguagePicker className={styles.languagePick} />
        <p className="muted">
          {t("register.verifiedPrefix")}<strong>{props.label}</strong>{t("register.verifiedSuffix")}
        </p>
        <UiForm layout="vertical" onFinish={() => void onSubmit()} requiredMark={false}>
          <UiFormItem label={t("register.username")} htmlFor="octopus-register-username">
            <Controller
              name="username"
              control={control}
              render={({ field }) => (
                <UiInput
                  id="octopus-register-username"
                  autoComplete="username"
                  autoFocus
                  maxLength={32}
                  placeholder={t("register.example")}
                  {...field}
                />
              )}
            />
          </UiFormItem>
          <p className="muted">{t("register.rules")}</p>
          <UiButton htmlType="submit" tone="primary" loading={busy}>
            {busy ? t("register.creating") : t("register.create")}
          </UiButton>
        </UiForm>
        <div className={styles.err} role="status" aria-live="polite">
          {error}
        </div>
      </UiCard>
    </div>
  );
}
