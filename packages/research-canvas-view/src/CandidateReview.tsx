import { useEffect, useState } from "react";
import type { WorkflowBatch, WorkflowCandidate, WorkflowExecution, WorkflowPage } from "@claude-bot/research-canvas-contract";
import { persist, stored, type Call } from "./client.js";
import { useWorkflowActions, useWorkflowPage } from "./workflow-client.js";

export function CandidateReview({ source, batch, call, editable, runnable, onOpen, epoch = 0, storageKey, defaultAgent }: {
  source?: string; batch?: string; call: Call; editable: boolean; runnable: boolean; onOpen(node: string): void; epoch?: number; storageKey: string; defaultAgent?: string;
}) {
  const { page, error, refresh } = useWorkflowPage(call, epoch, source);
  const batches = page?.batches.filter(item => !batch || item.id === batch) ?? [];
  return <section className="rv-candidate-review" aria-label="候选事项审阅">
    {error && <p role="alert">{error}<button onClick={() => void refresh(true)}>重新读取候选</button></p>}
    {!page && !error && <p role="status">正在读取候选…</p>}
    {page && !batches.length && <p className="rv-muted">此来源尚无候选事项；纪要仍可独立保存。</p>}
    {page && batches.map(item => <CandidateBatch key={`${storageKey}:candidates:${item.id}`} batch={item} page={page} call={call} editable={editable} runnable={runnable} onOpen={onOpen} storageKey={storageKey} defaultAgent={defaultAgent} refresh={() => refresh(true)} />)}
  </section>;
}
export function CandidateBatch({ batch, page, call, editable, runnable, onOpen, storageKey, refresh, defaultAgent }: {
  batch: WorkflowBatch; page: WorkflowPage; call: Call; editable: boolean; runnable: boolean; onOpen(node: string): void; storageKey: string; defaultAgent?: string; refresh(): Promise<void>;
}) {
  const key = `${storageKey}:candidates:${batch.id}`;
  const [items, setItems] = useState(() => stored<WorkflowCandidate[]>(key + ":items", batch.items));
  const [baseVersion, setBaseVersion] = useState(() => stored(key + ":base", batch.version));
  const [agents, setAgents] = useState<Record<string, string>>(() => stored(key + ":agents", {}));
  const [scope, setScope] = useState<string[]>(() => stored(key + ":scope", []));
  const [parallelism, setParallelism] = useState(() => stored(key + ":parallelism", 1)), [prompt, setPrompt] = useState(() => stored(key + ":prompt", ""));
  const { run, pending, error } = useWorkflowActions(call, key);
  useEffect(() => { persist(key + ":items", items); persist(key + ":base", baseVersion); }, [key, items, baseVersion]);
  useEffect(() => { persist(key + ":agents", agents); }, [key, agents]);
  useEffect(() => { persist(key + ":scope", scope); }, [key, scope]);
  useEffect(() => { persist(key + ":parallelism", parallelism); persist(key + ":prompt", prompt); }, [key, parallelism, prompt]);
  const effectiveAgents = Object.fromEntries(items.map(item => [item.id, agents[item.id] ?? (page.agents.some(agent => agent.id === defaultAgent) ? defaultAgent! : "")]));
  const dirty = JSON.stringify(items) !== JSON.stringify(batch.items);
  const confirmed = items.filter(item => item.state === "confirmed");
  const unpublished = confirmed.filter(item => !batch.published[item.id]);
  const executable = confirmed.filter(item => item.kind === "task" || item.kind === "goal");
  const assigned = page.executions.filter(execution => execution.batch === batch.id);
  const previouslyScheduled = new Set(assigned.flatMap(execution => execution.scope));
  const edit = (id: string, patch: Partial<WorkflowCandidate>) => setItems(current => current.map(item => item.id === id ? { ...item, state: "edited", ...patch } : item));
  const save = async () => {
    const result = await run<{ batch: WorkflowBatch }>("candidates_save", { batch: batch.id, version: baseVersion, data: { items } });
    if (result) { setItems(result.batch.items); setBaseVersion(result.batch.version); await refresh(); }
  };
  const publish = async (execute: boolean) => {
    const result = await run<{ batch: WorkflowBatch; execution: WorkflowExecution | null }>("candidates_publish", {
      batch: batch.id, version: batch.version, data: { mode: execute ? "publish_execute" : "publish", ...(execute ? { execution: { scope, agents: Object.fromEntries(scope.map(id => [id, effectiveAgents[id]])), parallelism, prompt } } : {}) },
    });
    if (result) { setBaseVersion(result.batch.version); await refresh(); }
  };
  return <div className="rv-workflow-editor">
    <h3>{batch.title} · 候选事项</h3><p className="rv-muted">先编辑或删除，再逐项确认。只有已确认事项会发布。</p>
    {items.map(item => <details key={item.id} open={item.state !== "deleted"} className="rv-workflow-candidate">
      <summary>{item.state === "confirmed" ? "✓ " : item.state === "deleted" ? "已删除 · " : ""}{item.title}{batch.published[item.id] ? " · 已发布" : ""}</summary>
      <fieldset disabled={!editable || !!pending || !!batch.published[item.id]}>
        <label>标题<input value={item.title} onChange={event => edit(item.id, { title: event.target.value })} /></label>
        <label>类型<select value={item.kind} onChange={event => edit(item.id, { kind: event.target.value as WorkflowCandidate["kind"] })}><option value="task">任务</option><option value="goal">目标</option><option value="finding">发现</option><option value="note">笔记</option></select></label>
        <label>摘要<textarea value={item.summary} onChange={event => edit(item.id, { summary: event.target.value })} /></label>
        <label>正文<textarea value={item.body} onChange={event => edit(item.id, { body: event.target.value })} /></label>
        <label>依赖事项<select multiple value={item.dependencies} onChange={event => edit(item.id, { dependencies: Array.from(event.target.selectedOptions, option => option.value) })}>{items.filter(other => other.id !== item.id && other.state !== "deleted").map(other => <option key={other.id} value={other.id}>{other.title}</option>)}</select></label>
        <p className="rv-muted">依据：{item.evidence.map(source => source.source + (source.locator ? "#" + source.locator : "")).join("、")}</p>
        <button onClick={() => edit(item.id, { state: item.state === "confirmed" ? "edited" : "confirmed" })}>{item.state === "confirmed" ? "取消确认" : "确认此项"}</button>
        <button onClick={() => edit(item.id, { state: item.state === "deleted" ? "edited" : "deleted" })}>{item.state === "deleted" ? "恢复候选" : "删除候选"}</button>
      </fieldset>
      {batch.published[item.id] && <button onClick={() => onOpen(batch.published[item.id].node)}>打开已发布对象</button>}
    </details>)}
    {batch.pendingPublish && <button disabled={!editable || !!pending} onClick={async () => {
      const recovery = batch.pendingPublish!;
      const result = await run<{ batch: WorkflowBatch }>("candidates_publish", { request: recovery.request, batch: batch.id, version: recovery.version, data: recovery.data });
      if (result) { setBaseVersion(result.batch.version); await refresh(); }
    }}>恢复未确认的发布</button>}
    <button disabled={!editable || !!pending || !dirty || !!batch.pendingPublish} onClick={() => void save()}>保存候选修改</button>
    <button disabled={!editable || !!pending || dirty || !!batch.pendingPublish || !unpublished.length} onClick={() => void publish(false)}>发布到图谱</button>
    <details className="rv-task-dispatch" open><summary>确认下发任务 · 选择范围与执行 Agent</summary>
      {!executable.length && <p className="rv-muted">先逐项确认任务建议并保存，再选择需要下发的任务。</p>}
      {executable.map(item => <div className="rv-workflow-execution-row" key={item.id}>
        <label><input type="checkbox" checked={scope.includes(item.id)} disabled={!runnable || previouslyScheduled.has(item.id)} onChange={event => setScope(current => event.target.checked ? [...new Set([...current, item.id])] : current.filter(id => id !== item.id))} />{item.title}{previouslyScheduled.has(item.id) ? "（已安排执行）" : ""}</label>
        <select aria-label={"执行 Agent：" + item.title} value={effectiveAgents[item.id]} disabled={!runnable || previouslyScheduled.has(item.id)} onChange={event => setAgents({ ...agents, [item.id]: event.target.value })}><option value="">选择已绑定 Agent</option>{page.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.title}</option>)}</select>
        <p className="rv-muted">等待：{item.dependencies.map(id => items.find(other => other.id === id)?.title ?? id).join("、") || "无依赖"}</p>
      </div>)}
      <label>并行上限<input type="number" min="1" max="8" value={parallelism} onChange={event => setParallelism(Number(event.target.value))} /></label>
      <label>本次执行说明<textarea value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
      <p>点击下方确认按钮后，将发布已确认事项，并启动勾选的 {scope.length} 项。依赖成功后才派发后续项；实际并行还受资源队列限制。</p>
      <button className="rv-audio-primary" disabled={!editable || !runnable || !!pending || dirty || !!batch.pendingPublish || !scope.length || scope.some(id => !effectiveAgents[id] || previouslyScheduled.has(id) || !executable.some(item => item.id === id))} onClick={() => void publish(true)}>确认下发 {scope.length} 项任务</button>
    </details>
    {assigned.map(execution => <div key={execution.id}><strong>执行状态：{execution.state}</strong><ul>{Object.entries(execution.items).map(([id, item]) => <li key={id}>{items.find(candidate => candidate.id === id)?.title ?? id} · {item.state}{item.error && " · " + item.error}<button onClick={() => onOpen(item.node)}>打开任务</button></li>)}</ul>
      {runnable && execution.state === "running" && <button disabled={!!pending} onClick={async () => { if (await run("workflow_execution_stop", { execution: execution.id, version: execution.version })) await refresh(); }}>停止继续派发</button>}</div>)}
    {batch.version !== baseVersion && <button onClick={() => { setItems(batch.items); setBaseVersion(batch.version); }}>重新载入当前候选版本</button>}
    {dirty && <p className="rv-muted">请先保存修改，再发布。</p>}{!!pending && <p role="status">正在提交…</p>}{error && <p role="alert">{error}</p>}
  </div>;
}
