import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
/**
 * `/launcher` — the ordinary user's App launcher.
 *
 * `/apps` is the OPERATOR's registry (digests, releases, activation) and stays
 * `Administer`; this page answers the person's question — "what can I open" —
 * from availability metadata only. Opening still crosses `page.appOpen` and
 * the publisher-trust door; a card here is a navigation hint, never authority.
 */

import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { UiAlert } from "../ui-kit/primitives.js";
import styles from "./LauncherPage.module.css";

interface LauncherApp {
  app: string;
  title: string;
  publisher: string;
  available: boolean;
}

export function LauncherPage() {
  useDashboardLanguage();
  const [apps, setApps] = useState<LauncherApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ apps: LauncherApp[] }>("/api/apps/launcher")
      .then((data) => setApps(data.apps))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div className={styles.wrap}>
      <h2>{uiText("🎲 应用")}</h2>
      <p className={styles.lead}>{uiText("已发布且可打开的应用。")}</p>
      {error ? <UiAlert tone="warning" title={uiText("加载失败")}>{error}</UiAlert> : null}
      {apps && apps.length === 0 ? <p className={styles.empty}>{uiText("还没有已激活的应用。")}</p> : null}
      <div className={styles.grid}>
        {(apps ?? []).map((entry) => (
          <a
            key={entry.app}
            className={styles.card}
            href={entry.available ? `/apps/${encodeURIComponent(entry.app)}/open` : undefined}
            aria-disabled={!entry.available}
          >
            <div className={styles.title}>{entry.title}</div>
            <div className={styles.meta}>{entry.publisher}</div>
            <div className={styles.state}>{entry.available ? uiText("打开 →") : uiText("暂无可用 release")}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
