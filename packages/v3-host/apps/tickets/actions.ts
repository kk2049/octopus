/**
 * tickets actions — shared-scope handlers. Note what is ABSENT: no author
 * params anywhere. The engine stamps `by`; the projection renders it; forging
 * identity is not an API shape that exists.
 */

interface Ctx {
  state: {
    tickets: Array<{ id: string; badge: string }>;
    counts: { tickets: number };
  };
}
type P = Record<string, unknown>;
type Out = { events: Array<{ type: string; data: unknown }>; reply?: string };

function need(ctx: Ctx, id: string, wantOpen: boolean): void {
  const t = ctx.state.tickets.find((x) => x.id === id);
  if (!t) {
    const have = ctx.state.tickets.map((x) => x.id).join("、") || "（还没有工单）";
    throw new Error(`没有工单「${id}」。现有：${have}`);
  }
  if (wantOpen && t.badge === "已关") throw new Error(`工单「${id}」已经关了`);
}

export function open_ticket(ctx: Ctx, p: P): Out {
  const id = `tk-${ctx.state.counts.tickets + 1}`;
  return {
    events: [{ type: "ticket_opened", data: { id, title: p.title, body: p.body } }],
    reply: `工单 ${id} 已开`,
  };
}

export function comment(ctx: Ctx, p: P): Out {
  const id = String(p.id);
  need(ctx, id, true);
  return { events: [{ type: "ticket_comment", data: { id, text: p.text } }], reply: `已评论 ${id}` };
}

export function close_ticket(ctx: Ctx, p: P): Out {
  const id = String(p.id);
  need(ctx, id, true);
  return { events: [{ type: "ticket_closed", data: { id } }], reply: `已关 ${id}` };
}
