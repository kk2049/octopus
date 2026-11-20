import { describe, expect, it } from "vitest";
import {
  WIRE_PARAM_LIMITS,
  actionOf,
  createRemoteCall,
  decodeWireParams,
  wireServiceableActions,
  type ContractDeclaration,
} from "@claude-bot/typed-port-kit";
import { answers, refuses, scriptedTransport } from "@claude-bot/typed-port-kit/testing";
import {
  SESSION_CHANNEL_CONTRACT_V2,
  SESSION_CHANNEL_DECLARATION,
  SESSION_CHANNEL_DECLARATION_V2,
  SESSION_CHANNEL_TENTACLE_TOOL,
  SESSION_CHANNEL_TENTACLE_TOOLS,
  SESSION_CHANNEL_V2_LIMITS,
  SESSION_CHANNEL_V2_TENTACLE_TOOL,
  readSessionSendReceipt,
  sessionTextProblem,
  utf8ByteLength,
  type SessionChannelRefusalCode,
} from "./index.js";

const MESSAGES = {
  noAnswer: "会话通道没有回应。",
  malformedAnswer: "会话通道回执格式异常。",
  refusedWithoutReason: "会话通道拒绝了请求。",
  closed: "会话通道已关闭。",
};

/** An App's `send` over the View wire, against a far side that decodes with the same declaration. */
function sender(declaration: ContractDeclaration<SessionChannelRefusalCode, string>) {
  const received: string[] = [];
  const script = scriptedTransport({
    "resource.send": (params) => {
      const { binding: _, ...wire } = params;
      const decoded = decodeWireParams(actionOf(declaration, "send")!, wire);
      if (!decoded.ok) return refuses("invalid_request", "参数无效");
      const content = String(decoded.value.content);
      const problem = sessionTextProblem(content);
      if (problem) return refuses("too_large", problem);
      received.push(content);
      return answers({ sessionRef: wire.session_ref, clientMessageId: wire.client_message_id, disposition: "accepted" });
    },
  });
  const remote = createRemoteCall({
    declaration,
    transport: script.transport,
    binding: "session",
    invalidRequest: "invalid_request",
    closed: "scope_closed",
    messages: MESSAGES,
  });
  const send = (content: string) =>
    remote.call({
      action: "send",
      params: { session_ref: "sch_a", client_message_id: "msg_a", content, delivery: "followup" },
      read: readSessionSendReceipt,
      malformed: MESSAGES.malformedAnswer,
    });
  return { send, received, calls: script.calls };
}

describe("session-channel/v2", () => {
  it("keeps v1's verbs, operations and refusals, and is wire serviceable", () => {
    expect(SESSION_CHANNEL_DECLARATION_V2.contract).toBe(SESSION_CHANNEL_CONTRACT_V2);
    expect(SESSION_CHANNEL_DECLARATION_V2.actionIds).toEqual(SESSION_CHANNEL_DECLARATION.actionIds);
    expect(SESSION_CHANNEL_DECLARATION_V2.operations).toEqual(SESSION_CHANNEL_DECLARATION.operations);
    expect(SESSION_CHANNEL_DECLARATION_V2.refusals.codes).toEqual(SESSION_CHANNEL_DECLARATION.refusals.codes);
    expect(wireServiceableActions(SESSION_CHANNEL_DECLARATION_V2)).toEqual(SESSION_CHANNEL_DECLARATION_V2.actionIds);
    expect(SESSION_CHANNEL_V2_LIMITS.maxTextLength).toBe(WIRE_PARAM_LIMITS.maxDeclaredValueLength);
    // The runner's SESSION_PROMPT_MAX_BYTES.
    expect(SESSION_CHANNEL_V2_LIMITS.maxTextBytes).toBe(384 * 1024);
    expect(SESSION_CHANNEL_TENTACLE_TOOLS).toEqual([SESSION_CHANNEL_TENTACLE_TOOL, SESSION_CHANNEL_V2_TENTACLE_TOOL]);
  });

  it("carries a 300 KiB message from an App to the session intact, which v1 refuses before sending", async () => {
    const message = "研究进展：".repeat(10) + "x".repeat(300 * 1024 - 150);
    expect(utf8ByteLength(message)).toBe(300 * 1024);
    const v2 = sender(SESSION_CHANNEL_DECLARATION_V2);
    expect(await v2.send(message)).toEqual({
      ok: true,
      value: { sessionRef: "sch_a", clientMessageId: "msg_a", disposition: "accepted" },
    });
    expect(v2.received).toEqual([message]);

    const v1 = sender(SESSION_CHANNEL_DECLARATION);
    expect(await v1.send(message)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(v1.calls).toHaveLength(0);
  });

  it("refuses past the byte budget, never truncating", async () => {
    const ascii = "a".repeat(SESSION_CHANNEL_V2_LIMITS.maxTextBytes);
    expect(sessionTextProblem(ascii)).toBeNull();
    // Within the wire's characters, past the budget's bytes: the provider says too_large.
    const wide = "长".repeat(150 * 1024);
    expect(sessionTextProblem(wide)).toContain("460800 字节");
    const v2 = sender(SESSION_CHANNEL_DECLARATION_V2);
    expect(await v2.send(wide)).toMatchObject({ ok: false, code: "too_large" });
    expect(await v2.send(ascii + "a")).toMatchObject({ ok: false, code: "invalid_request" });
    expect(v2.received).toEqual([]);
    expect(utf8ByteLength("😀é")).toBe(6);
    expect(utf8ByteLength("\ud800")).toBe(3);
  });
});
