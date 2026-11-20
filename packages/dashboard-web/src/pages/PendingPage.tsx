import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
/**
 * `/pending` — a compatibility landing for old links.
 *
 * The trusted confirmation surface lives in the shell: every page gets the same
 * owner-scoped pill and drawer, so a person never has to leave the session or
 * ticket they are on. This route stays guarded and points a real browser
 * session at that drawer; a bearer credential gets the explanation instead,
 * because a bearer is deliberately not evidence that a person is present.
 */

import { useEffect } from "react";
import { bootstrap } from "../lib/bootstrap.js";
import { UiAlert, UiButton } from "../ui-kit/primitives.js";
import type { PendingPageProps } from "../contract.js";
import styles from "./PendingPage.module.css";

export function PendingPage() {
  useDashboardLanguage();
  const props = bootstrap.pageProps as PendingPageProps;
  // The shell opens its drawer on this hash, which is also how an operation
  // chip inside a conversation says "在顶部批准 →".
  useEffect(() => {
    if (props.hasSession && location.hash !== "#approvals") location.hash = "approvals";
  }, [props.hasSession]);

  return (
    <div className={styles.wrap}>
      <h2>{uiText("待批准（兼容入口）")}</h2>
      <p className={styles.lead}>{uiText("请在页面顶部的“批准”中处理；此地址仅兼容旧书签。")}</p>
      {props.hasSession ? (
        <p>
          <UiButton
            tone="primary"
            onClick={() => {
              location.hash = "approvals";
              // Re-assigning the same hash fires no event, so nudge it.
              window.dispatchEvent(new HashChangeEvent("hashchange"));
            }}
          >
            {uiText("打开顶部批准")}</UiButton>
        </p>
      ) : (
        <UiAlert tone="warning" className={styles.warn} title={uiText("需要浏览器登录")}>
          {uiText("请先 ")}<a href="/login">{uiText("登录")}</a>{uiText("，再处理待批准调用。")}</UiAlert>
      )}
    </div>
  );
}
