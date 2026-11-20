/**
 * `/login` — exchange a long-lived key for an opaque server-side session.
 *
 * POST, never a query string: a credential in a URL survives in history, in the
 * `Referer` of the next request, and in every log between here and the server.
 * The link handed out in Feishu still points at `/login`; this page is what
 * turns it into an exchange nobody writes down.
 *
 * The key is held in component state for the duration of one submit and is
 * never stored, logged, or put anywhere a later page could read it.
 */

import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { request } from "../lib/api.js";
import { UiButton, UiCard, UiForm, UiFormItem, UiPasswordInput } from "../ui-kit/primitives.js";
import { LanguagePicker } from "../app/LanguagePicker.js";
import { useMessages } from "../i18n/react.js";
import type { LoginPageProps } from "../contract.js";
import styles from "./LoginPage.module.css";

interface LoginForm {
  token: string;
}

export function LoginPage(props: LoginPageProps) {
  const { t } = useMessages();
  const { control, handleSubmit, setFocus } = useForm<LoginForm>({ defaultValues: { token: "" } });
  const [error, setError] = useState<string>(
    props.rejected ? `✖ ${props.reason ?? t("login.invalidKey")}` : "",
  );
  const [busy, setBusy] = useState(false);

  const onSubmit = handleSubmit(async ({ token }) => {
    const value = token.trim();
    if (!value) {
      setError(`✖ ${t("login.required")}`);
      setFocus("token");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await request("/login", {
        method: "POST",
        json: { token: value, next: props.next || "" },
      });
      if (res.redirected) {
        // `fetch` follows the server's 303 before returning. Its Response URL
        // does not reliably retain a fragment, so prefer the server-sanitised
        // bootstrap value and keep ticket/query/hash deep links intact.
        location.replace(props.next || res.url);
        return;
      }
      if (res.ok) {
        location.replace(props.next || "/");
        return;
      }
      setError(`✖ ${t("login.invalidKey")}`);
    } catch {
      setError(`✖ ${t("login.networkError")}`);
    } finally {
      setBusy(false);
    }
  });

  return (
    <div className={styles.wrap}>
      <UiCard className={styles.box}>
        <h1>🐙 octopus</h1>
        <LanguagePicker className={styles.languagePick} />
        <p className="muted">{t("login.intro")}</p>
        <UiForm layout="vertical" onFinish={() => void onSubmit()} requiredMark={false}>
          <UiFormItem label={t("login.key")} htmlFor="octopus-login-token">
            <Controller
              name="token"
              control={control}
              render={({ field }) => (
                <UiPasswordInput
                  id="octopus-login-token"
                  type="password"
                  placeholder={t("login.key")}
                  autoComplete="current-password"
                  autoFocus
                  {...field}
                />
              )}
            />
          </UiFormItem>
          <UiButton htmlType="submit" tone="primary" loading={busy}>
            {busy ? t("login.signingIn") : t("login.signIn")}
          </UiButton>
        </UiForm>
        {props.githubEnabled ? (
          <div className={styles.oauth}>
            <span>{t("login.or")}</span>
            <a href={`/auth/github${props.next ? `?next=${encodeURIComponent(props.next)}` : ""}`}>
              {t("login.github")}
            </a>
          </div>
        ) : null}
        <div className={styles.err} role="status" aria-live="polite">
          {error}
        </div>
      </UiCard>
    </div>
  );
}
