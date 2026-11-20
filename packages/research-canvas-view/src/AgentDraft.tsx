import { useEffect, useState } from "react";
import type { ResearchNode, WorkflowDraft } from "@claude-bot/research-canvas-contract";
import { persist, stored, type Call } from "./client.js";
import { useWorkflowActions } from "./workflow-client.js";

function refsFromText(raw: string, nodes: ResearchNode[]): string[] {
  const values = raw.split(/[\s,，]+/).filter(Boolean), result: string[] = [];
  for (const value of values) {
    let target = value;
    try { const url = new URL(value); target = url.searchParams.get("researchNode") ?? url.searchParams.get("node") ?? value; } catch { /* A fixed resource ref is also accepted. */ }
    const node = nodes.find(node => node.id === target || node.ref === target);
    if (node) result.push(node.ref ?? node.id);
    else if (/^[a-z][a-z0-9_-]*:[A-Za-z0-9_.:-]+$/.test(target)) result.push(target);
    else throw new Error("无法识别节点引用：" + value);
  }
  return [...new Set(result)];
}
export function AgentDraft({
  draft, nodes, agents, selected = [], call, storageKey, runnable, onSaved, onOpen,
}: {
  draft?: WorkflowDraft; nodes: ResearchNode[]; agents: ResearchNode[]; selected?: string[];
  call: Call; storageKey: string; runnable: boolean;
  onSaved(draft: WorkflowDraft): void; onOpen?(agent: string, conversation?: string): void;
}) {
  const key = storageKey + ":draft:" + (draft?.id ?? "new");
  const initial = { title: draft?.title ?? "", agent: draft?.agent ?? "", contexts: draft?.contexts ?? [], prompt: draft?.prompt ?? "" };
  const [form, setForm] = useState(() => stored(key, initial)), [paste, setPaste] = useState(""), [followup, setFollowup] = useState(() => stored(key + ":followup", ""));
  const [baseVersion, setBaseVersion] = useState(() => stored(key + ":base", draft?.version ?? 0));
  const { run, pending, error, setError } = useWorkflowActions(call, key);
  useEffect(() => { persist(key, form); persist(key + ":base", baseVersion); }, [key, form, baseVersion]);
  useEffect(() => { persist(key + ":followup", followup); }, [key, followup]);
  const add = (refs: string[]) => setForm(current => ({ ...current, contexts: [...new Set([...current.contexts, ...refs])] }));
  const addRaw = (raw: string) => { try { add(refsFromText(raw, nodes)); setError(""); setPaste(""); } catch (reason) { setError(String(reason)); } };
  const started = draft?.status === "started";
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const send = async (action: "agent_draft_save" | "agent_draft_start" | "agent_draft_continue") => {
    const answer = await run<{ draft: WorkflowDraft }>(action, action === "agent_draft_save"
      ? { draft: draft?.id, version: baseVersion, data: form }
      : action === "agent_draft_start" ? { draft: draft!.id, version: draft!.version }
        : { draft: draft!.id, prompt: followup });
    if (answer) { setBaseVersion(answer.draft.version); if (action === "agent_draft_continue") setFollowup(""); onSaved(answer.draft); }
  };
  return <section className="rv-workflow-editor" aria-label={started ? "Agent 会话" : "Agent 草稿"}
    onDragOver={event => { if (!started) event.preventDefault(); }}
    onDrop={event => { if (started) return; event.preventDefault(); const raw = event.dataTransfer.getData("text/plain") || event.dataTransfer.getData("text/uri-list"); if (raw) addRaw(raw); }}>
    {started ? <><h3>{draft.title}</h3><p>运行已建立，后续消息进入同一个会话。</p><button onClick={() => onOpen?.(draft.agent, draft.conversation)}>打开原始对话</button>
      <label>继续说明<textarea value={followup} onChange={event => setFollowup(event.target.value)} /></label>
      <button disabled={!runnable || !!pending || !followup.trim()} onClick={() => void send("agent_draft_continue")}>发送并继续</button></>
      : <><label>草稿标题<input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
      <label>执行 Agent<select value={form.agent} onChange={event => setForm({ ...form, agent: event.target.value })}><option value="">启动前选择已绑定资源</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.title}</option>)}</select></label>
      <label>任务说明<textarea value={form.prompt} onChange={event => setForm({ ...form, prompt: event.target.value })} /></label>
      <div><button disabled={!selected.length} onClick={() => add(selected.map(id => nodes.find(node => node.id === id)?.ref ?? id))}>加入选中节点（{selected.length}）</button></div>
      <label>粘贴节点链接或引用<input value={paste} onChange={event => setPaste(event.target.value)} onPaste={event => { const raw = event.clipboardData.getData("text/plain"); if (raw) { event.preventDefault(); addRaw(raw); } }} /></label>
      <button disabled={!paste.trim()} onClick={() => addRaw(paste)}>加入引用</button>
      <ul>{form.contexts.map(ref => <li key={ref}><span>{nodes.find(node => node.ref === ref || node.id === ref)?.title ?? ref}</span><button aria-label={"移除上下文 " + ref} onClick={() => setForm({ ...form, contexts: form.contexts.filter(value => value !== ref) })}>移除</button></li>)}</ul>
      <p className="rv-muted">保存或加入上下文不会启动。确认下面的草稿内容后，再点击启动。</p>
      <button disabled={!runnable || !!pending || !form.title.trim()} onClick={() => void send("agent_draft_save")}>保存草稿</button>
      <button disabled={!runnable || !!pending || !draft || dirty || !form.agent || !form.prompt.trim()} onClick={() => void send("agent_draft_start")}>启动 Agent</button>
      {draft && draft.version !== baseVersion && <button onClick={() => { setForm(initial); setBaseVersion(draft.version); }}>重新载入当前草稿版本</button>}
      {draft && dirty && <p className="rv-muted">启动前请保存当前修改。</p>}</>}
    {!!pending && <p role="status">正在提交…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
