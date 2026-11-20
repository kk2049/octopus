import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AgentViewAlerts,
  SplitHandle,
  useAgentViewStatus,
  useProjection,
  useOperations,
  useProposals,
  usePropose,
} from "@claude-bot/agent-view-react";
import {
  DockWorkspaceShell,
  createModuleRegistry,
  createWorkspacePlan,
  useNarrowViewport,
  useWorkspaceLayout,
} from "@claude-bot/agent-view-react/workspace";
import {
  defaultDocumentKey,
  formatTime,
  label,
  registeredLeadAgents,
  navigationDocuments,
  roleLabel,
  rows,
  type ActivityRow,
  type LeadAgentRow,
  type LeadDocumentRow,
  type ProjectRow,
  type ResearchProjection,
  type WorkspaceProjectRow,
} from "./model.js";
import { RESEARCH_PROGRAM_MODULES } from "./modules.js";
import { RESEARCH_DOCUMENT_RESOURCE_KIND, RESEARCH_PROGRAM_COMPOSITION } from "./plan.js";
import { ResearchProgramProvider, ResearchResourcesProvider } from "./runtime.js";
import "./styles/research-program.css";
import { ResearchWorkbench } from "./ResearchWorkbench.js";
import { listedFileContext } from '@claude-bot/agent-file-preview';
import { researchDocumentContext } from './documents-adapter.js';
import { WORKSPACE_MEDIA_RESOURCE_KIND } from '@claude-bot/workspace-files-contract';

type LifecycleDialog = "archive" | "reopen";

export const RESEARCH_PROJECT_NAVIGATE_ACTION = "research.navigate_project";
/** Host-owned, parameterless: the trusted shell appends the next membership window. */
export const RESEARCH_PROJECT_LOAD_MORE_ACTION = "research.load_more_projects";

const WORKSPACE_PLAN = createWorkspacePlan({
  composition: RESEARCH_PROGRAM_COMPOSITION,
  registry: createModuleRegistry(RESEARCH_PROGRAM_MODULES),
});

export function ResearchProgram() {
  const projection = useProjection<ResearchProjection>();
  const propose = usePropose();
  const { proposals, dismiss } = useProposals();
  const transport = useAgentViewStatus();
  const operations = useOperations();
  const narrow = useNarrowViewport(720);
  const workspace = useWorkspaceLayout(WORKSPACE_PLAN, { narrow });
  const [query, setQuery] = useState("");
  const [mobileNavigation, setMobileNavigation] = useState<"projects" | "sources" | null>(null);
  const [sectionOverride, setSection] = useState<"research" | "workspace" | "history" | null>(null);
  const section = sectionOverride ?? "workspace";
  const [profileOpen, setProfileOpen] = useState(false);
  const [connectorOpen, setConnectorOpen] = useState(false);
  const [lifecycleDialog, setLifecycleDialog] = useState<LifecycleDialog | null>(null);
  const [lifecycleReason, setLifecycleReason] = useState("");
  useEffect(() => workspace.dispatch({ type: "viewport", narrow }), [narrow, workspace.dispatch]);

  const channelOpen = transport.phase === "open";
  const project = projection?.project ?? {};
  const navigation = projection?.workspace_navigation;
  const workspaceProjects = rows<WorkspaceProjectRow>(navigation?.projects);
  const controls = projection?.controls ?? {};
  const activity = rows<ActivityRow>(projection?.activity);
  const agentHistory = rows<LeadAgentRow>(projection?.lead_agent_history);
  const documentHistory = rows<LeadDocumentRow>(projection?.lead_document_history);
  const leadAgents = projection ? registeredLeadAgents(projection) : [];
  const projectDocuments = projection ? navigationDocuments(projection) : [];
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  const visibleAgents = leadAgents.filter((row) => !needle || [row.agent_label, row.session_title, row.reason]
    .some((value) => label(value, "").toLocaleLowerCase("zh-CN").includes(needle)));
  const visibleDocuments = projectDocuments.filter((row) => !needle || [row.document_title, row.document_path, row.reason]
    .some((value) => label(value, "").toLocaleLowerCase("zh-CN").includes(needle)));
  const focused = workspace.state.panels.find((panel) => panel.panelId === workspace.state.focused);
  const runtime = useMemo(() => projection ? ({ projection, channelOpen, propose, operations }) : null, [channelOpen, projection, propose, operations]);

  const defaultDocument = projection ? defaultDocumentKey(projection) : null;
  const documentKind = (key: string) => projection?.sources?.[key]?.encoding === 'png-base64' ? WORKSPACE_MEDIA_RESOURCE_KIND : RESEARCH_DOCUMENT_RESOURCE_KIND;
  const openedDefaultDocument = useRef(false);
  useEffect(() => {
    if (!defaultDocument || openedDefaultDocument.current) return;
    if (workspace.state.panels.some(panel => [RESEARCH_DOCUMENT_RESOURCE_KIND, WORKSPACE_MEDIA_RESOURCE_KIND].includes(panel.resourceKind ?? ''))) { openedDefaultDocument.current = true; return; }
    const document = projection?.documents?.find(row => row.key === defaultDocument);
    openedDefaultDocument.current = workspace.api.open({ kind: documentKind(defaultDocument), ref: defaultDocument, label: label(document?.title, '项目文档') }, { slot: 'secondary', context: listedFileContext(researchDocumentContext(document)) });
  }, [defaultDocument, projection?.documents, workspace.api, workspace.state.panels]);

  function latest(action: string) {
    return [...proposals].reverse().find((item) => item.action === action);
  }

  function openSession(row: LeadAgentRow): void {
    if (!row.session_key) return;
    const session = projection?.sessions?.find(item => item.session_key === row.session_key);
    workspace.api.open({ kind: "session", ref: row.session_key, label: label(session?.title, label(row.session_title, row.agent_label)) });
    setSection("workspace");
    setMobileNavigation(null);
  }

  function openDocument(row: LeadDocumentRow): void {
    if (!row.document_key) return;
    workspace.api.open({
      kind: documentKind(row.document_key),
      ref: row.document_key,
      label: label(row.document_title, row.document_path),
    }, { context: listedFileContext(researchDocumentContext(projection?.documents?.find(document => document.key === row.document_key))) });
    setSection("workspace");
    setMobileNavigation(null);
  }

  async function switchProject(row: WorkspaceProjectRow): Promise<void> {
    const ref = row.ref?.trim();
    if (!ref || ref === navigation?.current_ref || !channelOpen) return;
    const previous = latest(RESEARCH_PROJECT_NAVIGATE_ACTION);
    if (previous?.phase === "refused") dismiss(previous.rid);
    await propose(RESEARCH_PROJECT_NAVIGATE_ACTION, { project_ref: ref });
  }

  async function loadMoreProjects(): Promise<void> {
    if (!channelOpen) return;
    const previous = latest(RESEARCH_PROJECT_LOAD_MORE_ACTION);
    if (previous?.phase === "refused") dismiss(previous.rid);
    await propose(RESEARCH_PROJECT_LOAD_MORE_ACTION, {});
  }

  async function submitLifecycle(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!channelOpen || !lifecycleDialog || !lifecycleReason.trim()) return;
    const action = lifecycleDialog === "archive" ? "archive_project" : "reopen_project";
    const previous = latest(action);
    if (previous?.phase === "refused") dismiss(previous.rid);
    const reply = await propose(action, { confirm: "确认", reason: lifecycleReason.trim() });
    if (reply.ok) {
      setLifecycleDialog(null);
      setLifecycleReason("");
    }
  }

  if (!projection) {
    return <div className="research-program__transport" role="status">等待可信科研项目投影…</div>;
  }
  if (projection.available !== true) {
    return <div className="research-program__transport" role="alert">当前没有可用的项目成员证据，未披露项目内容。</div>;
  }

  const lifecycleAction = lifecycleDialog === "archive" ? "archive_project" : "reopen_project";
  const lifecycleProposal = lifecycleDialog ? latest(lifecycleAction) : undefined;
  const navigationProposal = latest(RESEARCH_PROJECT_NAVIGATE_ACTION);
  const loadMoreProposal = latest(RESEARCH_PROJECT_LOAD_MORE_ACTION);

  return (
    <div className={`research-program${mobileNavigation ? ` is-mobile-${mobileNavigation}` : ''}`}>
      <div className="research-program__mobile-navigation" aria-label="手机项目导航">
        <strong>{label(project.title, '科研项目')}</strong>
        <button type="button" aria-expanded={mobileNavigation === 'projects'} aria-controls="research-mobile-projects" onClick={() => setMobileNavigation(v => v === 'projects' ? null : 'projects')}>项目列表</button>
        <button type="button" aria-expanded={mobileNavigation === 'sources'} aria-controls="research-mobile-sources" onClick={() => setMobileNavigation(v => v === 'sources' ? null : 'sources')}>Agent / 文档</button>
      </div>
      <aside id="research-mobile-projects" className="research-program__project-rail" aria-label="科研项目导航">
        <div className="research-program__project-card">
          <div className="research-program__brand">
            <span className="research-program__brand-mark" aria-hidden="true">R</span>
            <div><strong>Research OS</strong><small>自动科研项目台</small></div>
          </div>
          <div className="research-program__project-card-body">
            <small>FUNDED PROJECT</small>
            <strong>{label(project.title, "未命名科研项目")}</strong>
            <span>{label(project.funding_label, "尚未填写资助标识")}</span>
            <div><span className={`research-program__dot ${project.archived ? "is-archived" : ""}`} aria-hidden="true" />{project.archived ? "已归档" : "项目进行中"}</div>
          </div>
        </div>
        <nav className="research-program__projects" aria-label="我的科研项目">
          <header><strong>科研项目</strong><span>{workspaceProjects.length}</span></header>
          {workspaceProjects.map((row) => row.ref ? (
            <button
              type="button"
              key={row.ref}
              aria-current={row.ref === navigation?.current_ref ? "page" : undefined}
              disabled={!channelOpen || navigationProposal?.phase === "inflight"}
              onClick={() => void switchProject(row)}
            >
              <i className={row.archived ? "is-archived" : ""} aria-hidden="true" />
              <span><strong>{label(row.title, "未命名科研项目")}</strong><small>{row.archived ? "已归档" : row.ref === navigation?.current_ref ? "当前项目" : "项目进行中"}</small></span>
            </button>
          ) : null)}
          {!workspaceProjects.length ? <p>项目目录暂不可用；当前项目仍可继续使用。</p> : null}
        </nav>
        <div className="research-program__project-rail-footer">
          <span>项目成员、邀请与创建保留在可信控制栏。</span>
          {navigation?.truncated ? (
            <button
              type="button"
              className="research-program__load-more"
              disabled={!channelOpen || loadMoreProposal?.phase === "inflight"}
              onClick={() => void loadMoreProjects()}
            >
              {loadMoreProposal?.phase === "inflight" ? "正在加载更多项目…" : "加载更多项目"}
            </button>
          ) : null}
          {loadMoreProposal?.phase === "refused" ? <Refusal message={loadMoreProposal.message} onDismiss={() => dismiss(loadMoreProposal.rid)} /> : null}
        </div>
      </aside>

      <SplitHandle axis="x" target="prev" storageKey="research-program.project-rail" min={190} max={360} remainingMin={720} title="拖拽调整项目导航宽度" />

      <aside id="research-mobile-sources" className="research-program__rail" aria-label="主导对象导航">
        <label className="research-program__search">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Agent 或文档" />
        </label>
        <nav className="research-program__directory" aria-label="项目 Agent 与文档">
          <section>
            <header><span aria-hidden="true">A</span><strong>项目 Agent · {visibleAgents.length}</strong></header>
            {visibleAgents.map((row) => row.session_key ? (
              <button
                type="button"
                className="research-program__agent-row"
                key={row.session_key}
                aria-current={focused?.resourceKind === "session" && focused.resourceRef === row.session_key ? "page" : undefined}
                onClick={() => openSession(row)}
              >
                <span className="research-program__agent-avatar is-codex">{label(row.agent_label, "A").slice(0, 1).toUpperCase()}</span>
                <span><strong>{label(row.agent_label, "未命名 Agent")}</strong><small>{label(row.session_title, row.session_key)} · {formatTime(row.at)}</small></span>
                <i className="is-active" aria-label="已绑定项目 Agent" />
              </button>
            ) : null)}
            {!visibleAgents.length ? <p className="research-program__rail-empty">{query ? "没有匹配的 Agent" : "尚未绑定项目 Agent。"}</p> : null}
          </section>
          <section>
            <header><span aria-hidden="true">D</span><strong>项目文档</strong></header>
            {visibleDocuments.map((row) => row.document_key ? (
              <button
                type="button"
                className="research-program__document-row"
                key={row.document_key}
                aria-current={focused?.resourceRef === row.document_key ? "page" : undefined}
                onClick={() => openDocument(row)}
              >
                <span className="research-program__lead-icon is-document">D</span>
                <span><strong>{label(row.document_title, "未命名文档")}</strong><small>{label(row.document_path, row.document_key)} · {formatTime(row.at)}</small></span>
              </button>
            ) : null)}
            {!visibleDocuments.length ? <p className="research-program__rail-empty">{query ? "没有匹配的项目文档" : "尚未发布项目文档。"}</p> : null}
          </section>
        </nav>
        <div className="research-program__rail-footer">
          <button type="button" onClick={() => setConnectorOpen(true)}><span aria-hidden="true">◎</span><span><strong>接力登记规范</strong><small>Codex / Runner / Opus</small></span></button>
          <button type="button" onClick={() => setSection("history")} aria-current={section === "history" ? "page" : undefined}><span aria-hidden="true">↺</span><span><strong>主导历史</strong><small>{agentHistory.length + documentHistory.length} 次登记</small></span></button>
        </div>
      </aside>

      <SplitHandle axis="x" target="prev" storageKey="research-program.lead-rail" min={220} max={420} remainingMin={460} title="拖拽调整主导对象导航宽度" />

      <main className="research-program__main">
        <header className="research-program__toolbar">
          <div className="research-program__view-switch" role="tablist" aria-label="项目视图">
            <button type="button" role="tab" aria-selected={section === "research"} onClick={() => setSection("research")}>科研协作</button>
            <button type="button" role="tab" aria-selected={section === "workspace"} onClick={() => setSection("workspace")}>工作台</button>
            <button type="button" role="tab" aria-selected={section === "history"} onClick={() => setSection("history")}>历史</button>
          </div>
          <span className="research-program__toolbar-grow" />
          <span className="research-program__role">{roleLabel(projection.viewer_role)}</span>
          {controls.can_configure && channelOpen ? <button type="button" onClick={() => setProfileOpen(true)}>项目设置</button> : null}
          {controls.can_archive && channelOpen ? <button type="button" className="is-danger" onClick={() => setLifecycleDialog("archive")}>归档…</button> : null}
          {controls.can_reopen && channelOpen ? <button type="button" onClick={() => setLifecycleDialog("reopen")}>重新开放…</button> : null}
        </header>
        {transport.phase === "closed" ? <div className="research-program__banner is-error" role="alert">可信通道已关闭；保留当前投影，只读展示，不再提交动作。</div> : null}
        {project.archived ? <div className="research-program__banner" role="status">项目已归档：会话、文档与历史保持可读，所有 Agent 更新已冻结。</div> : null}
        <AgentViewAlerts />
        {runtime ? (
          <div hidden={section !== "research"} style={{ minHeight: 0, flex: 1 }}><ResearchProgramProvider value={runtime}><ResearchWorkbench /></ResearchProgramProvider></div>
        ) : null}
        {runtime ? (
          <div hidden={section !== "workspace"} className="research-program__workspace research-program__workspace--dock">
            <ResearchResourcesProvider value={runtime}>
              <DockWorkspaceShell
                plan={WORKSPACE_PLAN}
                state={workspace.state}
                api={workspace.api}
                className="research-program__dock"
                surfaceClassName={{ primary: "av-dock-surface-inset", secondary: "av-dock-surface-inset" }}
                initialMobileSection="main"
                mobileSectionLabels={{ main: "Agent", resource: "文档" }}
              />
            </ResearchResourcesProvider>
          </div>
        ) : null}
        {section === "history" ? <HistoryView activity={activity} agentHistory={agentHistory} documentHistory={documentHistory} onSession={(key) => openSession({ session_key: key })} onDocument={(key) => openDocument({ document_key: key })} /> : null}
      </main>

      {profileOpen ? <ProfileDialog project={project} proposals={proposals} dismiss={dismiss} propose={propose} channelOpen={channelOpen} onClose={() => setProfileOpen(false)} /> : null}
      {connectorOpen ? <ConnectorDialog onClose={() => setConnectorOpen(false)} /> : null}
      {lifecycleDialog ? (
        <Modal title={lifecycleDialog === "archive" ? "归档科研项目" : "重新开放科研项目"} onClose={() => setLifecycleDialog(null)}>
          <form className="research-program__modal-form" onSubmit={submitLifecycle}>
            <p>{lifecycleDialog === "archive" ? "归档会冻结 Agent 发布，但保留所有成员可读的状态与历史。" : "重新开放后，Owner 与 Member 可以再次通过项目动作发布更新。"}</p>
            <label>{lifecycleDialog === "archive" ? "归档原因" : "重开原因"}<textarea required maxLength={500} value={lifecycleReason} onChange={(event) => setLifecycleReason(event.target.value)} /></label>
            {lifecycleProposal?.phase === "refused" ? <Refusal message={lifecycleProposal.message} onDismiss={() => dismiss(lifecycleProposal.rid)} /> : null}
            {!channelOpen ? <div className="research-program__refusal" role="alert">可信通道已关闭，请关闭表单后再重试。</div> : null}
            <div className="research-program__modal-actions"><button type="button" onClick={() => setLifecycleDialog(null)}>取消</button><button type="submit" className={lifecycleDialog === "archive" ? "is-danger" : "is-primary"} disabled={!channelOpen || lifecycleProposal?.phase === "inflight" || !lifecycleReason.trim()}>{lifecycleProposal?.phase === "inflight" ? "提交中…" : lifecycleDialog === "archive" ? "确认归档" : "确认重新开放"}</button></div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

function Refusal({ message, onDismiss }: { message: string; onDismiss(): void }) {
  return <div className="research-program__refusal" role="alert"><span>{message || "动作被可信 Host 拒绝。"}</span><button type="button" onClick={onDismiss}>关闭</button></div>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  return <div className="research-program__backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="research-program__modal" role="dialog" aria-modal="true" aria-labelledby="research-modal-title"><header><div><small>RESEARCH CONTROL</small><h2 id="research-modal-title">{title}</h2></div><button type="button" aria-label="关闭" onClick={onClose}>×</button></header>{children}</section></div>;
}

function ProfileDialog({ project, proposals, dismiss, propose, channelOpen, onClose }: {
  project: ProjectRow;
  proposals: readonly { rid: string; action: string; phase: string; message: string }[];
  dismiss(rid: string): void;
  propose(action: string, params?: Record<string, string>): Promise<{ ok: boolean }>;
  channelOpen: boolean;
  onClose(): void;
}) {
  const [title, setTitle] = useState(project.title ?? "");
  const [funding, setFunding] = useState(project.funding_label ?? "");
  const [summary, setSummary] = useState(project.summary ?? "");
  const proposal = [...proposals].reverse().find((item) => item.action === "configure_project");
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!channelOpen || !title.trim()) return;
    if (proposal?.phase === "refused") dismiss(proposal.rid);
    const reply = await propose("configure_project", { title: title.trim(), funding_label: funding.trim(), summary: summary.trim() });
    if (reply.ok) onClose();
  }
  return <Modal title="项目设置" onClose={onClose}><form className="research-program__modal-form" onSubmit={submit}><p>这只修改共享项目的展示资料；成员授权仍由可信外层实例目录管理。</p><label>项目名称<input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>资助标识<input maxLength={120} value={funding} onChange={(event) => setFunding(event.target.value)} placeholder="计划、Grant 或内部编号" /></label><label>项目简介<textarea maxLength={1200} value={summary} onChange={(event) => setSummary(event.target.value)} /></label>{proposal?.phase === "refused" ? <Refusal message={proposal.message} onDismiss={() => dismiss(proposal.rid)} /> : null}{!channelOpen ? <div className="research-program__refusal" role="alert">可信通道已关闭，请关闭表单后再重试。</div> : null}<div className="research-program__modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit" className="is-primary" disabled={!channelOpen || proposal?.phase === "inflight" || !title.trim()}>{proposal?.phase === "inflight" ? "保存中…" : proposal?.phase === "refused" ? "重新保存" : "保存资料"}</button></div></form></Modal>;
}

function ConnectorDialog({ onClose }: { onClose(): void }) {
  return <Modal title="主导 Agent 接力登记" onClose={onClose}><div className="research-program__connector"><section><span>01</span><div><h3>选择允许的主导者</h3><p>当前只使用 Codex 第一方、Codex 本地 Runner 或 Claude Opus；暂不授权 Fable。</p></div></section><section><span>02</span><div><h3>登记继任会话</h3><p>用户明确要求接力后，继任者通过 <code>app_list</code> 找到项目，再用 <code>app_dispatch</code> 调用 <code>publish_agent_update</code>。</p></div></section><section><span>03</span><div><h3>确认主导关系</h3><p>最后调用 <code>set_lead_agent</code>。左侧列出主导历史，以及通过来源绑定明确选入的关键会话。普通后台 subagent 不自动登记。</p></div></section><aside>界面不再按目录或进程列表猜测主导者。真实工作区与 Runner 能力继续留在可信边界。</aside><div className="research-program__modal-actions"><button type="button" className="is-primary" onClick={onClose}>知道了</button></div></div></Modal>;
}

function HistoryView({ activity, agentHistory, documentHistory, onSession, onDocument }: {
  activity: ActivityRow[];
  agentHistory: LeadAgentRow[];
  documentHistory: LeadDocumentRow[];
  onSession(key: string): void;
  onDocument(key: string): void;
}) {
  return <div className="research-program__history"><section><header><small>LEADERSHIP</small><h2>主导登记历史</h2><p>这里记录明确的主导接棒。其他人工选入的关键会话可从左侧项目 Agent 浏览。</p></header><div className="research-program__history-columns"><div><h3>主导 Agent</h3>{agentHistory.length ? [...agentHistory].reverse().map((row, index) => <article key={`${row.at ?? ""}-${row.session_key ?? index}`}><span className="research-program__lead-icon is-agent">A</span><div><strong>{label(row.agent_label, "未命名 Agent")}</strong><small>{label(row.session_title, row.session_key)} · {formatTime(row.at)}</small><p>{label(row.reason, "未说明原因")}</p><em>{label(row.by, "可信协调器")}</em></div>{row.session_key ? <button type="button" onClick={() => onSession(row.session_key!)}>打开</button> : null}</article>) : <p className="research-program__muted">尚未登记主导 Agent</p>}</div><div><h3>主导文档</h3>{documentHistory.length ? [...documentHistory].reverse().map((row, index) => <article key={`${row.at ?? ""}-${row.document_key ?? index}`}><span className="research-program__lead-icon is-document">D</span><div><strong>{label(row.document_title, "未命名文档")}</strong><small>{label(row.document_path, row.document_key)} · {formatTime(row.at)}</small><p>{label(row.reason, "未说明原因")}</p><em>{label(row.by, "可信协调器")}</em></div>{row.document_key ? <button type="button" onClick={() => onDocument(row.document_key!)}>打开</button> : null}</article>) : <p className="research-program__muted">尚未登记主导文档</p>}</div></div></section><aside><header><small>ACTIVITY</small><h2>项目活动</h2></header>{activity.length ? <ol>{[...activity].reverse().map((row, index) => <li key={`${row.at ?? ""}-${index}`}><i className={`is-${row.type ?? "event"}`} /><div><strong>{label(row.title, "项目更新")}</strong><p>{label(row.detail, "")}</p><small>{formatTime(row.at)} · {label(row.by, "可信协调器")}</small></div></li>)}</ol> : <p className="research-program__muted">尚无项目活动</p>}</aside></div>;
}
