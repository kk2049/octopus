import { useCallback, useEffect, useRef, useState } from "react";
import { SOURCE_STAGE_LABELS, type DiscussionSourceStatus, type ResearchNode } from "@claude-bot/research-canvas-contract";
import { requestId, type Call } from "../client.js";
import { CandidateReview } from "../CandidateReview.js";

export function useDiscussionSource(call: Call, node: string, epoch = 0) {
  const [source, setSource] = useState<DiscussionSourceStatus | null>(null), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const generation = useRef(0), flight = useRef<symbol | null>(null), queued = useRef(false), refused = useRef(false);
  const refresh = useCallback(async (explicit = false): Promise<void> => {
    if (refused.current && !explicit) return;
    if (flight.current) { queued.current = true; return; }
    const ticket = generation.current, lease = Symbol(); flight.current = lease; setPending(true);
    try {
      const result = await call<{ source: DiscussionSourceStatus | null }>("source_read", { node });
      if (ticket !== generation.current) return;
      setSource(previous => JSON.stringify(previous) === JSON.stringify(result.source) ? previous : result.source); setError(""); refused.current = false;
    } catch (reason) { if (ticket === generation.current) { setError(String(reason)); refused.current = true; } }
    finally {
      if (flight.current === lease) {
        flight.current = null;
        if (ticket === generation.current) {
          setPending(false);
          if (queued.current) { queued.current = false; if (!refused.current) void refresh(); }
        }
      }
    }
  }, [call, node]);
  useEffect(() => {
    generation.current++; flight.current = null; queued.current = false; refused.current = false; setSource(null); setError("");
    return () => { generation.current++; flight.current = null; };
  }, [refresh]);
  useEffect(() => { void refresh(); }, [epoch, refresh]);
  const active = Boolean(source && (!['uploaded', 'transcribed', 'completed', 'failed', 'needs_review', 'unknown'].includes(source.stage)
    || source.summary && ["queued", "running"].includes(source.summary.state)));
  useEffect(() => {
    if (!active || error) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [active, error, refresh]);
  return { source, error, pending, refresh, active };
}

export function DiscussionSourceResults({ source, node, call, editable, runnable, open, storageKey, pending, error, refresh, allowRetry = true }: {
  source: DiscussionSourceStatus | null; node: ResearchNode; call: Call; editable: boolean; runnable: boolean; open(id: string): void;
  storageKey: string; pending: boolean; error: string; refresh(explicit?: boolean): Promise<void>; allowRetry?: boolean;
}) {
  const [retrying, setRetrying] = useState(false), [retryError, setRetryError] = useState("");
  const generation = useRef(0), retry = useRef<string | null>(null);
  useEffect(() => () => { generation.current++; }, [node.id, call]);
  const reconnectAudio = source?.kind === "audio" && !source.integrity?.complete;
  const showRetry = allowRetry && source && ["failed", "unknown", "needs_review"].includes(source.stage);
  return <section className="rv-discussion-results" aria-label="讨论来源处理与派生结果">
    <div className="rv-inline"><strong>{node.type === "audio" ? "转写与纪要" : "讨论来源与派生结果"}</strong><button disabled={pending} onClick={() => void refresh(true)}>刷新进度</button></div>
    {source ? <>
      <p role="status"><strong>{SOURCE_STAGE_LABELS[source.stage]}</strong> · {source.message}</p>
      {source.progress !== null && <progress value={source.progress} max={100} aria-label="讨论处理进度" />}
      {source.kind === "chat" && <ol className="rv-source-stages" aria-label="处理阶段">{["获取群消息", "固定来源区间", "整理纪要", "候选待办"].map(label => <li key={label}>{label}</li>)}</ol>}
      {source.summary && <p>纪要 Agent：<button onClick={() => open(source.summary!.agent.id)}>{source.summary.agent.title}</button>
        {" · "}{{ queued: "等待整理", running: "正在整理", completed: "整理完成", failed: "整理失败", unknown: "整理结果待确认" }[source.summary.state]}
        {source.summary.message && ` · ${source.summary.message}`}</p>}
      {source.integrity && <details><summary>转写完整性与讲话人说明</summary><p className="rv-muted">覆盖至 {source.integrity.lastEndSeconds.toFixed(2)} / {source.integrity.durationSeconds.toFixed(2)} 秒 · {source.integrity.segments} 个片段{source.integrity.recovered ? " · 含有记录的补段恢复" : ""}。讲话人标签为匿名声音标签，未作实名核验。</p></details>}
      {source.integrity?.warnings.map(warning => <p key={warning} role="note">{warning}</p>)}
      <div className="rv-inline">
        {source.transcript && <button onClick={() => open(source.transcript!.id)}>{source.kind === "audio" ? source.integrity?.complete ? "打开完整转写" : "打开部分转写（待审）" : "打开原始讨论"}</button>}
        {source.minutes && <button className="rv-audio-primary" onClick={() => open(source.minutes!.id)}>打开可编辑纪要</button>}
        {source.evidence && <button onClick={() => open(source.evidence!.id)}>查看完整性证据</button>}
        {showRetry && <button disabled={!runnable || retrying} onClick={async () => {
          const ticket = generation.current; const request = retry.current ?? requestId(); retry.current = request; setRetrying(true); setRetryError("");
          try { await call("source_retry", { request, node: source.node, version: source.sourceVersion }); if (ticket === generation.current) { retry.current = null; await refresh(true); } }
          catch (reason) { if (ticket === generation.current) setRetryError(String(reason)); }
          finally { if (ticket === generation.current) setRetrying(false); }
        }}>{retrying ? "提交中…" : reconnectAudio ? "重新连接并核对原转写" : "继续整理已保存来源"}</button>}
      </div>
      {showRetry && reconnectAudio && <p className="rv-muted">此入口重新连接并核对原转写作业，不会重新运行。若原作业已经失败，请更换或重新上传录音，建立新版本后再处理。</p>}
      {source.batch && <CandidateReview batch={source.batch} source={`${source.kind === "audio" ? "audio" : "workgroup"}:${source.node}`} call={call}
        editable={editable} runnable={runnable} onOpen={open} storageKey={storageKey} defaultAgent={source.summary?.agent.id} epoch={Date.parse(source.updatedAt) || 0} />}
    </> : <p className="rv-muted">{node.type === "audio" ? "上传后手动开始转写。生成的中文纪要可以编辑，任务建议需确认后下发。" : "选择消息区间导入后，这里显示纪要、候选事项及可回查的原文。"}</p>}
    {(error || retryError) && <p role="alert">{error || retryError}</p>}
  </section>;
}
export function DiscussionSourceWindow({ node, call, editable, runnable, open, storageKey, epoch = 0 }: {
  node: ResearchNode; call: Call; editable: boolean; runnable: boolean; open(id: string): void; storageKey: string; epoch?: number;
}) {
  const state = useDiscussionSource(call, node.id, epoch);
  return <DiscussionSourceResults {...{ node, call, editable, runnable, open, storageKey }} {...state} />;
}
