/**
 * reports actions — the sender's own log is written locally; the copy in the
 * recipient's mailbox is a CAPABILITY CALL, not a value this file returns.
 *
 * The handler can no longer name a target scope, an event type or an author.
 * All it can do is ask the delivery slot to carry a report to a username, and
 * that request goes through the same Gate as any other resource: the broker
 * resolves the recipient, checks the recipient's own receive policy, and either
 * the grant's terms allow this send or a human decides it. What lands in the
 * mailbox is an envelope the broker writes (`packages/engine/src/host/delivery.ts`).
 *
 * Three outcomes matter to the app and all three are visible in its own log:
 *   sent      — the mailbox has it;
 *   pending   — a person still has to approve this exact send;
 *   failed    — refused (unknown recipient, no receive grant, …).
 * A failure is recorded, never rolled back: the sender's truth is that they
 * tried, and hiding that would make a dropped report indistinguishable from
 * one that was never written.
 */

interface Caps {
  request(
    slot: string,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<
    | { status: "succeeded"; result: unknown }
    | { status: "approval_required"; pendingCallId: string }
    | { status: "denied"; reason: string }
    | { status: "failed"; reason: string }
    | { status: "unknown"; reason: string }
  >;
}
interface Ctx {
  scope: string;
  capabilities?: Caps;
  state: {
    inbox: Array<{ id: string; subtitle: string; badge?: string }>;
    counts: { sent: number; replied?: Record<string, number> };
  };
}
type P = Record<string, unknown>;
type Ev = { type: string; data: unknown };
type Out = { events: Ev[]; reply?: string };

function findInbox(ctx: Ctx, id: string): { id: string; peer: string } {
  const t = ctx.state.inbox.find((x) => x.id === id);
  if (!t) {
    const have = ctx.state.inbox.map((x) => x.id).join("、") || "（空）";
    throw new Error(`收件箱里没有「${id}」。现有：${have}`);
  }
  return { id: t.id, peer: t.subtitle.split(" · ")[0] };
}

/**
 * Ask the broker to carry one envelope, and turn its answer into a local fact.
 *
 * `delivery_id` is derived from the sender's own log position: distinct for
 * each distinct message (or a second one would silently dedupe against the
 * first) and unchanged across the approval round-trip, because the PendingCall
 * holds the original arguments and approving re-runs exactly those. That
 * round-trip is the retry the mailbox's idempotency is actually for.
 */
async function transfer(
  ctx: Ctx,
  operation: string,
  args: Record<string, unknown>,
): Promise<{ state: "sent" | "pending" | "failed"; note: string; pendingCallId?: string }> {
  if (!ctx.capabilities) return { state: "failed", note: "本实例没有投递能力（未授予 delivery）" };
  const out = await ctx.capabilities.request("delivery", operation, args);
  switch (out.status) {
    case "succeeded": {
      // The broker tells us whether this actually landed or matched an earlier
      // delivery of the same id. Both are "succeeded" — that is what
      // idempotency means — but they are not the same fact to report, and
      // flattening them is how a colliding id looks like a delivered message.
      const dup = (out.result as { status?: string } | null)?.status === "duplicate";
      return { state: "sent", note: dup ? "已送达（与先前同一次投递合并）" : "已送达" };
    }
    case "approval_required":
      return { state: "pending", note: "等待你在可信面板上批准这次投递", pendingCallId: out.pendingCallId };
    default:
      return { state: "failed", note: out.reason };
  }
}

export async function send_report(ctx: Ctx, p: P): Promise<Out> {
  const to = String(p.to ?? "").trim();
  if (to === ctx.scope) throw new Error("不能把汇报发给自己");
  const id = `rp-${ctx.scope}-${ctx.state.counts.sent + 1}`;
  const r = await transfer(ctx, "send_report", {
    to,
    title: String(p.title ?? ""),
    body: String(p.body ?? ""),
    delivery_id: id,
  });
  return {
    events: [
      {
        type: "report_sent",
        data: { id, title: p.title, body: p.body, to, delivery: r.state, note: r.note, pending: r.pendingCallId },
      },
    ],
    reply:
      r.state === "sent"
        ? `已发给 ${to}（${id}）`
        : r.state === "pending"
          ? `${id} 待批准：${r.note}`
          : `${id} 未送达：${r.note}`,
  };
}

export function mark_read(ctx: Ctx, p: P): Out {
  const { id } = findInbox(ctx, String(p.id));
  return { events: [{ type: "report_read", data: { id } }], reply: `已读 ${id}` };
}

export async function reply_report(ctx: Ctx, p: P): Promise<Out> {
  const { id, peer } = findInbox(ctx, String(p.id));
  // One id per reply, not per thread. The mailbox dedupes on (delivery_id,
  // from), so reusing the thread's id would make every reply after the first
  // land as a "duplicate" and disappear without anyone being told.
  const nth = (ctx.state.counts.replied?.[id] ?? 0) + 1;
  const r = await transfer(ctx, "reply_report", {
    to: peer,
    id,
    text: String(p.text ?? ""),
    delivery_id: `rl-${ctx.scope}-${id}-${nth}`,
  });
  return {
    events: [{ type: "report_replied", data: { id, text: p.text, delivery: r.state, note: r.note } }],
    reply: r.state === "sent" ? `已回复 ${peer}` : `回复 ${peer} 未送达：${r.note}`,
  };
}
