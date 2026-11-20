import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
import { UiButton } from "../ui-kit/primitives.js";
import { DeployProgressBanner } from "./DeployProgressBanner.js";
/**
 * The site-wide dead-man banner.
 *
 * While a deploy sits in `confirm_wait`, EVERY page shows the confirm/rollback
 * bar: a web click proves the public ingress is alive (the Feishu card proves
 * the WS side), and any logged-in user's click counts. If nobody clicks, the
 * supervisor rolls back on its own — so this bar is the thing standing between
 * a bad deploy and an automatic revert, and it must not be the thing that
 * failed to render.
 *
 * Two behaviours are deliberate:
 *  · the decision is single-flight — the confirm endpoint is not idempotent;
 *  · an empty response body becomes words. The bot may be mid-restart exactly
 *    when this button matters, and "Unexpected end of JSON input" is not
 *    something anyone can act on.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorText } from "../lib/api.js";
import { pollInterval } from "../lib/query.js";
import { useAction } from "../ui/misc.js";
import styles from "./DeployBanner.module.css";
import type { DeploymentOrigin } from "../contract.js";
import { DeployOrigin } from "./DeployOrigin.js";

interface ActiveDeploy {
  origin?: DeploymentOrigin | null;
  intent_id?: number;
  confirm_wait?: boolean;
  deadline?: string;
}

const ACTIVE_PATH = "/api/deploy/active";

export function DeployBanner() {
  useDashboardLanguage();
  const client = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["deploy", "active"],
    queryFn: () => api<ActiveDeploy>(ACTIVE_PATH),
    refetchInterval: pollInterval(ACTIVE_PATH, 10_000),
    refetchIntervalInBackground: false,
  });

  const [decide, busy] = useAction(async (decision: "alive" | "rollback") => {
    if (data?.intent_id == null) return;
    setFailure(null);
    try {
      await api("/api/deploy/confirm", {
        method: "POST",
        json: { intent_id: data.intent_id, decision },
      });
    } catch (err) {
      setFailure(errorText(err));
    }
    await client.invalidateQueries({ queryKey: ["deploy"] });
  });

  if (!data?.confirm_wait) return <DeployProgressBanner origin={data?.origin} />;
  return (
    <div className={styles.banner} role="alert">
      <span>
        {uiText("🫀 部署批次 D")}{data.intent_id} {uiText(" 新版本已启动，请确认可以正常使用")}{data.deadline ? uiText("(超时自动回滚,截止 {v0} UTC)", { v0: data.deadline.slice(11, 19) }) : "…"}
      </span>
      {data.origin && data.origin.intent_id === data.intent_id ? <DeployOrigin origin={data.origin} /> : null}
      <UiButton className="primary" disabled={busy} onClick={() => void decide("alive")}>
        {uiText("✅ 系统存活确认")}</UiButton>
      <UiButton
        className={styles.rollback}
        disabled={busy}
        onClick={() => void decide("rollback")}
      >
        {uiText("⛔ 立即回滚")}</UiButton>
      {failure ? <span className={styles.failure}>{failure}</span> : null}
    </div>
  );
}
