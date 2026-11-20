export function project(events: any[], context?: any): any {
  return projectIncremental({}, events, context);
}

export function projectIncremental(snapshot: any, events: any[], context?: any) {
  const prior = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
  const records: any[] = Array.isArray(prior.records) ? JSON.parse(JSON.stringify(prior.records)) : [];
  const byId = new Map<string, any>(records.map((record) => [String(record?.id ?? ""), record]));
  let sequence = Number.isSafeInteger(prior.sequence) && prior.sequence >= 0 ? prior.sequence : records.length;
  for (const row of Array.isArray(events) ? events : []) {
    const id = String(row?.data?.id ?? "");
    if (row?.type === "expense_submitted" && id) {
      sequence += 1;
      const record: any = {
        id, author: String(row.by ?? "").replace(/^user:/, ""), merchant: String(row.data.merchant ?? ""),
        amount_value: Number(row.data.amount), amount: money(Number(row.data.amount)), date: String(row.data.expense_date ?? ""),
        description: String(row.data.description ?? ""), attachment: row.data.attachment ?? null, extracted: {},
        status: "processing", badge: "Agent 处理中", tone: "info", history: [],
      };
      records.push(record); byId.set(id, record);
      record.history.push(history(row, "已提交", "材料进入处理流程", "info"));
    } else if (row?.type === "agent_step" && byId.has(id)) {
      const record = byId.get(id);
      record.history.push(history(row, String(row.data.title ?? "Agent 步骤"), String(row.data.detail ?? ""), tone(row.data.tone)));
      if (row.data.extracted && typeof row.data.extracted === "object" && !Array.isArray(row.data.extracted)) record.extracted = row.data.extracted;
    } else if (row?.type === "expense_review_requested" && byId.has(id)) {
      const record = byId.get(id); record.status = "review"; record.badge = "待复核"; record.tone = "warn";
      record.history.push(history(row, "等待复核", String(row.data.detail ?? ""), "warn"));
    } else if (row?.type === "expense_completed" && byId.has(id)) {
      const record = byId.get(id); record.status = "approved"; record.badge = "自动通过"; record.tone = "ok";
      record.history.push(history(row, "自动完成", String(row.data.detail ?? ""), "ok"));
    } else if (row?.type === "expense_decided" && byId.has(id)) {
      const record = byId.get(id); const approved = row.data.decision === "approved";
      record.status = approved ? "approved" : "rejected"; record.badge = approved ? "已通过" : "已退回"; record.tone = approved ? "ok" : "error";
      record.history.push(history(row, approved ? "管理者通过" : "管理者退回", String(row.data.detail ?? ""), approved ? "ok" : "error"));
    }
  }
  const full = records.map(present);
  // No viewer context is the Runtime's private fold used by action handlers.
  // A real View open always supplies `context.viewer`; malformed evidence is
  // treated as an anonymous submitter and receives no records.
  if (!context || !Object.prototype.hasOwnProperty.call(context, "viewer")) {
    return { sequence, records, intake: workspace("manager", false, full, []) };
  }
  const viewer = context.viewer && typeof context.viewer === "object" ? context.viewer : {};
  const user = typeof viewer.user === "string" ? viewer.user : "";
  const role = viewer.role === "manager" ? "manager" : viewer.role === "submitter" ? "submitter" : "";
  if (role === "manager" && user) {
    const visible = full.map(forManager);
    return { sequence, intake: workspace("manager", false, visible, []) };
  }
  if (role === "submitter" && user) {
    const own = full.filter((record) => record.author === user).map(forSubmitter);
    return { sequence, intake: workspace("submitter", true, [], own) };
  }
  return { sequence, intake: workspace("submitter", false, [], []) };
}

function workspace(mode: "manager" | "submitter", canSubmit: boolean, all: any[], mine: any[]) {
  const completed = mode === "manager" ? all.filter((record) => record.status === "approved" || record.status === "rejected") : [];
  const processing = mode === "manager" ? all.filter((record) => record.status === "processing" || record.status === "review") : [];
  return {
    mode, can_submit: canSubmit, completed, processing, mine,
    stats: mode === "manager"
      ? { 已处理: String(completed.length), 处理中: String(processing.length), 待复核: String(processing.filter((record) => record.status === "review").length) }
      : { 我的提交: String(mine.length), 已完成: String(mine.filter((record) => record.status === "approved" || record.status === "rejected").length), 处理中: String(mine.filter((record) => record.status === "processing" || record.status === "review").length) },
  };
}
function present(record: any) { return { ...record, title: `${record.merchant} · ${record.amount}`, subtitle: `${record.author} · ${record.date}` }; }
function forManager({ attachment, ...record }: any) {
  const metadata = attachment && typeof attachment === "object"
    ? { name: String(attachment.name ?? ""), type: String(attachment.type ?? ""), size: Number(attachment.size) || 0 }
    : null;
  return { ...record, attachment: metadata };
}
function forSubmitter({ attachment, extracted: _extracted, ...record }: any) {
  return {
    ...record,
    attachment_name: attachment && typeof attachment === "object" ? String(attachment.name ?? "") : "",
    attachment_size: attachment && typeof attachment === "object" ? Number(attachment.size) || 0 : 0,
  };
}
function history(row: any, title: string, detail: string, toneValue: string) {
  return { at: String(row?.at ?? ""), by: String(row?.by ?? "").replace(/^user:/, ""), title, detail, tone: toneValue };
}
function tone(value: any): string { return ["neutral", "ok", "warn", "error", "info"].includes(value) ? value : "neutral"; }
function money(value: number): string { return Number.isFinite(value) ? `¥${value.toFixed(2)}` : "¥0.00"; }
