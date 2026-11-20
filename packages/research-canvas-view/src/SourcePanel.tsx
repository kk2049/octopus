import { useEffect, useRef, useState } from "react";
import { SOURCE_STAGE_LABELS, type DiscussionSourceStatus, type ResearchNode, type ResearchRun } from "@claude-bot/research-canvas-contract";
import type { Call } from "./client.js";
export function SourcePanel({ nodes, call, epoch = 0, open, reveal, runs = [] }: {
  nodes: ResearchNode[]; runs?: ResearchRun[]; call: Call; epoch?: number; open(id: string): void; reveal?(id: string): void;
}) {
  const [items, setItems] = useState<DiscussionSourceStatus[]>([]), [error, setError] = useState(""), [tab, setTab] = useState<"sources" | "agents">("sources");
  const generation = useRef(0), loading = useRef<number | null>(null), queued = useRef(false);
  const refresh = async () => {
    if (loading.current === generation.current) { queued.current = true; return; }
    const ticket = generation.current; loading.current = ticket;
    try {
      const result = await call<{ items: DiscussionSourceStatus[] }>("source_list");
      if (ticket === generation.current) { setItems(old => JSON.stringify(old) === JSON.stringify(result.items) ? old : result.items); setError(""); }
    } catch (reason) { if (ticket === generation.current) setError(String(reason)); }
    finally { if (loading.current === ticket) loading.current = null; if (queued.current && ticket === generation.current) { queued.current = false; void refresh(); } }
  };
  useEffect(() => { return () => { generation.current++; queued.current = false; }; }, [call]);
  useEffect(() => { if (!error) void refresh(); }, [epoch, call]);
  const sourceNodes = nodes.filter(node => !node.archived && ["audio", "group", "workgroup"].includes(node.type));
  const latest = new Map<string, DiscussionSourceStatus>();
  for (const item of items) if (!latest.has(item.node)) latest.set(item.node, item);
  const sources = [...sourceNodes.map(node => ({ id: node.id, title: node.title, kind: node.type, at: latest.get(node.id)?.updatedAt ?? node.updated.at,
    status: latest.get(node.id) })), ...[...latest.values()].filter(item => !sourceNodes.some(node => node.id === item.node)).map(item => ({ id: item.node, title: item.title, kind: item.kind, at: item.updatedAt, status: item }))]
    .sort((a, b) => b.at.localeCompare(a.at));
  const agents = nodes.filter(node => node.type === "agent").sort((a, b) => b.updated.at.localeCompare(a.updated.at));
  return <aside className="rv-source-panel" aria-label="来源与 Agent 活动">
    <div className="rv-inline"><button aria-pressed={tab === "sources"} onClick={() => setTab("sources")}>讨论来源</button><button aria-pressed={tab === "agents"} onClick={() => setTab("agents")}>Agent 活动</button></div>
    <div hidden={tab !== "sources"}>{sources.length ? sources.map(item => <article key={item.id}>
      <button onClick={() => open(item.id)}>{item.kind === "audio" ? "♫ " : "◉ "}{item.title}</button>
      <small>{item.status ? SOURCE_STAGE_LABELS[item.status.stage] : "尚未处理"} · {new Date(item.at).toLocaleString()}</small>
      {item.status?.minutes && <button onClick={() => open(item.status!.minutes!.id)}>纪要</button>}
      {reveal && <button onClick={() => reveal(item.id)}>定位图谱</button>}
    </article>) : <p>新建会议录音或绑定飞书群后，可在这里按时间查看来源。</p>}</div>
    <div hidden={tab !== "agents"}>{agents.length ? agents.map(node => <article key={node.id}>
      <button onClick={() => open(node.id)}>✳ {node.title}</button><small>{node.archived ? "历史 Agent" : node.summary || "查看会话与运行状态"}</small>
      {runs.filter(run => run.node === node.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 1).map(run => <small key={run.id}>
        {{ queued: "等待启动", running: "运行中", waiting: "等待交互", completed: "运行结束，待验收", failed: "运行失败", cancelled: "已停止", unknown: "状态待核对" }[run.status]} · {Math.max(0, Math.round(((run.finished ? Date.parse(run.finished) : Date.now()) - Date.parse(run.at)) / 60000))} 分钟
      </small>)}
      {reveal && <button onClick={() => reveal(node.id)}>定位图谱</button>}
    </article>) : <p>尚无关联 Agent。</p>}</div>
    {error && <p role="alert">{error}<button onClick={() => void refresh()}>重试来源读取</button></p>}
  </aside>;
}
