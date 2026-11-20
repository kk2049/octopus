/**
 * The memory port, and the conformance harness run against BOTH implementations.
 *
 * Running the same property set against the fixture and against the remote
 * client is the only form in which "these components depend on a port, not on a
 * transport" is checkable. Two implementations, one set of assertions.
 */

import { describe, expect, it } from "vitest";

import { assertConformant, answers, runPortConformance, scriptedTransport } from "@claude-bot/typed-port-kit/testing";

import { NOTIFY_CONTRACT, NOTIFY_DECLARATION, NOTIFY_LIMITS } from "../contract.js";
import type { NotifyActionId, NotifyRefusalCode } from "../contract.js";
import type { NotifyCard, NotifyReceipt } from "../projection.js";
import type { NotifyPort, NotifyReply } from "../port.js";
import { createRemoteNotifyPort } from "../remote.js";
import { createMemoryNotifyPort } from "./memory-port.js";

const CARD: NotifyCard = { title: "部署完成", lines: ["v3 已上线"] };

describe("createMemoryNotifyPort", () => {
  it("accepts a known recipient and records what it was asked to send", async () => {
    const memory = createMemoryNotifyPort({
      recipients: ["rcpt-a"],
      now: () => new Date("2026-08-07T10:00:00.000Z"),
    });
    expect(await memory.port.sendText("rcpt-a", "上线了")).toEqual({
      ok: true,
      value: { recipient: "rcpt-a", deliveryId: "memory-0001", acceptedAt: "2026-08-07T10:00:00.000Z" },
    });
    expect(await memory.port.sendCard("rcpt-a", CARD)).toMatchObject({ ok: true });
    expect(memory.sent).toEqual([
      { kind: "text", recipient: "rcpt-a", body: "上线了" },
      { kind: "card", recipient: "rcpt-a", card: CARD },
    ]);
  });

  it("refuses an unknown recipient, and records the attempt", async () => {
    const memory = createMemoryNotifyPort({ recipients: ["rcpt-a"] });
    expect(await memory.port.sendText("rcpt-b", "hi")).toEqual({
      ok: false,
      code: "bad_recipient",
      message: "这个收件人引用不属于当前视图。",
    });
    expect(memory.sent).toEqual([]);
    expect(memory.calls).toEqual([{ method: "sendText", recipient: "rcpt-b" }]);
  });

  it("plays scripted refusals, which are the branches a component gets wrong", async () => {
    const memory = createMemoryNotifyPort({
      recipients: ["rcpt-a", "rcpt-b"],
      refusals: { "rcpt-b": { code: "approval_required", message: "去可信面板批准一下。" } },
    });
    expect(await memory.port.sendCard("rcpt-b", CARD)).toEqual({
      ok: false,
      code: "approval_required",
      message: "去可信面板批准一下。",
    });
  });

  it("supports a look-but-not-send consumer without a second interface", async () => {
    const memory = createMemoryNotifyPort({
      recipients: ["rcpt-a"],
      refuseAll: { code: "no_authority", message: "这个视图没有被授予投递权限。" },
    });
    expect(await memory.port.sendText("rcpt-a", "hi")).toMatchObject({ ok: false, code: "no_authority" });
    expect(await memory.port.sendCard("rcpt-a", CARD)).toMatchObject({ ok: false, code: "no_authority" });
    expect(memory.sent).toEqual([]);
  });

  it("puts a card through the contract's own reader, so it cannot accept one the provider would refuse", async () => {
    const memory = createMemoryNotifyPort({ recipients: ["rcpt-a"] });
    expect(await memory.port.sendCard("rcpt-a", { title: "", lines: [] })).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(await memory.port.sendCard("rcpt-a", { title: "t", lines: ["a", "b", "c", "d"] })).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(memory.sent).toEqual([]);
  });

  it("refuses an over-long body and an empty one", async () => {
    const memory = createMemoryNotifyPort({ recipients: ["rcpt-a"] });
    expect(await memory.port.sendText("rcpt-a", "")).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await memory.port.sendText("rcpt-a", "x".repeat(NOTIFY_LIMITS.maxBodyLength + 1))).toMatchObject({
      ok: false,
      code: "too_large",
    });
  });

  it("does not read inherited names as scripted refusals", async () => {
    const memory = createMemoryNotifyPort({ recipients: ["toString"], refusals: {} });
    expect(await memory.port.sendText("toString", "hi")).toMatchObject({ ok: true });
  });
});

// ── the same property set, against both implementations ──

function invokerFor(port: NotifyPort) {
  return async (action: NotifyActionId, params: Readonly<Record<string, unknown>>): Promise<NotifyReply<unknown>> => {
    const recipient = typeof params.recipient === "string" ? params.recipient : "";
    if (action === "send_text") return port.sendText(recipient, typeof params.body === "string" ? params.body : "");
    return port.sendCard(recipient, params.card as NotifyCard);
  };
}

const SAMPLES = {
  send_text: { recipient: "rcpt-a", body: "上线了" },
  send_card: { recipient: "rcpt-a", card: CARD },
} as const;

describe("both implementations satisfy the contract's own properties", () => {
  it("the memory port does", async () => {
    const memory = createMemoryNotifyPort({ recipients: ["rcpt-a"] });
    const findings = await runPortConformance<NotifyRefusalCode, NotifyActionId>({
      declaration: NOTIFY_DECLARATION,
      port: memory.port,
      samples: SAMPLES,
      invoke: invokerFor(memory.port),
    });
    expect(() => assertConformant(findings)).not.toThrow();
  });

  it("the remote port does, over a transport that answers", async () => {
    const receipt: NotifyReceipt = {
      recipient: "rcpt-a",
      deliveryId: "dlv-00000001",
      acceptedAt: "2026-08-07T10:00:00.000Z",
    };
    const scripted = scriptedTransport({
      "resource.send_text": answers(receipt),
      "resource.send_card": answers(receipt),
    });
    const remote = createRemoteNotifyPort(scripted.transport, "notify");
    const findings = await runPortConformance<NotifyRefusalCode, NotifyActionId>({
      declaration: NOTIFY_DECLARATION,
      port: remote.port,
      samples: SAMPLES,
      invoke: invokerFor(remote.port),
    });
    expect(() => assertConformant(findings)).not.toThrow();
  });

  it("the remote port still does over a transport that only rejects", async () => {
    // The load-bearing property: every method RESOLVES, whatever the transport
    // does. A port that threw here would make "a refusal is something to show a
    // person" false.
    const scripted = scriptedTransport({ "resource.send_text": "reject", "resource.send_card": "reject" });
    const remote = createRemoteNotifyPort(scripted.transport, "notify");
    const findings = await runPortConformance<NotifyRefusalCode, NotifyActionId>({
      declaration: NOTIFY_DECLARATION,
      port: remote.port,
      samples: SAMPLES,
      invoke: invokerFor(remote.port),
    });
    expect(() => assertConformant(findings)).not.toThrow();
  });

  it("and both state the same contract", () => {
    const memory = createMemoryNotifyPort({ recipients: [] });
    const scripted = scriptedTransport({});
    expect(memory.port.contract).toBe(NOTIFY_CONTRACT);
    expect(createRemoteNotifyPort(scripted.transport, "notify").port.contract).toBe(NOTIFY_CONTRACT);
  });
});
