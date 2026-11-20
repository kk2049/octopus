const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_PDF_BYTES = 184_320;

export function submit_expense(ctx: any, params: any) {
  role(ctx, ["submitter"]);
  const merchant = field(params?.merchant, 120, "merchant").trim();
  if (!merchant) throw new Error("merchant is required");
  const amount = amountOf(params?.amount);
  const expenseDate = field(params?.expense_date, 10, "expense_date");
  if (!DATE.test(expenseDate) || !validDate(expenseDate)) throw new Error("expense_date must be YYYY-MM-DD");
  const description = optional(params?.description, 1000, "description").trim();
  const attachment = pdfOf(params?.receipt_pdf);
  const sequence = Number(ctx?.state?.sequence ?? 0) + 1;
  const id = `expense-${sequence}`;
  const extracted = {
    商户: merchant,
    金额: money(amount),
    日期: expenseDate,
    说明: description || "—",
    发票号码: "DEMO-待核验",
  };
  const events: any[] = [
    event(ctx, "expense_submitted", { id, merchant, amount, expense_date: expenseDate, description, attachment }),
    event(ctx, "agent_step", { id, title: "PDF 接收", detail: `${attachment.name} 已进入隔离处理队列`, tone: "info" }),
    event(ctx, "agent_step", { id, title: "字段提取", detail: "演示提取器已写入商户、金额、日期和待核验发票号", tone: "ok", extracted }),
  ];
  if (amount <= 5000) {
    events.push(event(ctx, "expense_completed", { id, decision: "auto_approved", detail: "金额不超过 ¥5,000，演示规则自动通过" }));
  } else {
    events.push(event(ctx, "expense_review_requested", { id, detail: "金额超过 ¥5,000，等待管理者复核" }));
  }
  return { events, result: { id, status: amount <= 5000 ? "approved" : "review" } };
}

export function approve_expense(ctx: any, params: any) { return decide(ctx, params, "approved"); }
export function reject_expense(ctx: any, params: any) { return decide(ctx, params, "rejected"); }

function decide(ctx: any, params: any, decision: "approved" | "rejected") {
  role(ctx, ["manager"]);
  const id = field(params?.expense_id, 80, "expense_id");
  if (!ID.test(id)) throw new Error("expense_id is invalid");
  const record = Array.isArray(ctx?.state?.records) ? ctx.state.records.find((item: any) => item?.id === id) : null;
  if (!record) throw new Error("expense does not exist");
  if (record.status !== "review") throw new Error("expense is not awaiting review");
  const title = decision === "approved" ? "管理者通过" : "管理者退回";
  return { events: [event(ctx, "expense_decided", { id, decision, detail: title })], result: { id, status: decision } };
}

function pdfOf(value: any): { name: string; type: string; size: number; data: string } {
  if (typeof value !== "string" || value.length > 262_144) throw new Error("receipt_pdf envelope is invalid");
  let row: any;
  try { row = JSON.parse(value); } catch { throw new Error("receipt_pdf envelope is invalid"); }
  if (!row || Array.isArray(row) || typeof row !== "object") throw new Error("receipt_pdf envelope is invalid");
  const name = field(row.name, 160, "PDF name");
  const type = field(row.type, 80, "PDF type");
  const size = row.size;
  const data = row.data;
  if (!name.toLowerCase().endsWith(".pdf") || name.includes("/") || name.includes("\\") || type !== "application/pdf") throw new Error("only application/pdf is accepted");
  if (!Number.isInteger(size) || size < 5 || size > MAX_PDF_BYTES || typeof data !== "string" || data.length !== Math.ceil(size / 3) * 4 || !BASE64.test(data) || !data.startsWith("JVBERi0")) throw new Error("PDF payload is invalid or too large");
  return { name, type, size, data };
}

function amountOf(value: any): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(value)) throw new Error("amount must be a positive decimal");
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new Error("amount must be inside 0..1000000");
  return Math.round(amount * 100) / 100;
}
function money(value: number): string { return `¥${value.toFixed(2)}`; }
function role(ctx: any, allowed: string[]): string { const value = ctx?.actor?.role; if (!allowed.includes(value)) throw new Error("actor role is not allowed"); return value; }
function field(value: any, max: number, name: string): string { if (typeof value !== "string" || !value || value.length > max) throw new Error(`${name} is invalid`); return value; }
function optional(value: any, max: number, name: string): string { if (value === undefined || value === null) return ""; if (typeof value !== "string" || value.length > max) throw new Error(`${name} is invalid`); return value; }
function validDate(value: string): boolean { const [year, month, day] = value.split("-").map(Number); const parsed = new Date(Date.UTC(year!, month! - 1, day)); return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day; }
function event(ctx: any, type: string, data: any) { return { type, data, at: String(ctx?.now ?? ""), by: "expense-intake" }; }
