/**
 * reports projection — one user's mailbox view, folded from their own log.
 *
 * `report_received` / `reply_received` are written by the delivery broker
 * (`system:delivery/<sender>`) after a gate decision, never by the sender's own
 * handler; this fold treats them as facts about my inbox and never rewrites
 * them. `report_sent` now carries how the transfer ended — sent / pending /
 * failed — because a report that is waiting on an approval is a different fact
 * from one that arrived, and hiding the difference is how a dropped report
 * looks like a delivered one.
 */

interface Ev {
  seq: number;
  at: string;
  by: string;
  type: string;
  data: Record<string, unknown>;
}

interface Thread {
  id: string;
  peer: string;
  title: string;
  body: string;
  at: string;
  read: boolean;
  replies: Array<{ from: string; text: string; at: string }>;
  /** Sent threads only: how the controlled transfer ended. */
  delivery?: string;
  note?: string;
}

const day = (s: string): string => s.slice(5, 10);

export function project(events: readonly Ev[]): Record<string, unknown> {
  const inbox = new Map<string, Thread>();
  const sent = new Map<string, Thread>();
  const overdueIds = new Set<string>();
  let sentCount = 0;
  /** How many replies I have already written per thread — see `counts` below. */
  const repliedCount: Record<string, number> = {};

  for (const e of events) {
    const d = e.data ?? {};
    const id = String(d.id ?? "");
    switch (e.type) {
      case "report_received":
        inbox.set(id, {
          id,
          peer: String(d.from),
          title: String(d.title),
          body: String(d.body ?? ""),
          at: e.at,
          read: false,
          replies: [],
        });
        break;
      case "report_sent":
        sentCount++;
        sent.set(id, {
          id,
          peer: String(d.to),
          title: String(d.title),
          body: String(d.body ?? ""),
          at: e.at,
          read: true,
          replies: [],
          delivery: d.delivery ? String(d.delivery) : "sent",
          note: d.note ? String(d.note) : undefined,
        });
        break;
      case "report_read": {
        const t = inbox.get(id);
        if (t) t.read = true;
        break;
      }
      case "report_replied": {
        repliedCount[id] = (repliedCount[id] ?? 0) + 1;
        const t = inbox.get(id);
        if (t) t.replies.push({ from: "我", text: String(d.text), at: e.at });
        break;
      }
      case "reply_received": {
        const t = sent.get(id);
        if (t) t.replies.push({ from: String(d.from), text: String(d.text), at: e.at });
        break;
      }
      case "report_overdue": {
        const t = inbox.get(id);
        if (t && !t.read) overdueIds.add(id);
        break;
      }
      default:
        break;
    }
  }

  const inboxList = [...inbox.values()].reverse();
  const unread = inboxList.filter((t) => !t.read);
  const latestThread = unread[0] ?? inboxList[0];

  const detailOf = (t: Thread): string =>
    `## ${t.title}\n\n来自 **${t.peer}** · ${day(t.at)}${t.read ? "" : " · 未读"}\n\n${t.body}` +
    (t.replies.length ? "\n\n---\n" + t.replies.map((r) => `**${r.from}**：${r.text}`).join("\n\n") : "");

  const threadsById: Record<string, string> = {};
  for (const t of inbox.values()) threadsById[t.id] = detailOf(t);
  for (const t of sent.values()) if (!threadsById[t.id]) threadsById[t.id] = `（发出）${detailOf(t)}`;

  const stillOverdue = [...overdueIds].filter((id) => !inbox.get(id)?.read);

  return {
    inbox: inboxList.map((t) => ({
      id: t.id,
      title: t.title,
      subtitle: `${t.peer} · ${day(t.at)}${t.replies.length ? ` · ${t.replies.length} 回复` : ""}`,
      badge: overdueIds.has(t.id) && !t.read ? "逾期未读" : t.read ? "已读" : "未读",
      tone: overdueIds.has(t.id) && !t.read ? "err" : t.read ? undefined : "warn",
    })),
    banner: stillOverdue.length
      ? { tone: "err", text: `有 ${stillOverdue.length} 封汇报逾期未读（超 3 天）——发件人正在等你。` }
      : null,
    sent: [...sent.values()].reverse().map((t) => ({
      id: t.id,
      title: t.title,
      subtitle: `→ ${t.peer} · ${day(t.at)}${t.delivery && t.delivery !== "sent" ? ` · ${t.note ?? ""}` : ""}`,
      badge:
        t.delivery === "pending"
          ? "待批准"
          : t.delivery === "failed"
            ? "未送达"
            : t.replies.length
              ? `${t.replies.length} 回复`
              : undefined,
      tone: t.delivery === "failed" ? "err" : t.delivery === "pending" ? "warn" : t.replies.length ? "ok" : undefined,
    })),
    threadsById,
    latestId: latestThread?.id ?? "",
    stats: { 收件: inbox.size, 未读: unread.length, 已发: sent.size },
    digest:
      (unread.length
        ? unread.map((t) => `- 🟡 **${t.title}**（${t.peer}，${day(t.at)}）`).join("\n")
        : "- 没有未读汇报 ✅") +
      (sent.size ? `\n\n已发 ${sent.size} 封。` : ""),
    // Both feed `delivery_id` in actions.ts. A delivery id has to be stable
    // across a retry of the SAME message and different for a different one —
    // the mailbox dedupes on it, so an id reused for a second reply would make
    // that reply vanish silently instead of arriving.
    counts: { sent: sentCount, replied: repliedCount },
  };
}
