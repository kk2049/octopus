import { describe, expect, it } from "vitest";

import { corroborate, echoMatches, portLifecycle, readProposalAnswer } from "./arrival.js";
import { portRefusal, type PortReply } from "./reply.js";

describe("readProposalAnswer", () => {
  it("accepts a well-formed answer and copies exactly the declared fields", () => {
    expect(readProposalAnswer({ ok: true, result: { a: 1 }, message: "", extra: "x" })).toEqual({
      ok: true,
      code: undefined,
      result: { a: 1 },
      message: "",
    });
  });

  it("rejects anything that is not an answer", () => {
    for (const value of [null, undefined, "ok", 42, [], [{ ok: true, message: "" }]]) {
      expect(readProposalAnswer(value), `for ${JSON.stringify(value)}`).toBeNull();
    }
  });

  it("rejects a broken envelope field by field", () => {
    expect(readProposalAnswer({ result: 1, message: "" })).toBeNull();
    expect(readProposalAnswer({ ok: "yes", message: "" })).toBeNull();
    // A `message` that is not a string is as much a broken envelope as a
    // missing `ok`: every consumer renders it, and `undefined` reaching a
    // person is a blank box where an explanation should be.
    expect(readProposalAnswer({ ok: false, code: "x" })).toBeNull();
    expect(readProposalAnswer({ ok: false, message: 1 })).toBeNull();
    expect(readProposalAnswer({ ok: false, code: 7, message: "" })).toBeNull();
  });
});

describe("echoMatches", () => {
  it("compares as strings and nothing else", () => {
    expect(echoMatches({ ref: "abc" }, "ref", "abc")).toBe(true);
    // The failure a reader cannot catch: a listing for somewhere else is a
    // perfectly valid listing.
    expect(echoMatches({ ref: "other" }, "ref", "abc")).toBe(false);
    expect(echoMatches({ ref: 1 }, "ref", "1")).toBe(false);
    expect(echoMatches({}, "ref", "abc")).toBe(false);
    expect(echoMatches(null, "ref", "abc")).toBe(false);
    expect(echoMatches(["abc"], "0", "abc")).toBe(false);
  });
});

describe("corroborate", () => {
  it("answers null when every pair agrees", () => {
    expect(corroborate([{ what: "digest", expected: "a", actual: "a" }])).toBeNull();
  });

  it("names the first disagreement", () => {
    expect(
      corroborate([
        { what: "mediaType", expected: "text/plain", actual: "text/plain" },
        { what: "totalBytes", expected: 40, actual: 41 },
        { what: "digest", expected: "a", actual: "b" },
      ]),
    ).toBe("totalBytes");
  });

  it("treats an absent half as a disagreement", () => {
    // `totalBytes` is the only thing that can catch a transport ending a stream
    // early, so a header that omits it must not read as "agrees".
    expect(corroborate([{ what: "totalBytes", expected: 40, actual: undefined }])).toBe("totalBytes");
  });
});

describe("portLifecycle", () => {
  const gone = () => portRefusal("closed", "已经结束");
  const ok = <T,>(value: T): PortReply<T, "closed"> => ({ ok: true, value });

  it("refuses before the call when it is already destroyed", async () => {
    const life = portLifecycle<"closed">(gone);
    life.destroy();
    let ran = false;
    const reply = await life.guard(async () => {
      ran = true;
      return ok(1);
    });
    expect(ran).toBe(false);
    expect(reply).toEqual({ ok: false, code: "closed", message: "已经结束" });
  });

  it("refuses AFTER the await when destroy landed mid-flight", async () => {
    // The interesting case: a call already in flight when a panel unmounted is
    // exactly the one that would otherwise deliver into it.
    const life = portLifecycle<"closed">(gone);
    const discarded: number[] = [];
    const reply = await life.guard(
      async () => {
        life.destroy();
        return ok(7);
      },
      (value) => discarded.push(value),
    );
    expect(reply.ok).toBe(false);
    // Returning "gone" without releasing what the late answer owns is a leak.
    expect(discarded).toEqual([7]);
  });

  it("does not discard a late refusal, only a late value", async () => {
    const life = portLifecycle<"closed">(gone);
    let discards = 0;
    await life.guard(
      async () => {
        life.destroy();
        return portRefusal("closed", "x");
      },
      () => (discards += 1),
    );
    expect(discards).toBe(0);
  });

  it("survives a discard that throws", async () => {
    const life = portLifecycle<"closed">(gone);
    const reply = await life.guard(
      async () => {
        life.destroy();
        return ok(1);
      },
      () => {
        throw new Error("boom");
      },
    );
    expect(reply.ok).toBe(false);
  });

  it("releases everything tracked, once, in registration order", () => {
    const life = portLifecycle<"closed">(gone);
    const order: string[] = [];
    life.track(() => order.push("a"));
    const dropB = life.track(() => order.push("b"));
    life.track(() => order.push("c"));
    dropB();
    life.destroy();
    life.destroy();
    expect(order).toEqual(["a", "c"]);
    expect(life.destroyed).toBe(true);
  });

  it("survives a release that throws and still releases the rest", () => {
    const life = portLifecycle<"closed">(gone);
    const order: string[] = [];
    life.track(() => {
      throw new Error("boom");
    });
    life.track(() => order.push("b"));
    expect(() => life.destroy()).not.toThrow();
    expect(order).toEqual(["b"]);
  });

  it("releases immediately when something is tracked after destroy", () => {
    // Registering against a dead lifecycle would otherwise leak silently:
    // nothing will ever call it.
    const life = portLifecycle<"closed">(gone);
    life.destroy();
    let released = false;
    life.track(() => (released = true));
    expect(released).toBe(true);
  });
});
