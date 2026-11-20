/**
 * The report domain state machine. Membership and roles are platform evidence.
 *
 * Handlers return event CONTENT — the runtime's shape check wants `at`/`by`
 * present, but the trusted coordinator overwrites both before the commit.
 * `ctx.actor.user` is trusted coordinator context (never a request parameter);
 * it is kept in domain data so the shared projection can show real authorship
 * while the commit's `by` stamp still distinguishes a button from an agent
 * turn. Ids are minted from the projection's historical `counts`. Errors name
 * what exists, for the person (or model) that acted.
 */

export function submit_report(ctx: any, params: any) {
  const id = `report-${tally(ctx) + 1}`;
  return {
    events: [event(ctx, "report_submitted", {
      id,
      subject: required(params?.subject, 200, "subject"),
      recipient: optional(params?.recipient, 120, "recipient"),
      period: optional(params?.period, 120, "period"),
      body: required(params?.body, 4096, "body"),
      evidence: optional(params?.evidence, 4096, "evidence"),
    })],
    result: { report_id: id },
  };
}

export function mark_seen(ctx: any, params: any) {
  const report = liveReport(ctx, params?.report_id);
  const actor = String(ctx?.actor?.user ?? "");
  if (actor && Array.isArray(report.seen_by) && report.seen_by.includes(actor)) {
    throw new Error(`你已经标记过「${report.id}」已阅`);
  }
  return { events: [event(ctx, "report_seen", { report_id: report.id })], result: { report_id: report.id } };
}

export function comment_report(ctx: any, params: any) {
  const report = liveReport(ctx, params?.report_id);
  return {
    events: [event(ctx, "report_commented", {
      report_id: report.id,
      body: required(params?.body, 2000, "body"),
    })],
    result: { report_id: report.id },
  };
}

export function record_decision(ctx: any, params: any) {
  const report = liveReport(ctx, params?.report_id);
  return {
    events: [event(ctx, "report_decided", {
      report_id: report.id,
      decision: required(params?.decision, 500, "decision"),
    })],
    result: { report_id: report.id },
  };
}

export function close_report(ctx: any, params: any) {
  const report = liveReport(ctx, params?.report_id);
  return { events: [event(ctx, "report_closed", { report_id: report.id })], result: { report_id: report.id } };
}

export function retract_report(ctx: any, params: any) {
  const report = liveReport(ctx, params?.report_id);
  const actor = String(ctx?.actor?.user ?? "");
  if (!actor || report.author !== actor) throw new Error("只有提交者本人可以撤回这份汇报");
  return {
    events: [event(ctx, "report_retracted", {
      report_id: report.id,
      reason: required(params?.reason, 500, "reason"),
    })],
    result: { report_id: report.id },
  };
}

function liveReport(ctx: any, raw: any): any {
  const id = required(raw, 80, "report_id");
  const rows = list(ctx?.state?.reports);
  const report = rows.find((row: any) => row?.id === id);
  if (!report) {
    const have = rows.map((row: any) => row.id).join("、") || "（空）";
    throw new Error(`没有汇报「${id}」。现有：${have}`);
  }
  if (report.status === "closed" || report.status === "retracted") {
    throw new Error(`「${id}」已经${report.status === "closed" ? "关闭" : "被撤回"}，不能再操作`);
  }
  return report;
}
function list(value: any): any[] { return Array.isArray(value) ? value : []; }
function tally(ctx: any): number {
  const value = ctx?.state?.counts?.reports;
  if (Number.isInteger(value) && value >= 0) return value;
  return list(ctx?.state?.reports).length;
}
function required(value: any, max: number, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} is required`);
  return value.trim();
}
function optional(value: any, max: number, name: string): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > max) throw new Error(`${name} is invalid`);
  return value.trim();
}
function event(ctx: any, type: string, data: any) {
  // `actor.user` is trusted coordinator context, never a request parameter.
  // The at/by fields satisfy the runtime's event shape; the coordinator
  // replaces both with its own stamps before anything is committed.
  return {
    type,
    data: { ...data, actor_user: String(ctx?.actor?.user ?? "") },
    at: String(ctx?.now ?? ""),
    by: "report-space",
  };
}
