import { describe, expect, it } from "vitest";

import { answers, refuses, scriptedTransport } from "@claude-bot/typed-port-kit/testing";

import { NOTIFY_CONTRACT, NOTIFY_LIMITS } from "./contract.js";
import { createRemoteNotifyPort } from "./remote.js";

const RECEIPT = { recipient: "rcpt-abc", deliveryId: "dlv-00000001", acceptedAt: "2026-08-07T10:00:00.000Z" };
const CARD = { title: "部署完成", lines: ["v3 已上线"] };

function build(script: Parameters<typeof scriptedTransport>[0]) {
  const scripted = scriptedTransport(script);
  return { scripted, ...createRemoteNotifyPort(scripted.transport, "notify") };
}

describe("what crosses the wire", () => {
  it("carries the binding, the prefixed action, and the declared params", () => {
    const { scripted, port } = build({ "resource.send_text": answers(RECEIPT) });
    return port.sendText("rcpt-abc", "上线了").then((reply) => {
      expect(reply).toEqual({ ok: true, value: RECEIPT });
      expect(scripted.calls).toEqual([
        { action: "resource.send_text", params: { binding: "notify", recipient: "rcpt-abc", body: "上线了" } },
      ]);
    });
  });

  it("encodes a card as its canonical JSON, in one parameter", () => {
    const { scripted, port } = build({ "resource.send_card": answers(RECEIPT) });
    return port.sendCard("rcpt-abc", CARD).then(() => {
      expect(scripted.calls[0]!.params.card).toBe('{"title":"部署完成","lines":["v3 已上线"]}');
    });
  });

  it("states its contract, and nothing else about where the data comes from", () => {
    const { port } = build({});
    expect(port.contract).toBe(NOTIFY_CONTRACT);
    // No identity of any kind. Not filtered — absent.
    expect(Object.keys(port).sort()).toEqual(["contract", "sendCard", "sendText"]);
  });
});

describe("refusing locally, before anything is sent", () => {
  it("refuses an over-long body without proposing", async () => {
    // "Your body is 600 characters" is a different sentence from "the
    // notification service said no", and sending it first would make it the
    // second one.
    const { scripted, port } = build({ "resource.send_text": answers(RECEIPT) });
    const reply = await port.sendText("rcpt-abc", "x".repeat(NOTIFY_LIMITS.maxBodyLength + 1));
    expect(reply).toMatchObject({ ok: false, code: "invalid_request" });
    expect(reply.ok ? "" : reply.message).toContain("body is longer than 512 characters");
    expect(scripted.calls).toEqual([]);
  });

  it("refuses a card whose escaping overruns the wire parameter, without proposing", async () => {
    const { scripted, port } = build({ "resource.send_card": answers(RECEIPT) });
    const quoted = { title: '"'.repeat(60), lines: ['\\'.repeat(100), '\\'.repeat(100), '\\'.repeat(100)] };
    const reply = await port.sendCard("rcpt-abc", quoted);
    expect(reply).toMatchObject({ ok: false, code: "invalid_request" });
    expect(scripted.calls).toEqual([]);
  });

  it("refuses a recipient that is not a bounded printable reference", async () => {
    const { scripted, port } = build({ "resource.send_text": answers(RECEIPT) });
    const reply = await port.sendText(`bad${String.fromCharCode(10)}ref`, "hi");
    expect(reply).toMatchObject({ ok: false, code: "invalid_request" });
    expect(scripted.calls).toEqual([]);
  });

  it("refuses a card that is not a card at all", async () => {
    const { port } = build({ "resource.send_card": answers(RECEIPT) });
    const cyclic: Record<string, unknown> = { title: "t", lines: [] };
    cyclic.self = cyclic;
    const reply = await port.sendCard("rcpt-abc", cyclic as never);
    expect(reply).toMatchObject({ ok: false, code: "invalid_request" });
  });
});

describe("every refusal resolves", () => {
  it("when the transport rejects", async () => {
    const { port } = build({ "resource.send_text": "reject" });
    expect(await port.sendText("rcpt-abc", "hi")).toEqual({
      ok: false,
      code: "unavailable",
      message: "通知通道没有作答。",
    });
  });

  it("when the transport answers with something that is not an answer", async () => {
    for (const malformed of [null, "sent", 42, [], { ok: "yes", message: "" }]) {
      const { port } = build({ "resource.send_text": { malformed } });
      expect(await port.sendText("rcpt-abc", "hi"), `for ${JSON.stringify(malformed)}`).toEqual({
        ok: false,
        code: "unavailable",
        message: "通知通道给出了无法识别的回复。",
      });
    }
  });

  it("for every code this contract declares", async () => {
    for (const code of ["refused", "bad_recipient", "approval_required", "no_authority", "rate_limited"] as const) {
      const { port } = build({ "resource.send_text": refuses(code, `因为 ${code}`) });
      expect(await port.sendText("rcpt-abc", "hi")).toEqual({ ok: false, code, message: `因为 ${code}` });
    }
  });

  it("folding a code this build has never heard of", async () => {
    const { port } = build({ "resource.send_card": refuses("recipient_on_holiday", "度假中") });
    expect(await port.sendCard("rcpt-abc", CARD)).toEqual({ ok: false, code: "unavailable", message: "度假中" });
  });

  it("substituting its own sentence for a refusal that carries none", async () => {
    const { port } = build({ "resource.send_text": refuses("rate_limited", "") });
    expect(await port.sendText("rcpt-abc", "hi")).toEqual({
      ok: false,
      code: "rate_limited",
      message: "这条通知没有发出去。",
    });
  });
});

describe("validating the receipt again on arrival", () => {
  it("refuses a receipt that fails the contract's own reader", async () => {
    const { port } = build({ "resource.send_text": answers({ recipient: "rcpt-abc" }) });
    expect(await port.sendText("rcpt-abc", "hi")).toEqual({
      ok: false,
      code: "unavailable",
      message: "投递回执没有通过公开契约校验。",
    });
  });

  it("refuses a receipt carrying a field this contract does not have", async () => {
    const { port } = build({ "resource.send_text": answers({ ...RECEIPT, chatId: "oc_1" }) });
    expect(await port.sendText("rcpt-abc", "hi")).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("refuses a receipt for a DIFFERENT recipient", async () => {
    // A receipt for somebody else passes the reader perfectly — it is a
    // completely valid receipt for somewhere else. Only comparing against what
    // was asked finds it, and a UI rendering "sent ✓" from it would tell a
    // person their message went where it did not.
    const { port } = build({ "resource.send_card": answers({ ...RECEIPT, recipient: "rcpt-someone-else" }) });
    expect(await port.sendCard("rcpt-abc", CARD)).toEqual({
      ok: false,
      code: "unavailable",
      message: "收到的回执不是发给所请求的那个收件人的。",
    });
  });
});

describe("destroy", () => {
  it("refuses afterwards, and never proposes again", async () => {
    const { scripted, port, destroy } = build({ "resource.send_text": answers(RECEIPT) });
    destroy();
    destroy();
    expect(await port.sendText("rcpt-abc", "hi")).toEqual({
      ok: false,
      code: "scope_closed",
      message: "这个视图的会话已经结束，请重新打开。",
    });
    expect(scripted.calls).toEqual([]);
  });

  it("does not hand back a receipt for a send that was already in flight", async () => {
    // The send DID happen — this is about a torn-down panel not being handed
    // data, not about undoing a delivery.
    const { port, destroy } = build({ "resource.send_text": answers(RECEIPT) });
    const inFlight = port.sendText("rcpt-abc", "hi");
    destroy();
    expect(await inFlight).toMatchObject({ ok: false, code: "scope_closed" });
  });
});

describe("no streaming", () => {
  it("never touches the stream verbs", async () => {
    // Worth pinning rather than assuming: the kit's stream half is opt-in, and
    // a write contract with a small complete answer carries none of it.
    const { scripted, port } = build({
      "resource.send_text": answers(RECEIPT),
      "resource.send_card": answers(RECEIPT),
    });
    await port.sendText("rcpt-abc", "hi");
    await port.sendCard("rcpt-abc", CARD);
    expect(scripted.calls.some((call) => call.action.includes("stream"))).toBe(false);
  });
});
