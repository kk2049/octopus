/**
 * clips projection — one user's link clipboard, folded from their log.
 * A drop never rewrites history: clip_added stays in the log verbatim, the
 * fold just stops showing the entry in any list (it keeps a byId detail so
 * a stale selection still renders honestly as 已删除).
 */

interface Ev {
  seq: number;
  at: string;
  by: string;
  type: string;
  data: Record<string, unknown>;
}

interface Clip {
  id: string;
  url: string;
  title: string;
  note: string;
  tag: string;
  at: string;
  read: boolean;
  dropped: boolean;
}

const day = (s: string): string => s.slice(5, 10);

export function project(events: readonly Ev[]): Record<string, unknown> {
  const clips = new Map<string, Clip>();
  let addedCount = 0;

  for (const e of events) {
    const d = e.data ?? {};
    const id = String(d.id ?? "");
    switch (e.type) {
      case "clip_added":
        addedCount++;
        clips.set(id, {
          id,
          url: String(d.url ?? ""),
          title: String(d.title ?? ""),
          note: String(d.note ?? ""),
          tag: String(d.tag ?? ""),
          at: e.at,
          read: false,
          dropped: false,
        });
        break;
      case "clip_read": {
        const c = clips.get(id);
        if (c) c.read = true;
        break;
      }
      case "clip_dropped": {
        const c = clips.get(id);
        if (c) c.dropped = true;
        break;
      }
      default:
        break;
    }
  }

  const live = [...clips.values()].filter((c) => !c.dropped).reverse();
  const unread = live.filter((c) => !c.read);
  const read = live.filter((c) => c.read);
  const latest = unread[0] ?? live[0];

  const rowOf = (c: Clip) => ({
    id: c.id,
    title: c.title,
    subtitle: `${c.tag ? `#${c.tag} · ` : ""}${day(c.at)}`,
    badge: c.read ? "已读" : "未读",
    tone: c.read ? ("ok" as const) : ("warn" as const),
  });

  const detailOf = (c: Clip): string => {
    const status = c.dropped ? "🗑 已删除" : c.read ? "✅ 已读" : "🟡 未读";
    return (
      `## ${c.title}\n\n` +
      `[${c.url}](${c.url})\n\n` +
      `${status}${c.tag ? ` · #${c.tag}` : ""} · 收藏于 ${day(c.at)}` +
      (c.note ? `\n\n> ${c.note}` : "")
    );
  };

  const byId: Record<string, string> = {};
  for (const c of clips.values()) byId[c.id] = detailOf(c);

  return {
    unread: unread.map(rowOf),
    read: read.map(rowOf),
    tagIds: [...new Set(live.map((c) => c.tag).filter((t) => t !== ""))],
    openIds: unread.map((c) => c.id),
    byId,
    latestId: latest?.id ?? "",
    stats: { 未读: unread.length, 已读: read.length, 总数: live.length },
    digest:
      (unread.length
        ? unread.map((c) => `- 🟡 [${c.title}](${c.url})${c.tag ? `（#${c.tag}）` : ""}`).join("\n")
        : "- 没有未读收藏 ✅") + (read.length ? `\n\n已读 ${read.length} 条。` : ""),
    counts: { added: addedCount },
  };
}
