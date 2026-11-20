import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAgentViewStatus, useProjection, useProposals, usePropose } from "@claude-bot/agent-view-react";
import "./styles/expense-v2.css";

const MAX_PDF_BYTES = 184_320;
const MAX_ENVELOPE_CHARS = 262_144;

interface HistoryRow { at?: string; by?: string; title?: string; detail?: string; tone?: string }
interface AttachmentMeta { name?: string; type?: string; size?: number }
interface ExpenseRecord {
  id?: string; author?: string; merchant?: string; amount?: string; amount_value?: number; date?: string;
  description?: string; status?: "processing" | "review" | "approved" | "rejected"; badge?: string; tone?: string;
  history?: HistoryRow[]; attachment?: AttachmentMeta; attachment_name?: string; attachment_size?: number;
  extracted?: Record<string, unknown>;
}
interface ExpenseProjection {
  intake?: { mode?: "manager" | "submitter"; can_submit?: boolean; mine?: ExpenseRecord[]; processing?: ExpenseRecord[]; completed?: ExpenseRecord[] };
}
interface Draft { merchant: string; amount: string; expenseDate: string; description: string }

function safeRecords(value: unknown): ExpenseRecord[] { return Array.isArray(value) ? value.filter((item): item is ExpenseRecord => Boolean(item) && typeof item === "object") : []; }
function safeHistory(value: unknown): HistoryRow[] { return Array.isArray(value) ? value.filter((item): item is HistoryRow => Boolean(item) && typeof item === "object") : []; }
function bytesLabel(value: number | undefined): string { return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("zh-CN")} bytes` : "大小未知"; }
function statusClass(status: ExpenseRecord["status"]): string { return status === "review" ? "is-review" : status === "approved" ? "is-approved" : status === "rejected" ? "is-rejected" : "is-processing"; }
function safeText(value: unknown): string { return typeof value === "string" || typeof value === "number" ? String(value) : "—"; }
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function readPdf(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取这份 PDF，请重新选择。"));
    reader.onload = () => {
      if (typeof reader.result !== "string") return reject(new Error("无法读取这份 PDF，请重新选择。"));
      const comma = reader.result.indexOf(",");
      if (comma < 0) return reject(new Error("PDF 编码失败，请重新选择。"));
      resolve(reader.result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function validateFile(file: File | null): string {
  if (!file) return "请先选择一份 PDF 凭据。";
  if (file.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf") || file.name.includes("/") || file.name.includes("\\")) return "仅接受文件名有效、类型为 application/pdf 的 PDF。";
  if (file.name.length > 160) return "PDF 文件名不能超过 160 个字符。";
  if (file.size < 5 || file.size > MAX_PDF_BYTES) return "PDF 大小必须在 5 bytes 至 180 KiB（184,320 bytes）之间。";
  return "";
}

function StatusBadge({ record }: { record: ExpenseRecord }) {
  return <span className={`expense-v2__status ${statusClass(record.status)}`}>{record.badge || record.status || "状态未知"}</span>;
}

function History({ rows }: { rows: HistoryRow[] | undefined }) {
  const history = safeHistory(rows);
  return history.length ? <ol className="expense-v2__history">{[...history].reverse().map((row, index) => <li key={`${row.at ?? ""}-${index}`}><time>{row.at || "时间未知"}</time><div><strong>{row.title || "状态更新"}</strong><span>{row.detail || ""}</span><small>{row.by || "可信协调器"}</small></div></li>)}</ol> : <p className="expense-v2__muted">尚无状态历史</p>;
}

export function ExpenseWorkbench() {
  const projection = useProjection<ExpenseProjection>();
  const propose = usePropose();
  const { proposals, dismiss } = useProposals();
  const transport = useAgentViewStatus();
  const [draft, setDraft] = useState<Draft>({ merchant: "", amount: "", expenseDate: "", description: "" });
  const [file, setFile] = useState<File | null>(null);
  const [formError, setFormError] = useState("");
  const [submitRefusal, setSubmitRefusal] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ action: "approve_expense" | "reject_expense"; id: string } | null>(null);
  const generation = useRef(0);

  const intake = projection?.intake;
  const mode = intake?.mode;
  const mine = safeRecords(intake?.mine);
  const managerRecords = useMemo(() => mode === "manager" ? [...safeRecords(intake?.processing), ...safeRecords(intake?.completed)] : [], [mode, intake?.processing, intake?.completed]);
  const current = selectedId ? managerRecords.find((record) => record.id === selectedId) : managerRecords[0];
  const latest = (action: string, id?: string) => [...proposals].reverse().find((item) => item.action === action && (!id || item.params.expense_id === id));
  const submitProposal = latest("submit_expense");
  const submitPending = preparing || submitProposal?.phase === "inflight";

  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => {
    const refused = [...proposals].reverse().find((item) => item.action === "submit_expense" && item.phase === "refused");
    if (!refused) return;
    setSubmitRefusal((refused.message || "提交被拒绝。").slice(0, 500));
    dismiss(refused.rid);
  }, [dismiss, proposals]);

  function updateDraft(key: keyof Draft, value: string): void { setDraft((currentDraft) => ({ ...currentDraft, [key]: value })); }

  async function submitExpense(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitPending || intake?.can_submit !== true) return;
    const fileProblem = validateFile(file);
    if (fileProblem) { setFormError(fileProblem); return; }
    if (!draft.merchant.trim()) { setFormError("请填写申报商户。"); return; }
    if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(draft.amount) || Number(draft.amount) <= 0 || Number(draft.amount) > 1_000_000) { setFormError("金额应为 0.01 至 1,000,000，最多两位小数且无多余前导零。"); return; }
    if (!isCalendarDate(draft.expenseDate)) { setFormError("请选择有效的发生日期。"); return; }
    const mineGeneration = ++generation.current;
    setFormError(""); setSubmitRefusal(""); setPreparing(true);
    try {
      const data = await readPdf(file!);
      if (mineGeneration !== generation.current) return;
      const receiptPdf = JSON.stringify({ name: file!.name, type: "application/pdf", size: file!.size, data });
      if (receiptPdf.length > MAX_ENVELOPE_CHARS) throw new Error("PDF 上传封套超过 262,144 字符限制。" );
      const pendingReply = propose("submit_expense", {
        merchant: draft.merchant.trim(), amount: draft.amount, expense_date: draft.expenseDate,
        description: draft.description.trim(), receipt_pdf: receiptPdf,
      });
      setPreparing(false);
      const reply = await pendingReply;
      if (mineGeneration !== generation.current) return;
      if (reply.ok) { setDraft({ merchant: "", amount: "", expenseDate: "", description: "" }); setFile(null); }
    } catch (error) {
      if (mineGeneration === generation.current) setFormError(error instanceof Error ? error.message : "PDF 处理失败。" );
    } finally {
      if (mineGeneration === generation.current) setPreparing(false);
    }
  }

  async function confirmDecision(): Promise<void> {
    if (!confirming) return;
    const { action, id } = confirming;
    const previous = latest(action, id);
    if (previous?.phase === "refused") dismiss(previous.rid);
    setConfirming(null);
    await propose(action, { expense_id: id });
  }

  if (!projection) return <div className="expense-v2__transport" role="status">等待可信费用投影…</div>;
  if (mode !== "submitter" && mode !== "manager") return <div className="expense-v2__transport" role="alert">当前没有可用的费用角色证据。</div>;

  return <div className="expense-v2">
    <header className="expense-v2__topbar"><div className="expense-v2__brand"><span aria-hidden="true"/><strong>凭据流</strong></div><span>{transport.phase === "closed" ? "可信通道已关闭" : mode === "submitter" ? "员工收件" : "财务复核"}</span></header>
    <main className="expense-v2__main">
      <div className="expense-v2__intro"><div><small>{mode === "submitter" ? "MY EXPENSE INTAKE" : "REVIEW QUEUE"}</small><h1>{mode === "submitter" ? "提交一份费用凭据" : "逐笔核验，明确决策"}</h1><p>{mode === "submitter" ? "先申报事实，再上传一份凭据；状态变化会留在你的记录中。" : "从待审队列进入单笔核验台，对照申报值与安全提取值。"}</p></div><aside>{mode === "submitter" ? "这里只显示你自己的申报、附件名称与状态历史；不提供提取载荷。" : "结构化预览只渲染允许文本与附件元数据，不载入原始 PDF。"}</aside></div>
      {mode === "submitter" ? <div className="expense-v2__employee">
        <section className="expense-v2__paper expense-v2__intake"><header><div><small>01 · INTAKE</small><h2>新建费用申报</h2></div>{submitPending ? <span className="expense-v2__status is-processing">处理中</span> : null}</header><div className="expense-v2__limits"><span><b>1 份</b> 凭据</span><span><b>仅 PDF</b></span><span><b>≤ 180 KiB</b>（184,320 bytes）</span></div><form onSubmit={submitExpense}>
          {submitPending ? <div className="expense-v2__notice" role="status">正在读取并提交 PDF；确认前不会创建申报，请勿重复提交。</div> : null}
          {formError ? <div className="expense-v2__error" role="alert">{formError}</div> : null}
          {submitRefusal ? <div className="expense-v2__error" role="alert">{submitRefusal}</div> : null}
          <label className="expense-v2__file"><input aria-label="选择 PDF 凭据" type="file" accept="application/pdf,.pdf" disabled={submitPending} onChange={(event) => { const next = event.target.files?.[0] ?? null; setFile(next); setFormError(validateFile(next)); event.target.value = ""; }} /><i aria-hidden="true">PDF</i><strong>{file ? file.name : "选择一份 PDF 凭据"}</strong><span>{file ? `${bytesLabel(file.size)} · 内容只在明确提交后读取` : "提交前即可看到精确格式与大小限制"}</span></label>
          <div className="expense-v2__form-grid"><label>申报商户<input required maxLength={120} value={draft.merchant} disabled={submitPending} onChange={(event) => updateDraft("merchant", event.target.value)} /></label><label>申报金额<input required inputMode="decimal" value={draft.amount} disabled={submitPending} placeholder="0.00" onChange={(event) => updateDraft("amount", event.target.value)} /></label><label>发生日期<input required type="date" value={draft.expenseDate} disabled={submitPending} onChange={(event) => updateDraft("expenseDate", event.target.value)} /></label><label>说明 <small>选填</small><input maxLength={1000} value={draft.description} disabled={submitPending} onChange={(event) => updateDraft("description", event.target.value)} /></label></div>
          <div className="expense-v2__submit-row"><span>申报值与系统提取值分开保存，供财务核验。</span><button className="expense-v2__primary" type="submit" disabled={submitPending || intake?.can_submit !== true}>{submitPending ? "处理中" : "提交凭据"}</button></div>
        </form></section>
        <section className="expense-v2__paper"><header><div><small>02 · TRACKING</small><h2>我的申报</h2></div></header>{mine.length ? <div className="expense-v2__mine">{mine.map((record) => <article key={record.id || record.merchant}><div><strong>{record.merchant || "未命名商户"}</strong><small>{record.id || "编号待生成"} · {record.date || "日期未知"}</small></div><b>{record.amount || "¥0.00"}</b><StatusBadge record={record}/><div className="expense-v2__record-meta">附件：{record.attachment_name || "未提供名称"} · {bytesLabel(record.attachment_size)}</div><History rows={record.history}/></article>)}</div> : <div className="expense-v2__empty"><i/><h2>还没有费用申报</h2><p>完成收件流程后，你的申报和处理历史会出现在这里。</p></div>}</section>
      </div> : <ManagerWorkspace records={managerRecords} current={current} selectedId={selectedId} onSelect={setSelectedId} proposals={proposals} dismiss={dismiss} onConfirm={setConfirming} />}
    </main>
    {confirming ? <div className="expense-v2__backdrop" role="presentation"><div className="expense-v2__modal" role="dialog" aria-modal="true" aria-labelledby="expense-confirm-title"><small>明确决定</small><h2 id="expense-confirm-title">{confirming.action === "approve_expense" ? "确认批准这笔申报？" : "确认拒绝这笔申报？"}</h2><p>只有可信外层确认后，记录状态与历史才会更新。</p><div><button type="button" onClick={() => setConfirming(null)}>取消</button><button className={confirming.action === "approve_expense" ? "expense-v2__primary" : "expense-v2__danger"} type="button" onClick={confirmDecision}>确认</button></div></div></div> : null}
  </div>;
}

function ManagerWorkspace({ records, current, selectedId, onSelect, proposals, dismiss, onConfirm }: { records: ExpenseRecord[]; current: ExpenseRecord | undefined; selectedId: string | null; onSelect(id: string): void; proposals: readonly { rid: string; action: string; params: Readonly<Record<string,string>>; phase: string; message: string }[]; dismiss(rid: string): void; onConfirm(value: { action: "approve_expense" | "reject_expense"; id: string }): void }) {
  if (!records.length) return <div className="expense-v2__paper expense-v2__empty"><i/><h2>队列已清空</h2><p>当前没有待审或已完成的申报记录。</p></div>;
  return <div className="expense-v2__manager"><aside className="expense-v2__paper expense-v2__queue"><header><div><small>QUEUE</small><h2>逐笔队列</h2></div></header>{records.map((record) => <button type="button" key={record.id} aria-current={(selectedId ? selectedId === record.id : current?.id === record.id) ? "true" : undefined} onClick={() => record.id && onSelect(record.id)}><span><strong>{record.merchant || "未命名商户"}</strong><small>{record.author || "未知提交人"} · {record.id}</small></span><b>{record.amount}</b><StatusBadge record={record}/></button>)}</aside>{current ? <ManagerRecord record={current} proposals={proposals} dismiss={dismiss} onConfirm={onConfirm}/> : <section className="expense-v2__paper expense-v2__empty"><h2>所选记录暂不可用</h2><p>保留当前选择；等待下一份权威投影恢复它。</p></section>}</div>;
}

function ManagerRecord({ record, proposals, dismiss, onConfirm }: { record: ExpenseRecord; proposals: readonly { rid: string; action: string; params: Readonly<Record<string,string>>; phase: string; message: string }[]; dismiss(rid: string): void; onConfirm(value: { action: "approve_expense" | "reject_expense"; id: string }): void }) {
  const related = [...proposals].reverse().find((item) => (item.action === "approve_expense" || item.action === "reject_expense") && item.params.expense_id === record.id);
  const pending = related?.phase === "inflight";
  const extracted = record.extracted && typeof record.extracted === "object" && !Array.isArray(record.extracted) ? record.extracted : {};
  const declared: Array<[string,string]> = [["商户",record.merchant || "—"],["金额",record.amount || "—"],["日期",record.date || "—"],["说明",record.description || "—"]];
  const attachment = record.attachment && typeof record.attachment === "object" ? record.attachment : {};
  return <article className="expense-v2__paper expense-v2__record"><header><div><small>{record.id || "记录"}</small><h1>{record.merchant || "未命名商户"}</h1><p>申报人 {record.author || "未知"} · 附件 {attachment.name || "无名称"} · {bytesLabel(attachment.size)}</p></div><StatusBadge record={record}/></header><div className="expense-v2__record-body">
    {related?.phase === "refused" ? <div className="expense-v2__error" role="alert"><span>{related.message || "审核动作被拒绝。"}</span><button type="button" onClick={() => dismiss(related.rid)}>关闭</button></div> : null}
    <div className="expense-v2__compare"><section><h2>员工申报值</h2>{declared.map(([label,value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section><section><h2>系统提取值 · 仅核验</h2>{Object.entries(extracted).map(([label,value]) => <div key={label}><span>{label}</span><strong>{safeText(value)}</strong></div>)}</section></div>
    <div className="expense-v2__bench"><section><h2>凭据结构化安全预览</h2><div className="expense-v2__receipt"><small>结构化安全预览</small>{Object.entries(extracted).map(([label,value]) => <div key={label}><span>{label}</span><strong>{safeText(value)}</strong></div>)}<p>附件元数据：{attachment.name || "无名称"} · {attachment.type || "类型未知"} · {bytesLabel(attachment.size)}</p></div><p className="expense-v2__muted">只呈现允许文本与附件元数据；不加载链接、脚本、data URL 或原始 PDF。</p></section><aside><h2>参与者与状态历史</h2><History rows={record.history}/></aside></div>
    {record.status === "review" ? <div className="expense-v2__decision"><div><strong>{pending ? "正在确认审核决定" : "做出本笔决定"}</strong><span>{pending ? "权威投影更新前不会改变记录状态。" : "只有可信外层确认后才会生效。"}</span></div><div><button type="button" className="expense-v2__danger" disabled={pending} onClick={() => record.id && onConfirm({ action:"reject_expense", id:record.id })}>拒绝…</button><button type="button" className="expense-v2__primary" disabled={pending} onClick={() => record.id && onConfirm({ action:"approve_expense", id:record.id })}>批准</button></div></div> : <div className="expense-v2__terminal"><strong>该记录已完成</strong><span>保留申报、核验与历史供检查，不再提供审核动作。</span></div>}
  </div></article>;
}
