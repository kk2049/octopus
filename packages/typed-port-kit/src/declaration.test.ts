import { describe, expect, it } from "vitest";

import {
  declareContract,
  wireServiceableActions,
  wireValueLimit,
  type PortActionSpec,
} from "./declaration.js";
import { refusalVocabulary } from "./refusals.js";
import { WIRE_PARAM_LIMITS } from "./wire.js";

const REFUSALS = refusalVocabulary(["unavailable", "invalid_request"], { fallback: "unavailable" });

function declare(actions: Record<string, PortActionSpec>) {
  return declareContract({ contract: "demo/v1", summary: "a demo", actions, refusals: REFUSALS });
}

const SIMPLE: PortActionSpec = {
  summary: "do a thing",
  params: { thing: { type: "string", description: "the thing", maxLength: 40 } },
};

describe("declareContract", () => {
  it("normalises actions into declaration order with their ids attached", () => {
    const declaration = declare({ first: SIMPLE, second: SIMPLE });
    expect(declaration.actionIds).toEqual(["first", "second"]);
    expect(declaration.actions.map((action) => action.action)).toEqual(["first", "second"]);
    expect(declaration.byAction.first.summary).toBe("do a thing");
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(declaration.byAction.first)).toBe(true);
  });

  it("collects permission tokens, deduplicated and sorted", () => {
    // Two actions MAY name one operation: `append` and `resume` are two
    // intentions under one persistent authorisation.
    const declaration = declare({
      append: { ...SIMPLE, operation: "append_session" },
      resume: { ...SIMPLE, operation: "append_session" },
      read: { ...SIMPLE, operation: "a_read" },
      pin: SIMPLE,
    });
    expect(declaration.operations).toEqual(["a_read", "append_session"]);
  });

  it("refuses a contract id a binding plan could not reference", () => {
    const bad = ["notify", "notify/1", "Notify/v1", "notify/v0", "notify/v1/x", "../notify/v1"];
    for (const contract of bad) {
      expect(() =>
        declareContract({ contract, summary: "x", actions: { a: SIMPLE }, refusals: REFUSALS }),
      ).toThrow(/not a valid contract identifier/);
    }
  });

  it("refuses a declaration with no actions and one with no summary", () => {
    expect(() => declare({})).toThrow(/at least one action/);
    expect(() =>
      declareContract({ contract: "demo/v1", summary: "", actions: { a: SIMPLE }, refusals: REFUSALS }),
    ).toThrow(/needs a summary/);
    expect(() => declare({ a: { ...SIMPLE, summary: "" } })).toThrow(/needs a summary/);
  });

  it("refuses an action id or parameter name that is not a plain identifier", () => {
    expect(() => declare({ "Do-It": SIMPLE })).toThrow(/not a plain identifier/);
    expect(() =>
      declare({ a: { summary: "s", params: { "not ok": { type: "string", description: "d", maxLength: 1 } } } }),
    ).toThrow(/not a plain identifier/);
  });

  it("refuses a parameter with no description, because that is what an agent reads", () => {
    expect(() => declare({ a: { summary: "s", params: { p: { type: "string", description: "" } } } })).toThrow(
      /needs a description/,
    );
  });

  it("refuses an operation token that is not a plain identifier", () => {
    expect(() => declare({ a: { ...SIMPLE, operation: "read workspace" } })).toThrow(/not a plain identifier/);
  });
});

describe("field shape checks", () => {
  const field = (params: Record<string, never> | PortActionSpec["params"]) => () =>
    declare({ a: { summary: "s", params: params as PortActionSpec["params"] } });

  it("requires a json field to bound its encoded form", () => {
    // A structured value with no bound is the one field shape that makes a
    // proposal unmeasurable.
    expect(field({ c: { type: "json", description: "d" } })).toThrow(/must declare a maxLength/);
    expect(field({ c: { type: "json", description: "d", maxLength: 1 } })).toThrow(/at least 2/);
  });

  it("requires a pattern to be anchored and flagless", () => {
    // JSON Schema patterns are unanchored by default and have no flags; a
    // pattern that meant one thing here and another to an MCP client would be
    // worse than no pattern.
    expect(field({ p: { type: "string", description: "d", maxLength: 4, pattern: /abc/ } })).toThrow(/anchored/);
    expect(field({ p: { type: "string", description: "d", maxLength: 4, pattern: /^abc/ } })).toThrow(/anchored/);
    expect(field({ p: { type: "string", description: "d", maxLength: 4, pattern: /^abc$/i } })).toThrow(/no flags/);
    expect(field({ p: { type: "string", description: "d", maxLength: 4, pattern: /^abc$/ } })).not.toThrow();
  });

  it("keeps enum, pattern and schema on the types they belong to", () => {
    expect(field({ e: { type: "integer", description: "d", enum: ["a"] } })).toThrow(/only valid on a string/);
    expect(field({ p: { type: "boolean", description: "d", pattern: /^a$/ } })).toThrow(/only valid on a string/);
    expect(field({ s: { type: "string", description: "d", maxLength: 2, schema: {} } })).toThrow(/only valid on json/);
  });

  it("refuses a degenerate enum and an inverted integer range", () => {
    expect(field({ e: { type: "string", description: "d", enum: [] } })).toThrow(/empty enum/);
    expect(field({ e: { type: "string", description: "d", enum: ["a", "a"] } })).toThrow(/repeats a value/);
    expect(field({ n: { type: "integer", description: "d", minimum: 5, maximum: 1 } })).toThrow(/greater than maximum/);
    expect(field({ n: { type: "integer", description: "d", minimum: 1.5 } })).toThrow(/must be an integer/);
  });

  it("refuses a nonsensical string bound", () => {
    expect(field({ s: { type: "string", description: "d", maxLength: 0 } })).toThrow(/positive integer/);
  });
});

describe("wireProblems", () => {
  it("is empty for a declaration the View wire can carry", () => {
    const declaration = declare({ a: SIMPLE });
    expect(declaration.wireProblems.a).toEqual([]);
    expect(wireServiceableActions(declaration)).toEqual(["a"]);
  });

  it("accepts ONE declared parameter over the default bound", () => {
    // The editor batch's wire ruling: 512 characters is the bound for a
    // parameter nobody declared anything about, and a contract may raise it for
    // one field of one action (a whole file body under a compare-and-swap).
    const declaration = declare({
      a: { summary: "s", params: { body: { type: "string", description: "d", maxLength: 4000 } } },
    });
    expect(declaration.wireProblems.a).toEqual([]);
    expect(wireServiceableActions(declaration)).toEqual(["a"]);
    expect(wireValueLimit(declaration.byAction.a.params.body!)).toBe(4000);
  });

  it("reports a declared parameter over the ceiling", () => {
    const over = WIRE_PARAM_LIMITS.maxDeclaredValueLength + 1;
    const declaration = declare({
      a: { summary: "s", params: { body: { type: "string", description: "d", maxLength: over } } },
    });
    expect(declaration.wireProblems.a).toEqual([
      `body allows ${over} characters, over the wire's ceiling of ${WIRE_PARAM_LIMITS.maxDeclaredValueLength}`,
    ]);
    expect(wireServiceableActions(declaration)).toEqual([]);
    expect(wireValueLimit(declaration.byAction.a.params.body!)).toBeNull();
  });

  it("reports TWO oversized parameters, because they cannot both fit in one message", () => {
    const declaration = declare({
      a: {
        summary: "s",
        params: {
          body: { type: "string", description: "d", maxLength: 4000 },
          other: { type: "string", description: "d", maxLength: 4000 },
        },
      },
    });
    expect(declaration.wireProblems.a).toEqual([
      "2 parameters exceed 512 characters, and one proposal carries at most 1",
    ]);
    expect(wireServiceableActions(declaration)).toEqual([]);
  });

  it("keeps the default bound for a field that declares less than it", () => {
    // `wireValueLimit` answers "what may the WIRE carry"; the field's own
    // smaller bound is enforced separately, with its field path in the message.
    const declaration = declare({
      a: { summary: "s", params: { ref: { type: "string", description: "d", maxLength: 200 } } },
    });
    expect(wireValueLimit(declaration.byAction.a.params.ref!)).toBe(WIRE_PARAM_LIMITS.maxValueLength);
  });

  it("reports an unbounded string and an unbounded integer", () => {
    const declaration = declare({
      s: { summary: "s", params: { x: { type: "string", description: "d" } } },
      n: { summary: "s", params: { x: { type: "integer", description: "d" } } },
      half: { summary: "s", params: { x: { type: "integer", description: "d", minimum: 0 } } },
    });
    expect(declaration.wireProblems.s).toEqual(["x declares no bound, so its wire size is unbounded"]);
    expect(declaration.wireProblems.n).toEqual(["x declares no bound, so its wire size is unbounded"]);
    expect(declaration.wireProblems.half).toEqual(["x declares no bound, so its wire size is unbounded"]);
  });

  it("reports more parameters than the wire's key budget", () => {
    const params: Record<string, { type: "boolean"; description: string }> = {};
    for (let i = 0; i < 9; i += 1) params[`p${i}`] = { type: "boolean", description: "d" };
    const declaration = declare({ a: { summary: "s", params } });
    expect(declaration.wireProblems.a).toEqual(["9 parameters, over the wire's 8"]);
  });

  it("treats an enum and a bounded integer as bounded", () => {
    const declaration = declare({
      a: {
        summary: "s",
        params: {
          mode: { type: "string", description: "d", enum: ["fast", "slow"] },
          n: { type: "integer", description: "d", minimum: 0, maximum: 100 },
          flag: { type: "boolean", description: "d" },
          blob: { type: "json", description: "d", maxLength: 512 },
        },
      },
    });
    expect(declaration.wireProblems.a).toEqual([]);
  });
});
