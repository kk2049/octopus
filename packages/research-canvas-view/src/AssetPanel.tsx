import { useEffect, useRef, useState } from "react";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import type { Call } from "./client.js";
import "./evidence.css";
interface AssetChoice { id: string; kind: string; title: string; config: Record<string, unknown> }
export function AssetPanel({ nodes, call, open, editable, owner }: { nodes: ResearchNode[]; call: Call; open(id: string): void; editable: boolean; owner: boolean }) {
  const [resources, setResources] = useState<AssetChoice[]>([]), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const [filter, setFilter] = useState(""), [url, setUrl] = useState(""), [title, setTitle] = useState("");
  const generation = useRef(0), pendingBind = useRef<{ request: string; node: string; url: string } | null>(null);
  const read = async () => { const ticket = ++generation.current; setPending(true); setError(""); try { const result = await call<{ resources: AssetChoice[] }>("resources_list"); if (ticket === generation.current) setResources(result.resources); } catch (reason) { if (ticket === generation.current) setError(String(reason)); } finally { if (ticket === generation.current) setPending(false); } };
  useEffect(() => { void read(); return () => { generation.current++; }; }, [call]);
  const artifacts = nodes.filter(node => !node.archived && (node.type === "file" || node.type === "audio" || node.type === "adapter" || (node.data.meta && typeof node.data.meta === "object" && !Array.isArray(node.data.meta) && (node.data.meta.reportId || node.data.meta.cloudDocument))) && (!filter || `${node.title} ${node.summary}`.toLowerCase().includes(filter.toLowerCase())));
  const machines = [...new Map(resources.filter(item => typeof item.config.device === "string").map(item => [String(item.config.device), item])).values()];
  return <section className="rv-evidence-window" aria-label="项目资源与材料">
    <header><b>资源与材料</b><button disabled={pending} onClick={() => void read()}>刷新资源</button></header>
    {error && <p role="alert">{error}</p>}{pending && <p role="status">正在处理…</p>}
    <details open><summary>可用设备与工作区 · {machines.length}</summary>{machines.map(machine => <div key={machine.id}><b>{String(machine.config.device)}</b><ul>{resources.filter(item => item.config.device === machine.config.device).map(item => <li key={item.id}>{item.title}<small> {String(item.config.directory ?? item.config.label ?? "")}</small></li>)}</ul></div>)}{!machines.length && <p>当前账号没有可列出的已授权工作区。</p>}</details>
    <label>查找项目产物<input value={filter} onChange={event => setFilter(event.target.value)} placeholder="标题或摘要" /></label>
    <ul>{artifacts.map(node => <li key={node.id}><button onClick={() => open(node.id)}>{node.title}</button><small> {node.type === "file" ? "文件" : node.type === "audio" ? "会议录音" : node.type === "adapter" ? "投影" : "研究材料"}</small></li>)}</ul>
    {owner && editable && <details className="rv-settings"><summary>接入飞书云文档</summary><form onSubmit={async event => {
      event.preventDefault(); const ticket = generation.current; setPending(true); setError("");
      try {
        if (!pendingBind.current || pendingBind.current.url !== url) pendingBind.current = { request: `cloud_${crypto.randomUUID()}`, node: "", url };
        const intent = pendingBind.current;
        if (!intent.node) { const created = await call<{ node: ResearchNode }>("node_add", { request: `${intent.request}:node`, data: { type: "note", title: title || "论文云文档", summary: "飞书论文材料与中文大纲", data: { text: "" } } }); intent.node = created.node.id; }
        await call("cloud_document_bind", { request: intent.request, node: intent.node, data: { url: intent.url } });
        if (ticket !== generation.current) return;
        pendingBind.current = null; setTitle(""); setUrl(""); open(intent.node);
      } catch (reason) { if (ticket === generation.current) setError(String(reason)); }
      finally { if (ticket === generation.current) setPending(false); }
    }}><label>材料标题<input value={title} disabled={pending} onChange={event => setTitle(event.target.value)} /></label><label>飞书原文档地址<input type="url" required value={url} disabled={pending} onChange={event => setUrl(event.target.value)} placeholder="https://…feishu.cn/docx/…" /></label><button disabled={pending || !url}>读取并接入项目</button></form></details>}
  </section>;
}
