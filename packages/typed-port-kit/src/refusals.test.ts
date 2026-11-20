import { describe, expect, it } from "vitest";

import { foldRefusalInto, isRefusalCode, refusalVocabulary } from "./refusals.js";

const CODES = refusalVocabulary(["unavailable", "refused", "too_large"], { fallback: "unavailable" });

describe("refusalVocabulary construction", () => {
  it("freezes the declared list in declaration order", () => {
    expect(CODES.codes).toEqual(["unavailable", "refused", "too_large"]);
    expect(Object.isFrozen(CODES.codes)).toBe(true);
  });

  it("refuses an empty vocabulary", () => {
    expect(() => refusalVocabulary([] as string[], { fallback: "x" })).toThrow(/at least one code/);
  });

  it("refuses a duplicate code", () => {
    expect(() => refusalVocabulary(["a", "a"], { fallback: "a" })).toThrow(/declared twice/);
  });

  it("refuses a code that is not a plain identifier", () => {
    // A code is compared, logged and switched on. Punctuation lets it carry
    // structure, and structure invites parsing.
    expect(() => refusalVocabulary(["Too-Large"], { fallback: "Too-Large" })).toThrow(/plain identifier/);
    expect(() => refusalVocabulary(["a/b"], { fallback: "a/b" })).toThrow(/plain identifier/);
  });

  it("refuses a fallback outside its own set", () => {
    expect(() => refusalVocabulary(["a"], { fallback: "b" as "a" })).toThrow(/not one of the declared codes/);
  });

  it("refuses a nonsensical message bound", () => {
    expect(() => refusalVocabulary(["a"], { fallback: "a", maxMessageLength: 0 })).toThrow(/positive integer/);
  });
});

describe("isRefusalCode", () => {
  it("accepts snake_case identifiers and nothing else", () => {
    expect(isRefusalCode("approval_required")).toBe(true);
    expect(isRefusalCode("a1")).toBe(true);
    expect(isRefusalCode("1a")).toBe(false);
    expect(isRefusalCode("")).toBe(false);
    expect(isRefusalCode(42)).toBe(false);
  });
});

describe("coercing an unrecognised code", () => {
  it("recognises its own", () => {
    expect(CODES.has("refused")).toBe(true);
    expect(CODES.coerce("refused")).toBe("refused");
  });

  it("folds anything else to the declared fallback", () => {
    // A Host one release newer can answer with a code this build has never
    // heard of. Rendering it as if it meant something is the one outcome that
    // is worse than saying "this build cannot interpret what happened".
    expect(CODES.coerce("rate_limited")).toBe("unavailable");
    expect(CODES.coerce(undefined)).toBe("unavailable");
    expect(CODES.coerce({ code: "refused" })).toBe("unavailable");
  });

  it("does not treat inherited properties as membership", () => {
    expect(CODES.has("toString")).toBe(false);
    expect(CODES.has("__proto__")).toBe(false);
  });
});

describe("fold", () => {
  it("keeps the far side's text when there is any", () => {
    expect(CODES.fold("too_large", "文件太大了。", "fallback")).toEqual({
      ok: false,
      code: "too_large",
      message: "文件太大了。",
    });
  });

  it("substitutes the fallback text for an empty or absent message", () => {
    // An empty message reaches a person as a blank box.
    expect(CODES.fold("refused", "", "没有说明原因。").message).toBe("没有说明原因。");
    expect(CODES.fold("refused", undefined, "没有说明原因。").message).toBe("没有说明原因。");
  });

  it("bounds the message with the vocabulary's own limit", () => {
    const narrow = refusalVocabulary(["a"], { fallback: "a", maxMessageLength: 4 });
    expect(narrow.fold("a", "abcdefgh", "x").message).toBe("abc\u2026");
  });
});

describe("foldRefusalInto", () => {
  const stream = refusalVocabulary(["denied", "expired", "protocol", "unavailable"], { fallback: "unavailable" });

  it("translates the codes it names", () => {
    const fold = foldRefusalInto(stream, { approval_required: "denied", scope_closed: "expired" });
    expect(fold("approval_required", "去批准", "x").code).toBe("denied");
    expect(fold("scope_closed", "过期了", "x").code).toBe("expired");
  });

  it("sends an unmapped code through the destination's own fold", () => {
    // Unmapped and unknown reach the same honest answer by the same path,
    // rather than one of them being rendered as something it is not.
    const fold = foldRefusalInto(stream, { approval_required: "denied" });
    expect(fold("protocol", "坏帧", "x").code).toBe("protocol");
    expect(fold("bad_recipient", "谁?", "x").code).toBe("unavailable");
  });

  it("refuses a destination code the target vocabulary does not have", () => {
    expect(() => foldRefusalInto(stream, { a: "nope" as "denied" })).toThrow(/targets unknown code/);
  });

  it("refuses a source key that is not a plain identifier", () => {
    expect(() => foldRefusalInto(stream, { "a b": "denied" })).toThrow(/plain identifier/);
  });

  it("does not read inherited keys from the mapping", () => {
    const fold = foldRefusalInto(stream, {});
    expect(fold("toString", "x", "y").code).toBe("unavailable");
  });
});
