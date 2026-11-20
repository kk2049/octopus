import { describe, expect, it } from "vitest";

import { declareContract, type PortActionSpec } from "./declaration.js";
import { actionOf, canonicalJson, decodeWireParams, encodeWireParams } from "./params.js";
import { refusalVocabulary } from "./refusals.js";
import { WIRE_PARAM_LIMITS } from "./wire.js";

const REFUSALS = refusalVocabulary(["unavailable"], { fallback: "unavailable" });

const ACTION: PortActionSpec = {
  summary: "everything at once",
  params: {
    text: { type: "string", description: "some text", maxLength: 10 },
    mode: { type: "string", description: "how", enum: ["fast", "slow"] },
    ref: { type: "string", description: "opaque", maxLength: 20, pattern: /^[A-Za-z0-9_-]+$/ },
    count: { type: "integer", description: "how many", minimum: 0, maximum: 100 },
    flag: { type: "boolean", description: "whether", optional: true },
    blob: { type: "json", description: "structure", maxLength: 60, optional: true },
  },
};

const DECLARATION = declareContract({
  contract: "demo/v1",
  summary: "demo",
  actions: { go: ACTION },
  refusals: REFUSALS,
});
const GO = DECLARATION.byAction.go;

function issues(
  result: ReturnType<typeof encodeWireParams> | ReturnType<typeof decodeWireParams>,
): string[] {
  return result.ok ? [] : result.issues.map((issue) => `${issue.code}:${issue.message}`);
}

describe("encodeWireParams", () => {
  it("encodes every declared type as a flat string", () => {
    const out = encodeWireParams(GO, {
      text: "hello",
      mode: "fast",
      ref: "abc-123",
      count: 7,
      flag: true,
      blob: { a: 1 },
    });
    expect(out).toEqual({
      ok: true,
      value: { text: "hello", mode: "fast", ref: "abc-123", count: "7", flag: "true", blob: '{"a":1}' },
    });
  });

  it("omits an absent optional rather than sending it empty", () => {
    // The wire has an eight-key budget, and "" is a value: a far side that
    // distinguishes "no flag" from "flag false" would be given the wrong answer.
    const out = encodeWireParams(GO, { text: "x", mode: "slow", ref: "r", count: 0 });
    expect(out.ok && Object.keys(out.value).sort()).toEqual(["count", "mode", "ref", "text"]);
  });

  it("treats null the same as absent", () => {
    const out = encodeWireParams(GO, { text: "x", mode: "slow", ref: "r", count: 0, flag: null });
    expect(out.ok && "flag" in out.value).toBe(false);
  });

  it("refuses an unknown parameter instead of dropping it", () => {
    // Dropping sends a proposal that means something different from what the
    // caller wrote.
    const out = encodeWireParams(GO, { text: "x", mode: "slow", ref: "r", count: 0, sneaky: "1" });
    expect(issues(out)).toContain("unknown_field:unknown parameter sneaky");
  });

  it("refuses a missing required parameter", () => {
    expect(issues(encodeWireParams(GO, {}))).toEqual([
      "missing_field:missing text",
      "missing_field:missing mode",
      "missing_field:missing ref",
      "missing_field:missing count",
    ]);
  });

  it("does not coerce between types", () => {
    // The panel's own schema layer turned coercion off for the same reason: a
    // schema that rewrites the request has not validated the request.
    const base = { text: "x", mode: "slow", ref: "r", count: 0 };
    expect(issues(encodeWireParams(GO, { ...base, count: "7" }))).toContain("field_type:count must be an integer");
    expect(issues(encodeWireParams(GO, { ...base, text: 7 }))).toContain("field_type:text must be a string");
    expect(issues(encodeWireParams(GO, { ...base, flag: "true" }))).toContain("field_type:flag must be a boolean");
    expect(issues(encodeWireParams(GO, { ...base, count: 1.5 }))).toContain("field_type:count must be an integer");
  });

  it("enforces every declared bound", () => {
    const base = { text: "x", mode: "slow", ref: "r", count: 0 };
    expect(issues(encodeWireParams(GO, { ...base, text: "x".repeat(11) }))).toContain(
      "limit:text is longer than 10 characters",
    );
    expect(issues(encodeWireParams(GO, { ...base, mode: "medium" }))).toContain("schema:mode must be one of fast, slow");
    expect(issues(encodeWireParams(GO, { ...base, ref: "not ok" }))).toContain(
      "identifier:ref does not match its declared form",
    );
    expect(issues(encodeWireParams(GO, { ...base, count: 101 }))).toContain("limit:count is above 100");
    expect(issues(encodeWireParams(GO, { ...base, count: -1 }))).toContain("limit:count is below 0");
  });
});

describe("json fields", () => {
  const base = { text: "x", mode: "slow", ref: "r", count: 0 };

  it("measures the ENCODED form, so escaping counts", () => {
    // Every string in this value respects its own bound; the escaping is what
    // pushes the encoding over. Truncating it would produce a document that
    // parses into something else, so it is a refusal.
    const quotes = { note: '"'.repeat(40) };
    expect(canonicalJson(quotes)!.length).toBeGreaterThan(60);
    expect(issues(encodeWireParams(GO, { ...base, blob: quotes }))).toContain(
      "limit:blob encodes to more than 60 characters",
    );
  });

  it("refuses a value JSON cannot represent instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(issues(encodeWireParams(GO, { ...base, blob: cyclic }))).toContain(
      "field_type:blob is not representable as JSON",
    );
    expect(() => encodeWireParams(GO, { ...base, blob: { n: 1n } })).not.toThrow();
    expect(issues(encodeWireParams(GO, { ...base, blob: { n: 1n } }))).toContain(
      "field_type:blob is not representable as JSON",
    );
  });

  it("preserves construction order, which is what makes canonical round-trip an equality", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"b":1,"a":2}');
    expect(canonicalJson(undefined)).toBeNull();
  });
});

describe("the wire's own ceiling", () => {
  const wide = declareContract({
    contract: "demo/v1",
    summary: "demo",
    actions: { go: { summary: "s", params: { body: { type: "string", description: "d", maxLength: 4000 } } } },
    refusals: REFUSALS,
  });

  it("carries a value over 512 characters when the field declared it", () => {
    // The editor batch's ruling: the DECLARATION raises the bound, so a
    // declared 4000-character field encodes 600 characters rather than being
    // refused for a limit that was never its own.
    const out = encodeWireParams(wide.byAction.go, { body: "x".repeat(600) });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.body).toHaveLength(600);
  });

  it("still refuses a value over the field's own declared bound", () => {
    const out = encodeWireParams(wide.byAction.go, { body: "x".repeat(4001) });
    expect(issues(out)).toContain("limit:body is longer than 4000 characters");
  });

  it("falls back to the default bound for a field that declared none", () => {
    // An unbounded field is a wire problem, so `createRemoteCall` refuses to
    // build for this declaration at all. If one is reached anyway, the encoder
    // bounds it at the DEFAULT rather than at the raised ceiling: an unknown
    // size gets the narrow answer.
    const loose = declareContract({
      contract: "demo/v1",
      summary: "demo",
      actions: { go: { summary: "s", params: { body: { type: "string", description: "d" } } } },
      refusals: REFUSALS,
    });
    expect(loose.wireProblems.go).toHaveLength(1);
    const out = encodeWireParams(loose.byAction.go, { body: "x".repeat(600) });
    expect(issues(out)).toContain(`limit:body is longer than the wire's ${WIRE_PARAM_LIMITS.maxValueLength} characters`);
  });

  it("decodes with the same bound it encoded against", () => {
    // Two numbers here would mean a value the client may send and the server
    // silently drops. `decodeWireParams` reads `wireValueLimit` too.
    const body = "x".repeat(600);
    expect(decodeWireParams(wide.byAction.go, { body })).toEqual({ ok: true, value: { body } });
    const over = decodeWireParams(wide.byAction.go, { body: "x".repeat(4001) });
    expect(issues(over)).toContain("limit:body is longer than the wire's 4000 characters");
  });
});

describe("decodeWireParams", () => {
  it("round-trips every type back to its declared shape", () => {
    const encoded = encodeWireParams(GO, {
      text: "hello",
      mode: "fast",
      ref: "abc",
      count: 7,
      flag: false,
      blob: { a: [1, 2] },
    });
    expect(encoded.ok).toBe(true);
    const decoded = decodeWireParams(GO, encoded.ok ? encoded.value : {});
    expect(decoded).toEqual({
      ok: true,
      value: { text: "hello", mode: "fast", ref: "abc", count: 7, flag: false, blob: { a: [1, 2] } },
    });
  });

  it("parses integers strictly", () => {
    // `parseInt` would accept "12abc"; `Number` would accept " 12 ", "0x0c"
    // and "1e3". A wire value that is nearly a number is a caller that meant
    // something else.
    const base = { text: "x", mode: "slow", ref: "r" };
    for (const bad of ["12abc", " 12 ", "1e3", "0x0c", "", "+7", "007", "1.0"]) {
      const out = decodeWireParams(GO, { ...base, count: bad });
      expect(out.ok, `expected ${JSON.stringify(bad)} to be refused`).toBe(false);
    }
    expect(decodeWireParams(GO, { ...base, count: "0" }).ok).toBe(true);
    expect(decodeWireParams(GO, { ...base, count: "-0" }).ok).toBe(false);
  });

  it("parses booleans strictly", () => {
    const base = { text: "x", mode: "slow", ref: "r", count: "1" };
    expect(decodeWireParams(GO, { ...base, flag: "1" }).ok).toBe(false);
    expect(decodeWireParams(GO, { ...base, flag: "TRUE" }).ok).toBe(false);
    expect(decodeWireParams(GO, { ...base, flag: "true" }).ok).toBe(true);
  });

  it("refuses a value that did not arrive as a string", () => {
    const out = decodeWireParams(GO, { text: 1, mode: "slow", ref: "r", count: "1" });
    expect(out.ok ? [] : out.issues.map((i) => i.message)).toContain("text must arrive as a string");
  });

  it("refuses unparseable json and an unknown parameter", () => {
    const base = { text: "x", mode: "slow", ref: "r", count: "1" };
    expect(decodeWireParams(GO, { ...base, blob: "{oops" }).ok).toBe(false);
    expect(decodeWireParams(GO, { ...base, extra: "x" }).ok).toBe(false);
  });

  it("refuses a value over the wire's ceiling before looking at the field", () => {
    const out = decodeWireParams(GO, { text: "x".repeat(600), mode: "slow", ref: "r", count: "1" });
    expect(out.ok ? [] : out.issues.map((i) => i.message)).toContain(
      `text is longer than the wire's ${WIRE_PARAM_LIMITS.maxValueLength} characters`,
    );
  });

  it("leaves a json field's meaning to the contract's own reader", () => {
    // This layer knows a value arrived and that it parsed. What it means is a
    // question only the contract can answer.
    const decoded = decodeWireParams(GO, { text: "x", mode: "slow", ref: "r", count: "1", blob: '"just a string"' });
    expect(decoded).toEqual({ ok: true, value: { text: "x", mode: "slow", ref: "r", count: 1, blob: "just a string" } });
  });
});

describe("actionOf", () => {
  it("answers null for an id that is not declared, including inherited names", () => {
    expect(actionOf(DECLARATION, "go")?.action).toBe("go");
    expect(actionOf(DECLARATION, "nope")).toBeNull();
    expect(actionOf(DECLARATION, "toString")).toBeNull();
    expect(actionOf(DECLARATION, "__proto__")).toBeNull();
  });
});
