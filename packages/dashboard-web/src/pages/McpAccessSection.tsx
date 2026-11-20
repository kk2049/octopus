import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, uiMessage, uiValue, type UiTextValue, localizedLabels } from "../i18n/ui-text.js";
import { UiButton, UiCheckbox, UiInput } from "../ui-kit/primitives.js";
/**
 * The MCP access block on `/permissions` — mint/list/revoke `mcp_` tokens and
 * the one-click registration snippet for external agents.
 *
 * Rendering rules, same as the rest of the page: everything shown is
 * server-computed (the endpoint URL, the command, the config JSON all come
 * from the token API), the browser decides nothing, and the plaintext token
 * exists only in this component's state for the one render after minting — it
 * is never queryable again, and the list shows only hashes.
 */

import { useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText, query } from "../lib/api.js";
import { Confirm } from "../ui/Dialog.js";
import { ErrorBox, Loading, Status } from "../ui/misc.js";
import { formatStamp } from "../lib/format.js";
import styles from "./PermissionsPage.module.css";

interface McpTokenRow {
  token_hash: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  active: boolean;
  policy: McpTokenPolicy | null;
}

type McpToolGroup = "sessions" | "workspace" | "crdt" | "memory" | "skills" | "apps" | "feishu" | "tentacle" | "execution" | "discussions";
interface McpTokenPolicy {
  schema: "mcp-token-policy/v1";
  groups: McpToolGroup[];
  apps?: { ids?: string[]; instances?: string[]; actions?: string[] };
}

const GROUPS = localizedLabels((): ReadonlyArray<{ id: McpToolGroup; label: string }> => ([
  { id: "sessions", label: uiText("会话") },
  { id: "workspace", label: uiText("工作区文件") },
  { id: "crdt", label: uiText("协作文档") },
  { id: "memory", label: uiText("中心记忆") },
  { id: "skills", label: uiText("技能库") },
  { id: "apps", label: "Agentic Apps" },
  { id: "feishu", label: uiText("飞书") },
  { id: "discussions", label: uiText("议题会议") },
  { id: "tentacle", label: uiText("dsh 跨用户 Gate") },
  { id: "execution", label: uiText("远程执行作用域（dsh 后端）") },
]));

function allowlist(value: string): string[] | undefined {
  const rows = [...new Set(value.split(/[\s,，]+/).map((row) => row.trim()).filter(Boolean))];
  return rows.length ? rows : undefined;
}

function policyLabel(policy: McpTokenPolicy | null): string {
  if (!policy) return uiText("旧令牌 · 跟随账户全部授权");
  const groups = policy.groups.map((id) => GROUPS().find((row) => row.id === id)?.label ?? id).join("、");
  const selectors = [
    policy.apps?.ids?.length ? `App ${policy.apps.ids.join(", ")}` : "",
    policy.apps?.instances?.length ? uiText("空间 {v0} 个", { v0: policy.apps.instances.length }) : "",
    policy.apps?.actions?.length ? uiText("动作 {v0}", { v0: policy.apps.actions.join(", ") }) : "",
  ].filter(Boolean).join("；");
  return selectors ? `${groups} · ${selectors}` : groups;
}

interface McpRegistration {
  endpoint: string;
  command: string;
  config: Record<string, unknown>;
}

interface McpTokenList {
  tokens: McpTokenRow[];
  registration: McpRegistration;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  useDashboardLanguage();
  const [done, setDone] = useState(false);
  return (
    <UiButton
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setDone(true),
          () => setDone(false),
        );
      }}
    >
      {done ? uiText("已复制") : (label ?? uiText("复制"))}
    </UiButton>
  );
}

const SNIPPET_STYLE: CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  fontSize: "12px",
  margin: "4px 0 8px",
  padding: "8px",
  background: "rgba(127,127,127,.08)",
  borderRadius: "6px",
};

export function McpAccessSection({ owner, canEdit }: { owner: string; canEdit: boolean }) {
  useDashboardLanguage();
  const client = useQueryClient();
  const [label, setLabel] = useState("");
  const [groups, setGroups] = useState<McpToolGroup[]>(GROUPS().map((row) => row.id));
  const [appIds, setAppIds] = useState("");
  const [appInstances, setAppInstances] = useState("");
  const [appActions, setAppActions] = useState("");
  const [minted, setMinted] = useState<{ token: string; label: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: UiTextValue } | null>(null);

  const tokens = useQuery({
    queryKey: ["mcp", "tokens", owner],
    queryFn: () => api<McpTokenList>(`/api/mcp/tokens${query({ username: owner })}`),
  });

  const mint = useMutation({
    mutationFn: () =>
      api<{ token: string; label: string }>("/api/mcp/tokens/create", {
        method: "POST",
        json: {
          username: owner,
          label,
          tool_groups: groups,
          ...(allowlist(appIds) ? { app_ids: allowlist(appIds) } : {}),
          ...(allowlist(appInstances) ? { app_instances: allowlist(appInstances) } : {}),
          ...(allowlist(appActions) ? { app_actions: allowlist(appActions) } : {}),
        },
      }),
    onSuccess: (out) => {
      setMinted({ token: out.token, label: out.label });
      setLabel("");
      setMessage({ kind: "ok", text: uiMessage("已签发。令牌只显示这一次，请立刻复制。") });
      void client.invalidateQueries({ queryKey: ["mcp", "tokens", owner] });
    },
    onError: (err) => setMessage({ kind: "err", text: errorText(err) }),
  });

  const revoke = useMutation({
    mutationFn: (tokenHash: string) =>
      api("/api/mcp/tokens/revoke", { method: "POST", json: { username: owner, token_hash: tokenHash } }),
    onSuccess: () => {
      setRevoking(null);
      setMessage({ kind: "ok", text: uiMessage("已撤销。这个令牌打开的作用域与未决批准卡已一并作废。") });
      void client.invalidateQueries({ queryKey: ["mcp", "tokens", owner] });
    },
    onError: (err) => {
      setRevoking(null);
      setMessage({ kind: "err", text: errorText(err) });
    },
  });

  const registration = tokens.data?.registration;
  const command = registration
    ? registration.command.replace("<mcp_token>", minted?.token ?? "<mcp_token>")
    : "";
  const config = registration
    ? JSON.stringify(registration.config, null, 2).replace("<mcp_token>", minted?.token ?? "<mcp_token>")
    : "";

  return (
    <>
      <h2 className={styles.sec}>{uiText("MCP 接入（外部 Agent）")}</h2>
      <p className={styles.lead}>
        {uiText("令牌只能调用账户权限内且在下方选中的 MCP 操作；不能登录网页、签发令牌或批准自己的调用。")}</p>

      {tokens.isPending ? (
        <Loading />
      ) : tokens.isError ? (
        <ErrorBox>{uiText("加载失败：")}{errorText(tokens.error)}</ErrorBox>
      ) : (
        <>
          {minted ? (
            <div className={styles.card}>
              <b>{uiText("新令牌「")}{minted.label || uiText("(无标签)")}{uiText("」— 只显示这一次：")}</b>
              <pre style={SNIPPET_STYLE}>{minted.token}</pre>
              <div className={styles.rowacts}>
                <CopyButton text={minted.token} label={uiText("复制令牌")} />
              </div>
            </div>
          ) : null}

          <div className={styles.card}>
            <b>{uiText("一键注册")}</b>
            <p className={styles.sub}>
              {uiText("端点 ")}<code>{registration?.endpoint}</code>
              {minted ? null : uiText("（把命令里的 <mcp_token> 换成你签发的令牌）")}
            </p>
            <pre style={SNIPPET_STYLE}>{command}</pre>
            <div className={styles.rowacts}>
              <CopyButton text={command} label={uiText("复制命令")} />
            </div>
            <p className={styles.sub}>{uiText("或写进 MCP 客户端的 JSON 配置：")}</p>
            <pre style={SNIPPET_STYLE}>{config}</pre>
            <div className={styles.rowacts}>
              <CopyButton text={config} label={uiText("复制 JSON")} />
            </div>
          </div>

          <div className={styles.card}>
            {canEdit ? (
              <div style={{ display: "grid", gap: 12 }}>
                <div>
                  <b>{uiText("新令牌的最小权限")}</b>
                  <p className={styles.sub}>{uiText("令牌权限只能收窄账户授权。")}</p>
                  <div className={styles.rowacts}>
                    {GROUPS().map((row) => (
                      <UiCheckbox
                        key={row.id}
                        checked={groups.includes(row.id)}
                        onChange={(event) => setGroups((current) => event.target.checked
                          ? [...current, row.id]
                          : current.filter((id) => id !== row.id))}
                      >
                        {row.label}
                      </UiCheckbox>
                    ))}
                  </div>
                </div>
                {groups.includes("apps") ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    <p className={styles.sub}>{uiText("留空表示不限；多个值用逗号分隔。共享空间标识可从 App 页面或 ")}<code>app_list</code> {uiText(" 获取。")}</p>
                    <UiInput aria-label={uiText("允许的 App")} placeholder={uiText("App：例如 daily-brief, report-space")} value={appIds} maxLength={1024} onChange={(event) => setAppIds(event.target.value)} />
                    <UiInput aria-label={uiText("允许的共享空间")} placeholder={uiText("共享空间：例如 asi_…")} value={appInstances} maxLength={2048} onChange={(event) => setAppInstances(event.target.value)} />
                    <UiInput aria-label={uiText("允许的 App 动作")} placeholder={uiText("写动作：例如 publish_summary, submit_report")} value={appActions} maxLength={2048} onChange={(event) => setAppActions(event.target.value)} />
                  </div>
                ) : null}
                <div className={styles.rowacts}>
                  <UiInput
                    type="text"
                    placeholder={uiText("标签（例如：工作笔记本的 Claude Code）")}
                    aria-label={uiText("新令牌标签")}
                    value={label}
                    maxLength={64}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                  <UiButton disabled={mint.isPending || groups.length === 0} onClick={() => mint.mutate()}>
                    {uiText("签发新令牌")}</UiButton>
                </div>
              </div>
            ) : null}
            {tokens.data!.tokens.length === 0 ? (
              <div className={styles.sub}>{uiText("还没有签发过 MCP 令牌。")}</div>
            ) : (
              tokens.data!.tokens.map((row) => (
                <div key={row.token_hash} className={styles.dev}>
                  <span className={styles.n}>{row.label || uiText("(无标签)")}</span>
                  <span className={row.active ? styles.online : styles.offline}>
                    {row.revoked_at ? uiText("○ 已撤销") : row.active ? uiText("● 有效") : uiText("○ 已过期")}
                  </span>
                  <span className={styles.offline}>{uiText("签发于 ")}{formatStamp(row.created_at, 10)}</span>
                  <span className={styles.offline}>
                    {row.last_used_at ? uiText("最近使用 {v0}", { v0: formatStamp(row.last_used_at) }) : uiText("从未使用")}
                  </span>
                  <span className={styles.offline}>{policyLabel(row.policy)}</span>
                  <span className="grow" />
                  {canEdit && row.active ? (
                    <UiButton className="danger" onClick={() => setRevoking(row.token_hash)}>
                      {uiText("撤销")}</UiButton>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {message ? <Status kind={message.kind}>{uiValue(message.text)}</Status> : null}
      <Confirm
        open={revoking !== null}
        title={uiText("撤销 MCP 令牌")}
        destructive
        confirmLabel={uiText("撤销")}
        busy={revoke.isPending}
        body={uiText("撤销后这个令牌立即失效：它打开的文件/文档作用域和未决批准卡一并作废。已注册它的 Agent 需要换新令牌。")}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        onCancel={() => setRevoking(null)}
      />
    </>
  );
}
