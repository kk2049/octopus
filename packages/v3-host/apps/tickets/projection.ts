/**
 * tickets projection — a shared log folded into a board. Identity comes from
 * the engine-stamped `by` field, never from payload: nobody can open a
 * ticket "as" someone else, because authorship isn't a parameter.
 */

interface Ev {
  seq: number;
  at: string;
  by: string;
  type: string;
  data: Record<string, unknown>;
}

interface Ticket {
  id: string;
  title: string;
  body: string;
  by: string;
  at: string;
  closed: boolean;
  closedBy?: string;
  comments: Array<{ by: string; text: string; at: string }>;
}

const who = (by: string): string => by.replace(/^user:/, "").replace(/^agent:/, "🤖");
const day = (s: string): string => s.slice(5, 10);

export function project(events: readonly Ev[]): Record<string, unknown> {
  const tickets = new Map<string, Ticket>();
  let count = 0;

  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case "ticket_opened":
        count++;
        tickets.set(String(d.id), {
          id: String(d.id),
          title: String(d.title),
          body: String(d.body ?? ""),
          by: e.by,
          at: e.at,
          closed: false,
          comments: [],
        });
        break;
      case "ticket_comment": {
        const t = tickets.get(String(d.id));
        if (t) t.comments.push({ by: e.by, text: String(d.text), at: e.at });
        break;
      }
      case "ticket_closed": {
        const t = tickets.get(String(d.id));
        if (t) {
          t.closed = true;
          t.closedBy = e.by;
        }
        break;
      }
      default:
        break;
    }
  }

  const all = [...tickets.values()].reverse();
  const open = all.filter((t) => !t.closed);
  const latest = open[0] ?? all[0];

  const thread = latest
    ? `## ${latest.id} · ${latest.title}${latest.closed ? "（已关）" : ""}\n\n` +
      `**${who(latest.by)}** 开于 ${day(latest.at)}：\n\n${latest.body}\n\n---\n` +
      (latest.comments.length
        ? latest.comments.map((c) => `**${who(c.by)}**（${day(c.at)}）：${c.text}`).join("\n\n")
        : "（还没有评论）")
    : "（还没有工单）";

  return {
    tickets: all.map((t) => ({
      id: t.id,
      title: t.title,
      subtitle: `${who(t.by)} · ${day(t.at)} · ${t.comments.length} 评论`,
      badge: t.closed ? "已关" : t.id,
      tone: t.closed ? undefined : "warn",
    })),
    thread,
    stats: { 开着: open.length, 已关: all.length - open.length },
    counts: { tickets: count },
  };
}
