/**
 * One shared projection for one explicit disclosure boundary.
 *
 * Shape decisions, each answering a defect the first release shipped with:
 *
 *  - Every report carries its OWN `evidence` (a section of the record) and its
 *    own `thread` — submission, who marked it seen, every comment, the
 *    decision, closing, retraction. The cross-report "最近讨论" soup and the
 *    always-latest evidence pane are gone; what you read belongs to the report
 *    you opened.
 *  - Status is a PRIORITY, computed after the fold: 已撤回 > 已关闭 > 有结论 >
 *    已阅 > 待阅. A late `mark_seen` can no longer downgrade "有结论".
 *  - `feed` is the space's activity stream with each entry naming its report.
 *  - `latest_id` drives `default_ref`; `counts` mint ids from history.
 */

interface Ev {
  at?: string;
  by?: string;
  type?: string;
  data?: Record<string, unknown>;
}

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const day = (at: string): string => (at.length >= 16 ? at.slice(5, 16).replace("T", " ") : at);

export function project(events: unknown[]) {
  return projectIncremental({}, events);
}

export function projectIncremental(snapshot: unknown, events: unknown[]) {
  interface Report {
    id: string;
    title: string;
    subject: string;
    recipient: string;
    period: string;
    body: string;
    evidence: string;
    author: string;
    submitted_via: string;
    submitted_at: string;
    status: "open" | "closed" | "retracted";
    seen_by: string[];
    decision: string;
    comments: number;
    retract_reason: string;
    badge: string;
    tone: string;
    subtitle: string;
    thread: Array<{ id: string; by: string; at: string; text: string; badge: string; tone: string }>;
  }

  const prior = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
  const chronological: Report[] = Array.isArray(prior.reports)
    ? (JSON.parse(JSON.stringify(prior.reports)) as Report[]).reverse()
    : [];
  const byId = new Map<string, Report>();
  for (const report of chronological) byId.set(report.id, report);
  const feed: Array<{ id: string; title: string; subtitle: string; tone?: string }> = Array.isArray(prior.feed)
    ? (JSON.parse(JSON.stringify(prior.feed)) as Array<{ id: string; title: string; subtitle: string; tone?: string }>).reverse()
    : [];
  const counts = prior.counts && typeof prior.counts === "object" && !Array.isArray(prior.counts)
    ? prior.counts as Record<string, unknown>
    : {};
  let reportCount = Number.isSafeInteger(counts.reports) ? Number(counts.reports) : chronological.length;
  let eventCount = feed.reduce((max, row) => Math.max(max, Number(/^evt-(\d+)$/.exec(row.id)?.[1] ?? 0)), 0);

  const tell = (title: string, at: string, tone?: string): void => {
    eventCount += 1;
    feed.push({ id: `evt-${eventCount}`, title, subtitle: day(at), ...(tone ? { tone } : {}) });
  };

  for (const row of (Array.isArray(events) ? events : []) as Ev[]) {
    const data = row?.data ?? {};
    const evidenceActor = str(row?.by);
    const by = str(data.actor_user as string, evidenceActor).replace(/^user:/, "");
    const at = str(row?.at);
    if (row?.type === "report_submitted") {
      reportCount += 1;
      const report: Report = {
        id: str(data.id),
        title: str(data.subject, "汇报"),
        subject: str(data.subject),
        recipient: str(data.recipient, "全体成员"),
        period: str(data.period),
        body: str(data.body),
        evidence: str(data.evidence),
        author: by,
        submitted_via: evidenceActor.startsWith("agent:") ? "代理提交" : "本人操作",
        submitted_at: day(at),
        status: "open",
        seen_by: [],
        decision: "",
        comments: 0,
        retract_reason: "",
        badge: "",
        tone: "",
        subtitle: "",
        thread: [
          { id: `${str(data.id)}-submitted`, by, at: day(at), text: "", badge: "提交", tone: "info" },
        ],
      };
      chronological.push(report);
      byId.set(report.id, report);
      tell(`${by} 发起了「${report.title}」`, at, "info");
      continue;
    }
    const report = byId.get(str(data.report_id));
    if (!report) continue;
    if (row?.type === "report_seen") {
      if (!report.seen_by.includes(by)) report.seen_by.push(by);
      report.thread.push({ id: `${report.id}-seen-${report.seen_by.length}`, by, at: day(at), text: "", badge: "已阅", tone: "neutral" });
    } else if (row?.type === "report_commented") {
      report.comments += 1;
      report.thread.push({ id: `${report.id}-comment-${report.comments}`, by, at: day(at), text: str(data.body), badge: "讨论", tone: "neutral" });
      tell(`${by} 在「${report.title}」下讨论`, at);
    } else if (row?.type === "report_decided") {
      report.decision = str(data.decision);
      report.thread.push({ id: `${report.id}-decision-${report.thread.length}`, by, at: day(at), text: report.decision, badge: "结论", tone: "ok" });
      tell(`${by} 为「${report.title}」记录了结论`, at, "ok");
    } else if (row?.type === "report_closed") {
      report.status = "closed";
      report.thread.push({ id: `${report.id}-closed-${report.thread.length}`, by, at: day(at), text: "", badge: "关闭", tone: "neutral" });
      tell(`${by} 关闭了「${report.title}」`, at);
    } else if (row?.type === "report_retracted") {
      report.status = "retracted";
      report.retract_reason = str(data.reason);
      report.thread.push({ id: `${report.id}-retracted-${report.thread.length}`, by, at: day(at), text: report.retract_reason, badge: "撤回", tone: "error" });
      tell(`${by} 撤回了「${report.title}」`, at, "error");
    }
  }

  for (const report of chronological) {
    // One priority order, applied once: a late mark_seen cannot downgrade a
    // decided report, and a retraction outranks everything.
    if (report.status === "retracted") {
      report.badge = "已撤回";
      report.tone = "error";
      const notice = `> 此汇报已由提交者撤回：${report.retract_reason}\n\n`;
      if (!report.body.startsWith(notice)) report.body = `${notice}${report.body}`;
    } else if (report.status === "closed") {
      report.badge = "已关闭";
      report.tone = "ok";
    } else if (report.decision) {
      report.badge = "有结论";
      report.tone = "ok";
    } else if (report.seen_by.length) {
      report.badge = "已阅";
      report.tone = "info";
    } else {
      report.badge = "待阅";
      report.tone = "warn";
    }
    report.subtitle = `${report.author || "成员"} → ${report.recipient}${report.period ? ` · ${report.period}` : ""}`;
  }

  const reports = chronological.slice().reverse();
  const open = reports.filter((report) => report.status === "open");
  const unseen = open.filter((report) => !report.seen_by.length);

  return {
    reports,
    latest_id: reports[0]?.id ?? "",
    feed: feed.slice(-100).reverse(),
    reports_notice: unseen.length
      ? { tone: "warn", text: `有 ${unseen.length} 份汇报还没有人标记已阅。` }
      : null,
    room_panel: {
      title: "空间概览",
      body:
        reports.length === 0
          ? "这个共享空间还没有汇报。成员在下方「发起汇报」提交正文与最小披露的证据快照；讨论、结论与关闭都会留在同一条可审计的事实链上。"
          : "",
      汇报: reports.length,
      进行中: open.length,
      待阅: unseen.length,
      有结论: reports.filter((report) => Boolean(report.decision)).length,
      讨论: reports.reduce((sum, report) => sum + report.comments, 0),
    },
    report_fields: {
      author: "提交者",
      submitted_via: "提交途径",
      recipient: "接收人",
      period: "周期",
      submitted_at: "提交时间",
      badge: "状态",
      seen_by: "已阅成员",
      comments: "讨论数",
      decision: "结论",
    },
    report_sections: { evidence: "证据快照" },
    report_menu: [
      { action: "mark_seen", label: "标记已阅", fields: "seen_params", title: "标记已阅", submit_label: "确认已阅", context_param: "report_id" },
      { action: "comment_report", label: "参与讨论", fields: "comment_params", title: "参与讨论", submit_label: "发表", context_param: "report_id" },
      { action: "record_decision", label: "记录结论", fields: "decision_params", title: "记录结论", submit_label: "记录", context_param: "report_id" },
      { action: "close_report", label: "关闭汇报", fields: "close_params", title: "关闭汇报", submit_label: "关闭", context_param: "report_id" },
      {
        action: "retract_report", label: "撤回", fields: "retract_params", title: "撤回自己的汇报",
        submit_label: "撤回", context_param: "report_id", hint: "只有提交者本人可以撤回；撤回原因会留在事实链上。",
      },
    ],
    action_menu: [
      {
        action: "submit_report", label: "发起汇报", fields: "submit_params", title: "发起汇报",
        submit_label: "发布到共享空间", hint: "证据快照只粘贴共享所需的最小文件名、引用和摘录。",
      },
    ],
    submit_params: {
      subject: { type: "string", label: "标题", required: true },
      recipient: { type: "string", label: "主要接收人", required: false },
      period: { type: "string", label: "周期", required: false },
      body: { type: "text", label: "汇报正文", required: true },
      evidence: { type: "text", label: "证据快照", required: false, description: "只粘贴共享所需的最小文件名、引用和摘录" },
    },
    seen_params: { report_id: { type: "string", label: "报告 ID", required: true } },
    comment_params: {
      report_id: { type: "string", label: "报告 ID", required: true },
      body: { type: "text", label: "讨论内容", required: true },
    },
    decision_params: {
      report_id: { type: "string", label: "报告 ID", required: true },
      decision: { type: "text", label: "结论或下一步", required: true },
    },
    close_params: { report_id: { type: "string", label: "报告 ID", required: true } },
    retract_params: {
      report_id: { type: "string", label: "报告 ID", required: true },
      reason: { type: "text", label: "撤回原因", required: true },
    },
    counts: { reports: reportCount },
  };
}
