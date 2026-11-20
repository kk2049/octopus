import { describe, expect, it } from "vitest";

import { REPLY_LIMITS, boundedMessage, isRefusal, portRefusal, portValue } from "./reply.js";

describe("boundedMessage", () => {
  it("replaces control characters rather than dropping them", () => {
    const raw = `a${String.fromCharCode(0)}b${String.fromCharCode(0x1f)}c${String.fromCharCode(0x7f)}d`;
    expect(boundedMessage(raw)).toBe("a�b�c�d");
  });

  it("keeps printable text, including non-ASCII, untouched", () => {
    expect(boundedMessage("这个引用不属于当前视图。")).toBe("这个引用不属于当前视图。");
  });

  it("truncates with an ellipsis and stays within the bound", () => {
    const clipped = boundedMessage("x".repeat(500));
    expect(clipped.length).toBe(REPLY_LIMITS.maxMessageLength);
    expect(clipped.endsWith("\u2026")).toBe(true);
  });

  it("answers empty for anything that is not a string", () => {
    // A refusal whose message is `undefined` reaches a person as a blank box,
    // so the fold happens here rather than at every render site.
    expect(boundedMessage(undefined)).toBe("");
    expect(boundedMessage(42)).toBe("");
    expect(boundedMessage(null)).toBe("");
  });
});

describe("portRefusal", () => {
  it("bounds the message and freezes the envelope", () => {
    const refusal = portRefusal("too_large", `bad${String.fromCharCode(7)}`);
    expect(refusal).toEqual({ ok: false, code: "too_large", message: "bad�" });
    expect(Object.isFrozen(refusal)).toBe(true);
  });

  it("honours a narrower bound", () => {
    expect(portRefusal("x", "abcdef", 3).message).toBe("ab\u2026");
  });
});

describe("portValue", () => {
  it("freezes the envelope but not the payload", () => {
    const payload = { rows: [1] };
    const reply = portValue(payload);
    expect(reply.ok).toBe(true);
    expect(Object.isFrozen(reply)).toBe(true);
    // Stated because it is a real limit of this layer: deep-freezing an
    // arbitrary T is not something a generic wrapper can do.
    expect(Object.isFrozen(reply.value)).toBe(false);
  });
});

describe("isRefusal", () => {
  it("narrows in both directions", () => {
    expect(isRefusal(portRefusal("nope", "no"))).toBe(true);
    expect(isRefusal(portValue(1))).toBe(false);
  });
});
