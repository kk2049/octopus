import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText, query } from "../lib/api.js";
import { ErrorBox, Loading } from "../ui/misc.js";
import { UiButton, UiCard, UiInput, UiSelect, UiTag } from "../ui-kit/primitives.js";
import styles from "./PermissionsPage.module.css";

interface CatalogTool {
  name: string;
  description: string;
  shareable: boolean;
  reason?: string;
}

interface TentacleDevice {
  device: string;
  online: boolean;
  tools: CatalogTool[];
}

interface TentacleShare {
  viewer: string;
  objectId: string;
  kind: "tool" | "projection";
  device: string;
  resourceKey: string;
  schemaDigest: string;
  effective: boolean;
  explanation: string;
}

interface TentacleView {
  available?: boolean;
  devices: TentacleDevice[];
  shares: TentacleShare[];
}

export function TentacleSharingSection({
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
  const [viewer, setViewer] = useState("");
  const [device, setDevice] = useState("");
  const [kind, setKind] = useState<"tool" | "projection">("tool");
  const [resourceKey, setResourceKey] = useState("");
  const state = useQuery({
    queryKey: ["tentacle", owner],
    queryFn: () => api<TentacleView>(`/api/tentacle${query({ username: owner })}`),
  });
  const selectedDevice = device || state.data?.devices[0]?.device || "";
  const tools = state.data?.devices.find((row) => row.device === selectedDevice)?.tools ?? [];
  const shareableTools = tools.filter((tool) => tool.shareable);
  const selectedResource = resourceKey || (kind === "tool" ? shareableTools[0]?.name ?? "" : "");

  const refresh = () => void client.invalidateQueries({ queryKey: ["tentacle", owner] });
  const create = useMutation({
    mutationFn: () => api("/api/tentacle/shares", {
      method: "POST",
      json: {
        username: owner,
        viewer,
        device: selectedDevice,
        kind,
        resource_key: selectedResource,
      },
    }),
    onSuccess: () => {
      onMessage("ok", uiText("dsh Object 已固定并授权给指定用户。"));
      setViewer("");
      setResourceKey("");
      refresh();
    },
    onError: (error) => onMessage("err", errorText(error)),
  });
  const revoke = useMutation({
    mutationFn: (share: TentacleShare) => api("/api/tentacle/shares/revoke", {
      method: "POST",
      json: { username: owner, viewer: share.viewer, object_id: share.objectId },
    }),
    onSuccess: () => {
      onMessage("ok", uiText("共享已撤销，现有 Context 和投影已停止。"));
      refresh();
    },
    onError: (error) => onMessage("err", errorText(error)),
  });

  return (
    <>
      <h2 className={styles.sec}>{uiText("dsh 跨用户共享")}</h2>
      <p className={styles.lead}>
        {uiText("只共享所选工具或会话投影，不共享整机；会话不含凭据、环境变量、调试栈或本地路径。")}</p>
      {state.isPending ? <Loading /> : state.isError ? <ErrorBox>{errorText(state.error)}</ErrorBox> : (
        <UiCard className={styles.card}>
          {state.data!.available === false ? (
            <div className={styles.sub}>{uiText("当前部署未启用 dsh 共享。")}</div>
          ) : null}
          {canEdit && state.data!.available !== false ? (
            <div className={styles.filters}>
              <UiInput
                aria-label={uiText("共享给用户")}
                placeholder={uiText("对方 Octopus 用户名")}
                value={viewer}
                maxLength={64}
                onChange={(event) => setViewer(event.target.value)}
              />
              <UiSelect
                aria-label={uiText("dsh 设备")}
                value={selectedDevice}
                onValueChange={(value) => { setDevice(value); setResourceKey(""); }}
                options={state.data!.devices.map((row) => ({
                  value: row.device,
                  label: `${row.device} · ${row.online ? uiText("在线") : uiText("离线")}`,
                }))}
              />
              <UiSelect
                aria-label={uiText("共享类型")}
                value={kind}
                onValueChange={(value) => { setKind(value === "projection" ? "projection" : "tool"); setResourceKey(""); }}
                options={[
                  { value: "tool", label: uiText("工具") },
                  { value: "projection", label: uiText("会话投影") },
                ]}
              />
              {kind === "tool" ? (
                <UiSelect
                  aria-label={uiText("固定工具")}
                  value={selectedResource}
                  onValueChange={setResourceKey}
                  options={shareableTools.map((tool) => ({ value: tool.name, label: tool.name }))}
                />
              ) : (
                <UiInput
                  aria-label={uiText("源会话 ID")}
                  placeholder={uiText("源 dsh 会话 ID")}
                  value={resourceKey}
                  maxLength={256}
                  onChange={(event) => setResourceKey(event.target.value)}
                />
              )}
              <UiButton
                tone="primary"
                loading={create.isPending}
                disabled={!viewer || !selectedDevice || !selectedResource}
                onClick={() => create.mutate()}
              >
                {uiText("固定并授权")}</UiButton>
            </div>
          ) : null}
          {state.data!.devices.flatMap((row) => row.tools.filter((tool) => !tool.shareable)).map((tool) => (
            <div key={tool.name} className={styles.sub}>
              <code>{tool.name}</code> {uiText(" 未共享：")}{tool.reason}
            </div>
          ))}
          {state.data!.shares.length === 0 ? <div className={styles.sub}>{uiText("尚无跨用户共享。")}</div> : (
            state.data!.shares.map((share) => (
              <div key={`${share.viewer}:${share.objectId}`} className={styles.dev}>
                <span className={styles.n}>{share.resourceKey}</span>
                <UiTag tone="info">{share.kind === "tool" ? uiText("工具") : uiText("裁剪投影")}</UiTag>
                <span>→ {share.viewer}</span>
                <span className="grow" />
                <span className={share.effective ? styles.online : styles.offline} title={share.explanation}>
                  {share.effective ? uiText("● 有效") : uiText("○ 已失效")}
                </span>
                {canEdit ? (
                  <UiButton tone="danger" loading={revoke.isPending} onClick={() => revoke.mutate(share)}>
                    {uiText("撤销")}</UiButton>
                ) : null}
              </div>
            ))
          )}
        </UiCard>
      )}
    </>
  );
}
