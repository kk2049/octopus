import { describe, expect, it } from "vitest";

import { encodeWireParams, mcpToolsOf, wireServiceableActions } from "@claude-bot/typed-port-kit";

import { NOTIFY_CONTRACT, NOTIFY_DECLARATION, NOTIFY_LIMITS, NOTIFY_OPERATIONS, NOTIFY_REFUSALS } from "./contract.js";
import { encodeNotifyCard, readNotifyCard, readNotifyReceipt } from "./projection.js";

describe("the vocabulary", () => {
  it("is exactly two actions, and both spend one permission token", () => {
    // Sending a person a card and sending them a paragraph is one
    // authorisation; the action ids stay separate so an approval card says
    // which one was asked for. Same split as append/resume.
    expect(NOTIFY_DECLARATION.contract).toBe(NOTIFY_CONTRACT);
    expect(NOTIFY_DECLARATION.actionIds).toEqual(["send_text", "send_card"]);
    expect(NOTIFY_DECLARATION.byAction.send_text.operation).toBe("send_notification");
    expect(NOTIFY_DECLARATION.byAction.send_card.operation).toBe("send_notification");
    expect(NOTIFY_OPERATIONS).toEqual(["send_notification"]);
  });

  it("is exactly nine refusal codes, and unavailable is where the unknown fold", () => {
    expect(NOTIFY_REFUSALS.codes).toEqual([
      "unavailable",
      "refused",
      "bad_recipient",
      "too_large",
      "approval_required",
      "no_authority",
      "scope_closed",
      "invalid_request",
      "rate_limited",
    ]);
    expect(NOTIFY_REFUSALS.fallback).toBe("unavailable");
    expect(NOTIFY_REFUSALS.coerce("delivered_to_the_moon")).toBe("unavailable");
  });

  it("is serviceable over the View wire, and that is a checked fact", () => {
    // `maxBodyLength` is 512 because that is exactly one wire parameter. If
    // somebody raises it, this is where they find out.
    expect(NOTIFY_DECLARATION.wireProblems).toEqual({ send_text: [], send_card: [] });
    expect(wireServiceableActions(NOTIFY_DECLARATION)).toEqual(["send_text", "send_card"]);
  });

  it("has no verb that enumerates recipients", () => {
    // v1 has no enumeration on purpose: adding it discloses a colleague list,
    // which is a permission contract change rather than a refactor.
    const surface = JSON.stringify(NOTIFY_DECLARATION.actionIds);
    expect(surface).not.toMatch(/list|search|find|who|directory/i);
  });
});

describe("the card's bounds add up", () => {
  const maximal = {
    title: "标".repeat(NOTIFY_LIMITS.maxTitleLength),
    lines: Array.from({ length: NOTIFY_LIMITS.maxLines }, () => "行".repeat(NOTIFY_LIMITS.maxLineLength)),
  };

  it("lets the LARGEST legal card still encode inside the wire's parameter", () => {
    // A set of per-field bounds adding up to more than the encoding allows
    // would make the biggest legal card unsendable — a contract that accepts a
    // value it cannot carry.
    const read = readNotifyCard(maximal);
    expect(read.ok).toBe(true);
    const encoded = encodeNotifyCard(maximal)!;
    expect(encoded.length).toBeLessThanOrEqual(NOTIFY_LIMITS.maxCardEncodedLength);
    expect(encodeWireParams(NOTIFY_DECLARATION.byAction.send_card, { recipient: "r", card: maximal }).ok).toBe(true);
  });

  it("refuses a card whose ESCAPING pushes it over, rather than mangling it", () => {
    // Every string here respects its own bound; JSON escaping is what pushes
    // the encoding over. Truncating would produce a document that parses into
    // something else.
    const quoted = {
      title: '"'.repeat(NOTIFY_LIMITS.maxTitleLength),
      lines: Array.from({ length: NOTIFY_LIMITS.maxLines }, () => "\\".repeat(NOTIFY_LIMITS.maxLineLength)),
    };
    expect(readNotifyCard(quoted).ok).toBe(true);
    expect(encodeNotifyCard(quoted)!.length).toBeGreaterThan(NOTIFY_LIMITS.maxCardEncodedLength);
    const encoded = encodeWireParams(NOTIFY_DECLARATION.byAction.send_card, { recipient: "r", card: quoted });
    expect(encoded.ok).toBe(false);
    expect(encoded.ok ? [] : encoded.issues.map((issue) => issue.message)).toContain(
      `card encodes to more than ${NOTIFY_LIMITS.maxCardEncodedLength} characters`,
    );
  });
});

describe("readNotifyCard", () => {
  const good = { title: "部署完成", lines: ["v3 已上线", "耗时 4 分钟"] };

  it("round-trips to canonical bytes, in one fixed field order", () => {
    const read = readNotifyCard(good);
    expect(read.ok && read.value).toEqual(good);
    const bytes = encodeNotifyCard(read.ok ? read.value : good)!;
    expect(bytes).toBe('{"title":"部署完成","lines":["v3 已上线","耗时 4 分钟"]}');
    const again = readNotifyCard(JSON.parse(bytes));
    expect(again.ok && encodeNotifyCard(again.value)).toBe(bytes);
  });

  it("accepts a card with no lines at all", () => {
    expect(readNotifyCard({ title: "只有标题", lines: [] })).toEqual({
      ok: true,
      value: { title: "只有标题", lines: [] },
    });
  });

  function issues(value: unknown): string[] {
    const read = readNotifyCard(value);
    return read.ok ? [] : read.issues.map((issue) => `${issue.code}:${issue.message}`);
  }

  it("refuses an unknown field rather than ignoring it", () => {
    // A field this build does not understand is either a newer schema or a typo
    // that quietly turned something off.
    expect(issues({ ...good, buttons: [] })).toContain("unknown_field:unknown field buttons");
  });

  it("refuses a missing, empty or over-long title", () => {
    expect(issues({ lines: [] })).toContain("missing_field:missing title");
    expect(issues({ title: "", lines: [] })).toContain("schema:title must not be empty");
    expect(issues({ title: "x".repeat(61), lines: [] })).toContain(
      `limit:title is longer than ${NOTIFY_LIMITS.maxTitleLength} characters`,
    );
  });

  it("refuses too many lines, an over-long line, and a line that is not a string", () => {
    expect(issues({ title: "t", lines: ["a", "b", "c", "d"] })).toContain(
      `limit:lines has more than ${NOTIFY_LIMITS.maxLines} entries`,
    );
    expect(issues({ title: "t", lines: ["x".repeat(101)] })).toContain(
      `limit:a line is longer than ${NOTIFY_LIMITS.maxLineLength} characters`,
    );
    expect(issues({ title: "t", lines: [7] })).toContain("field_type:a line must be a string");
    expect(issues({ title: "t", lines: "not an array" })).toContain("field_type:lines must be an array");
  });

  it("refuses control characters rather than scrubbing them", () => {
    // A card is text an App CONSTRUCTED. Scrubbing would silently send
    // something other than what the author wrote.
    const bell = String.fromCharCode(7);
    expect(issues({ title: `a${bell}`, lines: [] })).toContain("schema:title must not contain control characters");
    expect(issues({ title: "t", lines: [`a${bell}`] })).toContain(
      "schema:a line must not contain control characters",
    );
  });

  it("refuses a value that is not an object at all", () => {
    for (const value of [null, "a card", 7, ["title"]]) {
      expect(readNotifyCard(value).ok, `for ${JSON.stringify(value)}`).toBe(false);
    }
  });
});

describe("readNotifyReceipt", () => {
  const good = { recipient: "rcpt-abc", deliveryId: "dlv-00000001", acceptedAt: "2026-08-07T10:00:00.000Z" };

  it("accepts a well-formed receipt", () => {
    expect(readNotifyReceipt(good)).toEqual({ ok: true, value: good });
  });

  function issues(value: unknown): string[] {
    const read = readNotifyReceipt(value);
    return read.ok ? [] : read.issues.map((issue) => `${issue.code}:${issue.message}`);
  }

  it("refuses a platform routing id smuggled in as an extra field", () => {
    // The field list IS the boundary: a chat id or the platform's own message
    // id would leak a routing handle into a bundle whose premise is that it
    // cannot address anything directly.
    expect(issues({ ...good, chatId: "oc_1" })).toContain("unknown_field:unknown field chatId");
    expect(issues({ ...good, messageId: "om_1" })).toContain("unknown_field:unknown field messageId");
    expect(issues({ ...good, openId: "ou_1" })).toContain("unknown_field:unknown field openId");
  });

  it("refuses a recipient that is not a bounded printable reference", () => {
    expect(issues({ ...good, recipient: `a${String.fromCharCode(9)}b` })).toContain(
      "identifier:recipient must be a bounded printable reference",
    );
    expect(issues({ ...good, recipient: "x".repeat(201) })).toContain(
      `limit:recipient is longer than ${NOTIFY_LIMITS.maxRecipientLength} characters`,
    );
  });

  it("refuses a delivery id that is not a bounded opaque token", () => {
    expect(issues({ ...good, deliveryId: "short" })).toContain("identifier:deliveryId must be a bounded opaque token");
    expect(issues({ ...good, deliveryId: "has spaces here" })).toContain(
      "identifier:deliveryId must be a bounded opaque token",
    );
  });

  it("refuses an acceptedAt that is not an ISO instant in UTC", () => {
    for (const bad of ["2026-08-07", "2026-08-07T10:00:00+08:00", "Aug 7 2026", 1_754_560_000_000]) {
      expect(issues({ ...good, acceptedAt: bad }), `for ${JSON.stringify(bad)}`).toContain(
        "field_type:acceptedAt must be an ISO-8601 instant in UTC",
      );
    }
  });

  it("refuses a missing field rather than defaulting it", () => {
    expect(issues({ recipient: "r" })).toEqual(
      expect.arrayContaining(["missing_field:missing deliveryId", "field_type:acceptedAt must be an ISO-8601 instant in UTC"]),
    );
  });
});

describe("the MCP face", () => {
  const tools = mcpToolsOf(NOTIFY_DECLARATION);

  it("derives one tool per action, with every declared bound carried", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["notify_send_text", "notify_send_card"]);
    const text = tools[0]!;
    expect(text.inputSchema.required).toEqual(["recipient", "body"]);
    expect(text.inputSchema.additionalProperties).toBe(false);
    expect(text.inputSchema.properties.body).toMatchObject({
      type: "string",
      maxLength: NOTIFY_LIMITS.maxBodyLength,
    });
    expect(text.inputSchema.properties.recipient).toMatchObject({
      type: "string",
      maxLength: NOTIFY_LIMITS.maxRecipientLength,
      pattern: "^[ -~]{1,200}$",
    });
  });

  it("gives the card its nested schema, not a string containing JSON", () => {
    // The wire's 512 characters is the WIRE's limit; a bridge runs inside the
    // trusted process and receives the object itself.
    const card = tools[1]!.inputSchema.properties.card as Record<string, unknown>;
    expect(card.type).toBe("object");
    expect(card.additionalProperties).toBe(false);
    expect(card.required).toEqual(["title", "lines"]);
    expect("maxLength" in card).toBe(false);
  });

  it("publishes the closed refusal set to whoever reads the tools", () => {
    expect(tools[0]!.description).toContain("approval_required");
    expect(tools[0]!.description).toContain("（权限词元 send_notification）");
  });
});
