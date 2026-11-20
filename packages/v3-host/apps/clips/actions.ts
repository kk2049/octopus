/**
 * clips actions — every mutation is an appended event. drop_clip appends a
 * clip_dropped marker instead of rewriting anything: the projection stops
 * listing the entry, the log keeps the full story.
 */

interface Row {
  id: string;
  title: string;
}
interface Ctx {
  scope: string;
  state: {
    unread: Row[];
    read: Row[];
    openIds: string[];
    counts: { added: number };
  };
}
type P = Record<string, unknown>;
type Ev = { type: string; data: unknown };
type Out = { events: Ev[]; reply?: string };

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function add_clip(ctx: Ctx, p: P): Out {
  const url = str(p.url);
  const title = str(p.title);
  if (!url) throw new Error("url 不能为空");
  if (!/^https?:\/\//.test(url)) throw new Error(`url 要以 http(s):// 开头，收到「${url}」`);
  if (!title) throw new Error("title 不能为空");
  const id = `clip-${ctx.state.counts.added + 1}`;
  const data: Record<string, unknown> = { id, url, title };
  const note = str(p.note);
  const tag = str(p.tag);
  if (note) data.note = note;
  if (tag) data.tag = tag;
  return { events: [{ type: "clip_added", data }], reply: `已收藏「${title}」（${id}）` };
}

export function mark_read(ctx: Ctx, p: P): Out {
  const id = str(p.id);
  if (!ctx.state.openIds.includes(id)) {
    if (ctx.state.read.some((c) => c.id === id)) throw new Error(`「${id}」已经是已读`);
    const have = ctx.state.openIds.join("、") || "（空）";
    throw new Error(`未读里没有「${id}」。现有未读：${have}`);
  }
  return { events: [{ type: "clip_read", data: { id } }], reply: `已读 ${id}` };
}

export function drop_clip(ctx: Ctx, p: P): Out {
  const id = str(p.id);
  const hit = ctx.state.unread.find((x) => x.id === id) ?? ctx.state.read.find((x) => x.id === id);
  if (!hit) {
    const have = [...ctx.state.unread, ...ctx.state.read].map((x) => x.id).join("、") || "（空）";
    throw new Error(`收藏夹里没有「${id}」。现有：${have}`);
  }
  return {
    events: [{ type: "clip_dropped", data: { id } }],
    reply: `已删除「${hit.title}」（${id}），日志保留原始记录`,
  };
}
