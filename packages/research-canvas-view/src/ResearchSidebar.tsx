import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ResearchNode, ResearchRun } from "@claude-bot/research-canvas-contract";
import { buildHierarchy, nodeMeta } from "./hierarchy.js";
import { persist, stored } from "./client.js";

export type WorkbenchPanel = "sources" | "workflow" | "assets";
type Section = "tree" | "agents" | "files" | "meetings";
interface SidebarProps {
  storageKey: string; projectTitle: string; nodes: ResearchNode[]; agents: ResearchNode[]; runs: ResearchRun[];
  scope: string; selected: string; loading: boolean; collapsed: boolean; narrow: boolean; mobileOpen: boolean;
  searchRequest: number; panel: WorkbenchPanel | ""; pendingFlags: number; pendingProposals: number; runnable: boolean;
  onCollapse(collapsed: boolean): void; onMobileClose(): void; onSearch(): void;
  onNavigate(scope: string): void; onOpen(node: ResearchNode): void; onLocate(node: ResearchNode): void;
  onAgent(node: ResearchNode): void; onPanel(panel: WorkbenchPanel): void; onHistory(): void; onOrganize(): void;
}
const PAGE_SIZE = 8;
const ACTIVE = new Set<ResearchRun["status"]>(["queued", "running", "waiting"]);
const RUN_LABEL: Record<ResearchRun["status"], string> = {
  queued: "等待启动", running: "运行中", waiting: "等待交互", completed: "运行结束 · 待验收",
  failed: "运行失败", cancelled: "已停止", unknown: "状态待核对",
};
const KIND_LABEL: Record<string, string> = { goal: "目标", folder: "子图", task: "任务", agent: "Agent", file: "文件", audio: "会议录音", group: "讨论群", workgroup: "讨论记录", note: "笔记", finding: "结论", review: "审查", adapter: "数据材料" };
function minutes(node: ResearchNode, byId: Map<string, ResearchNode>) {
  const meta = nodeMeta(node);
  return !!meta.discussionSource || ["human", "model"].includes(String(meta.excerptKind))
    && ["audio", "group", "workgroup"].includes(byId.get(String(meta.sourceNode))?.type ?? "");
}
function recent(a: ResearchNode, b: ResearchNode) { return (b.updated.at ?? "").localeCompare(a.updated.at ?? "") || a.title.localeCompare(b.title); }
/** Only project metadata is indexed here; opening a row owns all expensive reads. */
export function ResearchSidebar(props: SidebarProps) { return <Sidebar key={props.storageKey} {...props} />; }
function Sidebar(props: SidebarProps) {
  const { storageKey, nodes, scope, selected, narrow, collapsed, mobileOpen } = props;
  const [folded, setFolded] = useState<Record<string, boolean>>(() => stored(storageKey + ":sections", {}));
  const [branches, setBranches] = useState<Record<string, boolean>>(() => stored(storageKey + ":branches", {}));
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null), surface = useRef<HTMLElement>(null), id = useId();
  const [otherAgents, setOtherAgents] = useState(() => stored(storageKey + ":other-agents", false));
  useEffect(() => { persist(storageKey + ":sections", folded); }, [storageKey, folded]);
  useEffect(() => { persist(storageKey + ":branches", branches); }, [storageKey, branches]);
  useEffect(() => { persist(storageKey + ":other-agents", otherAgents); }, [storageKey, otherAgents]);
  useEffect(() => { if (narrow && mobileOpen) surface.current?.querySelector<HTMLButtonElement>(".rv-nav-heading button")?.focus({ preventScroll: true }); }, [narrow, mobileOpen]);
  useEffect(() => { if (props.searchRequest) input.current?.focus(); }, [props.searchRequest]);
  const hierarchy = useMemo(() => buildHierarchy(nodes), [nodes]);
  const all = useMemo(() => [...new Map([...props.agents, ...nodes].filter(node => !node.archived).map(node => [node.id, node])).values()], [props.agents, nodes]);
  const liveAgents = useMemo(() => {
    const latest = new Map<string, ResearchRun>();
    for (const run of props.runs) if (!latest.has(run.node) || latest.get(run.node)!.at < run.at) latest.set(run.node, run);
    return all.filter(node => node.type === "agent").sort(recent).map(node => ({ node, run: latest.get(node.id) }));
  }, [all, props.runs]);
  const active = liveAgents.filter(item => item.run && ACTIVE.has(item.run.status));
  const others = liveAgents.filter(item => !item.run || !ACTIVE.has(item.run.status));
  const meetings = useMemo(() => nodes.filter(node => !node.archived && (minutes(node, hierarchy.byId) || ["audio", "group", "workgroup"].includes(node.type))).sort((a, b) => Number(minutes(b, hierarchy.byId)) - Number(minutes(a, hierarchy.byId)) || recent(a, b)), [nodes, hierarchy]);
  const files = useMemo(() => nodes.filter(node => !node.archived && !minutes(node, hierarchy.byId) && (["file", "adapter"].includes(node.type) || nodeMeta(node).reportId || nodeMeta(node).cloudDocument)).sort(recent), [nodes, hierarchy]);
  const branch = (node: ResearchNode) => ["goal", "folder"].includes(node.type) || !!hierarchy.children.get(node.id)?.length;
  const roots = hierarchy.roots.filter(branch), trail = new Set(hierarchy.trail(scope).map(node => node.id));
  const kind = (node: ResearchNode) => minutes(node, hierarchy.byId) ? "会议纪要" : KIND_LABEL[node.type] ?? node.type;
  const location = (node: ResearchNode) => hierarchy.trail(node.id).slice(0, -1).map(item => item.title).join(" / ") || "项目总览";
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const found = terms.length ? all.filter(node => {
    const text = [node.title, node.summary, node.ref, node.id, node.created.owner, node.data.path, kind(node), location(node)].join(" ").toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  }).sort((a, b) => Number(b.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) - Number(a.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) || recent(a, b)) : [];
  const closeMobile = () => { if (narrow) props.onMobileClose(); };
  const open = (node: ResearchNode) => { closeMobile(); if (node.type === "agent") props.onAgent(node); else props.onOpen(node); };
  const panel = (value: WorkbenchPanel) => { closeMobile(); props.onPanel(value); };
  const visit = (value: string) => { closeMobile(); props.onNavigate(value); };
  const showSection = (section: Section) => { props.onCollapse(false); setFolded(previous => ({ ...previous, [section]: false })); };
  const more = (key: string, total: number) => (limits[key] ?? PAGE_SIZE) < total && <button className="rv-nav-more" aria-label={`再显示 ${Math.min(PAGE_SIZE, total - (limits[key] ?? PAGE_SIZE))} 项 共 ${total} 项`} onClick={() => setLimits(old => ({ ...old, [key]: (old[key] ?? PAGE_SIZE) + PAGE_SIZE }))}>再显示 {Math.min(PAGE_SIZE, total - (limits[key] ?? PAGE_SIZE))} 项<span>共 {total} 项</span></button>;
  const row = (node: ResearchNode, detail: string, status?: ResearchRun["status"]) => <li className={`rv-nav-row ${selected === node.id ? "is-current" : ""}`} key={node.id}>
    <button className="rv-nav-item" aria-label={`${node.title} · ${detail}`} title={node.title} onClick={() => open(node)}><span className={`rv-nav-glyph ${status && ACTIVE.has(status) ? "is-live" : ""}`}><NavIcon name={node.type === "agent" ? "agent" : minutes(node, hierarchy.byId) ? "minutes" : node.type === "audio" ? "audio" : "file"} /></span><span><strong>{node.title}</strong><small>{detail}</small></span></button>
    {hierarchy.byId.has(node.id) && <button className="rv-nav-locate" aria-label={`在图谱中定位 ${node.title}`} title="在图谱中定位" onClick={() => { closeMobile(); props.onLocate(node); }}><NavIcon name="locate" /></button>}
  </li>;
  const section = (section: Section, label: string, count: number, content: ReactNode) => <section className="rv-nav-section" aria-label={label}>
    <button className="rv-nav-section-toggle" aria-label={`${label} ${count}`} aria-expanded={!folded[section]} aria-controls={`${id}-${section}`} onClick={() => setFolded(previous => ({ ...previous, [section]: !previous[section] }))}><NavIcon name={folded[section] ? "right" : "down"} /><span>{label}</span><span className="rv-nav-count">{count}</span></button>
    {!folded[section] && <div id={`${id}-${section}`}>{content}</div>}
  </section>;
  const treeRows: { node: ResearchNode; depth: number; open: boolean; children: number; path: string }[] = [];
  const treeLimit = limits.tree ?? PAGE_SIZE;
  const pending = [...roots].reverse().map(node => ({ node, depth: 0, ancestors: new Set<string>(), path: "/" + node.id }));
  while (pending.length && treeRows.length < treeLimit + 1) {
    const { node, depth, ancestors, path } = pending.pop()!;
    if (ancestors.has(node.id)) continue;
    const children = (hierarchy.children.get(node.id) ?? []).filter(child => branch(child) && !ancestors.has(child.id) && child.id !== node.id);
    const isOpen = branches[node.id] ?? trail.has(node.id);
    treeRows.push({ node, depth, open: isOpen, children: children.length, path });
    if (isOpen) for (const child of [...children].reverse()) pending.push({ node: child, depth: depth + 1, ancestors: new Set([...ancestors, node.id]), path: path + "/" + child.id });
  }
  return <>
    {narrow && mobileOpen && <button className="rv-nav-backdrop" aria-label="关闭研究导航" onClick={props.onMobileClose} />}
    <aside ref={surface} className={`rv-sidebar ${!narrow && collapsed ? "is-collapsed" : ""}`} hidden={narrow && !mobileOpen} role={narrow ? "dialog" : undefined} aria-modal={narrow && mobileOpen ? true : undefined} aria-label="研究导航" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); if (query) setQuery(""); else if (narrow) props.onMobileClose(); }
      if (event.key === "Tab" && narrow && mobileOpen) {
        const focusable = surface.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,a[href]");
        const first = focusable?.[0], last = focusable?.[focusable.length - 1];
        if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header className="rv-nav-heading"><span className="rv-nav-brand"><NavIcon name="graph" /></span>{(!collapsed || narrow) && <div><strong>研究导航</strong><small title={props.projectTitle}>{props.projectTitle}</small></div>}<button aria-label={narrow ? "收起研究导航" : collapsed ? "展开研究导航" : "收起研究导航"} title={collapsed ? "展开导航" : "收起导航"} onClick={() => narrow ? props.onMobileClose() : props.onCollapse(!collapsed)}><NavIcon name={collapsed && !narrow ? "expand" : "collapse"} /></button></header>
      {!narrow && collapsed ? <nav className="rv-nav-rail" aria-label="导航快捷入口">
        <button aria-label="搜索研究内容" title="搜索 · Ctrl / ⌘ K" onClick={props.onSearch}><NavIcon name="search" /></button>
        <button aria-label="项目总览" title="项目总览" onClick={() => visit("")}><NavIcon name="graph" /></button>
        <button aria-label={`活跃 Agent ${active.length}`} title={`活跃 Agent · ${active.length}`} onClick={() => showSection("agents")}><NavIcon name="agent" />{active.length > 0 && <i />}</button>
        <button aria-label="文件与材料" title="文件与材料" onClick={() => showSection("files")}><NavIcon name="file" /></button>
        <button aria-label="会议纪要" title="会议纪要" onClick={() => showSection("meetings")}><NavIcon name="minutes" /></button>
        <button aria-label="Agent 与审查" title={`Agent 与审查 · ${props.pendingFlags} 项待处理`} onClick={() => panel("workflow")}><NavIcon name="review" />{props.pendingFlags > 0 && <i />}</button>
      </nav> : <>
        <div className="rv-nav-search"><NavIcon name="search" /><input ref={input} aria-label="搜索研究内容" type="search" placeholder="搜索标题、摘要、文件…" value={query} onChange={event => { setQuery(event.target.value); setLimits(old => ({ ...old, search: PAGE_SIZE })); }} onKeyDown={event => {
          if (event.key === "ArrowDown") { event.preventDefault(); surface.current?.querySelector<HTMLButtonElement>(".rv-nav-results .rv-nav-item")?.focus(); }
        }} /><kbd title="Ctrl / Command K">⌘ K</kbd></div>
        <div className="rv-nav-scroll">
          {terms.length ? <section className="rv-nav-results" aria-label="搜索结果" onKeyDown={event => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".rv-nav-item")), index = buttons.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
            if (next < 0) input.current?.focus(); else buttons[Math.min(buttons.length - 1, next)]?.focus();
          }}><div className="rv-nav-search-summary"><span role="status">{props.loading ? "正在读取项目…" : `${found.length} 项匹配`}</span><button onClick={() => { setQuery(""); input.current?.focus(); }}>清除</button></div>
            <ul>{found.slice(0, limits.search ?? PAGE_SIZE).map(node => row(node, `${kind(node)} · ${location(node)}`))}</ul>{!found.length && !props.loading && <p className="rv-nav-empty">没有找到匹配内容。试试关键词或文件路径。</p>}{more("search", found.length)}
          </section> : <>
            <button className={`rv-nav-home ${!scope ? "is-current" : ""}`} aria-current={!scope ? "page" : undefined} onClick={() => visit("")}><NavIcon name="graph" /><span>项目总览</span><small>{nodes.length}</small></button>
            {section("tree", "目标与子图", roots.length, <>{treeRows.length ? <ul className="rv-nav-tree">{treeRows.slice(0, treeLimit).map(({ node, depth, open, children, path }) => <li key={path} style={{ paddingLeft: Math.min(depth, 6) * 12 }}>
              {children ? <button className="rv-nav-branch" aria-label={`${open ? "收起" : "展开"}子图 ${node.title}`} aria-expanded={open} onClick={() => setBranches(old => ({ ...old, [node.id]: !open }))}><NavIcon name={open ? "down" : "right"} /></button> : <span className="rv-nav-branch-leaf" />}
              <button className={scope === node.id ? "is-current" : ""} aria-label={`${node.title} ${hierarchy.children.get(node.id)?.length ?? 0}`} aria-current={scope === node.id ? "page" : undefined} onClick={() => visit(node.id)} title={node.title}><span>{node.title}</span><small>{hierarchy.children.get(node.id)?.length ?? 0}</small></button>
            </li>)}</ul> : <p className="rv-nav-empty">用目标或文件夹组织研究；新建后会出现在这里。</p>}{treeRows.length > treeLimit && <button className="rv-nav-more" onClick={() => setLimits(old => ({ ...old, tree: treeLimit + PAGE_SIZE }))}>显示更多子图</button>}</>)}
            {section("agents", "活跃 Agent", active.length, <><ul>{active.slice(0, limits.agents ?? PAGE_SIZE).map(({ node, run }) => row(node, RUN_LABEL[run!.status], run!.status))}</ul>{!active.length && <p className="rv-nav-empty">{props.loading ? "正在读取活动…" : "当前没有已知活跃的 Agent。"}</p>}{more("agents", active.length)}
              {!!others.length && <><button className="rv-nav-secondary-toggle" aria-label={`其他 Agent ${others.length}`} aria-expanded={otherAgents} onClick={() => setOtherAgents(!otherAgents)}><NavIcon name={otherAgents ? "down" : "right"} />其他 Agent<span>{others.length}</span></button>{otherAgents && <><ul>{others.slice(0, limits.others ?? PAGE_SIZE).map(({ node, run }) => row(node, run ? RUN_LABEL[run.status] : "尚未观测到运行状态", run?.status))}</ul>{more("others", others.length)}</>}</>}
              <button className="rv-nav-section-action" onClick={() => panel("workflow")}>草稿与运行历史 <span>↗</span></button>
            </>)}
            {section("files", "文件与材料", files.length, <><ul>{files.slice(0, limits.files ?? PAGE_SIZE).map(node => row(node, typeof node.data.path === "string" ? node.data.path : kind(node)))}</ul>{!files.length && <p className="rv-nav-empty">项目文件、报告与数据材料会汇集到这里。</p>}{more("files", files.length)}<button className="rv-nav-section-action" aria-label="资源材料" aria-pressed={props.panel === "assets"} onClick={() => panel("assets")}>资源材料 <span>↗</span></button></>)}
            {section("meetings", "会议纪要", meetings.length, <><ul>{meetings.slice(0, limits.meetings ?? PAGE_SIZE).map(node => row(node, `${kind(node)}${nodeMeta(node).acceptanceStatus === "pending" ? " · 待审阅" : ""}`))}</ul>{!meetings.length && <p className="rv-nav-empty">添加会议录音或讨论群，纪要与原始记录会保留在一起。</p>}{more("meetings", meetings.length)}<button className="rv-nav-section-action" aria-label="来源" aria-pressed={props.panel === "sources"} onClick={() => panel("sources")}>来源 <span>录音 / 群聊 ↗</span></button></>)}
          </>}
        </div>
        <footer className="rv-nav-footer"><button aria-label="Agent 与审查" aria-description={`${props.pendingFlags} 项待处理`} aria-pressed={props.panel === "workflow"} onClick={() => panel("workflow")}><NavIcon name="review" /><span>Agent 与审查</span>{props.pendingFlags > 0 && <small className="rv-nav-attention">{props.pendingFlags}</small>}</button><button onClick={() => { closeMobile(); props.onHistory(); }}><NavIcon name="history" /><span>决策与提案</span>{props.pendingProposals > 0 && <small>{props.pendingProposals}</small>}</button><button disabled={!props.runnable} onClick={() => { closeMobile(); props.onOrganize(); }}><NavIcon name="organize" /><span>请 Agent 整理</span></button></footer>
      </>}
    </aside>
  </>;
}
const ICONS: Record<string, ReactNode> = {
  graph: <><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="3" width="6" height="6" rx="1.5" /><rect x="9" y="15" width="6" height="6" rx="1.5" /><path d="M6 9v3h12V9m-6 3v3" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  agent: <><rect x="4" y="7" width="16" height="13" rx="4" /><path d="M12 7V3m-4 9v2m8-2v2m-7 3h6" /></>,
  file: <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M8 12h8m-8 4h6" /></>,
  minutes: <><rect x="4" y="4" width="16" height="17" rx="2" /><path d="M8 2v4m8-4v4M8 11h8m-8 4h8m-8 3h4" /></>,
  audio: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3" /></>,
  review: <><path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7zM12 8v5m0 3h.01" /></>,
  locate: <><circle cx="12" cy="12" r="6" /><path d="M12 2v4m0 12v4M2 12h4m12 0h4m-6-7h.01" /></>,
  history: <><path d="M3 11a9 9 0 1 1 2 7M3 5v6h6m3-4v6l4 2" /></>,
  organize: <><path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z" /></>,
  right: <path d="m9 6 6 6-6 6" />, down: <path d="m6 9 6 6 6-6" />,
  collapse: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16m7-12-3 4 3 4" /></>,
  expand: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16m4-12 3 4-3 4" /></>,
};
function NavIcon({ name }: { name: string }) { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{ICONS[name]}</svg>; }
