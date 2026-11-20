import { useEffect, useState } from "react";
import { AvButton, AvInput, AvTextArea, Banner, ModalDialog, StatusChip } from "@claude-bot/agent-view-react/ui";
import type { IntakeReadout, IntakeRecord } from "../lib/intake.js";

export interface IntakeWorkflowProps {
  intake: IntakeReadout; busy: boolean; notice: { tone: "ok" | "warn" | "error" | "info"; text: string } | null;
  file: File | null; submitLabel: string;
  onFile(file: File | null): void; onSubmit(values: Record<string, string>): void; onDecide(id: string, decision: "approve" | "reject"): void;
}

export function IntakeWorkflow({ intake, busy, notice, file, submitLabel, onFile, onSubmit, onDecide }: IntakeWorkflowProps) {
  const [selected, setSelected] = useState<IntakeRecord | null>(null);
  const [preview, setPreview] = useState(false);
  const [history, setHistory] = useState(false);
  const [form, setForm] = useState({ merchant: "", amount: "", expense_date: "", description: "" });
  const visible = [...intake.completed, ...intake.processing, ...intake.mine];
  // Projection replacement can represent a live role change or revocation.
  // Never let a manager-only attachment survive in local dialog state after
  // the authoritative projection stopped disclosing that record.
  useEffect(() => {
    if (!selected) return;
    const fresh = visible.find((record) => record.id === selected.id);
    if (fresh === selected) return;
    if (fresh) setSelected(fresh);
    else {
      setSelected(null);
      setPreview(false);
      setHistory(false);
    }
  }, [selected, visible]);
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = () => onSubmit(form);
  if (intake.status !== "ok") return <p className="iv-note" role="note">工作台数据{intake.status === "missing" ? "尚未到达" : "不可读"}。</p>;
  return <section className="iv-workflow" aria-busy={busy || undefined}>
    <div className="iv-stats">{Object.entries(intake.stats).map(([key, value]) => <div key={key}><span>{key}</span><b>{value}</b></div>)}</div>
    {intake.canSubmit ? <form className="iv-submit" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="iv-title"><div><b>提交新材料</b><span>仅 PDF，文件和字段一起进入处理流程</span></div><StatusChip word={intake.mode === "manager" ? "管理者入口" : "提交入口"} tone="info" /></div>
      <label>商户<AvInput required maxLength={120} value={form.merchant} onChange={(event) => set("merchant", event.target.value)} /></label>
      <label>金额<AvInput required inputMode="decimal" value={form.amount} onChange={(event) => set("amount", event.target.value)} /></label>
      <label>发生日期<AvInput required type="date" value={form.expense_date} onChange={(event) => set("expense_date", event.target.value)} /></label>
      <label className="iv-file">PDF 文件<input required type="file" accept="application/pdf,.pdf" onChange={(event) => onFile(event.target.files?.[0] ?? null)} /><small>{file ? `${file.name} · ${Math.ceil(file.size / 1024)} KiB` : "请选择不超过 180 KiB 的 PDF"}</small></label>
      <label className="iv-description">说明<AvTextArea maxLength={1000} rows={2} value={form.description} onChange={(event) => set("description", event.target.value)} /></label>
      <AvButton htmlType="submit" tone="primary" loading={busy} disabled={!file || !form.merchant.trim() || !form.amount || !form.expense_date}>{submitLabel || "提交"}</AvButton>
    </form> : null}
    {notice ? <Banner tone={notice.tone} title={notice.text} /> : null}
    {intake.mode === "manager" ? <>
      <RecordTable title="处理中" rows={intake.processing} empty="没有处理中的记录。" onOpen={setSelected} />
      <RecordTable title="已处理" rows={intake.completed} empty="还没有处理完成的记录。" onOpen={setSelected} />
    </> : <RecordTable title="我的提交" rows={intake.mine} empty="你还没有提交记录。" onOpen={setSelected} />}
    <ModalDialog open={Boolean(selected)} title={selected?.title || "记录详情"} onClose={() => { setSelected(null); setPreview(false); }}>
      {selected ? <div className="iv-detail">
        <div className="iv-detail-head"><StatusChip word={selected.badge || selected.status} tone={selected.tone} /><span>{selected.subtitle}</span></div>
        <dl><dt>提交人</dt><dd>{selected.author}</dd><dt>商户</dt><dd>{selected.merchant}</dd><dt>金额</dt><dd>{selected.amount}</dd><dt>日期</dt><dd>{selected.date}</dd><dt>说明</dt><dd>{selected.description || "—"}</dd></dl>
        {selected.attachment ? <><AvButton onClick={() => setPreview((value) => !value)}>📄 {selected.attachment.name}</AvButton>
          {preview ? <div className="iv-paper" role="document"><b>安全预览</b><p>{selected.attachment.name} · {selected.attachment.type} · {selected.attachment.size} bytes</p><hr />{Object.entries(selected.extracted).map(([key, value]) => <p key={key}><strong>{key}</strong><span>{value}</span></p>)}</div> : null}</> : null}
        <div className="iv-detail-actions"><AvButton tone="quiet" onClick={() => setHistory(true)}>⚙ Agent 历史 · {selected.history.length}</AvButton>
          {intake.mode === "manager" && selected.status === "review" ? <><AvButton tone="primary" disabled={busy} onClick={() => onDecide(selected.id, "approve")}>通过</AvButton><AvButton tone="danger" disabled={busy} onClick={() => onDecide(selected.id, "reject")}>退回</AvButton></> : null}</div>
      </div> : null}
    </ModalDialog>
    <ModalDialog open={history} title="处理 Agent 历史" onClose={() => setHistory(false)}>
      <ol className="iv-history">{selected?.history.map((item, index) => <li key={`${item.at}-${index}`}><StatusChip word={item.title} tone={item.tone} /><small>{item.at}</small><p>{item.detail}</p></li>)}</ol>
    </ModalDialog>
  </section>;
}

function RecordTable({ title, rows, empty, onOpen }: { title: string; rows: readonly IntakeRecord[]; empty: string; onOpen(record: IntakeRecord): void }) {
  return <section className="iv-table"><h3>{title}<small>{rows.length}</small></h3>{rows.length ? <div role="table">
    {rows.map((row) => <button type="button" role="row" key={row.id} onClick={() => onOpen(row)}><span>{row.title}</span><span>{row.author}</span><span>{row.amount}</span><StatusChip word={row.badge || row.status} tone={row.tone} /></button>)}
  </div> : <p className="iv-note">{empty}</p>}</section>;
}
