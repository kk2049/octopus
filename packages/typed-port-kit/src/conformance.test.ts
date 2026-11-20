import { describe, expect, it } from "vitest";

import {
  answers,
  assertConformant,
  refuses,
  runPortConformance,
  scriptedTransport,
  type ConformanceFinding,
} from "./conformance.js";
import { declareContract, type ContractBound } from "./declaration.js";
import { refusalVocabulary } from "./refusals.js";
import { portRefusal, portValue, type PortReply } from "./reply.js";

const REFUSALS = refusalVocabulary(["unavailable", "invalid_request"], { fallback: "unavailable" });

const DECLARATION = declareContract({
  contract: "demo/v1",
  summary: "a demo port",
  actions: {
    read_row: { summary: "read one", params: { ref: { type: "string", description: "d", maxLength: 8 } } },
    ping: { summary: "hello", params: {} },
  },
  refusals: REFUSALS,
});

type Code = (typeof DECLARATION.refusals.codes)[number];

const PORT: ContractBound<"demo/v1"> = { contract: "demo/v1" };
const SAMPLES = { read_row: { ref: "r1" }, ping: {} } as const;

function failed(findings: readonly ConformanceFinding[]): string[] {
  return findings.filter((finding) => !finding.ok).map((finding) => finding.check);
}

describe("runPortConformance", () => {
  it("passes a port that answers, is bounded, and stays inside its vocabulary", async () => {
    const findings = await runPortConformance({
      declaration: DECLARATION,
      port: PORT,
      samples: SAMPLES,
      invoke: async (_action, params) =>
        "ref" in params ? portValue({ ref: params.ref }) : portRefusal<Code>("invalid_request", "缺少参数"),
    });
    expect(failed(findings)).toEqual([]);
    expect(() => assertConformant(findings)).not.toThrow();
  });

  it("reports a method that throws instead of resolving", async () => {
    // The single most important finding: it is the load-bearing claim behind
    // "a refusal is something to show a person, not an exception to catch".
    const findings = await runPortConformance({
      declaration: DECLARATION,
      port: PORT,
      samples: SAMPLES,
      invoke: async () => {
        throw new Error("не resolve");
      },
    });
    expect(failed(findings)).toContain("read_row: resolves");
    expect(failed(findings)).toContain("ping: resolves for empty arguments");
  });

  it("reports a refusal code outside the declared closed set", async () => {
    const findings = await runPortConformance({
      declaration: DECLARATION,
      port: PORT,
      samples: SAMPLES,
      invoke: async () => portRefusal("rate_limited" as Code, "慢一点"),
    });
    expect(failed(findings)).toContain("read_row: refusal code is in the closed set");
  });

  it("reports an unbounded or control-character refusal message", async () => {
    const findings = await runPortConformance({
      declaration: DECLARATION,
      port: PORT,
      samples: SAMPLES,
      // Deliberately built by hand rather than with `portRefusal`, because that
      // constructor is what makes this impossible.
      invoke: async () =>
        ({ ok: false, code: "unavailable", message: `x${String.fromCharCode(7)}` }) as PortReply<never, Code>,
    });
    expect(failed(findings)).toContain("read_row: refusal message is bounded and printable");
  });

  it("reports a port whose stated contract does not match the declaration", async () => {
    const findings = await runPortConformance({
      declaration: DECLARATION,
      port: { contract: "other/v1" },
      samples: SAMPLES,
      invoke: async () => portValue(null),
    });
    expect(failed(findings)).toContain("port states its contract");
  });

  it("reports a missing sample rather than quietly skipping the action", async () => {
    // A conformance report that silently omits half a contract is worse than
    // one that fails.
    const findings = await runPortConformance({
      declaration: DECLARATION,
      port: PORT,
      samples: { ping: {} },
      invoke: async () => portValue(null),
    });
    expect(failed(findings)).toEqual(["read_row: has a sample"]);
  });

  it("reports a sample that does not satisfy the declaration it is testing", async () => {
    const findings = await runPortConformance({
      declaration: DECLARATION,
      port: PORT,
      samples: { read_row: { ref: "x".repeat(20) }, ping: {} },
      invoke: async () => portValue(null),
    });
    expect(failed(findings)).toContain("read_row: sample satisfies the declaration");
  });

  it("reports an answer that is not a reply envelope at all", async () => {
    const findings = await runPortConformance({
      declaration: DECLARATION,
      port: PORT,
      samples: SAMPLES,
      invoke: async () => "fine" as unknown as PortReply<never, Code>,
    });
    expect(failed(findings)).toContain("read_row: answers with a reply envelope");
  });
});

describe("assertConformant", () => {
  it("says how many failed and names each one", () => {
    expect(() =>
      assertConformant([
        { check: "a", ok: true },
        { check: "b", ok: false, detail: "because" },
      ]),
    ).toThrow(/1 of 2 conformance checks failed[\s\S]*b: because/);
  });
});

describe("scriptedTransport", () => {
  it("records every proposal, with its params frozen", async () => {
    const scripted = scriptedTransport({ go: answers(1) });
    await scripted.transport.propose("go", { a: "1" });
    expect(scripted.calls).toEqual([{ action: "go", params: { a: "1" } }]);
    expect(Object.isFrozen(scripted.calls[0]!.params)).toBe(true);
  });

  it("answers a bounded unavailable for an action the script does not name", async () => {
    // Throwing would make every test that forgot one action fail for the wrong
    // reason.
    const scripted = scriptedTransport({});
    expect(await scripted.transport.propose("go")).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("rejects on demand, because that is a different code path from saying no", async () => {
    const scripted = scriptedTransport({ go: "reject" });
    await expect(scripted.transport.propose("go")).rejects.toThrow(/scripted transport rejected/);
  });

  it("returns malformed values verbatim, so an envelope fold can be exercised", async () => {
    const scripted = scriptedTransport({ go: { malformed: "not an object" } });
    expect(await scripted.transport.propose("go")).toBe("not an object" as never);
  });

  it("varies its answer by call index", async () => {
    const scripted = scriptedTransport({ go: (_params, nth) => (nth === 0 ? answers("first") : refuses("unavailable")) });
    expect(await scripted.transport.propose("go")).toMatchObject({ ok: true, result: "first" });
    expect(await scripted.transport.propose("go")).toMatchObject({ ok: false });
  });

  it("does not read inherited properties as scripted answers", async () => {
    const scripted = scriptedTransport({});
    expect(await scripted.transport.propose("toString")).toMatchObject({ ok: false, code: "unavailable" });
  });
});
