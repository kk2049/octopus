import { useEffect, useRef, useState } from "react";
import type {
  ResearchEdge, ResearchNode, ResearchRun, WorkflowFlag, WorkflowSummary, WorkflowTrace,
} from "@claude-bot/research-canvas-contract";
import { AgentDraft } from "./AgentDraft.js";
import { ReviewActions } from "./ReviewActions.js";
import { WorkflowRules } from "./WorkflowRules.js";
import { AgentWindow } from "./windows/AgentWindow.js";
import { persist, stored, type Call } from "./client.js";
import { useWorkflowActions, useWorkflowPage } from "./workflow-client.js";
import "./workflows.css";

type Selection = { kind: "draft" | "run" | "agent" | "flag" | "rule"; id: string } | null;
export interface WorkflowIntent { agent: string; request: number }
type WorkflowState = ReturnType<typeof useWorkflowPage>;
interface WorkflowPanelProps {
  project: string; viewer: string; nodes: ResearchNode[]; edges?: ResearchEdge[]; runs?: ResearchRun[];
  selected?: string[]; call: Call; epoch: number; editable: boolean; runnable: boolean;
  openNode(node: string): void; openAgent?(node: string, conversation?: string): void; openFile?(node: string, path: string): void;
  onSummaries?(summaries: Record<string, WorkflowSummary>): void;
  workflow?: WorkflowState; intent?: WorkflowIntent;
}
/** App navigation shares one metadata read without mounting this detail panel. */
export function WorkflowPanel(props: WorkflowPanelProps) {
  return props.workflow ? <WorkflowContent {...props} workflow={props.workflow} /> : <WorkflowLoader {...props} />;
}
function WorkflowLoader(props: WorkflowPanelProps) {
  const workflow = useWorkflowPage(props.call, props.epoch);
  return <WorkflowContent {...props} workflow={workflow} />;
}
function WorkflowContent({
  project, viewer, nodes, selected = [], call, epoch, editable, runnable, openNode, openFile,
  onSummaries, workflow, intent,
}: WorkflowPanelProps & { workflow: WorkflowState }) {
  const storageKey = "rv:workflow:" + project + ":" + viewer;
  const [tab, setTab] = useState(() => stored(storageKey + ":tab", "agents"));
  const [selection, setSelection] = useState<Selection>(() => stored(storageKey + ":selection", null));
  const [traceSource, setTraceSource] = useState(""), [traceNode, setTraceNode] = useState("");
  const { page, error, refresh } = workflow;
  const appliedIntent = useRef(0);
  useEffect(() => {
    if (!intent || appliedIntent.current === intent.request || !page) return;
    appliedIntent.current = intent.request;
    setTab("agents");
    const latest = page.runs.filter(run => run.node === intent.agent).sort((a, b) => b.at.localeCompare(a.at))[0];
    setSelection(latest ? { kind: "run", id: latest.id } : { kind: "agent", id: intent.agent });
  }, [intent, page]);
  const { run, pending, error: actionError, failure } = useWorkflowActions(call, storageKey);
  useEffect(() => { persist(storageKey + ":selection", selection); }, [storageKey, selection]);
  useEffect(() => { persist(storageKey + ":tab", tab); }, [storageKey, tab]);
  useEffect(() => { if (page) onSummaries?.(page.summaries); }, [page, onSummaries]);
  const showTrace = (source: string, node = "") => { setTraceSource(source); setTraceNode(node); setTab("changes"); };
  const flag = selection?.kind === "flag" ? page?.flags.find(flag => flag.id === selection.id) : undefined;
  const draft = selection?.kind === "draft" ? page?.drafts.find(draft => draft.id === selection.id) : undefined;
  const rule = selection?.kind === "rule" ? page?.rules.find(rule => rule.id === selection.id) : undefined;
  const currentRun = selection?.kind === "run" ? page?.runs.find(run => run.id === selection.id) : undefined;
  const agent = [...(page?.agents ?? []), ...nodes].find(agent => agent.id === (currentRun?.node ?? (selection?.kind === "agent" ? selection.id : "")));
  const selectRun = (agent: string, conversation?: string) => {
    const matching = page?.runs.filter(run => run.node === agent && (!conversation || run.conversation === conversation)).at(-1);
    if (matching) setSelection({ kind: "run", id: matching.id });
  };
  const followup = async (prompt: string) => {
    if (!currentRun) throw new Error("运行已不可用，请刷新历史");
    const result = await run("agent_run_continue", { run: currentRun.id, prompt });
    if (!result) throw new Error(failure.current || "继续未确认；草稿已保留，请重试");
    await refresh(true);
  };
  const activeFlags = page?.flags.filter(flag => flag.state === "open") ?? [];
  return <aside className="rv-workflows" aria-label="Agent 活动与协作">
    <div className="rv-workflow-tabs">{[["agents", "Agent"], ["flags", "待处理 " + activeFlags.length], ["rules", "规则"], ["changes", "来源与改动"]].map(([key, label]) => <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}</div>
    {error && <p role="alert">{error}<button onClick={() => void refresh(true)}>重新读取</button></p>}
    {page?.truncated && <p className="rv-muted">当前显示最近 200 条；对象历史可从原会话继续查看。</p>}
    {!page && !error && <p role="status">正在读取协作活动…</p>}
    {tab === "agents" && <><button disabled={!runnable} onClick={() => setSelection({ kind: "draft", id: "new" })}>新建 Agent 草稿</button>
      <div className="rv-workflow-list" aria-label="Agent 草稿和历史">
        {page?.drafts.filter(draft => draft.status === "draft").map(draft => <button className="rv-workflow-row" key={draft.id} onClick={() => setSelection({ kind: "draft", id: draft.id })}><strong>{draft.title}</strong><span>尚未启动 · {new Date(draft.updated.at).toLocaleString()}</span></button>)}
        {[...(page?.runs ?? [])].sort((a, b) => b.at.localeCompare(a.at)).map(run => <div className="rv-workflow-row" key={run.id}><button onClick={() => setSelection({ kind: "run", id: run.id })}><strong>{page?.drafts.find(draft => draft.conversation === run.conversation)?.title ?? page?.agents.find(agent => agent.id === run.node)?.title ?? run.node}</strong><span>{run.status} · {duration(run)} · {new Date(run.at).toLocaleString()}</span></button><button onClick={() => showTrace("run:" + run.id)}>成果与改动</button></div>)}
        {!page?.drafts.length && !page?.runs.length && <p className="rv-muted">先准备上下文草稿，再明确启动。</p>}
      </div>
      {selection?.kind === "draft" && (draft || selection.id === "new") && <AgentDraft key={selection.id} draft={draft} agents={page?.agents ?? []} nodes={nodes} selected={selected} call={call} storageKey={storageKey} runnable={runnable} onOpen={selectRun} onSaved={draft => { setSelection({ kind: "draft", id: draft.id }); void refresh(true); }} />}
      {agent && <section className="rv-workflow-conversation" aria-label="Agent 原会话"><h3>{agent.title}{currentRun ? " · " + duration(currentRun) : ""}</h3><AgentWindow key={currentRun?.conversation ?? agent.id} node={agent} call={call} epoch={epoch} storageKey={storageKey + ":" + (currentRun?.conversation ?? agent.id)} runnable={runnable} conversationId={currentRun?.conversation} send={currentRun ? followup : undefined} openFile={path => openFile?.(agent.id, path)} />{currentRun && <button onClick={() => showTrace("run:" + currentRun.id)}>查看本次改动</button>}</section>}
    </>}
    {tab === "flags" && <>
      <FlagComposer call={call} storageKey={storageKey} selected={selected} editable={editable} onSaved={() => refresh(true)} />
      <div className="rv-workflow-list">{page?.flags.map(flag => <button key={flag.id} className="rv-workflow-row" onClick={() => setSelection({ kind: "flag", id: flag.id })}><strong>{flag.kind === "review" ? "！" : "？"}{flag.title}</strong><span>{flag.state === "open" ? "待处理" : "已处理"}{flag.affected.length ? " · 影响 " + flag.affected.length + " 项成果" : ""}</span></button>)}</div>
      {flag && <ReviewActions key={flag.id} flag={flag} nodes={nodes} call={call} editable={editable} runnable={runnable} storageKey={storageKey} onOpen={openNode} onSaved={() => { void refresh(true); }} />}
    </>}
    {tab === "rules" && <><button disabled={!editable} onClick={() => setSelection({ kind: "rule", id: "new" })}>新建适用规则</button><div className="rv-workflow-list">{page?.rules.map(rule => <button key={rule.id} className="rv-workflow-row" onClick={() => setSelection({ kind: "rule", id: rule.id })}><strong>{rule.title}</strong><span>{rule.enabled ? "启用" : "已停用"} · {rule.scope.kind} · {rule.enforcement === "block" ? "明确阶段门禁" : "提示检查"}</span></button>)}</div>
      {selection?.kind === "rule" && (rule || selection.id === "new") && <WorkflowRules key={selection.id} rule={rule} rules={page?.rules ?? []} nodes={[...nodes, ...(page?.agents.filter(agent => !nodes.some(node => node.id === agent.id)) ?? [])]} selected={selected} call={call} editable={editable} storageKey={storageKey} onSaved={rule => { setSelection({ kind: "rule", id: rule.id }); void refresh(true); }} />}</>}
    {tab === "changes" && <WorkflowChanges key={traceSource + ":" + traceNode} call={call} source={traceSource} node={traceNode} nodes={nodes} selected={selected} onOpen={openNode} onSource={source => showTrace(source)} />}
    {!!pending && <p role="status">正在提交…</p>}{actionError && <p role="alert">{actionError}</p>}
  </aside>;
}
function duration(run: ResearchRun): string {
  const seconds = Math.max(0, Math.round(((run.finished ? Date.parse(run.finished) : Date.now()) - Date.parse(run.at)) / 1000));
  return seconds < 60 ? seconds + " 秒" : Math.floor(seconds / 60) + " 分 " + seconds % 60 + " 秒";
}
function FlagComposer({ call, storageKey, selected, editable, onSaved }: { call: Call; storageKey: string; selected: string[]; editable: boolean; onSaved(): Promise<void> }) {
  const [kind, setKind] = useState("review"), [title, setTitle] = useState(""), [background, setBackground] = useState("");
  const { run, pending, error } = useWorkflowActions(call, storageKey + ":newflag");
  return <details><summary>显式提出待审问题</summary><label>类型<select value={kind} onChange={event => setKind(event.target.value)}><option value="review">审核结果或风险</option><option value="decision">需要决策的问题</option></select></label><label>问题<input value={title} onChange={event => setTitle(event.target.value)} /></label><label>背景与依据<textarea value={background} onChange={event => setBackground(event.target.value)} /></label><p>关联当前选中的 {selected.length} 个对象；也可以只保留文字问题。</p><button disabled={!editable || !!pending || !title.trim()} onClick={async () => { const result = await run<{ flag: WorkflowFlag }>("review_flag_open", { data: { kind, title, background, related: selected } }); if (result) { setTitle(""); setBackground(""); await onSaved(); } }}>提出问题</button>{error && <p role="alert">{error}</p>}</details>;
}
function WorkflowChanges({ call, source, node, nodes, selected, onOpen, onSource }: { call: Call; source: string; node: string; nodes: ResearchNode[]; selected: string[]; onOpen(node: string): void; onSource(source: string): void }) {
  const [result, setResult] = useState<{ traces: WorkflowTrace[]; next: string | null; suggestions: { batch: string; source: string; pending: { id: string; title: string }[]; published: Record<string, { node: string; ref: string }> }[] } | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [filterSource, setFilterSource] = useState(source), [filterNode, setFilterNode] = useState(node);
  const generation = useRef(0);
  const read = async () => {
    if (busy) return;
    const ticket = ++generation.current; setBusy(true);
    try { const answer = await call<NonNullable<typeof result>>("workflow_trace", { source: filterSource || undefined, node: filterNode || undefined }); if (ticket === generation.current) { setResult(answer); setError(""); } }
    catch (reason) { if (ticket === generation.current) setError(String(reason)); }
    finally { if (ticket === generation.current) setBusy(false); }
  };
  useEffect(() => { void read(); return () => { generation.current++; }; }, [call, source, node]);
  return <section aria-label="来源和改动历史"><label>来源 / Agent / 运行<input value={filterSource} onChange={event => setFilterSource(event.target.value)} /></label><label>对象 ID 或引用<input value={filterNode} onChange={event => setFilterNode(event.target.value)} /></label><button disabled={busy} onClick={() => void read()}>查询来源与改动</button><button disabled={!selected.length} onClick={() => setFilterNode(selected[0])}>选择当前对象</button>
    {result?.traces.map(trace => <article className="rv-workflow-trace" key={trace.id}><p>{new Date(trace.at).toLocaleString()} · {trace.actor.owner} · {trace.action} · {trace.state === "observed" ? "已核对，未改写" : trace.state === "applied" ? trace.outcome === "merged_with_conflicts" ? "已提交，含合并冲突" : "已经生效" : "建议"}</p><div>{trace.sources.map(source => <button key={source} onClick={() => onSource(source)}>{source}</button>)}</div><ul>{trace.targets.map((target, index) => <li key={target.id + ":" + index}>{target.operation} · {target.kind === "edge" ? target.id : <button onClick={() => onOpen(nodes.find(node => node.id === target.id || node.ref === target.id)?.id ?? target.id)}>{nodes.find(node => node.id === target.id || node.ref === target.id)?.title ?? target.id}</button>}</li>)}</ul></article>)}
    {result?.suggestions.map(batch => <details key={batch.batch}><summary>来源候选 · {batch.source}</summary>{batch.pending.map(item => <p key={item.id}>尚未生效 · {item.title}</p>)}{Object.values(batch.published).map(item => <button key={item.node} onClick={() => onOpen(item.node)}>已发布 · {nodes.find(node => node.id === item.node)?.title ?? item.node}</button>)}</details>)}
    {result && !result.traces.length && !result.suggestions.length && <p className="rv-muted">当前筛选下没有改动记录。</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
