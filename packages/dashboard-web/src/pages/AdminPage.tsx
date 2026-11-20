import { dateLocale } from "../lib/format.js";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, uiMessage, uiValue, type UiTextValue } from "../i18n/ui-text.js";
/**
 * `/admin` — who may use the dev pipeline, and provisioning accounts from the
 * Feishu directory.
 *
 * Admin itself is NOT editable here and that is the point: a panel that can
 * make more admins hands the host to any single stolen admin session. Admins
 * come from `config.yaml` and a restart.
 *
 * `deploy` implies `dev` one way only — ticking deploy locks dev on, and
 * unticking dev never removes deploy. The lock state is rendered from what the
 * server returned, never from an optimistic local guess: a checkbox that flips
 * before the server agreed is a security control that lies.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "../lib/api.js";
import { pollInterval } from "../lib/query.js";
import { ErrorBox, Loading, Status } from "../ui/misc.js";
import { UiButton, UiCheckbox, UiInput, UiTag } from "../ui-kit/primitives.js";
import styles from "./AdminPage.module.css";

interface GrantInfo {
  granted_by?: string;
  granted_at?: string;
}

interface AdminUser {
  username: string;
  display_name?: string;
  admin: boolean;
  dev: boolean;
  deploy: boolean;
  /** The tier below dev (2026-08-20): own tickets through the review lane. */
  contribute?: boolean;
  grants?: Record<string, GrantInfo>;
}

interface Member {
  open_id: string;
  name?: string;
}

interface Binding {
  username: string;
  display_name: string;
}

interface Chat {
  chat_id: string;
  name: string;
  members: Member[];
  error?: string;
}

const USERS_PATH = "/api/admin/users";

/** The default internal username `provisionFeishuUser()` would derive. */
function suggestUsername(openId: string): string {
  const tail = String(openId).replace(/^ou_/, "").slice(-8).toLowerCase().replace(/[^a-z0-9_]/g, "");
  return `fs_${tail}`;
}

function MemberRow({
  member,
  binding,
  onImport,
  onRename,
  busy,
}: {
  member: Member;
  binding: Binding | undefined;
  onImport: (openId: string, username: string, displayName: string) => void;
  onRename: (username: string, displayName: string) => void;
  busy: boolean;
}) {
  useDashboardLanguage();
  const name = member.name || uiText("(未取到姓名)");
  const [username, setUsername] = useState(() => suggestUsername(member.open_id));
  const [displayName, setDisplayName] = useState(() =>
    binding ? binding.display_name : member.name || "",
  );
  if (binding) {
    return (
      <div className={`${styles.mrow} ${styles.bound}`}>
        <span className={styles.mname}>{binding.display_name}</span>
        <span className={styles.moid}>{member.open_id}</span>
        <span className="badge">{binding.username}</span>
        <span className="grow" />
        <UiInput
          type="text"
          aria-label={uiText("{v0} 的新显示名", { v0: binding.username })}
          placeholder={uiText("新显示名")}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <UiButton disabled={busy} onClick={() => onRename(binding.username, displayName.trim())}>
          {uiText("保存")}</UiButton>
      </div>
    );
  }
  return (
    <div className={styles.mrow}>
      <span className={styles.mname}>{name}</span>
      <span className={styles.moid}>{member.open_id}</span>
      <span className="grow" />
      <UiInput
        type="text"
        aria-label={uiText("用户名")}
        placeholder={uiText("用户名")}
        value={username}
        onChange={(event) => setUsername(event.target.value)}
      />
      <UiInput
        type="text"
        aria-label={uiText("显示名")}
        placeholder={uiText("显示名")}
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
      />
      <UiButton
        disabled={busy}
        onClick={() =>
          onImport(member.open_id, username.trim().toLowerCase(), displayName.trim())
        }
      >
        {uiText("开号")}</UiButton>
    </div>
  );
}

export function AdminPage() {
  useDashboardLanguage();
  const client = useQueryClient();
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: UiTextValue } | null>(null);
  const [dirMessage, setDirMessage] = useState<UiTextValue>("");
  const [lookup, setLookup] = useState({ mobiles: "", emails: "" });

  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api<{ users: AdminUser[] }>(USERS_PATH),
    refetchInterval: pollInterval(USERS_PATH, 30_000),
    refetchIntervalInBackground: false,
  });

  const directory = useQuery({
    queryKey: ["admin", "feishu-directory"],
    queryFn: () =>
      api<{ chats?: Chat[]; bindings?: Record<string, Binding>; built_at?: string; error?: string }>(
        "/api/admin/feishu-directory",
      ),
  });

  const lookupQuery = useMutation({
    mutationFn: (body: { mobiles: string; emails: string }) =>
      api<{
        hits?: Member[];
        bindings?: Record<string, Binding>;
        missing?: Array<{ mobile?: string; email?: string }>;
        error?: string;
      }>("/api/admin/feishu-lookup", { method: "POST", json: body }),
  });

  const grant = useMutation({
    mutationFn: (body: { username: string; capability: string; value: boolean }) =>
      api("/api/admin/grant", { method: "POST", json: body }),
    onSuccess: async (_data, body) => {
      setMessage({
        kind: "ok",
        text: uiMessage(body.value ? "已授予 {v0} · {v1}" : "已收回 {v0} · {v1}", { v0: body.capability, v1: body.username }),
      });
      await client.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onError: (err) => setMessage({ kind: "err", text: uiMessage("操作失败：{v0}", { v0: errorText(err) }) }),
  });

  const importUser = useMutation({
    mutationFn: (body: { open_id: string; username: string; display_name: string }) =>
      api<{ username: string; display_name?: string }>("/api/admin/feishu-import", {
        method: "POST",
        json: body,
      }),
    onSuccess: async (out) => {
      setDirMessage(uiMessage("已开号 {v0}{v1}", { v0: out.username, v1: out.display_name ? uiMessage(" · 显示名 {v0}", { v0: out.display_name }) : "" }));
      await Promise.all([
        client.invalidateQueries({ queryKey: ["admin", "users"] }),
        client.invalidateQueries({ queryKey: ["admin", "feishu-directory"] }),
      ]);
      if (lookupQuery.data) lookupQuery.mutate(lookup);
    },
    onError: (err) => setDirMessage(uiMessage("失败：{v0}", { v0: errorText(err) })),
  });

  const rename = useMutation({
    mutationFn: (body: { username: string; display_name: string }) =>
      api<{ username: string; display_name: string }>("/api/admin/rename", {
        method: "POST",
        json: body,
      }),
    onSuccess: async (out) => {
      setDirMessage(uiMessage("已改显示名 · {v0} → {v1}", { v0: out.username, v1: out.display_name }));
      await Promise.all([
        client.invalidateQueries({ queryKey: ["admin", "users"] }),
        client.invalidateQueries({ queryKey: ["admin", "feishu-directory"] }),
      ]);
    },
    onError: (err) => setDirMessage(uiMessage("失败：{v0}", { v0: errorText(err) })),
  });

  // Local accounts and login keys (2026-08-20). The plaintext key is shown
  // exactly once, in this component's state; reloading the page loses it and
  // minting again is the documented recovery.
  const [local, setLocal] = useState({ username: "", display_name: "" });
  const [secret, setSecret] = useState<{ username: string; token: string } | null>(null);
  const createLocal = useMutation({
    mutationFn: (body: { username: string; display_name: string }) =>
      api<{ username: string; token: string }>("/api/admin/local-user", { method: "POST", json: body }),
    onSuccess: async (out) => {
      setSecret({ username: out.username, token: out.token });
      setMessage({ kind: "ok", text: uiMessage("已创建本地账户 {v0};登录密钥只显示这一次", { v0: out.username }) });
      setLocal({ username: "", display_name: "" });
      await client.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onError: (err) => setMessage({ kind: "err", text: uiMessage("创建失败:{v0}", { v0: errorText(err) }) }),
  });
  const mintKey = useMutation({
    mutationFn: (body: { username: string }) =>
      api<{ username: string; token: string; ended_sessions?: number }>("/api/admin/dashboard-token", { method: "POST", json: body }),
    onSuccess: (out) => {
      setSecret({ username: out.username, token: out.token });
      setMessage({
        kind: "ok",
        text: uiMessage("已为 {v0} 签发新的登录密钥；旧密钥立即失效，{v1} 个登录会话已结束", {
          v0: out.username,
          v1: out.ended_sessions ?? 0,
        }),
      });
    },
    onError: (err) => setMessage({ kind: "err", text: uiMessage("签发失败:{v0}", { v0: errorText(err) }) }),
  });
  // Incident response (B12): end every browser login of one account now,
  // instead of waiting for its 14-day absolute expiry.
  const endSessions = useMutation({
    mutationFn: (body: { username: string }) =>
      api<{ username: string; revoked: number }>("/api/admin/web-sessions/revoke", { method: "POST", json: body }),
    onSuccess: (out) =>
      setMessage({ kind: "ok", text: uiMessage("已结束 {v0} 的 {v1} 个登录会话", { v0: out.username, v1: out.revoked }) }),
    onError: (err) => setMessage({ kind: "err", text: uiMessage("结束失败:{v0}", { v0: errorText(err) }) }),
  });

  const rows = users.data?.users ?? [];
  const bindings = directory.data?.bindings ?? {};

  return (
    <div className={styles.wrap}>
      <h2>{uiText("权限")}</h2>
      <p className={styles.lead}>{uiText("开发权限按用户授予，勾选立即生效。")}</p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th style={{ width: "28%" }}>{uiText("用户")}</th>
            <th style={{ width: "24%" }}>{uiText("贡献者 (contribute)")}</th>
            <th style={{ width: "24%" }}>{uiText("开发系统 (dev)")}</th>
            <th style={{ width: "24%" }}>{uiText("上线/落地 (deploy)")}</th>
          </tr>
        </thead>
        <tbody>
          {users.isPending ? (
            <tr>
              <td colSpan={4} className={styles.grant}>
                {uiText("加载中…")}</td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={4} className={styles.grant}>
                {uiText("还没有注册用户")}</td>
            </tr>
          ) : (
            rows.map((user) => {
              const devOn = user.admin || user.deploy || user.dev;
              const devLocked = user.admin || user.deploy;
              const deployLocked = user.admin;
              const contributeOn = devOn || Boolean(user.contribute);
              const contributeLocked = devOn;
              const by = (capability: string) =>
                user.grants?.[capability] ? (
                  <div className={styles.grant}>
                    {user.grants[capability].granted_by} ·{" "}
                    {(user.grants[capability].granted_at || "").slice(0, 10)}
                  </div>
                ) : null;
              return (
                <tr key={user.username}>
                  <td className={styles.who}>
                    <b>{user.display_name || user.username}</b>
                    {user.admin ? <UiTag tone="info">{uiText("管理员")}</UiTag> : null}
                    <div className={styles.u}>{user.username}</div>
                    <UiButton
                      disabled={mintKey.isPending}
                      aria-label={uiText("为 {v0} 签发登录密钥", { v0: user.username })}
                      onClick={() => mintKey.mutate({ username: user.username })}
                    >
                      {uiText("🔑 签发登录密钥")}</UiButton>
                    <UiButton
                      disabled={endSessions.isPending}
                      aria-label={uiText("结束 {v0} 的全部登录会话", { v0: user.username })}
                      onClick={() => endSessions.mutate({ username: user.username })}
                    >
                      {uiText("结束登录会话")}</UiButton>
                    <a
                      href={`/sessions-plus?as=${encodeURIComponent(user.username)}`}
                      aria-label={uiText("以 {v0} 的账户打开会话+", { v0: user.username })}
                    >
                      {uiText("查看会话")}</a>
                  </td>
                  <td>
                    <UiCheckbox
                      className={`${styles.cap} ${contributeLocked ? styles.locked : ""}`}
                      checked={contributeOn}
                      disabled={contributeLocked || grant.isPending}
                      onChange={(event) =>
                        grant.mutate({
                          username: user.username,
                          capability: "contribute",
                          value: event.target.checked,
                        })
                      }
                    >
                      <span>
                        {user.admin
                          ? uiText("管理员默认拥有")
                          : devOn
                            ? uiText("由 dev 蕴含")
                            : contributeOn
                              ? uiText("已授予")
                              : uiText("未授予")}
                      </span>
                    </UiCheckbox>
                    {contributeLocked ? null : by("contribute")}
                  </td>
                  <td>
                    <UiCheckbox
                      className={`${styles.cap} ${devLocked ? styles.locked : ""}`}
                      checked={devOn}
                      disabled={devLocked || grant.isPending}
                      onChange={(event) =>
                        grant.mutate({
                          username: user.username,
                          capability: "dev",
                          value: event.target.checked,
                        })
                      }
                    >
                      <span>
                        {user.admin
                          ? uiText("管理员默认拥有")
                          : user.deploy
                            ? uiText("由 deploy 蕴含")
                            : devOn
                              ? uiText("已授予")
                              : uiText("未授予")}
                      </span>
                    </UiCheckbox>
                    {devLocked ? null : by("dev")}
                  </td>
                  <td>
                    <UiCheckbox
                      className={`${styles.cap} ${deployLocked ? styles.locked : ""}`}
                      checked={user.admin || user.deploy}
                      disabled={deployLocked || grant.isPending}
                      onChange={(event) =>
                        grant.mutate({
                          username: user.username,
                          capability: "deploy",
                          value: event.target.checked,
                        })
                      }
                    >
                      <span>
                        {user.admin ? uiText("管理员默认拥有") : user.deploy ? uiText("已授予") : uiText("未授予")}
                      </span>
                    </UiCheckbox>
                    {deployLocked ? null : by("deploy")}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      {users.isError ? <ErrorBox>{uiText("加载失败：")}{errorText(users.error)}</ErrorBox> : null}
      {message ? <Status kind={message.kind}>{uiValue(message.text)}</Status> : null}
      {secret ? (
        <div className={styles.secret} data-testid="login-secret">
          <b>{secret.username}</b> {uiText(" 的登录密钥（仅显示一次）：")}<br />
          <code>{secret.token}</code>
          <br />
          {uiText("打开 ")}<code>/login</code> {uiText(" 并粘贴此密钥。")}</div>
      ) : null}
      <div className={styles.note}>
        <b>{uiText("管理员")}</b>{uiText("由 ")}<code>config.yaml</code> {uiText(" 的 ")}<code>dashboard.admins</code> {uiText(" 管理，修改后需重启。")}<br />
        {uiText("权限逐级包含：deploy → dev → contribute。contribute 仅访问本人工单并走 GitLab 评审，不能直接合入基线。")}</div>

      <h2 className={styles.sec}>{uiText("本地账户")}</h2>
      <p className={styles.lead}>{uiText("为无法使用飞书或 GitHub 登录的人创建本地账户；创建后再授予权限。")}</p>
      <div className={styles.localForm}>
        <label className="srOnly" htmlFor="local-username">
          {uiText("用户名")}</label>
        <UiInput
          id="local-username"
          type="text"
          placeholder={uiText("username(小写字母开头)")}
          value={local.username}
          onChange={(event) => setLocal((v) => ({ ...v, username: event.target.value }))}
        />
        <label className="srOnly" htmlFor="local-display">
          {uiText("显示名")}</label>
        <UiInput
          id="local-display"
          type="text"
          placeholder={uiText("显示名(可选)")}
          value={local.display_name}
          onChange={(event) => setLocal((v) => ({ ...v, display_name: event.target.value }))}
        />
        <UiButton
          className="primary"
          loading={createLocal.isPending}
          onClick={() => {
            if (!local.username.trim()) {
              setMessage({ kind: "err", text: uiMessage("请填写 username") });
              return;
            }
            createLocal.mutate({ username: local.username.trim().toLowerCase(), display_name: local.display_name.trim() });
          }}
        >
          {uiText("➕ 创建本地账户")}</UiButton>
      </div>

      <h2 className={styles.sec}>{uiText("飞书点名添加")}</h2>
      <p className={styles.lead}>
        {uiText("按手机号或邮箱查找同租户用户；多个值用逗号或空格分隔。跨租户用户需使用已知 open_id。")}</p>
      <div className={styles.lookupInputs}>
        <label className="srOnly" htmlFor="lk-mobiles">
          {uiText("手机号")}</label>
        <UiInput
          id="lk-mobiles"
          type="text"
          placeholder={uiText("手机号(可多个)")}
          value={lookup.mobiles}
          onChange={(event) => setLookup((v) => ({ ...v, mobiles: event.target.value }))}
        />
        <label className="srOnly" htmlFor="lk-emails">
          {uiText("邮箱")}</label>
        <UiInput
          id="lk-emails"
          type="text"
          placeholder={uiText("邮箱(可多个)")}
          value={lookup.emails}
          onChange={(event) => setLookup((v) => ({ ...v, emails: event.target.value }))}
        />
        <UiButton
          loading={lookupQuery.isPending}
          onClick={() => {
            if (!lookup.mobiles.trim() && !lookup.emails.trim()) {
              setDirMessage(uiMessage("请填写手机号或邮箱"));
              return;
            }
            setDirMessage("");
            lookupQuery.mutate(lookup);
          }}
        >
          {uiText("查找")}</UiButton>
      </div>
      <div className={styles.lkResult}>
        {lookupQuery.isPending ? <div className={styles.lkmiss}>{uiText("查找中…")}</div> : null}
        {lookupQuery.isError ? (
          <div className={styles.lkerr}>{uiText("查找失败:")}{errorText(lookupQuery.error)}</div>
        ) : null}
        {lookupQuery.data?.error ? (
          <div className={styles.lkerr}>⚠ {lookupQuery.data.error}</div>
        ) : null}
        {lookupQuery.data?.hits?.length ? (
          <div className={styles.members}>
            {lookupQuery.data.hits.map((hit) => (
              <MemberRow
                key={hit.open_id}
                member={hit}
                binding={(lookupQuery.data?.bindings ?? {})[hit.open_id]}
                busy={importUser.isPending || rename.isPending}
                onImport={(open_id, username, display_name) => {
                  if (!username) {
                    setDirMessage(uiMessage("请填写 username"));
                    return;
                  }
                  importUser.mutate({ open_id, username, display_name });
                }}
                onRename={(username, display_name) => {
                  if (!display_name) {
                    setDirMessage(uiMessage("显示名不能为空"));
                    return;
                  }
                  rename.mutate({ username, display_name });
                }}
              />
            ))}
          </div>
        ) : null}
        {lookupQuery.data?.missing?.length ? (
          <div className={styles.lkmiss}>
            {uiText("查无此人:")}{lookupQuery.data.missing
              .map((entry) => entry.mobile || entry.email || "")
              .filter(Boolean)
              .join("、")}
          </div>
        ) : null}
      </div>

      <h2 className={styles.sec}>{uiText("飞书群目录")}</h2>
      <p className={styles.lead}>{uiText("列出机器人所在群的成员；已开户用户只能修改显示名。")}</p>
      <div className={styles.toolbar}>
        <UiButton onClick={() => void directory.refetch()}>
          {uiText("🔄 刷新目录")}</UiButton>
        <span className={styles.stamp}>
          {directory.data?.built_at
            ? uiText("更新于 {v0}", { v0: new Date(directory.data.built_at).toLocaleTimeString(dateLocale()) })
            : ""}
        </span>
      </div>
      <div className={styles.chats}>
        {directory.isPending ? (
          <Loading />
        ) : directory.isError ? (
          <div className={styles.grant}>{uiText("加载失败：")}{errorText(directory.error)}</div>
        ) : directory.data?.error ? (
          <div className={styles.grant}>{directory.data.error}</div>
        ) : !directory.data?.chats?.length ? (
          <div className={styles.grant}>{uiText("机器人还不在任何群里(或权限位不足)")}</div>
        ) : (
          directory.data.chats.map((chat) => {
            const inSystem = chat.members.filter((member) => bindings[member.open_id]).length;
            return (
              <details key={chat.chat_id} className={styles.chat}>
                <summary>
                  {chat.name}
                  <span className={styles.cnt}>
                    · {chat.members.length} {uiText(" 人 · 已开号 ")}{inSystem}
                  </span>
                  <span className={styles.cid}>{chat.chat_id}</span>
                </summary>
                {chat.error ? <div className={styles.cerr}>⚠ {chat.error}</div> : null}
                <div className={styles.members}>
                  {chat.members.length === 0 ? (
                    <div className={styles.grant}>{uiText("这个群还没拉到成员")}</div>
                  ) : (
                    chat.members.map((member) => (
                      <MemberRow
                        key={member.open_id}
                        member={member}
                        binding={bindings[member.open_id]}
                        busy={importUser.isPending || rename.isPending}
                        onImport={(open_id, username, display_name) => {
                          if (!username) {
                            setDirMessage(uiMessage("请填写 username"));
                            return;
                          }
                          importUser.mutate({ open_id, username, display_name });
                        }}
                        onRename={(username, display_name) => {
                          if (!display_name) {
                            setDirMessage(uiMessage("显示名不能为空"));
                            return;
                          }
                          rename.mutate({ username, display_name });
                        }}
                      />
                    ))
                  )}
                </div>
              </details>
            );
          })
        )}
      </div>
      {uiValue(dirMessage) ? <p className={styles.lead}>{uiValue(dirMessage)}</p> : null}
    </div>
  );
}
