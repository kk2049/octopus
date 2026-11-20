import { RunnerDisplayName } from "../ui/RunnerDisplayName.js";
import { FeishuOAuthSection } from "./FeishuOAuthSection.js";
import { SessionSharingPermissions } from "./SessionSharing.js";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, uiMessage, uiValue, type UiTextValue } from "../i18n/ui-text.js";
/**
 * `/permissions` — what may act on your behalf, over what, and why it still works.
 *
 * ── The rule this page is written to ────────────────────────────────────────
 *
 * Requested, granted and effective are three columns, never one tick. The two
 * lies a single tick tells are specific: "the laptop was revoked but the page
 * still says it may read", and "the new release added `exec` and the old tick
 * makes it look covered". Both are visible here as separate columns with a
 * reason attached.
 *
 * Everything shown is server-computed. There is no client-side permission
 * arithmetic — the browser renders `entries` and `explanation`; it decides
 * nothing. The one derived thing is the pending diff ("what pressing 保存 would
 * change"), which is a comparison of the checkbox state against the `granted`
 * set the server already sent, and still says nothing about what is EFFECTIVE.
 *
 * Nothing rendered here is a capability id, a Context id, a token or a
 * transcript path: none of them mean anything to a person, and every one of
 * them is a thing the browser could then send back.
 */

import { useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText, query } from "../lib/api.js";
import { bootstrap } from "../lib/bootstrap.js";
import { formatStamp } from "../lib/format.js";
import { Confirm } from "../ui/Dialog.js";
import { ErrorBox, Loading, Status } from "../ui/misc.js";
import { UiButton, UiCard, UiSelect, UiTag } from "../ui-kit/primitives.js";
import type { PermissionsPageProps } from "../contract.js";
import { PermissionStudio } from "../permissions/PermissionStudio.js";
import { McpAccessSection } from "./McpAccessSection.js";
import { GithubConnectionsSection } from "./GithubConnectionsSection.js";
import { SubjectOps, type Subject } from "./permissions/SubjectOps.js";
import { TentacleSharingSection } from "./TentacleSharingSection.js";
import styles from "./PermissionsPage.module.css";

interface DeviceRow {
  device: string;
  display_name?: string;
  online: boolean;
  created_at?: string;
}

interface WebSessionRow {
  sid: string;
  current?: boolean;
  active?: boolean;
  last_seen_at?: string;
}

interface AuditRow {
  id: number;
  at?: string;
  subject_id: string;
  operation: string;
  decision: string;
  reason?: string;
}

/** One newest-first page; `next_before` is the keyset cursor to the older page. */
interface AuditPage {
  records: AuditRow[];
  has_more?: boolean;
  next_before?: number;
}

function SubjectCard({
  subject,
  agents,
  canEdit,
  owner,
  onChanged,
  onMessage,
}: {
  subject: Subject;
  agents: Subject[];
  canEdit: boolean;
  owner: string;
  onChanged: () => Promise<void>;
  onMessage: (kind: "ok" | "err", text: string) => void;
}) {
  useDashboardLanguage();
  const editable = canEdit && !subject.trustedService && subject.enforced !== false && subject.editable === true;
  return (
    <UiCard className={styles.card}>
      <h3>
        {subject.title}
        {subject.trustedService ? (
          <UiTag tone="danger">{uiText("受信系统服务")}</UiTag>
        ) : null}
        {!subject.trustedService && subject.enforced === false ? (
          <UiTag tone="warning">{uiText("未接入执行路径 · 授权不生效")}</UiTag>
        ) : null}
        {subject.grant?.source === "config" ? (
          <UiTag tone="warning">{uiText("来源：部署配置 · 只读")}</UiTag>
        ) : subject.grant ? (
          <UiTag tone="info">{uiText("来源 ")}{subject.grant.source}</UiTag>
        ) : (
          <UiTag>{uiText("尚未授权")}</UiTag>
        )}
        {subject.grant?.source === "bootstrap" ? (
          <UiTag tone="warning">{uiText("迁移导入 · 非你手动同意")}</UiTag>
        ) : null}
      </h3>
      <p className={styles.sub}>{subject.description}</p>
      {subject.trustedService ? (
        <div className={styles.sub}>
          <b>{uiText("实际权限（不受本页授权或沙箱控制）：")}</b> {uiText("主体")}<code>{subject.trustedService.principal}</code>
          <ul className={styles.bounds}>
            {subject.trustedService.boundaries.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : subject.enforced === false ? (
        <div className={styles.sub}>
          {uiText("权限来自部署配置（")}<code>v3_host.apps.*</code>{uiText("），本页仅展示且不可编辑。")}</div>
      ) : subject.grant?.source === "config" ? (
        <div className={styles.sub}>
          {uiText("权限由部署配置管理，本页只读。")}</div>
      ) : null}
      <SubjectOps
        subject={subject}
        editable={editable}
        owner={owner}
        onChanged={onChanged}
        onMessage={onMessage}
      />
      {agents.map((agent) => (
        <UiCard key={agent.id} className={styles.card} style={{ margin: "10px 0 0" }}>
          <h3>
            ↳ Agent {String(agent.id).split("/")[1] || agent.id}
            <UiTag tone="info">{uiText("只能是所属 App 的子集")}</UiTag>
            {agent.enforced === false ? (
              <UiTag tone="warning">{uiText("尚未接入执行路径")}</UiTag>
            ) : null}
          </h3>
          <div className={styles.counts}>
            <span>
              {uiText("已授权 ")}<b>{agent.permissions.grantedCount}</b>
            </span>
            <span>
              {uiText("此刻有效 ")}<b>{agent.permissions.effectiveCount}</b>
            </span>
          </div>
          <SubjectOps
            subject={agent}
            editable={canEdit && agent.enforced !== false && agent.editable === true}
            owner={owner}
            onChanged={onChanged}
            onMessage={onMessage}
          />
        </UiCard>
      ))}
    </UiCard>
  );
}

export function PermissionsPage() {
  useDashboardLanguage();
  const props = bootstrap.pageProps as PermissionsPageProps;
  const owner = props.owner;
  const canEdit = props.canEdit;
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const sections = [
    { id: "grants", title: uiText("应用授权") }, { id: "tree", title: uiText("权限树") },
    { id: "connections", title: uiText("连接与设备") }, { id: "activity", title: uiText("活动记录") },
  ];
  const activeSection = sections.some((section) => section.id === params.get("view"))
    ? params.get("view")! : props.connectionMessage || location.hash === "#connections" || params.get("focus") === "feishu" ? "connections" : "grants";
  const selectSection = (id: string) => setParams((previous) => {
    const next = new URLSearchParams(previous); next.set("view", id); return next;
  });
  const client = useQueryClient();
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: UiTextValue } | null>(
    props.connectionMessage ?? null,
  );
  const [filter, setFilter] = useState({ subject: "", decision: "" });
  const [appliedFilter, setAppliedFilter] = useState({ subject: "", decision: "" });
  const [revokeDevice, setRevokeDevice] = useState<string | null>(null);
  const [logoutOthers, setLogoutOthers] = useState(false);

  const subjects = useQuery({
    queryKey: ["permissions", "subjects", owner],
    queryFn: () => api<{ subjects: Subject[] }>(`/api/permissions${query({ username: owner })}`),
  });
  const devices = useQuery({
    queryKey: ["permissions", "devices", owner],
    queryFn: () =>
      api<{ devices: DeviceRow[] }>(`/api/permissions/devices${query({ username: owner })}`),
  });
  const webSessions = useQuery({
    queryKey: ["permissions", "web-sessions", owner],
    queryFn: () =>
      api<{ sessions: WebSessionRow[] }>(
        `/api/permissions/web-sessions${query({ username: owner })}`,
      ),
  });
  // Older pages load only on the explicit button; the cursor is the last id
  // seen, so a page never repeats or skips rows appended meanwhile.
  const audit = useInfiniteQuery({
    queryKey: ["permissions", "audit", owner, appliedFilter],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      api<AuditPage>(
        `/api/permissions/audit${query({
          username: owner,
          subject: appliedFilter.subject,
          decision: appliedFilter.decision,
          before: pageParam,
        })}`,
      ),
    getNextPageParam: (lastPage) => (lastPage.has_more && lastPage.next_before ? lastPage.next_before : null),
  });
  const auditRecords = useMemo(() => audit.data?.pages.flatMap((page) => page.records) ?? [], [audit.data]);

  const refreshAll = () => client.invalidateQueries({ queryKey: ["permissions"] });

  const endSession = useMutation({
    mutationFn: (sid: string) =>
      api("/api/permissions/web-sessions/revoke", {
        method: "POST",
        json: { username: owner, sid },
      }),
    onSuccess: () => {
      setMessage({ kind: "ok", text: uiMessage("已结束该处登录。") });
      void client.invalidateQueries({ queryKey: ["permissions", "web-sessions", owner] });
    },
    onError: (err) => setMessage({ kind: "err", text: errorText(err) }),
  });

  const endOthers = useMutation({
    mutationFn: () =>
      api<{ revoked: number }>("/api/permissions/web-sessions/revoke-others", {
        method: "POST",
        json: { username: owner },
      }),
    onSuccess: (out) => {
      setLogoutOthers(false);
      setMessage({ kind: "ok", text: uiMessage("已结束 {v0} 处登录。", { v0: out.revoked }) });
      void client.invalidateQueries({ queryKey: ["permissions", "web-sessions", owner] });
    },
    onError: (err) => {
      setLogoutOthers(false);
      setMessage({ kind: "err", text: errorText(err) });
    },
  });

  const dropDevice = useMutation({
    mutationFn: (device: string) =>
      api("/api/runner-delete", { method: "POST", json: { username: owner, device } }),
    onSuccess: () => {
      setRevokeDevice(null);
      setMessage({ kind: "ok", text: uiMessage("已吊销。") });
      refreshAll();
    },
    onError: (err) => {
      setRevokeDevice(null);
      setMessage({ kind: "err", text: errorText(err) });
    },
  });

  const grouped = useMemo(() => {
    const list = subjects.data?.subjects ?? [];
    const agents: Record<string, Subject[]> = {};
    for (const subject of list) {
      if (subject.type !== "agent") continue;
      const app = String(subject.id).split("/")[0];
      (agents[app] = agents[app] ?? []).push(subject);
    }
    return list
      .filter((subject) => subject.type !== "agent")
      .map((subject) => ({ subject, agents: agents[subject.id] ?? [] }));
  }, [subjects.data]);

  return (
    <div className={styles.wrap}>
      <h2>{uiText("权限中心")}</h2>
      {canEdit ? <FeishuOAuthSection key={owner} owner={owner} /> : null}
      {bootstrap.pages.includes("page.sessionsPlus") ? <SessionSharingPermissions /> : null}
      <p className={styles.lead}>{uiText("管理应用能做什么，查看资源授予了谁。")}</p>
      <div className={styles.tabs} role="tablist" aria-label={uiText("权限中心分区")}>
        {sections.map((section, index) => <button type="button" key={section.id}
          role="tab" id={`permission-tab-${section.id}`} aria-selected={activeSection === section.id}
          aria-controls={`permission-panel-${section.id}`} tabIndex={activeSection === section.id ? 0 : -1}
          onClick={() => selectSection(section.id)} onKeyDown={(event) => {
            const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            const next = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1
              : direction ? (index + direction + sections.length) % sections.length : null;
            if (next === null) return;
            event.preventDefault(); selectSection(sections[next].id);
            document.getElementById(`permission-tab-${sections[next].id}`)?.focus();
          }}>{section.title}</button>)}
      </div>
      {message ? <Status kind={message.kind}>{uiValue(message.text)}</Status> : null}
      <section id="permission-panel-tree" role="tabpanel" aria-labelledby="permission-tab-tree" hidden={activeSection !== "tree"}>
        <PermissionStudio owner={owner} />
      </section>
      <section id="permission-panel-grants" role="tabpanel" aria-labelledby="permission-tab-grants" hidden={activeSection !== "grants"}>
      <p className={styles.lead}>{uiText("按类别选择权限，保存后生效。申请、已授权和此刻有效分别展示。")}</p>
      {subjects.isPending ? (
        <Loading />
      ) : subjects.isError ? (
        <ErrorBox>{uiText("加载失败：")}{errorText(subjects.error)}</ErrorBox>
      ) : null}
      {grouped.map(({ subject, agents }) => (
          <SubjectCard
            key={subject.id}
            subject={subject}
            agents={agents}
            canEdit={canEdit}
            owner={owner}
            onChanged={refreshAll}
            onMessage={(kind, text) => setMessage({ kind, text })}
          />
        ))}

      </section>
      <section id="permission-panel-connections" role="tabpanel" aria-labelledby="permission-tab-connections" hidden={activeSection !== "connections"}>
      <GithubConnectionsSection
        owner={owner}
        canEdit={canEdit}
        onMessage={(kind, text) => setMessage({ kind, text })}
      />

      <h2 className={styles.sec}>{uiText("设备与 CLI")}</h2>
      <p className={styles.lead}>
        {uiText("章鱼端点可单独撤销；本页只控制会话操作，不改变设备上的文件或 shell 权限。撤销会终止派生权限。")}</p>
      {devices.isPending ? (
        <Loading />
      ) : devices.isError ? (
        <ErrorBox>{errorText(devices.error)}</ErrorBox>
      ) : devices.data!.devices.length === 0 ? (
        <UiCard className={`${styles.card} ${styles.sub}`}>
          {uiText("还没有注册章鱼端点；会话权限保持关闭。")}</UiCard>
      ) : (
        <UiCard className={styles.card}>
          {devices.data!.devices.map((device) => (
            <div key={JSON.stringify([owner, device.device])} className={styles.dev}>
              <span className={styles.n}><RunnerDisplayName username={owner} device={device.device} displayName={device.display_name}
                canEdit={canEdit} onSaved={() => devices.refetch()} /></span>
              <span className={device.online ? styles.online : styles.offline}>
                {device.online ? uiText("● 在线") : uiText("○ 离线")}
              </span>
              <span className="grow" />
              <span className={styles.offline}>{uiText("注册于 ")}{(device.created_at || "").slice(0, 10)}</span>
              {canEdit ? (
                <UiButton tone="danger" onClick={() => setRevokeDevice(device.device)}>
                  {uiText("吊销")}</UiButton>
              ) : null}
            </div>
          ))}
        </UiCard>
      )}

      <h2 className={styles.sec}>{uiText("浏览器会话")}</h2>
      <p className={styles.lead}>{uiText("管理当前浏览器登录；“全部退出”保留本次会话。")}</p>
      <UiCard className={styles.card}>
        {webSessions.isPending ? (
          <Loading />
        ) : webSessions.isError ? (
          <ErrorBox>{errorText(webSessions.error)}</ErrorBox>
        ) : webSessions.data!.sessions.length === 0 ? (
          <div className={styles.sub}>{uiText("没有记录")}</div>
        ) : (
          webSessions.data!.sessions.map((session) => (
            <div key={session.sid} className={styles.dev}>
              <span className={styles.n}>{session.current ? uiText("本次会话") : uiText("另一处登录")}</span>
              <span className={styles.offline}>
                {uiText("最近活动 ")}{formatStamp(session.last_seen_at)}
              </span>
              <span className="grow" />
              <span className={session.active ? styles.online : styles.offline}>
                {session.active ? uiText("● 有效") : uiText("○ 已结束")}
              </span>
              {canEdit && session.active && !session.current ? (
                <UiButton
                  tone="danger"
                  disabled={endSession.isPending}
                  onClick={() => endSession.mutate(session.sid)}
                >
                  {uiText("结束")}</UiButton>
              ) : null}
            </div>
          ))
        )}
        {canEdit ? (
          <div className={styles.rowacts}>
            <UiButton tone="danger" onClick={() => setLogoutOthers(true)}>
              {uiText("除本次外全部退出")}</UiButton>
          </div>
        ) : null}
      </UiCard>

      <McpAccessSection owner={owner} canEdit={canEdit} />

      <TentacleSharingSection
        owner={owner}
        canEdit={canEdit}
        onMessage={(kind, text) => setMessage({ kind, text })}
      />

      </section>
      <section id="permission-panel-activity" role="tabpanel" aria-labelledby="permission-tab-activity" hidden={activeSection !== "activity"}>
      <h2 className={styles.sec}>{uiText("活动记录")}</h2>
      <p className={styles.lead}>{uiText("权限事件，从新到旧。")}</p>
      <div className={styles.filters}>
        <label className="srOnly" htmlFor="filter-subject">
          {uiText("来源")}</label>
        <UiSelect
          id="filter-subject"
          value={filter.subject}
          onValueChange={(subject) => setFilter((f) => ({ ...f, subject }))}
          options={[
            { value: "", label: uiText("全部来源") },
            ...(subjects.data?.subjects ?? []).map((subject) => ({
              value: subject.id,
              label: subject.title,
            })),
          ]}
        />
        <label className="srOnly" htmlFor="filter-decision">
          {uiText("结果")}</label>
        <UiSelect
          id="filter-decision"
          value={filter.decision}
          onValueChange={(decision) => setFilter((f) => ({ ...f, decision }))}
          options={[
            { value: "", label: uiText("全部结果") },
            ...["allow", "deny", "pending", "result", "grant", "revoke", "error"].map(
              (value) => ({ value, label: value }),
            ),
          ]}
        />
        <UiButton onClick={() => setAppliedFilter(filter)}>
          {uiText("筛选")}</UiButton>
      </div>
      <UiCard className={styles.card} styles={{ body: { padding: "6px 8px" } }}>
        <table className={styles.audit}>
          <thead>
            <tr>
              <th>{uiText("时间")}</th>
              <th>{uiText("来源")}</th>
              <th>{uiText("操作")}</th>
              <th>{uiText("结果")}</th>
              <th>{uiText("说明")}</th>
            </tr>
          </thead>
          <tbody>
            {audit.isPending ? (
              <tr>
                <td colSpan={5}>{uiText("加载中…")}</td>
              </tr>
            ) : audit.isError ? (
              <tr>
                <td colSpan={5} className={styles.why}>
                  {errorText(audit.error)}
                </td>
              </tr>
            ) : auditRecords.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.why}>
                  {uiText("还没有记录")}</td>
              </tr>
            ) : (
              auditRecords.map((record) => (
                <tr key={record.id}>
                  <td className={styles.t}>{formatStamp(record.at, 19)}</td>
                  <td>{record.subject_id}</td>
                  <td>{record.operation}</td>
                  <td className={`${styles.dec} ${styles[record.decision] ?? ""}`}>
                    {record.decision}
                  </td>
                  <td className={styles.why}>{record.reason || ""}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {audit.data && auditRecords.length > 0 ? (
          <p className={styles.why} data-testid="audit-paging">
            {audit.hasNextPage
              ? uiText("已加载 {v0} 条；还有更早的记录。", { v0: auditRecords.length })
              : uiText("已加载全部 {v0} 条记录。", { v0: auditRecords.length })}
          </p>
        ) : null}
        {audit.isFetchNextPageError ? <ErrorBox>{errorText(audit.error)}</ErrorBox> : null}
        {audit.hasNextPage ? (
          <UiButton loading={audit.isFetchingNextPage} disabled={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
            {uiText("加载更早的记录")}</UiButton>
        ) : null}
      </UiCard>

      </section>
      <div className={styles.note}>
        <b>{uiText("待批准")}</b>{uiText("调用在顶部“批准”中处理；授权只决定能否发起，不代表免批。")}<br />
        <b>{uiText("撤销立即生效")}</b>{uiText("，并结束相关实时流、待审批调用和临时 Context。")}<br />
        {uiText("部署配置授权只读；未接入执行路径的主体不可编辑。")}</div>

      <Confirm
        open={revokeDevice !== null}
        title={uiText("吊销设备")}
        destructive
        confirmLabel={uiText("吊销")}
        busy={dropDevice.isPending}
        body={uiText("吊销设备「{v0}」？它的连接会被断开，本账号已派生的全部端点权限一并失效。", { v0: revokeDevice ?? "" })}
        onConfirm={() => revokeDevice && dropDevice.mutate(revokeDevice)}
        onCancel={() => setRevokeDevice(null)}
      />
      <Confirm
        open={logoutOthers}
        title={uiText("结束其它登录")}
        destructive
        confirmLabel={uiText("全部退出")}
        busy={endOthers.isPending}
        body={uiText("结束除本次之外的所有浏览器登录？它们派生出的实时流与未决批准卡会一并作废。")}
        onConfirm={() => endOthers.mutate()}
        onCancel={() => setLogoutOthers(false)}
      />
    </div>
  );
}
