import { AppAgentActivity } from "./AppAgentActivity.js";
import { dateLocale } from "../lib/format.js";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, uiMessage, uiValue, type UiTextValue, localizedLabels } from "../i18n/ui-text.js";
import { UiButton, UiDescriptions, UiInput, UiRadio, UiSelect } from "../ui-kit/primitives.js";
/**
 * `/apps/<id>/open` — the trusted shell around ONE declared App's Agent View.
 *
 * Publisher trust and resource authorization are separate decisions. Reviewed
 * resource Apps show server-computed permission counts and link to the existing
 * permission centre; this page never infers or grants their capabilities.
 *
 * ── What is on which side of the line ───────────────────────────────────────
 *
 * Outside the frame: identity, logout, approvals and membership management —
 * all from the app shell, all still working whatever the view does. A declared
 * App may receive a bounded display navigation projection; Research Program's
 * contains only membership-filtered URL lookup refs, titles and archive state.
 * No session id, CSRF secret, per-tab instance handle, member, role, owner or
 * username reaches it: not in its URL (the bare origin), not in its document
 * (this process does not compose it), and not in the boot payload.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorText, request } from "../lib/api.js";
import { appInstanceHandle, bootstrap } from "../lib/bootstrap.js";
import { createProjectionStream, type ProjectionStream } from "../lib/projection-stream.js";
import { createAppHost as createSessionPlusHost, type HostSnapshot, type Proposal } from "../session-plus/app-host.js";
import { useFramePicker } from "../session-plus/use-frame-picker.js";
import { recordAgenticProposal } from "../app/agentic-activity.js";
import { getAppearance, subscribeTheme } from "../styles/themes.js";
import { Status } from "../ui/misc.js";
import type {
  AppOpenAppProps,
  AppOpenConsentProps,
  AppOpenInstancesProps,
  AppOpenJoinProps,
  AppOpenPageProps,
  DeclaredAppIdentityProps,
  ExternalAppHostProps,
  SharedInstanceSummaryProps,
  SharedRoleSeatProps,
  SharedWorkspaceProps,
} from "../contract.js";
import styles from "./AppOpenPage.module.css";

const WORDS = localizedLabels((): Record<string, string> => ({
  idle: uiText("已停止"),
  loading: uiText("加载中…"),
  ready: uiText("已就绪"),
  unavailable: uiText("不可用"),
  degraded: uiText("已崩溃，可点 ♻ 重建"),
}));

function CLOSED_WORDS(): Record<string, UiTextValue> {
  return {
  publisher_trust_revoked: uiMessage("发布者信任已撤销"),
  credential_ended: uiMessage("浏览器会话已结束"),
  instance_expired: uiMessage("应用实例已过期"),
  instance_stale: uiMessage("应用已切换到新的 release"),
  owner_ended: uiMessage("本账号的实例已被结束"),
  service_stopped: uiMessage("服务已停止"),
};
}

const WHY = localizedLabels((): Record<string, string> => ({
  never_decided: uiText("这是你第一次运行这个发布者提供的应用代码。"),
  revoked: uiText("你之前撤销了对这个发布者的信任。"),
  profile_changed: uiText("应用的执行模式发生了变化，需要重新确认。"),
  release_changed: uiText("你只信任了上一个精确 release；当前运行字节已经变化。"),
}));

export type AppVersionAvailabilityMode = "multi_version" | "refresh_required";

export interface TrustedShellVersionApi {
  versionAvailable: {
    availableDigest: string;
    mode: AppVersionAvailabilityMode;
  } | null;
  reloadToAvailableVersion(): void;
}

/** The only version-switching action: a user-triggered reload of the whole trusted page. */
export function reloadToAvailableVersion(): void {
  window.location.reload();
}

export function AppOpenPage() {
  useDashboardLanguage();
  const props = bootstrap.pageProps as AppOpenPageProps;
  if (props.mode === "consent") return <ConsentGate {...props} />;
  if (props.mode === "join" && props.workspace) return <ResearchJoinGate {...props} />;
  if (props.mode === "join") return <JoinGate {...props} />;
  if (props.mode === "instances" && props.workspace) return <ResearchEmptyWorkspace {...props} />;
  if (props.mode === "instances") return <InstancePicker {...props} />;
  return <TrustedShell {...props} />;
}

/** Where this page's four same-origin calls go. The App id is not a secret. */
function route(path: string, app: string): string {
  return `${path}?app=${encodeURIComponent(app)}`;
}

/** The page address that names one shared instance. Both segments are lookup keys. */
function openPath(appId: string, instanceKey: string): string {
  return `/apps/${encodeURIComponent(appId)}/open?instance=${encodeURIComponent(instanceKey)}`;
}

export const RESEARCH_PROJECT_NAVIGATE_ACTION = "research.navigate_project";
/** Host-owned and parameterless: append the next window of the trusted directory. */
export const RESEARCH_PROJECT_LOAD_MORE_ACTION = "research.load_more_projects";
const RESEARCH_PROJECT_REF_MAX = 128;

/**
 * Declassify only the display subset of the trusted membership directory.
 * The URL-safe ref is a lookup key, not the per-tab instance handle. No role,
 * member, creator or management fact has a field in the resulting shape.
 */
export function researchViewProjection(
  projection: unknown,
  workspace: SharedWorkspaceProps | undefined,
  currentInstanceKey: string | undefined,
): unknown {
  if (!workspace) return projection;
  const root = projection && typeof projection === "object" && !Array.isArray(projection)
    ? projection as Record<string, unknown>
    : {};
  const projects = workspace.projects.flatMap((row) => {
    const ref = row.instanceKey;
    if (!ref || ref.length > RESEARCH_PROJECT_REF_MAX) return [];
    const title = (typeof row.title === "string" ? row.title : "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 120) || uiText("未命名科研项目");
    return [{ ref, title, ...(row.archived ? { archived: true } : {}) }];
  });
  const currentRef = currentInstanceKey && projects.some((row) => row.ref === currentInstanceKey)
    ? currentInstanceKey
    : undefined;
  return {
    ...root,
    workspace_navigation: {
      ...(currentRef ? { current_ref: currentRef } : {}),
      projects,
      // "More projects exist than listed": the View offers the Host-owned
      // `research.load_more_projects` proposal while this is set.
      ...(workspace.nextCursor ? { truncated: true } : {}),
    },
  };
}

interface SharedInstanceListAnswer {
  instances?: Array<Record<string, unknown>>;
  next_cursor?: unknown;
}

/**
 * Append the next server window of the membership directory. Rows already
 * listed (the URL's own project is pinned into the first window) keep their
 * place; the server's cursor, not a count, says whether more follow.
 */
export async function loadMoreResearchProjects(
  appId: string,
  workspace: SharedWorkspaceProps,
): Promise<SharedWorkspaceProps> {
  if (!workspace.nextCursor) return workspace;
  const answer = await api<SharedInstanceListAnswer>(
    `/api/apps/${encodeURIComponent(appId)}/shared-instances?cursor=${encodeURIComponent(workspace.nextCursor)}`,
  );
  const known = new Set(workspace.projects.map((row) => row.instanceKey));
  const added: SharedInstanceSummaryProps[] = [];
  for (const row of answer.instances ?? []) {
    const instanceKey = row.instance_key;
    if (typeof instanceKey !== "string" || !instanceKey || known.has(instanceKey)) continue;
    known.add(instanceKey);
    added.push({
      instanceKey,
      createdAt: String(row.created_at ?? ""),
      creator: String(row.creator ?? ""),
      role: String(row.role ?? ""),
      members: Number(row.members) || 0,
      ...(typeof row.title === "string" ? { title: row.title } : {}),
      ...(row.archived === true ? { archived: true } : {}),
      ...(typeof row.activity_at === "string" ? { activityAt: row.activity_at } : {}),
      ...(row.manageable === true ? { manageable: true } : {}),
    });
  }
  const { nextCursor: _consumed, ...rest } = workspace;
  const next = typeof answer.next_cursor === "string" && answer.next_cursor ? answer.next_cursor : undefined;
  return { ...rest, projects: [...workspace.projects, ...added], ...(next ? { nextCursor: next } : {}) };
}

interface ResearchDirectory {
  workspace: SharedWorkspaceProps | undefined;
  /** Read by long-lived closures (the App host's dispatcher and stream). */
  latest: { readonly current: SharedWorkspaceProps | undefined };
  /** Single-flight; resolves with the bounded failure text, or "" when appended. */
  loadMore(): Promise<string>;
  loading: boolean;
  failure: UiTextValue;
}

/**
 * The page's copy of the trusted directory, grown one window per explicit
 * request. Never polled or prefetched; a result that arrives after unmount or
 * after another window replaced the one it extended is dropped.
 */
function useResearchDirectory(
  appId: string,
  initial: SharedWorkspaceProps | undefined,
  onLoaded?: (next: SharedWorkspaceProps) => void,
): ResearchDirectory {
  const [workspace, setWorkspace] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<UiTextValue>("");
  const latest = useRef(initial);
  const inflight = useRef<Promise<string> | null>(null);
  const alive = useRef(true);
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const loadMore = useCallback((): Promise<string> => {
    const base = latest.current;
    if (!base?.nextCursor) return Promise.resolve("");
    if (inflight.current) return inflight.current;
    setLoading(true);
    setFailure("");
    const job = loadMoreResearchProjects(appId, base).then(
      (next) => {
        if (!alive.current || latest.current !== base) return "";
        latest.current = next;
        setWorkspace(next);
        loaded.current?.(next);
        return "";
      },
      (err: unknown) => {
        const text = errorText(err) || uiText("加载更多项目失败");
        if (alive.current) setFailure(text);
        return text;
      },
    ).finally(() => {
      inflight.current = null;
      if (alive.current) setLoading(false);
    });
    inflight.current = job;
    return job;
  }, [appId]);
  return { workspace, latest, loadMore, loading, failure };
}

/** The explicit "next window" control; absent once the directory is complete. */
function LoadMoreProjects({ directory }: { directory: ResearchDirectory }) {
  useDashboardLanguage();
  if (!directory.workspace?.nextCursor) return null;
  return (
    <div className={styles.researchHint}>
      <UiButton disabled={directory.loading} onClick={() => directory.loadMore()}>
        {directory.loading ? uiText("正在加载更多项目…") : uiText("加载更多项目")}
      </UiButton>
      {directory.failure ? <p role="alert">{uiValue(directory.failure)}</p> : null}
    </div>
  );
}

/** Resolve the one Host-owned navigation proposal against the live ACL projection. */
export function researchProjectNavigationPath(
  appId: string,
  workspace: SharedWorkspaceProps | undefined,
  currentInstanceKey: string | undefined,
  proposal: Proposal,
): string | null {
  if (!workspace || proposal.action !== RESEARCH_PROJECT_NAVIGATE_ACTION) return null;
  const keys = Object.keys(proposal.params);
  const ref = proposal.params.project_ref;
  if (keys.length !== 1 || typeof ref !== "string" || !ref || ref.length > RESEARCH_PROJECT_REF_MAX) return null;
  if (ref === currentInstanceKey || !workspace.projects.some((row) => row.instanceKey === ref)) return null;
  return openPath(appId, ref);
}

/**
 * The whole invitation (ADR 0007 P1): this URL, plus being logged in here.
 * There is no invitation object to send and no approval to wait for.
 */
function shareLink(appId: string, instanceKey: string): string {
  return `${location.origin}${openPath(appId, instanceKey)}`;
}

function CopyLink({ href }: { href: string }) {
  useDashboardLanguage();
  const [copied, setCopied] = useState(false);
  return (
    <UiButton
      onClick={() => {
        void navigator.clipboard?.writeText(href).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? uiText("已复制") : uiText("复制分享链接")}
    </UiButton>
  );
}

function roleLabel(role: string): string {
  return role === "owner" ? uiText("所有者") : role === "member" ? uiText("成员") : role === "viewer" ? uiText("查看者") : role;
}

function CreateResearchProject({ app, workspace }: {
  app: DeclaredAppIdentityProps;
  workspace: SharedWorkspaceProps;
}) {
  useDashboardLanguage();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<UiTextValue>("");
  const role = workspace.roles.find((row) => row.role === "owner")
    ?? workspace.roles.find((row) => !row.observer)
    ?? workspace.roles[0];
  if (!role) return null;
  return (
    <div className={styles.researchCreate}>
      <UiButton
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMessage(uiMessage("正在创建项目…"));
          void api<{ instance_key: string }>(
            `/api/apps/${encodeURIComponent(app.stableAppId)}/shared-instances`,
            { method: "POST", json: { role: role.role } },
          ).then(
            (res) => { location.href = openPath(app.stableAppId, res.instance_key); },
            (err) => {
              setBusy(false);
              setMessage(errorText(err) || uiMessage("创建失败"));
            },
          );
        }}
      >
        {busy ? uiText("创建中…") : uiText("＋ 新建科研项目")}
      </UiButton>
      <p className={styles.researchMessage} role="status">{uiValue(message)}</p>
    </div>
  );
}

const RESEARCH_AGENT_OPTIONS = localizedLabels(() => (Object.freeze([
  { id: "codex-gpt-6-astra", title: uiText("Codex 第一方"), detail: uiText("平台默认的第一方 Codex 主导 Agent") },
  { id: "codex-runner-gpt-6-astra", title: uiText("Codex 本地 Runner"), detail: uiText("在已连接的个人 Runner 上继续项目") },
  { id: "claude-opus-4-7", title: "Claude Opus", detail: uiText("通过 Claude Agent SDK 承接主导任务") },
])));

function ResearchAgentAccess() {
  useDashboardLanguage();
  return (
    <details className={styles.researchDisclosure}>
      <summary>{uiText("Agent 接入")}</summary>
      <div className={styles.researchAgentOptions}>
        {RESEARCH_AGENT_OPTIONS().map((option) => (
          <div key={option.id} className={styles.researchAgentOption}>
            <span aria-hidden="true">{option.title.startsWith("Claude") ? "C" : "⌘"}</span>
            <div><b>{option.title}</b><small>{option.detail}</small><code>{option.id}</code></div>
          </div>
        ))}
        <p>{uiText("接力者启动后通过 Apps MCP 登记为主导 Agent；后台 subagent 不登记。当前列表不含 Fable。")}</p>
      </div>
    </details>
  );
}

/**
 * Membership and instance lifecycle stay in same-origin chrome even though the
 * display-only project picker now belongs to the Agent View.
 */
function ResearchProjectControls({ app, workspace, currentInstanceKey, directory }: {
  app: DeclaredAppIdentityProps;
  workspace: SharedWorkspaceProps;
  currentInstanceKey?: string;
  directory: ResearchDirectory;
}) {
  useDashboardLanguage();
  const current = workspace.projects.find((row) => row.instanceKey === currentInstanceKey);
  return (
    <details className={`${styles.menu} ${styles.researchMenu}`}>
      <summary>{uiText("项目协作")}</summary>
      <div className={`${styles.drop} ${styles.researchControlDrop}`}>
        <h2>{uiText("可信项目协作")}</h2>
        <p className={styles.lead}>{uiText("项目列表在 App 内显示；成员、邀请、创建与 Agent 接入仍由本站复核。")}</p>
        {current ? (
          <section className={styles.researchTrustedControls}>
            <p><b>{current.title || uiText("当前项目")}</b><br /><span>{roleLabel(current.role)} · {current.members} {uiText(" 名成员")}</span></p>
            <div className={styles.bar}><CopyLink href={shareLink(app.stableAppId, current.instanceKey)} /></div>
            {current.manageable ? <MemberManager appId={app.stableAppId} instance={current} roles={workspace.roles} /> : null}
          </section>
        ) : null}
        <CreateResearchProject app={app} workspace={workspace} />
        <ResearchAgentAccess />
        <LoadMoreProjects directory={directory} />
      </div>
    </details>
  );
}

function ResearchWorkspaceFrame({
  app,
  workspace: initialWorkspace,
  currentInstanceKey,
  access,
  children,
}: {
  app: DeclaredAppIdentityProps;
  workspace: SharedWorkspaceProps;
  currentInstanceKey?: string;
  access?: ReactNode;
  children: ReactNode;
}) {
  useDashboardLanguage();
  const directory = useResearchDirectory(app.stableAppId, initialWorkspace);
  const workspace = directory.workspace ?? initialWorkspace;
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [accessOpen, setAccessOpen] = useState(true);
  const current = workspace.projects.find((row) => row.instanceKey === currentInstanceKey);
  const invitation = Boolean(currentInstanceKey && !current);
  return (
    <div className={styles.researchShell}>
      <aside className={styles.researchRail} aria-label={uiText("科研项目导航")}>
        <header className={styles.researchBrand}>
          <span aria-hidden="true">🔬</span>
          <div><strong>{uiText("自动科研")}</strong><small>{uiText("项目工作台")}</small></div>
        </header>
        <details
          className={styles.researchDisclosure}
          open={projectsOpen}
          onToggle={(event) => setProjectsOpen(event.currentTarget.open)}
        >
          <summary>{uiText("科研项目 ")}<span>{workspace.projects.length}</span></summary>
          <nav className={styles.researchProjects} aria-label={uiText("我的科研项目")}>
            {workspace.projects.map((row) => (
              <a
                key={row.instanceKey}
                href={openPath(app.stableAppId, row.instanceKey)}
                aria-current={row.instanceKey === currentInstanceKey ? "page" : undefined}
              >
                <span className={row.archived ? styles.projectArchived : styles.projectActive} aria-hidden="true" />
                <span><strong>{row.title || uiText("未命名科研项目")}</strong><small>{row.archived ? uiText("已归档") : uiText("{v0} · {v1} 名成员", { v0: roleLabel(row.role), v1: row.members })}</small></span>
              </a>
            ))}
            {invitation ? (
              <div className={styles.researchInvitation} aria-current="page">
                <span className={styles.projectPending} aria-hidden="true" />
                <span><strong>{uiText("受邀科研项目")}</strong><small>{uiText("加入后显示项目名称")}</small></span>
              </div>
            ) : null}
            {workspace.projects.length === 0 && !invitation ? <p>{uiText("还没有科研项目。")}</p> : null}
          </nav>
        </details>
        <CreateResearchProject app={app} workspace={workspace} />
        <details
          className={styles.researchDisclosure}
          open={accessOpen}
          onToggle={(event) => setAccessOpen(event.currentTarget.open)}
        >
          <summary>{invitation ? uiText("加入项目") : uiText("成员与邀请")}</summary>
          <div className={styles.researchAccess}>
            {current ? (
              <>
                <p><b>{current.title || uiText("当前项目")}</b><br /><span>{roleLabel(current.role)} · {current.members} {uiText(" 名成员")}</span></p>
                <CopyLink href={shareLink(app.stableAppId, current.instanceKey)} />
                {current.manageable ? <MemberManager appId={app.stableAppId} instance={current} roles={workspace.roles} /> : null}
              </>
            ) : null}
            {access}
          </div>
        </details>
        <ResearchAgentAccess />
        <LoadMoreProjects directory={directory} />
      </aside>
      <section className={styles.researchMain}>{children}</section>
    </div>
  );
}

function ResearchJoinChoices({ app, instanceKey, seats }: {
  app: DeclaredAppIdentityProps;
  instanceKey: string;
  seats: SharedRoleSeatProps[];
}) {
  useDashboardLanguage();
  const [message, setMessage] = useState<UiTextValue>("");
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.researchJoinChoices}>
      <p>{uiText("选择一个仍有空位的项目角色。加入成功后，工作台会在原位置打开。")}</p>
      {seats.filter((seat) => seat.joinable !== false).map((seat) => (
        <UiButton
          key={seat.role}
          disabled={busy || seat.taken >= seat.max}
          onClick={() => {
            setBusy(true);
            setMessage(uiMessage("正在加入…"));
            void api(
              `/api/apps/${encodeURIComponent(app.stableAppId)}/shared-instances/${encodeURIComponent(instanceKey)}/join`,
              { method: "POST", json: { role: seat.role } },
            ).then(
              () => location.reload(),
              (err) => {
                setBusy(false);
                setMessage(errorText(err) || uiMessage("加入失败"));
              },
            );
          }}
        >
          {seat.taken >= seat.max ? uiText("{v0} 已满", { v0: roleLabel(seat.role) }) : uiText("以 {v0} 加入", { v0: roleLabel(seat.role) })}
        </UiButton>
      ))}
      <p className={styles.researchMessage} role="status">{uiValue(message)}</p>
    </div>
  );
}

function ResearchJoinGate(props: AppOpenJoinProps) {
  useDashboardLanguage();
  const workspace = props.workspace!;
  return (
    <ResearchWorkspaceFrame
      app={props.app}
      workspace={workspace}
      currentInstanceKey={props.instanceKey}
      access={<ResearchJoinChoices app={props.app} instanceKey={props.instanceKey} seats={props.seats} />}
    >
      <main className={styles.researchLanding}>
        <span aria-hidden="true">↗</span>
        <h1>{uiText("加入后直接进入工作台")}</h1>
        <p>{uiText("项目的最新会话与主导文档会在这里打开；当前尚未向你披露项目内容。")}</p>
      </main>
    </ResearchWorkspaceFrame>
  );
}

function ResearchEmptyWorkspace(props: AppOpenInstancesProps) {
  useDashboardLanguage();
  const workspace = props.workspace!;
  return (
    <ResearchWorkspaceFrame app={props.app} workspace={workspace}>
      <main className={styles.researchLanding}>
        <span aria-hidden="true">◇</span>
        <h1>{uiText("自动科研工作台")}</h1>
        <p>{uiText("创建第一个项目，或打开别人发来的项目链接加入。项目建立后会直接显示最新会话与主导文档。")}</p>
      </main>
    </ResearchWorkspaceFrame>
  );
}

/**
 * A share link landed on an instance the viewer has not joined: pick a free
 * seat. The POST below writes ONE membership row; whether that row opens the
 * state is decided server-side on the reload, by the same door every open goes
 * through. No iframe exists on this page.
 */
function JoinGate(props: AppOpenJoinProps) {
  useDashboardLanguage();
  const app = props.app;
  const [message, setMessage] = useState<UiTextValue>("");
  const [busy, setBusy] = useState(false);
  const join = (role: string): void => {
    setBusy(true);
    setMessage(uiMessage("正在占位…"));
    void api(
      `/api/apps/${encodeURIComponent(app.stableAppId)}/shared-instances/${encodeURIComponent(props.instanceKey)}/join`,
      { method: "POST", json: { role } },
    ).then(
      () => location.reload(),
      (err) => {
        setBusy(false);
        setMessage(errorText(err) || uiMessage("占位失败"));
      },
    );
  };
  return (
    <main className={styles.trustwrap}>
      <section className={styles.trustcard}>
        <div className={styles.eyebrow}>{uiText("共享实例 · 选择角色")}</div>
        <h2>{uiText("加入「")}{app.title}{uiText("」的这个实例？")}</h2>
        <p className={styles.lead}>
          {uiText("所有成员共享状态；动作按用户名记入历史。持有链接可加入开放的角色，其余角色由创建者分配。")}</p>
        <UiDescriptions
          items={[
            { key: "app", label: uiText("应用"), children: <>{app.title} · <code>{app.stableAppId}</code></> },
            { key: "publisher", label: uiText("发布者"), children: <b>{app.publisher}</b> },
            { key: "instance", label: uiText("实例"), children: <code>{props.instanceKey}</code> },
          ]}
        />
        <div className={styles.seats}>
          {props.seats.map((seat) => (
            <div key={seat.role} className={styles.seatRow}>
              <b>{seat.role}</b>
              <span className="small muted">
                {seat.taken}/{seat.max} {uiText(" 已占")}{seat.observer ? uiText(" · 观战角色") : ""}
              </span>
              <span className="grow" />
              {seat.joinable === false ? (
                <span className="small muted">{uiText("由创建者分配")}</span>
              ) : (
                <UiButton disabled={busy || seat.taken >= seat.max} onClick={() => join(seat.role)}>
                  {seat.taken >= seat.max ? uiText("已满") : uiText("以 {v0} 加入", { v0: seat.role })}
                </UiButton>
              )}
            </div>
          ))}
        </div>
        <div className={styles.actions}>
          <a href={`/apps/${encodeURIComponent(app.stableAppId)}/open`}>{uiText("返回我的实例列表")}</a>
        </div>
        <p className={styles.trustMessage} role="status">
          {uiValue(message)}
        </p>
      </section>
    </main>
  );
}

/**
 * A shared-scope App opened with no instance named: this viewer's own
 * memberships, plus one create button per declared role. The instance key is
 * minted server-side; creating seats the creator in the same transaction.
 */
function InstancePicker(props: AppOpenInstancesProps) {
  useDashboardLanguage();
  const app = props.app;
  const [message, setMessage] = useState<UiTextValue>("");
  const [busy, setBusy] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const create = (role: string): void => {
    setBusy(true);
    setMessage(uiMessage("正在创建…"));
    void api<{ instance_key: string }>(
      `/api/apps/${encodeURIComponent(app.stableAppId)}/shared-instances`,
      { method: "POST", json: { role } },
    ).then(
      (res) => {
        location.href = openPath(app.stableAppId, res.instance_key);
      },
      (err) => {
        setBusy(false);
        setMessage(errorText(err) || uiMessage("创建失败"));
      },
    );
  };
  return (
    <main className={styles.trustwrap}>
      <section className={styles.trustcard}>
        <div className={styles.eyebrow}>{uiText("共享实例 · ")}{app.title}</div>
        <h2>{app.stableAppId === "research-v2" ? uiText("选择科研项目") : uiText("选择一个实例，或新开一个")}</h2>
        <p className={styles.lead}>
          {uiText("每个实例有独立状态和成员；分享链接即可邀请本站用户加入。")}</p>
        {props.instances.length === 0 ? (
          <p className="small muted">{uiText("你还没有加入任何实例。")}</p>
        ) : (
          <div className={styles.seats}>
            {props.instances.map((row) => (
              <div key={row.instanceKey} className={styles.seatRow}>
                <a href={openPath(app.stableAppId, row.instanceKey)}>
                  {row.title ? <strong>{row.title}</strong> : app.stableAppId === "research-v2" ? uiText("未命名科研项目") : <code>{row.instanceKey}</code>}
                </a>
                <span className="small muted">
                  {row.role} · {row.members} {uiText(" 名成员 · ")}{row.creator} {uiText(" 建于 ")}{row.createdAt.slice(0, 10)}
                </span>
                <span className="grow" />
                <CopyLink href={shareLink(app.stableAppId, row.instanceKey)} />
                {row.manageable ? (
                  <UiButton onClick={() => setManaging((current) => current === row.instanceKey ? null : row.instanceKey)}>
                    {managing === row.instanceKey ? uiText("收起管理") : uiText("管理成员")}
                  </UiButton>
                ) : null}
                {managing === row.instanceKey ? (
                  <MemberManager appId={app.stableAppId} instance={row} roles={props.roles} />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
      <section className={styles.trustcard}>
        <h2>{uiText("新开一个实例")}</h2>
        <p className={styles.lead}>{uiText("创建后立即以所选角色加入。")}</p>
        <div className={styles.actions}>
          {props.roles.map((spec) => (
            <UiButton key={spec.role} disabled={busy} onClick={() => create(spec.role)}>
              {uiText("以 ")}{spec.role} {uiText(" 新开")}{spec.observer ? uiText("（观战）") : ""}
            </UiButton>
          ))}
        </div>
        <p className={styles.trustMessage} role="status">
          {uiValue(message)}
        </p>
      </section>
      {props.externalHosts?.length ? (
        <ExternalBindings app={app} hosts={props.externalHosts} instances={props.instances} />
      ) : null}
    </main>
  );
}

/**
 * Handing one instance to an external trusted host, and taking it back.
 *
 * Everything dangerous about this screen is server-side, and the screen is
 * written to make that visible rather than to imply otherwise: the host list is
 * the operator's (a person picks an id, never types an origin), the two buttons
 * are two DIFFERENT authorities with two different sentences, and the launch
 * URL is shown ONCE because its fragment is a one-shot secret that the server
 * only stored a digest of.
 */
function ExternalBindings({ app, hosts, instances, compact = false }: {
  app: DeclaredAppIdentityProps;
  hosts: ExternalAppHostProps[];
  instances: AppOpenInstancesProps["instances"];
  compact?: boolean;
}) {
  useDashboardLanguage();
  const [instanceKey, setInstanceKey] = useState(instances[0]?.instanceKey ?? "");
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "");
  const [minted, setMinted] = useState<{ url: string; authority: string; expiresAt: string } | null>(null);
  const [message, setMessage] = useState<UiTextValue>("");
  const [busy, setBusy] = useState(false);
  const [bindings, setBindings] = useState<ExternalBindingRow[] | null>(null);
  const instanceLabel = (key: string): string => {
    const row = instances.find((candidate) => candidate.instanceKey === key);
    return row?.title || (compact ? uiText("当前项目") : key);
  };

  const endpoint = (path: string): string => `/api/app-external/${path}?app=${encodeURIComponent(app.stableAppId)}`;
  const refresh = (): void => {
    void api<{ bindings: ExternalBindingRow[] }>(endpoint("bindings")).then(
      (res) => setBindings(res.bindings),
      (err) => setMessage(errorText(err) || uiMessage("读取绑定失败")),
    );
  };
  // One explicit read on mount. No polling: this list changes only when
  // somebody on this page acts.
  useEffect(refresh, []);

  const mint = (authority: "human" | "agent"): void => {
    setBusy(true);
    setMinted(null);
    setMessage(uiMessage("正在生成一次性启动链接…"));
    void api<{ launch_url: string; authority: string; expires_at: string }>(endpoint("launch"), {
      method: "POST",
      json: { instance_key: instanceKey, host: hostId, authority },
    }).then(
      (res) => {
        setBusy(false);
        setMessage("");
        setMinted({ url: res.launch_url, authority: res.authority, expiresAt: res.expires_at });
        refresh();
      },
      (err) => {
        setBusy(false);
        setMessage(errorText(err) || uiMessage("生成失败"));
      },
    );
  };

  return (
    <section className={`${styles.trustcard} ${compact ? styles.externalCompact : ""}`}>
      <div className={styles.eyebrow}>{uiText("外部宿主 · external-app-host/v1")}</div>
      <h2>{uiText("把某个实例交给外部宿主")}</h2>
      <p className={styles.lead}>
        {uiText("外部宿主嵌入同一 View，不接触本站登录态；一次性令牌仅在 URL fragment 中，兑换后失效。")}</p>
      <div className={styles.memberAdd}>
        <UiSelect
          aria-label={uiText("共享实例")}
          value={instanceKey}
          options={instances.map((row) => ({ value: row.instanceKey, label: `${row.title || row.instanceKey}（${roleLabel(row.role)}）` }))}
          onValueChange={setInstanceKey}
        />
        <UiSelect
          aria-label={uiText("外部宿主")}
          value={hostId}
          options={hosts.map((row) => ({ value: row.id, label: `${row.label} · ${row.origin}` }))}
          onValueChange={setHostId}
        />
        <UiButton disabled={busy || !instanceKey || !hostId} onClick={() => mint("human")}>
          {uiText("生成「我本人操作」绑定")}</UiButton>
        <UiButton className="danger" disabled={busy || !instanceKey || !hostId} onClick={() => mint("agent")}>
          {uiText("另外授予「Agent 提议」绑定")}</UiButton>
      </div>
      <p className="small muted">{uiText("人类绑定与 Agent 提议使用独立凭据，权限不互通。")}</p>
      {minted ? (
        <div className={styles.memberManager}>
          <p className="small">
            <b>{minted.authority === "agent" ? uiText("Agent 提议") : uiText("我本人操作")}</b> {uiText(" 启动链接（")}{new Date(minted.expiresAt).toLocaleString(dateLocale())} {uiText(" 前有效，只显示这一次）：")}</p>
          <UiInput aria-label={uiText("启动链接")} readOnly value={minted.url} onChange={() => {}} />
          <div className={styles.actions}>
            <CopyLink href={minted.url} />
            <a href={minted.url} target="_blank" rel="noreferrer noopener">{uiText("在外部宿主中打开")}</a>
          </div>
        </div>
      ) : null}
      <div className={styles.memberGrid}>
        {(bindings ?? []).map((row) => (
          <div className={styles.memberRow} key={row.credential_id}>
            <b>{row.authority === "agent" ? uiText("Agent 提议") : uiText("我本人操作")}</b>
            <span className="small muted">
              {row.host_origin} · {instanceLabel(row.instance)} · {row.status}
              {row.last_used_at ? uiText(" · 最近使用 {v0}", { v0: row.last_used_at.slice(0, 19).replace("T", " ") }) : uiText(" · 从未使用")}
            </span>
            <span className="grow" />
            {row.status === "active" ? (
              <UiButton
                className="danger"
                onClick={() => {
                  void api(endpoint("revoke"), { method: "POST", json: { credential_id: row.credential_id } }).then(
                    refresh,
                    (err) => setMessage(errorText(err) || uiMessage("撤销失败")),
                  );
                }}
              >
                {uiText("撤销")}</UiButton>
            ) : <span className="small muted">{uiText("已失效")}</span>}
          </div>
        ))}
        {bindings && bindings.length === 0 ? <p className="small muted">{uiText("还没有任何外部绑定。")}</p> : null}
      </div>
      <p className={styles.trustMessage} role="status">{uiValue(message)}</p>
    </section>
  );
}

interface ExternalBindingRow {
  credential_id: string;
  instance: string;
  authority: string;
  host: string;
  host_origin: string;
  status: string;
  last_used_at: string | null;
}

function MemberManager({ appId, instance, roles }: {
  appId: string;
  instance: AppOpenInstancesProps["instances"][number];
  roles: AppOpenInstancesProps["roles"];
}) {
  useDashboardLanguage();
  const [username, setUsername] = useState("");
  const [selectedUsername, setSelectedUsername] = useState("");
  const [role, setRole] = useState(roles.find((row) => !row.observer)?.role ?? roles[0]?.role ?? "");
  const [message, setMessage] = useState<UiTextValue>("");
  const [candidates, setCandidates] = useState<Array<{ username: string; display_name: string }>>([]);
  const [searching, setSearching] = useState(false);
  const endpoint = `/api/apps/${encodeURIComponent(appId)}/shared-instances/${encodeURIComponent(instance.instanceKey)}`;
  useEffect(() => {
    const query = username.trim();
    if (!query || query === selectedUsername) {
      setCandidates([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      void api<{ candidates?: Array<{ username?: string; display_name?: string }> }>(
        `${endpoint}/member-candidates?q=${encodeURIComponent(query)}`,
        { signal: controller.signal },
      ).then(
        (result) => {
          setCandidates((result.candidates ?? []).flatMap((row) => row.username
            ? [{ username: row.username, display_name: row.display_name || row.username }]
            : []));
          setSearching(false);
        },
        (error) => {
          if (controller.signal.aborted) return;
          setCandidates([]);
          setSearching(false);
          setMessage(errorText(error) || uiMessage("用户搜索失败"));
        },
      );
    }, 160);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, selectedUsername, username]);
  const mutate = (path: string, json?: Record<string, unknown>) => {
    setMessage(uiMessage("正在更新…"));
    void api(`${endpoint}/${path}`, { method: "POST", ...(json ? { json } : {}) }).then(
      () => location.reload(),
      (error) => setMessage(errorText(error) || uiMessage("更新失败")),
    );
  };
  return (
    <div className={styles.memberManager}>
      <div className={styles.memberGrid}>
        {(instance.memberRows ?? []).map((member) => (
          <div className={styles.memberRow} key={member.username}>
            <b>{member.username}</b>
            <span className="small muted">{member.role}</span>
            <span className="grow" />
            {member.username !== instance.creator ? (
              <UiButton className="danger" onClick={() => mutate("members/remove", { username: member.username })}>{uiText("移除")}</UiButton>
            ) : <span className="small muted">{uiText("创建者")}</span>}
          </div>
        ))}
      </div>
      <div className={styles.memberAdd}>
        <div className={styles.memberLookup}>
          <UiInput
            aria-label={uiText("搜索成员")}
            aria-autocomplete="list"
            aria-controls="member-candidates"
            aria-expanded={candidates.length > 0}
            role="combobox"
            placeholder={uiText("输入姓名、用户名或首字母")}
            value={username}
            maxLength={64}
            onChange={(event) => {
              setSelectedUsername("");
              setCandidates([]);
              setUsername(event.target.value);
            }}
          />
          {searching ? <span className={styles.memberLookupStatus} role="status">{uiText("正在联想…")}</span> : null}
          {candidates.length ? (
            <div id="member-candidates" className={styles.memberCandidates} role="listbox" aria-label={uiText("成员联想结果")}>
              {candidates.map((candidate) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={candidate.username === username}
                  key={candidate.username}
                  onClick={() => {
                    setSelectedUsername(candidate.username);
                    setUsername(candidate.username);
                    setCandidates([]);
                  }}
                >
                  <b>{candidate.display_name}</b><span>@{candidate.username}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <UiSelect
          aria-label={uiText("成员角色")}
          value={role}
          options={roles.map((row) => ({ value: row.role, label: `${row.role}${row.observer ? uiText("（只读）") : ""}` }))}
          onValueChange={setRole}
        />
        <UiButton disabled={!username.trim() || !role} onClick={() => mutate("members", { username: username.trim(), role })}>{uiText("添加 / 改角色")}</UiButton>
        <UiButton className="danger" onClick={() => mutate("close")}>{uiText("关闭空间")}</UiButton>
      </div>
      <p className={styles.trustMessage} role="status">{uiValue(message)}</p>
    </div>
  );
}

function AppResourcePermissions({ app }: { app: DeclaredAppIdentityProps }) {
  useDashboardLanguage();
  const permissions = app.resourcePermissions;
  if (!permissions?.requestedCount) {
    return <p className={styles.lead}>{uiText("该 App 当前未申请额外的用户资源权限。")}</p>;
  }
  return <div>
    <p className={styles.lead}>{uiText("申请 {v0} 项资源权限，已授权 {v1} 项，当前有效 {v2} 项。", {
      v0: permissions.requestedCount, v1: permissions.grantedCount, v2: permissions.effectiveCount,
    })}</p>
    <p className={styles.lead}>{uiText("请在权限中心找到「{v0}」，勾选所需操作并保存，然后返回项目重试。", { v0: app.title })}</p>
    <a href="/permissions?view=grants" target="_blank" rel="noopener noreferrer">{uiText("权限中心")}</a>
  </div>;
}

/** The first door. No App code is mounted until this succeeds. */
function ConsentGate(props: AppOpenConsentProps) {
  useDashboardLanguage();
  const [policy, setPolicy] = useState<"exact" | "publisher">("exact");
  const [message, setMessage] = useState<UiTextValue>("");
  const [busy, setBusy] = useState(false);
  const app = props.app;

  return (
    <main className={styles.trustwrap}>
      <section className={styles.trustcard}>
        <div className={styles.eyebrow}>{uiText("第一道门 · 发布者信任")}</div>
        <h2>{uiText("是否运行「")}{app.title}」？</h2>
        <p className={styles.lead}>
          {WHY()[props.reason] ?? props.reason} {uiText("信任发布者只允许加载应用代码；资源权限需要另行授权。")}</p>
        <AppResourcePermissions app={app} />
        <UiDescriptions
          items={[
            { key: "app", label: uiText("应用"), children: <>{app.title} · <code>{app.stableAppId}</code></> },
            { key: "publisher", label: uiText("发布者"), children: <b>{app.publisher}</b> },
            { key: "profile", label: uiText("执行模式"), children: uiText("运行发布者提供的应用代码；使用当前账户已授权的数据与能力。") },
            { key: "package", label: "package", children: <code>{app.packageDigest}</code> },
            { key: "origin", label: uiText("View 来源"), children: <code>{app.viewOrigin}</code> },
          ]}
        />
        <p className={styles.warning}>{uiText("撤销只影响未来运行，无法收回已披露数据。")}</p>
      </section>
      <section className={`${styles.trustcard} ${styles.choices}`}>
        <UiRadio
            name="policy"
            value="exact"
            checked={policy === "exact"}
            onChange={() => setPolicy("exact")}
          >
          <span>
            <b>{uiText("只信任这个精确 release")}</b>
            <small>{uiText("package digest 变化时再次询问。")}</small>
          </span>
        </UiRadio>
        <UiRadio
            name="policy"
            value="publisher"
            checked={policy === "publisher"}
            onChange={() => setPolicy("publisher")}
          >
          <span>
            <b>{uiText("信任该发布者的后续更新")}</b>
            <small>{uiText("同一发布者和执行模式的更新继续运行。")}</small>
          </span>
        </UiRadio>
        <div className={styles.actions}>
          <UiButton
            id="trustApp"
            data-testid="trust-app"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setMessage(uiMessage("正在记录你的决定…"));
              void api(route("/api/app-view/trust", app.stableAppId), {
                method: "POST",
                json: { decision: "trust", follow_updates: policy === "publisher" },
              }).then(
                () => location.reload(),
                (err) => {
                  setBusy(false);
                  setMessage(errorText(err) || uiMessage("记录失败"));
                },
              );
            }}
          >
            {uiText("信任并继续")}</UiButton>
          <a href="/apps">{uiText("暂不运行，返回应用列表")}</a>
        </div>
        <p className={styles.trustMessage} role="status">
          {uiValue(message)}
        </p>
      </section>
    </main>
  );
}

function TrustedShell(props: AppOpenAppProps) {
  useDashboardLanguage();
  const app = props.app;
  const slotRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<ReturnType<typeof createSessionPlusHost> | null>(null);
  // One projection decoder per document: the stream rebuilds patched frames on
  // it, and act replies are patched against the frame it holds.
  const projectionsRef = useRef<ProjectionStream | null>(null);
  projectionsRef.current ??= createProjectionStream();
  const projections = projectionsRef.current;
  const onDebugEvent = useFramePicker(hostRef);
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [backend, setBackend] = useState<{ ok: boolean; word: UiTextValue }>({ ok: true, word: uiMessage("应用后端已连接") });
  const [consentMessage, setConsentMessage] = useState<UiTextValue>("");
  const [versionAvailable, setVersionAvailable] = useState<TrustedShellVersionApi["versionAvailable"]>(null);
  const versionApi: TrustedShellVersionApi = { versionAvailable, reloadToAvailableVersion };
  // The newest undecorated projection the host accepted (stream frame or act
  // reply, by the host's own revision rule). A newly loaded directory window is
  // re-declared over THIS, so it never rolls the View back to an older frame.
  const shownProjection = useRef<{ projection: unknown; revision?: number }>({ projection: props.projection });
  const remember = (projection: unknown, revision: number | undefined): void => {
    const held = shownProjection.current.revision;
    if (revision === undefined || held === undefined || revision > held) {
      shownProjection.current = { projection, ...(revision === undefined ? {} : { revision }) };
    }
  };
  const directory = useResearchDirectory(app.stableAppId, props.workspace, (next) => {
    hostRef.current?.update(researchViewProjection(shownProjection.current.projection, next, props.instanceKey));
  });

  // One host per mount. The instance handle is read from the module that owns
  // it, never threaded through props, and the dispatcher below is the ONLY
  // place it is used besides the stream.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const instance = appInstanceHandle();
    const host = createSessionPlusHost({
      doc: document,
      win: window,
      slot,
      appId: app.stableAppId,
      packageDigest: app.packageDigest,
      appOrigin: app.viewOrigin,
      appUrl: app.viewUrl,
      onDebugEvent,
      projection: researchViewProjection(props.projection, directory.latest.current, props.instanceKey),
      // The outer shell's current theme, wrapped in the wire contract id so
      // the View has classic/aurora/ink in hand for its first paint (ticket
      // #45). Live changes are pushed by the subscription below.
      appearance: getAppearance(),
      onChange: (next) => {
        setSnapshot(next);
        recordAgenticProposal({ id: app.stableAppId, title: app.title }, next);
      },
      dispatch: async (proposal: Proposal) => {
        if (proposal.action === RESEARCH_PROJECT_LOAD_MORE_ACTION && directory.latest.current) {
          if (Object.keys(proposal.params).length !== 0) {
            return { ok: false, code: "invalid_params", message: uiText("加载更多项目不接受参数。") };
          }
          const failure = await directory.loadMore();
          return failure ? { ok: false, code: "project_directory_unavailable", message: failure } : { ok: true };
        }
        if (proposal.action === RESEARCH_PROJECT_NAVIGATE_ACTION) {
          const target = researchProjectNavigationPath(app.stableAppId, directory.latest.current, props.instanceKey, proposal);
          if (!target) {
            return {
              ok: false,
              code: "project_not_available",
              message: uiText("该项目不在当前授权目录中，请刷新页面后重试。"),
            };
          }
          window.location.assign(target);
          return { ok: true };
        }
        try {
          const held = projections.act();
          const res = await request(route("/api/app-view/act", app.stableAppId), {
            method: "POST",
            json: { action: proposal.action, params: proposal.params },
            headers: instance ? { ...held.headers, "x-app-instance": instance } : {},
          });
          const text = await res.text();
          let value: Record<string, unknown>;
          try {
            value = text ? held.rebuild(JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            value = { error: uiText("服务返回了无法解析的结果") };
          }
          if (!res.ok && res.status >= 500) throw new Error(String(value.error || uiText("请求失败")));
          setBackend({ ok: true, word: uiMessage("应用后端已连接") });
          if (!res.ok) {
            return {
              ok: false,
              code: String(value.code || "request_refused"),
              message: String(value.error || uiText("请求被拒绝")),
            };
          }
          if (directory.latest.current && Object.prototype.hasOwnProperty.call(value, "projection")) {
            // An act reply's projection replaces the View's frame too: declare
            // the same trusted navigation on it as on every stream frame.
            remember(value.projection, typeof value.revision === "number" ? value.revision : undefined);
            value = { ...value, projection: researchViewProjection(value.projection, directory.latest.current, props.instanceKey) };
          }
          return value as { ok?: boolean };
        } catch (err) {
          setBackend({ ok: false, word: uiMessage("应用后端不可用") });
          return { ok: false, code: "backend_unavailable", message: errorText(err) || uiText("应用后端暂时不可用") };
        }
      },
      // Deliberately absent: `resetResources`. That epoch exists so a rebuilt
      // view cannot keep reading through the previous view's resource handles,
      // and a declared App has no resource handles to invalidate.
    });
    hostRef.current = host;
    host.mount();
    // Live theme changes (this tab's picker, or a `storage` event bridged in
    // from a sibling tab) forward to the iframe over the same MessagePort.
    // The subscription NEVER fires synchronously — the initial theme was
    // already sent on the boot payload above.
    const offTheme = subscribeTheme((appearance) => {
      hostRef.current?.updateAppearance(appearance);
    });
    return () => {
      offTheme();
      hostRef.current = null;
      host.dispose(uiMessage("页面已离开"));
    };
    // The host owns a DOM node and a channel; it is created once for the life of
    // this screen. Re-running on prop identity would tear down the live view.
  }, []);

  // The projection stream. `fetch` + a reader rather than `EventSource` because
  // the instance handle must ride in a header, and `EventSource` cannot set one.
  useEffect(() => {
    const instance = appInstanceHandle();
    let stopped = false;
    let controller: AbortController | null = null;
    let retryTimer: number | null = null;
    let attempt = 0;

    function consume(block: string): void {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.slice(0, 6) === "event:") event = line.slice(6).trim();
        if (line.slice(0, 5) === "data:") data.push(line.slice(5).trim());
      }
      if (!data.length) return;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(data.join("\n")) as Record<string, unknown>;
      } catch {
        return;
      }
      const frame = projections.read(event, value);
      if (frame === null) {
        // A patch that does not fit this tab's frame: reconnect for a full one.
        controller?.abort();
        throw new Error("projection stream resync");
      }
      if (frame) {
        remember(frame.projection, frame.revision);
        hostRef.current?.update(
          researchViewProjection(frame.projection, directory.latest.current, props.instanceKey),
          frame.revision,
        );
      }
      if (
        event === "release_available"
        && value.current_package_digest === app.packageDigest
        && typeof value.available_package_digest === "string"
        && (value.mode === "multi_version" || value.mode === "refresh_required")
      ) {
        // Chrome state only. In particular: no reload, reconstruct, iframe
        // replacement or src mutation occurs on this notification path.
        setVersionAvailable({
          availableDigest: value.available_package_digest,
          mode: value.mode,
        });
      }
      if (event === "closed") {
        stopped = true;
        setBackend({ ok: false, word: CLOSED_WORDS()[String(value.reason ?? "")] ?? uiMessage("此实例已关闭") });
      }
    }

    async function connect(): Promise<void> {
      if (stopped) return;
      controller = new AbortController();
      try {
        const res = await request(route("/api/app-view/stream", app.stableAppId), {
          headers: { ...projections.headers(), ...(instance ? { "x-app-instance": instance } : {}) },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error("stream unavailable");
        attempt = 0;
        setBackend({ ok: true, word: uiMessage("应用后端已连接") });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const part = await reader.read();
          if (part.done) throw new Error("stream ended");
          buffer += decoder.decode(part.value, { stream: true });
          let split: number;
          while ((split = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const block = buffer.slice(0, split);
            const match = /^\r?\n\r?\n/.exec(buffer.slice(split));
            buffer = buffer.slice(split + (match ? match[0].length : 2));
            consume(block);
          }
        }
      } catch (err) {
        if (stopped || (err as Error)?.name === "AbortError") return;
        setBackend({ ok: false, word: uiMessage("状态流重连中…") });
        const delay = Math.min(10_000, 500 * 2 ** attempt++);
        retryTimer = window.setTimeout(() => void connect(), delay);
      }
    }

    void connect();

    // A closed tab must release its instance; `keepalive` is what makes the
    // request survive the unload.
    const onHide = () => {
      stopped = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      controller?.abort();
      void request(route("/api/app-view/close", app.stableAppId), {
        method: "POST",
        headers: instance ? { "x-app-instance": instance } : {},
        keepalive: true,
      }).catch(() => {});
    };
    // A page restored from the back/forward cache would revive a handle this
    // page deliberately closed, and skip the server's current decision.
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      stopped = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      controller?.abort();
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  // The trusted side's own account of what it did, written where anything on
  // this origin can read it — a MessagePort boundary has no other external
  // observer, so "the view proposed X and we refused it" is otherwise
  // unobservable from outside the two documents.
  useEffect(() => {
    const body = document.body;
    body.setAttribute("data-app-state", snapshot?.state ?? "loading");
    body.setAttribute("data-app-generation", String(snapshot?.generation ?? 0));
    body.setAttribute("data-app-accepted", String(snapshot?.accepted ?? 0));
    body.setAttribute("data-app-refused", String(snapshot?.refused ?? 0));
    body.setAttribute("data-app-ignored", String(snapshot?.ignored ?? 0));
  }, [snapshot]);

  const state = snapshot?.state ?? "loading";
  const versionStatus = versionApi.versionAvailable?.mode === "refresh_required"
    ? uiText("应用有新版本；继续提交前必须显式刷新整个页面。")
    : versionApi.versionAvailable
      ? uiText("应用有新版本；可在安全位置显式刷新整个页面。")
      : "";
  const content = (
    <>
      <div
        className={styles.trustbar}
        aria-label={uiText("应用可信控制栏")}
        data-version-available={versionApi.versionAvailable?.mode}
      >
        <span className="srOnly" role="status" aria-live="polite" aria-label={uiText("应用版本状态")}>
          {versionStatus}
        </span>
        <div className={styles.core}>
          <span aria-hidden="true">📦</span>
          <strong>{app.title}</strong>
          <span className="small muted">{uiText("被声明的 App")}</span>
        </div>
        <div className={styles.statuses}>
          <span className={`${styles.state} ${styles[state] ?? ""}`} title={uiValue(snapshot?.notice ?? snapshot?.detail) || ""}>
            {WORDS()[state] ?? state}</span>
          <span className={`${styles.state} ${backend.ok ? styles.ready : styles.unavailable}`}>{uiValue(backend.word)}</span>
        </div>
        {/* The same sentence, visible: "refresh before submitting" must not
            be something only a screen reader is told. The live region above
            stays the announcement; this copy is hidden from it. */}
        {versionStatus ? (
          <span className={styles.versionNotice} data-mode={versionApi.versionAvailable?.mode}
            data-testid="app-version-notice" aria-hidden="true">{versionStatus}</span>
        ) : null}
        <span className={styles.trustGrow} />

        <div className={styles.tools}>
          {app.resourcePermissions?.requestedCount ? (
            <a href="/permissions?view=grants" target="_blank" rel="noopener noreferrer">{uiText("权限中心")}</a>
          ) : null}
          {props.workspace ? (
            <ResearchProjectControls app={app} workspace={directory.workspace ?? props.workspace} currentInstanceKey={props.instanceKey} directory={directory} />
          ) : null}
          <details className={styles.menu}>
            <summary>{uiText("应用信息")}</summary>
          <div className={styles.drop}>
            <h2>📦 {app.title}</h2>
            <p className={styles.lead}>
              {uiText("运行发布者提供的应用代码；使用当前账户已授权的数据与能力。")}</p>
            <AppResourcePermissions app={app} />
            <dl className={styles.facts}>
              <dt>{uiText("稳定 App ID")}</dt>
              <dd>{app.stableAppId}</dd>
              <dt>{uiText("发布者")}</dt>
              <dd>{app.publisher}</dd>
              <dt>{uiText("包摘要")}</dt>
              <dd>{app.packageDigest}</dd>
              <dt>{uiText("View 来源")}</dt>
              <dd>{app.viewOrigin}</dd>
              {props.instanceKey && !props.workspace ? (
                <>
                  <dt>{uiText("共享实例")}</dt>
                  <dd>{props.instanceKey}</dd>
                </>
              ) : null}
            </dl>
            <div className={styles.bar}>
              <a href="/apps">{uiText("应用发布管理")}</a>
              {props.instanceKey ? <CopyLink href={shareLink(app.stableAppId, props.instanceKey)} /> : null}
              <span className="grow" />
              {props.trustReason === "first_party" ? null : (
                <UiButton
                  className="danger"
                  onClick={() => {
                    setConsentMessage(uiMessage("正在记录…"));
                    void api(route("/api/app-view/trust", app.stableAppId), {
                      method: "POST",
                      json: { decision: "revoke" },
                    }).then(
                      () => location.reload(),
                      (err) => setConsentMessage(errorText(err) || uiMessage("操作失败")),
                    );
                  }}
                >
                  {uiText("撤销发布者信任")}</UiButton>
              )}
            </div>
            {uiValue(consentMessage) ? <Status kind="err">{uiValue(consentMessage)}</Status> : null}
          </div>
          </details>

          <UiButton
            id="appReconstruct"
            className={styles.icon}
            title={uiText("重建 Agent View")}
            aria-label={uiText("重建 Agent View")}
            onClick={() => void hostRef.current?.reconstruct()}
          >
            ♻
          </UiButton>
        </div>
      </div>

      <AppAgentActivity appId={app.stableAppId} />
      <main className={`${styles.workspace} appwrap`} aria-label={uiText("Agent View 工作区")}>
        <div className={styles.slot} ref={slotRef}>
          {snapshot?.element}
          {state === "ready" ? null : (
            <div className={styles.empty}>{uiValue(snapshot?.notice ?? snapshot?.detail) || WORDS()[state] || uiText("正在加载 Agent View…")}</div>
          )}
        </div>
      </main>
    </>
  );
  return content;
}
