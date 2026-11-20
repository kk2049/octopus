import type { DeploymentOrigin } from "../contract.js";
import { uiText } from "../i18n/ui-text.js";
import styles from "./DeployBanner.module.css";

export function DeployOrigin({ origin }: { origin: DeploymentOrigin }) {
  const actor = origin.actor === "admin" ? uiText("管理密钥（未记录个人账号）") : origin.actor;
  return <span className={styles.origin}>
    {uiText("发起人：{v0}", { v0: actor })} · {origin.kind === "web" ? uiText("网页手动更新")
      : origin.kind === "ticket_agent" ? <>
        {uiText("工单 Agent 执行更新（调用方提供）")} · <span>{`#${origin.ticket_id} ${origin.ticket_title ?? ""}`}</span>
        {origin.agent ? ` · ${origin.agent}` : ""}
      </> : origin.kind === "cli_agent" ? <>
        {uiText("CLI Agent（调用方提供）")} · {origin.agent}
        {origin.device ? ` · ${origin.device}` : ""}{origin.session ? ` · ${origin.session}` : ""}
      </> : origin.kind === "cli_api" ? uiText("CLI / API（未提供 Agent 信息）") : uiText("历史记录未注明更新路径")}
  </span>;
}
