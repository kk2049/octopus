import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AppAgentActivity as Activity } from "../contract.js";
import { api, errorText } from "../lib/api.js";
import { pollInterval } from "../lib/query.js";
import { appInstanceHandle } from "../lib/bootstrap.js";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, localizedLabels } from "../i18n/ui-text.js";
import { UiButton } from "../ui-kit/primitives.js";
import styles from "./AppAgentActivity.module.css";

const labels = localizedLabels((): Record<Activity["state"], string> => ({
  running: uiText("正在执行"), reconnecting: uiText("重新连接中"),
  waiting_resource: uiText("等待运行环境"), waiting_approval: uiText("等待批准"),
  ended: uiText("本轮已结束"), failed: uiText("执行中断"), unknown: uiText("结果未知"), stopped: uiText("已停止"),
}));

/** Trusted host chrome. The App receives no handle, transcript or controls. */
export function AppAgentActivity({ appId, enabled = true }: { appId: string; enabled?: boolean }) {
  useDashboardLanguage();
  const instance = appInstanceHandle();
  const base = appId === "session-plus" ? "/api/session-plus" : "/api/app-view";
  const endpoint = `${base}/agent-activity?app=${encodeURIComponent(appId)}`;
  const headers = { [appId === "session-plus" ? "x-session-plus-instance" : "x-app-instance"]: instance ?? "" };
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const generation = useRef(0);
  const stopping = useRef(false);
  useEffect(() => {
    generation.current++; stopping.current = false; setPending(null); setFailure("");
    return () => { generation.current++; };
  }, [appId, instance, enabled]);
  const activity = useQuery<{ activity: Activity[] }>({
    queryKey: ["app-agent-activity", appId, instance],
    queryFn: ({ signal }) => api(endpoint, { headers, signal }),
    enabled: enabled && Boolean(instance),
    refetchInterval: enabled ? pollInterval(endpoint, 3_000) : false,
  });
  async function stop(id: string) {
    if (stopping.current || !enabled || !instance) return;
    const current = generation.current; stopping.current = true;
    setPending(id); setFailure("");
    try {
      await api(`${base}/agent-stop?app=${encodeURIComponent(appId)}`, { method: "POST", headers, json: { turnId: id } });
      if (current === generation.current) await activity.refetch();
    } catch (error) { if (current === generation.current) setFailure(errorText(error)); }
    finally { if (current === generation.current) { stopping.current = false; setPending(null); } }
  }
  if (!enabled || !instance) return null;
  // A denied/refused read immediately hides cached private replies.
  if (activity.error) return <div className={styles.activity} role="status">{uiText("暂时无法读取任务状态")}</div>;
  if (!activity.data?.activity.length) return null;
  return <section className={styles.activity} aria-label={uiText("应用任务")}>
    <div role="status" aria-live="polite">
      {activity.data.activity.filter(row => row.canStop).map(row => <span key={row.id}>{row.agent} · {labels()[row.state]} </span>)}
    </div>
    <details>
      <summary>{uiText("应用任务")} · {labels()[activity.data.activity[0]!.state]}</summary>
      {activity.data.activity.map(row => <article key={row.id}>
        <strong>{row.agent} · {labels()[row.state]}</strong>
        {row.state === "waiting_resource" ? <p>{uiText("已等待一分钟；保持监听，连接恢复后自动继续。")}</p> : null}
        {row.state === "unknown" ? <p>{uiText("不会自动重试。请先查看会话记录，需要时再发一条消息继续。")}</p> : null}
        {row.canStop ? <UiButton disabled={pending !== null} onClick={() => void stop(row.id)}>{pending === row.id ? uiText("正在停止…") : uiText("停止此任务")}</UiButton> : null}
        {row.reply ? <p className={styles.reply}>{row.reply}</p> : null}
      </article>)}
    </details>
    {failure ? <p role="alert">{failure}</p> : null}
  </section>;
}
