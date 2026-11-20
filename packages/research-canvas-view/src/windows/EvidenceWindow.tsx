import { useEffect, useRef, useState } from "react";
import { Markdown } from "@claude-bot/agent-view-react/ui";
import type { EvidenceSelection, ResearchEvidence } from "@claude-bot/research-canvas-contract";
import type { NodeWindowProps } from "./NodeWindow.js";
import { FileWindow } from "./FileWindow.js";
import { EvidenceThumbnail } from "../EvidenceThumbnail.js";
import { useEvidenceSelection } from "../evidence-selection.js";
import "../evidence.css";

const sectionTitles = { motivation: "为什么做", goal: "希望证明什么", design: "采用什么方法", execution: "怎样执行", results: "观察到什么", analysis: "如何理解结果", configuration: "配置", limitations: "局限与异常" } as const;
export function EvidenceWindow({ node, nodes, call, editable, open, storageKey, boot }: NodeWindowProps) {
  const { selection, error: readError, pending: reading, refresh, accept } = useEvidenceSelection(node, call, boot.epoch);
  const [error, setError] = useState(""), [adopting, setAdopting] = useState(false);
  const generation = useRef(0), adoption = useRef<{ expected: string; request: string } | null>(null);
  const pending = reading || adopting;
  useEffect(() => { generation.current++; adoption.current = null; setError(""); setAdopting(false); return () => { generation.current++; }; }, [node.id, call]);
  const adopt = async () => {
    if (!selection || pending) return;
    const expected = selection.adopted?.id ?? "";
    if (!adoption.current || adoption.current.expected !== expected) adoption.current = { expected, request: `adopt_${crypto.randomUUID()}` };
    const ticket = generation.current; setAdopting(true); setError("");
    try {
      const next = await call<EvidenceSelection>("evidence_adopt", { node: node.id, ...adoption.current });
      if (ticket !== generation.current) return;
      accept(next); adoption.current = null;
    } catch (reason) { if (ticket === generation.current) setError(String(reason)); }
    finally { if (ticket === generation.current) setAdopting(false); }
  };
  return <section className="rv-evidence-window" aria-label="研究报告">
    <header><b>报告与证据</b><button disabled={pending} onClick={() => { setError(""); void refresh(); }}>刷新状态</button></header>
    {(error || readError) && <p role="alert">{error || readError}</p>}{pending && <p role="status">正在处理…</p>}
    {selection && <>
      <div className="rv-report-selections"><ReportChoice label="本系列最新结果" report={selection.latest} open={open} /><ReportChoice label="当前采纳结果" report={selection.adopted} open={open} /></div>
      <p className="rv-report-claim">{{ observation: "观测结果", inference: "推导结论", hypothesis: "待验证的设想" }[selection.report.claim]} · {selection.report.created.at.slice(0, 16).replace("T", " ")}</p>
      <h3>{selection.report.title}</h3><Markdown>{selection.report.conclusion}</Markdown>
      {editable && <button disabled={pending || selection.adopted?.id === selection.report.id} onClick={() => void adopt()}>{selection.adopted?.id === selection.report.id ? "这份报告已被采纳" : "采纳这份报告"}</button>}
      {Object.entries(sectionTitles).map(([key, title]) => <section key={key}><h4>{title}</h4><Markdown>{selection.report[key as keyof typeof sectionTitles] || "未补充"}</Markdown></section>)}
      <EvidenceLinks report={selection.report} nodes={nodes} open={open} />
      {selection.report.charts.map(id => { const chart = nodes.find(item => item.id === id); return chart && chart.type === "file" ? <details key={id}><summary>关键图表：{chart.title}</summary><FileWindow node={chart} call={call} editable={false} storageKey={`${storageKey}:report:${selection.report.id}:chart:${id}`} openVersion={() => open(id)} /></details> : null; })}
    </>}
  </section>;
}
function ReportChoice({ label, report, open, compact = false }: { label: string; report: ResearchEvidence | null; open(id: string): void; compact?: boolean }) {
  return <div><small>{label}</small>{report ? <button onClick={event => { event.stopPropagation(); open(report.node); }}>{report.title}</button> : <span>尚未采纳</span>}{report && !compact && <p>{report.conclusion}</p>}</div>;
}
function EvidenceLinks({ report, nodes, open }: Pick<NodeWindowProps, "nodes" | "open"> & { report: ResearchEvidence }) {
  const titles = { code: "代码版本", frameworks: "测试框架", runs: "运行轮次", artifacts: "原始产物", charts: "关键图表", sources: "原始来源" };
  return <dl className="rv-evidence-links">{Object.entries(titles).map(([key, title]) => <div key={key}><dt>{title}</dt><dd>{report[key as keyof typeof titles].length ? report[key as keyof typeof titles].map(id => <button key={id} onClick={() => open(id)}>{nodes.find(node => node.id === id)?.title ?? id}</button>) : "—"}</dd></div>)}</dl>;
}

/** Compact cards present both statuses independently; the report body stays immutable. */
export function EvidencePreview({ node, nodes, call, open, epoch = 0 }: Pick<NodeWindowProps, "node" | "nodes" | "call" | "open"> & { epoch?: number }) {
  const { selection, error, refresh } = useEvidenceSelection(node, call, epoch);
  const charts = [...new Set(selection?.report.charts ?? [])];
  return <div className="rv-evidence-preview" aria-label="报告摘要与关键图表">
    {error && <small role="alert">{error}<button onClick={event => { event.stopPropagation(); void refresh(); }}>重试报告状态</button></small>}
    {selection && <>
      {selection.report.conclusion !== node.summary && <div className="rv-evidence-conclusion"><Markdown renderImage={image => <span>{image.alt || "[图片引用，打开来源查看]"}</span>}>{selection.report.conclusion}</Markdown></div>}
      <div className="rv-evidence-statuses"><ReportChoice label="最新" report={selection.latest} open={open} compact /><ReportChoice label="已采纳" report={selection.adopted} open={open} compact /></div>
      {charts.length > 0 && <div className="rv-evidence-charts"><small>关键图表 · {charts.length}</small>{charts.slice(0, 2).map(id => {
        const chart = nodes.find(item => item.id === id && !item.archived);
        return chart?.type === "file" ? <EvidenceThumbnail key={`${selection.report.id}:${id}`} node={chart} call={call} open={open} /> : <small key={id}>图表来源暂不可用</small>;
      })}{charts.length > 2 && <button onClick={event => { event.stopPropagation(); open(selection.report.node); }}>查看全部 {charts.length} 张关键图表</button>}</div>}
    </>}
  </div>;
}
