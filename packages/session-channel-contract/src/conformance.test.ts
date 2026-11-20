import { describe, expect, it } from "vitest";
import { assertConformant, runPortConformance } from "@claude-bot/typed-port-kit/testing";
import {
  SESSION_CHANNEL_CONTRACT,
  SESSION_CHANNEL_DECLARATION,
  SESSION_CHANNEL_REFUSALS,
  type SessionChannelRefusalCode,
} from "./contract.js";
import type { SessionChannelPort } from "./port.js";

const refusal = () => Promise.resolve(SESSION_CHANNEL_REFUSALS.refuse("no_authority", "测试 port 没有绑定 owner authority。"));
const port: SessionChannelPort = {
  contract: SESSION_CHANNEL_CONTRACT,
  open: refusal,
  send: refusal,
  stop: refusal,
  readActivity: refusal,
};

describe("session-channel/v1 conformance", () => {
  it("maps every declared action to a resolving named port method", async () => {
    const findings = await runPortConformance<SessionChannelRefusalCode, (typeof SESSION_CHANNEL_DECLARATION.actionIds)[number]>({
      declaration: SESSION_CHANNEL_DECLARATION,
      port,
      samples: {
        open_session: { binding_ref: "schb_a", client_conversation_ref: "conv_a", idempotency_key: "open_a" },
        send: { session_ref: "sch_a", client_message_id: "msg_a", content: "hello", delivery: "followup" },
        stop: { session_ref: "sch_a", request_id: "stop_a", reason: "user requested" },
        read_activity: { session_ref: "sch_a", after_cursor: 0, max_events: 32, max_bytes: 8192 },
      },
      invoke: async (action, params) => {
        switch (action) {
          case "open_session": return await port.open(String(params.binding_ref), String(params.client_conversation_ref), String(params.idempotency_key));
          case "send": return await port.send(String(params.session_ref), String(params.client_message_id), String(params.content), params.delivery === "steer" ? "steer" : "followup");
          case "stop": return await port.stop(String(params.session_ref), String(params.request_id), String(params.reason));
          case "read_activity": return await port.readActivity(String(params.session_ref), Number(params.after_cursor), Number(params.max_events), Number(params.max_bytes));
        }
      },
    });
    expect(() => assertConformant(findings)).not.toThrow();
  });
});
