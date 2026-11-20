/**
 * Pure domain actions. Resource reads happen outside this App through MCP.
 *
 * Handlers return event CONTENT — the runtime's shape check wants `at`/`by`
 * present, but the trusted coordinator overwrites both before the commit, so
 * nothing here can actually claim an author or a time. Ids are minted from the
 * projection's historical `counts`, never from the current array length, so a
 * removed row can never cause an id to be reused. Errors are written for the
 * person (or model) that acted: they name what exists, v3-style.
 */

export function request_summary(ctx: any, params: any) {
  const period = required(params?.period, 120, "period");
  const focus = optional(params?.focus, 1000, "focus");
  const id = `request-${tally(ctx, "requests") + 1}`;
  return {
    events: [event(ctx, "summary_requested", { id, period, focus })],
    result: { request_id: id, queued: true },
  };
}

export function publish_summary(ctx: any, params: any) {
  const period = required(params?.period, 120, "period");
  const headline = required(params?.headline, 200, "headline");
  const body = required(params?.body, 4096, "body");
  const evidence = optional(params?.evidence, 4096, "evidence");
  const coverage = optional(params?.coverage, 800, "coverage");
  const requestId = optional(params?.request_id, 80, "request_id");
  if (requestId) {
    const pending = rows(ctx, "requests").filter((row: any) => row?.status === "pending");
    if (!pending.some((row: any) => row?.id === requestId)) {
      const have = pending.map((row: any) => row.id).join("、") || "（没有待处理请求）";
      throw new Error(`没有待处理的请求「${requestId}」。现有：${have}`);
    }
  }
  const id = `summary-${tally(ctx, "briefs") + 1}`;
  return {
    events: [event(ctx, "summary_published", { id, period, headline, body, evidence, coverage, request_id: requestId })],
    result: { summary_id: id },
  };
}

export function correct_summary(ctx: any, params: any) {
  const brief = liveBrief(ctx, params?.summary_id);
  return {
    events: [
      event(ctx, "summary_corrected", {
        summary_id: brief.id,
        body: required(params?.body, 4096, "body"),
        reason: required(params?.reason, 500, "reason"),
      }),
    ],
    result: { summary_id: brief.id },
  };
}

export function acknowledge_summary(ctx: any, params: any) {
  const brief = liveBrief(ctx, params?.summary_id);
  if (brief.acknowledged === true) throw new Error(`「${brief.id}」已经确认过了`);
  return {
    events: [event(ctx, "summary_acknowledged", { summary_id: brief.id })],
    result: { summary_id: brief.id },
  };
}

function liveBrief(ctx: any, raw: any): any {
  const id = required(raw, 80, "summary_id");
  const brief = rows(ctx, "briefs").find((row: any) => row?.id === id);
  if (!brief) {
    const have = rows(ctx, "briefs").map((row: any) => row.id).join("、") || "（空）";
    throw new Error(`没有总结「${id}」。现有：${have}`);
  }
  return brief;
}

function rows(ctx: any, key: string): any[] {
  const value = ctx?.state?.[key];
  return Array.isArray(value) ? value : [];
}
function tally(ctx: any, key: string): number {
  const value = ctx?.state?.counts?.[key];
  if (Number.isInteger(value) && value >= 0) return value;
  return rows(ctx, key).length;
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
  // The runtime's event shape wants at/by present; the trusted coordinator
  // replaces both with its own stamps before anything is committed.
  return { type, data, at: String(ctx?.now ?? ""), by: "daily-brief" };
}
