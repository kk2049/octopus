/**
 * SEC-01 — the reports app asks the broker to carry a report; it does not
 * write anyone's log.
 *
 * The broker dedupes on `(delivery_id, from)`, which makes an interrupted
 * delivery safe to re-issue. It also makes a REUSED id a silent drop, so the
 * ids this app mints have to be distinct per message — the first cut derived a
 * reply's id from the thread alone, so the second reply on a thread matched the
 * first and never arrived, while the sender's own log said 已送达.
 */

import { describe, expect, it } from "vitest";
import { reply_report, send_report } from "../apps/reports/actions.js";

type Req = { slot: string; operation: string; args: Record<string, unknown> };

/** A ctx whose capability facade records what the handler asked for. */
function ctxWith(o: {
  scope: string;
  inbox?: Array<{ id: string; subtitle: string }>;
  sent?: number;
  replied?: Record<string, number>;
  answer?: (r: Req) => unknown;
}) {
  const calls: Req[] = [];
  return {
    calls,
    ctx: {
      scope: o.scope,
      capabilities: {
        async request(slot: string, operation: string, args: Record<string, unknown>) {
          calls.push({ slot, operation, args });
          return (o.answer?.({ slot, operation, args }) ?? { status: "succeeded", result: { status: "delivered" } }) as never;
        },
      },
      state: {
        inbox: o.inbox ?? [],
        counts: { sent: o.sent ?? 0, replied: o.replied ?? {} },
      },
    },
  };
}

describe("SEC-01 · the reports app mints one delivery id per message", () => {
  it("two replies on one thread get different ids, so both can land", async () => {
    const first = ctxWith({ scope: "bob", inbox: [{ id: "rp-alice-1", subtitle: "alice · 07-31" }] });
    await reply_report(first.ctx, { id: "rp-alice-1", text: "收到" });
    // The engine has now appended `report_replied`, so the projection counts one.
    const second = ctxWith({
      scope: "bob",
      inbox: [{ id: "rp-alice-1", subtitle: "alice · 07-31" }],
      replied: { "rp-alice-1": 1 },
    });
    await reply_report(second.ctx, { id: "rp-alice-1", text: "补充一句" });

    expect(first.calls[0].args.delivery_id).toBe("rl-bob-rp-alice-1-1");
    expect(second.calls[0].args.delivery_id).toBe("rl-bob-rp-alice-1-2");
    expect(first.calls[0].args.delivery_id).not.toBe(second.calls[0].args.delivery_id);
  });

  it("the id is stable across the approval round-trip, which is the retry that matters", async () => {
    // Two attempts at the SAME reply — nothing was appended in between,
    // because the first one is still waiting on a human.
    const answer = () => ({ status: "approval_required", pendingCallId: "pc-1" });
    const a = ctxWith({ scope: "bob", inbox: [{ id: "rp-alice-1", subtitle: "alice · 07-31" }], answer });
    const b = ctxWith({ scope: "bob", inbox: [{ id: "rp-alice-1", subtitle: "alice · 07-31" }], answer });
    const outA = await reply_report(a.ctx, { id: "rp-alice-1", text: "收到" });
    await reply_report(b.ctx, { id: "rp-alice-1", text: "收到" });
    expect(a.calls[0].args.delivery_id).toBe(b.calls[0].args.delivery_id);
    expect(outA.events[0].data).toMatchObject({ delivery: "pending" });
  });

  it("sends go through the delivery slot and carry no scope of their own", async () => {
    const w = ctxWith({ scope: "alice", sent: 2 });
    const out = await send_report(w.ctx, { to: "bob", title: "周报", body: "三件事" });
    expect(w.calls).toEqual([
      {
        slot: "delivery",
        operation: "send_report",
        args: { to: "bob", title: "周报", body: "三件事", delivery_id: "rp-alice-3" },
      },
    ]);
    // The local event records the attempt and how it ended — never a write
    // into anyone else's log.
    expect(out.events[0].type).toBe("report_sent");
    expect(out.events[0].data).toMatchObject({ to: "bob", delivery: "sent" });
    expect("deliveries" in out).toBe(false);
  });

  it("a refusal is recorded as failed rather than reported as sent", async () => {
    const w = ctxWith({
      scope: "alice",
      answer: () => ({ status: "denied", reason: "bob 的信箱没有授权接收来自 alice 的投递" }),
    });
    const out = await send_report(w.ctx, { to: "bob", title: "周报", body: "三件事" });
    expect(out.events[0].data).toMatchObject({ delivery: "failed" });
    expect(out.reply).toContain("未送达");
  });

  it("a duplicate is not dressed up as a fresh delivery", async () => {
    const w = ctxWith({
      scope: "alice",
      answer: () => ({ status: "succeeded", result: { status: "duplicate" } }),
    });
    const out = await send_report(w.ctx, { to: "bob", title: "周报", body: "三件事" });
    expect(String((out.events[0].data as { note?: string }).note)).toContain("合并");
  });

  it("without a delivery capability nothing is attempted and nothing claims success", async () => {
    const out = await send_report(
      { scope: "alice", state: { inbox: [], counts: { sent: 0 } } },
      { to: "bob", title: "t", body: "b" },
    );
    expect(out.events[0].data).toMatchObject({ delivery: "failed" });
  });
});
