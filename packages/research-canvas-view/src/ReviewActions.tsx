import { useEffect, useState } from "react";
import type { ResearchNode, WorkflowFlag } from "@claude-bot/research-canvas-contract";
import { persist, stored, type Call } from "./client.js";
import { useWorkflowActions } from "./workflow-client.js";

export function ReviewActions({ flag, nodes, call, editable, runnable, storageKey, onSaved, onOpen }: {
  flag: WorkflowFlag; nodes: ResearchNode[]; call: Call; editable: boolean; runnable: boolean; storageKey: string;
  onSaved(flag: WorkflowFlag): void; onOpen(node: string): void;
}) {
  const key = storageKey + ":flag:" + flag.id;
  const [answer, setAnswer] = useState(() => stored(key, flag.answer?.text ?? ""));
  const [state, setState] = useState<WorkflowFlag["state"]>(() => stored(key + ":state", flag.state));
  const [baseVersion, setBaseVersion] = useState(() => stored(key + ":base", flag.version));
  const { run, pending, error } = useWorkflowActions(call, key);
  useEffect(() => { persist(key, answer); persist(key + ":state", state); persist(key + ":base", baseVersion); }, [key, answer, state, baseVersion]);
  const dirty = answer !== (flag.answer?.text ?? "") || state !== flag.state;
  const sent = flag.sent.some(item => item.answerVersion === (flag.answerRevision ?? flag.version));
  const submit = async (action: "review_flag_save" | "review_flag_continue") => {
    const result = await run<{ flag: WorkflowFlag }>(action, { flag: flag.id, version: action === "review_flag_save" ? baseVersion : flag.version, ...(action === "review_flag_save" ? { data: { answer, state } } : {}) });
    if (result) { setBaseVersion(result.flag.version); onSaved(result.flag); }
  };
  const links = (refs: string[]) => refs.map(ref => {
    const node = nodes.find(node => node.id === ref || node.ref === ref);
    return <button key={ref} onClick={() => onOpen(node?.id ?? ref)}>{node?.title ?? ref}</button>;
  });
  return <section className="rv-workflow-editor" aria-label="异步审核与决策">
    <h3>{flag.kind === "review" ? "！待审核" : "？待决策"} · {flag.title}</h3>
    <p className="rv-workflow-pre">{flag.background}</p>
    {!!flag.options.length && <ul>{flag.options.map(option => <li key={option}>{option}</li>)}</ul>}
    <div className="rv-workflow-links">{links(flag.related)}</div>
    {!!flag.sources.length && <p>来源：{flag.sources.map(source => source.source + (source.locator ? "#" + source.locator : "")).join("、")}</p>}
    {!!flag.affected.length && <div>受影响的后续成果：{links(flag.affected)}</div>}
    <label>审核结果或回答<textarea disabled={!editable} value={answer} onChange={event => setAnswer(event.target.value)} /></label>
    <label>处理状态<select disabled={!editable} value={state} onChange={event => setState(event.target.value as WorkflowFlag["state"])}><option value="open">保留待处理</option><option value="resolved">已处理</option></select></label>
    <button disabled={!editable || !!pending || !answer.trim()} onClick={() => void submit("review_flag_save")}>保存结果</button>
    <button disabled={!runnable || !!pending || dirty || !flag.answer || !flag.agent || !flag.conversation || sent} onClick={() => void submit("review_flag_continue")}>{sent ? "本次结果已发送" : "发送结果并继续"}</button>
    <p className="rv-muted">保存只记录结果；发送并继续才唤醒关联的原会话。</p>
    {!flag.agent && <p className="rv-muted">此问题未关联 Agent，可保存和跟踪结果。</p>}
    {flag.version !== baseVersion && <button onClick={() => { setAnswer(flag.answer?.text ?? ""); setState(flag.state); setBaseVersion(flag.version); }}>重新载入当前处理结果</button>}
    {!!pending && <p role="status">正在提交…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
