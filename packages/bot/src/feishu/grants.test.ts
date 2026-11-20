/**
 * SEC-03 — the grant config is the only thing that hands an agent a Feishu
 * operation, so a line it cannot honour must fail at boot rather than quietly
 * grant nothing (which reads exactly like a working deployment).
 */

import { describe, expect, it } from "vitest";
import {
  FeishuGrantConfigError,
  DEFAULT_FEISHU_RIGHTS,
  NO_FEISHU_RIGHTS,
  resolveChatAgentGrant,
  resolvePrivilegedAgentGrant,
  validateFeishuGatewayConfig,
} from "./grants.js";

describe("validateFeishuGatewayConfig", () => {
  it("accepts an absent config — the reviewed user catalog is the default", () => {
    expect(() => validateFeishuGatewayConfig(undefined)).not.toThrow();
    expect(() => validateFeishuGatewayConfig({})).not.toThrow();
  });

  it("rejects an operation that is not in the catalog", () => {
    expect(() => validateFeishuGatewayConfig({ chat_agent: { operations: ["doc_reed"] } })).toThrow(
      FeishuGrantConfigError,
    );
  });

  it("rejects a SYSTEM operation by name, and says why", () => {
    expect(() => validateFeishuGatewayConfig({ chat_agent: { operations: ["system_reply_in_chat"] } })).toThrow(
      /SYSTEM Feishu operation/,
    );
  });

  it("rejects auto_allow that is not a subset of operations", () => {
    expect(() =>
      validateFeishuGatewayConfig({ chat_agent: { operations: ["doc_read"], auto_allow: ["doc_search"] } }),
    ).toThrow(/not in that grant's operations/);
  });

  it("rejects auto-allowing a write, because the kernel would drop it anyway", () => {
    expect(() =>
      validateFeishuGatewayConfig({
        chat_agent: { operations: ["doc_read", "doc_create"], auto_allow: ["doc_create"] },
      }),
    ).toThrow(/approved by the owner/);
  });

  it("checks per-user blocks too, and names the one at fault", () => {
    expect(() => validateFeishuGatewayConfig({ users: { bob: { operations: ["nope"] } } })).toThrow(
      /feishu_gateway\.users\.bob/,
    );
  });

  it("accepts a well-formed grant", () => {
    expect(() =>
      validateFeishuGatewayConfig({
        chat_agent: { operations: ["doc_read", "doc_search", "doc_create"], auto_allow: ["doc_read", "doc_search"] },
        users: { lht: { operations: ["calendar_primary", "calendar_list_events"] } },
      }),
    ).not.toThrow();
  });

  it("requires privileged operations to be attached to one explicit user", () => {
    expect(() => validateFeishuGatewayConfig({
      chat_agent: { operations: ["message_send_as_bot"] },
    })).toThrow(/privileged_users/);
    expect(() => validateFeishuGatewayConfig({
      privileged_users: { lht: { operations: ["message_send_as_bot", "document_grant_member"] } },
    })).not.toThrow();
  });
});

describe("resolveChatAgentGrant", () => {
  it("defaults every user to the ordinary user-OAuth catalog", () => {
    expect(resolveChatAgentGrant(undefined, "alice")).toEqual(DEFAULT_FEISHU_RIGHTS);
    expect(resolveChatAgentGrant({}, "alice")).toEqual(DEFAULT_FEISHU_RIGHTS);
    expect(resolveChatAgentGrant({ users: { bob: { operations: ["doc_read"] } } }, "alice"))
      .toEqual(DEFAULT_FEISHU_RIGHTS);
  });

  it("keeps privileged rights empty unless the exact username is listed", () => {
    const cfg = { privileged_users: { alice: { operations: ["message_send_as_bot"] } } };
    expect(resolvePrivilegedAgentGrant(cfg, "alice")).toEqual(["message_send_as_bot"]);
    expect(resolvePrivilegedAgentGrant(cfg, "bob")).toEqual([]);
    expect(NO_FEISHU_RIGHTS.operations).toEqual([]);
  });

  it("a per-user entry replaces the default instead of adding to it", () => {
    const cfg = {
      chat_agent: { operations: ["doc_read", "doc_search"], auto_allow: ["doc_read"] },
      users: { alice: { operations: ["calendar_primary"] } },
    };
    expect(resolveChatAgentGrant(cfg, "alice")).toEqual({ operations: ["calendar_primary"], autoAllow: [] });
    expect(resolveChatAgentGrant(cfg, "bob")).toEqual({
      operations: ["doc_read", "doc_search"],
      autoAllow: ["doc_read"],
    });
  });

  it("filters again at the point of use, so a config that skipped validation still cannot widen", () => {
    // Neither of these can reach here through `loadConfig`, but the resolver is
    // the function that grants and it does not depend on that being true.
    expect(
      resolveChatAgentGrant({ chat_agent: { operations: ["doc_read", "system_send_card", "nope"] } }, "alice"),
    ).toEqual({ operations: ["doc_read"], autoAllow: [] });
    expect(
      resolveChatAgentGrant(
        { chat_agent: { operations: ["doc_read", "doc_create"], auto_allow: ["doc_create", "doc_search"] } },
        "alice",
      ),
    ).toEqual({ operations: ["doc_read", "doc_create"], autoAllow: [] });
  });
});
