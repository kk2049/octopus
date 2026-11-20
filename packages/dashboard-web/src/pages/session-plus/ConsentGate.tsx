import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText, uiMessage, uiValue, type UiTextValue } from "../../i18n/ui-text.js";
import { useState } from "react";
import type { SessionPlusConsentProps } from "../../contract.js";
import { api, errorText } from "../../lib/api.js";
import { UiButton, UiRadio } from "../../ui-kit/primitives.js";
import styles from "../SessionPlusPage.module.css";

/** Publisher trust is an independent screen and must run before an App iframe exists. */
export function ConsentGate(props: SessionPlusConsentProps) {
  useDashboardLanguage();
  const [policy, setPolicy] = useState<"exact" | "publisher">("exact");
  const [message, setMessage] = useState<UiTextValue>("");
  const [busy, setBusy] = useState(false);
  const id = props.identity;
  const release = props.release as {
    disclosures?: Array<{ id: string; title: string; operations: string[] }>;
    sourceSnapshot?: { digest?: string };
    recipeDigest?: string;
  };
  const why =
    {
      never_decided: uiText("这是你第一次运行这个发布者提供的应用代码。"),
      revoked: uiText("你之前撤销了对这个发布者的信任。"),
      profile_changed: uiText("应用的执行模式发生了变化，需要重新确认。"),
      release_changed: uiText("你只信任了上一个精确 release；当前运行字节已经变化。"),
    }[props.reason] ?? props.reason;

  return (
    <main className={styles.trustwrap}>
      <section className={styles.trustcard}>
        <div className={styles.eyebrow}>{uiText("第一道门 · 发布者信任")}</div>
        <h2>{uiText("是否运行「会话+」并向它披露数据？")}</h2>
        <p className={styles.lead}>
          {why} {uiText(" 本步骤只决定加载发布者代码；会话能力另行授权。")}</p>
        <dl>
          <dt>{uiText("应用")}</dt>
          <dd>
            {uiText("会话+ · ")}<code>{id.stableAppId}</code>
          </dd>
          <dt>{uiText("发布者")}</dt>
          <dd>
            <b>{id.publisher}</b> {uiText(" · 第一方")}</dd>
          <dt>{uiText("执行模式")}</dt>
          <dd>
            {uiText("运行发布者提供的应用代码；使用当前账户已授权的数据与能力。")}</dd>
          <dt>{uiText("包")}</dt>
          <dd>
            <code>{id.packageDigest}</code>
          </dd>
          <dt>{uiText("源码快照")}</dt>
          <dd>
            <code>{release.sourceSnapshot?.digest ?? ""}</code>
          </dd>
          <dt>{uiText("构建配方")}</dt>
          <dd>
            <code>{release.recipeDigest ?? ""}</code>
          </dd>
        </dl>
        <p>
          <a href="/api/session-plus/release" target="_blank" rel="noopener noreferrer">
            {uiText("查看平台托管的 ReleaseRecord 与逐文件源码快照 ↗")}</a>
        </p>
      </section>
      <section className={styles.trustcard}>
        <h3>{uiText("运行后会投影给这个 package 的数据类别")}</h3>
        <ul className={styles.disclosures}>
          {(release.disclosures ?? []).map((entry) => (
            <li key={entry.id}>
              <b>{entry.title}</b>
              <br />
              <code>{entry.id}</code> · {entry.operations.join("、")}
            </li>
          ))}
        </ul>
        <p className={styles.warning}>{uiText("撤销只影响未来投影，无法收回已披露数据。")}</p>
      </section>
      <section className={`${styles.trustcard} ${styles.choices}`}>
        <UiRadio
          name="policy"
          value="exact"
          checked={policy === "exact"}
          onChange={() => setPolicy("exact")}
        >
          <span>
            <b>{uiText("只信任这个精确 release")}</b>
            <small>{uiText("package digest 变化时再次询问。")}</small>
          </span>
        </UiRadio>
        <UiRadio
          name="policy"
          value="publisher"
          checked={policy === "publisher"}
          onChange={() => setPolicy("publisher")}
        >
          <span>
            <b>{uiText("信任该发布者的后续更新")}</b>
            <small>{uiText("同一发布者和执行模式的更新继续运行；扩权仍会单独询问。")}</small>
          </span>
        </UiRadio>
        <div className={styles.actions}>
          <UiButton
            id="trustApp"
            data-testid="trust-app"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setMessage(uiMessage("正在记录你的决定…"));
              void api("/api/session-plus/trust", {
                method: "POST",
                json: { decision: "trust", follow_updates: policy === "publisher" },
              }).then(
                () => location.reload(),
                (err) => {
                  setBusy(false);
                  setMessage(errorText(err) || uiMessage("记录失败"));
                },
              );
            }}
          >
            {uiText("信任并继续")}</UiButton>
          <a href="/">{uiText("暂不运行，返回首页")}</a>
        </div>
        <p className={styles.trustMessage} role="status">
          {uiValue(message)}
        </p>
      </section>
    </main>
  );
}
