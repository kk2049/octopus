/**
 * Fold the immutable event log into what the generic data modules render.
 *
 * Shape decisions, each answering a defect the first release shipped with:
 *
 *  - Every brief carries its OWN `evidence`/`coverage` (rendered as sections of
 *    the record) and its own `thread` (request → publish → corrections →
 *    acknowledgement). There is no "latest evidence" panel any more, so what
 *    you read always belongs to the summary you opened.
 *  - `latest_id` drives `default_ref`: a fresh workspace shows the newest
 *    summary instead of an empty pane.
 *  - A request completes by explicit `request_id` first, period equality as a
 *    fallback — "本周" vs "2026-08-13" no longer strands a request forever.
 *  - `counts` are historical totals for id minting (ids are never reused).
 *  - schema 3 stamps human events `user:<name>`; agent turns keep their
 *    `agent:` prefix and are displayed as the local Agent.
 */

interface Ev {
  at?: string;
  by?: string;
  type?: string;
  data?: Record<string, unknown>;
}

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const day = (at: string): string => (at.length >= 16 ? at.slice(5, 16).replace("T", " ") : at);

function actorOf(by: string): string {
  if (by.startsWith("user:")) return by.slice(5);
  if (by.startsWith("agent:")) return "本地 Agent";
  return by || "—";
}

export function project(events: unknown[]) {
  return projectIncremental({}, events);
}

export function projectIncremental(snapshot: unknown, events: unknown[]) {
  interface Brief {
    id: string;
    title: string;
    period: string;
    subtitle: string;
    badge: string;
    tone: string;
    body: string;
    evidence: string;
    coverage: string;
    published_at: string;
    published_by: string;
    acknowledged: boolean;
    corrections: number;
    focus: string;
    thread: Array<{ id: string; by: string; at: string; text: string; badge: string; tone: string }>;
  }
  interface Request {
    id: string;
    period: string;
    focus: string;
    at: string;
    by: string;
    status: "pending" | "completed";
    summary_id: string;
  }

  const prior = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
  const briefs: Brief[] = Array.isArray(prior.briefs)
    ? JSON.parse(JSON.stringify(prior.briefs)) as Brief[]
    : [];
  const byId = new Map<string, Brief>();
  for (const brief of briefs) byId.set(brief.id, brief);
  const requests: Request[] = Array.isArray(prior.requests)
    ? (JSON.parse(JSON.stringify(prior.requests)) as Request[]).reverse()
    : [];
  const requestById = new Map<string, Request>();
  for (const request of requests) requestById.set(request.id, request);
  const counts = prior.counts && typeof prior.counts === "object" && !Array.isArray(prior.counts)
    ? prior.counts as Record<string, unknown>
    : {};
  let requestCount = Number.isSafeInteger(counts.requests) ? Number(counts.requests) : requests.length;
  let briefCount = Number.isSafeInteger(counts.briefs) ? Number(counts.briefs) : briefs.length;

  const complete = (request: Request | undefined, brief: Brief): void => {
    if (!request || request.status === "completed") return;
    request.status = "completed";
    request.summary_id = brief.id;
    brief.focus = brief.focus || request.focus;
    brief.thread.unshift({
      id: `${brief.id}-request`,
      by: actorOf(request.by),
      at: day(request.at),
      text: request.focus ? `请求总结：${request.focus}` : "请求了一次总结",
      badge: "请求",
      tone: "neutral",
    });
  };

  for (const row of (Array.isArray(events) ? events : []) as Ev[]) {
    const data = row?.data ?? {};
    const by = str(row?.by);
    const at = str(row?.at);
    if (row?.type === "summary_requested") {
      requestCount += 1;
      const request: Request = {
        id: str(data.id),
        period: str(data.period),
        focus: str(data.focus),
        at,
        by,
        status: "pending",
        summary_id: "",
      };
      requests.push(request);
      requestById.set(request.id, request);
    } else if (row?.type === "summary_published") {
      briefCount += 1;
      const brief: Brief = {
        id: str(data.id),
        title: str(data.headline, "总结"),
        period: str(data.period),
        subtitle: "",
        badge: "待确认",
        tone: "info",
        body: str(data.body),
        evidence: str(data.evidence),
        coverage: str(data.coverage),
        published_at: day(at),
        published_by: actorOf(by),
        acknowledged: false,
        corrections: 0,
        focus: "",
        thread: [
          { id: `${str(data.id)}-published`, by: actorOf(by), at: day(at), text: "", badge: "发布", tone: "info" },
        ],
      };
      briefs.unshift(brief);
      byId.set(brief.id, brief);
      // Explicit linkage first; period equality only completes the OLDEST
      // still-pending request with that period, oldest first, so one publish
      // does not swallow a queue of distinct asks.
      const named = requestById.get(str(data.request_id));
      if (named) complete(named, brief);
      else complete(requests.find((request) => request.status === "pending" && request.period === brief.period), brief);
    } else if (row?.type === "summary_corrected") {
      const brief = byId.get(str(data.summary_id));
      if (!brief) continue;
      brief.body = str(data.body, brief.body);
      brief.corrections += 1;
      if (!brief.acknowledged) {
        brief.badge = "已修正";
        brief.tone = "warn";
      }
      brief.thread.push({
        id: `${brief.id}-fix-${brief.corrections}`,
        by: actorOf(by),
        at: day(at),
        text: str(data.reason),
        badge: "修正",
        tone: "warn",
      });
    } else if (row?.type === "summary_acknowledged") {
      const brief = byId.get(str(data.summary_id));
      if (!brief || brief.acknowledged) continue;
      brief.acknowledged = true;
      brief.badge = "已确认";
      brief.tone = "ok";
      brief.thread.push({
        id: `${brief.id}-ack`,
        by: actorOf(by),
        at: day(at),
        text: "",
        badge: "已确认",
        tone: "ok",
      });
    }
  }

  for (const brief of briefs) {
    brief.subtitle = `${brief.period}${brief.period ? " · " : ""}${brief.published_by}`;
  }
  const pending = requests.filter((request) => request.status === "pending");
  const unread = briefs.filter((brief) => !brief.acknowledged);

  return {
    briefs,
    latest_id: briefs[0]?.id ?? "",
    requests: requests
      .slice()
      .reverse()
      .map((request) => ({
        ...request,
        title: request.period || request.id,
        subtitle: request.focus || "无额外关注点",
        badge: request.status === "completed" ? "已完成" : "待处理",
        tone: request.status === "completed" ? "ok" : "warn",
      })),
    requests_notice: pending.length
      ? { tone: "info", text: `有 ${pending.length} 条请求在等你本机的 Agent 读取处理。` }
      : null,
    status_panel: {
      title: "概览",
      body:
        briefs.length === 0
          ? "还没有任何总结。\n\n1. 在下方「请求总结」记下周期与关注点；\n2. 让你本机的 Agent 通过 MCP 读取本 App 投影并调用 `publish_summary` 写回结果。\n\n事实留在事件链，模型运行在你的设备，证据只按最小范围披露。"
          : "",
      总结: briefs.length,
      待确认: unread.length,
      待处理请求: pending.length,
      修订: briefs.reduce((sum, brief) => sum + brief.corrections, 0),
    },
    brief_fields: {
      period: "周期",
      published_at: "发布时间",
      published_by: "发布者",
      focus: "请求关注点",
      badge: "状态",
      corrections: "修订次数",
    },
    brief_sections: { evidence: "证据快照", coverage: "覆盖范围" },
    brief_menu: [
      {
        action: "acknowledge_summary",
        label: "确认已读",
        fields: "acknowledge_params",
        title: "确认已读",
        submit_label: "确认",
        context_param: "summary_id",
      },
      {
        action: "correct_summary",
        label: "追加修正",
        fields: "correct_params",
        title: "追加修正",
        submit_label: "提交修正",
        hint: "修正是追加的事件；原文完整留在事件链里。",
        context_param: "summary_id",
      },
    ],
    action_menu: [
      {
        action: "request_summary",
        label: "请求总结",
        fields: "request_params",
        title: "请求一次总结",
        submit_label: "加入待处理",
        hint: "这里只记录请求；推理由你本机的 Agent 通过 MCP 完成。",
      },
    ],
    request_params: {
      period: { type: "string", label: "周期", required: true, description: "例如 2026-08-13 或 本周" },
      focus: { type: "text", label: "关注点", required: false, description: "希望本地 Agent 重点回答的问题" },
    },
    correct_params: {
      summary_id: { type: "string", label: "总结 ID", required: true },
      body: { type: "text", label: "修正后的正文", required: true },
      reason: { type: "text", label: "修正原因", required: true },
    },
    acknowledge_params: { summary_id: { type: "string", label: "总结 ID", required: true } },
    counts: { requests: requestCount, briefs: briefCount },
  };
}
