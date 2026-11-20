import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { researchRole, type ResearchNode } from "@claude-bot/research-canvas-contract";
import { persist, stored, requestId, type Call } from "./client.js";
import type { CanvasDocument } from "./collaboration.js";
import { pluginFor } from "./plugins.js";
import { CardIcon } from "./CardIcon.js";
export const contentTypes = ["note", "task", "finding", "goal", "workgroup"];
export const cardKinds: Record<string, string> = { goal: "项目目标", target: "具体目标", motivation: "动机", note: "便签", task: "任务", finding: "研究结论", workgroup: "研究工作群" };
export const cardKind = (node: ResearchNode): string => String((node.data.meta as Record<string, unknown> | undefined)?.cardKind ?? researchRole(node) ?? node.type);
interface Draft { title: string; summary: string; kind: string }
export function InlineEditor({ node, call, doc, draftKey, active, field = "summary", close, changed }: {
  node: ResearchNode; call: Call; doc?: CanvasDocument; draftKey: string; active: boolean; field?: "title" | "summary" | "body"; close(): void; changed(): void;
}) {
  const titleInput = useRef<HTMLInputElement>(null), summaryInput = useRef<HTMLTextAreaElement>(null);
  const initial = () => ({ title: node.title, summary: node.summary, kind: cardKind(node) });
  const saved = useRef(stored<{ draft: Draft; dirty: boolean; outgoing?: { request: string; data: Record<string, unknown>; sent: Draft; version: number; snapshot?: string } } | null>(draftKey, null));
  const [draft, setDraft] = useState<Draft>(() => saved.current?.dirty ? saved.current.draft : initial());
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const current = useRef(draft), base = useRef(node), dirty = useRef(saved.current?.dirty ?? false), outgoing = useRef(saved.current?.outgoing), busy = useRef(false), mounted = useRef(true), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const readOnly = (node.data.meta as Record<string, unknown> | undefined)?.read_only === true;
  const saveDraft = () => persist(draftKey, { draft: current.current, dirty: dirty.current, outgoing: outgoing.current });
  const flush = async (retry = false) => {
    clearTimeout(timer.current);
    if (busy.current || !dirty.current || error && !retry) return;
    busy.current = true; setPending(true); setError("");
    try {
      const value = current.current;
      if (!value.title.trim()) return;
      outgoing.current ??= { request: requestId(), sent: { ...value }, version: base.current.version, snapshot: base.current.snapshot, data: {
        ...(value.title !== base.current.title ? { title: value.title } : {}),
        ...(!readOnly && value.summary !== base.current.summary ? { summary: value.summary } : {}),
        ...(!readOnly && contentTypes.includes(node.type) && value.kind !== cardKind(base.current) ? { cardKind: value.kind } : {}),
      } };
      saveDraft();
      const operation = outgoing.current;
      if (!Object.keys(operation.data).length) { outgoing.current = undefined; dirty.current = false; saveDraft(); return; }
      const result = await call<{ node: ResearchNode; edit?: { conflicts?: unknown[] } }>("node_update", { request: operation.request, node: node.id, version: operation.version, snapshot: operation.snapshot, data: operation.data });
      if (!mounted.current) return;
      base.current = result.node; outgoing.current = undefined;
      dirty.current = JSON.stringify(current.current) !== JSON.stringify(operation.sent);
      if (!dirty.current) { current.current = { title: result.node.title, summary: result.node.summary, kind: cardKind(result.node) }; setDraft(current.current); }
      saveDraft(); changed();
      if (result.edit?.conflicts?.length) setError("并发修改已合并，当前有效标题已显示");
      if (dirty.current) timer.current = setTimeout(() => void flush(), 650);
    } catch (reason) { if (mounted.current) setError(`${String(reason)}；草稿已保留`); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  };
  const change = (patch: Partial<Draft>) => {
    current.current = { ...current.current, ...patch }; dirty.current = true; setDraft(current.current); saveDraft();
    clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), 650);
  };
  useLayoutEffect(() => {
    const input = summaryInput.current;
    if (!input || !active) return;
    input.style.height = "0px";
    input.style.height = `${Math.max(56, Math.min(360, input.scrollHeight))}px`;
  }, [draft.summary, active]);
  useEffect(() => {
    if (!active) return;
    if (field === "title") titleInput.current?.focus({ preventScroll: true });
    else if (field === "summary") summaryInput.current?.focus({ preventScroll: true });
  }, [active, field]);
  useEffect(() => { if (!dirty.current && !busy.current) { base.current = node; current.current = initial(); setDraft(current.current); } }, [node]);
  useEffect(() => { if (!active) { void flush(); if (doc?.snapshot().ready) void doc.sync(); } }, [active]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); saveDraft(); }; }, []);
  return <div className="rv-inline-editor" hidden={!active} onPointerDown={e => { if (!(e.target as Element).closest(".rv-card-drag,.rv-title-drag")) e.stopPropagation(); }} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") { void flush(); close(); } }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) void flush(); }}>
    <div className="rv-edit-toolbar rv-title-drag"><span className="rv-card-drag" title="拖动移动卡片"><CardIcon name="grip" /></span><select aria-label="卡片类型" value={draft.kind} disabled={readOnly || !contentTypes.includes(node.type)} onChange={e => change({ kind: e.target.value })}>
      {contentTypes.includes(node.type) ? Object.entries(cardKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>) : <option value={draft.kind}>{pluginFor(node.type).title}</option>}
    </select><button aria-label="完成编辑" title="完成编辑" onClick={() => { void flush(); close(); }}><CardIcon name="done" /></button></div>
    <input ref={titleInput} aria-label="卡片标题" placeholder="对象 + 要做什么／核心结论" value={draft.title} maxLength={200} onChange={e => change({ title: e.target.value })} />
    {doc ? <><textarea ref={summaryInput} className="rv-inline-summary" aria-label="卡片摘要" placeholder="一句话摘要" value={draft.summary} maxLength={2000} disabled={readOnly} onChange={e => change({ summary: e.target.value })}/><InlineBody doc={doc} readOnly={readOnly} active={active && field === "body"}/></> : <textarea ref={summaryInput} className="rv-inline-summary" aria-label="卡片说明" value={draft.summary} disabled={readOnly} maxLength={2000} onChange={e => change({ summary: e.target.value })} />}
    <div className="rv-inline-save" role="status">{pending ? "保存中…" : error ? "草稿已保留" : "自动保存"}{error && <button onClick={() => void flush(true)}>重试</button>}</div>
    {error && <p className="rv-inline-error" role="alert">{error}</p>}
  </div>;
}
function InlineBody({ doc, readOnly, active }: { doc: CanvasDocument; readOnly: boolean; active: boolean }) {
  const state = useSyncExternalStore(doc.subscribe, doc.snapshot);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { void doc.sync(); }, [doc]);
  useEffect(() => { if (active && state.ready) input.current?.focus({ preventScroll: true }); }, [active, state.ready]);
  return <><textarea ref={input} className="rv-inline-body" aria-label="卡片正文" placeholder={state.ready ? "记录线索、讨论或结论…" : "正在读取正文…"} value={doc.text()} disabled={readOnly || !state.ready || Boolean(state.partial)} onChange={e => doc.replaceText(e.target.value)} onBlur={() => void doc.sync()} />{state.error && <p role="alert">{state.error}<button onClick={() => void doc.sync(true)}>重试保存正文</button></p>}</>;
}
