import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMessages } from "../i18n/react.js";
import type { MessageKey } from "../i18n/messages.js";
import { uiText } from "../i18n/ui-text.js";
import { pollInterval } from "../lib/query.js";
import { request } from "../lib/api.js";
import { bootstrap } from "../lib/bootstrap.js";
import { BUILD_ID_HEADER } from "../contract.js";
import { activeDeployment, DEPLOY_DISMISSED_KEY, DEPLOY_OBSERVED_KEY, DEPLOY_REQUEST_EVENT, freshDeployment, recalledDeployment, rememberDeployment, type EdgeDeployment } from "../lib/deployment-status.js";
import { UiButton } from "../ui-kit/primitives.js";
import { Spinner, useNow } from "../ui/misc.js";
import styles from "./DeployBanner.module.css";
import { DeployOrigin } from "./DeployOrigin.js";
import type { DeploymentOrigin } from "../contract.js";

const labels: Record<string, MessageKey> = {
  requested: "deploy.status.requested", claimed: "deploy.status.claimed", building: "deploy.status.building",
  restarting: "deploy.status.restarting", health_gate: "deploy.status.health_gate", confirm_wait: "deploy.status.confirm_wait",
  succeeded: "deploy.status.succeeded", rolled_back: "deploy.status.rolled_back", failed: "deploy.status.failed",
};

export function DeployProgressBanner({ origin }: { origin?: DeploymentOrigin | null }) {
  const { t } = useMessages();
  const now = useNow(true);
  const [requested, setRequested] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(() => recalledDeployment(DEPLOY_DISMISSED_KEY));
  const [observed, setObserved] = useState(() => recalledDeployment(DEPLOY_OBSERVED_KEY));
  const { data, refetch } = useQuery({
    queryKey: ["edge-deployment"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/__octopus/deploy", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), credentials: "omit", cache: "no-store", redirect: "error",
      });
      if (!response.ok) throw new Error("deployment status unavailable");
      return await response.json() as EdgeDeployment;
    },
    refetchInterval: pollInterval("/__octopus/deploy", 2000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const fresh = freshDeployment(data, now);
  const active = Boolean(data && activeDeployment(data.status));
  // A React remount is not a document refresh. A document opened during the
  // build may still hold the old bundle, so also check the serving process.
  const refreshedSuccess = Boolean(fresh && data?.status === "succeeded" && data.id && data.id > dismissed
    && data.created_at && performance.timeOrigin >= Date.parse(data.created_at));
  const { data: currentDocument } = useQuery({
    queryKey: ["deploy", "loaded-document", data?.id, bootstrap.buildId],
    enabled: refreshedSuccess,
    queryFn: async ({ signal }) => {
      const response = await request("/api/deploy/active", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      });
      if (!response.ok) throw new Error("deployment refresh could not be verified");
      const active = await response.json() as { intent_id?: number | null };
      return active.intent_id === null && response.headers.get(BUILD_ID_HEADER) === bootstrap.buildId;
    },
    refetchInterval: (query) => refreshedSuccess && query.state.status === "error" ? pollInterval("/api/deploy/active", 2000) : false,
  });
  useEffect(() => {
    if (refreshedSuccess && currentDocument && data?.id) {
      setDismissed(data.id);
      rememberDeployment(DEPLOY_DISMISSED_KEY, data.id);
    }
  }, [refreshedSuccess, currentDocument, data?.id]);
  useEffect(() => {
    const listener = (event: Event) => {
      const id = (event as CustomEvent<number | null>).detail;
      setRequested(id);
      if (id) setObserved(id);
      void refetch();
    };
    addEventListener(DEPLOY_REQUEST_EVENT, listener);
    return () => removeEventListener(DEPLOY_REQUEST_EVENT, listener);
  }, [refetch]);
  useEffect(() => {
    if (fresh && data?.id && active) {
      setObserved(data.id);
      rememberDeployment(DEPLOY_OBSERVED_KEY, data.id);
    }
    if (fresh && data?.id && requested !== null && requested !== 0 && data.id >= requested) setRequested(null);
  }, [data, fresh, active, requested]);
  const visible = requested !== null || (data?.id && data.id > dismissed && (active || data.id === observed || ["failed", "rolled_back"].includes(data.status)));
  if (!visible) return null;
  const waiting = requested !== null && (!data?.id || requested === 0 || data.id < requested);
  const terminal = fresh && !waiting && data && ["succeeded", "failed", "rolled_back"].includes(data.status);
  const label = waiting ? t("deploy.triggering") : !fresh ? uiText("连接中，正在核对部署状态")
    : data?.status === "rolling_back" ? uiText("新版本启动失败，正在恢复上一版本")
    : labels[data?.status ?? ""] ? t(labels[data!.status]!) : uiText("连接中，正在核对部署状态");
  const seconds = data?.created_at ? Math.max(0, Math.floor((now - Date.parse(data.created_at)) / 1000)) : 0;
  // A running document never becomes a restart page, even during an outage.
  // Only an unsuccessful document navigation can reach the edge loading page.
  return <div className={styles.banner} role="status" aria-live="polite" data-testid="deployment-progress">
    {!terminal ? <Spinner /> : null}
    <strong>{label}</strong>
    {!waiting && data?.id ? <span>D{data.id} · {Number.isFinite(seconds) ? seconds : 0}s</span> : null}
    {!waiting && origin && origin.intent_id === data?.id ? <DeployOrigin origin={origin} /> : null}
    {terminal && data.status !== "succeeded" ? <span>{uiText("本次升级未完成。请在工单页查看原因和实际版本。")}</span> : null}
    {terminal ? <>
      <UiButton onClick={() => location.reload()}>{uiText("刷新页面")}</UiButton>
      {data.status !== "succeeded" ? <UiButton onClick={() => { setDismissed(data.id!); rememberDeployment(DEPLOY_DISMISSED_KEY, data.id!); }}>{uiText("知道了")}</UiButton> : null}
    </> : <span>{uiText("后端更新中，你可以继续编辑；页面不会自动刷新。")}</span>}
  </div>;
}
