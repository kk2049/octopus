import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
import { api, errorText, query } from "../lib/api.js";
import { pollInterval } from "../lib/query.js";
import { UiButton } from "../ui-kit/primitives.js";
import { ErrorBox, Loading, Status, useAction } from "../ui/misc.js";
import styles from "./PermissionsPage.module.css";

type FeishuOAuthStatus =
  | { available: false; state: "unavailable" }
  | { available: true; state: "disconnected" | "connected" }
  | { available: true; state: "pending"; verificationUri: string; userCode: string; expiresAt: string }
  | { available: true; state: "failed"; error: string };

/** Personal OAuth is independent of login connections and external MCP tokens. */
export function FeishuOAuthSection({ owner }: { owner: string }) {
  useDashboardLanguage();
  const client = useQueryClient();
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [owner]);
  const [error, setError] = useState<string | null>(null);
  const [needsOpen, setNeedsOpen] = useState(false);
  const queryKey = ["feishu", "oauth", owner];
  const feishu = useQuery({
    queryKey,
    queryFn: ({ signal }) => api<FeishuOAuthStatus>(`/api/feishu/oauth/status${query({ username: owner })}`, { signal }),
    refetchInterval: (current) => current.state.data?.state === "pending" && !current.state.error
      ? pollInterval("/api/feishu/oauth/status", 2_000) : false,
    refetchIntervalInBackground: true,
  });

  const [connect, busy] = useAction(async () => {
    const current = generation.current;
    setError(null);
    setNeedsOpen(false);
    // Reserve the tab inside the click gesture, before any async work. Opening
    // it after the POST loses browser user activation on slower connections.
    let popup: Window | null = null;
    try {
      popup = window.open("about:blank", "_blank");
      if (popup) popup.opener = null;
    } catch { /* The pending card keeps a normal link when popups are blocked. */ }
    try {
      await client.cancelQueries({ queryKey });
      const out = await api<FeishuOAuthStatus>("/api/feishu/oauth/start", {
        method: "POST", json: { username: owner, force: true },
      });
      if (generation.current !== current) { popup?.close(); return; }
      client.setQueryData(queryKey, out);
      if (out.state === "pending") {
        if (popup && !popup.closed) {
          try { popup.location.replace(out.verificationUri); }
          catch { popup.close(); setNeedsOpen(true); }
        } else setNeedsOpen(true);
      } else popup?.close();
    } catch (err) {
      popup?.close();
      if (generation.current === current) setError(errorText(err));
    }
  });

  const status = feishu.data;
  return (
    <section id="feishu-authorization" className={styles.card} aria-labelledby="feishu-authorization-title">
      <h3 id="feishu-authorization-title">{uiText("飞书个人连接")}</h3>
      <p className={styles.sub}>{uiText("飞书登录身份绑定不代表已授权访问个人日历和文档。")}</p>
      {busy ? <Status>{uiText("正在发起飞书授权…")}</Status> : null}
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {feishu.isError ? <ErrorBox>
        {uiText("飞书连接状态加载失败：")}{errorText(feishu.error)}
        <UiButton loading={feishu.isFetching} onClick={() => { void feishu.refetch(); }}>{uiText("检查授权状态")}</UiButton>
      </ErrorBox> : null}
      {feishu.isPending ? <Loading /> : !status ? null : !status.available ? (
        <p className={styles.offline}>{uiText("当前部署尚未启用飞书个人授权，请联系管理员配置后再连接。")}</p>
      ) : status.state === "pending" ? (
        <div style={{ display: "grid", gap: 8 }}>
          <Status>{uiText("请在飞书授权页确认授权，完成后此处会自动更新。")}</Status>
          {needsOpen ? <Status>{uiText("浏览器未能自动打开授权页，请点击下方链接继续。")}</Status> : null}
          <span>{uiText("授权码：")}<code>{status.userCode}</code></span>
          <div className={styles.rowacts}>
            <a href={status.verificationUri} target="_blank" rel="noopener noreferrer">{uiText("打开飞书授权页")}</a>
            {!feishu.isError ? <UiButton loading={feishu.isFetching} onClick={() => { void feishu.refetch(); }}>{uiText("检查授权状态")}</UiButton> : null}
          </div>
        </div>
      ) : (
        <div className={styles.rowacts}>
          {!busy && !feishu.isError ? <Status kind={status.state === "connected" ? "ok" : status.state === "failed" ? "err" : "muted"}>
            {status.state === "connected" ? uiText("● 已连接") : status.state === "failed"
              ? uiText("○ 连接失败：{v0}", { v0: status.error }) : uiText("○ 尚未连接")}
          </Status> : null}
          <UiButton tone="primary" loading={busy} onClick={() => { void connect(); }}>
            {status.state === "connected" ? uiText("重新授权") : uiText("连接飞书")}
          </UiButton>
        </div>
      )}
    </section>
  );
}
