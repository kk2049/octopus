import { describe, expect, it } from "vitest";

import { declareContract } from "./declaration.js";
import { mcpErrorOf, mcpToolsOf } from "./mcp.js";
import { portRefusal } from "./reply.js";
import { refusalVocabulary } from "./refusals.js";

const REFUSALS = refusalVocabulary(["unavailable", "approval_required", "too_large"], { fallback: "unavailable" });

const DECLARATION = declareContract({
  contract: "notify-demo/v1",
  summary: "a demo notifier",
  actions: {
    send_text: {
      summary: "把一段文字发给一个收件人",
      operation: "send_notification",
      params: {
        recipient: {
          type: "string",
          description: "不透明收件人引用",
          maxLength: 200,
          pattern: /^[A-Za-z0-9_-]{1,200}$/,
        },
        body: { type: "string", description: "正文", maxLength: 512 },
        urgent: { type: "boolean", description: "是否加急", optional: true },
        retries: { type: "integer", description: "重试次数", minimum: 0, maximum: 3, optional: true },
        mode: { type: "string", description: "投递方式", enum: ["direct", "group"], optional: true },
      },
    },
    send_card: {
      summary: "发一张结构化卡片",
      params: {
        recipient: { type: "string", description: "不透明收件人引用", maxLength: 200 },
        card: {
          type: "json",
          description: "卡片内容",
          maxLength: 512,
          schema: {
            type: "object",
            properties: { title: { type: "string", maxLength: 60 }, lines: { type: "array" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
    },
  },
  refusals: REFUSALS,
});

describe("mcpToolsOf", () => {
  const tools = mcpToolsOf(DECLARATION);
  const text = tools.find((tool) => tool.name === "notify-demo_send_text")!;
  const card = tools.find((tool) => tool.name === "notify-demo_send_card")!;

  it("derives one tool per action, in declaration order, named from the contract", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["notify-demo_send_text", "notify-demo_send_card"]);
  });

  it("emits the repository's own tool shape and nothing else", () => {
    expect(Object.keys(text).sort()).toEqual(["description", "inputSchema", "name"]);
    expect(text.inputSchema.type).toBe("object");
    // Only one place in this repository sets it today, and its absence
    // elsewhere is how a model's invented extra argument reaches a handler that
    // ignores it — which reads to the model as "accepted".
    expect(text.inputSchema.additionalProperties).toBe(false);
  });

  it("carries EVERY declared bound, which is the whole reason to derive", () => {
    // The existing hand-written generator emits `{ type }` and drops all of
    // these; a model that cannot see a bound will exceed it and be refused for
    // a reason it was never shown.
    expect(text.inputSchema.properties.recipient).toEqual({
      type: "string",
      description: "不透明收件人引用",
      maxLength: 200,
      pattern: "^[A-Za-z0-9_-]{1,200}$",
    });
    expect(text.inputSchema.properties.retries).toEqual({
      type: "integer",
      description: "重试次数",
      minimum: 0,
      maximum: 3,
    });
    expect(text.inputSchema.properties.mode).toEqual({
      type: "string",
      description: "投递方式",
      enum: ["direct", "group"],
    });
    expect(text.inputSchema.properties.urgent).toEqual({ type: "boolean", description: "是否加急" });
  });

  it("derives `required` from the absence of `optional`", () => {
    expect(text.inputSchema.required).toEqual(["recipient", "body"]);
  });

  it("omits `required` entirely when nothing is required", () => {
    const optionalOnly = declareContract({
      contract: "demo/v1",
      summary: "s",
      actions: { go: { summary: "s", params: { x: { type: "boolean", description: "d", optional: true } } } },
      refusals: REFUSALS,
    });
    expect("required" in mcpToolsOf(optionalOnly)[0]!.inputSchema).toBe(false);
  });

  it("gives a json field its nested schema, and no wire bound", () => {
    // The wire's 512 characters is the WIRE's limit. A bridge runs inside the
    // trusted process and receives the object itself.
    expect(card.inputSchema.properties.card).toEqual({
      description: "卡片内容",
      type: "object",
      properties: { title: { type: "string", maxLength: 60 }, lines: { type: "array" } },
      required: ["title"],
      additionalProperties: false,
    });
    expect("maxLength" in (card.inputSchema.properties.card as Record<string, unknown>)).toBe(false);
  });

  it("falls back to a plain object for a json field with no schema", () => {
    const bare = declareContract({
      contract: "demo/v1",
      summary: "s",
      actions: { go: { summary: "s", params: { c: { type: "json", description: "d", maxLength: 64 } } } },
      refusals: REFUSALS,
    });
    expect(mcpToolsOf(bare)[0]!.inputSchema.properties.c).toEqual({ description: "d", type: "object" });
  });

  it("names the permission token and the contract in the description", () => {
    // An agent with two notification tools mounted needs to know which service
    // each one reaches; the tool name alone is a prefix somebody chose.
    expect(text.description).toContain("（权限词元 send_notification）");
    expect(text.description).toContain("[notify-demo/v1]");
    expect(card.description).not.toContain("权限词元");
  });

  it("publishes the closed refusal set, and can be told not to", () => {
    expect(text.description).toContain("unavailable、approval_required、too_large");
    expect(mcpToolsOf(DECLARATION, { describeRefusals: false })[0]!.description).not.toContain("拒绝");
  });

  it("honours a name prefix and a subset, in the order given", () => {
    const subset = mcpToolsOf(DECLARATION, { namePrefix: "feishu", only: ["send_card"] });
    expect(subset.map((tool) => tool.name)).toEqual(["feishu_send_card"]);
  });

  it("throws for an action it was told to derive that does not exist", () => {
    expect(() => mcpToolsOf(DECLARATION, { only: ["send_smoke_signal"] })).toThrow(/has no action/);
    expect(() => mcpToolsOf(DECLARATION, { only: ["toString"] })).toThrow(/has no action/);
  });

  it("throws for a prefix that cannot produce a legal MCP name", () => {
    // A derivation that quietly produced an unusable name would surface as a
    // tool that never appears, which is indistinguishable from one that was
    // never registered.
    expect(() => mcpToolsOf(DECLARATION, { namePrefix: "not ok" })).toThrow(/not a legal MCP name/);
    expect(() => mcpToolsOf(DECLARATION, { namePrefix: "a/b" })).toThrow(/not a legal MCP name/);
  });

  it("derives a prefix from a dotted contract namespace", () => {
    const dotted = declareContract({
      contract: "session.roster/v1",
      summary: "s",
      actions: { go: { summary: "s", params: {} } },
      refusals: REFUSALS,
    });
    expect(mcpToolsOf(dotted)[0]!.name).toBe("session_go");
  });

  it("produces frozen data, so a caller cannot edit the derivation in place", () => {
    expect(Object.isFrozen(tools)).toBe(true);
    expect(Object.isFrozen(text)).toBe(true);
    expect(Object.isFrozen(text.inputSchema)).toBe(true);
  });
});

describe("mcpErrorOf", () => {
  it("puts the code where an agent can act on it", () => {
    // The prose is written for a person and may be in any language;
    // `approval_required` means the same thing every time.
    expect(mcpErrorOf(portRefusal("approval_required", "去可信面板批准一下。"))).toEqual({
      isError: true,
      content: [{ type: "text", text: "approval_required: 去可信面板批准一下。" }],
    });
  });
});
