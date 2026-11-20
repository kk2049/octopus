import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText, query } from "../lib/api.js";
import { formatStamp } from "../lib/format.js";
import { Confirm } from "../ui/Dialog.js";
import { ErrorBox, Loading } from "../ui/misc.js";
import { UiButton, UiCard, UiTag } from "../ui-kit/primitives.js";
import styles from "./PermissionsPage.module.css";

interface ConnectionRow {
  /** Process-salted selector; never rendered and never an external identity id. */
  connection_id: string;
  provider: string;
  label: string | null;
  created_at: string | null;
}
interface ConnectionsResponse {
  github_available: boolean;
  connections: ConnectionRow[];
}

export function GithubConnectionsSection({
  owner,
  canEdit,
  onMessage,
}: {
  owner: string;
  canEdit: boolean;
  onMessage: (kind: "ok" | "err", text: string) => void;
}) {
  useDashboardLanguage();
  const client = useQueryClient();
  const [pendingRemoval, setPendingRemoval] = useState<ConnectionRow | null>(null);
  const connections = useQuery({
    queryKey: ["permissions", "connections", owner],
    queryFn: () => api<ConnectionsResponse>(`/api/connections${query({ username: owner })}`),
  });
  const bindGithub = useMutation({
    mutationFn: () =>
      api<{ authorize_url: string }>("/api/connections/github/start", {
        method: "POST",
        json: { username: owner },
      }),
    onSuccess: (out) => location.assign(out.authorize_url),
    onError: (error) => onMessage("err", errorText(error)),
  });
  const unbind = useMutation({
    mutationFn: (connection: ConnectionRow) =>
      api("/api/connections/unbind", {
        method: "POST",
        json: { username: owner, connection_id: connection.connection_id },
      }),
    onSuccess: () => {
      setPendingRemoval(null);
      onMessage("ok", uiText("身份连接已解绑。"));
      void client.invalidateQueries({ queryKey: ["permissions", "connections", owner] });
    },
    onError: (error) => {
      setPendingRemoval(null);
      onMessage("err", errorText(error));
    },
  });

  return (
    <section id="connections">
      <h2 className={styles.sec}>{uiText("登录连接")}</h2>
      <p className={styles.lead}>{uiText("显示外部登录连接；解绑最后一种连接前，先保留其他登录方式。")}</p>
      <UiCard className={styles.card}>
        {connections.isPending ? (
          <Loading />
        ) : connections.isError ? (
          <ErrorBox>{errorText(connections.error)}</ErrorBox>
        ) : connections.data.connections.length === 0 ? (
          <div className={styles.sub}>{uiText("还没有外部身份连接。")}</div>
        ) : (
          connections.data.connections.map((connection) => (
            <div key={connection.connection_id} className={styles.dev}>
              <span className={styles.n}>{connection.label || uiText("未设置展示名")}</span>
              <UiTag>{connection.provider}</UiTag>
              <span className="grow" />
              <span className={styles.offline}>{uiText("连接于 ")}{formatStamp(connection.created_at ?? undefined)}</span>
              {canEdit ? (
                <UiButton tone="danger" onClick={() => setPendingRemoval(connection)}>
                  {uiText("解绑")}</UiButton>
              ) : null}
            </div>
          ))
        )}
        {canEdit && connections.data?.github_available ? (
          <div className={styles.rowacts}>
            <UiButton loading={bindGithub.isPending} onClick={() => bindGithub.mutate()}>
              {uiText("绑定 GitHub")}</UiButton>
          </div>
        ) : null}
      </UiCard>
      <Confirm
        open={pendingRemoval !== null}
        title={uiText("解绑身份")}
        destructive
        confirmLabel={uiText("解绑")}
        busy={unbind.isPending}
        body={uiText("解绑「{v0}」？如果这是最后一种可恢复的登录方式，服务器会拒绝。", { v0: pendingRemoval?.label || pendingRemoval?.provider || uiText("该身份") })}
        onConfirm={() => pendingRemoval && unbind.mutate(pendingRemoval)}
        onCancel={() => setPendingRemoval(null)}
      />
    </section>
  );
}
